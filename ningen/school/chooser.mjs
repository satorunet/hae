// The fly's mushroom body choosing how to use the human body, shared by the trainer (Node) and the
// page (a browser worker) so both run the same brain - built like ../../juku/reader.mjs.
//
// The smell of the food goes in through the olfactory projection neurons of its glomeruli
// (./strategies.mjs ODOURS), and the mushroom body turns it into a sparse Kenyon-cell code. Each
// option of each decision (./strategies.mjs DECISIONS: how to approach, how to feed) has its own
// dopamine compartment - a group of MBONs - and choosing means asking which of that decision's
// compartments this smell drives least (spikes x synapses x learned weight, relative to
// a naive brain). With a naive brain they are all about equal, and which one comes out least is down
// to the spikes of the moment: the fly tries things.
//
// Learning, after a trial, with the smell presented again: dopamine in each chosen compartment, at
// the level ./strategies.mjs outcomeLevels gives for how that part of the trial went. Positive
// (ordinary dopamine) weakens the synapses from the Kenyon cells the smell lights up, so that
// compartment goes quiet for that food and the fly picks it again; negative strengthens them, so it
// stops picking it. All of it happens in the WASM core's plasticity rule during a spiking simulation.
import { DECISIONS, DECISION_KEYS, ODOURS } from './strategies.mjs?v=5';

export const SCHOOL = { hz: 120, ms: 400, feedbackMs: 300, eta: 8e-5, gainMin: 0.05, gainMax: 2, tie: 0.002 };

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
 * @param {typeof import('../../flybrain/flybrain.js').FlyBrain} o.FlyBrain
 * @param {URL} o.base   the flybrain/ directory
 */
export async function makeChooser({ FlyBrain, base, v = '', onProgress }) {
  const C = SCHOOL;
  const mb = JSON.parse(new TextDecoder().decode(await readBytes(new URL('data/mb783.json' + v, base))));
  const brain = await FlyBrain.load({ graph: new URL('data/flywire783.fbg.gz' + v, base), wasm: new URL('flybrain.wasm' + v, base), onProgress });
  const G = mb.groups;
  const pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
  const all = (keys) => keys.flatMap((k) => G[k].idx);
  const KC = all(pick('kc:')), MBON = all(pick('mbon:')), DAN = all(pick('dan:')), MBIN = all(pick('mbin:')), ALPN = all(pick('alpn:'));

  // the mushroom body alone, as for the reading fly: the whole-brain model runs away on olfactory input
  const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);
  const outside = [];
  for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
  brain.silence(outside, true, { byIndex: true });

  // every decision's options in one row of compartments (approach's first), and the 96 MBONs dealt
  // out to them, best-connected first, each to the one with the fewest Kenyon-cell inputs so far
  // (as the reader deals them to letters)
  const OPTIONS = DECISION_KEYS.flatMap((dk) => DECISIONS[dk].options.map((o, i) => ({ decision: dk, i, ...o })));
  const first = {};
  OPTIONS.forEach((o, c) => { if (first[o.decision] == null) first[o.decision] = c; });
  const kcIn = new Map(), mbonSet = new Set(MBON);
  for (const k of KC) for (const i of brain.outgoing(k, { byIndex: true }).post) if (mbonSet.has(i)) kcIn.set(i, (kcIn.get(i) || 0) + 1);
  const typeOf = new Map();
  for (const t of pick('mbon:')) for (const i of G[t].idx) typeOf.set(i, t.slice(5));
  const NS = OPTIONS.length;
  const groups = Array.from({ length: NS }, () => ({ cells: [], types: [], inputs: 0 }));
  // (decisions with `take` came later: first everything is dealt to the others exactly as before - so
  // a brain learned then keeps what each of their compartments had learned - and then each of their
  // compartments takes `take` MBONs, one at a time from whichever compartment has the most cells, its
  // least-connected one)
  const late = OPTIONS.map((o, c) => (DECISIONS[o.decision].take ? c : -1)).filter((c) => c >= 0);
  const early = groups.filter((_, c) => !late.includes(c));
  for (const i of [...kcIn.keys()].sort((a, b) => kcIn.get(b) - kcIn.get(a) || a - b)) {
    let g = early[0];
    for (const h of early) if (h.inputs < g.inputs) g = h;
    g.cells.push(i); g.types.push(typeOf.get(i)); g.inputs += kcIn.get(i);
  }
  for (const c of late) {
    for (let n = 0; n < DECISIONS[OPTIONS[c].decision].take; n++) {
      let from = early[0];
      for (const h of early) if (h.cells.length > from.cells.length) from = h;
      let j = 0;
      for (let q = 1; q < from.cells.length; q++) if (kcIn.get(from.cells[q]) < kcIn.get(from.cells[j])) j = q;
      const [i] = from.cells.splice(j, 1), [ty] = from.types.splice(j, 1);
      from.inputs -= kcIn.get(i);
      groups[c].cells.push(i); groups[c].types.push(ty); groups[c].inputs += kcIn.get(i);
    }
  }
  for (const g of groups) g.name = [...new Set(g.types)].join('+');
  brain.setPlasticity({ pre: KC, groups: groups.map((g) => ({ post: g.cells, modulators: [] })), eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });

  const smell = Object.fromEntries(Object.entries(ODOURS).map(([food, keys]) => [food, keys.flatMap((k) => (G['alpn:' + k] ? G['alpn:' + k].idx : []))]));
  const quiet = (eta = 0) => brain.setPlasticityParams({ eta, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
  let seed = 1;

  /** Smell the food (C.ms of simulated time) and read what each strategy's compartment receives. */
  function sniff(food, s) {
    brain.clearStimuli();
    brain.stimulate(smell[food], C.hz, { byIndex: true });
    quiet();
    brain.reset(s ?? ++seed);
    brain.run(C.ms, { events: false });
    const c = brain.counts(), spikes = new Uint16Array(KC.length);
    let active = 0;
    for (let k = 0; k < KC.length; k++) { const n = c[KC[k]]; if (n) { spikes[k] = Math.min(65535, n); active++; } }
    return { drive: Array.from(brain.driveByGroup(KC, spikes)), active };
  }

  const range = (decision) => DECISIONS[decision].options.map((_, i) => first[decision] + i);

  /**
   * One decision for this food: of that decision's compartments, the one its smell drives least.
   * Compartments within C.tie of the least are as good as tied, and one of them is tried at random
   * (a naive brain drives them all exactly alike, and a fly that has learned nothing yet still has
   * to try something). k is the option's index within the decision.
   */
  function choose(decision, food, s, rnd = Math.random) {
    const { drive: all, active } = sniff(food, s);
    const drive = range(decision).map((c) => all[c]);
    const least = Math.min(...drive), tied = drive.map((v, k) => [v, k]).filter(([v]) => v <= least + C.tie).map(([, k]) => k);
    const k = tied[Math.floor(rnd() * tied.length)];
    return { decision, k, option: DECISIONS[decision].options[k], drive, active, tied: tied.length };
  }

  /** After a trial, with the smell presented again: `levels` = { decision: [k, level] }. */
  function learn(food, levels) {
    const given = Object.entries(levels).filter(([, v]) => v && v[1]);
    if (!given.length) return;
    sniff(food);
    quiet(C.eta);
    for (const [dk, [k, level]] of given) brain.dopamine(first[dk] + k, level);
    brain.run(C.feedbackMs, { events: false });
    for (const [dk, [k]] of given) brain.dopamine(first[dk] + k, 0);
    quiet();
  }

  return {
    brain, groups, decisions: DECISIONS, options: OPTIONS, foods: Object.keys(ODOURS), smell, range,
    sniff, choose, learn,
    exportGains: () => brain.exportGains(),
    importGains: (f32) => brain.importGains(f32),
    gains: () => groups.map((_, c) => brain.gain(c)),
  };
}
