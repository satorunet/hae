// The mushroom body, in a worker: the Shiu whole-brain LIF model (FlyWire v783)
// restricted to the mushroom body, with its learning rule switched on.
//
// The page asks for an odour to be presented, or paired with dopamine; the
// worker simulates one second of it and answers with which Kenyon cells fired,
// how fast each MBON type fired, and how weak each compartment's synapses now
// are.
import { FlyBrain } from '../flybrain/flybrain.js?v=2';   // the query keeps Cloudflare from serving a cached copy without setPlasticity()

const V = '?v=2';
const BASE = new URL('../flybrain/', import.meta.url);
const HZ = 100;        // odour concentration, as Poisson drive to the projection neurons
const DAN_HZ = 80;     // how hard the dopaminergic neurons are driven while training
const ETA = 2e-5;      // learning rate (per ms of coincidence)
const TRIAL_MS = 1000;

let brain = null, G = null, CM = null;
let KC = [], mbonTypes = [], odours = {}, dans = {};
const post = (m, t) => self.postMessage(m, t || []);
const pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
const all = (keys) => keys.flatMap((k) => (G[k] ? G[k].idx : []));

async function init() {
  const [mb, cm] = await Promise.all([
    fetch(new URL('data/mb783.json' + V, BASE)).then((r) => r.json()),
    fetch(new URL('data/mbcompart783.json' + V, BASE)).then((r) => r.json()),
  ]);
  G = mb.groups; CM = cm;
  for (const fn of ['setPlasticity', 'gainFrom', 'gain', 'forget'])
    if (typeof FlyBrain.prototype[fn] !== 'function')
      throw new Error(`flybrain.js is stale (no ${fn}) - bump the ?v= in brain-worker.js`);
  brain = await FlyBrain.load({
    graph: new URL('data/flywire783.fbg.gz' + V, BASE),
    wasm: new URL('flybrain.wasm' + V, BASE),
    onProgress: (p) => post({ type: 'progress', ...p }),
  });
  post({ type: 'progress', phase: 'wiring' });

  KC = all(pick('kc:'));
  const MBON = all(pick('mbon:')), DAN = all(pick('dan:')),
        MBIN = all(pick('mbin:')), ALPN = all(pick('alpn:'));

  // The mushroom body on its own. The published whole-brain model has a
  // self-sustaining runaway that any olfactory drive tips it into, so the rest
  // of the brain is switched off rather than allowed to blow up.
  const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);
  const outside = [];
  for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
  brain.silence(outside, true, { byIndex: true });

  // one dopamine compartment per MBON type; its modulators are the DANs that
  // share that MBON's Kenyon cells (data/mbcompart783.json)
  mbonTypes = pick('mbon:');
  const groups = mbonTypes.map((m) => ({
    post: G[m].idx,
    modulators: Object.entries(CM.gate[m]).flatMap(([d, w]) => G[d].idx.map((i) => [i, w])),
  }));
  const marked = brain.setPlasticity({
    pre: KC, groups, eta: 0, tauTrace: 40, tauDopa: 100, gainMin: 0.05,
  });

  // two odours, each a broad but almost disjoint set of glomeruli
  const ats = pick('alpn:');
  odours = { A: all(ats.filter((_, i) => i % 2 === 0)), B: all(ats.filter((_, i) => i % 2 === 1)) };
  dans = {
    punish: pick('dan:').filter((k) => /PPL1/.test(k)).flatMap((k) => G[k].idx),
    reward: all(['dan:PAM05', 'dan:PAM13', 'dan:PAM06', 'dan:PAM14']),
  };

  const kcIdx = new Uint32Array(KC);
  post({
    type: 'ready',
    n: brain.n, nnz: brain.nnz,
    kc: kcIdx, synapses: marked.reduce((a, b) => a + b, 0),
    mbon: mbonTypes.map((m, c) => ({
      name: m.slice(5), n: G[m].idx.length, synapses: marked[c],
      punish: CM.valence[m].punish, reward: CM.valence[m].reward,
      dans: Object.entries(CM.gate[m]).sort((a, b) => b[1] - a[1]).map(([d, x]) => [d.slice(4), x]),
      top: CM.valence[m].top,
    })),
    odours: Object.fromEntries(Object.entries(odours).map(([k, v]) => [k, v.length])),
    dans: Object.fromEntries(Object.entries(dans).map(([k, v]) => [k, v.length])),
  }, [kcIdx.buffer]);
}

// run ms of simulated time, reporting progress as it goes
function simulate(ms) {
  const chunk = 100;
  for (let done = 0; done < ms; done += chunk) {
    brain.run(Math.min(chunk, ms - done), { events: false });
    post({ type: 'busy', done: done + chunk, total: ms });
  }
}

function measure() {
  const c = brain.counts();
  const active = [], activeIdx = [];
  for (let k = 0; k < KC.length; k++) if (c[KC[k]]) { active.push(k); activeIdx.push(KC[k]); }
  const rates = new Float32Array(mbonTypes.length);
  mbonTypes.forEach((m, j) => {
    let s = 0;
    for (const i of G[m].idx) s += c[i];
    rates[j] = s / G[m].idx.length;      // spikes in 1 s = Hz
  });
  const gains = new Float32Array(mbonTypes.length);
  for (let j = 0; j < mbonTypes.length; j++) gains[j] = brain.gain(j);
  // how much drive the cells that just carried this odour have lost: the
  // memory itself, read off the synapses rather than from the MBONs
  const gainPre = brain.gainFrom(activeIdx, { byIndex: true });
  return { active: new Uint32Array(active), rates, gains, gainPre };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') { await init(); return; }
  if (m.type === 'forget') {
    brain.forget();
    const g = new Float32Array(mbonTypes.length);
    for (let j = 0; j < mbonTypes.length; j++) g[j] = brain.gain(j);
    post({ type: 'forgotten', gains: g }, [g.buffer]);
    return;
  }
  if (m.type === 'present' || m.type === 'train') {
    const learn = m.type === 'train';
    brain.setPlasticityParams(learn
      ? { eta: ETA, tauTrace: 40, tauDopa: 100, gainMin: 0.05 }
      : { eta: 0 });
    brain.clearStimuli();
    brain.stimulate(odours[m.odour], HZ, { byIndex: true });
    if (learn) brain.stimulate(dans[m.dan], DAN_HZ, { byIndex: true });
    brain.reset(m.seed || 1);
    simulate(TRIAL_MS);
    const r = measure();
    post({ type: learn ? 'trained' : 'presented', odour: m.odour, dan: m.dan, ...r },
      [r.active.buffer, r.rates.buffer, r.gains.buffer]);
  }
};
