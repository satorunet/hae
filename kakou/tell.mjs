// Telling each other *which* - a conversation with something in it.
//
// `talk.mjs` passes one bit: B knows there is food, A eats. A fair complaint about that is that one bit
// with a fixed meaning is indistinguishable from an if-statement. So: **three places**, and what has to
// cross is *which one*.
//
//   The food is at one of three places. Only the teller can see which (LC11 / LC6 / LC4 - three of the
//   connectome's object-detecting populations, one per place).
//   The seeker is hungry and asks: a wing buzz (DNg02).
//   The teller, asked, answers with the sound for the place it saw: the giant fibre (DNp01), the
//   backward-walking descending neurons (MDN), or the grooming ones (DNg84 + DNg35).
//   The seeker holds which of the three it heard - and that is where it goes.
//
// Both flies run the same brain: whoever is shown the food is the teller, whoever is hungry is the
// seeker. Chance is 1/3, so getting it right is not something a single trigger can do.
//
// What each sound reaches is this model's assumption (the connectome says nothing about frequency
// tuning), but the four mechanosensory populations used are real and do not overlap.
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const G = (re) => [...new Set(Object.keys(groups).filter((k) => re.test(k)).flatMap((k) => groups[k].idx))];

const PLACES = ['左', '中', '右'];
const SEE = [G(/^vpn:LC11/), G(/^vpn:LC6/), G(/^vpn:LC4/)];          // seeing the food at each place
const WANT = G(/^vpn:LPLC2/);                                        // being hungry

// **The symbols cannot be neurons that hearing already drives.** The first try used the giant fibre
// (DNp01) for "left", and the giant fibre is the escape neuron: it startles at the other fly's buzz and
// said "left" when the food was on the right. DNg84/DNg35 do the same to the bristle channels (161-165
// spikes). Measured across all four sounds, 323 descending populations answer **none** of them, so the
// symbols are taken from those: anything they say is the graft speaking, not a reflex.
const ASK = G(/^dn:DNg02_(a|b)/);                                    // the question: a wing buzz
const SAY = [G(/^dn:DNg12_b/), G(/^dn:DNpe008/), G(/^dn:DNge071/)];  // one sound per place
const EAR_ASK = G(/^mechano:JO_auditory/);                           // where the question lands
const EAR = [G(/^mechano:JO_wind_gravity/), G(/^mechano:head_bristle/), G(/^mechano:eye_bristle/)];
const MN9 = '720575940660219265';

const HZ = 150, CUE = 200, STEP = 5;
const TALK = +(arg.talk || 1500), TRIALS = +(arg.trials || 6);
const ASK_GAIN = +(arg.askGain || 10), SAY_GAIN = +(arg.sayGain || 30), CAP = 200;

// ---- drivers for every input, each answering its own and nothing else
const plain = await (await Workshop.open({ cells: 1 })).build();
const mn9 = plain.index(MN9);
const motors = new Set([...ASK, ...SAY.flat(), mn9]);
const answers = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 4; s++) {
    plain.clearStimuli(); plain.reset(20 + s); plain.stimulate(cells, HZ, { byIndex: true }); plain.run(CUE);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 4;
  }
  return m;
};
const INPUTS = { want: WANT, see0: SEE[0], see1: SEE[1], see2: SEE[2], ask: EAR_ASK, ear0: EAR[0], ear1: EAR[1], ear2: EAR[2] };
const M = Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, answers(v)]));
// **A memory latches on almost nothing.** The ring holds itself up once any of it fires, so a driver
// that answers another input even a little will write the wrong memory: picking drivers that answered
// LC4 with a mean of 0.65 spikes was enough for LC4 to write LC11's memory (5,120 spikes) instead of its
// own (32). So a driver here has to be **completely silent** on every other input, not just quieter.
const pick = (k) => {
  const others = Object.keys(INPUTS).filter((o) => o !== k);
  const strict = [...M[k].keys()].filter((i) => M[k][i] >= 2 && !motors.has(i) && others.every((o) => M[o][i] === 0));
  return strict.sort((x, y) => M[k][y] - M[k][x]).slice(0, 24);
};
const D = Object.fromEntries(Object.keys(INPUTS).map((k) => [k, pick(k)]));
for (const k of Object.keys(D)) {
  const own = (D[k].reduce((s, i) => s + M[k][i], 0) / D[k].length).toFixed(1);
  const cross = Math.max(...Object.keys(INPUTS).filter((o) => o !== k).map((o) => D[k].reduce((s, i) => s + M[o][i], 0) / D[k].length)).toFixed(2);
  console.log(`${k.padEnd(6)} ${D[k].length} drivers: ${own} on its own input, at most ${cross} on any other`);
}

// ---- the graft, the same in both flies
const W = await Workshop.open({ cells: 512, slots: 96 });
const andGate = (signal, state, out, syn) => {
  const gate = W.cells(16), veto = W.cells(8);
  W.wire(signal, gate, 8); W.wire(signal, veto, 60);
  W.wire(veto, gate, -128); W.wire(state, veto, -128);
  W.wire(gate, out, syn);
  return gate;
};
const WRITE = +(arg.write || 60);
const wants = W.memory();  wants.write(D.want, WRITE);
W.wire(wants, ASK, 12);                                     // hungry -> ask
const saw = [0, 1, 2].map((k) => { const m = W.memory(); m.write(D['see' + k], WRITE); return m; });
const heard = [0, 1, 2].map(() => W.memory());
const sayGate = [0, 1, 2].map((k) => andGate(D.ask, saw[k], SAY[k], 400));       // asked, and saw k -> say k
const hearGate = [0, 1, 2].map((k) => andGate(D['ear' + k], wants, heard[k], 60)); // hungry, and heard k -> hold k
const brain = await W.build();
const other = await W.build();
console.log(`\ngraft: ${W._taken} cells, ${W.links.length} connections\n`);

// ---- one meeting. `seeker` is hungry, `teller` is shown the food at `place`.
function meet(seeker, teller, place, { cut = 'none', seed = 7 } = {}) {
  for (const x of [seeker, teller]) { x.clearStimuli(); x.reset(seed); }
  seeker.stimulate(WANT, HZ, { byIndex: true });
  if (cut !== 'blind') teller.stimulate(SEE[place], HZ, { byIndex: true });
  seeker.run(CUE); teller.run(CUE);
  seeker.clearStimuli(); teller.clearStimuli();
  let ps = Uint32Array.from(seeker.counts()), pt = Uint32Array.from(teller.counts());
  const s0 = { s: ps, t: pt };
  const at = [-1, -1, -1, -1];
  const sum = (c, p, idx) => { let s = 0; for (const i of idx) s += c[i] - p[i]; return s; };
  for (let t = 0; t < TALK; t += STEP) {
    seeker.run(STEP); teller.run(STEP);
    const cs = seeker.counts(), ct = teller.counts();
    const askN = sum(cs, ps, ASK);
    const sayN = SAY.map((g) => sum(ct, pt, g));
    ps = Uint32Array.from(cs); pt = Uint32Array.from(ct);
    const toAsk = cut === 'mute' ? 0 : Math.min(CAP, askN * ASK_GAIN);
    if (Math.abs(toAsk - at[3]) > 5) { teller.stimulate(EAR_ASK, cut === 'deafT' ? 0 : toAsk, { byIndex: true }); at[3] = toAsk; }
    for (let k = 0; k < 3; k++) {
      const v = cut === 'silent' ? 0 : Math.min(CAP, sayN[k] * SAY_GAIN);
      if (Math.abs(v - at[k]) > 5) { seeker.stimulate(EAR[k], cut === 'deafS' ? 0 : v, { byIndex: true }); at[k] = v; }
    }
  }
  const cs = seeker.counts(), ct = teller.counts();
  const held = heard.map((m) => sum(cs, s0.s, m));
  const said = SAY.map((g) => sum(ct, s0.t, g));
  const sawT = saw.map((m) => sum(ct, s0.t, m));
  const gateT = sayGate.map((g) => sum(ct, s0.t, g));
  const gateS = hearGate.map((g) => sum(cs, s0.s, g));
  let best = -1, bv = 0;
  held.forEach((v, k) => { if (v > bv) { bv = v; best = k; } });
  return { went: bv > 200 ? best : -1, held, said, sawT, gateT, gateS, ask: sum(cs, s0.s, ASK) };
}

// ---- does the right place cross?
console.log('food at | the teller and the seeker, channel by channel');
const conf = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
for (let p = 0; p < 3; p++) for (let t = 0; t < TRIALS; t++) {
  const r = meet(brain, other, p, { seed: 11 + t * 7 });
  conf[p][r.went < 0 ? 3 : r.went]++;
  if (t === 0) console.log(`${PLACES[p].padStart(6)}  | teller saw ${r.sawT.map((v) => String(v).padStart(5)).join(' ')} | say-gate ${r.gateT.map((v) => String(v).padStart(5)).join(' ')} | said ${r.said.map((v) => String(v).padStart(5)).join(' ')} | hear-gate ${r.gateS.map((v) => String(v).padStart(5)).join(' ')} | held ${r.held.map((v) => String(v).padStart(5)).join(' ')} -> ${r.went < 0 ? 'どこへも' : PLACES[r.went]}`);
}
console.log('\n            went 左   中   右  どこへも');
let right = 0, n = 0;
for (let p = 0; p < 3; p++) {
  console.log(`food at ${PLACES[p]}   ${conf[p].map((v) => String(v).padStart(5)).join(' ')}`);
  right += conf[p][p]; n += TRIALS;
}
console.log(`\nright place: ${right} of ${n} (chance is ${(n / 3).toFixed(0)})`);

// ---- and with the chain cut
const CUTS = { none: 'そのまま', mute: '聞き手が問えない', deafT: '話し手が聞こえない', silent: '話し手が言えない', deafS: '聞き手が聞こえない', blind: '話し手が見ていない' };
console.log('\ncut                     right place   went somewhere   nowhere');
for (const [c, label] of Object.entries(CUTS)) {
  let ok = 0, moved = 0, none_ = 0;
  for (let p = 0; p < 3; p++) for (let t = 0; t < TRIALS; t++) {
    const r = meet(brain, other, p, { cut: c, seed: 11 + t * 7 });
    if (r.went === p) ok++;
    if (r.went < 0) none_++; else moved++;
  }
  console.log(`${label.padEnd(22)} ${String(ok + '/' + (3 * TRIALS)).padStart(11)} ${String(moved).padStart(14)} ${String(none_).padStart(9)}`);
}
