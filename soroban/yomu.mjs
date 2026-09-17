// 読む - the digits come from the fly's own eye.
//
// /suji/ has a fly that reads handwritten numerals: pictures go in where odours do, the mushroom body
// makes a sparse code of each one, and 110,217 practices of dopamine-gated depression left it answering
// 89.6% of MNIST's test digits right. That fly could read a digit and do nothing with it - 50 ms later
// its brain is silent again (kakou/hold.mjs).
//
// This is the same fly with the machine of soroban/machine.mjs grafted in, in one brain: it looks at a
// picture, the digit it read is written into a ring register, and the registers add. Nothing is held
// outside the brain between one picture and the answer.
//
//   node soroban/yomu.mjs                  # 8 sums of two 2-digit numbers, read from MNIST
//   node soroban/yomu.mjs n=10 digits=3
//   node soroban/yomu.mjs control=1        # first: does a brain that is holding a number still read?
//
// The one thing that is not spikes is the comparison between the nine compartments - the answer is
// which compartment the picture drives least, which /suji/, /hiragana/ and /kana/ all work out in
// arithmetic outside the brain. It cannot be done with neurons here: measured over 40 test digits the
// drive rule is right 38 times and the least-*spiking* compartment 2, because in this model the MBONs
// of a silenced brain barely fire at all. So the reading is the fly's and the comparison is not, and
// everything after it - the digit, the carry, the sum - is back inside.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';
import { makeReader, COURSES } from '../juku/reader.mjs';
import { Workshop } from '../kakou/graft.mjs';
import { build } from './machine.mjs';

const ROOT = new URL('../', import.meta.url);
const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const DIG = +(arg.digits || 2), N = +(arg.n || 8), SEED = +(arg.seed || 7);
const GAINS = arg.gains || 'juku/state/suji/brain-110217.bin.gz';
const C = COURSES.suji;

// ---- MNIST's test digits, 12x12, labelled 1-9 (the fly was never taught a zero)
const rec = 145;
const test = new Uint8Array(gunzipSync(await readFile(new URL('juku/data/mnist12_test.bin.gz', ROOT))));
const nTest = test.length / rec;
const picture = (n) => Float32Array.from(test.subarray(n * rec + 1, (n + 1) * rec), (v) => v / 255);
const byDigit = [...Array(10)].map(() => []);
for (let n = 0; n < nTest; n++) byDigit[test[n * rec]].push(n);

// ---- one brain: the connectome, the machine, and the mushroom body that reads
const plain = await (await Workshop.open({ cells: 1 })).build();
const M = await build({ digits: DIG, plain, quiet: !!+(arg.quiet || 0) });
const graft = [...Array(M.W.newCells).keys()].map((k) => M.W.n0 + k);
const keep = [...graft, ...Object.values(M.IN).flat()];
const R = await makeReader({ FlyBrain, base: new URL('flybrain/', ROOT), course: 'suji', brain: M.brain, keep });
R.importGains(new Float32Array(gunzipSync(await readFile(new URL(GAINS, ROOT))).buffer));
console.log(`\n${M.W.newCells} new cells for ${DIG} digits; the mushroom body reads with ${GAINS.split('/').pop()}`);
console.log(`everything outside the mushroom body, the machine and the clock lines is silenced, as juku/reader.mjs does\n`);

/** Look at a picture without resetting the brain - the registers have to survive it. */
function look(img) {
  const b = M.brain;
  R.stimulate(img);
  b.setPlasticityParams({ eta: 0, tauTrace: 40, tauDopa: 1e7, gainMin: C.gainMin, gainMax: C.gainMax });
  const before = Uint32Array.from(b.counts());
  b.run(C.ms, { events: false });
  const c = b.counts();
  const spikes = new Uint16Array(R.KC.length);
  for (let k = 0; k < R.KC.length; k++) spikes[k] = Math.min(65535, c[R.KC[k]] - before[R.KC[k]]);
  M.at = Uint32Array.from(c); M.ms += C.ms;
  b.clearStimuli();
  return { answer: R.decide(b.driveByGroup(R.KC, spikes)).answer + 1, kc: spikes.reduce((t, v) => t + (v ? 1 : 0), 0) };
}

const rnd = (() => { let s = SEED >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();
const pick = (d) => byDigit[d][Math.floor(rnd() * byDigit[d].length)];

if (+(arg.control || 0)) {
  // Does the fly still read while the rings are up? Same pictures, reset between each (as /suji/ does)
  // and then straight through with the machine holding a number.
  const shots = [...Array(90).keys()].map(() => { const d = 1 + Math.floor(rnd() * 9); return [pick(d), d]; });
  M.reset(1); M.zero();
  let a = 0;
  for (const [n, d] of shots) { M.brain.reset(1000 + n); if (look(picture(n)).answer === d) a++; }
  M.reset(2); M.zero(); M.wipe();
  for (let k = 0; k < DIG; k++) M.load(k, 7);
  let b = 0, kc = 0;
  for (const [n, d] of shots) { const r = look(picture(n)); if (r.answer === d) b++; kc += r.kc / shots.length; }
  const held = M.look();
  console.log(`reading, brain reset between pictures (as /suji/ runs)        ${(a / shots.length * 100).toFixed(1)}%`);
  console.log(`reading, never reset, ${DIG} rings holding a digit throughout    ${(b / shots.length * 100).toFixed(1)}%  (${kc.toFixed(0)} Kenyon cells a picture)`);
  console.log(`and the registers still hold what they held: ${held.op.join('')} \n`);
}

// ---- the sums
console.log('   shown | the fly reads |        sum | it says | right?');
let digitsRight = 0, digitsAll = 0, right = 0, clean = 0, cleanRight = 0;
for (let t = 0; t < N; t++) {
  const nums = [0, 1].map(() => [...Array(DIG)].map(() => 1 + Math.floor(rnd() * 9)));   // no zeros: unteachable
  M.reset(100 + t); M.zero();
  const read = [];
  for (const num of nums) {
    M.wipe();
    const got = [];
    for (let d = 0; d < DIG; d++) {                       // position 0 is the units digit
      const truth = num[DIG - 1 - d], n = pick(truth);
      const v = look(picture(n));
      got[d] = v.answer;
      digitsAll++; digitsRight += v.answer === truth;
      M.load(d, v.answer);
    }
    for (let d = 0; d < DIG; d++) M.add(d);
    read.push(got);
  }
  const shown = nums.map((x) => x.join('')).join(' + ');
  const asRead = read.map((g) => [...g].reverse().join('')).join(' + ');
  const want = String((+read[0].slice().reverse().join('') + +read[1].slice().reverse().join('')) % 10 ** DIG).padStart(DIG, '0');
  const total = +nums[0].join('') + +nums[1].join('');
  const truthSum = String(total % 10 ** DIG).padStart(DIG, '0');
  const got = M.number();
  const ok = got === truthSum;
  right += ok;
  const readOk = asRead === shown;
  if (readOk) { clean++; cleanRight += ok; }
  console.log(`${shown.padStart(8)} | ${asRead.padStart(13)} | ${String(total).padStart(10)} | ${got.padStart(7)} | ${ok ? 'right' : (want === got ? 'misread' : '** WRONG **')}`);
}
console.log(`\ndigits read right      ${digitsRight}/${digitsAll}  (${(digitsRight / digitsAll * 100).toFixed(1)}%)`);
console.log(`sums right end to end  ${right}/${N}`);
console.log(`sums where every digit was read right: ${clean}, of which the arithmetic was right ${cleanRight}`);
console.log(`${(M.ms / 1e3).toFixed(1)} s of fly`);
