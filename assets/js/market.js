import { EXTRA_PAIRS, FACTORIES, LCD, THIN_LUNC, amt, dbg, getJSON, smart } from './chain.js?v=8e146a21';

/* ---------------- discovery and pricing ----------------
   The chain has no "which CW20 does this address hold" endpoint. Balances live
   inside each token contract and only that contract can be asked, so the
   candidate list has to be built from somewhere else: the market. Every CW20
   that appears in a factory pool is a candidate - 779 pairs, 477 tokens at the
   last count. A token with no pool at all, like TCO on its bonding curve, is
   invisible to that method, which is why the hand written CW20 list above is
   kept as a seed instead of being replaced.
*/
const LUNC_KEY = 'native:uluna';
// TerraSwap says {token:{contract_addr}} / {native_token:{denom}},
// Garuda says {cw20:"terra1..."} / {native:"uluna"}. Both mean the same asset.
// What the map knows about an asset by itself, with no pool attached: enough
// to draw a row for something this wallet has never held, which is the whole
// point of being able to buy it.
function assetOf(key){
  if (!OW || !OW.syms) return null;
  if (!OW.syms[key] && OW.decs[key] === undefined) return null;
  return {
    key: key,
    sym: OW.syms[key] || key.slice(key.indexOf(':') + 1, key.indexOf(':') + 7),
    dec: OW.decs[key] === undefined ? 6 : OW.decs[key],
    logo: OW.logos[key] || null
  };
}

/* CL8Y publishes what it lists - symbol, decimals, and a picture, which is the
   one thing neither the feed nor a contract query will give us. It ships with
   the app rather than being fetched from the exchange, so it costs one local
   file read and cannot fail at the wrong moment; the cost is that it goes stale
   when they add a token, which is what the cache-busting version is for.

   Order of authority: the market feed, then this, then the contract itself. The
   first two are free. */
const LIST_V = (String(import.meta.url).split('?v=')[1] || '').split('&')[0];
let LIST = null;
let LIST_P = null;
function cl8yList(){
  if (!LIST_P) LIST_P = loadList();
  return LIST_P;
}
async function loadList(){
  if (LIST) return LIST;
  const hit = cacheGetStale('cl8y:' + LIST_V);
  if (hit) { LIST = hit; return LIST; }
  const out = {};
  try {
    const r = await fetch('assets/cl8y-tokens.json' + (LIST_V ? '?v=' + LIST_V : ''));
    const rows = ((await r.json()) || {}).tokens || [];
    for (const t of rows) {
      if (!t || !t.symbol) continue;
      const key = t.address ? 'cw20:' + t.address
                : t.denom ? 'native:' + t.denom : null;
      if (!key) continue;
      out[key] = { key: key, sym: t.symbol,
                   dec: t.decimals === undefined ? 6 : t.decimals,
                   logo: t.logoURI || null };
      // Not "if undefined". A feed that never listed the token still has a
      // default sitting in DEC, and legRate divides by ten to that power - so a
      // wrong 6 against a real 18 is not a rounding error, it is a different
      // number entirely. The issuer's own list outranks a guess.
      if (t.decimals !== undefined) DEC[key] = t.decimals;
    }
    cacheSet('cl8y:' + LIST_V, out);
  } catch (e) { /* a missing list is one fewer source, not a failure */ }
  LIST = out;
  return LIST;
}
// started at load: everything that reads it wants an answer without waiting
cl8yList();

/* The feed names what it indexes, and nothing else - so a CL8Y token has a
   pool, a price and a balance, and no symbol to put on the row. The contract
   knows its own name; asking it once and keeping the answer is cheaper than
   leaving the asset unnameable and therefore unlistable. */
/* Merged, not first-wins. The feed knows almost every token but carries no
   picture and only whatever decimals it happened to record; the published list
   knows eleven tokens exactly and is right about all of them. Returning
   whichever answered first meant one missing field in the feed's entry hid a
   complete one in the list - which is why USTR kept its old icon and its wrong
   scale after the list was already loaded. */
const ASSET = {};
function knownAsset(key){
  if (ASSET[key]) return ASSET[key];
  const feed = assetOf(key);
  const list = LIST && LIST[key];
  const kept = cacheGetStale('as:' + key);
  if (!feed && !list && !kept) return null;
  // whatever we settle on below, the scale has to reach the arithmetic
  const known = (list && list.dec) || (kept && kept.dec) || (feed && feed.dec);
  if (known !== undefined && known !== null) DEC[key] = known;
  const pick = (field, order) => {
    for (const src of order) if (src && src[field] !== undefined && src[field] !== null) return src[field];
    return null;
  };
  return {
    key: key,
    // the issuer first, as with everything else it publishes. A feed reports
    // whatever string the contract carries, and a contract's internal name is
    // not always the one the token is traded under.
    sym: pick('sym', [list, feed, kept]),
    // the issuer's list first for both: it is the only authority on either
    dec: pick('dec', [list, feed, kept]),
    logo: pick('logo', [list, feed, kept])
  };
}
async function learnAsset(key){
  await cl8yList();
  const have = knownAsset(key);
  if (have) { ASSET[key] = have; return have; }
  if (!key || key.slice(0, 5) !== 'cw20:') return null;
  const r = await smart(key.slice(5), { token_info: {} }, 1).catch(() => null);
  const d = r && r.data;
  if (!d || !d.symbol) return null;
  const a = { key: key, sym: d.symbol,
              dec: d.decimals === undefined ? 6 : d.decimals, logo: null };
  // Into DEC as well, and this is the point of the whole call: legRate scales
  // a reserve by ten to the power of what it finds there, and finding nothing
  // means six. A contract that says eighteen and is not heard is a price out
  // by a factor of a trillion - which is exactly what USTR was doing before
  // the published list happened to cover it.
  if (d.decimals !== undefined) DEC[key] = d.decimals;
  cacheSet('as:' + key, a);
  ASSET[key] = a;
  return a;
}

// Everything that shares a pool with this asset, deepest pool first. One entry
// per counterparty: several exchanges list the same pair, and the picker is
// naming assets, not pools.
function directPeers(key){
  if (!OW || !OW.edges) return [];
  const best = {};
  for (const e of (OW.edges[key] || [])) {
    if (e.to === key) continue;                 // a pool against itself is noise
    if (!best[e.to] || e.liq > best[e.to].liq) best[e.to] = e;
  }
  const out = [];
  for (const k in best) {
    const a = assetOf(k);
    if (a) out.push(Object.assign({}, a, { pair: best[k].pair, liq: best[k].liq, dex: best[k].dex }));
  }
  return out.sort((x, y) => y.liq - x.liq);
}

// Peers the factory walk found. graph() exists to cover the exchanges the feed
// does not - CL8Y and TwingoSwap, by its own comment - and its edges carry no
// depth, because a factory listing says which pools exist and nothing else.
function graphPeers(key){
  if (!GRAPH || !GRAPH.edges) return [];
  const best = {};
  for (const e of (GRAPH.edges[key] || [])) {
    if (e.to === key) continue;
    // an edge the walk found has no depth attached, and saying 0 is a claim we
    // cannot make - it reads as "empty pool" to everything downstream
    const liq = typeof e.liq === 'number' ? e.liq : null;
    const was = best[e.to];
    if (!was || (liq !== null && (was.liq === null || liq > was.liq))) {
      best[e.to] = { key: e.to, pair: e.pair, liq: liq, dex: e.dex || 'ts' };
    }
  }
  return Object.keys(best).map(k => best[k]);
}

// Every pool holding exactly these two, deepest first. This is the candidate
// list a quote is taken from: which one is best depends on the amount, so all
// of them get asked.
//
// Both sources, deduplicated by pool address. graph() already folds the feed's
// edges into its own, so the same pool arrives twice whenever both know it.
function poolsBetween(a, b){
  const out = [];
  const take = function (e) {
    if (e.to !== b) return;
    if (out.some(x => x.pair === e.pair)) return;
    out.push({ pair: e.pair, dex: e.dex || 'ts',
               liq: typeof e.liq === 'number' ? e.liq : null });
  };
  if (OW && OW.edges) (OW.edges[a] || []).forEach(take);
  if (GRAPH && GRAPH.edges) (GRAPH.edges[a] || []).forEach(take);
  // known depths first, largest first; unmeasured ones after them rather than
  // beneath them - they are still candidates, deepestLeg will measure them
  return out.sort(function (x, y) {
    if (x.liq === null && y.liq === null) return 0;
    if (x.liq === null) return 1;
    if (y.liq === null) return -1;
    return y.liq - x.liq;
  });
}

// One side of one pool, priced against the other. Decimals come from the map,
// which carries them for everything it lists.
async function legRate(pair, from, to){
  const res = await reserves(pair).catch(() => null);
  if (!res) return null;
  const a = res.find(x => x.key === from), b = res.find(x => x.key === to);
  if (!a || !b) return null;
  const av = amt(a.raw, DEC[from] === undefined ? 6 : DEC[from]);
  const bv = amt(b.raw, DEC[to] === undefined ? 6 : DEC[to]);
  if (!(av > 0) || !(bv > 0)) return null;
  return { rate: bv / av, far: bv };
}

// A price in LUNC for anything the map lists, in at most two hops, using only
// what the map already holds plus a reserve read per hop.
//
// This is the same answer graph() gives, for the shape of route that covers
// almost every token, without graph()'s price of admission - it has to page
// every factory and read every pool before it can answer anything. Two hops is
// the ceiling on purpose: a third would need a search, and a token three pools
// away from LUNC is not one this screen can price honestly anyway.
/* The deepest of several pools holding the same two assets, measured rather
   than assumed. Taking the first of the list only works when the list is
   ordered by depth, and it is not: an edge from the factory walk carries liq 0,
   because a factory listing says a pool exists and nothing about its size. So
   every candidate sorted to the front by a tie of zeroes, and whichever
   arbitrary pool won got to set the price - which is how USTR ended up at more
   than twice what it trades for, off some thin pool nobody uses. */
async function deepestLeg(pools, from, to, cap){
  let best = null;
  for (const p of pools.slice(0, cap || 3)) {
    const r = await legRate(p.pair, from, to);
    if (!r) continue;
    if (!best || r.far > best.far) best = { pair: p.pair, rate: r.rate, far: r.far };
  }
  return best;
}

/* USTC priced in LUNC, from the deepest pool holding the two. That pool is one
   of the largest on the chain and its rate does not wander, so it is read once
   a session and spends no part of the two-hop budget - which is the whole point
   of making USTC a base. */
const USTC_KEY = 'native:uusd';

/* The assets a price is allowed to terminate at, beyond LUNC itself.
   Each one is worth a fixed amount of LUNC through a pool deep enough that the
   crossing is not what limits the answer, so reaching a hub is as good as
   reaching LUNC - and it costs no part of the two-hop budget.

   They are built in order, each against the ones already established. USTC
   against LUNC, then cUSTC against USTC: cUSTC is a wrapper on USTC and the way
   in and out of everything CL8Y lists, so with it as a hub a token like USTR
   reaches a base in two hops (USTR, UST1, cUSTC) instead of needing three. */
/* The promise is what gets kept, not the list.
   Holding the list meant assigning it empty before the first await, and an
   empty array is truthy - so every caller that arrived during the build was
   handed the empty one and went away thinking there were no hubs at all. These
   callers are concurrent by design: both sides of a swap are priced at once and
   the token list prices four at a time, so the racing caller was the common
   case rather than the rare one. */
/* Rebuilt once, when the factory walk has been done and not before.
   The first price request comes from the token list, and at that point the only
   pools anyone knows are the ones the market feed publishes - which is every
   exchange except CL8Y and TwingoSwap. cUSTC lives entirely in the part the
   feed does not cover, so a hub list built at that moment cannot contain it,
   and memoising the promise then fixed that gap in place for the whole session.
   One rebuild, the first time the walk has actually delivered. */
let HUBS = null, HUBS_WALKED = false;
function hubs(){
  // GRAPH itself, not graphReady(). The flag says the pair list is cached; the
  // edges only exist once something has actually built them, and the hubs are
  // made of edges.
  const walked = !!GRAPH;
  if (HUBS && (HUBS_WALKED || !walked)) return HUBS;
  HUBS_WALKED = walked;
  HUBS = buildHubs().catch(function () { HUBS = null; return []; });
  return HUBS;
}

async function buildHubs(){
  await warmGraph();
  const out = [];
  const ustc = await deepestLeg(poolsBetween(USTC_KEY, LUNC_KEY), USTC_KEY, LUNC_KEY, 3);
  if (!ustc) return out;
  out.push({ key: USTC_KEY, rate: ustc.rate, far: ustc.far,
             route: [{ pair: ustc.pair }] });

  await cl8yList();
  const wrapped = LIST && Object.keys(LIST).filter(k => LIST[k].sym === 'cUSTC')[0];
  if (!wrapped) return out;
  const leg = await routeTo(wrapped, USTC_KEY);
  if (!leg) return out;
  out.push({ key: wrapped,
             rate: leg.rate * ustc.rate,
             // still limited by its own narrowest leg, crossing included
             far: Math.min(leg.depth * ustc.rate, ustc.far),
             route: leg.route.concat([{ pair: ustc.pair }]) });
  return out;
}

async function routeTo(key, base){
  const direct = poolsBetween(key, base);
  if (direct.length) {
    const one = await deepestLeg(direct, key, base, 3);
    if (one) return { rate: one.rate, depth: one.far, hops: 1,
                      route: [{ pair: one.pair }], legs: [one.far] };
  }
  const seen = {}, mids = [];
  for (const p of directPeers(key).concat(graphPeers(key))) {
    if (p.key === key || p.key === base || seen[p.key]) continue;
    seen[p.key] = 1;
    if (!poolsBetween(p.key, base).length) continue;
    mids.push(p);
  }
  let best = null;
  for (const m of mids.slice(0, 6)) {
    const two = await deepestLeg(poolsBetween(m.key, base), m.key, base, 2);
    if (!two) continue;
    const one = await deepestLeg(poolsBetween(key, m.key), key, m.key, 2);
    if (!one) continue;
    // the first pool expressed in the base, so the two legs are comparable
    const legOne = one.far * two.rate;
    const narrow = Math.min(legOne, two.far);
    if (!best || narrow > best.depth) {
      best = { rate: one.rate * two.rate, depth: narrow, hops: 2,
               route: [{ pair: one.pair }, { pair: two.pair }],
               via: m.key, legs: [legOne, two.far] };
    }
  }
  return best;
}

/* Pull the graph into memory when doing so costs nothing.
   A complete pair list in the cache is the common case after the first sweep,
   and building the edges from it touches no network at all - but until someone
   calls graph(), GRAPH is null and every pool the market feed does not publish
   is invisible. That is the whole CL8Y exchange, sitting one free call away
   from every price on the token list. */
async function warmGraph(){
  if (GRAPH || !graphReady()) return;
  await graph().catch(function () {});
}

async function mapPrice(key){
  if (!key || key === LUNC_KEY) return null;
  // decimals before arithmetic: the list is where 18 comes from, and a price
  // computed at 6 is out by a factor of a trillion
  await cl8yList();
  await warmGraph();

  // What was tried and what it gave. Printed only when the answer is thin or
  // missing, which is the only time anyone needs to know - and the only way to
  // tell "this hub was never in the list" from "this hub had no route", which
  // three rounds of reasoning failed to distinguish.
  const trace = [];

  const viaLunc = await routeTo(key, LUNC_KEY);
  // A deep pool straight to LUNC ends the question; searching the hubs as well
  // would only spend reads to confirm what is already known.
  if (viaLunc && viaLunc.hops === 1 && viaLunc.depth >= THIN_LUNC) {
    return { inLunc: viaLunc.rate, depth: viaLunc.depth, hops: 1,
             route: viaLunc.route, legs: viaLunc.legs };
  }
  trace.push('lunc=' + (viaLunc ? Math.round(viaLunc.depth) + '@' + viaLunc.hops + 'h' : 'none'));

  let best = viaLunc ? {
    rate: viaLunc.rate, depth: viaLunc.depth, hops: viaLunc.hops,
    route: viaLunc.route, via: viaLunc.via, legs: viaLunc.legs
  } : null;

  const list = await hubs();
  trace.push('hubs=' + (list.length ? list.map(h => h.key.slice(0, 12)).join(',') : 'NONE'));

  for (const h of list) {
    if (key === h.key) { trace.push(h.key.slice(0, 12) + '=self'); continue; }
    // once something is good enough to trade against, a wider one changes
    // nothing on screen and costs a dozen more reads
    if (best && best.depth >= THIN_LUNC) { trace.push('stopped-early'); break; }
    const r = await routeTo(key, h.key);
    if (!r) { trace.push(h.key.slice(0, 12) + '=no-route'); continue; }
    // converted into LUNC, depths included, so every candidate is judged on one
    // scale whichever base it reached
    const cand = {
      rate: r.rate * h.rate,
      depth: Math.min(r.depth * h.rate, h.far),
      hops: r.hops + h.route.length,
      route: r.route.concat(h.route),
      via: r.via || h.key,
      legs: (r.legs || []).map(x => x * h.rate).concat([h.far])
    };
    trace.push(h.key.slice(0, 12) + '=' + Math.round(cand.depth) + '@' + cand.hops + 'h');
    if (!best || cand.depth > best.depth) best = cand;
  }

  if (!best || best.depth < THIN_LUNC) {
    dbg('[route]', key.slice(0, 18), trace.join(' | '),
                 '| peers ow=' + directPeers(key).length,
                 'graph=' + graphPeers(key).length,
                 '| graphReady=' + graphReady());
  }

  if (!best) return null;
  return { inLunc: best.rate, depth: best.depth, hops: best.hops,
           route: best.route, via: best.via, legs: best.legs };
}

/* Assets that hold a pool with both sides, so a trade can go through them.
   Ordered by the shallower of the two pools where the feed knows a depth, since
   that is the leg a trade would run into first; ones nobody has measured come
   after those rather than beneath them. */
function midsBetween(a, b){
  if (a === b) return [];
  const seen = {}, out = [];
  for (const p of directPeers(a).concat(graphPeers(a))) {
    if (p.key === a || p.key === b || seen[p.key]) continue;
    seen[p.key] = 1;
    const second = poolsBetween(p.key, b);
    if (!second.length) continue;
    const first = poolsBetween(a, p.key);
    if (!first.length) continue;
    const d1 = first[0].liq, d2 = second[0].liq;
    const known = d1 !== null && d2 !== null ? Math.min(d1, d2) : null;
    out.push({ key: p.key, liq: known, first: first, second: second });
  }
  return out.sort(function (x, y) {
    if (x.liq === null && y.liq === null) return 0;
    if (x.liq === null) return 1;
    if (y.liq === null) return -1;
    return y.liq - x.liq;
  });
}

// Two dialects, one question. TerraSwap asks `simulation` and wraps the side
// in `info`; Garuda asks `simulate_swap`, names the side directly, and puts the
// amount beside it rather than inside. Both answer with the same three fields,
// so only the question differs.
const tsInfo = key => key.slice(0, 5) === 'cw20:'
  ? { token: { contract_addr: key.slice(5) } }
  : { native_token: { denom: key.slice(7) } };
const gdInfo = key => key.slice(0, 5) === 'cw20:'
  ? { cw20: key.slice(5) }
  : { native: key.slice(7) };

/* Three dialects now, and the third is a different kind of thing. A CL8Y pool
   is dex_common::pair: a constant product curve with a limit order book beside
   it, and `hybrid_simulation` prices a trade across both. The split is the
   caller's to make - pool_input and book_input have to add up to the offer.

   All of it goes to the pool. On the pair this was worked out against, the
   curve alone returned more than the book did, and it is the half that behaves
   predictably: max_maker_fills at zero means no maker order is touched, so the
   gas is bounded and the quote cannot be moved by someone else's order landing
   first. Splitting the offer would need the execution to repeat the same split
   the quote used, or the trade returns something other than what was shown -
   that is a feature with its own failure mode, not a default. */
const clHybrid = raw => ({
  pool_input: raw,
  book_input: '0',
  max_maker_fills: 0,
  book_start_hint: null
});

/* The same question put to the order book instead of the curve.
   max_maker_fills bounds how many resting orders one trade may consume, and
   with it the gas; eight is enough to matter and small enough to price. */
const clBook = raw => ({
  pool_input: '0',
  book_input: raw,
  max_maker_fills: 8,
  book_start_hint: null
});

const simMsg = (d, key, raw, book) =>
  d === 'gd' ? { simulate_swap: { offer_asset: gdInfo(key), offer_amount: raw } } :
  d === 'cl' ? { hybrid_simulation: { offer_asset: { info: tsInfo(key), amount: raw },
                                      hybrid: (book ? clBook : clHybrid)(raw) } } :
  { simulation: { offer_asset: { info: tsInfo(key), amount: raw } } };

// A pool's code does not change, so which dialect it answers to is worth
// learning once and keeping. The map's dex name is only the first guess; the
// pool itself is the authority.
const DIALECTS = ['ts', 'gd', 'cl'];
async function simulateSwap(pair, offerKey, raw, guess){
  const known = cacheGetStale('dex:' + pair);
  const first = known || guess;
  // the remembered one, or the map's guess, then the others - and whichever
  // answers is remembered against this pool for good, because a pool's code
  // does not change
  const order = DIALECTS.indexOf(first) >= 0
    ? [first].concat(DIALECTS.filter(d => d !== first))
    : DIALECTS.slice();
  let last = null;
  for (const d of order) {
    try {
      const r = await smart(pair, simMsg(d, offerKey, raw), 1);
      const x = (r && r.data) || {};
      if (x.return_amount === undefined) throw new Error('pool gave no return_amount');
      if (known !== d) cacheSet('dex:' + pair, d);
      if (d !== 'cl') return Object.assign({ dialect: d }, x);

      // Both sides of a hybrid pool, because the execution message picks
      // neither and the contract will use whichever serves the trade.
      const alt = await smart(pair, simMsg(d, offerKey, raw, true), 1).catch(() => null);
      const y = (alt && alt.data) || null;
      if (y && Number(y.return_amount) > Number(x.return_amount)) {
        return Object.assign({ dialect: d, via: 'book' }, y);
      }
      return Object.assign({ dialect: d, via: 'pool' }, x);
    } catch (e) { last = e; }
  }
  throw last || new Error('no dialect answered');
}

function infoKey(i){
  if (!i) return '?';
  if (i.token) return 'cw20:' + i.token.contract_addr;
  if (i.native_token) return 'native:' + i.native_token.denom;
  if (i.cw20) return 'cw20:' + i.cw20;
  if (i.native) return 'native:' + i.native;
  return '?';
}

const CACHE_TTL = 6 * 3600 * 1000;
const CACHE_GEN = 5;   // bump when FACTORIES changes, or stale pairs hide the new ones
function cacheGet(k){
  try {
    const r = JSON.parse(localStorage.getItem('fw:' + CACHE_GEN + ':' + k) || 'null');
    if (r && Date.now() - r.t < CACHE_TTL) return r.v;
  } catch (e) {}
  return null;
}
// the same entry, ignoring its age - used only when a fresh build came back
// worse than what we already had
function cacheGetStale(k){
  try {
    const r = JSON.parse(localStorage.getItem('fw:' + CACHE_GEN + ':' + k) || 'null');
    return r ? r.v : null;
  } catch (e) { return null; }
}
function cacheSet(k, v){
  try { localStorage.setItem('fw:' + CACHE_GEN + ':' + k, JSON.stringify({ t: Date.now(), v: v })); } catch (e) {}
}

// four hundred requests fired at once earns a 429 and nothing else
async function mapLimit(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Every CW20 transfer writes its own contract address into the wasm event, so
// the address history is a list of tokens that actually reached this wallet.
// Note the parameter name: this node refuses "events" and answers "query".
async function txCandidates(addr){
  const hit = cacheGet('tx:' + addr);
  if (hit) return hit;
  const out = {};
  for (const ev of ["wasm.to='" + addr + "'", "wasm.recipient='" + addr + "'"]) {
    for (let page = 0; page < 3; page++) {
      let r;
      try {
        r = await getJSON(LCD + '/cosmos/tx/v1beta1/txs?query=' + encodeURIComponent(ev) +
          '&pagination.limit=100&pagination.offset=' + (page * 100) +
          '&order_by=ORDER_BY_DESC', 25000);
      } catch (e) { break; }
      const resp = r.tx_responses || [];
      for (const t of resp) {
        for (const lg of (t.logs || [])) {
          for (const e of (lg.events || [])) {
            if (e.type !== 'wasm') continue;
            for (const a of (e.attributes || [])) {
              if (a.key === '_contract_address') out[a.value] = 1;
            }
          }
        }
      }
      if (resp.length < 100) break;
    }
  }
  const list = Object.keys(out);
  if (list.length) cacheSet('tx:' + addr, list);
  return list;
}

// /code/{id}/contracts, paged. count_total is not supported by this node, so
// it is left off - next_key is enough.
async function contractsByCode(code){
  const hit = cacheGet('code:' + code);
  if (hit) return hit;
  const out = [];
  let next = null;
  for (let page = 0; page < 40; page++) {
    let url = LCD + '/cosmwasm/wasm/v1/code/' + code + '/contracts?pagination.limit=100';
    if (next) url += '&pagination.key=' + encodeURIComponent(next);
    let r;
    try { r = await getJSON(url, 25000); } catch (e) { break; }
    const got = r.contracts || [];
    out.push(...got);
    next = r.pagination && r.pagination.next_key;
    if (!next || !got.length) break;
  }
  if (out.length) cacheSet('code:' + code, out);
  return out;
}

// false whenever the pair list in use was not read in full
let MARKET_COMPLETE = true;
const marketComplete = () => MARKET_COMPLETE;

/* ---------------- the market map ----------------
   Our own proxy in front of OrbitWire. It exists because their API sends no
   CORS header, and it caches so their service sees one request a minute from
   all of us rather than one per wallet open.

   This is a map, not a price feed. It says which pools exist and where; what
   is in them we still read ourselves.
*/
const OW_URL = 'https://orbitwire-proxy.vladislav-baydan.workers.dev/pairs';

let OW = null;
const owKey = t => (t.type === 'NATIVE' || String(t.address).slice(0, 6) !== 'terra1')
  ? 'native:' + t.address : 'cw20:' + t.address;

async function owMarket(){
  if (OW !== null) return OW;
  let raw = cacheGet('ow');
  if (!raw) {
    try {
      const r = await getJSON(OW_URL, 15000);
      if (r && r.ok && Array.isArray(r.pairs) && r.pairs.length) {
        raw = r.pairs;
        cacheSet('ow', raw);
      }
    } catch (e) { raw = null; }
  }
  if (!raw) { OW = false; return false; }   // false, not null: asked and failed

  const edges = {}, tokens = [], seen = {}, logos = {}, decs = {}, syms = {};
  for (const p of raw) {
    if (!p.base || !p.quote || !p.pool) continue;
    const a = owKey(p.base), b = owKey(p.quote);
    // Depth travels with the edge so a pair listed by four exchanges can be
    // ordered without asking any of them, and the dex name travels with it
    // because it is the first guess at which dialect the pool speaks.
    const liq = Number(p.liquidity) || 0;
    const dex = /garuda/i.test(String(p.dex || '')) ? 'gd' : 'ts';
    (edges[a] = edges[a] || []).push({ to: b, pair: p.pool, liq: liq, dex: dex });
    (edges[b] = edges[b] || []).push({ to: a, pair: p.pool, liq: liq, dex: dex });
    for (const t of [p.base, p.quote]) {
      const k = owKey(t);
      if (t.logo && !logos[k]) logos[k] = t.logo;
      if (t.symbol && !syms[k]) syms[k] = t.symbol;
      if (t.decimals !== undefined && t.decimals !== null) decs[k] = t.decimals;
      if (k.slice(0, 5) === 'cw20:' && !seen[k]) { seen[k] = 1; tokens.push(k.slice(5)); }
    }
  }
  OW = { edges: edges, tokens: tokens, logos: logos, decs: decs, syms: syms, count: raw.length };
  // decimals from the map save a token_info call each
  for (const k in decs) if (DEC[k] === undefined) DEC[k] = decs[k];
  return OW;
}

const owLogo = contract => (OW && OW.logos['cw20:' + contract]) || null;

let GRAPH = null;

// True when graph() would answer from memory or from a stored pair list that
// names every exchange - that is, without a single request. False means a cold
// build: a thousand reads, and a caller that cannot afford them should wait
// for the sweep instead of starting one.
function graphReady(){
  if (GRAPH) return true;
  const stored = cacheGet('pairs');
  return !!(stored && stored.pairs && FACTORIES.every(f => stored.by && stored.by[f.n] > 0));
}

async function graph(){
  if (GRAPH) return GRAPH;

  // The map covers Garuda, both Terraports, Terraswap and Weso DeFi. It does
  // not cover CL8Y or TwingoSwap, so the factory walk below still runs and the
  // two are merged - but the thousand-read cold start is gone either way.
  const ow = await owMarket();
  // A stored list is only believed if it names every exchange. Short lists
  // used to look exactly like real ones.
  const stored = cacheGet('pairs');
  let raw = null;
  if (stored && stored.pairs && FACTORIES.every(f => stored.by && stored.by[f.n] > 0)) {
    raw = stored.pairs;
  }
  MARKET_COMPLETE = !!raw;
  if (!raw) {
    raw = [];
    const by = {};
    // Anything that fails here makes the picture incomplete, and an incomplete
    // picture must not be written down - a missing deep pool does not read as
    // "missing", it reads as a confident wrong price.
    let lost = 0;
    await Promise.all(FACTORIES.map(async f => {
      if (f.k === 'code') {
        // Every pool of this exchange is an instance of one code, so the chain
        // can list them and we never have to believe the factory.
        const addrs = await contractsByCode(f.code);
        if (!addrs.length) { lost += 1; return; }
        by[f.n] = 0;
        const got = await mapLimit(addrs, 8, async c => {
          try {
            const r = await smart(c, { pool: {} });
            const d = (r && r.data) || {};
            if (!d.asset1 || d.reserve1 === undefined) return null;
            return { p: c, i: [d.asset1, d.asset2] };
          } catch (e) { return 'fail'; }
        });
        for (const g of got) {
          if (g === 'fail') lost += 1;
          else if (g) { raw.push(g); by[f.n] = (by[f.n] || 0) + 1; }
        }
        return;
      }
      let start = null;
      for (let guard = 0; guard < 80; guard++) {
        const q = { pairs: { limit: 30 } };
        if (start) q.pairs.start_after = start;
        let r;
        // a page we could not read is not the end of the list
        try { r = await smart(f.a, q); } catch (e) { lost += 1; break; }
        const chunk = (r.data && r.data.pairs) || [];
        if (!chunk.length) break;
        for (const p of chunk) {
          raw.push({ p: p.contract_addr, i: p.asset_infos });
          by[f.n] = (by[f.n] || 0) + 1;
        }
        start = chunk[chunk.length - 1].asset_infos;
        if (chunk.length < 30) break;
      }
    }));

    // pools that no factory lists, read the same way as the rest
    const extra = await mapLimit(EXTRA_PAIRS, 4, async c => {
      try {
        const r = await smart(c, { pool: {} });
        const d = (r && r.data) || {};
        if (d.asset1 && d.reserve1 !== undefined) return { p: c, i: [d.asset1, d.asset2] };
        if (Array.isArray(d.assets) && d.assets.length === 2) {
          return { p: c, i: d.assets.map(a => a.info) };
        }
        return null;
      } catch (e) { lost += 1; return null; }
    });
    for (const e of extra) if (e) raw.push(e);

    // Every exchange has to have contributed something. Falling back to an
    // older list is not an option here - the older list is how this went wrong
    // in the first place.
    const full = !lost && FACTORIES.every(f => by[f.n] > 0);
    MARKET_COMPLETE = full;
    if (full) cacheSet('pairs', { pairs: raw, by: by });
    else console.warn('market incomplete', by, 'failures:', lost);
  }
  const edges = {}, tokens = [], seen = {};
  for (const pr of raw) {
    const a = infoKey(pr.i[0]), b = infoKey(pr.i[1]);
    (edges[a] = edges[a] || []).push({ to: b, pair: pr.p });
    (edges[b] = edges[b] || []).push({ to: a, pair: pr.p });
    for (const k of [a, b]) {
      if (k.slice(0, 5) === 'cw20:' && !seen[k]) { seen[k] = 1; tokens.push(k.slice(5)); }
    }
  }
  if (ow) {
    // the map first, so its pools are found even if a factory answered short
    for (const k in ow.edges) {
      edges[k] = (edges[k] || []).concat(ow.edges[k]);
    }
    for (const t of ow.tokens) if (tokens.indexOf(t) < 0) tokens.push(t);
  }

  GRAPH = { edges: edges, tokens: tokens };
  return GRAPH;
}

// shortest ways from a token to LUNC, a few of them, so the deepest can win
// Returns the routes found at the FIRST distance that yields any, all of them,
// capped. ELPACO sits in eight Garuda pools and one of them is the real market;
// taking "some three routes" and hoping meant quoting a side pool at three
// times the price you could actually sell for.
function routesToLunc(g, from, maxHops, maxRoutes){
  if (from === LUNC_KEY) return [];
  const found = [];
  const seen = {};
  seen[from] = 1;
  let frontier = [[{ node: from }]];
  for (let h = 0; h < maxHops; h++) {
    const next = [];
    for (const path of frontier) {
      const last = path[path.length - 1].node;
      for (const e of (g.edges[last] || [])) {
        if (e.to === LUNC_KEY) { found.push(path.concat([{ node: e.to, pair: e.pair }])); continue; }
        if (seen[e.to]) continue;
        next.push(path.concat([{ node: e.to, pair: e.pair }]));
      }
    }
    // a shorter route is a better quote, so stop as soon as one distance pays
    if (found.length) break;
    for (const p of next) seen[p[p.length - 1].node] = 1;
    frontier = next;
    if (!frontier.length) break;
  }
  return found.slice(0, maxRoutes);
}

const DEC = {};
DEC[LUNC_KEY] = 6;
async function decimalsOf(key){
  if (DEC[key] !== undefined) return DEC[key];
  let d = 6;
  if (key.slice(0, 5) === 'cw20:') {
    try { const r = await smart(key.slice(5), { token_info: {} }); d = r.data.decimals; } catch (e) {}
  }
  DEC[key] = d;
  return d;
}

// Walk the route from the LUNC end back to the token, carrying each node's
// price in LUNC. Depth is the narrowest pool on the way, valued in LUNC - that
// leg is what a real sale would have to squeeze through, so quoting the wide
// pool at the far end would flatter the number.
// Both pool shapes reduced to the same two numbers: which asset, how much of
// it. Detected from the answer rather than remembered per pair, so a factory
// that changes its mind about the format does not silently produce nonsense.
async function reserves(pair){
  let r;
  try { r = await smart(pair, { pool: {} }); } catch (e) { return null; }
  const d = (r && r.data) || {};
  if (Array.isArray(d.assets)) {
    if (d.assets.length !== 2) return null;
    return d.assets.map(a => ({ key: infoKey(a.info), raw: a.amount }));
  }
  if (d.asset1 && d.reserve1 !== undefined) {
    return [{ key: infoKey(d.asset1), raw: d.reserve1 },
            { key: infoKey(d.asset2), raw: d.reserve2 }];
  }
  return null;
}

async function priceRoute(route){
  let price = 1, depth = Infinity;
  for (let i = route.length - 1; i > 0; i--) {
    const near = route[i].node, far = route[i - 1].node;
    const res = await reserves(route[i].pair);
    if (!res) return null;
    const keys = res.map(x => x.key);
    const iN = keys.indexOf(near), iF = keys.indexOf(far);
    if (iN < 0 || iF < 0) return null;
    const an = amt(res[iN].raw, await decimalsOf(near));
    const af = amt(res[iF].raw, await decimalsOf(far));
    if (!an || !af) return null;
    depth = Math.min(depth, an * price);
    price = price * an / af;
  }
  // The route is what a swap has to execute, not just what a price was derived
  // from. Keeping the pair addresses costs nothing here and saves finding them
  // again with a second round of factory queries at swap time.
  return { inLunc: price, depth: depth, hops: route.length - 1, route: route };
}

// Tokens that have not graduated to a pool still trade, against a curve. The
// factory maps a token to its curve, and the curve states its own price - so
// there is nothing to derive here, only to read.
const PUMP_FACTORY = 'terra1vd595gqyekq05p8hy9t0r9q68jtk5whleqt5py4wdwrqfykz74lqrmw8q5';

async function bondPrice(token){
  let r;
  // BondNotFound is the ordinary answer for most tokens, not an error worth
  // reporting - almost nothing on the chain is bonded. It arrives as a 500,
  // which the retry logic read as "later", so the one question on the chain
  // with the most permanent answer was being asked three times per token per
  // open. Once now, and the "no" is kept: a token graduating off a curve shows
  // up when the entry expires.
  const hit = cacheGet('bond:' + token);
  if (hit !== null) return hit || null;
  try { r = await smart(PUMP_FACTORY, { bond: { filter: { by_token: token } } }, 1); }
  catch (e) { if (e && e.status && e.status !== 429) cacheSet('bond:' + token, 0); return null; }
  const d = r && r.data;
  if (!d || !d.price) { cacheSet('bond:' + token, 0); return null; }
  const p = Number(d.price);
  if (!isFinite(p) || p <= 0) return null;
  const out = {
    inLunc: p,
    // real LUNC in the curve. virtual_reserve is formula, not funds.
    depth: amt(d.native_balance, 6),
    hops: 1,
    bond: true,
    status: d.status
  };
  // A curve's price moves with every buy, so this is the one cached answer
  // that goes stale on purpose - the six hour TTL is the whole point of not
  // keeping it longer.
  cacheSet('bond:' + token, out);
  return out;
}

// Ask every factory whether it holds this exact pair. TerraSwap shaped ones
// take asset_infos; Garuda names the sides asset1 and asset2. A factory that
// does not have the pair answers with an error, which is a normal answer here.
async function directPairs(token){
  // Which factories hold this pair changes when someone creates a pool, not
  // between two openings of a wallet.
  const hit = cacheGet('pair:' + token);
  if (hit) return hit;

  // If the map knows this token, it already says which pools pair it with
  // LUNC - five factory questions answered by a list we have in hand.
  const ow = await owMarket();
  if (ow) {
    const mine = (ow.edges['cw20:' + token] || [])
      .filter(e => e.to === LUNC_KEY).map(e => e.pair);
    if (mine.length) {
      cacheSet('pair:' + token, mine);
      return mine;
    }
  }

  const want = [];
  // A factory that fell over is not a factory that answered "no pair". Without
  // this the two look identical, and one 500 hides a token's price for as long
  // as the cache lives.
  let asked = 0;
  await Promise.all(FACTORIES.map(async f => {
    const q = f.k === 'code'
      ? { pair: { asset1: { cw20: token }, asset2: { native: 'uluna' } } }
      : { pair: { asset_infos: [
          { token: { contract_addr: token } },
          { native_token: { denom: 'uluna' } }
        ] } };
    let r;
    // One try. A factory that does not hold this pair answers 500 rather than
    // 400, and the retry logic reads that as "later" - so a question with one
    // permanent answer was being asked three times.
    //
    // That 500 is an ANSWER, and treating it as silence is what stopped the
    // negative below from ever being written: a token with no pool anywhere
    // left every factory "unheard", so nothing was cached and all five were
    // asked again on the next open, forever. Only a request that got no HTTP
    // reply at all - timeout, network, or a 429 meaning "later" - counts as
    // unheard now.
    try { r = await smart(f.a, q, 1); }
    catch (e) { if (e && e.status && e.status !== 429) asked += 1; return; }
    asked += 1;
    const d = (r && r.data) || {};
    const addr = d.contract_addr || d.contract || d.pair;
    if (addr) want.push(addr);
  }));
  // "No factory holds this pair" is an answer worth remembering. Without this
  // every token without a pool asked every factory again on every open, which
  // is where most of the 500s came from. A pool created in the meantime shows
  // up when the cache expires.
  // "No factory holds this pair" is worth remembering - but only when every
  // factory was actually heard from. A partial round says nothing.
  if (want.length || asked === FACTORIES.length) cacheSet('pair:' + token, want);
  return want;
}

// A one hop route built by hand, so the existing pricing code can read it.
async function priceDirect(token){
  const pairs = await directPairs(token);
  if (!pairs.length) return null;
  const priced = (await Promise.all(pairs.map(p => priceRoute([
    { node: 'cw20:' + token },
    { node: LUNC_KEY, pair: p }
  ]).catch(() => null)))).filter(Boolean);
  if (!priced.length) return null;
  priced.sort((a, b) => b.depth - a.depth);
  return priced[0];
}

// quick=true means: answer from what is already known. A cold graph is a
// thousand reads, and nothing that runs while someone is watching the screen
// should be allowed to start one.
async function poolPrice(token, quick){
  // the cheap question first - it answers for most tokens
  const direct = await priceDirect(token).catch(() => null);
  if (direct) return direct;

  if (quick && !GRAPH) return await bondPrice(token).catch(() => null);

  // no direct pool anywhere, so now it is worth knowing the whole market
  const g = await graph();
  const rs = routesToLunc(g, 'cw20:' + token, 3, 6);
  const priced = rs.length
    ? (await Promise.all(rs.map(r => priceRoute(r).catch(() => null)))).filter(Boolean)
    : [];
  if (priced.length) {
    priced.sort((a, b) => b.depth - a.depth);
    return priced[0];
  }
  return await bondPrice(token).catch(() => null);
}

export { DEC, assetOf, cacheGet, cacheGetStale, cacheSet, cl8yList, directPairs, directPeers, gdInfo, graph, graphPeers, graphReady, knownAsset, learnAsset, mapLimit, mapPrice, marketComplete, midsBetween, owLogo, owMarket, poolPrice, poolsBetween, reserves, simulateSwap, tsInfo, txCandidates };
