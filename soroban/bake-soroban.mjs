// Bake the soroban into a graph the browser can hold (soroban/bake.mjs, for the other machine).
//
//   node soroban/bake-soroban.mjs            # -> soroban/data/soroban.fbg.gz + .json + -pos.bin.gz
//   node soroban/bake-soroban.mjs ms=100
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';
import { Workshop, encode } from '../kakou/graft.mjs';
import { build, Soroban } from './soroban.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const DIG = +(arg.digits || 3);
const OUT = new URL('data/', import.meta.url);
const WASM = new URL('../flybrain/flybrain.wasm', import.meta.url);
const CHECK = (arg.check || '12+34,99+1,777+345,908+92,9+9,500-321,12-30,100-1,7*8,23*4').split(',');
const LOOP = !!+(arg.loop ?? 1);            // the extra rod that counts the rounds of a multiplication

const plain = await (await Workshop.open({ cells: 1 })).build();
const S = await build({ digits: DIG, plain, loop: LOOP, ...(arg.ms ? { ms: +arg.ms } : {}) });
S.IN = S.D;                                 // drive only the cells the machine listens to
console.log(`\n${S.W.newCells} new cells, ${DIG} rods, tick ${S.o.tickMs} ms\n`);

function run(M, e) {
  const [, a, op, b] = e.match(/^(\d+)([-+*])(\d+)$/);
  M.reset(1); M.zero();
  if (op === '*') { M.times(+a, +b); return M.number(); }
  M.place(+a);                                  // the first number is placed, not added
  M.put(+b); M.add(op === '-' ? '-' : '+');
  return M.number();
}
const seen = new Uint8Array(S.brain.n);
const mark = () => { const c = S.brain.counts(); for (let i = 0; i < S.brain.n; i++) if (c[i]) seen[i] = 1; };
const before = CHECK.map((e) => { const r = run(S, e); mark(); return r; });
console.log(`the full brain: ${CHECK.map((e, i) => `${e} = ${before[i]}`).join(', ')}`);
// every bead of every rod, so no gate is left out of the cut
S.reset(1); S.zero();
for (const n of [999, 555, 111, 444]) { S.place(n); S.put(n); S.add('+'); mark(); }
for (const n of [999, 555, 111, 444]) { S.put(n); S.add('-'); mark(); }
for (let d = 0; d < 10; d++) { S.place(d * 111, d); mark(); }      // every bead-placing cell
S.setLoop(9); S.tickLoop(); mark();

const graft = new Set();
for (let k = 0; k < S.W.newCells; k++) graft.add(S.W.n0 + k);
for (let i = 0; i < S.brain.n; i++) seen[i] = 0;
for (const i of graft) seen[i] = 1;
for (const list of Object.values(S.IN)) for (const i of list) seen[i] = 1;
const keep = [];
for (let i = 0; i < S.brain.n; i++) if (seen[i]) keep.push(i);
const at = new Int32Array(S.brain.n).fill(-1);
keep.forEach((i, k) => { at[i] = k; });
console.log(`keeping ${keep.length} of ${S.brain.n} neurons (${keep.filter((i) => !graft.has(i)).length} of the connectome's own)`);

const G = S.W.baked;
const start = new Uint32Array(G.n + 1);
for (let i = 0; i < G.n; i++) start[i + 1] = start[i] + G.deg[i];
const ids = new BigUint64Array(keep.length), deg = new Uint32Array(keep.length);
const post = [], w = [];
keep.forEach((i, k) => {
  ids[k] = G.ids[i];
  let d = 0;
  for (let q = start[i]; q < start[i + 1]; q++) {
    const j = at[G.post[q]];
    if (j < 0 || !G.w[q]) continue;
    post.push(j); w.push(G.w[q]); d++;
  }
  deg[k] = d;
});
const bytes = encode({ n: keep.length, ids, deg, post: Uint32Array.from(post), w: Int16Array.from(w), header: G.header });
console.log(`connections ${post.length} of ${G.post.length} (${(100 * post.length / G.post.length).toFixed(2)}%)`);

const remap = (list) => [...list].map((i) => at[i]).filter((i) => i >= 0);
const cut = await FlyBrain.load({ graph: bytes, wasm: WASM });
const IN2 = Object.fromEntries(Object.entries(S.IN).map(([k, v]) => [k, remap(v)]));
const rods2 = S.rods.map((R) => ({
  h: R.h.map(remap), e: R.e.map(remap), hs: R.hs.map(remap), es: R.es.map(remap),
  c5: remap(R.c5), c5no: remap(R.c5no), cout: remap(R.cout), set: R.set.map(remap),
  b: { h: R.b.h.map(remap), e: R.b.e.map(remap), load: R.b.load.map(remap) },
}));
const C = new Soroban({ brain: cut, rods: rods2, IN: IN2, o: S.o, digits: DIG, nrods: S.nrods, loop: LOOP, W: { n0: 0, newCells: 0 } });
console.log(`cut brain: n=${cut.n} nnz=${cut.nnz}, wasm heap ${(cut._x.memory.buffer.byteLength / 1048576).toFixed(1)} MB`);
const t0 = Date.now();
let fly = 0;
const after = CHECK.map((e) => { const r = run(C, e); fly += C.ms / 1e3; return r; });
const wall = (Date.now() - t0) / 1e3;
console.log(`the cut brain: ${CHECK.map((e, i) => `${e} = ${after[i]}`).join(', ')}`);
console.log(`${fly.toFixed(1)} s of fly in ${wall.toFixed(1)} s of wall clock - ${(fly / wall).toFixed(1)}x real time`);
if (after.some((v, i) => v !== before[i])) { console.error('the cut brain does not answer the same; not writing it out'); process.exit(1); }

// ---- where each cell is, for the page's brain map
{
  const praw = new Uint8Array(gunzipSync(await readFile(new URL('../flybrain/data/pos783.bin.gz', import.meta.url))));
  const pdv = new DataView(praw.buffer, praw.byteOffset);
  const pn = pdv.getUint32(4, true);
  const PX = new Uint16Array(praw.buffer.slice(praw.byteOffset + 8, praw.byteOffset + 8 + 2 * pn));
  const PY = new Uint16Array(praw.buffer.slice(praw.byteOffset + 8 + 2 * pn, praw.byteOffset + 8 + 4 * pn));
  const lineSet = new Set(Object.values(S.IN).flat());
  const out = new Uint8Array(keep.length * 5);
  const dvp = new DataView(out.buffer);
  const grafts = keep.filter((i) => i >= S.W.n0);
  const GW = Math.ceil(Math.sqrt(grafts.length * 1.6));
  let g = 0;
  keep.forEach((i, k) => {
    let x, y, kind;
    if (i >= S.W.n0) {
      const col = g % GW, row = Math.floor(g / GW), rows = Math.ceil(grafts.length / GW);
      x = 0.755 + (col / (GW - 1)) * 0.245;
      y = 0.06 + (row / Math.max(1, rows - 1)) * 0.88;
      kind = 3; g++;
    } else {
      x = (PX[i] / 65535) * 0.70; y = PY[i] / 65535;
      kind = lineSet.has(i) ? 2 : 0;
    }
    dvp.setUint16(k * 5, Math.round(x * 65535), true);
    dvp.setUint16(k * 5 + 2, Math.round(y * 65535), true);
    out[k * 5 + 4] = kind;
  });
  await mkdir(OUT, { recursive: true });
  await writeFile(new URL('soroban-pos.bin.gz', OUT), gzipSync(out, { level: 9 }));

  // and the whole brain, thinned and quantised, so the page can draw the fly's own outline behind it
  const step = 6;                                   // every sixth neuron is plenty for a faint shape
  const n2 = Math.floor(pn / step);
  const outline = new Uint8Array(n2 * 2);
  for (let k = 0; k < n2; k++) {
    const i = k * step;
    outline[k * 2] = Math.round((PX[i] / 65535) * 0.70 * 255);
    outline[k * 2 + 1] = Math.round((PY[i] / 65535) * 255);
  }
  const ogz = gzipSync(outline, { level: 9 });
  await writeFile(new URL('brain-outline.bin.gz', OUT), ogz);
  console.log(`wrote brain-outline.bin.gz (${(ogz.length / 1024).toFixed(0)} KB, ${n2} of ${pn} neurons)`);
}

await mkdir(OUT, { recursive: true });
const gz = gzipSync(bytes, { level: 9 });
await writeFile(new URL('soroban.fbg.gz', OUT), gz);
const index = {
  n: cut.n, nnz: cut.nnz, digits: DIG, nrods: S.nrods, loop: LOOP, of: S.brain.n, n0: S.W.n0, graft: S.W.newCells,
  ms: S.o.ms, tickMs: S.o.tickMs, read: S.o.read, gap: S.o.gap, hz: S.o.hz,
  lines: IN2,
  rods: rods2.map((R) => ({ h: R.h, e: R.e, cout: R.cout, set: R.set, b: { h: R.b.h, e: R.b.e, load: R.b.load } })),
};
await writeFile(new URL('soroban.json', OUT), JSON.stringify(index));
console.log(`\nwrote soroban/data/soroban.fbg.gz (${(gz.length / 1024).toFixed(0)} KB) and soroban.json (${(JSON.stringify(index).length / 1024).toFixed(0)} KB)`);
