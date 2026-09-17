// Does a graft make a *learned* task better? The one thing the rest of this directory does not show.
//
// The same reading task /hiragana/ runs (juku/reader.mjs): a 16x16 picture dealt round-robin across the
// channels, 400 ms, the Kenyon cells' drive on 46 MBON compartments read out, and the compartment driven
// least is the answer. Error-driven: the fly answers first, and only a wrong answer brings dopamine -
// the right letter's compartment weakened, the one it picked strengthened - while the picture is still up.
// Trained on the fonts /hiragana/ trains on, tested on the five it never sees.
//
// The learning machinery is reader.mjs's, rebuilt here so that production is not touched and so that the
// brain can be a grafted one. Conditions, all at the same number of practices:
//
//   ch=0            302 channels - the brain as it is
//   free=1 ch=383   685 - the 383 projection neurons that are already there and reach no Kenyon cell,
//                   wired in. No new cell at all, connections only.
//   ch=1300         1,602 - new projection neurons, wired as the real ones are
//   ch=1300 kc=15531  the same, and 20,708 Kenyon cells: wired in as real ones are, inside APL's loop,
//                   and out to 12 MBONs each so the readout can see them
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Workshop } from './graft.mjs';
import * as K from '../hiragana/kana.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const ADD = +(arg.ch || 0), GROWKC = +(arg.kc || 0), FREE = arg.free === '1';
const PRACTICE = +(arg.practice || 2000), TAG = arg.tag || `ch+${ADD}${FREE ? ' (already there)' : ''}${GROWKC ? ` kc+${GROWKC}` : ''}`;
const C = { size: 16, hz: 270, ink: 0.05, ms: 400, feedbackMs: 300, eta: 6e-5, gainMin: 0.05, gainMax: 2 };
const NPIX = C.size * C.size, NL = 46;

const mb = JSON.parse(await readFile(new URL('flybrain/data/mb783.json', ROOT), 'utf8')).groups;
const pickKeys = (p) => Object.keys(mb).filter((k) => k.startsWith(p)).sort();
const all = (keys) => [...new Set(keys.flatMap((k) => mb[k].idx))];
const KC0 = all(pickKeys('kc:')), MBON = all(pickKeys('mbon:')), DAN = all(pickKeys('dan:')),
      MBIN = all(pickKeys('mbin:')), ALPN = all(pickKeys('alpn:')), APL = all(pickKeys('mbin:APL'));

// which projection neurons reach a Kenyon cell
const probe = await (await Workshop.open({ cells: 1 })).build();
const { graphOf } = await import('../shinka/genome.mjs');
const Gp = graphOf(probe), kcSet = new Set(KC0);
const effective = ALPN.filter((p) => { for (let q = Gp.indptr[p]; q < Gp.indptr[p + 1]; q++) if (Gp.w[q] > 0 && kcSet.has(Gp.post[q])) return true; return false; });
const idle = ALPN.filter((p) => !effective.includes(p));

// ---- build the brain for this condition
const W = await Workshop.open({ cells: (FREE ? 1 : Math.max(1, ADD)) + GROWKC, slots: 96 });
const fresh = FREE ? idle.slice(0, ADD) : (ADD ? W.cells(ADD) : []);
const newKc = GROWKC ? W.cells(GROWKC) : [];
let rs = 777;
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (const c of fresh) { const seen = new Set(); while (seen.size < 71) seen.add(KC0[Math.floor(rnd() * KC0.length)]); for (const k of seen) W.link(c, k, 12); }
const channels = [...effective, ...fresh];
for (const k of newKc) {
  const seen = new Set();
  while (seen.size < 6) seen.add(channels[Math.floor(rnd() * channels.length)]);
  for (const c of seen) W.link(c, k, 12);
  for (const a of APL) { W.link(a, k, -19); W.link(k, a, 22); }
  const out = new Set();                                  // and out to the readout, or it is invisible
  while (out.size < 12) out.add(MBON[Math.floor(rnd() * MBON.length)]);
  for (const m of out) W.link(k, m, 4);
}
const brain = await W.build();
const KC = [...KC0, ...newKc];
const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN, ...fresh]);
const outside = [];
for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
brain.silence(outside, true, { byIndex: true });

// ---- the 46 compartments: MBONs dealt out so each gets a comparable share of Kenyon input
const kcIn = new Map(), mbonSet = new Set(MBON);
for (const k of KC) { const { post } = brain.outgoing(k, { byIndex: true }); for (const i of post) if (mbonSet.has(i)) kcIn.set(i, (kcIn.get(i) || 0) + 1); }
const groups = Array.from({ length: NL }, () => ({ cells: [], inputs: 0 }));
for (const i of [...kcIn.keys()].sort((a, b) => kcIn.get(b) - kcIn.get(a) || a - b)) {
  let g = groups[0];
  for (const c of groups) if (c.inputs < g.inputs) g = c;
  g.cells.push(i); g.inputs += kcIn.get(i);
}
brain.setPlasticity({ pre: KC, groups: groups.map((g) => ({ post: g.cells, modulators: [] })), eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });

// ---- pixels to channels, as reader.mjs deals them
let ds = 12345;
const drnd = () => ((ds = (ds * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const deck = [...channels];
for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(drnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
const chan = Array.from({ length: NPIX }, () => []);
deck.forEach((p, i) => chan[i % NPIX].push(p));

const meta = JSON.parse(await readFile(new URL('hiragana/kana48.json', ROOT), 'utf8'));
const bank = K.unpackBank(gunzipSync(await readFile(new URL('hiragana/kana48.bin.gz', ROOT))), meta);
const testFonts = K.TEST_FONTS.map((n) => bank.fonts.indexOf(n)).filter((i) => i >= 0);
const trainFonts = [...Array(bank.nf).keys()].filter((f) => !testFonts.includes(f));

let seed = 1;
function look(img) {
  brain.clearStimuli();
  for (let i = 0; i < NPIX; i++) if (img[i] > C.ink) brain.stimulate(chan[i], C.hz * img[i], { byIndex: true });
  brain.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
  brain.reset(++seed);
  brain.run(C.ms, { events: false });
  const c = brain.counts(), spikes = new Uint16Array(KC.length);
  for (let k = 0; k < KC.length; k++) spikes[k] = Math.min(65535, c[KC[k]]);
  return brain.driveByGroup(KC, spikes);
}
const decide = (drive) => { let best = 0; for (let c = 1; c < NL; c++) if (drive[c] < drive[best]) best = c; return best; };
function feedback(truth, wrong) {
  brain.setPlasticityParams({ eta: C.eta, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
  brain.dopamine(truth, 1);
  if (wrong !== truth) brain.dopamine(wrong, -1);
  brain.run(C.feedbackMs, { events: false });
  brain.dopamine(truth, 0); brain.dopamine(wrong, 0);
  brain.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
}

function test() {
  let right = 0, n = 0;
  for (let k = 0; k < NL; k++) for (const f of testFonts) {
    if (decide(look(K.sample(bank, f, k, K.mulberry32(50000 + k * 97 + f)))) === k) right++;
    n++;
  }
  return right / n;
}

const t0 = Date.now();
console.log(`${TAG}: ${channels.length} channels, ${KC.length} Kenyon cells, ${MBON.length} MBONs, ${PRACTICE} practices`);
let rrnd = K.mulberry32(4242), window = [];
for (let p = 1; p <= PRACTICE; p++) {
  const k = Math.floor(rrnd() * NL), f = trainFonts[Math.floor(rrnd() * trainFonts.length)];
  const img = K.sample(bank, f, k, rrnd);
  const answer = decide(look(img));
  const ok = answer === k;
  if (!ok) feedback(k, answer);
  window.push(ok ? 1 : 0);
  if (window.length > 500) window.shift();
  if (p % 500 === 0) console.log(`  ${String(p).padStart(5)} practised  running ${(window.reduce((s, v) => s + v, 0) / window.length).toFixed(3)}  (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}
console.log(`${TAG}: TEST ${test().toFixed(4)} on unseen fonts after ${PRACTICE} practices  (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
