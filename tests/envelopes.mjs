/* The message that actually gets signed.

   This is the only layer where being wrong costs money rather than credibility,
   and all three shapes were worked out by reading real transactions off the
   chain - the pool contracts publish no schema. So the assertions below are
   written against those transactions, field for field, including the two that
   look alike and are not: Garuda takes a deadline in milliseconds and CL8Y
   takes one in seconds.

   swap.js attaches DOM handlers when it loads, so rather than bring in a DOM to
   import it, the function's own source is lifted out of the shipped file and
   run against stubs. It is still the deployed text - rename or rewrite it and
   this goes red. */
import fs from 'fs';
import path from 'path';
import { ok, group } from './harness.mjs';
import { loadMarket } from './harness.mjs';

const SRC = path.resolve(process.argv[2] || 'assets/js');
const swap = fs.readFileSync(path.join(SRC, 'swap.js'), 'utf8');

// brace-matching, because the function contains braces of its own
function lift(src, header){
  const i = src.indexOf(header);
  if (i < 0) throw new Error('not found in swap.js: ' + header);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
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

function constant(name){
  const m = swap.match(new RegExp('const ' + name + '\\s*=\\s*([^;\\n]+)'));
  if (!m) throw new Error('constant not found: ' + name);
  return m[1].trim();
}

const SLIP = Number(constant('SLIP'));
const { mod } = await loadMarket();

const src = [
  'const SLIP = ' + SLIP + ';',
  liftLine(swap, 'const keyOf ='),
  lift(swap, 'function envelope('),
  lift(swap, 'function steps()'),
  'return { envelope, keyOf, steps };'
].join('\n');

const make = new Function('gdInfo', 'btoa', 'FROM', 'QUOTE', src);

const LUNC = { sym: 'LUNC', denom: 'uluna' };
const TOK = { sym: 'UST1', contract: 'terra1ust1' };
const OFFER = '4580948';
const RETURN = '465400000';
const b64 = t => Buffer.from(t, 'binary').toString('base64');

function build(from, dialect){
  const quote = { pair: 'terra1pool', dialect: dialect,
                  offerRaw: OFFER, returnRaw: RETURN };
  const api = make(mod.gdInfo, b64, from, quote);
  const e = api.envelope();
  const out = JSON.parse(JSON.stringify(e));
  if (out.msg.send) out.msg.send.msg = JSON.parse(Buffer.from(out.msg.send.msg, 'base64').toString());
  return out;
}

const floor = Math.floor(Number(RETURN) * (1 - SLIP));

group('envelopes: how a CW20 is offered');
{
  for (const d of ['ts', 'gd', 'cl']) {
    const e = build(TOK, d);
    ok(d + ': the token contract sends itself to the pool',
       e.contract === TOK.contract && e.msg.send && e.msg.send.contract === 'terra1pool');
    ok(d + ': the whole offer travels in the send',
       e.msg.send.amount === OFFER, e.msg.send.amount);
    ok(d + ': no funds ride along with a CW20',
       Array.isArray(e.funds) && e.funds.length === 0);
    ok(d + ': the hook is a swap', !!e.msg.send.msg.swap);
  }
}

group('envelopes: how a native coin is offered');
{
  for (const d of ['ts', 'gd', 'cl']) {
    const e = build(LUNC, d);
    ok(d + ': the pool is called directly', e.contract === 'terra1pool' && !e.msg.send);
    ok(d + ': the coin rides as funds',
       e.funds.length === 1 && e.funds[0].denom === 'uluna' && e.funds[0].amount === OFFER,
       JSON.stringify(e.funds));
  }
}

group('envelopes: the guard against a bad fill');
{
  const ts = build(TOK, 'ts').msg.send.msg.swap;
  ok('terraswap is told the price to expect', typeof ts.belief_price === 'string');
  ok('and how far it may drift', ts.max_spread === String(SLIP), ts.max_spread);
  ok('terraswap needs no deadline', ts.deadline === undefined);

  const gd = build(TOK, 'gd').msg.send.msg.swap;
  ok('garuda is told the smallest acceptable return',
     gd.min_receive === String(floor), gd.min_receive + ' vs ' + floor);
  ok('which is below the quote, never above', Number(gd.min_receive) < Number(RETURN));
  ok('garuda is not given a belief price it does not accept', gd.belief_price === undefined);
  ok('garuda repeats the offer inside the hook',
     gd.offer_amount === OFFER && gd.offer_asset && gd.offer_asset.cw20 === TOK.contract,
     JSON.stringify(gd.offer_asset));

  const cl = build(TOK, 'cl').msg.send.msg.swap;
  ok('cl8y guards with a spread, like terraswap', cl.max_spread === String(SLIP));
  ok('and carries no belief price, which its trades never contain',
     cl.belief_price === undefined);
  ok('and no offer_asset in the hook either',
     cl.offer_asset === undefined && cl.offer_amount === undefined,
     JSON.stringify(cl));
}

group('envelopes: the two deadlines that look alike');
{
  const now = Date.now();
  const gd = build(TOK, 'gd').msg.send.msg.swap;
  const cl = build(TOK, 'cl').msg.send.msg.swap;

  // milliseconds: thirteen digits, and within a few minutes of now
  ok('garuda gets milliseconds',
     gd.deadline > now && gd.deadline < now + 10 * 60 * 1000,
     String(gd.deadline));
  // seconds: ten digits. Sending one for the other is a swap that either never
  // expires or expired decades ago.
  ok('cl8y gets seconds',
     cl.deadline > now / 1000 && cl.deadline < now / 1000 + 10 * 60,
     String(cl.deadline));
  ok('the two are not the same number', gd.deadline !== cl.deadline);
  ok('and they differ by about a thousand',
     Math.round(gd.deadline / cl.deadline) === 1000,
     String(gd.deadline / cl.deadline));
}

group('two steps, one transaction');
{
  const MID = { sym: 'cUSTC', contract: 'terra1custc' };
  // what quoteHop builds: the second leg is offered by the middle token and
  // spends the first leg's guaranteed minimum, never its expectation
  const min1 = String(Math.floor(Number(RETURN) * (1 - SLIP)));
  const quote = {
    hops: 2, mid: MID,
    legs: [
      { pair: 'terra1poolA', dialect: 'cl', offerRaw: OFFER, returnRaw: RETURN },
      { pair: 'terra1poolB', dialect: 'gd', offerRaw: min1, returnRaw: '900' }
    ]
  };
  const api = make(mod.gdInfo, b64, TOK, quote);
  const st = api.steps();

  ok('a hop is two messages', st.length === 2, String(st.length));
  ok('the first is offered by the token on screen', st[0].contract === TOK.contract);
  ok('the second is offered by the middle token', st[1].contract === MID.contract);
  ok('the first spends what the user typed',
     st[0].msg.send.amount === OFFER, st[0].msg.send.amount);
  ok('the second spends the first leg\'s guaranteed minimum, not its quote',
     st[1].msg.send.amount === min1 && st[1].msg.send.amount !== RETURN,
     st[1].msg.send.amount + ' vs quoted ' + RETURN);
  ok('each message goes to its own pool',
     st[0].msg.send.contract === 'terra1poolA' && st[1].msg.send.contract === 'terra1poolB');

  const h1 = JSON.parse(Buffer.from(st[0].msg.send.msg, 'base64').toString()).swap;
  const h2 = JSON.parse(Buffer.from(st[1].msg.send.msg, 'base64').toString()).swap;
  ok('each leg speaks its own pool\'s dialect',
     h1.deadline < 1e11 && h2.deadline > 1e12,
     'cl ' + h1.deadline + ', gd ' + h2.deadline);
  ok('the second leg names the middle token as what it offers',
     h2.offer_asset && h2.offer_asset.cw20 === MID.contract,
     JSON.stringify(h2.offer_asset));

  const one = make(mod.gdInfo, b64, TOK,
    { hops: 1, legs: [{ pair: 'terra1pool', dialect: 'ts', offerRaw: OFFER, returnRaw: RETURN }] });
  ok('a direct trade is still one message', one.steps().length === 1);
}

group('envelopes: against the transactions these were read from');
{
  // {"swap":{"max_spread":"0.05","deadline":1786652194}} - a real CL8Y trade
  const cl = build(TOK, 'cl').msg.send.msg.swap;
  ok('cl8y hook has exactly the two fields those trades carry',
     Object.keys(cl).sort().join(',') === 'deadline,max_spread',
     Object.keys(cl).sort().join(','));

  // {"swap":{"min_receive":"...","offer_amount":"...","offer_asset":{"cw20":"..."},"deadline":...}}
  const gd = build(TOK, 'gd').msg.send.msg.swap;
  ok('garuda hook has exactly the four',
     Object.keys(gd).sort().join(',') === 'deadline,min_receive,offer_amount,offer_asset',
     Object.keys(gd).sort().join(','));

  // the native side of a garuda trade names the asset flat, not wrapped in info
  const gdn = build(LUNC, 'gd').msg.swap;
  ok('garuda names a native side flat',
     gdn.offer_asset && gdn.offer_asset.native === 'uluna' && !gdn.offer_asset.info,
     JSON.stringify(gdn.offer_asset));

  // terraswap wraps it
  const tsn = build(LUNC, 'ts').msg.swap;
  ok('terraswap wraps a native side in info',
     tsn.offer_asset.info && tsn.offer_asset.info.native_token.denom === 'uluna' &&
     tsn.offer_asset.amount === OFFER,
     JSON.stringify(tsn.offer_asset));
}
