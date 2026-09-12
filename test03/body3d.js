// The fly's body: NeuroMechFly v2 from flygym (NeLy-EPFL, Apache-2.0), driven kinematically.
//
//   - 69 body segments and 126 hinge joints, exported from flygym's MuJoCo model
//     (tools/export_nmf.py). Forward kinematics follow MuJoCo's rule: body pos/quat,
//     then each hinge in order.
//   - Walking: flygym's tripod CPG network (coupled phase oscillators, 12 Hz) reading
//     flygym's PreprogrammedSteps -- joint angles recorded from real walking flies --
//     exactly as flygym's HybridTurningController does, fed a 2-D descending signal.
//   - Everything else (grooming, proboscis, take-off, wing strokes, landing) is
//     hand-made on top of the same skeleton: flygym has no flight model.
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
export const LEGS = ['lf', 'lm', 'lh', 'rf', 'rm', 'rh'];

export async function loadFlyData(base, v = '') {
  const [J, bin] = await Promise.all([
    fetch(base + 'body.json' + v).then((r) => r.json()),
    fetch(base + 'meshes.bin.gz' + v).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
  ]);
  return { J, bin };
}
export async function loadFlyBody(base, v = '') {
  const { J, bin } = await loadFlyData(base, v);
  return new FlyBody(J, bin);
}

// ---------------------------------------------------------------- tiny quaternion math ([w,x,y,z], like MuJoCo)
const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qaxis = (ax, ang) => { const s = Math.sin(ang / 2); return [Math.cos(ang / 2), ax[0] * s, ax[1] * s, ax[2] * s]; };
function qrot(q, v) {
  const [w, x, y, z] = q, [a, b, c] = v;
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
const toThreeQ = (q, out = new THREE.Quaternion()) => out.set(q[1], q[2], q[3], q[0]);
// allocation-free versions for the per-frame paths: q <- q * axis-angle, out <- q v q*
function qmulAxisIn(q, ax, ang) {
  const s = Math.sin(ang / 2), bw = Math.cos(ang / 2), bx = ax[0] * s, by = ax[1] * s, bz = ax[2] * s;
  const [aw, a1, a2, a3] = [q[0], q[1], q[2], q[3]];
  q[0] = aw * bw - a1 * bx - a2 * by - a3 * bz; q[1] = aw * bx + a1 * bw + a2 * bz - a3 * by;
  q[2] = aw * by - a1 * bz + a2 * bw + a3 * bx; q[3] = aw * bz + a1 * by - a2 * bx + a3 * bw;
}
function qmulIn(q, b) {
  const [aw, a1, a2, a3] = [q[0], q[1], q[2], q[3]];
  q[0] = aw * b[0] - a1 * b[1] - a2 * b[2] - a3 * b[3]; q[1] = aw * b[1] + a1 * b[0] + a2 * b[3] - a3 * b[2];
  q[2] = aw * b[2] - a1 * b[3] + a2 * b[0] + a3 * b[1]; q[3] = aw * b[3] + a1 * b[2] - a2 * b[1] + a3 * b[0];
}
function qrotAdd(q, v, p) {           // p += q v q*
  const w = q[0], x = q[1], y = q[2], z = q[3], a = v[0], b = v[1], c = v[2];
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  p[0] += ix * w + iw * -x + iy * -z - iz * -y; p[1] += iy * w + iw * -y + iz * -x - ix * -z; p[2] += iz * w + iw * -z + ix * -y - iy * -x;
}
const _q4 = [1, 0, 0, 0];

// ---------------------------------------------------------------- procedural surface colour
function hash3(x, y, z) { let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t), u = s(xf), v = s(yf), w = s(zf);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++)
    r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  return r;
}
const lerp = (a, b, t) => a + (b - a) * t;
const srgb = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

// colour of one vertex (p: in the segment's body frame, box: that mesh's extent)
function vertexColour(name, p, box, base, out) {
  let [r, g, b] = [base.r, base.g, base.b];
  if (!name.endsWith('_eye')) { const l = 0.3 * r + 0.55 * g + 0.15 * b; r = lerp(r, l, 0.22); g = lerp(g, l, 0.22); b = lerp(b, l, 0.22); } // a little less orange
  const n1 = vnoise(p[0] * 22, p[1] * 22, p[2] * 22), n2 = vnoise(p[0] * 70 + 9, p[1] * 70, p[2] * 70);
  let k = 0.86 + 0.22 * n1 + 0.1 * (n2 - 0.5);
  if (name.startsWith('c_abdomen')) {
    // tergites: a dark band across the back of each segment, cream belly
    const t = (box.max[0] - p[0]) / Math.max(1e-6, box.max[0] - box.min[0]);   // 0 front .. 1 back
    const zc = (p[2] - box.min[2]) / Math.max(1e-6, box.max[2] - box.min[2]);  // 0 belly .. 1 back
    const dorsal = THREE.MathUtils.smoothstep(zc, 0.38, 0.62);
    const bandStart = name === 'c_abdomen6' ? 0.05 : name === 'c_abdomen5' ? 0.3 : 0.5;
    const band = THREE.MathUtils.smoothstep(t, bandStart, bandStart + 0.14) * dorsal;
    const dark = [0.12, 0.075, 0.035];
    r = r * (1 - band) + dark[0] * band; g = g * (1 - band) + dark[1] * band; b = b * (1 - band) + dark[2] * band;
    const belly = 1 - THREE.MathUtils.smoothstep(zc, 0.15, 0.4);
    r += (0.62 - r) * belly * 0.6; g += (0.52 - g) * belly * 0.6; b += (0.34 - b) * belly * 0.6;
  } else if (name === 'c_thorax') {
    // faint dorsal stripes of the scutum
    const zc = (p[2] - box.min[2]) / (box.max[2] - box.min[2]);
    const stripe = 0.5 + 0.5 * Math.cos(p[1] * 26);
    k *= 1 - 0.13 * stripe * THREE.MathUtils.smoothstep(zc, 0.55, 0.85);
  } else if (name.endsWith('_eye')) {
    k = 0.8 + 0.3 * n2;                       // ommatidial speckle
  } else if (/_(coxa|trochanterfemur|tibia|tarsus\d)$/.test(name)) {
    const len = box.max[2] - box.min[2], t = (box.max[2] - p[2]) / Math.max(1e-6, len); // 0 proximal .. 1 distal
    k *= 0.9 + 0.12 * Math.sin(t * Math.PI);  // darker at the joints
    if (name.includes('tarsus5')) k *= 0.75;
  }
  out[0] = r * k; out[1] = g * k; out[2] = b * k;
}

// Drosophila wing venation, drawn into a texture in the wing's own (span, chord) frame
function wingTexture() {
  if (typeof document === 'undefined') return null;   // (node tests)
  const W = 512, H = 256, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(200,206,212,0.26)'; g.fillRect(0, 0, W, H);
  // v = 1 at the leading edge (top of the texture = y 0)
  const P = (u, v) => [u * W, (1 - v) * H];
  const vein = (pts, w) => {
    g.lineWidth = w; g.strokeStyle = 'rgba(92,70,48,0.9)'; g.lineCap = 'round'; g.beginPath();
    g.moveTo(...P(...pts[0]));
    if (pts.length === 3) g.quadraticCurveTo(...P(...pts[1]), ...P(...pts[2]));
    else for (const p of pts.slice(1)) g.lineTo(...P(...p));
    g.stroke();
  };
  vein([[0.0, 0.93], [0.35, 1.0], [0.72, 0.98]], 6);      // costa
  vein([[0.08, 0.86], [0.4, 0.93], [0.74, 0.96]], 2.6);    // L2
  vein([[0.06, 0.74], [0.5, 0.72], [0.99, 0.62]], 2.6);    // L3
  vein([[0.07, 0.6], [0.5, 0.5], [0.97, 0.3]], 2.6);       // L4
  vein([[0.06, 0.48], [0.4, 0.3], [0.8, 0.06]], 2.6);      // L5
  vein([[0.04, 0.4], [0.18, 0.27], [0.3, 0.14]], 2.2);     // L6
  vein([[0.43, 0.71], [0.44, 0.53]], 2.2);                  // anterior crossvein
  vein([[0.62, 0.44], [0.58, 0.28]], 2.2);                  // posterior crossvein
  g.fillStyle = 'rgba(80,60,40,0.18)';                      // microtrichia
  for (let i = 0; i < 1400; i++) g.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- bristles
const BRISTLE = new THREE.CylinderGeometry(0.0012, 0.0065, 1, 5, 1, true).translate(0, 0.5, 0);
// macrochaetae: body, x, y (per side), length, direction (y per side)
const BRISTLE_SPOTS = [
  ['c_thorax', -0.42, 0.14, 0.26, [-1, 0.05, 0.55]],   // anterior dorsocentral
  ['c_thorax', -0.66, 0.14, 0.3, [-1, 0.05, 0.5]],     // posterior dorsocentral
  ['c_thorax', -0.93, 0.09, 0.34, [-1, -0.25, 0.35]],  // apical scutellar (crossing)
  ['c_thorax', -0.86, 0.17, 0.26, [-1, 0.2, 0.35]],    // basal scutellar
  ['c_thorax', -0.3, 0.33, 0.24, [-0.8, 0.5, 0.4]],    // notopleural / supra-alar
  ['c_thorax', -0.62, 0.36, 0.24, [-0.9, 0.4, 0.4]],
  ['c_head', 0.15, 0.1, 0.2, [-0.6, 0.35, 0.9]],       // vertical
  ['c_head', 0.22, 0.17, 0.16, [0.4, 0.3, 0.9]],       // orbital
  ['c_head', 0.28, 0.04, 0.14, [0.3, 0.6, 0.8]],       // ocellar
];
function bristleSpots(Pof) {
  const out = [], up = new THREE.Vector3(0, 1, 0);
  for (const [body, x, y0, len, d] of BRISTLE_SPOTS) for (const s of [1, -1]) {
    const y = y0 * s, P = Pof(body);
    let best = null;                                  // highest surface point near (x, y)
    for (const tol of [0.04, 0.08, 0.14]) {
      for (const p of P) if (Math.abs(p[0] - x) < tol && Math.abs(p[1] - y) < tol && (!best || p[2] > best[2])) best = p;
      if (best) break;
    }
    if (!best) continue;
    out.push({ body, len, pos: [best[0], best[1], best[2] - 0.005], q: new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(d[0], d[1] * s, d[2]).normalize()) });
  }
  return out;
}

// ---------------------------------------------------------------- the body
const SHARED = new WeakMap();
const WQ = { f: new THREE.Vector3(), n: new THREE.Vector3(), y: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Vector3(), nn: new THREE.Vector3(), R: new THREE.Matrix4() };      // body data -> meshes/materials shared by all flies built from it
export class FlyBody {
  // opts.lo = { meta, bin } (meshes_lo.*): "crowd" mode -- the whole body except the wings is one
  // skinned mesh of low-poly segments (one draw call per fly), added to the scene as `this.skin`
  constructor(J, bin, opts = {}) {
    this.J = J;
    const lo = opts.lo || null;
    this.nGhosts = opts.ghosts ?? 8;                        // blurred copies of each wing for fast strokes
    this.root = new THREE.Group();          // = the thorax frame, placed in the world by the caller
    this.root.name = 'fly';
    this.bodies = [];
    this.byName = {};
    this.joints = {};                        // name -> { axis, q, q0, body }
    if (!SHARED.has(J)) SHARED.set(J, {
      geo: new Map(), wingTex: wingTexture(),
      base: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.0 }),
      eye: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.35 }),
    });
    const { geo: cache, wingTex, base, eye: eyeMat } = SHARED.get(J);
    this.wingMat = new THREE.MeshPhysicalMaterial({
      map: wingTex, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false,
      roughness: 0.25, iridescence: 0.8, iridescenceIOR: 1.5, iridescenceThicknessRange: [250, 650],
    });
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0xc8d0d8, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
    const col = [0, 0, 0];

    for (const [i, b] of J.bodies.entries()) {
      const obj = new THREE.Object3D();
      obj.name = b.name;
      const body = {
        name: b.name, index: i, parent: b.parent, obj,
        pos: b.pos, quat: b.quat, joints: b.joints.map((j) => ({ ...j, q: j.q0 })), tip: b.tip || null,
      };
      for (const j of body.joints) this.joints[j.name] = j;
      if (b.parent >= 0) { obj.position.set(...b.pos); toThreeQ(b.quat, obj.quaternion); this.bodies[b.parent].obj.add(obj); }
      else this.root.add(obj);        // the thorax sits at the root, which carries the world pose
      this.bodies.push(body); this.byName[b.name] = body;

      if (!b.geom) continue;
      if (lo && !b.name.endsWith('wing')) continue;         // drawn by the skinned crowd mesh instead
      // geometry (and its colours) is shared by every fly built from the same data
      let shared = cache.get(b.name);
      if (!shared) {
        const m = J.meshes[b.geom.mesh];
        const Q = new Int16Array(bin, m.voff, m.vn * 3), F = new Uint16Array(bin, m.foff, m.fn * 3);
        const pos = new Float32Array(m.vn * 3);
        for (let v = 0; v < m.vn; v++) for (let a = 0; a < 3; a++) pos[v * 3 + a] = m.lo[a] + (Q[v * 3 + a] + 32768) * m.sc[a];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint16Array(F), 1));
        geo.computeVertexNormals();
        // positions in the body frame, for colouring and for the wing's own axes
        const gq = b.geom.quat, gp = b.geom.pos, P = [];
        const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
        for (let v = 0; v < m.vn; v++) {
          const w = qrot(gq, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
          w[0] += gp[0]; w[1] += gp[1]; w[2] += gp[2]; P.push(w);
          for (let a = 0; a < 3; a++) { box.min[a] = Math.min(box.min[a], w[a]); box.max[a] = Math.max(box.max[a], w[a]); }
        }
        if (!b.name.endsWith('wing')) {
          const baseCol = srgb(b.name.endsWith('_eye') ? [0.62, 0.1, 0.06] : b.geom.rgba);
          const colors = new Float32Array(m.vn * 3);
          for (let v = 0; v < m.vn; v++) { vertexColour(b.name, P[v], box, baseCol, col); colors.set(col, v * 3); }
          geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        shared = { geo, P, box };
        cache.set(b.name, shared);
      }
      const { geo, P, box } = shared;
      const mesh = new THREE.Mesh(geo);
      mesh.position.set(...b.geom.pos); toThreeQ(b.geom.quat, mesh.quaternion);
      mesh.castShadow = true; mesh.receiveShadow = !b.name.endsWith('wing');
      if (b.name.endsWith('wing')) this._setupWing(body, mesh, geo, P);
      else mesh.material = b.name.endsWith('_eye') ? eyeMat : base;
      body.mesh = mesh; body.P = P; body.box = box;
      obj.add(mesh);
    }
    this.thorax = this.byName.c_thorax;
    for (const g of this._ghostQueue || []) this.thorax.obj.add(g);
    this.wings = [this.byName.l_wing, this.byName.r_wing];
    if (lo) { this.skin = this._skinnedMesh(lo, base); this.microchaetae = []; this.dust = []; }
    else { this._addBristles(); this.dust = this._dustSpecks(); }
    this._legChains();
    this.update();
  }

  // --- wings: own axes (span from the hinge to the tip, chord toward the leading edge)
  _setupWing(body, mesh, geo, P) {
    const side = body.name[0] === 'l' ? 1 : -1;
    const c = [0, 0, 0];
    for (const p of P) { c[0] += p[0] / P.length; c[1] += p[1] / P.length; c[2] += p[2] / P.length; }
    const s0 = new THREE.Vector3(...c).normalize();
    // second principal axis, orthogonal to the span
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of P) { const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
    let v = new THREE.Vector3(0.3, 0.8, 0.5);
    const M = new THREE.Matrix3().set(...C[0], ...C[1], ...C[2]);
    for (let it = 0; it < 60; it++) { v.applyMatrix3(M); v.addScaledVector(s0, -v.dot(s0)).normalize(); }
    // at rest the leading edge (costa) is the lateral one
    const qRest = new THREE.Quaternion(); toThreeQ(body.quat, qRest);
    if (v.clone().applyQuaternion(qRest).y * side < 0) v.negate();
    const c0 = v, n0 = new THREE.Vector3().crossVectors(s0, c0);
    // planar UVs in (span, chord) for the vein texture
    let smin = 1e9, smax = -1e9, cmin = 1e9, cmax = -1e9;
    const S = P.map((p) => { const q = new THREE.Vector3(...p); const s = q.dot(s0), ch = q.dot(c0); smin = Math.min(smin, s); smax = Math.max(smax, s); cmin = Math.min(cmin, ch); cmax = Math.max(cmax, ch); return [s, ch]; });
    const uv = new Float32Array(P.length * 2);
    S.forEach(([s, ch], i) => { uv[i * 2] = (s - smin) / (smax - smin); uv[i * 2 + 1] = (ch - cmin) / (cmax - cmin); });
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    mesh.material = this.wingMat;
    mesh.renderOrder = 2;
    // blur copies for fast strokes
    const ghosts = [];
    for (let k = 0; k < this.nGhosts; k++) {
      const gm = new THREE.Mesh(geo, this.ghostMat);
      gm.position.copy(mesh.position); gm.quaternion.copy(mesh.quaternion);
      const holder = new THREE.Object3D(); holder.position.set(...body.pos); holder.add(gm); holder.visible = false;
      gm.renderOrder = 1;
      ghosts.push(holder);
    }
    body.wing = { side, qRest, axesRest: [s0.clone().applyQuaternion(qRest), c0.clone().applyQuaternion(qRest), n0.clone().applyQuaternion(qRest)], ghosts, length: smax };
    this._ghostQueue = (this._ghostQueue || []).concat(ghosts);
  }

  // macrochaetae on the scutum, scutellum and head; microchaetae as short lines
  _addBristles() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a120b, roughness: 0.6 });
    for (const sp of bristleSpots((n) => this.byName[n].P)) {
      const m = new THREE.Mesh(BRISTLE, dark);
      m.position.fromArray(sp.pos); m.scale.set(1, sp.len, 1); m.quaternion.copy(sp.q);
      m.castShadow = false; this.byName[sp.body].obj.add(m);
    }
    // microchaetae: many short hairs on the dorsal surfaces
    const lines = [];
    const hairy = [['c_thorax', 700, 0.045], ['c_head', 160, 0.035], ['c_abdomen12', 120, 0.04], ['c_abdomen3', 120, 0.04], ['c_abdomen4', 120, 0.04], ['c_abdomen5', 110, 0.04], ['c_abdomen6', 90, 0.04]];
    this.microchaetae = [];
    for (const [nm, n, len] of hairy) {
      const b = this.byName[nm], zc = (b.box.min[2] + b.box.max[2]) / 2, pos = [];
      let tries = 0;
      while (pos.length < n * 6 && tries++ < n * 40) {
        const p = b.P[(Math.random() * b.P.length) | 0];
        if (p[2] < zc) continue;
        pos.push(p[0], p[1], p[2], p[0] - len, p[1] + (Math.random() - 0.5) * len * 0.4, p[2] + len * 0.35);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x24170c, transparent: true, opacity: 0.55 }));
      b.obj.add(ls); this.microchaetae.push(ls);
    }
  }

  _dustSpecks() {
    const hd = this.byName.c_head, g = new THREE.SphereGeometry(0.022, 5, 4), m = new THREE.MeshStandardMaterial({ color: 0x9a927f, roughness: 1 });
    const specks = [];
    const pts = hd.P.filter((p) => p[0] > 0.2 && p[2] > -0.05);
    for (let i = 0; i < 40; i++) {
      const p = pts[(Math.random() * pts.length) | 0], s = new THREE.Mesh(g, m);
      s.position.set(...p); s.visible = false; s.userData.side = p[1] >= 0 ? 'L' : 'R'; s.userData.k = Math.random();
      hd.obj.add(s); specks.push(s);
    }
    return specks;
  }
  setDust(L, R) { for (const s of this.dust) s.visible = s.userData.k < (s.userData.side === 'L' ? L : R); }

  // --- crowd mode: one skinned mesh, bone i = body i (vertices in each body's own frame)
  _skinnedMesh(lo, mat) {
    const S = SHARED.get(this.J);
    if (!S.skinGeo) {
      const pos = [], col = [], si = [], sw = [], idx = [], Pby = {}, c3 = [0, 0, 0];
      const push = (bi, p, c) => { pos.push(p[0], p[1], p[2]); col.push(c[0], c[1], c[2]); si.push(bi, 0, 0, 0); sw.push(1, 0, 0, 0); };
      this.J.bodies.forEach((b, bi) => {
        const m = b.geom && !b.name.endsWith('wing') && lo.meta.meshes[b.name];
        if (!m) return;
        const Q = new Int16Array(lo.bin, m.voff, m.vn * 3), F = new Uint16Array(lo.bin, m.foff, m.fn * 3), P = [];
        const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
        for (let v = 0; v < m.vn; v++) {
          const w = qrot(b.geom.quat, [0, 1, 2].map((a) => m.lo[a] + (Q[v * 3 + a] + 32768) * m.sc[a]));
          for (let a = 0; a < 3; a++) { w[a] += b.geom.pos[a]; box.min[a] = Math.min(box.min[a], w[a]); box.max[a] = Math.max(box.max[a], w[a]); }
          P.push(w);
        }
        Pby[b.name] = P;
        const base = pos.length / 3, baseCol = srgb(b.name.endsWith('_eye') ? [0.62, 0.1, 0.06] : b.geom.rgba);
        for (const p of P) { vertexColour(b.name, p, box, baseCol, c3); push(bi, p, c3); }
        for (let k = 0; k < F.length; k++) idx.push(base + F[k]);
      });
      // the macrochaetae, baked into the same mesh
      const bp = BRISTLE.attributes.position, dark = srgb([0.1, 0.07, 0.045]), M = new THREE.Matrix4(), v = new THREE.Vector3();
      for (const sp of bristleSpots((n) => Pby[n])) {
        const bi = this.byName[sp.body].index, base = pos.length / 3;
        M.compose(new THREE.Vector3(...sp.pos), sp.q, new THREE.Vector3(1, sp.len, 1));
        for (let k = 0; k < bp.count; k++) { v.fromBufferAttribute(bp, k).applyMatrix4(M); push(bi, [v.x, v.y, v.z], [dark.r, dark.g, dark.b]); }
        for (let k = 0; k < BRISTLE.index.count; k++) idx.push(base + BRISTLE.index.getX(k));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      g.setIndex(idx); g.computeVertexNormals();
      S.skinGeo = g;
    }
    const skin = new THREE.SkinnedMesh(S.skinGeo, mat);
    const bones = this.bodies.map((b) => b.obj);
    skin.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
    skin.bindMode = 'detached';
    skin.castShadow = true; skin.receiveShadow = true; skin.frustumCulled = false;
    return skin;
  }

  // --- legs: plain-math forward kinematics in the thorax frame (for grounding and IK)
  _legChains() {
    this.chains = {};
    for (const leg of LEGS) {
      const names = ['coxa', 'trochanterfemur', 'tibia', 'tarsus1', 'tarsus2', 'tarsus3', 'tarsus4', 'tarsus5'].map((s) => `${leg}_${s}`);
      this.chains[leg] = names.map((n) => this.byName[n]);
    }
    const tpl = this.J.steps.dofs;
    this.legDofs = {};
    for (const leg of LEGS) {
      this.legDofs[leg] = tpl.map((t) => this.joints[t.replaceAll('{leg}', leg)]);
      this.legDofs[leg].forEach((j, k) => { j.dof = k; });            // column in the 7-angle vectors
    }
  }
  // tip of a leg's tarsus5 in the thorax frame, optionally with the 7 active DOFs overridden
  legTip(leg, angles7) {
    const dofs = this.legDofs[leg], p = [0, 0, 0], q = _q4;
    q[0] = 1; q[1] = q[2] = q[3] = 0;
    for (const b of this.chains[leg]) {
      qrotAdd(q, b.pos, p);
      qmulIn(q, b.quat);
      for (const j of b.joints) qmulAxisIn(q, j.axis, angles7 && j.dof !== undefined ? angles7[j.dof] : j.q);
    }
    qrotAdd(q, this.chains[leg][7].tip, p);
    return p;
  }
  setLeg(leg, a7) { const d = this.legDofs[leg]; for (let i = 0; i < 7; i++) d[i].q = a7[i]; }
  getLeg(leg) { return this.legDofs[leg].map((j) => j.q); }

  // damped least squares toward a tip target (thorax frame), pulled toward a rest pose;
  // warm-started from `init`, returns the 7 active angles (does not touch the body)
  ik(leg, target, init, rest, iters = 6, reg = 0.03) {
    const a = init.slice(), h = 1e-3, J = [[], [], []];
    for (let it = 0; it < iters; it++) {
      const p = this.legTip(leg, a), e = [target[0] - p[0], target[1] - p[1], target[2] - p[2]];
      for (let i = 0; i < 7; i++) { const b = a.slice(); b[i] += h; const pi = this.legTip(leg, b); for (let r = 0; r < 3; r++) J[r][i] = (pi[r] - p[r]) / h; }
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let s = 0; for (let i = 0; i < 7; i++) s += J[r][i] * J[c][i]; A[r][c] = s + (r === c ? 0.004 : 0); }
      const x = solve3(A, e);
      for (let i = 0; i < 7; i++) a[i] += Math.max(-0.3, Math.min(0.3, J[0][i] * x[0] + J[1][i] * x[1] + J[2][i] * x[2])) + reg * (rest[i] - a[i]);
    }
    return a;
  }

  // --- wings: stroke kinematics in the thorax frame
  //   phi: stroke angle (0 = sideways, + forward), dev: deviation, gam: rotation (chord angle in the stroke plane)
  wingQuat(body, phi, dev, gam, beta, out) {
    const w = body.wing, side = w.side, { f, n, y, s, c, nn, R } = WQ;
    f.set(Math.cos(beta), 0, -Math.sin(beta)); n.set(Math.sin(beta), 0, Math.cos(beta)); y.set(0, side, 0);
    s.copy(y).multiplyScalar(Math.cos(phi)).addScaledVector(f, Math.sin(phi)).addScaledVector(n, Math.tan(dev)).normalize();
    c.copy(y).multiplyScalar(-Math.sin(phi)).addScaledVector(f, Math.cos(phi));     // stroke direction ...
    c.multiplyScalar(Math.cos(gam)).addScaledVector(n, Math.sin(gam));              // ... tilted to the chord
    c.addScaledVector(s, -c.dot(s)).normalize();
    nn.crossVectors(s, c);
    w.restT ??= (() => { const [s0, c0, n0] = w.axesRest; return new THREE.Matrix4().makeBasis(s0, c0, n0).transpose(); })();
    R.makeBasis(s, c, nn).multiply(w.restT);
    return out.setFromRotationMatrix(R).multiply(w.qRest);
  }

  // write every joint into the three.js objects
  update() {
    const q = _q4;
    for (const b of this.bodies) {
      if (b.parent < 0) continue;
      q[0] = b.quat[0]; q[1] = b.quat[1]; q[2] = b.quat[2]; q[3] = b.quat[3];
      for (const j of b.joints) qmulAxisIn(q, j.axis, j.q);
      b.obj.quaternion.set(q[1], q[2], q[3], q[0]);
    }
  }
}

function solve3(A, b) {
  const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g) || 1e-12;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}

// ---------------------------------------------------------------- flygym's CPG + PreprogrammedSteps
export class CPG {
  constructor(J) {
    const s = J.steps, c = J.cpg;
    this.N = s.n; this.tab = LEGS.map((l) => s.table[l]);
    this.f0 = c.freq; this.w = c.coupling; this.conv = c.convergence; this.pb = c.phase_biases;
    this.phase = new Float64Array(6); this.mag = new Float64Array(6); this.freq = new Float64Array(6).fill(this.f0);
    this.amp = new Float64Array(6);
    this.reset();
  }
  reset() { for (let i = 0; i < 6; i++) { this.phase[i] = Math.random() * TAU; this.mag[i] = 0; } }
  // descending signal [dL, dR] as in flygym's HybridTurningController: |d| -> amplitude, sign -> direction
  step(dt, dL, dR) {
    for (let i = 0; i < 6; i++) { const d = i < 3 ? dL : dR; this.amp[i] = Math.abs(d); this.freq[i] = this.f0 * (d >= 0 ? 1 : -1); }
    const h = 1e-3, n = Math.max(1, Math.ceil(dt / h - 1e-9)), hh = dt / n, dph = this._dph ??= new Float64Array(6);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let j = 0; j < 6; j++) if (this.pb[i][j] > 0) s += this.mag[j] * this.w * Math.sin(this.phase[j] - this.phase[i] - this.pb[i][j]);
        dph[i] = TAU * this.freq[i] + s;
      }
      for (let i = 0; i < 6; i++) { this.phase[i] += dph[i] * hh; this.mag[i] += this.conv * (this.amp[i] - this.mag[i]) * hh; }
    }
  }
  angles(li, out = new Array(7), phase = this.phase[li], mag = this.mag[li]) {
    const t = this.tab[li], N = this.N;
    const x = (((phase % TAU) + TAU) % TAU) / TAU * N, i0 = Math.floor(x) % N, i1 = (i0 + 1) % N, f = x - Math.floor(x);
    for (let d = 0; d < 7; d++) {
      const v = t.angles[i0 * 7 + d] * (1 - f) + t.angles[i1 * 7 + d] * f;
      out[d] = t.neutral[d] + mag * (v - t.neutral[d]);
    }
    return out;
  }
  // 1 in stance, 0 in swing, smooth at the edges
  stance(li) {
    const p = ((this.phase[li] % TAU) + TAU) % TAU, [s, e] = this.tab[li].swing;
    const d = Math.min(Math.abs(p - s), Math.abs(p - e), Math.abs(p - s - TAU), Math.abs(p + TAU - e));
    const inSwing = p > s && p < e;
    return inSwing ? 0.5 - 0.5 * Math.min(1, d / 0.35) : 0.5 + 0.5 * Math.min(1, d / 0.35);
  }
  neutral(li) { return this.tab[li].neutral.slice(); }
}

// ---------------------------------------------------------------- physics-measured locomotion (flygym MuJoCo)
export class LocoMap {
  constructor(L) {
    this.vals = L.values; this.n = this.vals.length;
    const key = {};
    for (const r of L.runs) key[r.sig[0] + ',' + r.sig[1]] = r;
    this.grid = this.vals.map((a) => this.vals.map((b) => key[a + ',' + b]));
  }
  _idx(v) {
    const a = this.vals; v = Math.max(a[0], Math.min(a[a.length - 1], v));
    let i = 0; while (i < a.length - 2 && v > a[i + 1]) i++;
    return [i, (v - a[i]) / (a[i + 1] - a[i])];
  }
  // bilinear in the (left, right) descending signal
  at(dL, dR) {
    const [i, fi] = this._idx(dL), [j, fj] = this._idx(dR), G = this.grid, out = this._out ??= {};
    const a = G[i][j], b = G[i + 1][j], c = G[i][j + 1], d = G[i + 1][j + 1];
    const wa = (1 - fi) * (1 - fj), wb = fi * (1 - fj), wc = (1 - fi) * fj, wd = fi * fj;
    out.vx = wa * a.vx + wb * b.vx + wc * c.vx + wd * d.vx;
    out.vy = wa * a.vy + wb * b.vy + wc * c.vy + wd * d.vy;
    out.wz = wa * a.wz + wb * b.wz + wc * c.wz + wd * d.wz;
    return out;
  }
}
