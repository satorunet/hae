// The male: a second NeuroMechFly body in the female's scene, courting her.
//
// There is no 3D model of a male fly (NeuroMechFly is a CT scan of a female),
// so this one is the same body made smaller (0.85x) with the dark tip of the
// abdomen that males have. His behaviour is a hand-written script - the male
// brain (FlyEM male CNS) is not in this prototype yet:
//
//   approach -> tap her with a foreleg -> sing (one wing out, vibrating) ->
//   if she stands still for him: mount and copulate -> dismount
//   if she keeps not accepting: give up for a while, then try again
//
// Walking is the same CPG + locomotion map the female uses.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LEGS } from '../test03/body3d.js?v=6';
import { poseDying, tuckAngles } from './growth.js?v=33';
import { waveTexture, createBeam, wingPoint } from './song.js?v=3';
import { HUNGRY_S } from './food.js?v=6';

const NMF = new URL('../test03/nmf/', import.meta.url).href;
export const MALE_SCALE = 0.85;
export const COPULATE_S = 15;              // on screen; real copulation lasts about 20 minutes
const START_D = 8;                          // where he is when he appears, mm from her
const START_WAIT = 3;                       // seconds before he sets off toward her
const COURT_D = 2.7;                        // how far from her centre he courts, mm (a body length is about 2.7)
const GIVE_UP_S = 14;                       // singing this long without her standing still: he gives up
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const approach = (v, to, dt, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));
const rnd = (a, b) => a + Math.random() * (b - a);
const AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

export const MALE_STATE_TEXT = {
  hidden: '', dead: '死んだ（寿命）', wander: 'うろうろしている', approach: 'メスに近づいている', tap: '前脚でメスをたたいている（フェロモンを味で確かめる）',
  sing: '片翅を広げて歌っている', toFood: '餌へ向かっている', feed: '餌を食べている', fly: '飛んでいる', mount: 'メスに乗ろうとしている', copulate: '交尾中', dismount: '離れている', giveup: 'あきらめた（しばらく求愛しない）',
};

const WAVE_EVERY = { pulse: 0.105, sine: 0.14 };   // a new stretch of song this often (s)
const WAVE_FLIGHT = 0.75;                           // seconds from his wing to her head

export class MaleFly {
  constructor(female) {
    this.f = female;
    this.ready = false;
    this.visible = false;
    this.state = 'hidden'; this.stateT = 0;
    this.x = 3; this.y = 2; this.yaw = Math.PI;
    this.dL = 0; this.dR = 0;
    this.sing = 0;                  // 0..1, the wing held out
    this.pulse = 0;                 // the wing's vibration right now
    this.mountW = 0;
    this.songType = 'pulse';        // real males alternate pulse song with short bouts of sine song
    this.songT = 2;
    this.t = 0;
    this.onCopulated = null;        // called when a copulation ends
  }

  async load() {
    const { J, bin } = await loadFlyData(NMF, '?v=6');
    this.body = new FlyBody(J, bin, { ghosts: 4 });   // blurred copies of the wing while it vibrates
    this.body.root.scale.setScalar(MALE_SCALE);
    // males: the last abdominal segments are dark all over
    for (const name of ['c_abdomen5', 'c_abdomen6']) {
      const b = this.body.byName[name];
      if (!b?.mesh) continue;
      const m = b.mesh.material.clone();
      m.color.setRGB(0.22, 0.17, 0.13);
      b.mesh.material = m;
    }
    this.cpg = new CPG(J);
    this.neutral = LEGS.map((_, i) => this.cpg.neutral(i));
    LEGS.forEach((leg, i) => this.body.setLeg(leg, this.neutral[i]));
    this.z0 = -this.body.legTip('lm')[2] * MALE_SCALE;
    this.body.root.visible = false;
    this.f.scene.add(this.body.root);
    this.waveTex = { pulse: waveTexture('pulse'), sine: waveTexture('sine') };
    this.waves = Array.from({ length: 16 }, () => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.waveTex.pulse, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.visible = false; sp.life = 0; sp.renderOrder = 10;
      this.f.scene.add(sp);
      return sp;
    });
    this.waveT = 0;
    this.beam = createBeam(this.f.scene);
    this.ready = true;
    return this;
  }

  show(on) {
    this.visible = on;
    if (!this.ready) return;
    this.body.root.visible = on;
    if (!on) { for (const w of this.waves) w.visible = false; this.beam?.update(1, false); }
    if (on) {                                        // he starts well away from her, pauses, then walks over
      // across the view from her (not in line with the camera, where the two would overlap)
      const a = this.f.camAng + (Math.PI / 2 + rnd(-0.3, 0.3)) * (Math.random() < 0.5 ? 1 : -1);
      this.x = this.f.x + Math.cos(a) * START_D; this.y = this.f.y + Math.sin(a) * START_D;
      this.yaw = a + Math.PI + rnd(-0.8, 0.8);
      this.set('wander'); this.stateT = 6 - START_WAIT;
    } else this.set('hidden');
  }
  startFlight(x, y, then) { const d = Math.hypot(x - this.x, y - this.y); this.fl = { x0: this.x, y0: this.y, x1: x, y1: y, t: 0, T: 0.9 + d * 0.16, h: 1.4 + d * 0.22, then }; this.set('fly'); }
  leaveFood() { if (this.food) this.food.eaters = Math.max(0, this.food.eaters - 1); this.food = null; this.set(this.after || 'wander'); }
  set(s) { this.state = s; this.stateT = 0; if (s === 'sing') { this.songType = 'pulse'; this.songT = rnd(1.5, 3); } }

  /** Where the song comes from, as the female hears it: side (-1 left .. 1 right) and loudness (0..1). */
  songFor() {
    const dx = this.x - this.f.x, dy = this.y - this.f.y, d = Math.hypot(dx, dy);
    const rel = wrap(Math.atan2(dy, dx) - this.f.yaw);
    return { side: clamp(-Math.sin(rel), -1, 1), gain: clamp(2.6 / Math.max(d, 1.2), 0, 1) };
  }
  get singing() { return this.visible && !this.dead && this.state === 'sing' && this.sing > 0.7; }
  die() { this.dead = true; this.set('dead'); this.beam?.update(1, false); for (const w of this.waves || []) { w.visible = false; w.life = 0; } }

  /**
   * One frame. `receptive` is the female's vpoDN, as a fraction of the stand-still threshold;
   * `clock` is the real time that passed (the script keeps to it even when frames are slow).
   */
  step(dt, receptive, mated, clock = dt) {
    if (!this.ready || !this.visible) return;
    if (this.dead) {                                  // on his back where he fell
      for (const w of this.body.wings) w.wing.ghosts.forEach((g) => { g.visible = false; });
      this.deadT = (this.deadT || 0) + dt;
      poseDying(this.body, this.x, this.y, this.yaw, this.z0, MALE_SCALE, this.deadT);
      return;
    }
    this.t += dt; this.stateT += clock;
    const F = this.f, dx = F.x - this.x, dy = F.y - this.y, dist = Math.hypot(dx, dy);
    const toHer = Math.atan2(dy, dx);
    let goal = null, face = null;                   // a point to walk to, a heading to turn to

    this.hunger = (this.hunger ?? 0.4) + clock / HUNGRY_S;
    const free = this.state === 'wander' || this.state === 'giveup';
    // hungry: food before courting (not once he is mounting or mating)
    const canLeave = free || ['approach', 'tap', 'sing'].includes(this.state);
    if (canLeave && this.foods && (this.stateT > 1 || !free) && this.hunger > 1) {
      const food = this.foods.nearest(this.x, this.y);
      if (food) { this.food = food; food.eaters++; const d = Math.hypot(food.x - this.x, food.y - this.y); this.after = free ? this.state : 'wander'; if (d > 5) this.startFlight(food.x - (food.x - this.x) / d * 1.1, food.y - (food.y - this.y) / d * 1.1, 'toFood'); else this.set('toFood'); }
    } else if (free && this.foods && this.stateT > 1) {
      if (Math.random() < clock * 0.02) { const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 4; this.after = this.state; this.startFlight(F.x + Math.cos(a) * r, F.y + Math.sin(a) * r, this.state); }
    }
    switch (this.state) {
      case 'fly': {
        const L = this.fl; L.t += clock;
        const u = clamp(L.t / L.T, 0, 1), e = u * u * (3 - 2 * u);
        this.x = L.x0 + (L.x1 - L.x0) * e; this.y = L.y0 + (L.y1 - L.y0) * e;
        this.yaw += wrap(Math.atan2(L.y1 - L.y0, L.x1 - L.x0) - this.yaw) * Math.min(1, dt * 6);
        this.alt = Math.sin(Math.PI * u) * L.h;
        if (u >= 1) { this.alt = 0; this.set(L.then); this.fl = null; }
        break;
      }
      case 'toFood': {
        const f = this.food;
        if (!f || f.amount <= 0 || this.stateT > 12) { this.leaveFood(); break; }
        goal = [f.x, f.y];
        if (Math.hypot(f.x - this.x, f.y - this.y) < 1.2) { this.set('feed'); goal = null; }
        break;
      }
      case 'feed': {
        const f = this.food;
        if (!f || f.amount <= 0 || this.stateT > 4) { this.leaveFood(); break; }
        face = Math.atan2(f.y - this.y, f.x - this.x);
        if (!this.foods.eat(f, clock)) { this.hunger = 0; this.leaveFood(); }   // eaten up: full
        break;
      }
      case 'wander':
        if (this.stateT > 6) this.set('approach');
        else if (dist < 5) goal = [F.x - dx / dist * 5, F.y - dy / dist * 5];
        break;
      case 'giveup':
        if (dist < 4.5) goal = [F.x - dx / dist * 5.5, F.y - dy / dist * 5.5];
        if (this.stateT > 9) this.set('approach');
        break;
      case 'approach': {
        // to a spot beside her, on the side he is already on, a little behind her head
        const around = Math.atan2(this.y - F.y, this.x - F.x);
        goal = [F.x + Math.cos(around) * COURT_D, F.y + Math.sin(around) * COURT_D];
        if (dist < COURT_D + 0.35) this.set('tap');
        break;
      }
      case 'tap':
        face = toHer;
        if (dist > COURT_D + 1.2) this.set('approach');
        else if (this.stateT > 1.1) this.set('sing');
        break;
      case 'sing':
        face = toHer;
        this.songT -= clock;
        if (this.songT <= 0) {
          this.songType = this.songType === 'sine' || Math.random() < 0.6 ? 'pulse' : 'sine';
          this.songT = this.songType === 'sine' ? rnd(0.6, 1.3) : rnd(1.5, 3.5);
        }
        if (dist > COURT_D + 1.0) goal = [F.x - dx / dist * COURT_D, F.y - dy / dist * COURT_D];   // she moved off: follow, still singing
        this.acceptT = receptive >= 1 ? (this.acceptT || 0) + clock : 0;
        if (this.acceptT > 1.5) this.set('mount');
        else if (this.stateT > GIVE_UP_S) { this.set('giveup'); this.onReject?.(new THREE.Vector3(this.x, this.y, 1.6)); }
        break;
      case 'mount': {
        // round to her rear, facing the way she faces
        const back = [F.x - Math.cos(F.yaw) * 2.2, F.y - Math.sin(F.yaw) * 2.2];
        const d = Math.hypot(back[0] - this.x, back[1] - this.y);
        if (d > 0.45 && this.stateT < 6) goal = back;
        else { this.set('copulate'); this.onMate?.(new THREE.Vector3(F.x, F.y, F.z0 + 1.6)); }
        break;
      }
      case 'copulate':
        if (this.stateT > COPULATE_S) { this.set('dismount'); this.onCopulated?.(); }
        break;
      case 'dismount':
        if (this.stateT > 1.2) this.set('wander');
        break;
    }

    // ------------------------------------------------ walking (or turning on the spot)
    const onHer = this.state === 'copulate' || (this.state === 'dismount' && this.stateT < 0.8);
    let wantL = 0, wantR = 0;
    if (goal && !onHer) {
      const turn = clamp(wrap(Math.atan2(goal[1] - this.y, goal[0] - this.x) - this.yaw) * 1.1, -0.85, 0.85);
      wantL = 1 - Math.max(0, turn); wantR = 1 + Math.min(0, turn);
    } else if (face != null && !onHer) {
      const turn = wrap(face - this.yaw);
      if (Math.abs(turn) > 0.25) { wantL = -0.45 * Math.sign(turn); wantR = 0.45 * Math.sign(turn); }
    }
    this.dL = approach(this.dL, wantL, dt, 0.15);
    this.dR = approach(this.dR, wantR, dt, 0.15);
    this.cpg.step(dt, this.dL, this.dR);
    if (!onHer && this.state !== 'fly' && Math.abs(this.dL) + Math.abs(this.dR) > 0.05) {
      const v = this.f.loco.at(this.dL, this.dR);
      this.yaw += v.wz * dt;
      this.x += (Math.cos(this.yaw) * v.vx - Math.sin(this.yaw) * v.vy) * dt * MALE_SCALE;
      this.y += (Math.sin(this.yaw) * v.vx + Math.cos(this.yaw) * v.vy) * dt * MALE_SCALE;
    }
    // never walk through her
    const keep = this.state === 'mount' ? 1.3 : 2.3;
    if (!onHer && dist < keep) {
      const push = (keep - dist) / Math.max(dist, 1e-3);
      this.x -= dx * push * 0.5; this.y -= dy * push * 0.5;
    }

    // ------------------------------------------------ legs
    const a = this._a ??= new Array(7);
    LEGS.forEach((leg, i) => {
      this.cpg.angles(i, a);
      this.body.setLeg(leg, a);
      const front = leg[1] === 'f', sgn = leg[0] === 'l' ? 1 : -1;
      if (front && this.state === 'tap') {           // the forelegs reach out and pat her
        const tgt = [1.15, sgn * 0.22, -0.5 + 0.18 * Math.max(0, Math.sin(this.t * 9 + (sgn > 0 ? 0 : 1.6)))];
        this.body.setLeg(leg, this.body.ik(leg, tgt, this.body.getLeg(leg), this.neutral[i], 4, 0.02));
      }
      if (front && onHer) {                          // holding on to her
        const tgt = [0.75, sgn * 0.55, -0.35];
        this.body.setLeg(leg, this.body.ik(leg, tgt, this.body.getLeg(leg), this.neutral[i], 4, 0.02));
      }
    });

    // ------------------------------------------------ pose on the ground, or on her back
    this.mountW = approach(this.mountW, onHer ? 1 : 0, dt, 0.35);
    const m = this.mountW;
    let px = this.x, py = this.y, pz = this.z0 + (this.alt || 0), yaw = this.yaw, pitch = this.state === 'fly' ? 0.12 : 0;
    if (m > 0.001) {
      // on her back, over her abdomen, facing her way
      // his thorax over the front of her abdomen, resting on her back (her thorax top is 0.44 above her root, his underside 0.54 below his)
      const ox = F.x - Math.cos(F.yaw) * 1.0, oy = F.y - Math.sin(F.yaw) * 1.0;
      px += (ox - px) * m; py += (oy - py) * m; pz += (F.z0 + 0.9 - pz) * m;
      yaw = this.yaw + wrap(F.yaw - this.yaw) * m;
      pitch = -0.18 * m;
      if (m > 0.98) { this.x = ox; this.y = oy; this.yaw = F.yaw; }
    }
    const q = this._q ??= new THREE.Quaternion(), q2 = this._q2 ??= new THREE.Quaternion();
    q.setFromAxisAngle(AZ, yaw);
    q2.setFromAxisAngle(AY, pitch);
    this.body.root.quaternion.copy(q).multiply(q2);
    this.body.root.position.set(px, py, pz);

    // the abdomen curls down and forward to her while mounted
    const j = this.body.joints;
    const curl = -0.32 * m;                          // negative pitch bends it down
    // eating: proboscis down onto the food; flying: legs folded
    this.prob = approach(this.prob || 0, this.state === 'feed' ? 1 : 0, dt, 0.12);
    if (j['c_head-c_rostrum-pitch']) j['c_head-c_rostrum-pitch'].q = -1.25 * this.prob + this.prob * 0.2 * Math.sin(this.t * 8.3);
    if (j['c_rostrum-c_haustellum-pitch']) j['c_rostrum-c_haustellum-pitch'].q = -1.6 * this.prob + this.prob * 0.4 * Math.sin(this.t * 15.5);
    if (this.state === 'fly') { const tk = tuckAngles(this.body); LEGS.forEach((leg, i) => this.body.setLeg(leg, tk[i])); }
    for (const n of ['c_abdomen12-c_abdomen3-pitch', 'c_abdomen3-c_abdomen4-pitch', 'c_abdomen4-c_abdomen5-pitch', 'c_abdomen5-c_abdomen6-pitch'])
      if (j[n]) j[n].q = curl;

    // ------------------------------------------------ the song: one wing out, the other folded
    this.sing = approach(this.sing, this.state === 'sing' ? 1 : 0, dt, 0.12);
    const pulsing = this.state === 'sing' && (this.songType === 'sine' || ((this.t * 1000) % 35) < 10);
    this.pulse = pulsing ? Math.sin(this.t * TAU * (this.songType === 'sine' ? 150 : 225)) * (this.songType === 'sine' ? 0.5 : 1) : 0;
    this.body.update();
    // the wing on the side nearer her head goes out and vibrates: the real wing moves far too fast
    // to see (the pulses come 35 ms apart), so it flutters at a visible rate with blurred copies
    // spread over the range it sweeps - wider and jerkier for pulse song, a small steady hum for sine song
    const rel = wrap(toHer - this.yaw);
    const side = rel >= 0 ? 0 : 1;                   // l_wing = index 0
    const qw = this._qw ??= new THREE.Quaternion();
    const amp = this.singing ? (this.songType === 'pulse' ? 0.3 : 0.14) : 0;
    this.flutter = (this.flutter || 0) + dt * (this.songType === 'pulse' ? 23 : 31) * TAU;
    const jitter = this.songType === 'pulse' ? (Math.random() - 0.5) * 0.5 : 0;
    this.body.ghostMat.opacity = amp ? 0.16 : 0;
    this.body.wings.forEach((w, k) => {
      const out = k === side ? this.sing : 0;
      const ghosts = w.wing.ghosts;
      if (out < 0.002) { w.obj.quaternion.copy(w.wing.qRest); ghosts.forEach((g) => { g.visible = false; }); return; }
      const sweep = (ph) => { this.body.wingQuat(w, -0.05 + amp * ph, 0.35 * amp * ph, Math.PI / 2 - 0.15, 0.8, qw); return qw; };
      w.obj.quaternion.copy(w.wing.qRest).slerp(sweep(Math.sin(this.flutter) + jitter), out);
      ghosts.forEach((g, gi) => {
        g.visible = amp > 0 && out > 0.7;
        if (g.visible) g.quaternion.copy(w.wing.qRest).slerp(sweep(Math.sin((gi + 0.5) / ghosts.length * TAU)), out);
      });
    });
    if (this.state === 'fly' || this._flew) {
      this._flew = this.state === 'fly';
      const qf = this._qf ??= new THREE.Quaternion();
      this.wingPh = (this.wingPh || 0) + dt * 29 * TAU;
      this.body.ghostMat.opacity = this._flew ? 0.12 : 0;
      for (const w of this.body.wings) {
        if (!this._flew) { w.obj.quaternion.copy(w.wing.qRest); w.wing.ghosts.forEach((g) => { g.visible = false; }); continue; }
        const st = (ph) => this.body.wingQuat(w, -0.12 + 1.2 * Math.sin(ph), 0.1 * Math.sin(2 * ph), Math.PI / 2 - 0.6 * Math.cos(ph), 0.8, qf);
        w.obj.quaternion.copy(st(this.wingPh));
        w.wing.ghosts.forEach((g, gi) => { g.visible = true; g.quaternion.copy(st(this.wingPh + (gi + 0.5) / w.wing.ghosts.length * TAU)); });
      }
    }
    this.stepWaves(dt, side);
    // the beam: from the singing wing's tip to her head
    if (this.singing || this.beam.level > 0.01) {
      const w = this.body.wings[side], from = this._bf ??= new THREE.Vector3(), to = this._bt ??= new THREE.Vector3();
      wingPoint(w, 0.6, from);
      this.f.body.byName.c_head.obj.getWorldPosition(to); to.z += 0.2;
      this.beam.update(dt, this.singing, from, to, this.songType, this.songFor().gain);
    }
  }

  // stretches of song leave the singing wing and fly to her head, growing and fading
  stepWaves(dt, side) {
    const from = this._from ??= new THREE.Vector3(), to = this._to ??= new THREE.Vector3();
    if (this.singing) {
      this.waveT -= dt;
      if (this.waveT <= 0) {
        this.waveT = WAVE_EVERY[this.songType];
        const sp = this.waves.find((w) => w.life <= 0);
        if (sp) {
          this.body.wings[side].obj.getWorldPosition(from);
          this.f.body.byName.c_head.obj.getWorldPosition(to);
          to.z += 0.25;                                  // the antennae, on top of the head
          sp.from = from.clone(); sp.to = to.clone(); sp.life = 1;
          sp.material.map = this.waveTex[this.songType]; sp.material.needsUpdate = true;
          sp.visible = true;
        }
      }
    }
    for (const sp of this.waves) {
      if (sp.life <= 0) continue;
      sp.life -= dt / WAVE_FLIGHT;
      if (sp.life <= 0) { sp.visible = false; continue; }
      const u = 1 - sp.life;
      sp.position.lerpVectors(sp.from, sp.to, u);
      sp.position.z += Math.sin(u * Math.PI) * 0.4;    // a slight arc
      const k = 0.6 + 0.5 * u;
      sp.scale.set(0.9 * k, 0.34 * k, 1);
      sp.material.opacity = Math.min(1, u * 5) * Math.min(1, sp.life * 3);
    }
  }
}
