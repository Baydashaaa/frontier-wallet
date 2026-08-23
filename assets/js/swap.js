// swap.js - котировки обмена. Ничего не подписывает и не отправляет.
//
// Цена в списке токенов выведена из резервов пула. Здесь так делать нельзя:
// пул сам умеет ответить, сколько отдаст за конкретную сумму, с учётом
// проскальзывания и комиссии. Считать это самому - значит показать одно
// число, а получить другое.
import { amt, fmt, iconHTML, paintIcons, smart } from './chain.js?v=d0167347';
import { $, go, tap } from './shell.js?v=d0167347';
import { directPairs } from './market.js?v=d0167347';
import { heldTokens } from './tokens.js?v=d0167347';
import { dryRunSwap, sendSwap } from './tx.js?v=d0167347';
import { S } from './state.js?v=d0167347';

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

// Стороны сделки описываются по-разному: нативный деном против адреса
// контракта. Пул ждёт именно ту форму, что соответствует активу.
const assetInfo = t => t.denom
  ? { native_token: { denom: t.denom } }
  : { token: { contract_addr: t.contract } };

// Пара, через которую идёт обмен. Маршрут уже посчитан при оценке цены,
// последний участок и есть пул против LUNC.
function pairOf(t){
  const r = t && t.pool && t.pool.route;
  if (!Array.isArray(r) || !r.length) return null;
  const last = r[r.length - 1];
  return last && last.pair ? last.pair : null;
}
const swappable = t =>
  !!t && !!t.contract && !!t.pool && !t.pool.bond && !!pairOf(t) && t.pool.hops === 1;

// The same pair is listed by more than one factory, with different depth and
// different fees. Which one is best is a question about this amount, not about
// the pools in general, so every candidate is asked and the answers compared.
async function candidates(token, fallback){
  try {
    const list = await directPairs(token.contract);
    if (Array.isArray(list) && list.length) return list;
  } catch (e) {}
  return [fallback];
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
function comfortOf(){
  const token = FROM.sym === 'LUNC' ? TO : FROM;
  if (!token || !token.pool || !token.pool.depth) return 0;
  const lunc = token.pool.depth;
  const reserve = FROM.denom ? lunc : lunc / (token.pool.inLunc || 1);
  return reserve > 0 ? reserve * 0.01 : 0;
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
  const rows = heldTokens().filter(swappable);
  if (!TO && rows.length) TO = rows[0];
  face($('#sw-from'), FROM);
  face($('#sw-to'), TO || LUNC);
  $('#sw-net').textContent = rows.length ? rows.length + ' pairs' : 'no direct pairs held';
  const bal = balOf(FROM);
  $('#sw-avail').textContent = bal ? fmt(bal) + ' available' : '';
  paintZones();
}

function openSheet(side){
  const lunc = pick('LUNC') || LUNC;
  const all = [lunc].concat(heldTokens().filter(swappable));
  $('#sw-list').innerHTML = all.map(function (t) {
    return '<button class="sw-item" type="button" data-sym="' + t.sym + '">' +
      iconHTML(t) + '<span class="sw-item-s">' + t.sym + '</span>' +
      '<span class="sw-item-v">' + fmt(t.v || 0) + '</span></button>';
  }).join('');
  paintIcons($('#sw-list'));
  const sheet = $('#sw-sheet');
  sheet.dataset.side = side;
  sheet.hidden = false;
}
const closeSheet = () => { $('#sw-sheet').hidden = true; };

// The slider spends a share of what is actually held, so it has nothing to say
// until a balance is known.
function setPct(p){
  const bal = balOf(FROM);
  if (!bal) return;
  let v = bal * (p / 100);
  if (p === 100 && FROM.denom === 'uluna') v = Math.max(0, bal - LUNC_RESERVE);
  $('#sw-amt').value = v > 0 ? v.toFixed(6) : '';
  $('#sw-range').value = String(p);
  schedule();
}

function pick(sym){
  if (sym === 'LUNC') return heldTokens().find(x => x.sym === 'LUNC' && x.denom) || LUNC;
  return heldTokens().find(x => x.sym === sym) || null;
}

function detail(lines){
  $('#sw-detail').innerHTML = lines.map(function (l) {
    return '<div class="sw-line' + (l.tone ? ' ' + l.tone : '') + '">' +
      '<span>' + l.k + '</span><b>' + l.v + '</b></div>';
  }).join('');
}

async function quote(){
  const my = ++SEQ;
  QUOTE = null; PLAN = null; armGo('Enter an amount', false);
  const v = parseFloat(String($('#sw-amt').value).replace(',', '.'));
  const out = $('#sw-out');

  // одна сторона обязана быть LUNC: пул торгует токен против LUNC, и
  // токен-в-токен это две сделки, а не одна
  const token = FROM.sym === 'LUNC' ? TO : FROM;
  if (!token || (FROM.sym !== 'LUNC' && (!TO || TO.sym !== 'LUNC'))) {
    out.textContent = '-'; out.classList.add('dim');
    detail([{ k: 'Route', v: 'token to token needs two swaps', tone: 'warn' }]);
    return;
  }
  let pair = pairOf(token);
  if (!pair) { out.textContent = '-'; out.classList.add('dim');
    detail([{ k: 'Route', v: 'no direct pool', tone: 'bad' }]); return; }
  if (!isFinite(v) || v <= 0) { out.textContent = '-'; out.classList.add('dim'); detail([]); return; }

  out.textContent = 'quoting'; out.classList.add('dim');
  const dFrom = decOf(FROM), dTo = decOf(TO);
  const raw = String(Math.round(v * Math.pow(10, dFrom)));

  try {
    const pairs = await candidates(token, pair);
    const quotes = (await Promise.all(pairs.map(function (p) {
      return smart(p, { simulation: { offer_asset: { info: assetInfo(FROM), amount: raw } } })
        .then(function (x) { return { pair: p, d: (x && x.data) || {} }; })
        // a pool that will not answer is not an error, it is one fewer option
        .catch(function () { return null; });
    }))).filter(function (q) { return q && Number(q.d.return_amount) > 0; });
    if (my !== SEQ) return;                       // ответ на устаревший ввод
    if (!quotes.length) throw new Error('no pool would quote this amount');
    quotes.sort(function (a, b) { return Number(b.d.return_amount) - Number(a.d.return_amount); });
    pair = quotes[0].pair;
    const d = quotes[0].d;
    // what the second best would have given, which is the whole point of asking
    const edge = quotes.length > 1
      ? (Number(d.return_amount) / Number(quotes[1].d.return_amount) - 1) * 100
      : 0;
    const got = amt(d.return_amount, dTo);
    const spread = Number(d.spread_amount) / Math.pow(10, dTo);
    const fee = Number(d.commission_amount) / Math.pow(10, dTo);
    const pct = got > 0 ? (spread / (got + spread + fee)) * 100 : 0;

    out.textContent = fmt(got);
    out.classList.remove('dim');
    QUOTE = { pair: pair, offerRaw: raw, returnRaw: String(d.return_amount),
              got: got, dTo: dTo, pct: pct };
    // an expensive trade should not be one tap away from an ordinary one
    armGo(!S.MNEMONIC ? 'Watch only, nothing can be signed'
          : pct >= 5 ? 'This costs ' + pct.toFixed(1) + '%, check it'
          : 'Check what this would cost', !!S.MNEMONIC);
    detail([
      { k: 'Rate', v: '1 ' + FROM.sym + ' = ' + fmt(got / v) + ' ' + TO.sym },
      { k: 'Price impact', v: pct.toFixed(2) + '%',
        tone: pct >= 5 ? 'bad' : pct >= 1 ? 'warn' : '' },
      // a percentage is an argument; the tokens it costs is a fact
      { k: 'Slippage costs you', v: fmt(spread) + ' ' + TO.sym,
        tone: pct >= 5 ? 'bad' : pct >= 1 ? 'warn' : '' },
      { k: 'Pool fee', v: fmt(fee) + ' ' + TO.sym },
      { k: 'Pool depth', v: fmt(token.pool.depth) + ' LUNC',
        tone: token.pool.depth < 5e6 ? 'warn' : '' },
      { k: 'Pools asked', v: quotes.length + ' of ' + pairs.length +
        (edge > 0.01 ? ', best by ' + edge.toFixed(2) + '%' : '') }
    ]);
  } catch (e) {
    if (my !== SEQ) return;
    out.textContent = '-'; out.classList.add('dim');
    detail([{ k: 'Pool', v: 'did not answer', tone: 'bad' }]);
    console.error('[swap]', e);
  }
}

const schedule = () => { clearTimeout(TIMER); TIMER = setTimeout(quote, 400); };

$('#sw-amt').addEventListener('input', schedule);
$('#sw-from').addEventListener('click', () => { tap(); openSheet('from'); });
$('#sw-to').addEventListener('click', () => { tap(); openSheet('to'); });
$('#sw-close').addEventListener('click', closeSheet);
$('#sw-sheet').addEventListener('click', e => { if (e.target.id === 'sw-sheet') closeSheet(); });
$('#sw-list').addEventListener('click', e => {
  const item = e.target.closest('.sw-item');
  if (!item) return;
  const t = pick(item.dataset.sym);
  const side = $('#sw-sheet').dataset.side;
  // both sides the same asset is not a trade
  if (side === 'from') { if (TO && t && TO.sym === t.sym) TO = FROM; FROM = t || LUNC; }
  else { if (t && FROM.sym === t.sym) FROM = TO || LUNC; TO = t; }
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

// экран открывается из консоли на главной
const btn = document.getElementById('act-swap');
if (btn) btn.addEventListener('click', () => { fillPickers(); go('swap'); });

// Two ways to hand a pool an offer. A native coin rides along as funds; a CW20
// cannot, so the token contract is asked to send itself with the swap as a
// hook. Same trade, different envelope.
function envelope(){
  const belief = (Number(QUOTE.offerRaw) / Number(QUOTE.returnRaw)).toFixed(18);
  const guard = { belief_price: belief, max_spread: String(SLIP) };
  if (FROM.denom) {
    return {
      contract: QUOTE.pair,
      funds: [{ denom: FROM.denom, amount: QUOTE.offerRaw }],
      msg: { swap: Object.assign({
        offer_asset: { info: { native_token: { denom: FROM.denom } }, amount: QUOTE.offerRaw }
      }, guard) }
    };
  }
  return {
    contract: FROM.contract,
    funds: [],
    msg: { send: { contract: QUOTE.pair, amount: QUOTE.offerRaw,
                   msg: btoa(JSON.stringify({ swap: guard })) } }
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
      b.textContent = 'Checking';
      const env = envelope();
      const est = await dryRunSwap(addrOf(), env.contract, env.msg, env.funds, S.MNEMONIC);
      PLAN = { env: env, est: est };
      const min = QUOTE.got * (1 - SLIP);
      detail([
        { k: 'You receive', v: fmt(QUOTE.got) + ' ' + TO.sym },
        { k: 'At worst', v: fmt(min) + ' ' + TO.sym, tone: 'warn' },
        { k: 'Network fee', v: fmt(est.gasFee / 1e6) + ' LUNC' },
        { k: 'Gas', v: String(est.gas) }
      ]);
      armGo(QUOTE && PLAN && QUOTE.pct >= 5
        ? 'Swap anyway, losing ' + QUOTE.pct.toFixed(1) + '%'
        : 'Swap ' + FROM.sym + ' for ' + TO.sym, true);
    } else {
      b.textContent = 'Signing';
      const env = PLAN.env;
      const res = await sendSwap(addrOf(), env.contract, env.msg, env.funds, S.MNEMONIC);
      detail([{ k: 'Sent', v: res.hash.slice(0, 10) + '\u2026' },
              { k: 'Status', v: 'waiting for a block' }]);
      armGo('Sent', false);
      const done = await res.wait();
      detail([{ k: 'Swap', v: done ? 'confirmed' : 'not seen yet, check Activity',
                tone: done ? '' : 'warn' },
              { k: 'Hash', v: res.hash.slice(0, 10) + '\u2026' }]);
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
