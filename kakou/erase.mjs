// Graft 2 - erasing what graft 1 holds.
//
// The ring of graft 1 holds sugar for good: 10 s after the taste stops it is still going at the same
// rate (108 Hz a cell), and the rest of the brain is untouched. That is a latch, not a memory - what is
// written can never be taken back, so the circuit can be used once and never again.
//
// So a second population: cells fed by the taste the ring is *not* for (bitter here, standing in for
// "something else happened"), wired inhibitory onto every cell of the ring. Sugar writes, the ring
// holds, bitter clears. The question is how much inhibition it takes to put out a loop that is feeding
// itself, and whether the clear is clean - the ring silent afterwards, and still able to be written again.
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';

const BASE = new URL('../flybrain/', import.meta.url);
const groups = JSON.parse(await readFile(new URL('data/groups783.json', BASE), 'utf8')).groups;
const SUGAR = groups['shiu:sugar'].idx, BITTER = groups['shiu:bitter'].idx;
const STIM = 200, HZ = 150;
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const H = +(arg.cells || 32), G = +(arg.groups || 2), REC = +(arg.rec || 16), FEED = +(arg.feed || 60);
const STOPS = (arg.stop || '8,16,32,64,128,256').split(',').map(Number);

const plain = await (await Workshop.open({ cells: 1 })).build();
const mean = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 6; s++) {
    plain.clearStimuli(); plain.reset(10 + s); plain.stimulate(cells, HZ, { byIndex: true }); plain.run(STIM);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 6;
  }
  return m;
};
const ms = mean(SUGAR), mb = mean(BITTER);
const pick = (a, b) => [...a.keys()].filter((i) => a[i] >= 2).sort((x, y) => (a[y] - b[y]) - (a[x] - b[x])).slice(0, 24);
const drivers = pick(ms, mb), stoppers = pick(mb, ms);
console.log(`write drivers ${drivers.length} (sugar ${(drivers.reduce((s, i) => s + ms[i], 0) / drivers.length).toFixed(1)} sp/200ms)`);
console.log(`clear drivers ${stoppers.length} (bitter ${(stoppers.reduce((s, i) => s + mb[i], 0) / stoppers.length).toFixed(1)} sp/200ms)\n`);

async function build(stop) {
  const W = await Workshop.open({ cells: H, slots: Math.ceil(H / G) + 4 });
  const hold = W.cells(H);
  const ring = [...Array(G)].map((_, k) => hold.filter((_, i) => i % G === k));
  W.wire(drivers, ring[0], FEED);
  for (let k = 0; k < G; k++) W.wire(ring[k], ring[(k + 1) % G], REC);
  if (stop) W.wire(stoppers, hold, -stop);             // negative = inhibitory
  return { brain: await W.build(), hold };
}

// write (sugar 200 ms) -> hold 500 ms -> clear (bitter 200 ms) -> watch 1000 ms -> write again
async function episode(brain, hold, { clear = true, seed = 7 } = {}) {
  const win = [];
  let at;
  const phase = (ms) => { brain.run(ms); const c = brain.counts(); const k = hold.reduce((s, i) => s + (c[i] - at[i]), 0); at = Uint32Array.from(c); return k; };
  brain.clearStimuli(); brain.reset(seed); at = Uint32Array.from(brain.counts());
  brain.stimulate(SUGAR, HZ, { byIndex: true }); win.push(['write', phase(STIM)]);
  brain.clearStimuli(); win.push(['hold 500', phase(500)]);
  if (clear) { brain.stimulate(BITTER, HZ, { byIndex: true }); win.push(['clear', phase(STIM)]); brain.clearStimuli(); }
  else win.push(['(no clear)', phase(STIM)]);
  win.push(['after 500', phase(500)]);
  win.push(['after 1000', phase(1000)]);
  brain.stimulate(SUGAR, HZ, { byIndex: true }); win.push(['rewrite', phase(STIM)]);
  brain.clearStimuli(); win.push(['hold 500', phase(500)]);
  return win;
}

console.log('stop   write   hold500    clear   after500  after1000   rewrite  hold500     verdict');
for (const stop of STOPS) {
  const { brain, hold } = await build(stop);
  const w = await episode(brain, hold);
  const n = w.map(([, v]) => v);
  const cleared = n[3] === 0 && n[4] === 0, rewritable = n[6] > 0;
  console.log(`${String(stop).padStart(4)} ${n.map((v) => String(v).padStart(8)).join(' ')}   ${cleared ? (rewritable ? 'cleared, writable again' : 'cleared but dead') : 'still holding'}`);
}
