/**
 * Aversive and appetitive olfactory conditioning in the mushroom body.
 *
 *     node test/learn.mjs
 *
 * Pair one odour with dopamine and the KC->MBON synapses that carried it
 * weaken, so that odour's MBON response falls while a second odour's does not,
 * and only the compartments the paired DANs end in are touched.
 */
import { readFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';

const HERE = new URL('.', import.meta.url).pathname;
const G = JSON.parse(readFileSync(HERE + '../data/mb783.json')).groups;
const CM = JSON.parse(readFileSync(HERE + '../data/mbcompart783.json'));
const pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
const all = (keys) => keys.flatMap((k) => G[k].idx);

const brain = await FlyBrain.load({ graph: HERE + '../data/flywire783.fbg.gz' });
const KC = all(pick('kc:')), MBON = all(pick('mbon:')), DAN = all(pick('dan:')),
      MBIN = all(pick('mbin:')), ALPN = all(pick('alpn:'));

// The mushroom body on its own. The whole-brain model has a self-sustaining
// runaway that any olfactory drive tips it into, so the rest is switched off.
const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);
const outside = [];
for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
brain.silence(outside, true, { byIndex: true });

const mbonTypes = pick('mbon:');
const groups = mbonTypes.map((m) => ({
  post: G[m].idx,
  modulators: Object.entries(CM.gate[m]).flatMap(([d, w]) => G[d].idx.map((i) => [i, w])),
}));
brain.setPlasticity({ pre: KC, groups, eta: 0, tauTrace: 40, tauDopa: 100, gainMin: 0.05 });

// two odours: alternate glomeruli, so both are broad but barely overlap
const ats = pick('alpn:');
const ODOUR = { A: all(ats.filter((_, i) => i % 2 === 0)), B: all(ats.filter((_, i) => i % 2 === 1)) };
const PUNISH = pick('dan:').filter((k) => /PPL1/.test(k)).flatMap((k) => G[k].idx);
const REWARD = pick('dan:').filter((k) => /PAM/.test(k)).flatMap((k) => G[k].idx);
const HZ = 100, ETA = 2e-5;

const rates = (odour) => {
  brain.setPlasticityParams({ eta: 0 });
  brain.clearStimuli();
  brain.stimulate(ODOUR[odour], HZ, { byIndex: true });
  brain.reset(1);
  brain.run(1000, { events: false });
  const c = brain.counts();
  return Object.fromEntries(mbonTypes.map((m) =>
    [m, G[m].idx.reduce((a, i) => a + c[i], 0) / G[m].idx.length]));
};
const pair = (odour, dans, k) => {
  brain.setPlasticityParams({ eta: ETA, tauTrace: 40, tauDopa: 100, gainMin: 0.05 });
  brain.clearStimuli();
  brain.stimulate(ODOUR[odour], HZ, { byIndex: true });
  brain.stimulate(dans, 80, { byIndex: true });
  brain.reset(100 + k);
  brain.run(1000, { events: false });
};

const kcActive = (odour) => {
  brain.setPlasticityParams({ eta: 0 });
  brain.clearStimuli(); brain.stimulate(ODOUR[odour], HZ, { byIndex: true });
  brain.reset(1); brain.run(1000, { events: false });
  const c = brain.counts(), on = new Set();
  for (const i of KC) if (c[i]) on.add(i);
  return on;
};
const onA = kcActive('A'), onB = kcActive('B');
let inter = 0;
for (const i of onA) if (onB.has(i)) inter++;
console.log(`Kenyon cells firing: odour A ${(100 * onA.size / KC.length).toFixed(1)}%, ` +
  `odour B ${(100 * onB.size / KC.length).toFixed(1)}%, ` +
  `shared ${(100 * inter / (onA.size + onB.size - inter)).toFixed(1)}% (Jaccard)`);

for (const [label, dans] of [['punishment (PPL1)', PUNISH], ['reward (PAM)', REWARD]]) {
  brain.forget();
  const base = { A: rates('A'), B: rates('B') };
  const shown = mbonTypes.filter((m) => base.A[m] > 2 || base.B[m] > 2);
  console.log(`\n== odour A paired with ${label}, ${dans.length} DANs at 80 Hz, eta ${ETA} ==`);
  console.log('trial | ' + shown.map((m) => m.slice(5).padStart(7)).join('') + '   |' +
              shown.map((m) => m.slice(5).padStart(7)).join(''));
  console.log('      |' + ' odour A (paired)'.padEnd(7 * shown.length + 1) + ' | odour B (control)');
  for (let k = 0; k <= 4; k++) {
    if (k) pair('A', dans, k);
    const a = rates('A'), b = rates('B');
    console.log(`${String(k).padStart(5)} | ` + shown.map((m) => a[m].toFixed(1).padStart(7)).join('') +
                '   |' + shown.map((m) => b[m].toFixed(1).padStart(7)).join(''));
  }
  const gains = mbonTypes.map((m, c) => [m, brain.gain(c)]).filter(([, g]) => g < 0.999)
    .sort((x, y) => x[1] - y[1]);
  console.log('compartments depressed: ' + (gains.length
    ? gains.slice(0, 8).map(([m, g]) => `${m.slice(5)} ${g.toFixed(2)}`).join('  ') : 'none'));
  const spared = mbonTypes.map((m, c) => [m, brain.gain(c)]).filter(([, g]) => g > 0.99);
  console.log('compartments untouched: ' + spared.length + ' of ' + mbonTypes.length);
}
