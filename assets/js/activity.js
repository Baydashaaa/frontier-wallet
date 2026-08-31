// activity.js - история адреса с того же LCD, которым пользуется txCandidates.
//
// Индексатор здесь не нужен: LCD принимает ?query= по событиям. Но событие
// решает, что попадёт в выборку. message.sender находит всё, что адрес
// подписывал - переводы, свапы, стейкинг. Полученное он не видит вовсе, его
// приходится спрашивать отдельно по получателю, а потом склеивать по хешу.
import { LCD, amt, fmt, getJSON } from './chain.js?v=e1051c10';
import { $ } from './shell.js?v=e1051c10';
import { S } from './state.js?v=e1051c10';

// terra.money's classic finder is gone; the community one is what answers
const FINDER = 'https://finder.terraclassic.community/columbus-5/tx/';
let LOADED = '';

const short = s => !s ? '' : s.slice(0, 9) + '\u2026' + s.slice(-4);

function ago(ts){
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  const d = Math.round(s / 86400);
  return d < 30 ? d + 'd ago' : new Date(ts).toISOString().slice(0, 10);
}

// Only native coins can be read straight off the message. A cw20 amount is a
// number inside a contract call with no denom attached, so it is left alone
// rather than guessed at.
function coins(list){
  if (!Array.isArray(list) || !list.length) return '';
  const c = list[0];
  if (c.denom === 'uluna') return fmt(amt(c.amount, 6)) + ' LUNC';
  if (c.denom === 'uusd') return fmt(amt(c.amount, 6)) + ' USTC';
  return fmt(amt(c.amount, 6)) + ' ' + c.denom.replace(/^u/, '').toUpperCase();
}

/* What the person did, taken from the message they signed.

   The old reading walked every wasm event and kept the last `action` attribute
   it found - which is whatever the final contract in the chain of calls chose
   to log about itself. That is how "receive cw20 fee" and "record entry" ended
   up as the names of somebody's swaps: true statements about a contract's
   internals, and not descriptions of anything the owner did.

   The execute message names the intent directly: {"send":...} was a send,
   {"swap":...} was a swap. Where the chain of calls matters - a cw20 send whose
   hook is a swap - the hook is opened and it says so. */
const VERB = {
  swap: 'Swapped', send: 'Sent', transfer: 'Sent', burn: 'Burned', mint: 'Minted',
  provide_liquidity: 'Added liquidity', withdraw_liquidity: 'Removed liquidity',
  increase_allowance: 'Approved spending', claim: 'Claimed', buy: 'Bought',
  stake: 'Staked', unstake: 'Unstaked', deposit: 'Deposited', withdraw: 'Withdrew',
  vote: 'Voted', enter: 'Entered', register: 'Registered'
};

function hookOf(msg){
  // a cw20 send carries the real intent base64-encoded inside it
  try {
    const inner = msg && msg.send && msg.send.msg;
    if (!inner) return null;
    return Object.keys(JSON.parse(atob(inner)))[0] || null;
  } catch (e) { return null; }
}

function intentOf(m){
  const msg = m && m.msg;
  if (!msg || typeof msg !== 'object') return '';
  const top = Object.keys(msg)[0] || '';
  return (top === 'send' && hookOf(msg)) || top;
}

const ICON = {
  // an arrow falling into a bowl, and one rising out of it
  in:   '<path d="M12 3.5v9.5"/><path d="m7.8 8.8 4.2 4.2 4.2-4.2"/>' +
        '<path d="M4.5 15.5a7.5 7.5 0 0 0 15 0"/>',
  out:  '<path d="M12 13V3.5"/><path d="m7.8 7.7 4.2-4.2 4.2 4.2"/>' +
        '<path d="M4.5 15.5a7.5 7.5 0 0 0 15 0"/>',
  // two lanes passing each other
  swap: '<path d="M5 9h11"/><path d="m12.8 5.4 3.6 3.6-3.6 3.6"/>' +
        '<path d="M19 15H8"/><path d="m11.2 11.4-3.6 3.6 3.6 3.6"/>',
  stake:'<path d="m12 3 8.5 4.7-8.5 4.7-8.5-4.7Z"/><path d="m3.5 12 8.5 4.7 8.5-4.7"/>' +
        '<path d="m3.5 16.4 8.5 4.7 8.5-4.7"/>',
  gift: '<circle cx="9.2" cy="12" r="4.6"/><path d="M14 7.8a4.6 4.6 0 0 1 0 8.4"/>' +
        '<path d="M9.2 9.9v4.2"/>',
  // brackets: something ran, and it was code
  code: '<path d="M9.2 7.5 5.4 12l3.8 4.5"/><path d="M14.8 7.5 18.6 12l-3.8 4.5"/>' +
        '<path d="M12.8 6.5 11.2 17.5"/>'
};

// what the transaction was, and which face it wears
function describe(t, me){
  const msgs = ((t.tx || {}).body || {}).messages || [];
  const m = msgs[0] || {};
  const type = String(m['@type'] || '');
  const extra = msgs.length > 1 ? ' +' + (msgs.length - 1) : '';

  if (type.indexOf('MsgSend') >= 0) {
    const mine = m.from_address === me;
    return { kind: mine ? 'out' : 'in',
             title: (mine ? 'Sent' : 'Received') + extra,
             sub: mine ? 'to ' + short(m.to_address) : 'from ' + short(m.from_address),
             value: (mine ? '-' : '+') + coins(m.amount) };
  }
  if (type.indexOf('MsgExecuteContract') >= 0) {
    const intent = intentOf(m);
    const swap = intent === 'swap' || intent === 'execute_swap_operations' ||
                 intent === 'swap_operations';
    const verb = VERB[intent];
    return { kind: swap ? 'swap' : 'code',
             // an unknown action is named as it came rather than dressed up
             title: (verb || (intent ? intent.replace(/_/g, ' ') : 'Contract call')) + extra,
             sub: short(m.contract || ''),
             value: coins(m.funds) };
  }
  if (type.indexOf('MsgDelegate') >= 0)
    return { kind: 'stake', title: 'Delegated' + extra, sub: short(m.validator_address),
             value: coins([m.amount]) };
  if (type.indexOf('MsgUndelegate') >= 0)
    return { kind: 'stake', title: 'Undelegated' + extra, sub: short(m.validator_address),
             value: coins([m.amount]) };
  if (type.indexOf('WithdrawDelegatorReward') >= 0)
    return { kind: 'gift', title: 'Claimed rewards' + extra, sub: short(m.validator_address), value: '' };

  return { kind: 'code', title: type.split('.').pop() || 'Transaction', sub: '', value: '' };
}

/* Everything the chain said about one transaction.

   It was a link out of the app: tap a row, leave for a block explorer, come
   back. Almost everything worth knowing is already here - the response carries
   the messages, the events, the fee and the log - so the common questions get
   answered without going anywhere.

   The explorer stays, for the questions this does not answer. */
const TXS = {};

function transfersIn(t, me){
  const out = [];
  for (const lg of (t.logs || [])) {
    for (const e of (lg.events || [])) {
      if (e.type !== 'transfer') continue;
      let to = '', from = '', what = '';
      for (const a of (e.attributes || [])) {
        if (a.key === 'recipient') to = a.value;
        if (a.key === 'sender') from = a.value;
        if (a.key === 'amount') what = a.value;
      }
      if (!what || (to !== me && from !== me)) continue;
      // several coins arrive comma separated, and each is digits then a denom
      for (const part of what.split(',')) {
        const mm = /^(\d+)(.+)$/.exec(part.trim());
        if (!mm) continue;
        out.push({ mine: to === me, other: to === me ? from : to,
                   text: coins([{ amount: mm[1], denom: mm[2] }]) });
      }
    }
  }
  return out;
}

function memoOf(t){
  const m = ((t.tx || {}).body || {}).memo || '';
  return m.trim();
}

function feeOf(t){
  const f = (((t.tx || {}).auth_info || {}).fee || {}).amount || [];
  return f.length ? coins(f) : '';
}

function row(k, v, cls){
  return '<div class="tx-line' + (cls ? ' ' + cls : '') + '">' +
         '<span>' + k + '</span><b>' + v + '</b></div>';
}

function openTx(hash){
  const t = TXS[hash];
  if (!t) return;
  const me = S.ADDR || (S.SAVED && S.SAVED.addr) || '';
  const d = describe(t, me);
  const failed = Number(t.code) > 0;
  const moves = transfersIn(t, me);
  const memo = memoOf(t);

  let html =
    '<div class="tx-head"><div class="ac-mark ' + d.kind + (failed ? ' fail' : '') + '">' +
      '<svg viewBox="0 0 24 24">' + (ICON[d.kind] || ICON.code) + '</svg></div>' +
      '<div><b>' + d.title + '</b><i>' + new Date(t.timestamp).toLocaleString() + '</i></div></div>';

  if (failed) {
    html += '<div class="tx-fail">The chain rejected this one. Nothing moved.' +
            (t.raw_log ? '<p>' + String(t.raw_log).slice(0, 200) + '</p>' : '') + '</div>';
  }

  if (moves.length) {
    html += '<div class="tx-moves">' + moves.slice(0, 8).map(function (mv) {
      return row(mv.mine ? 'Received' : 'Sent',
                 (mv.mine ? '+' : '-') + mv.text, mv.mine ? 'in' : 'out') +
             '<p class="tx-who">' + (mv.mine ? 'from ' : 'to ') + short(mv.other) + '</p>';
    }).join('') + '</div>';
  }

  html += row('Status', failed ? 'Failed' : 'Confirmed', failed ? 'out' : 'in');
  html += row('Block', String(t.height || ''));
  if (feeOf(t)) html += row('Network fee', feeOf(t));
  if (t.gas_used) html += row('Gas', t.gas_used + ' of ' + (t.gas_wanted || '?'));
  if (memo) html += row('Memo', memo);
  html += '<div class="tx-hash" id="tx-hash">' + hash + '</div>';

  $('#tx-body').innerHTML = html;
  $('#tx-sheet').hidden = false;
  CURRENT = hash;
}

let CURRENT = '';

async function page(query){
  try {
    const r = await getJSON(LCD + '/cosmos/tx/v1beta1/txs?query=' + encodeURIComponent(query) +
      '&pagination.limit=25&order_by=ORDER_BY_DESC', 20000);
    return r.tx_responses || [];
  } catch (e) { return []; }
}

async function load(){
  const me = S.ADDR || (S.SAVED && S.SAVED.addr) || '';
  if (!me || LOADED === me) return;
  const list = $('#ac-list');
  list.innerHTML = '<div class="empty">Reading the chain</div>';

  // sent and received are two different questions to the same index
  const [mine, got] = await Promise.all([
    page("message.sender='" + me + "'"),
    page("transfer.recipient='" + me + "'")
  ]);

  const seen = {}, all = [];
  for (const t of mine.concat(got)) {
    if (!t || seen[t.txhash]) continue;
    seen[t.txhash] = 1;
    all.push(t);
  }
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!all.length) {
    list.innerHTML = '<div class="empty">Nothing on chain for this address yet.</div>';
    $('#ac-note').textContent = '';
    LOADED = me;
    return;
  }

  list.innerHTML = all.slice(0, 40).map(function (t) {
    // held so the detail panel has the answer without asking the chain again
    TXS[t.txhash] = t;
    const d = describe(t, me);
    const failed = Number(t.code) > 0;
    return '<div class="ac-row" data-hash="' + t.txhash + '">' +
      '<div class="ac-mark ' + d.kind + (failed ? ' fail' : '') + '">' +
        '<svg viewBox="0 0 24 24">' + (ICON[d.kind] || ICON.dot) + '</svg></div>' +
      '<div class="ac-mid"><div class="ac-t">' + d.title + '</div>' +
        '<div class="ac-s">' + (failed ? '<span class="ac-bad">failed</span> \u00b7 ' : '') +
        (d.sub || short(t.txhash)) + '</div></div>' +
      '<div class="ac-r"><div class="ac-v' + (d.kind === 'in' ? ' in' : '') + '">' +
        (d.value || '') + '</div><div class="ac-w">' + ago(t.timestamp) + '</div></div>' +
      '</div>';
  }).join('');
  $('#ac-note').textContent = 'The last ' + Math.min(all.length, 40) +
    ' transactions this address signed or received.';
  LOADED = me;
}

function openLink(url){
  if (window.Telegram && Telegram.WebApp && Telegram.WebApp.openLink)
    Telegram.WebApp.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

$('#ac-list').addEventListener('click', e => {
  const row = e.target.closest('.ac-row');
  if (row) openTx(row.dataset.hash);
});

$('#tx-x').addEventListener('click', () => { $('#tx-sheet').hidden = true; });
$('#tx-close').addEventListener('click', () => { $('#tx-sheet').hidden = true; });
$('#tx-open').addEventListener('click', () => { if (CURRENT) openLink(FINDER + CURRENT); });
$('#tx-copy').addEventListener('click', async function () {
  const back = this.textContent;
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard');
    await navigator.clipboard.writeText(CURRENT);
    this.textContent = 'Copied';
  } catch (e) { this.textContent = 'Copying was refused'; }
  setTimeout(() => { this.textContent = back; }, 1500);
});

// loaded when the tab is opened, not on boot: the home screen has enough to do
document.querySelectorAll('[data-tab="activity"]').forEach(b =>
  b.addEventListener('click', () => { load(); }));

export { load };
