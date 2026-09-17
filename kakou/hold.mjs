// Graft 1 - a holding circuit. Can new cells keep firing after the taste is gone?
//
// The unmutated brain forgets in about 50 ms: 200 ms of sugar, and 50 ms after it stops the whole brain
// is silent (0 spikes of 138,639 neurons), so nothing downstream can still tell sugar from bitter.
//
// First try, all-to-all: 32 new cells fed by the 24 cells that answer sugar and not bitter, and wired to
// each other. It does not hold - at any recurrent strength from 1 to 8 synapses the cells fire once after
// the stimulus and stop. They all fire together, so the volley they send each other arrives while every
// one of them is refractory, and this model drops synaptic input that reaches a refractory neuron
// (flybrain's README: reproduced from Brian2's generated code, and worth ~30% of downstream rate).
// Self-excitation that is synchronous puts itself out.
//
// So: a ring. The cells are split into `groups`, and each group excites only the next one, so the
// activity travels round instead of firing at once and each group is fed when it is out of its refractory
// period (2.2 ms; a lap of G groups takes at least G x 1.8 ms of synaptic delay).
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';

const BASE = new URL('../flybrain/', import.meta.url);
const groups = JSON.parse(await readFile(new URL('data/groups783.json', BASE), 'utf8')).groups;
const SUGAR = groups['shiu:sugar'].idx, BITTER = groups['shiu:bitter'].idx;
const STIM = 200, HZ = 150, SEEDS = 4;
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const H = +(arg.cells || 32), NDRV = +(arg.drivers || 24), FEED = +(arg.feed || 60);
const GS = (arg.groups || '1,2,3,4,6,8').split(',').map(Number);
const RECS = (arg.rec || '4,8,16,32').split(',').map(Number);
const AFTER = +(arg.after || 1000);
const STEP = 25;

const plain = await (await Workshop.open({ cells: 1 })).build();
const stimCounts = (cells, seed) => {
  plain.clearStimuli(); plain.reset(seed); plain.stimulate(cells, HZ, { byIndex: true });
  plain.run(STIM); return Uint32Array.from(plain.counts());
};
const mean = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 6; s++) { const c = stimCounts(cells, 10 + s); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 6; }
  return m;
};
const ms = mean(SUGAR), mb = mean(BITTER);
const drivers = [...ms.keys()].filter((i) => ms[i] >= 2).sort((a, b) => (ms[b] - mb[b]) - (ms[a] - mb[a])).slice(0, NDRV);
console.log(`drivers ${drivers.length} (sugar ${(drivers.reduce((s, i) => s + ms[i], 0) / drivers.length).toFixed(1)} vs bitter ${(drivers.reduce((s, i) => s + mb[i], 0) / drivers.length).toFixed(2)} spikes/200 ms), hold ${H} cells, feed ${FEED}\n`);

async function run(G, rec) {
  const W = await Workshop.open({ cells: H, slots: Math.ceil(H / G) + 4 });
  const hold = W.cells(H);
  const ring = [...Array(G)].map((_, k) => hold.filter((_, i) => i % G === k));
  W.wire(drivers, ring[0], FEED);                          // the wave is started in one place
  for (let k = 0; k < G; k++) if (rec && G > 1) W.wire(ring[k], ring[(k + 1) % G], rec);
  if (G === 1 && rec) W.wire(hold, hold, rec, { self: false });
  const brain = await W.build();
  const out = {};
  for (const [name, cells] of [['sugar', SUGAR], ['bitter', BITTER]]) {
    let held = 0, after = 0, during = 0, rate = 0;
    for (let s = 0; s < SEEDS; s++) {
      brain.clearStimuli(); brain.reset(100 + s);
      brain.stimulate(cells, HZ, { byIndex: true });
      brain.run(STIM);
      let at = Uint32Array.from(brain.counts());
      during += hold.reduce((t, i) => t + at[i], 0) / SEEDS / H;
      brain.clearStimuli();
      let alive = 0, tot = 0;
      for (let t = 0; t < AFTER; t += STEP) {
        brain.run(STEP);
        const c = brain.counts();
        const k = hold.reduce((sum, i) => sum + (c[i] - at[i]), 0);
        at = Uint32Array.from(c);
        tot += k;
        if (k > 0) alive = t + STEP;
      }
      held += alive / SEEDS; after += tot / SEEDS / H;
      rate += brain.activeCount / SEEDS;
    }
    out[name] = { during, after, held, rate };
  }
  return out;
}

console.log('groups  rec   during/cell   after/cell   held(ms)   |  bitter after/cell  held(ms)');
for (const G of GS) for (const rec of RECS) {
  const r = await run(G, rec);
  console.log(`${String(G).padStart(6)} ${String(rec).padStart(4)} ${r.sugar.during.toFixed(1).padStart(13)} ${r.sugar.after.toFixed(1).padStart(12)} ${String(Math.round(r.sugar.held)).padStart(10)}   | ${r.bitter.after.toFixed(1).padStart(16)} ${String(Math.round(r.bitter.held)).padStart(9)}`);
}
