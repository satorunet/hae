// Addition, in the brain of a fly.
//
//   node soroban/add.mjs                       # the standard set, 3 digits
//   node soroban/add.mjs digits=2 sums=7+8
//   node soroban/add.mjs ms=100                # a faster clock
//   node soroban/add.mjs fidelity=1            # and what it costs the animal
//
// Each number is put in one digit at a time and added by the machine of soroban/machine.mjs, which is
// told nothing but "the operand is in, now turn the clock". Every carry is the brain's own.
import { Workshop } from '../kakou/graft.mjs';
import { build, budget } from './machine.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const DIG = +(arg.digits || 3);
const SUMS = (arg.sums || (DIG >= 3 ? '12+34,47+38,99+1,123+456,777+345,908+92,500+500,1+999'
  : '3+4,7+8,12+34,55+45,99+1')).split(',');
const o = { ms: +(arg.ms || 200), read: +(arg.read || 50) };
const DEFAULTS_MS = o.ms;

const plain = await (await Workshop.open({ cells: 1 })).build();
console.log(`${DIG} digits, ${budget(DIG)} new cells, phases of ${o.ms} ms\n`);
const M = await build({ digits: DIG, plain, ...o });
const digitsOf = (n) => [...Array(DIG)].map((_, d) => Math.floor(n / 10 ** d) % 10);

function put(n) {                       // the number into the operand registers, one digit each
  M.wipe();
  const d = digitsOf(n);
  for (let k = 0; k < DIG; k++) M.load(k, d[k]);
  return d;
}
function addNumber(n) {
  put(n);
  const turns = [];
  for (let k = 0; k < DIG; k++) turns.push(M.add(k));
  return turns;
}

if (+(arg.ripple || 0)) {
  // How long a carry takes to travel. The accumulator is put at 99...9 and asked for one more, and
  // the tick is run in 20 ms slices to see when each digit up the chain moves.
  M.reset(1); M.zero();
  put(10 ** DIG - 1); for (let k = 0; k < DIG; k++) M.add(k);
  console.log(`accumulator at ${M.number()}, now +1, watched in 20 ms slices of the tick:\n`);
  put(1);
  const first = new Array(DIG + 1).fill(0);
  for (let t = 0; t < 600; t += 20) {
    const r = M.phase(20, [...M.IN.tick, ...M.IN.run0]);
    if (!first[0] && r.acc[0].req > 8) first[0] = t + 20;
    for (let d = 0; d < DIG; d++) if (!first[d + 1] && M.acc[d].s.reduce((t2, ring) => t2 + r.sum(ring), 0) > 8) first[d + 1] = t + 20;
  }
  console.log(`  the operand asks            ${String(first[0]).padStart(4)} ms`);
  for (let d = 0; d < DIG; d++) console.log(`  digit ${d} writes its shadow    ${String(first[d + 1]).padStart(4)} ms`);
  console.log(`\nthe tick is ${M.o.tickMs} ms long (${DEFAULTS_MS} + 80 per digit above the first)`);
  process.exit(0);
}

console.log('        sum |  loaded  | turns of the clock |   the fly says | right?');
let wrong = 0, t0 = Date.now();
for (const s of SUMS) {
  const [a, b] = s.split('+').map(Number);
  M.reset(+(arg.seed || 1));
  M.zero();
  const ta = addNumber(a), tb = addNumber(b);
  const got = M.number(), want = String((a + b) % 10 ** DIG).padStart(DIG, '0');
  if (got !== want) wrong++;
  console.log(`${s.padStart(11)} | ${(String(a).padStart(DIG, '0') + ' ' + String(b).padStart(DIG, '0')).padStart(8)} | ${(ta.join('+') + ' then ' + tb.join('+')).padStart(18)} | ${got.padStart(14)} | ${got === want ? 'right' : `** ${want} **`}`);
}
console.log(`\n${SUMS.length - wrong} of ${SUMS.length} right, ${((Date.now() - t0) / 1e3).toFixed(0)} s of wall clock, ${(M.ms / 1e3).toFixed(1)} s of fly`);

if (+arg.fidelity) {
  // what the graft costs the animal: the connectome's own neurons, with the machine sitting there
  const { readFile } = await import('node:fs/promises');
  const groups = JSON.parse(await readFile(new URL('../flybrain/data/groups783.json', import.meta.url), 'utf8')).groups;
  const MN9 = plain.index('720575940660219265');
  console.log('\nwith the machine in place, against the plain brain over 1 s:');
  console.log('              | neurons differing | spikes (plain vs grafted) |  MN9');
  for (const [name, cells] of [['sugar', groups['shiu:sugar'].idx], ['bitter', groups['shiu:bitter'].idx], ['nothing', []]]) {
    let diff = 0, sp = [0, 0], mn = [0, 0];
    for (let s = 1; s <= 3; s++) {
      const out = [plain, M.brain].map((b) => {
        b.clearStimuli(); b.reset(s);
        if (cells.length) b.stimulate(cells, 150, { byIndex: true });
        b.run(1000);
        return Uint32Array.from(b.counts());
      });
      for (let i = 0; i < M.W.n0; i++) { if (out[0][i] !== out[1][i]) diff++; sp[0] += out[0][i]; sp[1] += out[1][i]; }
      mn[0] += out[0][MN9] / 3; mn[1] += out[1][MN9] / 3;
    }
    console.log(`${name.padStart(13)} |     ${String(Math.round(diff / 3)).padStart(6)} / ${M.W.n0} | ${String(Math.round(sp[0] / 3)).padStart(11)} vs ${String(Math.round(sp[1] / 3)).padStart(9)} | ${mn[0].toFixed(0)} vs ${mn[1].toFixed(0)}`);
  }
}
