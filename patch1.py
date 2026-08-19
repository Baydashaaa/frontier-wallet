import io
p = 'index.html'
s = io.open(p, encoding='utf-8').read()

# ---------- 1. CSS ----------
old = ".err{font-size:13px;color:var(--red);margin-top:12px;line-height:1.6}"
new = """.err{font-size:13px;color:var(--red);margin-top:12px;line-height:1.6}
.pinrow{display:flex;gap:10px;justify-content:center;margin:6px 0 14px}
.pindot{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--border);transition:all .18s}
.pindot.on{background:var(--accent);border-color:var(--accent);box-shadow:0 0 12px rgba(123,92,255,.6)}
.pindot.bad{background:var(--red);border-color:var(--red);box-shadow:none}
.pinin{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.pinbox{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-card);
  padding:22px 18px;margin-bottom:16px;cursor:text;text-align:center}
.pinbox label{margin-bottom:14px}
.tiny{font-size:11.5px;color:var(--muted);text-align:center;line-height:1.6;margin-top:10px}
.store{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--muted);background:var(--surface2);border:1px solid var(--border);
  border-radius:999px;padding:4px 11px;margin:0 auto 18px}
.store b{color:var(--green);font-weight:700}
.store.weak b{color:var(--gold)}"""
assert s.count(old) == 1, 'CSS anchor'
s = s.replace(old, new)

# ---------- 2. setup screen becomes a PIN screen ----------
old = """  <div class="field">
    <label>Passphrase</label>
    <input type="password" id="p1" autocomplete="new-password" placeholder="At least 12 characters">
    <div class="meter"><i id="mfill"></i></div>
    <div class="meter-txt" id="mtxt"></div>
  </div>
  <div class="field">
    <label>Repeat it</label>
    <input type="password" id="p2" autocomplete="new-password">
    <div class="meter-txt" id="mmatch"></div>
  </div>"""
new = """  <div class="pinbox" id="pinbox1">
    <label>Choose a 6 digit PIN</label>
    <div class="pinrow" id="pinrow1"></div>
    <input class="pinin" id="p1" type="tel" inputmode="numeric" maxlength="6" autocomplete="off">
    <div class="meter-txt" id="mtxt" style="min-height:0"></div>
  </div>
  <div class="pinbox" id="pinbox2">
    <label>Repeat it</label>
    <div class="pinrow" id="pinrow2"></div>
    <input class="pinin" id="p2" type="tel" inputmode="numeric" maxlength="6" autocomplete="off">
    <div class="meter-txt" id="mmatch" style="min-height:0"></div>
  </div>"""
assert s.count(old) == 1, 'setup fields'
s = s.replace(old, new)

s = s.replace("Pick a phrase length, then a passphrase that encrypts the keys on this device.",
              "Pick a phrase length, then a PIN. The keys are encrypted with it and kept in your phone's secure storage, never on a server.")
s = s.replace("<b>There is no reset.</b> If you forget this passphrase, the recovery phrase on the next screen is the only way back in.",
              "<b>There is no reset.</b> If you forget this PIN or lose the phone, the recovery phrase on the next screen is the only way back in.")

# ---------- 3. import screen PIN ----------
old = """    <label>Passphrase for this device</label>
    <input type="password" id="ip1" autocomplete="new-password" placeholder="At least 12 characters">"""
new = """    <label>PIN for this device</label>
    <input type="tel" inputmode="numeric" maxlength="6" id="ip1" autocomplete="off" placeholder="6 digits">"""
assert s.count(old) == 1, 'import pin'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('patch 1 ok')
