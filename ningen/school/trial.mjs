// One body and one whole fly brain in a Node process, running learning trials for ./trainer.mjs.
//
// The body is the page's own worker (../web/body-worker.js), run as fast as the CPU allows, and the
// brain is the page's whole-brain model with the same inputs and outputs (../web/brain-worker.js),
// ticked 20 ms at a time from the body's senses - the fly still decides when to eat (MN9) and how to
// steer. The trainer sends {run: {id, food, params, x, y}}: start the body over on all fours, give it
// the approach option's params, drop the food; when the body gets to it, ask the trainer for the
// feeding option ({reached: {id}} -> {feed: {params}}, the two merged); report how the worker says
// the trial ended (finished, fell, out, timeout or lost, with the times it reached and ate - see
// watchTrial in the worker), or timeout after `maxT` seconds of body time.
import { readFile } from 'node:fs/promises';
import { FlyBrain } from '../../flybrain/flybrain.js';
import { setupReflex, REFLEX } from '../web/reflex.mjs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { const url = new URL(u); return url.protocol === 'file:' ? new Response(await readFile(url)) : realFetch(u); };

// the brain, as ../web/brain-worker.js sets it up
const BASE = new URL('../../flybrain/', import.meta.url);
const src = await readFile(new URL('../web/brain-worker.js', import.meta.url), 'utf8');
const table = (name) => (0, eval)('(' + src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`))[1] + ')');
const INPUTS = table('INPUTS'), OUTPUTS = table('OUTPUTS');
const groups = JSON.parse(await readFile(new URL('data/groups783.json', BASE), 'utf8')).groups;
const pick = (keys) => [...new Set(keys.flatMap((key) => { const [k, every] = key.split('@'), idx = groups[k] ? groups[k].idx : []; return every ? idx.filter((_, i) => i % +every === 0) : idx; }))];
const inputs = Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, pick(v)]));
const outputs = Object.fromEntries(Object.entries(OUTPUTS).map(([k, v]) => [k, pick(v)]));
const brain = await FlyBrain.load({ graph: new URL('data/flywire783.fbg.gz', BASE), wasm: new URL('flybrain.wasm', BASE) });
let current = {};
// the elbow reflex's plastic synapses (../web/reflex.mjs): learning only in a run given the school's
// gains (run.reflex); the tuner's runs keep them naive
brain.silence(JSON.parse(await readFile(new URL('../web/data/tame783.json', import.meta.url), 'utf8')).silenced, true, { byIndex: true });   // (or smell runs the brain away)
setupReflex(brain, groups);
let reflexOn = false;

let frame = null, ready, ended = null, getups = [], onReached = null, onDown = null, ateAt = null, reachedAt = null;
const readyP = new Promise((r) => (ready = r));
globalThis.self = {
  postMessage: (msg) => {
    if (msg.type === 'ready') ready(msg);
    else if (msg.type === 'frame') frame = msg;
    else if (msg.type === 'trial' && msg.phase === 'end') ended = msg;
    else if (msg.type === 'trial' && msg.phase === 'reached') { reachedAt = reachedAt ?? msg.t; if (onReached) onReached(msg); }
    else if (msg.type === 'trial' && msg.phase === 'ate') ateAt = msg.t;
    else if (msg.type === 'getup') getups.push({ n: msg.n, ok: msg.ok, t: msg.t, at: frame ? frame.t : 0 });
    else if (msg.type === 'down' && onDown) onDown(msg);
    else if (msg.type === 'senses') tick(msg.rates);
    else if (msg.type === 'dopa') { if (reflexOn) msg.levels.forEach((v, c) => brain.dopamine(c, v)); }
    else if (msg.type === 'error') process.send?.({ error: msg.message });
  },
};
function tick(rates) {
  for (const k of Object.keys(inputs)) {
    const hz = Math.max(0, Math.min(400, +rates[k] || 0));
    if (Math.abs((current[k] ?? -1) - hz) < 0.5) continue;
    brain.stimulate(inputs[k], hz, { byIndex: true });
    current[k] = hz;
  }
  const c0 = brain.counts(), before = {};
  for (const [k, idx] of Object.entries(outputs)) { let s = 0; for (const i of idx) s += c0[i]; before[k] = s; }
  brain.run(20, { events: false });
  const c = brain.counts(), out = {};
  for (const [k, idx] of Object.entries(outputs)) { let s = 0; for (const i of idx) s += c[i]; out[k] = (s - before[k]) / Math.max(1, idx.length) / 0.02; }
  self.onmessage({ data: { type: 'brain', out } });
}
await import('../web/body-worker.js');
const send = (data) => self.onmessage({ data });
send({ type: 'init' });
const info = await readyP;
const pelvisId = info.bodies.indexOf('pelvis');
send({ type: 'speed', x: 20 });                             // as fast as it will go

const waitFor = (cond, maxWallS = 600) => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => { const v = cond(); if (v || Date.now() - t0 > maxWallS * 1000) { clearInterval(iv); resolve(v); } }, 20);
});

async function run(run) {
  const { id, food, params, control = null, x, y, maxT = 30, seed = 1, tune = false, push = null } = run;
  brain.clearStimuli(); brain.reset(seed); current = {};
  reflexOn = run.reflex !== undefined;
  brain.forget();
  brain.setPlasticityParams({ eta: reflexOn ? REFLEX.eta : 0, tauTrace: REFLEX.tauTrace, tauDopa: REFLEX.tauDopa, gainMin: REFLEX.gainMin, gainMax: REFLEX.gainMax });
  if (Array.isArray(run.reflex)) { try { brain.importGains(Float32Array.from(run.reflex)); } catch { /* another wiring: naive */ } }
  const gains0 = brain.exportGains();
  const reflexOut = () => (reflexOn ? { reflexDelta: Array.from(brain.exportGains(), (v, i) => +(v - gains0[i]).toFixed(5)), reflexSize: gains0.length } : {});
  if (control) send({ type: 'control', params: control });
  send({ type: 'reset' });
  send({ type: 'strategy', params });
  const t0 = frame ? frame.t : 0;
  await waitFor(() => frame && frame.t > t0 + 0.6);        // settle on all fours
  const start = frame.t, wall = Date.now();
  ended = null; getups = []; ateAt = null; reachedAt = null;
  onReached = tune ? null : (msg) => process.send({ reached: { id, t: msg.t } });
  onDown = tune ? null : (msg) => { if (!ended) process.send({ down: { id, n: msg.n } }); };   // (the trainer chooses how to get up)
  send({ type: 'food', id: 1, kind: food, x, y, z: 0 });
  if (tune) {
    // for the search (./tune.mjs): the whole time, whatever happens - how long before the first fall,
    // whether it got to eat, and how getting up went (a shove at push.at, if asked)
    let firstFall = null, ate = null, pushed = false;
    const pelvis = () => [frame.xpos[3 * pelvisId], frame.xpos[3 * pelvisId + 1]];
    const d0 = Math.hypot(pelvis()[0] - x, pelvis()[1] - y);
    let dMin = d0;
    await waitFor(() => {
      const t = frame.t - start;
      if (firstFall == null) { const q = pelvis(); dMin = Math.min(dMin, Math.hypot(q[0] - x, q[1] - y)); }   // (how close it got before any fall)
      if (push && !pushed && t > push.at) { send({ type: 'push', v: push.v }); pushed = true; }
      if (firstFall == null && frame.falls > 0) firstFall = t;
      if (ateAt != null && ate == null) ate = ateAt;
      return t > maxT;
    });
    return { ...reflexOut(), id, tune: true, firstFall, ate, reached: reachedAt, getups, falls: frame.falls, realtime: frame.realtime, progress: +Math.max(0, Math.min(1, (d0 - dMin) / Math.max(0.1, d0 - 0.5))).toFixed(3) };
  }
  let shoved = false;
  await waitFor(() => { if (push && !shoved && frame.t - start > push.at) { send({ type: 'push', v: push.v }); shoved = true; } return ended || frame.t - start > maxT; });
  onReached = null; onDown = null;
  const result = ended ? ended.result : 'timeout';
  return { ...reflexOut(), id, result, reached: ended?.reached ?? null, ate: ended?.ate ?? ateAt, t: +(frame.t - start).toFixed(2), wall: Date.now() - wall, record: ended?.record, getups, motion: ended?.motion ? Array.from(new Uint8Array(ended.motion)) : null };
}

process.on('message', async (m) => {
  if (m.feed) send({ type: 'strategy', params: m.feed.params });
  if (m.run) process.send({ done: await run(m.run) });
});
process.send({ ready: true });
