// nft.js - NFT адреса, без списка коллекций.
//
// Перечислять коллекции нечем: у CW721 нет фабрики, которая знала бы их все.
// Зато у CW721 есть запрос {tokens:{owner}}, на который CW20 отвечает ошибкой.
// Значит коллекции можно не знать заранее, а узнавать: собрать контракты, с
// которыми адрес когда-либо имел дело, и спросить каждого. Чужая коллекция
// найдётся так же, как своя.
import { LCD, getJSON, smart } from './chain.js?v=e1051c10';
import { $ } from './shell.js?v=e1051c10';
import { cacheGet, cacheSet, mapLimit, txCandidates } from './market.js?v=e1051c10';
import { S } from './state.js?v=e1051c10';

const SHOW_MAX = 24;          // сколько картинок тянуть за один заход
let LOADED = '';

// Три события, потому что NFT приходит не так, как токен: минт пишет
// владельца, перевод - получателя, а часть контрактов зовёт это "to".
async function contractsFor(addr){
  const hit = cacheGet('nftc:' + addr);
  if (hit) return hit;

  const evs = ["wasm.recipient='" + addr + "'",
               "wasm.owner='" + addr + "'",
               "wasm.to='" + addr + "'"];
  const pages = await Promise.all(evs.map(function (ev) {
    return getJSON(LCD + '/cosmos/tx/v1beta1/txs?query=' + encodeURIComponent(ev) +
      '&pagination.limit=100&order_by=ORDER_BY_DESC', 25000).catch(function () { return {}; });
  }));

  const out = {};
  for (const r of pages)
    for (const t of (r.tx_responses || []))
      for (const lg of (t.logs || []))
        for (const e of (lg.events || []))
          if (e.type === 'wasm')
            for (const a of (e.attributes || []))
              if (a.key === '_contract_address') out[a.value] = 1;

  // то же, чем ищутся токены: контракты, уже встречавшиеся этому адресу
  for (const c of (await txCandidates(addr).catch(function () { return []; }))) out[c] = 1;

  const list = Object.keys(out);
  cacheSet('nftc:' + addr, list);
  return list;
}

// Контракт, ответивший списком, - коллекция. Ошибка здесь обычный ответ, а не
// сбой: почти всё, что попадает в перебор, никаким CW721 не является.
async function collections(addr){
  const cands = await contractsFor(addr);
  const res = await mapLimit(cands, 8, async function (c) {
    let ids;
    try {
      const r = await smart(c, { tokens: { owner: addr, limit: 30 } });
      ids = ((r.data || {}).tokens) || null;
    } catch (e) { return null; }
    if (!Array.isArray(ids) || !ids.length) return null;
    let name = '';
    try { name = (((await smart(c, { contract_info: {} })).data) || {}).name || ''; }
    catch (e) { /* коллекция без имени всё ещё коллекция */ }
    return { c: c, name: name, ids: ids };
  });
  return res.filter(Boolean);
}

const IPFS = 'https://ipfs.io/ipfs/';
const web = u => !u ? '' : (String(u).indexOf('ipfs://') === 0 ? IPFS + String(u).slice(7) : u);
const looksImage = u => /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(u || '');

// Картинка лежит по-разному: у одних прямо в extension, у других по ссылке, и
// ссылка чаще ведёт на метаданные, а не на изображение.
async function imageOf(contract, id){
  let d;
  try { d = ((await smart(contract, { nft_info: { token_id: String(id) } })).data) || {}; }
  catch (e) { return ''; }
  const ext = d.extension || {};
  if (ext.image) return web(ext.image);
  const uri = web(d.token_uri || '');
  if (!uri) return '';
  if (looksImage(uri)) return uri;
  try {
    const meta = await getJSON(uri, 15000);
    return web(meta.image || meta.image_url || '');
  } catch (e) { return ''; }
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
});

async function load(){
  const addr = S.ADDR || (S.SAVED && S.SAVED.addr) || '';
  if (!addr || LOADED === addr) return;
  const grid = $('#nft-grid'), note = $('#nft-note');
  grid.innerHTML = '<div class="empty">Looking for collections this address has touched</div>';
  note.textContent = '';

  let cols;
  try { cols = await collections(addr); }
  catch (e) {
    grid.innerHTML = '<div class="empty">Could not read the chain just now.</div>';
    return;
  }

  const items = [];
  for (const col of cols)
    for (const id of col.ids)
      items.push({ c: col.c, name: col.name || 'Collection', id: id });

  $('#nft-count').textContent = items.length ? String(items.length) : '';
  if (!items.length) {
    grid.innerHTML = '<div class="empty">No NFTs on this address yet.</div>';
    LOADED = addr;
    return;
  }

  // рамки сразу, картинки следом: сетка не должна ждать самый медленный шлюз
  const shown = items.slice(0, SHOW_MAX);
  grid.innerHTML = shown.map(function (it, i) {
    return '<div class="nft-card" data-i="' + i + '">' +
      '<div class="nft-art"><span class="ph">' + esc(String(it.id).slice(0, 2)) + '</span></div>' +
      '<div class="nft-meta"><div class="nft-id">' + esc(it.id) + '</div>' +
      '<div class="nft-col">' + esc(it.name) + '</div></div></div>';
  }).join('');
  note.textContent = items.length > SHOW_MAX
    ? 'Showing ' + SHOW_MAX + ' of ' + items.length + ' across ' + cols.length + ' collections.'
    : items.length + ' across ' + cols.length + ' collection' + (cols.length > 1 ? 's' : '') + '.';

  await mapLimit(shown, 5, async function (it, i) {
    const src = await imageOf(it.c, it.id);
    if (!src) return null;
    const card = grid.querySelector('.nft-card[data-i="' + shown.indexOf(it) + '"] .nft-art');
    if (!card) return null;
    const img = new Image();
    img.alt = '';
    // а если шлюз не отдал - остаётся заглушка, и это честнее битой картинки
    img.onload = function () { card.innerHTML = ''; card.appendChild(img); };
    img.src = src;
    return null;
  });

  LOADED = addr;
}

function pane(which){
  const tok = which === 'tok';
  document.querySelectorAll('.hm-seg-b').forEach(function (b) {
    b.classList.toggle('on', b.dataset.pane === which);
  });
  $('#pane-tok').hidden = !tok;
  $('#pane-nft').hidden = tok;
  if (!tok) load();
}

document.querySelectorAll('.hm-seg-b').forEach(function (b) {
  b.addEventListener('click', function () { pane(b.dataset.pane); });
});

export { load };
