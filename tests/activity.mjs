/* What a transaction is called, and which face it wears.

   The old reading walked every wasm event and kept the last `action` a contract
   logged about itself - so a swap through a router came back named after
   whatever the final contract in the chain happened to call its own bookkeeping.
   "receive cw20 fee" was a true statement about somebody's internals and a
   description of nothing the owner did.

   activity.js touches the DOM when it loads, so the functions are lifted from
   the shipped file the same way swap.js's are. */
import fs from 'fs';
import path from 'path';
import { ok, group } from './harness.mjs';

const SRC = path.resolve(process.argv[2] || 'assets/js');
const src = fs.readFileSync(path.join(SRC, 'activity.js'), 'utf8');

function lift(s, header){
  const i = s.indexOf(header);
  if (i < 0) throw new Error('not found in activity.js: ' + header);
  let d = 0;
  for (let k = s.indexOf('{', i); k < s.length; k++) {
    if (s[k] === '{') d += 1;
    else if (s[k] === '}') { d -= 1; if (!d) return s.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}
function liftLine(s, header){
  const i = s.indexOf(header);
  return s.slice(i, s.indexOf(';\n', i) + 1);
}

// a small market: two tokens the wallet knows, and one it does not
const KNOWN = {
  'cw20:terra1cl8y': { sym: 'CL8Y', dec: 18 },
  'native:uusd': { sym: 'USTC', dec: 6 }
};

const api = new Function('atob', 'short', 'coins', 'fmt', 'amt', 'knownAsset', 'DEC', [
  liftLine(src, 'const keyFor ='),
  lift(src, 'function wasmCalls('),
  liftLine(src, 'const FACE ='),
  liftLine(src, 'const sentence ='),
  lift(src, 'function nameOf('),
  lift(src, 'function swapMoves('),
  liftLine(src, 'const VERB ='),
  lift(src, 'function hookOf('),
  lift(src, 'function intentOf('),
  liftLine(src, 'const ICON ='),
  lift(src, 'function describe('),
  'return { describe, ICON, swapMoves, nameOf, wasmCalls };'
].join('\n'))(
  s => Buffer.from(s, 'base64').toString(),
  x => String(x).slice(0, 6) + '\u2026',
  c => (c && c[0] ? c[0].amount + ' ' + c[0].denom : ''),
  v => String(Math.round(v * 1e6) / 1e6),
  (raw, dec) => Number(raw) / Math.pow(10, dec),
  k => KNOWN[k] || null,
  {}
);

const exec = (msg, logs) => ({
  tx: { body: { messages: [
    { '@type': '/cosmwasm.wasm.v1.MsgExecuteContract', contract: 'terra1pool', msg }
  ] } },
  logs: logs || []
});
const native = (from, to) => ({
  tx: { body: { messages: [
    { '@type': '/cosmos.bank.v1beta1.MsgSend', from_address: from, to_address: to, amount: [] }
  ] } }
});

group('a transaction is named by what was asked for');
{
  // the exact case that produced "receive cw20 fee" on screen
  const hook = Buffer.from(JSON.stringify({ swap: { max_spread: '0.01' } })).toString('base64');
  const t = exec({ send: { contract: 'terra1p', amount: '100', msg: hook } },
                 [{ events: [{ type: 'wasm',
                    attributes: [{ key: 'action', value: 'receive cw20 fee' }] }] }]);
  const d = api.describe(t, 'me');
  ok('a cw20 send whose hook is a swap is a swap', d.title === 'Swapped', d.title);
  ok('and it wears the swap face', d.kind === 'swap', d.kind);
  ok("what a downstream contract logged about itself does not name it",
     d.title.indexOf('receive') < 0 && d.title.indexOf('fee') < 0, d.title);

  ok('a transfer reads as sent',
     api.describe(exec({ transfer: { recipient: 'terra1x', amount: '5' } }), 'me').title === 'Sent');
  ok('liquidity has words of its own',
     api.describe(exec({ provide_liquidity: {} }), 'me').title === 'Added liquidity');

  const odd = api.describe(exec({ record_entry: {} }), 'me');
  // shown as it came, but as a sentence: a lower case fragment reads as a leak
  ok('an action nobody has a word for is shown as it came',
     odd.title === 'Record entry', odd.title);
  ok('and is not dressed up as something known', odd.kind === 'code', odd.kind);
}

group('the badge carries the meaning');
{
  const seen = {
    out:   api.describe(native('me', 'terra1x'), 'me').kind,
    in:    api.describe(native('terra1x', 'me'), 'me').kind,
    swap:  api.describe(exec({ swap: {} }), 'me').kind,
    stake: api.describe({ tx: { body: { messages: [
             { '@type': '/cosmos.staking.v1beta1.MsgDelegate', amount: {} }] } } }, 'me').kind,
    gift:  api.describe({ tx: { body: { messages: [
             { '@type': '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward' }] } } }, 'me').kind
  };
  for (const want in seen) {
    ok('a ' + want + ' is marked as one', seen[want] === want, seen[want]);
  }
  // a face with no glyph falls back to a shared one, and every act looks alike
  const missing = Object.keys(seen).concat(['code']).filter(k => !api.ICON[k]);
  ok('every face has a glyph of its own', missing.length === 0, missing.join(','));

  const glyphs = Object.keys(api.ICON).map(k => api.ICON[k]);
  ok('and no two acts share a drawing',
     new Set(glyphs).size === glyphs.length);
}

group('several messages are counted, not hidden');
{
  const many = native('me', 'terra1x');
  many.tx.body.messages.push({ '@type': '/cosmos.bank.v1beta1.MsgSend' });
  ok('a transaction with more than one message says so',
     api.describe(many, 'me').title === 'Sent +1', api.describe(many, 'me').title);
}

group('a swap says what it moved');
{
  // the amounts are in the events the pools emit; a row that omits them is
  // half a sentence, and it was half of every swap on the screen
  const wasm = (attrs) => ({ type: 'wasm', attributes:
    Object.keys(attrs).map(k => ({ key: k, value: String(attrs[k]) })) });

  const one = { logs: [{ events: [wasm({
    action: 'swap', offer_asset: 'terra1cl8y', offer_amount: '8233232000000000000',
    ask_asset: 'uusd', return_amount: '806730000' })] }] };
  const m = api.swapMoves(one);
  ok('the amount received is read', m && m.got === '806.73 USTC', m && m.got);
  ok('and the amount paid', m && m.gave === '8.233232 CL8Y', m && m.gave);
  ok('the pair replaces a contract address', m && m.pair === 'CL8Y \u2192 USTC', m && m.pair);
  ok('each side at its own decimals', m && m.gave.indexOf('8233232') < 0);

  // two pools in one transaction: the first offer and the last return are the
  // two ends of what the owner did, and the middle token is not either of them
  const two = { logs: [{ events: [
    wasm({ action: 'swap', offer_asset: 'terra1cl8y', offer_amount: '1000000000000000000',
           ask_asset: 'terra1mid', return_amount: '500' }),
    wasm({ action: 'swap', offer_asset: 'terra1mid', offer_amount: '500',
           ask_asset: 'uusd', return_amount: '990000' })
  ] }] };
  const h = api.swapMoves(two);
  ok('a two pool trade reports its ends, not its middle',
     h.gave.indexOf('CL8Y') >= 0 && h.got.indexOf('USTC') >= 0, h.gave + ' -> ' + h.got);
  ok('and the middle token appears in neither',
     h.pair.indexOf('terra1mid') < 0, h.pair);

  ok('a transaction with no swap events reports nothing',
     api.swapMoves({ logs: [] }) === null);

  // and the row has to actually use it, which is the whole point
  const row = api.describe({
    tx: { body: { messages: [{ '@type': '/cosmwasm.wasm.v1.MsgExecuteContract',
                               contract: 'terra1pool', msg: { swap: {} } }] } },
    logs: [{ events: [wasm({
      action: 'swap', offer_asset: 'terra1cl8y', offer_amount: '8233232000000000000',
      ask_asset: 'uusd', return_amount: '806730000' })] }]
  }, 'me');
  ok('the row carries the amount received', row.value === '+806.73 USTC', row.value);
  ok('and the pair instead of the contract', row.sub === 'CL8Y \u2192 USTC', row.sub);
  ok('and is coloured as a gain', row.gain === true);

  // an asset nobody has heard of still gets a readable name
  const un = api.nameOf('uwhat');
  ok('an unknown denom is named from itself', un.sym === 'WHAT', un.sym);
  ok('and assumed to be six decimals until told otherwise', un.dec === 6);
}

group('one wasm event, several contracts');
{
  /* The chain concatenates every contract's attributes into one event, in the
     order they ran, separated only by a fresh _contract_address. Reading that
     as a single object gives the first action in the chain - which for a swap
     paid in a CW20 is the token's own send, never the pool's swap. */
  const chained = { logs: [{ events: [{ type: 'wasm', attributes: [
    { key: '_contract_address', value: 'terra1cl8y' },
    { key: 'action', value: 'send' },
    { key: 'from', value: 'me' },
    { key: '_contract_address', value: 'terra1pool' },
    { key: 'action', value: 'swap' },
    { key: 'offer_asset', value: 'terra1cl8y' },
    { key: 'offer_amount', value: '8233232000000000000' },
    { key: 'ask_asset', value: 'uusd' },
    { key: 'return_amount', value: '806730000' }
  ] }] }] };

  const calls = api.wasmCalls(chained);
  ok('each contract is read separately', calls.length === 2, String(calls.length));
  ok("the token's own action does not stand for the pool's",
     calls[0].action === 'send' && calls[1].action === 'swap');

  const m = api.swapMoves(chained);
  ok('so the swap behind a cw20 send is found at last', !!m);
  ok('with the amount that came back', m && m.got === '806.73 USTC', m && m.got);
  ok('and the pair', m && m.pair === 'CL8Y \u2192 USTC', m && m.pair);
}

group('a contract call wears the face of what it did');
{
  const exec2 = (msg) => ({ tx: { body: { messages: [
    { '@type': '/cosmwasm.wasm.v1.MsgExecuteContract', contract: 'terra1cl8y', msg } ] } } });

  ok('staking is not filed under "some code ran"',
     api.describe(exec2({ stake: {} }), 'me').kind === 'stake');
  ok('nor is unstaking', api.describe(exec2({ unbond: {} }), 'me').kind === 'stake');
  ok('a reward wears the reward face',
     api.describe(exec2({ claim_rewards: {} }), 'me').kind === 'gift');
  ok('and is named in words', api.describe(exec2({ claim_rewards: {} }), 'me').title
     === 'Claimed rewards');
  ok('something with no name still starts with a capital',
     api.describe(exec2({ record_entry: {} }), 'me').title === 'Record entry',
     api.describe(exec2({ record_entry: {} }), 'me').title);
  ok('and still admits it is only code',
     api.describe(exec2({ record_entry: {} }), 'me').kind === 'code');

  // the amount a cw20 carries out of the wallet lives in the message
  const staked = api.describe(exec2({ send: { contract: 'terra1farm',
                                              amount: '1500000000000000000' } }), 'me');
  ok('a cw20 leaving the wallet reports how much',
     staked.value === '-1.5 CL8Y', staked.value);
}
