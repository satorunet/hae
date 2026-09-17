// ハエ計算機 - plus, minus and times.
//
//   node soroban/keisan.mjs                          # the standard set
//   node soroban/keisan.mjs sums=123+456,500-321,23*4
//   node soroban/keisan.mjs digits=2 sums=7*8
//
// Addition is soroban/add.mjs. Two more things come out of the same parts:
//
//   minus  a second bank of gates on the accumulator that counts **down**, and a borrow instead of a
//          carry (a digit that runs off 0 goes to 9 and takes one from the digit above). Which bank
//          fires is decided by a veto per direction: the "plus" line silences one, the "minus" line
//          the other, and a tick with neither does nothing at all. Below zero it wraps - 12-30 is 982
//          in three digits, which is ten's complement and is what a machine of D digits does.
//
//   times  a loop register: one more operand register, wired to no accumulator, which nothing wipes
//          between operands. Multiplying is adding the same number until that register is spent, and
//          the register says when that is. So the fly does a x b as b additions of a, and what stops
//          it is a ring going quiet, not a counter in this script.
import { Workshop } from '../kakou/graft.mjs';
import { build, budget } from './machine.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const DIG = +(arg.digits || 3);
const SUMS = (arg.sums || '12+34,47+38,99+1,123+456,80-27,500-321,12-30,7*8,23*4,111*9').split(',');
const o = { ms: +(arg.ms || 200), read: +(arg.read || 50) };

const plain = await (await Workshop.open({ cells: 1 })).build();
console.log(`${DIG} digits, ${budget(DIG, { sub: true, loop: true })} new cells, tick ${o.ms} ms\n`);
const M = await build({ digits: DIG, plain, sub: true, loop: true, ...o });
const mod = 10 ** DIG;

function compute(a, op, b) {
  M.zero();
  if (op !== '*') {
    M.put(a); const ta = M.apply('+');           // the accumulator starts at a
    M.put(b);
    return [ta, M.apply(op)];                    // and b goes in or comes off
  }
  const rounds = [];
  M.setLoop(b);                                  // b in a register of its own, and add a until it is 0
  for (let i = 0; i < 10 && M.loopLeft() !== 0; i++) {
    M.put(a); rounds.push(M.apply('+').reduce((x, y) => x + y, 0));
    M.tickLoop();                                // one off the loop register
  }
  return rounds;
}

console.log('        sum |   the fly says |   should be | turns of the clock');
let wrong = 0, t0 = Date.now();
for (const e of SUMS) {
  const [, a, op, b] = e.match(/^(\d+)([-+*])(\d+)$/);
  M.reset(+(arg.seed || 1));
  const turns = compute(+a, op, +b);
  const want = String((((op === '+' ? +a + +b : op === '-' ? +a - +b : +a * +b) % mod) + mod) % mod).padStart(DIG, '0');
  const got = M.number();
  if (got !== want) wrong++;
  console.log(`${e.padStart(11)} | ${got.padStart(14)} | ${want.padStart(11)} | ${JSON.stringify(turns)}${got === want ? '' : '   ** WRONG **'}`);
}
console.log(`\n${SUMS.length - wrong} of ${SUMS.length} right, ${((Date.now() - t0) / 1e3).toFixed(0)} s of wall clock, ${(M.ms / 1e3).toFixed(1)} s of fly`);
