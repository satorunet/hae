// The fly's whole brain as a line-oriented process, for a body simulated elsewhere.
//
//   stdin : {"ms": 20, "inputs": {"sugar": 120, "headL": 0, ...}}   one per line
//   stdout: {"t": ..., "out": {"MN9": 31.5, ...}, "awake": n}      one per line
//   {"reset": true} starts the brain over.
//
// The sensory channels and the descending/motor readouts are the ones /test03/
// uses to drive the NeuroMechFly body (see test03/brain-worker.js).
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { FlyBrain } from '../flybrain/flybrain.js';

const BASE = new URL('../flybrain/', import.meta.url);
const INPUTS = {
  sugar:  ['shiu:sugar', 'shiu:sugar_left'],
  bitter: ['shiu:bitter', 'gustatory:bitter:L', 'gustatory:bitter:R'],
  water:  ['shiu:water'],
  headL:  ['mechano:head_bristle:L', 'mechano:JO_grooming:L'],
  headR:  ['mechano:head_bristle:R', 'mechano:JO_grooming:R'],
  loomL:  ['vpn:LC4:L', 'vpn:LPLC2:L'],
  loomR:  ['vpn:LC4:R', 'vpn:LPLC2:R'],
};
const OUTPUTS = {
  MN9:    ['motor:CB0701:L', 'motor:CB0701:R'],
  PROB:   ['motor:CB0700:L', 'motor:CB0700:R'],
  groomL: ['dn:DNg84:L', 'dn:DNg35:L'],
  groomR: ['dn:DNg84:R', 'dn:DNg35:R'],
  aDN:    ['dn:DNg62:L', 'dn:DNg62:R', 'dn:DNge078:L', 'dn:DNge078:R'],
  GFL:    ['dn:DNp01:L'],
  GFR:    ['dn:DNp01:R'],
  escL:   ['dn:DNp04:L', 'dn:DNp02:L'],
  escR:   ['dn:DNp04:R', 'dn:DNp02:R'],
  DNa02L: ['dn:DNa02:L'],
  DNa02R: ['dn:DNa02:R'],
  MDN:    ['dn:MDN:L', 'dn:MDN:R'],
  DNp09:  ['dn:DNp09:L', 'dn:DNp09:R'],
};

const groups = JSON.parse(await readFile(new URL('data/groups783.json', BASE), 'utf8')).groups;
const pick = (keys) => [...new Set(keys.flatMap((k) => (groups[k] ? groups[k].idx : [])))];
const inputs = {}, outputs = {}, current = {};
for (const [k, keys] of Object.entries(INPUTS)) inputs[k] = pick(keys);
for (const [k, keys] of Object.entries(OUTPUTS)) outputs[k] = pick(keys);
const brain = await FlyBrain.load({ graph: new URL('data/flywire783.fbg.gz', BASE), wasm: new URL('flybrain.wasm', BASE) });
let seed = 1;
brain.reset(seed);
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
say({ ready: true, n: brain.n,
  inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.length])),
  outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.length])) });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.reset) { brain.reset(++seed); for (const k in current) delete current[k]; say({ reset: true }); continue; }
  for (const k of Object.keys(inputs)) {
    const hz = Math.max(0, Math.min(400, +(m.inputs || {})[k] || 0));
    if (Math.abs((current[k] ?? -1) - hz) < 0.5) continue;
    brain.stimulate(inputs[k], hz, { byIndex: true });
    current[k] = hz;
  }
  const c0 = brain.counts(), before = {};
  for (const [k, idx] of Object.entries(outputs)) { let s = 0; for (const i of idx) s += c0[i]; before[k] = s; }
  brain.run(m.ms, { events: false });
  const c = brain.counts(), out = {};
  for (const [k, idx] of Object.entries(outputs)) {
    let s = 0; for (const i of idx) s += c[i];
    out[k] = +(((s - before[k]) / Math.max(1, idx.length)) / (m.ms / 1000)).toFixed(1);
  }
  say({ t: +brain.time.toFixed(1), out, awake: brain.activeCount });
}
