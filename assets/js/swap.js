// swap.js - котировки обмена. Ничего не подписывает и не отправляет.
//
// Цена в списке токенов выведена из резервов пула. Здесь так делать нельзя:
// пул сам умеет ответить, сколько отдаст за конкретную сумму, с учётом
// проскальзывания и комиссии. Считать это самому - значит показать одно
// число, а получить другое.
import { THIN_LUNC, amt, fmt, iconHTML, paintIcons, usd } from './chain.js?v=04347cb2';
import { $, go, tap } from './shell.js?v=04347cb2';
import { assetOf, directPeers, gdInfo, graph, graphPeers, graphReady, knownAsset, learnAsset, mapPrice, midsBetween, poolsBetween, reserves, simulateSwap } from './market.js?v=04347cb2';
import { fiatOf, heldTokens, refreshBalances, remember } from './tokens.js?v=04347cb2';
import { dryRunSwap, sendSwap, toRaw } from './tx.js?v=04347cb2';
import { S } from './state.js?v=04347cb2';

const LUNC = { sym: 'LUNC', denom: 'uluna', dec: 6, native: true };
let FROM = LUNC, TO = null, TIMER = null, SEQ = 0;
// A quote is only good for the pool state it was taken from, so a new
// keystroke throws away the plan built from the old one.
let QUOTE = null, PLAN = null, BUSY = false;
const SLIP = 0.01;   // 1 percent, the number every leg of this is checked against
const addrOf = () => S.ADDR || (S.SAVED && S.SAVED.addr) || '';
function armGo(text, on){
  const b = $('#sw-go');
  b.textContent = text; b.disabled = !on;
}

// How an asset is named everywhere below: the same key the market map uses, so
// a row from the wallet and an asset from the map are the same thing.
const keyOf = t => !t ? '' : (t.contract ? 'cw20:' + t.contract : 'native:' + t.denom);

// A wallet row if there is one - it carries the balance and the icon the list
// already resolved - otherwise a row built from the map, holding nothing. The
// second kind is the point: you cannot buy a token you do not have if the
// picker only offers tokens you have.
function tokenFor(key){
  const held = heldTokens().find(r => keyOf(r) === key);
  if (held) return held;
  const a = knownAsset(key);
  if (!a) return null;
  const base = { sym: a.sym, dec: a.dec, logo: a.logo, v: 0 };
  if (key.slice(0, 5) === 'cw20:') base.contract = key.slice(5);
  else base.denom = key.slice(7);
  return base;
}

// Terra's original basket of on-chain stablecoins - ukrw, ueur, uidr, umnt and
// the rest - still exists, still has the odd pool, and is still dead. They are
// not worth a row, and a rule beats a list: every one of them is a short `u`
// denom, and the only two that matter are named.
const LEGACY = d => /^u[a-z]{2,4}$/.test(String(d || '')) && d !== 'uluna' && d !== 'uusd';

// Under this a pool cannot absorb a trade worth doing, so offering it as a
// destination is offering a trap.
const THIN_POOL = 50;      // dollars of liquidity, from the market map

// Tradeable means the map knows a pool holding it. Not "has a route to LUNC",
// which is what this used to mean and why a token with three healthy pools of
// its own counted as unswappable.
// Everything with a pool, however small. What you own you must be able to
// sell: a shallow pool is a bad price, not a locked door, and hiding the row
// leaves a balance on the main screen with no way to act on it. UST1 trades
// only against cUSTC and that pool is small, which is exactly the case the
// threshold was quietly deciding on the owner's behalf.
// Both sources, merged by asset rather than by pool: the feed knows depth, the
// factory walk knows the exchanges the feed skips, and either alone leaves out
// tokens this wallet is holding.
function allPeersOf(t){
  const k = keyOf(t);
  const seen = {}, out = [];
  for (const p of directPeers(k).concat(graphPeers(k))) {
    if (LEGACY(p.key.slice(7))) continue;
    const liq = typeof p.liq === 'number' ? p.liq : null;
    const was = seen[p.key];
    if (was) {
      // a measured depth beats an unmeasured one, and a bigger one beats a
      // smaller - the feed and the walk often both know the same pair
      if (liq !== null && (was.liq === null || liq > was.liq)) Object.assign(was, p, { liq: liq });
      continue;
    }
    seen[p.key] = Object.assign({}, p, { liq: liq });
    out.push(seen[p.key]);
  }
  return out.sort(function (a, b) {
    if (a.liq === null && b.liq === null) return 0;
    if (a.liq === null) return 1;
    if (b.liq === null) return -1;
    return b.liq - a.liq;
  });
}

/* The factory walk covers what the feed does not, and until now only the daily
   sweep ever started it - so a CL8Y token stayed unswappable for as long as a
   day after it arrived. Opening this screen is a deliberate act by someone who
   is about to choose an asset, which makes it the right moment to pay for the
   walk once. Cached for six hours afterwards. */
let WALKING = false;
function ensureGraph(){
  if (WALKING || graphReady()) return;
  WALKING = true;
  graph().then(function () {
    // Every "asked, no answer" from before the walk was answered against a
    // market missing two whole exchanges. Those are not settled questions any
    // more, so the marks come off and the screen asks again.
    for (const k in PX) if (PX[k] === null) delete PX[k];
    fillPickers();
    drawSheet();
  }).catch(function () {});
}

// The destination list is a different question. Sending someone into a pool too
// thin to absorb the trade is offering a trap, and there is normally somewhere
// better to go - but if there is not, a thin pool beats no list at all.
function peersOf(t){
  const all = allPeersOf(t);
  // A threshold may only exclude what it has actually measured. Pairs from the
  // factory walk carry no depth, and treating that as zero is what removed
  // every CL8Y token from the buy side without a word.
  const ok = all.filter(p => p.liq === null || p.liq >= THIN_POOL);
  return ok.length ? ok : all;
}
const swappable = t => !!t && !LEGACY(t.denom) && allPeersOf(t).length > 0;

/* Everywhere the trade can end up: assets sharing a pool with this one, and
   then assets sharing a pool with those. The second kind is what makes the
   whole CL8Y cluster reachable - UST1 and CL8Y have no pool between them, and
   their own exchange routes that trade through cUSTC rather than refusing it.
   Direct destinations come first; a hop costs a second pool's fee and leaves a
   little of the middle token behind, so it is the fallback, not the default. */
function destinations(t){
  const self = keyOf(t);
  const seen = {}, out = [];
  const near = peersOf(t);
  for (const p of near) { seen[p.key] = 1; out.push(Object.assign({ hops: 1 }, p)); }
  for (const m of near.slice(0, 10)) {
    for (const q of directPeers(m.key).concat(graphPeers(m.key))) {
      if (q.key === self || seen[q.key] || LEGACY(q.key.slice(7))) continue;
      if (!knownAsset(q.key) && !heldTokens().some(r => keyOf(r) === q.key)) continue;
      seen[q.key] = 1;
      out.push(Object.assign({}, q, { hops: 2, via: m.key }));
    }
  }
  return out;
}

function decOf(t){
  const d = Number(t && t.dec);
  return isFinite(d) && d > 0 ? d : 6;
}

// Gas is paid in LUNC, so spending the whole balance leaves nothing to pay
// with. Max stops short by enough for a few transactions.
const LUNC_RESERVE = 2;

function balOf(t){
  if (!t) return 0;
  const row = heldTokens().find(x => x.sym === t.sym);
  return row ? (row.v || 0) : (t.v || 0);
}

// The picker draws the same icon the token list draws, which is why the rows
// come from heldTokens rather than being rebuilt here.
function face(el, t){
  const row = heldTokens().find(x => x.sym === (t && t.sym)) || t;
  el.innerHTML = (row ? iconHTML(row) : '') +
    '<span>' + ((t && t.sym) || 'LUNC') + '</span>' +
    '<svg class="sw-caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
  paintIcons(el);
}

// On a constant product pool the cost of a trade is roughly its size against
// the reserve it is pushing into, so a trade worth one percent of that reserve
// costs about one percent. That number can be named before anything is typed,
// which is the only moment a warning is still useful.
//
// It used to be derived from the token's LUNC depth, which only exists for a
// pair against LUNC. Read from the pool itself it holds for any pair, and it is
// one query per pool, kept for as long as the screen is open.
const DEPTH = {};
function firstLeg(){
  const pools = poolsBetween(keyOf(FROM), keyOf(TO));
  if (pools.length) return pools[0].pair;
  const mids = midsBetween(keyOf(FROM), keyOf(TO));
  // for a hop it is the first pool the trade enters that sets the comfortable
  // size; what happens after it is smaller by definition
  return mids.length ? mids[0].first[0].pair : null;
}

function comfortOf(){
  const pair = firstLeg();
  if (!pair) return 0;
  const d = DEPTH[pair];
  return d && d > 0 ? d * 0.01 : 0;
}

// Which pool: the deepest one by the map when nothing has been quoted yet, and
// the one the quote actually chose once it has. Those differ - the best pool
// for an amount is not always the biggest - and reading the wrong one is why
// the depth line sat on "reading" forever.
async function learnDepth(pair){
  if (!pair) pair = firstLeg();
  if (!pair) return;
  if (DEPTH[pair] !== undefined) return;
  DEPTH[pair] = 0;                       // asked, so the next paint does not re-ask
  const res = await reserves(pair).catch(() => null);
  if (!res) return;
  const mine = res.find(x => x.key === keyOf(FROM));
  if (!mine) return;
  DEPTH[pair] = amt(mine.raw, decOf(FROM));
  paintZones();
  if (DETAIL && DETAIL.pair === pair) redrawDetail();
}

let DETAIL = null;
function redrawDetail(){
  if (!DETAIL) return;
  const d = DEPTH[DETAIL.pair];
  detail(DETAIL.lines.map(function (l) {
    if (l.k !== 'Pool depth') return l;
    return { k: 'Pool depth',
             v: d ? fmt(d) + ' ' + DETAIL.sym : 'not readable',
             tone: d && d < DETAIL.size * 20 ? 'warn' : '' };
  }));
}

function paintZones(){
  const el = $('#sw-range'), hint = $('#sw-hint');
  const bal = balOf(FROM), c = comfortOf();
  if (!bal || !c) {
    el.style.removeProperty('--sw-zones');
    hint.textContent = '';
    return;
  }
  const s = Math.min(100, (c / bal) * 100);
  const m = Math.min(100, s * 5);
  el.style.setProperty('--sw-zones',
    'linear-gradient(90deg,#00FFB0 0 ' + s + '%,#E8C840 ' + s + '% ' + m + '%,' +
    '#FF6B8A ' + m + '% 100%)');
  hint.innerHTML = c >= bal
    ? 'This pool is deep enough for anything you hold.'
    : 'Around <b>' + fmt(c) + ' ' + FROM.sym + '</b> is where this pool starts ' +
      'costing you more than 1%.';
}

function fillPickers(){
  const peers = peersOf(FROM);
  // Both sides starting as LUNC is not a trade, and the old default did exactly
  // that whenever the wallet held nothing else priced against it.
  if ((!TO || keyOf(TO) === keyOf(FROM)) && peers.length) TO = tokenFor(peers[0].key);
  face($('#sw-from'), FROM);
  face($('#sw-to'), TO || LUNC);
  ensureGraph();
  $('#sw-net').textContent = peers.length
    ? peers.length + ' pairs with ' + FROM.sym + (graphReady() ? '' : ', still looking')
    : (graphReady() ? 'nothing pairs with ' + FROM.sym : 'looking for pairs');
  const bal = balOf(FROM);
  $('#sw-avail').textContent = bal ? fmt(bal) + ' available' : '';
  paintZones();
  learnDepth();
  learnPrice(FROM);
  learnPrice(TO);
  paintUsd();
}

// The pay side is what you hold and can actually sell. The receive side is
// whatever shares a pool with it - held or not, because otherwise this screen
// can only shuffle what is already in the wallet.
function sheetRows(side){
  if (side === 'from') {
    const mine = heldTokens().filter(function (t) {
      if (!((t.v || 0) > 0) || !swappable(t)) return false;
      const f = fiatOf(t);
      return f === null || f >= 0.01;
    });
    const lunc = pick('LUNC');
    if (lunc && !mine.some(t => t.sym === 'LUNC')) mine.unshift(lunc);
    return mine;
  }
  return destinations(FROM).map(function (p) {
    const t = tokenFor(p.key);
    return t ? Object.assign({}, t, { hops: p.hops, via: p.via }) : null;
  }).filter(Boolean);
}

// Rows the sheet could not name yet. Asked for once, all at once, and the sheet
// is redrawn when they land - one redraw rather than a row appearing at a time.
let NAMING = false;
function nameTheRest(side){
  if (NAMING || side === 'from') return;
  const missing = peersOf(FROM).map(p => p.key).filter(k => !knownAsset(k) &&
    !heldTokens().some(r => keyOf(r) === k));
  if (!missing.length) return;
  NAMING = true;
  Promise.all(missing.slice(0, 24).map(k => learnAsset(k).catch(() => null)))
    .then(function () { NAMING = false; drawSheet(); });
}

// The search field is built once and lives above the list. It is not in the
// markup because it belongs to this screen's behaviour rather than its shape,
// and the sheet is the only thing that opens it.
let FIND = null;
function findBox(){
  if (FIND) return FIND;
  const wrap = document.createElement('div');
  wrap.className = 'sw-find';
  wrap.innerHTML = '<svg viewBox="0 0 24 24" class="sw-find-i">' +
    '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
    '<input id="sw-q" type="text" autocomplete="off" spellcheck="false" ' +
    'placeholder="Search by ticker">';
  const list = $('#sw-list');
  list.parentNode.insertBefore(wrap, list);
  FIND = wrap.querySelector('input');
  FIND.addEventListener('input', function () { drawSheet(); });
  return FIND;
}

let SHEET_SIDE = 'from';
function drawSheet(){
  const q = (FIND && FIND.value || '').trim().toUpperCase();
  const all = sheetRows(SHEET_SIDE).filter(t => !q || String(t.sym).toUpperCase().indexOf(q) >= 0);
  const list = $('#sw-list');
  list.innerHTML = all.length ? all.map(function (t) {
    const f = fiatOf(t);
    return '<button class="sw-item" type="button" data-k="' + keyOf(t) + '">' +
      iconHTML(t) + '<span class="sw-item-s">' + t.sym +
      (t.hops === 2 ? '<b class="sw-hop">2 steps</b>' : '') + '</span>' +
      '<span class="sw-item-r">' +
        '<span class="sw-item-v">' + ((t.v || 0) > 0 ? fmt(t.v) : '') + '</span>' +
        '<span class="sw-item-u">' + (f !== null && f > 0 ? usd(f) : '') + '</span>' +
      '</span></button>';
  }).join('') : '<div class="sw-none">' + (q
    ? 'Nothing here matches ' + q + '.'
    : 'Nothing shares a pool with ' + FROM.sym + '.') + '</div>';
  paintIcons(list);
}

function openSheet(side){
  SHEET_SIDE = side;
  const box = findBox();
  box.value = '';
  drawSheet();
  nameTheRest(side);
  const sheet = $('#sw-sheet');
  sheet.dataset.side = side;
  sheet.hidden = false;
  // A count is the one thing a search box cannot tell you before you type.
  const n = $('#sw-count');
  if (n) n.textContent = sheetRows(side).length + ' available';
}
const closeSheet = () => {
  $('#sw-sheet').hidden = true;
  // the keyboard follows the sheet down rather than staying up over the screen
  if (FIND) FIND.blur();
};

// The slider spends a share of what is actually held, so it has nothing to say
// until a balance is known.
function setPct(p){
  const bal = balOf(FROM);
  if (!bal) return;
  let v = bal * (p / 100);
  if (p === 100 && FROM.denom === 'uluna') v = Math.max(0, bal - LUNC_RESERVE);
  $('#sw-amt').value = v > 0 ? v.toFixed(decOf(FROM)) : '';
  $('#sw-range').value = String(p);
  schedule();
}

function pick(sym){
  if (sym === 'LUNC') return heldTokens().find(x => x.sym === 'LUNC' && x.denom) || LUNC;
  return heldTokens().find(x => x.sym === sym) || null;
}

/* A moment that says what happened.

   The quote, the review, the signature and the outcome all used to be the same
   row of small grey text in the same place, so the screen never changed shape
   and nothing ever announced itself. This is the one place where it should:
   a state, a sentence in plain words, and the hash as something you can open
   rather than a truncated string to squint at. */
function result(state, title, note, hash){
  const box = $('#sw-detail');
  const link = 'https://finder.terraclassic.community/columbus-5/tx/' + hash;
  box.innerHTML =
    '<div class="sw-result ' + state + '">' +
      '<div class="sw-result-top">' +
        (state === 'done'
          ? '<svg viewBox="0 0 24 24" class="sw-tick"><path d="m4 12 5.5 5.5L20 7"/></svg>'
          : '<span class="spin"></span>') +
        '<b>' + title + '</b>' +
      '</div>' +
      '<p>' + note + '</p>' +
      '<a href="' + link + '" target="_blank" rel="noopener">' +
        hash.slice(0, 8) + '\u2026' + hash.slice(-6) + ' \u2197</a>' +
    '</div>';
}

function detail(lines){
  $('#sw-detail').innerHTML = lines.map(function (l) {
    return '<div class="sw-line' + (l.tone ? ' ' + l.tone : '') + '">' +
      '<span>' + l.k + '</span><b>' + l.v + '</b></div>';
  }).join('');
}

/* Ask every pool that holds the pair and keep the best answer.
   Pulled out of quote() because a two step swap asks this twice, once per leg,
   and the second leg is not the pair on screen. */
async function bestPool(pools, offerKey, raw, refused){
  const got = (await Promise.all(pools.slice(0, 3).map(function (p) {
    return simulateSwap(p.pair, offerKey, raw, p.dex)
      .then(function (x) { return { pair: p.pair, dialect: x.dialect, d: x }; })
      .catch(function (e) {
        refused.push(String(e && e.message ? e.message : e));
        return null;
      });
  }))).filter(function (q) { return q && Number(q.d.return_amount) > 0; });
  got.sort(function (a, b) { return Number(b.d.return_amount) - Number(a.d.return_amount); });
  return { best: got[0] || null, tried: pools.length, answered: got.length, all: got };
}

const legCost = (d, dec) => {
  const out = Number(d.return_amount) / Math.pow(10, dec);
  const spread = Number(d.spread_amount) / Math.pow(10, dec);
  const fee = Number(d.commission_amount) / Math.pow(10, dec);
  const whole = out + spread + fee;
  return { out: out, spread: spread, fee: fee,
           impact: whole > 0 ? (spread / whole) * 100 : 0,
           feePct: out + fee > 0 ? (fee / (out + fee)) * 100 : 0 };
};

/* Two pools, one transaction.

   The second message has to name its amount when the transaction is signed, and
   what the first message will actually deliver is not known until it runs. So
   the second one spends the first one's guaranteed minimum: it can never be
   short, the transaction never half-executes, and whatever the first leg
   delivered above that minimum stays in the wallet as the middle token. That
   residue is bounded by the slippage setting and is shown on screen before
   anything is signed - it is a condition of the trade, not a surprise.

   The quote for the second leg is taken on the minimum, not on the expectation,
   so the number on screen is what the trade actually yields rather than a best
   case nobody will get. */
async function quoteHop(mids, raw, refused){
  let best = null, asked = 0;
  // Which candidates were tried and where each one stopped. "no route" with an
  // empty refusal list says only that nothing was asked, which is the one
  // answer that explains nothing.
  const trace = [];
  for (const m of mids.slice(0, 2)) {
    const mid = tokenFor(m.key);
    if (!mid) { trace.push(m.key.slice(0, 14) + ':unnamed'); continue; }
    const dMid = decOf(mid);

    const one = await bestPool(m.first, keyOf(FROM), raw, refused);
    asked += one.tried;
    if (!one.best) { trace.push(mid.sym + ':leg1 none of ' + one.tried); continue; }

    const min1 = String(Math.floor(Number(one.best.d.return_amount) * (1 - SLIP)));
    if (!(Number(min1) > 0)) {
      trace.push(mid.sym + ':leg1 returned ' + one.best.d.return_amount); continue;
    }

    const two = await bestPool(m.second, m.key, min1, refused);
    asked += two.tried;
    if (!two.best) { trace.push(mid.sym + ':leg2 none of ' + two.tried); continue; }

    const outRaw = Number(two.best.d.return_amount);
    if (!(outRaw > 0)) continue;
    trace.push(mid.sym + ':ok ' + outRaw);
    if (best && outRaw <= Number(best.returnRaw)) continue;

    best = {
      mid: mid, dMid: dMid, asked: asked,
      residue: (Number(one.best.d.return_amount) - Number(min1)) / Math.pow(10, dMid),
      one: legCost(one.best.d, dMid),
      two: legCost(two.best.d, decOf(TO)),
      returnRaw: two.best.d.return_amount,
      legs: [
        { pair: one.best.pair, dialect: one.best.dialect,
          offerRaw: raw, returnRaw: one.best.d.return_amount },
        { pair: two.best.pair, dialect: two.best.dialect,
          offerRaw: min1, returnRaw: two.best.d.return_amount }
      ]
    };
  }
  if (!best) {
    console.info('[hop]', mids.length + ' candidates,', trace.join(' | ') || 'none tried',
                 '| refusals', refused.length);
  }
  return best;
}

async function quote(){
  const my = ++SEQ;
  QUOTE = null; PLAN = null; DETAIL = null; armGo('Enter an amount', false);
  paintUsd();
  const v = parseFloat(String($('#sw-amt').value).replace(',', '.'));
  const out = $('#sw-out');

  if (!TO || keyOf(TO) === keyOf(FROM)) {
    out.textContent = '-'; out.classList.add('dim');
    detail([{ k: 'Route', v: 'pick two different assets', tone: 'warn' }]);
    return;
  }

  // A pool holding both is always preferred: one message, one fee, nothing left
  // behind. Only when there is none does the trade go through a middle asset.
  const pools = poolsBetween(keyOf(FROM), keyOf(TO));
  const mids = pools.length ? [] : midsBetween(keyOf(FROM), keyOf(TO));
  if (!pools.length && !mids.length) {
    out.textContent = '-'; out.classList.add('dim');
    detail([{ k: 'Route', v: 'nothing connects these two', tone: 'bad' }]); return;
  }
  if (!isFinite(v) || v <= 0) { out.textContent = '-'; out.classList.add('dim'); detail([]); return; }

  out.textContent = 'quoting'; out.classList.add('dim');
  const dFrom = decOf(FROM), dTo = decOf(TO);
  const raw = toRaw($('#sw-amt').value, dFrom);

  try {
    // A pool that will not answer is one fewer option, not an error - but when
    // every one of them refuses, what they said is the only thing that explains
    // why, and it used to be thrown away.
    const refused = [];
    let lines, pair, pct, hop = null, direct = null;

    if (pools.length) {
      direct = await bestPool(pools, keyOf(FROM), raw, refused);
      if (my !== SEQ) return;
      if (!direct.best) throw new Error(refused[0] || 'no pool would quote this amount');
      pair = direct.best.pair;
      const c = legCost(direct.best.d, dTo);
      pct = c.impact;
      learnDepth(pair);
      // What the second best would have given - the whole point of asking more
      // than one pool. Only pools that could actually have taken the trade
      // count: a pool holding a few hundred LUNC returns almost nothing, and
      // "better by 327807%" reads as a broken screen rather than as dust.
      const b = Number(direct.best.d.return_amount);
      const rival = direct.all.length > 1 && Number(direct.all[1].d.return_amount) > b / 2
        ? Number(direct.all[1].d.return_amount) : 0;
      const edge = rival ? (b / rival - 1) * 100 : null;

      out.textContent = fmt(c.out);
      QUOTE = { pair: pair, dialect: direct.best.dialect, offerRaw: raw,
                returnRaw: String(direct.best.d.return_amount),
                got: c.out, dTo: dTo, pct: pct, hops: 1,
                legs: [{ pair: pair, dialect: direct.best.dialect,
                         offerRaw: raw, returnRaw: String(direct.best.d.return_amount) }] };
      lines = [
        { k: 'Rate', v: '1 ' + FROM.sym + ' = ' + fmt(c.out / v) + ' ' + TO.sym },
        { k: 'Price impact', v: pct.toFixed(2) + '%',
          tone: pct >= 5 ? 'bad' : pct >= 1 ? 'warn' : '' },
        // a percentage is an argument; the tokens it costs is a fact
        { k: 'Slippage costs you', v: fmt(c.spread) + ' ' + TO.sym,
          tone: pct >= 5 ? 'bad' : pct >= 1 ? 'warn' : '' },
        { k: 'Pool fee', v: fmt(c.fee) + ' ' + TO.sym +
          (c.feePct > 0 ? ' \u00b7 ' + c.feePct.toFixed(2) + '%' : ''),
          tone: c.feePct > 1 ? 'warn' : '' },
        { k: 'Pool depth', v: DEPTH[pair] ? fmt(DEPTH[pair]) + ' ' + FROM.sym : 'reading',
          tone: DEPTH[pair] && DEPTH[pair] < v * 20 ? 'warn' : '' },
        { k: 'Pools asked', v: direct.answered + ' of ' + direct.tried +
          (edge === null
            ? (direct.answered > 1 ? ', the rest too thin to matter' : '')
            : edge > 0.01 ? ', best by ' + edge.toFixed(2) + '%' : '') }
      ];
    } else {
      hop = await quoteHop(mids, raw, refused);
      if (my !== SEQ) return;
      if (!hop) throw new Error(refused[0] || 'no route would quote this amount');
      pair = hop.legs[0].pair;
      pct = hop.one.impact + hop.two.impact;
      learnDepth(pair);

      out.textContent = fmt(hop.two.out);
      QUOTE = { pair: pair, dialect: hop.legs[1].dialect, offerRaw: raw,
                returnRaw: hop.returnRaw, got: hop.two.out, dTo: dTo, pct: pct,
                hops: 2, mid: hop.mid, residue: hop.residue, legs: hop.legs };
      lines = [
        { k: 'Route', v: FROM.sym + ' \u2192 ' + hop.mid.sym + ' \u2192 ' + TO.sym },
        { k: 'Rate', v: '1 ' + FROM.sym + ' = ' + fmt(hop.two.out / v) + ' ' + TO.sym },
        { k: 'Price impact', v: pct.toFixed(2) + '% over two pools',
          tone: pct >= 5 ? 'bad' : pct >= 1 ? 'warn' : '' },
        { k: 'Pool fees', v: hop.one.feePct.toFixed(2) + '% then ' + hop.two.feePct.toFixed(2) + '%',
          tone: hop.one.feePct + hop.two.feePct > 2 ? 'warn' : '' },
        // the whole reason a two step trade is not a one step trade
        { k: 'Leaves in your wallet', v: fmt(hop.residue) + ' ' + hop.mid.sym,
          tone: 'warn' },
        { k: 'Pool depth', v: DEPTH[pair] ? fmt(DEPTH[pair]) + ' ' + FROM.sym : 'reading',
          tone: DEPTH[pair] && DEPTH[pair] < v * 20 ? 'warn' : '' }
      ];
    }

    out.classList.remove('dim');
    paintUsd();
    // an expensive trade should not be one tap away from an ordinary one
    armGo(!S.MNEMONIC ? 'Watch only, nothing can be signed'
          : pct >= 5 ? 'This costs ' + pct.toFixed(1) + '%, check it'
          : 'Check what this would cost', !!S.MNEMONIC);
    DETAIL = { pair: pair, sym: FROM.sym, size: v, lines: lines };
    detail(lines);
  } catch (e) {
    if (my !== SEQ) return;
    out.textContent = '-'; out.classList.add('dim');
    const why = String(e && e.message ? e.message : e);
    detail([{ k: 'Pool', v: why.slice(0, 90), tone: 'bad' }]);
    console.error('[swap]', e);
  }
}

/* The messages, in order. One for a direct trade, two for a hop - and the
   second is offered by the middle token, not by the one on screen. */
function steps(){
  if (!QUOTE || !QUOTE.legs) return [];
  return QUOTE.legs.map(function (leg, i) {
    return envelope(i === 0 ? FROM : QUOTE.mid, leg);
  });
}

/* What one unit is worth, in dollars.
   Two sources, in order. A token the wallet holds has already been priced by
   the list, and asking it the same question twice is how two screens end up
   disagreeing. Anything else - and the receive side is usually something the
   wallet does not hold yet, which is the whole point of being able to buy it -
   is priced from its own pool against LUNC, once, and kept. */
const PX = {};
function unitUsd(t){
  const k = keyOf(t);
  return PX[k] === undefined ? null : PX[k];
}

async function learnPrice(t){
  if (!t) return;
  const k = keyOf(t);
  if (PX[k] !== undefined) return;
  const own = fiatOf(Object.assign({}, t, { v: 1 }));
  if (own !== null) { PX[k] = own; paintUsd(); return; }
  PX[k] = null;                          // asked; a second miss costs nothing
  // Reserves, not a curve. poolPrice falls back to bondPrice when nothing
  // trades against LUNC directly, and a bonding curve is not a market - it can
  // sit for months at a price nobody has taken. USTR came back 2.4x its real
  // value that way, under a figure the screen presented as what you get.
  // mapPrice reads the pools themselves, one hop or two, and is the same
  // arithmetic behind every number on the token list - so the two screens
  // cannot disagree about what something is worth.
  const lunc = fiatOf({ sym: 'LUNC', v: 1 });
  if (lunc === null) return;
  const p = await mapPrice(k).catch(() => null);
  if (!p || !p.inLunc) { console.warn('[swap] no route to price', k); return; }
  // The narrowest leg of the route, in LUNC. Below the line where a pool stops
  // being a market, the number it produces is not a price - it is whatever the
  // last person to touch that pool left behind, and printing it next to a real
  // amount would be the most confident thing on the screen.
  if (p.depth !== undefined && p.depth < THIN_LUNC) {
    console.warn('[swap] route too thin to price', k, 'narrow leg', Math.round(p.depth),
                 'LUNC, floor is', THIN_LUNC);
    return;
  }
  // Printed because a wrong price is otherwise untraceable: the number on the
  // screen says nothing about which pool produced it, and finding that out by
  // hand took two rounds.
  console.info('[swap] price', k, '=', p.inLunc * lunc, 'usd via',
               p.hops + ' hop' + (p.hops > 1 ? 's' : ''),
               p.via || '', p.route.map(r => r.pair).join(' -> '),
               'depth', p.depth,
               p.legs ? '(legs in LUNC: ' + p.legs.map(Math.round).join(', ') + ')' : '');
  PX[k] = p.inLunc * lunc;
  paintUsd();
}

// The dollar line under each amount. Built here rather than in the markup
// because it belongs to this screen only, and hidden rather than zeroed when
// there is no price - an empty line reads as "nothing", and a $0.00 reads as a
// claim.
function usdSlot(id){
  let el = document.getElementById(id);
  if (el) return el;
  const anchor = $(id === 'sw-amt-usd' ? '#sw-amt' : '#sw-out');
  if (!anchor) return null;
  el = document.createElement('div');
  el.id = id;
  el.className = 'sw-usd';
  anchor.insertAdjacentElement('afterend', el);
  return el;
}

function paintUsd(){
  const v = parseFloat(String($('#sw-amt').value).replace(',', '.'));
  const pf = unitUsd(FROM), pt = unitUsd(TO);
  const a = usdSlot('sw-amt-usd');
  if (a) a.textContent = (isFinite(v) && v > 0 && pf !== null) ? '\u2248 ' + usd(v * pf) : '';
  const b = usdSlot('sw-out-usd');
  const got = QUOTE ? QUOTE.got : 0;
  if (b) b.textContent = (got > 0 && pt !== null) ? '\u2248 ' + usd(got * pt) : '';
}

const schedule = () => { clearTimeout(TIMER); TIMER = setTimeout(quote, 400); };

$('#sw-amt').addEventListener('input', function () { paintUsd(); schedule(); });
$('#sw-from').addEventListener('click', () => { tap(); openSheet('from'); });
$('#sw-to').addEventListener('click', () => { tap(); openSheet('to'); });
$('#sw-close').addEventListener('click', closeSheet);
$('#sw-sheet').addEventListener('click', e => { if (e.target.id === 'sw-sheet') closeSheet(); });
$('#sw-list').addEventListener('click', e => {
  const item = e.target.closest('.sw-item');
  if (!item) return;
  const t = tokenFor(item.dataset.k);
  const side = $('#sw-sheet').dataset.side;
  // both sides the same asset is not a trade
  if (side === 'from') {
    // changing what you pay with changes what you can receive, so a receive
    // side that no longer pairs with it is dropped rather than left dangling
    if (TO && t && keyOf(TO) === keyOf(t)) TO = FROM;
    FROM = t || LUNC;
    if (TO && !poolsBetween(keyOf(FROM), keyOf(TO)).length) TO = null;
  } else {
    if (t && keyOf(FROM) === keyOf(t)) FROM = TO || LUNC;
    TO = t;
  }
  closeSheet(); tap(); fillPickers();
  $('#sw-amt').value = ''; $('#sw-range').value = '0';
  $('#sw-out').textContent = '-'; detail([]);
  schedule();
});
$('#sw-range').addEventListener('input', () => setPct(Number($('#sw-range').value)));
document.querySelectorAll('.sw-pct').forEach(b =>
  b.addEventListener('click', () => { tap(); setPct(Number(b.dataset.pct)); }));
$('#sw-flip').addEventListener('click', () => {
  tap();
  const a = FROM; FROM = TO || LUNC; TO = a;
  $('#sw-amt').value = '';
  $('#sw-out').textContent = '-';
  fillPickers(); detail([]);
});

(function () {
  const top = document.querySelector('.sw-sheet-top');
  if (top && !document.getElementById('sw-count')) {
    const n = document.createElement('span');
    n.id = 'sw-count';
    top.insertBefore(n, top.lastElementChild);
  }
})();

// экран открывается из консоли на главной
const btn = document.getElementById('act-swap');
if (btn) btn.addEventListener('click', () => { fillPickers(); go('swap'); });

// Two ways to hand a pool an offer, times two dialects.
//
// A native coin rides along as funds; a CW20 cannot, so the token contract is
// asked to send itself with the swap as a hook. That part is the same either
// way. What differs is the guard: TerraSwap is told the price it should expect
// and how far it may drift, while Garuda is told the smallest number of tokens
// that may come back. The second is the stricter promise, and the one the pool
// itself enforces rather than recomputes.
/* Takes the leg rather than reading the globals, because a two step swap has
   two of them and only the first is the pair on screen. Called with nothing it
   behaves as before, which is what the direct case still wants. */
function envelope(from, q){
  from = from || FROM;
  q = q || QUOTE;
  const gd = q.dialect === 'gd';
  const cl = q.dialect === 'cl';
  // a floor, so rounding never pushes the guard above what was quoted
  const floor = String(Math.floor(Number(q.returnRaw) * (1 - SLIP)));
  const guard = gd
    ? { offer_amount: q.offerRaw, min_receive: floor, deadline: Date.now() + 120000 }
    : cl
    // seconds, not milliseconds - and no belief_price, which appears in none of
    // the trades this contract has taken
    ? { max_spread: String(SLIP), deadline: Math.floor(Date.now() / 1000) + 120 }
    : { belief_price: (Number(q.offerRaw) / Number(q.returnRaw)).toFixed(18),
        max_spread: String(SLIP) };

  if (from.denom) {
    const offer = gd
      ? { offer_asset: gdInfo(keyOf(from)) }
      : { offer_asset: { info: { native_token: { denom: from.denom } }, amount: q.offerRaw } };
    return {
      contract: q.pair,
      funds: [{ denom: from.denom, amount: q.offerRaw }],
      msg: { swap: Object.assign({}, offer, guard) }
    };
  }
  const hook = gd
    ? { swap: Object.assign({ offer_asset: gdInfo(keyOf(from)) }, guard) }
    : { swap: guard };
  return {
    contract: from.contract,
    funds: [],
    msg: { send: { contract: q.pair, amount: q.offerRaw,
                   msg: btoa(JSON.stringify(hook)) } }
  };
}

$('#sw-go').addEventListener('click', async () => {
  if (BUSY || !QUOTE || !S.MNEMONIC) return;
  tap();
  BUSY = true;
  const b = $('#sw-go');

  try {
    if (!PLAN) {
      // the review: the node runs the message and prices the gas, which is
      // also what proves the transaction was built correctly
      b.textContent = 'Checking with the node';
      const plan = steps();
      const est = await dryRunSwap(addrOf(), plan, S.MNEMONIC);
      PLAN = { steps: plan, est: est };
      const min = QUOTE.got * (1 - SLIP);
      const review = [
        { k: 'You receive', v: fmt(QUOTE.got) + ' ' + TO.sym },
        { k: 'At worst', v: fmt(min) + ' ' + TO.sym, tone: 'warn' }
      ];
      if (QUOTE.hops === 2) {
        // both messages commit together or neither does, and the middle token
        // exists only in between - except for the part that stays
        review.push({ k: 'Steps', v: '2, in one transaction' });
        review.push({ k: 'Leaves in your wallet',
                      v: fmt(QUOTE.residue) + ' ' + QUOTE.mid.sym, tone: 'warn' });
      }
      review.push({ k: 'Network fee', v: fmt(est.gasFee / 1e6) + ' LUNC' });
      review.push({ k: 'Gas', v: String(est.gas) });
      detail(review);
      armGo(QUOTE && PLAN && QUOTE.pct >= 5
        ? 'Swap anyway, losing ' + QUOTE.pct.toFixed(1) + '%'
        : 'Swap ' + FROM.sym + ' for ' + TO.sym, true);
    } else {
      b.textContent = 'Signing';
      const bought = TO, spent = FROM, want = QUOTE.got, left = QUOTE.residue, mid = QUOTE.mid;
      const res = await sendSwap(addrOf(), PLAN.steps, S.MNEMONIC);

      // Waiting is a state, not an absence of one. It used to look identical to
      // the quote it replaced - the same small grey rows in the same place -
      // and there was no moment where anything said it had worked.
      result('sent', 'Sent to the chain', 'Waiting for it to be included in a block.',
             res.hash);
      armGo('Sent', false);

      const done = await res.wait();

      // What was just bought is not in the registry, so nothing would ask for
      // its balance until the daily sweep came round. The wallet knows exactly
      // what it just acquired.
      remember(addrOf(), [bought.contract, mid && mid.contract]);
      // the node can answer with state from a block earlier than the one that
      // included this, so ask twice rather than show a stale number
      refreshBalances(true);
      setTimeout(function () { refreshBalances(true); }, 6000);

      result(done ? 'done' : 'sent',
             done ? 'Swapped' : 'Sent, not seen yet',
             done
               ? 'You received ' + fmt(want) + ' ' + bought.sym +
                 (left ? ', and ' + fmt(left) + ' ' + mid.sym + ' stayed behind as expected.' : '.')
               : 'The chain has not shown it yet. Activity will have it once it lands.',
             res.hash);
      QUOTE = null; PLAN = null;
      $('#sw-amt').value = '';
      $('#sw-out').textContent = '-';
      armGo('Enter an amount', false);
    }
  } catch (e) {
    PLAN = null;
    const m = String(e && e.message ? e.message : e);
    detail([{ k: 'Stopped', v: m.slice(0, 90), tone: 'bad' }]);
    armGo('Try again', true);
    console.error('[swap]', e);
  } finally {
    BUSY = false;
  }
});

export { fillPickers };
