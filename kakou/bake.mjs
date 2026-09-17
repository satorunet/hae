// Bake one grafted brain that both flies of /kaiwa/ run, and check it before writing it out.
//
// Both flies get the *same* brain - they are the same species - and which part of it speaks depends on
// what has happened to that fly. Everything here is from this directory's catalogue and nothing else:
//
//   wants  = W.memory()   written by LC4   ... this fly wants food and cannot find it
//   knows  = W.memory()   written by LC11  ... this fly has seen where food is
//   wants -> DNg02                          ... wanting is asking (a wing buzz)
//   AND(heard a buzz, knows) -> DNp01       ... knowing, and asked, is answering (a click)
//   AND(heard a click, wants) -> MN9        ... told, and still wanting, is eating
//
// Writes ../kaiwa/data/talk783.fbg.gz and ../kaiwa/data/talk783.json (what each added cell is, and the
// sensory groups the page drives), after running the four cases headless.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Workshop, encode } from './graft.mjs';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('../kaiwa/data/', import.meta.url);
const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const G = (re) => [...new Set(Object.keys(groups).filter((k) => re.test(k)).flatMap((k) => groups[k].idx))];

const IN = {
  wants: G(/^vpn:LC4/),                     // the drive: wants food, cannot find it   (MN9 0.0 Hz alone)
  knows: G(/^vpn:LC11/),                    // has seen food                            (MN9 0.0 Hz alone)
  earAsk: G(/^mechano:JO_auditory/),        // where a buzz lands
  earYes: G(/^mechano:JO_wind_gravity/),    // where a click lands
};
const OUTC = {
  buzz: G(/^dn:DNg02/),                     // the wings: asking
  click: G(/^dn:DNp01/),                    // the giant fibre: answering
};
const MN9 = '720575940660219265';
const HZ = 150, CUE = 200;

// ---- drivers: cells that answer one of the four inputs and none of the others
const plain = await (await Workshop.open({ cells: 1 })).build();
const mn9 = plain.index(MN9);
const answers = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 4; s++) {
    plain.clearStimuli(); plain.reset(20 + s); plain.stimulate(cells, HZ, { byIndex: true }); plain.run(CUE);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 4;
  }
  return m;
};
const M = Object.fromEntries(Object.entries(IN).map(([k, v]) => [k, answers(v)]));
const skip = new Set([mn9, ...OUTC.buzz, ...OUTC.click]);
const pick = (k) => {
  const others = Object.keys(IN).filter((o) => o !== k);
  return [...M[k].keys()].filter((i) => M[k][i] >= 2 && !skip.has(i))
    .sort((x, y) => (M[k][y] - Math.max(...others.map((o) => M[o][y]))) - (M[k][x] - Math.max(...others.map((o) => M[o][x])))).slice(0, 24);
};
const D = Object.fromEntries(Object.keys(IN).map((k) => [k, pick(k)]));
for (const k of Object.keys(D)) {
  const own = (D[k].reduce((s, i) => s + M[k][i], 0) / D[k].length).toFixed(1);
  const cross = Math.max(...Object.keys(IN).filter((o) => o !== k).map((o) => D[k].reduce((s, i) => s + M[o][i], 0) / D[k].length)).toFixed(2);
  console.log(`${k.padEnd(7)} ${D[k].length} drivers: ${own} spikes on its own input, at most ${cross} on any other`);
}

// ---- the graft: the same for both flies
const W = await Workshop.open({ cells: 128, slots: 72 });
const wants = W.memory();
const knows = W.memory();
wants.write(D.wants);
knows.write(D.knows);
W.wire(wants, OUTC.buzz, 12);                    // wanting is asking

function andGate(signal, state, out, syn) {      // the disinhibited AND of graft 3
  const gate = W.cells(16), veto = W.cells(8);
  W.wire(signal, gate, 8);
  W.wire(signal, veto, 60);
  W.wire(veto, gate, -128);
  W.wire(state, veto, -128);
  W.wire(gate, out, syn);
  return { gate, veto };
}
const answer = andGate(D.earAsk, knows, OUTC.click, 400);   // asked, and knows -> answers
const eat = andGate(D.earYes, wants, [mn9], 200);           // told, and still wants -> eats
const brain = await W.build();
console.log(`\ngraft: ${W.newCells} cells reserved, ${W.links.length} connections`);

// ---- check it, headless, exactly as /kaiwa/ will drive it
const A = brain, B = await W.build();            // two copies of the same brain
const step = 5, TALK = 1500, ASK_GAIN = 10, YES_GAIN = 30, CAP = 200;
function trial(aWants, bKnows) {
  for (const x of [A, B]) { x.clearStimuli(); x.reset(31); }
  if (aWants) A.stimulate(IN.wants, HZ, { byIndex: true });
  if (bKnows) B.stimulate(IN.knows, HZ, { byIndex: true });
  A.run(CUE); B.run(CUE);
  A.clearStimuli(); B.clearStimuli();
  let pa = Uint32Array.from(A.counts()), pb = Uint32Array.from(B.counts());
  const s0 = { a: pa, b: pb };
  let ah = -1, bh = -1;
  for (let t = 0; t < TALK; t += step) {
    A.run(step); B.run(step);
    const ca = A.counts(), cb = B.counts();
    const buzz = OUTC.buzz.reduce((s, i) => s + (ca[i] - pa[i]), 0);
    const click = OUTC.click.reduce((s, i) => s + (cb[i] - pb[i]), 0);
    pa = Uint32Array.from(ca); pb = Uint32Array.from(cb);
    const wa = Math.min(CAP, buzz * ASK_GAIN), wy = Math.min(CAP, click * YES_GAIN);
    if (Math.abs(wa - bh) > 5) { B.stimulate(IN.earAsk, wa, { byIndex: true }); bh = wa; }
    if (Math.abs(wy - ah) > 5) { A.stimulate(IN.earYes, wy, { byIndex: true }); ah = wy; }
  }
  const ca = A.counts(), cb = B.counts();
  const d = (c, s, idx) => idx.reduce((t, i) => t + (c[i] - s[i]), 0);
  return { ask: d(ca, s0.a, OUTC.buzz), answer: d(cb, s0.b, OUTC.click), eat: ca[mn9] - s0.a[mn9] };
}
console.log('\nA wants  B knows | A asks  B answers | A eats');
let ok = true;
for (const [w, k] of [[true, true], [true, false], [false, true], [false, false]]) {
  const r = trial(w, k);
  const should = w && k;
  if ((r.eat > 2) !== should) ok = false;
  console.log(`${(w ? 'yes' : 'no ').padStart(7)} ${(k ? 'yes' : 'no ').padStart(8)} | ${String(r.ask).padStart(6)} ${String(r.answer).padStart(10)} | ${String(r.eat).padStart(6)}  ${(r.eat > 2) === should ? '' : '** WRONG **'}`);
}
if (!ok) { console.error('\nthe graft does not behave; not writing it out'); process.exit(1); }

// ---- write it
await mkdir(OUT, { recursive: true });
const raw = encode(W.baked);
await writeFile(new URL('talk783.fbg.gz', OUT), gzipSync(raw, { level: 9 }));
const index = {
  n: W.n0 + W.newCells, n0: W.n0, mn9,
  inputs: IN, drivers: D,
  outputs: OUTC,
  parts: { wants: [...wants], knows: [...knows], answerGate: answer.gate, answerVeto: answer.veto, eatGate: eat.gate, eatVeto: eat.veto },
  talk: { step, ASK_GAIN, YES_GAIN, CAP, HZ, CUE },
};
await writeFile(new URL('talk783.json', OUT), JSON.stringify(index));
console.log(`\nwrote kaiwa/data/talk783.fbg.gz (${(gzipSync(raw, { level: 9 }).length / 1048576).toFixed(1)} MB) and talk783.json`);
