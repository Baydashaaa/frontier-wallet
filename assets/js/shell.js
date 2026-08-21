/* ------------------------------------------------------------------
   PROTOTYPE. Real BIP39, real WebCrypto, real address derivation, so
   the address can be checked against Station. Nothing is persisted:
   the encrypted blob is displayed instead of stored, because this file
   is for review. Do not fund an address created here.

   For production replace PBKDF2 with Argon2id (hash-wasm). PBKDF2 is
   what WebCrypto offers natively but it is much weaker against GPU
   cracking, which is the threat when an encrypted blob sits on a
   server.
------------------------------------------------------------------- */
let bip39, bip32, base, ripe, sha;

const $  = s => document.querySelector(s);

/* no console inside a Mini App, so failures are printed on screen */
const crash = document.createElement('div');
crash.className = 'crash';
document.body.appendChild(crash);
function report(where, e){
  const msg = e && e.stack ? e.stack : String(e);
  crash.textContent = '[' + where + '] ' + msg;
  crash.classList.add('on');
}
window.addEventListener('error', ev => report('error', ev.error || ev.message));
window.addEventListener('unhandledrejection', ev => report('promise', ev.reason));
const $$ = s => Array.from(document.querySelectorAll(s));
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) { tg.ready(); tg.expand(); }
const tap  = () => { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light'); };

/* Telegram floats its close button over the page instead of reserving space,
   and on this build the safe-area vars come back as zero, so a floor is the
   only thing that reliably keeps content clear of it. */
function applyInsets(){
  const a = (tg && tg.contentSafeAreaInset && tg.contentSafeAreaInset.top) || 0;
  const b = (tg && tg.safeAreaInset && tg.safeAreaInset.top) || 0;
  const floor = tg ? 58 : 0;
  document.documentElement.style.setProperty('--pad-top', Math.max(a + b, floor) + 'px');
}
applyInsets();
if (tg && tg.onEvent) {
  ['safeAreaChanged','contentSafeAreaChanged','viewportChanged'].forEach(ev => {
    try { tg.onEvent(ev, applyInsets); } catch (e) {}
  });
}
const buzz = k => { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(k); };

/* the webview keeps focus after a tap outside, so drop it by hand */
function dropKeyboard(){
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) a.blur();
  if (tg && typeof tg.hideKeyboard === 'function') { try { tg.hideKeyboard(); } catch (e) {} }
}
document.addEventListener('pointerdown', e => {
  // .pinbox refocuses its hidden input on click, so blurring here made the
  // keyboard close and immediately reopen
  if (e.target.closest('input, textarea, .chip, .slot, .pinbox')) return;
  dropKeyboard();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); dropKeyboard(); }
});

const WALLET_TABS = ['home','stake','activity','settings'];
function go(name){
  tap();
  const t = $('#tabs');
  if (t) {
    t.classList.toggle('on', WALLET_TABS.includes(name));
    t.querySelectorAll('.tab').forEach(b => b.classList.toggle('sel', b.dataset.tab === name));
  }
  // the intro plays once; coming back to welcome later must be instant
  $('#st-welcome').classList.remove('intro');
  $$('.step').forEach(s => s.classList.remove('on'));
  $('#st-' + name).classList.add('on');
  window.scrollTo(0,0);
}
$$('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));

async function libs(){
  if (bip39) return;
  const m = await import('../../vendor/crypto.js');
  bip39 = { ...m.bip39, wordlist: m.wordlist };
  bip32 = m.bip32; base = m.base;
  ripe = { ripemd160: m.ripemd160 };
  sha  = { sha256: m.sha256 };
}

export { $, $$, bip39, buzz, dropKeyboard, go, libs, report, tap, tg };
