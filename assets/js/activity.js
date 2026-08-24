// activity.js - история адреса с того же LCD, которым пользуется txCandidates.
//
// Индексатор здесь не нужен: LCD принимает ?query= по событиям. Но событие
// решает, что попадёт в выборку. message.sender находит всё, что адрес
// подписывал - переводы, свапы, стейкинг. Полученное он не видит вовсе, его
// приходится спрашивать отдельно по получателю, а потом склеивать по хешу.
import { LCD, amt, fmt, getJSON } from './chain.js?v=73d3e550';
import { $ } from './shell.js?v=73d3e550';
import { S } from './state.js?v=73d3e550';

const FINDER = 'https://finder.terra.money/classic/tx/';
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

const ICON = {
  out:  '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  in:   '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  swap: '<path d="M4 8h13"/><path d="m14 4 4 4-4 4"/><path d="M20 16H7"/><path d="m10 12-4 4 4 4"/>',
  dot:  '<circle cx="12" cy="12" r="7"/>'
};

// What the transaction was, decided by its first message. Anything unfamiliar
// says so plainly instead of being labelled a guess.
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
    let action = '';
    for (const lg of (t.logs || [])) {
      for (const e of (lg.events || [])) {
        if (e.type !== 'wasm') continue;
        for (const a of (e.attributes || [])) if (a.key === 'action') action = a.value;
      }
    }
    const isSwap = action === 'swap';
    return { kind: isSwap ? 'swap' : 'dot',
             title: (isSwap ? 'Swap' : action ? action.replace(/_/g, ' ') : 'Contract call') + extra,
             sub: short(m.contract || ''),
             value: coins(m.funds) };
  }
  if (type.indexOf('MsgDelegate') >= 0)
    return { kind: 'out', title: 'Delegated' + extra, sub: short(m.validator_address),
             value: coins([m.amount]) };
  if (type.indexOf('MsgUndelegate') >= 0)
    return { kind: 'in', title: 'Undelegated' + extra, sub: short(m.validator_address),
             value: coins([m.amount]) };
  if (type.indexOf('WithdrawDelegatorReward') >= 0)
    return { kind: 'in', title: 'Claimed rewards' + extra, sub: short(m.validator_address), value: '' };

  return { kind: 'dot', title: type.split('.').pop() || 'Transaction', sub: '', value: '' };
}

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

$('#ac-list').addEventListener('click', e => {
  const row = e.target.closest('.ac-row');
  if (!row) return;
  const url = FINDER + row.dataset.hash;
  if (window.Telegram && Telegram.WebApp && Telegram.WebApp.openLink)
    Telegram.WebApp.openLink(url);
  else window.open(url, '_blank', 'noopener');
});

// loaded when the tab is opened, not on boot: the home screen has enough to do
document.querySelectorAll('[data-tab="activity"]').forEach(b =>
  b.addEventListener('click', () => { load(); }));

export { load };
