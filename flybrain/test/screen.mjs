// Which descending / motor neurons does each sensory input drive in the model?
//   node test/screen.mjs [HZ=150] [MS=500] [TRIALS=2] > screen.json
import { readFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';

const [HZ = 150, MS = 500, TRIALS = 2] = process.argv.slice(2).map(Number);
const G = JSON.parse(readFileSync(new URL('../data/groups783.json', import.meta.url))).groups;
const brain = await FlyBrain.load({ graph: new URL('../data/flywire783.fbg.gz', import.meta.url) });

const inputs = Object.keys(G).filter((k) => /^(shiu|gustatory|mechano|hygro|thermo|olfactory|visual|vpn):/.test(k));
const outputs = Object.keys(G).filter((k) => /^(dn|motor):/.test(k));
const result = {};
const t0 = performance.now();
for (const key of inputs) {
  brain.clearStimuli();
  brain.stimulate(G[key].idx, HZ, { byIndex: true });
  const sum = new Float64Array(brain.n);
  let spikes = 0;
  for (let k = 0; k < TRIALS; k++) {
    brain.reset(11 + k);
    spikes += brain.run(MS, { events: false }).spikes;
    const c = brain.counts();
    for (let i = 0; i < brain.n; i++) sum[i] += c[i];
  }
  const rate = (g) => G[g].idx.reduce((a, i) => a + sum[i], 0) / G[g].idx.length / TRIALS / (MS / 1000);
  const out = outputs.map((g) => [g, rate(g)]).filter(([, r]) => r > 0.5).sort((a, b) => b[1] - a[1]);
  result[key] = { n: G[key].idx.length, spikes_per_s: spikes / TRIALS / (MS / 1000), top: out.slice(0, 12).map(([g, r]) => [g, +r.toFixed(1)]) };
  process.stderr.write(`${key.padEnd(34)} n=${String(G[key].idx.length).padStart(5)}  ${out.slice(0, 5).map(([g, r]) => `${g.replace(/^(dn|motor):/, '')} ${r.toFixed(0)}`).join(', ')}\n`);
}
process.stderr.write(`screen took ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
console.log(JSON.stringify(result));
