// A fly that learns to read, shared by the trainer on the server (Node) and
// the pages (a browser worker) so both run exactly the same brain.
//
// Pictures go in where odours normally do: every pixel drives its own share of
// the 685 olfactory projection neurons, and the mushroom body turns that into
// a sparse Kenyon-cell code. Each letter the fly can learn has its own
// dopamine compartment - a group of MBONs - and reading a picture means asking
// which compartment's MBONs are driven least by the Kenyon cells it lights up
// (spikes x synapses x learned weight, relative to a naive brain).
//
// Learning is error-driven: the fly answers first, and only if it was wrong
// does dopamine arrive, while the picture is still in front of it -
//   * the right letter's compartment gets ordinary dopamine, which weakens the
//     synapses from the cells that are firing (so next time that letter's
//     MBONs go quiet for this picture), and
//   * the compartment it wrongly picked gets the reverse, which strengthens
//     them (so it stops claiming the picture).
// Both happen in the WASM core's plasticity rule during a spiking simulation;
// nothing is computed outside the brain except the final comparison.

export const COURSES = {
  suji: {
    size: 12, hz: 220, ink: 0.05, ms: 400, feedbackMs: 300,
    eta: 6e-5, gainMin: 0.05, gainMax: 2,
    labels: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  },
  hiragana: {
    size: 16, hz: 270, ink: 0.05, ms: 400, feedbackMs: 300,
    eta: 6e-5, gainMin: 0.05, gainMax: 2,
    labels: [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'],
  },
};

async function readBytes(url) {
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * @param {object} o
 * @param {typeof import('../flybrain/flybrain.js').FlyBrain} o.FlyBrain
 * @param {URL} o.base        the flybrain/ directory
 * @param {string} o.course   'suji' | 'hiragana'
 * @param {string} [o.v]      cache-busting query for the library's data
 */
export async function makeReader({ FlyBrain, base, course, v = '', onProgress }) {
  const C = COURSES[course];
  if (!C) throw new Error('unknown course ' + course);
  const mb = JSON.parse(new TextDecoder().decode(await readBytes(new URL('data/mb783.json' + v, base))));
  const brain = await FlyBrain.load({
    graph: new URL('data/flywire783.fbg.gz' + v, base),
    wasm: new URL('flybrain.wasm' + v, base),
    onProgress,
  });
  const G = mb.groups;
  const pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
  const all = (keys) => keys.flatMap((k) => G[k].idx);
  const KC = all(pick('kc:')), MBON = all(pick('mbon:')), DAN = all(pick('dan:')),
        MBIN = all(pick('mbin:')), ALPN = all(pick('alpn:'));

  // the mushroom body alone: the whole-brain model runs away on any olfactory input
  const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);
  const outside = [];
  for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
  brain.silence(outside, true, { byIndex: true });

  // How many Kenyon cells reach each MBON - the readouts go to the best-connected.
  const kcIn = new Map();
  const mbonSet = new Set(MBON);
  for (const k of KC) {
    const { post } = brain.outgoing(k, { byIndex: true });
    for (const i of post) if (mbonSet.has(i)) kcIn.set(i, (kcIn.get(i) || 0) + 1);
  }
  const NL = C.labels.length;
  // All 96 MBONs are dealt out to the letters, best-connected first, each to
  // whichever letter has the fewest Kenyon-cell inputs so far - so every letter
  // hears about as much of the code. (There are only 35 MBON types, fewer than
  // 46 letters, and a single MBON reaches at most ~40% of the Kenyon cells.)
  const typeOf = new Map();
  for (const t of pick('mbon:')) for (const i of G[t].idx) typeOf.set(i, t.slice(5));
  const groups = Array.from({ length: NL }, () => ({ cells: [], types: [], inputs: 0 }));
  for (const i of [...kcIn.keys()].sort((a, b) => kcIn.get(b) - kcIn.get(a) || a - b)) {
    let g = groups[0];
    for (const h of groups) if (h.inputs < g.inputs) g = h;
    g.cells.push(i); g.types.push(typeOf.get(i)); g.inputs += kcIn.get(i);
  }
  for (const g of groups) g.name = [...new Set(g.types)].join('+');
  const counts = brain.setPlasticity({
    pre: KC, groups: groups.map((g) => ({ post: g.cells, modulators: [] })),
    eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax,
  });
  groups.forEach((g, c) => (g.synapses = counts[c]));

  // pixels -> input channels: the projection neurons dealt out round-robin
  const npix = C.size * C.size;
  let rs = 12345;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const deck = [...ALPN];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const chan = Array.from({ length: npix }, () => []);
  deck.forEach((p, i) => chan[i % npix].push(p));

  let seed = 1, idling = false;
  const CHUNK_MS = 25;

  /**
   * The brain with nothing in front of it: every projection neuron gets weak,
   * independent Poisson input (background, `hz`), and the simulation carries on
   * from where it was. Returns that slice's spikes. Only the pages use this.
   */
  function idle(ms, hz = 20) {
    if (!idling) {
      brain.clearStimuli();
      brain.stimulate(ALPN, hz, { byIndex: true });
      brain.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
      brain.reset(++seed);
      idling = true;
    }
    return brain.run(ms);
  }

  function stimulate(img) {
    brain.clearStimuli();
    for (let i = 0; i < npix; i++)
      if (img[i] > C.ink) brain.stimulate(chan[i], C.hz * img[i], { byIndex: true });
  }

  /**
   * Show a picture (C.ms of simulated time) and read the compartments. With
   * `onChunk`, the same simulation runs in CHUNK_MS slices and each slice's
   * spikes are handed over as they happen (for watching it; the result is
   * identical - the steps and the random numbers are the same).
   */
  function look(img, { seed: s, onChunk } = {}) {
    idling = false;
    stimulate(img);
    brain.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
    brain.reset(s ?? ++seed);
    if (onChunk) for (let t = 0; t < C.ms; t += CHUNK_MS) onChunk(brain.run(Math.min(CHUNK_MS, C.ms - t)), t);
    else brain.run(C.ms, { events: false });
    const c = brain.counts(), spikes = new Uint16Array(KC.length);
    const slots = [];
    for (let k = 0; k < KC.length; k++) {
      const n = c[KC[k]];
      if (n) { spikes[k] = Math.min(65535, n); slots.push(k); }
    }
    const drive = brain.driveByGroup(KC, spikes);
    return { drive, slots: Uint16Array.from(slots) };
  }

  /**
   * The answer among the letters `allowed` (indices; default all): the
   * compartment whose MBONs this picture drives least. `margin` is how much
   * less than the runner-up, as a fraction of naive drive.
   */
  function decide(drive, allowed) {
    const cand = allowed ?? [...Array(NL).keys()];
    let best = cand[0], second = null;
    for (const c of cand) if (drive[c] < drive[best]) best = c;
    for (const c of cand) if (c !== best && (second == null || drive[c] < drive[second])) second = c;
    return { answer: best, second, margin: second == null ? 1 : drive[second] - drive[best] };
  }

  /** Dopamine while the picture is still up: right letter weakened, wrong pick strengthened. */
  function feedback(truth, wrong) {
    brain.setPlasticityParams({ eta: C.eta, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
    brain.dopamine(truth, 1);
    if (wrong != null && wrong !== truth) brain.dopamine(wrong, -1);
    brain.run(C.feedbackMs, { events: false });
    brain.dopamine(truth, 0);
    if (wrong != null) brain.dopamine(wrong, 0);
    brain.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
  }

  /** One practice question: look, answer, get corrected if wrong. */
  function practise(img, truth, allowed) {
    const seen = look(img);
    const d = decide(seen.drive, allowed);
    const ok = d.answer === truth;
    if (!ok) feedback(truth, d.answer);   // the picture is still being shown
    return { ok, answer: d.answer, margin: d.margin, slots: seen.slots };
  }

  return {
    course: C, brain, KC, ALPN, groups, labels: C.labels, npix,
    look, decide, feedback, practise, idle, CHUNK_MS, MBON,
    exportGains: () => brain.exportGains(),
    importGains: (g) => brain.importGains(g),
    forget: () => brain.forget(),
  };
}
