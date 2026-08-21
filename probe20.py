#!/usr/bin/env python3
# probe20.py - why does a token have no price, and where does it trade.
#
#     python3 probe20.py terra1your...address
#     python3 probe20.py terra1your...address --factory terra1garuda...factory
#     python3 probe20.py terra1your...address --token terra1vima...contract
#
# Repeats what the wallet does, but out loud: builds the pair graph, sweeps
# balances, then for every token you hold walks the route to LUNC hop by hop
# and prints the reserves it found - or the exact step where pricing gave up.
#
# Unlike scan17 this one does not swallow failures. A contract that errors out
# is reported, not silently dropped, which is why scan17 said 15 tokens and the
# wallet then showed 40.

import base64
import json
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor

LCD = 'https://terra-classic-lcd.publicnode.com'
HEADERS = {
    'Accept': 'application/json',
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
    'Referer': 'https://baydashaaa.github.io/',
    'Origin': 'https://baydashaaa.github.io',
}

FACTORIES = [
    'terra1n75fgfc8clsssrm2k0fswgtzsvstdaah7la6sfu96szdu22xta0q57rqqr',
    'terra1y55punu6m5cm8sgqdgt6ngevtyklaylc09qxputn6ksye4ptf9ysxmtyl6',
    'terra1fctq9rwk6vn2v6pdyhydmczxxdsttrxd2qcsq6ffzp7akfnw2uqq3ueskn',
]
SEED = [
    'terra1566znlxwke0kp9jkhe6qgapsmcfdmc7k9czh380tlx80va8zlsgqzvjtfp',
    'terra1vhgq25vwuhdhn9xjll0rhl2s67jzw78a4g2t78y5kz89q9lsdskq2pxcj2',
    'terra1ex0hjv3wurhj4wgup4jzlzaqj4av6xqd8le4etml7rg9rs207y4s8cdvrp',
    'terra12f3f5fzfzxckc0qlv3rmwwkjfhzevpwmx77345n0zuu2678vxf0sm6vvcw',
    'terra1mm8tdp40r2slzwqxk8jsz66ayc4zp69muxeateq37x2xquttzsaqy7275a',
    'terra1ljyvgw50u67r3ep7pp7qexgnsgy96fl57q0suut325ehed7eal8qwdtdq4',
]
LUNC = 'native:uluna'
OUT = 'probe20.json'

args = [a for a in sys.argv[1:]]
addr = args[0] if args and args[0].startswith('terra1') else None
extra_tokens = []
while '--factory' in args:
    k = args.index('--factory')
    FACTORIES.append(args[k + 1])
    del args[k:k + 2]
while '--token' in args:
    k = args.index('--token')
    extra_tokens.append(args[k + 1])
    del args[k:k + 2]
if not addr:
    sys.exit('pass your address: python3 probe20.py terra1...')


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            time.sleep(0.6 * (i + 1))
    raise last


def smart(contract, q):
    b = base64.b64encode(json.dumps(q, separators=(',', ':')).encode()).decode()
    return get(LCD + '/cosmwasm/wasm/v1/contract/' + contract + '/smart/' + b)['data']


def key(info):
    if 'token' in info:
        return 'cw20:' + info['token']['contract_addr']
    return 'native:' + info['native_token']['denom']


def short(k):
    if k.startswith('native:'):
        return k[7:]
    return SYM.get(k, k[5:15] + '...')


# ------------------------------------------------------------- the graph ---
print('endpoint ' + LCD)
h = get(LCD + '/cosmos/base/tendermint/v1beta1/blocks/latest')
print('  height ' + h['block']['header']['height'])

print('reading %d factories' % len(FACTORIES))
raw = []
for f in FACTORIES:
    start, got = None, 0
    while True:
        q = {'pairs': {'limit': 30}}
        if start:
            q['pairs']['start_after'] = start
        try:
            r = smart(f, q)
        except Exception as e:
            print('  %s... error: %s' % (f[:14], str(e)[:70]))
            break
        chunk = r.get('pairs', [])
        if not chunk:
            break
        raw.extend(chunk)
        got += len(chunk)
        start = chunk[-1]['asset_infos']
        if len(chunk) < 30:
            break
    print('  %s...  %d pairs' % (f[:14], got))

EDGES, TOKENS = {}, []
seen = set()
for p in raw:
    a, b = key(p['asset_infos'][0]), key(p['asset_infos'][1])
    EDGES.setdefault(a, []).append((b, p['contract_addr']))
    EDGES.setdefault(b, []).append((a, p['contract_addr']))
    for k in (a, b):
        if k.startswith('cw20:') and k not in seen:
            seen.add(k)
            TOKENS.append(k[5:])
print('  %d pairs, %d distinct CW20' % (len(raw), len(TOKENS)))

# ------------------------------------------------------------ your tokens --
candidates = list(dict.fromkeys(TOKENS + SEED + extra_tokens))
print('sweeping %d contracts' % len(candidates))
failed = []


def probe(c):
    try:
        bal = int(smart(c, {'balance': {'address': addr}})['balance'])
    except Exception as e:
        failed.append((c, str(e)[:60]))
        return None
    if bal <= 0:
        return None
    try:
        info = smart(c, {'token_info': {}})
    except Exception as e:
        failed.append((c, 'token_info: ' + str(e)[:50]))
        return None
    return {'c': c, 'sym': info.get('symbol'), 'dec': int(info.get('decimals', 6)),
            'v': bal / (10 ** int(info.get('decimals', 6)))}


with ThreadPoolExecutor(max_workers=14) as ex:
    held = [r for r in ex.map(probe, candidates) if r]
print('  %d held, %d contracts failed to answer' % (len(held), len(failed)))
for c, e in failed[:8]:
    print('    %s... %s' % (c[:16], e))

SYM = {}
DEC = {LUNC: 6}
for r in held:
    SYM['cw20:' + r['c']] = r['sym']
    DEC['cw20:' + r['c']] = r['dec']

for t in extra_tokens:
    if not any(r['c'] == t for r in held):
        inpairs = [p for p in raw if t in json.dumps(p['asset_infos'])]
        print('  requested token %s...: balance zero or unreadable, %d pairs found'
              % (t[:16], len(inpairs)))


# ------------------------------------------------------------ the routing --
def decimals(k):
    if k in DEC:
        return DEC[k]
    d = 6
    if k.startswith('cw20:'):
        try:
            d = int(smart(k[5:], {'token_info': {}})['decimals'])
        except Exception:
            pass
    DEC[k] = d
    return d


def routes(start, max_hops=3, max_routes=3):
    if start == LUNC:
        return []
    out, visited, frontier = [], {start}, [[(start, None)]]
    for _ in range(max_hops):
        nxt = []
        for path in frontier:
            last = path[-1][0]
            for to, pair in EDGES.get(last, ()):
                if to == LUNC:
                    out.append(path + [(to, pair)])
                    continue
                if to in visited:
                    continue
                nxt.append(path + [(to, pair)])
        for p in nxt:
            visited.add(p[-1][0])
        frontier = nxt
        if out or not frontier:
            if out:
                break
    return out[:max_routes]


def price(route, verbose):
    p, depth = 1.0, float('inf')
    for i in range(len(route) - 1, 0, -1):
        near, pair = route[i][0], route[i][1]
        far = route[i - 1][0]
        try:
            r = smart(pair, {'pool': {}})
        except Exception as e:
            if verbose:
                print('      pool %s... unreadable: %s' % (pair[:14], str(e)[:50]))
            return None
        assets = r.get('assets', [])
        if len(assets) != 2:
            if verbose:
                print('      pool %s... has %d assets' % (pair[:14], len(assets)))
            return None
        ks = [key(a['info']) for a in assets]
        if near not in ks or far not in ks:
            if verbose:
                print('      pool %s... holds %s, expected %s + %s'
                      % (pair[:14], ' + '.join(short(k) for k in ks), short(near), short(far)))
            return None
        an = int(assets[ks.index(near)]['amount']) / 10 ** decimals(near)
        af = int(assets[ks.index(far)]['amount']) / 10 ** decimals(far)
        if verbose:
            print('      %s %.4f  <->  %s %.4f   (%s...)'
                  % (short(near), an, short(far), af, pair[:14]))
        if an == 0 or af == 0:
            if verbose:
                print('      one side is empty, no price from this pool')
            return None
        depth = min(depth, an * p)
        p = p * an / af
    return {'inLunc': p, 'depth': depth, 'hops': len(route) - 1}


print('\nrouting each held token to LUNC')
report = []
held.sort(key=lambda r: -r['v'])
for r in held:
    k = 'cw20:' + r['c']
    rs = routes(k)
    line = {'symbol': r['sym'], 'contract': r['c'], 'amount': r['v'],
            'routes': len(rs), 'pairs': len(EDGES.get(k, []))}
    if not rs:
        print('  %-9s %14.4f   no route to LUNC, appears in %d pairs: %s'
              % (r['sym'], r['v'], len(EDGES.get(k, [])),
                 ', '.join(short(t) for t, _ in EDGES.get(k, [])[:6]) or 'none'))
        report.append(line)
        continue
    best = None
    for idx, rt in enumerate(rs):
        verbose = True
        print('  %-9s route %d: %s' % (r['sym'] if idx == 0 else '', idx + 1,
                                       ' -> '.join(short(n) for n, _ in rt)))
        pr = price(rt, verbose)
        if pr and (not best or pr['depth'] > best['depth']):
            best = pr
    if best:
        print('      priced %.10f LUNC, depth %.2f LUNC, %d hops'
              % (best['inLunc'], best['depth'], best['hops']))
        line.update(best)
    else:
        print('      every route failed, no price')
    report.append(line)

json.dump({'held': report, 'failed': failed, 'pairs': len(raw), 'tokens': len(TOKENS)},
          open(OUT, 'w'), indent=1)
print('\nwrote ' + OUT)
