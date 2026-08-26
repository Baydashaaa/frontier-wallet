import { $, base, bip32, bip39, ripe, sha } from './shell.js?v=89e16afa';
import { S } from './state.js?v=89e16afa';
import { saveWallet } from './storage.js?v=89e16afa';
import { openWallet } from './tokens.js?v=89e16afa';

/* ---------------- crypto ---------------- */
const ITER = 600000;
const b64 = u8 => btoa(String.fromCharCode(...u8));

async function encryptSeed(mnemonic, pass){
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const km   = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:ITER, hash:'SHA-256' },
    km, { name:'AES-GCM', length:256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(mnemonic)));
  return { v:1, kdf:'pbkdf2-sha256', iter:ITER, salt:b64(salt), iv:b64(iv), ct:b64(ct) };
}

async function deriveAddress(mnemonic){
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const node = bip32.HDKey.fromMasterSeed(seed).derive("m/44'/330'/0'/0/0");
  const rip  = ripe.ripemd160(sha.sha256(node.publicKey));
  return base.bech32.encode('terra', base.bech32.toWords(rip));
}

async function finish(mnemonic){
  const t0 = performance.now();
  const [addr, blob] = await Promise.all([deriveAddress(mnemonic), encryptSeed(mnemonic, S.PASS)]);
  const ms = Math.round(performance.now() - t0);
  $('#addr-out').textContent = addr;
  $('#blob-out').textContent = JSON.stringify(blob);
  $('#kdf-note').textContent = 'Key derivation took ' + ms + ' ms here with ' +
    ITER.toLocaleString() + ' PBKDF2 iterations. That delay repeats on every unlock, so pick the number against the slowest phone you care about, not this one.';
  await saveWallet(addr, blob);
  openWallet(addr);
}

$('#btn-verify').addEventListener('click', async () => {
  const b = $('#btn-verify');
  b.disabled = true; b.innerHTML = '<span class="spin"></span>Encrypting';
  try { await finish(S.MNEMONIC); }
  catch (e) { b.textContent = 'Something went wrong'; }
  finally { b.innerHTML = 'Create wallet'; }
});

export { finish };
