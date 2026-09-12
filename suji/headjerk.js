// An insect's "hmm?": the head does not sway, it snaps. Each move is a quick
// jerk to a tilt - rolled to one side and turned and dipped at the same time -
// then it holds perfectly still for a moment, and finally it snaps back to
// straight.
//
// A "hmm?" is never quite the same twice: each one picks a pattern (one corner
// then the other, the same side twice going deeper, a look up and then down,
// a tilt and a little shake...) and randomises its angles, pauses and snap
// speed.
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// each pattern returns [roll, yaw, pitch, hold] steps for side s (+1 / -1)
const PATTERNS = [
  // one corner, then the other
  (s) => [[s * rnd(0.55, 0.75), s * rnd(0.2, 0.38), rnd(-0.2, 0.1), rnd(0.3, 0.5)],
          [-s * rnd(0.5, 0.75), -s * rnd(0.15, 0.35), rnd(-0.2, 0.1), rnd(0.3, 0.5)]],
  // the same side twice, the second deeper
  (s) => [[s * rnd(0.25, 0.4), s * rnd(0.1, 0.2), rnd(-0.1, 0.05), rnd(0.2, 0.35)],
          [s * rnd(0.65, 0.85), s * rnd(0.25, 0.4), rnd(-0.28, -0.1), rnd(0.4, 0.6)]],
  // peer up to one side, then down to the other
  (s) => [[s * rnd(0.35, 0.55), s * rnd(0.3, 0.45), rnd(-0.38, -0.25), rnd(0.3, 0.45)],
          [-s * rnd(0.35, 0.55), -s * rnd(0.1, 0.25), rnd(0.15, 0.3), rnd(0.3, 0.45)]],
  // a tilt, held, then a small quick shake back towards the middle
  (s) => [[s * rnd(0.6, 0.8), s * rnd(0.15, 0.3), rnd(-0.15, 0.05), rnd(0.35, 0.55)],
          [s * rnd(0.15, 0.3), s * rnd(-0.1, 0.1), rnd(-0.05, 0.1), rnd(0.1, 0.16)]],
  // turn to look (mostly yaw), then cock the head the other way
  (s) => [[s * rnd(0.1, 0.25), s * rnd(0.4, 0.55), rnd(-0.1, 0.05), rnd(0.25, 0.4)],
          [-s * rnd(0.55, 0.75), s * rnd(0.05, 0.2), rnd(-0.2, 0.05), rnd(0.35, 0.5)]],
];

export class HeadJerk {
  constructor() {
    this.q = [0, 0, 0];            // roll, yaw, pitch offsets (rad)
    this.v = [0, 0, 0];
    this.target = [0, 0, 0];
    this.plan = [];                // steps still to come
    this.hold = 0;
    this.stiff = 34;
    this.lastPattern = -1;
  }
  get active() {
    return this.plan.length > 0 || this.hold > 0 ||
      Math.abs(this.q[0]) + Math.abs(this.q[1]) + Math.abs(this.q[2]) + Math.abs(this.v[0]) > 0.01;
  }

  /**
   * `jerks` 2 = a full "hmm?" from one of the patterns; 1 = a single cock of
   * the head. `scale` shrinks the angles.
   */
  start(jerks = 2, scale = 1) {
    const s = Math.random() < 0.5 ? 1 : -1;
    let steps;
    if (jerks >= 2) {
      let i;
      do { i = Math.floor(Math.random() * PATTERNS.length); } while (i === this.lastPattern);
      this.lastPattern = i;
      steps = PATTERNS[i](s);
    } else {
      steps = [pick(PATTERNS)(s)[0]];
    }
    this.plan = steps.map(([r, y, p, h]) => [r * scale, y * scale, p * scale, h]);
    this.stiff = rnd(28, 42);      // some snaps sharper than others
    this.hold = 0;
  }

  step(dt) {
    if (this.hold > 0) this.hold -= dt;
    if (this.hold <= 0 && this.plan.length) {
      const [r, y, p, h] = this.plan.shift();
      this.target = [r, y, p];
      this.hold = h;
    } else if (this.hold <= 0) {
      this.target = [0, 0, 0];                                   // snap back to straight
    }
    // a stiff, slightly underdamped spring: fast snap, a small overshoot, then still
    const W = this.stiff, Z = 0.62, n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let k = 0; k < n; k++) for (let i = 0; i < 3; i++) {
      const a = W * W * (this.target[i] - this.q[i]) - 2 * Z * W * this.v[i];
      this.v[i] += a * h;
      this.q[i] += this.v[i] * h;
    }
    if (!this.active) { this.q = [0, 0, 0]; this.v = [0, 0, 0]; }
    return this.q;
  }
}
