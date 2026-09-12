// An insect's "hmm?": the head does not sway, it snaps. Each move is a quick
// jerk (~70 ms) to a diagonal tilt - rolled to one side and turned and dipped
// at the same time - then it holds perfectly still for a moment. Two of those
// (one corner, then the other) and it snaps back to straight.
const rnd = (a, b) => a + Math.random() * (b - a);

export class HeadJerk {
  constructor() {
    this.q = [0, 0, 0];            // roll, yaw, pitch offsets (rad)
    this.v = [0, 0, 0];
    this.target = [0, 0, 0];
    this.jerks = 0;                // snaps still to come
    this.hold = 0;
    this.side = 1;
  }
  get active() {
    return this.jerks > 0 || this.hold > 0 ||
      Math.abs(this.q[0]) + Math.abs(this.q[1]) + Math.abs(this.q[2]) + Math.abs(this.v[0]) > 0.01;
  }

  start(jerks = 2) {
    this.jerks = jerks;
    this.hold = 0;
    this.side = Math.random() < 0.5 ? 1 : -1;
  }

  step(dt) {
    if (this.hold > 0) this.hold -= dt;
    if (this.hold <= 0 && this.jerks > 0) {
      this.jerks--;
      this.side = -this.side;                                    // the other corner each time
      const s = this.side;
      this.target = [s * rnd(0.55, 0.75), s * rnd(0.22, 0.38), rnd(-0.25, 0.1)];
      this.hold = rnd(0.38, 0.5);
    } else if (this.hold <= 0) {
      this.target = [0, 0, 0];                                   // snap back to straight
    }
    // a stiff, slightly underdamped spring: fast snap, a small overshoot, then still
    const W = 34, Z = 0.62, n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let k = 0; k < n; k++) for (let i = 0; i < 3; i++) {
      const a = W * W * (this.target[i] - this.q[i]) - 2 * Z * W * this.v[i];
      this.v[i] += a * h;
      this.q[i] += this.v[i] * h;
    }
    if (!this.active) { this.q = [0, 0, 0]; this.v = [0, 0, 0]; }
    return this.q;
  }
}
