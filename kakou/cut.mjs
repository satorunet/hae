// Cut the talking brain down to the part of it that actually talks.
//
// /kaiwa/ was downloading 28.5 MB and holding 215 MB of wasm for two brains, nearly all of it connectome:
// 15.1 million connections at 6 bytes each. But of 138,767 neurons only **2,868 ever fire** in any of the
// twelve conditions the page runs, and only 165,631 connections (1.1%) run between those.
//
// Removing a neuron that never fires is the same thing as silencing it - its outgoing synapses were never
// delivered either way - which is the trick `flybrain/tools/build_mb_graph.mjs` uses for the reading fly.
// So: run every condition over many seeds, keep every neuron that fired even once (plus every cell the
// page drives or reads, whether it fired or not), cut the graph to those, and check that the cut brain
// reproduces the full one's answers exactly before writing it out.
//
// The cut is specific to this demo. A neuron left out is one that did nothing *here*.
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';
import { decode, encode } from './graft.mjs';

const HERE = new URL('./', import.meta.url);
const DATA = new URL('../kaiwa/data/', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const SEEDS = +(arg.seeds || 12);

const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };
const WASM = new URL('../flybrain/flybrain.wasm', HERE);

const IDX = JSON.parse(await readFile(new URL('talk783.json', DATA), 'utf8'));
const raw = new Uint8Array(gunzipSync(await readFile(new URL('talk783.fbg.gz', DATA))));
const T = IDX.talk, IN = IDX.inputs, O = IDX.outputs, P = IDX.parts;
const CUTS = ['none', 'earsA', 'earsB', 'wingsA', 'voiceB', 'blindB'];

const sum = (c, p, idx) => { let s = 0; for (const i of idx) s += c[i] - p[i]; return s; };

/** One trial on a pair of brains; `seen` (optional) collects every neuron that fired. */
function trial(A, B, m, knows, cut, seed, seen) {
  for (const x of [A, B]) { x.clearStimuli(); x.reset(seed); }
  A.stimulate(m.wants, T.HZ, { byIndex: true });
  if (knows && cut !== 'blindB') B.stimulate(m.knows, T.HZ, { byIndex: true });
  A.run(T.CUE); B.run(T.CUE);
  A.clearStimuli(); B.clearStimuli();
  let pa = Uint32Array.from(A.counts()), pb = Uint32Array.from(B.counts());
  const s0 = { a: pa, b: pb };
  let ah = -1, bh = -1;
  for (let t = 0; t < 1500; t += T.step) {
    A.run(T.step); B.run(T.step);
    const ca = A.counts(), cb = B.counts();
    const buzz = sum(ca, pa, m.buzz), click = sum(cb, pb, m.click);
    pa = Uint32Array.from(ca); pb = Uint32Array.from(cb);
    const heard = cut === 'wingsA' ? 0 : Math.min(T.CAP, buzz * T.ASK_GAIN);
    const told = cut === 'voiceB' ? 0 : Math.min(T.CAP, click * T.YES_GAIN);
    const toB = cut === 'earsB' ? 0 : heard, toA = cut === 'earsA' ? 0 : told;
    if (Math.abs(toB - bh) > 5) { B.stimulate(m.earAsk, toB, { byIndex: true }); bh = toB; }
    if (Math.abs(toA - ah) > 5) { A.stimulate(m.earYes, toA, { byIndex: true }); ah = toA; }
  }
  const ca = A.counts(), cb = B.counts();
  if (seen) for (const br of [A, B]) { const c = br.counts(); for (let i = 0; i < br.n; i++) if (c[i]) seen[i] = 1; }
  return { ask: sum(ca, s0.a, m.buzz), answer: sum(cb, s0.b, m.click), eat: ca[m.mn9] - s0.a[m.mn9] };
}

const full = { wants: IN.wants, knows: IN.knows, earAsk: IN.earAsk, earYes: IN.earYes, buzz: O.buzz, click: O.click, mn9: IDX.mn9 };
const A = await FlyBrain.load({ graph: raw, wasm: WASM, recordCapacity: 1024 });
const B = await FlyBrain.load({ graph: raw, wasm: WASM, recordCapacity: 1024 });

// ---- what fires, and what the page needs whether it fires or not
const seen = new Uint8Array(A.n);
const before = [];
console.log(`running ${CUTS.length} cuts x 2 x ${SEEDS} seeds on the whole brain...`);
for (const c of CUTS) for (const k of [true, false]) for (let s = 0; s < SEEDS; s++) {
  const r = trial(A, B, full, k, c, 41 + s * 13, seen);
  before.push({ c, k, s, ...r });
}
for (const list of [...Object.values(IN), ...Object.values(O), ...Object.values(P)]) for (const i of list) seen[i] = 1;
seen[IDX.mn9] = 1;
const keep = [];
for (let i = 0; i < A.n; i++) if (seen[i]) keep.push(i);
const at = new Int32Array(A.n).fill(-1);
keep.forEach((i, k) => { at[i] = k; });
console.log(`keeping ${keep.length} of ${A.n} neurons`);

// ---- cut the graph, in the same order
const G = decode(raw);
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
    post.push(j); w.push(G.w[q]); d++;
  }
  deg[k] = d;
});
const cutGraph = { n: keep.length, ids, deg, post: Uint32Array.from(post), w: Int16Array.from(w), header: G.header };
const bytes = encode(cutGraph);
console.log(`connections ${post.length} of ${G.nnz} (${(100 * post.length / G.nnz).toFixed(1)}%), memory ${(post.length * 6 / 1048576).toFixed(2)} MB a brain`);

// ---- does the cut brain answer the same?
const remap = (list) => list.map((i) => at[i]).filter((i) => i >= 0);
const small = { wants: remap(IN.wants), knows: remap(IN.knows), earAsk: remap(IN.earAsk), earYes: remap(IN.earYes), buzz: remap(O.buzz), click: remap(O.click), mn9: at[IDX.mn9] };
const A2 = await FlyBrain.load({ graph: bytes, wasm: WASM, recordCapacity: 1024 });
const B2 = await FlyBrain.load({ graph: bytes, wasm: WASM, recordCapacity: 1024 });
console.log(`cut brain: n=${A2.n} nnz=${A2.nnz}, wasm heap ${(A2._x.memory.buffer.byteLength / 1048576).toFixed(1)} MB`);

let same = 0, differ = 0, verdictDiffer = 0;
console.log('\ncondition     B knows |  full: ask / answer / eat  |  cut: ask / answer / eat');
for (const c of CUTS) for (const k of [true, false]) {
  const f = before.filter((x) => x.c === c && x.k === k);
  let ate1 = 0, ate2 = 0, a1 = 0, a2 = 0, n1 = 0, n2 = 0;
  for (let s = 0; s < SEEDS; s++) {
    const r = trial(A2, B2, small, k, c, 41 + s * 13);
    const g = f[s];
    if (r.ask === g.ask && r.answer === g.answer && r.eat === g.eat) same++; else differ++;
    if ((r.eat > 2) !== (g.eat > 2)) verdictDiffer++;
    ate1 += g.eat / SEEDS; ate2 += r.eat / SEEDS; a1 += g.ask / SEEDS; a2 += r.ask / SEEDS; n1 += g.answer / SEEDS; n2 += r.answer / SEEDS;
  }
  console.log(`${c.padEnd(9)} ${(k ? 'yes' : 'no ').padStart(9)} | ${a1.toFixed(0).padStart(9)} ${n1.toFixed(0).padStart(7)} ${ate1.toFixed(1).padStart(6)} | ${a2.toFixed(0).padStart(9)} ${n2.toFixed(0).padStart(7)} ${ate2.toFixed(1).padStart(6)}`);
}
console.log(`\ntrials identical spike for spike: ${same} of ${same + differ}; verdicts differing: ${verdictDiffer}`);
if (verdictDiffer) { console.error('the cut brain does not answer the same; not writing it out'); process.exit(1); }

const gz = gzipSync(bytes, { level: 9 });
await writeFile(new URL('talk-cut.fbg.gz', DATA), gz);
await writeFile(new URL('talk-cut.json', DATA), JSON.stringify({
  n: keep.length, mn9: small.mn9, from: 'talk783', kept: keep.length, of: A.n,
  inputs: { wants: small.wants, knows: small.knows, earAsk: small.earAsk, earYes: small.earYes },
  outputs: { buzz: small.buzz, click: small.click },
  parts: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, remap(v)])),
  talk: T,
}));
console.log(`\nwrote kaiwa/data/talk-cut.fbg.gz (${(gz.length / 1024).toFixed(0)} KB, was ${(28.5 * 1024).toFixed(0)} KB) and talk-cut.json`);
