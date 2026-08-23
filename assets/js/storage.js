import { $, report, tg } from './shell.js?v=3d29f62b';
import { S } from './state.js?v=3d29f62b';

/* ---------------- storage ----------------
   SecureStorage is backed by the iOS Keychain and the Android Keystore,
   so the encrypted key never reaches a server. The cost is that it is
   DEVICE LOCAL: a new phone or a reinstall means the recovery phrase is
   the only way back. That is why the backup step is not optional.
------------------------------------------- */
const KEY = 'frontier_wallet_v1';
const Store = (() => {
  let mem = null, kind = 'memory', api = null;
  if (tg && tg.SecureStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0')) {
    kind = 'secure'; api = tg.SecureStorage;
  } else if (tg && tg.CloudStorage) {
    kind = 'cloud'; api = tg.CloudStorage;
  }
  const call = (fn, ...args) => new Promise((res, rej) => {
    try { fn.call(api, ...args, (err, val) => err ? rej(err) : res(val)); }
    catch (e) { rej(e); }
  });
  return {
    get kind(){ return kind; },
    async save(v){ if (!api) { mem = v; return; } await call(api.setItem, KEY, v); },
    async load(){
      if (!api) return mem;
      try { return await call(api.getItem, KEY); } catch (e) { return null; }
    },
    async clear(){ if (!api) { mem = null; return; } try { await call(api.removeItem, KEY); } catch (e) {} }
  };
})();

const short = a => a.slice(0, 11) + '\u2026' + a.slice(-6);

function showStore(){
  const el = $('#store-kind');
  if (!el) return;
  const label = Store.kind === 'secure' ? 'device keychain'
              : Store.kind === 'cloud'  ? 'telegram cloud'
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
