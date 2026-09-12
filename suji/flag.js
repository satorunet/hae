// The fly that answers with a flag - and that behaves like a fly the rest of
// the time.
//
// The body is the same NeuroMechFly skeleton the other pages use (test03), so
// none of this is faked: walking is flygym's CPG driving the six leg chains,
// with the body velocity measured from MuJoCo runs; grooming and hand-rubbing
// are inverse kinematics on the front tarsi; the mouthparts are the rostrum
// and haustellum joints; and raising the flag is IK on the two front tips with
// the flag riding where they meet.
//
// One answer runs as a little sequence: raise the flag, wave it, put it down,
// and - if the answer was right - walk over to the drop of food that appears
// and eat it.
//
// The skeleton's frame is z-up (as in MuJoCo and flygym), so this scene is too.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LocoMap, LEGS } from '../test03/body3d.js?v=6';

const V = '?v=6';
const NMF = new URL('../test03/nmf/', import.meta.url).href;
const TAU = Math.PI * 2;
const WAVE_FOR = 1.6;              // seconds the flag is held up
const FEED_FOR = 2.6;              // seconds spent on the reward
const ROAM = 3.0;                  // it stays inside this radius, in mm
const CAM_OFF = 1.05;              // the camera sits this far round from the fly's heading,
                                   // so it is always seen from the front quarter - head-on,
                                   // the flag it holds out in front would be edge-on

// leg-tip targets in the thorax frame, the same ones the other pages use
const POSE_TARGETS = {
  groom: { f: [0.62, 0.28, 0.16] },                             // start of a head sweep
  rub: { f: [0.74, 0.02, -0.46] },                              // tarsi rubbed together
};

export class FlagFly {
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.t = 0;
    // the answer sequence
    this.phase = 'idle';           // idle | raising | waving | lowering | toFood | feeding
    this.phaseT = 0;
    this.lift = 0;                 // 0 = legs on the ground, 1 = flag fully up
    this.want = 0;
    this.digit = null;
    this.sure = 1;
    this.reward = false;
    // idle behaviour
    this.act = 'stand';            // stand | walk | groom | rub | feed
    this.actT = 0.8;
    this.w = { groom: 0, rub: 0 };
    this.prob = 0;
    this.groomPh = rnd(0, 6); this.groomSlow = rnd(0, 6); this.rubPh = rnd(0, 6);
    this.dL = 0; this.dR = 0; this.turn = 0;
    this.x = 0; this.y = 0; this.yaw = -0.5;
    this.head = 0;
    this.look = new THREE.Vector3(0.35, 0, 0.8);
    this.camAng = this.yaw + CAM_OFF;   // the camera keeps to one side of the fly
  }

  /** True while an answer is still playing out, so the page can wait for it. */
  isBusy() { return this.phase !== 'idle'; }

  async load() {
    const [{ J, bin }, L] = await Promise.all([
      loadFlyData(NMF, V),
      fetch(NMF + 'locomotion.json' + V).then((r) => r.json()),
    ]);
    this.loco = new LocoMap(L);

    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.2;

    const scene = this.scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x20262e, 1.4));
    const sun = this.sun = new THREE.DirectionalLight(0xfff3e2, 2.4);
    sun.position.set(-5, -6, 9);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.7);
    rim.position.set(7, 5, 2);
    scene.add(rim);

    this.camera = new THREE.PerspectiveCamera(32, 1.6, 0.05, 200);
    this.camera.up.set(0, 0, 1);

    scene.add(new THREE.Mesh(new THREE.CircleGeometry(16, 56),
      new THREE.MeshStandardMaterial({ color: 0x1a212a, roughness: 0.96 })));

    this.body = new FlyBody(J, bin, { ghosts: 4 });
    scene.add(this.body.root);
    this.cpg = new CPG(J);
    this.neutral = LEGS.map((_, i) => this.cpg.neutral(i));
    this.poses = solvePoses(this.body, this.cpg);
    this.ikGroom = {}; this.ikRub = {};

    LEGS.forEach((leg, i) => this.body.setLeg(leg, this.neutral[i]));
    this.downTip = {};
    for (const leg of ['lf', 'rf']) this.downTip[leg] = this.body.legTip(leg).slice();
    this.z0 = -this.body.legTip('lm')[2];              // thorax height while standing

    this.flag = this.makeFlag();
    scene.add(this.flag.group);
    this.food = this.makeFood();
    scene.add(this.food.mesh);

    this.body.root.position.set(0, 0, this.z0);
    this.body.update();
    this.ready = true;
    this.resize();
    this.loop();
    return this;
  }

  // a pole along +z with the cloth on its upper half, gripped at z = 0
  makeFlag() {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.3, 8),
      new THREE.MeshStandardMaterial({ color: 0xc6cdd6, roughness: 0.45, metalness: 0.35 }));
    pole.rotation.x = Math.PI / 2;
    pole.position.z = 0.42;
    group.add(pole);
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 128;
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    // the camera always sits on the +y side of the flag (see CAM_OFF) and the
    // cloth's front faces -y after the rotation below, so mirror the texture
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.repeat.x = -1; tex.offset.x = 1;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.5, 14, 8),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
    cloth.rotation.x = Math.PI / 2;
    cloth.position.set(0.37, 0, 0.79);
    group.add(cloth);
    group.visible = false;
    return { group, cloth, cvs, tex, base: cloth.geometry.attributes.position.array.slice() };
  }

  // a drop of sugar water: a squashed, wet-looking bead on the ground
  makeFood() {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14),
      new THREE.MeshPhysicalMaterial({ color: 0xe9c46a, roughness: 0.18, clearcoat: 0.9,
        clearcoatRoughness: 0.15, transmission: 0.25, thickness: 0.4 }));
    mesh.scale.set(1, 1, 0.52);
    mesh.visible = false;
    return { mesh, x: 0, y: 0, life: 0 };
  }

  setDigit(d, sure = 1) {
    const { cvs, tex } = this.flag;
    const g = cvs.getContext('2d');
    g.fillStyle = sure > 0.45 ? '#f4f7fb' : '#ece3cc';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#aeb8c4'; g.lineWidth = 5; g.strokeRect(2.5, 2.5, 123, 123);
    g.fillStyle = '#141a21';
    g.font = '700 86px "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(d), 64, 68);
    tex.needsUpdate = true;
  }

  /**
   * Hold up the flag for `digit`, then put it down; if `correct`, food appears
   * and it goes and eats. `sure` in 0..1: a low value raises it slowly and wobbles.
   */
  show(digit, sure = 1, correct = false) {
    this.digit = digit;
    this.sure = clamp(sure, 0, 1);
    this.reward = !!correct;
    this.setDigit(digit, this.sure);
    this.flag.group.visible = true;
    this.setPhase('raising');
    this.want = 1;
    this.setAct('stand', 9);
  }
  /** A question is being worked on: stop wandering and stand ready. */
  think() {
    this.want = 0; this.digit = null; this.reward = false;
    this.setPhase('lowering'); this.setAct('stand', 4);
  }
  /** Put everything away and carry on being a fly. */
  lower() { this.want = 0; this.reward = false; this.setPhase('lowering'); this.actT = 0; }

  setPhase(p) { this.phase = p; this.phaseT = 0; }

  setAct(a, dur) {
    this.act = a;
    this.actT = dur;
    if (a === 'walk') {
      const far = Math.hypot(this.x, this.y) > ROAM * 0.8;
      this.turn = far ? wrap(Math.atan2(-this.y, -this.x) - this.yaw) : rnd(-1.4, 1.4);
    }
  }

  // something fly-like to do next
  chooseAct() {
    const r = Math.random();
    if (r < 0.30) this.setAct('rub', rnd(1.4, 3.2));         // washing its hands
    else if (r < 0.52) this.setAct('walk', rnd(2.0, 4.5));
    else if (r < 0.70) this.setAct('groom', rnd(1.6, 3.4));  // sweeping its head
    else if (r < 0.86) this.setAct('feed', rnd(1.6, 3.2));   // working its mouthparts
    else this.setAct('stand', rnd(0.8, 2.2));
  }

  dropFood() {
    const ang = this.yaw + rnd(-0.5, 0.5), d = rnd(1.5, 2.2);
    let fx = this.x + Math.cos(ang) * d, fy = this.y + Math.sin(ang) * d;
    const rr = Math.hypot(fx, fy);
    if (rr > ROAM) { fx *= ROAM / rr; fy *= ROAM / rr; }
    this.food.x = fx; this.food.y = fy; this.food.life = 1;
    this.food.mesh.position.set(fx, fy, 0.05);
    this.food.mesh.visible = true;
  }

  resize() {
    if (!this.ready) return;
    const w = this.canvas.clientWidth || 320;
    const h = Math.round(Math.max(190, Math.min(330, w * 0.62)));
    this.canvas.style.height = h + 'px';
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop = () => {
    requestAnimationFrame(this.loop);
    if (!this.ready) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now; this.t += dt; this.phaseT += dt;

    // ---------------------------------------------------------- the sequence
    const speed = this.phase === 'raising' ? 1.1 + 1.9 * this.sure : 2.4;
    this.lift += clamp(this.want - this.lift, -dt * speed, dt * speed);
    if (this.phase === 'raising' && this.lift > 0.995) this.setPhase('waving');
    if (this.phase === 'waving' && this.phaseT > WAVE_FOR) { this.want = 0; this.setPhase('lowering'); }
    if (this.phase === 'lowering' && this.lift < 0.005) {
      this.flag.group.visible = false;
      if (this.reward) { this.dropFood(); this.setPhase('toFood'); } else this.setPhase('idle');
    }
    const k = ease(this.lift);
    const holding = this.lift > 0.002;

    // walking to the food, then eating it
    let steer = null;
    if (this.phase === 'toFood') {
      const dx = this.food.x - this.x, dy = this.food.y - this.y, d = Math.hypot(dx, dy);
      if (d < 0.7 || this.phaseT > 5) { this.setPhase('feeding'); } else steer = Math.atan2(dy, dx);
    }
    if (this.phase === 'feeding') {
      this.food.life = Math.max(0, 1 - this.phaseT / FEED_FOR);
      if (this.food.life <= 0) { this.food.mesh.visible = false; this.reward = false; this.setPhase('idle'); }
    }
    const feeding = this.phase === 'feeding';
    if (this.food.mesh.visible) {
      const s = 0.35 + 0.65 * this.food.life;
      this.food.mesh.scale.set(s, s, s * 0.52);
      this.food.mesh.position.z = 0.05 * s;
    }

    // ---------------------------------------------------------- idle behaviour
    const answering = holding || this.phase === 'toFood' || feeding;
    this.actT -= dt;
    if (!answering && this.actT <= 0) this.chooseAct();

    const W = this.w;
    const grooming = this.act === 'groom' && !answering;
    const rubbing = this.act === 'rub' && !answering;
    W.groom = approach(W.groom, grooming ? 1 : 0, dt, 0.12);
    W.rub = approach(W.rub, rubbing ? 1 : 0, dt, 0.1);
    // the mouthparts: hard at work on the food, in bursts while "feeding" idly,
    // and an occasional twitch otherwise
    const wantProb = feeding ? clamp(0.72 + 0.28 * Math.sin(this.t * 9), 0.45, 1)
      : (this.act === 'feed' && !answering) ? clamp(0.4 + 0.6 * Math.sin(this.t * 7.5), 0.05, 1)
      : (!answering && Math.sin(this.t * 0.7) > 0.985 ? 0.3 : 0);
    this.prob = approach(this.prob, wantProb, dt, 0.07);
    if (grooming) { this.groomPh += dt * TAU * 5.5; this.groomSlow += dt * TAU * 0.35; }
    if (rubbing) this.rubPh += dt * TAU * 6.5;
    this.head = approach(this.head, answering || this.act === 'walk' ? 0 : Math.sin(this.t * 0.55) * 0.35, dt, 0.35);

    // ---------------------------------------------------------- walking
    const wantWalk = (this.act === 'walk' && !answering) || steer != null;
    if (steer != null) this.turn = wrap(steer - this.yaw);
    const turn = wantWalk ? clamp(this.turn * 1.1, -0.85, 0.85) : 0;
    this.dL = approach(this.dL, wantWalk ? 1 - Math.max(0, turn) : 0, dt, 0.18);
    this.dR = approach(this.dR, wantWalk ? 1 + Math.min(0, turn) : 0, dt, 0.18);
    this.cpg.step(dt, this.dL, this.dR);
    if (wantWalk) {
      const v = this.loco.at(this.dL, this.dR);
      this.yaw += v.wz * dt;
      this.turn -= v.wz * dt;
      this.x += (Math.cos(this.yaw) * v.vx - Math.sin(this.yaw) * v.vy) * dt;
      this.y += (Math.sin(this.yaw) * v.vx + Math.cos(this.yaw) * v.vy) * dt;
      if (steer == null && Math.hypot(this.x, this.y) > ROAM) {
        this.turn = wrap(Math.atan2(-this.y, -this.x) - this.yaw);
      }
    }

    // ---------------------------------------------------------- legs
    const a = this._a ??= new Array(7);
    const mid = [0, 0, 0];
    LEGS.forEach((leg, i) => {
      this.cpg.angles(i, a);
      const front = leg[1] === 'f';
      const mix = (pose, w) => { if (w > 0.001) for (let d = 0; d < 7; d++) a[d] += (pose[d] - a[d]) * Math.min(1, w); };
      if (front && W.groom > 0.001) {
        // a head sweep: the tarsus arcs up over the eye and back down
        const sgn = leg[0] === 'l' ? 1 : -1;
        const ph = this.groomPh + (sgn > 0 ? 0 : Math.PI * 0.9);
        const m = clamp(0.2 + 0.9 * Math.sin(this.groomSlow), 0, 1);
        const tgt = [
          lerp(0.62 + 0.1 * Math.sin(ph), 0.86 + 0.05 * Math.cos(ph), m),
          sgn * lerp(0.28 + 0.1 * Math.cos(ph), 0.04 + 0.05 * Math.sin(ph), m),
          lerp(0.16 + 0.22 * Math.sin(ph), -0.24 + 0.05 * Math.cos(ph), m),
        ];
        const sol = this.body.ik(leg, tgt, this.ikGroom[leg] || this.poses[leg].groom, this.neutral[i], 3, 0.02);
        this.ikGroom[leg] = sol; mix(sol, W.groom);
      } else this.ikGroom[leg] = null;
      if (front && W.rub > 0.001) {
        // the two tarsi cross and slide over each other in front of the head
        const sgn = leg[0] === 'l' ? 1 : -1, ph = this.rubPh + (sgn > 0 ? 0 : Math.PI);
        const tgt = [0.74 + 0.06 * Math.sin(ph), sgn * (0.015 + 0.07 * Math.sin(ph)), -0.46 + 0.05 * Math.cos(ph)];
        const sol = this.body.ik(leg, tgt, this.ikRub[leg] || this.poses[leg].rub, this.neutral[i], 3, 0.02);
        this.ikRub[leg] = sol; mix(sol, W.rub);
      } else this.ikRub[leg] = null;
      if (!front) a[0] += Math.sin(this.t * 1.7 + i) * 0.012 * (1 - Math.max(this.dL, this.dR));
      this.body.setLeg(leg, a);
      if (front && holding) {                            // the grip wins over everything
        const sgn = leg[0] === 'l' ? 1 : -1, d = this.downTip[leg];
        const up = [d[0] + 0.72, sgn * 0.09, d[2] + 1.42], wob = this.wob || 0;
        const tgt = [
          d[0] + (up[0] - d[0]) * k,
          d[1] + (up[1] - d[1]) * k + wob * 0.12 * sgn,
          d[2] + (up[2] - d[2]) * k + wob * 0.28,
        ];
        this.body.setLeg(leg, this.body.ik(leg, tgt, this.body.getLeg(leg), this.neutral[i], 5, 0.02));
      }
      if (front) {
        const tip = this.body.legTip(leg);
        for (let j = 0; j < 3; j++) mid[j] += tip[j] / 2;
      }
    });

    // ---------------------------------------------------------- head and mouthparts
    const jset = (n, v) => { const j = this.body.joints[n]; if (j) j.q = v; };
    jset('c_head-c_rostrum-pitch', -1.25 * this.prob);
    jset('c_rostrum-c_haustellum-pitch', -1.6 * this.prob);
    jset('c_thorax-c_head-pitch', 0.18 * this.prob + (grooming ? 0.12 * Math.sin(this.groomPh * 0.5) : 0));
    jset('c_thorax-c_head-yaw', this.head);

    const breathe = Math.sin(this.t * 2.3) * 0.01;
    this.wob = this.phase === 'waving'
      ? Math.sin(this.t * (2.4 + 5 * this.sure)) * (0.05 + 0.2 * (1 - this.sure))
      : 0;
    // it dips its head to the food while eating
    const dip = feeding ? 0.2 * this.prob : 0;
    const q = this._q ??= new THREE.Quaternion(), q2 = this._q2 ??= new THREE.Quaternion();
    q.setFromAxisAngle(AZ, this.yaw);
    q2.setFromAxisAngle(AY, -0.30 * k - 0.06 * W.groom + dip);
    this.body.root.quaternion.copy(q).multiply(q2);
    this.body.root.position.set(this.x, this.y,
      this.z0 + breathe + 0.45 * k - 0.06 * W.groom - 0.05 * (feeding ? this.prob : 0));
    this.body.update();

    // ---------------------------------------------------------- the flag
    if (this.flag.group.visible) {
      const p = this._p ??= new THREE.Vector3();
      p.set(mid[0], mid[1], mid[2]);
      this.body.root.localToWorld(p);
      this.flag.group.position.copy(p);
      this.flag.group.rotation.set(this.wob * 0.35, -0.1 - 0.25 * (1 - k), this.yaw);
      this.flag.group.scale.setScalar(1.25);
      const at = this.flag.cloth.geometry.attributes.position, b = this.flag.base;
      for (let i = 0; i < at.count; i++) {
        const x = b[3 * i], y = b[3 * i + 1];
        at.array[3 * i + 2] = Math.sin(this.t * 6 + x * 8 + y * 2) * 0.035 * (x + 0.37);
      }
      at.needsUpdate = true;
      this.flag.cloth.geometry.computeVertexNormals();
    }

    // ---------------------------------------------------------- camera
    // it frames the fly, and widens to take in the food while that is on screen
    const tx = this.food.mesh.visible ? (this.x + this.food.x) / 2 : this.x;
    const ty = this.food.mesh.visible ? (this.y + this.food.y) / 2 : this.y;
    const wide = this.food.mesh.visible ? 1.1 : 0;
    this.look.x += (tx * 0.85 - this.look.x) * Math.min(1, dt * 2.2);
    this.look.y += (ty * 0.85 - this.look.y) * Math.min(1, dt * 2.2);
    this.look.z += (0.8 + 1.7 * k - this.look.z) * Math.min(1, dt * 3);
    this.camAng += wrap(this.yaw + CAM_OFF - this.camAng) * Math.min(1, dt * 1.4);
    const r = 5.8 + 1.2 * k + wide;
    this.camera.position.set(this.look.x + Math.cos(this.camAng) * r,
      this.look.y + Math.sin(this.camAng) * r, 1.5 + 1.3 * k);
    this.camera.lookAt(this.look);
    // the key light rides with the camera, so the fly is never left backlit
    this.sun.position.set(this.look.x + Math.cos(this.camAng + 0.8) * 9,
      this.look.y + Math.sin(this.camAng + 0.8) * 9, 10);
    this.renderer.render(this.scene, this.camera);
  };
}

const AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const approach = (v, to, dt, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));

// the fixed leg poses, solved once by IK from the neutral stance
function solvePoses(body, cpg) {
  const out = {};
  LEGS.forEach((leg, i) => {
    const sgn = leg[0] === 'l' ? 1 : -1, n = cpg.neutral(i);
    out[leg] = {};
    for (const [name, byPos] of Object.entries(POSE_TARGETS)) {
      const t = byPos[leg[1]];
      out[leg][name] = t ? body.ik(leg, [t[0], sgn * t[1], t[2]], n, n, 60, 0.02) : n;
    }
  });
  LEGS.forEach((leg, i) => body.setLeg(leg, cpg.neutral(i)));
  body.update();
  return out;
}
