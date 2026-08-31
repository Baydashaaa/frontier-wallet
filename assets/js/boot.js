import { amt, fmt } from './chain.js?v=48d619ff';
import { finish } from './crypto.js?v=48d619ff';
import { PIN_LEN, digitsOnly, dots, focusPin } from './onboarding.js?v=48d619ff';
import { $, bip39, buzz, dropKeyboard, go, libs, report, tap, tg } from './shell.js?v=48d619ff';
import { S } from './state.js?v=48d619ff';
import { Store, decryptSeed, saveWallet, short, showStore } from './storage.js?v=48d619ff';
import { luncRaw, openWallet } from './tokens.js?v=48d619ff';

/* ---------------- unlock ---------------- */
let tries = 0;

$('#pinboxU').addEventListener('click', () => focusPin('#pu'));
$('#pu').addEventListener('input', async () => {
  const v = digitsOnly($('#pu'));
  dots('pinrowU', v.length);
  $('#umsg').textContent = '';
  if (v.length < PIN_LEN) return;

  $('#umsg').textContent = 'Checking';
  $('#umsg').style.color = 'var(--muted)';
  try {
    await libs();
    S.MNEMONIC = await decryptSeed(S.SAVED.blob, v);
    S.PASS = v; tries = 0;
    saveWallet(S.SAVED.addr, S.SAVED.blob);
    openWallet(S.SAVED.addr);
  } catch (e) {
    // OperationError is what AES-GCM throws on a bad key; anything else is a real fault
    const badPin = e && (e.name === 'OperationError' || e.name === 'InvalidAccessError');
    tries++;
    dots('pinrowU', PIN_LEN, true);
    buzz('error');
    if (badPin) {
      $('#umsg').textContent = 'Wrong PIN' + (tries > 2 ? ', ' + tries + ' attempts' : '');
    } else {
      $('#umsg').textContent = 'Could not unlock: ' + (e && e.message ? e.message : e);
      report('unlock', e);
    }
    $('#umsg').style.color = 'var(--red)';
    setTimeout(() => { $('#pu').value = ''; dots('pinrowU', 0); }, 550);
  }
});

document.querySelectorAll('#tabs .tab').forEach(b =>
  b.addEventListener('click', () => go(b.dataset.tab)));
$('#act-stake').addEventListener('click', () => go('stake'));
/* Receive used to be an alert with a bech32 string in it.

   The encoder is loaded when this screen opens and not before: it is fifty
   kilobytes that most sessions never need, and Receive is a deliberate act
   rather than something the wallet does on the way past. */
let QR = null;
async function drawQR(addr){
  const box = $('#rc-qr');
  if (!box) return;
  box.innerHTML = '<span class="spin"></span>';
  try {
    if (!QR) QR = (await import('../../vendor/qrcode.mjs')).default;
    const q = QR(0, 'M');
    q.addData(addr);
    q.make();
    // an svg rather than an image: it stays sharp at any size, and a blurred
    // qr is one a camera has to be coaxed into reading
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  } catch (e) {
    box.textContent = 'Could not draw the code. The address below still works.';
    report('qr', e);
  }
}

/* Copying, and saying so.
   The clipboard call can be refused - an insecure context, a webview that
   never implemented it - and a button that silently does nothing teaches
   people to distrust every other button. */
async function copyText(text, btn, done){
  const back = btn.textContent;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else throw new Error('no clipboard');
    buzz('success');
    btn.textContent = done || 'Copied';
  } catch (e) {
    btn.textContent = 'Select it by hand, copying was refused';
  }
  setTimeout(function () { btn.textContent = back; }, 1600);
}

$('#act-recv').addEventListener('click', () => {
  const a = S.SAVED && S.SAVED.addr;
  if (!a) return;
  $('#rc-addr').textContent = a;
  go('receive');
  drawQR(a);
});

$('#rc-copy').addEventListener('click', function () {
  const a = S.SAVED && S.SAVED.addr;
  if (a) copyText(a, this, 'Copied to clipboard');
});

$('#home-addr').addEventListener('click', function () {
  const a = S.SAVED && S.SAVED.addr;
  if (a) copyText(a, this, 'Copied');
});

/* A way out, where one exists.
   Telegram can close a Mini App; a browser tab cannot close itself, so outside
   Telegram the row is simply not there. */
(function () {
  const row = $('#btn-close');
  if (!row || !tg || typeof tg.close !== 'function') return;
  row.hidden = false;
  row.addEventListener('click', function () { tap(); try { tg.close(); } catch (e) {} });
})();
$('#act-send').addEventListener('click', () => {
  // hand the send screen the balance it is allowed to spend
  const el = $('#send-avail');
  if (el) {
    const raw = luncRaw() || 0;
    el.dataset.raw = String(raw);
    el.textContent = raw ? '\u00b7 ' + fmt(amt(raw, 6)) + ' available' : '';
  }
  go('send');
});

$('#btn-lock').addEventListener('click', () => {
  S.MNEMONIC = null; S.PASS = null;
  $('#pu').value = ''; dots('pinrowU', 0); $('#umsg').textContent = '';
  go('unlock');
  $('#pu').focus();
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Delete the wallet from this device? Only the recovery phrase can bring it back.')) return;
  await Store.clear();
  S.MNEMONIC = null; S.PASS = null; S.SAVED = null;
  go('welcome');
});

$('#btn-forget').addEventListener('click', async () => {
  if (!confirm('Forget this wallet? Only the recovery phrase can bring it back.')) return;
  await Store.clear();
  S.SAVED = null;
  go('welcome');
});

/* ---------------- boot ---------------- */
(async function boot(){
  showStore();
  try {
    const raw = await Store.load();
    if (!raw) return;
    S.SAVED = JSON.parse(raw);
    $('#unlock-addr').textContent = short(S.SAVED.addr);
    $('#st-welcome').classList.remove('on', 'intro');
    $('#st-unlock').classList.add('on');
    dots('pinrowU', 0);
  } catch (e) { report('boot', e); }
})();

/* ---------------- import ---------------- */
async function checkImport(){
  const v = $('#imp').value.trim().toLowerCase().replace(/\s+/g,' ');
  const n = v ? v.split(' ').length : 0;
  const t = $('#imptxt');
  const passOk = new RegExp('^\\d{' + PIN_LEN + '}$').test($('#ip1').value);
  if (!n) { t.textContent = ''; $('#btn-import').disabled = true; return; }
  if (n !== 12 && n !== 24) {
    t.textContent = n + ' words, needs 12 or 24';
    t.style.color = 'var(--muted)';
    $('#btn-import').disabled = true; return;
  }
  await libs();
  const ok = bip39.validateMnemonic(v, bip39.wordlist);
  t.textContent = ok ? 'Valid phrase' : 'Checksum failed, a word is wrong or out of order';
  t.style.color = ok ? 'var(--green)' : 'var(--red)';
  $('#btn-import').disabled = !(ok && passOk);
}
$('#imp').addEventListener('input', checkImport);
$('#ip1').addEventListener('input', checkImport);

/* ---------------- watch only ---------------- */
async function checkWatch(){
  const v = $('#wa').value.trim().toLowerCase();
  const t = $('#watxt');
  if (!v) { t.textContent = ''; $('#btn-watch').disabled = true; return; }
  if (!/^terra1[02-9ac-hj-np-z]{38,58}$/.test(v)) {
    t.textContent = 'Not a Terra address yet';
    t.style.color = 'var(--muted)';
    $('#btn-watch').disabled = true; return;
  }
  await libs();
  let ok = false, kind = '';
  try {
    const d = base.bech32.decode(v);
    const bytes = base.bech32.fromWords(d.words);
    ok = d.prefix === 'terra' && (bytes.length === 20 || bytes.length === 32);
    kind = bytes.length === 32 ? 'Valid, this is a contract address' : 'Valid address';
  } catch (e) { ok = false; }
  t.textContent = ok ? kind : 'Checksum failed, a character is wrong';
  t.style.color = ok ? 'var(--green)' : 'var(--red)';
  $('#btn-watch').disabled = !ok;
}
$('#wa').addEventListener('input', checkWatch);

$('#btn-watch').addEventListener('click', () => {
  tap();
  $('#watch-out').textContent = $('#wa').value.trim().toLowerCase();
  go('watching');
});

$('#btn-import').addEventListener('click', async () => {
  const b = $('#btn-import'), t = $('#imptxt');
  dropKeyboard();
  b.disabled = true; b.innerHTML = '<span class="spin"></span>Restoring';
  try {
    await libs();
    S.MNEMONIC = $('#imp').value.trim().toLowerCase().replace(/\s+/g,' ');
    S.PASS = $('#ip1').value;
    if (!bip39.validateMnemonic(S.MNEMONIC, bip39.wordlist)) throw new Error('checksum');
    if (S.PASS.length !== PIN_LEN) throw new Error('PIN must be 8 digits');
    await finish(S.MNEMONIC);
    b.innerHTML = 'Restore';                 // only reset on the way out
  } catch (e) {
    b.innerHTML = 'Restore';
    b.disabled = false;
    t.textContent = 'Could not restore: ' + (e && e.message ? e.message : 'unknown error');
    t.style.color = 'var(--red)';
    console.error('[import]', e);
  }
});

// Desktop Telegram hands the webview a window wider than what is actually
// visible, so anything centred lands off to one side. expand() puts the
// viewport into a state the app can trust, and the ready() before it is what
// tells Telegram the page is up.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) return;
  try { tg.ready(); } catch (e) {}
  try { tg.expand(); } catch (e) {}
})();
