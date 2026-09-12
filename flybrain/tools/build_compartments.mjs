/**
 * Work out which dopaminergic neurons gate which MBON, from the connectome
 * alone - no hand-typed anatomy table.
 *
 *     node build_compartments.mjs ../data/mb783.json ../data/flywire783.fbg.gz OUT.json
 *
 * A mushroom-body compartment is one slice of the Kenyon-cell axon bundle. The
 * DANs that end in it and the MBON that reads it are wired directly to each
 * other, and they meet the same Kenyon cells, so each MBON is scored against
 * every DAN type on both counts:
 *
 *   direct  synapses between the two, either way, per MBON cell
 *   shared  cosine of their Kenyon-cell synapse-count vectors
 *
 * `direct` is what picks the compartment out - it is sharply peaked (MBON11
 * against PPL101, the known MBON-y1pedc / PPL1-y1pedc pair, is 626 synapses
 * per cell against 39 for the runner-up), while `shared` is broad because a
 * PAM type covers a whole lobe. The output therefore gates each MBON by the
 * DANs holding at least `FLOOR` of its strongest direct partner, weighted by
 * their share, and labels the compartment by whether that partner is a PAM
 * (reward) or a PPL1 (punishment).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FlyBrain } from '../flybrain.js';

const FLOOR = 0.15;
const [mbPath, graphPath, outPath] = process.argv.slice(2);
const G = JSON.parse(readFileSync(mbPath)).groups;
const pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
const brain = await FlyBrain.load({ graph: graphPath });

const kcTypes = pick('kc:'), mbonTypes = pick('mbon:'), danTypes = pick('dan:');
const KC = kcTypes.flatMap((k) => G[k].idx);
const kcAt = new Map(KC.map((k, i) => [k, i]));
const mbonOf = new Map(), danOf = new Map();
for (const m of mbonTypes) for (const i of G[m].idx) mbonOf.set(i, m);
for (const d of danTypes) for (const i of G[d].idx) danOf.set(i, d);

// direct synapses between each MBON type and each DAN type, both directions
const direct = {};
for (const m of mbonTypes) direct[m] = {};
const tally = (from, lookup, key) => {
  const { post, synapses } = brain.outgoing(from, { byIndex: true });
  for (let q = 0; q < post.length; q++) {
    const other = lookup.get(post[q]);
    if (other) key(other, Math.abs(synapses[q]));
  }
};
for (const d of danTypes) for (const j of G[d].idx)
  tally(j, mbonOf, (m, s) => { direct[m][d] = (direct[m][d] || 0) + s; });
for (const m of mbonTypes) for (const i of G[m].idx)
  tally(i, danOf, (d, s) => { direct[m][d] = (direct[m][d] || 0) + s; });
for (const m of mbonTypes)
  for (const d of Object.keys(direct[m])) direct[m][d] = +(direct[m][d] / G[m].idx.length).toFixed(1);

// the Kenyon cells each side touches, for the secondary score
const onMbon = new Map(mbonTypes.map((m) => [m, new Float64Array(KC.length)]));
for (const k of KC) {
  const { post, synapses } = brain.outgoing(k, { byIndex: true });
  for (let q = 0; q < post.length; q++) {
    const m = mbonOf.get(post[q]);
    if (m) onMbon.get(m)[kcAt.get(k)] += Math.abs(synapses[q]);
  }
}
const onKc = new Map();
for (const d of danTypes) {
  const v = new Float64Array(KC.length);
  for (const j of G[d].idx) {
    const { post, synapses } = brain.outgoing(j, { byIndex: true });
    for (let q = 0; q < post.length; q++) {
      const at = kcAt.get(post[q]);
      if (at !== undefined) v[at] += Math.abs(synapses[q]);
    }
  }
  onKc.set(d, v);
}
const cos = (a, b) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
};
const shared = {};
for (const m of mbonTypes) {
  shared[m] = {};
  for (const d of danTypes) {
    const c = cos(onMbon.get(m), onKc.get(d));
    if (c > 0.05) shared[m][d] = +c.toFixed(3);
  }
}

// the gating: DANs above FLOOR of the MBON's strongest direct partner
const gate = {}, valence = {};
for (const m of mbonTypes) {
  const rows = Object.entries(direct[m]).sort((a, b) => b[1] - a[1]);
  const top = rows.length ? rows[0][1] : 0;
  const keep = rows.filter(([, s]) => s >= FLOOR * top && s > 0);
  const sum = keep.reduce((a, [, s]) => a + s, 0) || 1;
  gate[m] = Object.fromEntries(keep.map(([d, s]) => [d, +(s / sum).toFixed(3)]));
  const side = (re) => keep.filter(([d]) => re.test(d)).reduce((a, [, s]) => a + s, 0) / sum;
  valence[m] = { punish: +side(/dan:PPL1/).toFixed(3), reward: +side(/dan:PAM/).toFixed(3),
                 top: rows.length ? rows[0][0].slice(4) : null, topSynapses: top };
}
writeFileSync(outPath, JSON.stringify({ dataset: 'FlyWire v783', floor: FLOOR,
  direct, shared, gate, valence }, null, 0));

console.log(`${mbonTypes.length} MBON types x ${danTypes.length} DAN types -> ${outPath}`);
console.log('MBON         compartment (direct synapses per MBON cell)      side');
for (const m of mbonTypes) {
  const v = valence[m];
  console.log(`  ${m.slice(5).padEnd(13)} ${(v.top || '-').padEnd(7)} ${String(v.topSynapses).padStart(6)}   ` +
    `${Object.keys(gate[m]).length} DAN types   ` +
    (v.punish > v.reward ? 'punishment' : v.reward > v.punish ? 'reward' : '-'));
}
