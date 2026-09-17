// Bake the "which place" brain for /kaiwa/, check it, cut it down, and write it out.
//
// **A relay is not a conversation.** The first version had one fly see the food and the other fetch it,
// which a fair critic answers with: the one that can see could just go and eat. Nothing made it need the
// other one. So the plate here **only opens to two flies at once** (shinka's `crop` round does the same),
// and neither of them can do it alone: one can see which plate and cannot open it by itself, the other
// can be the second body and cannot see. And because the teller has to *go* as well, it has to know its
// message arrived - so the seeker says the place back, and only then does the teller move.
//
//   seeker: 問い -> 話し手: 場所 -> 聞き手: 復唱 -> 話し手: 了解して動く -> 二匹で皿へ
//
// One graft, in both flies - they are the same species, and which part of it runs is decided by what has
// happened to that fly, not by which brain it has:
//
//   saw[k]      memory, written by LC11 / LC6 / LC4   ... this fly can see the food, at place k
//   wants       memory, written by LPLC2              ... this fly is hungry
//   wants -> DNg02_a/b                                 ... being hungry is asking (a wing buzz)
//   AND(heard a buzz, saw[k]) -> say[k]                ... asked, and knowing, it names the place
//   AND(heard say[k], wants) -> heard[k]               ... hungry, and told, it holds which place
//   heard[k] -> say[k]                                 ... and says it back
//   AND(heard say[k], saw[k]) -> agreed                ... hearing its own place said back: understood
//
// The three symbols are DNg12_b, DNpe008 and DNge071 - descending neurons that answer **none** of the
// four sounds (323 populations do not; the giant fibre and DNg84/DNg35, which the first try used, are
// startled by them and said the wrong place). The memories are written at 15 synapses a driver, not 60:
// a ring holds itself up once anything in it fires, so a strong write lets a nearly-silent input latch
// the wrong memory. Drivers are cells that answer their own input and are **completely silent** on all
// the others.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Workshop, decode, encode } from './graft.mjs';
import { FlyBrain } from '../flybrain/flybrain.js';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('../kaiwa/data/', import.meta.url);
const WASM = new URL('flybrain/flybrain.wasm', ROOT);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const groups = JSON.parse(await readFile(new URL('flybrain/data/groups783.json', ROOT), 'utf8')).groups;
const G = (re) => [...new Set(Object.keys(groups).filter((k) => re.test(k)).flatMap((k) => groups[k].idx))];

const SEE = [G(/^vpn:LC11/), G(/^vpn:LC6/), G(/^vpn:LC4/)];
const WANT = G(/^vpn:LPLC2/);
const ASK = G(/^dn:DNg02_(a|b)/);
const SAY = [G(/^dn:DNg12_b/), G(/^dn:DNpe008/), G(/^dn:DNge071/)];
const EAR_ASK = G(/^mechano:JO_auditory/);
const EAR = [G(/^mechano:JO_wind_gravity/), G(/^mechano:head_bristle/), G(/^mechano:eye_bristle/)];
const MN9 = '720575940660219265';
const T = { HZ: 150, CUE: 200, step: 5, TALK: 1500, ASK_GAIN: 10, SAY_GAIN: 30, CAP: 200, WRITE: 15 };
const TRIALS = +(arg.trials || 6);

const plain = await (await Workshop.open({ cells: 1 })).build();
const mn9 = plain.index(MN9);
const motors = new Set([...ASK, ...SAY.flat(), mn9]);
const answers = (cells) => {
  const m = new Float64Array(plain.n);
  for (let s = 0; s < 4; s++) {
    plain.clearStimuli(); plain.reset(20 + s); plain.stimulate(cells, T.HZ, { byIndex: true }); plain.run(T.CUE);
    const c = plain.counts(); for (let i = 0; i < plain.n; i++) m[i] += c[i] / 4;
  }
  return m;
};
const INPUTS = { want: WANT, see0: SEE[0], see1: SEE[1], see2: SEE[2], ask: EAR_ASK, ear0: EAR[0], ear1: EAR[1], ear2: EAR[2] };
const M = Object.fromEntries(Object.entries(INPUTS).map(([k, v]) => [k, answers(v)]));
const D = Object.fromEntries(Object.keys(INPUTS).map((k) => {
  const others = Object.keys(INPUTS).filter((o) => o !== k);
  const strict = [...M[k].keys()].filter((i) => M[k][i] >= 2 && !motors.has(i) && others.every((o) => M[o][i] === 0));
  return [k, strict.sort((x, y) => M[k][y] - M[k][x]).slice(0, 24)];
}));
for (const k of Object.keys(D)) console.log(`${k.padEnd(5)} ${D[k].length} drivers, ${(D[k].reduce((s, i) => s + M[k][i], 0) / D[k].length).toFixed(1)} spikes, silent on everything else`);

const W = await Workshop.open({ cells: 512, slots: 96 });
const andGate = (signal, state, out, syn) => {
  const gate = W.cells(16), veto = W.cells(8);
  W.wire(signal, gate, 8); W.wire(signal, veto, 60);
  W.wire(veto, gate, -128); W.wire(state, veto, -128);
  W.wire(gate, out, syn);
  return gate;
};
const wants = W.memory(); wants.write(D.want, T.WRITE);
W.wire(wants, ASK, 12);
const saw = [0, 1, 2].map((k) => { const m = W.memory(); m.write(D['see' + k], T.WRITE); return m; });
const heard = [0, 1, 2].map(() => W.memory());
const sayGate = [0, 1, 2].map((k) => andGate(D.ask, saw[k], SAY[k], 400));
const hearGate = [0, 1, 2].map((k) => andGate(D['ear' + k], wants, heard[k], 60));
for (let k = 0; k < 3; k++) W.wire(heard[k], SAY[k], 12);              // the seeker says the place back
const agreed = W.memory();                                             // the teller: my message arrived
const okGate = [0, 1, 2].map((k) => andGate(D['ear' + k], saw[k], agreed, 60));
const full = await W.build();
const bytesFull = encode(W.baked);
console.log(`\ngraft: ${W._taken} cells, ${W.links.length} connections`);

const sum = (c, p, idx) => { let s = 0; for (const i of idx) s += c[i] - p[i]; return s; };
function meeting(S, Tl, map, place, cut, seed, seen) {
  for (const x of [S, Tl]) { x.clearStimuli(); x.reset(seed); }
  S.stimulate(map.want, T.HZ, { byIndex: true });
  if (cut !== 'blind') Tl.stimulate(map.see[place], T.HZ, { byIndex: true });
  S.run(T.CUE); Tl.run(T.CUE);
  S.clearStimuli(); Tl.clearStimuli();
  let ps = Uint32Array.from(S.counts()), pt = Uint32Array.from(Tl.counts());
  const s0 = { s: ps, t: pt };
  const at = [-1, -1, -1, -1];
  for (let t = 0; t < T.TALK; t += T.step) {
    S.run(T.step); Tl.run(T.step);
    const cs = S.counts(), ct = Tl.counts();
    const askN = sum(cs, ps, map.ask);
    const sayN = map.say.map((g) => sum(ct, pt, g));
    ps = Uint32Array.from(cs); pt = Uint32Array.from(ct);
    const toAsk = cut === 'mute' || cut === 'deafT' ? 0 : Math.min(T.CAP, askN * T.ASK_GAIN);
    if (Math.abs(toAsk - at[3]) > 5) { Tl.stimulate(map.earAsk, toAsk, { byIndex: true }); at[3] = toAsk; }
    for (let k = 0; k < 3; k++) {
      const v = cut === 'silent' || cut === 'deafS' ? 0 : Math.min(T.CAP, sayN[k] * T.SAY_GAIN);
      if (Math.abs(v - at[k]) > 5) { S.stimulate(map.ear[k], v, { byIndex: true }); at[k] = v; }
    }
  }
  const cs = S.counts(), ct = Tl.counts();
  if (seen) for (const br of [S, Tl]) { const c = br.counts(); for (let i = 0; i < br.n; i++) if (c[i]) seen[i] = 1; }
  const held = map.heard.map((m) => sum(cs, s0.s, m));
  let best = -1, bv = 0;
  held.forEach((v, k) => { if (v > bv) { bv = v; best = k; } });
  const ok = sum(ct, s0.t, map.agreed);
  return { went: bv > 200 ? best : -1, held, agreed: ok, both: bv > 200 && ok > 200,
    said: map.say.map((g) => sum(ct, s0.t, g)) };
}

const mapFull = { want: WANT, see: SEE, ask: ASK, say: SAY, earAsk: EAR_ASK, ear: EAR, heard: heard.map((m) => [...m]), agreed: [...agreed] };
const other = await FlyBrain.load({ graph: bytesFull, wasm: WASM, recordCapacity: 1024 });
const CUTS = ['none', 'mute', 'deafT', 'silent', 'deafS', 'blind'];
const seen = new Uint8Array(full.n);
const ref = [];
console.log('\nchecking the whole brain...');
for (const c of CUTS) for (let p = 0; p < 3; p++) for (let t = 0; t < TRIALS; t++)
  ref.push({ c, p, t, ...meeting(full, other, mapFull, p, c, 11 + t * 7, seen) });
const okFull = ref.filter((r) => r.c === 'none' && r.went === r.p && r.both).length;
console.log(`both flies to the right plate, nothing cut: ${okFull} of ${3 * TRIALS} (chance ${TRIALS})`);
if (okFull < 3 * TRIALS) { console.error('the graft does not get both flies there; not writing it out'); process.exit(1); }

// ---- cut to what fires
for (const list of [...Object.values(INPUTS), ASK, ...SAY, ...saw.map((m) => [...m]), ...heard.map((m) => [...m]), [...wants], [...agreed], ...sayGate, ...hearGate, ...okGate]) for (const i of list) seen[i] = 1;
seen[mn9] = 1;
const keep = []; for (let i = 0; i < full.n; i++) if (seen[i]) keep.push(i);
const at = new Int32Array(full.n).fill(-1); keep.forEach((i, k) => { at[i] = k; });
const Gf = decode(bytesFull);
const start = new Uint32Array(Gf.n + 1); for (let i = 0; i < Gf.n; i++) start[i + 1] = start[i] + Gf.deg[i];
const ids = new BigUint64Array(keep.length), deg = new Uint32Array(keep.length), post = [], w = [];
keep.forEach((i, k) => {
  ids[k] = Gf.ids[i]; let d = 0;
  for (let q = start[i]; q < start[i + 1]; q++) { const j = at[Gf.post[q]]; if (j < 0) continue; post.push(j); w.push(Gf.w[q]); d++; }
  deg[k] = d;
});
const bytes = encode({ n: keep.length, ids, deg, post: Uint32Array.from(post), w: Int16Array.from(w), header: Gf.header });
console.log(`cut: ${keep.length} of ${full.n} neurons, ${post.length} of ${Gf.nnz} connections (${(100 * post.length / Gf.nnz).toFixed(1)}%)`);

const R = (l) => l.map((i) => at[i]).filter((i) => i >= 0);
const mapCut = { want: R(WANT), see: SEE.map(R), ask: R(ASK), say: SAY.map(R), earAsk: R(EAR_ASK), ear: EAR.map(R), heard: heard.map((m) => R([...m])), agreed: R([...agreed]) };
const A2 = await FlyBrain.load({ graph: bytes, wasm: WASM, recordCapacity: 1024 });
const B2 = await FlyBrain.load({ graph: bytes, wasm: WASM, recordCapacity: 1024 });
console.log(`cut brain: n=${A2.n} nnz=${A2.nnz}, wasm ${(A2._x.memory.buffer.byteLength / 1048576).toFixed(1)} MB`);

let differ = 0;
console.log('\ncut          both to the right plate   seeker knew   teller agreed');
for (const c of CUTS) {
  let ok = 0, knew = 0, ag = 0;
  for (let p = 0; p < 3; p++) for (let t = 0; t < TRIALS; t++) {
    const r = meeting(A2, B2, mapCut, p, c, 11 + t * 7);
    const g = ref.find((x) => x.c === c && x.p === p && x.t === t);
    if (r.went !== g.went || r.both !== g.both) differ++;
    if (r.went === p && r.both) ok++;
    if (r.went >= 0) knew++;
    if (r.agreed > 200) ag++;
  }
  console.log(`${c.padEnd(12)} ${String(ok + '/' + 3 * TRIALS).padStart(18)} ${String(knew).padStart(13)} ${String(ag).padStart(15)}`);
}
console.log(`\ntrials where the cut brain went somewhere else than the whole one: ${differ}`);
if (differ) { console.error('the cut changes what happens; not writing it out'); process.exit(1); }

await mkdir(OUT, { recursive: true });
const gz = gzipSync(bytes, { level: 9 });
await writeFile(new URL('tell.fbg.gz', OUT), gz);
await writeFile(new URL('tell.json', OUT), JSON.stringify({
  n: keep.length, kept: keep.length, of: full.n, mn9: at[mn9], places: ['左', '中', '右'],
  inputs: { want: mapCut.want, see: mapCut.see, earAsk: mapCut.earAsk, ear: mapCut.ear },
  outputs: { ask: mapCut.ask, say: mapCut.say },
  parts: { wants: R([...wants]), saw: saw.map((m) => R([...m])), heard: mapCut.heard, agreed: mapCut.agreed,
    sayGate: sayGate.map(R), hearGate: hearGate.map(R), okGate: okGate.map(R) },
  talk: T,
}));
console.log(`\nwrote kaiwa/data/tell.fbg.gz (${(gz.length / 1024).toFixed(0)} KB) and tell.json`);
