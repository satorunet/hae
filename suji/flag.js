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
// One answer runs as a little sequence: write the answer on the ground with a
// front leg (in stroke order, from KanjiVG), set the foot back down and wait
// over the letter to be marked, and - if the answer was right - walk over to
// the drop of food that appears and eat it.
//
// The skeleton's frame is z-up (as in MuJoCo and flygym), so this scene is too.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LocoMap, LEGS } from '../test03/body3d.js?v=6';
import { HeadJerk } from './headjerk.js?v=4';

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
  rub: { f: [0.9, 0.02, -0.68] },                               // tarsi rubbed together, in front of and below the head
  tuck: { f: [0.5, 0.28, -0.62], m: [-0.5, 0.42, -0.9], h: [-1.45, 0.3, -0.82] },   // folded up in flight (test03)
};
const WINGBEAT = 210;              // Hz, as in test03
const WAIT_FOR = 1.8;              // seconds it waits over what it wrote, unless held
const FLY_ROAM = 9;                // flights stay inside this radius, mm (walking keeps to ROAM)

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
    this.lick = 0;                 // 0..1: how hard the mouthparts are working the food
    this.groomPh = rnd(0, 6); this.groomSlow = rnd(0, 6); this.rubPh = rnd(0, 6);
    this.dL = 0; this.dR = 0; this.turn = 0;
    this.x = 0; this.y = 0; this.yaw = -0.5;
    this.head = 0;
    this.jerk = new HeadJerk();    // puzzling over a wrong answer, or just weighing something up
    this.jerkBlocks = false;       // only the puzzling holds up the quiz
    this.feedW = 0;                // 0..1, eased: how far into its eating posture
    this.fl = null;                // a short flight in progress (see startFlight)
    this.alt = 0;                  // height above the ground, mm
    this.wingOpen = 0; this.flap = 0; this.wingPh = 0; this.tuckW = 0;
    this.pen = null;               // the letter being written (see planWriting)
    this.pending = null;           // a letter waiting for the previous flag to come down
    this.cockT = rnd(3, 8);        // next idle cock of the head
    this.look = new THREE.Vector3(0.35, 0, 0.8);
    this.camAng = this.yaw + CAM_OFF;   // the camera keeps to one side of the fly
  }

  /** True while an answer is still playing out, so the page can wait for it. */
  isBusy() { return this.phase !== 'idle' || !!this.fl || (this.jerkBlocks && this.jerk.active); }

  /** Told it was wrong: two quick cocks of the head, one way then the other, as if thinking. */
  puzzle() { this.jerk.start(2); this.jerkBlocks = true; }
  /** A single small cock of the head - a fly weighing something up. */
  cock(scale = 0.6) {
    if (this.jerk.active) return;
    this.jerk.start(Math.random() < 0.3 ? 2 : 1, scale);
    this.jerkBlocks = false;
  }

  async load() {
    const [{ J, bin }, L, S] = await Promise.all([
      loadFlyData(NMF, V),
      fetch(NMF + 'locomotion.json' + V).then((r) => r.json()),
      fetch(new URL('./strokes.json?v=1', import.meta.url)).then((r) => r.json()).catch(() => ({})),
    ]);
    this.strokes = S;
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

    // the ground: wide enough for a flight seen from above, with faint blotches so
    // movement over it reads
    scene.add(new THREE.Mesh(new THREE.CircleGeometry(60, 72),
      new THREE.MeshStandardMaterial({ color: 0x1a212a, roughness: 0.96, map: groundTexture() })));

    this.body = new FlyBody(J, bin, { ghosts: 4 });
    scene.add(this.body.root);
    this.cpg = new CPG(J);
    this.neutral = LEGS.map((_, i) => this.cpg.neutral(i));
    this.poses = solvePoses(this.body, this.cpg);
    this.ikGroom = {}; this.ikRub = {};

    LEGS.forEach((leg, i) => this.body.setLeg(leg, this.neutral[i]));
    this.downTip = {};
    for (const leg of ['lf', 'rf']) this.downTip[leg] = this.body.legTip(leg).slice();
    // the tarsi: five small segments at the end of each leg, which the CPG and
    // IK leave straight. They get their own life below.
    this.tars = {};
    for (const leg of LEGS) this.tars[leg] = {
      z0: this.body.legTip(leg)[2], lift: 0, tap: 0, tapT: rnd(0.5, 3),
      ph: rnd(0, TAU), seg: [1, 2, 3, 4].map((k) => this.body.joints[`${leg}_tarsus${k}-${leg}_tarsus${k + 1}-pitch`]),
    };
    this.z0 = -this.body.legTip('lm')[2];              // thorax height while standing

    this.flag = this.makeFlag();
    scene.add(this.flag.group);
    this.food = this.makeFood();
    scene.add(this.food.mesh);
    this.ink = this.makeInk();
    scene.add(this.ink.mesh);

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

  // the flag shows the fly's own handwriting: the tip's path while it wrote
  setHand(runs, sure = 1) {
    const { cvs, tex } = this.flag;
    const g = cvs.getContext('2d');
    g.fillStyle = sure > 0.45 ? '#f4f7fb' : '#ece3cc';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#aeb8c4'; g.lineWidth = 5; g.strokeRect(2.5, 2.5, 123, 123);
    g.strokeStyle = '#141a21'; g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const r of runs) {
      g.beginPath();
      for (let i = 0; i < r.length; i += 2) {
        const x = 64 + r[i] * 98, y = 66 + r[i + 1] * 98;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      if (r.length === 2) g.lineTo(64 + r[0] * 98 + 0.1, 66 + r[1] * 98);
      g.stroke();
    }
    tex.needsUpdate = true;
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
   * Answer `digit`: write it on the ground, put the foot down and wait over it;
   * `onWritten` is called at that moment - that is when the answer is there to
   * be marked. If `correct`, food appears after the wait and it goes and eats.
   * With `hold` it waits until release(). A letter already on the ground is
   * wiped for the new one.
   */
  show(digit, sure = 1, correct = false, hold = false, onWritten = null) {
    if (this.fl) {                 // in the air: come down first, then answer
      this.fl.hurry = true;
      this.afterLand = () => this.show(digit, sure, correct, hold, onWritten);
      return;
    }
    this.onWritten = onWritten;
    // it cocks its head as it answers - more often when it is unsure
    if (Math.random() < 0.45 + 0.4 * (1 - clamp(sure, 0, 1))) this.cock(0.45 + 0.3 * Math.random());
    this.hold = !!hold;
    this.digit = digit;
    this.sure = clamp(sure, 0, 1);
    this.reward = !!correct;
    this.setAct('stand', 20);
    const P = this.planWriting(digit);
    if (!P) {                      // nothing to write it with: a printed flag, straight up
      this.pending = null; this.pen = null;
      this.setDigit(digit, this.sure);
      this.raiseFlag();
      this.written();
      return;
    }
    this.pending = P;
    if (this.lift > 0.002) { this.want = 0; this.setPhase('lowering'); }
    else this.startWriting();       // (a letter it was waiting over is wiped for this one)
  }
  written() {
    const cb = this.onWritten; this.onWritten = null;
    if (cb) cb();
  }
  startWriting() {
    this.pen = this.pending; this.pending = null;
    this.flag.group.visible = false;
    this.inkClear(); this.ink.life = 1; this.ink.mesh.material.opacity = 0.95;
    this.setPhase('writing');
  }
  endWait() {
    if (this.reward) { this.dropFood(); this.setPhase('toFood'); } else this.setPhase('idle');
    this.setAct('stand', rnd(0.8, 1.6));
  }
  raiseFlag() {
    this.flag.group.visible = true;
    this.setPhase('raising');
    this.want = 1;
    this.setAct('stand', 9);
  }
  /**
   * Put down a flag held with show(..., hold = true); `correct` pays for it -
   * the food comes when the flag is down (at once, if it already is).
   */
  release(correct = false) {
    this.hold = false;
    if (this.phase === 'toFood' || this.phase === 'feeding') return;
    if (this.pending || this.phase === 'writing' || this.phase === 'showing') {
      this.reward = !!correct;     // it finishes writing, waits a moment, then eats
      return;
    }
    if (this.phase === 'waiting') { this.reward = !!correct; this.endWait(); return; }
    if (this.phase === 'idle') {
      if (correct) { this.setAct('stand', 6); this.dropFood(); this.setPhase('toFood'); }
      return;
    }
    this.reward = !!correct; this.want = 0; this.setPhase('lowering');
  }
  /** A question is being worked on: stop wandering and stand ready. */
  think() {
    this.want = 0; this.digit = null; this.reward = false; this.hold = false;
    this.pending = null; this.pen = null; this.onWritten = null;
    this.setPhase('lowering'); this.setAct('stand', 4);
  }
  /** Put everything away and carry on being a fly. */
  lower() {
    this.want = 0; this.reward = false; this.hold = false; this.pending = null; this.pen = null;
    this.onWritten = null;
    this.setPhase('lowering'); this.actT = 0;
  }

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
    else if (r < 0.80) this.setAct('feed', rnd(1.6, 3.2));   // working its mouthparts
    else if (r < 0.92 && this.t > 4) this.startFlight();     // a hop into the air and down somewhere else
    else this.setAct('stand', rnd(0.8, 2.2));
  }

  // Take-off, a short flight to another spot, landing. Wing strokes as in
  // test03 (210 Hz, blurred), legs folded up in the air and reaching out for
  // the landing. Hand-made, like all flight on this site: flygym has none.
  startFlight() {
    // a real trip: several body lengths away, high up (the camera pulls back for it)
    const ang = rnd(0, TAU), d = rnd(4, 8);
    let x1 = this.x + Math.cos(ang) * d, y1 = this.y + Math.sin(ang) * d;
    const rr = Math.hypot(x1, y1);
    if (rr > FLY_ROAM) { x1 *= FLY_ROAM / rr; y1 *= FLY_ROAM / rr; }
    const dist = Math.hypot(x1 - this.x, y1 - this.y);
    this.fl = { t: 0, x0: this.x, y0: this.y, x1, y1, h: rnd(2.5, 5), T: 1.4 + dist / rnd(3.5, 5), yaw1: this.yaw + rnd(-1.6, 1.6) };
    this.setAct('fly', 99);
  }
  stepFlight(dt) {
    const F = this.fl;
    if (this.lift > 0 || this.flag.group.visible) {   // nothing is carried into the air
      this.lift = 0; this.want = 0; this.flag.group.visible = false;
    }
    if (F.hurry && F.t < F.T - 0.6) F.T = Math.max(F.t + 0.6, 0.9);   // asked a question: cut it short
    F.t += dt;
    const T = F.T, t = F.t;
    // height: a crouch, a jump, cruise with a little bob, a flare onto the ground
    const up = ease(clamp((t - 0.18) / 0.35, 0, 1)), down = ease(clamp((T - t) / 0.45, 0, 1));
    const crouch = t < 0.18 ? -0.08 * Math.sin(Math.PI * t / 0.18) : 0;
    this.alt = crouch + F.h * Math.min(up, down) + 0.06 * Math.sin(t * 11) * Math.min(up, down);
    // across the ground
    const u = ease(clamp((t - 0.3) / Math.max(0.2, T - 0.8), 0, 1));
    const px = this.x, py = this.y;
    this.x = F.x0 + (F.x1 - F.x0) * u;
    this.y = F.y0 + (F.y1 - F.y0) * u;
    const vx = (this.x - px) / Math.max(dt, 1e-3), vy = (this.y - py) / Math.max(dt, 1e-3);
    if (Math.hypot(vx, vy) > 0.3) this.yaw += wrap(Math.atan2(vy, vx) - this.yaw) * Math.min(1, dt * 6);
    else if (t > T - 0.5) this.yaw += wrap(F.yaw1 - this.yaw) * Math.min(1, dt * 3);
    this.flySpeed = Math.hypot(vx, vy);
    // wings open before the jump, beat through the flight, fold after touch-down
    const inAir = t > 0.1 && t < T;
    this.wingOpen = approach(this.wingOpen, t < T ? 1 : 0, dt, t < T ? 0.04 : 0.08);
    this.flap = approach(this.flap, inAir ? 1 : 0, dt, 0.03);
    this.tuckW = approach(this.tuckW, t > 0.35 && t < T - 0.4 ? 1 : 0, dt, 0.06);
    if (t >= T + 0.25) {
      this.fl = null; this.alt = 0; this.flySpeed = 0;
      this.setAct('stand', rnd(0.6, 1.4));
      this.landedAt = this.t;
      if (this.afterLand) { const go = this.afterLand; this.afterLand = null; go(); }
      else if (Math.random() < 0.5) this.cock(0.5);
    }
  }

  // the trail the writing leg leaves: flat quads on the ground, one per step of the tip
  makeInk() {
    const MAX = 1500, pos = new Float32Array(MAX * 4 * 3), idx = [];
    for (let i = 0; i < MAX; i++) { const o = 4 * i; idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.95,
      depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    return { mesh, g, pos, n: 0, MAX, last: null, life: 0 };
  }
  inkClear() { this.ink.n = 0; this.ink.last = null; this.ink.g.setDrawRange(0, 0); }
  inkAdd(x, y) {
    const I = this.ink, W = 0.045, Z = 0.012;
    if (!I.last) { I.last = [x, y]; return; }
    const dx = x - I.last[0], dy = y - I.last[1], d = Math.hypot(dx, dy);
    if (d < 0.015 || I.n >= I.MAX) return;
    // a segment, overlapping the previous one a little so the line has no gaps
    const nx = -dy / d * W, ny = dx / d * W, ex = dx / d * W * 0.7, ey = dy / d * W * 0.7;
    const [ax, ay] = [I.last[0] - ex, I.last[1] - ey], [bx, by] = [x + ex, y + ey];
    I.pos.set([ax + nx, ay + ny, Z, ax - nx, ay - ny, Z, bx + nx, by + ny, Z, bx - nx, by - ny, Z], 12 * I.n);
    I.n++;
    I.last = [x, y];
    I.g.attributes.position.needsUpdate = true;
    I.g.setDrawRange(0, 6 * I.n);
  }

  /**
   * Plan the writing of `label` with the left front leg, in the thorax frame:
   * the letter lies on the ground in front of the fly, turned so that it reads
   * the right way up from where the camera is. Pen-up moves hop over the gaps.
   */
  planWriting(label) {
    const strokes = this.strokes?.[label];
    if (!strokes || !strokes.length) return null;
    const rel = this.camAng - this.yaw;                    // camera direction, fly frame
    const far = [-Math.cos(rel), -Math.sin(rel)];          // "up" on the page = away from the camera
    const right = [far[1], -far[0]];
    const C = [1.3, 0.5], S = 0.85, G = -this.z0 + 0.035, UP = 0.24;
    const at = (u, v) => [C[0] + S * (u * right[0] - v * far[0]), C[1] + S * (u * right[1] - v * far[1])];
    const pts = [];                                        // [x, y, z, penDown]
    const home = this.downTip.lf;
    pts.push([home[0], home[1], home[2], 0]);
    for (const st of strokes) {
      const p0 = at(st[0], st[1]);
      pts.push([p0[0], p0[1], G + UP, 0], [p0[0], p0[1], G, 0]);
      for (let i = 0; i < st.length; i += 2) { const p = at(st[i], st[i + 1]); pts.push([p[0], p[1], G, 1]); }
      const pe = at(st[st.length - 2], st[st.length - 1]);
      pts.push([pe[0], pe[1], G + UP, 0]);
    }
    pts.push([home[0], home[1], home[2] + 0.05, 0], [home[0], home[1], home[2], 0]);
    // time along the path: slower while writing than while hopping
    const T = [0];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      T.push(T[i - 1] + d / (b[3] && a[3] ? 1.8 : 3.0) + (b[3] !== a[3] ? 0.03 : 0));
    }
    const c = at(0, 0), w = new THREE.Vector3(c[0], c[1], 0);
    this.body.root.localToWorld(w);
    return { pts, T, t: 0, centre: [w.x, w.y], C, S, far, right, runs: [], down: false };
  }
  penAt(P) {
    const { pts, T } = P;
    let i = 1;
    while (i < T.length - 1 && T[i] < P.t) i++;
    const a = pts[i - 1], b = pts[i], u = clamp((P.t - T[i - 1]) / Math.max(1e-6, T[i] - T[i - 1]), 0, 1);
    P.down = !!(a[3] && b[3]);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  // Points along a leg in the thorax frame: the start of each segment from the
  // femur on, and the tip (the same forward kinematics as FlyBody.legTip).
  legPoints(leg) {
    const chain = this.body.chains[leg], pts = [], p = [0, 0, 0], q = [1, 0, 0, 0];
    chain.forEach((b, k) => {
      rotAdd(q, b.pos, p);
      if (k >= 1) pts.push(p.slice());
      mulIn(q, b.quat);
      for (const j of b.joints) mulAxisIn(q, j.axis, j.q);
    });
    rotAdd(q, chain[chain.length - 1].tip, p);
    pts.push(p.slice());
    return pts;                     // [femur, tibia, tarsus1..5, tip]
  }
  /**
   * No leg through the body: the head (with its eyes and folded proboscis), the
   * thorax and the abdomen are ellipsoids, and wherever a leg's segments dip
   * inside one, the tip is pushed out along the surface normal and the leg is
   * solved again. Front legs are checked against the head from the tibia on;
   * every leg against thorax and abdomen from the first tarsal segment on
   * (the upper leg is attached right there).
   */
  keepOutOfBody(leg, i, front) {
    for (let iter = 0; iter < 6; iter++) {
      const pts = this.legPoints(leg);
      let push = null, deepest = 0;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        for (const u of [0.25, 0.5, 0.75, 1]) {
          const x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u, z = a[2] + (b[2] - a[2]) * u;
          for (const E of BODY_SHAPES) {
            if (E.head ? !front || k < 2 : k < 3) continue;
            const dx = (x - E.c[0]) / E.r[0], dy = (y - E.c[1]) / E.r[1], dz = (z - E.c[2]) / E.r[2];
            const d = Math.hypot(dx, dy, dz);
            if (d >= 1 || 1 - d <= deepest) continue;
            deepest = 1 - d;
            const s = 1 / Math.max(d, 1e-3) - 1;             // out to the surface, plus a little
            push = [dx * E.r[0] * (s + 0.12), dy * E.r[1] * (s + 0.12), dz * E.r[2] * (s + 0.12)];
          }
        }
      }
      if (!push) return;
      const tip = this.body.legTip(leg);
      const tgt = [tip[0] + push[0], tip[1] + push[1], tip[2] + push[2]];
      this.body.setLeg(leg, this.body.ik(leg, tgt, this.body.getLeg(leg), this.neutral[i], 6, 0.005));
    }
  }

  // wing strokes, the same kinematics as test03, with blurred copies while beating
  poseWings() {
    const body = this.body, A = 1.3, phi0 = -0.12, alpha = 0.7, beta = 0.8, fk = this.flap;
    const q = this._wq ??= new THREE.Quaternion(), qg = this._wqg ??= new THREE.Quaternion();
    const stroke = (ph) => [
      lerp(phi0 - A, phi0 + A * Math.sin(ph), fk),
      0.12 * Math.sin(2 * ph) * fk,
      lerp(Math.PI / 2, Math.PI / 2 - (Math.PI / 2 - alpha) * Math.tanh(2.5 * Math.cos(ph)) / Math.tanh(2.5), fk),
    ];
    const blur = fk, ghost = blur > 0.02 && this.wingOpen > 0.8 && fk > 0.5;
    body.wingMat.opacity = 1 - 0.62 * (ghost ? blur : 0);
    body.ghostMat.opacity = 0.075 * blur;
    for (const w of body.wings) {
      const [phi, dev, gam] = stroke(this.wingPh);
      body.wingQuat(w, phi, dev, gam, beta, q);
      w.obj.quaternion.copy(w.wing.qRest).slerp(q, this.wingOpen);
      w.wing.ghosts.forEach((g, k) => {
        g.visible = ghost;
        if (!ghost) return;
        const [p2, d2, g2] = stroke(this.wingPh + (k + 0.5) / w.wing.ghosts.length * TAU);
        body.wingQuat(w, p2, d2, g2, beta, qg);
        g.quaternion.copy(w.wing.qRest).slerp(qg, this.wingOpen);
      });
    }
    this._wingsOut = this.wingOpen > 0.002;
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
    // on a phone the fly gets a good share of the screen; elsewhere it follows the width
    const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
    const h = phone ? Math.round(clamp(innerHeight * 0.42, 240, 460)) : Math.round(Math.max(190, Math.min(330, w * 0.62)));
    this.canvas.style.height = h + 'px';
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the horizontal field of view of a wide panel on narrower screens, or the fly is cropped
    const ref = 1.9;
    this.camera.fov = w / h < ref ? 2 * Math.atan(Math.tan(16 * Math.PI / 180) * ref / (w / h)) * 180 / Math.PI : 32;
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
    if (this.phase === 'waving' && !this.hold && this.phaseT > WAVE_FOR) { this.want = 0; this.setPhase('lowering'); }
    if (this.phase === 'lowering' && this.lift < 0.005) {
      this.flag.group.visible = false;
      if (this.pending) this.startWriting();                  // the next answer, now the hands are free
      else if (this.reward) { this.dropFood(); this.setPhase('toFood'); }
      else this.setPhase('idle');
    }
    const k = ease(this.lift);
    const holding = this.lift > 0.002;

    // writing the answer, the foot back down, then waiting over it to be marked
    if (this.phase === 'writing') {
      this.pen.t += dt;
      if (this.pen.t >= this.pen.T[this.pen.T.length - 1]) { this.setPhase('waiting'); this.cock(0.45); this.written(); }
    }
    if (this.phase === 'waiting' && !this.hold && this.phaseT > WAIT_FOR) this.endWait();
    if (this.ink.n && this.phase !== 'writing' && this.phase !== 'waiting') {
      // once it has been marked the letter fades
      this.ink.life = Math.max(0, this.ink.life - dt / 1.6);
      this.ink.mesh.material.opacity = 0.95 * Math.min(1, this.ink.life * 2.5);
      if (this.ink.life <= 0) this.inkClear();
    }

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
    const writing = this.phase === 'writing' || this.phase === 'waiting';
    const answering = holding || this.phase === 'toFood' || feeding || writing;
    this.actT -= dt;
    if (!answering && !this.fl && this.actT <= 0) this.chooseAct();

    const W = this.w;
    // waiting over its answer it fidgets: rubs its tarsi together, wipes its head, stands still
    if (this.phase === 'waiting') {
      this.waitT = (this.waitT ?? 0) - dt;
      if (this.waitT <= 0) {
        const r = Math.random();
        this.waitAct = this.waitAct !== 'stand' && r < 0.3 ? 'stand' : r < 0.65 ? 'rub' : 'groom';
        this.waitT = this.waitAct === 'stand' ? rnd(0.5, 1.0) : rnd(1.2, 2.2);
      }
    } else this.waitT = 0;
    const waitingAs = this.phase === 'waiting' ? this.waitAct : null;
    const grooming = (this.act === 'groom' && !answering) || waitingAs === 'groom';
    const rubbing = (this.act === 'rub' && !answering) || waitingAs === 'rub';
    W.groom = approach(W.groom, grooming ? 1 : 0, dt, 0.12);
    W.rub = approach(W.rub, rubbing ? 1 : 0, dt, 0.1);
    // the mouthparts: hard at work on the food, in bursts while "feeding" idly,
    // and an occasional twitch otherwise
    const wantProb = feeding ? clamp(0.72 + 0.28 * Math.sin(this.t * 9), 0.45, 1)
      : (this.act === 'feed' && !answering) ? clamp(0.4 + 0.6 * Math.sin(this.t * 7.5), 0.05, 1)
      : (!answering && Math.sin(this.t * 0.7) > 0.985 ? 0.3 : 0);
    this.prob = approach(this.prob, wantProb, dt, 0.07);
    this.lick = approach(this.lick, feeding ? 1 : (this.act === 'feed' && !answering) ? 0.45 : 0, dt, 0.15);
    if (grooming) { this.groomPh += dt * TAU * 5.5; this.groomSlow += dt * TAU * 0.35; }
    if (rubbing) this.rubPh += dt * TAU * 6.5;
    this.head = approach(this.head, answering || this.act === 'walk' ? 0 : Math.sin(this.t * 0.55) * 0.35, dt, 0.35);

    // ---------------------------------------------------------- flying
    if (this.fl) this.stepFlight(dt);
    else {
      this.tuckW = approach(this.tuckW, 0, dt, 0.06); this.flap = approach(this.flap, 0, dt, 0.03);
      this.wingOpen = approach(this.wingOpen, 0, dt, 0.08);
    }
    if (this.flap > 0.01) this.wingPh += dt * TAU * WINGBEAT;

    // ---------------------------------------------------------- walking
    const wantWalk = !this.fl && ((this.act === 'walk' && !answering) || steer != null);
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
        outsideHead(tgt);                            // sweep over the eye, not through it
        const sol = this.body.ik(leg, tgt, this.ikGroom[leg] || this.poses[leg].groom, this.neutral[i], 3, 0.02);
        this.ikGroom[leg] = sol; mix(sol, W.groom);
      } else this.ikGroom[leg] = null;
      if (front && W.rub > 0.001) {
        // the two tarsi cross and slide over each other in front of the head
        const sgn = leg[0] === 'l' ? 1 : -1, ph = this.rubPh + (sgn > 0 ? 0 : Math.PI);
        const tgt = [0.9 + 0.06 * Math.sin(ph), sgn * (0.02 + 0.07 * Math.sin(ph)), -0.68 + 0.05 * Math.cos(ph)];
        const sol = this.body.ik(leg, tgt, this.ikRub[leg] || this.poses[leg].rub, this.neutral[i], 3, 0.02);
        this.ikRub[leg] = sol; mix(sol, W.rub);
      } else this.ikRub[leg] = null;
      if (!front) a[0] += Math.sin(this.t * 1.7 + i) * 0.012 * (1 - Math.max(this.dL, this.dR));
      mix(this.poses[leg].tuck, this.tuckW);        // folded up in flight
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
      if (leg === 'lf' && this.phase === 'writing') {   // the pen
        const tgt = this.penAt(this.pen);
        this.penIk = this.body.ik(leg, tgt, this.penIk || this.body.getLeg(leg), this.neutral[i], 6, 0.015);
        this.body.setLeg(leg, this.penIk);
      } else if (leg === 'lf') this.penIk = null;
      if (front || this.tuckW > 0.01) this.keepOutOfBody(leg, i, front);
      if (front) {
        const tip = this.body.legTip(leg);
        for (let j = 0; j < 3; j++) mid[j] += tip[j] / 2;
      }
    });

    // ---------------------------------------------------------- tarsi
    // On the ground each tarsus lies nearly flat, flexing a little as the body
    // shifts over it; lifted off the ground it curls (more towards the tip);
    // holding the pole the front ones wrap round it; and now and then a
    // standing leg flicks the end of its tarsus up and sets it down again.
    // Positive pitch on these joints curls the segment under.
    for (const leg of LEGS) {
      const T = this.tars[leg], tip = this.body.legTip(leg);
      const front = leg[1] === 'f';
      const up = clamp((tip[2] - T.z0) / 0.28, 0, 1);
      T.lift = approach(T.lift, Math.max(up, front && holding ? 0.9 * k : 0), dt, 0.05);
      T.tapT -= dt;
      if (T.tapT <= 0) {
        T.tapT = rnd(1.2, 4.5);
        if (T.lift < 0.2 && this.dL + this.dR < 0.2) T.tap = 1;
      }
      T.tap = Math.max(0, T.tap - dt / 0.32);
      const flick = Math.sin(Math.PI * (1 - T.tap)) * (T.tap > 0 ? 1 : 0);   // up and back down
      const load = 0.5 + 0.5 * Math.sin(this.t * 1.9 + T.ph);              // weight shifting over it
      T.seg.forEach((j, s) => {
        const d = s / 3;                                                   // 0 proximal .. 1 distal
        j.q = -0.087 + 0.05 + 0.04 * load
          + T.lift * (0.2 + 0.18 * d)
          - flick * (0.1 + 0.25 * d)                                       // the flick lifts the claws
          + 0.025 * Math.sin(this.t * (4.3 + 1.7 * s) + T.ph + s);
      });
    }

    // ---------------------------------------------------------- head and mouthparts
    const jset = (n, v) => { const j = this.body.joints[n]; if (j) j.q = v; };
    // Feeding is not a still reach: the labellum at the tip pumps and dabs over
    // the drop, the haustellum sweeps it side to side, the rostrum works in and
    // out, and the antennae twitch.
    const L = this.lick, t = this.t;
    jset('c_head-c_rostrum-pitch', -1.25 * this.prob + L * (0.22 * Math.sin(t * 8.3) + 0.08 * Math.sin(t * 19)));
    jset('c_head-c_rostrum-yaw', L * 0.14 * Math.sin(t * 3.1));
    jset('c_rostrum-c_haustellum-pitch', -1.6 * this.prob + L * (0.42 * Math.sin(t * 15.5) + 0.12 * Math.sin(t * 4.2)));
    jset('c_rostrum-c_haustellum-yaw', L * 0.38 * Math.sin(t * 5.3));
    jset('c_rostrum-c_haustellum-roll', L * 0.3 * Math.sin(t * 7.1 + 1));
    const tw = (ph) => Math.max(0, Math.sin(t * 2.7 + ph)) ** 6;        // occasional sharp flicks
    jset('c_head-l_pedicel-pitch', L * (0.18 * Math.sin(t * 11) + 0.35 * tw(0)));
    jset('c_head-r_pedicel-pitch', L * (0.18 * Math.sin(t * 11 + 2.1) + 0.35 * tw(1.9)));
    jset('c_head-l_pedicel-yaw', L * 0.2 * Math.sin(t * 6.4));
    jset('c_head-r_pedicel-yaw', -L * 0.2 * Math.sin(t * 6.4 + 0.8));
    jset('c_thorax-c_head-pitch', 0.18 * this.prob + this.feedW * 0.07 * Math.sin(t * 9)
      + (grooming ? 0.12 * Math.sin(this.groomPh * 0.5) : 0));
    // puzzling: the head snaps from one diagonal tilt to another (see headjerk.js)
    // ...and, now and then, a small one of its own accord while it stands about
    this.cockT -= dt;
    if (this.cockT <= 0) {
      this.cockT = rnd(4, 11);
      const calm = this.act !== 'groom' && this.act !== 'rub' && this.act !== 'walk' && this.phase !== 'feeding';
      if (calm) this.cock(0.3 + 0.35 * Math.random());
    }
    const [pr, py, pp] = this.jerk.step(dt);
    jset('c_thorax-c_head-yaw', this.head + py);
    jset('c_thorax-c_head-roll', pr);
    if (pp) { const j = this.body.joints['c_thorax-c_head-pitch']; if (j) j.q += pp; }

    const breathe = Math.sin(this.t * 2.3) * 0.01;
    this.wob = this.phase === 'waving'
      ? Math.sin(this.t * (2.4 + 5 * this.sure)) * (0.05 + 0.2 * (1 - this.sure))
      : 0;
    // it leans in to eat - a steady posture, eased in and out; the rhythm of
    // eating is in the head and mouthparts only, so the body and abdomen stay put
    this.feedW = approach(this.feedW, feeding ? 1 : 0, dt, 0.3);
    const dip = 0.16 * this.feedW;
    const q = this._q ??= new THREE.Quaternion(), q2 = this._q2 ??= new THREE.Quaternion();
    q.setFromAxisAngle(AZ, this.yaw);
    const pitchFly = this.fl ? 0.1 * clamp((this.flySpeed || 0) / 3, 0, 1) - 0.12 * this.flap : 0;   // nose down to go, tail down to hover
    q2.setFromAxisAngle(AY, -0.30 * k - 0.06 * W.groom + dip + pitchFly);
    this.body.root.quaternion.copy(q).multiply(q2);
    this.body.root.position.set(this.x, this.y,
      this.z0 + this.alt + breathe * (1 - this.feedW) + 0.45 * k - 0.06 * W.groom - 0.05 * this.feedW);
    jset('c_thorax-c_abdomen12-pitch', -0.12 * this.tuckW);
    for (const sd of ['l', 'r']) jset(`c_thorax-${sd}_haltere-pitch`, this.flap * 0.9 * Math.sin(this.wingPh + Math.PI));
    this.body.update();
    if (this.wingOpen > 0.002 || this._wingsOut) this.poseWings();

    // the ink comes off the real tip of the leg, whenever it touches the ground
    if (this.phase === 'writing') {
      const tip = this.body.legTip('lf'), w = this._w ??= new THREE.Vector3();
      w.set(tip[0], tip[1], tip[2]);
      this.body.root.localToWorld(w);
      const P = this.pen;
      if (P.down && w.z < 0.12) {
        this.inkAdd(w.x, w.y);
        // and the same path, in the letter's own frame, for the flag
        const dx = tip[0] - P.C[0], dy = tip[1] - P.C[1];
        const u = (dx * P.right[0] + dy * P.right[1]) / P.S, v = -(dx * P.far[0] + dy * P.far[1]) / P.S;
        if (!P.inRun) { P.runs.push([]); P.inRun = true; }
        const run = P.runs[P.runs.length - 1], n = run.length;
        if (!n || Math.hypot(u - run[n - 2], v - run[n - 1]) > 0.012) run.push(u, v);
      } else { this.ink.last = null; this.pen.inRun = false; }
    }

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
    let tx = this.food.mesh.visible ? (this.x + this.food.x) / 2 : this.x;
    let ty = this.food.mesh.visible ? (this.y + this.food.y) / 2 : this.y;
    if (writing && this.pen) { tx = (this.x + this.pen.centre[0]) / 2; ty = (this.y + this.pen.centre[1]) / 2; }
    const wide = this.food.mesh.visible ? 1.1 : 0;
    // in flight the view pulls far back and up, looking down on the whole trip;
    // it comes back in close once the fly has landed (and for reading and writing)
    this.flyW = approach(this.flyW || 0, this.fl && !this.fl.hurry ? 1 : 0, dt, this.fl ? 0.7 : 0.9);
    const fw = this.flyW;
    const fx = this.fl ? (this.fl.x0 + this.fl.x1) / 2 : this.x, fy = this.fl ? (this.fl.y0 + this.fl.y1) / 2 : this.y;
    tx += (0.5 * this.x + 0.5 * fx - tx) * fw; ty += (0.5 * this.y + 0.5 * fy - ty) * fw;
    const follow = this.fl ? 3.5 : 2.2;
    this.look.x += (tx * (0.85 + 0.15 * fw) - this.look.x) * Math.min(1, dt * follow);
    this.look.y += (ty * (0.85 + 0.15 * fw) - this.look.y) * Math.min(1, dt * follow);
    // while it writes and shows the letter, the camera climbs to look down on the page
    this.writeW = approach(this.writeW || 0, writing ? 1 : 0, dt, 0.5);
    const vw = this.writeW;
    this.look.z += (0.8 + 1.7 * k - 0.6 * vw + (0.8 - 0.5 * fw) * this.alt - this.look.z) * Math.min(1, dt * 3);
    this.camAng += wrap(this.yaw + CAM_OFF - this.camAng) * Math.min(1, dt * 1.4 * (1 - 0.85 * fw));   // no swinging round mid-flight
    const r = 5.8 + 1.2 * k + wide - 2.0 * vw + 17 * fw;
    this.camera.position.set(this.look.x + Math.cos(this.camAng) * r,
      this.look.y + Math.sin(this.camAng) * r, 1.5 + 1.3 * k + 3.4 * vw + 0.9 * this.alt * (1 - fw) + 24 * fw);
    this.camera.lookAt(this.look);
    // the key light rides with the camera, so the fly is never left backlit
    this.sun.position.set(this.look.x + Math.cos(this.camAng + 0.8) * 9,
      this.look.y + Math.sin(this.camAng + 0.8) * 9, 10);
    this.renderer.render(this.scene, this.camera);
  };
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 260; i++) {                  // soft darker and lighter blotches, tiling
    const x = Math.random() * 256, y = Math.random() * 256, r = 2 + Math.random() * 16;
    const light = Math.random() < 0.4;
    g.fillStyle = light ? 'rgba(255,255,255,0.10)' : `rgba(0,0,0,${0.05 + Math.random() * 0.1})`;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
      g.beginPath(); g.arc(x + dx, y + dy, r, 0, TAU); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// the body as ellipsoids in the thorax frame, measured from the NeuroMechFly meshes
const BODY_SHAPES = [
  { c: [0.27, 0, 0.08], r: [0.36, 0.56, 0.5], head: true },        // head and eyes
  { c: [0.3, 0, -0.38], r: [0.32, 0.26, 0.3], head: true },        // rostrum and haustellum, folded
  { c: [-0.58, 0, 0], r: [0.86, 0.47, 0.86] },                     // thorax
  { c: [-1.55, 0, -0.18], r: [0.8, 0.5, 0.5] },                    // abdomen
];
// move a point out of the head shapes, onto a slightly larger copy of them
function outsideHead(p, grow = 1.25) {
  for (const E of BODY_SHAPES) {
    if (!E.head) continue;
    const dx = (p[0] - E.c[0]) / E.r[0], dy = (p[1] - E.c[1]) / E.r[1], dz = (p[2] - E.c[2]) / E.r[2];
    const d = Math.hypot(dx, dy, dz);
    if (d >= grow || d < 1e-6) continue;
    const k = grow / d;
    p[0] = E.c[0] + dx * k * E.r[0]; p[1] = E.c[1] + dy * k * E.r[1]; p[2] = E.c[2] + dz * k * E.r[2];
  }
  return p;
}
// quaternion helpers ([w, x, y, z], as in body3d.js)
function mulAxisIn(q, ax, ang) {
  const s = Math.sin(ang / 2), bw = Math.cos(ang / 2), bx = ax[0] * s, by = ax[1] * s, bz = ax[2] * s;
  const aw = q[0], a1 = q[1], a2 = q[2], a3 = q[3];
  q[0] = aw * bw - a1 * bx - a2 * by - a3 * bz; q[1] = aw * bx + a1 * bw + a2 * bz - a3 * by;
  q[2] = aw * by - a1 * bz + a2 * bw + a3 * bx; q[3] = aw * bz + a1 * by - a2 * bx + a3 * bw;
}
function mulIn(q, b) {
  const aw = q[0], a1 = q[1], a2 = q[2], a3 = q[3];
  q[0] = aw * b[0] - a1 * b[1] - a2 * b[2] - a3 * b[3]; q[1] = aw * b[1] + a1 * b[0] + a2 * b[3] - a3 * b[2];
  q[2] = aw * b[2] - a1 * b[3] + a2 * b[0] + a3 * b[1]; q[3] = aw * b[3] + a1 * b[2] - a2 * b[1] + a3 * b[0];
}
function rotAdd(q, v, p) {
  const w = q[0], x = q[1], y = q[2], z = q[3], a = v[0], b = v[1], c = v[2];
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  p[0] += ix * w + iw * -x + iy * -z - iz * -y; p[1] += iy * w + iw * -y + iz * -x - ix * -z; p[2] += iz * w + iw * -z + ix * -y - iy * -x;
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
