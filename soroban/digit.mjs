// A digit, in a fly.
//
// The brain kakou/hold.mjs measured cannot hold anything for 50 ms. A ring of new cells holds
// indefinitely (graft 1), a disinhibited gate puts two things together (graft 3), and inhibition
// clears a state (graft 2). A **digit** is ten of those rings, one of which is up: a one-hot mod-10
// register. Incrementing it is a transition k -> k+1, which is the state machine of graft 6 closed
// into a circle.
//
// The one thing that does not carry over is the clock. A single increment pulse, left on, walks the
// counter all the way round: the gate writes k+1, and k+1's gate is now the one the same pulse opens.
// So the counter is built the way hardware is - **master and slave**:
//
//     TICK  : M[k] & inc  -> gate T[k] -> writes S[k+1], and clears M[k] (so T[k] shuts itself)
//     TOCK  : S[k]        -> gate K[k] -> writes M[k]
//     CLEAR : wipes every shadow, ready for the next tick
//
// Nothing ever reads a latch in the same phase that writes it, and the counter advances exactly once
// per cycle however long the pulse is left on. `carry` is written by T[9] - the wrap from 9 to 0 - and
// is what the next digit up is ticked by (see soroban/add.mjs).
//
//   node soroban/digit.mjs                 # count 0,1,2,...,9,0 and watch the carry
//   node soroban/digit.mjs h=16 ms=100     # smaller rings, shorter phases
//   node soroban/digit.mjs oneshot=1       # what happens with no slave: the runaway
import { Workshop } from '../kakou/graft.mjs';
import { G, drivers } from './lines.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const H = +(arg.h || 32), REC = +(arg.rec || 16), FEED = +(arg.feed || 16), CLR = +(arg.clr || 32);
const KG = +(arg.gate || 16), NV = +(arg.veto || 8), GB = +(arg.gb || 8), VB = 60, VG = +(arg.vg || 128), VH = +(arg.vh || 128);
const MS = +(arg.ms || 200), HZ = 150, GAP = +(arg.gap || 0), N = +(arg.n || 12);
const ONESHOT = !!+(arg.oneshot || 0);

const IN = {
  tick: G('mechano:JO_wind_gravity:L+mechano:JO_wind_gravity:R'),
  tock: G('mechano:head_bristle:L+mechano:head_bristle:R'),
  clear: G('mechano:eye_bristle:L+mechano:eye_bristle:R'),
  zero: G('visual:ocellar:L+visual:ocellar:R'),
  inc: G('vpn:LC11:L+vpn:LC11:R'),
};
console.log('lines:');
const plain = await (await Workshop.open({ cells: 1 })).build();
const D = drivers(plain, IN);

// ---- build
const NEED = 10 * H * 2 + 10 * (KG + NV) * 2 + NV + H;
const W = await Workshop.open({ cells: NEED, slots: 96 });
const M = [...Array(10)].map(() => W.memory(H, { groups: 2, rec: REC }));   // master: the digit
const S = [...Array(10)].map(() => W.memory(H, { groups: 2, rec: REC }));   // slave: the digit being written
const carry = W.memory(H, { groups: 2, rec: REC });
const Vinc = W.cells(NV);                                    // shut unless the increment line is on

W.wire(D.zero, M[0].ring[0], FEED);                          // zero: state 0 up, everything else down
for (let k = 1; k < 10; k++) W.wire(D.zero, M[k], -CLR);
for (let k = 0; k < 10; k++) W.wire(D.zero, S[k], -CLR);
W.wire(D.zero, carry, -CLR);

W.wire(D.tick, Vinc, VB);
W.wire(D.inc, Vinc, -VH);                                    // the increment line opens it
for (let k = 0; k < 10; k++) {
  const T = W.cells(KG), V = W.cells(NV);
  W.wire(D.tick, T, GB);                                     // the tick reaches the gate weakly
  W.wire(D.tick, V, VB);                                     // and fires the veto that shuts it
  W.wire(V, T, -VG); W.wire(Vinc, T, -VG);                   // both vetoes have to be silent
  W.wire(M[k], V, -VH);                                      // this state, and only this state, opens it
  W.wire(T, (ONESHOT ? M : S)[(k + 1) % 10].ring[0], FEED);  // write the next digit into the shadow
  W.wire(T, M[k], -CLR);                                     // and put this one out, so the gate shuts
  if (k === 9) W.wire(T, carry.ring[0], FEED);               // 9 -> 0 is a carry
}
for (let k = 0; k < 10; k++) {
  const K = W.cells(KG), V = W.cells(NV);
  W.wire(D.tock, K, GB); W.wire(D.tock, V, VB); W.wire(V, K, -VG);
  W.wire(S[k], V, -VH);
  if (!ONESHOT) W.wire(K, M[k].ring[0], FEED);               // the shadow becomes the digit
  W.wire(D.clear, S[k], -CLR);                               // and the clear phase wipes it
}
W.wire(D.clear, carry, -CLR);                                // the carry lasts one cycle
const brain = await W.build();
console.log(`\n${NEED} new cells: 10 masters + 10 shadows of ${H} (${REC} synapses a pair), 20 gates of ${KG}, carry ${H}`);
console.log(`phases of ${MS} ms at ${HZ} Hz${ONESHOT ? '  [ONESHOT: no shadow - the tick gate writes the digit itself]' : ''}\n`);

let at = null;
const phase = (ms, stim) => {
  brain.clearStimuli();
  if (stim) brain.stimulate(stim, HZ, { byIndex: true });
  brain.run(ms);
  const c = brain.counts();
  const sum = (cells) => cells.reduce((t, i) => t + (c[i] - at[i]), 0);
  const r = { m: M.map(sum), s: S.map(sum), carry: sum(carry) };
  at = Uint32Array.from(c);
  return r;
};
const read = () => {
  const r = phase(50, null);
  const k = r.m.indexOf(Math.max(...r.m));
  return { k: Math.max(...r.m) > 20 ? k : -1, m: r.m };
};
brain.clearStimuli(); brain.reset(+(arg.seed || 1)); at = Uint32Array.from(brain.counts());
phase(MS, IN.zero);
if (GAP) phase(GAP, null);
console.log(`after zero: ${read().k}`);
console.log('\n tick | digit | carry | the ten rings');
let wrong = 0;
for (let n = 1; n <= N; n++) {
  const t = phase(MS, [...IN.tick, ...IN.inc]);
  if (GAP) phase(GAP, null);
  const k2 = phase(MS, IN.tock);
  if (arg.debug) console.log(`   tick: m=${t.m.map(Math.round)} s=${t.s.map(Math.round)}\n   tock: m=${k2.m.map(Math.round)} s=${k2.s.map(Math.round)}`);
  if (GAP) phase(GAP, null);
  const c = phase(MS, IN.clear);
  const r = read();
  const want = n % 10, carried = t.carry + c.carry > 20;
  if (r.k !== want) wrong++;
  console.log(`${String(n).padStart(5)} | ${String(r.k).padStart(5)} | ${(carried ? 'yes' : '  .').padStart(5)} | ${r.m.map((v) => String(Math.round(v)).padStart(4)).join('')}${r.k === want ? '' : `   ** want ${want} **`}`);
}
console.log(`\n${N - wrong} of ${N} ticks right`);
