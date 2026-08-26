import { CW20, LCD, NATIVE, THIN_LUNC, amt, chainLogo, fmt, getJSON, iconHTML, paintIcons, prices, smart, usd } from './chain.js?v=06044790';
import { DEC, cacheGet, cacheGetStale, cacheSet, graph, mapLimit, marketComplete, poolPrice, txCandidates } from './market.js?v=06044790';
import { $, go } from './shell.js?v=06044790';

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
        logo: (await chainLogo(c, mkt).catch(() => null)) || null
      };
      cacheSet('ti:' + c, fixed);
    }
    const d = { symbol: fixed.sym, decimals: fixed.dec, name: fixed.note };
    DEC['cw20:' + c] = d.decimals;
    const v = amt(bal.data && bal.data.balance, d.decimals);
    if (!(v > 0) && !keep) return null;
    // No pricing here. A balance is the one read that has to happen; a price is
    // many, and making the row wait on them is what left the screen empty.
    return { sym: d.symbol, v: v, note: d.name, logo: fixed.logo, pool: null, contract: c };
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

let PRICING = 0;
async function priceRows(list, found, px){
  const mine = ++PRICING;
  const todo = found.filter(r => r.contract && !r.pool && !px[r.sym]);
  if (!todo.length) return;
  const got = await mapLimit(todo, 10, r => poolPrice(r.contract).catch(() => null));
  if (mine !== PRICING) return;   // a newer pass has started, this one is stale
  todo.forEach((r, i) => { r.pool = got[i] || null; });
  renderTokens(list, found, px, LAST.hint);
}

const HOME_NOTE = 'LUNC and USTC use a price feed. Everything else is priced from pools on chain, ' +
  'following a route to LUNC when there is no direct pair. The depth shown is the narrowest pool ' +
  'on that route, because that is the leg a real sale has to fit through.';

let HIDE_DUST = false;
try { HIDE_DUST = localStorage.getItem('fw:dust') === '1'; } catch (e) {}
let LAST = { found: [], px: {}, hint: '' };
// True while the market sweep is still running, which is exactly the window in
// which the total is real but incomplete. TOTAL_SHOWN is the last one that was
// not.
let SWEEPING = false, TOTAL_SHOWN = null;
// set by the button; makes the next load do a full sweep regardless of when
// the last one ran
let FORCE_SWEEP = false;
// the address the visible list belongs to
let LAST_ADDR = null;
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
function renderCore(rows){
  const box = $('#core');
  if (!box) return;
  box.innerHTML = CORE_SYMS.map((sym, n) => {
    const r = rows.find(x => x.t.sym === sym);
    const has = !!r && r.fiat !== null;
    return (n ? '<div class="core-seam"></div>' : '') +
      '<div class="core-cell">' +
        '<div class="core-top">' +
          (r ? iconHTML(r.t) : '<span class="core-dot"></span>') +
          '<span class="core-sym">' + sym + '</span>' +
        '</div>' +
        '<div class="core-usd' + (r && r.shaky ? ' soft' : '') + '">' +
          (has ? (r.shaky ? '\u2248' : '') + usd(r.fiat) : '\u2014') +
        '</div>' +
        '<div class="core-qty">' + fmt(r ? r.t.v : 0) + '</div>' +
      '</div>';
  }).join('');
  paintIcons(box);
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

  rows.forEach(function (r) {
    const k = r.t.sym;
    if (r.fiat !== null) {
      // only a finished sweep is allowed to define what a token is worth
      if (!SWEEPING) PRICE_SEEN[k] = { fiat: r.fiat, sub: r.sub };
    } else if (SWEEPING && PRICE_SEEN[k]) {
      r.fiat = PRICE_SEEN[k].fiat;
      r.sub = PRICE_SEEN[k].sub;
      r.shaky = true;             // last known, not current - and it says so
    } else if (!SWEEPING) {
      // the sweep finished and found no price: the old one is now a fiction
      delete PRICE_SEEN[k];
    }
  });

  // by value, not by count - a hundred dollars belongs above eight cents no
  // matter how many decimal places the cheaper token happens to have
  const rank = r => (r.fiat === null ? -1 : r.fiat);
  rows.sort((a, b) => rank(b) - rank(a) || b.t.v - a.t.v);

  const total = rows.reduce((a, r) => a + (r.fiat || 0), 0);
  // "no price" is not the same as "worth nothing" - TCO has no pool yet, and
  // hiding 4.8 million of it behind a dust filter would be a lie
  renderCore(rows);
  // pinned above, so the list must not repeat them
  const rest = rows.filter(r => CORE_SYMS.indexOf(r.t.sym) < 0);
  const shown = HIDE_DUST ? rest.filter(r => r.fiat === null || r.fiat >= DUST) : rest;

  list.innerHTML = shown.length ? shown.map(r => {
    const t = r.t;
    return '<li class="row">' +
      iconHTML(t) +
      '<div class="row-main"><div class="row-name">' + t.sym + '</div>' +
      '<div class="row-amt">' + fmt(t.v) + (t.note ? ' \u00b7 ' + t.note : '') + '</div></div>' +
      '<div class="row-val"><div class="row-fiat' + (r.shaky ? ' soft' : '') + '">' +
      (r.fiat !== null ? (r.shaky ? '\u2248' : '') + usd(r.fiat) : '\u2014') + '</div>' +
      '<div class="row-sub"' + (t.pool && t.pool.depth < THIN_LUNC ? ' style="color:var(--gold)"' : '') +
      '>' + r.sub + '</div></div></li>';
  }).join('') : '<li class="empty">' +
    (rest.length ? 'Everything priced here rounds to zero. Turn off hide $0 to see it.'
                 : 'This address holds nothing yet.') + '</li>';

  paintIcons(list);
  // the hidden ones are still counted, so the number never lies about the wallet
  $('#tok-count').textContent = !rest.length ? ''
    : (shown.length < rest.length ? shown.length + ' of ' + rest.length : String(rest.length));
  // The list may fill in as tokens are found - that reads as progress. The
  // total may not: a number that drops to a fifth and climbs back looks like
  // money went missing, and after a swap that is a frightening thing to show.
  const totalEl = $('#bal-total');
  if (!SWEEPING) {
    TOTAL_SHOWN = total;
    totalEl.textContent = usd(total);
    totalEl.classList.remove('stale');
  } else if (TOTAL_SHOWN !== null) {
    // a refresh keeps the last complete figure, dimmed, rather than guessing
    totalEl.textContent = usd(TOTAL_SHOWN);
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

async function loadBalances(addr){
  LAST_ADDR = addr;
  const list = $('#tok-list');
  SWEEPING = true;

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
    const [bank, px] = await Promise.all([
      getJSON(LCD + '/cosmos/bank/v1beta1/balances/' + addr),
      prices()
    ]);

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
        try {
          const tr = await getJSON(LCD + '/ibc/apps/transfer/v1/denom_traces/' + b.denom.slice(4));
          const base = tr.denom_trace.base_denom;
          sym = (base.startsWith('u') ? base.slice(1) : base).toUpperCase();
          note = tr.denom_trace.path;
        } catch (e) {}
        found.push({ sym: sym, v: amt(b.amount, 6), note: note, denom: b.denom, dec: 6 });
      } else {
        found.push({ sym: b.denom.toUpperCase(), v: amt(b.amount, 6), note: '', denom: b.denom, dec: 6 });
      }
    }

    // the seeded few first, so the screen is useful within a second
    // Balances are already in hand at this point - put them on screen before
    // anything that talks to a pool.
    renderTokens(list, found, px, 'Reading your tokens.');

    // The list, and nothing but the list. This is the whole of a normal open.
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
    priceRows(list, found, px);   // deliberately not awaited

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
      SWEEPING = true;
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
let ADDR = '', LAST_AT = 0, BUSY = false;

// A balance changes when a block lands, not when a transaction was signed, so
// the screen has to be told to look again. Two guards: never twice at once,
// and never more often than every fifteen seconds - the chain does not move
// faster than that, and neither should the polling.
async function refreshBalances(force){
  if (!ADDR || BUSY) return;
  if (!force && Date.now() - LAST_AT < 15000) return;
  BUSY = true;
  try { await loadBalances(ADDR); }
  catch (e) { /* a failed refresh is not a failed swap */ }
  finally { BUSY = false; LAST_AT = Date.now(); }
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
  ADDR = addr;
  $('#home-addr').textContent = addr.slice(0,14) + '\u2026' + addr.slice(-6);
  go('home');
  loadBalances(addr);
  loadStaking(addr);
}

// The swap screen needs the same rows the list is drawn from, priced and all.
// Handing back LAST.found beats asking the chain a second time.
const heldTokens = () => LAST.found || [];
export { forget, registry, remember, heldTokens, luncRaw, openWallet, refreshBalances };

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
    try { await loadBalances(LAST_ADDR); } catch (e) { /* the banner reports it */ }
    b.textContent = was;
    delete b.dataset.busy;
  });
})();
