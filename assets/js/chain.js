import { $ } from './shell.js?v=f478a2b1';

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
const localIcon = sym => 'assets/tokens/' + sym.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Three chances per icon, in order: the contract's own logo, a local file
// named after the ticker, the first letter. The letter is what renders first,
// so a slow image never leaves an empty hole in the row.
function iconHTML(t){
  const cands = [];
  if (t.logo) cands.push(t.logo);
  const base = localIcon(t.sym);
  cands.push(base + '.png', base + '.svg', base + '.webp');
  return '<span class="sym" style="background:' + swatch(t.sym) + '" ' +
         'data-icons="' + attr(cands.join('|')) + '">' + t.sym[0] + '</span>';
}

// The tint is dropped the moment a real image loads, because most token art is
// transparent and a coloured disc behind it reads as the token's own colour.
function paintIcons(root){
  root.querySelectorAll('.sym[data-icons]').forEach(el => {
    const cands = el.getAttribute('data-icons').split('|').filter(Boolean);
    let i = 0;
    (function next(){
      if (i >= cands.length) return;
      const img = new Image();
      img.alt = '';
      img.onload = () => {
        el.textContent = '';
        el.removeAttribute('style');
        el.classList.add('has-img');
        el.appendChild(img);
      };
      img.onerror = () => { i += 1; next(); };
      img.src = cands[i];
    })();
  });
}

const smart = (addr, msg) =>
  getJSON(LCD + '/cosmwasm/wasm/v1/contract/' + addr + '/smart/' + btoa(JSON.stringify(msg)));

// A public node under load answers 429 or simply takes too long. One such
// answer used to be indistinguishable from "there is nothing more here", which
// is how a partial market got mistaken for the whole one.
async function getJSON(url, ms = 12000, tries = 3){
  let last;
  for (let i = 0; i < tries; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { signal:c.signal });
      if (!r.ok) {
        const err = new Error(url.split('/').pop() + ' -> ' + r.status);
        // 4xx is the node answering. A smart query for a pair that does not
        // exist comes back 400, and asking twice more does not conjure it up.
        // 429 is the exception: that one means "later", not "no".
        err.final = r.status >= 400 && r.status < 500 && r.status !== 429;
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
    const d = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=terra-luna,terrausd&vs_currencies=usd', 8000);
    return { LUNC: d['terra-luna'] && d['terra-luna'].usd, USTC: d['terrausd'] && d['terrausd'].usd };
  } catch (e) { return {}; }
}

export { CW20, EXTRA_PAIRS, FACTORIES, LCD, NATIVE, THIN_LUNC, amt, chainLogo, fmt, getJSON, iconHTML, paintIcons, prices, smart, usd };
