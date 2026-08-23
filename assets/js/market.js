import { EXTRA_PAIRS, FACTORIES, LCD, amt, getJSON, smart } from './chain.js?v=f478a2b1';

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

let GRAPH = null;
async function graph(){
  if (GRAPH) return GRAPH;
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
  return { inLunc: price, depth: depth, hops: route.length - 1 };
}

// Tokens that have not graduated to a pool still trade, against a curve. The
// factory maps a token to its curve, and the curve states its own price - so
// there is nothing to derive here, only to read.
const PUMP_FACTORY = 'terra1vd595gqyekq05p8hy9t0r9q68jtk5whleqt5py4wdwrqfykz74lqrmw8q5';

async function bondPrice(token){
  let r;
  // BondNotFound is the ordinary answer for most tokens, not an error worth
  // reporting - almost nothing on the chain is bonded
  try { r = await smart(PUMP_FACTORY, { bond: { filter: { by_token: token } } }); }
  catch (e) { return null; }
  const d = r && r.data;
  if (!d || !d.price) return null;
  const p = Number(d.price);
  if (!isFinite(p) || p <= 0) return null;
  return {
    inLunc: p,
    // real LUNC in the curve. virtual_reserve is formula, not funds.
    depth: amt(d.native_balance, 6),
    hops: 1,
    bond: true,
    status: d.status
  };
}

// Ask every factory whether it holds this exact pair. TerraSwap shaped ones
// take asset_infos; Garuda names the sides asset1 and asset2. A factory that
// does not have the pair answers with an error, which is a normal answer here.
async function directPairs(token){
  // Which factories hold this pair changes when someone creates a pool, not
  // between two openings of a wallet.
  const hit = cacheGet('pair:' + token);
  if (hit) return hit;
  const want = [];
  await Promise.all(FACTORIES.map(async f => {
    const q = f.k === 'code'
      ? { pair: { asset1: { cw20: token }, asset2: { native: 'uluna' } } }
      : { pair: { asset_infos: [
          { token: { contract_addr: token } },
          { native_token: { denom: 'uluna' } }
        ] } };
    let r;
    try { r = await smart(f.a, q); } catch (e) { return; }
    const d = (r && r.data) || {};
    const addr = d.contract_addr || d.contract || d.pair;
    if (addr) want.push(addr);
  }));
  if (want.length) cacheSet('pair:' + token, want);
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

async function poolPrice(token){
  // the cheap question first - it answers for most tokens
  const direct = await priceDirect(token).catch(() => null);
  if (direct) return direct;

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

export { DEC, cacheGet, cacheGetStale, cacheSet, graph, mapLimit, marketComplete, poolPrice, txCandidates };
