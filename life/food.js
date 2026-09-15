// Food on the ground: drops of fruit juice and blobs of yeast paste that turn up now and then
// around the fruit. Hungry flies walk or fly to the nearest one and eat it down; an eaten-up
// piece disappears, and new ones keep appearing.
import * as THREE from '../test03/vendor/three.module.min.js';

const EVERY_S = 10;               // a new piece this often (real seconds), up to MAX at a time
const MAX = 6;                    // that turn up by themselves
const MAX_TAPPED = 12;            // with the ones people put down
const EAT_S = 1.2;                // one fly eats a whole piece in this many seconds
// Hunger, in real seconds (behaviour is real time; on the squeezed day clock a real fly lasts 2-3 days
// without food): hungry after HUNGRY_S, and a fly still unfed when its hunger reaches STARVE dies.
export const HUNGRY_S = 35, STARVE = 3;

export class Foods {
  constructor(scene, site) {
    this.scene = scene; this.site = site;
    this.list = [];
    this.t = EVERY_S - 3;
    this.geo = new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);   // a dome on the ground
    this.mats = {
      juice: new THREE.MeshPhysicalMaterial({ color: 0xe0a53a, roughness: 0.06, clearcoat: 1, transmission: 0.35, thickness: 0.4, transparent: true, opacity: 0.9 }),
      yeast: new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.9, emissive: 0x151008 }),
    };
    this.ring = new THREE.RingGeometry(0.9, 1.25, 32);
  }

  step(dt) {
    this.t += dt;
    if (this.t >= EVERY_S && this.list.length < MAX) { this.t = 0; this.spawn(); }
    for (const f of this.list) {
      f.born = Math.min(1, f.born + dt / 0.8);                  // it swells into view
      const s = f.r * Math.max(0.25, Math.sqrt(f.amount)) * f.born;
      f.mesh.scale.set(s, s, s * (f.kind === 'juice' ? 0.45 : 0.6));
      f.halo.material.opacity = 0.35 * f.born * Math.max(0, 1 - f.age / 2); f.age += dt;
    }
    for (const f of this.list.filter((x) => x.amount <= 0)) this.remove(f);
  }

  /** A new piece: at (x, y) if given (a tap), else somewhere around the fruit. */
  spawn(at = null) {
    const c = this.site.position;
    let x, y, tries = 0;
    if (at) {
      [x, y] = at;
      if (this.list.length >= MAX_TAPPED) this.remove(this.list[0]);   // too many: the oldest goes
    } else do {                                                   // around the fruit, not on it, not on another piece
      const a = Math.random() * Math.PI * 2, r = 3.2 + Math.random() * 5.5;
      x = c.x + Math.cos(a) * r; y = c.y + Math.sin(a) * r;
    } while (tries++ < 20 && this.list.some((f) => Math.hypot(f.x - x, f.y - y) < 1.5));
    const kind = Math.random() < 0.6 ? 'juice' : 'yeast';
    const mesh = new THREE.Mesh(this.geo, this.mats[kind]);
    mesh.position.set(x, y, 0.005);
    const halo = new THREE.Mesh(this.ring, new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.35, depthWrite: false }));
    halo.position.set(x, y, 0.01);
    this.scene.add(mesh); this.scene.add(halo);
    const f = { x, y, kind, amount: 1, r: kind === 'juice' ? 0.42 : 0.34, mesh, halo, born: 0, age: 0, eaters: 0 };
    this.list.push(f);
    return f;
  }

  remove(f) { this.scene.remove(f.mesh); this.scene.remove(f.halo); this.list = this.list.filter((x) => x !== f); }
  clear() { for (const f of [...this.list]) this.remove(f); this.t = EVERY_S - 3; }

  /** The nearest piece with food left, or null. */
  nearest(x, y) {
    let best = null, bd = Infinity;
    for (const f of this.list) { if (f.amount <= 0 || f.eaters >= 3) continue; const d = Math.hypot(f.x - x, f.y - y); if (d < bd) { bd = d; best = f; } }
    return best;
  }
  eat(f, dt) { f.amount -= dt / EAT_S; return f.amount > 0; }
}
