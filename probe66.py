#!/usr/bin/env python3
# probe66 - какие NFT-коллекции знает этот адрес, без списка коллекций.
#
#     python3 probe66.py terra1...
#
# Идея: у CW721 есть запрос {tokens:{owner}}, которого нет у CW20. Токен на
# него отвечает ошибкой, коллекция - списком. Значит перечислять коллекции не
# нужно, их можно узнавать: собрать контракты, с которыми адрес когда-либо
# имел дело, и спросить каждого.
#
# Ничего не пишет и не подписывает - только читает.

import base64, json, sys, time
from urllib.parse import quote
from urllib.request import urlopen, Request

LCD = 'https://terra-classic-lcd.publicnode.com'

if len(sys.argv) < 2 or not sys.argv[1].startswith('terra1'):
    sys.exit('нужен адрес: python3 probe66.py terra1...')
ADDR = sys.argv[1].strip()

def get(url, timeout=25):
    req = Request(url, headers={'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'})
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def smart(contract, msg):
    q = base64.b64encode(json.dumps(msg, separators=(',', ':')).encode()).decode()
    return get(LCD + '/cosmwasm/wasm/v1/contract/' + contract + '/smart/' + q, 20)

# ─── контракты, с которыми адрес имел дело ───
# Три события, потому что NFT приходит не так, как токен: минт пишет владельца,
# перевод - получателя, а собственные действия видны по отправителю.
EVENTS = [
    "wasm.recipient='%s'" % ADDR,
    "wasm.owner='%s'" % ADDR,
    "wasm.to='%s'" % ADDR,
    "message.sender='%s'" % ADDR,
]

found = {}
for ev in EVENTS:
    for page in range(2):
        try:
            r = get(LCD + '/cosmos/tx/v1beta1/txs?query=' + quote(ev) +
                    '&pagination.limit=100&pagination.offset=' + str(page * 100) +
                    '&order_by=ORDER_BY_DESC')
        except Exception as e:
            print('  событие %-34s не ответило (%s)' % (ev.split('=')[0], e))
            break
        resp = r.get('tx_responses', [])
        for t in resp:
            for lg in (t.get('logs') or []):
                for e in (lg.get('events') or []):
                    if e.get('type') != 'wasm':
                        continue
                    for a in (e.get('attributes') or []):
                        if a.get('key') == '_contract_address':
                            found[a['value']] = 1
        if len(resp) < 100:
            break

print('контрактов в истории адреса: %d' % len(found))
if not found:
    sys.exit('история пуста - проверь адрес')

# ─── кто из них коллекция ───
cols = []
for i, c in enumerate(sorted(found), 1):
    try:
        d = smart(c, {'tokens': {'owner': ADDR, 'limit': 3}}).get('data') or {}
    except Exception:
        continue                      # не CW721, обычный ответ
    ids = d.get('tokens')
    if not isinstance(ids, list):
        continue
    name = ''
    try:
        info = smart(c, {'contract_info': {}}).get('data') or {}
        name = info.get('name') or ''
    except Exception:
        pass
    cols.append((c, name, ids))
    print('\n  %s' % c)
    print('    название : %s' % (name or 'не отдал'))
    print('    у адреса : %s%s' % (', '.join(map(str, ids[:3])) or 'ни одного',
                                   ' ...' if len(ids) >= 3 else ''))
    if ids:
        try:
            meta = smart(c, {'nft_info': {'token_id': str(ids[0])}}).get('data') or {}
            print('    картинка : %s' % (meta.get('token_uri') or
                  (meta.get('extension') or {}).get('image') or 'не нашлась'))
        except Exception as e:
            print('    картинка : запрос не прошёл (%s)' % e)
    time.sleep(0.15)

print('\nколлекций найдено: %d' % len(cols))
print('с NFT на балансе : %d' % len([c for c in cols if c[2]]))
