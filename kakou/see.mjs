// Does a picture put in through the retina drive the fly's own visual system?
//
// retina.mjs gives each photoreceptor a line of sight; this shows the eye a scene and asks what answers
// - the photoreceptors themselves, the optic lobe, and the object-detecting cells the connectome has
// names for (LC4, LPLC2, LPLC1, LC6, LC11). Nothing is grafted here. It is the check that has to pass
// before wiring the visual system anywhere: if the eye does not reach the lobula, there is no signal to
// bridge to the mushroom body.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Workshop } from './graft.mjs';
import { buildRetina, rates } from './retina.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const HZ = +(arg.hz || 30), BASE = +(arg.base || 2), MS = +(arg.ms || 200);

const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const eyes = await buildRetina({ groups });
const brain = await (await Workshop.open({ cells: 1 })).build();

// what each kind of cell is, for counting where the spikes land
const pos = new Uint8Array(gunzipSync(await readFile(new URL('flybrain/data/pos783.bin.gz', ROOT))));
const n = new DataView(pos.buffer, pos.byteOffset).getUint32(4, true);
const klass = pos.subarray(8 + 4 * n, 8 + 5 * n);
const CLASSES = ['sensory', 'optic', 'central', 'visual projection', 'visual centrifugal', 'ascending', 'descending', 'motor', 'endocrine'];
const photo = new Set(Object.keys(groups).filter((k) => /^visual:R/.test(k)).flatMap((k) => groups[k].idx));
const named = ['vpn:LC4', 'vpn:LPLC2', 'vpn:LPLC1', 'vpn:LC6', 'vpn:LC11'];
const mb = JSON.parse(await readFile(new URL('flybrain/data/mb783.json', ROOT), 'utf8')).groups;
const KC = [...new Set(Object.keys(mb).filter((k) => /^kc:/.test(k)).flatMap((k) => mb[k].idx))];

const SCENES = {
  nothing: [],
  'spot ahead': [{ az: 0, el: 0, r: 5, i: 0 }],
  'spot left': [{ az: 60, el: 0, r: 5, i: 0 }],
  'spot right': [{ az: -60, el: 0, r: 5, i: 0 }],
  'spot above': [{ az: 0, el: 40, r: 5, i: 0 }],
  'big disc left': [{ az: 60, el: 0, r: 25, i: 0 }],
  'bar across': [...Array(9)].map((_, k) => ({ az: -80 + 20 * k, el: 0, r: 8, i: 0 })),
};

console.log(`retina ${eyes.L.om.length} ommatidia an eye, ${HZ} Hz at full contrast (background ${BASE} Hz), ${MS} ms\n`);
console.log('scene              spikes  photoreceptors   optic   visual proj   central   Kenyon |   LC4  LPLC2  LPLC1   LC6  LC11');
for (const [name, objects] of Object.entries(SCENES)) {
  brain.clearStimuli();
  const r = rates(eyes, objects, { hz: HZ, base: BASE });
  const byRate = new Map();
  for (const [i, v] of r) { const key = Math.round(v * 2) / 2; if (!byRate.has(key)) byRate.set(key, []); byRate.get(key).push(i); }
  for (const [v, cells] of byRate) brain.stimulate(cells, v, { byIndex: true });
  brain.reset(3);
  const res = brain.run(MS, { events: false });
  const c = brain.counts();
  const tot = { photo: 0, optic: 0, vpn: 0, central: 0, kc: 0 };
  for (let i = 0; i < brain.n && i < n; i++) {
    const s = c[i];
    if (!s) continue;
    if (photo.has(i)) tot.photo += s;
    else if (klass[i] === 1) tot.optic += s;
    else if (klass[i] === 3 || klass[i] === 4) tot.vpn += s;
    else tot.central += s;
  }
  for (const k of KC) tot.kc += c[k];
  const lc = named.map((p) => {
    const idx = [...new Set([`${p}:L`, `${p}:R`].flatMap((k) => (groups[k] ? groups[k].idx : [])))];
    return idx.reduce((s, i) => s + c[i], 0);
  });
  console.log(`${name.padEnd(16)} ${String(res.spikes).padStart(8)} ${String(tot.photo).padStart(15)} ${String(tot.optic).padStart(7)} ${String(tot.vpn).padStart(13)} ${String(tot.central).padStart(9)} ${String(tot.kc).padStart(8)} | ${lc.map((v) => String(v).padStart(5)).join(' ')}`);
}
