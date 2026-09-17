// Bake the calculator into a graph the browser can hold, and cut it to what it actually uses.
//
// The grafted brain is the connectome plus ~9,400 new cells: 28.5 MB of .fbg and 107 MB of wasm, nearly
// all of it neurons the calculator never touches. Two cuts make it small enough for a page:
//
//   1. **Neurons that never fire.** Removing one is the same as silencing it - its outgoing synapses
//      were never delivered either way (kakou/cut.mjs). Every line is pulsed, every register is run
//      through all ten of its states, and whatever fired even once is kept.
//   2. **Synapses of weight 0.** A new cell is given 96 outgoing slots and uses a few dozen; the rest
//      point at itself with nothing in them. They deliver nothing, so they go.
//
// Then the cut brain runs the same sums and has to answer the same, digit for digit, before anything
// is written out.
//
//   node soroban/bake.mjs                 # -> soroban/data/keisan.fbg.gz + keisan.json
//   node soroban/bake.mjs digits=2
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';
import { COURSES } from '../juku/reader.mjs';
import { Workshop, encode } from '../kakou/graft.mjs';
import { build, Machine } from './machine.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const DIG = +(arg.digits || 3);
const OUT = new URL('data/', import.meta.url);
const WASM = new URL('../flybrain/flybrain.wasm', import.meta.url);
const CHECK = (arg.check || '12+34,99+1,500-321,23*4').split(',');
// min=1: keep the machine and the 24 cells per line it actually listens to, and drive those directly.
// The rest of the connectome neither reaches the machine nor hears it; what it costs is that the page's
// brain is no longer the whole animal, only the part of it this is built on.
const MIN = !!+(arg.min ?? 1);
// mb=1: keep the mushroom body as well, so the same brain can *read* the digits it is given
// (juku/reader.mjs's machinery, with /suji/'s trained weights) and then count with them.
const MB = !!+(arg.mb ?? 1);
const SAMPLES = +(arg.samples || 24);          // handwritten digits per numeral shipped to the page

const plain = await (await Workshop.open({ cells: 1 })).build();
const M = await build({ digits: DIG, plain, sub: true, loop: true, ...(arg.ms ? { ms: +arg.ms } : {}) });
const POP = M.IN;                                   // the whole sensory populations
if (MIN) M.IN = M.D;                                // or just the cells the machine is wired from
const nop = DIG + 1;
console.log(`\n${M.W.newCells} new cells, ${DIG} digits, tick ${M.o.tickMs} ms\n`);

// ---- the program the page runs, as a function of a machine
function compute(m, a, op, b, onPhase) {
  m.zero();
  if (op !== '*') {
    m.put(a); m.apply('+');
    m.put(b); m.apply(op);
  } else {
    m.setLoop(b);
    for (let i = 0; i < 10 && m.loopLeft() !== 0; i++) { m.put(a); m.apply('+'); m.tickLoop(); }
  }
  if (onPhase) onPhase();
  return m.number();
}

// ---- what fires: every line on its own, and a run that puts every register through every state
const seen = new Uint8Array(M.brain.n);
const mark = () => { const c = M.brain.counts(); for (let i = 0; i < M.brain.n; i++) if (c[i]) seen[i] = 1; };
M.reset(1);
for (const line of Object.keys(M.IN)) { M.phase(M.o.ms, M.IN[line]); mark(); }
for (const line of Object.keys(POP)) { M.phase(M.o.ms, POP[line]); mark(); }
const before = [];
for (const e of CHECK) {
  const [, a, o, b] = e.match(/^(\d+)([-+*])(\d+)$/);
  M.reset(1);
  before.push(compute(M, +a, o, +b));
  mark();
}
console.log(`the full brain: ${CHECK.map((e, i) => `${e} = ${before[i]}`).join(', ')}`);
// every ring of every register, so no gate is left out of the cut
M.reset(1); M.zero();
for (let d = 0; d < nop; d++) { M.wipe(); M.load(d, 9); M.add(d); mark(); }
M.reset(1); M.zero();
for (let d = 0; d < DIG; d++) { M.wipe(); M.load(d, 9); M.add(d, '-'); mark(); }
mark();

const graft = new Set();
for (let k = 0; k < M.W.newCells; k++) graft.add(M.W.n0 + k);
for (const i of graft) seen[i] = 1;                       // the machine is kept whether it fired or not
for (const list of Object.values(M.IN)) for (const i of list) seen[i] = 1;
if (MIN) { for (let i = 0; i < M.brain.n; i++) seen[i] = 0;
  for (const i of graft) seen[i] = 1;
  for (const list of Object.values(M.IN)) for (const i of list) seen[i] = 1; }
// the mushroom body: the fly's own learning machine, kept whole so the page can show it a picture
const mbJson = JSON.parse(await readFile(new URL('../flybrain/data/mb783.json', import.meta.url), 'utf8'));
const pickG = (p) => Object.keys(mbJson.groups).filter((k) => k.startsWith(p)).sort();
const allG = (keys) => keys.flatMap((k) => mbJson.groups[k].idx);
const KC = allG(pickG('kc:')), MBON = allG(pickG('mbon:')), DAN = allG(pickG('dan:')),
      MBIN = allG(pickG('mbin:')), ALPN = allG(pickG('alpn:'));
if (MB) for (const i of [...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]) seen[i] = 1;
const keep = [];
for (let i = 0; i < M.brain.n; i++) if (seen[i]) keep.push(i);
const at = new Int32Array(M.brain.n).fill(-1);
keep.forEach((i, k) => { at[i] = k; });
console.log(`keeping ${keep.length} of ${M.brain.n} neurons (${keep.filter((i) => !graft.has(i)).length} of the connectome's own)`);

// ---- cut the graph: kept cells only, and no synapse of weight 0
const G = M.W.baked;
const start = new Uint32Array(G.n + 1);
for (let i = 0; i < G.n; i++) start[i + 1] = start[i] + G.deg[i];
const ids = new BigUint64Array(keep.length), deg = new Uint32Array(keep.length);
const post = [], w = [];
keep.forEach((i, k) => {
  ids[k] = G.ids[i];
  let d = 0;
  for (let q = start[i]; q < start[i + 1]; q++) {
    const j = at[G.post[q]];
    if (j < 0) continue;
    if (!G.w[q] && i >= M.W.n0) continue;         // the new cells' empty slots; the connectome's rows
                                                  // are left exactly as they are, so /suji/'s learned
                                                  // weights still line up with them
    post.push(j); w.push(G.w[q]); d++;
  }
  deg[k] = d;
});
const bytes = encode({ n: keep.length, ids, deg, post: Uint32Array.from(post), w: Int16Array.from(w), header: G.header });
console.log(`connections ${post.length} of ${G.post.length} (${(100 * post.length / G.post.length).toFixed(2)}%)`);

// ---- does the cut brain answer the same?
const remap = (list) => [...list].map((i) => at[i]).filter((i) => i >= 0);
const cut = await FlyBrain.load({ graph: bytes, wasm: WASM });
const IN2 = Object.fromEntries(Object.entries(M.IN).map(([k, v]) => [k, remap(v)]));
const acc2 = M.acc.map((A) => ({ m: A.m.map(remap), s: A.s.map(remap), req: remap(A.req), carry: remap(A.carry), borrow: remap(A.borrow) }));
const op2 = M.op.map((O) => ({ m: O.m.map(remap), s: O.s.map(remap), load: O.load.map(remap) }));
const C = new Machine({ brain: cut, acc: acc2, op: op2, IN: IN2, o: M.o, digits: DIG, sub: true, loop: true, W: { n0: 0, newCells: 0 } });
console.log(`cut brain: n=${cut.n} nnz=${cut.nnz}, wasm heap ${(cut._x.memory.buffer.byteLength / 1048576).toFixed(1)} MB`);
let wrong = 0;
const t0 = Date.now();
const after = CHECK.map((e) => {
  const [, a, o, b] = e.match(/^(\d+)([-+*])(\d+)$/);
  C.reset(1);
  return compute(C, +a, o, +b);
});
const wall = (Date.now() - t0) / 1e3;
for (let i = 0; i < CHECK.length; i++) if (after[i] !== before[i]) wrong++;
console.log(`the cut brain: ${CHECK.map((e, i) => `${e} = ${after[i]}`).join(', ')}`);
console.log(`${(C.ms / 1e3).toFixed(1)} s of fly in ${wall.toFixed(1)} s of wall clock - ${(C.ms / 1e3 / wall).toFixed(1)}x real time`);
if (wrong) { console.error('the cut brain does not answer the same; not writing it out'); process.exit(1); }

// ---- can the cut brain still read? (juku/reader.mjs's setup, /suji/'s weights, MNIST's test digits)
let reading = null;
if (MB) {
  const C = COURSES.suji;
  const kc2 = remap(KC), mbon2 = remap(MBON);
  const kcIn = new Map(), mbonSet = new Set(mbon2);
  for (const k of kc2) for (const i of cut.outgoing(k, { byIndex: true }).post) if (mbonSet.has(i)) kcIn.set(i, (kcIn.get(i) || 0) + 1);
  const NL = C.labels.length;
  const comp = Array.from({ length: NL }, () => ({ cells: [], inputs: 0 }));
  for (const i of [...kcIn.keys()].sort((a, b) => kcIn.get(b) - kcIn.get(a) || a - b)) {
    let g = comp[0];
    for (const x of comp) if (x.inputs < g.inputs) g = x;
    g.cells.push(i); g.inputs += kcIn.get(i);
  }
  cut.setPlasticity({ pre: kc2, groups: comp.map((g) => ({ post: g.cells, modulators: [] })),
    eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
  const gains = new Float32Array(gunzipSync(await readFile(new URL('../juku/state/suji/brain-110217.bin.gz', import.meta.url))).buffer);
  cut.importGains(gains);
  // the picture's pixels go in where odours do, dealt across a shuffled deck of projection neurons -
  // the same deck reader.mjs deals, so the weights mean what they meant
  const npix = C.size * C.size;
  let rs = 12345;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const deck = remap(ALPN);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const chan = Array.from({ length: npix }, () => []);
  deck.forEach((p, i) => chan[i % npix].push(p));

  const rec = 145;
  const test = new Uint8Array(gunzipSync(await readFile(new URL('../juku/data/mnist12_test.bin.gz', import.meta.url))));
  const img = (n) => Float32Array.from(test.subarray(n * rec + 1, (n + 1) * rec), (v) => v / 255);
  const look = (pic) => {
    cut.clearStimuli();
    for (let i = 0; i < npix; i++) if (pic[i] > C.ink) cut.stimulate(chan[i], C.hz * pic[i], { byIndex: true });
    cut.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
    cut.reset(7);
    cut.run(C.ms, { events: false });
    const c = cut.counts(), spikes = new Uint16Array(kc2.length);
    let lit = 0;
    for (let k = 0; k < kc2.length; k++) { const v = c[kc2[k]]; if (v) { spikes[k] = Math.min(65535, v); lit++; } }
    const drive = cut.driveByGroup(kc2, spikes);
    let best = 0;
    for (let i = 1; i < NL; i++) if (drive[i] < drive[best]) best = i;
    return { answer: best + 1, lit: lit / kc2.length };
  };
  let ok = 0, n = 0, lit = 0;
  for (let i = 0; i < 180; i++) { const r = look(img(i)); ok += r.answer === test[i * rec]; lit += r.lit / 180; n++; }
  console.log(`\nthe cut brain reading MNIST with /suji/'s weights: ${ok}/${n} (${(ok / n * 100).toFixed(1)}%), ${(lit * 100).toFixed(1)}% of Kenyon cells a picture`);
  if (ok / n < 0.8) { console.error('the cut brain cannot read; not writing it out'); process.exit(1); }
  reading = { kc: kc2, alpn: remap(ALPN), comp: comp.map((g) => g.cells), chan, size: C.size,
    hz: C.hz, ink: C.ink, ms: C.ms, labels: C.labels, gainMin: C.gainMin, gainMax: C.gainMax };

  // a handful of handwritten digits for the page to show it, from the test set it never learnt from
  const per = new Map();
  for (let i = 0; i < test.length / rec && [...per.values()].reduce((a, b) => a + b.length, 0) < SAMPLES * 9; i++) {
    const d = test[i * rec];
    const list = per.get(d) || [];
    if (list.length < SAMPLES) { list.push(i); per.set(d, list); }
  }
  const pics = [];
  for (let d = 1; d <= 9; d++) for (const i of per.get(d)) pics.push(test.subarray(i * rec + 1, (i + 1) * rec));
  const blob = new Uint8Array(pics.length * 144);
  pics.forEach((p, k) => blob.set(p, k * 144));
  await mkdir(OUT, { recursive: true });
  await writeFile(new URL('suji-pics.bin.gz', OUT), gzipSync(blob, { level: 9 }));
  await writeFile(new URL('suji-gains.bin.gz', OUT), gzipSync(Buffer.from(gains.buffer), { level: 9 }));
  reading.pics = { n: SAMPLES, size: 12 };
  console.log(`wrote suji-pics.bin.gz (${SAMPLES} pictures x 9 digits) and suji-gains.bin.gz`);
}

// ---- where every kept cell is, so the page can show which part of the brain is working
// The connectome's own cells have real positions (flybrain/data/pos783.bin.gz, a frontal view of the
// brain); the grafted ones have none, so the machine is laid out as a block beside the brain.
{
  const praw = new Uint8Array(gunzipSync(await readFile(new URL('../flybrain/data/pos783.bin.gz', import.meta.url))));
  const pdv = new DataView(praw.buffer, praw.byteOffset);
  if (String.fromCharCode(...praw.subarray(0, 4)) !== 'FLYP') throw new Error('not a position file');
  const pn = pdv.getUint32(4, true);
  const PX = new Uint16Array(praw.buffer.slice(praw.byteOffset + 8, praw.byteOffset + 8 + 2 * pn));
  const PY = new Uint16Array(praw.buffer.slice(praw.byteOffset + 8 + 2 * pn, praw.byteOffset + 8 + 4 * pn));
  const mbSet = MB ? new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]) : new Set();
  const lineSet = new Set(Object.values(M.IN).flat());
  const out = new Uint8Array(keep.length * 5);
  const dvp = new DataView(out.buffer);
  const grafts = keep.filter((i) => i >= M.W.n0);
  const GW = Math.ceil(Math.sqrt(grafts.length * 1.6));
  let g = 0;
  keep.forEach((i, k) => {
    let x, y, kind;
    if (i >= M.W.n0) {                       // the machine: a block on the right
      const col = g % GW, rowy = Math.floor(g / GW), rows = Math.ceil(grafts.length / GW);
      x = 0.755 + (col / (GW - 1)) * 0.245;
      y = 0.06 + (rowy / Math.max(1, rows - 1)) * 0.88;
      kind = 3; g++;
    } else {
      x = (PX[i] / 65535) * 0.70;            // the brain: the left seven tenths
      y = PY[i] / 65535;
      kind = mbSet.has(i) ? 1 : lineSet.has(i) ? 2 : 0;
    }
    dvp.setUint16(k * 5, Math.max(0, Math.min(65535, Math.round(x * 65535))), true);
    dvp.setUint16(k * 5 + 2, Math.max(0, Math.min(65535, Math.round(y * 65535))), true);
    out[k * 5 + 4] = kind;
  });
  await mkdir(OUT, { recursive: true });
  const pgz = gzipSync(out, { level: 9 });
  await writeFile(new URL('keisan-pos.bin.gz', OUT), pgz);
  console.log(`wrote keisan-pos.bin.gz (${(pgz.length / 1024).toFixed(0)} KB, ${keep.length} cells: `
    + `${keep.filter((i) => i < M.W.n0).length} of the connectome and ${grafts.length} grafted)`);
}

// ---- write it
await mkdir(OUT, { recursive: true });
const gz = gzipSync(bytes, { level: 9 });
await writeFile(new URL('keisan.fbg.gz', OUT), gz);
const index = {
  n: cut.n, nnz: cut.nnz, digits: DIG, of: M.brain.n, n0: M.W.n0, graft: M.W.newCells, kept: keep.length,
  ms: M.o.ms, tickMs: M.o.tickMs, read: M.o.read, hz: M.o.hz,
  lines: {
    tick: IN2.tick, tock: IN2.tock, clear: IN2.clear, zero: IN2.zero, wipe: IN2.wipe,
    plus: IN2.plus, minus: IN2.minus, run: [...Array(nop).keys()].map((d) => IN2['run' + d]),
  },
  acc: acc2.map((A) => ({ m: A.m, carry: A.carry, borrow: A.borrow, req: A.req })),
  op: op2.map((O) => ({ m: O.m, load: O.load })),
  reading,
};
await writeFile(new URL('keisan.json', OUT), JSON.stringify(index));
console.log(`\nwrote soroban/data/keisan.fbg.gz (${(gz.length / 1024).toFixed(0)} KB) and keisan.json (${(JSON.stringify(index).length / 1024).toFixed(0)} KB)`);
