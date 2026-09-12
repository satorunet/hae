// Compare flybrain (wasm) against Brian2 on the paper's sugar experiment.
//
//   node test/validate.mjs BRIAN_RATES.json [HZ=150] [TRIALS=30]
//
// BRIAN_RATES.json: { "brian150": { "<flywire id>": [rate, std], ... }, ... }
import { readFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';

const [ratesPath, hzArg = '150', trialsArg = '30'] = process.argv.slice(2);
const HZ = Number(hzArg), TRIALS = Number(trialsArg);
const REF = JSON.parse(readFileSync(ratesPath, 'utf8'))[HZ === 150 ? 'brian150' : 'orig200'];

const SUGAR = ['720575940624963786', '720575940630233916', '720575940637568838',
  '720575940638202345', '720575940617000768', '720575940630797113', '720575940632889389',
  '720575940621754367', '720575940621502051', '720575940640649691', '720575940639332736',
  '720575940616885538', '720575940639198653', '720575940620900446', '720575940617937543',
  '720575940632425919', '720575940633143833', '720575940612670570', '720575940628853239',
  '720575940629176663', '720575940611875570'];
const MN9 = '720575940660219265';

let t = performance.now();
const brain = await FlyBrain.load();
console.log(`load ${((performance.now() - t) / 1000).toFixed(2)} s  (${brain.n.toLocaleString()} neurons, ${brain.nnz.toLocaleString()} connections)`);

brain.stimulate(SUGAR, HZ);
const sum = new Float64Array(brain.n), sq = new Float64Array(brain.n);
let spikes = 0, peakActive = 0;
t = performance.now();
for (let k = 0; k < TRIALS; k++) {
  brain.reset(1000 + k);
  for (let ms = 0; ms < 1000; ms += 50) {
    spikes += brain.run(50, { events: false }).spikes;
    peakActive = Math.max(peakActive, brain.activeCount);
  }
  const c = brain.counts();
  for (let i = 0; i < brain.n; i++) if (c[i]) { sum[i] += c[i]; sq[i] += c[i] * c[i]; }
}
const wall = (performance.now() - t) / 1000;

const rate = new Map();
for (let i = 0; i < brain.n; i++) if (sum[i]) rate.set(String(brain.id(i)), sum[i] / TRIALS);

const keys = new Set([...rate.keys(), ...Object.keys(REF)]);
const a = [], b = [];
for (const k of keys) { a.push(REF[k]?.[0] ?? 0); b.push(rate.get(k) ?? 0); }
const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
const ma = mean(a), mb = mean(b);
let sab = 0, saa = 0, sbb = 0;
for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
const corr = sab / Math.sqrt(saa * sbb);
const both = [...rate.keys()].filter((k) => REF[k]).length;
const mn9i = brain.index(MN9);
const mn9 = sum[mn9i] / TRIALS, mn9sd = Math.sqrt(sq[mn9i] / TRIALS - mn9 * mn9);

console.log(`simulated ${TRIALS} x 1 s at ${HZ} Hz in ${wall.toFixed(2)} s  (${(wall / TRIALS * 1000).toFixed(0)} ms per simulated second, peak active ${peakActive.toLocaleString()})`);
console.log(`spikes          wasm ${spikes.toLocaleString()}   brian ${Object.values(REF).reduce((p, r) => p + r[0], 0) * TRIALS | 0}`);
console.log(`active neurons  wasm ${rate.size}   brian ${Object.keys(REF).length}   both ${both}`);
console.log(`MN9             wasm ${mn9.toFixed(1)} ± ${mn9sd.toFixed(1)} Hz   brian ${REF[MN9][0].toFixed(1)} ± ${REF[MN9][1].toFixed(1)} Hz`);
console.log(`rate correlation (pearson, per neuron): ${corr.toFixed(4)}`);

// neurons where the two disagree by more than 3 combined standard errors
const se = (sd) => sd / Math.sqrt(TRIALS);
const off = [];
for (const k of keys) {
  const r0 = REF[k]?.[0] ?? 0, s0 = REF[k]?.[1] ?? 0;
  const i = brain.index(k), r1 = rate.get(k) ?? 0;
  const s1 = i >= 0 ? Math.sqrt(Math.max(0, sq[i] / TRIALS - r1 * r1)) : 0;
  const z = Math.abs(r1 - r0) / Math.max(0.5, Math.hypot(se(s0), se(s1)));
  if (z > 3) off.push([k, r0, r1, z]);
}
off.sort((p, q) => q[3] - p[3]);
console.log(`neurons differing by > 3 SE: ${off.length} of ${keys.size}`);
for (const [k, r0, r1, z] of off.slice(0, 8)) console.log(`  ${k}  brian ${r0.toFixed(1)}  wasm ${r1.toFixed(1)}  z=${z.toFixed(1)}`);
