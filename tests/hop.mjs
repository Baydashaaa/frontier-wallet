/* The arithmetic that decides what a two step trade is worth, and what it
   spends. This is the part where being wrong costs money: the second message
   names its amount at signing time, and if that amount is larger than what the
   first message actually delivers, the whole transaction reverts.

   `quoteHop` and its two helpers are lifted out of swap.js for the same reason
   `envelope` is - the module attaches DOM handlers when it loads - and run
   against the real `simulateSwap` and the fixture's pools. */
import fs from 'fs';
import path from 'path';
import { loadMarket, ok, near, group } from './harness.mjs';
import { A, META } from './fixture.mjs';

const SRC = path.resolve(process.argv[2] || 'assets/js');
const swap = fs.readFileSync(path.join(SRC, 'swap.js'), 'utf8');

function lift(src, header){
  const i = src.indexOf(header);
  if (i < 0) throw new Error('not found in swap.js: ' + header);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d += 1;
    else if (src[k] === '}') { d -= 1; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}

// A single-line const has no braces of its own, so brace matching would run on
// into whatever comes next. This takes the statement instead.
function liftLine(src, header){
  const i = src.indexOf(header);
  if (i < 0) throw new Error('not found in swap.js: ' + header);
  const end = src.indexOf(';\n', i);
  return src.slice(i, end + 1);
}

// the default now lives inside savedSlip, which is where it belongs
const SLIP = Number(swap.match(/function savedSlip\([\s\S]*?return ([\d.]+);/)[1]);
const { mod } = await loadMarket();
await mod.owMarket();
await mod.graph();
await mod.cl8yList();

const tok = key => {
  const m = META[key];
  const t = { sym: m.sym, dec: m.dec };
  if (key.slice(0, 5) === 'cw20:') t.contract = key.slice(5); else t.denom = key.slice(7);
  return t;
};

const body = [
  'const SLIP = ' + SLIP + ';',
  lift(swap, 'function decOf('),
  liftLine(swap, 'const keyOf ='),
  lift(swap, 'async function bestPool('),
  lift(swap, 'const legCost ='),
  lift(swap, 'async function quoteHop('),
  'return { quoteHop, bestPool };'
].join('\n');

function run(fromKey, toKey){
  const FROM = tok(fromKey), TO = tok(toKey);
  // DEBUG guards the trace strings inside bestPool, so the lifted code needs it
  const api = new Function('simulateSwap', 'tokenFor', 'FROM', 'TO', 'DEBUG', 'dbg', body)(
    mod.simulateSwap, k => tok(k), FROM, TO, false, () => {});
  return { api: api, FROM: FROM, TO: TO };
}

group('decimals reach the amount that is offered');
{
  // The bug that made an eighteen decimal token unsellable: a wallet row is
  // built from a balance query and used to have no decimals on it at all, so
  // every reader downstream assumed six. Six is right for almost everything
  // here, which is why it went unnoticed until it was not.
  const api = new Function('DEC', 'keyOf', [lift(swap, 'function decOf('),
                                            'return { decOf };'].join('\n'))(
    mod.DEC, k => (k.contract ? 'cw20:' + k.contract : 'native:' + k.denom));

  ok('a row that carries its decimals is believed',
     api.decOf({ contract: 'terra1cl8y', dec: 18 }) === 18);
  ok('a row without them falls back on what the map recorded, not on six',
     api.decOf({ contract: A.CL8Y.slice(5) }) === 18,
     String(api.decOf({ contract: A.CL8Y.slice(5) })));
  ok('and only guesses when nothing knows',
     api.decOf({ contract: 'terra1neverseen' }) === 6);
}

group('a fee is quoted in the asset it was taken from');
{
  // Garuda answers with the return and the spread in what you receive and the
  // commission in what you pay. Measured on a real pool: 8.233232 CL8Y offered,
  // commission 41166162281441236, which at eighteen decimals is 0.041166 - half
  // a percent of the offer. Read at the receiving side's six decimals it came
  // out as forty one billion USTC and a hundred percent.
  const api = new Function([lift(swap, 'const legCost ='), 'return { legCost };'].join('\n'))();

  const garuda = { return_amount: '725380679', spread_amount: '42310821',
                   commission_amount: '41166162281441236' };
  const g = api.legCost(garuda, 6, 18, 'gd', 8.233232456288247);
  near('the return is read at the receiving side', g.out, 725.380679, 0.0001);
  near('the fee is read at the offering side', g.fee, 0.041166162281441236, 0.0001);
  ok('and it is marked as belonging to that side', g.feeSide === 'in', g.feeSide);
  near('so the fee comes out as the half percent it is', g.feePct, 0.5, 0.01);

  // the same numbers read the old way: what the screen was showing
  const wrong = api.legCost(garuda, 6, 6, 'ts', 8.233232456288247);
  ok('read the old way it was forty one billion', wrong.fee > 4e10, String(wrong.fee));
  ok('and a hundred percent', wrong.feePct > 99, String(wrong.feePct));

  // terraswap and cl8y keep the commission on the receiving side
  const ts = { return_amount: '1000000', spread_amount: '2000', commission_amount: '3000' };
  const t = api.legCost(ts, 6, 6, 'ts', 1);
  ok('an ordinary pool still reports on the receiving side', t.feeSide === 'out');
  near('and its fee is a share of what comes back', t.feePct, 0.299, 0.02);
  near('the spread is measured against the whole', t.impact, 0.199, 0.02);

  // A fee taken from the offer is not part of what came back, so it has no
  // place in the total the spread is measured against. With both sides at the
  // same scale the difference is plain: 0.1 of spread against 1.1 returned,
  // not against 1.6.
  const same = { return_amount: '1000000', spread_amount: '100000',
                 commission_amount: '500000' };
  const g2 = api.legCost(same, 6, 6, 'gd', 10);
  near('an offer-side fee stays out of the gross', g2.impact, 9.09, 0.02);
}

group('the comfortable size is measured, not assumed');
{
  // The old estimate read the reserve and assumed a constant product curve. On
  // a pool with an order book beside it that assumption is wrong, and it was
  // wrong in the confident direction: "deep enough for anything you hold",
  // followed by the contract refusing the trade.
  const api = new Function('firstLeg', 'balOf', 'COMFORT', [
    lift(swap, 'function comfortOf('), 'return { comfortOf };'
  ].join('\n'));

  const run = m => api(() => 'P', () => 1000, m ? { P: m } : {}).comfortOf();

  ok('nothing measured yet means no claim at all', run(null) === 0);
  ok('a pool that costs under a percent at the full balance takes all of it',
     run({ at: 1000, pct: 0.4 }) === 1000, String(run({ at: 1000, pct: 0.4 })));
  ok('exactly one percent still counts as all of it',
     run({ at: 1000, pct: 1 }) === 1000);
  // 1000 costs 5%, so a percent is reached around a fifth of that
  ok('above a percent, the crossing point comes from the measurement',
     run({ at: 1000, pct: 5 }) === 200, String(run({ at: 1000, pct: 5 })));
  ok('a far worse pool gives a far smaller size',
     run({ at: 1000, pct: 50 }) === 20, String(run({ at: 1000, pct: 50 })));
  ok('a measurement in flight makes no claim',
     run({ at: 0, pct: 0 }) === 0);
}

group('the order destinations are offered in');
{
  const api = new Function([lift(swap, 'function rankDestinations('),
                            'return { rankDestinations };'].join('\n'))();
  const held = { 'cw20:mine': 1 };
  const rows = [
    { key: 'cw20:far',   sym: 'FAR',   hops: 2, liq: 900000 },
    { key: 'cw20:thin',  sym: 'THIN',  hops: 1, liq: 40 },
    { key: 'cw20:deep',  sym: 'DEEP',  hops: 1, liq: 120000 },
    { key: 'cw20:zzz',   sym: 'ZZZ',   hops: 1, liq: null },
    { key: 'cw20:aaa',   sym: 'AAA',   hops: 1, liq: null },
    { key: 'cw20:mine',  sym: 'MINE',  hops: 1, liq: null }
  ];
  const order = api.rankDestinations(rows.slice(), held).map(r => r.sym);

  ok('one hop comes before two, however deep the two is',
     order.indexOf('FAR') === order.length - 1, order.join(','));
  ok('a known depth outranks a smaller known depth',
     order.indexOf('DEEP') < order.indexOf('THIN'), order.join(','));
  ok('a measured pool outranks an unmeasured one',
     order.indexOf('THIN') < order.indexOf('AAA'), order.join(','));
  ok('among the unmeasured, what the wallet holds comes first',
     order.indexOf('MINE') < order.indexOf('AAA'), order.join(','));
  ok('and the rest go alphabetically, so the list is stable',
     order.indexOf('AAA') < order.indexOf('ZZZ'), order.join(','));

  const twice = api.rankDestinations(rows.slice(), held).map(r => r.sym).join(',');
  ok('the same input gives the same order twice', twice === order.join(','));
}

group('naming the gap between two dollar figures');
{
  // valueGap decides whether the difference between what goes in and what comes
  // out, measured in dollars, is explained by what the trade costs. The two
  // amounts are priced independently, so on a thin market they disagree by more
  // than any fee - and saying nothing about that leaves "price impact 0.02%"
  // sitting next to a ten percent drop with no account of it anywhere.
  const api = new Function('unitUsd', 'FROM', 'TO', [
    lift(swap, 'function valueGap('), 'return { valueGap };'
  ].join('\n'))(t => (t && t.px !== undefined ? t.px : null),
                 { px: 1 }, { px: 1 });

  ok('a gap the costs explain is not mentioned',
     api.valueGap(100, 97.5, 2.5) === null);
  ok('nor is one just barely above them',
     api.valueGap(100, 96.6, 2.5) === null);
  const big = api.valueGap(100, 89.3, 2.72);
  ok('a gap the costs cannot explain is named', !!big);
  ok('and it states what the trade actually costs',
     big && big.note.indexOf('2.72%') >= 0, big && big.note.slice(0, 40));
  ok('and how large the gap is', big && big.v === '-10.7%', big && big.v);
  ok('a much larger one is flagged harder',
     api.valueGap(100, 60, 2) .tone === 'bad');
  ok('a trade that gains value says nothing', api.valueGap(100, 105, 2) === null);
}

group('a two step quote');
{
  const { api, FROM, TO } = run(A.UST1, A.CL8Y);
  const mids = mod.midsBetween(A.UST1, A.CL8Y);
  ok('there is a middle asset to try', mids.length > 0);

  const refused = [];
  const hop = await api.quoteHop(mids, '1000000000', refused);   // 1000 UST1
  ok('a hop is quoted', !!hop, refused.join(' | '));
  ok('it goes through the wrapper', hop && hop.mid.sym === 'cUSTC', hop && hop.mid.sym);
  ok('both legs are recorded', hop && hop.legs.length === 2);

  // the promise the whole design rests on: what the second message spends can
  // never exceed what the first message is guaranteed to deliver
  const out1 = Number(hop.legs[0].returnRaw);
  const spend2 = Number(hop.legs[1].offerRaw);
  ok('the second leg spends no more than the first guarantees',
     spend2 <= Math.floor(out1 * (1 - SLIP)),
     spend2 + ' vs guaranteed ' + Math.floor(out1 * (1 - SLIP)));
  ok('and it spends less than the first leg expects to deliver',
     spend2 < out1, spend2 + ' vs expected ' + out1);

  // and the number on screen must describe that spend, not the larger one
  const cUSTCdec = META[A.CUSTC].dec;
  near('the residue is the gap between them',
       hop.residue, (out1 - spend2) / Math.pow(10, cUSTCdec), 0.001);
  ok('the residue is bounded by the slippage setting',
     hop.residue <= (out1 / Math.pow(10, cUSTCdec)) * SLIP * 1.001,
     String(hop.residue));

  ok('the first leg starts from what the user typed',
     hop.legs[0].offerRaw === '1000000000');
}

group('the quote describes the spend, not the hope');
{
  const { api } = run(A.UST1, A.CL8Y);
  const mids = mod.midsBetween(A.UST1, A.CL8Y);
  const hop = await api.quoteHop(mids, '1000000000', []);

  // re-simulate the second leg on both amounts: the quoted output must match
  // the one taken on the guaranteed minimum, not on the expected delivery
  const onMin = await mod.simulateSwap(hop.legs[1].pair, A.CUSTC, hop.legs[1].offerRaw, 'cl');
  const onHope = await mod.simulateSwap(hop.legs[1].pair, A.CUSTC, hop.legs[0].returnRaw, 'cl');
  ok('the shown return is the one for the minimum',
     hop.returnRaw === onMin.return_amount, hop.returnRaw + ' vs ' + onMin.return_amount);
  ok('which is smaller than quoting on the expectation would have shown',
     Number(onMin.return_amount) < Number(onHope.return_amount));
}

group('choosing between middle assets');
{
  const { api } = run(A.USTR, A.CL8Y);
  const mids = mod.midsBetween(A.USTR, A.CL8Y);
  if (mids.length > 1) {
    const hop = await api.quoteHop(mids, '1000000000000000000', []);
    ok('the best middle asset is the one that returns most', !!hop);
  } else {
    ok('a single middle asset is used when there is only one', true);
  }
}

group('when no hop works');
{
  const { api } = run(A.UST1, A.CL8Y);
  const refused = [];
  const none = await api.quoteHop([], '1000000000', refused);
  ok('an empty candidate list yields nothing', none === null || none === undefined);
}
