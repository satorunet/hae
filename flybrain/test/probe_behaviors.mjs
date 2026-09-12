// Targeted probes for the fly simulator's body mapping (v783).
import { readFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';

const G = JSON.parse(readFileSync(new URL('../data/groups783.json', import.meta.url))).groups;
const b = await FlyBrain.load({ graph: new URL('../data/flywire783.fbg.gz', import.meta.url) });
const ix = (...keys) => keys.flatMap((k) => (G[k] ? G[k].idx : []));
const MS = 500;

function trial(stims, outs, trials = 2) {
  const sum = new Float64Array(b.n);
  let spikes = 0;
  for (let k = 0; k < trials; k++) {
    b.clearStimuli();
    for (const [idx, hz] of stims) b.stimulate(idx, hz, { byIndex: true });
    b.reset(21 + k);
    spikes += b.run(MS, { events: false }).spikes;
    const c = b.counts();
    for (let i = 0; i < b.n; i++) sum[i] += c[i];
  }
  const r = (idx) => (idx.length ? idx.reduce((a, i) => a + sum[i], 0) / idx.length / trials / (MS / 1000) : NaN);
  return { total: spikes / trials / (MS / 1000), out: Object.fromEntries(outs.map((o) => [o, r(ix(o))])) };
}
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k.replace(/^(dn|motor):/, '')} ${Number.isNaN(v) ? '-' : v.toFixed(0)}`).join('  ');

console.log('--- runaway threshold vs rate (total spikes/s) ---');
for (const key of ['olfactory:ORN_DM1:L', 'olfactory:ORN_DM2:L', 'olfactory:ORN_VA2:L', 'olfactory:ORN_V:L',
  'thermo:heating:L', 'hygro:moist:L', 'visual:R1-6:L', 'gustatory:sugar_water:R']) {
  const row = [];
  for (const hz of [10, 20, 40, 80]) row.push(`${hz}Hz ${(trial([[ix(key), hz]], [], 1).total / 1000).toFixed(0)}k`);
  console.log(key.padEnd(26), row.join('   '));
}

console.log('\n--- smell on one side: lateralized steering? (40 Hz) ---');
const steer = ['dn:DNa02:L', 'dn:DNa02:R', 'dn:DNa01:L', 'dn:DNa01:R', 'dn:DNb05:L', 'dn:DNb05:R', 'dn:DNg13:L', 'dn:DNg13:R'];
for (const key of ['olfactory:ORN_DM1', 'olfactory:ORN_VA2', 'olfactory:ORN_V']) {
  for (const side of ['L', 'R']) {
    const t = trial([[ix(`${key}:${side}`), 40]], steer);
    console.log(`${key}:${side}`.padEnd(24), `${(t.total / 1000).toFixed(0)}k/s `, fmt(t.out));
  }
}

console.log('\n--- grooming candidates ---');
const groom = ['dn:DNg62:L', 'dn:DNg62:R', 'dn:DNge078:L', 'dn:DNge078:R', 'dn:DNg11:L', 'dn:DNg11:R',
  'dn:DNg84:L', 'dn:DNg84:R', 'dn:DNg35:L', 'dn:DNg35:R', 'dn:DNg12:L'];
for (const key of ['mechano:JO_grooming', 'mechano:JO_wind_gravity', 'mechano:head_bristle', 'mechano:eye_bristle']) {
  for (const side of ['L', 'R']) {
    const t = trial([[ix(`${key}:${side}`), 100]], groom);
    console.log(`${key}:${side}`.padEnd(28), `${(t.total / 1000).toFixed(0)}k/s `, fmt(t.out));
  }
}

console.log('\n--- feeding: sugar, bitter, and the mix (Shiu Fig. 3) ---');
const feed = ['motor:CB0701:L', 'motor:CB0701:R', 'motor:CB0700:L', 'motor:CB0700:R'];
const sugar = ix('shiu:sugar', 'shiu:sugar_left'), bitter = ix('shiu:bitter', 'gustatory:bitter:L', 'gustatory:bitter:R');
const water = ix('shiu:water');
for (const [label, st] of [['sugar 150', [[sugar, 150]]], ['sugar 50', [[sugar, 50]]], ['bitter 150', [[bitter, 150]]],
  ['sugar 150 + bitter 150', [[sugar, 150], [bitter, 150]]], ['sugar 150 + bitter 50', [[sugar, 150], [bitter, 50]]],
  ['water 150', [[water, 150]]]]) {
  const t = trial(st, feed);
  console.log(label.padEnd(24), `${(t.total / 1000).toFixed(0)}k/s `, fmt(t.out));
}

console.log('\n--- looming from one side -> giant fiber ---');
const esc = ['dn:DNp01:L', 'dn:DNp01:R', 'dn:DNp02:L', 'dn:DNp02:R', 'dn:DNp04:L', 'dn:DNp04:R', 'dn:DNp11:L', 'dn:DNp11:R'];
for (const side of ['L', 'R']) for (const hz of [40, 100]) {
  const t = trial([[ix(`vpn:LC4:${side}`, `vpn:LPLC2:${side}`), hz]], esc);
  console.log(`LC4+LPLC2:${side} ${hz}Hz`.padEnd(24), `${(t.total / 1000).toFixed(0)}k/s `, fmt(t.out));
}
console.log('\n--- small moving object (LC11) one side -> steering ---');
for (const side of ['L', 'R']) {
  const t = trial([[ix(`vpn:LC11:${side}`), 100]], steer);
  console.log(`LC11:${side}`.padEnd(24), `${(t.total / 1000).toFixed(0)}k/s `, fmt(t.out));
}
