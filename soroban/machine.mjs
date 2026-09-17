// ハエ計算機 - the machine.
//
// A number is D digits, each a one-hot mod-10 ring register (soroban/digit.mjs). There are two of them
// side by side:
//
//   ACC   the accumulator, which only knows how to count up by one, and to carry
//   OP    the operand, which only knows how to count down by one, and to stop at zero
//
// and one wire between them: **OP's down-gate is what asks ACC to count up.** So adding a digit is a
// loop the brain runs itself -
//
//   TICK   OP[k] & run   -> gate  -> OP gets k-1, and writes the "asked" latch
//          ACC[j] & (asked or carry from the digit below) -> gate -> ACC's shadow gets j+1
//                                                                   (and j = 9 writes this digit's carry)
//   TOCK   every shadow that is up becomes its register's digit
//   CLEAR  the shadows, the "asked" latch and the carries are wiped
//
// The loop stops itself: there is no down-gate on OP's state 0, so once the operand digit is used up
// nothing asks and ACC stands still. Nobody outside the brain has to know what the digit was - which
// matters, because the digits come from the fly's eye (soroban/yomu.mjs) and not from the experimenter.
//
// Everything else is the clock: tick, tock, clear, zero, wipe and one "run" line per digit position,
// each a real sensory population pulsed at 150 Hz. The fly is not building the rhythm, it is hearing it.
import { Workshop } from '../kakou/graft.mjs';
import { G, drivers } from './lines.mjs';

export const LINES = {
  tick: 'mechano:JO_wind_gravity:L+mechano:JO_wind_gravity:R',
  tock: 'mechano:head_bristle:L+mechano:head_bristle:R',
  clear: 'mechano:eye_bristle:L+mechano:eye_bristle:R',
  zero: 'visual:ocellar:L+visual:ocellar:R',
  wipe: 'vpn:LPLC2:L+vpn:LPLC2:R',
  run: ['vpn:LC11:L+vpn:LC11:R', 'vpn:LC6:L+vpn:LC6:R', 'vpn:LC4:L+vpn:LC4:R',
        'vpn:LPLC1:L+vpn:LPLC1:R', 'mechano:JO_auditory:L+mechano:JO_auditory:R'],
  plus: 'mechano:JO_grooming:L+mechano:JO_grooming:R',
  minus: 'gustatory:sugar_water:L+gustatory:sugar_water:R',
};

export const DEFAULTS = {
  h: 32, rec: 16,          // a latch: 32 cells, two groups, 16 synapses a pair (kakou graft 1)
  feed: 16,                // writing one. 60 - kakou's number - is past the edge: see soroban/README
  clr: 32,                 // clearing one (kakou graft 2: 16-64 works, 128 outlives the clear)
  gate: 16, veto: 8,       // a disinhibited gate (kakou graft 3)
  gb: 8, vb: 32, vg: 128, vh: 128,
  ms: 200, tickMs: 0, hz: 150, read: 50,
};

/** How many new cells a machine of `digits` digits takes. */
export function budget(digits, { sub = false, loop = false, ...rest } = {}) {
  const o = { ...DEFAULTS, ...rest };
  // per digit position: 42 rings (ACC 10+10+asked+carry, OP 10+10), 10 loaders of 8,
  // 39 gates (9 down, 10 up, 20 tock) and 49 vetoes (2 on each down gate, 1 shared "asked" veto and
  // one per state on the up gates, 1 on each tock gate)
  const per = 42 * o.h + 10 * 8 + 39 * o.gate + 49 * o.veto;
  const perSub = 10 * o.gate + 12 * o.veto + o.h;        // the down bank, its vetoes and the borrow
  const perLoop = 20 * o.h + 10 * 8 + 19 * o.gate + 28 * o.veto;   // an operand register on its own
  return digits * (per + (sub ? perSub : 0)) + (loop ? perLoop : 0);
}

export async function build({ digits = 3, plain, quiet = false, sub = false, loop = false, ...over } = {}) {
  const o = { ...DEFAULTS, ...over };
  const nop = digits + (loop ? 1 : 0);                  // the loop register is an operand register
  if (nop > LINES.run.length) throw new Error(`only ${LINES.run.length} run lines`);
  const IN = { tick: G(LINES.tick), tock: G(LINES.tock), clear: G(LINES.clear), zero: G(LINES.zero), wipe: G(LINES.wipe) };
  for (let d = 0; d < nop; d++) IN['run' + d] = G(LINES.run[d]);
  if (sub) { IN.plus = G(LINES.plus); IN.minus = G(LINES.minus); }
  if (!quiet) console.log('lines:');
  const D = drivers(plain, IN, { quiet, ms: o.ms, hz: o.hz });

  const W = await Workshop.open({ cells: budget(digits, { sub, loop, ...over }) + 128, slots: 96 });
  const mem = () => W.memory(o.h, { groups: 2, rec: o.rec });
  const acc = [], op = [];
  for (let d = 0; d < digits; d++)
    acc.push({ m: [...Array(10)].map(mem), s: [...Array(10)].map(mem), req: mem(), carry: mem(), borrow: sub ? mem() : null });
  for (let d = 0; d < nop; d++)
    op.push({ m: [...Array(10)].map(mem), s: [...Array(10)].map(mem), load: [...Array(10)].map(() => W.cells(8)) });
  // a gate the tick opens only when every one of `opens` is firing: it reaches the gate weakly and
  // also fires a veto per condition, and each condition silences its own veto (kakou graft 3)
  const veto = (opens) => {
    const v = W.cells(o.veto);
    W.wire(D.tick, v, o.vb);
    for (const open of opens) W.wire(open, v, -o.vh);
    return v;
  };
  const gate = (vetoes) => {
    const g = W.cells(o.gate);
    W.wire(D.tick, g, o.gb);
    for (const v of vetoes) W.wire(v, g, -o.vg);
    return g;
  };
  // One veto per accumulator digit carries the whole question "is this digit being asked to count up":
  // its own operand asked, or the digit below it carried. Both silence it, which is an OR for nothing.
  const asked = acc.map((A, d) => veto(d ? [A.req, acc[d - 1].carry, ...(sub ? [acc[d - 1].borrow] : [])] : [A.req]));
  // in a machine that can also take away, one veto per direction says which way this tick counts
  const vplus = sub ? acc.map(() => veto([D.plus])) : null;
  const vminus = sub ? acc.map(() => veto([D.minus])) : null;
  for (let d = 0; d < nop; d++) {
    const O = op[d], A = d < digits ? acc[d] : null;
    if (A) {
      W.wire(D.zero, A.m[0].ring[0], o.feed);       // zero: the accumulator is 0
      for (let k = 1; k < 10; k++) W.wire(D.zero, A.m[k], -o.clr);
      for (let k = 0; k < 10; k++) W.wire(D.zero, A.s[k], -o.clr);
      W.wire(D.zero, A.req, -o.clr); W.wire(D.zero, A.carry, -o.clr);
      if (sub) W.wire(D.zero, A.borrow, -o.clr);
    }
    for (let k = 0; k < 10; k++) {
      W.wire(D.zero, O.m[k], -o.clr); W.wire(D.zero, O.s[k], -o.clr);
      if (d < digits) { W.wire(D.wipe, O.m[k], -o.clr); W.wire(D.wipe, O.s[k], -o.clr); }  // the loop
    }                                               // register is not wiped between operands
    for (let v = 0; v < 10; v++) W.wire(O.load[v], O.m[v].ring[0], o.feed);   // loading a digit

    // OP counts down, if this position's run line is on. There is no gate on 0, so it stops there.
    for (let k = 1; k < 10; k++) {
      const g = gate([veto([D['run' + d]]), veto([O.m[k]])]);
      W.wire(g, O.s[k - 1].ring[0], o.feed);
      W.wire(g, O.m[k], -o.clr);
      if (A) {
        W.wire(g, A.req.ring[0], o.feed);           // *** and this is what asks ACC to count ***
        W.wire(g, asked[d], -o.vh);                 // the short way round: a ring takes ~60 ms to come
      }                                             // up and silence a veto, and the gate itself ~2
    }
    if (!A) continue;
    // ACC counts up, when it is asked or when the digit below it carried
    for (let k = 0; k < 10; k++) {
      const g = gate([asked[d], veto([A.m[k]]), ...(sub ? [vplus[d]] : [])]);
      W.wire(g, A.s[(k + 1) % 10].ring[0], o.feed);
      W.wire(g, A.m[k], -o.clr);
      if (k === 9) {
        W.wire(g, A.carry.ring[0], o.feed);
        if (d + 1 < digits) W.wire(g, asked[d + 1], -o.vh);      // and the same short way for a carry
      }
    }
    // and down, on a minus tick, borrowing from the digit above when it runs off 0
    if (sub) for (let k = 0; k < 10; k++) {
      const g = gate([asked[d], veto([A.m[k]]), vminus[d]]);
      W.wire(g, A.s[(k + 9) % 10].ring[0], o.feed);
      W.wire(g, A.m[k], -o.clr);
      if (k === 0) {
        W.wire(g, A.borrow.ring[0], o.feed);
        if (d + 1 < digits) W.wire(g, asked[d + 1], -o.vh);
      }
    }
    // the tock: every shadow that is up becomes the digit, and the clear wipes what is spent
    for (const R of [A, O]) for (let k = 0; k < 10; k++) {
      const g = W.cells(o.gate), v = W.cells(o.veto);
      W.wire(D.tock, g, o.gb); W.wire(D.tock, v, o.vb); W.wire(v, g, -o.vg);
      W.wire(R.s[k], v, -o.vh);
      W.wire(g, R.m[k].ring[0], o.feed);
      W.wire(D.clear, R.s[k], -o.clr);
    }
    W.wire(D.clear, A.req, -o.clr);
    W.wire(D.clear, A.carry, -o.clr);
    if (sub) W.wire(D.clear, A.borrow, -o.clr);
  }
  // the loop register's own tock and clear (it has no accumulator beside it)
  if (loop) { const O = op[digits];
    for (let k = 0; k < 10; k++) {
      const g = W.cells(o.gate), v = W.cells(o.veto);
      W.wire(D.tock, g, o.gb); W.wire(D.tock, v, o.vb); W.wire(v, g, -o.vg);
      W.wire(O.s[k], v, -o.vh);
      W.wire(g, O.m[k].ring[0], o.feed);
      W.wire(D.clear, O.s[k], -o.clr);
    }
  }
  // A carry is a chain: the gate that wraps 9 -> 0 silences the next digit's veto at once, but the
  // ring behind it takes ~40 ms to come up, so a ripple through D digits needs a tick that long.
  if (!o.tickMs) o.tickMs = o.ms + 80 * (digits - 1);
  const brain = await W.build();
  return new Machine({ brain, W, acc, op, IN, D, o, digits, sub, loop });
}

export class Machine {
  constructor(x) { Object.assign(this, x); this.at = null; this.ms = 0; }
  reset(seed = 1) {
    this.brain.clearStimuli(); this.brain.reset(seed);
    this.at = Uint32Array.from(this.brain.counts()); this.ms = 0;
  }
  /** Run `ms` with `stim` (model indices) on, and hand back the spikes of everything interesting. */
  phase(ms, stim) {
    const b = this.brain;
    b.clearStimuli();
    if (stim && stim.length) b.stimulate(stim, this.o.hz, { byIndex: true });
    b.run(ms); this.ms += ms;
    const c = b.counts(), at = this.at;
    const sum = (cells) => cells.reduce((t, i) => t + (c[i] - at[i]), 0);
    this.at = Uint32Array.from(c);
    return {
      acc: this.acc.map((A) => ({ m: A.m.map(sum), req: sum(A.req), carry: sum(A.carry) })),
      op: this.op.map((O) => ({ m: O.m.map(sum) })),
      sum,
    };
  }
  /** What each register is showing now, read with nothing going in. -1 = no digit up. */
  look() {
    const r = this.phase(this.o.read, null);
    const one = (v) => { const k = v.indexOf(Math.max(...v)); return Math.max(...v) > 20 ? k : -1; };
    return {
      acc: r.acc.map((A) => one(A.m)), op: r.op.map((O) => one(O.m)),
      accRaw: r.acc.map((A) => A.m), opRaw: r.op.map((O) => O.m),
      carry: r.acc.map((A) => A.carry),
    };
  }
  zero() { this.phase(this.o.ms, this.IN.zero); }
  wipe() { this.phase(this.o.ms, this.IN.wipe); }
  /** Put `v` into the operand register at position `d` (this is what the eye does in yomu.mjs). */
  load(d, v) { this.phase(this.o.ms, this.op[d].load[v]); }
  /** One turn of the clock with position `d`'s run line on, counting `way` ('+' or '-'). */
  cycle(d, way = '+') {
    const mode = this.sub ? (way === '-' ? this.IN.minus : this.IN.plus) : [];
    const t = this.phase(this.o.tickMs, [...this.IN.tick, ...this.IN['run' + d], ...mode]);
    const k = this.phase(this.o.ms, this.IN.tock);
    const c = this.phase(this.o.ms, this.IN.clear);
    return { t, k, c };
  }
  /**
   * Add the operand digit at position `d` into the accumulator: turn the clock until the operand is
   * spent. The machine says when that is (its state-0 ring is the one that is up), so this never needs
   * to know what the digit was.
   */
  add(d, way = '+', max = 10) {
    let n = 0;
    for (; n < max; n++) {
      const r = this.look();
      if (r.op[d] === 0) break;
      this.cycle(d, way);
    }
    return n;
  }
  /** Put a whole number into the operand registers, least significant digit at position 0. */
  put(n) {
    this.wipe();
    for (let d = 0; d < this.digits; d++) this.load(d, Math.floor(n / 10 ** d) % 10);
  }
  /** Add (or take away) whatever is in the operand registers, digit by digit. */
  apply(way = '+') { const t = []; for (let d = 0; d < this.digits; d++) t.push(this.add(d, way)); return t; }
  number() { return this.look().acc.map((k) => (k < 0 ? '?' : k)).reverse().join(''); }
  /** The loop register: load it, turn it down by one, ask whether it is spent. */
  setLoop(v) { this.load(this.digits, v); }
  tickLoop() { this.cycle(this.digits); }
  loopLeft() { return this.look().op[this.digits]; }
}
