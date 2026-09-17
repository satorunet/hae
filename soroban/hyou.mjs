// 表で答える - the fly learns the addition table instead of counting it out.
//
// soroban/machine.mjs adds the way a child first does: by counting. 7 + 8 is fifteen turns of a clock,
// and a three-digit sum is seconds of fly. A child stops doing that once it has learnt 7 + 8 = 15 - the
// answer is *recalled*, not computed. This fly has the machine for exactly that: the mushroom body,
// which is what /suji/ and /hiragana/ learn with, and it answers in one look.
//
//   a question = three one-hot patterns into the olfactory channels: the digit a, the digit b, and the
//                carry coming in
//   an answer  = two readouts off the same Kenyon-cell code: the sum digit (10 compartments) and the
//                carry going out (2), each learnt by dopamine-gated depression exactly as a letter is
//
// 200 questions cover the whole of column addition (10 x 10 x 2), and one look answers a digit
// *including its carry*, so an N-digit sum is N looks instead of up to 9N turns of the clock.
//
//   node soroban/hyou.mjs                   # learn the addition table, then test all 200
//   node soroban/hyou.mjs op=x              # the multiplication table (九九): 100 questions, two digits out
//   node soroban/hyou.mjs epochs=20 hz=270
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const OP = arg.op === 'x' || arg.op === '*' ? '*' : '+';
const EPOCHS = +(arg.epochs || 12), HZ = +(arg.hz || 270), MS = +(arg.ms || 400), FB = +(arg.fb || 300);
const ETA = +(arg.eta || 6e-5), SEED = +(arg.seed || 5);

// ---- the questions: a, b, carry in -> the digit that goes down, and the carry that goes up
const QS = [];
for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) {
  if (OP === '+') for (const c of [0, 1]) QS.push({ a, b, c, out: (a + b + c) % 10, up: ((a + b + c) / 10) | 0 });
  else QS.push({ a, b, c: 0, out: (a * b) % 10, up: ((a * b) / 10) | 0 });
}
const UP = OP === '+' ? 2 : 9;                      // how many values the upper digit can take
// How the question is put to the nose.
//   split: one channel per digit - a, b and the carry lit separately (10 + 10 + 2)
//   pair:  one channel per *pair* - the question is a single thing, the way 「しちはごじゅうろく」 is
const ENC = arg.enc || 'pair';
const NCH = ENC === 'split' ? 10 + 10 + (OP === '+' ? 2 : 0) : 100 + (OP === '+' ? 2 : 0);
const KCH = +(arg.k || 60);                         // projection neurons per channel (they overlap)

// ---- the mushroom body, and nothing else
const mb = JSON.parse(await readFile(new URL('flybrain/data/mb783.json', ROOT), 'utf8'));
const G = mb.groups, pick = (p) => Object.keys(G).filter((k) => k.startsWith(p)).sort();
const all = (keys) => keys.flatMap((k) => G[k].idx);
const KC = all(pick('kc:')), MBON = all(pick('mbon:')), DAN = all(pick('dan:')), MBIN = all(pick('mbin:')), ALPN = all(pick('alpn:'));
const brain = await FlyBrain.load({ graph: new URL('flybrain/data/flywire783.fbg.gz', ROOT), wasm: new URL('flybrain/flybrain.wasm', ROOT) });
const inside = new Set([...KC, ...MBON, ...DAN, ...MBIN, ...ALPN]);
const outside = [];
for (let i = 0; i < brain.n; i++) if (!inside.has(i)) outside.push(i);
brain.silence(outside, true, { byIndex: true });

// ---- 10 + UP compartments, the MBONs dealt out best-connected first (juku/reader.mjs)
const kcIn = new Map(), mbonSet = new Set(MBON);
for (const k of KC) for (const i of brain.outgoing(k, { byIndex: true }).post) if (mbonSet.has(i)) kcIn.set(i, (kcIn.get(i) || 0) + 1);
const NG = 10 + UP;
const groups = Array.from({ length: NG }, () => ({ cells: [], inputs: 0 }));
for (const i of [...kcIn.keys()].sort((a, b) => kcIn.get(b) - kcIn.get(a) || a - b)) {
  let g = groups[0];
  for (const x of groups) if (x.inputs < g.inputs) g = x;
  g.cells.push(i); g.inputs += kcIn.get(i);
}
const counts = brain.setPlasticity({ pre: KC, groups: groups.map((g) => ({ post: g.cells, modulators: [] })), eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: 0.05, gainMax: 2 });
console.log(`${NG} compartments (${10} for the digit, ${UP} for the carry), ${counts.reduce((a, b) => a + b, 0)} plastic synapses`);

// ---- the channels: the 685 projection neurons dealt round-robin, as a picture's pixels are
let rs = 20260917;
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const deck = [...ALPN];
for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
// a channel is KCH projection neurons taken at random - channels overlap, as odours do
const chan = Array.from({ length: NCH }, () => {
  const pool = [...deck], out = [];
  for (let i = 0; i < KCH; i++) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
});
const lines = (q) => (ENC === 'split'
  ? [q.a, 10 + q.b, ...(OP === '+' ? [20 + q.c] : [])]
  : [q.a * 10 + q.b, ...(OP === '+' ? [100 + q.c] : [])]);
const ask = (q) => {
  brain.clearStimuli();
  for (const ch of lines(q)) brain.stimulate(chan[ch], HZ, { byIndex: true });
};
let seed = SEED;
const params = (eta) => brain.setPlasticityParams({ eta, tauTrace: 40, tauDopa: 1e7, gainMin: 0.05, gainMax: 2 });
function look(q) {
  ask(q); params(0); brain.reset(++seed);
  brain.run(MS, { events: false });
  const c = brain.counts(), spikes = new Uint16Array(KC.length);
  let lit = 0;
  for (let k = 0; k < KC.length; k++) { const n = c[KC[k]]; if (n) { spikes[k] = Math.min(65535, n); lit++; } }
  const drive = brain.driveByGroup(KC, spikes);
  const least = (from, to) => { let best = from; for (let i = from; i < to; i++) if (drive[i] < drive[best]) best = i; return best; };
  return { out: least(0, 10), up: least(10, NG) - 10, lit: lit / KC.length };
}
function teach(truth, wrong) {           // the picture is still up, as juku/reader.mjs does it
  params(ETA);
  brain.dopamine(truth, 1);
  if (wrong != null && wrong !== truth) brain.dopamine(wrong, -1);
  brain.run(FB, { events: false });
  brain.dopamine(truth, 0);
  if (wrong != null) brain.dopamine(wrong, 0);
  params(0);
}

const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const test = () => {
  let o = 0, u = 0, both = 0, lit = 0;
  for (const q of QS) {
    const r = look(q);
    o += r.out === q.out; u += r.up === q.up; both += r.out === q.out && r.up === q.up; lit += r.lit / QS.length;
  }
  return { o: o / QS.length, u: u / QS.length, both: both / QS.length, lit };
};

console.log(`${QS.length} questions, ${OP === '+' ? 'a + b + carry' : 'a x b'}, encoding "${ENC}": ${NCH} channels of ${KCH} projection neurons, ${HZ} Hz, ${MS} ms a look\n`);
const t0 = Date.now();
let flyMs = 0;
console.log('epoch | practised | the digit | the carry |  both | KC firing | wall');
const r0 = test();
console.log(`    0 |         0 |    ${(r0.o * 100).toFixed(1).padStart(5)}% |    ${(r0.u * 100).toFixed(1).padStart(5)}% | ${(r0.both * 100).toFixed(1).padStart(5)}% | ${(r0.lit * 100).toFixed(1).padStart(8)}% | ${((Date.now() - t0) / 1e3).toFixed(0)}s`);
let done = 0;
for (let e = 1; e <= EPOCHS; e++) {
  for (const q of shuffle(QS)) {
    const r = look(q); flyMs += MS; done++;
    if (r.out !== q.out) { teach(q.out, r.out); flyMs += FB; }
    if (r.up !== q.up) { teach(10 + q.up, 10 + r.up); flyMs += FB; }
  }
  const t = test();
  console.log(`${String(e).padStart(5)} | ${String(done).padStart(9)} |    ${(t.o * 100).toFixed(1).padStart(5)}% |    ${(t.u * 100).toFixed(1).padStart(5)}% | ${(t.both * 100).toFixed(1).padStart(5)}% | ${(t.lit * 100).toFixed(1).padStart(8)}% | ${((Date.now() - t0) / 1e3).toFixed(0)}s`);
  if (t.both === 1) { console.log('\nit knows the table.'); break; }
}
const final = test();
console.log(`\none look is ${MS} ms of fly and answers a digit and its carry;`);
console.log(`the counting machine needs up to 9 turns of the clock a digit, ${9 * (260 + 100 + 100 + 50)} ms.`);
if (arg.save) {
  const gains = brain.exportGains();
  await writeFile(new URL(arg.save, import.meta.url), gzipSync(Buffer.from(gains.buffer), { level: 9 }));
  console.log(`wrote ${arg.save} (${(gains.length * 4 / 1024).toFixed(0)} KB of gains)`);
}
console.log(`final: digit ${(final.o * 100).toFixed(1)}%, carry ${(final.u * 100).toFixed(1)}%, both ${(final.both * 100).toFixed(1)}%`);
