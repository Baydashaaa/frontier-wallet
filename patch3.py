import io
p = 'index.html'
s = io.open(p, encoding='utf-8').read()

# ---------- 6. persist after onboarding ----------
old = "  go('done');\n}"
new = """  await saveWallet(addr, blob);
  $('#home-addr').textContent = addr;
  $('#home-note').textContent =
    'PIN check took ' + ms + ' ms on this device. That delay repeats on every unlock.';
  go('home');
}"""
assert s.count(old) == 1, 'finish tail'
s = s.replace(old, new)

# ---------- 7. storage layer, unlock, boot ----------
old = "/* ---------------- import ---------------- */"
new = """/* ---------------- storage ----------------
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

const short = a => a.slice(0, 11) + '\\u2026' + a.slice(-6);

async function saveWallet(addr, blob){
  try { await Store.save(JSON.stringify({ addr, blob })); }
  catch (e) { report('save', e); }
  const el = $('#store-kind');
  const label = Store.kind === 'secure' ? 'device keychain'
              : Store.kind === 'cloud'  ? 'telegram cloud'
              : 'memory only';
  el.innerHTML = 'stored in <b>' + label + '</b>';
  el.classList.toggle('weak', Store.kind !== 'secure');
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

/* ---------------- unlock ---------------- */
let SAVED = null, tries = 0;

$('#pinboxU').addEventListener('click', () => $('#pu').focus());
$('#pu').addEventListener('input', async () => {
  const v = digitsOnly($('#pu'));
  dots('pinrowU', v.length);
  $('#umsg').textContent = '';
  if (v.length < 6) return;

  $('#umsg').textContent = 'Checking';
  $('#umsg').style.color = 'var(--muted)';
  try {
    await libs();
    MNEMONIC = await decryptSeed(SAVED.blob, v);
    PASS = v; tries = 0;
    $('#home-addr').textContent = SAVED.addr;
    $('#home-note').textContent = '';
    saveWallet(SAVED.addr, SAVED.blob);
    go('home');
  } catch (e) {
    tries++;
    dots('pinrowU', 6, true);
    buzz('error');
    $('#umsg').textContent = 'Wrong PIN' + (tries > 2 ? ', ' + tries + ' attempts' : '');
    $('#umsg').style.color = 'var(--red)';
    setTimeout(() => { $('#pu').value = ''; dots('pinrowU', 0); }, 550);
  }
});

$('#btn-lock').addEventListener('click', () => {
  MNEMONIC = null; PASS = null;
  $('#pu').value = ''; dots('pinrowU', 0); $('#umsg').textContent = '';
  go('unlock');
  $('#pu').focus();
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Delete the wallet from this device? Only the recovery phrase can bring it back.')) return;
  await Store.clear();
  MNEMONIC = null; PASS = null; SAVED = null;
  go('welcome');
});

$('#btn-forget').addEventListener('click', async () => {
  if (!confirm('Forget this wallet? Only the recovery phrase can bring it back.')) return;
  await Store.clear();
  SAVED = null;
  go('welcome');
});

/* ---------------- boot ---------------- */
(async function boot(){
  try {
    const raw = await Store.load();
    if (!raw) return;
    SAVED = JSON.parse(raw);
    $('#unlock-addr').textContent = short(SAVED.addr);
    $('#st-welcome').classList.remove('on', 'intro');
    $('#st-unlock').classList.add('on');
    dots('pinrowU', 0);
  } catch (e) { report('boot', e); }
})();

/* ---------------- import ---------------- */"""
assert s.count(old) == 1, 'import anchor'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('patch 3 ok')
