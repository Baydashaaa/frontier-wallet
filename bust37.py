#!/usr/bin/env python3
# bust37.py - stamp a version on every module, so the webview cannot serve
# yesterday's code.
#
#     cd ~/frontier-wallet && python3 bust37.py
#
# This is a hole I opened with the split and did not close. While everything
# lived in index.html, the browser revalidated that one file and you always got
# the current code. Now the code sits in eight files that are fetched by name
# with no version on them, and Telegram's webview caches those hard. So the
# screen you are looking at may be running any mixture of old and new modules -
# which is also the worst kind of bug, because a stale market.js next to a
# fresh tokens.js fails quietly rather than loudly.
#
# Every import gets ?v=<hash of all the code>. Change one line anywhere and
# every url changes, so there is no such thing as a partial update. Run it
# after each patch, before committing.

import hashlib
import io
import os
import re
import sys

JS = os.path.join('assets', 'js')
CSS = os.path.join('assets', 'css', 'app.css')
IX = 'index.html'
if not os.path.isdir(JS) or not os.path.exists(IX):
    sys.exit('run this from the repo root, after the split')

# ---------------------------------------------------------- strip old ones -
VER = re.compile(r"\?v=[0-9a-f]{6,12}")


def clean(s):
    return VER.sub('', s)


def rewrite(path, fn):
    # read fully, then open for writing. Doing both in one expression truncates
    # the file before the read runs, which empties every module it touches.
    body = io.open(path, encoding='utf-8').read()
    out = fn(body)
    io.open(path, 'w', encoding='utf-8').write(out)


files = sorted(f for f in os.listdir(JS) if f.endswith('.js'))
for f in files:
    rewrite(os.path.join(JS, f), clean)
rewrite(IX, clean)

# ------------------------------------------------------------ the version -
h = hashlib.sha1()
for f in files:
    h.update(io.open(os.path.join(JS, f), 'rb').read())
if os.path.exists(CSS):
    h.update(io.open(CSS, 'rb').read())
tag = h.hexdigest()[:8]
print('version %s over %d modules' % (tag, len(files)))

# --------------------------------------------------------- stamp imports --
names = [f[:-3] for f in files]
stamped = 0
for f in files:
    p = os.path.join(JS, f)
    s = io.open(p, encoding='utf-8').read()
    before = s
    for n in names:
        s = s.replace("from './%s.js'" % n, "from './%s.js?v=%s'" % (n, tag))
        s = s.replace("import './%s.js'" % n, "import './%s.js?v=%s'" % (n, tag))
    if s != before:
        io.open(p, 'w', encoding='utf-8').write(s)
        stamped += 1
    del before
print('  stamped imports in %d modules' % stamped)

s = io.open(IX, encoding='utf-8').read()
s = s.replace('href="assets/css/app.css"', 'href="assets/css/app.css?v=%s"' % tag)
s = s.replace('src="assets/js/app.js"', 'src="assets/js/app.js?v=%s"' % tag)
io.open(IX, 'w', encoding='utf-8').write(s)
print('  stamped index.html')

# ---------------------------------------------------------------- verify ---
bad = []
for f in files:
    s = io.open(os.path.join(JS, f), encoding='utf-8').read()
    for m in re.finditer(r"(?:from|import) '\./([a-z0-9_-]+\.js)(\?v=[0-9a-f]+)?'", s):
        if not m.group(2):
            bad.append('%s -> %s' % (f, m.group(1)))
if bad:
    print('\nthese imports did not get a version, which defeats the point:')
    for b in bad:
        print('  ' + b)
    sys.exit(1)
print('every internal import carries the version')
