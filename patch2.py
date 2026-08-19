import io
p = 'index.html'
s = io.open(p, encoding='utf-8').read()

# ---------- 4. unlock + home screens ----------
old = '<section class="step" id="st-done">'
new = """<!-- ================= UNLOCK ================= -->
<section class="step" id="st-unlock">
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center">
    <h1 style="text-align:center">Welcome back</h1>
    <p class="lede" style="text-align:center" id="unlock-addr">...</p>
    <div class="pinbox" id="pinboxU">
      <label>Enter your PIN</label>
      <div class="pinrow" id="pinrowU"></div>
      <input class="pinin" id="pu" type="tel" inputmode="numeric" maxlength="6" autocomplete="off">
      <div class="meter-txt" id="umsg" style="min-height:0"></div>
    </div>
  </div>
  <button class="btn quiet" id="btn-forget">Forget this wallet</button>
</section>

<!-- ================= HOME (placeholder) ================= -->
<section class="step" id="st-home">
  <div class="bar"><div class="dots"></div></div>
  <h1>Wallet unlocked</h1>
  <p class="lede">The balance, send and staking screens are not wired into this build yet. What works is the part underneath: the key is decrypted in memory and never leaves the device.</p>
  <div class="store" id="store-kind">stored in <b>...</b></div>
  <div class="addr">
    <label>Your address</label>
    <code id="home-addr">...</code>
  </div>
  <p class="tiny" id="home-note"></p>
  <div class="grow"></div>
  <button class="btn" id="btn-lock">Lock</button>
  <button class="btn quiet" id="btn-reset">Delete wallet from this device</button>
</section>

<section class="step" id="st-done">"""
assert s.count(old) == 1, 'done anchor'
s = s.replace(old, new)

# ---------- 5. PIN logic replaces the passphrase meter ----------
old = """function checkPass(){
  const a = $('#p1').value, b = $('#p2').value, s = strength(a);
  $('#mfill').style.width = s.score + '%';
  $('#mfill').style.background = s.score <= 25 ? 'var(--red)' : s.score <= 50 ? 'var(--gold)' : 'var(--green)';
  $('#mtxt').textContent = s.txt;
  const match = a.length > 0 && a === b;
  $('#mmatch').textContent = b.length === 0 ? '' : (match ? '' : 'The two do not match');
  $('#mmatch').style.color = 'var(--red)';
  $('#btn-setup').disabled = !(a.length >= 12 && match);
}
$('#p1').addEventListener('input', checkPass);
$('#p2').addEventListener('input', checkPass);"""
new = """function dots(rowId, n, bad){
  const row = $('#' + rowId);
  row.innerHTML = '';
  for (let i = 0; i < 6; i++){
    const d = document.createElement('span');
    d.className = 'pindot' + (i < n ? ' on' : '') + (bad ? ' bad' : '');
    row.appendChild(d);
  }
}
function digitsOnly(el){ el.value = el.value.replace(/\\D/g, '').slice(0, 6); return el.value; }

function checkPass(){
  const a = digitsOnly($('#p1')), b = digitsOnly($('#p2'));
  dots('pinrow1', a.length); dots('pinrow2', b.length);
  const weak = a.length === 6 && (/^(\\d)\\1{5}$/.test(a) || '0123456789'.includes(a) || '9876543210'.includes(a));
  $('#mtxt').textContent = weak ? 'Too easy to guess, pick another' : '';
  $('#mtxt').style.color = 'var(--gold)';
  const match = a.length === 6 && a === b;
  $('#mmatch').textContent = (b.length === 6 && !match) ? 'The two do not match' : '';
  $('#mmatch').style.color = 'var(--red)';
  $('#btn-setup').disabled = !(match && !weak);
}
['p1','p2'].forEach(id => {
  $('#' + id).addEventListener('input', checkPass);
  $('#pinbox' + (id === 'p1' ? '1' : '2')).addEventListener('click', () => $('#' + id).focus());
});
dots('pinrow1', 0); dots('pinrow2', 0);
$('#ip1').addEventListener('input', () => digitsOnly($('#ip1')));"""
assert s.count(old) == 1, 'checkPass'
s = s.replace(old, new)

s = s.replace("if (PASS.length < 12) throw new Error('passphrase too short');",
              "if (PASS.length !== 6) throw new Error('PIN must be 6 digits');")
s = s.replace("const passOk = $('#ip1').value.length >= 12;",
              "const passOk = /^\\d{6}$/.test($('#ip1').value);")

io.open(p, 'w', encoding='utf-8').write(s)
print('patch 2 ok')
