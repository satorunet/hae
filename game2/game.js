// ハエたたき — two players share one field of flies and swat at them; more kills in the time wins.
//
// The flies, their bodies (flygym's NeuroMechFly) and the droppings are the ones from the main
// page; here they run on rules only (no brain worker). The droppings are only bait — what counts is
// how many flies each player flattens before the clock runs out. A hand looming overhead sets off the
// same escape response the flies already had, so the good ones get away.
//
// Online, the two devices talk through the relay at /ws/ (nodejs/hae-game): the first one in the room
// hosts — it runs the whole field and ships it over twelve times a second, and it alone decides who
// was hit — and the other renders that and sends back only its swats.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LocoMap, LEGS } from '../test03/body3d.js?v=6';

const V = '?v=1';
const SITE = new URL('../', import.meta.url);          // data paths work from / and from /test04/
const at = (p) => new URL(p, SITE).href;
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, target, dt, tau) => v + (target - v) * (1 - Math.exp(-dt / tau));
const rnd = (a, b) => a + Math.random() * (b - a);
// every fly's looks come from its id, so both devices show the same swarm
const mulberry32 = (a) => () => {
  a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const TAU = Math.PI * 2;

const N_FLIES = 30;               // before the match and after it: fixed, the players cannot change it
const N_MATCH = 50;              // during the match itself
const MODE = window.__HAE_MODE || 'vs';            // 'solo60' on the front page, 'vs' on /game2/
const SOLO60 = MODE === 'solo60';
const BEST_KEY = 'hae-tataki-best-60';
const MATCH_TIME = SOLO60 ? 60 : 45;   // seconds of swatting
const COUNT_IN = 3.2;            // the 3–2–1 before it
const SWAT_HALF = 6.5;           // half the width of the head: everything under that square is caught at once
const SWAT_FLEX = 0.8;           // how far below the mesh a fly can still be and be caught
const ALARM_R = 46;              // a swing is noticed right across the field
const ALARM_NEAR = 18;           // this close they stop dead as well as turn
const ALARM_LOOK = 1.3;          // they stop and watch the spot for this long — long enough to come
                                 // right about from facing away, at ALARM_TURN. That is all it is.
const ALARM_TURN = 2.8;          // rad/s they can whip round at, over what the legs alone manage
const SWAT_FALL = 0.17;          // seconds from the raised hand to the impact
const SWAT_COOL = 0.5;           // and this long before that player can swing again
const PIN_T = 0.34;              // it is held down and struggling for this long before anything is decided
const P_FREE = 0.12;             // wriggles out from under the mesh, unhurt
const P_HURT = 0.32;             // or lives, but broken: it has to be hit again
const SWAT_H = 46;               // how high the hand starts
const BAIT = [[-17, 8], [16, 12], [1, -18]];   // where the three droppings go: the same on both devices
const TICK = 20;                 // ms of brain time per exchange with the worker
const H = 0.002;                 // s, body step
const WALK_Z = 1.12;             // thorax height above the ground while walking (flygym physics)
const WINGBEAT = 210;            // Hz
const G = 9810;                  // mm/s^2
const FIELD_R = 38;              // the playing field: walkers turn back beyond this
const FLY_R = 50;                // flights stay within this radius of the middle
const PLACE_R = 34;              // droppings can be placed this far out
const HAND_Z = 9;                // the hand sweeps this high above the ground
const HOLD_Z = 7;                // a caught fly is carried this high

// ------------------------------------------------------------------ the droppings: height fields
// Each dropping is a few log-like lumps around its own centre
// (lump: x, y, angle, half-length, radius, height, extra height at the ridge)
const poops = [];                                          // every dropping on the field
// nMin / kMin put a floor under how much there is. Left alone this comes out as a single small
// lump often enough that a field of three reads as though two of the droppings are missing.
function makeLumps(nMin = 1, kMin = 0.75) {
  const k = rnd(kMin, kMin + 0.5);                          // how much there is
  const n = nMin + Math.floor(Math.random() * 3), pile = Math.random() < 0.65, out = [];
  for (let i = 0; i < n; i++) {
    const r = i === 0 ? 0 : (pile ? rnd(0.8, 2.4) : rnd(2.2, 4.2)) * k, a = rnd(0, Math.PI * 2);
    out.push([Math.cos(a) * r, Math.sin(a) * r, rnd(0, Math.PI * 2), rnd(1.4, 3.8) * k, rnd(2.2, 3.6) * Math.sqrt(k), rnd(1.5, 2.6) * Math.sqrt(k),
      (i === 0 ? rnd(0, 0.8) : pile ? rnd(0.8, 3.0) : rnd(0, 0.6)) * Math.sqrt(k)]);
  }
  return { lumps: out, R: Math.max(...out.map(([cx, cy, , L, R]) => Math.hypot(cx, cy) + L + R)), noff: [rnd(0, 100), rnd(0, 100)] };
}
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
}
// height of one dropping at a world point (p.z > 0 while it is still in the air)
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
// the dropping a point stands on, and the one that smells best from there (bigger and closer wins)
function poopUnder(x, y) { let best = null, bh = 0.25; for (const p of poops) { const v = poopHAt(p, x, y); if (v > bh) { bh = v; best = p; } } return best; }
// pick one at random, the best-smelling ones more often
function weightedPoop(x, y) {
  const w = [];
  let tot = 0;
  for (const p of poops) { const v = p.z > 0.01 ? 0 : (p.R + 5) / (Math.hypot(p.x - x, p.y - y) + 9); w.push(v); tot += v; }
  if (tot <= 0) return null;
  let r = Math.random() * tot;
  for (let i = 0; i < poops.length; i++) { r -= w[i]; if (r <= 0) return poops[i]; }
  return poops[poops.length - 1];
}
function bestPoop(x, y) {
  let best = null, bs = -1;
  for (const p of poops) {
    if (p.z > 0.01) continue;
    const s = (p.R + 5) / (Math.hypot(p.x - x, p.y - y) + 9);
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}

// ------------------------------------------------------------------ one fly
let J = null, BIN = null, LO = null, loco = null;
const flies = [];
const world = { t: 0, hand: null };

class Fly {
  constructor(id) {
    this.id = id;
    this.body = new FlyBody(J, BIN, { lo: LO, ghosts: 5 });     // one skinned low-poly mesh per fly
    this.cpg = new CPG(J);
    // every fly different: size, colour type (tan / black / metallic green), and a longer/plumper or slimmer abdomen
    const R = mulberry32((id + 1) * 0x9E3779B1 | 0), rr = (a, b) => a + R() * (b - a);
    const kind = R() < 0.2 ? 'green' : R() < 0.25 ? 'black' : 'tan';
    this.s = rr(0.78, 1.22) * (kind === 'tan' ? 1 : 1.1); this.walkZ = WALK_Z * this.s;
    this.body.root.scale.setScalar(this.s);
    const TINTS = [[1.05, 0.95, 0.8], [0.62, 0.54, 0.46], [1.1, 0.8, 0.64], [0.84, 0.82, 0.8], [1.14, 1.03, 0.7], [0.95, 0.9, 0.86]];
    const j = () => rr(0.92, 1.08);
    let tint, k = rr(0.82, 1.12);
    if (kind === 'green') { tint = [0.07 * j(), 0.2 * j(), 0.085 * j()]; k = rr(0.75, 1.05); }     // greenbottle-like: dark metallic green
    else if (kind === 'black') { tint = [0.2, 0.2, 0.21].map((v) => v * j()); k = rr(0.8, 1.3); } // housefly-like
    else tint = TINTS[Math.floor(R() * TINTS.length)].map((v) => v * j());
    this.kind = kind;
    // eye colour: most are the usual brick red, a good few much darker, the odd one orange
    const e = R();
    const eye = e < 0.52 ? [rr(0.9, 1.12), rr(0.9, 1.12), rr(0.9, 1.12)]
      : e < 0.82 ? [rr(0.45, 0.64), rr(0.68, 0.92), rr(0.78, 1.02)]
        : e < 0.94 ? [rr(0.18, 0.34), rr(0.55, 0.8), rr(0.8, 1.05)]
          : [rr(1.08, 1.28), rr(1.4, 1.9), rr(0.95, 1.2)];
    this.body.skin.material = flyMaterial(tint.map((v) => v * k), kind === 'green', eye);
    const girth = rr(0.88, 1.3);
    this.body.byName.c_abdomen12.obj.scale.set(rr(0.9, 1.18), girth, girth * rr(0.92, 1.08));
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

  // --- the other nine: rules standing in for the same decisions
  decideRule(dt) {
    const r = this.rule, d = this.drive;
    r.feedT -= dt; r.restT -= dt; r.groomT -= dt;
    if (this.airborne || this.state === 'land') return;
    if (this.hurt) { if (this.state !== 'walk') this.setState('walk'); return; }
    if (this.startle && world.t >= this.startle.at) { this.takeoff('escape', this.startle.dir, 'rule'); this.startle = null; return; }
    const [mx, my] = this.mouth();
    if (this.state === 'feed') {
      if (r.feedT <= 0 || !onPoop(mx, my)) { r.restT = rnd(1, 3); if (Math.random() < 0.85) this.rub(); else this.setState('walk'); }
    }
    else if (this.state === 'groom') { if (r.groomT <= 0) this.setState('walk'); }
    else if (this.state === 'rub') { /* ends by itself (step) */ }
    else {
      if ((this.touchL > 0 || this.touchR > 0) && Math.random() < 0.02) { if (Math.random() < 0.75) this.rub(); else { this.setState('groom'); r.groomT = rnd(1.2, 3.5); } }
      else if (Math.random() < dt / 45) { this.setState('groom'); r.groomT = rnd(1.5, 4); }
      else if (Math.random() < dt / 4.5 && !(onPoop(mx, my) && r.restT <= 0)) this.rub();     // (eating comes first)
      else if (onPoop(mx, my) && r.restT <= 0) { this.setState('feed'); r.feedT = rnd(5, 16); }
    }
    d.MN9 = this.state === 'feed' ? 45 : 0;
    d.groomL = d.groomR = this.state === 'groom' ? 60 : 0;
  }

  // the fly's "hand washing": front legs (sometimes the hind legs) rubbed against each other
  rub() { this.setState('rub'); this.rubT = rnd(2, 5.5); this.rubHind = Math.random() < 0.2; }

  takeoff(mode, dir, by) {
    if (this.hurt) return;                             // it has no wings left to do this with
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
    if (this.dead) this.deadStep(dt);
    else if (this.remote) this.netStep(dt);
    else if (this.state === 'held') this.holdStep(dt); else if (this.airborne) this.flightStep(dt); else this.groundStep(dt);
    const W = this.w, F = this.flight;
    const tuck = (this.state === 'flight' || (this.state === 'takeoff' && F.launched)) && !(F && F.reach);
    W.groom = approach(W.groom, this.state === 'groom' ? 1 : 0, dt, 0.12);
    W.rub = approach(W.rub || 0, this.state === 'rub' && !this.rubHind ? 1 : 0, dt, 0.12);
    W.rubH = approach(W.rubH || 0, this.state === 'rub' && this.rubHind ? 1 : 0, dt, 0.14);
    if (this.state === 'rub') { this.rubPh = (this.rubPh || 0) + dt * TAU * 4.5; if (!this.remote && (this.rubT -= dt) <= 0) this.setState('walk'); }
    // the brain fly rubs too when it stands idle (body default)
    else if (!this.remote && this.state === 'walk' && this.pauseT > 0 && Math.random() < dt / 2) this.rub();
    W.tuck = approach(W.tuck, tuck ? 1 : 0, dt, 0.04);
    W.reach = approach(W.reach, (F && F.reach) || (this.state === 'land' && this.stateT < 0.1) ? 1 : 0, dt, 0.05);
    W.jump = approach(W.jump, this.state === 'takeoff' && F.pushing ? 1 : 0, dt, 0.003);
    this.prob = approach(this.prob, this.state === 'feed' ? clamp(this.drive.MN9 / 55, 0.35, 1) : 0, dt, 0.08);
    // the mouthparts are never still: dabbing fast at the food, fidgeting the rest of the time
    this.dabPh = (this.dabPh || 0) + dt * TAU * (this.state === 'feed' ? 7.5 + (this.id % 5) * 0.9 : 1.7);
    if (this.state === 'groom') { this.groomPh += dt * TAU * 5.5; this.groomSlow += dt * TAU * 0.35; }
    const flapping = this.state === 'flight' || this.state === 'landing' || (this.state === 'takeoff' && F.flapOn)
      || (this.state === 'held' && this.held.buzz) || (this.hurt && this.hurtBuzz) || (this.dead && this.throeBuzz);
    this.flap = approach(this.flap, flapping ? 1 : 0, dt, flapping ? 0.006 : 0.02);
    if (this.flap > 0.01) this.wingPh += dt * TAU * WINGBEAT;
    const open = this.dead ? this.throeBuzz : this.hurt ? true : this.state === 'takeoff' ? F.wingsUp : this.state === 'held' ? this.held.buzz : this.airborne || (this.state === 'land' && this.stateT < 0.05);
    this.wingOpen = approach(this.wingOpen, open ? 1 : 0, dt, open ? (F && F.mode === 'escape' ? 0.004 : 0.03) : 0.06);
    // spontaneous take-off (body default, not the brain)
    if (!this.remote && this.state === 'walk' && !this.leaving && world.t - this.lastFlightEnd > 6 && Math.random() < dt / 45) this.takeoff('voluntary', this.yaw + rnd(-0.4, 0.4), 'body');
  }

  // --- a fly the other device owns: legs and wings still run here, where it goes comes over the wire
  netStep(dt) {
    this.cpg.step(dt, this.dL, this.dR);
    const t = this.net, k = 1 - Math.exp(-dt / 0.05);
    this.x += (t.x - this.x) * k; this.y += (t.y - this.y) * k;
    this.yaw = wrap(this.yaw + wrap(t.yaw - this.yaw) * k);
    if (this.airborne) { this.z += (t.z - this.z) * k; this.pitch += (t.pitch - this.pitch) * k; this.roll += (t.roll - this.roll) * k; }
    const m = this.cpg.mag, sL = (m[0] + m[1] + m[2]) / 3 * Math.sign(this.cpg.freq[0]), sR = (m[3] + m[4] + m[5]) / 3 * Math.sign(this.cpg.freq[3]);
    this.speed = Math.abs(loco.at(sL, sR).vx * this.s);
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
    if (!this.flight) { this.setState('walk'); return; }      // too broken to fly
    Object.assign(this.flight, { launched: true, u: clamp(Math.hypot(vx, vy), 120, 260), T: rnd(0.6, 1.6) });
    this.state = 'flight'; this.stateT = 0; this.vz = 80; this.wingOpen = 1; this.flap = 1; this.yaw = dir;
  }

  groundStep(dt) {
    if (this.hurt) return this.hurtStep(dt);
    // The escape is a reflex and does not wait for the next decision tick twenty milliseconds away:
    // it is checked here, every two. A real fly is off the ground about five milliseconds after it
    // sees the thing coming, which is most of why they are so hard to hit.
    if (this.startle && world.t >= this.startle.at) {
      const dir = this.startle.dir;
      this.startle = null;
      this.takeoff('escape', dir, 'rule');
      if (this.airborne) return;
    }
    let base = 0;
    if (this.state === 'walk') {
      if (this.pauseT > 0) this.pauseT -= dt; else if (Math.random() < dt / 5) this.pauseT = rnd(0.4, 2.2);
      base = this.pauseT > 0 ? 0 : 1;
      if (this.drive.MDN > 20) base = -0.8;
    }
    // exploration + attraction to whichever dropping smells best from here + staying on the field: + = turn right
    this.om += (-this.om / 0.6) * dt + (Math.random() - 0.5) * 2.4 * Math.sqrt(dt);
    if ((this.aimT = (this.aimT || 0) - dt) <= 0) { this.aimT = 0.5; this.aim = bestPoop(this.x, this.y); }
    const A = this.aim && poops.includes(this.aim) ? this.aim : null;
    const da = A ? Math.hypot(this.x - A.x, this.y - A.y) : 0;
    const toA = A ? wrap(Math.atan2(A.y - this.y, A.x - this.x) - this.yaw) : 0;
    const pull = A && da > A.R * 0.75 ? -clamp(toA, -1, 1) * Math.min(0.9, 0.035 * da) : 0;
    const dist = Math.hypot(this.x, this.y), toC = wrap(Math.atan2(-this.y, -this.x) - this.yaw);
    const back = dist > FIELD_R ? -Math.sign(toC) * (dist - FIELD_R) * 0.12 : 0;
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
    const at = this.alarmT ?? -9, alarmed = world.t >= at && world.t - at < ALARM_LOOK;
    if (alarmed) { base = 0; this.pauseT = 0; }        // it stops where it is; the dropping can wait
    const turn = clamp(this.om + pull + back + avoid + dna02, -0.8, 0.8);
    this.dL = base * (1 + turn); this.dR = base * (1 - turn);
    if (alarmed) {
      // Wary, not curious: it turns to keep an eye on where that came down and goes nowhere while it
      // does. base*(1±turn) can never give the two sides opposite signs, so a pivot is set directly.
      const e = wrap(Math.atan2(this.alarmY - this.y, this.alarmX - this.x) - this.yaw);
      const q = clamp(e * 2.5, -1, 1) * 0.6 * (this.alarmGain ?? 1);
      this.dL = -q; this.dR = q;
    }
    if (this.state === 'land') { this.dL = this.dR = 0; if (this.stateT > 0.35) this.setState('walk'); }
    this.cpg.step(dt, this.dL, this.dR);
    const m = this.cpg.mag, sL = (m[0] + m[1] + m[2]) / 3 * Math.sign(this.cpg.freq[0]), sR = (m[3] + m[4] + m[5]) / 3 * Math.sign(this.cpg.freq[3]);
    const v = loco.at(sL, sR), c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let vx = v.vx * this.s;
    if (this.state === 'land' && this.flight) vx += this.flight.u * Math.exp(-this.stateT / 0.03);
    this.x += (c * vx - s * v.vy * this.s) * dt; this.y += (s * vx + c * v.vy * this.s) * dt; this.yaw = wrap(this.yaw + v.wz * dt);
    if (alarmed) {
      // shuffling legs alone take a second and a half to come about, far too slow to read as a
      // reaction — a real fly snaps round to look. This is on top of what the legs are doing.
      const e = wrap(Math.atan2(this.alarmY - this.y, this.alarmX - this.x) - this.yaw);
      this.yaw = wrap(this.yaw + clamp(e * 4, -1, 1) * ALARM_TURN * dt);
    }
    this.speed = Math.abs(vx);
  }

  // it does not simply stop, and no two go the same way: DEATHS holds the shapes this takes
  deadStep(dt) {
    const d = this.dth, st = d.st;
    d.t += dt;
    const k = Math.max(0, 1 - d.t / d.span);                 // how much fight is left
    if ((d.T -= dt) <= 0) {
      d.on = !d.on;
      d.T = d.on ? rnd(st.on[0], st.on[1]) * (0.35 + k) : rnd(st.off[0], st.off[1]) / (0.12 + k);
      d.dL = d.on ? rnd(-1.6, 1.6) * st.leg * k : 0;
      d.dR = d.on ? rnd(-1.6, 1.6) * st.leg * k : 0;
      d.buzz = d.on && Math.random() < st.buzz * (0.35 + k);
      d.jolt = d.on ? rnd(-1, 1) * st.jolt * k : 0;
    }
    this.throeBuzz = d.buzz;
    this.cpg.step(dt * st.rate, d.dL, d.dR);                 // legs still firing, out of time with each other
    const w = (d.on ? 1 : 0.15) * k;
    this.yaw = d.yaw0 + d.jolt * 0.12 * w;
    this.roll = d.roll0 + Math.sin(d.t * d.hz) * 0.09 * w * st.jolt;
    this.pitch = d.pitch0 + Math.sin(d.t * d.hz * 0.78 + 1.3) * 0.07 * w * st.jolt;
    this.x = d.x0 + Math.cos(d.yaw0) * d.jolt * 0.25 * w;
    this.y = d.y0 + Math.sin(d.yaw0) * d.jolt * 0.25 * w;
    if (d.t >= d.span) {
      if (d.encore > 0) {                                    // one last kick, long after it looked over
        const q = d.encore;
        d.encore = 0; d.t = 0; d.span = q + rnd(0.3, 0.9); d.T = q;
        d.on = false; d.dL = d.dR = 0; d.buzz = false; d.jolt = 0;
      } else settleDead(this);
    }
  }

  // knocked over and unable to fly: it buzzes its wings flat against the ground and skids along on its side
  hurtStep(dt) {
    const h = this.hb ??= { buzz: false, T: rnd(0.05, 0.3), dir: this.yaw, v: 0, dL: 0.2, dR: 0.2 };
    if ((h.T -= dt) <= 0) {
      h.buzz = !h.buzz;
      h.T = h.buzz ? rnd(0.16, 0.5) : rnd(0.2, 0.7);
      if (h.buzz) {
        h.dir = wrap(h.dir + rnd(-1.7, 1.7));
        h.v = rnd(16, 38);
        h.dL = rnd(0.5, 1.4) * (Math.random() < 0.3 ? -1 : 1);
        h.dR = rnd(0.5, 1.4) * (Math.random() < 0.3 ? -1 : 1);
      }
    }
    this.hurtBuzz = h.buzz;
    this.speed = approach(this.speed, h.buzz ? h.v : 0, dt, 0.06);
    if (Math.hypot(this.x, this.y) > FIELD_R) h.dir = Math.atan2(-this.y, -this.x) + rnd(-0.5, 0.5);
    this.x += Math.cos(h.dir) * this.speed * dt;
    this.y += Math.sin(h.dir) * this.speed * dt;
    this.yaw = wrap(this.yaw + wrap(h.dir - this.yaw) * Math.min(1, dt * 5));
    this.dL = this.dR = 0;
    this.cpg.step(dt * 2.2, h.dL, h.dR);               // legs scrabbling at nothing
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
        const onIt = Math.random() < 0.75, a = rnd(0, TAU), r = onIt ? rnd(0, t.R) : rnd(t.R, t.R + 9);
        p = { x: t.x + Math.cos(a) * r, y: t.y + Math.sin(a) * r };
        if (onIt && !onPoop(p.x, p.y)) continue;
      } else { const a = rnd(0, TAU), r = Math.sqrt(Math.random()) * FIELD_R * 0.8; p = { x: Math.cos(a) * r, y: Math.sin(a) * r }; }
      if (Math.hypot(p.x, p.y) > FIELD_R) continue;
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
    const dab = Math.sin(this.dabPh || 0), dab2 = Math.sin((this.dabPh || 0) * 1.7 + 1.1);
    const idle = this.prob < 0.05 ? 1 : 0;                 // even a resting fly works its mouth a little
    jset('c_head-c_rostrum-pitch', -1.25 * this.prob * (1 + 0.16 * dab) - idle * 0.07 * (0.5 + 0.5 * dab));
    jset('c_rostrum-c_haustellum-pitch', -1.6 * this.prob * (0.76 + 0.34 * dab2) - idle * 0.11 * (0.5 + 0.5 * dab2));
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
      if (w.detached) continue;                              // that one is lying on the ground
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
    if (this.dead) {                                         // lying where it fell, not standing on its feet
      const root = body.root;
      root.position.set(this.x, this.y, this.z);
      _qa.setFromAxisAngle(AZ, this.yaw); _qb.setFromAxisAngle(AY, -this.pitch); _qc.setFromAxisAngle(AX, this.roll);
      root.quaternion.copy(_qa).multiply(_qb).multiply(_qc);
      return;
    }
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
      const k2 = 1 - Math.exp(-Math.max(simDt, 1e-5) / (this.hurt ? 0.03 : this.state === 'land' ? 0.025 : 0.01));
      if (this.hurt) {                                 // lying over on its side, pressed into the ground
        const gc = groundZ(this.x, this.y);
        this.z += (gc + 0.42 * this.s - this.z) * k2;
        this.pitch += (0.22 * Math.sin(world.t * 11 + this.id) - this.pitch) * k2;
        this.roll += (this.hurtRoll - this.roll) * k2;
      } else {
        this.z += (g.z - this.z) * k2; this.pitch += (g.pitch - this.pitch) * k2; this.roll += (g.roll - this.roll) * k2;
      }
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
  if (net.on && !net.host) return;                     // the host jostles them; we only draw the result
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
    if (f.airborne || f.startle) continue;
    for (const o of flies) {
      if (o === f || !o.airborne || !o.flight || !o.flight.launched) continue;
      const d = Math.hypot(o.x - f.x, o.y - f.y, o.z - f.z);
      if (d < 3.5 && Math.random() < dt * 3) f.startle = { at: world.t + rnd(0.004, 0.03), dir: Math.atan2(f.y - o.y, f.x - o.x) };
    }
  }
  // a hand coming down is a looming stimulus: the ones that spot it in time get away
  for (const s of swats) {
    if (s.hit) continue;
    for (const f of flies) {
      if (f.airborne || f.startle) continue;
      const dx = f.x - s.x, dy = f.y - s.y, dz = f.z - s.z, d = Math.hypot(dx, dy, dz) || 1;
      const closing = s.vz * dz / d;                                       // mm/s toward the fly
      // this is rolled every 8 ms of the fall, so the rate has to stay low or nothing is ever caught
      const rate = (d < 20 && closing > 25 ? 1.4 : 0) + (d < 11 ? 1.0 : 0);
      if (rate && Math.random() < dt * rate) f.startle = { at: world.t + rnd(0.0, 0.02), dir: Math.atan2(dy, dx) + rnd(-0.5, 0.5) };
    }
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
// ------------------------------------------------------------------ building one dropping
const stainTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), grd = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grd.addColorStop(0, 'rgba(40,28,16,0.55)'); grd.addColorStop(0.6, 'rgba(40,28,16,0.25)'); grd.addColorStop(1, 'rgba(40,28,16,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function buildPoopMesh(p) {
  const stain = new THREE.Mesh(new THREE.PlaneGeometry(p.R * 2.6 + 5, p.R * 2.3 + 4),
    new THREE.MeshStandardMaterial({ map: stainTex, transparent: true, opacity: 0, depthWrite: false, roughness: 0.6 }));
  stain.position.set(p.x + 0.6, p.y + 0.6, 0.02); stain.receiveShadow = true; scene.add(stain);
  const z0 = p.z; p.z = 0;                                   // shape it as it will lie on the ground
  const S = p.R + 1, N = Math.round(clamp(S / 0.1, 140, 260)), pos = [], col = [], idx = [];
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
  p.z = z0;
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
  m.position.set(p.x, p.y, p.z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
  p.mesh = m; p.stain = stain;
}
// a player drops one: it falls from above, lands with a squash, and scatters whoever sat there
function dropPoop(x, y, owner, shape) {
  const p = { x, y, owner, z: 60, born: world.t, score: 0, count: 0, ...(shape || makeLumps()), anim: { phase: 'fall', t: 0, v: 0 } };
  poops.push(p);
  buildPoopMesh(p);
  scatterFrom(x, y, p.R + 3);
  return p;
}
function clearPoops() {
  for (const p of poops) {
    for (const m of [p.mesh, p.stain, p.marker]) { if (!m) continue; scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }
  poops.length = 0;
}
function stepPoops(dt) {
  for (const p of poops) {
    const A = p.anim;
    if (!A) continue;
    A.t += dt;
    if (A.phase === 'fall') {
      A.v += 520 * dt; p.z = Math.max(0, p.z - A.v * dt);
      if (p.z <= 0) { A.phase = 'squash'; A.t = 0; thud(); }
    } else {
      p.stain.material.opacity = Math.min(1, A.t / 0.25);
      if (A.t > 0.6) { p.anim = null; p.mesh.scale.set(1, 1, 1); }
    }
    const sq = A.phase === 'squash' ? 1 - 0.3 * Math.exp(-A.t / 0.09) * Math.cos(A.t * 32) : 1.08;
    p.mesh.position.z = p.z; p.mesh.scale.set(1 + (1 - sq) * 0.35, 1 + (1 - sq) * 0.35, sq);
    p.mesh.castShadow = p.z < 20;                            // no stray shadow sliver while it is high up
  }
}
// whoever sits near a spot takes off and comes back
function scatterFrom(x, y, R) {
  for (const f of flies) {
    if (f.airborne || f.hurt || f.state === 'land' || Math.hypot(f.x - x, f.y - y) > R + 3) continue;
    f.takeoff('voluntary', Math.atan2(f.y - y, f.x - x) + rnd(-0.8, 0.8), 'body');
    if (f.flight) f.flight.T = rnd(0.7, 1.8);        // it may not have got off the ground
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
// the outline of the field: droppings go inside it
{
  const m = new THREE.Mesh(new THREE.RingGeometry(PLACE_R - 0.25, PLACE_R + 0.25, 96),
    new THREE.MeshBasicMaterial({ color: 0x6b6355, transparent: true, opacity: 0.35, depthWrite: false }));
  m.position.z = 0.04; scene.add(m);
}
// the hand that shoos them (a dark looming shape)
const handMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.7, transparent: true, opacity: 0.72 }));
handMesh.scale.set(11, 7.5, 3.2); handMesh.castShadow = true; handMesh.visible = false; handMesh.renderOrder = 3; scene.add(handMesh);
// ------------------------------------------------------------------ camera: orbit around the dropping
const cam = { az: -2.0, el: 1.18, dist: 130, userZoom: false, userOrbit: false, target: new THREE.Vector3(0, 0, 1.5) };
function placeCamera() {
  const { az, el, dist, target } = cam;

  camera.position.set(target.x + Math.cos(az) * Math.cos(el) * dist, target.y + Math.sin(az) * Math.cos(el) * dist, target.z + Math.sin(el) * dist);
  camera.lookAt(target);
}
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w / h < 1 ? 55 : 36;       // portrait phones see a good deal wider
  camera.updateProjectionMatrix();
  // a tall screen wants a higher vantage, or the round field leaves big empty bands
  if (!cam.userOrbit) cam.el = camera.aspect < 1 ? 1.18 : 0.85;
  fitCamera();
}
// far enough back that the whole field is on screen — otherwise part of it cannot be tapped.
// The rim is projected for real and the distance halved in on, which beats guessing at the trigonometry.
const _fit = new THREE.Vector3();
function fitCamera() {
  if (cam.userZoom) return;
  const R = PLACE_R + 3, keep = cam.dist;
  let lo = 14, hi = 300;
  for (let k = 0; k < 20; k++) {
    const d = (lo + hi) / 2;
    cam.dist = d; placeCamera(); camera.updateMatrixWorld(true);
    let ok = true;
    for (let a = 0; a < TAU && ok; a += TAU / 24) {
      _fit.set(Math.cos(a) * R, Math.sin(a) * R, 0).project(camera);
      if (Math.abs(_fit.x) > 0.97 || Math.abs(_fit.y) > 0.97) ok = false;
    }
    if (ok) hi = d; else lo = d;
  }
  cam.dist = hi < 299 ? hi : keep;
  placeCamera();
}
new ResizeObserver(resize).observe(stage);

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
  if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    two = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }; down = null;
  }
});
view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const [px, py] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2 && two) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    cam.dist = clamp(cam.dist * two.d / d, 12, 260); cam.userZoom = true;
    cam.az -= (mx - two.mx) * 0.006; cam.el = clamp(cam.el + (my - two.my) * 0.005, 0.12, 1.45); cam.userOrbit = true;
    Object.assign(two, { d, mx, my }); return;
  }
  if (!down) return;
  const dx = e.clientX - px, dy = e.clientY - py;
  down.moved += Math.abs(dx) + Math.abs(dy);
  if (down.moved <= 10) return;
  // no shooing and no catching in this game: a drag only looks around
  cam.az -= dx * 0.006; cam.el = clamp(cam.el + dy * 0.005, 0.12, 1.45); cam.userOrbit = true;
});
view.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (down && down.moved <= 10 && performance.now() - down.t < 600) tapGround(e.clientX, e.clientY);
  down = null; if (pointers.size < 2) two = null;
});
view.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId); down = null; two = null;
});
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 12, 260); cam.userZoom = true; }, { passive: false });
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
// ------------------------------------------------------------------ the game: two players, one screen
const PLAYERS = [
  { name: '赤', css: '#e04b3c', hex: 0xe04b3c },
  { name: '青', css: '#2f74d0', hex: 0x2f74d0 },
];
const game = { phase: 'intro', left: MATCH_TIME, countIn: COUNT_IN, kills: [0, 0] };
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function startGame() {
  clearPoops(); clearCorpses(); clearSwats(); clearHitPops();
  for (let i = flies.length - 1; i >= 0; i--) {              // the wounded from the last round are cleared away
    const f = flies[i];
    if (!f.hurt) continue;
    scene.remove(f.body.root, f.body.skin); flies.splice(i, 1); net.byId.delete(f.id);
  }
  Object.assign(game, { phase: 'count', left: MATCH_TIME, countIn: COUNT_IN, kills: [0, 0], lastPip: 99 });
  cool[0] = cool[1] = 0;
  wanted = N_FLIES;                      // fixed at 30 until the match starts
  started = true;                        // the flies start arriving
  $('result').hidden = true;
  $('again').textContent = 'もう一度';
  const shapes = [];
  for (const [x, y] of BAIT) {
    const shp = makeLumps(3, 0.85);                 // never a lone speck: all three have to draw flies
    shapes.push({ lumps: shp.lumps, R: shp.R, noff: shp.noff });
    dropPoop(x, y, 0, shp);
  }
  hud();
  if (net.host) { net.send({ t: 'reset', shapes }); netSendGame(); }
}
function startMatch() {
  game.phase = 'play';
  game.endAt = performance.now() / 1000 + MATCH_TIME; game.left = MATCH_TIME;
  wanted = N_MATCH;                      // the match itself is played with more flies
  sfxStart();
  if (net.host) netSendGame();
}
function groundTarget(cx, cy) {
  const r = view.getBoundingClientRect(), p = new THREE.Vector3();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  return ray.ray.intersectPlane(groundPlane, p) ? p : null;
}
function say(msg) {
  const el = $('msg');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(say.t); say.t = setTimeout(() => el.classList.remove('show'), 1600);
}
// a tap on the ground puts the current player's dropping there
function tapGround(cx, cy) {
  // the ray meets the flat ground, which is well past a fly standing on top of a dropping —
  // so if the tap was on a fly, that fly's own spot is what was meant
  const f = flyAt(cx, cy);
  if (f && !f.leaving) return tapWorld(f.x, f.y);
  const q = groundTarget(cx, cy);
  if (q) tapWorld(q.x, q.y);
}
// a tap, in field coordinates: your own hand comes down there
function tapWorld(x, y) {
  if (game.phase !== 'play') return false;
  const by = net.on ? net.idx : 0;
  if (!canSwat(by)) return false;
  if (net.on && !net.host) { swat(x, y, by, true); net.send({ t: 'swat', x, y }); return true; }
  return swat(x, y, by);
}

// ------------------------------------------------------------------ the hand, and what it flattens
const swats = [], corpses = [], cool = [0, 0];
const CORPSE_MAX = 34;                           // the oldest are cleared away: each one is still a whole mesh
// a real fly swatter: a square mesh head in a frame, on a handle going up to whoever is holding it.
// All of it is one merged geometry, so a swing costs a single draw call and casts one latticed shadow.
function mergeBoxes(boxes) {
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const up = unit.attributes.position.array, un = unit.attributes.normal.array, ui = unit.index.array;
  const pos = [], nor = [], idx = [];
  const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), sc = new THREE.Vector3(), v = new THREE.Vector3();
  let base = 0;
  for (const [w, h, d, x, y, z, ry] of boxes) {
    m.makeRotationY(ry || 0); m.scale(sc.set(w, h, d)); m.setPosition(x, y, z);
    nm.getNormalMatrix(m);
    for (let k = 0; k < up.length; k += 3) {
      v.set(up[k], up[k + 1], up[k + 2]).applyMatrix4(m); pos.push(v.x, v.y, v.z);
      v.set(un[k], un[k + 1], un[k + 2]).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z);
    }
    for (const t of ui) idx.push(base + t);
    base += up.length / 3;
  }
  unit.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
const SWAT_BARS = [];            // the mesh bars, in the swatter's own frame: a fly between them may slip through
let SWAT_INNER = 5, SWAT_STEP = 2;
const swatGeo = (() => {
  const HEAD = SWAT_HALF * 2, TH = 0.44, RIM = 0.92, N = 5, boxes = [];
  const half = HEAD / 2, inner = half - RIM;
  SWAT_INNER = inner;
  // the square rim
  boxes.push([HEAD, RIM, TH, 0, half - RIM / 2, 0], [HEAD, RIM, TH, 0, -half + RIM / 2, 0]);
  boxes.push([RIM, HEAD - RIM * 2, TH, half - RIM / 2, 0, 0], [RIM, HEAD - RIM * 2, TH, -half + RIM / 2, 0, 0]);
  // the mesh across it, both ways
  const span = inner * 2, step = span / (N + 1);
  SWAT_STEP = step;
  for (let i = 1; i <= N; i++) {
    const t = -inner + step * i;
    SWAT_BARS.push(t);
    boxes.push([span, 0.38, TH * 0.62, 0, t, 0]);         // running left to right
    boxes.push([0.38, span, TH * 0.62, t, 0, 0]);         // and front to back
  }
  // the neck, then one handle leaning up out of it towards whoever is holding this
  boxes.push([2.2, 1.0, TH, half + 1.0, 0, 0]);
  const L = 17, phi = 0.5, x0 = half + 1.9, z0 = 0.1;
  boxes.push([L, 0.9, 0.9, x0 + Math.cos(phi) * L / 2, 0, z0 + Math.sin(phi) * L / 2, -phi]);
  boxes.push([2.2, 1.5, 1.5, x0 + Math.cos(phi) * (L - 0.8), 0, z0 + Math.sin(phi) * (L - 0.8), -phi]);
  return mergeBoxes(boxes);
})();
const swatMat = PLAYERS.map((p) => new THREE.MeshStandardMaterial({ color: p.hex, roughness: 0.62, metalness: 0.05 }));
const canSwat = (by) => game.phase === 'play' && world.t >= cool[by];
// Where the head comes to rest. Balancing it on the single highest point under the square left it
// hanging in the air over everything else, so it lies across the surface instead: a plane is fitted
// to the ground under it, tilted to match, then lifted just clear of the tallest lump.
function restPlane(x, y, rot) {
  const c = Math.cos(rot), sn = Math.sin(rot);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0], pts = [];
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const lx = i / 3 * SWAT_HALF, ly = j / 3 * SWAT_HALF;
    const h = groundZ(x + lx * c - ly * sn, y + lx * sn + ly * c);
    pts.push([lx, ly, h]);
    const row = [1, lx, ly];
    for (let a = 0; a < 3; a++) { r[a] += row[a] * h; for (let b = 0; b < 3; b++) S[a][b] += row[a] * row[b]; }
  }
  S[1][1] += 1e-3; S[2][2] += 1e-3;
  const sol = solve3(S, r);
  const bx = clamp(sol[1], -0.45, 0.45), by = clamp(sol[2], -0.45, 0.45);
  let lift = 0;
  for (const [lx, ly, h] of pts) lift = Math.max(lift, h - (sol[0] + bx * lx + by * ly));
  return { z: sol[0] + lift, bx, by };
}
// how high the mesh is directly over a point in its own frame
const meshOver = (s, lx, ly) => s.z + s.bx * lx + s.by * ly;
// `quiet` = this hand is only being drawn (a guest's own optimistic swing, or the opponent's echo)
function swat(x, y, by, quiet) {
  if (!canSwat(by)) return false;
  cool[by] = world.t + SWAT_COOL;
  const m = new THREE.Mesh(swatGeo, swatMat[by]);
  const rot = rnd(0, TAU);
  m.castShadow = true; m.renderOrder = 3;
  m.position.set(x, y, SWAT_H); scene.add(m);
  // everything nearby looks up at once; the jumpiest ones are already going
  for (const f of flies) {
    if (f.airborne || f.leaving || f.state === 'held' || f.hurt) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d > ALARM_R) continue;
    const near = d < ALARM_NEAR;
    // the ones further off catch the movement a moment later, and turn at their own pace
    f.alarmT = world.t + (near ? 0 : rnd(0.04, 0.05 + d * 0.008));
    f.alarmX = x; f.alarmY = y; f.alarmNear = near;
    f.alarmGain = near ? 1.15 : rnd(0.55, 1.0);
    // nearly all of them are already going before the mesh has started down, on top of the looming
    // response on the way and the scatter on impact: they are meant to be very hard to catch
    if (near && !f.startle && Math.random() < 0.85) {
      f.startle = { at: world.t + rnd(0.004, 0.028), dir: Math.atan2(f.y - y, f.x - x) + rnd(-0.5, 0.5) };
    }
  }
  const pl = restPlane(x, y, rot);
  _qa.setFromAxisAngle(AZ, rot);
  _qb.setFromAxisAngle(AY, -Math.atan(pl.bx));
  _qc.setFromAxisAngle(AX, Math.atan(pl.by));
  m.quaternion.copy(_qa).multiply(_qb).multiply(_qc);          // lying along the slope it landed on
  swats.push({ x, y, by, rot, rest: pl.z, bx: pl.bx, by2: pl.by, t: 0, z: SWAT_H, vz: 0, mesh: m, hit: false, done: false, pinned: [], quiet: !!quiet });
  if (net.host) net.send({ t: 'swat', x, y, by });        // so the other screen sees it swing, not just land
  return true;
}
function stepSwats(dt) {
  for (let i = swats.length - 1; i >= 0; i--) {
    const s = swats[i];
    s.t += dt;
    const z0 = s.z, u = Math.min(1, s.t / SWAT_FALL);
    s.z = s.t <= SWAT_FALL ? s.rest + (SWAT_H - s.rest) * (1 - u * u)   // accelerating down onto whatever is there
      : s.t <= SWAT_FALL + PIN_T ? s.rest                               // resting on it while what is under it fights
        : Math.min(SWAT_H, s.rest + (s.t - SWAT_FALL - PIN_T) * 170);   // then snatched back up
    s.vz = (s.z - z0) / Math.max(dt, 1e-5);
    s.mesh.position.z = s.z + 0.55;
    const mine = !s.quiet && (!net.on || net.host);
    if (mine && !s.hit) sweepSwat(s);                         // catches anything flying through the swing
    if (!s.hit && s.t >= SWAT_FALL) {
      s.hit = true;
      sfxSlap();
      if (mine) impactSwat(s);
    }
    if (!s.done && s.t >= SWAT_FALL + PIN_T) { s.done = true; if (mine) finishSwat(s); }
    if (s.t > SWAT_FALL + PIN_T + 0.4) { scene.remove(s.mesh); swats.splice(i, 1); }
  }
}
// how much clear air there is around a point under the head: 0 right under a bar, 1 in the middle of a hole
function gapAt(lx, ly) {
  const near = (v) => {
    if (Math.abs(v) > SWAT_INNER) return 0;            // out under the rim, where there is no hole at all
    let d = 1e9;
    for (const t of SWAT_BARS) d = Math.min(d, Math.abs(v - t));
    return Math.min(1, d / (SWAT_STEP / 2));
  };
  return Math.min(near(lx), near(ly));
}
// on the way down the head sweeps through the air: whatever is in its path is knocked out of flight
function sweepSwat(s) {
  const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
  for (const f of flies) {
    if (!f.airborne || f.state === 'held' || f.leaving) continue;
    const dx = f.x - s.x, dy = f.y - s.y;
    if (Math.hypot(dx, dy) > SWAT_HALF * 1.5 + f.s) continue;
    const lx = dx * c - dy * sn, ly = dx * sn + dy * c, m = SWAT_HALF + f.s * 0.25;
    if (Math.abs(lx) > m || Math.abs(ly) > m) continue;
    const over = meshOver(s, lx, ly);                         // the mesh right above this fly
    if (f.z > over + 2.0 || f.z < over - 3.0) continue;        // not in the sheet it is sweeping through
    pinDown(f, s);                                            // swatted down and carried to the ground
  }
}
// only the host does this, so both devices agree on who got whom
function impactSwat(s) {
  const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
  const d = s.dbg = { under: 0, gone: 0, outOfReach: 0, slipped: 0 };
  for (let i = flies.length - 1; i >= 0; i--) {
    const f = flies[i];
    const dx = f.x - s.x, dy = f.y - s.y;
    if (Math.hypot(dx, dy) > SWAT_HALF * 1.5 + f.s) continue;                 // cheap reject before the real test
    const lx = dx * c - dy * sn, ly = dx * sn + dy * c, m = SWAT_HALF + f.s * 0.25;
    if (Math.abs(lx) > m || Math.abs(ly) > m) continue;
    d.under++;
    if (f.airborne || f.leaving || f.state === 'held') { d.gone++; continue; }
    // the head rests on the tallest thing under it; the mesh only bends so far, so a fly further
    // down the slope (or on the flat beside a tall dropping) is out of its reach
    // it is only caught if the mesh actually came down onto it, not merely somewhere overhead
    if (groundZ(f.x, f.y) + 1.05 * f.s + SWAT_FLEX < s.rest + s.bx * lx + s.by2 * ly) { d.outOfReach++; continue; }
    // a fly that happens to be over one of the holes can dart up through the mesh — unless it is already broken
    if (!f.hurt && Math.random() < clamp((0.04 + 0.3 * gapAt(lx, ly) ** 2) * (1.5 - 0.55 * f.s), 0, 0.5)) {
      d.slipped++; slipAway(f, s); continue;
    }
    pinDown(f, s);
  }
  // everything close by that was not caught gets out of there
  for (const f of flies) {
    if (f.airborne || f.leaving || f.hurt || f.startle || f.state === 'held') continue;
    const d = Math.hypot(f.x - s.x, f.y - s.y);
    if (d > 17 || Math.random() > 0.55 - d * 0.022) continue;
    f.startle = { at: world.t + rnd(0, 0.025), dir: Math.atan2(f.y - s.y, f.x - s.x) + rnd(-0.5, 0.5) };
  }
  if (s.pinned.length) sfxSquash(Math.min(3, s.pinned.length));
}
// pinned under the mesh: legs kicking, wings buzzing, going nowhere for the moment
function pinDown(f, s) {
  f.hold();
  const h = f.held;
  h.tx = f.x; h.ty = f.y; h.tz = groundZ(f.x, f.y) + 0.5 * f.s;
  s.pinned.push(f);
}
// and now it is decided: dead, broken, or away
function finishSwat(s) {
  const got = [];
  let escaped = 0, broke = 0;
  for (const f of s.pinned) {
    const i = flies.indexOf(f);
    if (i < 0) continue;
    if (f.hurt) { got.push(f.id); squash(f, i); continue; }   // a second hit finishes what the first started
    const r = Math.random();
    if (r < P_FREE) { freeFly(f, s); escaped++; }
    else if (r < P_FREE + P_HURT) { cripple(f); broke++; }
    else { got.push(f.id); squash(f, i); }
  }
  if (got.length) {
    game.kills[s.by] += got.length;
    sfxKill(got.length);
    if (got.length > 1) hitPop(s.x, s.y, s.rest, got.length, s.by);
  }
  if (net.host && got.length) net.send({ t: 'hit', got, x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.rest.toFixed(1), by: s.by });
  if (escaped) sfxEscape();
  if (broke) sfxHurt();
  hud();
}
function slipAway(f, s) {
  f.startle = null;
  f.takeoff('escape', Math.atan2(f.y - s.y, f.x - s.x) + rnd(-0.8, 0.8), 'rule');
  if (f.flight) { f.flight.T = rnd(0.5, 1.3); f.flight.launched = true; }
  sfxEscape();
}
function freeFly(f, s) {
  f.release(rnd(-60, 60) + (f.x - s.x) * 12, rnd(-60, 60) + (f.y - s.y) * 12);
}
// alive, but it will not be flying anywhere: it drags itself along until someone finishes it
function cripple(f) {
  f.held = null; f.flight = null; f.startle = null;
  f.setState('walk');
  f.hurt = true;
  hurtLook(f);
}
function hurtLook(f) {
  f.hurt = true;
  f.wingOpen = 1; f.hurtBuzz = true;                   // wings out, and shivering
  const r = mulberry32(f.id * 7919 | 0);
  f.hurtRoll = (r() < 0.5 ? -1 : 1) * (1.0 + r() * 0.45);      // right over onto one side
  f.body.root.scale.set(f.s * 1.06, f.s * 1.06, f.s * 0.72);
}
// flattened where it stood, turned over on its back, legs curled in — and left there
function squash(f, i) {
  flies.splice(i, 1); net.byId.delete(f.id);
  f.state = 'dead'; f.dead = true; f.remote = false; f.flight = null; f.held = null; f.startle = null;
  f.hurt = false; f.settled = false;
  const b = f.body;
  for (const m of b.microchaetae) m.visible = false;
  for (const w of b.wings) for (const g of w.wing.ghosts) g.visible = false;
  b.root.scale.set(f.s * 1.16, f.s * 1.16, f.s * 0.3);            // squashed flat
  f.z = groundZ(f.x, f.y) + 0.22 * f.s;
  f.yaw += rnd(-0.6, 0.6);
  f.pitch = rnd(-0.3, 0.3);
  // it is flattened along its own back-to-belly axis, so that axis has to stay near vertical:
  // rolled onto its side it would stand up on edge instead of lying squashed
  f.roll = Math.random() < 0.55 ? Math.PI + rnd(-0.45, 0.45) : rnd(-0.45, 0.45);
  dismember(f);
  // it takes a while to stop, and how long and how hard comes from DEATHS
  const st = pickDeath();
  f.dth = { st, t: 0, span: rnd(st.span[0], st.span[1]), T: rnd(0.01, 0.08), on: true,
    hz: rnd(17, 34), dL: rnd(-1.6, 1.6) * st.leg, dR: rnd(-1.6, 1.6) * st.leg,
    buzz: Math.random() < st.buzz, jolt: rnd(-1, 1) * st.jolt,
    encore: Math.random() < 0.28 ? rnd(0.6, 2.6) : 0,             // some of them come back for one more
    x0: f.x, y0: f.y, yaw0: f.yaw, pitch0: f.pitch, roll0: f.roll };
  f.pose(0.001, 0, true);
  corpses.push(f);
  while (corpses.length > CORPSE_MAX) sweepAway(corpses.shift());
}
function sweepAway(o) {
  scene.remove(o.body.root, o.body.skin);
  for (const m of o.parts || []) scene.remove(m);
}
// the ways a fly can go: over at once, the usual, a long time about it, all wings, or all legs
const DEATHS = [
  { w: 18, span: [0.4, 1.3], on: [0.03, 0.12], off: [0.08, 0.30], buzz: 0.25, leg: 1.1, jolt: 0.7, rate: 2.4 },
  { w: 34, span: [1.8, 4.2], on: [0.04, 0.20], off: [0.12, 0.70], buzz: 0.50, leg: 1.5, jolt: 1.0, rate: 2.6 },
  { w: 20, span: [4.0, 9.5], on: [0.05, 0.30], off: [0.30, 1.70], buzz: 0.35, leg: 1.2, jolt: 0.8, rate: 2.0 },
  { w: 16, span: [2.0, 5.5], on: [0.12, 0.50], off: [0.06, 0.28], buzz: 0.90, leg: 0.5, jolt: 1.5, rate: 1.4 },
  { w: 12, span: [1.5, 4.5], on: [0.05, 0.20], off: [0.15, 0.90], buzz: 0.04, leg: 2.0, jolt: 0.5, rate: 3.2 },
];
function pickDeath() {
  let r = Math.random() * DEATHS.reduce((a, d) => a + d.w, 0);
  for (const d of DEATHS) if ((r -= d.w) <= 0) return d;
  return DEATHS[1];
}
// bits that come off: a wing torn away, the head off, legs scattered. The part is hidden on the
// body (the bone is collapsed) and a small stand-in is dropped on the ground beside it.
const partGeo = new THREE.SphereGeometry(1, 8, 6);
const partMats = new Map();
function partMat(hex, wing) {
  const key = wing ? 'wing' : hex;
  let m = partMats.get(key);
  if (!m) {
    m = wing
      ? new THREE.MeshStandardMaterial({ color: 0xeae8e2, roughness: 0.3, transparent: true, opacity: 0.55 })
      : new THREE.MeshStandardMaterial({ color: hex, roughness: 0.6 });
    partMats.set(key, m);
  }
  return m;
}
function dropPart(f, kind) {
  const m = new THREE.Mesh(partGeo, partMat(f.body.skin.material.color.getHex(), kind === 'wing'));
  const a = rnd(0, TAU), r = rnd(0.7, 3.0) * f.s;
  const x = f.x + Math.cos(a) * r, y = f.y + Math.sin(a) * r;
  if (kind === 'wing') m.scale.set(1.3 * f.s, 0.45 * f.s, 0.05 * f.s);
  else if (kind === 'head') m.scale.set(0.34 * f.s, 0.32 * f.s, 0.28 * f.s);
  else m.scale.set(0.5 * f.s, 0.075 * f.s, 0.075 * f.s);
  m.position.set(x, y, groundZ(x, y) + (kind === 'head' ? 0.3 : 0.07) * f.s);
  m.rotation.z = rnd(0, TAU);
  m.castShadow = kind === 'head';
  scene.add(m);
  (f.parts ??= []).push(m);
}
function dismember(f) {
  const b = f.body;
  if (Math.random() < 0.22) {                        // a wing torn off, sometimes both
    const both = Math.random() < 0.3, pick = Math.random() < 0.5 ? 0 : 1;
    b.wings.forEach((w, i) => {
      if (!both && i !== pick) return;
      w.obj.visible = false; w.detached = true;
      dropPart(f, 'wing');
    });
  }
  if (Math.random() < 0.09 && b.byName.c_head) {      // and once in a while the head goes
    b.byName.c_head.obj.scale.setScalar(0.015);
    dropPart(f, 'head');
  }
  if (Math.random() < 0.18) {                        // or a leg or three
    const legs = [...LEGS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
    for (const leg of legs) {
      const c = b.byName[leg + '_coxa'];
      if (!c) continue;
      c.obj.scale.setScalar(0.015);
      dropPart(f, 'leg');
    }
  }
}
// finally still: legs drawn up the way a dead fly's are, wings folded back down
function settleDead(f) {
  f.settled = true;
  f.throeBuzz = false; f.flap = 0; f.wingOpen = 0.35;
  const b = f.body;
  for (const leg of LEGS) b.setLeg(leg, FIXED_POSES[leg].tuck);
  b.update();
  f.yaw = f.dth.yaw0; f.pitch = f.dth.pitch0; f.roll = f.dth.roll0;
  f.x = f.dth.x0; f.y = f.dth.y0;
  f.pose(0.001, 0, false);
}
function clearCorpses() { for (const f of corpses) sweepAway(f); corpses.length = 0; }
// when a swing takes more than one, the number pops where it happened
const hitPops = [];
function hitPop(x, y, z, k, by) {
  const el = document.createElement('div');
  el.className = 'hitpop';
  el.style.color = PLAYERS[by] ? PLAYERS[by].css : '';
  el.textContent = '+' + k;
  stage.appendChild(el);
  hitPops.push({ el, x, y, z: z + 2.5, t: 0 });
}
function stepHitPops(dt) {
  if (!hitPops.length) return;
  const w = view.clientWidth, h = view.clientHeight;
  for (let i = hitPops.length - 1; i >= 0; i--) {
    const p = hitPops[i], u = (p.t += dt) / 0.95;
    if (u >= 1) { p.el.remove(); hitPops.splice(i, 1); continue; }
    _v3.set(p.x, p.y, p.z).project(camera);
    p.el.style.left = (_v3.x + 1) / 2 * w + 'px';
    p.el.style.top = (1 - _v3.y) / 2 * h + 'px';
    p.el.style.transform = `translate(-50%, ${-8 - 38 * u}px) scale(${1 + 0.5 * Math.min(1, u * 6) - 0.35 * u})`;
    p.el.style.opacity = String(u < 0.1 ? u / 0.1 : 1 - (u - 0.1) / 0.9);
  }
}
function clearHitPops() { for (const p of hitPops) p.el.remove(); hitPops.length = 0; }
function clearSwats() {
  for (const s of swats) {
    scene.remove(s.mesh);
    for (const f of s.pinned) if (f.state === 'held' && flies.includes(f)) f.release(0, 0);
  }
  swats.length = 0;
}
// the clock: a 3–2–1, then the match, then it is over. The kills themselves are counted as they happen.
function scoreTick(dt) {
  if (net.on && !net.host) { hud(); return; }          // the host runs the clock; we only draw it
  if (game.phase === 'count') {
    game.countIn -= dt;
    const pip = Math.ceil(game.countIn);
    if (pip !== game.lastPip) { game.lastPip = pip; if (pip > 0) sfxPip(); }
    if (game.countIn <= 0) startMatch();
  } else if (game.phase === 'play') {
    game.left = game.endAt - performance.now() / 1000;
    if (game.left <= 0) endGame();
  }
  hud();
}
function endGame() {
  game.phase = 'result'; game.left = 0;
  wanted = N_FLIES;                      // back to the fixed 30 once it is over
  clearSwats();
  showResult();
  sfxResult();
  if (net.host) netSendGame();
}
function showResult() {
  const [a, b] = game.kills, win = a === b ? -1 : a > b ? 0 : 1;
  if (solo) {
    const best = Math.max(a, bestScore());
    try { localStorage.setItem(BEST_KEY, String(best)); } catch { /* private window */ }
    $('r-title').textContent = `${a}匹`;
    $('r-title').style.color = PLAYERS[0].css;
    const grade = a >= 30 ? 'みごとな手さばき' : a >= 18 ? 'なかなかの腕' : a >= 8 ? 'まずまず' : '逃げられましたね';
    $('r-score').innerHTML = `${grade}<br><span class="best">自己ベスト ${best}匹${a >= best && a > 0 ? '（更新！）' : ''}</span>`;
    if ($('share')) $('share').hidden = false;
    $('result').hidden = false;
    return;
  }
  if ($('share')) $('share').hidden = true;
  const me = net.on ? (win === net.idx ? 'あなたの勝ち' : win < 0 ? '引き分け' : 'あなたの負け') : null;
  $('r-title').textContent = me || (win < 0 ? '引き分け' : `${PLAYERS[win].name}の勝ち`);
  $('r-title').style.color = win < 0 ? '' : PLAYERS[win].css;
  $('r-score').innerHTML = `<span style="color:${PLAYERS[0].css}">赤 ${a}匹</span> <span class="vs">—</span> <span style="color:${PLAYERS[1].css}">青 ${b}匹</span>`;
  $('result').hidden = false;
}
function hud() {
  $('s0').textContent = game.kills[0]; $('s1').textContent = game.kills[1];
  const t = $('turn'), ck = $('clock');
  if (game.phase === 'count') {
    t.textContent = 'まもなく開始 — 蠅をねらってタップ';
    ck.textContent = String(Math.max(1, Math.ceil(game.countIn)));
  } else if (game.phase === 'play') {
    t.textContent = 'タップで叩く — 気づかれると逃げられます';
    ck.textContent = `のこり ${Math.ceil(Math.max(0, game.left))}`;
  } else if (game.phase === 'result') { t.textContent = '終了'; ck.textContent = '終了'; }
  else { t.textContent = ''; ck.textContent = ''; }
  popCount();
}
// each kill as a +1 / +3 that floats up out of the number
let lastCount = [0, 0], lastPhase = '';
function popCount() {
  if (game.phase !== lastPhase) { lastPhase = game.phase; lastCount = game.kills.slice(); return; }
  for (let i = 0; i < 2; i++) {
    const d = game.kills[i] - lastCount[i];
    if (!d) continue;
    const el = document.createElement('span');
    el.className = 'pop ' + (d > 0 ? 'up' : 'dn');
    el.textContent = (d > 0 ? '+' : '−') + Math.abs(d);
    $('p' + i).appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
  lastCount = game.kills.slice();
}
on('again', 'click', () => {
  if (net.walkover) { net.walkover = false; $('again').textContent = 'もう一度'; return backToLobby(''); }
  if (net.on && !net.host) { net.send({ t: 'again' }); say('あいてを待っています…'); return; }
  startGame();
});

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
  const f = [...left].reverse().find((o) => o.state !== 'held' && !o.hurt);
  if (!f) {                                  // only broken ones left: they simply crawl out of the picture
    const h = [...left].reverse().find((o) => o.hurt);
    if (!h) return;
    const i = flies.indexOf(h);
    if (i >= 0) { scene.remove(h.body.root, h.body.skin); flies.splice(i, 1); net.byId.delete(h.id); }
    return;
  }
  f.leaving = true;
  if (!f.airborne) f.takeoff('voluntary', Math.atan2(f.y, f.x) + rnd(-0.5, 0.5), 'body');
  Object.assign(f.flight, { phase: 'leave', reach: false, final: false, saccade: true, wp: { x: Math.cos(Math.atan2(f.y, f.x)) * 140, y: Math.sin(Math.atan2(f.y, f.x)) * 140 }, U: 220, h: 22 });
}
function dropGone() {
  if (net.on && !net.host) return;                     // the host decides who has left
  for (let i = flies.length - 1; i >= 0; i--) {
    const f = flies[i];
    if (!f.leaving || Math.hypot(f.x, f.y) < 95) continue;
    scene.remove(f.body.root, f.body.skin); flies.splice(i, 1);
  }
}
// newcomers arrive one after another; extra flies leave one after another
let arriveT = 0;
let started = false;       // flies only come once the dropping has landed
function balance(dt) {
  if (!started || (net.on && !net.host)) return;
  const n = staying().length;
  if (n > wanted) { for (let k = n; k > wanted; k--) removeFly(); return; }
  if (n < wanted && (arriveT -= dt) <= 0) { addFly(); arriveT = n < 12 ? rnd(0.15, 0.5) : rnd(0.03, 0.12); }
}
// how many flies is not up to the players: 30 outside the match, N_MATCH during it (see startWatch)

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
// short synthesized cues: a rising whistle when the match starts, a fanfare or a sigh when it ends
function tone(f0, f1, t0, dur, type, vol, filt) {
  const ctx = audio.ctx; if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.25));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let last = g;
  if (filt) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = filt; g.connect(lp); last = lp; }
  o.connect(g); last.connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
function sfxStart() {                              // スタート！ — three rising pips and a little whistle up
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  [880, 1108.7, 1318.5].forEach((f, i) => tone(f, f, t + i * 0.09, 0.085, 'triangle', 0.3));
  tone(1318.5, 2093, t + 0.28, 0.26, 'square', 0.16, 3000);
}
function sfxWin() {                                // 勝ち — a bright major arpeggio that keeps climbing
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  [523.3, 659.3, 784, 1046.5].forEach((f, i) => {
    tone(f, f, t + i * 0.105, 0.16, 'triangle', 0.32);
    tone(f * 2, f * 2, t + i * 0.105, 0.12, 'square', 0.07, 4000);
  });
  tone(1046.5, 1568, t + 0.44, 0.5, 'triangle', 0.28);
}
function sfxLose() {                               // 負け — the same shape, walked down and flattened
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  [392, 349.2, 311.1, 261.6].forEach((f, i) => tone(f, f, t + i * 0.14, 0.22, 'sawtooth', 0.2, 1200));
  tone(261.6, 196, t + 0.58, 0.7, 'sawtooth', 0.2, 900);
}
function sfxPip() {                                 // 3…2…1
  const ctx = audio.ctx; if (!ctx) return;
  tone(880, 880, ctx.currentTime + 0.01, 0.09, 'triangle', 0.26);
}
function sfxSlap() {                               // the hand hitting the ground: a dry, flat smack
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.01, n = Math.floor(ctx.sampleRate * 0.07);
  const b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.011));
  const src = ctx.createBufferSource(); src.buffer = b;
  const bp = ctx.createBiquadFilter(), g = ctx.createGain();
  bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.8; g.gain.value = 0.5;
  src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t);
  tone(150, 60, t, 0.09, 'sine', 0.35);
}
function sfxSquash(k) {                            // something is under there, thrashing
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.03;
  tone(620 + 70 * Math.min(k, 5), 420, t, 0.1, 'square', 0.15, 2200);
}
function sfxKill(k) {                             // and the wet little pop when it stops
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  tone(520 + 60 * Math.min(k, 5), 170, t, 0.14, 'square', 0.24, 2000);
  tone(260, 100, t + 0.02, 0.18, 'sawtooth', 0.18, 800);
}
function sfxEscape() {                            // a thin rising whip: that one got away
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.01;
  tone(700, 1750, t, 0.14, 'triangle', 0.14, 5000);
}
function sfxHurt() {                              // a sagging note: still alive, but only just
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  tone(430, 250, t, 0.22, 'sawtooth', 0.17, 1100);
}
function sfxDraw() {                               // 引き分け — two flat notes, neither way
  const ctx = audio.ctx; if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  tone(440, 440, t, 0.22, 'triangle', 0.26);
  tone(440, 440, t + 0.3, 0.4, 'triangle', 0.22);
}
// 終了！ — whoever it went to decides which of the three plays
function sfxResult() {
  if (solo) return sfxWin();
  const [a, b] = game.kills, win = a === b ? -1 : a > b ? 0 : 1;
  if (win < 0) return sfxDraw();
  if (net.on) return win === net.idx ? sfxWin() : sfxLose();
  sfxWin();                                        // one phone: someone won, and they are both here
}
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
// ------------------------------------------------------------------ the lobby: one phone, or two over the net
function beginPlay() {
  startAudio();
  flyBy();
  $('lobby').hidden = true;
  $('app').classList.add('playing');
  resize();
}
function showWaiting() {
  if (!$('lobby-wait')) return;
  $('lobby-menu').hidden = true;
  $('lobby-wait').hidden = false;
  netStatus('あいてを探しています', true);
}
on('btn-local', 'click', () => {
  solo = true;
  document.body.classList.add('solo');
  beginPlay();
  startGame();
});
on('btn-online', 'click', () => {
  startAudio();
  $('lobby-menu').hidden = true;
  $('lobby-wait').hidden = false;
  netStart('');                                    // whoever is waiting: no code to agree on first
});
on('btn-back', 'click', () => backToLobby(''));
on('share', 'click', shareResult);
// the opponent dropped in the middle of a match: tell them, and hand them the win
function walkover() {
  game.phase = 'result'; game.left = 0; wanted = N_FLIES;
  net.walkover = true; net.on = false;
  if (net.ws) { try { net.ws.close(); } catch { /* already gone */ } net.ws = null; }
  $('r-title').textContent = '不戦勝';
  $('r-title').style.color = PLAYERS[net.idx] ? PLAYERS[net.idx].css : '';
  $('r-score').textContent = 'あいてがオフラインになりました';
  $('again').textContent = '最初の画面へ';
  $('result').hidden = false;
  say('あいてがオフラインになりました — 不戦勝です');
  sfxWin();
  hud();
}
// back to the first screen: after a cancel, an opponent leaving, or the line going down
function backToLobby(msg) {
  if (SOLO60) return;                              // the front page has nowhere else to go
  solo = false; document.body.classList.remove('solo');
  if (net.ws) { try { net.ws.close(); } catch { /* already gone */ } net.ws = null; }
  net.on = false; net.host = false; net.idx = -1; net.byId.clear();
  $('result').hidden = true;
  $('lobby-wait').hidden = true; $('lobby-menu').hidden = false; $('lobby').hidden = false;
  $('app').classList.remove('playing');
  netStatus(msg || '');
}

let solo = SOLO60;                                 // playing alone: only the red side is on screen
if (SOLO60) document.body.classList.add('solo');
// ------------------------------------------------------------------ online: the host runs the field, the guest draws it
// One binary frame per snapshot (Float32: a header count, then 11 numbers per fly), and small JSON
// messages for everything that happens once — a dropping, the score, the end of the match.
const ST = ['walk', 'feed', 'groom', 'rub', 'land', 'takeoff', 'flight', 'landing', 'held'];
const STI = Object.fromEntries(ST.map((v, i) => [v, i]));
const PER = 11, SNAP_HZ = 12;

const net = {
  ws: null, on: false, host: false, idx: -1, room: '', byId: new Map(), seen: new Set(), sendT: 0,
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
  bin(b) { if (this.ws && this.ws.readyState === 1) this.ws.send(b); },
};
let snapBuf = null;

function netSendGame() {
  net.send({ t: 'g', ph: game.phase, ki: game.kills.slice(), lf: Math.max(0, game.left), ci: game.countIn });
}
function netSendSnapshot() {
  const n = flies.length, need = 1 + n * PER;
  if (!snapBuf || snapBuf.length < need) snapBuf = new Float32Array(need + 22 * PER);
  const a = snapBuf; a[0] = n;
  let o = 1;
  for (const f of flies) {
    const F = f.flight;
    let bits = 0;
    if (F) { if (F.launched) bits |= 1; if (F.reach) bits |= 2; if (F.pushing) bits |= 4; if (F.flapOn) bits |= 8; if (F.wingsUp) bits |= 16; if (F.mode === 'escape') bits |= 32; }
    if ((f.held && f.held.buzz) || (f.hurt && f.hurtBuzz)) bits |= 64;
    if (f.rubHind) bits |= 128;
    if (f.leaving) bits |= 256;
    if (f.hurt) bits |= 512;
    a[o] = f.id; a[o + 1] = STI[f.state] ?? 0; a[o + 2] = bits;
    a[o + 3] = f.x; a[o + 4] = f.y; a[o + 5] = f.z;
    a[o + 6] = f.yaw; a[o + 7] = f.pitch; a[o + 8] = f.roll;
    a[o + 9] = f.dL; a[o + 10] = f.dR;
    o += PER;
  }
  net.bin(a.buffer.slice(0, need * 4));
}
function netApplySnapshot(buf) {
  if (!J) return;
  const a = new Float32Array(buf), n = a[0] | 0, seen = net.seen;
  seen.clear();
  let o = 1, born = 0;
  for (let i = 0; i < n; i++, o += PER) {
    const id = a[o] | 0;
    let f = net.byId.get(id);
    if (!f) {
      if (born >= 4) continue;                           // a few new bodies per frame: building 50 at once stutters
      born++;
      f = new Fly(id);
      f.remote = true;
      f.net = { x: a[o + 3], y: a[o + 4], z: a[o + 5], yaw: a[o + 6], pitch: a[o + 7], roll: a[o + 8] };
      Object.assign(f, f.net);
      f.flight = { launched: true, reach: false, pushing: false, flapOn: false, wingsUp: false, mode: 'voluntary' };
      f.held = { buzz: false };
      scene.add(f.body.root, f.body.skin); flies.push(f); net.byId.set(id, f);
    }
    seen.add(id);
    const st = ST[a[o + 1] | 0] || 'walk', bits = a[o + 2] | 0, F = f.flight;
    if (f.state !== st) { f.state = st; f.stateT = 0; }
    F.launched = !!(bits & 1); F.reach = !!(bits & 2); F.pushing = !!(bits & 4);
    F.flapOn = !!(bits & 8); F.wingsUp = !!(bits & 16); F.mode = bits & 32 ? 'escape' : 'voluntary';
    f.held.buzz = f.hurtBuzz = !!(bits & 64); f.rubHind = !!(bits & 128); f.leaving = !!(bits & 256);
    if (bits & 512 && !f.hurt) hurtLook(f);
    const t = f.net;
    t.x = a[o + 3]; t.y = a[o + 4]; t.z = a[o + 5]; t.yaw = a[o + 6]; t.pitch = a[o + 7]; t.roll = a[o + 8];
    f.dL = a[o + 9]; f.dR = a[o + 10];
  }
  for (let i = flies.length - 1; i >= 0; i--) {
    const f = flies[i];
    if (seen.has(f.id)) continue;
    scene.remove(f.body.root, f.body.skin); flies.splice(i, 1); net.byId.delete(f.id);
  }
}
function netMessage(m) {
  if (m.t === 'reset') {                                  // the host laid out the bait: build the same three
    clearPoops(); clearCorpses(); clearSwats(); clearHitPops();
    for (const [i, [x, y]] of BAIT.entries()) dropPoop(x, y, 0, m.shapes[i]);
    $('result').hidden = true; $('again').textContent = 'もう一度'; started = true;
  } else if (m.t === 'g') {
    const was = game.phase;
    game.phase = m.ph; game.kills = m.ki; game.left = m.lf; game.countIn = m.ci;
    if (game.phase !== was) {
      if (game.phase === 'result') { wanted = N_FLIES; clearSwats(); showResult(); sfxResult(); }
      else {
        $('result').hidden = true;
        if (game.phase === 'play') { wanted = N_MATCH; sfxStart(); }
      }
    } else if (game.phase === 'count') {
      const pip = Math.ceil(game.countIn);
      if (pip !== game.lastPip) { game.lastPip = pip; if (pip > 0) sfxPip(); }
    }
    hud();
  } else if (m.t === 'swat') {
    if (net.host) { swat(m.x, m.y, 1); return; }           // the guest swung: resolve it here
    if (m.by !== net.idx) swat(m.x, m.y, m.by, true);      // the opponent's hand, for us to watch
  } else if (m.t === 'hit') {                              // which flies the host's swing caught
    for (const id of m.got) {
      const f = net.byId.get(id), i = flies.indexOf(f);
      if (f && i >= 0) squash(f, i);
    }
    if (m.got.length) sfxKill(m.got.length);
    if (m.got.length > 1) hitPop(m.x, m.y, m.z, m.got.length, m.by);
  } else if (m.t === 'again') {
    if (net.host) startGame();
  }
}
function netStatus(text, spin) {
  const el = $('lobby-status');
  if (el) { el.textContent = text || ''; el.classList.toggle('spin', !!spin); }
}
function netStart(room) {
  net.room = room || '';
  netStatus('つないでいます…', true);
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/';
  let ws;
  try { ws = new WebSocket(url); } catch { return netStatus('接続できませんでした'); }
  net.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { net.send({ t: 'join', room: net.room, game: 'tataki' }); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return netApplySnapshot(ev.data);
    let m = null;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'waiting') {
      net.room = m.room;
      showWaiting();
    } else if (m.t === 'start') {
      net.on = true; net.idx = m.idx; net.host = m.idx === 0; net.room = m.room;
      beginPlay();
      if (net.host) startGame(); else { started = true; hud(); }
      say(net.host ? 'あなたは赤（先手）' : 'あなたは青（後手）');
    } else if (m.t === 'host') {
      net.idx = 0; net.host = true;
    } else if (m.t === 'err') {
      netStatus(m.msg || 'エラー');
    } else if (m.t === 'peer-left') {
      if (game.phase === 'place' || game.phase === 'watch') walkover();
      else backToLobby('あいてが退出しました');
    } else netMessage(m);
  };
  ws.onclose = () => { if (net.on) backToLobby('接続が切れました'); else netStatus('接続できませんでした'); };
  ws.onerror = () => netStatus('接続できませんでした');
}

// ------------------------------------------------------------------ your best, and posting it
function bestScore() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function shareResult() {
  const a = game.kills[0];
  const text = `ハエたたき：1分で ${a}匹 たたきました。\n#ハエたたき`;
  const url = 'https://hae.satoru.net/';
  if (navigator.share) {
    navigator.share({ title: 'ハエたたき', text, url }).catch(() => { /* the sheet was dismissed */ });
    return;
  }
  window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text + '\n' + url), '_blank', 'noopener');
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), acc = 0, stepN = 0, frameN = 0, scoreAcc = 0;
const stats = { step: 0, pose: 0, render: 0, sim: 0, frames: 0 };
function frame(now) {
  const wall = (now - last) / 1000, dtReal = Math.min(0.1, wall); last = now;
  let simDt = 0;
  if (J) {                                 // body data loaded (flies may still be on their way)
    acc = Math.min(acc + dtReal, 0.2);
    const t0 = performance.now();
    while (acc >= H) {
      acc -= H; simDt += H; world.t += H;
      for (const f of flies) f.step(H);
      if (Math.round(world.t * 1000) % 20 === 0) for (const f of flies) if (!f.remote) f.decideRule(0.02);
      for (const f of corpses) if (!f.settled) f.step(H);
      if (++stepN % 4 === 0) { stepSwats(4 * H); crowd(4 * H); dropGone(); balance(4 * H); }
      const h = world.hand;
      if (h) {
        const k = 1 - Math.exp(-H / 0.03), ox = h.x, oy = h.y, oz = h.z;
        if (h.lift) { h.x += h.vx * H; h.y += h.vy * H; h.z += 140 * H; h.vx *= 0.995; h.vy *= 0.995; }
        else { h.x += (h.tx - h.x) * k; h.y += (h.ty - h.y) * k; h.z += (HAND_Z - h.z) * (1 - Math.exp(-H / 0.06)); }
        h.vx = (h.x - ox) / H; h.vy = (h.y - oy) / H; h.vz = (h.z - oz) / H;
        if (h.z > HAND_Z + 45) world.hand = null;
      }
    }
    const t1 = performance.now();
    stepPoops(dtReal);
    if ((scoreAcc += wall) >= 0.2) { scoreTick(scoreAcc); scoreAcc = 0; if (net.host) netSendGame(); }
    if (net.host && (net.sendT -= dtReal) <= 0) { net.sendT = 1 / SNAP_HZ; netSendSnapshot(); }
    const blur = clamp((WINGBEAT * simDt - 0.15) / 0.35, 0, 1);
    const many = flies.length > 30; frameN++;
    flies.forEach((f, i) => f.pose(simDt, blur, !many || ((i + frameN) & 1) === 0));
    for (const f of corpses) if (!f.settled) f.pose(simDt, blur, true);
    const t2 = performance.now();
    const h = world.hand; handMesh.visible = !!h;
    if (h) { handMesh.position.set(h.x, h.y, h.z); if (Math.hypot(h.vx, h.vy) > 20) handMesh.rotation.z = Math.atan2(h.vy, h.vx); }
    updateAudio();
    stepHitPops(dtReal);
    for (const f of flies) for (const m of f.body.microchaetae) m.visible = cam.dist < 30;
    placeCamera();
    renderer.render(scene, camera);
    const t3 = performance.now(), st = stats;
    st.step += t1 - t0; st.pose += t2 - t1; st.render += t3 - t2; st.sim += simDt; st.frames++;   // totals (divide by frames)
  }
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
window.__game = { world, flies, cam, stats, renderer, audio, game, poops, net, swats, corpses, startGame, swat, tapWorld, endGame, beginPlay, gapAt, cripple, groundAt: groundZ, project: (f) => new THREE.Vector3(f.x, f.y, f.z).project(camera).toArray() };
requestAnimationFrame(frame);
