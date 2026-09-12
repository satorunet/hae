// 迷路実験 — a dropping at the far end of a maze, and walking flies let in at the near end.
//
// The flies are the NeuroMechFly bodies and the CPG-driven gait from the rest of the site, but the
// navigating here is a hand-written controller, NOT the connectome model: driving the olfactory
// receptor neurons of the Shiu model sends the whole brain into a self-sustaining runaway, so it
// cannot be used to steer anything. What it does use is the same three things a real fly walking a
// maze uses — a bilateral comparison of odour between the two antennae (osmotropotaxis), turning
// away from whatever an antenna bumps into, and an undirected random walk when it can smell nothing.
//
// Flight is off. That is not a shortcut: walking assays with flightless flies are how this is done
// for real, and a fly that can fly just goes over the walls.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LocoMap, LEGS } from '../test03/body3d.js?v=6';

const V = '?v=1';
const SITE = new URL('../', import.meta.url);
const at = (p) => new URL(p, SITE).href;
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, t, dt, tau) => v + (t - v) * (1 - Math.exp(-dt / tau));
const rnd = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;
const mulberry32 = (a) => () => {
  a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

// ------------------------------------------------------------------ the maze
const CW = 9, CH = 9;              // cells
const G = 8.2;                     // mm per grid square: a corridor one square wide, a wall the same
const GW = CW * 2 + 1, GH = CH * 2 + 1;
const WALL_H = 5.5;
const W2 = GW * G / 2, H2 = GH * G / 2;                 // half extents, maze centred on the origin
const gx = (x) => Math.floor((x + W2) / G);             // world -> grid
const gy = (y) => Math.floor((y + H2) / G);
const wx = (i) => (i + 0.5) * G - W2;                   // grid -> world (centre of the square)
const wy = (j) => (j + 0.5) * G - H2;
const H = 0.002;                   // s, body step
const WALK_Z = 1.12;
const N_FLIES = 30;
const RUN_TIME = 90;               // s before the run is called

let solid = new Uint8Array(GW * GH);                    // 1 = wall
let odour = new Float32Array(GW * GH);                  // steady-state concentration, 0..1
let START = { i: 1, j: 1 }, GOAL = { i: GW - 2, j: GH - 2 };
const SOLID = (i, j) => (i < 0 || j < 0 || i >= GW || j >= GH) ? 1 : solid[j * GW + i];

// a maze by recursive backtracking, then a few walls knocked through so it is not simply a tree
function buildMaze(seed) {
  const rng = mulberry32(seed);
  const cells = Array.from({ length: CW * CH }, () => ({ n: 1, e: 1, s: 1, w: 1, v: 0 }));
  const cell = (x, y) => cells[y * CW + x];
  const stack = [[0, 0]];
  cell(0, 0).v = 1;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1], nb = [];
    if (y > 0 && !cell(x, y - 1).v) nb.push([x, y - 1, 'n', 's']);
    if (x < CW - 1 && !cell(x + 1, y).v) nb.push([x + 1, y, 'e', 'w']);
    if (y < CH - 1 && !cell(x, y + 1).v) nb.push([x, y + 1, 's', 'n']);
    if (x > 0 && !cell(x - 1, y).v) nb.push([x - 1, y, 'w', 'e']);
    if (!nb.length) { stack.pop(); continue; }
    const [nx, ny, a, b] = nb[Math.floor(rng() * nb.length)];
    cell(x, y)[a] = 0; cell(nx, ny)[b] = 0; cell(nx, ny).v = 1;
    stack.push([nx, ny]);
  }
  for (let k = 0; k < Math.round(CW * CH * 0.12); k++) {     // loops: one route to the food is too kind
    const x = 1 + Math.floor(rng() * (CW - 2)), y = 1 + Math.floor(rng() * (CH - 2));
    if (rng() < 0.5) { cell(x, y).e = 0; cell(x + 1, y).w = 0; } else { cell(x, y).s = 0; cell(x, y + 1).n = 0; }
  }
  solid = new Uint8Array(GW * GH).fill(1);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    const i = x * 2 + 1, j = y * 2 + 1, c = cell(x, y);
    solid[j * GW + i] = 0;
    if (!c.n) solid[(j - 1) * GW + i] = 0;
    if (!c.s) solid[(j + 1) * GW + i] = 0;
    if (!c.w) solid[j * GW + i - 1] = 0;
    if (!c.e) solid[j * GW + i + 1] = 0;
  }
  START = { i: 1, j: 1 };
  GOAL = { i: GW - 2, j: GH - 2 };
}

// The odour, as it would stand once it has spread: diffusion through the open squares with a slow
// loss, held at 1 in the square the dropping sits in. Round a corner there is still a gradient to
// follow, but it fades with the distance travelled *through the maze*, not through the walls.
// kappa sets the decay length: G/sqrt(kappa). At 0.055 that is 35 mm, and a path of 300 mm through
// the maze left 1e-6 at the entrance — nothing to follow. At 0.004 it is about 130 mm, which still
// falls off steeply with distance round the corners but stays above what a nose could pick up.
function diffuse(iters = 2000, kappa = 0.004) {
  odour = new Float32Array(GW * GH);
  let next = new Float32Array(GW * GH);
  const gi = GOAL.j * GW + GOAL.i;
  for (let k = 0; k < iters; k++) {
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const n = j * GW + i;
      if (solid[n]) { next[n] = 0; continue; }
      let sum = 0, cnt = 0;
      if (!SOLID(i - 1, j)) { sum += odour[n - 1]; cnt++; }
      if (!SOLID(i + 1, j)) { sum += odour[n + 1]; cnt++; }
      if (!SOLID(i, j - 1)) { sum += odour[n - GW]; cnt++; }
      if (!SOLID(i, j + 1)) { sum += odour[n + GW]; cnt++; }
      next[n] = cnt ? sum / (cnt + kappa) : 0;
    }
    next[gi] = 1;
    [odour, next] = [next, odour];
  }
  odour[gi] = 1;
}
// bilinear sample, so the two antennae see a smooth difference rather than a staircase
function smell(x, y) {
  const fx = (x + W2) / G - 0.5, fy = (y + H2) / G - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  const v = (a, b) => (a < 0 || b < 0 || a >= GW || b >= GH || solid[b * GW + a]) ? 0 : odour[b * GW + a];
  return lerp(lerp(v(i, j), v(i + 1, j), tx), lerp(v(i, j + 1), v(i + 1, j + 1), tx), ty);
}

// ------------------------------------------------------------------ scene
const view = $('view'), stage = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9cdc6);
const camera = new THREE.PerspectiveCamera(40, 1.6, 0.5, 2000);
camera.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x8a8170, 1.5));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
sun.position.set(-60, -90, 220); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 40, far: 460 });
scene.add(sun, sun.target);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(GW * G + 40, GH * G + 40),
  new THREE.MeshStandardMaterial({ color: 0xcdc7b8, roughness: 0.95 }));
floor.receiveShadow = true; scene.add(floor);

const wallMat = new THREE.MeshStandardMaterial({ color: 0x8d8577, roughness: 0.85 });
const odourMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.62, depthWrite: false });
let wallMesh = null, odourMesh = null;
function buildWalls() {
  if (wallMesh) { scene.remove(wallMesh); wallMesh.geometry.dispose(); }
  const box = new THREE.BoxGeometry(G, G, WALL_H);
  const n = solid.reduce((a, v) => a + v, 0);
  wallMesh = new THREE.InstancedMesh(box, wallMat, n);
  wallMesh.castShadow = wallMesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  let k = 0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    if (!solid[j * GW + i]) continue;
    m.makeTranslation(wx(i), wy(j), WALL_H / 2);
    wallMesh.setMatrixAt(k++, m);
  }
  wallMesh.instanceMatrix.needsUpdate = true;
  scene.add(wallMesh);
}
// the plume, drawn as a green haze over the floor so you can see what there is to follow
function buildOdour() {
  if (odourMesh) { scene.remove(odourMesh); odourMesh.geometry.dispose(); }
  const open = [];
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) if (!solid[j * GW + i]) open.push([i, j]);
  const plate = new THREE.PlaneGeometry(G, G);
  odourMesh = new THREE.InstancedMesh(plate, odourMat, open.length);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  open.forEach(([i, j], k) => {
    m.makeTranslation(wx(i), wy(j), 0.05);
    odourMesh.setMatrixAt(k, m);
    // log scale: the field spans five orders of magnitude, and a nose reads it that way too
    const raw = odour[j * GW + i];
    const c = clamp((Math.log10(raw + 1e-9) + 6) / 6, 0, 1);
    col.setRGB(0.06 + 0.95 * Math.pow(c, 1.7), 0.10 + 0.80 * Math.pow(c, 0.8), 0.30 - 0.26 * c);
    odourMesh.setColorAt(k, col);
  });
  odourMesh.instanceMatrix.needsUpdate = true;
  if (odourMesh.instanceColor) odourMesh.instanceColor.needsUpdate = true;
  odourMesh.visible = showPlume;
  scene.add(odourMesh);
}

// ------------------------------------------------------------------ the dropping at the far end
function hash2(x, y) { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
}
let poop = null, poopMesh = null;
function dropGoal() {
  if (poopMesh) { scene.remove(poopMesh); poopMesh.geometry.dispose(); poopMesh.material.dispose(); }
  const k = 0.62, lumps = [];
  for (let i = 0; i < 3; i++) {
    const r = i === 0 ? 0 : rnd(0.6, 1.8) * k, a = rnd(0, TAU);
    lumps.push([Math.cos(a) * r, Math.sin(a) * r, rnd(0, TAU), rnd(1.0, 2.2) * k,
      rnd(1.6, 2.4) * Math.sqrt(k), rnd(1.2, 2.0) * Math.sqrt(k), rnd(0.4, 1.6) * Math.sqrt(k)]);
  }
  poop = { x: wx(GOAL.i), y: wy(GOAL.j), lumps, noff: [rnd(0, 100), rnd(0, 100)] };
  poop.R = Math.max(...lumps.map(([cx, cy, , L, R]) => Math.hypot(cx, cy) + L + R));
  const S = poop.R + 1, N = 120, pos = [], col = [], idx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = -S + 2 * S * i / N, y = -S + 2 * S * j / N, h = poopH(x, y);
    pos.push(x, y, h > 0 ? h + 0.02 : 0.01);
    const n1 = vnoise(x * 2.2 + 7, y * 2.2), n2 = vnoise(x * 9, y * 9 + 3);
    const kk = 0.72 + 0.5 * n2;
    const c = new THREE.Color().setRGB((0.27 + 0.1 * n1) * kk, (0.16 + 0.06 * n1) * kk, (0.075 + 0.03 * n1) * kk, THREE.SRGBColorSpace);
    col.push(c.r, c.g, c.b);
  }
  const up = (v) => pos[v * 3 + 2] > 0.011;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
    if (up(a) || up(b) || up(c) || up(d)) idx.push(a, b, d, a, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  poopMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }));
  poopMesh.position.set(poop.x, poop.y, 0); poopMesh.castShadow = poopMesh.receiveShadow = true;
  scene.add(poopMesh);
}
function poopH(lx, ly) {
  if (!poop) return 0;
  let h = 0;
  for (const [cx, cy, a, L, R0, Hh, zo] of poop.lumps) {
    const dx = lx - cx, dy = ly - cy, c = Math.cos(a), s = Math.sin(a), t = dx * c + dy * s;
    const R = R0 * (1 - 0.13 * (0.5 + 0.5 * Math.cos(t * 1.9 + cx)));
    const u = Math.max(0, Math.abs(t) - L), v = -dx * s + dy * c;
    const d2 = (u * u + v * v) / (R * R);
    if (d2 < 1) h = Math.max(h, Hh * Math.sqrt(1 - d2) + zo * (1 - d2));
  }
  return Math.max(0, h);
}

// ------------------------------------------------------------------ one walking fly
let J = null, BIN = null, LO = null, loco = null;
const flies = [];
class Walker {
  constructor(id) {
    this.id = id;
    this.body = new FlyBody(J, BIN, { lo: LO, ghosts: 0 });
    this.cpg = new CPG(J);
    const R = mulberry32((id + 1) * 0x9E3779B1 | 0), rr = (a, b) => a + R() * (b - a);
    this.s = rr(0.85, 1.15);
    this.body.root.scale.setScalar(this.s);
    const tint = [rr(0.9, 1.15), rr(0.82, 1.0), rr(0.62, 0.8)];
    this.body.skin.material = flyMaterial(tint);
    this.x = wx(START.i) + rr(-1.5, 1.5); this.y = wy(START.j) + rr(-1.5, 1.5);
    this.z = WALK_Z * this.s; this.yaw = rr(0, TAU); this.pitch = 0; this.roll = 0;
    this.om = 0; this.dL = this.dR = 0; this.speed = 0;
    this.touch = 0; this.arrived = 0; this.path = 0; this.lastC = 0;
    this.air = null; this.flyT = rnd(2, 14); this.markT = 0;
    this.trail = makeTrail(id);
    for (const [i, leg] of LEGS.entries()) this.body.setLeg(leg, this.cpg.neutral(i));
    scene.add(this.body.root, this.body.skin);
  }
  step(dt) {
    if (this.arrived) return;
    if ((this.markT -= dt) <= 0) { this.markT = 0.08; this.mark(); }
    if (this.air) return this.flyStep(dt);
    if (flightOn && (this.flyT -= dt) <= 0) return this.takeoff();
    // --- the two antennae, a third of a millimetre either side of the midline
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), ax = 0.75 * this.s, ay = 0.34 * this.s;
    const lx = this.x + c * ax - s * ay, ly = this.y + s * ax + c * ay;
    const rx = this.x + c * ax + s * ay, ry = this.y + s * ax - c * ay;
    const cl = smell(lx, ly), cr = smell(rx, ry), cm = (cl + cr) / 2;
    // --- odour: a bilateral comparison, scaled by the local concentration the way a nose works
    let turn = 0, base = 1;
    if (odourOn && cm > DETECT) {
      turn = -clamp((cl - cr) / (cm + 1e-12) * OSMO, -0.9, 0.9);
      if (cm < this.lastC * 0.995) this.om += rnd(-1, 1) * 0.5;   // losing it: cast about
      this.lastC = cm;
    } else {
      this.lastC = 0;
    }
    // --- an antenna against a wall turns it away; walls are what it has instead of a map
    const probe = (a) => SOLID(gx(this.x + Math.cos(this.yaw + a) * 1.9 * this.s),
      gy(this.y + Math.sin(this.yaw + a) * 1.9 * this.s));
    const hitL = probe(0.55), hitR = probe(-0.55), hitF = probe(0);
    if (hitL || hitR || hitF) {
      this.touch = 0.25;
      turn += hitL && !hitR ? -0.85 : hitR && !hitL ? 0.85 : (this.id & 1 ? 0.9 : -0.9);
      if (hitF) base = 0.25;
    }
    this.touch = Math.max(0, this.touch - dt);
    // --- and when it can smell nothing, an ordinary random walk
    this.om += (-this.om / 0.7) * dt + (Math.random() - 0.5) * 2.2 * Math.sqrt(dt);
    turn = clamp(turn + this.om * (turn ? 0.3 : 1), -1.1, 1.1);
    this.dL = base * (1 + turn); this.dR = base * (1 - turn);
    this.cpg.step(dt, this.dL, this.dR);
    const m = this.cpg.mag;
    const sL = (m[0] + m[1] + m[2]) / 3 * Math.sign(this.cpg.freq[0]);
    const sR = (m[3] + m[4] + m[5]) / 3 * Math.sign(this.cpg.freq[3]);
    const v = loco.at(sL, sR);
    const nx = this.x + (c * v.vx - s * v.vy) * this.s * dt, ny = this.y + (s * v.vx + c * v.vy) * this.s * dt;
    const [px, py] = pushOut(nx, ny, 1.15 * this.s);
    this.path += Math.hypot(px - this.x, py - this.y);
    this.x = px; this.y = py;
    this.yaw = wrap(this.yaw + v.wz * dt);
    this.speed = Math.abs(v.vx * this.s);
    if (Math.hypot(this.x - poop.x, this.y - poop.y) < poop.R + 1.2) this.reach();
  }
  mark() {
    const t = this.trail;
    if (t.n >= TRAIL_MAX) return;
    const a = t.geo.attributes.position;
    a.setXYZ(t.n, this.x, this.y, (this.air ? this.z : 0.35) + 0.2);
    t.n++; a.needsUpdate = true; t.geo.setDrawRange(0, t.n);
    t.geo.computeBoundingSphere();
  }
  reach() {
    this.arrived = world.t;
    this.trail.line.material.opacity = 1;
    this.trail.line.material.color.setHSL((this.id * 0.618034) % 1, 0.9, 0.68);
    arrived.push({ id: this.id, t: world.t, path: this.path });
    hud();
  }
  takeoff() {
    const cm = smell(this.x, this.y);
    let dir = rnd(0, TAU);
    if (odourOn && cm > DETECT) {                      // it heads the way the air smells better
      let best = -1;
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * TAU, v = smell(this.x + Math.cos(a) * G * 2.2, this.y + Math.sin(a) * G * 2.2);
        if (v > best) { best = v; dir = a; }
      }
      dir += rnd(-0.6, 0.6);
    }
    this.air = { t: 0, T: rnd(0.5, 1.9), dir, u: rnd(55, 110), landing: false };
    this.flyT = rnd(3, 16);
  }
  flyStep(dt) {
    const A = this.air;
    A.t += dt;
    const up = WALL_H + 3.5;
    if (!A.landing) {
      this.z = approach(this.z, up, dt, 0.09);
      this.x += Math.cos(A.dir) * A.u * dt;
      this.y += Math.sin(A.dir) * A.u * dt;
      if (Math.abs(this.x) > W2 - 2 || Math.abs(this.y) > H2 - 2) {   // the outer wall turns it back
        A.dir = Math.atan2(-this.y, -this.x) + rnd(-0.5, 0.5);
        this.x = clamp(this.x, -W2 + 2, W2 - 2); this.y = clamp(this.y, -H2 + 2, H2 - 2);
      }
      this.yaw = wrap(this.yaw + wrap(A.dir - this.yaw) * (1 - Math.exp(-dt / 0.05)));
      if (A.t > A.T && !SOLID(gx(this.x), gy(this.y))) A.landing = true;   // only down into a corridor
    } else {
      this.z = approach(this.z, WALK_Z * this.s, dt, 0.06);
      this.x += Math.cos(A.dir) * A.u * 0.15 * dt;
      this.y += Math.sin(A.dir) * A.u * 0.15 * dt;
      if (SOLID(gx(this.x), gy(this.y))) { A.landing = false; A.t = 0; A.T = rnd(0.2, 0.8); return; }
      if (this.z < WALK_Z * this.s + 0.15) {
        const [px, py] = pushOut(this.x, this.y, 1.15 * this.s);
        this.x = px; this.y = py; this.air = null;
      }
    }
    this.cpg.step(dt * 0.2, 0, 0);
    if (Math.hypot(this.x - poop.x, this.y - poop.y) < poop.R + 1.2 && this.z < WALL_H) this.reach();
  }
  pose(dt) {
    const body = this.body, a = this._a ??= new Array(7);
    for (const [i, leg] of LEGS.entries()) { this.cpg.angles(i, a); body.setLeg(leg, a); }
    body.update();
    if (!this.air) {
      const gz = poopH(this.x - poop.x, this.y - poop.y);
      this.z = approach(this.z, gz + WALK_Z * this.s, dt, 0.02);
    }
    body.root.position.set(this.x, this.y, this.z);
    _qa.setFromAxisAngle(AZ, this.yaw);
    body.root.quaternion.copy(_qa);
  }
}
const _qa = new THREE.Quaternion(), AZ = new THREE.Vector3(0, 0, 1);

// where each one has been, in its own colour
const TRAIL_MAX = 2200;
function makeTrail(id) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
  geo.setDrawRange(0, 0);
  const col = new THREE.Color().setHSL((id * 0.618034) % 1, 0.75, 0.58);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.75 }));
  line.frustumCulled = false; line.renderOrder = 4;
  scene.add(line);
  return { line, geo, n: 0, col };
}
// keep a body out of the walls: push it clear of every solid square it overlaps
function pushOut(x, y, r) {
  for (let k = 0; k < 2; k++) {
    const i0 = gx(x - r), i1 = gx(x + r), j0 = gy(y - r), j1 = gy(y + r);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (!SOLID(i, j)) continue;
      const cx = wx(i), cy = wy(j);
      const nx = clamp(x, cx - G / 2, cx + G / 2), ny = clamp(y, cy - G / 2, cy + G / 2);
      const dx = x - nx, dy = y - ny, d = Math.hypot(dx, dy);
      if (d >= r) continue;
      if (d < 1e-4) { x = cx + (x < cx ? -1 : 1) * (G / 2 + r); continue; }
      x = nx + dx / d * r; y = ny + dy / d * r;
    }
  }
  return [x, y];
}
function flyMaterial(tint) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0 });
  const uTint = { value: new THREE.Color(...tint) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTint = uTint;
    sh.fragmentShader = 'uniform vec3 uTint;\n' + sh.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb *= mix(uTint, vec3(1.0), step(6.0 * vColor.g + 0.01, vColor.r));');
  };
  m.customProgramCacheKey = () => 'fly';
  return m;
}

// ------------------------------------------------------------------ the run
const world = { t: 0 };
const arrived = [];
let odourOn = true, flightOn = true, running = false, seed = 1;
const DETECT = 2e-5;               // below this there is nothing to follow
const OSMO = 45;                   // how hard it turns on the difference between the two antennae

function reset(newMaze) {
  for (const f of flies) { scene.remove(f.body.root, f.body.skin); if (f.trail) scene.remove(f.trail.line); }
  flies.length = 0; arrived.length = 0;
  world.t = 0;
  if (newMaze) { seed = (Math.random() * 1e9) | 0; buildMaze(seed); buildWalls(); }
  diffuse();
  buildOdour();
  dropGoal();
  if (odourMesh) odourMesh.visible = showPlume;
  if (J) for (let i = 0; i < N_FLIES; i++) flies.push(new Walker(i));
  running = true;
  hud();
}
let showPlume = true;

function hud() {
  $('n-in').textContent = String(flies.length);
  $('n-goal').textContent = String(arrived.length);
  $('clock').textContent = running ? `${Math.floor(Math.max(0, RUN_TIME - world.t))} 秒` : '終了';
  const best = arrived.length ? Math.min(...arrived.map((a) => a.t)) : 0;
  $('note').textContent = arrived.length
    ? `最初の1匹 ${best.toFixed(1)} 秒 ・ 平均経路 ${(arrived.reduce((s, a) => s + a.path, 0) / arrived.length / 10).toFixed(1)} cm`
    : (odourOn ? '匂いをたどって探しています' : '匂いなし — 手がかりはありません');
}

// ------------------------------------------------------------------ camera and input
const cam = { az: -Math.PI / 2, el: 1.32, dist: 210, target: new THREE.Vector3(0, 0, 0) };
function placeCamera() {
  camera.position.set(cam.target.x + Math.cos(cam.az) * Math.cos(cam.el) * cam.dist,
    cam.target.y + Math.sin(cam.az) * Math.cos(cam.el) * cam.dist,
    cam.target.z + Math.sin(cam.el) * cam.dist);
  camera.lookAt(cam.target);
}
const _fit = new THREE.Vector3();
function fitCamera() {
  if (cam.userZoom) return;
  let lo = 40, hi = 600;
  for (let k = 0; k < 20; k++) {
    const d = (lo + hi) / 2;
    cam.dist = d; placeCamera(); camera.updateMatrixWorld(true);
    let ok = true;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      _fit.set(sx * (W2 + 3), sy * (H2 + 3), 0).project(camera);
      if (Math.abs(_fit.x) > 0.97 || Math.abs(_fit.y) > 0.97) ok = false;
    }
    if (ok) hi = d; else lo = d;
  }
  cam.dist = hi; placeCamera();
}
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w / h < 1 ? 46 : 34;
  camera.updateProjectionMatrix();
  fitCamera();
}
new ResizeObserver(resize).observe(stage);
const pointers = new Map();
let down = null, two = null;
view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) down = { x: e.clientX, y: e.clientY };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    two = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; down = null;
  }
});
view.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const [px, py] = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2 && two) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    cam.dist = clamp(cam.dist * two.d / d, 40, 600); cam.userZoom = true; two.d = d; return;
  }
  if (!down) return;
  cam.az -= (e.clientX - px) * 0.006;
  cam.el = clamp(cam.el + (e.clientY - py) * 0.005, 0.25, 1.53);
});
view.addEventListener('pointerup', (e) => { pointers.delete(e.pointerId); down = null; if (pointers.size < 2) two = null; });
view.addEventListener('pointercancel', () => { pointers.clear(); down = null; two = null; });
view.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 40, 600); cam.userZoom = true; }, { passive: false });

on('again', 'click', () => reset(true));
on('odour', 'change', (e) => { odourOn = e.target.value === 'on'; reset(false); });
on('flight', 'change', (e) => { flightOn = e.target.value === 'on'; reset(false); });
on('plume', 'change', (e) => { showPlume = e.target.checked; if (odourMesh) odourMesh.visible = showPlume; });
on('start', 'click', () => { $('intro').hidden = true; reset(true); });

// ------------------------------------------------------------------ loop
let last = performance.now(), acc = 0;
function frame(now) {
  const dtReal = Math.min(0.05, (now - last) / 1000); last = now;
  if (J) {
    acc = Math.min(acc + dtReal, 0.1);
    while (acc >= H) {
      acc -= H; world.t += H;
      if (running) for (const f of flies) f.step(H);
    }
    for (const f of flies) f.pose(dtReal);
    if (running && world.t >= RUN_TIME) { running = false; hud(); }
    if (running && Math.floor(world.t * 4) !== Math.floor((world.t - dtReal) * 4)) hud();
    placeCamera();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

resize();
(async () => {
  try {
    const [data, L, loMeta, loBin] = await Promise.all([
      loadFlyData(at('test03/nmf/'), V),
      fetch(at('test03/nmf/locomotion.json' + V)).then((r) => r.json()),
      fetch(at('test03/nmf/meshes_lo.json' + V)).then((r) => r.json()),
      fetch(at('test03/nmf/meshes_lo.bin.gz' + V)).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    ]);
    J = data.J; BIN = data.bin; LO = { meta: loMeta, bin: loBin }; loco = new LocoMap(L);
    buildMaze(seed); buildWalls(); diffuse(); buildOdour(); dropGoal();
    fitCamera();
    $('load').remove();
  } catch (err) {
    $('load').textContent = '読み込みに失敗しました: ' + (err && err.message || err);
  }
})();
window.__maze = { world, flies, arrived, cam, smell, solid: () => solid, odour: () => odour,
  grid: { GW, GH, G, W2, H2 }, START: () => START, GOAL: () => GOAL, poop: () => poop,
  reset, setOdour: (v) => { odourOn = v; }, isRunning: () => running, fit: fitCamera };
requestAnimationFrame(frame);
