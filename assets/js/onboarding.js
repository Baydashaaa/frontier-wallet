import { finish } from './crypto.js?v=77336b0c';
import { $, $$, bip39, buzz, go, libs, tap } from './shell.js?v=77336b0c';
import { S } from './state.js?v=77336b0c';

/* ---------------- length toggle ---------------- */
$('#seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  tap();
  $$('#seg button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  S.BITS = +b.dataset.len;
  $('#len-note').textContent = S.BITS === 128
    ? '12 words is 128 bits of entropy. Nothing will brute force that, and it is far easier to write down without a mistake.'
    : '24 words is 256 bits. No practical gain over 12 against brute force, but some people prefer it and some hardware wallets expect it.';
});

/* ---------------- passphrase ---------------- */
function strength(p){
  if (!p) return { score:0, txt:'' };
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  const bits = Math.round(p.length * Math.log2(pool || 1));
  if (bits < 45)      return { score:25,  txt:'Weak, crackable offline in hours - about ' + bits + ' bits' };
  if (bits < 60)      return { score:50,  txt:'Fair - about ' + bits + ' bits' };
  if (bits < 80)      return { score:75,  txt:'Good - about ' + bits + ' bits' };
  return                     { score:100, txt:'Strong - about ' + bits + ' bits' };
}
const PIN_LEN = 8;
function dots(rowId, n, bad){
  const row = $('#' + rowId);
  row.innerHTML = '';
  for (let i = 0; i < PIN_LEN; i++){
    const d = document.createElement('span');
    d.className = 'pindot' + (i < n ? ' on' : '') + (bad ? ' bad' : '');
    row.appendChild(d);
  }
}
function digitsOnly(el){ el.value = el.value.replace(/\D/g, '').slice(0, PIN_LEN); return el.value; }

function checkPass(){
  const a = digitsOnly($('#p1')), b = digitsOnly($('#p2'));
  dots('pinrow1', a.length); dots('pinrow2', b.length);
  const weak = a.length === PIN_LEN && (/^(\d)\1+$/.test(a) || '0123456789'.includes(a) || '9876543210'.includes(a));
  $('#mtxt').textContent = weak ? 'Too easy to guess, pick another' : '';
  $('#mtxt').style.color = 'var(--gold)';
  const match = a.length === PIN_LEN && a === b;
  $('#mmatch').textContent = (b.length === PIN_LEN && !match) ? 'The two do not match' : '';
  $('#mmatch').style.color = 'var(--red)';
  $('#btn-setup').disabled = !(match && !weak);
}
function focusPin(sel){
  const el = $(sel);
  if (document.activeElement !== el) el.focus();
}
['p1','p2'].forEach(id => {
  $('#' + id).addEventListener('input', checkPass);
  $('#pinbox' + (id === 'p1' ? '1' : '2')).addEventListener('click', () => focusPin('#' + id));
});
dots('pinrow1', 0); dots('pinrow2', 0);
$('#pinboxI').addEventListener('click', () => focusPin('#ip1'));
$('#ip1').addEventListener('input', () => dots('pinrowI', digitsOnly($('#ip1')).length));
dots('pinrowI', 0);

/* ---------------- generate ---------------- */
$('#btn-setup').addEventListener('click', async () => {
  tap();
  S.PASS = $('#p1').value;
  const b = $('#btn-setup');
  b.disabled = true; b.innerHTML = '<span class="spin"></span>Generating';
  try {
    await libs();
    S.MNEMONIC = bip39.generateMnemonic(bip39.wordlist, S.BITS);
    renderSeed();
    go('seed');
  } catch (e) {
    b.insertAdjacentHTML('afterend', '<p class="err">Could not load the crypto libraries. Check the connection and reload.</p>');
  } finally { b.disabled = false; b.textContent = 'Continue'; }
});

function renderSeed(){
  const words = S.MNEMONIC.split(' ');
  const g = $('#seedgrid');
  g.className = 'seed' + (words.length > 12 ? ' long' : '');
  g.innerHTML = words.map((w,i) => '<div class="word"><i>' + (i+1) + '</i><b>' + w + '</b></div>').join('');
  $('#seed-lede').textContent = 'These ' + words.length +
    ' words ARE your wallet. Write them down in order. Anyone who reads them owns your funds.';
  $('#veil').classList.remove('gone');
  $('#chk').classList.remove('on');
  $('#btn-seed').disabled = true;
  const c = $('#copy'); c.classList.remove('done'); c.querySelector('span').textContent = 'Copy phrase';
}

$('#veil').addEventListener('click', () => { tap(); $('#veil').classList.add('gone'); });

$('#copy').addEventListener('click', async () => {
  tap();
  try { await navigator.clipboard.writeText(S.MNEMONIC); }
  catch (e) {
    const t = document.createElement('textarea');
    t.value = S.MNEMONIC; document.body.appendChild(t); t.select();
    document.execCommand('copy'); t.remove();
  }
  const c = $('#copy');
  c.classList.add('done');
  c.querySelector('span').textContent = 'Copied - paste it somewhere safe now';
  buzz('success');
});

$('#chk').addEventListener('click', () => {
  tap();
  const on = $('#chk').classList.toggle('on');
  $('#btn-seed').disabled = !on || !$('#veil').classList.contains('gone');
});

/* ---------------- verification ---------------- */
$('#btn-seed').addEventListener('click', () => { buildVerify(); go('verify'); });

function buildVerify(){
  const words = S.MNEMONIC.split(' ');
  const n = words.length;

  // two distinct positions, kept apart so they are not adjacent
  let a = 1 + Math.floor(Math.random() * (n - 1));
  let b = 1 + Math.floor(Math.random() * (n - 1));
  let guard = 0;
  while (Math.abs(a - b) < Math.max(2, Math.floor(n / 4)) && guard++ < 60) {
    b = 1 + Math.floor(Math.random() * (n - 1));
  }
  const pos = [a, b].sort((x, y) => x - y);
  S.SLOTS = pos.map(p => ({ pos: p, answer: words[p - 1], word: null }));

  $('#slots').innerHTML = S.SLOTS.map((s, i) =>
    '<div class="slot" data-slot="' + i + '">' +
      '<span class="slot-n">Word ' + s.pos + '</span>' +
      '<span class="slot-w"></span>' +
    '</div>').join('');

  // ten chips: the two answers plus eight decoys
  const chips = [S.SLOTS[0].answer, S.SLOTS[1].answer];
  while (chips.length < 10) {
    const w = bip39.wordlist[Math.floor(Math.random() * bip39.wordlist.length)];
    if (!chips.includes(w) && !words.includes(w)) chips.push(w);
  }
  chips.sort(() => Math.random() - 0.5);
  $('#tray').innerHTML = chips.map(w => '<div class="chip" data-w="' + w + '">' + w + '</div>').join('');

  S.SEL = null;
  $('#btn-verify').disabled = true;
  wireDrag();
}

function place(slotIdx, word, chipEl){
  const s = S.SLOTS[slotIdx];
  if (s.word) return false;              // occupied
  s.word = word; s.chip = chipEl;
  const el = $('.slot[data-slot="' + slotIdx + '"]');
  el.classList.add('filled');
  el.querySelector('.slot-w').textContent = word;
  chipEl.classList.add('used');
  grade();
  return true;
}

function unplace(slotIdx){
  const s = S.SLOTS[slotIdx];
  if (!s.word) return;
  s.chip.classList.remove('used');
  s.word = null; s.chip = null;
  const el = $('.slot[data-slot="' + slotIdx + '"]');
  el.className = 'slot';
  el.querySelector('.slot-w').textContent = '';
  grade();
}

function grade(){
  const done = S.SLOTS.every(s => s.word);
  if (!done) { $('#btn-verify').disabled = true; return; }
  let all = true;
  S.SLOTS.forEach((s, i) => {
    const el = $('.slot[data-slot="' + i + '"]');
    const ok = s.word === s.answer;
    el.classList.toggle('ok', ok);
    el.classList.toggle('bad', !ok);
    if (!ok) all = false;
  });
  buzz(all ? 'success' : 'error');
  $('#btn-verify').disabled = !all;
}

function wireDrag(){
  // tap to select, tap a slot to drop
  $$('#tray .chip').forEach(chip => {
    let sx = 0, sy = 0, moved = false, ghost = null, hot = null;

    chip.addEventListener('pointerdown', e => {
      if (chip.classList.contains('used')) return;
      sx = e.clientX; sy = e.clientY; moved = false;
      chip.setPointerCapture(e.pointerId);
    });

    chip.addEventListener('pointermove', e => {
      if (!chip.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 7) return;
      if (!moved) {
        moved = true;
        ghost = document.createElement('div');
        ghost.className = 'dragghost';
        ghost.textContent = chip.dataset.w;
        document.body.appendChild(ghost);
        chip.style.opacity = '.25';
      }
      ghost.style.left = e.clientX + 'px';
      ghost.style.top  = e.clientY + 'px';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const slot = under && under.closest ? under.closest('.slot') : null;
      if (hot && hot !== slot) hot.classList.remove('hot');
      if (slot && !S.SLOTS[+slot.dataset.slot].word) { slot.classList.add('hot'); hot = slot; }
      else hot = null;
    });

    const finish = e => {
      if (!chip.hasPointerCapture || !moved) {
        if (!moved) {                      // treated as a tap
          tap();
          if (S.SEL === chip) { chip.classList.remove('sel'); S.SEL = null; }
          else {
            if (S.SEL) S.SEL.classList.remove('sel');
            S.SEL = chip; chip.classList.add('sel');
          }
        }
      }
      if (moved) {
        if (ghost) { ghost.remove(); ghost = null; }
        chip.style.opacity = '';
        if (hot) {
          hot.classList.remove('hot');
          place(+hot.dataset.slot, chip.dataset.w, chip);
          tap();
        }
        hot = null; moved = false;
      }
    };
    chip.addEventListener('pointerup', finish);
    chip.addEventListener('pointercancel', finish);
  });

  $$('#slots .slot').forEach(el => {
    el.addEventListener('click', () => {
      const i = +el.dataset.slot;
      if (S.SLOTS[i].word) { tap(); unplace(i); return; }
      if (S.SEL) { place(i, S.SEL.dataset.w, S.SEL); S.SEL.classList.remove('sel'); S.SEL = null; tap(); }
    });
  });
}

export { PIN_LEN, digitsOnly, dots, focusPin };
