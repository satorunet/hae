// The calculator's brain, in a worker.
//
// data/keisan.fbg.gz is the FlyWire v783 connectome with 9,560 new cells grafted in - three digits of
// ring registers, their gates and their carries (soroban/machine.mjs) - cut down to the machine itself
// plus the 264 sensory cells it is wired from (soroban/bake.mjs). Every answer it gives here was checked
// against the same machine inside the whole 138,639-neuron brain before this file was written.
//
// Nothing in this worker knows how to add. It pulses sensory lines - tick, tock, clear, zero, wipe,
// plus, minus and one "run" line per digit - and reads which ring is turning. The arithmetic is the
// brain's.
import { FlyBrain } from '../flybrain/flybrain.js';

const BUILD = 'keisan-4';
const HERE = new URL('./', import.meta.url);
const SLICE = 20;                       // ms of fly per frame sent to the page
let brain = null, IDX = null, at = null, flyMs = 0, stop = false, R = null;

const ring = (c, idx) => { let s = 0; for (const i of idx) s += c[i] - at[i]; return s; };
/** Every cell that fired since the last slice, as indices (thinned if a great many did). */
function firedSince(c) {
  const hit = [];
  for (let i = 0; i < c.length; i++) if (c[i] !== at[i]) hit.push(i);
  const step = hit.length > 1600 ? Math.ceil(hit.length / 1600) : 1;
  const out = new Uint16Array(Math.ceil(hit.length / step));
  for (let k = 0, j = 0; k < hit.length; k += step) out[j++] = hit[k];
  return out;
}

/** Run one phase, sending the page a frame every SLICE ms; returns the phase's totals. */
function phase(ms, stim, tag, extra = {}) {
  brain.clearStimuli();
  if (stim && stim.length) brain.stimulate(stim, IDX.hz, { byIndex: true });
  const D = IDX.digits, tot = {
    acc: IDX.acc.map(() => new Array(10).fill(0)),
    op: IDX.op.map(() => new Array(10).fill(0)),
    carry: IDX.acc.map(() => 0), borrow: IDX.acc.map(() => 0),
  };
  for (let t = 0; t < ms; t += SLICE) {
    if (stop) throw new Error('stopped');
    const step = Math.min(SLICE, ms - t);
    brain.run(step);
    flyMs += step;
    const c = brain.counts();
    const fired = firedSince(c);                 // which cells spiked in this 20 ms, for the brain map
    const f = {
      type: 'frame', tag, ...extra, flyMs, fired,
      acc: IDX.acc.map((A) => A.m.map((r) => ring(c, r))),
      op: IDX.op.map((O) => O.m.map((r) => ring(c, r))),
      carry: IDX.acc.map((A) => ring(c, A.carry)),
      borrow: IDX.acc.map((A) => (A.borrow.length ? ring(c, A.borrow) : 0)),
    };
    at = Uint32Array.from(c);
    for (let d = 0; d < f.acc.length; d++) for (let k = 0; k < 10; k++) tot.acc[d][k] += f.acc[d][k];
    for (let d = 0; d < f.op.length; d++) for (let k = 0; k < 10; k++) tot.op[d][k] += f.op[d][k];
    for (let d = 0; d < D; d++) { tot.carry[d] += f.carry[d]; tot.borrow[d] += f.borrow[d]; }
    f.spikes = f.acc.flat().reduce((x, y) => x + y, 0) + f.op.flat().reduce((x, y) => x + y, 0);
    postMessage(f, [fired.buffer]);
  }
  const one = (v) => { const k = v.indexOf(Math.max(...v)); return Math.max(...v) > 20 ? k : -1; };
  return { acc: tot.acc.map(one), op: tot.op.map(one), tot };
}

const L = () => IDX.lines;
const zero = () => phase(IDX.ms, L().zero, 'zero');
const wipe = () => phase(IDX.ms, L().wipe, 'wipe');
const load = (d, v) => phase(IDX.ms, IDX.op[d].load[v], 'load', { d, v });
const look = () => phase(IDX.read, null, 'read');
function cycle(d, way) {
  phase(IDX.tickMs, [...L().tick, ...L().run[d], ...(way === '-' ? L().minus : L().plus)], 'tick', { d, way });
  phase(IDX.ms, L().tock, 'tock', { d });
  phase(IDX.ms, L().clear, 'clear', { d });
}
/** Turn the clock at position d until the operand register there is spent. It says when. */
function addDigit(d, way) {
  for (let n = 0; n < 10; n++) {
    if (look().op[d] === 0) return n;
    cycle(d, way);
  }
  return 10;
}
function put(n) {
  wipe();
  for (let d = 0; d < IDX.digits; d++) load(d, Math.floor(n / 10 ** d) % 10);
}
function apply(way) { for (let d = 0; d < IDX.digits; d++) addDigit(d, way); }

/**
 * Show the fly a 12x12 picture for 400 ms and ask which numeral it is - /suji/'s reading, in the same
 * brain that is holding the numbers. The answer is the compartment the picture drives least, which is
 * the one comparison that happens outside the brain (see soroban/README.md).
 */
function read(pic, tag) {
  const before = Uint32Array.from(brain.counts());
  brain.clearStimuli();
  for (let i = 0; i < pic.length; i++) if (pic[i] > R.ink) brain.stimulate(R.chan[i], R.hz * pic[i], { byIndex: true });
  brain.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: R.gainMin, gainMax: R.gainMax });
  for (let t = 0; t < R.ms; t += SLICE) {
    if (stop) throw new Error('stopped');
    brain.run(Math.min(SLICE, R.ms - t));
    flyMs += Math.min(SLICE, R.ms - t);
    const c = brain.counts();
    let lit = 0;
    for (const k of R.kc) if (c[k] - at[k]) lit++;
    const fired = firedSince(c);
    at = Uint32Array.from(c);
    postMessage({ type: 'looking', tag, lit: lit / R.kc.length, flyMs, fired }, [fired.buffer]);
  }
  const c = brain.counts(), spikes = new Uint16Array(R.kc.length);
  let lit = 0;
  for (let k = 0; k < R.kc.length; k++) { const v = c[R.kc[k]] - before[R.kc[k]]; if (v > 0) { spikes[k] = Math.min(65535, v); lit++; } }
  const drive = brain.driveByGroup(R.kc, spikes);
  let best = 0;
  for (let i = 1; i < drive.length; i++) if (drive[i] < drive[best]) best = i;
  brain.clearStimuli();
  at = Uint32Array.from(brain.counts());
  return { answer: best + 1, lit: lit / R.kc.length };
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const say = (what, pct) => postMessage({ type: 'progress', what, pct });
      IDX = await (await fetch(new URL('data/keisan.json?v=2', HERE))).json();
      say('脳をダウンロード中…', 0);
      const res = await fetch(new URL('data/keisan.fbg.gz?v=2', HERE));
      if (!res.ok) throw new Error(`keisan.fbg.gz -> HTTP ${res.status}`);
      const gz = new Uint8Array(await res.arrayBuffer());
      say('脳を展開中…', 1);
      const raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      say('脳を組み立て中…', 1);
      brain = await FlyBrain.load({ graph: raw, wasm: new URL('../flybrain/flybrain.wasm', HERE) });
      if (IDX.reading && m.read !== false) {
        say('読み方を思い出しています…', 1);
        const C = IDX.reading;
        brain.setPlasticity({ pre: C.kc, groups: C.comp.map((cells) => ({ post: cells, modulators: [] })),
          eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
        const g = await fetch(new URL('data/suji-gains.bin.gz?v=2', HERE));
        const gz = new Uint8Array(await g.arrayBuffer());
        const bytes = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        brain.importGains(new Float32Array(bytes.buffer));
        R = C;
      }
      postMessage({ type: 'ready', n: brain.n, nnz: brain.nnz, idx: { digits: IDX.digits, ms: IDX.ms, tickMs: IDX.tickMs, of: IDX.of, n0: IDX.n0, graft: IDX.graft, reads: !!R },
        mb: +(brain._x.memory.buffer.byteLength / 1048576).toFixed(1), build: BUILD });
    } catch (err) {
      postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }
  if (m.type === 'stop') { stop = true; return; }
  if (m.type === 'run') {
    stop = false;
    const { a, b, op, pics = null, seed = 1 + ((Math.random() * 1e6) | 0) } = m;
    try {
      brain.clearStimuli(); brain.reset(seed);
      at = Uint32Array.from(brain.counts()); flyMs = 0;
      const t0 = Date.now();
      zero();
      // pics: one 12x12 picture per digit, most significant first. The fly reads each one and what it
      // read is what goes into the register - which is where every wrong answer on this page comes from.
      const putRead = (which, list, digits) => {
        wipe();
        const got = [];
        for (let k = 0; k < list.length; k++) {
          const d = digits - 1 - k;                        // position 0 is the units digit
          let v;
          if (!list[k]) { v = 0; postMessage({ type: 'read', which, d, answer: 0, blank: true }); }
          else {
            const r = read(list[k], { which, d });
            v = r.answer;
            postMessage({ type: 'read', which, d, answer: v, lit: r.lit });
          }
          got.push(v);
          load(d, v);
        }
        return got.join('');
      };
      if (op !== '*') {
        postMessage({ type: 'say', text: pics ? '1 つめの数を見せています' : `1 つめの数 ${a} をレジスタに入れています` });
        if (pics) putRead('a', pics.a, IDX.digits); else put(a);
        apply('+');
        postMessage({ type: 'say', text: pics ? '2 つめの数を見せています' : `2 つめの数 ${b} を${op === '+' ? '足して' : '引いて'}います` });
        if (pics) putRead('b', pics.b, IDX.digits); else put(b);
        apply(op);
      } else {
        postMessage({ type: 'say', text: `${b} をループ用のレジスタに入れています` });
        let times = b;
        if (pics && pics.b && pics.b[pics.b.length - 1]) {
          const r = read(pics.b[pics.b.length - 1], { which: 'b', d: 0 });
          times = r.answer;
          postMessage({ type: 'read', which: 'b', d: 0, answer: times, lit: r.lit });
        }
        phase(IDX.ms, IDX.op[IDX.digits].load[times], 'load', { d: IDX.digits, v: times });
        for (let i = 0; i < 10; i++) {
          if (look().op[IDX.digits] === 0) break;
          postMessage({ type: 'say', text: `${a} を足しています（${i + 1} 周目）` });
          if (pics) putRead('a', pics.a, IDX.digits); else put(a);
          apply('+');
          cycle(IDX.digits, '+');                       // one off the loop register
        }
      }
      const r = look();
      postMessage({ type: 'done', answer: r.acc.map((k) => (k < 0 ? '?' : k)).reverse().join(''),
        flyMs, wall: (Date.now() - t0) / 1e3 });
    } catch (err) {
      if (String(err.message) !== 'stopped') postMessage({ type: 'error', message: String(err.message || err) });
      else postMessage({ type: 'stopped' });
    }
  }
};
