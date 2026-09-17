// ハエそろばん計算機の脳 - in a worker.
//
// data/soroban.fbg.gz is the FlyWire v783 connectome with a soroban grafted into it: four rods, each a
// five-bead (a one-hot pair of rings) and four one-beads (a one-hot five), and the gates that move them
// (soroban/soroban.mjs). Cut to the machine and the sensory cells it listens to, and checked against the
// same machine inside the whole 138,639-neuron brain before it was written out.
//
// Nothing here knows how to add. It pulses lines - tick, carry, take-away, borrow, tock, clear, zero,
// wipe - and reads which bead rings are turning.
import { FlyBrain } from '../flybrain/flybrain.js';

const BUILD = 'soroban-11';
const HERE = new URL('./', import.meta.url);
const SLICE = 20;
let brain = null, IDX = null, at = null, flyMs = 0, stop = false;
// what the beads are already showing because it was keyed in: a sum can start from there instead of
// wiping the board and placing the first number all over again
let onBoard = null;
// which digit each rod is showing, as far as this knows - null whenever anything has made it uncertain.
// A rod that is already showing the wanted digit is left alone: pushing a bead that is already there
// drives its ring twice over, and after a few of those the rod stops adding properly.
let boardRods = null;

const sum = (c, idx) => { let s = 0; for (const i of idx) s += c[i] - at[i]; return s; };
function firedSince(c) {
  const hit = [];
  for (let i = 0; i < c.length; i++) if (c[i] !== at[i]) hit.push(i);
  const step = hit.length > 1600 ? Math.ceil(hit.length / 1600) : 1;
  const out = new Uint16Array(Math.ceil(hit.length / step));
  for (let k = 0, j = 0; k < hit.length; k += step) out[j++] = hit[k];
  return out;
}

/** One phase, a frame to the page every 20 ms of fly; returns what each rod was showing. */
function phase(ms, stim, tag, extra = {}) {
  brain.clearStimuli();
  if (stim && stim.length) brain.stimulate(stim, IDX.hz, { byIndex: true });
  const tot = IDX.rods.map(() => ({ h: [0, 0], e: [0, 0, 0, 0, 0], cout: 0 }));
  for (let t = 0; t < ms; t += SLICE) {
    if (stop) throw new Error('stopped');
    const step = Math.min(SLICE, ms - t);
    brain.run(step);
    flyMs += step;
    const c = brain.counts();
    const fired = firedSince(c);
    const rods = IDX.rods.map((R) => ({ h: R.h.map((x) => sum(c, x)), e: R.e.map((x) => sum(c, x)), cout: sum(c, R.cout) }));
    at = Uint32Array.from(c);
    rods.forEach((R, r) => {
      for (let k = 0; k < 2; k++) tot[r].h[k] += R.h[k];
      for (let k = 0; k < 5; k++) tot[r].e[k] += R.e[k];
      tot[r].cout += R.cout;
    });
    let spikes = 0;
    for (const R of rods) spikes += R.h[0] + R.h[1] + R.e.reduce((a, b) => a + b, 0);
    postMessage({ type: 'frame', tag, ...extra, flyMs, rods, fired, spikes }, [fired.buffer]);
  }
  const one = (v) => { const k = v.indexOf(Math.max(...v)); return Math.max(...v) > 20 ? k : -1; };
  const out = tot.map((R) => { const h = one(R.h), e = one(R.e); return h < 0 || e < 0 ? -1 : h * 5 + e; });
  out.carried = tot.some((R) => R.cout > 20);
  return out;
}

const L = () => IDX.lines;
const gap = () => phase(IDX.gap, null, 'gap');
const zero = () => { const r = phase(IDX.ms, L().zero, 'zero'); boardRods = IDX.rods.map(() => 0); return r; };
const look = () => phase(IDX.read, null, 'read');
const digitsOf = (n, loopDigit = 0) =>
  IDX.rods.map((R, r) => (r < IDX.digits ? Math.floor(n / 10 ** r) % 10 : loopDigit));
/** The operand, every rod in the same pulse - they are different cells, so nothing has to wait. */
function put(n, loopDigit = 0) {
  phase(IDX.ms, L().wipe, 'wipe');
  phase(IDX.ms, digitsOf(n, loopDigit).flatMap((d, r) => IDX.rods[r].b.load[d]), 'load');
}
/** The first number is *placed* straight onto the beads, the way a hand does. One pulse. */
function placeRods(list) {
  const todo = list.map((d, r) => (d == null || (boardRods && boardRods[r] === d) ? null : d));
  // A rod is emptied before the new digit goes on, the way a hand clears a rod first: writing straight
  // over beads that are already up leaves the rod half-driven, and a long carry through it then fails.
  const dirty = todo.some((d, r) => d != null && (!boardRods || boardRods[r] !== 0));
  if (dirty) phase(IDX.ms, todo.flatMap((d, r) => (d == null ? [] : IDX.rods[r].set[0])), 'place');
  phase(IDX.ms, todo.flatMap((d, r) => (d == null ? [] : IDX.rods[r].set[d])), 'place');
  if (boardRods) list.forEach((d, r) => { if (d != null) boardRods[r] = d; });
}
const place = (n, loopDigit = 0) => placeRods(digitsOf(n, loopDigit));
/** One move of every rod at once, and the carries only if some rod actually carried. */
function move(way) {
  boardRods = null;                       // the beads are about to move on their own
  const t = phase(IDX.tickMs, way === '-' ? L().stick : L().tick, 'tick', { way });
  phase(IDX.ms, L().tock, 'tock');
  if (t.carried) {
    phase(IDX.ms, L().clear, 'clear'); gap();
    phase(IDX.tickMs, way === '-' ? L().bctick : L().ctick, 'carry', { way });
    phase(IDX.ms, L().tock, 'tock');
  }
  phase(IDX.ms, L().cclear, 'clear'); gap();
}
const shown = () => look().slice(0, IDX.digits);

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const say = (what) => postMessage({ type: 'progress', what });
      IDX = await (await fetch(new URL('data/soroban.json?v=5', HERE))).json();
      say('そろばん脳をダウンロード中…');
      const res = await fetch(new URL('data/soroban.fbg.gz?v=5', HERE));
      if (!res.ok) throw new Error(`soroban.fbg.gz -> HTTP ${res.status}`);
      const gz = new Uint8Array(await res.arrayBuffer());
      say('展開中…');
      const raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      say('組み立て中…');
      brain = await FlyBrain.load({ graph: raw, wasm: new URL('../flybrain/flybrain.wasm', HERE) });
      postMessage({ type: 'ready', n: brain.n, nnz: brain.nnz, build: BUILD,
        mb: +(brain._x.memory.buffer.byteLength / 1048576).toFixed(1),
        idx: { digits: IDX.digits, nrods: IDX.nrods, of: IDX.of, n0: IDX.n0, graft: IDX.graft } });
    } catch (err) {
      postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }
  if (m.type === 'stop') { stop = true; return; }
  // typing: the number goes straight onto the beads, so the board shows what is being keyed in
  if (m.type === 'show') {
    if (!brain) return;
    try {
      stop = false;
      if (at === null || onBoard === null) {          // a fresh board: clear it once, then keep it warm
        brain.clearStimuli(); brain.reset(1);
        at = Uint32Array.from(brain.counts()); flyMs = 0;
        zero();
      }
      place(m.n | 0);
      onBoard = m.n | 0;
    } catch (err) { onBoard = null; boardRods = null; }   // a key pressed while something else was running
    return;
  }
  if (m.type === 'run') {
    stop = false;
    let { a, b } = m;
    const { op, seed = 1 + ((Math.random() * 1e6) | 0) } = m;
    // Adding is the same either way round, and what is standing on the beads is usually the second
    // number - it was the last thing keyed in. So the machine takes it as the one already placed.
    // ... and multiplying is the same either way round too, as long as the other number still fits the
    // one counting rod.
    if (at !== null && onBoard === b && onBoard !== a
        && (op === '+' || (op === '*' && a >= 1 && a <= 9 && a <= b))) { const t = a; a = b; b = t; }
    try {
      // The first number is usually already up: it went onto the beads as it was keyed in, and an answer
      // is left standing on the board too. So the wipe and the placing are simply skipped.
      const warm = at !== null && onBoard === a && !(op === '*' && b < 1);
      onBoard = null;
      if (!warm) {
        brain.clearStimuli(); brain.reset(seed);
        boardRods = null;
        at = Uint32Array.from(brain.counts());
        flyMs = 0;
        zero();
      } else flyMs = 0;
      const t0 = Date.now();
      if (op === '*') {
        if (warm) {                                   // a is already there: count the other b - 1 times
          postMessage({ type: 'say', text: `${a} はもう置いてあります。あと ${b - 1} 回ぶんを左の棒に` });
          placeRods(IDX.rods.map((R, r) => (r < IDX.digits ? null : b - 1)));
        } else {
          postMessage({ type: 'say', text: `${b} 回ぶんを左の棒に置いています` });
          place(0, b);
        }
        for (let i = 0; i < 10; i++) {
          if (look()[IDX.digits] === 0) break;
          postMessage({ type: 'say', text: `${a} を足しています（${i + 1} 周目）` });
          put(a); move('+');
          put(0, 1); move('-');                       // one off the loop rod
        }
      } else {
        if (warm) postMessage({ type: 'say', text: `${a} はもう置いてあります` });
        else {
          postMessage({ type: 'say', text: `${a} を置いています` });
          place(a);
        }
        postMessage({ type: 'say', text: `${b} を${op === '-' ? '払って' : '入れて'}います` });
        put(b); move(op === '-' ? '-' : '+');
      }
      const full = look();
      const d = full.slice(0, IDX.digits);
      boardRods = full.some((v) => v < 0) ? null : full.slice();   // the answer is what is up now
      const answer = d.map((v) => (v < 0 ? '?' : v)).reverse().join('');
      // the answer is standing on the beads now, so a sum carried on from it starts from here
      if (!d.some((v) => v < 0)) onBoard = +answer;
      postMessage({ type: 'done', answer, flyMs, wall: (Date.now() - t0) / 1e3 });
    } catch (err) {
      onBoard = null; boardRods = null;
      if (String(err.message) !== 'stopped') postMessage({ type: 'error', message: String(err.message || err) });
      else postMessage({ type: 'stopped' });
    }
  }
};
