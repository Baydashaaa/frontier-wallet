// activity.js - история адреса с того же LCD, которым пользуется txCandidates.
//
// Индексатор здесь не нужен: LCD принимает ?query= по событиям. Но событие
// решает, что попадёт в выборку. message.sender находит всё, что адрес
// подписывал - переводы, свапы, стейкинг. Полученное он не видит вовсе, его
// приходится спрашивать отдельно по получателю, а потом склеивать по хешу.
import { LCD, amt, fmt, getJSON } from './chain.js?v=da345e6a';
import { DEC, knownAsset } from './market.js?v=da345e6a';
import { $ } from './shell.js?v=da345e6a';
import { S } from './state.js?v=da345e6a';

// terra.money's classic finder is gone; the community one is what answers
const FINDER = 'https://finder.terraclassic.community/columbus-5/tx/';
let LOADED = '';

const short = s => !s ? '' : s.slice(0, 9) + '\u2026' + s.slice(-4);

/* Two clocks, and they disagreed with each other.
   Rounding seconds into hours and then into days put "24h ago" directly above
   "1d ago" for two things that happened minutes apart. Inside a day the time of
   day is the useful fact; beyond it, the day is, and the day now has a heading
   of its own - so the row only has to say where in the day it sits. */
function clock(ts){
  const t = new Date(ts);
  const s = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// midnight to midnight, in the reader's own timezone rather than the chain's
const dayKey = ts => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
};

function dayName(ts){
  const d = new Date(ts), now = new Date();
  const same = dayKey(ts) === dayKey(now);
  const y = new Date(now.getTime() - 86400000);
  if (same) return 'Today';
  if (dayKey(ts) === dayKey(y)) return 'Yesterday';
  const within = (now - d) / 86400000 < 300;
  return d.toLocaleDateString([], within
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
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
/* What a swap actually moved.

   A row that says "Swapped" and nothing else is half a sentence: the amounts
   are in the transaction, in the wasm events the pools emit, and reading them
   is the difference between a list you can scan and a list you have to open.

   For a trade that crossed two pools the first offer and the last return are
   the two ends of what the owner did; everything between them is the middle
   token appearing and disappearing inside the same transaction. */
const keyFor = a => !a ? '' :
  (String(a).slice(0, 6) === 'terra1' ? 'cw20:' + a : 'native:' + a);

function nameOf(a){
  const k = keyFor(a);
  const known = k && knownAsset(k);
  if (known) return { sym: known.sym, dec: known.dec === undefined ? 6 : known.dec };
  if (a === 'uluna') return { sym: 'LUNC', dec: 6 };
  if (a === 'uusd') return { sym: 'USTC', dec: 6 };
  const d = DEC[k];
  return { sym: String(a || '').replace(/^u/, '').slice(0, 8).toUpperCase(),
           dec: d === undefined ? 6 : d };
}

/* One wasm event, several contracts.

   The chain concatenates every contract's attributes into a single event of
   type "wasm", in the order they ran, separated only by a fresh
   _contract_address. Folding that into one object and reading `action` off it
   gives the FIRST action in the chain - for a swap paid in a CW20 that is the
   token's own `send`, never the pool's `swap`. The condition below could not
   match, which is why every swap row came back empty.

   Split at the boundaries and each contract speaks for itself. */
function wasmCalls(t){
  const out = [];
  for (const lg of (t.logs || [])) {
    for (const e of (lg.events || [])) {
      if (e.type !== 'wasm') continue;
      let cur = null;
      for (const at of (e.attributes || [])) {
        if (at.key === '_contract_address') { cur = { at: at.value }; out.push(cur); continue; }
        if (!cur) { cur = {}; out.push(cur); }
        if (!(at.key in cur)) cur[at.key] = at.value;
      }
    }
  }
  return out;
}

function swapMoves(t){
  let gave = null, got = null;
  for (const a of wasmCalls(t)) {
    if (a.action !== 'swap' || !a.return_amount) continue;
    // the first offer and the last return: the two ends of the trade
    if (!gave && a.offer_asset && a.offer_amount) gave = { asset: a.offer_asset, raw: a.offer_amount };
    if (a.ask_asset) got = { asset: a.ask_asset, raw: a.return_amount };
  }
  if (!got) return null;
  const g = nameOf(got.asset);
  const out = { got: fmt(amt(got.raw, g.dec)) + ' ' + g.sym };
  if (gave) {
    const p = nameOf(gave.asset);
    out.gave = fmt(amt(gave.raw, p.dec)) + ' ' + p.sym;
    out.pair = p.sym + ' \u2192 ' + g.sym;
  }
  return out;
}

const VERB = {
  swap: 'Swapped', send: 'Sent', transfer: 'Sent', burn: 'Burned', mint: 'Minted',
  provide_liquidity: 'Added liquidity', withdraw_liquidity: 'Removed liquidity',
  increase_allowance: 'Approved spending', buy: 'Bought', sell: 'Sold',
  claim: 'Claimed', claim_rewards: 'Claimed rewards', withdraw_rewards: 'Claimed rewards',
  claim_reward: 'Claimed rewards', harvest: 'Claimed rewards',
  stake: 'Staked', unstake: 'Unstaked', unbond: 'Unstaked', bond: 'Staked',
  deposit: 'Deposited', withdraw: 'Withdrew', vote: 'Voted', enter: 'Entered',
  register: 'Registered', mint_nft: 'Minted an NFT', approve: 'Approved'
};

/* Which face a contract call wears.
   Only swaps had one, so staking, unstaking and claiming all came out wearing
   the brackets that mean "some code ran" - true, and useless next to five other
   rows saying the same. */
const FACE = {
  swap: 'swap', execute_swap_operations: 'swap', swap_operations: 'swap',
  stake: 'stake', bond: 'stake', unstake: 'stake', unbond: 'stake',
  provide_liquidity: 'stake', withdraw_liquidity: 'stake', deposit: 'stake',
  claim: 'gift', claim_rewards: 'gift', claim_reward: 'gift',
  withdraw_rewards: 'gift', harvest: 'gift', mint: 'gift',
  send: 'out', transfer: 'out', burn: 'out', withdraw: 'in'
};

// "record entry" reads as a leak; "Record entry" reads as a decision
const sentence = s => !s ? '' : s.charAt(0).toUpperCase() + s.slice(1);

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
    // a truncated contract address tells nobody anything; the pair does
    const mv = swap ? swapMoves(t) : null;
    // A cw20 leaves the wallet inside the send that carries it, so the amount
    // is in the message even when no event mentions it - which is every
    // staking row, all of which had an empty column.
    let paid = '';
    if (!mv && m.msg && m.msg.send && m.msg.send.amount) {
      const p = nameOf(m.contract);
      paid = '-' + fmt(amt(m.msg.send.amount, p.dec)) + ' ' + p.sym;
    }
    return { kind: FACE[intent] || (swap ? 'swap' : 'code'),
             // an unknown action is named as it came rather than dressed up
             title: (verb || sentence((intent || '').replace(/_/g, ' ')) ||
                     'Contract call') + extra,
             sub: (mv && mv.pair) || short(m.contract || ''),
             value: mv ? '+' + mv.got : (paid || coins(m.funds)),
             gain: !!mv };
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

  let day = '';
  list.innerHTML = all.slice(0, 40).map(function (t) {
    // held so the detail panel has the answer without asking the chain again
    TXS[t.txhash] = t;
    const d = describe(t, me);
    // a heading whenever the date turns over, which is the structure a list of
    // events has and a flat column of rows hides
    let head = '';
    const k = dayKey(t.timestamp);
    if (k !== day) { day = k; head = '<div class="ac-day">' + dayName(t.timestamp) + '</div>'; }
    const failed = Number(t.code) > 0;
    return head + '<div class="ac-row" data-hash="' + t.txhash + '">' +
      '<div class="ac-mark ' + d.kind + (failed ? ' fail' : '') + '">' +
        '<svg viewBox="0 0 24 24">' + (ICON[d.kind] || ICON.dot) + '</svg></div>' +
      '<div class="ac-mid"><div class="ac-t">' + d.title + '</div>' +
        '<div class="ac-s">' + (failed ? '<span class="ac-bad">failed</span> \u00b7 ' : '') +
        (d.sub || short(t.txhash)) + '</div></div>' +
      '<div class="ac-r"><div class="ac-v' + (d.kind === 'in' || d.gain ? ' in' : '') + '">' +
        (d.value || '') + '</div><div class="ac-w">' + clock(t.timestamp) + '</div></div>' +
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
