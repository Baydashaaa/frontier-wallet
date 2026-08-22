import { LCD, amt, fmt, getJSON } from './chain.js?v=0fb00800';
import { $, buzz, go, tap } from './shell.js?v=0fb00800';
import { S } from './state.js?v=0fb00800';

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
const GAS_SAFETY = 1.5;          // simulation is a floor, not a promise

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
  const rate = await burnTaxRate();
  const [acc, key] = await Promise.all([account(from), keyOf(mnemonic)]);
  const raw = Math.floor(Number(human) * 1e6);
  if (!(raw > 0)) throw new Error('amount must be greater than zero');

  // first pass with a placeholder fee, only to learn the gas
  const first = nativeSendTx(from, to, denom, raw, memo, key.pub, acc.seq,
    [{ denom: 'uluna', amount: '1000000' }], 400000);
  const used = await simulateGas(first.body, first.auth);
  const gas = Math.ceil(used * GAS_SAFETY);
  const gasFee = Math.ceil(gas * GAS_PRICE);
  const tax = Math.ceil(raw * rate);

  // and the transaction as it would actually be signed
  const real = nativeSendTx(from, to, denom, raw, memo, key.pub, acc.seq,
    [{ denom: 'uluna', amount: String(gasFee + tax) }], gas);
  const doc = signDoc(real.body, real.auth, CHAIN, acc.num);
  const sig = key.node.sign(key.sha256(doc));

  return {
    rate: rate, amount: raw, tax: tax, gas: gas, gasUsed: used, gasFee: gasFee,
    total: raw + tax + gasFee,
    seq: acc.seq, num: acc.num,
    bytes: txRaw(real.body, real.auth, [sig]).length,
    signed: sig.length === 64
  };
}

/* ---------------- the screen ---------------- */
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
      line('Burn tax ' + (d.rate * 100).toFixed(2) + '%', fmt(amt(d.tax, 6)) + ' LUNC') +
      line('Gas (' + d.gasUsed.toLocaleString() + ' simulated, ' + d.gas.toLocaleString() + ' requested)',
           fmt(amt(d.gasFee, 6)) + ' LUNC') +
      line('Leaves your wallet', fmt(amt(d.total, 6)) + ' LUNC', true) +
      line('Recipient gets', fmt(amt(d.amount, 6)) + ' LUNC', true) +
      (over ? '<div class="sbad">More than this address holds - ' +
              fmt(amt(avail, 6)) + ' LUNC available.</div>' : '') +
      '<div class="tiny" style="margin-top:12px">Signed and ready at ' + d.bytes +
      ' bytes, sequence ' + d.seq + '. Nothing was sent - broadcasting is the next patch. ' +
      'Compare these numbers with Station on the same transfer before we turn it on.</div>';
    buzz('success');
  } catch (e) {
    out.innerHTML = '<div class="sbad">' + (e.message || e) + '</div>';
  }
}

function fillMax(){
  const avail = luncOf();
  const rate = TAX === null ? 0.015 : TAX;
  // a rough gas allowance; the review recomputes it properly
  const gasFee = Math.ceil(250000 * GAS_SAFETY * GAS_PRICE);
  const raw = Math.floor((avail - gasFee) / (1 + rate));
  $('#send-amt').value = raw > 0 ? (raw / 1e6).toFixed(6) : '0';
  tap();
}

const btn = $('#send-review');
if (btn) {
  btn.addEventListener('click', review);
  const mx = $('#send-max');
  if (mx) mx.addEventListener('click', fillMax);
}

export { dryRunNative, burnTaxRate, b64 };
