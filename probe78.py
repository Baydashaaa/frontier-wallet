#!/usr/bin/env python3
# probe78 - разведка вокруг cwLUNC.
#
#     python3 probe78.py
#
# Три вопроса, все решаются чтением:
#   1. какая фабрика создала пару JURIS/cwLUNC и сколько у неё пар
#   2. сколько из них торгуют против cwLUNC - то есть скольким токенам
#      правка вернёт настоящую цену
#   3. каким сообщением LUNC оборачивается в cwLUNC и обратно
#
# Ничего не подписывает.

import base64, json, sys, time
from urllib.request import urlopen, Request
from urllib.error import HTTPError

LCD = 'https://terra-classic-lcd.publicnode.com'
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/124.0 Safari/537.36')

PAIR = 'terra14jedagazgdawpjfn37yhec5lfxs5fh22r6cl3uspa4x9yt8hnhlsp322v7'
WRAP = 'terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6'
ROUTER = 'terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8'

def get(url, timeout=25):
    r = Request(url, headers={'user-agent': UA, 'accept': 'application/json'})
    return json.loads(urlopen(r, timeout=timeout).read().decode())

def smart(c, m, timeout=20):
    q = base64.b64encode(json.dumps(m, separators=(',', ':')).encode()).decode()
    return get(LCD + '/cosmwasm/wasm/v1/contract/' + c + '/smart/' + q, timeout).get('data')

def info(c):
    return get(LCD + '/cosmwasm/wasm/v1/contract/' + c)

def key(i):
    if not i: return '?'
    if 'token' in i: return i['token']['contract_addr']
    if 'native_token' in i: return 'native:' + i['native_token']['denom']
    if 'cw20' in i: return i['cw20']
    if 'native' in i: return 'native:' + i['native']
    return '?'

# ─────────── 1. кто создал пару ───────────
print('=== чей это пул ===')
creator = admin = None
try:
    d = info(PAIR).get('contract_info', {})
    creator = d.get('creator')
    admin = d.get('admin')
    print('  code_id :', d.get('code_id'))
    print('  creator :', creator)
    print('  admin   :', admin)
    print('  label   :', d.get('label'))
except Exception as e:
    print('  не прочиталось:', e)

# ─────────── 2. пары этой фабрики ───────────
print('\n=== пары фабрики ===')
pairs = []
if creator:
    start = None
    for page in range(12):
        q = {'pairs': {'limit': 30}}
        if start: q['pairs']['start_after'] = start
        try:
            d = smart(creator, q) or {}
        except Exception as e:
            print('  фабрика не отвечает на pairs{}:', e); break
        got = d.get('pairs') or []
        if not got: break
        for p in got:
            infos = p.get('asset_infos') or []
            pairs.append({
                'addr': p.get('contract_addr'),
                'a': key(infos[0] if len(infos) > 0 else None),
                'b': key(infos[1] if len(infos) > 1 else None),
            })
        start = got[-1].get('asset_infos')
        if len(got) < 30: break
        time.sleep(0.2)
print('  пар у фабрики: %d' % len(pairs))

vs_wrap = [p for p in pairs if WRAP in (p['a'], p['b'])]
vs_luna = [p for p in pairs if 'native:uluna' in (p['a'], p['b'])]
print('  против cwLUNC : %d' % len(vs_wrap))
print('  против uluna  : %d' % len(vs_luna))
for p in vs_wrap[:15]:
    other = p['b'] if p['a'] == WRAP else p['a']
    print('    %s…  токен %s…' % (p['addr'][:14], other[:14]))
if len(vs_wrap) > 15:
    print('    ... и ещё %d' % (len(vs_wrap) - 15))

# ─────────── 3. как оборачивается LUNC ───────────
print('\n=== обёртка cwLUNC ===')
try:
    d = info(WRAP).get('contract_info', {})
    print('  code_id :', d.get('code_id'), ' label:', d.get('label'))
except Exception as e:
    print('  contract_info не прочиталось:', e)

for name, msg in [('token_info', {'token_info': {}}),
                  ('minter', {'minter': {}}),
                  ('marketing_info', {'marketing_info': {}}),
                  ('state', {'state': {}}),
                  ('denom', {'denom': {}})]:
    try:
        print('  %-14s -> %s' % (name, json.dumps(smart(WRAP, msg))[:200]))
    except HTTPError as e:
        print('  %-14s -> нет (%s)' % (name, e.code))
    except Exception as e:
        print('  %-14s -> нет (%s)' % (name, e))
    time.sleep(0.15)

# Имя сообщения для упаковки контракт не выдаст запросом - но выдаст ошибка:
# wasmd в тексте отказа перечисляет варианты, которые он ожидал увидеть.
print('\n  пробую вызвать несуществующее сообщение, чтобы контракт сам')
print('  перечислил, что он принимает:')
try:
    smart(WRAP, {'__nonexistent_probe__': {}})
except HTTPError as e:
    try:
        body = json.loads(e.read().decode())
        print('  ' + (body.get('message') or '')[:600])
    except Exception:
        print('  контракт ответил %s без подробностей' % e.code)
except Exception as e:
    print('  ' + str(e)[:300])

# ─────────── 4. роутер, для сравнения ───────────
print('\n=== роутер Vyntrex ===')
try:
    d = info(ROUTER).get('contract_info', {})
    print('  code_id :', d.get('code_id'), ' admin:', d.get('admin'))
except Exception as e:
    print('  не прочиталось:', e)
try:
    smart(ROUTER, {'__nonexistent_probe__': {}})
except HTTPError as e:
    try:
        body = json.loads(e.read().decode())
        print('  принимает: ' + (body.get('message') or '')[:600])
    except Exception:
        print('  ответил %s без подробностей' % e.code)
except Exception as e:
    print('  ' + str(e)[:300])
