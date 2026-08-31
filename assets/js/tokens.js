import { CW20, LCD, NATIVE, THIN_LUNC, amt, chainLogo, fmt, getJSON, iconHTML, paintIcons, prices, smart, usd } from './chain.js?v=48d619ff';
import { DEC, cacheGet, cacheGetStale, cacheSet, cl8yList, graph, graphReady, knownAsset, mapLimit, mapPrice, marketComplete, owLogo, owMarket, poolPrice, txCandidates } from './market.js?v=48d619ff';
import { $, go } from './shell.js?v=48d619ff';

// keep=true means this contract is on the address's list, so it earns a row
// even at zero. Only an unknown contract has to prove itself with a balance.
async function tokenRow(c, addr, known, keep){
  try {
    // The symbol, the decimals and the logo were fixed when this contract was
    // deployed. Only the balance is worth asking about again.
    let fixed = cacheGet('ti:' + c);
    const [info, bal, mkt] = await Promise.all([
      fixed ? null : smart(c, { token_info: {} }),
      known === undefined
        ? smart(c, { balance: { address: addr } })
        : Promise.resolve({ data: { balance: known } }),
      fixed ? null : smart(c, { marketing_info: {} }).catch(() => null)
    ]);
    if (!fixed) {
      const t = info.data;
      fixed = {
        sym: t.symbol,
        dec: t.decimals,
        note: t.name,
        // the contract's own logo first, then the map's. Eight of your tokens
        // have nothing in marketing_info, and the chain simply has no picture
        // for them - it has to come from somewhere else or not at all.
        logo: (await chainLogo(c, mkt).catch(() => null)) || owLogo(c) || null
      };
      cacheSet('ti:' + c, fixed);
    }
    /* Laid over the record when it is read, not when it is written.
       The issuer's list outranks the contract's own string - CL8Y ships as
       "CL8Y-cb" and is called CL8Y everywhere it is traded, including by the
       people who issued it. Doing this at write time meant the six hour cache
       kept the old name for everyone who already had a record, which is
       everyone; a name published tomorrow would have waited for the record to
       expire before it appeared. */
    const pub = knownAsset('cw20:' + c);
    const d = { symbol: (pub && pub.sym) || fixed.sym,
                decimals: fixed.dec, name: fixed.note };
    if (pub && pub.logo && !fixed.logo) fixed = Object.assign({}, fixed, { logo: pub.logo });
    DEC['cw20:' + c] = d.decimals;
    const v = amt(bal.data && bal.data.balance, d.decimals);
    if (!(v > 0) && !keep) return null;
    // No pricing here. A balance is the one read that has to happen; a price is
    // many, and making the row wait on them is what left the screen empty.
    // dec travels with the row. It was used to compute v and then thrown away,
    // and every reader downstream had to assume six.
    return { sym: d.symbol, v: v, dec: d.decimals, note: d.name,
             logo: fixed.logo, pool: null, contract: c };
  } catch (e) { return null; }   // a dead contract must not take the screen down
}

// Prices whatever rows are on screen and redraws once. Called after each
// render, so an early list gets its numbers as soon as the market is readable.
// what the send screen is allowed to offer as "max"
let LUNC_RAW = 0;
const luncRaw = () => LUNC_RAW;

/* ---------------- the address's own token list ----------------
   This is the wallet's memory of what you hold, and it is only ever added to.
   A sweep that came back short must never be able to shorten it - that is how
   a token drops off the screen and then stops being looked for at all.
*/
function registry(addr){
  const r = cacheGetStale('reg:' + addr);
  if (Array.isArray(r)) return r;
  // first run after the change: adopt whatever the old list knew, so nobody
  // has to rediscover a wallet they already had
  const old = cacheGetStale('held:' + addr);
  const seed = Array.isArray(old) ? old : [];
  cacheSet('reg:' + addr, seed);
  return seed;
}

function remember(addr, contracts){
  const merged = registry(addr).concat(contracts.filter(Boolean));
  const out = merged.filter((c, i, a) => a.indexOf(c) === i);
  cacheSet('reg:' + addr, out);
  return out;
}

function forget(addr, contract){
  cacheSet('reg:' + addr, registry(addr).filter(c => c !== contract));
}

const keyOfRow = r => r.contract ? 'cw20:' + r.contract : 'native:' + r.denom;

/* One walk per session, and only on demand.
   Nothing here is speculative: it runs when rows exist that cannot be priced
   any other way, after they have already been drawn without prices. */
let FILLING = false;
function fillDeferred(list, found, px){
  if (FILLING || graphReady()) return;
  FILLING = true;
  graph()
    .then(function () { return priceRows(list, found, px); })
    .catch(function () {});
}

let PRICING = 0;
async function priceRows(list, found, px){
  const mine = ++PRICING;
  // Three things disqualify a row, not one. `tried` means it was asked and the
  // market had no answer; asking again in the same load produces the same
  // silence. `asking` means an earlier pass is in flight on it right now -
  // without that flag the sweep's pass re-requested every token the opening
  // pass had not finished paying for yet.
  //
  // `deferred` is the exception to `tried`: the row was not answered, it was
  // set aside because pricing it needed a market map nobody had yet. Once the
  // sweep has built one, it is worth asking again - and only then.
  // Asked once here rather than once per row: it reads a stored pair list of
  // several hundred entries out of localStorage, and nothing can build the
  // graph between this line and the end of this pass anyway.
  const ready = graphReady();
  // An IBC denom has no contract, and the filter asked for one - so USDC, which
  // the map prices in a single hop, was never even in the list. What decides is
  // whether the market can be asked about it, not which shape of address it
  // happens to have. uluna and uusd stay out: their price comes from the feed.
  const todo = found.filter(r => (r.contract || (r.denom && r.denom.slice(0, 4) === 'ibc/')) &&
    !r.pool && !r.asking && !px[r.sym] &&
    (!r.tried || (r.deferred && ready)));
  if (!todo.length) return;
  todo.forEach(r => { r.asking = true; r.deferred = false; });

  // What can be answered from a direct pool or a bonding curve, which is most
  // of any wallet. Drawn as soon as it is in, so the screen fills instead of
  // waiting on whichever token is slowest.
  const quick = await mapLimit(todo, 10, r => (r.contract
    ? poolPrice(r.contract, true)
    : mapPrice(keyOfRow(r))).catch(() => null));
  // Recorded BEFORE the staleness check. An answer belongs to the row, not to
  // the pass that fetched it; discarding it because a newer pass had started
  // meant the newer pass repeated every request the first one had just paid
  // for. Only the drawing is stale, not the data.
  // tried, whatever the answer. Without this a row with no price is
  // indistinguishable from a row whose price has not been asked for yet.
  todo.forEach((r, i) => { if (quick[i]) r.pool = quick[i]; r.tried = true; r.asking = false; });
  if (mine !== PRICING) return;   // a newer pass owns the screen
  renderTokens(list, found, px, LAST.hint);

  // The rest have no direct pool and no curve, so pricing them means routing
  // through other pools, which means the whole market map. That comment above
  // poolPrice - nothing that runs while someone is watching the screen should
  // start a cold graph - was true, but this call was the one starting it: a
  // thousand reads fired in the background of an ordinary open, quietly eating
  // the same six-wide queue everything else was waiting in.
  //
  // Set aside instead. The daily sweep builds the map for its own reasons and
  // the pass that follows it picks these up; the scan button forces the same
  // thing on demand. A handful of tokens priced a load late beats every load
  // being slow.
  const rest = todo.filter(r => !r.pool);
  if (!rest.length) return;

  // Two hops, off the map, before anything is deferred. UST1 has no pool
  // against LUNC at all - it trades against cUSTC - and that used to mean
  // waiting for a sweep to build a graph. The map already knows both legs.
  const hop = await mapLimit(rest, 4, r => mapPrice(keyOfRow(r)).catch(() => null));
  rest.forEach((r, i) => { if (hop[i]) r.pool = hop[i]; });

  // Whatever two hops could not reach is where the full graph would have been
  // the only answer, and that is still not worth building while someone is
  // looking at the screen.
  const left = rest.filter(r => !r.pool);
  if (left.length && !ready) {
    left.forEach(r => { r.deferred = true; });
    // The walk is the only thing that can answer for these, and this is the
    // wallet's own list saying which. Started behind the finished screen rather
    // than in front of it, and once per session - the sweep would get here
    // eventually, but "eventually" is up to a day away on a device that swept
    // this morning.
    fillDeferred(list, found, px);
  } else if (left.length) {
    const slow = await mapLimit(left, 4, r => (r.contract
      ? poolPrice(r.contract)
      : Promise.resolve(null)).catch(() => null));
    left.forEach((r, i) => { if (slow[i]) r.pool = slow[i]; });
  }
  rest.forEach(r => { r.tried = true; r.asking = false; if (r.pool) r.deferred = false; });
  if (mine !== PRICING) return;
  renderTokens(list, found, px, LAST.hint);
}

// What a row is worth, or null. Same inputs, same arithmetic as the list.
function fiatOf(t){
  const px = (LAST && LAST.px) || {};
  if (!t) return null;
  if (px[t.sym]) return (t.v || 0) * px[t.sym];
  if (t.pool && px.LUNC) return (t.v || 0) * t.pool.inLunc * px.LUNC;
  return null;
}

const HOME_NOTE = 'LUNC and USTC use a price feed. Everything else is priced from pools on chain, ' +
  'following a route to LUNC when there is no direct pair. The depth shown is the narrowest pool ' +
  'on that route, because that is the leg a real sale has to fit through.';

let HIDE_DUST = false;
try { HIDE_DUST = localStorage.getItem('fw:dust') === '1'; } catch (e) {}
let LAST = { found: [], px: {}, hint: '' };
// The order the list is drawn in, settled at the end of a complete reading and
// held through the incomplete ones that follow.
let ORDER = [];
// True while the market sweep is still running, which is exactly the window in
// which the total is real but incomplete. TOTAL_SHOWN is the last one that was
// not.
let SWEEPING = false, TOTAL_SHOWN = null;
// set by the button; makes the next load do a full sweep regardless of when
// the last one ran
let FORCE_SWEEP = false;
// the address the visible list belongs to
let LAST_ADDR = null;
// One pass at a time, and not more often than the chain produces blocks.
let RUNNING = false, LOADED_AT = 0;
// This node answers 501 to denom_traces: the endpoint is not built here, and
// it will not be built by the next open either. That is a fact about the node,
// worth learning once a session rather than rediscovering with two sequential
// requests in front of every first paint.
let IBC_TRACES = true;
// What each token was worth the last time a sweep finished. A price that
// blinks out to "no price" on every refresh reads as the token having lost its
// market, which is a far bigger claim than "not asked yet".
const PRICE_SEEN = {};

// anything that rounds to $0.00 on screen counts as dust
const DUST = 0.005;

// LUNC and USTC are pinned above the list. Both slots stay put even when one is
// empty: a zero on a core asset is exactly the number a user came to check, and
// a panel that changes shape with the balance is a panel you cannot trust.
const CORE_SYMS = ['LUNC', 'USTC'];
// What a row is, as far as the screen is concerned. Two rows with this same
// key are the same row grown older, and must be edited rather than replaced.
function rowKey(t){
  return t.contract || t.denom || ('sym:' + t.sym);
}

// The panel's shape never changes - two cells and a seam - so it is built once
// and edited afterwards. Rebuilding it threw away the two <img> elements the
// user looks at most, and they came back a letter at a time.
function renderCore(rows){
  const box = $('#core');
  if (!box) return;
  if (!box.querySelector('.core-cell')) {
    box.innerHTML = CORE_SYMS.map((sym, n) =>
      (n ? '<div class="core-seam"></div>' : '') +
      '<div class="core-cell" data-sym="' + sym + '">' +
        '<div class="core-top">' +
          '<span class="core-dot"></span>' +
          '<span class="core-sym">' + sym + '</span>' +
        '</div>' +
        '<div class="core-usd">\u2014</div>' +
        '<div class="core-qty">0</div>' +
      '</div>').join('');
  }
  let painted = false;
  CORE_SYMS.forEach(sym => {
    const cell = box.querySelector('.core-cell[data-sym="' + sym + '"]');
    if (!cell) return;
    const r = rows.find(x => x.t.sym === sym);
    // the placeholder dot becomes a real icon exactly once, when a row for this
    // asset first exists
    if (r && cell.querySelector('.core-dot')) {
      cell.querySelector('.core-dot').outerHTML = iconHTML(r.t);
      painted = true;
    }
    const usdEl = cell.querySelector('.core-usd');
    const has = !!r && r.fiat !== null;
    setText(usdEl, has ? (r.shaky ? '\u2248' : '') + usd(r.fiat) : '\u2014');
    usdEl.classList.toggle('soft', !!(r && r.shaky));
    setText(cell.querySelector('.core-qty'), fmt(r ? r.t.v : 0));
  });
  if (painted) paintIcons(box);
}

// Touching textContent when nothing changed still costs a layout pass on some
// webviews, and there are several redraws per load.
function setText(el, s){
  if (el && el.textContent !== s) el.textContent = s;
}

// Everything inside the <li> except the <li> itself, so the same markup builds
// a new row and is never used to rebuild an existing one.
function rowInner(r){
  const t = r.t;
  return iconHTML(t) +
    '<div class="row-main"><div class="row-name">' + t.sym + '</div>' +
    '<div class="row-amt"></div></div>' +
    '<div class="row-val"><div class="row-fiat"></div>' +
    '<div class="row-sub"></div></div>';
}

function updateRow(el, r){
  const t = r.t;
  setText(el.querySelector('.row-amt'), fmt(t.v) + (t.note ? ' \u00b7 ' + t.note : ''));
  const fiatEl = el.querySelector('.row-fiat');
  setText(fiatEl, r.fiat !== null ? (r.shaky ? '\u2248' : '') + usd(r.fiat) : '\u2014');
  fiatEl.classList.toggle('soft', !!r.shaky);
  const subEl = el.querySelector('.row-sub');
  setText(subEl, r.sub);
  subEl.style.color = (t.pool && t.pool.depth < THIN_LUNC) ? 'var(--gold)' : '';
  // A row can be drawn from a snapshot, which carries no logo, before the
  // contract's own picture has been read. When it arrives the icon is worth
  // one replacement - but only then, and only if a letter is still showing.
  const ic = el.querySelector('.sym');
  if (t.logo && ic && !ic.classList.contains('has-img') &&
      (ic.getAttribute('data-logo') || '') !== t.logo) {
    ic.outerHTML = iconHTML(t);
    paintIcons(el);
  }
}

/* Rows are matched to the elements already on screen by key, edited in place,
   and moved with insertBefore - which relocates a live node rather than
   building a new one, so an <img> that has finished loading stays loaded. The
   old code assigned innerHTML on every redraw, and with six redraws in a load
   every icon fell back to its letter six times while the browser fetched a
   picture it already had. */
function syncList(list, shown, emptyMsg){
  if (!shown.length) {
    if (!list.querySelector('li.empty')) list.innerHTML = '';
    const e = list.querySelector('li.empty');
    if (e) setText(e, emptyMsg);
    else {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = emptyMsg;
      list.appendChild(li);
    }
    return;
  }
  const gone = list.querySelector('li.empty');
  if (gone) gone.remove();

  const have = {};
  Array.prototype.forEach.call(list.querySelectorAll('li.row[data-k]'), el => {
    have[el.getAttribute('data-k')] = el;
  });

  let prev = null;
  const fresh = [];
  shown.forEach(r => {
    const k = rowKey(r.t);
    let el = have[k];
    if (el) {
      delete have[k];
      updateRow(el, r);
    } else {
      el = document.createElement('li');
      el.className = 'row';
      el.setAttribute('data-k', k);
      el.innerHTML = rowInner(r);
      updateRow(el, r);
      fresh.push(el);
    }
    const at = prev ? prev.nextSibling : list.firstChild;
    if (el !== at) list.insertBefore(el, at);
    prev = el;
  });
  for (const k in have) have[k].remove();
  fresh.forEach(el => paintIcons(el));
}
function renderTokens(list, found, px, hint){
  LAST = { found: found, px: px, hint: hint };

  const rows = found.map(t => {
    let fiat = null, sub = 'no price';
    if (px[t.sym]) {
      fiat = t.v * px[t.sym];
      sub = '';
    } else if (t.pool && px.LUNC) {
      fiat = t.v * t.pool.inLunc * px.LUNC;
      // a curve is not a pool and should not be described as one
      sub = t.pool.bond
        ? 'bonding curve, ' + fmt(t.pool.depth) + ' LUNC' +
          (t.pool.status && t.pool.status !== 'OPEN' ? ' \u00b7 ' + t.pool.status.toLowerCase() : '')
        : t.pool.hops > 1
          ? t.pool.hops + ' hops \u00b7 narrowest leg ' + fmt(t.pool.depth) + ' LUNC'
          : (t.pool.depth < THIN_LUNC ? 'thin pool, ' : 'pool ') + fmt(t.pool.depth) + ' LUNC';
    }
    // A curve states its own price and is not a route, so it is never shaky.
    // Everything else that had to pass through a link this thin is a guess.
    const shaky = !!(t.pool && !t.pool.bond && t.pool.depth < THIN_LUNC);
    return { t: t, fiat: fiat, sub: sub, shaky: shaky };
  });

  // A native row carries no contract, so it fell out of this check entirely -
  // and with it LUNC and USTC, whose price comes from the feed rather than
  // from a pool. When the feed was slow or refused, the total declared itself
  // final while missing the two largest holdings, then jumped when the feed
  // came back. Other native denoms are excluded on purpose: an IBC balance has
  // no price here and never will, so waiting on one would dim the total for
  // good.
  const waiting = rows.some(r => r.fiat === null &&
    (r.t.contract ? !r.t.tried : CORE_SYMS.indexOf(r.t.sym) >= 0));
  // Two different questions were being answered by one flag. SWEEPING means
  // the list can still grow; `waiting` means the prices are still arriving.
  // Either one makes this reading provisional, and only a reading that is not
  // provisional may define, or retract, what a token is worth.
  const settling = SWEEPING || waiting;

  rows.forEach(function (r) {
    const k = r.t.sym;
    if (r.fiat !== null) {
      if (!settling) PRICE_SEEN[k] = { fiat: r.fiat, sub: r.sub };
    } else if (settling && PRICE_SEEN[k]) {
      r.fiat = PRICE_SEEN[k].fiat;
      r.sub = PRICE_SEEN[k].sub;
      r.shaky = true;             // last known, not current - and it says so
    } else if (!settling) {
      // asked in full and no price came back: the old one is now a fiction
      delete PRICE_SEEN[k];
    }
  });

  // by value, not by count - a hundred dollars belongs above eight cents no
  // matter how many decimal places the cheaper token happens to have
  const rank = r => (r.fiat === null ? -1 : r.fiat);
  // ...but not while the values are still arriving. Sorting on a key that is
  // -1 now and four hundred a second from now means the row a finger is
  // reaching for has moved by the time it lands. The order is settled once,
  // when the reading is complete, and held until the next complete one; rows
  // found in between keep their place and newcomers go at the end.
  if (!settling || !ORDER.length) {
    rows.sort((a, b) => rank(b) - rank(a) || b.t.v - a.t.v);
    if (!settling) ORDER = rows.map(r => rowKey(r.t));
  } else {
    const pos = {};
    ORDER.forEach((k, i) => { pos[k] = i; });
    rows.sort((a, b) => {
      const ia = pos[rowKey(a.t)], ib = pos[rowKey(b.t)];
      if (ia === undefined && ib === undefined) return rank(b) - rank(a) || b.t.v - a.t.v;
      if (ia === undefined) return 1;
      if (ib === undefined) return -1;
      return ia - ib;
    });
  }

  const total = rows.reduce((a, r) => a + (r.fiat || 0), 0);
  // "no price" is not the same as "worth nothing" - TCO has no pool yet, and
  // hiding 4.8 million of it behind a dust filter would be a lie
  renderCore(rows);
  // pinned above, so the list must not repeat them
  const rest = rows.filter(r => CORE_SYMS.indexOf(r.t.sym) < 0);
  const shown = HIDE_DUST ? rest.filter(r => r.fiat === null || r.fiat >= DUST) : rest;

  syncList(list, shown, rest.length
    ? 'Everything priced here rounds to zero. Turn off hide $0 to see it.'
    : 'This address holds nothing yet.');
  // the hidden ones are still counted, so the number never lies about the wallet
  $('#tok-count').textContent = !rest.length ? ''
    : (shown.length < rest.length ? shown.length + ' of ' + rest.length : String(rest.length));
  // The list may fill in as tokens are found - that reads as progress. The
  // total may not: a number that drops to a fifth and climbs back looks like
  // money went missing, and after a swap that is a frightening thing to show.
  // A total is complete when every token in it has had its price asked for -
  // not when the sweep happens to be idle. The balances arrive long before the
  // prices do, and calling that moment "complete" is what froze $2.34 over a
  // list worth two hundred.
  const totalEl = $('#bal-total');
  if (!settling) {
    TOTAL_SHOWN = total;
    totalEl.textContent = usd(total);
    totalEl.classList.remove('stale');
  } else {
    // Dimmed and climbing as prices land. It reads as loading, which is what
    // it is; a frozen figure reads as final, which it is not.
    totalEl.textContent = usd(Math.max(total, waiting ? 0 : (TOTAL_SHOWN || 0)));
    totalEl.classList.add('stale');
  }
  // on a cold start there is nothing honest to put here yet, so the placeholder
  // stays until the sweep finishes
  $('#home-note').textContent = hint || HOME_NOTE;
}

(function wireDust(){
  const b = $('#dust-toggle');
  if (!b) return;
  b.classList.toggle('on', HIDE_DUST);
  b.addEventListener('click', () => {
    HIDE_DUST = !HIDE_DUST;
    try { localStorage.setItem('fw:dust', HIDE_DUST ? '1' : '0'); } catch (e) {}
    b.classList.toggle('on', HIDE_DUST);
    renderTokens($('#tok-list'), LAST.found, LAST.px, LAST.hint);
  });
})();

// force=true is the button and the post-send refresh: those know something
// changed and are worth interrupting the schedule for. Everything else is
// polling and can be skipped.
async function loadBalances(addr, force){
  // The guard lives here because there is no other way in. Callers used to
  // reach around it, which is how three passes ended up sharing one list.
  if (RUNNING) return;
  if (!force && addr === LAST_ADDR && Date.now() - LOADED_AT < 15000) return;
  RUNNING = true;
  LAST_ADDR = addr;
  const list = $('#tok-list');
  SWEEPING = true;
  try {

  // The last complete reading, drawn before a single request goes out. It is
  // minutes old at worst and it is replaced as soon as the chain answers - but
  // it means the wallet opens with numbers in it instead of a blank waiting to
  // be filled, which is the whole difference in how fast this feels.
  try {
    const snap = cacheGetStale('snap:' + addr);
    if (snap && Array.isArray(snap.found) && snap.found.length) {
      SWEEPING = false;              // that reading was complete when it was saved
      renderTokens(list, snap.found, snap.px || {}, 'Checking for changes.');
      SWEEPING = true;
    }
  } catch (e) { /* a bad snapshot is not worth failing the open over */ }

  try {
    // The feed used to be awaited alongside the balances, so nothing at all
    // was drawn until CoinGecko answered - and from a phone it answers 429
    // often enough that three paced retries put twenty seconds of blank screen
    // in front of a wallet whose balances were already in hand. It runs on its
    // own now, seeded from the last figures it gave us, and the screen is
    // redrawn if and when it lands.
    // Kicked off, not awaited: it is needed to name IBC denoms a few lines
    // below, and it will be needed for pricing a moment later regardless. On a
    // warm cache it is a localStorage read.
    const owReady = owMarket().catch(() => null);
  // one local file, and it names assets neither the feed nor the chain will
  const listReady = cl8yList().catch(() => null);
    const bank = await getJSON(LCD + '/cosmos/bank/v1beta1/balances/' + addr);
    const px = Object.assign({}, cacheGetStale('px') || {});
    prices().then(function (fresh) {
      if (!fresh || (!fresh.LUNC && !fresh.USTC)) return;
      cacheSet('px', fresh);
      Object.assign(px, fresh);
      if (LAST_ADDR !== addr || !LAST.found.length) return;
      // whichever pass owns the screen now, not necessarily this one
      Object.assign(LAST.px, fresh);
      renderTokens(list, LAST.found, LAST.px, LAST.hint);
    }).catch(function () {});

    const found = [];

    // every native denom the address actually holds, ibc ones resolved to
    // whatever they were before they crossed the bridge
    for (const b of (bank.balances || [])) {
      if (NATIVE[b.denom]) {
        const m = NATIVE[b.denom];
        // the denom is what a swap has to name in offer_asset; the symbol is
        // only what a human reads
        found.push({ sym: m.sym, v: amt(b.amount, m.dec), note: '', denom: b.denom, dec: m.dec });
        if (b.denom === 'uluna') LUNC_RAW = Number(b.amount);
      } else if (b.denom.startsWith('ibc/')) {
        let sym = 'IBC', note = b.denom.slice(4, 12) + '\u2026';
        // The market map names the denoms that actually trade, which is the set
        // worth naming, and it is already loaded. The node is asked only for
        // what the map has never heard of.
        await owReady; await listReady;
        const mapped = knownAsset('native:' + b.denom);
        if (mapped && mapped.sym) {
          found.push({ sym: mapped.sym, v: amt(b.amount, mapped.dec), note: 'IBC',
                       denom: b.denom, dec: mapped.dec, logo: mapped.logo });
          continue;
        }
        // A hash resolves to the same trace forever, so the answer is worth
        // keeping; and where the node refuses to answer at all, that refusal
        // is worth keeping too. Both were being paid for on every open, in the
        // one place where the cost is visible - before anything is drawn.
        const seen = cacheGetStale('ibc:' + b.denom);
        if (seen && seen.sym) {
          sym = seen.sym;
          note = seen.note;
        } else if (IBC_TRACES) {
          try {
            const tr = await getJSON(LCD + '/ibc/apps/transfer/v1/denom_traces/' + b.denom.slice(4));
            const base = tr.denom_trace.base_denom;
            sym = (base.startsWith('u') ? base.slice(1) : base).toUpperCase();
            note = tr.denom_trace.path;
            cacheSet('ibc:' + b.denom, { sym: sym, note: note });
          } catch (e) {
            // not "this denom is unknown" but "this node does not do this"
            if (e && e.status === 501) IBC_TRACES = false;
          }
        }
        found.push({ sym: sym, v: amt(b.amount, 6), note: note, denom: b.denom, dec: 6 });
      } else {
        found.push({ sym: b.denom.toUpperCase(), v: amt(b.amount, 6), note: '', denom: b.denom, dec: 6 });
      }
    }

    // the seeded few first, so the screen is useful within a second
    // Balances are already in hand at this point - put them on screen before
    // anything that talks to a pool.
    //
    // On a refresh there is already a fuller list on screen than this, because
    // `found` here is natives only: the CW20 rows are read below. Drawing it
    // would blank every token for a second or two on a timer, which is what the
    // 45 second poll was doing. A cold open has nothing better to show, so it
    // still draws.
    if (!LAST.found.length) renderTokens(list, found, px, 'Reading your tokens.');

    // The list, and nothing but the list. This is the whole of a normal open.
    // one request, and every logo and decimal below comes for free
    await owMarket().catch(() => null);

    const mine = registry(addr);
    const firstRound = CW20.concat(mine.filter(c => CW20.indexOf(c) < 0));

    // Ten at a time: enough to finish in about a second, few enough that the
    // node does not start refusing.
    const seeded = await mapLimit(firstRound, 10, c => tokenRow(c, addr, undefined, true));
    for (const r of seeded) if (r) found.push(r);
    remember(addr, seeded.filter(Boolean).map(r => r.contract));
    // From here the list is complete as far as this address knows, so the
    // total is honest even though prices are still arriving.
    SWEEPING = false;
    renderTokens(list, found, px, '');
    // Not awaited here - the sweep below must not wait on prices. Kept, though,
    // because the snapshot at the end must.
    const opening = priceRows(list, found, px).catch(() => null);

    // then everything that trades anywhere, which is the part nobody should
    // have to maintain by hand
    // two sources, one list: what trades somewhere, and what ever arrived here.
    // Contracts that are not tokens at all just answer nothing to balance{}.
    const seed = {};
    for (const c of firstRound) seed[c] = 1;
    // The full sweep asks balance{} of every contract the market knows - two
    // hundred requests, which is where the 429s came from. What it finds
    // barely changes between openings, and the remembered list above already
    // covers everything this address holds, so the sweep runs on a schedule
    // instead of on every open. A new token arriving is worth an hour's wait.
    // Once a day on its own, or whenever you press the button. Never in the
    // way of the balances above.
    const SWEEP_EVERY = 24 * 60 * 60 * 1000;
    const sweptAt = Number(cacheGetStale('swept:' + addr) || 0);
    const skipSweep = !FORCE_SWEEP && Date.now() - sweptAt < SWEEP_EVERY;
    FORCE_SWEEP = false;
    if (!skipSweep) {
      renderTokens(list, found, px, 'Looking for tokens this address has not seen before.');
    }
    // The graph is a thousand reads. It is only built when something is
    // actually going to be done with it.
    const [g, txc] = skipSweep
      ? [{ tokens: [] }, []]
      : await Promise.all([graph(), txCandidates(addr).catch(() => [])]);
    const rest = skipSweep ? [] : g.tokens.concat(txc)
      .filter((c, i, a) => !seed[c] && a.indexOf(c) === i);
    if (!skipSweep) cacheSet('swept:' + addr, Date.now());

    const bals = await mapLimit(rest, 14, async c => {
      try { const r = await smart(c, { balance: { address: addr } }); return (r.data && r.data.balance) || '0'; }
      catch (e) { return '0'; }
    });
    const hits = [];
    rest.forEach((c, i) => { if (Number(bals[i]) > 0) hits.push({ c: c, bal: bals[i] }); });
    // Only now is the total actually incomplete: rows are about to join the
    // list. A sweep that finds nothing - which is nearly every sweep - never
    // makes the figure provisional at all.
    if (hits.length) SWEEPING = true;

    const rows = await mapLimit(hits, 6, h => tokenRow(h.c, addr, h.bal));
    for (const r of rows) if (r) found.push(r);

    // remember the CW20 contracts that came back with something, so the next
    // open starts from the answer. A token spent down to zero simply drops out
    // of the list next time, because this is rewritten from the full sweep.
    // Only ever add. A sweep that came back short would otherwise erase a real
    // holding from the list, and the next open would not look for it at all -
    // which is exactly how UST1 disappeared instead of merely arriving late.
    // A token spent to zero costs one wasted query per open, which is cheap
    // next to forgetting one you still own.
    // anything the sweep turned up joins the list for good
    remember(addr, found.map(r => r.contract).concat(hits.map(h => h.c)));
    await opening;
    await priceRows(list, found, px);
    // everything that could be found has been found and priced; from here the
    // total is the whole wallet
    SWEEPING = false;
    // kept for the next open. Logos are dropped: a contract logo arrives as a
    // base64 data url and would fill the storage quota by itself.
    try {
      cacheSet('snap:' + addr, {
        found: found.map(function (t) {
          const c = {};
          for (const k in t) if (k !== 'logo') c[k] = t[k];
          return c;
        }),
        px: px
      });
    } catch (e) {}
    renderTokens(list, found, px, marketComplete() ? '' :
      'Could not read every exchange just now, so some prices may be based on ' +
      'the wrong pool. Reopening usually fixes it.');
  } catch (e) {
    SWEEPING = false;
    list.innerHTML = '<li class="empty">Could not reach the chain: ' + (e.message || e) + '</li>';
    // a failed read is not a zero balance, and must not be drawn as one
    if (TOTAL_SHOWN === null) $('#bal-total').textContent = '\u2014';
  }
  } finally {
    RUNNING = false;
    LOADED_AT = Date.now();
  }
}

async function loadStaking(addr){
  const body = $('#stk-body');
  try {
    const [dels, rew] = await Promise.all([
      getJSON(LCD + '/cosmos/staking/v1beta1/delegations/' + addr),
      getJSON(LCD + '/cosmos/distribution/v1beta1/delegators/' + addr + '/rewards').catch(() => ({}))
    ]);
    const rows = dels.delegation_responses || [];
    $('#stk-count').textContent = rows.length ? rows.length + ' validator' + (rows.length > 1 ? 's' : '') : '';
    if (!rows.length) {
      body.innerHTML = '<div class="empty">Nothing staked yet. Delegating LUNC earns rewards and gives your address weight in governance votes.</div>';
      return;
    }
    const staked = rows.reduce((a, r) => a + amt(r.balance && r.balance.amount, 6), 0);
    let pending = 0;
    (rew.total || []).forEach(t => { if (t.denom === 'uluna') pending += amt(t.amount, 6); });

    body.innerHTML =
      '<div class="bal" style="margin-bottom:14px"><div class="bal-label">Staked</div>' +
      '<div class="bal-value" style="font-size:32px">' + fmt(staked) + ' <span style="font-size:18px;color:var(--muted)">LUNC</span></div>' +
      '<div class="row-sub" style="margin-top:8px">Rewards ' + fmt(pending) + ' LUNC</div></div>' +
      rows.map(r =>
        '<div class="row"><span class="sym" style="background:var(--surface2);color:var(--muted)">\u25c8</span>' +
        '<div class="row-main"><div class="row-name" style="font-size:13px;word-break:break-all">' +
        r.delegation.validator_address.slice(0,20) + '\u2026</div></div>' +
        '<div class="row-val"><div class="row-fiat">' + fmt(amt(r.balance.amount, 6)) + '</div></div></div>'
      ).join('') +
      '<p class="tiny">Unstaking takes 21 days. Sending and claiming are not wired up in this build.</p>';
  } catch (e) {
    body.innerHTML = '<div class="empty">Could not load staking: ' + (e.message || e) + '</div>';
  }
}

// Which address the screen is showing, so anything can ask for a fresh read
// without carrying the address around.
// Two sessions each kept the address under their own name. One of them had
// to go, and the guard they each half-implemented now lives in loadBalances.

// A balance changes when a block lands, not when a transaction was signed, so
// the screen has to be told to look again. Two guards: never twice at once,
// and never more often than every fifteen seconds - the chain does not move
// faster than that, and neither should the polling.
async function refreshBalances(force){
  if (!LAST_ADDR) return;
  try { await loadBalances(LAST_ADDR, force); }
  catch (e) { /* a failed refresh is not a failed swap */ }
}

// Only while the wallet is actually on screen. A mini app that keeps polling
// after it is closed is a battery complaint waiting to happen.
const onHome = () => {
  const h = document.getElementById('st-home');
  return !document.hidden && h && h.classList.contains('on');
};
setInterval(() => { if (onHome()) refreshBalances(false); }, 45000);
document.addEventListener('visibilitychange', () => { if (onHome()) refreshBalances(false); });

function openWallet(addr){
  LAST_ADDR = addr;
  $('#home-addr').textContent = addr.slice(0,14) + '\u2026' + addr.slice(-6);
  go('home');
  loadBalances(addr);
  loadStaking(addr);
}

// The swap screen needs the same rows the list is drawn from, priced and all.
// Handing back LAST.found beats asking the chain a second time.
const heldTokens = () => LAST.found || [];
export { fiatOf, forget, registry, remember, heldTokens, luncRaw, openWallet, refreshBalances };

// A sweep is two hundred requests. It is worth doing on demand and worth not
// doing otherwise, so it gets a button that says what it is doing.
(function wireScan(){
  const b = $('#tok-scan');
  if (!b) return;
  b.addEventListener('click', async () => {
    if (b.dataset.busy || !LAST_ADDR) return;
    b.dataset.busy = '1';
    const was = b.textContent;
    b.textContent = 'looking...';
    FORCE_SWEEP = true;
    try { await loadBalances(LAST_ADDR, true); } catch (e) { /* the banner reports it */ }
    b.textContent = was;
    delete b.dataset.busy;
  });
})();
