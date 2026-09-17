// そろばん - the same brain, counting the way a hand does.
//
// soroban/machine.mjs adds by counting: 7 + 8 is fifteen turns of a clock, and a three-digit sum can be
// twenty-seven of them. A soroban does not count. Each rod carries **one five-bead and four one-beads**,
// so a digit is (5h + e), and adding is a *move*: put up e beads if there is room, and if there is not,
// take the five and give back its complement, and if the five is taken too, give one to the rod above
// and give back ten's complement. Every one of those is a rule of the form "in this state, with this
// input, go to that state" - which is the one thing this brain has been shown to do (kakou graft 6).
//
//   a rod   h: a one-hot pair (the five-bead, up or down)     e: a one-hot five (the one-beads, 0-4)
//   adding  e + be  -> the earth gate, which also says whether it carried into the five (c5 / c5no)
//           h + bh + c5 -> the heaven gate, which says whether it carried into the rod above (cout)
//   carry   one "carry tick" ripples every cout through the rods above, as soroban/machine.mjs does
//
// The whole of a three-digit operand goes in **at once** - every rod adds its own digit in the same
// tick - so a sum is a fixed handful of phases instead of one per unit counted.
//
//   node soroban/soroban.mjs                 # add the standard set, and check every digit of it
//   node soroban/soroban.mjs sums=999+1,123+456
//   node soroban/soroban.mjs race=1          # against the counting machine, in fly time
import { Workshop } from '../kakou/graft.mjs';
import { G, drivers } from './lines.mjs';

export const LINES = {
  tick: 'mechano:JO_wind_gravity:L+mechano:JO_wind_gravity:R',      // add the operand
  ctick: 'vpn:LC11:L+vpn:LC11:R',                                   // ripple the carries
  tock: 'mechano:head_bristle:L+mechano:head_bristle:R',            // shadows become beads
  clear: 'mechano:eye_bristle:L+mechano:eye_bristle:R',             // wipe shadows and the five-carry
  cclear: 'vpn:LC6:L+vpn:LC6:R',                                    // wipe the carries between rods
  stick: 'vpn:LC4:L+vpn:LC4:R',                                     // take the operand away
  bctick: 'vpn:LPLC1:L+vpn:LPLC1:R',                                // ripple the borrows
  zero: 'visual:ocellar:L+visual:ocellar:R',                        // the soroban is set to 0
  wipe: 'vpn:LPLC2:L+vpn:LPLC2:R',                                  // the operand rods are emptied
};

export const DEFAULTS = {
  h: 32, rec: 16, feed: 16, clr: 32,
  gate: 16, veto: 8, gb: 8, vb: 32, vg: 128, vh: 128,
  ms: 200, tickMs: 0, hz: 150, read: 50, gap: 60,
};

export function budget(digits, o = DEFAULTS) {
  // per rod: 24 rings (beads 2+5, shadows 2+5, c5, c5no, cout, and the operand's 2+5), 20 loaders
  // of 8 (ten into the operand, ten straight onto the beads), and two sets of the same gates - one to
  // add, one to take away - which share the rings: 25 earth + 8 heaven + 5 carry-earth + 4
  // carry-heaven each, plus 7 tock gates.
  return digits * (24 * o.h + 20 * 8 + 91 * o.gate + 183 * o.veto);
}

export async function build({ digits = 3, plain, quiet = false, loop = false, ...over } = {}) {
  const o = { ...DEFAULTS, ...over };
  const nrods = digits + (loop ? 1 : 0);        // one more rod to count the rounds of a multiplication
  const IN = Object.fromEntries(Object.entries(LINES).map(([k, v]) => [k, G(v)]));
  if (!quiet) console.log('lines:');
  const D = drivers(plain, IN, { quiet, ms: o.ms, hz: o.hz });

  const W = await Workshop.open({ cells: budget(nrods, o) + 128, slots: 96 });
  const mem = () => W.memory(o.h, { groups: 2, rec: o.rec });
  const rods = [];
  for (let r = 0; r < nrods; r++) {
    rods.push({
      h: [mem(), mem()], e: [...Array(5)].map(mem),              // the beads
      hs: [mem(), mem()], es: [...Array(5)].map(mem),            // where the next move is written
      c5: mem(), c5no: mem(), cout: mem(),                       // what the move carried
      b: { h: [mem(), mem()], e: [...Array(5)].map(mem), load: [...Array(10)].map(() => W.cells(8)) },
      set: [...Array(10)].map(() => W.cells(8)),     // put a digit straight onto the beads ("置く")
    });
  }
  const veto = (line, opens) => {
    const v = W.cells(o.veto);
    W.wire(line, v, o.vb);
    for (const open of opens) W.wire(open, v, -o.vh);
    return v;
  };
  const gate = (line, conds) => {
    const g = W.cells(o.gate);
    W.wire(line, g, o.gb);
    for (const c of conds) W.wire(veto(line, [c]), g, -o.vg);
    return g;
  };

  for (let r = 0; r < nrods; r++) {
    const A = rods[r], B = A.b;
    // zero: 0 beads on every rod, nothing held anywhere
    W.wire(D.zero, A.h[0].ring[0], o.feed); W.wire(D.zero, A.e[0].ring[0], o.feed);
    for (const ring of [A.h[1], ...A.e.slice(1), ...A.hs, ...A.es, A.c5, A.c5no, A.cout, ...B.h, ...B.e])
      W.wire(D.zero, ring, -o.clr);
    for (const ring of [...B.h, ...B.e]) W.wire(D.wipe, ring, -o.clr);      // the operand only
    for (let b = 0; b < 10; b++) {                                          // a digit into the operand
      W.wire(B.load[b], B.e[b % 5].ring[0], o.feed);
      W.wire(B.load[b], B.h[b >= 5 ? 1 : 0].ring[0], o.feed);
      // and a digit placed straight onto the beads, which is what a hand does with the first number:
      // no adding, no carrying, one pulse - the other beads are pushed out of the way by the same cells
      const he = b >= 5 ? 1 : 0, ee = b % 5;
      W.wire(A.set[b], A.h[he].ring[0], o.feed);
      W.wire(A.set[b], A.e[ee].ring[0], o.feed);
      W.wire(A.set[b], A.h[1 - he], -o.clr);
      for (let k = 0; k < 5; k++) if (k !== ee) W.wire(A.set[b], A.e[k], -o.clr);
    }
    // --- the tick: every rod adds its own digit. The one-beads first.
    for (let e = 0; e < 5; e++) for (let be = 0; be < 5; be++) {
      const g = gate(D.tick, [A.e[e], B.e[be]]);
      const s = e + be;
      W.wire(g, A.es[s % 5].ring[0], o.feed);
      W.wire(g, A.e[e], -o.clr);
      W.wire(g, (s >= 5 ? A.c5 : A.c5no).ring[0], o.feed);   // did the one-beads reach five
    }
    // then the five-bead, which needs to know both the operand's five and what the one-beads carried
    for (let h = 0; h < 2; h++) for (let bh = 0; bh < 2; bh++) for (let c = 0; c < 2; c++) {
      const g = gate(D.tick, [A.h[h], B.h[bh], c ? A.c5 : A.c5no]);
      const s = h + bh + c;
      W.wire(g, A.hs[s % 2].ring[0], o.feed);
      W.wire(g, A.h[h], -o.clr);
      if (s >= 2) W.wire(g, A.cout.ring[0], o.feed);         // ten: one for the rod above
    }
    // --- the carry tick: +1 from the rod below, rippling upward in the one tick.
    // The loop rod is not part of the number, so the chain must stop before it - otherwise a sum that
    // runs off the top adds one to the count of rounds left in a multiplication.
    if (r > 0 && r < digits) {
      const below = rods[r - 1];
      for (let e = 0; e < 5; e++) {
        const g = gate(D.ctick, [below.cout, A.e[e]]);
        const s = e + 1;
        W.wire(g, A.es[s % 5].ring[0], o.feed);
        W.wire(g, A.e[e], -o.clr);
        W.wire(g, (s >= 5 ? A.c5 : A.c5no).ring[0], o.feed);
      }
      for (let h = 0; h < 2; h++) for (let c = 0; c < 2; c++) {
        const g = gate(D.ctick, [A.h[h], c ? A.c5 : A.c5no]);
        const s = h + c;
        W.wire(g, A.hs[s % 2].ring[0], o.feed);
        W.wire(g, A.h[h], -o.clr);
        if (s >= 2) W.wire(g, A.cout.ring[0], o.feed);      // which the rod above picks up, one hop on
      }
    }
    // --- taking away, which is the same thing with the beads going the other way: not enough
    // one-beads means taking the five and giving back its complement, and no five means borrowing
    // ten from the rod above.
    for (let e = 0; e < 5; e++) for (let be = 0; be < 5; be++) {
      const g = gate(D.stick, [A.e[e], B.e[be]]);
      const s = e - be;
      W.wire(g, A.es[(s + 5) % 5].ring[0], o.feed);
      W.wire(g, A.e[e], -o.clr);
      W.wire(g, (s < 0 ? A.c5 : A.c5no).ring[0], o.feed);   // did it have to break the five
    }
    for (let h = 0; h < 2; h++) for (let bh = 0; bh < 2; bh++) for (let c = 0; c < 2; c++) {
      const g = gate(D.stick, [A.h[h], B.h[bh], c ? A.c5 : A.c5no]);
      const s = h - bh - c;
      W.wire(g, A.hs[(s + 2) % 2].ring[0], o.feed);
      W.wire(g, A.h[h], -o.clr);
      if (s < 0) W.wire(g, A.cout.ring[0], o.feed);         // ten borrowed from the rod above
    }
    if (r > 0 && r < digits) {
      const below = rods[r - 1];
      for (let e = 0; e < 5; e++) {                          // -1 rippling up
        const g = gate(D.bctick, [below.cout, A.e[e]]);
        const s = e - 1;
        W.wire(g, A.es[(s + 5) % 5].ring[0], o.feed);
        W.wire(g, A.e[e], -o.clr);
        W.wire(g, (s < 0 ? A.c5 : A.c5no).ring[0], o.feed);
      }
      for (let h = 0; h < 2; h++) for (let c = 0; c < 2; c++) {
        const g = gate(D.bctick, [A.h[h], c ? A.c5 : A.c5no]);
        const s = h - c;
        W.wire(g, A.hs[(s + 2) % 2].ring[0], o.feed);
        W.wire(g, A.h[h], -o.clr);
        if (s < 0) W.wire(g, A.cout.ring[0], o.feed);
      }
    }
    // --- the tock: every shadow becomes a bead; the clear wipes what is spent
    for (const [shadow, bead] of [[A.hs, A.h], [A.es, A.e]]) {
      for (let k = 0; k < shadow.length; k++) {
        const g = W.cells(o.gate), v = W.cells(o.veto);
        W.wire(D.tock, g, o.gb); W.wire(D.tock, v, o.vb); W.wire(v, g, -o.vg);
        W.wire(shadow[k], v, -o.vh);
        W.wire(g, bead[k].ring[0], o.feed);
        W.wire(D.clear, shadow[k], -o.clr);
      }
    }
    W.wire(D.clear, A.c5, -o.clr); W.wire(D.clear, A.c5no, -o.clr);
    // the carries last until they are used, and the last clear of a move wipes everything at once
    W.wire(D.cclear, A.cout, -o.clr);
    W.wire(D.cclear, A.c5, -o.clr); W.wire(D.cclear, A.c5no, -o.clr);
    for (const ring of [...A.hs, ...A.es]) W.wire(D.cclear, ring, -o.clr);
  }
  const brain = await W.build();
  if (!o.tickMs) o.tickMs = o.ms + 80 * (nrods - 1);         // a carry takes ~40 ms a rod
  return new Soroban({ brain, W, rods, IN, D, o, digits, nrods, loop });
}

export class Soroban {
  constructor(x) { Object.assign(this, x); this.at = null; this.ms = 0; }
  reset(seed = 1) {
    this.brain.clearStimuli(); this.brain.reset(seed);
    this.at = Uint32Array.from(this.brain.counts()); this.ms = 0;
  }
  phase(ms, stim) {
    const b = this.brain;
    b.clearStimuli();
    if (stim && stim.length) b.stimulate(stim, this.o.hz, { byIndex: true });
    b.run(ms); this.ms += ms;
    const c = b.counts(), at = this.at;
    const sum = (cells) => cells.reduce((t, i) => t + (c[i] - at[i]), 0);
    this.at = Uint32Array.from(c);
    return { sum, rods: this.rods.map((R) => ({ h: R.h.map(sum), e: R.e.map(sum), cout: sum(R.cout) })) };
  }
  /** What the soroban shows now: the beads, read with nothing going in. */
  look() {
    const r = this.phase(this.o.read, null);
    const one = (v) => { const k = v.indexOf(Math.max(...v)); return Math.max(...v) > 20 ? k : -1; };
    return r.rods.map((R) => {
      const h = one(R.h), e = one(R.e);
      return h < 0 || e < 0 ? -1 : h * 5 + e;
    });
  }
  number() { return this.look().slice(0, this.digits).map((d) => (d < 0 ? '?' : d)).reverse().join(''); }
  zero() { this.phase(this.o.ms, this.IN.zero); }
  /** The digits of `n`, rod by rod (and `loopDigit` onto the rod that counts rounds). */
  digitsOf(n, loopDigit = 0) {
    return this.rods.map((R, r) => (r < this.digits ? Math.floor(n / 10 ** r) % 10 : loopDigit));
  }
  /**
   * A whole number onto the operand rods - every rod in the *same* pulse, because the rods are
   * different cells and nothing stops them being written at once.
   */
  put(n, loopDigit = 0) {
    this.phase(this.o.ms, this.IN.wipe);
    const cells = this.digitsOf(n, loopDigit).flatMap((d, r) => this.rods[r].b.load[d]);
    this.phase(this.o.ms, cells);
  }
  /**
   * The first number is not added, it is *placed*: one pulse, straight onto the beads, the way a hand
   * puts a number on a soroban before it starts. `list[r] = null` leaves that rod alone.
   */
  placeRods(list) {
    const cells = list.flatMap((d, r) => (d == null ? [] : this.rods[r].set[d]));
    this.phase(this.o.ms, cells);
  }
  place(n, loopDigit = 0) { this.placeRods(this.digitsOf(n, loopDigit)); }
  /**
   * Add whatever is on the operand rods: one move a rod, then one ripple of the carries.
   *
   * The gap after a clear is not padding. A ring that has just been emptied cannot take a write for a
   * few tens of milliseconds - the cells are still recovering from the inhibition - and a gate that
   * fires the instant the next phase starts writes into that hole and the shadow never latches.
   * (soroban/machine.mjs never hit this because its 50 ms read sits in exactly that place.)
   */
  add(way = '+') {
    const gap = () => this.phase(this.o.gap, null);
    const move = way === '-' ? this.IN.stick : this.IN.tick;
    const ripple = way === '-' ? this.IN.bctick : this.IN.ctick;
    const t = this.phase(this.o.tickMs, move);
    this.phase(this.o.ms, this.IN.tock);
    // and the carries only if any rod actually carried - the machine says so itself
    if (t.rods.some((R) => R.cout > 20)) {
      this.phase(this.o.ms, this.IN.clear); gap();
      this.phase(this.o.tickMs, ripple);
      this.phase(this.o.ms, this.IN.tock);
    }
    this.phase(this.o.ms, this.IN.cclear); gap();
  }
  sub() { this.add('-'); }
  /** The loop rod: set it, take one off it, ask whether it is spent. */
  setLoop(v) { this.placeRods(this.rods.map((_, r) => (r === this.digits ? v : null))); }
  tickLoop() { this.put(0, 1); this.add('-'); }
  loopLeft() { return this.look()[this.digits]; }
  /** a x b, as b rounds of adding a - and the rod says when to stop. */
  times(a, b, max = 10) {
    this.setLoop(b);
    this.place(0, b);                       // the digits start at 0 with the count already on its rod
    let rounds = 0;
    for (let i = 0; i < max && this.loopLeft() !== 0; i++) {
      this.put(a); this.add('+');
      this.tickLoop();
      rounds++;
    }
    return rounds;
  }
}
