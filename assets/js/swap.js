// swap.js - котировки обмена. Ничего не подписывает и не отправляет.
//
// Цена в списке токенов выведена из резервов пула. Здесь так делать нельзя:
// пул сам умеет ответить, сколько отдаст за конкретную сумму, с учётом
// проскальзывания и комиссии. Считать это самому - значит показать одно
// число, а получить другое.
import { amt, fmt, smart } from './chain.js?v=d5ba4548';
import { $, go, tap } from './shell.js?v=d5ba4548';
import { heldTokens } from './tokens.js?v=d5ba4548';
import { dryRunSwap, sendSwap } from './tx.js?v=d5ba4548';
import { S } from './state.js?v=d5ba4548';

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

function decOf(t){
  const d = Number(t && t.dec);
  return isFinite(d) && d > 0 ? d : 6;
}

function fillPickers(){
  const rows = heldTokens().filter(swappable);
  const opts = t => '<option value="' + t.sym + '">' + t.sym + '</option>';
  if (!TO && rows.length) TO = rows[0];
  $('#sw-from').innerHTML = '<option value="LUNC">LUNC</option>' + rows.map(opts).join('');
  $('#sw-to').innerHTML = '<option value="LUNC">LUNC</option>' + rows.map(opts).join('');
  $('#sw-from').value = FROM.sym;
  $('#sw-to').value = TO ? TO.sym : 'LUNC';
  $('#sw-net').textContent = rows.length ? rows.length + ' pairs' : 'no direct pairs held';
  const bal = FROM.sym === 'LUNC'
    ? (heldTokens().find(x => x.sym === 'LUNC') || {}).v
    : FROM.v;
  $('#sw-avail').textContent = bal ? fmt(bal) + ' available' : '';
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
  const pair = pairOf(token);
  if (!pair) { out.textContent = '-'; out.classList.add('dim');
    detail([{ k: 'Route', v: 'no direct pool', tone: 'bad' }]); return; }
  if (!isFinite(v) || v <= 0) { out.textContent = '-'; out.classList.add('dim'); detail([]); return; }

  out.textContent = 'quoting'; out.classList.add('dim');
  const dFrom = decOf(FROM), dTo = decOf(TO);
  const raw = String(Math.round(v * Math.pow(10, dFrom)));

  try {
    const r = await smart(pair, { simulation: { offer_asset: { info: assetInfo(FROM), amount: raw } } });
    if (my !== SEQ) return;                       // ответ на устаревший ввод
    const d = (r && r.data) || {};
    const got = amt(d.return_amount, dTo);
    const spread = Number(d.spread_amount) / Math.pow(10, dTo);
    const fee = Number(d.commission_amount) / Math.pow(10, dTo);
    const pct = got > 0 ? (spread / (got + spread + fee)) * 100 : 0;

    out.textContent = fmt(got);
    out.classList.remove('dim');
    QUOTE = { pair: pair, offerRaw: raw, returnRaw: String(d.return_amount),
              got: got, dTo: dTo };
    armGo(S.MNEMONIC ? 'Check what this would cost' : 'Watch only, nothing can be signed',
          !!S.MNEMONIC);
    detail([
      { k: 'Rate', v: '1 ' + FROM.sym + ' = ' + fmt(got / v) + ' ' + TO.sym },
      { k: 'Price impact', v: pct.toFixed(2) + '%',
        tone: pct >= 5 ? 'bad' : pct >= 1 ? 'warn' : '' },
      { k: 'Pool fee', v: fmt(fee) + ' ' + TO.sym },
      { k: 'Pool depth', v: fmt(token.pool.depth) + ' LUNC',
        tone: token.pool.depth < 5e6 ? 'warn' : '' }
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
$('#sw-from').addEventListener('change', () => { FROM = pick($('#sw-from').value) || LUNC; fillPickers(); schedule(); });
$('#sw-to').addEventListener('change', () => { TO = pick($('#sw-to').value); fillPickers(); schedule(); });
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
      armGo('Swap ' + FROM.sym + ' for ' + TO.sym, true);
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
