// The fly's brain, in a worker: FlyWire v783 through flybrain.js (WebAssembly).
//
// The page sends one message per 20 ms of brain time with the current sensory
// input rates; the worker simulates that window and answers with the firing
// rates of the descending / motor neurons the body reads, plus which neurons
// fired (for the brain map).
import { FlyBrain } from '../flybrain/flybrain.js';

const V = '?v=1';
const BASE = new URL('../flybrain/', import.meta.url);

// sensory channels: stimulated with Poisson input at the rate the page asks for
const INPUTS = {
  sugar:  ['shiu:sugar', 'shiu:sugar_left'],                          // labellar sugar GRNs
  bitter: ['shiu:bitter', 'gustatory:bitter:L', 'gustatory:bitter:R'],
  water:  ['shiu:water'],
  headL:  ['mechano:head_bristle:L', 'mechano:JO_grooming:L'],       // head bristles + JO-F
  headR:  ['mechano:head_bristle:R', 'mechano:JO_grooming:R'],
  loomL:  ['vpn:LC4:L', 'vpn:LPLC2:L'],                              // looming detectors
  loomR:  ['vpn:LC4:R', 'vpn:LPLC2:R'],
  smell:  ['olfactory:ORN_DM1:L', 'olfactory:ORN_DM1:R'],            // the runaway experiment
};
// outputs the body reads (and the panel shows)
const OUTPUTS = {
  MN9:     ['motor:CB0701:L', 'motor:CB0701:R'],
  PROB:    ['motor:CB0700:L', 'motor:CB0700:R'],
  groomL:  ['dn:DNg84:L', 'dn:DNg35:L'],
  groomR:  ['dn:DNg84:R', 'dn:DNg35:R'],
  aDN:     ['dn:DNg62:L', 'dn:DNg62:R', 'dn:DNge078:L', 'dn:DNge078:R'],
  GFL:     ['dn:DNp01:L'],
  GFR:     ['dn:DNp01:R'],
  escL:    ['dn:DNp04:L', 'dn:DNp02:L'],
  escR:    ['dn:DNp04:R', 'dn:DNp02:R'],
  DNa02L:  ['dn:DNa02:L'],
  DNa02R:  ['dn:DNa02:R'],
  MDN:     ['dn:MDN:L', 'dn:MDN:R'],
  DNp09:   ['dn:DNp09:L', 'dn:DNp09:R'],
};

let brain = null, inputs = {}, outputs = {}, current = {}, seed = 1;
const post = (m, t) => self.postMessage(m, t || []);

async function init() {
  const groups = (await (await fetch(new URL('data/groups783.json' + V, BASE))).json()).groups;
  const pick = (keys) => [...new Set(keys.flatMap((k) => (groups[k] ? groups[k].idx : [])))];
  for (const [k, keys] of Object.entries(INPUTS)) inputs[k] = pick(keys);
  for (const [k, keys] of Object.entries(OUTPUTS)) outputs[k] = new Uint32Array(pick(keys));
  brain = await FlyBrain.load({
    graph: new URL('data/flywire783.fbg.gz' + V, BASE),
    wasm: new URL('flybrain.wasm' + V, BASE),
    onProgress: (p) => post({ type: 'progress', ...p }),
  });
  brain.reset(seed);
  post({
    type: 'ready', n: brain.n, nnz: brain.nnz,
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.length])),
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.length])),
  });
}

function setInputs(rates) {
  for (const k of Object.keys(inputs)) {
    const hz = Math.max(0, Math.min(400, +rates[k] || 0));
    if (Math.abs((current[k] || 0) - hz) < 0.5) continue;
    brain.stimulate(inputs[k], hz, { byIndex: true });
    current[k] = hz;
  }
}

function tick(ms, rates) {
  setInputs(rates);
  const before = {};
  const c0 = brain.counts();
  for (const [k, idx] of Object.entries(outputs)) { let s = 0; for (const i of idx) s += c0[i]; before[k] = s; }
  const t0 = performance.now();
  const r = brain.run(ms);
  const wall = performance.now() - t0;
  const c = brain.counts(), rates_out = {};
  for (const [k, idx] of Object.entries(outputs)) {
    let s = 0; for (const i of idx) s += c[i];
    rates_out[k] = ((s - before[k]) / idx.length) / (ms / 1000);
  }
  // unique neurons that fired in this window, for the brain map
  const fired = r.idx.length > 6000 ? r.idx.subarray(0, 6000) : r.idx;
  post({ type: 'tick', t: brain.time, ms, wall, spikes: r.spikes, awake: brain.activeCount, out: rates_out, fired }, [fired.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init();
    else if (m.type === 'tick') tick(m.ms, m.inputs || {});
    else if (m.type === 'reset') { seed++; brain.reset(seed); post({ type: 'reset' }); }
  } catch (err) {
    post({ type: 'error', message: String(err && err.message || err) });
  }
};
