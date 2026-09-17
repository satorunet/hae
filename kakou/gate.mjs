// Graft 3 - making the register drive the animal: a delayed match to sample, on vision.
//
// Grafts 1 and 2 gave the brain a register (one input writes it, it holds, another clears it) wired to
// nothing, so the fly cannot use it. This wires it out, and to do that it has to be *asked* for:
//
//   cue (200 ms: LC11, an object in view, or LC6) -> a gap of nothing -> go (200 ms: the ocelli)
//
// and the right answer is to feed (MN9) on the go only if the cue was LC11. The plain brain cannot do it
// at any gap - it is silent 50 ms after the cue - and none of the three inputs drives MN9 on its own.
//
// Vision rather than taste because the connectome has six object-detecting populations with known jobs
// (LC4, LPLC2, LPLC1, LC6, LC11), none of which runs the model away (measured: 3,000-6,900 spikes per
// 200 ms at 150 Hz, and 60-290 in the 200 ms after it stops, against the ~450,000/s of the runaway
// state). Taste has two. What can be held is limited by what can be told apart.
//
// **What does not work.** Two subthreshold excitations do not make an AND. Fed from the register and
// from the go cells, at the weakest weight there is (2 synapses) the go alone already fires the gate:
// 24 drivers at ~198 Hz, integrated over tau_m 20 ms, clear threshold however few synapses each has.
// Nor does a veto on a gate that is driven hard - inhibition reaching a refractory neuron is dropped by
// this model exactly as excitation is, so a saturated gate ignores 1,024 synapses of it.
//
// **What works** is disinhibition on a gate that is only just driven:
//
//     go --(gb, small)--> gate --(out)--> MN9
//     go --------------> veto --(-vg)--> gate
//     register ------------------(-vh)--> veto
import { readFile } from 'node:fs/promises';
import { Workshop } from './graft.mjs';

const BASE = new URL('../flybrain/', import.meta.url);
const groups = JSON.parse(await readFile(new URL('data/groups783.json', BASE), 'utf8')).groups;
const MN9 = '720575940660219265';
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const G_ = (k) => [...new Set(k.split('+').flatMap((x) => groups[x].idx))];
const CUE_A = G_(arg.cue || 'vpn:LC11:L+vpn:LC11:R');            // what is remembered
const CUE_B = G_(arg.other || 'vpn:LC6:L+vpn:LC6:R');            // what clears it
const GO = G_(arg.go || 'visual:ocellar:L+visual:ocellar:R');    // what asks the question
const CUE = 200, GOMS = 200, HZ = 150;
const H = +(arg.cells || 32), G = +(arg.groups || 2), REC = +(arg.rec || 16), FEED = +(arg.feed || 60), STOP = +(arg.stop || 32);
const K = +(arg.gate || 16), NV = +(arg.veto || 8), NDRV = +(arg.drivers || 24), NGO = +(arg.godrv || 24);
const GBS = (arg.gb || '2,4,8,16,32').split(',').map(Number);     // go -> gate
const VGS = (arg.vg || '32,128').split(',').map(Number);          // veto -| gate
const VH = +(arg.vh || 128);                                      // register -| veto
const VB = +(arg.vb || 60);                                       // go -> veto
const OUT = +(arg.out || 200);                                    // gate -> MN9
const GAP = +(arg.gap || 1000), SEEDS = +(arg.seeds || 4);

const plain = await (await Workshop.open({ cells: 1 })).build();
const mn9 = plain.index(MN9);
const mean = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 6; s++) {
    plain.clearStimuli(); plain.reset(10 + s); plain.stimulate(cells, HZ, { byIndex: true }); plain.run(CUE);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 6;
  }
  return m;
};
const ma = mean(CUE_A), mb = mean(CUE_B), mg = mean(GO);
const pick = (a, others, k) => [...a.keys()].filter((i) => a[i] >= 2 && i !== mn9)
  .sort((x, y) => (a[y] - Math.max(...others.map((o) => o[y]))) - (a[x] - Math.max(...others.map((o) => o[x])))).slice(0, k);
const drivers = pick(ma, [mb, mg], NDRV), stoppers = pick(mb, [ma, mg], NDRV), goers = pick(mg, [ma, mb], NGO);
const rate = (sel, m) => (sel.reduce((s, i) => s + m[i], 0) / sel.length).toFixed(1);
console.log(`write ${drivers.length} cells (${rate(drivers, ma)} sp/200ms on the cue, ${rate(drivers, mb)} on the other, ${rate(drivers, mg)} on the go)`);
console.log(`clear ${stoppers.length} (${rate(stoppers, mb)} / ${rate(stoppers, ma)} / ${rate(stoppers, mg)})`);
console.log(`go    ${goers.length} (${rate(goers, mg)} on the go, ${rate(goers, ma)} / ${rate(goers, mb)} on the cues)\n`);

async function build(gb, vg) {
  const W = await Workshop.open({ cells: H + K + NV, slots: Math.ceil(H / G) + NV + K + 8 });
  const hold = W.cells(H), gate = W.cells(K), veto = W.cells(NV);
  const ring = [...Array(G)].map((_, k) => hold.filter((_, i) => i % G === k));
  W.wire(drivers, ring[0], FEED);
  for (let k = 0; k < G; k++) W.wire(ring[k], ring[(k + 1) % G], REC);
  W.wire(stoppers, hold, -STOP);
  W.wire(goers, gate, gb);
  W.wire(goers, veto, VB);
  W.wire(veto, gate, -vg);
  W.wire(hold, veto, -VH);
  W.wire(gate, [mn9], OUT);
  return { brain: await W.build(), hold, gate, veto };
}

function trial(brain, parts, cue, seed) {
  let at;
  const phase = (ms, stim) => {
    brain.clearStimuli();
    if (stim) brain.stimulate(stim, HZ, { byIndex: true });
    brain.run(ms);
    const c = brain.counts();
    const r = { mn9: c[mn9] - at[mn9] };
    for (const [k, cells] of Object.entries(parts)) r[k] = cells.reduce((s, i) => s + (c[i] - at[i]), 0);
    at = Uint32Array.from(c);
    return r;
  };
  brain.clearStimuli(); brain.reset(seed); at = Uint32Array.from(brain.counts());
  return { cue: phase(CUE, cue), gap: phase(GAP, null), go: phase(GOMS, GO) };
}

{ // the plain brain
  let a = 0, b = 0;
  for (let s = 0; s < SEEDS; s++) for (const [cue, which] of [[CUE_A, 'a'], [CUE_B, 'b']]) {
    plain.clearStimuli(); plain.reset(200 + s);
    plain.stimulate(cue, HZ, { byIndex: true }); plain.run(CUE);
    plain.clearStimuli(); plain.run(GAP);
    const before = plain.counts()[mn9];
    plain.stimulate(GO, HZ, { byIndex: true }); plain.run(GOMS);
    const got = plain.counts()[mn9] - before;
    if (which === 'a') a += got / SEEDS; else b += got / SEEDS;
  }
  console.log(`plain brain, gap ${GAP} ms: MN9 on the go after the cue ${a.toFixed(1)} spikes, after the other ${b.toFixed(1)} - it cannot answer\n`);
}

console.log(`gap ${GAP} ms | hold ${H} gate ${K} veto ${NV} | go->veto ${VB}, reg-|veto ${VH}, gate->MN9 ${OUT} | ${SEEDS} seeds`);
console.log('go->gate  veto-|gate | veto: cue  other | gate: cue  other | MN9 on go: cue  other | verdict');
for (const gb of GBS) for (const vg of VGS) {
  const { brain, hold, gate, veto } = await build(gb, vg);
  const parts = { hold, gate, veto };
  const R = { a: [], b: [] };
  for (let s = 0; s < SEEDS; s++) {
    R.a.push(trial(brain, parts, CUE_A, 300 + s));
    R.b.push(trial(brain, parts, CUE_B, 400 + s));
  }
  const avg = (k, w, f) => R[k].reduce((t, x) => t + x[w][f], 0) / SEEDS;
  const [va, vb2] = [avg('a', 'go', 'veto'), avg('b', 'go', 'veto')];
  const [ga, gb2] = [avg('a', 'go', 'gate'), avg('b', 'go', 'gate')];
  const [ea, eb] = [avg('a', 'go', 'mn9'), avg('b', 'go', 'mn9')];
  const ok = ea > 5 && eb === 0;
  console.log(`${String(gb).padStart(8)} ${String(vg).padStart(11)} | ${va.toFixed(0).padStart(9)} ${vb2.toFixed(0).padStart(6)} | ${ga.toFixed(0).padStart(9)} ${gb2.toFixed(0).padStart(6)} | ${ea.toFixed(1).padStart(14)} ${eb.toFixed(1).padStart(6)} | ${ok ? 'ANSWERS' : eb > 0 ? 'answers the wrong cue too' : 'silent'}`);
}
