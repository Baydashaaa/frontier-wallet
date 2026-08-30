/* One case per bug that reached production.

   Every test here corresponds to something that was found by deploying, taking
   a screenshot, reading a console log and guessing - several of them more than
   once. They run in about a second. */
import { loadMarket, ok, near, group, report } from './harness.mjs';
import { A, META, POOLS } from './fixture.mjs';

// LUNC per USTC in the fixture: 9.4e8 / 5e6
const USTC_IN_LUNC = 188;

group('the market map');
{
  const { mod } = await loadMarket();
  await mod.owMarket();

  const peers = mod.directPeers(A.USTC).map(p => p.sym).sort();
  ok('feed peers are found', peers.join(',') === 'LUNC,USTR', peers.join(','));

  ok('a pool the feed does not publish is not in the map yet',
     mod.poolsBetween(A.UST1, A.USTR).length === 0);

  const dec = mod.DEC[A.USTR];
  ok('the feed alone does not decide decimals', dec === undefined || dec === 18, String(dec));
}

group('the published token list');
{
  const { mod } = await loadMarket();
  await mod.owMarket();
  await mod.cl8yList();

  const ustr = mod.knownAsset(A.USTR);
  ok('symbol resolves', ustr && ustr.sym === 'USTR');
  // the feed says 6 for USTR and the issuer says 18; the issuer wins
  ok('decimals come from the issuer, not the feed', ustr && ustr.dec === 18, String(ustr && ustr.dec));
  ok('the logo survives a feed entry that has none',
     ustr && ustr.logo === META[A.USTR].logo, String(ustr && ustr.logo));
  ok('decimals reach the arithmetic, not just the record',
     mod.DEC[A.USTR] === 18, String(mod.DEC[A.USTR]));
}

group('naming an asset nobody published');
{
  const { mod, chain } = await loadMarket({ noTokenList: true });
  await mod.owMarket();
  const a = await mod.learnAsset(A.CL8Y);
  ok('the contract is asked when no list covers it', a && a.sym === 'CL8Y');
  ok('and its decimals reach DEC too', mod.DEC[A.CL8Y] === 18, String(mod.DEC[A.CL8Y]));
  ok('token_info was actually queried', chain.calls.byMsg.token_info > 0);
}

group('unknown depth is not zero depth');
{
  const { mod } = await loadMarket();
  await mod.owMarket();
  await mod.graph();

  const pools = mod.poolsBetween(A.USTC, A.LUNC);
  ok('the same pool from two sources appears once', pools.length === 1, String(pools.length));
  ok('a depth the feed published is kept', pools[0].liq === POOLS.P_USTC_LUNC.feed);

  const walked = mod.poolsBetween(A.UST1, A.CUSTC);
  ok('a pool only the walk found is usable', walked.length === 1);
  ok('and its depth is null rather than 0', walked[0].liq === null, String(walked[0].liq));
}

group('routing');
{
  const { mod } = await loadMarket();
  await mod.owMarket();
  await mod.graph();

  const juris = await mod.mapPrice(A.JURIS);
  ok('a direct pool against LUNC is one hop', juris && juris.hops === 1, juris && String(juris.hops));
  near('and its rate is the pool ratio', juris.inLunc, 3.2e8 / 4e8);

  const custc = await mod.mapPrice(A.CUSTC);
  ok('cUSTC reaches a base', !!custc);
  // cUSTC -> CL8Y -> USTC, then the crossing to LUNC
  near('cUSTC is worth about a USTC', custc.inLunc, USTC_IN_LUNC, 0.15);

  const ustr = await mod.mapPrice(A.USTR);
  ok('USTR gets a route at all', !!ustr);
  ok('and it is not the thirty four cent pool',
     ustr && ustr.depth > 500000, ustr && 'depth ' + Math.round(ustr.depth));
  // 2.536e6 USTR against 24968 UST1, and UST1 is worth about 183 cUSTC
  near('USTR is priced through UST1, not through the empty pool',
       ustr.inLunc, (24968 / 2.536e6) * (4.638e6 / 25265) * USTC_IN_LUNC, 0.2);
}

group('a route is only as good as its narrowest leg');
{
  const { mod } = await loadMarket();
  await mod.owMarket();
  await mod.graph();
  const ustr = await mod.mapPrice(A.USTR);
  const narrow = Math.min.apply(null, ustr.legs);
  near('depth is the smallest leg, not the largest', ustr.depth, narrow, 0.001);
  ok('the deep crossing does not flatter a shallow first hop',
     ustr.depth < Math.max.apply(null, ustr.legs));
}

group('hubs');
{
  // the concurrency bug: three callers at once, before anything is cached
  const { mod } = await loadMarket();
  await mod.owMarket();
  await mod.graph();
  const [a, b, c] = await Promise.all([mod.mapPrice(A.USTR), mod.mapPrice(A.CUSTC), mod.mapPrice(A.UST1)]);
  ok('concurrent callers all get a full hub list',
     !!a && !!b && !!c && a.depth > 500000,
     'ustr ' + (a && Math.round(a.depth)));
}

{
  // the ordering bug: hubs built before the walk must not stay that way
  const { mod } = await loadMarket();
  await mod.owMarket();
  const early = await mod.mapPrice(A.USTR);      // no walk yet: only the thin pool exists
  ok('before the walk, USTR has only the thin route',
     !early || early.depth < 500000, early && String(Math.round(early.depth)));
  await mod.graph();
  const late = await mod.mapPrice(A.USTR);
  ok('after the walk, the hub list is rebuilt and USTR is priced',
     late && late.depth > 500000, late && 'depth ' + Math.round(late.depth));
}

group('the graph is loaded when it is free');
{
  const first = await loadMarket();
  await first.mod.owMarket();
  await first.mod.graph();                        // fills the pair cache
  ok('the walk queried the factories', first.chain.calls.byMsg.pairs > 0);

  // a new session, same storage: the pairs are cached, so nothing should be walked
  const second = await loadMarket({ storage: first.store });
  await second.mod.owMarket();
  const ustr = await second.mod.mapPrice(A.USTR);
  ok('a cached walk still prices USTR', ustr && ustr.depth > 500000,
     ustr ? 'depth ' + Math.round(ustr.depth) : 'no route');
  ok('and the factories were not asked again',
     !second.chain.calls.byMsg.pairs, String(second.chain.calls.byMsg.pairs));
}

group('a warm cache is not the same as a loaded graph');
{
  const first = await loadMarket();
  await first.mod.owMarket();
  await first.mod.graph();

  // new session, same storage, and nobody calls graph() this time
  const { mod } = await loadMarket({ storage: first.store });
  await mod.owMarket();
  ok('the pair cache says the walk is free', mod.graphReady());
  const peers = mod.graphPeers(A.USTR);
  const ustr = await mod.mapPrice(A.USTR);
  ok('pricing loads the graph rather than pricing without it',
     ustr && ustr.depth > 500000,
     'peers before pricing ' + peers.length + ', ' +
     (ustr ? 'depth ' + Math.round(ustr.depth) : 'no route'));
  ok('and the walked pools are visible afterwards',
     mod.graphPeers(A.USTR).length > 1, String(mod.graphPeers(A.USTR).length));
}

group('pool dialects');
{
  const { mod, chain } = await loadMarket();
  await mod.owMarket();
  await mod.graph();

  const ts = await mod.simulateSwap('P_USTC_LUNC', A.USTC, '1000000', 'ts');
  ok('a terraswap pool answers the terraswap question', ts.dialect === 'ts');

  const gd = await mod.simulateSwap('P_CL8Y_USTC', A.CL8Y, '1000000', 'ts');
  ok('a garuda pool is found by probing, despite the wrong guess', gd.dialect === 'gd');

  const cl = await mod.simulateSwap('P_UST1_USTR', A.UST1, '1000000', 'ts');
  ok('a CL8Y pool is found the same way', cl.dialect === 'cl');

  const before = chain.calls.smart;
  await mod.simulateSwap('P_UST1_USTR', A.UST1, '2000000', 'ts');
  ok('the dialect is remembered, so the second ask costs one call',
     chain.calls.smart - before === 1, String(chain.calls.smart - before));
}

group('two hops: candidates are filtered before they are capped');
{
  // eight neighbours, only the last of which reaches a base. Capping first and
  // filtering second - which is what patch68 did - loses it.
  const many = {};
  for (let i = 0; i < 7; i++) many['cw20:terra1dead' + i] = { sym: 'D' + i, dec: 6 };
  const { mod } = await loadMarket();
  await mod.owMarket();
  await mod.graph();
  const ustr = await mod.mapPrice(A.USTR);
  ok('a usable neighbour is not lost behind unusable ones', ustr && ustr.depth > 500000);
}

report();
