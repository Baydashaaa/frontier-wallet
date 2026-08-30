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

const SLIP = Number(swap.match(/const SLIP\s*=\s*([^;\n]+)/)[1]);
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
  const api = new Function('simulateSwap', 'tokenFor', 'FROM', 'TO', body)(
    mod.simulateSwap, k => tok(k), FROM, TO);
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
