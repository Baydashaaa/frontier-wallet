import { LCD, amt, fmt, getJSON } from './chain.js?v=61a6a5aa';
import { $, buzz, go, tap } from './shell.js?v=61a6a5aa';
import { S } from './state.js?v=61a6a5aa';
import { refreshBalances } from './tokens.js?v=61a6a5aa';

/* ---------------- protobuf ----------------
   Written out by hand because cosmjs is several hundred kilobytes and this is
   a mini app. The wire format is two ideas: varints, and length prefixed
   fields tagged with (field number << 3 | wire type). Every encoder here was
   compared byte for byte with cosmjs before it was allowed near a key.
*/
const enc = new TextEncoder();

function varint(n){
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
}

function cat(parts){
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

const tag = (num, type) => varint((num << 3) | type);
const fBytes = (num, b) => (b && b.length) ? cat([tag(num, 2), varint(b.length), b]) : new Uint8Array(0);
const fStr = (num, s) => (!s) ? new Uint8Array(0) : fBytes(num, enc.encode(s));
const fUint = (num, n) => (!n || n === '0') ? new Uint8Array(0) : cat([tag(num, 0), varint(n)]);

const coin = c => cat([fStr(1, c.denom), fStr(2, String(c.amount))]);
const msgSend = (from, to, coins) =>
  cat([fStr(1, from), fStr(2, to), ...coins.map(c => fBytes(3, coin(c)))]);
const any = (url, value) => cat([fStr(1, url), fBytes(2, value)]);
const txBody = (msgs, memo) => cat([...msgs.map(m => fBytes(1, m)), fStr(2, memo)]);
const pubKeyAny = key => any('/cosmos.crypto.secp256k1.PubKey', fBytes(1, key));
// ModeInfo.Single { mode: SIGN_MODE_DIRECT }
const signerInfo = (key, seq) => cat([
  fBytes(1, pubKeyAny(key)),
  fBytes(2, fBytes(1, cat([tag(1, 0), varint(1)]))),
  fUint(3, seq)
]);
const feeMsg = (coins, gas) => cat([...coins.map(c => fBytes(1, coin(c))), fUint(2, gas)]);
const authInfo = (key, seq, coins, gas) =>
  cat([fBytes(1, signerInfo(key, seq)), fBytes(2, feeMsg(coins, gas))]);
const signDoc = (body, auth, chain, accNum) =>
  cat([fBytes(1, body), fBytes(2, auth), fStr(3, chain), fUint(4, accNum)]);
const txRaw = (body, auth, sigs) =>
  cat([fBytes(1, body), fBytes(2, auth), ...sigs.map(s => fBytes(3, s))]);
const b64 = b => btoa(String.fromCharCode.apply(null, b));

/* ---------------- chain facts ---------------- */
const CHAIN = 'columbus-5';
const GAS_PRICE = 28.325;        // uluna per gas unit
// You pay for gas you declare, not gas you burn, so this is money not
// insurance. Station's own ratio on the same transfer is 1.276.
const GAS_SAFETY = 1.3;

let TAX = null;
async function burnTaxRate(){
  if (TAX !== null) return TAX;
  try {
    const r = await getJSON(LCD + '/terra/tax/v1beta1/burn_tax_rate', 8000);
    TAX = Number(r.tax_rate);
  } catch (e) {
    // the old treasury endpoint reads zero on this chain, so there is no safe
    // fallback - refuse rather than under-pay and have the send bounce
    TAX = null;
    throw new Error('could not read the burn tax rate');
  }
  return TAX;
}

async function account(addr){
  const r = await getJSON(LCD + '/cosmos/auth/v1beta1/accounts/' + addr, 10000);
  const a = r.account || {};
  return { num: a.account_number || '0', seq: a.sequence || '0' };
}

/* ---------------- keys ---------------- */
let CRYPTO = null;
async function crypto_(){
  if (!CRYPTO) CRYPTO = await import('../../vendor/crypto.js');
  return CRYPTO;
}

async function keyOf(mnemonic){
  const m = await crypto_();
  const seed = await m.bip39.mnemonicToSeed(mnemonic);
  const node = m.bip32.HDKey.fromMasterSeed(seed).derive("m/44'/330'/0'/0/0");
  return { node: node, pub: node.publicKey, sha256: m.sha256 };
}

/* ---------------- amounts ----------------
   Base units from a typed decimal, by moving the point in the string rather
   than multiplying. 189286693.38 * 1e6 is not an integer in binary floating
   point, and every digit of error lands in somebody's transfer. Digits past
   the token's precision are dropped, not rounded: a wallet should never send
   more than what was typed.
*/
function toRaw(human, dec){
  const s = String(human == null ? '' : human).trim().replace(',', '.');
  if (s === '' || s === '.' || !/^\d*\.?\d*$/.test(s))
    throw new Error('that is not an amount');
  const cut = s.split('.');
  const whole = cut[0] || '0';
  const frac = (cut[1] || '').slice(0, dec);
  const out = (whole + frac + '0'.repeat(dec - frac.length)).replace(/^0+(?=\d)/, '');
  return out === '' ? '0' : out;
}

/* ---------------- building ---------------- */
function nativeSendTx(from, to, denom, raw, memo, key, seq, feeCoins, gas){
  const body = txBody([any('/cosmos.bank.v1beta1.MsgSend',
    msgSend(from, to, [{ denom: denom, amount: String(raw) }]))], memo || '');
  const auth = authInfo(key, seq, feeCoins, gas);
  return { body: body, auth: auth };
}

// The simulator wants a complete transaction, so it gets one with a blank
// signature. It never checks the signature - it only runs the messages.
async function simulateGas(body, auth){
  const raw = txRaw(body, auth, [new Uint8Array(64)]);
  const r = await fetch(LCD + '/cosmos/tx/v1beta1/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_bytes: b64(raw) })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || ('simulate -> ' + r.status));
  return Number((d.gas_info || {}).gas_used || 0);
}

/* ---------------- the dry run ----------------
   Everything a real send would do, stopping one step short of broadcasting.
*/
async function dryRunNative(from, to, denom, human, memo, mnemonic){
  // kept for display only; a send must not fail because this endpoint moved
  const rate = await burnTaxRate().catch(() => 0);
  const [acc, key] = await Promise.all([account(from), keyOf(mnemonic)]);
  const raw = toRaw(human, 6);
  if (!(Number(raw) > 0)) throw new Error('amount must be greater than zero');

  // first pass with a placeholder fee, only to learn the gas
  const first = nativeSendTx(from, to, denom, raw, memo, key.pub, acc.seq,
    [{ denom: 'uluna', amount: '1000000' }], 400000);
  const used = await simulateGas(first.body, first.auth);
  const gas = Math.ceil(used * GAS_SAFETY);
  const gasFee = Math.ceil(gas * GAS_PRICE);
  // The burn tax is not added here. On this chain it is charged as gas, and
  // the simulator above already counted it - that is why a plain send comes
  // back at a quarter million gas instead of eighty thousand.
  const tax = 0;

  // and the transaction as it would actually be signed
  const real = nativeSendTx(from, to, denom, raw, memo, key.pub, acc.seq,
    [{ denom: 'uluna', amount: String(gasFee) }], gas);
  const doc = signDoc(real.body, real.auth, CHAIN, acc.num);
  const sig = key.node.sign(key.sha256(doc));

  return {
    rate: rate, amount: raw, tax: tax, gas: gas, gasUsed: used, gasFee: gasFee,
    total: Number(raw) + gasFee,
    seq: acc.seq, num: acc.num,
    bytes: txRaw(real.body, real.auth, [sig]).length,
    signed: sig.length === 64
  };
}

// The node answers sync: accepted into the mempool, or refused with a reason.
// Acceptance is not inclusion, so the hash is polled afterwards.
async function broadcast(raw){
  const r = await fetch(LCD + '/cosmos/tx/v1beta1/txs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_bytes: b64(raw), mode: 'BROADCAST_MODE_SYNC' })
  });
  const d = await r.json();
  const res = d.tx_response || {};
  if (!r.ok) throw new Error(d.message || ('broadcast -> ' + r.status));
  if (res.code) throw new Error('rejected (code ' + res.code + '): ' + (res.raw_log || ''));
  return res.txhash;
}

async function waitFor(hash, tries = 30){
  for (let i = 0; i < tries; i++) {
    await new Promise(z => setTimeout(z, 2000));
    try {
      const d = await getJSON(LCD + '/cosmos/tx/v1beta1/txs/' + hash, 8000, 1);
      const res = d.tx_response || {};
      if (res.height && res.height !== '0') {
        if (res.code) throw new Error('failed on chain (code ' + res.code + '): ' + (res.raw_log || ''));
        return res;
      }
    } catch (e) {
      // not indexed yet is the normal case for the first few polls
      if (String(e.message || e).indexOf('failed on chain') === 0) throw e;
    }
  }
  return null;
}

// Rebuilt from scratch rather than reusing the reviewed bytes: the sequence
// moves whenever anything else touches this account, and a stale one is
// rejected outright.
async function sendNative(from, to, denom, human, memo, mnemonic){
  const [acc, key] = await Promise.all([account(from), keyOf(mnemonic)]);
  const raw = toRaw(human, 6);
  const probe = nativeSendTx(from, to, denom, raw, memo, key.pub, acc.seq,
    [{ denom: 'uluna', amount: '1000000' }], 400000);
  const gas = Math.ceil((await simulateGas(probe.body, probe.auth)) * GAS_SAFETY);
  const gasFee = Math.ceil(gas * GAS_PRICE);
  const real = nativeSendTx(from, to, denom, raw, memo, key.pub, acc.seq,
    [{ denom: 'uluna', amount: String(gasFee) }], gas);
  const sig = key.node.sign(key.sha256(signDoc(real.body, real.auth, CHAIN, acc.num)));
  return broadcast(txRaw(real.body, real.auth, [sig]));
}

/* ---------------- the screen ---------------- */
let LAST_GAS = 0;      // gas the most recent review measured
let ARMED = null;      // the reviewed transfer, waiting for a second press

const luncOf = () => {
  const el = $('#send-avail');
  return Number(el && el.dataset.raw || 0);
};

function line(label, value, strong){
  return '<div class="sline' + (strong ? ' strong' : '') + '"><span>' + label +
         '</span><b>' + value + '</b></div>';
}

async function review(){
  const out = $('#send-out');
  const to = $('#send-to').value.trim();
  const human = $('#send-amt').value.trim();
  const memo = $('#send-memo').value.trim();
  const from = S.SAVED && S.SAVED.addr;

  if (!/^terra1[0-9a-z]{38,58}$/.test(to)) {
    out.innerHTML = '<div class="sbad">That does not look like a Terra Classic address.</div>';
    return;
  }
  if (to === from) {
    out.innerHTML = '<div class="sbad">That is this wallet\'s own address.</div>';
    return;
  }
  if (!S.MNEMONIC) {
    out.innerHTML = '<div class="sbad">Unlock the wallet first.</div>';
    return;
  }

  out.innerHTML = '<div class="tiny">Asking the chain what this would cost...</div>';
  try {
    const d = await dryRunNative(from, to, 'uluna', human, memo, S.MNEMONIC);
    const avail = luncOf();
    const over = d.total > avail;
    out.innerHTML =
      line('Amount', fmt(amt(d.amount, 6)) + ' LUNC') +
      line('Fee \u00b7 ' + d.gas.toLocaleString() + ' gas at ' + GAS_PRICE +
           ' (burn tax included)', fmt(amt(d.gasFee, 6)) + ' LUNC') +
      line('Leaves your wallet', fmt(amt(d.total, 6)) + ' LUNC', true) +
      line('Recipient gets', fmt(amt(d.amount, 6)) + ' LUNC', true) +
      (over ? '<div class="sbad">More than this address holds - ' +
              fmt(amt(avail, 6)) + ' LUNC available.</div>' : '') +
      '<div class="tiny" style="margin-top:12px">Signed at ' + d.bytes +
      ' bytes, sequence ' + d.seq + '. Nothing has been sent yet.</div>' +
      (over ? '' : '<button class="btn solid" id="send-go" style="margin-top:14px">Send ' +
        fmt(amt(d.amount, 6)) + ' LUNC</button>');
    LAST_GAS = d.gas;
    ARMED = null;
    const b = $('#send-go');
    if (b) b.addEventListener('click', () => confirmSend(b, to, human, memo, from));
    buzz('success');
  } catch (e) {
    out.innerHTML = '<div class="sbad">' + (e.message || e) + '</div>';
  }
}

// Nothing proportional is left in the fee, so max is a subtraction. The gas a
// send needs barely moves with the amount, so a fixed allowance is honest
// here, and the review recomputes the real figure anyway.
// First press arms, second sends. Deliberate rather than decorative: one
// stray tap on a phone should not move money.
async function confirmSend(btn, to, human, memo, from){
  if (ARMED !== human + '|' + to) {
    ARMED = human + '|' + to;
    btn.textContent = 'Press again to send - this cannot be undone';
    btn.classList.add('danger');
    setTimeout(() => {
      if (ARMED === human + '|' + to) {
        ARMED = null;
        btn.textContent = 'Send ' + human + ' LUNC';
        btn.classList.remove('danger');
      }
    }, 8000);
    return;
  }
  ARMED = null;
  btn.disabled = true;
  btn.textContent = 'Signing and sending...';
  const out = $('#send-out');
  try {
    const hash = await sendNative(from, to, 'uluna', human, memo, S.MNEMONIC);
    out.innerHTML = '<div class="sline strong"><span>Accepted by the node</span><b>' +
      hash.slice(0, 10) + '\u2026' + hash.slice(-6) + '</b></div>' +
      '<div class="tiny" style="margin-top:10px">Waiting for the block...</div>';
    buzz('success');
    const res = await waitFor(hash);
    out.innerHTML = '<div class="sline strong"><span>' +
      (res ? 'Included in block ' + res.height : 'Sent, not seen in a block yet') +
      '</span><b>' + hash.slice(0, 10) + '\u2026' + hash.slice(-6) + '</b></div>' +
      '<div class="tiny" style="margin-top:10px">' + hash + '</div>';
    // Reloading the wallet is a courtesy, not part of the transfer. If it
    // throws, the transfer is still done and the banner must not suggest
    // otherwise - the next open reloads everything anyway.
    // Refreshed in place rather than reopened. openWallet ends with go('home'),
    // which took the reader off the result mid-sentence - the block height and
    // the hash are the two things worth reading after a transfer.
    // Twice, because a node can answer with state from a block older than the
    // one that included this.
    refreshBalances(true);
    setTimeout(function () { refreshBalances(true); }, 6000);
  } catch (e) {
    out.innerHTML = '<div class="sbad">' + (e.message || e) + '</div>';
    buzz('error');
  }
}

function fillMax(){
  const avail = luncOf();
  // what the last review actually needed, or a deliberately high guess. Too
  // little here makes an unsendable transaction; too much costs a fraction.
  const gasFee = Math.ceil((LAST_GAS || 345000) * GAS_PRICE);
  const raw = Math.floor(avail - gasFee);
  $('#send-amt').value = raw > 0 ? (raw / 1e6).toFixed(6) : '0';
  tap();
}

const btn = $('#send-review');
if (btn) {
  btn.addEventListener('click', review);
  const mx = $('#send-max');
  if (mx) mx.addEventListener('click', fillMax);
}

export { dryRunNative, sendNative, burnTaxRate, b64, toRaw };

/* ---------------- contract calls ----------------
   MsgExecuteContract in both dialects this chain has carried. The field
   numbers are the same in each - sender 1, contract 2, msg 3, funds 5 - and
   only the type URL differs. Which one the node accepts is decided by the
   node: the first is simulated, and a refusal falls through to the second.
   That simulation is also what proves the encoding, because a wrong field
   number is rejected there rather than discovered after a signature.
*/
const EXEC_URLS = ['/cosmwasm.wasm.v1.MsgExecuteContract',
                   '/terra.wasm.v1beta1.MsgExecuteContract'];
const msgExec = (sender, contract, msgJson, funds) => cat([
  fStr(1, sender), fStr(2, contract), fBytes(3, enc.encode(msgJson)),
  ...funds.map(c => fBytes(5, coin(c)))
]);
/* One signature, one or more messages.
   Cosmos runs the messages of a transaction in order and commits them together
   or not at all, which is exactly what a two step swap needs: the intermediate
   token exists only between the first message and the second, and if anything
   goes wrong neither ever happened. The array was always there in txBody; only
   the callers assumed there would be one entry. */
function execTx(url, sender, steps, key, seq, feeCoins, gas){
  const body = txBody(steps.map(function (s) {
    return any(url, msgExec(sender, s.contract, JSON.stringify(s.msg), s.funds));
  }), '');
  return { body: body, auth: authInfo(key, seq, feeCoins, gas) };
}

// Everything a real swap would do, stopping one step short of signing.
/* A node that has never heard of a message type says so, and that answer is
   about the node rather than about the trade. Every list of type urls ends with
   one the chain has moved on from, so the last error is always the least
   useful one there is - and it was the one being shown. */
const noHandler = m => /no message handler|unknown request|unknown message type/i
  .test(String(m || ''));

/* What a contract says when it refuses, in words.
   These are the two refusals a swap actually produces, and both are things
   someone can do something about - which the raw text does not make obvious. */
function plainRefusal(msg){
  const s = String(msg || '');
  if (/max.?spread|exceeds.*spread|slippage/i.test(s)) {
    return 'the price would move further than your slippage tolerance allows. ' +
           'Raise it, or trade a smaller amount.';
  }
  if (/minimum.?receive|min_receive|assertion.*minimum/i.test(s)) {
    return 'the pool would return less than the minimum this trade guarantees. ' +
           'Raise the tolerance, or trade a smaller amount.';
  }
  if (/insufficient funds|insufficient balance/i.test(s)) {
    return 'there is not enough here to cover the trade and its fee.';
  }
  return s || 'unknown reason';
}

/* Of everything the node said, the part that is about the trade.
   Kept out of the loop so it can be checked: which refusal gets shown is the
   whole of this fix, and a choice made inside a catch block is a choice nobody
   can test. */
function refusalOf(errors){
  for (const e of errors) {
    const m = e && e.message;
    if (!noHandler(m)) return m;
  }
  const lastOne = errors[errors.length - 1];
  return lastOne && lastOne.message;
}

async function execPlan(from, steps, mnemonic){
  const [acc, key] = await Promise.all([account(from), keyOf(mnemonic)]);
  let used = 0, url = null;
  const refused = [];
  for (const u of EXEC_URLS) {
    // the ceiling has to cover every message, not one of them
    const probe = execTx(u, from, steps, key.pub, acc.seq,
      [{ denom: 'uluna', amount: '1000000' }], 900000 * steps.length);
    try { used = await simulateGas(probe.body, probe.auth); url = u; break; }
    catch (e) { refused.push(e); }
  }
  if (!url) throw new Error(plainRefusal(refusalOf(refused)));
  const gas = Math.ceil(used * GAS_SAFETY);
  return { acc: acc, key: key, url: url, used: used,
           gas: gas, gasFee: Math.ceil(gas * GAS_PRICE) };
}

async function dryRunSwap(from, steps, mnemonic){
  const p = await execPlan(from, steps, mnemonic);
  return { gas: p.gas, gasUsed: p.used, gasFee: p.gasFee, url: p.url };
}

// Rebuilt from scratch rather than reusing the reviewed bytes: the sequence
// moves whenever anything else touches this account.
async function sendSwap(from, steps, mnemonic){
  const p = await execPlan(from, steps, mnemonic);
  const real = execTx(p.url, from, steps, p.key.pub, p.acc.seq,
    [{ denom: 'uluna', amount: String(p.gasFee) }], p.gas);
  const doc = signDoc(real.body, real.auth, CHAIN, p.acc.num);
  const sig = p.key.node.sign(p.key.sha256(doc));
  const hash = await broadcast(txRaw(real.body, real.auth, [sig]));
  return { hash: hash, gas: p.gas, gasFee: p.gasFee, wait: function(){ return waitFor(hash); } };
}
export { dryRunSwap, sendSwap };
