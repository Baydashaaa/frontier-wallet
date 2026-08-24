#!/usr/bin/env python3
# probe76 - сколько реально даёт дробление сделки между пулами.
#
#     python3 probe76.py <контракт токена> <сумма LUNC>
#     python3 probe76.py terra1... 380000
#
# Ничего не подписывает. Только читает: находит все пары токена против LUNC,
# берёт их резервы, считает лучшее разбиение по модели постоянного
# произведения, и проверяет результат настоящей симуляцией у самих пулов.
#
# Смысл в том, чтобы узнать цену вопроса до того, как писать роутер.

import base64, json, sys, time
from urllib.request import urlopen, Request

LCD = 'https://terra-classic-lcd.publicnode.com'
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/124.0 Safari/537.36')

# те же фабрики, что знает кошелёк
FACTORIES = [
    ('terra1ejpgvv7g3hj0u6fpcnxhflqp84g0w3cnaskqkg5733ygwlmf963sfchsea', 'ts'),
    ('terra1y55punu6m5cm8sgqdgt6ngevtyklaylc09qxputn6ksye4ptf9ysxmtyl6', 'ts'),
    ('terra1n75fgfc8clsssrm2k0fswgtzsvstdaah7la6sfu96szdu22xta0q57rqqr', 'ts'),
    ('terra1fctq9rwk6vn2v6pdyhydmczxxdsttrxd2qcsq6ffzp7akfnw2uqq3ueskn', 'ts'),
]

if len(sys.argv) < 3:
    sys.exit('нужно: python3 probe76.py <контракт токена> <сумма LUNC>')
TOKEN = sys.argv[1].strip()
HUMAN = float(sys.argv[2].replace(',', '.'))
OFFER = int(round(HUMAN * 1e6))          # LUNC, шесть знаков

def smart(c, m, timeout=20):
    q = base64.b64encode(json.dumps(m, separators=(',', ':')).encode()).decode()
    r = Request(LCD + '/cosmwasm/wasm/v1/contract/' + c + '/smart/' + q,
                headers={'user-agent': UA, 'accept': 'application/json'})
    return json.loads(urlopen(r, timeout=timeout).read().decode()).get('data')

def info_key(i):
    if not i: return '?'
    if 'token' in i: return 'cw20:' + i['token']['contract_addr']
    if 'native_token' in i: return 'native:' + i['native_token']['denom']
    if 'cw20' in i: return 'cw20:' + i['cw20']
    if 'native' in i: return 'native:' + i['native']
    return '?'

# ─────────────── пары ───────────────
print('ищу пары %s / LUNC' % TOKEN[:16] + '...')
pairs = []
for f, kind in FACTORIES:
    q = {'pair': {'asset_infos': [
        {'token': {'contract_addr': TOKEN}},
        {'native_token': {'denom': 'uluna'}}]}}
    try:
        d = smart(f, q) or {}
    except Exception:
        continue                          # фабрика без этой пары отвечает ошибкой
    a = d.get('contract_addr') or d.get('contract') or d.get('pair')
    if a and a not in pairs:
        pairs.append(a)
    time.sleep(0.15)

if not pairs:
    sys.exit('пар не нашлось - проверь адрес контракта')
print('пар найдено: %d\n' % len(pairs))

# ─────────────── резервы ───────────────
pools = []
for p in pairs:
    try:
        d = smart(p, {'pool': {}}) or {}
    except Exception:
        print('  %s… резервы не отдал' % p[:16]); continue
    lunc = tok = None
    if isinstance(d.get('assets'), list) and len(d['assets']) == 2:
        for a in d['assets']:
            k = info_key(a.get('info'))
            if k == 'native:uluna': lunc = int(a['amount'])
            else: tok = int(a['amount'])
    elif d.get('asset1') is not None:
        k1 = info_key(d['asset1'])
        if k1 == 'native:uluna': lunc, tok = int(d['reserve1']), int(d['reserve2'])
        else: tok, lunc = int(d['reserve1']), int(d['reserve2'])
    if not lunc or not tok:
        print('  %s… резервы не прочитались' % p[:16]); continue
    pools.append({'p': p, 'x': lunc, 'y': tok})
    print('  %s…  %14.2f LUNC  /  %18.2f токена' % (p[:16], lunc / 1e6, tok / 1e6))
    time.sleep(0.15)

if len(pools) < 2:
    sys.exit('\nменьше двух рабочих пулов - дробить нечего')

# ─────────────── модель ───────────────
# Постоянное произведение с комиссией: out = y*x_in*(1-f)/(X+x_in).
# Модель нужна только чтобы выбрать разбиение; итог проверяется симуляцией.
FEE = 0.003
def out_of(pool, amt):
    if amt <= 0: return 0.0
    return pool['y'] * amt * (1 - FEE) / (pool['x'] + amt)

def total_of(split):
    return sum(out_of(pools[i], split[i]) for i in range(len(pools)))

# один лучший пул
best_single_i = max(range(len(pools)), key=lambda i: out_of(pools[i], OFFER))
model_single = out_of(pools[best_single_i], OFFER)

# перебор разбиений с шагом 2 процента, до трёх пулов
STEP = 0.02
best_split, best_model = None, 0.0
n = len(pools)
def walk(i, left, acc):
    global best_split, best_model
    if i == n - 1:
        cand = acc + [left]
        v = total_of(cand)
        if v > best_model:
            best_model, best_split = v, cand
        return
    k = 0.0
    while k <= left + 1e-9:
        walk(i + 1, left - k, acc + [k])
        k += STEP
walk(0, 1.0, [])
split_amounts = [int(round(OFFER * s)) for s in best_split]

print('\nпо модели:')
print('  один пул  : %18.2f' % (model_single / 1e6))
print('  дробление : %18.2f  (+%.2f%%)' %
      (best_model / 1e6, (best_model / model_single - 1) * 100 if model_single else 0))
print('  разбиение : %s' % ', '.join('%.0f%%' % (s * 100) for s in best_split))

# ─────────────── проверка у пулов ───────────────
def sim(pair, amt):
    d = smart(pair, {'simulation': {'offer_asset': {
        'info': {'native_token': {'denom': 'uluna'}}, 'amount': str(amt)}}}) or {}
    return int(d.get('return_amount') or 0)

print('\nпроверяю симуляцией...')
try:
    real_single = sim(pools[best_single_i]['p'], OFFER)
except Exception as e:
    sys.exit('симуляция одного пула не прошла: %s' % e)

real_split = 0
for i, amt in enumerate(split_amounts):
    if amt <= 0: continue
    try:
        real_split += sim(pools[i]['p'], amt)
    except Exception as e:
        print('  пул %s… не ответил (%s)' % (pools[i]['p'][:16], e))
    time.sleep(0.2)

print('\nпо настоящим котировкам:')
print('  один пул  : %18.2f' % (real_single / 1e6))
print('  дробление : %18.2f' % (real_split / 1e6))
if real_single:
    gain = (real_split / real_single - 1) * 100
    print('  выигрыш   : %+.3f%%   (%.2f токена)' %
          (gain, (real_split - real_single) / 1e6))
    print('\nвывод: %s' % (
        'дробление стоит роутера' if gain > 0.5 else
        'выигрыш меньше половины процента - роутер того не стоит'))
