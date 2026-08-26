import { $, report, tg } from './shell.js?v=66f765b7';
import { S } from './state.js?v=66f765b7';

/* ---------------- storage ----------------
   SecureStorage is backed by the iOS Keychain and the Android Keystore,
   so the encrypted key never reaches a server. The cost is that it is
   DEVICE LOCAL: a new phone or a reinstall means the recovery phrase is
   the only way back. That is why the backup step is not optional.
------------------------------------------- */
const KEY = 'frontier_wallet_v1';
const Store = (() => {
  let mem = null, kind = 'memory', api = null;
  // CloudStorage lands in the SDK object long before the client can answer it,
  // so existence is not the question - the version is. Cloud storage arrived
  // in 6.9; asking a 6.0 desktop client throws on every save.
  const atLeast = v => !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));
  if (tg && tg.SecureStorage && atLeast('8.0')) {
    kind = 'secure'; api = tg.SecureStorage;
  } else if (tg && tg.CloudStorage && atLeast('6.9')) {
    kind = 'cloud'; api = tg.CloudStorage;
  } else {
    // Falling back to memory meant the wallet did not survive a reload on those
    // clients. What is stored is the PIN-encrypted blob, not the phrase, so
    // localStorage is a weaker place than the Keychain but not an open one.
    kind = 'local';
  }
  const call = (fn, ...args) => new Promise((res, rej) => {
    try { fn.call(api, ...args, (err, val) => err ? rej(err) : res(val)); }
    catch (e) { rej(e); }
  });

  // Presence is not support. Telegram Desktop hands out a SecureStorage object
  // and a version high enough to pass any check, then answers UNSUPPORTED when
  // you use it - because the thing behind it is a phone's keychain. So when a
  // store refuses, we move to the next one rather than report and stop.
  function stepDown(){
    if (kind === 'secure' && tg && tg.CloudStorage && atLeast('6.9')) {
      kind = 'cloud'; api = tg.CloudStorage;
      return true;
    }
    if (kind === 'secure' || kind === 'cloud') {
      kind = 'local'; api = null;
      return true;
    }
    return false;
  }
  return {
    get kind(){ return kind; },
    async save(v){
      // three attempts at most, one per rung of the ladder
      for (let i = 0; i < 3; i++) {
        if (api) {
          try { await call(api.setItem, KEY, v); return; }
          catch (e) { if (!stepDown()) break; continue; }
        }
        if (kind === 'local') {
          try { localStorage.setItem(KEY, v); return; }
          catch (e) { /* private mode or a full quota - memory is what is left */ }
        }
        break;
      }
      mem = v;
    },
    async load(){
      // A wallet saved before this fix is sitting in whichever store answered
      // last time, so every rung is checked rather than only the current one.
      if (api) {
        try {
          const v = await call(api.getItem, KEY);
          if (v) return v;
        } catch (e) { stepDown(); return this.load(); }
      }
      try {
        const v = localStorage.getItem(KEY);
        if (v) return v;
      } catch (e) {}
      return mem;
    },
    async clear(){
      if (api) { try { await call(api.removeItem, KEY); } catch (e) {} return; }
      if (kind === 'local') { try { localStorage.removeItem(KEY); } catch (e) {} return; }
      mem = null;
    }
  };
})();

const short = a => a.slice(0, 11) + '\u2026' + a.slice(-6);

function showStore(){
  const el = $('#store-kind');
  if (!el) return;
  const label = Store.kind === 'secure' ? 'device keychain'
              : Store.kind === 'cloud'  ? 'telegram cloud'
              : Store.kind === 'local' ? 'this device\u2019s browser storage'
              : 'memory only, nothing is saved';
  el.innerHTML = 'stored in <b>' + label + '</b>';
  el.classList.toggle('weak', Store.kind !== 'secure');

  const rt = $('#rt');
  if (rt) {
    const w = window.Telegram;
    rt.textContent = !w
      ? 'window.Telegram absent - plain browser, or telegram-web-app.js failed to load'
      : !w.WebApp
        ? 'window.Telegram exists but WebApp does not'
        : 'WebApp ' + (w.WebApp.version || '?') + ' / ' + (w.WebApp.platform || '?') +
          ' | initData ' + ((w.WebApp.initData || '').length) +
          ' | Secure ' + (w.WebApp.SecureStorage ? 'y' : 'n') +
          ' | Cloud ' + (w.WebApp.CloudStorage ? 'y' : 'n') +
          ' | Device ' + (w.WebApp.DeviceStorage ? 'y' : 'n') +
          ' | store=' + Store.kind;
  }
}

async function saveWallet(addr, blob){
  S.SAVED = { addr, blob };          // without this, Lock right after setup had nothing to unlock
  $('#unlock-addr').textContent = short(addr);
  try { await Store.save(JSON.stringify({ addr, blob })); }
  catch (e) { report('save', e); }
  showStore();
}

async function decryptSeed(blob, pin){
  const u8 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  const enc = new TextEncoder();
  const km  = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name:'PBKDF2', salt:u8(blob.salt), iterations:blob.iter, hash:'SHA-256' },
    km, { name:'AES-GCM', length:256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv:u8(blob.iv) }, key, u8(blob.ct));
  return new TextDecoder().decode(pt);
}

export { Store, decryptSeed, saveWallet, short, showStore };
