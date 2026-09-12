// Teaching the mushroom body to read digits, in a worker.
//
// Pixels go in where odours normally do - each of the 144 pixels drives its
// own share of the olfactory projection neurons - and nine dopamine
// compartments stand for the nine digits. Teaching digit d means presenting
// the image with compartment d's dopamine on, which weakens the synapses from
// exactly the Kenyon cells that image lit up. Reading an image back means
// asking which compartment has lost the most of its drive from the cells this
// image lights up now.
// The query strings pin a version of the library: Cloudflare caches these URLs,
// and an older cached flybrain.js/.wasm has no plasticity in it at all. Bump
// them together whenever flybrain.js or flybrain.wasm changes.
import { FlyBrain } from '../flybrain/flybrain.js?v=4';

const V = '?v=4';
const BASE = new URL('../flybrain/', import.meta.url);
const HZ = 220;        // a full-black pixel drives its channel this hard
const INK = 0.05;      // pixels fainter than this are not presented at all
const MS = 400;        // how long one image is held in front of the fly
const ETA = 6e-5;      // learning rate
const NREAD = 9;       // nine compartments, one per digit

let brain = null, G = null, KC = [], kcAt = null, chan = [], READ = [];
let data = null;                 // the bundled MNIST digits
let taught = 0;                  // images taught so far
let norm = null;                 // per-compartment baseline, from the taught images
const post = (m, t) => self.postMessage(m, t || []);
const pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
const all = (keys) => keys.flatMap((k) => (G[k] ? G[k].idx : []));

async function init() {
  const [mb, buf] = await Promise.all([
    fetch(new URL('data/mb783.json' + V, BASE)).then((r) => r.json()),
    fetch(new URL('./digits.bin' + V, import.meta.url)).then((r) => r.arrayBuffer()),
  ]);
  G = mb.groups;
  data = unpack(buf);
  for (const fn of ['setPlasticity', 'gainByGroup', 'dopamine', 'forget'])
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
  kcAt = new Map(KC.map((k, i) => [k, i]));

  // the mushroom body alone: the whole-brain model runs away on any olfactory input
  const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);
  const outside = [];
  for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
  brain.silence(outside, true, { byIndex: true });

  // the nine MBON types with the most Kenyon-cell synapses become the readouts
  const mbonTypes = pick('mbon:');
  const counts = brain.setPlasticity({
    pre: KC, groups: mbonTypes.map((m) => ({ post: G[m].idx, modulators: [] })), eta: 0,
  });
  READ = mbonTypes.map((m, j) => ({ name: m.slice(5), key: m, synapses: counts[j] }))
    .sort((a, b) => b.synapses - a.synapses).slice(0, NREAD);
  brain.setPlasticity({
    pre: KC, groups: READ.map((r) => ({ post: G[r.key].idx, modulators: [] })),
    eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: 0.05,
  });

  // 144 pixels -> 144 input channels: the projection neurons dealt out round-robin
  // (their wiring onto the Kenyon cells is random anyway, so the order is arbitrary
  // - it is fixed here only so the same picture always lands the same way)
  const npix = data.size * data.size;
  let rs = 12345;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const deck = [...ALPN];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  chan = Array.from({ length: npix }, () => []);
  deck.forEach((p, i) => chan[i % npix].push(p));

  post({
    type: 'ready', n: brain.n, nnz: brain.nnz, kc: new Uint32Array(KC),
    size: data.size, perTrain: data.perTrain, perTest: data.perTest,
    channels: npix, pns: ALPN.length,
    readouts: READ.map((r) => ({ name: r.name, cells: G[r.key].idx.length, synapses: r.synapses })),
  });
}

function unpack(buf) {
  const h = new Uint8Array(buf, 0, 8);
  if (String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'DGT1') throw new Error('digits.bin');
  const size = h[4], nd = h[5], perTrain = h[6], perTest = h[7], npix = size * size;
  const px = new Uint8Array(buf, 8);
  const grab = (off, per) => {
    const out = {};
    for (let d = 1; d <= nd; d++) {
      out[d] = [];
      for (let k = 0; k < per; k++) {
        const img = new Float32Array(npix), at = off + ((d - 1) * per + k) * npix;
        for (let i = 0; i < npix; i++) img[i] = px[at + i] / 255;
        out[d].push(img);
      }
    }
    return out;
  };
  return { size, perTrain, perTest,
    train: grab(0, perTrain), test: grab(nd * perTrain * npix, perTest) };
}

// show one image; `label` non-null teaches it as that digit
let seed = 1;
function present(img, label) {
  brain.clearStimuli();
  for (let i = 0; i < img.length; i++)
    if (img[i] > INK) brain.stimulate(chan[i], HZ * img[i], { byIndex: true });
  brain.setPlasticityParams(label == null
    ? { eta: 0 }
    : { eta: ETA, tauTrace: 40, tauDopa: 1e7, gainMin: 0.05 });
  brain.reset(label == null ? 1 : ++seed);
  if (label != null) brain.dopamine(label - 1, 1);
  brain.run(MS, { events: false });
  if (label != null) brain.dopamine(label - 1, 0);
  const c = brain.counts(), active = [], slots = [];
  for (const k of KC) if (c[k]) { active.push(k); slots.push(kcAt.get(k)); }
  return { slots: new Uint32Array(slots), gain: brain.gainByGroup(active, { byIndex: true }) };
}

// Which compartment has lost the most of the drive this picture would give it?
// The baseline is measured on the taught images only, so nothing about the
// unseen ones takes part in the decision.
function decide(gain) {
  const z = new Float64Array(NREAD);
  for (let c = 0; c < NREAD; c++)
    z[c] = norm ? (gain[c] - norm.mean[c]) / norm.sd[c] : gain[c] - 1;
  let best = 0;
  for (let c = 1; c < NREAD; c++) if (z[c] < z[best]) best = c;
  return { digit: best + 1, z };
}

function rebaseline(images) {
  const rows = images.map((im, i) => {
    if (i % 4 === 0) post({ type: 'busy', phase: 'calibrating', done: i, total: images.length });
    return present(im, null).gain;
  });
  const mean = new Float64Array(NREAD), sd = new Float64Array(NREAD);
  for (const r of rows) for (let c = 0; c < NREAD; c++) mean[c] += r[c] / rows.length;
  for (const r of rows) for (let c = 0; c < NREAD; c++) sd[c] += (r[c] - mean[c]) ** 2 / rows.length;
  for (let c = 0; c < NREAD; c++) sd[c] = Math.sqrt(sd[c]) || 1e-9;
  norm = { mean, sd };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') { await init(); return; }

  if (m.type === 'forget') {
    brain.forget(); taught = 0; norm = null;
    post({ type: 'forgotten' });
    return;
  }

  if (m.type === 'train') {                 // m.per images of each digit, from MNIST
    const shown = [];
    const total = m.per * 9;
    for (let k = 0; k < m.per; k++) for (let d = 1; d <= 9; d++) {
      const im = data.train[d][(m.from + k) % data.perTrain];
      present(im, d); shown.push(im); taught++;
      post({ type: 'busy', phase: 'teaching', done: shown.length, total, digit: d });
    }
    // calibrate on everything taught so far
    const seen = [];
    for (let k = 0; k < Math.min(taught / 9, data.perTrain); k++)
      for (let d = 1; d <= 9; d++) seen.push(data.train[d][k]);
    rebaseline(seen);
    post({ type: 'trained', taught, gains: Float64Array.from({ length: NREAD }, (_, c) => brain.gain(c)) });
    return;
  }

  if (m.type === 'score') {                 // grade on digits it was never taught
    const per = Math.min(m.per || 10, data.perTest);
    const conf = Array.from({ length: 10 }, () => new Array(10).fill(0));
    let ok = 0, n = 0;
    for (let d = 1; d <= 9; d++) for (let k = 0; k < per; k++) {
      const { digit } = decide(present(data.test[d][k], null).gain);
      conf[d][digit]++; if (digit === d) ok++; n++;
      post({ type: 'busy', phase: 'scoring', done: n, total: 9 * per });
    }
    post({ type: 'scored', ok, n, conf });
    return;
  }

  if (m.type === 'read') {                  // one image the page drew
    const img = new Float32Array(m.img);
    const r = present(img, m.label ?? null);
    if (m.label != null) taught++;   // the baseline is now slightly stale, but usable
    const d = decide(r.gain);
    post({ type: 'readout', taught, label: m.label ?? null, digit: d.digit,
           z: d.z, slots: r.slots, calibrated: !!norm }, [r.slots.buffer]);
    return;
  }

  if (m.type === 'ask') {                   // one quiz question, asked and answered
    const truth = m.digit, k = m.k % data.perTest;
    const img = data.test[truth][k];
    const r = present(img, null);
    const d = decide(r.gain);
    post({ type: 'answered', truth, k, img: Float32Array.from(img), digit: d.digit,
           z: d.z, slots: r.slots, calibrated: !!norm }, [r.slots.buffer]);
    return;
  }

  if (m.type === 'sample') {                // hand the page a real MNIST digit
    const d = m.digit, k = m.k % data.perTest;
    post({ type: 'sampled', digit: d, img: Float32Array.from(data.test[d][k]) });
  }
};
