// Graft 6 - a state machine in a connectome.
//
// Grafts 1-3 gave the brain a register that holds, clears and can be asked for. Put several of them in a
// row and the pieces make a **finite state machine**: the fly answers to A then B then C, and to nothing
// else - not to A C B, not to B A C, not to A A B. Order is not something a fly brain does.
//
// Each state is a ring (graft 1: 32 cells in 2 groups, 16 synapses a pair - holds indefinitely, and
// nothing else in this model does). Each transition is a disinhibited gate (graft 3: the input reaches
// the gate weakly and also fires a veto that shuts it; the state silences the veto, so the gate opens
// only when *that* state is the one that is on). The gate then writes the next state and clears its own:
//
//     start --> S0
//     A + S0 --> gate0 --> S1,  and -| S0
//     B + S1 --> gate1 --> S2,  and -| S1
//     C + S2 --> gate2 --> S3,  and -| S2
//     S3 --> MN9
//
// Nothing here is new machinery. It is the same three circuits wired into a sequence, which is the point:
// if a state machine goes in, what goes in is limited by what can be designed, not by what a fly has.
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const G_ = (k) => [...new Set(k.split('+').flatMap((x) => groups[x].idx))];
const IN = {
  start: G_(arg.start || 'visual:ocellar:L+visual:ocellar:R'),
  A: G_(arg.a || 'vpn:LC11:L+vpn:LC11:R'),
  B: G_(arg.b || 'vpn:LC6:L+vpn:LC6:R'),
  C: G_(arg.c || 'vpn:LC4:L+vpn:LC4:R'),
};
const MN9 = '720575940660219265';
const STEP = +(arg.step || 200), GAP = +(arg.gap || 300), HZ = 150, SEEDS = +(arg.seeds || 3);
const H = +(arg.cells || 32), REC = +(arg.rec || 16), FEED = +(arg.feed || 60), CLEAR = +(arg.clear || 32);
const K = +(arg.gate || 16), NV = +(arg.veto || 8), GB = +(arg.gb || 8), VG = +(arg.vg || 128), VH = +(arg.vh || 128), VB = 60;
const OUT = +(arg.out || 200);

// drivers: cells that answer one input and none of the others
const plain = await (await Workshop.open({ cells: 1 })).build();
const mn9 = plain.index(MN9);
const mean = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 4; s++) {
    plain.clearStimuli(); plain.reset(10 + s); plain.stimulate(cells, HZ, { byIndex: true }); plain.run(STEP);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 4;
  }
  return m;
};
const M = Object.fromEntries(Object.entries(IN).map(([k, v]) => [k, mean(v)]));
const drivers = {};
for (const k of Object.keys(IN)) {
  const others = Object.keys(IN).filter((o) => o !== k).map((o) => M[o]);
  drivers[k] = [...M[k].keys()].filter((i) => M[k][i] >= 2 && i !== mn9)
    .sort((x, y) => (M[k][y] - Math.max(...others.map((o) => o[y]))) - (M[k][x] - Math.max(...others.map((o) => o[x])))).slice(0, 24);
  const own = (drivers[k].reduce((s, i) => s + M[k][i], 0) / drivers[k].length).toFixed(1);
  const cross = Math.max(...others.map((o) => drivers[k].reduce((s, i) => s + o[i], 0) / drivers[k].length)).toFixed(2);
  console.log(`${k.padEnd(6)} drivers ${drivers[k].length}: ${own} spikes on its own input, at most ${cross} on any other`);
}

// ---- build
const NSTATE = 4;
const W = await Workshop.open({ cells: NSTATE * H + 3 * (K + NV), slots: H / 2 + K + NV + 8 });
const S = [...Array(NSTATE)].map(() => W.cells(H));
const ring = S.map((cells) => [cells.filter((_, i) => i % 2 === 0), cells.filter((_, i) => i % 2 === 1)]);
for (const r of ring) { W.wire(r[0], r[1], REC); W.wire(r[1], r[0], REC); }
W.wire(drivers.start, ring[0][0], FEED);                       // the start pulse writes S0
const step = ['A', 'B', 'C'];
const gates = [], vetos = [];
for (let k = 0; k < 3; k++) {
  const gate = W.cells(K), veto = W.cells(NV);
  gates.push(gate); vetos.push(veto);
  W.wire(drivers[step[k]], gate, GB);                          // the input reaches the gate weakly
  W.wire(drivers[step[k]], veto, VB);                          // and fires the veto that shuts it
  W.wire(veto, gate, -VG);
  W.wire(S[k], veto, -VH);                                     // this state, and only this state, opens it
  W.wire(gate, ring[k + 1][0], FEED);                          // write the next state
  W.wire(gate, S[k], -CLEAR);                                  // and clear this one
}
W.wire(S[3], [mn9], OUT);
const brain = await W.build();
console.log(`\n${NSTATE} states of ${H} cells, 3 gates of ${K} with ${NV} veto cells each; S3 -> MN9 at ${OUT} synapses`);
console.log(`each input shown for ${STEP} ms at ${HZ} Hz, ${GAP} ms of nothing between, ${SEEDS} seeds\n`);

function run(seq, seed) {
  let at;
  const phase = (ms, stim) => {
    brain.clearStimuli();
    if (stim) brain.stimulate(stim, HZ, { byIndex: true });
    brain.run(ms);
    const c = brain.counts();
    const r = { mn9: c[mn9] - at[mn9], s: S.map((cells) => cells.reduce((t, i) => t + (c[i] - at[i]), 0)) };
    at = Uint32Array.from(c);
    return r;
  };
  brain.clearStimuli(); brain.reset(seed); at = Uint32Array.from(brain.counts());
  phase(STEP, IN.start); phase(GAP, null);
  let last = null;
  for (const ch of seq) { phase(STEP, IN[ch]); last = phase(GAP, null); }
  return last;
}

// What this machine computes is A *then* B *then* C as a subsequence - anything may come between, and
// what comes after S3 no longer matters. So that is what the test expects of it.
const accepts = (seq) => { let k = 0; for (const ch of seq) if (ch === step[k]) k++; return k === 3; };
const TESTS = ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA', 'AAB', 'ABB', 'AB', 'ABCA', 'AABC', 'ABAC',
  'ACBC', 'BCAB', 'CCC', 'BBB', 'CBABC', 'AAA', 'ABCABC', 'ACAB'];
let wrong = 0;
console.log('sequence |  S0    S1    S2    S3  | MN9 | should | verdict');
for (const seq of TESTS) {
  let mn = 0, st = [0, 0, 0, 0];
  for (let s = 0; s < SEEDS; s++) {
    const r = run(seq, 900 + s);
    mn += r.mn9 / SEEDS;
    for (let i = 0; i < 4; i++) st[i] += r.s[i] / SEEDS;
  }
  const want = accepts(seq);
  const got = mn > 2;
  if (got !== want) wrong++;
  console.log(`${seq.padEnd(8)} | ${st.map((v) => v.toFixed(0).padStart(5)).join(' ')} | ${mn.toFixed(1).padStart(4)} | ${(want ? 'fire' : 'silent').padStart(6)} | ${got === want ? 'right' : '** WRONG **'}`);
}
console.log(`\n${TESTS.length - wrong} of ${TESTS.length} right`);
