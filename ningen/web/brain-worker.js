// The fly's whole brain, in a worker, for the human body next door (body-worker.js).
// The same channels as ../brain.mjs and /test03/: every message runs 20 ms of brain time.
import { FlyBrain } from '../../flybrain/flybrain.js';
import { setupReflex, REFLEX } from './reflex.mjs?v=2';
// main -> worker: {type:'init', reflex}  reflex: 'latest', a level's file name, or null (naive synapses)
//                 {type:'tick', ms, inputs}   {type:'dopa', levels:[left, right]}   {type:'reflexDelta', id}
// worker -> main: {type:'ready', n, reflex: {loaded, gains:[meanL, meanR]}}  {type:'tick', ...}
//                 {type:'reflexDelta', id, delta: number[], gains: [meanL, meanR]}   (the change since the last one)

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
  // sounds (body-worker.js hearing): Johnston's organ's hearing neurons
  audL:   ['mechano:JO_auditory:L'],
  audR:   ['mechano:JO_auditory:R'],
  // smells (body-worker.js smelling): each food's glomeruli, the receptor neurons - honey the fruity and fermented
  // ones (as ../school/strategies.mjs ODOURS), meat and dung the ones for acids, ammonia and CO2 that, of the
  // likely ones, drive this model's walking DNs (measured: the mushroom body's choices keep ODOURS' own)
  odHoneyL: ['olfactory:ORN_DM1:L', 'olfactory:ORN_DM2:L', 'olfactory:ORN_DM4:L', 'olfactory:ORN_VA2:L', 'olfactory:ORN_DL1:L'],
  odHoneyR: ['olfactory:ORN_DM1:R', 'olfactory:ORN_DM2:R', 'olfactory:ORN_DM4:R', 'olfactory:ORN_VA2:R', 'olfactory:ORN_DL1:R'],
  odMeatL: ['olfactory:ORN_DP1m:L', 'olfactory:ORN_DC4:L', 'olfactory:ORN_VL2a:L', 'olfactory:ORN_VM7d:L', 'olfactory:ORN_VM7v:L'],
  odMeatR: ['olfactory:ORN_DP1m:R', 'olfactory:ORN_DC4:R', 'olfactory:ORN_VL2a:R', 'olfactory:ORN_VM7d:R', 'olfactory:ORN_VM7v:R'],
  odDungL: ['olfactory:ORN_VM1:L', 'olfactory:ORN_V:L', 'olfactory:ORN_VM7d:L', 'olfactory:ORN_VM7v:L', 'olfactory:ORN_VM6v:L'],
  odDungR: ['olfactory:ORN_VM1:R', 'olfactory:ORN_V:R', 'olfactory:ORN_VM7d:R', 'olfactory:ORN_VM7v:R', 'olfactory:ORN_VM6v:R'],
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
  // bending the elbows (body-worker.js ELBOWS): the DNs that answer the head tipping and swaying
  tiltL:  ['dn:DNp28:L'],
  tiltR:  ['dn:DNp28:R'],
  swayL:  ['dn:DNb06:L'],
  swayR:  ['dn:DNb06:R'],
  // turning the head toward a sound (body-worker.js jerk): the DNs a sound on that side drives
  // (in this model: a sound on the left drives DNp12 on the left, one on the right DNg24 on the right; both
  // stay quiet while the body just moves, unlike DNg29)
  orientL: ['dn:DNp12:L'],
  orientR: ['dn:DNg24:R'],
  // walking (body-worker.js walk): the DNa's that smells drive, besides DNa02 (steering) and DNp09
  // (and DNp32, which dung's smell drives where it does not drive the DNa's)
  goL: ['dn:DNa03:L', 'dn:DNa13:L', 'dn:DNa15:L', 'dn:DNa16:L', 'dn:DNp32:L'],
  goR: ['dn:DNa03:R', 'dn:DNa13:R', 'dn:DNa15:R', 'dn:DNa16:R', 'dn:DNp32:R'],
};
const post = (m, t) => self.postMessage(m, t || []);
let brain = null, lastGains = null, reflexLoaded = false;
const inputs = {}, outputs = {}, current = {};

let reflexFile = null;
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
  // (a few neurons silenced, or the whole brain runs away on smell: data/tame783.json)
  const tame = await (await fetch(new URL('./data/tame783.json', import.meta.url))).json();
  brain.silence(tame.silenced, true, { byIndex: true });
  brain.reset(1);
  // the elbow reflex's synapses (reflex.mjs), with what the school has learned in them so far
  setupReflex(brain, groups);
  if (reflexFile) {
    try {
      const r = await fetch(new URL('../school/state/' + reflexFile + '?t=' + Date.now(), import.meta.url));
      if (r.ok) {
        const g = new Float32Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        brain.importGains(g); reflexLoaded = true;
      }
    } catch { /* none yet, or another wiring: naive */ }
  }
  lastGains = brain.exportGains();
  post({ type: 'ready', n: brain.n, reflex: { loaded: reflexLoaded, gains: REFLEX.groups.map((_, c) => +brain.gain(c).toFixed(4)) } });
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
    if (msg.type === 'init') { reflexFile = msg.reflex || null; await init(); }
    else if (msg.type === 'dopa') { if (brain) msg.levels.forEach((v, c) => brain.dopamine(c, +v || 0)); }
    else if (msg.type === 'reflexDelta') {
      if (!brain) return;
      const g = brain.exportGains(), delta = Array.from(g, (v, i) => +(v - lastGains[i]).toFixed(5));
      lastGains = g;
      post({ type: 'reflexDelta', id: msg.id, delta, gains: REFLEX.groups.map((_, c) => +brain.gain(c).toFixed(4)) });
    }
    else if (msg.type === 'tick') tick(msg.ms, msg.inputs || {});
  } catch (err) {
    post({ type: 'error', message: String(err?.stack || err) });
  }
};
