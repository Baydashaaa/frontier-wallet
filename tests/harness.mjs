/* Loads the real assets/js/market.js against a stubbed outside world.

   The point is that the module under test is not a copy. Two of the bugs this
   suite covers were invisible in a reimplementation - the empty-array memo and
   the graphReady/GRAPH mix-up both live in the exact wording of the real
   thing - so the harness replaces only what market.js talks to: the chain, the
   browser's storage, and fetch. Everything else is the shipped file.

   Each load gets a fresh module instance, because market.js keeps a session in
   module scope (OW, GRAPH, HUBS, LIST, DEC) and a test that inherited the
   previous one would be testing the wrong thing. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { makeChain, FACTORIES, TOKENLIST } from './fixture.mjs';

const SRC = path.resolve(process.argv[2] || 'assets/js');
let seq = 0;

const STUB_CHAIN = `
// stand-in for chain.js: the same exports, backed by the fixture
const C = () => globalThis.__CHAIN;
export const LCD = 'https://lcd.test';
export const THIN_LUNC = 500000;
export const EXTRA_PAIRS = [];
export const FACTORIES = globalThis.__FACTORIES;
export const amt = (raw, dec) => Number(raw || 0) / Math.pow(10, dec);
// diagnostics are off in the build and off here; a test that needs them can
// swap this for console.info
export const DEBUG = false;
export const dbg = () => {};
export const smart = (addr, msg, tries) => C().smart(addr, msg, tries);
export const getJSON = (url, ms, tries) => C().getJSON(url, ms, tries);
`;

function memoryStorage(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    get size(){ return m.size; },
    dump: () => Object.fromEntries(m)
  };
}

/* opts.storage lets a test hand in a store carried over from a previous load,
   which is how "what happens on the second open" gets tested at all. */
export async function loadMarket(opts = {}){
  const chain = opts.chain || makeChain();
  const store = opts.storage || memoryStorage();

  globalThis.__CHAIN = chain;
  globalThis.__FACTORIES = opts.factories || FACTORIES;
  globalThis.localStorage = store;
  globalThis.fetch = async (url) => {
    if (String(url).indexOf('cl8y-tokens.json') >= 0) {
      if (opts.noTokenList) throw new Error('404');
      return { json: async () => (opts.tokenList || TOKENLIST) };
    }
    throw new Error('unexpected fetch ' + url);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-test-'));
  fs.writeFileSync(path.join(dir, 'chain.js'), STUB_CHAIN);
  const src = fs.readFileSync(path.join(SRC, 'market.js'), 'utf8')
    // the build stamps a version onto every import; node resolves paths, not urls
    .replace(/'\.\/([a-z]+)\.js\?v=[0-9a-f]+'/g, "'./$1.js'");
  fs.writeFileSync(path.join(dir, 'market.js'), src);

  seq += 1;
  const mod = await import(pathToFileURL(path.join(dir, 'market.js')).href + '?n=' + seq);
  return { mod, chain, store, dir };
}

// ------------------------------------------------------------------ asserting
let pass = 0, fail = 0;
const failures = [];

export function ok(name, cond, detail){
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else {
    fail += 1; failures.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : ''));
  }
}

export function near(name, got, want, tol){
  const good = Number.isFinite(got) && Math.abs(got - want) <= Math.abs(want) * (tol || 0.02);
  ok(name, good, 'got ' + got + ', wanted about ' + want);
}

export function group(name){ console.log('\n' + name); }

export function report(){
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('failing: ' + failures.join('; '));
  process.exit(fail ? 1 : 0);
}
