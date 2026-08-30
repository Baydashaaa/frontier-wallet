/* A small chain, built to contain the shapes that actually caused trouble.

   Two exchanges. One is published by the market feed, the other is only
   discoverable by walking its factory - which is the whole reason the CL8Y
   cluster kept falling out of everything. USTR sits where it really sits: one
   deep pool against UST1, and one near-empty pool against USTC that is its only
   direct way toward a base. Pricing it correctly means going USTR, UST1, cUSTC
   and crossing from there. */

export const A = {
  LUNC:  'native:uluna',
  USTC:  'native:uusd',
  CUSTC: 'cw20:terra1custc',
  UST1:  'cw20:terra1ust1',
  USTR:  'cw20:terra1ustr',
  JURIS: 'cw20:terra1juris',
  CL8Y:  'cw20:terra1cl8y'
};

export const META = {
  [A.LUNC]:  { sym: 'LUNC',  dec: 6 },
  [A.USTC]:  { sym: 'USTC',  dec: 6 },
  [A.CUSTC]: { sym: 'cUSTC', dec: 6,  logo: 'https://x/CUSTC.png' },
  [A.UST1]:  { sym: 'UST1',  dec: 6,  logo: 'https://x/UST1.png' },
  // eighteen, and the feed thinks six - the disagreement that put USTR out by
  // twelve orders of magnitude
  [A.USTR]:  { sym: 'USTR',  dec: 18, logo: 'https://x/USTR.png' },
  [A.CL8Y]:  { sym: 'CL8Y',  dec: 18, logo: 'https://x/CL8Y.png' },
  [A.JURIS]: { sym: 'JURIS', dec: 6 }
};

const u = (n, dec) => String(BigInt(Math.round(n * 1e6)) * 10n ** BigInt(dec - 6));

/* pool: which two assets, how much of each (in whole units), and which dialect
   the contract speaks. `feed` marks the ones the market feed publishes. */
export const POOLS = {
  // 940M LUNC against 5M USTC: the crossing every route leans on
  P_USTC_LUNC: { a: A.USTC, ra: u(5e6, 6), b: A.LUNC, rb: u(9.4e8, 6),
                 dex: 'ts', feed: 120000 },
  P_JURIS_LUNC: { a: A.JURIS, ra: u(4e8, 6), b: A.LUNC, rb: u(3.2e8, 6),
                  dex: 'ts', feed: 17000 },

  // the trap: about 34 cents of depth, and USTR's only direct step toward a base
  P_USTR_USTC: { a: A.USTR, ra: u(3600, 18), b: A.USTC, rb: u(34, 6),
                 dex: 'ts', feed: 34 },

  // the real market for USTR, on the exchange the feed does not publish
  P_UST1_USTR: { a: A.UST1, ra: u(24968, 6), b: A.USTR, rb: u(2.536e6, 18),
                 dex: 'cl' },
  P_UST1_CUSTC: { a: A.UST1, ra: u(25265, 6), b: A.CUSTC, rb: u(4.638e6, 6),
                  dex: 'cl' },
  // cUSTC reaches USTC in two hops, through CL8Y. A wrapper is worth its
  // wrapped thing, so the two legs multiply out to one: 1 cUSTC = 2 CL8Y and
  // 1 CL8Y = 0.5 USTC.
  P_CUSTC_CL8Y: { a: A.CUSTC, ra: u(2.9e6, 6), b: A.CL8Y, rb: u(5.8e6, 18),
                  dex: 'cl' },
  P_CL8Y_USTC: { a: A.CL8Y, ra: u(48000, 18), b: A.USTC, rb: u(24000, 6),
                 dex: 'gd' }
};

/* Seven neighbours of USTR that lead nowhere, declared ahead of the one that
   does. Capping the candidate list before filtering it - which is what patch68
   did - loses UST1 behind these and leaves USTR unpriceable. */
export const DEAD = {};
for (let i = 0; i < 7; i++) {
  DEAD['P_USTR_DEAD' + i] = {
    a: A.USTR, ra: u(500, 18),
    b: 'cw20:terra1dead' + i, rb: u(500, 6), dex: 'cl'
  };
}

export const FACTORIES = [
  { a: 'FACT_FEED', k: 'ts', n: 'FeedSwap' },
  { a: 'FACT_CL8Y', k: 'ts', n: 'CL8Y' }
];

// which factory lists which pool
const OWNER = {
  P_USTC_LUNC: 'FACT_FEED', P_JURIS_LUNC: 'FACT_FEED', P_USTR_USTC: 'FACT_FEED',
  P_UST1_USTR: 'FACT_CL8Y', P_UST1_CUSTC: 'FACT_CL8Y',
  P_CUSTC_CL8Y: 'FACT_CL8Y', P_CL8Y_USTC: 'FACT_CL8Y'
};
for (const k in DEAD) { POOLS[k] = DEAD[k]; OWNER[k] = 'FACT_CL8Y'; }
// the dead ones list first, so a cap applied before the filter would eat them
// all and never reach UST1
const ORDER = Object.keys(DEAD).concat(Object.keys(POOLS).filter(k => !DEAD[k]));

export const TOKENLIST = {
  name: 'test list',
  tokens: [A.LUNC, A.USTC, A.CUSTC, A.UST1, A.USTR, A.CL8Y].map(k => {
    const m = META[k];
    const row = { symbol: m.sym, decimals: m.dec, type: k.slice(0, 5) === 'cw20:' ? 'cw20' : 'native' };
    if (k.slice(0, 5) === 'cw20:') row.address = k.slice(5); else row.denom = k.slice(7);
    if (m.logo) row.logoURI = m.logo;
    return row;
  })
};

for (let i = 0; i < 7; i++) META['cw20:terra1dead' + i] = { sym: 'DEAD' + i, dec: 6 };

const asInfo = key => key.slice(0, 5) === 'cw20:'
  ? { token: { contract_addr: key.slice(5) } }
  : { native_token: { denom: key.slice(7) } };
const asFlat = key => key.slice(0, 5) === 'cw20:'
  ? { cw20: key.slice(5) }
  : { native: key.slice(7) };

/* A real curve, not a fixed answer.

   The output has to move with the input, or a test cannot tell a quote taken on
   one amount from a quote taken on another - and the whole two step design
   turns on quoting the second leg on the minimum rather than on the
   expectation. Integer arithmetic throughout, because an eighteen decimal
   reserve does not survive a double. */
const FEE_BPS = { ts: 30, gd: 30, cl: 180 };

function offerOf(body){
  const a = body.offer_asset || {};
  const key = a.info ? (a.info.token ? 'cw20:' + a.info.token.contract_addr
                                     : 'native:' + a.info.native_token.denom)
            : a.cw20 ? 'cw20:' + a.cw20
            : a.native ? 'native:' + a.native : null;
  const amount = a.amount || body.offer_amount ||
                 (body.hybrid && body.hybrid.pool_input) || '0';
  return { key: key, amount: BigInt(amount) };
}

function constantProduct(pool, body){
  const o = offerOf(body);
  const forward = o.key === pool.a;
  const inR = BigInt(forward ? pool.ra : pool.rb);
  const outR = BigInt(forward ? pool.rb : pool.ra);
  const dx = o.amount;
  if (dx <= 0n || inR <= 0n) return { return_amount: '0', spread_amount: '0', commission_amount: '0' };

  const gross = (outR * dx) / (inR + dx);
  const ideal = (outR * dx) / inR;                 // what a spread-free pool gives
  const bps = BigInt(FEE_BPS[pool.dex] || 30);
  const commission = (gross * bps) / 10000n;
  return {
    return_amount: String(gross - commission),
    spread_amount: String(ideal - gross),
    commission_amount: String(commission)
  };
}

function fail(status, note){
  const e = new Error('fixture ' + note + ' -> ' + status);
  e.status = status;
  e.final = status >= 400 && status < 500 && status !== 429;
  return e;
}

/* Counts every call, so a test can assert that something was NOT asked for -
   which is how you check a cache actually caches. */
/* The feed's own idea of decimals, which for USTR is wrong: it says six where
   the issuer says eighteen. That disagreement is the reason the issuer's list
   has to win, so the fixture has to contain it. */
const FEED_DEC = { [A.USTR]: 6 };
const side = key => ({
  address: key.slice(key.indexOf(':') + 1),
  symbol: META[key].sym,
  decimals: FEED_DEC[key] === undefined ? META[key].dec : FEED_DEC[key],
  type: key.slice(0, 5) === 'cw20:' ? 'CW20' : 'NATIVE'
});

export function makeChain(){
  const calls = { smart: 0, getJSON: 0, byMsg: {} };

  function poolOf(addr){ return POOLS[addr] || null; }

  async function smart(addr, msg, tries){
    calls.smart += 1;
    const kind = Object.keys(msg)[0];
    calls.byMsg[kind] = (calls.byMsg[kind] || 0) + 1;

    // factory listing
    const fact = FACTORIES.filter(f => f.a === addr)[0];
    if (fact) {
      if (!msg.pairs) throw fail(500, 'factory ' + kind);
      const mine = ORDER.filter(p => OWNER[p] === addr);
      return { data: { pairs: mine.map(p => ({
        contract_addr: p,
        asset_infos: [asInfo(POOLS[p].a), asInfo(POOLS[p].b)]
      })) } };
    }

    const pool = poolOf(addr);
    if (!pool) {
      if (msg.token_info) {
        const key = Object.keys(META).filter(k => k.slice(5) === addr || k.slice(7) === addr)[0];
        if (!key) throw fail(400, 'unknown contract');
        return { data: { symbol: META[key].sym, decimals: META[key].dec } };
      }
      throw fail(500, 'unknown contract ' + kind);
    }

    if (msg.pool) {
      // garuda names its sides differently, and reserves() reads both shapes
      if (pool.dex === 'gd') {
        return { data: { asset1: asFlat(pool.a), reserve1: pool.ra,
                         asset2: asFlat(pool.b), reserve2: pool.rb } };
      }
      return { data: { assets: [{ info: asInfo(pool.a), amount: pool.ra },
                                { info: asInfo(pool.b), amount: pool.rb }] } };
    }

    // a pool answers only its own dialect, and refuses the others with a 500 -
    // exactly as the real ones do, which is what dialect probing depends on
    const want = { ts: 'simulation', gd: 'simulate_swap', cl: 'hybrid_simulation' }[pool.dex];
    if (kind !== want) throw fail(500, 'wrong dialect ' + kind + ' for ' + pool.dex);
    return { data: constantProduct(pool, msg[kind]) };
  }

  async function getJSON(url){
    calls.getJSON += 1;
    if (url.indexOf('orbitwire') >= 0) {
      return { ok: true, pairs: Object.keys(POOLS).filter(p => POOLS[p].feed).map(p => {
        const q = POOLS[p];
        return {
          pool: p, dex: 'FeedSwap', liquidity: q.feed,
          base:  side(q.a),
          quote: side(q.b)
        };
      }) };
    }
    throw fail(501, 'no such endpoint');
  }

  return { smart, getJSON, calls };
}
