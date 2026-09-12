// test04 — ten flies (flygym's NeuroMechFly) on a dropping. Tap one: that fly is driven by the
// real FlyWire brain (the test03 worker) and its neurons light up inside the view.
// The other nine follow simple rules standing in for the same decisions.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LocoMap, LEGS } from '../test03/body3d.js?v=6';

const V = '?v=1';
const SITE = new URL('../', import.meta.url);          // data paths work from / and from /test04/
const at = (p) => new URL(p, SITE).href;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, target, dt, tau) => v + (target - v) * (1 - Math.exp(-dt / tau));
const rnd = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

const N_FLIES = 10;
const TICK = 20;                 // ms of brain time per exchange with the worker
const H = 0.002;                 // s, body step
const WALK_Z = 1.12;             // thorax height above the ground while walking (flygym physics)
const WINGBEAT = 210;            // Hz
const G = 9810;                  // mm/s^2
const FLY_R = 44;                // flights stay within this radius of the dropping
const WALK_R = 34;               // walkers turn back beyond this
const HAND_Z = 9;                // the hand sweeps this high above the ground
const HOLD_Z = 7;                // a caught fly is carried this high

// ------------------------------------------------------------------ the droppings: height fields
// Up to three at a time, each dropped at a free spot of its own: press the button a fourth time and
// the oldest sinks away as the new one falls. Each is a few log-like lumps, piled up or scattered.
// (lump: centre x, y, angle, half-length, radius, height, extra height at the ridge)
const MAX_POOPS = 3;
const SPREAD = 19;               // how far out from the middle a new one can land
const poops = [];                // { x, y, lumps, noff, R, z, body, stain, anim }
function newLumps() {
  const k = rnd(0.5, 1.5);                                 // how much there is, too
  const n = 1 + Math.floor(Math.random() * (k > 1 ? 6 : 4)), pile = Math.random() < 0.6, out = [];
  for (let i = 0; i < n; i++) {
    const r = i === 0 ? 0 : (pile ? rnd(0.8, 2.8) : rnd(2.5, 5.5)) * k, a = rnd(0, Math.PI * 2);
    out.push([Math.cos(a) * r, Math.sin(a) * r, rnd(0, Math.PI * 2), rnd(1.4, 4.6) * k, rnd(2.2, 3.9) * Math.sqrt(k), rnd(1.5, 2.7) * Math.sqrt(k),
      (i === 0 ? rnd(0, 0.8) : pile ? rnd(0.8, 3.2) : rnd(0, 0.6)) * Math.sqrt(k)]);
  }
  return { lumps: out, noff: [rnd(0, 100), rnd(0, 100)],
    R: Math.max(...out.map(([cx, cy, , L, R]) => Math.hypot(cx, cy) + L + R)) };          // its reach from its centre
}
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
}
// height of one dropping at a world point (p.z > 0 while it is still up in the air)
function poopHAt(p, x, y) {
  if (p.z > 0.01) return 0;
  const lx = x - p.x, ly = y - p.y;
  if (Math.abs(lx) > p.R + 1 || Math.abs(ly) > p.R + 1) return 0;
  let h = 0;
  for (const [cx, cy, a, L, R0, Hh, zo] of p.lumps) {
    const dx = lx - cx, dy = ly - cy, c = Math.cos(a), s = Math.sin(a), t = dx * c + dy * s;
    const R = R0 * (1 - 0.13 * (0.5 + 0.5 * Math.cos(t * 1.9 + cx)));          // segmented like a log
    const u = Math.max(0, Math.abs(t) - L), v = -dx * s + dy * c;
    const d2 = (u * u + v * v) / (R * R);
    if (d2 < 1) h = Math.max(h, (Hh * Math.sqrt(1 - d2) + zo * (1 - d2)) * (1 - 0.1 * (0.5 + 0.5 * Math.cos(t * 1.9 + cx))));
  }
  const nx = lx + p.noff[0], ny = ly + p.noff[1];
  if (h > 0) h += (0.4 * (vnoise(nx * 0.9 + 3, ny * 0.9) - 0.5) + 0.14 * (vnoise(nx * 4, ny * 4) - 0.5)) * Math.min(1, h / 0.8)
    - 0.12 * Math.max(0, 1 - Math.abs(Math.sin(nx * 2.3 + vnoise(nx, ny) * 4)) * 8) * Math.min(1, h / 1.5);   // cracks
  return Math.max(0, h + p.z);
}
function poopH(x, y) { let h = 0; for (const p of poops) { const v = poopHAt(p, x, y); if (v > h) h = v; } return h; }
const groundZ = (x, y) => poopH(x, y);
const onPoop = (x, y) => poopH(x, y) > 0.25;
// the one that smells best from a given spot: bigger and closer wins
function bestPoop(x, y) {
  let best = null, bs = -1;
  for (const p of poops) {
    if (p.z > 0.01 || (p.anim && p.anim.phase === 'sink')) continue;
    const s = (p.R + 5) / (Math.hypot(p.x - x, p.y - y) + 9);
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}
// pick one at random, the best-smelling ones more often
function weightedPoop(x, y) {
  const w = [];
  let tot = 0;
  for (const p of poops) {
    const v = (p.z > 0.01 || (p.anim && p.anim.phase === 'sink')) ? 0 : (p.R + 5) / (Math.hypot(p.x - x, p.y - y) + 9);
    w.push(v); tot += v;
  }
  if (tot <= 0) return null;
  let r = Math.random() * tot;
  for (let i = 0; i < poops.length; i++) { r -= w[i]; if (r <= 0) return poops[i]; }
  return poops[poops.length - 1];
}

// ------------------------------------------------------------------ one fly
let J = null, BIN = null, LO = null, loco = null;
let brainFly = null, selected = null;
const flies = [];
const world = { t: 0, hand: null };

class Fly {
  constructor(id) {
    this.id = id;
    this.body = new FlyBody(J, BIN, { lo: LO, ghosts: 5 });     // one skinned low-poly mesh per fly
    this.cpg = new CPG(J);
    // every fly different: size, colour type (tan / black / metallic green), and a longer/plumper or slimmer abdomen
    const kind = Math.random() < 0.2 ? 'green' : Math.random() < 0.25 ? 'black' : 'tan';
    this.s = rnd(0.78, 1.22) * (kind === 'tan' ? 1 : 1.1); this.walkZ = WALK_Z * this.s;
    this.body.root.scale.setScalar(this.s);
    const TINTS = [[1.05, 0.95, 0.8], [0.62, 0.54, 0.46], [1.1, 0.8, 0.64], [0.84, 0.82, 0.8], [1.14, 1.03, 0.7], [0.95, 0.9, 0.86]];
    const j = () => rnd(0.92, 1.08);
    let tint, k = rnd(0.82, 1.12);
    if (kind === 'green') { tint = [0.07 * j(), 0.2 * j(), 0.085 * j()]; k = rnd(0.75, 1.05); }     // greenbottle-like: dark metallic green
    else if (kind === 'black') { tint = [0.2, 0.2, 0.21].map((v) => v * j()); k = rnd(0.8, 1.3); } // housefly-like
    else tint = TINTS[Math.floor(Math.random() * TINTS.length)].map((v) => v * j());
    this.kind = kind;
    // eye colour: most are the usual brick red, a good few much darker, the odd one orange
    const e = Math.random();                     // this page has no seeded rng: nothing to keep in step
    const eye = e < 0.52 ? [rnd(0.9, 1.12), rnd(0.9, 1.12), rnd(0.9, 1.12)]
      : e < 0.82 ? [rnd(0.45, 0.64), rnd(0.68, 0.92), rnd(0.78, 1.02)]
        : e < 0.94 ? [rnd(0.18, 0.34), rnd(0.55, 0.8), rnd(0.8, 1.05)]
          : [rnd(1.08, 1.28), rnd(1.4, 1.9), rnd(0.95, 1.2)];
    this.body.skin.material = flyMaterial(tint.map((v) => v * k), kind === 'green', eye);
    const girth = rnd(0.88, 1.3);
    this.body.byName.c_abdomen12.obj.scale.set(rnd(0.9, 1.18), girth, girth * rnd(0.92, 1.08));
    Object.assign(this, {
      x: 0, y: 0, z: this.walkZ, yaw: 0, pitch: 0, roll: 0, vz: 0,
      state: 'walk', stateT: 0, pauseT: 0, om: 0, dL: 0, dR: 0, speed: 0,
      prob: 0, groomPh: rnd(0, 6), groomSlow: rnd(0, 6), touchL: 0, touchR: 0,
      wingOpen: 0, flap: 0, wingPh: rnd(0, 6), w: { groom: 0, tuck: 0, reach: 0, jump: 0, rub: 0, rubH: 0 },
      flight: null, lastFlightEnd: -rnd(0, 20), startle: null, why: '',
      rule: { feedT: 0, restT: rnd(0, 3), groomT: 0 },
      drive: { MN9: 0, groomL: 0, groomR: 0, GFL: 0, GFR: 0, escL: 0, escR: 0, DNa02L: 0, DNa02R: 0, MDN: 0 },
      IK: {}, ground: { z: this.walkZ, pitch: 0, roll: 0 },
    });
    for (const [i, leg] of LEGS.entries()) this.body.setLeg(leg, this.cpg.neutral(i));
  }
  get airborne() { return this.state === 'takeoff' || this.state === 'flight' || this.state === 'landing' || this.state === 'held'; }
  setState(s) { if (this.state !== s) { this.state = s; this.stateT = 0; } }
  mouth() { const c = Math.cos(this.yaw), s = Math.sin(this.yaw), r = 0.6 * this.s; return [this.x + c * r, this.y + s * r]; }

  // --- sensory input for the brain (only the brain fly)
  sense() {
    const inp = { sugar: 0, bitter: 0, water: 0, headL: 0, headR: 0, loomL: 0, loomR: 0, smell: 0 };
    const [mx, my] = this.mouth();
    if (!this.airborne && onPoop(mx, my)) { inp.sugar = 110; inp.water = 70; }   // the dropping's taste, via the model's taste inputs
    inp.headL = this.touchL > 0 ? 100 : 0; inp.headR = this.touchR > 0 ? 100 : 0;
    const hx = this.x + Math.cos(this.yaw) * 0.55, hy = this.y + Math.sin(this.yaw) * 0.55, hz = this.z;
    const looms = flies.filter((f) => f !== this && f.airborne).map((f) => ({ key: f, x: f.x, y: f.y, z: f.z, R: 1.4 }));
    if (world.hand) looms.push({ key: 'hand', ...world.hand });
    this.prevA ??= new Map();
    for (const o of looms) {
      const dx = o.x - hx, dy = o.y - hy, dz = o.z - hz, d = Math.max(0.5, Math.hypot(dx, dy, dz));
      const a = 2 * Math.atan(o.R / d), pa = this.prevA.get(o.key);
      this.prevA.set(o.key, a);
      if (pa === undefined) continue;
      const hz2 = clamp((a - pa) / (TICK / 1000) * 70, 0, 120);
      const side = -Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dy;
      if (side > 0) inp.loomL += hz2; else inp.loomR += hz2;
    }
    inp.loomL = clamp(inp.loomL, 0, 120); inp.loomR = clamp(inp.loomR, 0, 120);
    return inp;
  }

  // --- the brain's outputs decide (same mapping and thresholds as test03)
  decideBrain(out) {
    const d = this.drive;
    for (const k in d) d[k] = d[k] + ((out[k] || 0) - d[k]) * (k.startsWith('GF') ? 1 : 0.3);
    if (this.airborne || this.state === 'land') return;
    const groom = Math.max(d.groomL, d.groomR);
    if ((out.GFL || 0) + (out.GFR || 0) > 0) {
      const awayRight = d.escL >= d.escR;
      this.takeoff('escape', this.yaw + (awayRight ? -1.1 : 1.1), 'brain');
    } else if (groom > 40 || (this.state === 'groom' && (groom > 22 || this.stateT < 0.6))) this.setState('groom');
    else if (d.MN9 > 15 || (this.state === 'feed' && d.MN9 > 8)) this.setState('feed');
    else if (this.state === 'groom' || this.state === 'feed') this.setState('walk');
  }
  // --- the other nine: rules standing in for the same decisions
  decideRule(dt) {
    const r = this.rule, d = this.drive;
    r.feedT -= dt; r.restT -= dt; r.groomT -= dt;
    if (this.airborne || this.state === 'land') return;
    if (this.startle && world.t >= this.startle.at) { this.takeoff('escape', this.startle.dir, 'rule'); this.startle = null; return; }
    const [mx, my] = this.mouth();
    if (this.state === 'feed') {
      if (r.feedT <= 0 || !onPoop(mx, my)) { r.restT = rnd(1.5, 5); if (Math.random() < 0.85) this.rub(); else this.setState('walk'); }
    }
    else if (this.state === 'groom') { if (r.groomT <= 0) this.setState('walk'); }
    else if (this.state === 'rub') { /* ends by itself (step) */ }
    else {
      if ((this.touchL > 0 || this.touchR > 0) && Math.random() < 0.02) { if (Math.random() < 0.75) this.rub(); else { this.setState('groom'); r.groomT = rnd(1.2, 3.5); } }
      else if (Math.random() < dt / 45) { this.setState('groom'); r.groomT = rnd(1.5, 4); }
      else if (Math.random() < dt / 4.5 && !(onPoop(mx, my) && r.restT <= 0)) this.rub();     // (eating comes first)
      else if (onPoop(mx, my) && r.restT <= 0) { this.setState('feed'); r.feedT = rnd(3, 12); }
    }
    d.MN9 = this.state === 'feed' ? 45 : 0;
    d.groomL = d.groomR = this.state === 'groom' ? 60 : 0;
  }

  // the fly's "hand washing": front legs (sometimes the hind legs) rubbed against each other
  rub() { this.setState('rub'); this.rubT = rnd(2, 5.5); this.rubHind = Math.random() < 0.2; }

  takeoff(mode, dir, by) {
    this.flight = {
      mode, by, dir, launched: false, t: 0, phase: 'cruise', course: dir, u: 0, saccade: false, segT: 0.2,
      U: mode === 'escape' ? rnd(240, 300) : rnd(140, 210), h: mode === 'escape' ? rnd(10, 22) : rnd(5, 16),
      T: mode === 'escape' ? rnd(1.0, 2.2) : rnd(1.0, 3.0), wp: null, goal: null, final: false, reach: false,
    };
    this.vz = 0;
    this.setState('takeoff');
  }

  // --- 1 ms of body
  step(dt) {
    this.stateT += dt;
    this.touchL = Math.max(0, this.touchL - dt); this.touchR = Math.max(0, this.touchR - dt);
    if (this.state === 'held') this.holdStep(dt); else if (this.airborne) this.flightStep(dt); else this.groundStep(dt);
    const W = this.w, F = this.flight;
    const tuck = (this.state === 'flight' || (this.state === 'takeoff' && F.launched)) && !(F && F.reach);
    W.groom = approach(W.groom, this.state === 'groom' ? 1 : 0, dt, 0.12);
    W.rub = approach(W.rub || 0, this.state === 'rub' && !this.rubHind ? 1 : 0, dt, 0.12);
    W.rubH = approach(W.rubH || 0, this.state === 'rub' && this.rubHind ? 1 : 0, dt, 0.14);
    if (this.state === 'rub') { this.rubPh = (this.rubPh || 0) + dt * TAU * 4.5; if ((this.rubT -= dt) <= 0) this.setState('walk'); }
    // the brain fly rubs too when it stands idle (body default)
    else if (this === brainFly && this.state === 'walk' && this.pauseT > 0 && Math.random() < dt / 2) this.rub();
    W.tuck = approach(W.tuck, tuck ? 1 : 0, dt, 0.04);
    W.reach = approach(W.reach, (F && F.reach) || (this.state === 'land' && this.stateT < 0.1) ? 1 : 0, dt, 0.05);
    W.jump = approach(W.jump, this.state === 'takeoff' && F.pushing ? 1 : 0, dt, 0.003);
    this.prob = approach(this.prob, this.state === 'feed' ? clamp(this.drive.MN9 / 55, 0.35, 1) : 0, dt, 0.08);
    if (this.state === 'groom') { this.groomPh += dt * TAU * 5.5; this.groomSlow += dt * TAU * 0.35; }
    const flapping = this.state === 'flight' || this.state === 'landing' || (this.state === 'takeoff' && F.flapOn) || (this.state === 'held' && this.held.buzz);
    this.flap = approach(this.flap, flapping ? 1 : 0, dt, flapping ? 0.006 : 0.02);
    if (this.flap > 0.01) this.wingPh += dt * TAU * WINGBEAT;
    const open = this.state === 'takeoff' ? F.wingsUp : this.state === 'held' ? this.held.buzz : this.airborne || (this.state === 'land' && this.stateT < 0.05);
    this.wingOpen = approach(this.wingOpen, open ? 1 : 0, dt, open ? (F && F.mode === 'escape' ? 0.004 : 0.03) : 0.06);
    // spontaneous take-off (body default, not the brain)
    if (this.state === 'walk' && !this.leaving && world.t - this.lastFlightEnd > 5 && Math.random() < dt / 28) this.takeoff('voluntary', this.yaw + rnd(-0.4, 0.4), 'body');
  }

  // --- caught between the fingers: legs kick, wings buzz now and then
  hold() {
    this.setState('held'); this.flight = null; this.startle = null;
    this.held = { tx: this.x, ty: this.y, tz: this.z + 4, kickT: 0, dL: 1, dR: 1, buzz: false, buzzT: rnd(0.2, 0.6), t: 0 };
  }
  holdStep(dt) {
    const h = this.held;
    h.t += dt;
    this.x = approach(this.x, h.tx, dt, 0.035); this.y = approach(this.y, h.ty, dt, 0.035); this.z = approach(this.z, h.tz, dt, 0.05);
    this.pitch = approach(this.pitch, 0.35 + 0.12 * Math.sin(h.t * 6.1), dt, 0.08);
    this.roll = approach(this.roll, 0.3 * Math.sin(h.t * 4.3), dt, 0.08);
    if ((h.kickT -= dt) <= 0) { h.kickT = rnd(0.15, 0.5); h.dL = rnd(0.7, 1.4) * (Math.random() < 0.25 ? -1 : 1); h.dR = rnd(0.7, 1.4) * (Math.random() < 0.25 ? -1 : 1); }
    if ((h.buzzT -= dt) <= 0) { h.buzz = !h.buzz; h.buzzT = h.buzz ? rnd(0.25, 1.0) : rnd(0.3, 1.2); }
    this.cpg.step(dt * 1.7, h.dL, h.dR);                    // kicking faster than walking
    this.speed = 0;
  }
  release(vx, vy) {
    const dir = Math.hypot(vx, vy) > 30 ? Math.atan2(vy, vx) : rnd(-Math.PI, Math.PI);
    this.held = null;
    this.takeoff('escape', dir, 'body');
    Object.assign(this.flight, { launched: true, u: clamp(Math.hypot(vx, vy), 120, 260), T: rnd(0.6, 1.6) });
    this.state = 'flight'; this.stateT = 0; this.vz = 80; this.wingOpen = 1; this.flap = 1; this.yaw = dir;
  }

  groundStep(dt) {
    let base = 0;
    if (this.state === 'walk') {
      if (this.pauseT > 0) this.pauseT -= dt; else if (Math.random() < dt / 5) this.pauseT = rnd(0.4, 2.2);
      base = this.pauseT > 0 ? 0 : 1;
      if (this.drive.MDN > 20) base = -0.8;
    }
    // exploration + attraction to the dropping + staying near it (body) + DNa02 asymmetry (brain): + = turn right
    this.om += (-this.om / 0.6) * dt + (Math.random() - 0.5) * 2.4 * Math.sqrt(dt);
    if ((this.aimT = (this.aimT || 0) - dt) <= 0) { this.aimT = 0.5; this.aim = bestPoop(this.x, this.y); }
    const A = this.aim && poops.includes(this.aim) ? this.aim : null;
    const da = A ? Math.hypot(this.x - A.x, this.y - A.y) : 0;
    const toA = A ? wrap(Math.atan2(A.y - this.y, A.x - this.x) - this.yaw) : 0;
    const pull = A && da > A.R * 0.7 ? -clamp(toA, -1, 1) * Math.min(0.6, 0.012 * da) : 0;
    const dist = Math.hypot(this.x, this.y), toC = wrap(Math.atan2(-this.y, -this.x) - this.yaw);
    const back = dist > WALK_R ? -Math.sign(toC) * (dist - WALK_R) * 0.1 : 0;
    // keep out of the neighbours' way (re-checked every 4 ms)
    if ((this.avoidT = (this.avoidT || 0) - dt) <= 0) {
      this.avoidT = 0.004; this.avoid = 0; this.crowded = false;
      for (const o of flies) {
        if (o === this || o.airborne) continue;
        const dx = o.x - this.x, dy = o.y - this.y;
        if (Math.abs(dx) > 3.2 || Math.abs(dy) > 3.2) continue;
        const d = Math.hypot(dx, dy); if (d > 3.2) continue;
        const b = wrap(Math.atan2(dy, dx) - this.yaw);
        if (Math.abs(b) < 1.2) { this.avoid += Math.sign(b) * (3.2 - d) * 0.25; if (d < 2.2) this.crowded = true; }
      }
    }
    const avoid = this.avoid;
    if (this.crowded && base > 0) base *= 0.4;
    const dna02 = clamp((this.drive.DNa02R - this.drive.DNa02L) * 0.006, -0.5, 0.5);
    const turn = clamp(this.om + pull + back + avoid + dna02, -0.8, 0.8);
    this.dL = base * (1 + turn); this.dR = base * (1 - turn);
    if (this.state === 'land') { this.dL = this.dR = 0; if (this.stateT > 0.35) this.setState('walk'); }
    this.cpg.step(dt, this.dL, this.dR);
    const m = this.cpg.mag, sL = (m[0] + m[1] + m[2]) / 3 * Math.sign(this.cpg.freq[0]), sR = (m[3] + m[4] + m[5]) / 3 * Math.sign(this.cpg.freq[3]);
    const v = loco.at(sL, sR), c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let vx = v.vx * this.s;
    if (this.state === 'land' && this.flight) vx += this.flight.u * Math.exp(-this.stateT / 0.03);
    this.x += (c * vx - s * v.vy * this.s) * dt; this.y += (s * vx + c * v.vy * this.s) * dt; this.yaw = wrap(this.yaw + v.wz * dt);
    this.speed = Math.abs(vx);
  }

  pickWaypoint(minDist) {
    for (let k = 0; k < 30; k++) {
      const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * (FLY_R - 10);
      const p = { x: Math.cos(a) * r, y: Math.sin(a) * r };
      if (Math.hypot(p.x - this.x, p.y - this.y) > minDist) return p;
    }
    return { x: 0, y: 0 };
  }
  landingSpot() {
    const t = weightedPoop(this.x, this.y);
    for (let k = 0; k < 40; k++) {
      let p;
      if (t) {
        const onIt = Math.random() < 0.7, a = rnd(0, TAU), r = onIt ? rnd(0, t.R) : rnd(t.R, t.R + 11);
        p = { x: t.x + Math.cos(a) * r, y: t.y + Math.sin(a) * r };
        if (onIt && !onPoop(p.x, p.y)) continue;
      } else {
        const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * WALK_R * 0.8;
        p = { x: Math.cos(a) * r, y: Math.sin(a) * r };
      }
      if (flies.every((o) => o === this || o.airborne || Math.hypot(o.x - p.x, o.y - p.y) > 3)) return p;
    }
    return { x: rnd(-15, 15), y: rnd(-15, 15) };
  }
  flightStep(dt) {
    const F = this.flight;
    F.t += dt;
    if (this.state === 'takeoff') {
      const esc = F.mode === 'escape';
      const tPush = esc ? 0.003 : 0.14, tLaunch = esc ? 0.008 : 0.155, tFlap = esc ? 0.012 : 0.1;
      F.pushing = F.t > tPush && F.t < tLaunch + 0.004; F.wingsUp = esc ? F.t > 0.006 : true; F.flapOn = F.t > tFlap;
      if (!F.launched && F.t >= tLaunch) {
        F.launched = true;
        const v0 = esc ? 400 : 190, el = esc ? 0.85 : 1.15;
        F.u = v0 * Math.cos(el); this.vz = v0 * Math.sin(el); F.course = F.dir;
      }
      if (F.launched) {
        this.vz -= G * (1 - this.flap * 0.95) * dt;
        this.x += Math.cos(F.course) * F.u * dt; this.y += Math.sin(F.course) * F.u * dt; this.z += this.vz * dt;
        this.yaw = wrap(this.yaw + wrap(F.course - this.yaw) * (1 - Math.exp(-dt / 0.02)));
        this.pitch = approach(this.pitch, 0.7, dt, 0.03);
        if (F.t > tLaunch + 0.03) { this.setState('flight'); F.t = 0; }
      }
      this.z = Math.max(this.z, groundZ(this.x, this.y) + this.walkZ);
      return;
    }
    if (F.phase === 'leave') F.h = 22;
    if (F.phase === 'cruise' && F.t > F.T) { F.phase = 'approach'; F.goal = this.landingSpot(); F.wp = F.goal; F.saccade = true; }
    const look = Math.min(F.u * 0.06, 18), px = this.x + Math.cos(F.course) * look, py = this.y + Math.sin(F.course) * look;
    const leaving = Math.hypot(px, py) > FLY_R && F.phase !== 'leave';
    if (F.phase === 'cruise') {
      F.segT -= dt;
      if (!F.saccade && (F.segT <= 0 || leaving)) { F.wp = this.pickWaypoint(20); F.saccade = true; F.segT = rnd(0.12, 0.4); F.h = clamp(F.h + rnd(-6, 6), 4, 24); }
    }
    const tgt = F.wp || { x: 0, y: 0 }, d = Math.hypot(tgt.x - this.x, tgt.y - this.y), e = wrap(Math.atan2(tgt.y - this.y, tgt.x - this.x) - F.course);
    if (F.phase === 'approach' && d < 6) F.final = true;
    let rate = F.saccade ? clamp(e * 30, -32, 32) : F.phase === 'approach' ? clamp(e * 8, -8, 8) : rnd(-0.6, 0.6);
    if (F.saccade && (Math.abs(e) < 0.1 || d < 10)) F.saccade = false;
    if (F.final) rate = 0;
    F.course = wrap(F.course + rate * dt);
    const gz = groundZ(this.x, this.y) + this.walkZ;
    let U = F.U, h = F.h;
    if (F.phase === 'approach') {
      const goalZ = groundZ(tgt.x, tgt.y) + this.walkZ, high = this.z - goalZ;
      U = F.final ? 22 : clamp(d * 4, 25, F.U) * clamp(d / (1.5 * high + 1), 0.25, 1);
      h = F.final ? goalZ - 0.6 : Math.max(goalZ, goalZ + d * 0.3);
      F.reach = d < 12 && high < 8;
      if (F.t > F.T + 4) h = gz - 0.6;
    }
    F.u = approach(F.u, U, dt, 0.1);
    this.vz = approach(this.vz, clamp((h - this.z) * 6, -160, 220), dt, 0.06);
    this.x += Math.cos(F.course) * F.u * dt; this.y += Math.sin(F.course) * F.u * dt; this.z += this.vz * dt;
    this.speed = Math.hypot(F.u, this.vz);
    this.yaw = wrap(this.yaw + wrap(F.course - this.yaw) * (1 - Math.exp(-dt / 0.015)));
    this.roll = approach(this.roll, clamp(Math.atan(F.u * -rate / G), -1.05, 1.05), dt, 0.02);
    const flare = F.phase === 'approach' && d < 8 ? 0.35 * (1 - d / 8) : 0;
    this.pitch = approach(this.pitch, 0.78 - 0.42 * clamp(F.u / 350, 0, 1) + flare, dt, 0.05);
    if (F.phase === 'approach' && this.state === 'flight' && d < 18) this.setState('landing');
    const gzNow = groundZ(this.x, this.y) + this.walkZ;
    if (this.z <= gzNow && F.phase === 'approach' && this.vz <= 0) {
      this.z = gzNow; this.roll = 0; F.reach = false; this.lastFlightEnd = world.t; this.setState('land');
    } else if (this.z < gzNow) this.z = gzNow;          // can't fly through the dropping
  }

  // --- pose, once per frame
  // full = false: keep the legs as they are this frame (many flies), only move the body and wings
  pose(simDt, blur, full = true) {
    const body = this.body, cpg = this.cpg, a = this._a ??= new Array(7), W = this.w;
    this.legDt = (this.legDt || 0) + simDt;
    if (full) {
    for (const [i, leg] of LEGS.entries()) {
      cpg.angles(i, a);
      const P = FIXED_POSES[leg], mix = (pose, w) => { if (w > 0.001) for (let d = 0; d < 7; d++) a[d] += (pose[d] - a[d]) * Math.min(1, w); };
      if (leg[1] === 'm') mix(P.jump, W.jump);
      mix(P.tuck, W.tuck); mix(P.reach, W.reach);
      if (leg[1] === 'f' && W.groom > 0.001) {
        const sgn = leg[0] === 'l' ? 1 : -1, ph = this.groomPh + (sgn > 0 ? 0 : Math.PI * 0.9), m = clamp(0.2 + 0.9 * Math.sin(this.groomSlow), 0, 1);
        const tgt = [lerp(0.62 + 0.1 * Math.sin(ph), 0.86 + 0.05 * Math.cos(ph), m), sgn * lerp(0.28 + 0.1 * Math.cos(ph), 0.04 + 0.05 * Math.sin(ph), m),
          lerp(0.16 + 0.22 * Math.sin(ph), -0.24 + 0.05 * Math.cos(ph), m)];
        const sol = body.ik(leg, tgt, this.IK[leg] || P.groom, cpg.neutral(i), 3, 0.02);
        this.IK[leg] = sol; mix(sol, W.groom);
      } else this.IK[leg] = null;
      const rw = leg[1] === 'f' ? W.rub : leg[1] === 'h' ? W.rubH : 0;
      if (rw > 0.001) {
        // the two tarsi cross and slide over each other, alternating, in front of the head (or behind the abdomen)
        const sgn = leg[0] === 'l' ? 1 : -1, ph = (this.rubPh || 0) + (sgn > 0 ? 0 : Math.PI);
        const tgt = leg[1] === 'f'
          ? [0.74 + 0.06 * Math.sin(ph), sgn * (0.015 + 0.07 * Math.sin(ph)), -0.46 + 0.05 * Math.cos(ph)]
          : [-2.05 + 0.07 * Math.sin(ph), sgn * (0.02 + 0.08 * Math.sin(ph)), -0.72 + 0.06 * Math.cos(ph)];
        this.IKr ??= {};
        const sol = body.ik(leg, tgt, this.IKr[leg] || P.rub, cpg.neutral(i), 3, 0.02);
        this.IKr[leg] = sol; mix(sol, rw);
      } else if (this.IKr) this.IKr[leg] = null;
      body.setLeg(leg, a);
    }
    const jset = (n, v) => { const j = body.joints[n]; if (j) j.q = v; };
    jset('c_head-c_rostrum-pitch', -1.25 * this.prob);
    jset('c_rostrum-c_haustellum-pitch', -1.6 * this.prob);
    jset('c_thorax-c_head-pitch', 0.18 * this.prob + (this.state === 'groom' ? 0.12 * Math.sin(this.groomPh * 0.5) : 0));
    jset('c_thorax-c_abdomen12-pitch', -0.12 * this.w.tuck);
    for (const s of ['l', 'r']) jset(`c_thorax-${s}_haltere-pitch`, this.flap * 0.9 * Math.sin(this.wingPh + Math.PI));
    body.update();
    }
    // wings
    const A = 1.3, phi0 = -0.12, alpha = 0.7, beta = 0.8, q = this._q ??= new THREE.Quaternion(), qg = this._qg ??= new THREE.Quaternion();
    const stroke = (ph) => [lerp(phi0 - A, phi0 + A * Math.sin(ph), this.flap), 0.12 * Math.sin(2 * ph) * this.flap,
      lerp(Math.PI / 2, Math.PI / 2 - (Math.PI / 2 - alpha) * Math.tanh(2.5 * Math.cos(ph)) / Math.tanh(2.5), this.flap)];
    const ghost = blur > 0.02 && this.wingOpen > 0.8 && this.flap > 0.5;
    body.wingMat.opacity = 1 - 0.62 * (ghost ? blur : 0); body.ghostMat.opacity = 0.075 * blur;
    for (const w of body.wings) {
      body.wingQuat(w, ...stroke(this.wingPh), beta, q);
      w.obj.quaternion.copy(w.wing.qRest).slerp(q, this.wingOpen);
      w.wing.ghosts.forEach((g, k) => {
        g.visible = ghost; if (!ghost) return;
        body.wingQuat(w, ...stroke(this.wingPh + (k + 0.5) / w.wing.ghosts.length * TAU), beta, qg);
        g.quaternion.copy(w.wing.qRest).slerp(qg, this.wingOpen);
      });
    }
    this.place(simDt, full);
  }
  // stance feet on the (uneven) ground: fit height and tilt to the weighted stance tips
  place(simDt, full = true) {
    const body = this.body, g = this.ground;
    if (!this.airborne || (this.state === 'takeoff' && !this.flight.launched)) {
      if (!full) { g.z = groundZ(this.x, this.y) + (this.gOff ?? this.walkZ); }        // follow the terrain until the next full fit
      else {
      const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0], c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      for (const [i, leg] of LEGS.entries()) {
        let w = this.cpg.mag[i] > 0.15 ? this.cpg.stance(i) : 1;
        if (leg[1] === 'f') w *= 1 - Math.max(this.w.groom, this.w.rub || 0);
        if (leg[1] === 'h') w *= 1 - (this.w.rubH || 0);
        w *= 1 - Math.max(this.w.tuck, this.w.jump * (leg[1] === 'm' ? 0 : 1));
        if (w < 0.02) continue;
        const p = body.legTip(leg), sc = this.s; p[0] *= sc; p[1] *= sc; p[2] *= sc;
        const hz = groundZ(this.x + c * p[0] - s * p[1], this.y + s * p[0] + c * p[1]);
        const row = [1, p[0], p[1]];     // z_world = Z + z + pitch*x + roll*y
        for (let a = 0; a < 3; a++) { r[a] += w * row[a] * (hz - p[2]); for (let b = 0; b < 3; b++) S[a][b] += w * row[a] * row[b]; }
      }
      S[1][1] += 0.15; S[2][2] += 0.15; S[0][0] += 1e-6;
      const sol = solve3(S, r), k = 1 - Math.exp(-Math.max(this.legDt, 1e-5) / 0.03), gc = groundZ(this.x, this.y);
      g.z += (clamp(sol[0], gc + 0.5, gc + 3) - g.z) * k;
      g.pitch += (clamp(sol[1], -0.7, 0.7) - g.pitch) * k; g.roll += (clamp(sol[2], -0.7, 0.7) - g.roll) * k;
      this.gOff = g.z - gc;
      }
      const k2 = 1 - Math.exp(-Math.max(simDt, 1e-5) / (this.state === 'land' ? 0.025 : 0.01));
      this.z += (g.z - this.z) * k2; this.pitch += (g.pitch - this.pitch) * k2; this.roll += (g.roll - this.roll) * k2;
    }
    const root = body.root;
    root.position.set(this.x, this.y, this.z);
    _qa.setFromAxisAngle(AZ, this.yaw); _qb.setFromAxisAngle(AY, -this.pitch); _qc.setFromAxisAngle(AX, this.roll);
    root.quaternion.copy(_qa).multiply(_qb).multiply(_qc);
    if (full) this.legDt = 0;
  }
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
function solve3(A, b) {
  const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g) || 1e-12;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}

// the body colour of one fly: the tint applies everywhere except the (red) compound eyes;
// greenbottle-like flies get a metallic, slightly iridescent sheen from a soft sky reflection
let ENV = null;
function skyEnv() {
  if (ENV) return ENV;
  const es = new THREE.Scene(), g = new THREE.SphereGeometry(10, 48, 24), p = g.attributes.position, c = [];
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i) / 10, t = (z + 1) / 2;                          // z is up in this world
    c.push(lerp(0.42, 0.92, t), lerp(0.37, 0.95, t), lerp(0.3, 1.0, t));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  es.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunSpot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  sunSpot.position.set(-3.2, -4.8, 7.6); es.add(sunSpot);
  ENV = new THREE.PMREMGenerator(renderer).fromScene(es, 0.02).texture;
  return ENV;
}
function flyMaterial(tint, metallic, eye) {
  const m = metallic
    ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85, clearcoat: 0.35, clearcoatRoughness: 0.35,
        iridescence: 0.3, iridescenceIOR: 1.4, iridescenceThicknessRange: [300, 500], envMap: skyEnv(), envMapIntensity: 0.9 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0 });
  const uTint = { value: new THREE.Color(...tint) };
  const uEye = { value: new THREE.Color(...(eye || [1, 1, 1])) };     // the eyes get their own multiplier
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTint = uTint; sh.uniforms.uEye = uEye;
    sh.fragmentShader = 'uniform vec3 uTint;\nuniform vec3 uEye;\n' + sh.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb *= mix(uTint, uEye, step(6.0 * vColor.g + 0.01, vColor.r));   // the eyes keep out of the body tint');
  };
  m.customProgramCacheKey = () => (metallic ? 'fly-metal' : 'fly');
  return m;
}

// fixed leg poses in the thorax frame, solved once by IK from the neutral stance (same skeleton for all)
const FIXED_POSES = {};
function solveFixedPoses(body, cpg) {
  const T = {
    tuck: { f: [0.5, 0.28, -0.62], m: [-0.5, 0.42, -0.9], h: [-1.45, 0.3, -0.82] },     // legs folded in flight
    reach: { f: [1.1, 0.62, -1.0], m: [0.05, 1.15, -1.1], h: [-1.35, 0.95, -1.1] },     // reaching for the landing
    jump: { m: [-0.62, 0.7, -1.78] },                                                    // middle legs pushing off
    groom: { f: [0.62, 0.28, 0.16] },                                                    // start of a head sweep
    rub: { f: [0.74, 0.02, -0.46], h: [-2.05, 0.03, -0.72] },                            // legs rubbed together
  };
  for (const [i, leg] of LEGS.entries()) {
    const sgn = leg[0] === 'l' ? 1 : -1, n = cpg.neutral(i);
    FIXED_POSES[leg] = {};
    for (const [name, byPos] of Object.entries(T)) {
      const t = byPos[leg[1]];
      FIXED_POSES[leg][name] = t ? body.ik(leg, [t[0], sgn * t[1], t[2]], n, n, 60, 0.02) : n;
    }
  }
}

// ------------------------------------------------------------------ interactions between flies
function crowd(dt) {
  for (let i = 0; i < flies.length; i++) for (let j = i + 1; j < flies.length; j++) {
    const a = flies[i], b = flies[j];
    if (a.airborne || b.airborne) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) > 2.2 || Math.abs(dy) > 2.2) continue;
    const d = Math.hypot(dx, dy) || 1e-3;
    if (d < 2.0) { const p = (2.0 - d) / 2 * Math.min(1, dt * 60); a.x -= dx / d * p; a.y -= dy / d * p; b.x += dx / d * p; b.y += dy / d * p; }
    // a neighbour's body brushing the head stimulates the head bristles on that side
    for (const [f, o] of [[a, b], [b, a]]) {
      const hx = f.x + Math.cos(f.yaw) * 0.6, hy = f.y + Math.sin(f.yaw) * 0.6;
      if (Math.hypot(o.x - hx, o.y - hy) < 1.3) {
        const side = -Math.sin(f.yaw) * (o.x - f.x) + Math.cos(f.yaw) * (o.y - f.y);
        if (side > 0) f.touchL = 0.3; else f.touchR = 0.3;
      }
    }
  }
  // rule flies startle when something flies right at them (the brain fly decides with its own LC4/GF)
  for (const f of flies) {
    if (f === brainFly || f.airborne || f.startle) continue;
    for (const o of flies) {
      if (o === f || !o.airborne || !o.flight || !o.flight.launched) continue;
      const d = Math.hypot(o.x - f.x, o.y - f.y, o.z - f.z);
      if (d < 3.5 && Math.random() < dt * 3) f.startle = { at: world.t + rnd(0.005, 0.05), dir: Math.atan2(f.y - o.y, f.x - o.x) };
    }
  }
  const h = world.hand;
  if (h) for (const f of flies) {
    if (f === brainFly || f.airborne || f.startle) continue;
    const dx = f.x - h.x, dy = f.y - h.y, dz = f.z - h.z, d = Math.hypot(dx, dy, dz) || 1;
    const closing = (h.vx * dx + h.vy * dy + h.vz * dz) / d;               // mm/s toward the fly
    const rate = (d < 18 && closing > 25 ? 30 : 0) + (d < 10 ? 10 : 0);
    if (rate && Math.random() < dt * rate) f.startle = { at: world.t + rnd(0.0, 0.04), dir: Math.atan2(dy, dx) + rnd(-0.5, 0.5) };
  }
}

// ------------------------------------------------------------------ three.js scene
const view = $('view'), stage = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9cdc6); scene.fog = new THREE.Fog(0xc9cdc6, 180, 520);
const camera = new THREE.PerspectiveCamera(36, 1.6, 0.3, 1500);
camera.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x8a8170, 1.3));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.5);
sun.position.set(-40, -60, 110); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 10, far: 300 });
scene.add(sun, sun.target);

function groundTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#b9b1a1'; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 26000; i++) {
    const v = 120 + Math.random() * 90, r = Math.random() < 0.96 ? 1 + Math.random() * 2.5 : 3 + Math.random() * 6;
    g.fillStyle = `rgba(${v + 10},${v},${v - 18},${0.12 + Math.random() * 0.3})`;
    g.beginPath(); g.arc(Math.random() * 1024, Math.random() * 1024, r, 0, TAU); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(24, 24); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.receiveShadow = true; scene.add(ground);
const stainTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), grd = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grd.addColorStop(0, 'rgba(40,28,16,0.55)'); grd.addColorStop(0.6, 'rgba(40,28,16,0.25)'); grd.addColorStop(1, 'rgba(40,28,16,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function buildPoopMesh(p) {
  // a damp stain under it
  {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(p.R * 2.6 + 6, p.R * 2.3 + 5),
    new THREE.MeshStandardMaterial({ map: stainTex, transparent: true, opacity: 0, depthWrite: false, roughness: 0.6 }));
  m.position.set(p.x + 0.6, p.y + 0.6, 0.02); m.receiveShadow = true; scene.add(m); p.stain = m;
  }
  // the dropping itself, shaped as it will lie on the ground
  {
  const z0 = p.z; p.z = 0;
  const S = p.R + 1, N = Math.round(clamp(S / 0.13, 130, 230)), pos = [], col = [], idx = [];   // three of these now, so a little coarser
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = -S + 2 * S * i / N, y = -S + 2 * S * j / N, h = poopHAt(p, p.x + x, p.y + y);
    pos.push(x, y, h > 0 ? h + 0.02 : 0.01);
    const z = Math.max(0, h), n1 = vnoise(x * 2.2 + z * 1.7 + 7, y * 2.2 - z * 1.3), n2 = vnoise(x * 9 + z * 6, y * 9 + 3 - z * 5);
    const seed = hash2(Math.round(x * 6 + z * 4), Math.round(y * 6)) > 0.985;
    // colours picked in sRGB, stored linear
    let r = 0.27 + 0.1 * n1, g = 0.16 + 0.06 * n1, b = 0.075 + 0.03 * n1;
    const k = 0.72 + 0.5 * n2; r *= k; g *= k; b *= k;
    const crust = Math.max(0, vnoise(x * 1.3 + 11, y * 1.3) - 0.6) * 2.2 * Math.min(1, h / 2);   // drier, paler crust on top
    r += 0.14 * crust; g += 0.09 * crust; b += 0.04 * crust;
    if (seed) { r = 0.6; g = 0.5; b = 0.3; }                       // undigested bits
    const lin = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    col.push(lin.r, lin.g, lin.b);
  }
  const up = (v) => pos[v * 3 + 2] > 0.011;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
    if (up(a) || up(b) || up(c) || up(d)) idx.push(a, b, d, a, d, c);   // only where there is something
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35 }));
  m.castShadow = true; m.receiveShadow = true; m.position.set(p.x, p.y, p.z); scene.add(m); p.body = m;
  p.z = z0;
  }
}
function removePoop(p) {
  const i = poops.indexOf(p);
  if (i >= 0) poops.splice(i, 1);
  for (const m of [p.body, p.stain]) { if (!m) continue; scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
}
// somewhere clear of whatever is already down (a dropping on its way out does not count)
function freeSpot(R) {
  const here = poops.filter((p) => !(p.anim && p.anim.phase === 'sink'));
  for (let k = 0; k < 80; k++) {
    const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * SPREAD;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (here.every((p) => Math.hypot(p.x - x, p.y - y) > p.R + R + 5)) return [x, y];
  }
  return [rnd(-SPREAD, SPREAD), rnd(-SPREAD, SPREAD)];
}
let dropSpeed = 1;
function scatterFrom(x, y, R) {
  for (const f of flies) {
    if (f.airborne || f.state === 'land' || Math.hypot(f.x - x, f.y - y) > R + 3) continue;
    f.takeoff('voluntary', Math.atan2(f.y - y, f.x - x) + rnd(-0.8, 0.8), 'body');
    f.flight.T = rnd(0.9, 2.0);
  }
}
// the 便 button: one more falls somewhere free, and once there are three the oldest sinks away
function addDropping(x, y) {
  if (poops.some((p) => p.anim && p.anim.phase !== 'sink')) return;      // one in the air at a time
  const shape = newLumps();
  if (x === undefined) [x, y] = freeSpot(shape.R);
  const here = poops.filter((p) => !(p.anim && p.anim.phase === 'sink'));
  if (here.length >= MAX_POOPS) {
    const old = here[0];
    old.anim = { phase: 'sink', t: 0, depth: Math.max(...old.lumps.map((l) => l[5] + l[6])) + 0.8 };
  }
  const p = { x, y, z: 60, ...shape, anim: { phase: 'fall', t: 0, v: 0 } };
  poops.push(p);
  buildPoopMesh(p);
  scatterFrom(x, y, p.R);                                   // clear the landing site
}
function firstDrop() { addDropping(0, 0); }
function stepDropping(dt) {
  for (let i = poops.length - 1; i >= 0; i--) {
    const p = poops[i], A = p.anim;
    if (!A) continue;
    A.t += dt;
    if (A.phase === 'sink') {
      const u = Math.min(1, A.t / 1.1);
      p.z = -A.depth * u * u;
      p.stain.material.opacity = 1 - u;
      if (u >= 1) { removePoop(p); continue; }
    } else if (A.phase === 'fall') {
      A.v += 520 * dt; p.z = Math.max(0, p.z - A.v * dt);
      p.stain.material.opacity = 0;
      if (p.z <= 0) { A.phase = 'squash'; A.t = 0; thud(); }
    } else {
      p.stain.material.opacity = Math.min(1, A.t / 0.25);
      if (A.t > 0.6) { p.anim = null; p.body.scale.set(1, 1, 1); started = true; }
    }
    const sq = A.phase === 'squash' ? 1 - 0.3 * Math.exp(-A.t / 0.09) * Math.cos(A.t * 32) : A.phase === 'fall' ? 1.08 : 1;
    p.body.position.z = p.z; p.body.scale.set(1 + (1 - sq) * 0.35, 1 + (1 - sq) * 0.35, sq);
    p.body.castShadow = p.z < 20;                           // no stray shadow sliver while it is high up
  }
}
// "ボトッ": a heavy, wet drop -- a low body whose pitch falls fast, then a short squelch
function thud() {
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.01, out = ctx.createGain();
  out.gain.value = 0.9; out.connect(ctx.destination);
  // "ボ": the impact
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.13);
  og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.9, t + 0.006); og.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.25);
  // thump of the mass: low-passed noise
  const noise = (dur, decay) => { const n = Math.floor(ctx.sampleRate * dur), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * decay)); const src = ctx.createBufferSource(); src.buffer = b; return src; };
  const n1 = noise(0.2, 0.035), lp = ctx.createBiquadFilter(), g1 = ctx.createGain();
  lp.type = 'lowpass'; lp.frequency.value = 450; g1.gain.value = 0.8;
  n1.connect(lp); lp.connect(g1); g1.connect(out); n1.start(t);
  // "トッ": a short wet squelch right after
  const n2 = noise(0.08, 0.012), bp = ctx.createBiquadFilter(), g2 = ctx.createGain();
  bp.type = 'bandpass'; bp.frequency.setValueAtTime(900, t + 0.07); bp.frequency.exponentialRampToValueAtTime(420, t + 0.12); bp.Q.value = 3; g2.gain.value = 0.55;
  n2.connect(bp); bp.connect(g2); g2.connect(out); n2.start(t + 0.07);
}
// the hand that shoos them (a dark looming shape)
const handMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.7, transparent: true, opacity: 0.72 }));
handMesh.scale.set(11, 7.5, 3.2); handMesh.castShadow = true; handMesh.visible = false; handMesh.renderOrder = 3; scene.add(handMesh);
// a ring on the tapped fly
const ring = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.strokeStyle = 'rgba(255,190,60,0.95)'; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 54, 0, TAU); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, sizeAttenuation: false, depthTest: false, transparent: true }));
  sp.scale.set(0.06, 0.06, 1); sp.renderOrder = 6; sp.visible = false; scene.add(sp);
  return sp;
})();

// ------------------------------------------------------------------ camera: orbit around the dropping
const cam = { az: -2.0, el: 0.62, dist: 84, target: new THREE.Vector3(0, 0, 1.5) };   // far enough back for three
function placeCamera() {
  const { az, el, dist, target } = cam;

  camera.position.set(target.x + Math.cos(az) * Math.cos(el) * dist, target.y + Math.sin(az) * Math.cos(el) * dist, target.z + Math.sin(el) * dist);
  camera.lookAt(target);
}
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w / h < 1 ? 50 : 36;       // portrait phones see a bit wider
  camera.updateProjectionMatrix();
  resizeBrain();
}
new ResizeObserver(resize).observe(stage);

// ------------------------------------------------------------------ brain (loaded on the first tap)
let worker = null, ready = false, busy = false, brainT = 0, runaway = 0;
const glow = [];
function startBrain() {
  worker = new Worker(at('test03/brain-worker.js?v=1'), { type: 'module' });
  $('b-pbar').hidden = false;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (m.phase === 'download' && m.total) { $('b-bar').style.width = (m.loaded / m.total * 100) + '%'; showNow(`脳の配線を読み込み中… ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB`, '初回のみ。13.9万ニューロン・1,509万結合'); }
      if (m.phase === 'decompress') showNow('WebAssembly に脳を組み立て中…', '');
    } else if (m.type === 'ready') {
      ready = true; $('b-pbar').hidden = true; brainT = world.t;
      if (selected) attachBrain(selected);
    } else if (m.type === 'tick') {
      busy = false;
      if (brainFly) brainFly.decideBrain(m.out);
      const now = performance.now();
      for (let k = 0; k < m.fired.length; k++) glow.push([now, m.fired[k]]);
      if (glow.length > 12000) glow.splice(0, glow.length - 12000);
      runaway = m.spikes / (m.ms / 1000) > 150000 ? runaway + 1 : 0;
      if (runaway > 25) { worker.postMessage({ type: 'reset' }); runaway = 0; }
      if (brainT < world.t + 2 * TICK / 1000) sendTick();
    }
  };
  worker.postMessage({ type: 'init' });
}
function sendTick() {
  if (!ready || busy || !brainFly) return;
  if (brainT < world.t - 0.2) brainT = world.t;            // never fall far behind the body
  busy = true; brainT += TICK / 1000;
  worker.postMessage({ type: 'tick', ms: TICK, inputs: brainFly.sense() });
}
function attachBrain(f) {
  if (brainFly === f) return;
  if (brainFly) { brainFly.why = ''; for (const k in brainFly.drive) brainFly.drive[k] = 0; }
  brainFly = f;
  for (const k in f.drive) f.drive[k] = 0;
  f.prevA = new Map();
  worker.postMessage({ type: 'reset' });                   // a fresh brain for this fly
  glow.length = 0;
}

// brain map inside the view
const bm = $('brainmap'), bg = bm.getContext('2d');
let pos = null, bmBack = null, pxX = null, pxY = null;
async function loadPositions() {
  const res = await fetch(at('flybrain/data/pos783.bin.gz?v=1'));
  const raw = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const n = new DataView(raw.buffer).getUint32(4, true);
  pos = { n, x: new Uint16Array(raw.buffer.slice(8, 8 + 2 * n)), y: new Uint16Array(raw.buffer.slice(8 + 2 * n, 8 + 4 * n)), c: raw.slice(8 + 4 * n, 8 + 5 * n) };
  resizeBrain();
}
function resizeBrain() {
  if (!pos || $('brain').hidden) return;
  const d = window.devicePixelRatio || 1, W = bm.clientWidth; if (!W) return;
  const Hh = Math.round(W / 2.08);
  bm.width = Math.round(W * d); bm.height = Math.round(Hh * d); bm.style.height = Hh + 'px';
  pxX = new Float32Array(pos.n); pxY = new Float32Array(pos.n);
  for (let i = 0; i < pos.n; i++) { pxX[i] = (4 + pos.x[i] / 65535 * (W - 8)) * d; pxY[i] = (4 + pos.y[i] / 65535 * (Hh - 8)) * d; }
  bmBack = document.createElement('canvas'); bmBack.width = bm.width; bmBack.height = bm.height;
  const b = bmBack.getContext('2d'), img = b.createImageData(bm.width, bm.height);
  for (let i = 0; i < pos.n; i++) {
    if (pos.c[i] === 255) continue;
    const o = ((pxY[i] | 0) * bm.width + (pxX[i] | 0)) * 4;
    img.data[o] = 200; img.data[o + 1] = 205; img.data[o + 2] = 215; img.data[o + 3] = Math.min(255, img.data[o + 3] + 16);
  }
  b.putImageData(img, 0, 0);
}
function drawBrain(now) {
  if (!bmBack || $('brain').hidden) return;
  bg.setTransform(1, 0, 0, 1, 0, 0); bg.clearRect(0, 0, bm.width, bm.height); bg.drawImage(bmBack, 0, 0);
  const cols = ['#1baf7a', '#3987e5', '#eb6834'], d = window.devicePixelRatio || 1, sz = 2.2 * d;
  while (glow.length && now - glow[0][0] > 350) glow.shift();
  for (let pass = 0; pass < 3; pass++) {
    bg.fillStyle = cols[pass];
    for (const [t, i] of glow) {
      const c = pos.c[i], grp = c === 0 ? 0 : (c === 6 || c === 7) ? 2 : 1;
      if (grp !== pass) continue;
      bg.globalAlpha = 1 - (now - t) / 350;
      bg.fillRect(pxX[i] - sz / 2, pxY[i] - sz / 2, grp === 2 ? sz * 1.8 : sz, grp === 2 ? sz * 1.8 : sz);
    }
  }
  bg.globalAlpha = 1;
}
function showNow(what, why) { $('b-now').innerHTML = `${what}<span class="why">${why || ''}</span>`; }
function describe(f) {
  const d = f.drive, F = f.flight;
  if (!ready) return;
  const r = Math.round;
  if (f.state === 'feed') return showNow('🍽 うんちを食べている', `味覚ニューロン → 口吻の運動ニューロン MN9 が ${r(d.MN9)} Hz`);
  if (f.state === 'rub') return showNow(f.rubHind ? '🙏 後ろ脚をこすり合わせている' : '🙏 前脚をこすり合わせている', '「手をすり合わせる」身づくろい（体の既定動作）');
  if (f.state === 'groom') return showNow('🧹 前脚で頭をこすっている', `頭の毛への刺激 → 身づくろいの下行性ニューロン ${r(Math.max(d.groomL, d.groomR))} Hz`);
  if (f.state === 'held') return showNow('✋ つかまっている', '脚をばたつかせ、ときどき羽を震わせる');
  if (f.airborne && F && F.by === 'brain') return showNow('🦘 逃げた！', '迫ってくるものに LC4/LPLC2 が反応 → ジャイアントファイバー DNp01 が発火');
  if (f.airborne) return showNow('💨 飛んでいる', '自分から飛ぶのは体の既定動作（脳の指令ではない）');
  if (f.state === 'land') return showNow('🛬 着地', '');
  const onIt = onPoop(...f.mouth());
  return showNow(onIt ? '🚶 うんちの上を歩いている' : '🚶 歩いている', onIt ? '味はしているが MN9 はまだ閾値（15 Hz）未満' : '脳は静か。歩くこと自体は体の既定動作');
}

// ------------------------------------------------------------------ input
//   tap a fly: its brain  ·  trace with a finger (mouse drag): your hand shoos them
//   two fingers (right-drag / shift-drag): orbit and zoom  ·  wheel: zoom
const pointers = new Map(), handPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -HAND_Z), ray = new THREE.Raycaster();
let down = null, two = null;
const holdPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -HOLD_Z);
function holdTarget(cx, cy) {
  const r = view.getBoundingClientRect(), p = new THREE.Vector3();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  return ray.ray.intersectPlane(holdPlane, p) ? p : null;
}
function handTarget(cx, cy) {
  const r = view.getBoundingClientRect(), p = new THREE.Vector3();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  return ray.ray.intersectPlane(handPlane, p) ? p : null;
}
view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, orbit: e.button === 2 || e.shiftKey, hand: false, fly: flyAt(e.clientX, e.clientY) };
  if (pointers.size === 2) {
    if (down && down.hand) liftHand();
    if (down && down.fly && down.fly.state === 'held') down.fly.release(0, 0);
    const [a, b] = [...pointers.values()];
    two = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; down = null;
  }
});
view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const [px, py] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2 && two) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    cam.dist = clamp(cam.dist * two.d / d, 12, 160);
    cam.az -= (mx - two.mx) * 0.006; cam.el = clamp(cam.el + (my - two.my) * 0.005, 0.12, 1.45);
    Object.assign(two, { d, mx, my }); return;
  }
  if (!down) return;
  const dx = e.clientX - px, dy = e.clientY - py;
  down.moved += Math.abs(dx) + Math.abs(dy);
  if (down.moved <= 10) return;
  if (down.orbit) { cam.az -= dx * 0.006; cam.el = clamp(cam.el + dy * 0.005, 0.12, 1.45); return; }
  if (down.fly) {                                         // started on a fly: catch it and carry it
    const f = down.fly;
    if (f.leaving) return;
    if (f.state !== 'held') f.hold();
    const p = holdTarget(e.clientX, e.clientY);
    if (p) {
      const now = performance.now(), h = f.held;
      if (h.px !== undefined) { const k = Math.max(1, now - h.pt) / 1000; h.vx = (p.x - h.px) / k; h.vy = (p.y - h.py) / k; }
      h.px = p.x; h.py = p.y; h.pt = now; h.tx = p.x; h.ty = p.y; h.tz = p.z;
    }
    return;
  }
  const p = handTarget(e.clientX, e.clientY);
  if (!p) return;
  if (!down.hand || !world.hand || world.hand.lift) {
    down.hand = true;
    world.hand = { x: p.x, y: p.y, z: HAND_Z + 25, vx: 0, vy: 0, vz: 0, R: 7, tx: p.x, ty: p.y, lift: false };   // comes down from above
  }
  world.hand.tx = p.x; world.hand.ty = p.y;
});
function liftHand() { if (world.hand) world.hand.lift = true; }
view.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (down && down.fly && down.fly.state === 'held') { const h = down.fly.held; down.fly.release(h.vx || 0, h.vy || 0); }
  else if (down && !down.orbit && down.fly && down.moved <= 10) select(down.fly);
  else if (down && !down.orbit && !down.hand && down.moved <= 10 && performance.now() - down.t < 600) select(null);
  if (down && down.hand) liftHand();
  down = null; if (pointers.size < 2) two = null;
});
view.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId); if (down && down.hand) liftHand();
  if (down && down.fly && down.fly.state === 'held') down.fly.release(0, 0);
  down = null; two = null;
});
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 12, 160); }, { passive: false });
function flyAt(cx, cy) {
  const r = view.getBoundingClientRect();
  let best = null, bd = 1e9;
  for (const f of flies) {
    const p = new THREE.Vector3(f.x, f.y, f.z).project(camera);
    if (p.z > 1) continue;
    const sx = (p.x + 1) / 2 * r.width + r.left, sy = (1 - p.y) / 2 * r.height + r.top, d = Math.hypot(sx - cx, sy - cy);
    if (d < bd) { bd = d; best = f; }
  }
  return best && bd < Math.max(34, 1800 / cam.dist) ? best : null;
}
// the dotted line joining the tapped fly and its brain panel
const link = $('link'), linkPath = link.querySelectorAll('line');
function linkLine() {
  const panel = $('brain');
  if (!selected || panel.hidden) { link.style.display = 'none'; return; }
  const w = stage.clientWidth, h = stage.clientHeight, p = new THREE.Vector3(selected.x, selected.y, selected.z).project(camera);
  const fx = (p.x + 1) / 2 * w, fy = (1 - p.y) / 2 * h;
  const L = panel.offsetLeft, T = panel.offsetTop, R = L + panel.offsetWidth, B = T + panel.offsetHeight;
  const inside = fx > L && fx < R && fy > T && fy < B;
  if (p.z > 1 || inside) { link.style.display = 'none'; return; }
  const px = clamp(fx, L + 14, R - 14), py = clamp(fy, T + 14, B - 14);          // nearest point of the panel
  const ex = Math.abs(fx - px) > Math.abs(fy - py) ? (fx < L ? L : R) : px, ey = Math.abs(fx - px) > Math.abs(fy - py) ? py : (fy < T ? T : B);
  const d = Math.hypot(ex - fx, ey - fy) || 1, r = 16;                              // start just outside the ring
  link.style.display = '';
  for (const ln of linkPath) { ln.setAttribute('x1', fx + (ex - fx) / d * r); ln.setAttribute('y1', fy + (ey - fy) / d * r); ln.setAttribute('x2', ex); ln.setAttribute('y2', ey); }
  link.querySelector('circle').setAttribute('cx', ex); link.querySelector('circle').setAttribute('cy', ey);
}
function select(f) {
  selected = f;
  $('brain').hidden = !f;
  if (!f) return;
  $('b-name').textContent = `蠅 #${f.id + 1}`;
  if (!pos) loadPositions(); else resizeBrain();
  if (!worker) { startBrain(); showNow('脳を準備しています…', ''); }
  else if (ready) attachBrain(f);
}
$('b-close').addEventListener('click', () => select(null));

// ------------------------------------------------------------------ how many flies
let nextId = 0, wanted = N_FLIES;
const staying = () => flies.filter((f) => !f.leaving);
function addFly() {                          // a newcomer flies in from outside and lands
  if (!J) return;
  const f = new Fly(nextId++), a = rnd(0, TAU);
  f.x = Math.cos(a) * 70; f.y = Math.sin(a) * 70; f.z = rnd(12, 22); f.yaw = a + Math.PI;
  f.takeoff('voluntary', f.yaw, 'body');
  Object.assign(f.flight, { launched: true, u: 180, T: 0 });
  f.state = 'flight'; f.wingOpen = 1; f.flap = 1; f.w.tuck = 1; f.pitch = 0.5;
  scene.add(f.body.root, f.body.skin); flies.push(f);
}
function removeFly() {                       // someone flies off and away
  const left = staying();
  if (left.length <= 1) return;
  const f = [...left].reverse().find((o) => o !== selected && o.state !== 'held');
  if (!f) return;
  f.leaving = true;
  if (!f.airborne) f.takeoff('voluntary', Math.atan2(f.y, f.x) + rnd(-0.5, 0.5), 'body');
  Object.assign(f.flight, { phase: 'leave', reach: false, final: false, saccade: true, wp: { x: Math.cos(Math.atan2(f.y, f.x)) * 140, y: Math.sin(Math.atan2(f.y, f.x)) * 140 }, U: 220, h: 22 });
}
function dropGone() {
  for (let i = flies.length - 1; i >= 0; i--) {
    const f = flies[i];
    if (!f.leaving || Math.hypot(f.x, f.y) < 95) continue;
    if (f === selected) select(null);
    if (f === brainFly) brainFly = null;
    scene.remove(f.body.root, f.body.skin); flies.splice(i, 1);
  }
}
// newcomers arrive one after another; extra flies leave one after another
let arriveT = 0;
let started = false;       // flies only come once the dropping has landed
function balance(dt) {
  if (!started) return;
  const n = staying().length;
  if (n > wanted) { for (let k = n; k > wanted; k--) removeFly(); return; }
  if (n < wanted && (arriveT -= dt) <= 0) { addFly(); arriveT = n < 12 ? rnd(0.15, 0.5) : rnd(0.03, 0.12); }
}
$('n-flies').addEventListener('change', (e) => { wanted = +e.target.value; });
$('btn-poop').addEventListener('click', () => addDropping());

// ------------------------------------------------------------------ sound: the buzz of flying flies (synthesized)
// A few voices follow the loudest buzzing flies: a sawtooth at the wingbeat (~210 Hz) plus its
// octave, wobbling a little, louder the closer the fly is to the camera, panned by its screen position.
const audio = { ctx: null, on: true, voices: [] }, _v3 = new THREE.Vector3();
function startAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended' && !document.hidden) audio.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !audio.on) return;
  const ctx = new AC(), master = ctx.createGain();
  master.gain.value = 0.6; master.connect(ctx.destination);
  audio.ctx = ctx;
  for (let i = 0; i < 5; i++) {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), lfo = ctx.createOscillator();
    const g2 = ctx.createGain(), lg = ctx.createGain(), filt = ctx.createBiquadFilter(), gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    o1.type = 'sawtooth'; o2.type = 'square'; o1.frequency.value = 210; o2.frequency.value = 420.6;
    lfo.frequency.value = rnd(4, 9); lg.gain.value = rnd(3, 7); g2.gain.value = 0.22;
    filt.type = 'lowpass'; filt.frequency.value = 2400; filt.Q.value = 0.8; gain.gain.value = 0;
    lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
    o1.connect(filt); o2.connect(g2); g2.connect(filt); filt.connect(gain);
    if (pan) { gain.connect(pan); pan.connect(master); } else gain.connect(master);
    o1.start(); o2.start(); lfo.start();
    audio.voices.push({ gain, pan, o1, o2 });
  }
}
function updateAudio() {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  const loud = [];
  for (const f of flies) {
    if (f.flap < 0.05) continue;
    const d = camera.position.distanceTo(_v3.set(f.x, f.y, f.z));
    loud.push({ f, g: f.flap * Math.min(1.6, (40 / d) ** 2) });
  }
  loud.sort((a, b) => b.g - a.g);
  audio.voices.forEach((v, i) => {
    const c = loud[i];
    v.gain.gain.setTargetAtTime(c && audio.on ? 0.08 * c.g : 0, t, 0.05);
    if (!c) return;
    const f0 = 196 + (c.f.id * 37) % 38 + (c.f.speed > 250 ? 14 : 0);        // each fly its own pitch, higher when fleeing
    v.o1.frequency.setTargetAtTime(f0, t, 0.06); v.o2.frequency.setTargetAtTime(f0 * 2.003, t, 0.06);
    if (v.pan) v.pan.pan.setTargetAtTime(clamp(_v3.set(c.f.x, c.f.y, c.f.z).project(camera).x, -1, 1) * 0.8, t, 0.06);
  });
}
document.addEventListener('pointerdown', () => { if (audio.ctx) startAudio(); }, { capture: true });
document.addEventListener('visibilitychange', () => { if (!audio.ctx) return; if (document.hidden) audio.ctx.suspend(); else audio.ctx.resume(); });
// a fly buzzing past the listener: pitch drops as it passes (Doppler), left to right
function flyBy() {
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.05, T = 2.2;
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), vib = ctx.createOscillator(), vg = ctx.createGain();
  const g2 = ctx.createGain(), filt = ctx.createBiquadFilter(), gain = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  o1.type = 'sawtooth'; o2.type = 'square'; g2.gain.value = 0.25;
  vib.frequency.value = 7; vg.gain.value = 6; vib.connect(vg); vg.connect(o1.frequency); vg.connect(o2.frequency);
  o1.frequency.setValueAtTime(248, t); o1.frequency.setValueAtTime(248, t + T * 0.35); o1.frequency.exponentialRampToValueAtTime(186, t + T * 0.6);
  o2.frequency.setValueAtTime(497, t); o2.frequency.setValueAtTime(497, t + T * 0.35); o2.frequency.exponentialRampToValueAtTime(373, t + T * 0.6);
  filt.type = 'lowpass'; filt.frequency.setValueAtTime(900, t); filt.frequency.linearRampToValueAtTime(3000, t + T * 0.45); filt.frequency.linearRampToValueAtTime(900, t + T);
  gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.35, t + T * 0.45); gain.gain.exponentialRampToValueAtTime(0.0001, t + T);
  if (pan) { pan.pan.setValueAtTime(-0.9, t); pan.pan.linearRampToValueAtTime(0.9, t + T); }
  o1.connect(filt); o2.connect(g2); g2.connect(filt); filt.connect(gain);
  if (pan) { gain.connect(pan); pan.connect(ctx.destination); } else gain.connect(ctx.destination);
  for (const o of [o1, o2, vib]) { o.start(t); o.stop(t + T + 0.1); }
}
$('warn-ok').addEventListener('click', () => {
  startAudio();
  flyBy();
  $('warn').remove();
  setTimeout(firstDrop, 350);
});

// ------------------------------------------------------------------ main loop
let last = performance.now(), acc = 0, stepN = 0, frameN = 0;
const stats = { step: 0, pose: 0, render: 0, sim: 0, frames: 0 };
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
  let simDt = 0;
  if (J) {                                 // body data loaded (flies may still be on their way)
    acc = Math.min(acc + dtReal, 0.2);
    const t0 = performance.now();
    while (acc >= H) {
      acc -= H; simDt += H; world.t += H;
      for (const f of flies) f.step(H);
      if (Math.round(world.t * 1000) % 20 === 0) for (const f of flies) if (f !== brainFly) f.decideRule(0.02);
      if (++stepN % 4 === 0) { crowd(4 * H); dropGone(); balance(4 * H); }
      const h = world.hand;
      if (h) {
        const k = 1 - Math.exp(-H / 0.03), ox = h.x, oy = h.y, oz = h.z;
        if (h.lift) { h.x += h.vx * H; h.y += h.vy * H; h.z += 140 * H; h.vx *= 0.995; h.vy *= 0.995; }
        else { h.x += (h.tx - h.x) * k; h.y += (h.ty - h.y) * k; h.z += (HAND_Z - h.z) * (1 - Math.exp(-H / 0.06)); }
        h.vx = (h.x - ox) / H; h.vy = (h.y - oy) / H; h.vz = (h.z - oz) / H;
        if (h.z > HAND_Z + 45) world.hand = null;
      }
    }
    if (brainFly && ready) sendTick();
    const t1 = performance.now();
    stepDropping(dtReal * dropSpeed);
    const blur = clamp((WINGBEAT * simDt - 0.15) / 0.35, 0, 1);
    const many = flies.length > 30; frameN++;
    flies.forEach((f, i) => f.pose(simDt, blur, !many || f === selected || ((i + frameN) & 1) === 0));
    const t2 = performance.now();
    const h = world.hand; handMesh.visible = !!h;
    if (h) { handMesh.position.set(h.x, h.y, h.z); if (Math.hypot(h.vx, h.vy) > 20) handMesh.rotation.z = Math.atan2(h.vy, h.vx); }
    ring.visible = !!selected; if (selected) ring.position.set(selected.x, selected.y, selected.z);
    linkLine();
    updateAudio();
    for (const f of flies) for (const m of f.body.microchaetae) m.visible = cam.dist < 30;
    placeCamera();
    renderer.render(scene, camera);
    const t3 = performance.now(), st = stats;
    st.step += t1 - t0; st.pose += t2 - t1; st.render += t3 - t2; st.sim += simDt; st.frames++;   // totals (divide by frames)
  }
  drawBrain(now);
  if (selected && now - (frame.ui || 0) > 150) { frame.ui = now; describe(selected); }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ start
resize();
(async () => {
  try {
    const [data, L, loMeta, loBin] = await Promise.all([
      loadFlyData(at('test03/nmf/'), V), fetch(at('test03/nmf/locomotion.json' + V)).then((r) => r.json()),
      fetch(at('test03/nmf/meshes_lo.json' + V)).then((r) => r.json()),
      fetch(at('test03/nmf/meshes_lo.bin.gz' + V)).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    ]);
    J = data.J; BIN = data.bin; LO = { meta: loMeta, bin: loBin }; loco = new LocoMap(L);
    { const probe = new FlyBody(J, BIN, { lo: LO }); solveFixedPoses(probe, new CPG(J)); }
    $('load').remove();
  } catch (err) {
    $('load').textContent = '読み込みに失敗しました: ' + (err && err.message || err);
  }
})();
window.__sim = { world, flies, cam, select, stats, renderer, audio, poops, addDropping,
  dropState: () => poops.map((p) => [p.anim ? p.anim.phase : 'done', +p.z.toFixed(1)]),
  dropDbg: () => poops.map((p) => ({ xy: [+p.x.toFixed(1), +p.y.toFixed(1)], R: +p.R.toFixed(1), z: +p.z.toFixed(2),
    lumps: p.lumps.length, inScene: !!(p.body && p.body.parent), anim: p.anim ? p.anim.phase : null })),
  slowDrop: (k) => { dropSpeed = k; }, project: (f) => new THREE.Vector3(f.x, f.y, f.z).project(camera).toArray(), get selected() { return selected; }, get brainFly() { return brainFly; }, get ready() { return ready; } };
requestAnimationFrame(frame);
