// ハエそろばん - the 3D stage.
//
// A soroban tilted back in space and the fly that works it. The fly is the same NeuroMechFly body the
// rest of this site walks around on (test03/body3d.js); it stands over the board and reaches for beads
// with all six legs, each one solved by the body's own inverse kinematics.
//
// **Nothing moves a bead but a leg.** The beads slide on their rods under their own momentum and stop
// against the beam, the rails or each other - which is exactly where a soroban's numbers live - so what
// is on the board is the result of the fly having hit things, not of anything being animated into place.
// What it is *trying* to show comes from the brain in the worker.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, LEGS } from '../test03/body3d.js?v=6';

const NMF = new URL('../test03/nmf/', import.meta.url);
const V = '?v=6';
// A fly has six legs, so it works the soroban with six. Which leg takes which bead is decided by
// where that leg's foot rests: the nearest one gets it, which is why the front legs end up on the
// far side and the hind legs on the near side without being told.
const FRONT = LEGS;

// The soroban, in fly lengths. The bead places are not chosen - they are where a bead comes to rest
// against something: the beam, the rail, or the bead next to it. The physics below uses the same
// numbers, so a bead that is flicked ends up exactly where the machine wanted it.
const G = {
  gap: 5.4, beadR: 2.05, beadH: 2.3, beamHalf: 0.5,
  top: 8.8, bottom: -17.8,
};
G.pitch = G.beadH + 0.42;                       // bead to bead, stacked
G.beamUp = G.beamHalf + G.beadH / 2;            // a bead resting on the beam, from above
G.railTop = G.top - 0.8 - G.beadH / 2;          // against the top rail
G.railBottom = G.bottom + 0.8 + G.beadH / 2;    // against the bottom rail
G.heavenOn = G.beamUp;
G.heavenOff = G.railTop;
G.earthOn = (i) => -G.beamUp - i * G.pitch;
G.earthOff = (i) => G.railBottom + (3 - i) * G.pitch;

export async function makeStage(canvas, { rods = 4, digits = 3, onProgress, onHit } = {}) {
  const [{ J, bin }, meta, lobin] = await Promise.all([
    loadFlyData(NMF.href, V),
    fetch(new URL('meshes_lo.json' + V, NMF)).then((r) => r.json()),
    fetch(new URL('meshes_lo.bin.gz' + V, NMF)).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
  ]);
  const lo = { meta, bin: lobin };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const scene = new THREE.Scene();
  // the soroban is a thing standing in the room, tilted back like a board on a desk
  const board = new THREE.Group();
  board.rotation.x = -0.52;
  board.position.set(0, -1.5, 0);
  scene.add(board);
  const W = (rods - 1) * G.gap;
  const camera = new THREE.PerspectiveCamera(32, 16 / 10, 1, 500);
  camera.position.set(0, 0, 120);                // applyView() below puts it where it belongs
  camera.lookAt(0, -3, 2);                       // (and `view` below moves it when you drag)

  // ---- the board can be turned and zoomed by hand
  const FIT = Math.max(76, ((rods - 1) * G.gap + G.gap * 1.6) / 0.86);   // back far enough for the board
  const view = { yaw: 0, tilt: -0.52, dist: FIT };    // in close: the wings run off the edge
  function applyView() {
    board.rotation.set(view.tilt, view.yaw, 0);
    const d = view.dist;
    camera.position.set(2 * d / 124, 18 * d / 124, d);
    camera.lookAt(0, -3, 2);
  }
  {
    let drag = null, pinch = 0;
    const pts = new Map();
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, tilt: view.tilt };
      if (pts.size === 2) { drag = null; pinch = spread(); }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const s2 = spread();
        view.dist = Math.max(40, Math.min(FIT * 2.4, view.dist * pinch / Math.max(1, s2)));
        pinch = s2; applyView(); return;
      }
      if (!drag) return;
      view.yaw = Math.max(-1.1, Math.min(1.1, drag.yaw + (e.clientX - drag.x) * 0.006));
      view.tilt = Math.max(-1.35, Math.min(0.25, drag.tilt - (e.clientY - drag.y) * 0.005));
      applyView();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; if (!pts.size) drag = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      view.dist = Math.max(40, Math.min(FIT * 2.4, view.dist * (1 + Math.sign(e.deltaY) * 0.08)));
      applyView();
    }, { passive: false });
    function spread() {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
  }

  applyView();
  scene.add(new THREE.AmbientLight(0xcfe6ff, 1.0));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6); key.position.set(-16, 28, 30); scene.add(key);
  const rim = new THREE.DirectionalLight(0x74b6ff, 1.6); rim.position.set(22, -10, -20); scene.add(rim);
  const glow = new THREE.PointLight(0xffb454, 220, 120); glow.position.set(0, 2, -26); scene.add(glow);

  // ---- the frame, the beam, the rods
  const wood = new THREE.MeshStandardMaterial({ color: 0x46321f, roughness: 0.78, metalness: 0.04 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x6d4b2b, roughness: 0.55, metalness: 0.08,
    emissive: 0x3a2205, emissiveIntensity: 0.6 });
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x8d9bab, roughness: 0.3, metalness: 0.75 });
  const frameW = W + G.gap * 1.6;
  const bar = (w, h, d, x, y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wood);
    m.position.set(x, y, 0); board.add(m);
  };
  bar(frameW, 1.6, 3.6, 0, G.top + 0.8);
  bar(frameW, 1.6, 3.6, 0, G.bottom - 0.8);
  bar(1.7, G.top - G.bottom + 3.2, 3.6, -frameW / 2 + 0.85, (G.top + G.bottom) / 2);
  bar(1.7, G.top - G.bottom + 3.2, 3.6, frameW / 2 - 0.85, (G.top + G.bottom) / 2);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(frameW - 1.7, 1.0, 3.1), beamMat);
  board.add(beam);

  const rodGeo = new THREE.CylinderGeometry(0.3, 0.3, G.top - G.bottom + 1.4, 8);
  const profile = [];
  for (let k = 0; k <= 12; k++) {                 // fat in the middle, pinched at the rod
    const a = (k / 12 - 0.5) * Math.PI;
    profile.push(new THREE.Vector2(0.42 + Math.cos(a) * (G.beadR - 0.42), Math.sin(a) * G.beadH / 2));
  }
  const beadGeo = new THREE.LatheGeometry(profile, 20);
  const X = (r) => (rods - 1 - r) * G.gap - W / 2;            // rod 0 (the units) on the right
  const beads = [];
  for (let r = 0; r < rods; r++) {
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.set(X(r), (G.top + G.bottom) / 2, 0);
    board.add(rod);
    for (let k = 0; k < 5; k++) {
      const mat = new THREE.MeshStandardMaterial({
        color: r >= digits ? 0x7a6449 : 0xc98f42, roughness: 0.3, metalness: 0.12,
        emissive: 0x000000, emissiveIntensity: 1,
      });
      const m = new THREE.Mesh(beadGeo, mat);
      m.rotation.x = Math.PI / 2;                             // the lathe axis lies along the rod
      m.position.set(X(r), 0, 0);
      board.add(m);
      beads.push({ mesh: m, mat, r, k, y: 0, ty: 0, v: 0, on: false, dim: r >= digits,
        wait: 0, up: false });
    }
  }

  // ---- the fly, one of it, big enough to work the thing with its own legs
  const body = new FlyBody(J, bin, { lo, ghosts: 0 });
  scene.add(body.root);
  if (body.skin) scene.add(body.skin);
  // Big enough that a leg reaches the furthest bead. This is not a matter of taste: the far corner is
  // 28.0 away from where the thorax sits, so the legs have to be longer than that or that bead is never
  // struck and the board quietly shows the wrong number.
  const SCALE = 12.6;
  body.root.scale.setScalar(SCALE);
  const restLeg = {}, restTip = {};
  for (const leg of FRONT) { restLeg[leg] = body.getLeg(leg); restTip[leg] = body.legTip(leg, restLeg[leg]); }
  if (onProgress) onProgress(1);

  // It stands over the board, in the middle, facing up the rods - so every bead is inside the reach of
  // some leg and nothing has to fly anywhere. Only the legs move.
  const SEAT = new THREE.Vector3(0, (G.top + G.bottom) / 2 - 1, 2.2);     // in the board's own frame
  const fly = {
    hands: FRONT.map((leg) => ({ leg, bead: null, ang: restLeg[leg].slice(), reach: 99, t: 0 })),
    lean: new THREE.Vector2(0, 0),       // it leans over the board rather than letting a bead go alone
    buzz: 0, wingPh: 0, motion: 0,       // the wings run while the legs are moving, and not otherwise
  };
  const qw = new THREE.Quaternion();
  /** The wing stroke of flygym's own kinematics, blended in by how hard the fly is buzzing. */
  function beatWings(dt) {
    // how fast the legs are actually moving, in radians a second over all six of them
    const drive = Math.min(1, fly.motion / Math.max(1e-4, dt) / 7);
    fly.buzz = Math.max(drive, fly.buzz - dt * 5);
    fly.wingPh += dt * 34 * Math.PI * 2;                       // 34 strokes a second
    for (const w of body.wings) {
      body.wingQuat(w, -0.12 + 1.2 * Math.sin(fly.wingPh), 0.1 * Math.sin(2 * fly.wingPh),
        Math.PI / 2 - 0.6 * Math.cos(fly.wingPh), 0.8, qw);
      w.obj.quaternion.copy(w.wing.qRest).slerp(qw, Math.min(1, fly.buzz));
    }
  }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(),
        tmp = new THREE.Vector3(), eye = new THREE.Vector3();
  // the head is a real joint on this body - three axes off the thorax - so it can be pointed at things
  const headYawJ = body.joints['c_thorax-c_head-roll'];      // about the fly's z: left and right
  const headPitJ = body.joints['c_thorax-c_head-pitch'];     // about its y: up and down
  let headYaw = 0, headPit = 0;

  /** The fly stands still on the board; each leg reaches for whatever it has been given. */
  const bAxis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(board.quaternion).normalize();
  function placeBody() {
    const nose = bAxis(0, 1, 0), upM = bAxis(0, 0, 1);            // facing up the rods, back to the sky
    const leftM = new THREE.Vector3().crossVectors(upM, nose).normalize();
    M.makeBasis(nose, leftM, upM);
    Q.setFromRotationMatrix(M);
    body.root.quaternion.copy(Q);
    P.copy(SEAT); P.x += fly.lean.x; P.y += fly.lean.y; board.localToWorld(P);
    body.root.position.copy(P).addScaledVector(upM, Math.sin(clock * 2.6) * 0.25);
    body.root.updateMatrixWorld(true);
  }
  /** Where a bead is, in the fly's own frame - which is what its legs are measured in. */
  function beadLocal(b, out) {
    out.set(b.mesh.position.x, b.y + (b.up ? -1 : 1) * (G.beadH * 0.5 + 0.4), G.beadR * 0.75);
    board.localToWorld(out);
    body.thorax.obj.worldToLocal(out);
    return out;
  }
  function reachLegs(dt) {
    fly.motion = 0;
    for (const hand of fly.hands) {
      const rest = restLeg[hand.leg];
      const was = hand.ang.slice();
      if (swipe > 0 && (hand.leg === 'lf' || hand.leg === 'rf')) {
        const t = 1 - swipe / SWIPE_T, side = hand.leg === 'lf' ? 1 : -1;
        tmp2.set(-W / 2 - 3 + (W + 6) * t, -G.beamUp - 1.2 + side * 0.8, G.beadR * 0.9);
        board.localToWorld(tmp2);
        body.thorax.obj.worldToLocal(tmp2);
        hand.ang = body.ik(hand.leg, [tmp2.x, tmp2.y, tmp2.z], hand.ang, rest, 10, 0.02);
        hand.reach = 99; hand.bead = null;
        for (let k = 0; k < 7; k++) fly.motion += Math.abs(hand.ang[k] - was[k]);
        body.setLeg(hand.leg, hand.ang);
        continue;
      }
      if (hail > 0 && (hand.leg === 'lf' || hand.leg === 'rf')) {
        // the answer is in: both forelegs go up off the board and come back down
        const t = 1 - hail / HAIL_T;
        const lift = Math.sin(Math.min(1, t * 1.25) * Math.PI);
        const side = hand.leg === 'lf' ? 1 : -1;
        tmp2.set(side * (5 + 3 * lift), -1 + 9 * lift, G.beadR * 0.9 + 5 * lift);
        board.localToWorld(tmp2);
        body.thorax.obj.worldToLocal(tmp2);
        hand.ang = body.ik(hand.leg, [tmp2.x, tmp2.y, tmp2.z], hand.ang, rest, 10, 0.02);
        hand.reach = 99; hand.bead = null;
        for (let k = 0; k < 7; k++) fly.motion += Math.abs(hand.ang[k] - was[k]);
        body.setLeg(hand.leg, hand.ang);
        continue;
      }
      if (hand.bead) {
        beadLocal(hand.bead, tmp);
        hand.ang = body.ik(hand.leg, [tmp.x, tmp.y, tmp.z], hand.ang, rest, 12, 0.012);
        const tip = body.legTip(hand.leg, hand.ang);
        hand.reach = Math.hypot(tip[0] - tmp.x, tip[1] - tmp.y, tip[2] - tmp.z);
      } else {
        for (let k = 0; k < 7; k++) hand.ang[k] += (rest[k] - hand.ang[k]) * Math.min(1, dt * 11);
        hand.reach = 99;
      }
      for (let k = 0; k < 7; k++) fly.motion += Math.abs(hand.ang[k] - was[k]);
      body.setLeg(hand.leg, hand.ang);
    }
    aimHead(dt);
    body.update();
  }
  /**
   * It watches what it is doing: the head turns to whichever bead a leg is closest to touching, with a
   * twitch on it, and drifts back to level when there is nothing to hit.
   */
  function aimHead(dt) {
    let look = null, near = 1e9;
    if (feed <= 0) for (const hand of fly.hands) if (hand.bead && hand.reach < near) { near = hand.reach; look = hand.bead; }
    let yaw = 0, pit = feed > 0 ? 0.28 : -0.12;                  // drinking: head down to the drop
    if (look) {
      beadLocal(look, eye);
      const flat = Math.hypot(eye.x, eye.y);
      yaw = Math.max(-0.6, Math.min(0.6, Math.atan2(eye.y, eye.x)));
      pit = Math.max(-0.55, Math.min(0.55, -Math.atan2(eye.z, flat)));
    }
    const k = Math.min(1, dt * (look ? 13 : 5));               // quick to look, slow to look away
    headYaw += (yaw - headYaw) * k;
    headPit += (pit - headPit) * k;
    if (headYawJ) headYawJ.q = headYaw + Math.sin(clock * 12.7) * 0.022;
    if (headPitJ) headPitJ.q = headPit + Math.sin(clock * 9.3 + 1.1) * 0.018;
  }

  // A drop of honey for a sum that came out right, brought in by a feeder: a box on a stand swings a
  // tube out to the fly's mouth, a bead of honey forms at the nozzle, and the fly puts its proboscis
  // into it (the rostrum and haustellum on this body are real joints).
  const metal = new THREE.MeshStandardMaterial({ color: 0x9fb0c2, roughness: 0.35, metalness: 0.8 });
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0xd9e6f2, roughness: 0.25, metalness: 0.1,
    transparent: true, opacity: 0.55 });
  const feeder = new THREE.Group();
  feeder.visible = false;
  scene.add(feeder);
  const ANCHOR = new THREE.Vector3(W * 0.55 + 22, G.top + 30, 26);      // where the machine stands
  const box = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 7), metal);
  box.position.copy(ANCHOR);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x59b7ff, emissive: 0x2a6f9e, emissiveIntensity: 2 }));
  lamp.position.copy(ANCHOR).add(new THREE.Vector3(0, 4.6, 2));
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1, 10), tubeMat);
  const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.6, 12), metal);
  feeder.add(box, lamp, tube, nozzle);
  const honey = new THREE.Mesh(
    new THREE.SphereGeometry(1, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xffb02e, roughness: 0.15, metalness: 0.05,
      emissive: 0x6a3a00, emissiveIntensity: 1, transparent: true, opacity: 0.92 }));
  honey.visible = false;
  scene.add(honey);
  const rostrumJ = body.joints['c_head-c_rostrum-pitch'];
  const haustJ = body.joints['c_rostrum-c_haustellum-pitch'];
  let feed = 0, sip = 0, serve = 0;                 // drinking, and the feeder coming in and out
  let swipe = 0;                                    // the arm going across the board to clear it
  const SWIPE_T = 0.55;
  let hail = 0;                                     // both forelegs up: the sum is done
  const HAIL_T = 1.1;
  const tmp2 = new THREE.Vector3();
  /**
   * ご破算. Every bead is thrown back to zero at once and a foreleg goes across the board after them -
   * which is how a soroban is cleared before anything else happens.
   */
  function sweep() {
    for (const b of beads) {
      const zero = b.k === 0 ? G.heavenOff : G.earthOff(b.k - 1);
      b.ty = zero;
      if (Math.abs(zero - b.y) > 0.1) b.v = (zero > b.y ? 1 : -1) * 55;
      b.wait = 0;
      b.on = false;
    }
    values.fill(0);
    swipe = SWIPE_T;
  }
  const headObj = body.byName.c_head && body.byName.c_head.obj;
  const HV = new THREE.Vector3(), HN = new THREE.Vector3(), HU = new THREE.Vector3(),
        TIP = new THREE.Vector3(), DIR = new THREE.Vector3(), UPY = new THREE.Vector3(0, 1, 0);
  /** A sum came out right: wheel the feeder in. */
  function reward(seconds = 4.5) { feed = seconds; }
  /** The sum is done: both forelegs up, which is the only thing it can say. */
  function cheer() { hail = HAIL_T; }
  /** Keys are being pressed again: the feeder pulls back, the arms come down, the legs are free. */
  function stopFeed() { feed = 0; hail = 0; }
  function drink(dt) {
    const want = feed > 0 ? 1 : 0;
    serve += (want - serve) * Math.min(1, dt * (want ? 3.2 : 2));
    if (serve < 0.02 && !want) { feeder.visible = false; honey.visible = false; }
    if (feed > 0) feed -= dt;
    const out = feed > 0 && serve > 0.75 ? 1 : 0;   // it only drinks once the nozzle is there
    sip += (out - sip) * Math.min(1, dt * 6);
    if (rostrumJ) rostrumJ.q = 0.95 * sip + (out ? Math.sin(clock * 11) * 0.07 : 0);
    if (haustJ) haustJ.q = 0.75 * sip;
    if (serve < 0.02 || !headObj) return;
    feeder.visible = true;
    headObj.getWorldPosition(HV);
    HN.set(1, 0, 0).transformDirection(headObj.matrixWorld);
    HU.set(0, 0, 1).transformDirection(headObj.matrixWorld);
    HV.addScaledVector(HN, 6.2 * SCALE / 12).addScaledVector(HU, -3.4 * SCALE / 12);   // the mouth
    const e = serve * serve * (3 - 2 * serve);                       // the tube reaching out
    TIP.lerpVectors(ANCHOR, HV, e);
    DIR.copy(TIP).sub(ANCHOR);
    const len = Math.max(0.01, DIR.length());
    DIR.divideScalar(len);
    tube.position.copy(ANCHOR).addScaledVector(DIR, len / 2);
    tube.scale.set(1, len, 1);
    tube.quaternion.setFromUnitVectors(UPY, DIR);
    nozzle.position.copy(TIP).addScaledVector(DIR, -1.3);
    nozzle.quaternion.setFromUnitVectors(UPY, DIR);
    honey.visible = e > 0.7;
    honey.position.copy(TIP).addScaledVector(DIR, 1.1);
    const size = 2.4 * Math.min(1, Math.max(0.12, feed / 3.5)) * (1 + Math.sin(clock * 9) * 0.04);
    honey.scale.setScalar(size * Math.min(1, (e - 0.7) / 0.25));
    lamp.material.emissiveIntensity = 1.6 + Math.sin(clock * 6) * (feed > 0 ? 1.2 : 0.2);
  }
  // How long a bead waits to be struck before it goes on its own. During a sum the board must keep up
  // with the machine, so it is barely a moment; while a number is being keyed in there is no hurry and
  // the fly gets time to actually reach every bead.
  let patience = 0.45, clock = 0;
  const values = new Array(rods).fill(0);
  function set(list) {
    for (let r = 0; r < rods; r++) if (list[r] != null && list[r] >= 0) values[r] = list[r];
    for (const b of beads) {
      const v = values[b.r], h = v >= 5 ? 1 : 0, e = v % 5;
      b.on = b.k === 0 ? h === 1 : b.k - 1 < e;
      b.ty = b.k === 0 ? (b.on ? G.heavenOn : G.heavenOff) : (b.on ? G.earthOn(b.k - 1) : G.earthOff(b.k - 1));
    }
  }
  set(values);
  for (const b of beads) { b.y = b.ty; b.mesh.position.y = b.y; }


  function frame(dt) {
    clock += dt;
    swipe = Math.max(0, swipe - dt);
    hail = Math.max(0, hail - dt);
    const waiting = [];
    // ---- the beads are not moved; they slide. Anything pushed keeps going until it hits something.
    for (const b of beads) {
      b.v *= Math.exp(-2.2 * dt);                    // a little friction on the rod
      b.y += b.v * dt;
    }
    for (let r = 0; r < rods; r++) {
      const rod = beads.slice(r * 5, r * 5 + 5);
      const h = rod[0];
      if (h.y > G.heavenOff) { h.y = G.heavenOff; h.v = Math.min(0, h.v); }
      if (h.y < G.heavenOn) { h.y = G.heavenOn; h.v = Math.max(0, h.v); }
      for (let i = 0; i < 4; i++) {                  // stacked downward from the beam
        const b = rod[1 + i], top = i === 0 ? -G.beamUp : rod[i].y - G.pitch;
        if (b.y > top) { b.y = top; b.v = Math.min(0, b.v); }
      }
      for (let i = 3; i >= 0; i--) {                 // and upward from the bottom rail
        const b = rod[1 + i], floor = i === 3 ? G.railBottom : rod[2 + i].y + G.pitch;
        if (b.y < floor) { b.y = floor; b.v = Math.max(0, b.v); }
      }
    }
    for (const b of beads) {
      b.mesh.position.y = b.y;
      if (Math.abs(b.ty - b.y) > 0.25 && Math.abs(b.v) < 0.5) { b.up = b.ty > b.y; b.wait += dt; waiting.push(b); }
      else if (Math.abs(b.ty - b.y) <= 0.25) b.wait = 0;
      const want = b.on && !b.dim ? 0.5 : 0;
      const em = b.mat.emissive, k = Math.min(1, dt * 6);
      em.setRGB(em.r + (want * 0.55 - em.r) * k, em.g + (want * 0.3 - em.g) * k, em.b + (want * 0.05 - em.b) * k);
    }
    // hand each waiting bead to the free leg whose foot rests nearest it
    placeBody();
    const held = new Set(fly.hands.map((h) => h.bead).filter(Boolean));
    const todo = waiting.filter((b) => !held.has(b));
    for (const b of (feed > 0 || swipe > 0 ? [] : todo)) {   // not while drinking or clearing
      beadLocal(b, tmp);
      let best = null, bd = 1e9;
      for (const hand of fly.hands) {
        if (hand.bead) continue;
        const t = restTip[hand.leg];
        const d = (t[0] - tmp.x) ** 2 + (t[1] - tmp.y) ** 2 + (t[2] - tmp.z) ** 2;
        if (d < bd) { bd = d; best = hand; }
      }
      if (!best) break;
      best.bead = b; best.t = 0;
    }
    // if a leg has been stretching and cannot quite get there, the fly leans that way - a bead is
    // never allowed to move on its own, so the body has to do the work instead
    let lx = 0, ly = 0, n = 0;
    for (const hand of fly.hands) if (hand.bead) { lx += hand.bead.mesh.position.x; ly += hand.bead.y; n++; }
    const span = W / 2 + G.gap;                  // with many rods it slides along instead of leaning
    const leanX = n ? Math.max(-span, Math.min(span, lx / n)) : 0;
    const leanY = n ? Math.max(-7, Math.min(7, (ly / n - SEAT.y) * 0.4)) : 0;
    fly.lean.x += (leanX - fly.lean.x) * Math.min(1, dt * 3.5);
    fly.lean.y += (leanY - fly.lean.y) * Math.min(1, dt * 3);
    reachLegs(dt);
    // The flick. Nothing else moves a bead: when the tarsus is on it, the bead takes a push and slides
    // until the beam, the rail or its neighbour stops it - which is exactly where it belongs.
    for (const hand of fly.hands) {
      const b = hand.bead;
      if (!b) { hand.t = 0; continue; }
      hand.t += dt;
      if (hand.t > 1.3) { hand.bead = null; hand.t = 0; continue; }   // cannot get there: let another leg try
      if (hand.reach < 0.3) {
        const gap = Math.abs(b.ty - b.y);
        b.v = (b.ty > b.y ? 1 : -1) * Math.min(46, 9 + gap * 7);    // hard enough to get there, no more
        hand.bead = null; hand.t = 0;
        if (onHit) onHit(b);
      }
    }
    // The board keeps up with the machine: a bead does not wait to be reached. It is given its push as
    // soon as the rod's number changes, and the fly's legs chase the beads it is sending - which is what
    // the thing looked like when it read best. (A leg that gets there first still does the hitting, and
    // that is what the harder click and the wing buzz are.)
    for (const b of waiting) {
      if (b.wait < patience || Math.abs(b.v) > 0.5) continue;
      const gap = Math.abs(b.ty - b.y);
      b.v = (b.ty > b.y ? 1 : -1) * Math.min(46, 9 + gap * 7);
      b.wait = 0;
      for (const hand of fly.hands) if (hand.bead === b) { hand.bead = null; hand.t = 0; }
      if (onHit) onHit(b);
    }
    beatWings(dt);
    drink(dt);
    renderer.render(scene, camera);
  }
  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  /**
   * What the soroban is actually showing, read off the beads themselves: a bead counts when it has come
   * to rest against the beam (or against the beads already there). This is the number on the board, not
   * the number the machine is aiming for - while the fly is still working they differ, and that is
   * honest: a soroban says what its beads say.
   */
  function read() {
    const out = [];
    for (let r = 0; r < rods; r++) {
      const rod = beads.slice(r * 5, r * 5 + 5);
      const h = Math.abs(rod[0].y - G.heavenOn) < 0.45 ? 1 : 0;
      let e = 0;
      for (let i = 0; i < 4; i++) { if (Math.abs(rod[1 + i].y - G.earthOn(i)) < 0.45) e++; else break; }
      out[r] = h * 5 + e;
    }
    return out;
  }
  return {
    set, read, frame, resize, reward, cheer, stopFeed, sweep, renderer, beads, fly, view, applyView,
    enter() { patience = 0.05; },     // a sum is running: the beads cannot wait to be reached
    leave() { patience = 0.45; },     // it stays at the soroban, and now has time to hit every bead
  };
}
