// Graft 5 - a visual pathway the connectome does not conduct.
//
// `see.mjs` found that the eye is in the graph but does not reach the brain. Photoreceptors carry 23.2
// outgoing synapses a cell (olfactory receptor neurons carry 158.5, sugar 343.9, bristles 386.8) and
// 1,400 of the 7,932 R1-6 have no output at all. Shown a scene through `retina.mjs` they fire happily -
// and at 30 Hz the optic lobe gets 17 spikes, the visual projection neurons 0, the central brain 0, the
// Kenyon cells 0. At an absurd 1,000 Hz the optic lobe gets 7,506 and the projection neurons 14; the
// central brain still gets nothing. It is not a matter of driving it harder: the chain does not conduct.
//
// So the bridge is built instead. Each ommatidium's R7 - one per ommatidium, 1,336 over both eyes - is
// wired straight onto Kenyon cells, in the shape the olfactory projection neurons use (measured on v783:
// a median of 71 Kenyon cells, 11.9 synapses each, and a Kenyon cell fed by a median of 6 of them). The
// question is whether the mushroom body can then tell one scene from another: leave-one-out nearest
// centroid on the Kenyon-cell codes, over scenes it has never been trained on. Chance is 1/scenes.
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';
import { buildRetina, rates } from './retina.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const HZ = +(arg.hz || 60), BASE = +(arg.base || 2), MS = +(arg.ms || 200), SEEDS = +(arg.seeds || 4);
const FANS = (arg.fan || '0,6,23,71').split(',').map(Number);      // Kenyon cells each ommatidium reaches
const SYN = +(arg.syn || 12);

const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const mb = JSON.parse(await readFile(new URL('flybrain/data/mb783.json', ROOT), 'utf8')).groups;
const KC = [...new Set(Object.keys(mb).filter((k) => /^kc:/.test(k)).flatMap((k) => mb[k].idx))];
const eyes = await buildRetina({ groups });
const OM = ['L', 'R'].flatMap((s) => eyes[s].om.map((o) => o.cell));      // one R7 per ommatidium

// eight places a spot can be, plus two shapes - things a fly should be able to tell apart
const SCENES = {
  'spot ahead': [{ az: 0, el: 0, r: 6, i: 0 }],
  'spot left': [{ az: 60, el: 0, r: 6, i: 0 }],
  'spot right': [{ az: -60, el: 0, r: 6, i: 0 }],
  'spot up': [{ az: 0, el: 40, r: 6, i: 0 }],
  'spot down': [{ az: 0, el: -40, r: 6, i: 0 }],
  'spot up-left': [{ az: 60, el: 40, r: 6, i: 0 }],
  'big disc': [{ az: 0, el: 0, r: 30, i: 0 }],
  'bar across': [...Array(9)].map((_, k) => ({ az: -80 + 20 * k, el: 0, r: 8, i: 0 })),
};
const names = Object.keys(SCENES);

console.log(`${OM.length} ommatidia (R7, both eyes) -> ${KC.length} Kenyon cells, ${SYN} synapses each`);
console.log(`${names.length} scenes, ${SEEDS} presentations each, ${HZ} Hz at full contrast, ${MS} ms\n`);

async function measure(fan) {
  const W = await Workshop.open({ cells: 1, slots: 8 });
  if (fan) {
    let rs = 4242;
    const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const c of OM) {
      const seen = new Set();
      while (seen.size < fan) seen.add(KC[Math.floor(rnd() * KC.length)]);
      for (const k of seen) W.link(c, k, SYN);
    }
  }
  const brain = await W.build();
  const codes = [], truth = [];
  let kcSpikes = 0, active = 0, central = 0;
  for (let s = 0; s < names.length; s++) for (let r = 0; r < SEEDS; r++) {
    brain.clearStimuli();
    const rate = rates(eyes, SCENES[names[s]], { hz: HZ, base: BASE });
    const byRate = new Map();
    for (const [i, v] of rate) { const key = Math.round(v * 2) / 2; if (!byRate.has(key)) byRate.set(key, []); byRate.get(key).push(i); }
    for (const [v, cells] of byRate) brain.stimulate(cells, v, { byIndex: true });
    brain.reset(500 + s * 37 + r);
    brain.run(MS, { events: false });
    const c = brain.counts(), v = new Float64Array(KC.length);
    let on = 0, tot = 0;
    for (let k = 0; k < KC.length; k++) { v[k] = c[KC[k]]; if (v[k]) on++; tot += v[k]; }
    kcSpikes += tot / (names.length * SEEDS); active += on / (names.length * SEEDS);
    codes.push(v); truth.push(s);
  }
  const NL = names.length, per = SEEDS;
  const cent = Array.from({ length: NL }, () => new Float64Array(KC.length));
  for (let p = 0; p < codes.length; p++) for (let k = 0; k < KC.length; k++) cent[truth[p]][k] += codes[p][k] / per;
  let right = 0;
  for (let p = 0; p < codes.length; p++) {
    let best = -1, bd = Infinity;
    for (let cIdx = 0; cIdx < NL; cIdx++) {
      let d = 0;
      for (let k = 0; k < KC.length; k++) {
        const m = cIdx === truth[p] ? (cent[cIdx][k] * per - codes[p][k]) / (per - 1) : cent[cIdx][k];
        d += (codes[p][k] - m) ** 2;
      }
      if (d < bd) { bd = d; best = cIdx; }
    }
    if (best === truth[p]) right++;
  }
  return { sep: right / codes.length, kcSpikes, active: active / KC.length };
}

console.log('KCs per ommatidium | Kenyon spikes a scene | Kenyon cells firing | scenes told apart (chance ' + (1 / names.length).toFixed(3) + ')');
for (const fan of FANS) {
  const t = Date.now();
  const r = await measure(fan);
  console.log(`${String(fan).padStart(18)} | ${r.kcSpikes.toFixed(0).padStart(21)} | ${(100 * r.active).toFixed(1).padStart(18)}% | ${r.sep.toFixed(3).padStart(24)}   (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}
