import * as THREE from '../test03/vendor/three.module.min.js';

// The song made visible: a short stretch of the waveform drawn on a sprite, flying
// from his vibrating wing to her antennae. Pulse song = packets 35 ms apart (orange),
// sine song = a continuous hum (blue).
export function waveTexture(kind) {
  const W = 256, H = 96, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), col = kind === 'pulse' ? '255,176,84' : '110,200,255';
  const y = (x) => {
    if (kind === 'sine') return Math.sin(x / W * Math.PI * 2 * 5) * 0.8;
    // three pulses, 35 ms apart, in a 105 ms stretch
    let v = 0;
    for (const c0 of [0.17, 0.5, 0.83]) { const u = (x / W - c0) / 0.045; v += Math.exp(-u * u) * Math.sin((x / W - c0) * Math.PI * 2 * 24); }
    return v;
  };
  for (const [w, a] of [[14, 0.12], [7, 0.3], [3, 1]]) {        // a glow, then the line
    g.strokeStyle = `rgba(${col},${a})`; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    for (let x = 6; x <= W - 6; x += 2) { const py = H / 2 - y(x) * (H / 2 - 12); x === 6 ? g.moveTo(x, py) : g.lineTo(x, py); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The song as a beam of light from the vibrating wing to the female's head: a bright core inside a soft
// glow, with packets of light running along it toward her - in bursts for pulse song (orange),
// a steady stream for sine song (blue). Additive, so it glows over the scene.
function beamTexture(kind) {
  const W = 32, H = 256, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  for (let y = 0; y < H; y++) {
    const u = y / H;
    let v;
    if (kind === 'pulse') { const ph = (u * 6) % 1; v = 0.18 + 0.82 * Math.exp(-(((ph - 0.5) / 0.12) ** 2)); }   // six packets along the beam
    else v = 0.45 + 0.35 * Math.sin(u * Math.PI * 2 * 5) ** 2;
    g.fillStyle = `rgba(255,255,255,${v.toFixed(3)})`; g.fillRect(0, y, W, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const BEAM_COLOR = { pulse: 0xffa640, sine: 0x5cc4ff };
const Y = new THREE.Vector3(0, 1, 0);
export function createBeam(scene) {
  const tex = { pulse: beamTexture('pulse'), sine: beamTexture('sine') };
  const geo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
  const layer = (radius, opacity) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex.pulse, color: BEAM_COLOR.pulse, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.userData = { radius, opacity }; m.renderOrder = 11; m.visible = false; m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const core = layer(0.035, 1), glow = layer(0.13, 0.35), flare = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: BEAM_COLOR.pulse, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  flare.renderOrder = 11; flare.visible = false; scene.add(flare);
  const B = { core, glow, flare, level: 0, scroll: 0, kind: 'pulse' };
  const dir = new THREE.Vector3(), mid = new THREE.Vector3();
  /** Each frame: `on` while singing; `from`/`to` in the world; `kind` 'pulse' | 'sine'. */
  B.update = (dt, on, from, to, kind, gain = 1) => {
    B.level += ((on ? 1 : 0) - B.level) * Math.min(1, dt * (on ? 8 : 5));
    const vis = B.level > 0.01 && from && to;
    for (const m of [core, glow, flare]) m.visible = !!vis;
    if (!vis) return;
    if (kind !== B.kind) { B.kind = kind; for (const m of [core, glow]) { m.material.map = tex[kind]; m.material.needsUpdate = true; } }
    for (const m of [core, glow, flare]) m.material.color.setHex(BEAM_COLOR[kind]);
    dir.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-3) return;
    dir.normalize();
    mid.addVectors(from, to).multiplyScalar(0.5);
    B.scroll -= dt * (kind === 'pulse' ? 1.6 : 1.1);           // light runs from the wing toward her
    const beat = kind === 'pulse' ? 0.75 + 0.25 * Math.sin(performance.now() / 1000 * Math.PI * 2 * 9) : 0.9 + 0.1 * Math.sin(performance.now() / 1000 * 40);
    for (const m of [core, glow]) {
      m.position.copy(mid);
      m.quaternion.setFromUnitVectors(Y, dir);
      const r = m.userData.radius * (0.7 + 0.3 * gain) * (0.85 + 0.15 * beat);
      m.scale.set(r, len, r);
      m.material.map.repeat.set(1, Math.max(1, len / 1.2));
      m.material.map.offset.y = B.scroll;
      m.material.opacity = m.userData.opacity * B.level * beat;
    }
    flare.position.copy(from);                                    // a glow where it leaves the wing
    flare.scale.setScalar(0.12 * (0.8 + 0.4 * beat));
    flare.material.opacity = 0.6 * B.level * beat;
  };
  B.dispose = () => { for (const m of [core, glow, flare]) scene.remove(m); };
  return B;
}

/** A point along a wing, `frac` of the way from hinge to tip, in world coordinates. */
export function wingPoint(w, frac, out = new THREE.Vector3()) {
  const span = w.wing.spanLocal ??= w.wing.axesRest[0].clone().applyQuaternion(w.wing.qRest.clone().invert());
  return w.obj.localToWorld(out.copy(span).multiplyScalar(w.wing.length * frac));
}
