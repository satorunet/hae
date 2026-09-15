// The female fly's whole brain (FlyWire v783) listening for a courtship song.
// The song goes in through Johnston's organ (JO-A/B, louder on the side it comes
// from); what is read back is the path to the receptivity command vpoDN (DNp37)
// and the neurons that turn the head to a sound (DNp12); and, for egg-laying, the egg-laying
// command oviDN with its excitatory (SMP550) and inhibitory (oviIN) inputs.
//
// In: {type:'init'}, {type:'set', song:'off'|'pulse'|'sine', side:-1..1, gain:0..1, pc1:Hz, smp550:Hz}
// Out: {type:'progress'}, {type:'ready'}, {type:'tick', ms, counts:{group: spikes per cell}}
import { FlyBrain } from '../flybrain/flybrain.js?v=5';

const V = '?v=5';
const TICK = 25;                 // ms of brain per message
const LOUD = 250, SOFT = 60;     // Poisson Hz on the near and far antenna while a pulse (or the sine song) sounds
let brain = null, G = null, S = { song: 'off', side: 0, gain: 1, pc1: 0, smp550: 0 }, t = 0, last = {}, busy = false;

async function init() {
  const [court, tame] = await Promise.all([
    fetch(new URL('./data/court783.json?v=2', import.meta.url)).then((r) => r.json()),
    fetch(new URL('../ningen/web/data/tame783.json?v=1', import.meta.url)).then((r) => r.json()),
  ]);
  G = court.groups;
  brain = await FlyBrain.load({
    graph: new URL('../flybrain/data/flywire783.fbg.gz' + V, import.meta.url),
    wasm: new URL('../flybrain/flybrain.wasm' + V, import.meta.url),
    onProgress: (p) => postMessage({ type: 'progress', ...p }),
  });
  // the model runs away on some sensory input; the ningen experiment found 161 neurons that drive it
  brain.silence(tame.silenced, true, { byIndex: true });
  brain.reset(1);
  postMessage({ type: 'ready', groups: Object.fromEntries(Object.entries(G).map(([k, v]) => [k, v.length])) });
  setInterval(tick, TICK);
}

// a pulse song: 10 ms of sound every 35 ms (about D. melanogaster's inter-pulse interval); a sine song: sustained
function drive(ms) {
  if (S.song === 'off') return 0;
  if (S.song === 'sine') return 0.6;
  return ms % 35 < 10 ? 1 : 0;
}
function set(group, hz) {
  if (last[group] === hz) return;
  last[group] = hz;
  brain.stimulate(G[group], hz, { byIndex: true });
}

function tick() {
  if (!brain || busy) return;
  busy = true;
  const before = {};
  const c0 = brain.counts();
  for (const k in G) before[k] = G[k].reduce((a, i) => a + c0[i], 0);
  set('pC1', S.pc1);
  set('smp550', S.smp550);
  const nearL = S.side <= 0, k = Math.abs(S.side);
  for (let ms = 0; ms < TICK; ms++, t++) {
    const a = drive(t) * S.gain;
    const near = a * LOUD, far = a * (LOUD + (SOFT - LOUD) * k);
    set('joL', Math.round(nearL ? near : far));
    set('joR', Math.round(nearL ? far : near));
    brain.run(1, { events: false });
  }
  const c = brain.counts(), counts = {};
  for (const g in G) counts[g] = (G[g].reduce((a, i) => a + c[i], 0) - before[g]) / G[g].length;
  // spike counters are 32-bit and never reset while listening; start over now and then
  if (t > 600000) { brain.reset((Math.random() * 1e9) | 0); last = {}; t = 0; }
  postMessage({ type: 'tick', ms: TICK, counts });
  busy = false;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init().catch((err) => postMessage({ type: 'error', message: err.message }));
  else if (m.type === 'set') Object.assign(S, m);
};
