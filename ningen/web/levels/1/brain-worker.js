// The fly's whole brain, in a worker, for the human body next door (body-worker.js).
// The same channels as ../brain.mjs and /test03/: every message runs 20 ms of brain time.
import { FlyBrain } from '../../flybrain/flybrain.js';

const BASE = new URL('../../flybrain/', import.meta.url);
const INPUTS = {
  sugar:  ['shiu:sugar', 'shiu:sugar_left'],
  water:  ['shiu:water'],
  salt:   ['gustatory:low_salt:L', 'gustatory:low_salt:R'],
  bitter: ['shiu:bitter', 'gustatory:bitter:L', 'gustatory:bitter:R'],
  headL:  ['mechano:head_bristle:L', 'mechano:JO_grooming:L'],
  headR:  ['mechano:head_bristle:R', 'mechano:JO_grooming:R'],
  loomL:  ['vpn:LC4:L', 'vpn:LPLC2:L'],
  loomR:  ['vpn:LC4:R', 'vpn:LPLC2:R'],
  // what the body's own movement gives the senses (body-worker.js senses()). '@10' takes every 10th
  // neuron of a group: driving all 8,000 photoreceptors cost more than real time
  eyeL:   ['visual:R1-6:L@10'],
  eyeR:   ['visual:R1-6:R@10'],
  windL:  ['mechano:JO_wind_gravity:L'],
  windR:  ['mechano:JO_wind_gravity:R'],
  ocelli: ['visual:ocellar:L', 'visual:ocellar:R'],
  smallL: ['vpn:LC11:L'],
  smallR: ['vpn:LC11:R'],
};
const OUTPUTS = {
  MN9:    ['motor:CB0701:L', 'motor:CB0701:R'],
  groomL: ['dn:DNg84:L', 'dn:DNg35:L'],
  groomR: ['dn:DNg84:R', 'dn:DNg35:R'],
  GFL:    ['dn:DNp01:L'],
  GFR:    ['dn:DNp01:R'],
  escL:   ['dn:DNp04:L', 'dn:DNp02:L'],
  escR:   ['dn:DNp04:R', 'dn:DNp02:R'],
  MDN:    ['dn:MDN:L', 'dn:MDN:R'],
  DNa02L: ['dn:DNa02:L'],
  DNa02R: ['dn:DNa02:R'],
  DNp09:  ['dn:DNp09:L', 'dn:DNp09:R'],
};
const post = (m, t) => self.postMessage(m, t || []);
let brain = null;
const inputs = {}, outputs = {}, current = {};

async function init() {
  const groups = (await (await fetch(new URL('data/groups783.json', BASE))).json()).groups;
  const pick = (keys) => [...new Set(keys.flatMap((key) => {
    const [k, every] = key.split('@'), idx = groups[k] ? groups[k].idx : [];
    return every ? idx.filter((_, i) => i % +every === 0) : idx;
  }))];
  for (const [k, keys] of Object.entries(INPUTS)) inputs[k] = pick(keys);
  for (const [k, keys] of Object.entries(OUTPUTS)) outputs[k] = pick(keys);
  brain = await FlyBrain.load({
    graph: new URL('data/flywire783.fbg.gz', BASE), wasm: new URL('flybrain.wasm', BASE),
    onProgress: (p) => post({ type: 'progress', ...p }),
  });
  brain.reset(1);
  post({ type: 'ready', n: brain.n });
}

function tick(ms, rates) {
  for (const k of Object.keys(inputs)) {
    const hz = Math.max(0, Math.min(400, +rates[k] || 0));
    if (Math.abs((current[k] ?? -1) - hz) < 0.5) continue;
    brain.stimulate(inputs[k], hz, { byIndex: true });
    current[k] = hz;
  }
  const c0 = brain.counts(), before = {};
  for (const [k, idx] of Object.entries(outputs)) { let s = 0; for (const i of idx) s += c0[i]; before[k] = s; }
  const t0 = performance.now();
  const r = brain.run(ms);
  const c = brain.counts(), out = {};
  for (const [k, idx] of Object.entries(outputs)) {
    let s = 0; for (const i of idx) s += c[i];
    out[k] = ((s - before[k]) / Math.max(1, idx.length)) / (ms / 1000);
  }
  const fired = r.idx.length > 4000 ? r.idx.slice(0, 4000) : r.idx.slice();
  post({ type: 'tick', t: brain.time, out, wall: performance.now() - t0, spikes: r.spikes, fired }, [fired.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') await init();
    else if (msg.type === 'tick') tick(msg.ms, msg.inputs || {});
  } catch (err) {
    post({ type: 'error', message: String(err?.stack || err) });
  }
};
