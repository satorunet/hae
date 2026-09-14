// Teeth, gums and tongue for the skin's open mouth.
//
// Everything is built in the head body's rest frame (MuJoCo coordinates, as the skin's bind pose):
// the upper arch is fixed to the head; the lower arch, lower gum and tongue hang from the jaw hinge
// and turn with the same angle the skin's jaw morph opens by (fit_skin.py: jawHinge, jawAngle), so
// teeth and lips part together.
import * as THREE from '../../test03/vendor/three.module.min.js';

const enamel = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.32, metalness: 0 });
// (the gum's colour comes per vertex: paler pink at the edge round the teeth, deeper red up in the fold)
const gum = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0, side: THREE.DoubleSide });
const tongueMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.34, metalness: 0 });   // (wet)
// A tongue, as a unit shape (x across, y up, z forward to the tip): flat and broad, narrowing to a
// rounded tip, a shallow groove down the middle of its top, its underside flatter still - and its top
// rough with papillae (tiny bumps and a mottled colour), pinker toward the tip and deeper red at the root
function tongueGeo() {
  const geo = new THREE.SphereGeometry(1, 36, 22), p = geo.attributes.position, col = [];
  const tip = new THREE.Color(0xdc8b93), root = new THREE.Color(0xa9505c), c = new THREE.Color();
  const noise = (x, y, z) => { const v = Math.sin(x * 91.7 + y * 47.3 + z * 63.1) * 43758.5453; return v - Math.floor(v); };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const front = Math.max(0, z);
    x *= (1 - 0.42 * front * front) * (z < 0 ? 1 + 0.08 * -z : 1);          // (narrowing to the tip; a little fuller at the root)
    if (y > 0) {
      y *= 0.75;
      y -= 0.32 * y * Math.exp(-((x / 0.22) ** 2)) * (0.4 + 0.6 * (1 - front));   // (the groove, fading out at the tip)
      y += 0.03 * (noise(x, y, z) - 0.5) * (0.5 + 0.5 * front);                  // (papillae)
    } else y *= 0.55;
    p.setXYZ(i, x, y, z);
    c.copy(root).lerp(tip, Math.min(1, (z + 1) / 1.6)).multiplyScalar(0.93 + 0.1 * noise(z, x, y) + (y > 0 ? 0 : -0.06));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}
const throatMat = new THREE.MeshStandardMaterial({ color: 0x8c3c42, roughness: 0.9 });

// The teeth of one side, from the middle back, in mm as an adult's (width along the arch, crown height,
// thickness front to back): central incisor, lateral incisor, canine, two premolars, three molars.
// The arch here is smaller than an adult's, so they are all scaled down together to fit it.
const TEETH_MM = {
  upper: { w: [8.5, 6.5, 7.5, 7, 6.5, 10, 9, 8.5], h: [10.5, 9, 10, 8.5, 8, 7.5, 7, 6.5], t: [7, 6, 8, 9, 9, 11, 10, 9.5] },
  lower: { w: [5.5, 6, 7, 7, 7, 11, 10.5, 10], h: [9, 9.5, 11, 8.5, 8, 7.5, 7, 6.5], t: [6, 6, 7.5, 8, 8, 10.5, 10, 9.5] },
};
// a tooth: a rounded rectangle in section (a cylinder pushed out toward its corners), a little narrower
// at the gum (above for the upper teeth, below for the lower) - and a canine's edge drawn to a point
const toothGeo = (up, pointed) => {
  const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 4), p = geo.attributes.position, edge = up ? -1 : 1;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
    const sq = r > 1e-6 ? r / Math.max(Math.abs(x), Math.abs(z)) : 1, round = 1 + (sq - 1) * 0.6;   // (60% of the way to a square)
    const toEdge = 0.5 + edge * y;                                          // 1 at the biting edge, 0 at the gum
    const k = (0.84 + 0.16 * toEdge) * round * (pointed ? 1 - 0.35 * toEdge ** 3 : 1);
    p.setX(i, Math.max(-0.5, Math.min(0.5, x * k))); p.setZ(i, Math.max(-0.5, Math.min(0.5, z * k)));
    if (pointed && toEdge > 0.99) p.setY(i, y + edge * 0.12 * Math.max(0, 1 - Math.abs(x) / 0.5));   // (the tip)
  }
  geo.computeVertexNormals();
  return geo;
};
const TOOTH = { upper: toothGeo(true, false), upperCanine: toothGeo(true, true), lower: toothGeo(false, false), lowerCanine: toothGeo(false, true) };
// a small fixed wobble per tooth, so the rows are not machine-straight
const wobble = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };

// One arch: 16 teeth on a U from molar to molar, each in its slot along the arch (its share of the
// length by its width) and filling 90% of it, so a dark gap shows between them; and the gum they stand
// in - a rounded ridge along the arch whose edge dips over each tooth and rises into a point (the
// papilla) between each two, as a real gum line does.
function arch(upper) {
  const g = new THREE.Group();
  const W = 0.024, D = 0.034;                               // half-width and depth of the arch (m)
  const at = (a) => [W * Math.sin(a), -D * (1 - Math.cos(a))];   // x left, z forward (toward the lips)
  const N = 400, cum = [0];
  for (let k = 1; k <= N; k++) { const p = at(-Math.PI / 2 + Math.PI * (k - 1) / N), q = at(-Math.PI / 2 + Math.PI * k / N); cum.push(cum[k - 1] + Math.hypot(q[0] - p[0], q[1] - p[1])); }
  const angleAt = (len) => { let k = 1; while (k < N && cum[k] < len) k++; const f = (len - cum[k - 1]) / (cum[k] - cum[k - 1] || 1); return -Math.PI / 2 + Math.PI * (k - 1 + f) / N; };
  const mm = TEETH_MM[upper ? 'upper' : 'lower'];
  const kind = (i) => Math.round(Math.abs(i - 7.5) - 0.5);                // 0 central incisor ... 7 third molar
  const scale = cum[N] / Array.from({ length: 16 }, (_, i) => mm.w[kind(i)]).reduce((a, b) => a + b, 0);   // m per mm
  const sgnY = upper ? -1 : 1, bounds = [0], thick = [];
  let from = 0;
  for (let i = 0; i < 16; i++) {
    const q = kind(i), slot = mm.w[q] * scale, a = angleAt(from + slot / 2);
    from += slot; bounds.push(from);
    const w = slot * 0.9, h = mm.h[q] * scale, t = mm.t[q] * scale;
    thick.push([from - slot, from, t]);
    const tooth = new THREE.Mesh(TOOTH[(upper ? 'upper' : 'lower') + (q === 2 ? 'Canine' : '')], enamel);
    tooth.scale.set(w, h, t);
    const [x, z] = at(a);
    tooth.position.set(x, sgnY * (h / 2 - 0.0012) + 0.00025 * wobble(i, upper ? 1 : 2), z);
    tooth.rotation.set(0.03 * wobble(i, 3), Math.atan2(D * Math.sin(a), W * Math.cos(a)) + 0.05 * wobble(i, 4), 0.03 * wobble(i, 5));
    g.add(tooth);
  }
  // the gum: NS stations along the arch, NP points across the ridge from inside (tongue side) to outside
  const NS = 240, NP = 11, pos = [], col = [], idx = [];
  const edgeCol = new THREE.Color(0xe7a3a2), foldCol = new THREE.Color(0xa9505a), tmp = new THREE.Color();
  for (let si = 0; si <= NS; si++) {
    const len = cum[N] * si / NS, a = angleAt(len), [x, z] = at(a);
    const tx = W * Math.cos(a), tz = D * Math.sin(a), tl = Math.hypot(tx, tz), nx = -tz / tl, nz = tx / tl;   // (n: outward, toward the lips and cheeks)
    const tooth = thick.find(([s0, s1]) => len >= s0 && len <= s1) || thick[thick.length - 1];
    let pap = 0;                                                         // how near a gap between two teeth (1 right at it)
    for (const b of bounds) pap = Math.max(pap, 1 - Math.abs(len - b) / 0.0022);
    pap = Math.max(0, pap) ** 1.6;
    const margin = sgnY * (0.0010 + 0.0024 * pap);                      // the edge over the tooth: lower over its middle, down to a point between
    const top = -sgnY * 0.0055, half = tooth[2] / 2 + 0.0012;
    for (let pi = 0; pi < NP; pi++) {
      const ph = Math.PI * pi / (NP - 1), sn = Math.sin(ph);
      const off = -Math.cos(ph) * half * (1 + 0.3 * sn);                 // (a rounded ridge, fuller than the tooth)
      const y = margin + (top - margin) * sn ** 0.8;
      pos.push(x + nx * off, y, z + nz * off);
      tmp.copy(edgeCol).lerp(foldCol, Math.min(1, sn * 1.2)).multiplyScalar(0.94 + 0.06 * pap);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let si = 0; si < NS; si++) for (let pi = 0; pi < NP - 1; pi++) {
    const a0 = si * NP + pi, a1 = a0 + 1, b0 = a0 + NP, b1 = b0 + 1;
    idx.push(a0, b0, a1, a1, b0, b1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  g.add(new THREE.Mesh(geo, gum));
  return g;
}

/**
 * @param {THREE.Object3D} headBone  the skinned head bone
 * @param {object} info              skin.json (mouth, jawHinge, jawAngle)
 * @param {THREE.Matrix4} restHead   the head body's rest pose (world of the MuJoCo group)
 * @param {{fwd, up, left}} axes     head-frame directions of the face
 * @returns {{ open(amount) }}       amount 0..1, the same as the jaw morph's influence
 */
export function buildMouth(headBone, info, restHead, axes) {
  const toHead = restHead.clone().invert();
  const mouth = new THREE.Vector3(...info.mouth).applyMatrix4(toHead);
  const hinge = new THREE.Vector3(...info.jawHinge).applyMatrix4(toHead);
  const basis = new THREE.Matrix4().makeBasis(axes.left, axes.up, axes.fwd);
  const orient = new THREE.Quaternion().setFromRotationMatrix(basis);

  // the upper teeth, fixed in the head, just behind the lips
  const upper = arch(true);
  upper.quaternion.copy(orient);
  upper.position.copy(mouth).addScaledVector(axes.fwd, -0.006).addScaledVector(axes.up, 0.001);
  headBone.add(upper);

  // the back of the mouth: dark red, well behind the teeth so they stand out against it
  const throat = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), throatMat);
  throat.quaternion.copy(orient);
  throat.scale.set(0.026, 0.024, 0.024);
  throat.position.copy(mouth).addScaledVector(axes.fwd, -0.052).addScaledVector(axes.up, -0.006);
  headBone.add(throat);

  // the jaw: a pivot at the hinge carrying the lower teeth and the tongue
  const jaw = new THREE.Group();
  jaw.position.copy(hinge);
  headBone.add(jaw);
  const lower = arch(false);
  lower.quaternion.copy(orient);
  lower.position.copy(mouth).addScaledVector(axes.fwd, -0.013).addScaledVector(axes.up, -0.009).sub(hinge);
  jaw.add(lower);
  const tongue = new THREE.Mesh(tongueGeo(), tongueMat);
  tongue.quaternion.copy(orient);
  tongue.scale.set(0.0165, 0.0085, 0.024);
  tongue.position.copy(mouth).addScaledVector(axes.fwd, -0.036).addScaledVector(axes.up, -0.0065).sub(hinge);   // (its top just below the lower teeth's edge)
  jaw.add(tongue);

  const q = new THREE.Quaternion();
  return {
    open(amount) {
      // the skin's morph turns about the rest frame's x (the face's left) by jawAngle * amount; the
      // lips carry only part of the jaw's weight and drop less, so the teeth turn by less too to stay
      // just behind the lower lip
      q.setFromAxisAngle(axes.left, 0.72 * info.jawAngle * Math.max(0, Math.min(1, amount)));
      jaw.quaternion.copy(q);
    },
  };
}
