import { $ } from './shell.js?v=1a721539';

/* ---------------- chain reads ---------------- */
const LCD = 'https://terra-classic-lcd.publicnode.com';
// A seed, not the whole list. Everything that trades is discovered from the
// factory pools below. What lives here is what discovery cannot see: TCO has
// no pool at all yet, so nothing but this line would ever show it.
const CW20 = [
  'terra1566znlxwke0kp9jkhe6qgapsmcfdmc7k9czh380tlx80va8zlsgqzvjtfp',
  'terra1vhgq25vwuhdhn9xjll0rhl2s67jzw78a4g2t78y5kz89q9lsdskq2pxcj2',
  'terra1ex0hjv3wurhj4wgup4jzlzaqj4av6xqd8le4etml7rg9rs207y4s8cdvrp',
  'terra12f3f5fzfzxckc0qlv3rmwwkjfhzevpwmx77345n0zuu2678vxf0sm6vvcw',
  'terra1mm8tdp40r2slzwqxk8jsz66ayc4zp69muxeateq37x2xquttzsaqy7275a',
  'terra1ljyvgw50u67r3ep7pp7qexgnsgy96fl57q0suut325ehed7eal8qwdtdq4'
];
const NATIVE = { uluna:{sym:'LUNC',dec:6}, uusd:{sym:'USTC',dec:6} };
const COLOR  = { LUNC:'#7B5CFF', USTC:'#00FFB0', TCO:'#00D4FF', TERRA:'#E8C840' };
// a stable colour per symbol so tokens do not change appearance between loads
function hue(sym){
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 360;
  return 'hsl(' + h + ',62%,58%)';
}
const swatch = sym => COLOR[sym] || hue(sym);
// Terraswap-fork factories. Every pair they make answers {pool:{}} the same
// way, so one code path covers Terraport, Astroport and the rest. Pools that
// were deployed straight from a wallet are invisible here - that is a known
// gap, not an oversight.
// Every TerraSwap shaped factory we know about. Adding one here widens both
// discovery and pricing at once, because the candidate list and the route
// graph are both built from whatever these return.
// Two dialects. "ts" is the TerraSwap shape: pairs{limit,start_after} paged
// thirty at a time, sides in an asset_infos array. "garuda" answers pairs{}
// once and names the sides asset1 / asset2. Adding a factory is still one line.
// Names read off the chain, not guessed. "ts" means the TerraSwap message
// shape - pairs{limit,start_after}, sides in asset_infos - which four of these
// speak regardless of who built them. Garuda speaks its own, and worse, its
// factory answers pairs{} with ten pools out of 205 and ignores every paging
// field without complaining, so its pools are listed by code id instead.
const FACTORIES = [
  { a: 'terra1n75fgfc8clsssrm2k0fswgtzsvstdaah7la6sfu96szdu22xta0q57rqqr', k: 'ts', n: 'Terraport V2' },
  { a: 'terra1y55punu6m5cm8sgqdgt6ngevtyklaylc09qxputn6ksye4ptf9ysxmtyl6', k: 'ts', n: 'Terraport V3' },
  { a: 'terra1fctq9rwk6vn2v6pdyhydmczxxdsttrxd2qcsq6ffzp7akfnw2uqq3ueskn', k: 'ts', n: 'TwingoSwap' },
  { a: 'terra1ejpgvv7g3hj0u6fpcnxhflqp84g0w3cnaskqkg5733ygwlmf963sfchsea', k: 'ts', n: 'CL8Y' },
  { a: 'terra1ypwj6sw25g0qcykv7mzmcvsndvx56r3yrgkaw3fds7yzwl7fwwcsnxkeh7', k: 'code', n: 'Garuda', code: 10907 }
];
// Pools that exist on chain but appear in no factory listing. Reserves are
// read the same way as any other pool; only the discovery is manual.
const EXTRA_PAIRS = [
  'terra1treu8r8908lsr8r48yc85rdp7mk52vuukugw2x9z9a7h6085hens5sphtw',   // VIMA
  'terra1cf0fxnvhcmsqnw8levj3vrhrq3nxgfmc86w9d6pxyeghqyrkgj2spgqarl'    // DO
];
const THIN_LUNC = 500000;   // below this the quote is real but barely tradeable
const IPFS = 'https://ipfs.io/ipfs/';

// marketing_info answers with either a url, the word "embedded", or nothing at
// all - JURIS ships an empty string, which is the owner's right and not a bug
// on our side. Whatever is missing here falls through to the local file.
async function chainLogo(contract, mkt){
  const lg = mkt && mkt.data && mkt.data.logo;
  if (!lg) return null;
  if (typeof lg === 'string' || lg.embedded !== undefined) {
    const r = await smart(contract, { download_logo: {} }).catch(() => null);
    const dl = r && r.data;
    if (!dl || !dl.data) return null;
    return 'data:' + (dl.mime_type || 'image/png') + ';base64,' + dl.data;
  }
  if (!lg.url) return null;
  return lg.url.startsWith('ipfs://') ? IPFS + lg.url.slice(7) : lg.url;
}

const attr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// A ticker with no local file is a fact about this build, not a network
// hiccup, so asking again on the next render only produces the same 404. What
// is remembered per symbol: the url that worked, or 0 for "there is nothing".
const ICON_KEY = 'fw:icons';
let ICON_SEEN = {};
try { ICON_SEEN = JSON.parse(localStorage.getItem(ICON_KEY) || '{}') || {}; } catch (e) {}
let ICON_T = null;
function iconRemember(sym, val){
  if (!sym || ICON_SEEN[sym] === val) return;
  ICON_SEEN[sym] = val;
  // written in one go rather than on every icon
  clearTimeout(ICON_T);
  ICON_T = setTimeout(function () {
    try { localStorage.setItem(ICON_KEY, JSON.stringify(ICON_SEEN)); } catch (e) {}
  }, 500);
}
const localIcon = sym => 'assets/tokens/' + sym.toUpperCase().replace(/[^A-Z0-9]/g, '');

// A logo url that 404s will 404 again on the next render, and there are
// several renders per load - LTK's free image host dropped its file, so that
// one was being requested six times an open and losing the icon to a letter
// each time. Remembered per url rather than per symbol, so a token whose owner
// later points marketing_info somewhere that works is unaffected. Hosts do
// come back, so an entry is only believed for a week.
const DEAD_KEY = 'fw:icons:dead';
const DEAD_TTL = 7 * 24 * 3600 * 1000;
let ICON_DEAD = {};
try {
  const raw = JSON.parse(localStorage.getItem(DEAD_KEY) || '{}') || {};
  const now = Date.now();
  for (const u in raw) if (now - raw[u] < DEAD_TTL) ICON_DEAD[u] = raw[u];
} catch (e) {}
let DEAD_T = null;
function iconDead(url){
  if (ICON_DEAD[url]) return;
  ICON_DEAD[url] = Date.now();
  clearTimeout(DEAD_T);
  DEAD_T = setTimeout(function () {
    try { localStorage.setItem(DEAD_KEY, JSON.stringify(ICON_DEAD)); } catch (e) {}
  }, 500);
}

// Three chances per icon, in order: the contract's own logo, a local file
// named after the ticker, the first letter. The letter is what renders first,
// so a slow image never leaves an empty hole in the row.
function iconHTML(t){
  const sym = t.sym;
  const known = ICON_SEEN[sym];
  const cands = [];
  if (t.logo && !ICON_DEAD[t.logo]) cands.push(t.logo);
  if (typeof known === 'string') {
    cands.push(known);                       // уже знаем, какой файл есть
  } else if (known !== 0) {
    const base = localIcon(sym);             // ещё не искали
    cands.push(base + '.png', base + '.svg', base + '.webp');
  }                                          // known === 0 - файла нет, не ищем
  return '<span class="sym" style="background:' + swatch(sym) + '" ' +
         'data-sym="' + attr(sym) + '" ' +
         'data-logo="' + attr(t.logo || '') + '" ' +
         'data-icons="' + attr(cands.join('|')) + '">' + sym[0] + '</span>';
}

// The tint is dropped the moment a real image loads, because most token art is
// transparent and a coloured disc behind it reads as the token's own colour.
function paintIcons(root){
  root.querySelectorAll('.sym[data-icons]').forEach(el => {
    const cands = el.getAttribute('data-icons').split('|').filter(Boolean);
    const sym = el.getAttribute('data-sym') || '';
    let i = 0;
    (function next(){
      if (i >= cands.length) {
        // every candidate failed, and that will still be true next time
        if (sym) iconRemember(sym, 0);
        return;
      }
      const img = new Image();
      img.alt = '';
      img.onload = () => {
        el.textContent = '';
        el.removeAttribute('style');
        el.classList.add('has-img');
        el.appendChild(img);
        // only local paths are worth remembering: a contract logo arrives as a
        // data url, and storing those would fill the quota with base64
        if (sym && cands[i].indexOf('assets/') === 0) iconRemember(sym, cands[i]);
      };
      img.onerror = () => {
        // a local miss is already remembered per symbol below; this is for the
        // remote urls, which nothing was remembering at all
        const c = cands[i];
        if (c.indexOf('assets/') !== 0 && c.indexOf('data:') !== 0) iconDead(c);
        i += 1; next();
      };
      img.src = cands[i];
    })();
  });
}

// Some questions have no second answer. A factory that does not hold a pair
// says so with a 500 rather than a 400, and asking again three times only
// produces three of them - so the caller can say how many times to try.
const smart = (addr, msg, tries) =>
  getJSON(LCD + '/cosmwasm/wasm/v1/contract/' + addr + '/smart/' + btoa(JSON.stringify(msg)),
          12000, tries || 3);

// One node, one queue. Every mapLimit caps its own fan-out, but several run at
// the same time, so nothing ever capped the total - and the total is what a
// public node answers 500 to. This gate is the only place that sees them all.
const GATE = { n: 0, max: 6, q: [] };
// A public node counts requests per minute, not requests at once, so six in
// flight still delivers a hundred inside ten seconds - which is what it was
// answering 429 to. The queue paces as well as caps: one start every PACE_MS.
const PACE_MS = 120;
const PACE = { next: 0 };
async function slot(){
  if (GATE.n < GATE.max) GATE.n += 1;
  else await new Promise(function (res) { GATE.q.push(res); });
  const now = Date.now();
  const at = Math.max(now, PACE.next);
  PACE.next = at + PACE_MS;
  if (at > now) await nap(at - now);
}
function release(){
  const next = GATE.q.shift();
  if (next) next(); else GATE.n -= 1;
}
const nap = ms => new Promise(function (r) { setTimeout(r, ms); });

// A public node under load answers 429 or simply takes too long. One such
// answer used to be indistinguishable from "there is nothing more here", which
// is how a partial market got mistaken for the whole one.
async function getJSON(url, ms = 12000, tries = 3){
  let last;
  for (let i = 0; i < tries; i++) {
    // A retry that leaves immediately is the same burst again, which is why the
    // node was answering 500 three times instead of once.
    if (i) await nap(200 + 300 * i * i);
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      await slot();
      let r;
      try { r = await fetch(url, { signal:c.signal }); }
      finally { release(); }
      if (!r.ok) {
        const err = new Error(url.split('/').pop() + ' -> ' + r.status);
        // callers that need to tell a refusal from a silence read this
        err.status = r.status;
        // 4xx is the node answering. A smart query for a pair that does not
        // exist comes back 400, and asking twice more does not conjure it up.
        // 429 is the exception: that one means "later", not "no".
        // 501 is a 5xx that will never turn into anything else: the endpoint
        // is not built on this node. denom_traces is one of those, and asking
        // three times only made it three refusals.
        err.final = (r.status >= 400 && r.status < 500 && r.status !== 429) ||
                    r.status === 501;
        throw err;
      }
      return await r.json();
    } catch (e) {
      last = e;
      if (e && e.final) break;
      if (i < tries - 1) await new Promise(z => setTimeout(z, 400 * (i + 1)));
    } finally { clearTimeout(t); }
  }
  throw last;
}
const amt = (raw, dec) => Number(raw || 0) / Math.pow(10, dec);
const fmt = v => v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 2 });
const usd = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

async function prices(){
  try {
    const d = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=terra-luna,terrausd&vs_currencies=usd', 8000, 2);
    return { LUNC: d['terra-luna'] && d['terra-luna'].usd, USTC: d['terrausd'] && d['terrausd'].usd };
  } catch (e) { return {}; }
}

export { CW20, EXTRA_PAIRS, FACTORIES, LCD, NATIVE, THIN_LUNC, amt, chainLogo, fmt, getJSON, iconHTML, paintIcons, prices, smart, usd };
