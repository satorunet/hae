// How hard you may write to a ring.
//
// kakou's `W.memory()` writes a ring with 60 synapses from each driver, and that is what graft 1 was
// measured with - drivers being cells *downstream* of the taste, firing 28 spikes in 200 ms. This
// machine drives its lines directly (the tick is a mechanosensory population at 150 Hz), and at 60
// synapses the ring takes the write and then dies. The reason is graft 1's own reason: a ring holds
// because the wave travels round and each group is fed out of its refractory period. Write it hard
// enough and every cell fires together, so the volley they send each other lands in the refractory
// period and this model drops it - the same failure as all-to-all self-excitation, arriving through
// the write instead of through the ring.
//
//   node soroban/write.mjs
import { Workshop } from '../kakou/graft.mjs';
import { G, drivers } from './lines.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const IN = { a: G('visual:ocellar:L+visual:ocellar:R'), b: G('mechano:JO_wind_gravity:L+mechano:JO_wind_gravity:R') };
const plain = await (await Workshop.open({ cells: 1 })).build();
const D = drivers(plain, IN, { quiet: true });
const FEEDS = (arg.feed || '4,8,12,16,24,32,60').split(',').map(Number);
const SEEDS = +(arg.seeds || 3);

async function hold(groups, rec, feed) {
  const W = await Workshop.open({ cells: 32, slots: 32 });
  const m = W.memory(32, { groups, rec });
  W.wire(D.a, m.ring[0], feed);
  const brain = await W.build();
  let write = 0, after = 0, ok = 0;
  for (let s = 1; s <= SEEDS; s++) {
    brain.clearStimuli(); brain.reset(s); brain.stimulate(IN.a, 150, { byIndex: true });
    brain.run(200);
    let at = Uint32Array.from(brain.counts());
    write += m.reduce((t, i) => t + at[i], 0) / SEEDS;
    brain.clearStimuli();
    let last = 0;
    for (let k = 0; k < 3; k++) {
      brain.run(200); const c = brain.counts();
      last = m.reduce((t, i) => t + (c[i] - at[i]), 0); at = Uint32Array.from(c);
    }
    after += last / SEEDS; ok += last > 300 ? 1 : 0;
  }
  return { write, after, ok };
}

console.log(`32 cells, written for 200 ms by ${D.a.length} cells firing at 150 Hz, then watched for 600 ms\n`);
console.log('groups  rec |' + FEEDS.map((f) => `  feed ${String(f).padStart(2)}`).join('') + '   (spikes in the last 200 ms)');
for (const [groups, rec] of [[2, 16], [2, 8], [3, 16], [3, 32], [4, 32]]) {
  const row = [];
  for (const f of FEEDS) { const r = await hold(groups, rec, f); row.push(`${(r.ok === SEEDS ? String(Math.round(r.after)) : r.ok ? `${Math.round(r.after)}?` : 'out').padStart(9)}`); }
  console.log(`${String(groups).padStart(6)} ${String(rec).padStart(4)} |${row.join('')}`);
}
console.log(`\n"out" = the ring took the write and went out, on all ${SEEDS} seeds; "n?" = it held on some of them.`);
console.log('A machine wants a write that holds every time, whichever ring and whoever writes it, which');
console.log('is why soroban/machine.mjs writes with 16 rather than kakou\'s 60.');
