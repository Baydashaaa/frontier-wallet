/* Sending something other than LUNC.

   A coin pays its own fee out of the balance being sent. A token does not: the
   fee comes out of LUNC while the token balance is untouched, which means a
   transfer can fail for want of a coin nobody was looking at. The two paths
   differ in exactly that, and the difference is what these check.

   tx.js wires listeners when it loads, so the pieces are lifted from the file
   the same way swap.js's are. */
import fs from 'fs';
import path from 'path';
import { ok, group } from './harness.mjs';

const SRC = path.resolve(process.argv[2] || 'assets/js');
const src = fs.readFileSync(path.join(SRC, 'tx.js'), 'utf8');

function lift(s, header){
  const i = s.indexOf(header);
  if (i < 0) throw new Error('not found in tx.js: ' + header);
  let d = 0;
  for (let k = s.indexOf('{', i); k < s.length; k++) {
    if (s[k] === '{') d += 1;
    else if (s[k] === '}') { d -= 1; if (!d) return s.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}
const liftLine = (s, h) => { const i = s.indexOf(h); return s.slice(i, s.indexOf(';\n', i) + 1); };

const HELD = [
  { sym: 'LUNC', denom: 'uluna', dec: 6, v: 1000 },
  { sym: 'USTC', denom: 'uusd', dec: 6, v: 25 },
  { sym: 'CL8Y', contract: 'terra1cl8y', dec: 18, v: 8.25 },
  { sym: 'DUST', contract: 'terra1dust', dec: 6, v: 0 }
];

const api = new Function('heldTokens', 'toRaw', [
  liftLine(src, 'const isCw20 ='),
  liftLine(src, 'const sendKey ='),
  lift(src, 'function sendable('),
  lift(src, 'function balanceOf('),
  lift(src, 'function cw20Step('),
  'return { isCw20, sendKey, sendable, balanceOf, cw20Step };'
].join('\n'))(() => HELD, (h, d) => String(Math.round(Number(h) * Math.pow(10, d))));

group('what can be sent');
{
  const rows = api.sendable().map(r => r.sym);
  ok('the fee coin comes first, because it is what pays', rows[0] === 'LUNC', rows.join(','));
  ok('tokens with a balance are offered', rows.indexOf('CL8Y') > 0, rows.join(','));
  ok('and an empty balance is not', rows.indexOf('DUST') < 0, rows.join(','));
  ok('a coin and a token are told apart',
     !api.isCw20(HELD[0]) && api.isCw20(HELD[2]));
  ok('each is keyed the way the rest of the wallet keys assets',
     api.sendKey(HELD[0]) === 'native:uluna' && api.sendKey(HELD[2]) === 'cw20:terra1cl8y');
}

group('the message a token transfer is');
{
  const step = api.cw20Step(HELD[2], 'terra1friend', '1.5');
  ok('it is addressed to the token, not to the recipient',
     step.contract === 'terra1cl8y', step.contract);
  ok('the recipient is named inside it',
     step.msg.transfer.recipient === 'terra1friend');
  ok('and the amount is at the token\u2019s own decimals',
     step.msg.transfer.amount === '1500000000000000000', step.msg.transfer.amount);
  ok('no coins ride along with it',
     Array.isArray(step.funds) && step.funds.length === 0);

  // eighteen decimals read as six is the bug that made CL8Y unsellable
  const six = api.cw20Step({ contract: 'terra1x', dec: 6 }, 'terra1friend', '1.5');
  ok('a six decimal token is not scaled like an eighteen decimal one',
     six.msg.transfer.amount === '1500000');
}

group('balances are read per asset');
{
  ok('a coin balance is its own', api.balanceOf(HELD[0]) === 1000);
  ok('a token balance is its own', api.balanceOf(HELD[2]) === 8.25);
  ok('something the wallet does not hold is zero',
     api.balanceOf({ contract: 'terra1nope' }) === 0);
}
