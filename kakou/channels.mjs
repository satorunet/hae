// Graft 4 - widening the way in to the mushroom body.
//
// /hiragana/ puts a 16x16 picture into this brain through the olfactory projection neurons, dealt
// round-robin (juku/reader.mjs), and the mushroom body learns it: 46 letters at 84.35% after 100,000
// practices. The way in is narrower than it looks - of the 685 projection neurons **302 reach a Kenyon
// cell at all**, so 256 pixels are really going in through 302 channels, 1.18 apiece. And the way out is
// not what is holding it back: the correlation between a letter's accuracy and the size of its MBON
// compartment is r = -0.019, and the letters it fails are the ones that look alike.
//
// So: more channels. New cells wired onto the Kenyon cells the way the real ones are - measured on v783,
// a projection neuron reaches a median of 71 Kenyon cells with 11.9 synapses each, and a Kenyon cell is
// fed by a median of 6 of them (a real fly has 6-8 claws).
//
// Measured without any training, because what a wider way in can buy is set before the readout: present
// each letter and ask how separable the **Kenyon-cell codes** are - leave-one-out nearest centroid over
// the 46 letters. That is the information the compartments have to work with. Sparseness is printed with
// it, because feeding the Kenyon cells more can only help if they stay sparse.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Workshop } from './graft.mjs';
import * as K from '../hiragana/kana.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const HZ = +(arg.hz || 270), INK = 0.05, MS = 400, SIZE = 16, NPIX = SIZE * SIZE;
const NEW = (arg.add || '0,150,300,600').split(',').map(Number);
const FREE = arg.free === '1';        // instead of new cells, wire in the 383 projection neurons that
                                      // are already there and reach no Kenyon cell
const SYN = (arg.syn || '12').split(',').map(Number);
const KCS = +(arg.kcs || 71);                       // Kenyon cells a new channel reaches
const NLET = +(arg.letters || 46), NSAMP = +(arg.samples || 5);
const GROWKC = (arg.kc || '0').split(',').map(Number);   // Kenyon cells to add, wired as the real ones are:
                                      // 6 channels in at 12 synapses, APL's inhibition in at -19, and
                                      // 22 synapses back to APL, so the new cells are inside the loop
                                      // that keeps the code sparse
const QUIET = arg.quiet !== '0';      // silence everything outside the mushroom body, as juku/reader.mjs
                                      // does (the whole-brain model runs away on olfactory input)

const mb = JSON.parse(await readFile(new URL('flybrain/data/mb783.json', ROOT), 'utf8')).groups;
const setOf = (re) => [...new Set(Object.keys(mb).filter((k) => re.test(k)).flatMap((k) => mb[k].idx || mb[k]))];
const KC = setOf(/^kc:/), ALPN = setOf(/^alpn:/);
const MBON = setOf(/^mbon:/), DAN = setOf(/^dan:/), MBIN = setOf(/^mbin:/);
const APL = setOf(/^mbin:APL/);
const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);

// which projection neurons actually reach a Kenyon cell
const probe = await (await Workshop.open({ cells: 1 })).build();
const { graphOf } = await import('../shinka/genome.mjs');
const Gp = graphOf(probe);
const kcSet = new Set(KC);
const effective = ALPN.filter((p) => {
  for (let q = Gp.indptr[p]; q < Gp.indptr[p + 1]; q++) if (Gp.w[q] > 0 && kcSet.has(Gp.post[q])) return true;
  return false;
});
console.log(`projection neurons: ${ALPN.length}, of which ${effective.length} reach a Kenyon cell`);

const meta = JSON.parse(await readFile(new URL('hiragana/kana48.json', ROOT), 'utf8'));
const bank = K.unpackBank(gunzipSync(await readFile(new URL('hiragana/kana48.bin.gz', ROOT))), meta);
const fonts = K.TEST_FONTS.map((n) => bank.fonts.indexOf(n)).filter((i) => i >= 0);
console.log(`letters ${NLET}, ${NSAMP} pictures each, fonts ${fonts.length}\n`);

const rnd0 = K.mulberry32(99);
const pics = [];
for (let k = 0; k < NLET; k++) for (let s = 0; s < NSAMP; s++)
  pics.push({ truth: k, img: K.sample(bank, fonts[s % fonts.length], k, K.mulberry32(1000 + k * 97 + s)) });

function deal(channels) {                        // pixels -> channels, round-robin as reader.mjs does
  let rs = 12345;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const deck = [...channels];
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  const chan = Array.from({ length: NPIX }, () => []);
  deck.forEach((p, i) => chan[i % NPIX].push(p));
  return chan;
}

const idle = ALPN.filter((p) => !effective.includes(p));      // the 383 that reach nothing

async function measure(add, syn, growKc = 0) {
  const useFree = FREE && add > 0;
  const W = await Workshop.open({ cells: (useFree ? 1 : Math.max(1, add)) + growKc, slots: Math.max(KCS, 16) + 4 });
  const fresh = useFree ? idle.slice(0, add) : (add ? W.cells(add) : []);
  const newKc = growKc ? W.cells(growKc) : [];
  let rs = 777;
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const c of fresh) {                        // the same shape as a real projection neuron
    const seen = new Set();
    while (seen.size < KCS) seen.add(KC[Math.floor(rnd() * KC.length)]);
    for (const k of seen) W.link(c, k, syn);
  }
  let rk = 31337;
  const rk1 = () => ((rk = (rk * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const channels = [...effective, ...fresh];
  for (const k of newKc) {                          // a new Kenyon cell, wired as the real ones are
    const seen = new Set();
    while (seen.size < 6) seen.add(channels[Math.floor(rk1() * channels.length)]);
    for (const c of seen) W.link(c, k, 12);
    for (const a of APL) { W.link(a, k, -19); W.link(k, a, 22); }
  }
  const brain = await W.build();
  if (QUIET) {
    const outside = [];
    const keep = new Set([...fresh, ...newKc]);
    for (let i = 0; i < brain.n; i++) if (!inside.has(i) && !keep.has(i)) outside.push(i);
    brain.silence(outside, true, { byIndex: true });
  }
  const chan = deal([...effective, ...fresh]);
  const codes = [];
  let active = 0;
  for (let p = 0; p < pics.length; p++) {
    const img = pics[p].img;
    brain.clearStimuli();
    for (let i = 0; i < NPIX; i++) if (img[i] > INK) brain.stimulate(chan[i], HZ * img[i], { byIndex: true });
    brain.reset(1000 + p);
    brain.run(MS, { events: false });
    const all = [...KC, ...newKc];
    const c = brain.counts(), v = new Float64Array(all.length);
    let on = 0;
    for (let k = 0; k < all.length; k++) { v[k] = c[all[k]]; if (v[k]) on++; }
    active += on / pics.length / all.length;
    codes.push(v);
  }
  // leave-one-out nearest centroid over the letters
  const NL = NLET, per = NSAMP;
  let right = 0;
  const DIM = codes[0].length;
  const cent = Array.from({ length: NL }, () => new Float64Array(DIM));
  for (let p = 0; p < codes.length; p++) for (let k = 0; k < DIM; k++) cent[pics[p].truth][k] += codes[p][k] / per;
  for (let p = 0; p < codes.length; p++) {
    const t = pics[p].truth;
    let best = -1, bd = Infinity;
    for (let c = 0; c < NL; c++) {
      let d = 0;
      for (let k = 0; k < DIM; k++) {
        const m = c === t ? (cent[c][k] * per - codes[p][k]) / (per - 1) : cent[c][k];
        d += (codes[p][k] - m) ** 2;
      }
      if (d < bd) { bd = d; best = c; }
    }
    if (best === t) right++;
  }
  return { sep: right / codes.length, active };
}

console.log('channels  new  Kenyon | Kenyon cells firing | letters told apart (chance ' + (1 / NLET).toFixed(3) + ')');
for (const add of NEW) for (const syn of (add ? SYN : [12])) for (const gk of GROWKC) {
  const t = Date.now();
  const r = await measure(add, syn, gk);
  console.log(`${String(effective.length + add).padStart(8)} ${String(add).padStart(4)} ${String(KC.length + gk).padStart(7)} | ${(100 * r.active).toFixed(1).padStart(18)}% | ${r.sep.toFixed(3).padStart(18)}   (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}
