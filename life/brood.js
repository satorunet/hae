// Eggs, larvae and pupae in real numbers. A mated female lays dozens of eggs a day, so each one is
// not an object of its own but a slot in a few instanced meshes (one draw call per kind, however
// many there are). They die the way a real brood does:
//   - some eggs never hatch
//   - larvae on one piece of fruit starve each other: the more there are, the more die each day
//   - some pupae never eclose
// and they do what real larvae do when food is short (Vijendravarma et al. 2013; Ahmad et al. 2015):
//   - larvae that smell a dead adult nearby crawl to it and feed on it; it feeds a few, then is gone
//   - on crowded food, small larvae now and then attack a bigger (third-instar) larva and eat it from
//     within in about two hours; a larva that has fed that way is spared the crowding for a day
// A pupa about to eclose is handed to `onEclose`; if that takes it (there is room on screen for
// another adult) it goes on as a 3D fly, otherwise the new adult flies off and is counted as dispersed.
import * as THREE from '../test03/vendor/three.module.min.js';

export const T = { hatch: 1, L2: 2, L3: 3, wander: 4, pupa: 5, eclose: 9.5 };   // days after laying, 25 °C
const START_CAP = 1024;               // instances to begin with; the meshes double whenever more are needed (no limit on numbers)
const HATCH_FAIL = 0.1, PUPA_FAIL = 0.07;
const K = 150;                        // larvae the fruit feeds before crowding bites
const CORPSE_K = 8;                   // ... and a dead fly
export const CORPSE_MEAT = 10;               // larva-days of food in one dead fly
const SMELL = 4;                      // mm: a feeding larva finds a dead fly this close
const CANNIBAL_RATE = 1.2;            // attacks a day per small larva, times how far the crowding is past half of what the food feeds
const CANNIBAL_DAYS = 2 / 24;         // a victim is eaten from within in about two hours
const CANNIBAL_REACH = 2;             // mm: how far a small larva goes for a bigger one
const LEN = { L1: 0.5, L2: 1.0, L3: 2.0 };   // drawn at half their real length, as before
const EGG_GAP = 0.26;                 // eggs closer than this push each other apart, sliding out into the gaps
const PUPA_R = 0.4, GRID = 0.9;       // a pupa's elbow room; grid cell for finding neighbours (the widest pair)
const PUPA = [1.1, 0.31, 0.26];        // puparium half-length, half-width, half-height (about 2.2 mm long)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

export class Brood {
  constructor(scene, site) {
    this.scene = scene; this.site = site;
    this.list = [];
    this.dead = { egg: 0, larva: 0, pupa: 0, cannibal: 0 };
    this.dispersed = 0;
    this.corpses = [];                // dead adults on the ground, set before each step: { x, y, r, meat, n }
    this.sphere = new THREE.SphereGeometry(1, 14, 10);
    this.mats = {
      eggs: new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.4, emissive: 0x1a1812 }),
      larvae: new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.35, emissive: 0x201c14 }),
      heads: new THREE.MeshStandardMaterial({ color: 0x17120c, roughness: 0.6 }),
      guts: new THREE.MeshStandardMaterial({ color: 0x8a6428, roughness: 0.8 }),
      pupae: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }),
    };
    this.cap = 0;
    this.grow(START_CAP);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.p = new THREE.Vector3(); this.s = new THREE.Vector3(); this.c = new THREE.Color();
    this.Z = new THREE.Vector3(0, 0, 1);
  }

  // (re)make the instanced meshes with room for `cap` of each kind
  grow(cap) {
    for (const k of Object.keys(this.mats)) {
      if (this[k]) { this.scene.remove(this[k]); this[k].dispose(); }
      const m = new THREE.InstancedMesh(this.sphere, this.mats[k], cap);
      m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m); this[k] = m;
    }
    this.pupae.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.larvae.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    this.cap = cap;
  }
  add(x, y, yaw, gen) {
    if (this.list.length >= this.cap) this.grow(this.cap * 2);
    const r = Math.random();
    this.list.push({ x, y, yaw, gen, age: 0, sex: Math.random() < 0.5 ? 'female' : 'male', ph: Math.random() * TAU, turn: 0,
      // fates drawn at laying: an egg that will not hatch, a pupa that will not eclose
      failEgg: r < HATCH_FAIL, failPupa: Math.random() < PUPA_FAIL, pupateAt: null });
    return true;
  }
  clear() { this.list = []; this.dead = { egg: 0, larva: 0, pupa: 0, cannibal: 0 }; this.dispersed = 0; for (const m of [this.eggs, this.larvae, this.heads, this.guts, this.pupae]) m.count = 0; }
  alive() { return this.list.length > 0; }
  counts() {
    const c = { egg: 0, larva: 0, pupa: 0, onCorpse: 0 };
    for (const b of this.list) { if (b.age < T.hatch) c.egg++; else if (b.age < T.pupa) { c.larva++; if (b.home && b.home !== 'fruit') c.onCorpse++; } else c.pupa++; }
    return c;
  }

  step(dt, days) {
    const site = this.site.position, R = this.site.userData.r;
    // where each feeding larva feeds: a dead fly it can smell, or the fruit
    const corpses = this.corpses.filter((c) => c.meat > 0);
    for (const c of corpses) c.n = 0;
    let onFruit = 0;
    for (const b of this.list) {
      if (b.age < T.hatch || b.age >= T.pupa) continue;
      if (b.home && b.home !== 'fruit' && !(b.home.meat > 0)) b.home = null;   // eaten up (or gone): back to looking
      if (b.age < T.wander && (!b.home || b.home === 'fruit')) {
        let best = null, bd = SMELL;
        for (const c of corpses) { const d = Math.hypot(c.x - b.x, c.y - b.y); if (d < bd) { bd = d; best = c; } }
        b.home = best || 'fruit';
      }
      b.home ??= 'fruit';
      if (b.home === 'fruit') onFruit++; else b.home.n++;
    }
    for (const c of corpses) {                                  // the larvae on it eat it away
      if (!c.n) continue;
      c.meat -= days * c.n;
      if (c.meat <= 0) c.eaten?.();
    }
    // crowding: the daily chance of a larva dying rises steeply with how many share the food
    const crowd = (b) => (b.home && b.home !== 'fruit' ? b.home.n / CORPSE_K : onFruit / K);
    let ne = 0, nl = 0, np = 0;
    const keep = [];
    for (const b of this.list) {
      b.gone = true;                                         // (until it is kept below)
      if (b.prey && (b.preyT += days) >= CANNIBAL_DAYS && (b.preyS += dt) > 1.5) { this.dead.cannibal++; if (!b.prey.gone) { b.prey.fedUntil = b.prey.age + 1; b.prey.victim = null; } continue; }   // eaten from within
      const was = b.age;
      b.age += days;
      if (b.failEgg && was < T.hatch && b.age >= T.hatch) { this.dead.egg++; continue; }
      if (b.age >= T.hatch && b.age < T.pupa) {
        const fed = b.fedUntil > b.age || b.victim;
        const hazard = (0.04 + (fed ? 0 : 0.9 * crowd(b) ** 2)) * days;
        if (!b.prey && Math.random() < hazard) { this.dead.larva++; if (b.victim) b.victim.prey = null; continue; }
        if (!b.victim && !b.prey && b.age < T.L3 && Math.random() < CANNIBAL_RATE * Math.max(0, crowd(b) - 0.5) * days) this.attack(b);
      }
      if (b.failPupa && b.age >= T.eclose - 0.5) { this.dead.pupa++; continue; }
      if (b.age >= T.eclose - 0.3) {                         // ready to come out
        if (!this.onEclose?.(b)) this.dispersed++;
        continue;
      }
      b.gone = false;
      keep.push(b);
      if (b.age < T.hatch) { this.drawEgg(b, ne++); continue; }
      if (b.age < T.pupa) {
        if (b.prey) { /* held still while it is eaten */ }
        else if (b.victim) { const v = b.victim, a = Math.atan2(v.y - b.y, v.x - b.x); b.yaw = a; b.ph += dt * TAU; b.x = v.x - Math.cos(a) * v.len * 0.3; b.y = v.y - Math.sin(a) * v.len * 0.3; }   // head buried in it
        else { const h = b.home && b.home !== 'fruit' ? b.home : null; this.stepLarva(b, dt, h ?? site, h ? h.r : R); }
        this.drawLarva(b, nl++);
        continue;
      }
      this.drawPupa(b, np++);
    }
    this.list = keep;
    this.jostle(dt);
    this.eggs.count = ne; this.larvae.count = nl; this.heads.count = nl; this.guts.count = nl; this.pupae.count = np;
    for (const m of [this.eggs, this.larvae, this.heads, this.guts, this.pupae]) m.instanceMatrix.needsUpdate = true;
    this.pupae.instanceColor.needsUpdate = true;
    this.larvae.instanceColor.needsUpdate = true;
  }

  // a small larva on crowded food goes for a bigger one close by
  attack(b) {
    let v = null, vd = CANNIBAL_REACH;
    for (const o of this.list) {
      if (o === b || o.prey || o.victim || o.age < T.L3 || o.age >= T.pupa || (o.home ?? 'fruit') !== (b.home ?? 'fruit')) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y); if (d < vd) { vd = d; v = o; }
    }
    if (!v) return;
    v.prey = b; v.preyT = 0; v.preyS = 0; b.victim = v;
  }

  // Crowded ones are pushed aside into whatever room there is: each pair that overlaps moves apart a
  // little every frame, so a heap spreads out and fills the gaps around it. Eggs push eggs; larvae and
  // pupae push each other (a larva crawls over eggs). Each counts as a disc about its width, so long
  // larvae and pupae still overlap a little at the ends.
  jostle(dt) {
    const give = Math.min(0.5, dt * 6), size = (b) => (b.egg ? EGG_GAP : GRID);   // eggs in a finer grid of their own
    const cell = new Map(), key = (i, j, e) => (i * 73856093) ^ (j * 19349663) ^ (e ? 83492791 : 0);
    for (const b of this.list) {
      b.egg = b.age < T.hatch;
      b.rad = b.egg ? EGG_GAP / 2 : b.age < T.pupa ? Math.max(0.1, (b.len || LEN.L1) * 0.2) : PUPA_R;
      const C = size(b), k = key(Math.floor(b.x / C), Math.floor(b.y / C), b.egg);
      let c = cell.get(k); if (!c) cell.set(k, (c = [])); c.push(b);
    }
    let moved = false;
    for (const b of this.list) {
      const C = size(b), ci = Math.floor(b.x / C), cj = Math.floor(b.y / C);
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        const c = cell.get(key(i, j, b.egg)); if (!c) continue;
        for (const o of c) {
          if (o === b || o.egg !== b.egg || o.victim === b || b.victim === o) continue;
          const gap = b.rad + o.rad;
          let dx = b.x - o.x, dy = b.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 >= gap * gap) continue;
          if (d2 < 1e-8) { const a = Math.random() * TAU; dx = Math.cos(a) * 1e-3; dy = Math.sin(a) * 1e-3; d2 = 1e-6; }
          const d = Math.sqrt(d2), push = (gap - d) * 0.5 * give / d;
          for (const [q, sgn] of [[b, 1], [o, -1]]) {
            q.x += sgn * dx * push; q.y += sgn * dy * push;
            if (q.pupateAt) { q.pupateAt[0] += sgn * dx * push; q.pupateAt[1] += sgn * dy * push; }   // a wandering larva settles where it was pushed
          }
          if (b.egg) b.yaw += (Math.random() - 0.5) * push * 0.5;
          moved = true;
        }
      }
    }
    if (!moved) return;
    let ne = 0, nl = 0, np = 0;   // redraw them where they now are
    for (const b of this.list) {
      if (b.age < T.hatch) this.drawEgg(b, ne++);
      else if (b.age < T.pupa) this.drawLarva(b, nl++);
      else this.drawPupa(b, np++);
    }
  }

  onFruit(b) { return Math.hypot(b.x - this.site.position.x, b.y - this.site.position.y) < this.site.userData.r; }
  set(mesh, i, x, y, z, yaw, sx, sy, sz) {
    this.q.setFromAxisAngle(this.Z, yaw);
    this.m.compose(this.p.set(x, y, z), this.q, this.s.set(sx, sy, sz));
    mesh.setMatrixAt(i, this.m);
  }
  drawEgg(b, i) { this.set(this.eggs, i, b.x, b.y, this.onFruit(b) ? 0.12 : 0.1, b.yaw, 0.25, 0.1, 0.1); }

  stepLarva(b, dt, site, R) {
    const a = b.age, wander = a >= T.wander;
    b.len = a < T.L2 ? lerp(LEN.L1 * 0.6, LEN.L1, a - T.hatch) : a < T.L3 ? lerp(LEN.L2 * 0.7, LEN.L2, a - T.L2) : LEN.L3 * lerp(0.75, 1, clamp(a - T.L3, 0, 1));
    b.ph += dt * (wander ? 1.6 : 1.0) * TAU;
    const speed = b.len * (wander ? 0.35 : 0.12) * Math.max(0, Math.sin(b.ph));
    if (wander) {                                             // off the fruit, to pupate somewhere dry nearby
      if (!b.pupateAt) { const ang = Math.atan2(b.y - site.y, b.x - site.x) + (Math.random() - 0.5); const r = R + 0.6 + Math.random() * 2.4; b.pupateAt = [site.x + Math.cos(ang) * r, site.y + Math.sin(ang) * r]; }
      const want = Math.atan2(b.pupateAt[1] - b.y, b.pupateAt[0] - b.x);
      b.yaw += Math.atan2(Math.sin(want - b.yaw), Math.cos(want - b.yaw)) * Math.min(1, dt * 1.5);
      if (Math.hypot(b.pupateAt[0] - b.x, b.pupateAt[1] - b.y) < 0.2) return;
    } else {                                                  // feeding: wandering over the fruit
      b.yaw += Math.sin(b.ph * 0.11 + b.x) * dt * 0.9;
      if (Math.hypot(b.x - site.x, b.y - site.y) > R * 0.85) { const back = Math.atan2(site.y - b.y, site.x - b.x); b.yaw += Math.atan2(Math.sin(back - b.yaw), Math.cos(back - b.yaw)) * Math.min(1, dt * 2); }
    }
    b.x += Math.cos(b.yaw) * speed * dt; b.y += Math.sin(b.yaw) * speed * dt;
  }
  drawLarva(b, i) {
    const L = b.len, w = L * 0.11, squeeze = b.prey ? 1 : 1 - 0.14 * Math.max(0, Math.sin(b.ph)), z = (this.onFruit(b) ? 0.1 : 0) + w * 0.9;
    const k = b.prey ? clamp(b.preyT / CANNIBAL_DAYS, 0, 1) : 0;   // a victim goes limp and dark as it is emptied
    this.larvae.setColorAt(i, this.c.setRGB(lerp(1, 0.55, k), lerp(1, 0.42, k), lerp(1, 0.3, k)));
    this.set(this.larvae, i, b.x, b.y, z, b.yaw, L * 0.5 * squeeze, w * (2 - squeeze), w);
    const hx = b.x + Math.cos(b.yaw) * L * 0.47 * squeeze, hy = b.y + Math.sin(b.yaw) * L * 0.47 * squeeze;
    this.set(this.heads, i, hx, hy, z, b.yaw, w * 0.45, w * 0.35, w * 0.35);
    this.set(this.guts, i, b.x, b.y, z + w * 0.25, b.yaw, L * 0.28, w * 0.35, w * 0.4);
  }
  drawPupa(b, i) {
    const k = clamp((b.age - T.pupa) / 0.8, 0, 1);             // white, then tan, then brown as the case hardens
    this.set(this.pupae, i, b.x, b.y, PUPA[2] * 1.1, b.yaw, PUPA[0], PUPA[1], PUPA[2]);
    this.pupae.setColorAt(i, this.c.setRGB(lerp(0.93, 0.42, k), lerp(0.89, 0.25, k), lerp(0.78, 0.1, k)));
  }
}
