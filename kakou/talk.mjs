// The smallest conversation: two brains, a question, an answer, and an action that depends on it.
//
//   A is hungry. It cannot find food, so it asks - a wing buzz (DNg02).
//   B has seen food, or has not. Hearing the question (Johnston's organ), and only if it knows,
//     it answers - a click (the giant fibre, DNp01).
//   A hears the answer (Johnston's wind and gravity neurons) and, only if it is still hungry, eats (MN9).
//
// Every part of that is beyond a plain fly brain in this model: B cannot hold "I saw food" for longer
// than 50 ms, and neither of them can put a heard signal together with something they already know.
// Both are grafts from this directory - `W.memory()` and the disinhibited AND gate - and nothing else
// is added. The two brains are stepped 5 ms at a time and each hears what the other's motor neurons did
// in that slice, which is how shinka's world couples them too.
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const G = (re) => [...new Set(Object.keys(groups).filter((k) => re.test(k)).flatMap((k) => groups[k].idx))];

// A's drive and B's knowledge have to be inputs that do not make a fly eat by themselves, or the
// answer to the question is not what decides it. Measured on the plain brain: sugar drives MN9 at
// 63.8 Hz, so it cannot be used here; LC4, LC11 and both Johnston's populations drive it at 0.0 Hz.
const HUNGRY = G(/^vpn:LC4/);                         // A's own drive: it wants food and cannot find it
const SAW = G(/^vpn:LC11/);                           // B sees an object: it knows where food is
const WING = G(/^dn:DNg02/);                          // what asking sounds like
const CLICK = G(/^dn:DNp01/);                         // what "yes" sounds like
const EAR_ASK = G(/^mechano:JO_auditory/);            // where a buzz lands
const EAR_YES = G(/^mechano:JO_wind_gravity/);        // where a click lands
const MN9 = '720575940660219265';

const CUE = 200, TALK = +(arg.talk || 1500), HZ = 150, STEP = 5;
const ASK_GAIN = +(arg.askGain || 10), YES_GAIN = +(arg.yesGain || 30), CAP = 200;

// ---- who answers what, so a graft can be hung on it
const plain = await (await Workshop.open({ cells: 1 })).build();
const mn9 = plain.index(MN9);
const answers = (cells, ms = CUE) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 4; s++) {
    plain.clearStimuli(); plain.reset(20 + s); plain.stimulate(cells, HZ, { byIndex: true }); plain.run(ms);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 4;
  }
  return m;
};
const M = { hungry: answers(HUNGRY), saw: answers(SAW), ask: answers(EAR_ASK), yes: answers(EAR_YES) };
const pick = (k, ...others) => [...M[k].keys()]
  .filter((i) => M[k][i] >= 2 && i !== mn9 && !WING.includes(i) && !CLICK.includes(i))
  .sort((x, y) => (M[k][y] - Math.max(...others.map((o) => M[o][y]))) - (M[k][x] - Math.max(...others.map((o) => M[o][x])))).slice(0, 24);
const D = { hungry: pick('hungry', 'ask', 'yes'), saw: pick('saw', 'ask', 'yes'), ask: pick('ask', 'yes', 'hungry'), yes: pick('yes', 'ask', 'hungry') };
for (const [k, v] of Object.entries(D)) console.log(`${k.padEnd(7)} drivers ${v.length}: ${(v.reduce((s, i) => s + M[k][i], 0) / v.length).toFixed(1)} spikes on its own input`);

/** An AND gate by disinhibition: `signal` gets through only while `state` is held. */
function andGate(W, signal, state, out, syn = 200) {
  const gate = W.cells(16), veto = W.cells(8);
  W.wire(signal, gate, 8);
  W.wire(signal, veto, 60);
  W.wire(veto, gate, -128);
  W.wire(state, veto, -128);
  W.wire(gate, out, syn);
  return gate;
}

async function buildA(graft = true) {              // the one that asks
  const W = await Workshop.open({ cells: 64, slots: 64 });
  if (!graft) return { brain: await W.build(), parts: {} };
  const hunger = W.memory();                       // it holds being hungry
  hunger.write(D.hungry);
  W.wire(hunger, WING, 12);                        // and being hungry is asking
  const gate = andGate(W, D.yes, hunger, [mn9]);   // heard "yes" AND still hungry -> eat
  return { brain: await W.build(), parts: { hunger, gate } };
}
async function buildB(graft = true) {              // the one that answers
  const W = await Workshop.open({ cells: 64, slots: 64 });
  if (!graft) return { brain: await W.build(), parts: {} };
  const knows = W.memory();                        // it holds having seen food
  knows.write(D.saw);
  const gate = andGate(W, D.ask, knows, CLICK, 400);  // heard the question AND knows -> answer
  return { brain: await W.build(), parts: { knows, gate } };
}

function run(A, B, { hungry, sawFood, seed = 31 }) {
  for (const x of [A, B]) { x.brain.clearStimuli(); x.brain.reset(seed); }
  if (hungry) A.brain.stimulate(HUNGRY, HZ, { byIndex: true });
  if (sawFood) B.brain.stimulate(SAW, HZ, { byIndex: true });
  A.brain.run(CUE); B.brain.run(CUE);
  A.brain.clearStimuli(); B.brain.clearStimuli();

  let pa = Uint32Array.from(A.brain.counts()), pb = Uint32Array.from(B.brain.counts());
  const start = { a: pa, b: pb };
  let askHz = -1, yesHz = -1;
  for (let t = 0; t < TALK; t += STEP) {
    A.brain.run(STEP); B.brain.run(STEP);
    const ca = A.brain.counts(), cb = B.brain.counts();
    const buzz = WING.reduce((s, i) => s + (ca[i] - pa[i]), 0);       // what A's wings did
    const click = CLICK.reduce((s, i) => s + (cb[i] - pb[i]), 0);     // what B's giant fibre did
    pa = Uint32Array.from(ca); pb = Uint32Array.from(cb);
    const wantAsk = Math.min(CAP, buzz * ASK_GAIN), wantYes = Math.min(CAP, click * YES_GAIN);
    if (Math.abs(wantAsk - askHz) > 5) { B.brain.stimulate(EAR_ASK, wantAsk, { byIndex: true }); askHz = wantAsk; }
    if (Math.abs(wantYes - yesHz) > 5) { A.brain.stimulate(EAR_YES, wantYes, { byIndex: true }); yesHz = wantYes; }
  }
  const ca = A.brain.counts(), cb = B.brain.counts();
  const d = (c, s, idx) => idx.reduce((t, i) => t + (c[i] - s[i]), 0);
  return {
    ask: d(ca, start.a, WING),
    yes: d(cb, start.b, CLICK),
    eat: ca[mn9] - start.a[mn9],
    holdA: A.parts.hunger ? d(ca, start.a, A.parts.hunger) : 0,
    holdB: B.parts.knows ? d(cb, start.b, B.parts.knows) : 0,
    gateA: A.parts.gate ? d(ca, start.a, A.parts.gate) : 0,
    gateB: B.parts.gate ? d(cb, start.b, B.parts.gate) : 0,
  };
}

const A = await buildA(), B = await buildB();
const A0 = await buildA(false), B0 = await buildB(false);
console.log(`\n${TALK} ms of conversation after a ${CUE} ms cue\n`);
const head = 'A wants  B knows | A holds  B holds | A asks  B gate  B answers | A gate | A eats (MN9)';
console.log(head);
const CASES = [[true, true], [true, false], [false, true], [false, false]];
const SEEDS = +(arg.seeds || 1);
const avg = (A_, B_, h, s) => {
  const acc = { ask: 0, yes: 0, eat: 0, holdA: 0, holdB: 0, gateA: 0, gateB: 0 };
  for (let k = 0; k < SEEDS; k++) { const r = run(A_, B_, { hungry: h, sawFood: s, seed: 31 + k * 7 });
    for (const q of Object.keys(acc)) acc[q] += r[q] / SEEDS; }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, Math.round(v)]));
};
for (const [h, s] of CASES) {
  const r = avg(A, B, h, s);
  console.log(`${(h ? 'yes' : 'no ').padStart(7)} ${(s ? 'yes' : 'no ').padStart(8)} | ${String(r.holdA).padStart(7)} ${String(r.holdB).padStart(8)} | ${String(r.ask).padStart(6)} ${String(r.gateB).padStart(7)} ${String(r.yes).padStart(10)} | ${String(r.gateA).padStart(6)} | ${String(r.eat).padStart(12)}`);
}
console.log('\nthe same two flies with no graft at all:');
for (const [h, s] of CASES) {
  const r = avg(A0, B0, h, s);
  console.log(`${(h ? 'yes' : 'no ').padStart(7)} ${(s ? 'yes' : 'no ').padStart(8)} | ${String(r.holdA).padStart(7)} ${String(r.holdB).padStart(8)} | ${String(r.ask).padStart(6)} ${String(r.gateB).padStart(7)} ${String(r.yes).padStart(10)} | ${String(r.gateA).padStart(6)} | ${String(r.eat).padStart(12)}`);
}
