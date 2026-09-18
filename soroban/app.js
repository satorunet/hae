// ハエそろばん計算機 - the page.
//
// A soroban in 3D (soroban/stage.js) and the fly that works it: a rod carries one five-bead above the
// beam and four one-beads below, and a bead counts when it is against the beam. Everything on screen is
// read out of the brain in the worker - which bead rings are firing is what moves a bead - and nothing
// on this page does any arithmetic.
import { makeStage } from './stage.js?v=31';
import { Sound } from '../juku/sound.js';

const $ = (id) => document.getElementById(id);
const PAGE_V = 'v126 / stage31';        // shown on the page, so a stale file can be seen at a glance
addEventListener('error', (e) => { const s = $('say'); if (s) s.textContent = 'エラー: ' + (e.message || e.type); });
addEventListener('unhandledrejection', (e) => { const s = $('say'); if (s) s.textContent = 'エラー: ' + ((e.reason && e.reason.message) || e.reason); });
const snd = new Sound();
// A bead landing: a short band of noise for the click and a low triangle for the wood under it. The
// wing buzz comes from juku/sound.js (the same one the other pages fly with); this is what a soroban
// adds to it.
let noise = null;
const getNoise = (ctx) => {
  if (!noise) {
    noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  }
  return noise;
};
function clack(vol = 0.22, pitch = 1, at = 0) {
  const ctx = snd.ctx;
  if (!ctx || !snd.on) return;
  getNoise(ctx);
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource(); src.buffer = noise;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 2300 * pitch; bp.Q.value = 5.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  src.connect(bp); bp.connect(g); g.connect(snd.master);
  src.start(t); src.stop(t + 0.06);
  snd.note(150 * pitch, at, 0.045, 'triangle', vol * 0.5);      // the rod and the wood
}
/** ご破算: the sound of a whole board of beads being thrown back at once. */
function swish() {
  const ctx = snd.ctx;
  if (!ctx || !snd.on) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource(); src.buffer = getNoise(ctx); src.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(900, t);
  bp.frequency.exponentialRampToValueAtTime(3200, t + 0.16);
  bp.frequency.exponentialRampToValueAtTime(700, t + 0.42);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  src.connect(bp); bp.connect(g); g.connect(snd.master);
  src.start(t); src.stop(t + 0.5);
}
const DIG = 8, NRODS = 9;                     // eight digits, and the rod that counts a multiplication

const NBEAD = 5;                              // one five-bead and four one-beads a rod

// ---------------------------------------------------------------- the 3D soroban
// soroban/stage.js owns the scene: the frame, the rods, the beads and the flies that work them. All the
// page does is tell it what each rod is showing.
const canvas = $('stage');
let stage = null, ready = false, speed = 99, acc = 0, running = false;   // 最速 by default
const value = new Array(NRODS).fill(0);
makeStage(canvas, {
  rods: NRODS, digits: DIG,
  onProgress: () => { if (!ready) $('say').textContent = '蠅を呼んでいます…'; },
  onHit: (b) => clack(0.2 + (b.k === 0 ? 0.06 : 0), 0.9 + 0.1 * b.k),   // a bead landing
}).then((s) => { stage = s; s.set(value); layout(); if (ready) idleSay(); })
  .catch((err) => { console.warn('no 3D stage', err); $('say').textContent = '3D を用意できませんでした: ' + err.message; });

function layout() {
  if (!stage) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w > 0 && h > 0) stage.resize(w, h);
}
addEventListener('resize', layout);
if (window.ResizeObserver) new ResizeObserver(() => layout()).observe($('stagewrap'));

// ---------------------------------------------------------------- the brain, lighting up
const KINDS = ['#5d7285', '#54d98c', '#ffb454', '#59b7ff'];
const DIM = ['#2a3441', '#22402f', '#3a3122', '#22384a'];
// Two of these: the small one beside the number on the soroban tab, and the big one on the brain tab.
// They share the same glow, and only the one that is on screen is drawn.
let POS = null, glow = null, OUTLINE = null;      // OUTLINE: the whole fly brain, faint, behind it all
function brainView(canvas) {
  const ctx = canvas.getContext('2d');
  let BG = null, px = null, py = null;
  function size() {
    if (!POS || !canvas.clientWidth) return;
    const d = Math.min(2, devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight || 64;
    canvas.width = Math.round(w * d); canvas.height = Math.round(h * d);
    px = new Float32Array(POS.n); py = new Float32Array(POS.n);
    const pad = 3 * d;
    for (let i = 0; i < POS.n; i++) {
      px[i] = pad + POS.x[i] * (canvas.width - 2 * pad);
      py[i] = pad + POS.y[i] * (canvas.height - 2 * pad);
    }
    BG = document.createElement('canvas'); BG.width = canvas.width; BG.height = canvas.height;
    const g = BG.getContext('2d'), s = Math.max(1, Math.round(d));
    if (OUTLINE) {                                   // the fly's own brain: every sixth neuron, very dim
      g.fillStyle = '#1b232c';
      for (let i = 0; i < OUTLINE.length; i += 2) {
        g.fillRect(pad + (OUTLINE[i] / 255) * (canvas.width - 2 * pad),
          pad + (OUTLINE[i + 1] / 255) * (canvas.height - 2 * pad), s, s);
      }
    }
    for (let k = 0; k < 4; k++) {
      g.fillStyle = DIM[k];
      for (let i = 0; i < POS.n; i++) if (POS.kind[i] === k) g.fillRect(px[i], py[i], s, s);
    }
  }
  function draw(act) {
    if (!BG || !canvas.offsetParent) return;                 // not on screen: nothing to do
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(BG, 0, 0);
    const d = Math.min(2, devicePixelRatio || 1), s = Math.max(1.5, 1.7 * d);
    for (let band = 0; band < 3; band++) {
      ctx.globalAlpha = [1, 0.6, 0.3][band];
      for (let k = 0; k < 4; k++) {
        let started = false;
        for (const i of act) {
          if (POS.kind[i] !== k) continue;
          const v = glow[i], b = v > 0.6 ? 0 : v > 0.25 ? 1 : 2;
          if (b !== band) continue;
          if (!started) { ctx.fillStyle = KINDS[k]; started = true; }
          ctx.fillRect(px[i] - s / 2, py[i] - s / 2, s, s);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  return { size, draw };
}
const views = [brainView($('brain')), brainView($('bigbrain'))];
const sizeBrain = () => views.forEach((v) => v.size());
fetch(new URL('./data/brain-outline.bin.gz?v=1', import.meta.url))
  .then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  .then((buf) => { OUTLINE = new Uint8Array(buf); sizeBrain(); })
  .catch((err) => console.warn('no outline', err));
fetch(new URL('./data/soroban-pos.bin.gz?v=3', import.meta.url))
  .then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  .then((buf) => {
    const b = new Uint8Array(buf), dv = new DataView(buf), n = b.length / 5;
    POS = { n, x: new Float32Array(n), y: new Float32Array(n), kind: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      POS.x[i] = dv.getUint16(i * 5, true) / 65535;
      POS.y[i] = dv.getUint16(i * 5 + 2, true) / 65535;
      POS.kind[i] = b[i * 5 + 4];
    }
    glow = new Float32Array(n);
    helix();                                       // the grafted cells are drawn as a strand
    sizeBrain();
  })
  .catch((err) => console.warn('no brain map', err));

/**
 * The connectome's own cells are where they really are. The grafted ones have no place in a fly, so
 * they are laid out as a double helix beside the brain - a strand of something that was spliced in.
 */
function helix() {
  const g = [];
  for (let i = 0; i < POS.n; i++) if (POS.kind[i] === 3) g.push(i);
  const cx = 0.875, amp = 0.105, turns = 5.5;
  g.forEach((i, k) => {
    const t = k / Math.max(1, g.length - 1), th = t * turns * Math.PI * 2;
    const m = k % 7;
    // five cells of every seven sit on the two strands, two of them make the rung between
    const f = m < 5 ? (m % 2 ? -1 : 1) : ((m - 5) * 1.1 - 0.55);
    POS.x[i] = cx + Math.sin(th) * amp * f;
    POS.y[i] = 0.035 + t * 0.93;
  });
}
addEventListener('resize', sizeBrain);

function drawBrain(dt) {
  if (!POS || !glow) return;
  const keep = Math.exp(-dt / 0.19);
  const act = [];
  for (let i = 0; i < POS.n; i++) {
    if (glow[i] <= 0.01) { glow[i] = 0; continue; }
    if (glow[i] > 0.06) act.push(i);
    glow[i] *= keep;
  }
  for (const v of views) v.draw(act);
}
const lightUp = (fired) => { if (glow && fired) for (let k = 0; k < fired.length; k++) glow[fired[k]] = 1; };

// ---------------------------------------------------------------- a frame of the brain
// Which ring of a register is turning - and -1 while it is changing hands. A rod mid-move has its old
// ring dying and its new one coming up, and taking the larger of those as "the digit" is how a number
// that was never on the soroban ends up on the screen. So: a winner has to be firing properly and be
// well clear of the runner-up, or the rod is left alone until it settles.
const one = (v) => {
  let best = -1, second = -1, k = -1;
  for (let i = 0; i < v.length; i++) {
    if (v[i] > best) { second = best; best = v[i]; k = i; } else if (v[i] > second) second = v[i];
  }
  return best > 8 && best > second * 3 ? k : -1;
};
let lastTag = '';
const carried = new Array(NRODS).fill(false);
function paint(f) {
  let changed = false;
  f.rods.forEach((R, r) => {
    const h = one(R.h), e = one(R.e);
    if (h < 0 || e < 0) return;                        // mid-move: the rod is between two beads
    const v = h * 5 + e, was = value[r];
    if (was !== v) { value[r] = v; changed = true; }
    const c = R.cout > 2;                              // a carry going up the rods: a brighter click
    if (c && !carried[r]) clack(0.3, 1.9);
    carried[r] = c;
  });
  if (changed) stage && stage.set(value);       // the clicks come from the flies hitting them
  $('loopn').textContent = value[DIG];
  for (const t of ['tick', 'carry', 'tock', 'clear']) $('ph-' + t).classList.toggle('on', f.tag === t);
  $('ph-other').textContent = { zero: 'ZERO', wipe: 'WIPE', load: 'LOAD', read: 'READ', gap: '…' }[f.tag] || '—';
  $('ph-other').classList.toggle('on', !['tick', 'carry', 'tock', 'clear'].includes(f.tag));
  if (f.way) $('runline').textContent = f.way === '-' ? '払う' : '入れる';
  $('flyt').textContent = (f.flyMs / 1000).toFixed(1);
  $('spike').style.width = Math.min(100, f.spikes / 10) + '%';
  lastTag = f.tag;
}

// ---------------------------------------------------------------- the keypad
let a = null, b = null, op = null, entry = '', finished = false;
let buzzing = 0;        // the wing whine now playing, so it is only re-set when the wings change
let result = null;      // the sum just finished, written out over the keypad: 12 ＋ 34 ＝ 46
const sym = (o) => (o === '*' ? '×' : o === '-' ? '−' : '＋');
/** Whatever is being keyed in goes onto the beads as it is typed - the fly puts it up. */
let onBoard = null;     // what the beads are showing already - keyed in, or left there by the last sum
function show(n) {
  if (!ready || running) return;
  const want = Math.max(0, n | 0);
  if (onBoard === want) return;     // it is already up there: the fly leaves the soroban alone
  onBoard = want;
  worker.postMessage({ type: 'show', n: want });
}
/** Can the sum start from the beads as they stand? The same rule the worker uses (soroban-worker.js). */
function warmStart() {
  if (onBoard === null) return false;
  if (onBoard === a) return true;
  if (op === '+' && onBoard === b) return true;                       // adding is the same either way
  return op === '*' && onBoard === b && a >= 1 && a <= 9 && a <= b;   // so is multiplying, within a rod
}
const idleSay = () => { $('say').textContent = '式を入力してください（例: 123 ＋ 456）'; };
function tape() {
  if (result) { $('tape').textContent = result; return; }   // the finished sum stays up over the keypad
  const left = a === null ? (entry || '0') : a;
  $('tape').textContent = op ? `${left} ${sym(op)} ${a === null ? '' : (entry || (b === null ? '' : b))}` : `${left}`;
}
/**
 * 正解！ over the board: the word, and a handful of sparks thrown out of it. Purely decoration - the
 * checking is done before this is called.
 */
let tadaOff = 0;
function tada() {
  try {
    const el = $('tada');
    if (!el || !document.createElement) return;
    el.innerHTML = '<b>正解！</b>';
    for (let i = 0; i < 16; i++) {
      const sp = document.createElement('i');
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.4, d = 80 + Math.random() * 130;
      sp.style.setProperty('--dx', `${(Math.cos(a) * d).toFixed(0)}px`);
      sp.style.setProperty('--dy', `${(Math.sin(a) * d * 0.72).toFixed(0)}px`);
      sp.style.setProperty('--s', (0.5 + Math.random() * 1.3).toFixed(2));
      sp.style.animationDelay = (Math.random() * 0.2).toFixed(2) + 's';
      el.appendChild(sp);
    }
    el.hidden = false;
    clearTimeout(tadaOff);
    tadaOff = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, 1700);
  } catch (err) { /* no DOM to sparkle in */ }
}
function untada() { try { const el = $('tada'); if (el) { el.hidden = true; el.innerHTML = ''; } } catch (err) {} }

/** The key that was pressed lights up, whether it was tapped or typed. */
function flash(k) {
  if (!document.querySelector) return;
  const b = document.querySelector(`#pad button[data-k="${k}"]`);
  if (!b) return;
  b.classList.add('hit');
  clearTimeout(b.dim);
  b.dim = setTimeout(() => b.classList.remove('hit'), 110);
}
function key(k) {
  flash(k);
  untada();
  result = null;
  // a key while it is drinking: the feeder goes back where it came from, half-served or not, so the
  // fly is free to use its legs again
  if (stage) stage.stopFeed();
  check = null;
  if (k === 'C') {
    if (running) worker.postMessage({ type: 'stop' });
    a = b = op = null; entry = ''; finished = false; show(0);
    for (let r = 0; r < NRODS; r++) value[r] = 0;
    $('say').textContent = 'キーを押してください';
    $('loopline').hidden = true;
    if (stage) { stage.leave(); stage.set(value); }     // the soroban stays out, cleared
    snd.note(300, 0, 0.07, 'square', 0.12); tape(); return;
  }
  if (running) return;
  if ('0123456789'.includes(k)) {
    if (finished) { a = null; entry = ''; finished = false; }
    const max = op === '*' && a !== null ? 1 : DIG;
    if (entry.length >= max) { snd.note(240, 0, 0.05, 'square', 0.08); return; }
    entry = (entry + k).replace(/^0+(\d)/, '$1');
    snd.note(1180 + (+k) * 26, 0, 0.045, 'square', 0.17);
    // Only the first number goes onto the beads. The second one never needs to be up there: the sum
    // starts from what is standing on the soroban, so the machine has nothing to place first.
    if (op === null) show(+entry);
    tape(); return;
  }
  if (k === '=') {
    if (op === null || a === null) { $('say').textContent = '数字 → ＋ − × → 数字 → = の順に押してください'; return; }
    b = +(entry || 0); entry = ''; tape();
    snd.note(1480, 0, 0.05, 'square', 0.17); snd.note(1970, 0.06, 0.09, 'square', 0.15);
    go(); return;
  }
  finished = false;
  if (a === null) { a = +(entry || 0); entry = ''; } else if (entry) { b = +entry; entry = ''; }
  op = k; snd.note(720, 0, 0.06, 'square', 0.15); show(a); tape();
}
document.querySelectorAll('#pad button').forEach((btn) => btn.addEventListener('click', () => key(btn.dataset.k)));
addEventListener('keydown', (e) => {
  const map = { Enter: '=', '=': '=', Escape: 'C', c: 'C', Backspace: 'C', '+': '+', '-': '-', '*': '*', x: '*' };
  const k = map[e.key] || ('0123456789'.includes(e.key) ? e.key : null);
  if (k) { e.preventDefault(); key(k); }
});

// ---------------------------------------------------------------- the worker
const worker = new Worker(new URL('./soroban-worker.js?v=12', import.meta.url), { type: 'module' });
const queue = [];
worker.onerror = (e) => { $('say').textContent = 'ワーカーのエラー: ' + (e.message || e.type); };
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('say').textContent = m.what; return; }
  if (m.type === 'error') {
    $('say').textContent = '失敗: ' + m.message;
    running = false; document.body.classList.remove('running'); return;
  }
  if (m.type === 'ready') {
    ready = true; idleSay();
    if (m.build !== 'soroban-11') $('say').textContent = `古いワーカー (${m.build}) が動いています。強制リロードしてください`;
    $('build').textContent = `${m.n.toLocaleString()} ニューロン・${m.nnz.toLocaleString()} 結合`
      + `（コネクトーム ${(m.idx.n0 || 138639).toLocaleString()} + そろばん ${(m.idx.graft || 0).toLocaleString()} 細胞から切り出し、`
      + `wasm ${m.mb} MB, ${m.build}, ページ ${PAGE_V}）`;
    layout();
    return;
  }
  queue.push(m);
};
worker.postMessage({ type: 'init' });

function go() {
  if (running) return;
  if (!ready) { $('say').textContent = 'まだ脳を読み込んでいます…'; return; }
  running = true;
  queue.length = 0; acc = 0; lastTag = '';
  document.body.classList.add('running');
  $('loopline').hidden = op !== '*';   // the counting rod is only for a multiplication
  layout();                            // (it can only be measured once it is on the page)
  // ご破算で願いましては - but only when the board has to be emptied. What was keyed in is already
  // standing on the beads, so that sum starts from there and nothing is swept away.
  if (stage) stage.enter();
  if (!warmStart()) {
    if (stage) stage.sweep();
    swish();
    value.fill(0);
  }
  gotFrames = 0; runStarted = performance.now(); told = '';
  worker.postMessage({ type: 'run', a, op, b });
}
$('stop').addEventListener('click', () => worker.postMessage({ type: 'stop' }));
document.querySelectorAll('#speed button').forEach((btn) => btn.addEventListener('click', () => {
  speed = +btn.dataset.v;
  document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', x === btn));
}));
$('mute').addEventListener('click', () => { snd.setOn(!snd.on); $('mute').textContent = snd.on ? '🔊' : '🔇'; });
$('mute').textContent = snd.on ? '🔊' : '🔇';

// ---------------------------------------------------------------- the footer: one panel at a time
document.querySelectorAll('.tabbar button').forEach((btn) => btn.addEventListener('click', () => {
  document.body.dataset.tab = btn.dataset.go;
  document.querySelectorAll('.tabbar button').forEach((x) => x.setAttribute('aria-selected', String(x === btn)));
  requestAnimationFrame(() => { sizeBrain(); layout(); });     // both canvases need measuring once shown
}));

let last = performance.now(), relayout = 0, gotFrames = 0, runStarted = 0, told = '', check = null;
function screen(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  acc += dt * 1000 * speed;
  let latest = null, guard = 0;
  while (queue.length && (speed >= 99 || acc >= 20) && guard++ < 2000) {
    const m = queue.shift();
    if (m.type === 'frame') {
      if (speed < 99) acc -= 20;
      gotFrames++;
      lightUp(m.fired); latest = m; continue;
    }
    if (latest) { paint(latest); latest = null; }
    if (m.type === 'say') { $('say').textContent = m.text; continue; }
    if (m.type === 'stopped') {
      running = false; document.body.classList.remove('running');
      if (stage) stage.leave();
      onBoard = null;                        // stopped half way: what is on the beads is anyone's guess
      $('say').textContent = '途中でやめました'; continue;
    }
    if (m.type === 'done') {
      running = false; document.body.classList.remove('running');
      if (stage) { stage.leave(); stage.cheer(); }      // both forelegs up: the sum is in
      // the bell and the honey wait a moment: the beads are still sliding when the machine is done,
      // and the reward is for the board agreeing with it, not for the machine alone
      const aWas = a, bWas = b, opWas = op;
      const t = op === '*' ? a * b : op === '-' ? a - b : a + b;
      const mod = ((t % 1e8) + 1e8) % 1e8;
      // what the sum actually comes to, to check the fly against
      check = { answer: m.answer, want: String(mod).padStart(DIG, '0'), at: performance.now() + 1200 };
      // 3 rods, so anything past 999 runs off the top and anything below 0 comes round from 999
      const over = t !== mod
        ? `<span class="note">${t < 0 ? '0 を下回ったので 99999999 から戻っています' : '9 桁目は入りません（8 桁の機械なので、上の桁はあふれます）'}</span>　`
        : '';
      $('say').innerHTML = over + `計算時間：${m.wall.toFixed(2)}秒`;
      const ans = /^\d+$/.test(m.answer) ? String(+m.answer) : m.answer;
      onBoard = /^\d+$/.test(m.answer) ? +m.answer : null;   // the answer is left standing on the beads
      a = +m.answer; b = null; op = null; entry = ''; finished = true;
      result = `${aWas} ${sym(opWas)} ${bWas} ＝ ${ans}`; tape();
    }
  }
  if (latest) paint(latest);
  const board = (stage ? stage.read() : value).slice(0, DIG).reverse().join('');
  $('num').textContent = board;
  if (check && performance.now() >= check.at) {
    // right means both: the beads say what the machine says, and that is what the sum comes to
    const right = board === check.answer && check.answer === check.want;
    if (!right && check.answer !== check.want) {
      $('say').innerHTML += '　<span class="note">検算と合いません</span>';
    }
    if (right) {
      snd.note(1318, 0, 0.5, 'triangle', 0.26);          // ピンポーン
      snd.note(1046, 0.19, 0.75, 'triangle', 0.24);
      snd.note(2637, 0, 0.35, 'sine', 0.06);
      snd.note(3136, 0.34, 0.5, 'sine', 0.05);            // and a sparkle on top
      tada();
      if (stage) stage.reward();                          // and a drop of honey
    }
    check = null;
  }
  drawBrain(dt);
  relayout -= dt;
  if (relayout <= 0) { relayout = 0.5; if (!$('stagewrap').hidden) layout(); }
  if (stage) stage.frame(dt);
  // the buzz is the wings themselves: it is heard only while the fly is actually beating them,
  // and dies away with them - not while the brain is merely thinking
  const wings = stage ? Math.max(0, Math.min(1, stage.fly.buzz)) : 0;
  if (Math.abs(wings - buzzing) > 0.03 || (wings === 0 && buzzing !== 0)) {
    buzzing = wings; snd.buzz(wings, 40 * wings);
  }
  // if a sum has been asked for and nothing is coming back, say so rather than sitting there
  if (running && runStarted && performance.now() - runStarted > 3000 && gotFrames === 0) {
    $('say').textContent = '脳から反応がありません（ワーカーが動いていない可能性があります）';
    runStarted = 0;
  }
}
/** The screen must never stop: whatever goes wrong is shown and the loop carries on. */
function tickScreen(now) {
  try { screen(now); } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg !== told) { told = msg; $('say').textContent = '画面のエラー: ' + msg; console.error(err); }
  }
  requestAnimationFrame(tickScreen);
}
requestAnimationFrame(tickScreen);
tape();
