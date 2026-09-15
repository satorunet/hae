// From egg to adult: the eggs she lays are 3D objects that develop, on a clock
// squeezed from D. melanogaster's timetable at 25 °C:
//
//   egg 1 day -> larva L1 1 day -> L2 1 day -> L3 feeding 1 day, wandering 1 day
//   -> pupa (puparium) about 4.5 days -> the adult ecloses
//
// Sizes against the adult (a body length of about 2.5 mm): egg 0.5 mm as in life; larvae and puparium
// drawn at about half their real length (L3 really about 4 mm, the puparium about 3 mm).
// Adults then live out a lifespan (at 25 °C mostly 40-60 days; each one draws its own)
// and die: on their backs, legs folded. None of this is driven by a brain - it is
// development and ageing, played to a timetable. Only the day clock is squeezed;
// walking and the rest move in real time.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LEGS } from '../test03/body3d.js?v=6';
import { waveTexture, createBeam, wingPoint } from './song.js?v=3';
import { HUNGRY_S, STARVE } from './food.js?v=6';
import { Brood, T as BT, CORPSE_MEAT } from './brood.js?v=8';
export { CORPSE_MEAT };

const T_HATCH = 1, T_L2 = 2, T_L3 = 3, T_WANDER = 4, T_PUPA = 5, T_ECLOSE = 9.5;   // days after laying
// larval length, in the scene's mm. Real ones reach about 4 mm (L3), longer than the adult; drawn at
// half that so they do not swamp the scene
const LEN = { L1: 0.5, L2: 1.0, L3: 2.0 };
const PUPA_SCALE = 0.73;                         // puparium about 2.2 mm (real: about 3 mm)
// A new adult: small-looking (body and wings not yet expanded), yellow-green and soft; over about a day it
// fills out and darkens to its parents' colour. (A real adult does not grow after that - the change
// here is drawn larger than life so it can be seen.)
const TENERAL_SIZE = 0.55;
const GREEN_DAYS = 1, GROW_DAYS = 2;              // yellow-green and small for a day; then two days to fill out and colour up
// just out: soft, pale yellow-green (the cuticle is not yet hardened or tanned, and the green-black
// meconium shows through the abdomen); then pale tan; then the parents' colour
const PALE = [0.95, 1.6, 0.45], TAN = [1.25, 1.12, 0.72];
// The young court each other. They have no brains of their own running: a female's answer follows what
// the mother's whole brain did (virgin + song -> vpoDN over threshold -> stands still; mated -> does not).
const MALE_MATURE = 2, FEMALE_MATURE = 2.5;      // days after eclosion before courting / accepting (once grown here; real flies within hours to 2 days)
const COURT_RANGE = 9, SING_D = 2.4;             // mm: males look this far for a female; sing from this close
const ACCEPT_S = 1.5, GIVE_UP_S = 9, COPULATE_S = 10, COOLDOWN_S = 12;   // seconds (behaviour is in real time)
const EGGS_PER_DAY = 50, HOLD_MAX = 80, BATCH_MIN = 40, PUMP_S = 1.2;   // a mated young female: eggs ripen at this rate and come out a batch at a time, all at once
const CORPSE_SEEK = 10, CORPSE_LAY = 0.6;         // mm a female about to lay notices a dead fly from; how often she then lays on it rather than the fruit
const ADULT_CAP = Infinity;                       // adults living on screen (no limit for now; with a number here, any more fly off when they emerge)
export const YOUNG_TEXT = { roam: '', approach: '近づく', sing: '歌う', mount: '乗る', copulate: '交尾中', cooldown: '休む',
  listen: '聴いている', accept: '受け入れた', reject: '拒んだ', seek: '果物へ', lay: '産卵中', toFood: '餌へ', feed: '食べている', fly: '飛んでいる' };
const SEG = 11;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const rnd = (a, b) => a + Math.random() * (b - a);
const NMF = new URL('../test03/nmf/', import.meta.url).href;
// the young are drawn in the low-poly 'crowd' form (one skinned mesh per fly, as on the swatting game):
// the full NeuroMechFly meshes are about 220,000 triangles each, and dozens of them stall the page
let flyData = null;                               // loaded once for every offspring

export const STAGE_TEXT = { egg: '卵', L1: '1 齢幼虫', L2: '2 齢幼虫', L3: '3 齢幼虫', wander: '3 齢幼虫（さなぎになる場所を探す）', pupa: 'さなぎ', adult: '成虫', dead: '死んだ' };
/** A lifespan in days for one adult: at 25 °C most live 40-60 days. */
export const lifespan = () => clamp(50 + 9 * (Math.random() + Math.random() + Math.random() - 1.5) * 1.4, 25, 80);
const TUCK = { f: [0.5, 0.28, -0.62], m: [-0.5, 0.42, -0.9], h: [-1.45, 0.3, -0.82] };   // legs folded (as in flight)
/**
 * Dying, then dead. `t` is the real seconds since it died. From standing, its legs tremble and
 * give way, it keels over onto its back, the legs curl up with a few last twitches, and it lies
 * still. Call right before rendering; `standZ` is its thorax height while standing.
 */
/** The legs folded up (flight, death), solved once per body. */
export function tuckAngles(body) {
  return body._tuck ??= LEGS.map((leg) => {
    const sgn = leg[0] === 'l' ? 1 : -1, tk = TUCK[leg[1]];
    return body.ik(leg, [tk[0], sgn * tk[1], tk[2]], body.getLeg(leg).slice(), body.getLeg(leg).slice(), 60, 0.02);
  });
}
export function poseDying(body, x, y, yaw, standZ, scale, t) {
  tuckAngles(body);
  if (!body._dieFrom || t < body._dieT) body._dieFrom = LEGS.map((leg) => body.getLeg(leg).slice());   // the legs as they were
  body._dieT = t;
  const side = body._dieSide ??= Math.random() < 0.5 ? 1 : -1;
  const k1 = clamp(t / 1.2, 0, 1), k2 = ease((t - 1.0) / 1.4), k3 = ease((t - 2.0) / 2.0);
  // legs: trembling, then folding up, with twitches that die away
  LEGS.forEach((leg, i) => {
    const from = body._dieFrom[i], to = body._tuck[i], a = new Array(7);
    const fold = 0.35 * k2 + 0.65 * k3;
    const shake = (1 - k3) * (0.06 * k1 * Math.sin(t * 31 + i * 1.7) + (t > 2 ? 0.14 * Math.max(0, Math.sin(t * 9 + i * 2.3)) ** 3 : 0));
    for (let d = 0; d < 7; d++) a[d] = lerp(from[d], to[d], fold) + (d === 3 || d === 5 ? shake : 0);
    body.setLeg(leg, a);
  });
  // body: sags as the legs give way, wobbles, keels over sideways onto its back and settles
  const sag = standZ * lerp(1, 0.62, k1);
  const roll = side * (0.12 * k1 * Math.sin(t * 7) * (1 - k2) + Math.PI * k2);
  const lift = Math.sin(Math.PI * k2) * 0.35 * scale;
  const z = lerp(sag, 0.62 * scale, k2) + lift;
  body.root.quaternion.setFromAxisAngle(AZ, yaw);
  body.root.rotateX(roll);
  body.root.rotateY(0.12 * k1 * (1 - k2));                   // head dips as it falters
  body.root.position.set(x + Math.sin(yaw) * -side * 0.35 * scale * k2, y + Math.cos(yaw) * side * 0.35 * scale * k2, z);
  for (const w of body.wings) { w.obj.quaternion.copy(w.wing.qRest); w.wing.ghosts?.forEach((g) => { g.visible = false; }); }
  body.update();
}
/** Dead and long still. */
export const poseDead = (body, x, y, yaw, scale = 1) => poseDying(body, x, y, yaw, 1.16 * scale, scale, 99);

// ------------------------------------------------------------ textures
function chorionTexture() {                       // the egg shell's fine hexagonal pattern
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#b8b8b8'; g.lineWidth = 1.6;
  const r = 7, h = r * Math.sqrt(3);
  for (let y = -h; y < 128 + h; y += h) for (let x = -r * 3, row = 0; x < 256 + r * 3; x += r * 3, row++) {
    for (const [ox, oy] of [[0, 0], [r * 1.5, h / 2]]) {
      g.beginPath();
      for (let k = 0; k <= 6; k++) { const a = k / 6 * TAU; g.lineTo(x + ox + r * Math.cos(a), y + oy + r * Math.sin(a)); }
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
function shadowTexture() {                        // a soft contact shadow, so things sit on the surface
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------------ one individual
class Offspring {
  constructor(G, pos, yaw, gen = 1, fromBrood = null) {
    this.G = G; this.age = 0;                     // days since it was laid
    this.gen = gen;                               // 1 = the first pair's young, 2 = their grandchildren ...
    this.virgin = true; this.beh = 'roam'; this.behT = 0; this.eggsLaid = 0;
    this.x = pos.x; this.y = pos.y; this.yaw = yaw;
    this.stage = 'egg';
    this.sex = Math.random() < 0.5 ? 'female' : 'male';
    this.group = new THREE.Group();
    G.scene.add(this.group);
    this.shadow = new THREE.Mesh(G.shadowGeo, G.shadowMat);
    this.shadow.renderOrder = 1;
    G.scene.add(this.shadow);
    this.speedPhase = rnd(0, TAU);
    if (fromBrood) {                              // an instanced pupa about to eclose becomes a 3D one
      this.age = fromBrood.age; this.sex = fromBrood.sex; this.stage = 'pupa';
      this.makePupa(); this.pupa.scale.setScalar(PUPA_SCALE);
    } else this.makeEgg(pos);
  }

  makeEgg(from) {
    const G = this.G, egg = this.egg = new THREE.Group();
    const shell = new THREE.Mesh(G.eggGeo, G.eggMat);
    shell.scale.set(0.25, 0.1, 0.1);
    egg.add(shell);
    // the two dorsal appendages: thin, curved, flattening into paddles, from the front end
    for (const s of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.16, s * 0.025, 0.06), new THREE.Vector3(0.28, s * 0.05, 0.12), new THREE.Vector3(0.4, s * 0.08, 0.13)]);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.012, 6), G.eggMat);
      egg.add(tube);
      const paddle = new THREE.Mesh(G.eggGeo, G.eggMat);
      paddle.scale.set(0.05, 0.022, 0.008); paddle.position.set(0.42, s * 0.085, 0.13);
      egg.add(paddle);
    }
    egg.rotation.z = this.yaw;
    this.group.add(egg);
    // it comes out of the tip of her abdomen and drops onto the fruit
    this.birth = { t: 0, z0: from.z };
  }

  makeLarva() {
    const G = this.G, larva = this.larva = new THREE.Group();
    this.segs = [];
    for (let i = 0; i < SEG; i++) {
      const u = i / (SEG - 1);                    // 0 = head .. 1 = tail
      const m = new THREE.Mesh(G.segGeo, G.larvaMat);
      const w = 0.085 * Math.sin(Math.PI * clamp(0.12 + 0.88 * u, 0, 1)) + 0.035;
      m.userData = { u, w };
      larva.add(m); this.segs.push(m);
    }
    // the gut, dark with food, shows through
    this.gut = new THREE.Mesh(G.segGeo, G.gutMat); larva.add(this.gut);
    // the black mouth hooks at the front, and the two posterior spiracles at the back
    this.hooks = new THREE.Mesh(G.hookGeo, G.darkMat); larva.add(this.hooks);
    this.spir = [-1, 1].map((s) => { const m = new THREE.Mesh(G.eggGeo, G.darkMat); m.userData.s = s; larva.add(m); return m; });
    this.group.add(larva);
    this.len = 0.4;                                // it squeezes out of the egg
    this.crawl = 0;
  }

  makePupa() {
    const G = this.G, p = this.pupa = new THREE.Group();
    const body = new THREE.Mesh(G.eggGeo, this.pupaMat = G.pupaMat.clone());
    body.scale.set(1.5, 0.42, 0.36);
    p.add(body);
    // the lid at the front end, hinged along its top edge: it is pushed open when the adult comes out
    this.lid = new THREE.Group(); this.lid.position.set(1.12, 0, 0.3);
    this.operculum = new THREE.Mesh(G.capGeo, this.pupaMat);
    this.operculum.position.set(0.1, 0, -0.26); this.operculum.rotation.z = -Math.PI / 2;
    this.lid.add(this.operculum); p.add(this.lid);
    // the adult forming inside shows through the case in its last day or so: red eyes, dark wings
    this.pharate = [];
    for (const sd of [-1, 1]) {
      const eye = new THREE.Mesh(G.eggGeo, new THREE.MeshStandardMaterial({ color: 0xb01a10, roughness: 0.5, transparent: true, opacity: 0 }));
      eye.scale.set(0.16, 0.12, 0.12); eye.position.set(1.0, sd * 0.2, 0.12); p.add(eye); this.pharate.push(eye);
      const wing = new THREE.Mesh(G.eggGeo, new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.7, transparent: true, opacity: 0 }));
      wing.scale.set(0.5, 0.16, 0.05); wing.position.set(0.25, sd * 0.3, 0.2); wing.rotation.z = sd * 0.25; p.add(wing); this.pharate.push(wing);
    }
    for (const s of [-1, 1]) {                    // the anterior spiracles stick out like little horns
      const h = new THREE.Mesh(G.hookGeo, this.pupaMat);
      h.position.set(1.3, s * 0.18, 0.28); h.rotation.set(0, -0.7, s * 0.4); h.scale.setScalar(1.6);
      p.add(h);
    }
    p.position.z = 0.34;
    this.group.add(p);
  }

  async makeAdult() {
    flyData ??= Promise.all([
      loadFlyData(NMF, '?v=6'),
      fetch(NMF + 'meshes_lo.json?v=6').then((r) => r.json()),
      fetch(NMF + 'meshes_lo.bin.gz?v=6').then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    ]).then(([{ J, bin }, meta, lo]) => ({ J, bin, lo: { meta, bin: lo } }));
    const { J, bin, lo } = await flyData;
    const body = this.adult = new FlyBody(J, bin, { lo, ghosts: 3 });   // blurred wing copies: song (males) and flight
    // one material for the whole body: its colour is what changes as the new adult matures
    this.adultMats = [body.skin.material = body.skin.material.clone()];
    if (this.sex === 'male') {                                   // the dark tip of a male's abdomen
      this.maleTip = new THREE.Mesh(this.G.eggGeo, new THREE.MeshStandardMaterial({ color: 0x1c140c, roughness: 0.6, transparent: true, opacity: 0 }));
      this.maleTip.scale.set(0.34, 0.36, 0.3); this.maleTip.position.set(-0.12, 0, 0.02);
      body.byName.c_abdomen6.obj.add(this.maleTip);
    }
    this.sexScale = this.sex === 'male' ? 0.85 : 1;
    body.root.scale.setScalar(this.sexScale * TENERAL_SIZE);
    this.cpg = new CPG(J);
    this.neutral = LEGS.map((_, i) => this.cpg.neutral(i));
    this.legZ = -body.legTip('lm')[2];                          // standing height at scale 1
    this.G.scene.add(body.root, body.skin);
    this.adultT = 0; this.dL = 0; this.dR = 0; this.alt = 0;
    // the ptilinum: a sac it pumps in and out of its forehead to split the case open, then withdraws
    this.ptilinum = new THREE.Mesh(this.G.eggGeo, new THREE.MeshPhysicalMaterial({ color: 0xe8f0d0, roughness: 0.2, clearcoat: 1, transparent: true, opacity: 0.8 }));
    this.ptilinum.position.set(0.42, 0, 0.12);
    body.byName.c_head.obj.add(this.ptilinum);
    body.root.visible = body.skin.visible = false;
  }

  // ---------------------------------------------------------- every frame
  step(dt, days, site) {
    this.age += days;
    const G = this.G;
    if (this.stage === 'egg') {
      if (this.birth) {
        this.birth.t += dt;
        const k = ease(this.birth.t / 0.7);
        this.egg.position.z = lerp(this.birth.z0, 0.12, k);
        this.egg.scale.setScalar(lerp(0.35, 1, k));
        if (k >= 1) this.birth = null;
      } else this.egg.position.z = 0.12;
      if (this.age >= T_HATCH) { this.stage = 'L1'; this.makeLarva(); this.egg.children[0].material = G.shellMat; }
    }
    if (this.larva) this.stepLarva(dt, site);
    if (this.stage === 'pupa') this.stepPupa(dt);
    if (this.adult) this.stepAdult(dt, days);
    // the shadow follows whatever it is now
    const s = this.stage === 'egg' ? 0.3 : this.larva ? this.len * 0.3 : this.stage === 'pupa' ? 0.9 : 0;
    this.shadow.visible = s > 0;
    this.shadow.position.set(this.x, this.y, this.onFruit(site) ? 0.075 : 0.012);
    this.shadow.scale.set(s * 1.3, s * 0.55, 1); this.shadow.rotation.z = this.yaw;
    this.group.position.set(this.x, this.y, this.onFruit(site) ? 0.07 : 0);
  }
  onFruit(site) { return Math.hypot(this.x - site.position.x, this.y - site.position.y) < site.userData.r; }

  stepLarva(dt, site) {
    const a = this.age;
    const stage = a < T_L2 ? 'L1' : a < T_L3 ? 'L2' : a < T_WANDER ? 'L3' : 'wander';
    this.stage = stage;
    // growing: it moults into a bigger instar; inside an instar it grows a little too
    const target = stage === 'L1' ? lerp(LEN.L1 * 0.6, LEN.L1, a - T_HATCH) : stage === 'L2' ? lerp(LEN.L2 * 0.7, LEN.L2, a - T_L2) : LEN.L3 * lerp(0.75, 1, clamp(a - T_L3, 0, 1));
    this.len += (target - this.len) * Math.min(1, dt * 1.5);
    // crawling: a wave of contraction runs from the tail to the head, and the body moves on with each wave
    const hz = stage === 'wander' ? 1.6 : 1.0;
    this.crawl += dt * hz;
    const wave = this.crawl * TAU;
    const pulse = Math.max(0, Math.sin(wave));
    const speed = this.len * (stage === 'wander' ? 0.35 : 0.12) * pulse;
    const fx = site.position.x, fy = site.position.y, R = site.userData.r;
    if (stage === 'wander') {                     // off the food, to pupate somewhere dry nearby
      if (this.pupateAt == null) { const ang = Math.atan2(this.y - fy, this.x - fx) + rnd(-0.5, 0.5); this.pupateAt = [fx + Math.cos(ang) * (R + 2.2), fy + Math.sin(ang) * (R + 2.2)]; }
      this.yaw += wrap(Math.atan2(this.pupateAt[1] - this.y, this.pupateAt[0] - this.x) - this.yaw) * Math.min(1, dt * 1.2);
    } else {                                      // feeding: wander over the fruit, head sweeping
      this.yaw += Math.sin(this.crawl * 0.7 + this.speedPhase) * dt * 0.9;
      const r = Math.hypot(this.x - fx, this.y - fy);
      if (r > R * 0.8) this.yaw += wrap(Math.atan2(fy - this.y, fx - this.x) - this.yaw) * Math.min(1, dt * 2);
    }
    this.x += Math.cos(this.yaw) * speed * dt; this.y += Math.sin(this.yaw) * speed * dt;
    if (this.age >= T_PUPA) {                     // it stops, shortens and hardens into a puparium
      this.group.remove(this.larva); this.larva = null; this.stage = 'pupa'; this.makePupa();
      this.pupa.scale.setScalar(PUPA_SCALE);
      return;
    }
    // lay the segments out along the body, with the contraction wave and the head sweeping
    const L = this.len, n = SEG;
    let px = 0;
    const step = L / n;
    for (let i = 0; i < n; i++) {
      const m = this.segs[i], { u, w } = m.userData;
      const squeeze = 1 - 0.28 * Math.max(0, Math.sin(wave - u * 5));
      const sweep = (1 - u) ** 2 * 0.35 * Math.sin(this.crawl * 2.3 + this.speedPhase);
      m.position.set(L / 2 - px - step / 2, sweep * L * 0.15, w * L * 0.9);
      m.scale.set(step * 1.2 * squeeze, w * L * (2 - squeeze) * 0.95, w * L * 0.85);   // overlapping, so the body reads as one
      px += step * squeeze;
    }
    this.gut.position.set(0, 0, 0.07 * L); this.gut.scale.set(L * 0.28, 0.04 * L, 0.035 * L);
    const head = this.segs[0].position;
    this.hooks.position.set(head.x + step * 0.45, head.y, head.z * 0.6); this.hooks.rotation.set(0, Math.PI / 2 + 0.5, 0);
    this.hooks.scale.setScalar(L * 0.5);
    const tail = this.segs[n - 1].position;
    for (const sp of this.spir) { sp.position.set(tail.x - step * 0.35, sp.userData.s * 0.015 * L, tail.z * 1.3); sp.scale.setScalar(0.012 * L); }
    this.larva.rotation.z = this.yaw;
    // out of the egg: the empty shell stays behind, fading
    if (this.egg) {
      const k = clamp((this.age - T_HATCH) * 3, 0, 1);
      this.egg.children.forEach((c) => { if (c.material === this.G.shellMat) c.material.opacity = 0.75 * (1 - k); });
      if (k >= 1) { this.group.remove(this.egg); this.egg = null; }
    }
  }

  stepPupa(dt) {
    const k = clamp((this.age - T_PUPA) / 0.8, 0, 1);         // white to tan to brown as the cuticle hardens
    this.pupaMat.color.setRGB(lerp(0.93, 0.42, k), lerp(0.89, 0.25, k), lerp(0.78, 0.1, k));
    this.pupa.rotation.z = this.yaw;
    const ph = clamp((this.age - (T_ECLOSE - 1.5)) / 1.5, 0, 1);
    for (const m of this.pharate) m.material.opacity = 0.75 * ph;
    if (this.age >= T_ECLOSE && !this.adult && !this.adultLoading) {
      this.adultLoading = true;
      this.makeAdult().then(() => { this.stage = 'adult'; this.adultAge = 0; this.span = lifespan(); for (const m of this.pharate) m.visible = false; });
    }
  }

  // the body is gone (rotted away, or eaten)
  vanish() {
    if (!this.adult) return;
    this.G.scene.remove(this.adult.root, this.adult.skin); this.adult = null; this.stage = 'gone'; this.group.visible = false; this.shadow.visible = false;
    if (this.carcass) this.carcass.meat = 0;
  }

  stepAdult(dt, days) {
    const body = this.adult, t = (this.adultT += dt);
    this.adultAge += days;
    this._days = days;
    if (this.sex === 'female' && !this.virgin && this.stage === 'adult') this.held = Math.min(HOLD_MAX, (this.held ?? 25) + days * EGGS_PER_DAY);
    if (this.stage === 'dead') {                                 // on its back; after a few days it is gone
      this.deadT = (this.deadT || 0) + dt;
      poseDying(body, this.ax, this.ay, this.ayaw, this.z0, body.root.scale.x, this.deadT);
      this.deadDays = (this.deadDays || 0) + days;
      if (this.deadDays > 4) this.vanish();
      return;
    }
    this.hunger = (this.hunger ?? rnd(0.2, 0.6)) + dt / HUNGRY_S;
    if (this.hunger >= STARVE) this.cause = 'starved';
    if (this.adultAge >= this.span || this.cause === 'starved') { this.beam?.dispose(); this.beam = null; this.stage = 'dead'; this.G.onDie?.(new THREE.Vector3(this.ax, this.ay, 1.4)); this.release(); if (this.courter) { this.courter.release(); this.courter = null; } for (const w of this.adult.wings) w.wing.ghosts.forEach((g) => { g.visible = false; }); return; }
    // it pulls itself out of the case, pale, wings crumpled; the wings expand and the body darkens
    // coming out: the lid swings open, then the fly heaves itself out in three pushes, forehead sac pumping
    const lidOpen = ease(t / 0.6);
    this.lid.rotation.y = -2.0 * lidOpen;
    const u = clamp((t - 0.5) / 3.3, 0, 1) * 3, heave = Math.floor(u), f = u - heave;
    const out = u >= 3 ? 1 : clamp((heave + ease(Math.min(1, f * 1.7))) / 3, 0, 1);
    body.root.visible = body.skin.visible = t > 0.45;
    const pump = t < 4.2 ? 0.75 + 0.35 * Math.sin(t * 9) : Math.max(0, 1.1 - (t - 4.2) * 0.8);
    this.ptilinum.scale.set(0.16 * pump, 0.2 * pump, 0.14 * pump); this.ptilinum.visible = pump > 0.02;
    const grown = ease((this.adultAge - GREEN_DAYS) / GROW_DAYS);
    const size = this.sexScale * lerp(TENERAL_SIZE, 1, grown);
    body.root.scale.setScalar(size);
    this.z0 = this.legZ * size;
    // pale -> tan -> the parents' colour; a male's dark abdomen tip comes in with the colour
    const k1 = clamp(grown * 2, 0, 1), k2 = clamp(grown * 2 - 1, 0, 1);   // yellow-green until it starts to grow
    for (const m of this.adultMats) m.color.setRGB(lerp(lerp(PALE[0], TAN[0], k1), 1, k2), lerp(lerp(PALE[1], TAN[1], k1), 1, k2), lerp(lerp(PALE[2], TAN[2], k1), 1, k2));
    if (this.maleTip) this.maleTip.material.opacity = 0.9 * k2;
    for (const w of body.wings) {
      w.obj.quaternion.copy(w.wing.qRest);
      w.obj.scale.set(lerp(0.3, 1, clamp((t - 4) / 5, 0, 1)), lerp(0.6, 1, clamp((t - 4) / 5, 0, 1)), 1);   // crumpled, then pumped out
    }
    const front = 1.5 * this.pupa.scale.x;                      // the case's front end, from its centre
    if (this.ax == null) {                                       // where it stands once it is out of the case
      this.ax = this.x + Math.cos(this.yaw) * (front + 1.3); this.ay = this.y + Math.sin(this.yaw) * (front + 1.3); this.ayaw = this.yaw;
      this.x0 = this.x; this.y0 = this.y;
    }
    this.behave(dt, t > 7 && out >= 1);
    const back = (1 - out) * (front + 1.2);                      // from inside the case (its centre) to out in front
    let px = this.ax - Math.cos(this.ayaw) * back, py = this.ay - Math.sin(this.ayaw) * back, pz = this.z0 + 0.05 + (this.alt || 0), pitch = -0.35 * (1 - out), yaw = this.ayaw;
    if (this.beh === 'fly') { const tk = tuckAngles(body); LEGS.forEach((leg, i) => body.setLeg(leg, tk[i])); pitch += 0.12; }
    const F = this.mate, m = this.mountW = approachV(this.mountW || 0, this.beh === 'copulate' && F?.adult ? 1 : 0, dt, 0.35);
    if (m > 0.001 && F?.adult) {                                  // on her back, over her abdomen, facing her way
      const fs = F.adult.root.scale.x;
      px = lerp(px, F.ax - Math.cos(F.ayaw) * 1.0 * fs, m); py = lerp(py, F.ay - Math.sin(F.ayaw) * 1.0 * fs, m);
      pz = lerp(pz, F.z0 + 0.95 * fs, m); yaw = this.ayaw + wrap(F.ayaw - this.ayaw) * m; pitch -= 0.18 * m;
    }
    body.root.position.set(px, py, pz);
    body.root.quaternion.setFromAxisAngle(AZ, yaw);
    body.root.rotateY(pitch);
    const j = body.joints, curl = this.sex === 'male' ? -0.32 * m : -0.4 * (this.bend || 0);
    for (const n of ['c_abdomen12-c_abdomen3-pitch', 'c_abdomen3-c_abdomen4-pitch', 'c_abdomen4-c_abdomen5-pitch', 'c_abdomen5-c_abdomen6-pitch']) if (j[n]) j[n].q = curl;
    if (this.listenHead != null && j['c_thorax-c_head-yaw']) j['c_thorax-c_head-yaw'].q = this.listenHead;
    // eating: the proboscis unfolds down onto the food and dabs at it
    this.prob = approachV(this.prob || 0, this.beh === 'feed' ? 1 : 0, dt, 0.12);
    const tt = this.adultT, P = this.prob;
    if (j['c_head-c_rostrum-pitch']) j['c_head-c_rostrum-pitch'].q = -1.25 * P + P * 0.2 * Math.sin(tt * 8.3);
    if (j['c_rostrum-c_haustellum-pitch']) j['c_rostrum-c_haustellum-pitch'].q = -1.6 * P + P * 0.4 * Math.sin(tt * 15.5);
    if (j['c_thorax-c_head-pitch']) j['c_thorax-c_head-pitch'].q = 0.2 * P;
    body.update();
    this.poseSongWing(dt);
    this.poseFlightWings(dt);
    if (out >= 1 && this.pupa) { this.pupaMat.transparent = true; this.pupaMat.opacity = Math.max(0.35, 1 - (t - 2.5) / 6); }
  }

  // ---------------------------------------------------------- courting, mating, laying
  get mature() { return this.stage === 'adult' && this.adultAge >= (this.sex === 'male' ? MALE_MATURE : FEMALE_MATURE); }
  setBeh(b) { this.beh = b; this.behT = 0; }

  behave(dt, free) {
    const G = this.G, body = this.adult;
    this.behT += dt;
    let goal = null, face = null, wander = false;
    if (!free) { this.walkLegs(dt, null, null, false); return; }
    // flying, going to food and eating come before anything else once started
    if (this.beh === 'fly') { this.flyStep(dt); return; }
    if (this.beh === 'toFood' || this.beh === 'feed') { this.foodStep(dt); return; }
    const idle = this.beh === 'roam' || (this.sex === 'male' && this.beh === 'cooldown');
    // hungry: food comes first - courting, listening and laying are dropped (only mating is not)
    if (this.hunger > 1 && G.foods && this.beh !== 'copulate' && (this.behT > 0.5 || !idle)) {
      const food = G.foods.nearest(this.ax, this.ay);
      if (food) {
        this.release(); if (this.courter) { this.courter.release(); this.courter = null; }
        this.bend = 0; this.aim = null; this.listenHead = null;
        this.food = food; food.eaters++;
        const d = Math.hypot(food.x - this.ax, food.y - this.ay);
        if (d > 4.5) this.startFlight(food.x - (food.x - this.ax) / d * 1.1, food.y - (food.y - this.ay) / d * 1.1, 'toFood');
        else this.setBeh('toFood');
        return;
      }
    }
    if (idle && this.behT > 1) {
      if (Math.random() < dt * 0.02) {                          // now and then, a short flight for no reason
        const c = G.site.position, a = rnd(0, TAU), r = rnd(2.5, 7);
        this.startFlight(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, 'roam');
        return;
      }
    }
    if (this.sex === 'male') {
      const F = this.mate;
      const lost = F && (F.stage !== 'adult' || (F.courter && F.courter !== this));
      if (lost) { this.release(); this.setBeh('cooldown'); }
      // she may have flown off, died or been taken: courting without a female ends
      if (!this.mate && ['approach', 'sing', 'mount', 'copulate'].includes(this.beh)) this.setBeh('cooldown');
      switch (this.beh) {
        case 'roam':
          wander = true;
          if (this.mature && this.behT > 1) {                     // look for a grown female no one else is courting
            let best = null, bd = COURT_RANGE;
            for (const o of G.list) {
              if (o === this || o.sex !== 'female' || !o.mature || o.courter || o.beh === 'copulate') continue;
              const d = Math.hypot(o.ax - this.ax, o.ay - this.ay);
              if (d < bd) { bd = d; best = o; }
            }
            if (best) { this.mate = best; best.courter = this; this.setBeh('approach'); }
          }
          break;
        case 'approach': {
          const d = Math.hypot(F.ax - this.ax, F.ay - this.ay);
          goal = [F.ax + (this.ax - F.ax) / d * SING_D, F.ay + (this.ay - F.ay) / d * SING_D];
          if (d < SING_D + 0.4) this.setBeh('sing');
          if (this.behT > 15) { this.release(); this.setBeh('cooldown'); }
          break;
        }
        case 'sing': {
          const d = Math.hypot(F.ax - this.ax, F.ay - this.ay);
          face = Math.atan2(F.ay - this.ay, F.ax - this.ax);
          if (d > SING_D + 1.2) goal = [F.ax + (this.ax - F.ax) / d * SING_D, F.ay + (this.ay - F.ay) / d * SING_D];
          this.waveT = (this.waveT || 0) - dt;
          if (this.waveT <= 0 && this.singSide != null) {
            this.waveT = 0.16;
            const from = body.wings[this.singSide].obj.getWorldPosition(new THREE.Vector3());
            const to = F.adult.byName.c_head.obj.getWorldPosition(new THREE.Vector3()); to.z += 0.2;
            G.emitWave(from, to);
          }
          if (F.beh === 'accept') this.setBeh('mount');
          else if (F.beh === 'reject' || this.behT > GIVE_UP_S) { G.onReject?.(new THREE.Vector3(this.ax, this.ay, 1.5)); this.release(); this.setBeh('cooldown'); }
          break;
        }
        case 'mount': {
          const back = [F.ax - Math.cos(F.ayaw) * 2.0, F.ay - Math.sin(F.ayaw) * 2.0];
          if (Math.hypot(back[0] - this.ax, back[1] - this.ay) > 0.5 && this.behT < 6) goal = back;
          else { this.setBeh('copulate'); F.setBeh('copulate'); G.onMate?.(new THREE.Vector3(F.ax, F.ay, F.z0 + 1.5)); }
          break;
        }
        case 'copulate':
          if (this.behT > COPULATE_S) {
            F.virgin = false; F.matedAt = F.adultAge; F.setBeh('roam');
            this.ax = F.ax - Math.cos(F.ayaw) * 2.2; this.ay = F.ay - Math.sin(F.ayaw) * 2.2;   // off her back
            G.matings++; this.release(); this.setBeh('cooldown');
          }
          break;
        case 'cooldown': wander = true; if (this.behT > COOLDOWN_S) this.setBeh('roam'); break;
      }
    } else {
      const M = this.courter;
      const singing = M && M.beh === 'sing' && Math.hypot(M.ax - this.ax, M.ay - this.ay) < SING_D + 1.5;
      switch (this.beh) {
        case 'roam': case 'seek': case 'lay':
          if (singing && this.beh === 'roam') { this.setBeh('listen'); break; }
          if (this.beh === 'roam') {
            wander = true;
            if (!this.virgin && (this.held || 0) >= BATCH_MIN) { this.setBeh('seek'); this.spilled = false; this.spot = null; }
          }
          if (this.beh === 'seek') goal = this.layGoal();
          if (this.beh === 'lay') this.layStep(dt);
          break;
        case 'listen':                                          // she stops and turns her head to him
          if (!singing) { this.setBeh('roam'); break; }
          // the mother's brain: a virgin grown female hearing the song passes the stand-still threshold; a mated one does not
          if (this.behT > ACCEPT_S) this.setBeh(this.virgin && this.mature ? 'accept' : 'reject');
          break;
        case 'accept': if (!M || M.beh === 'roam' || M.beh === 'cooldown') this.setBeh('roam'); break;
        case 'reject': wander = true; this.forward = true; if (this.behT > 3) { this.forward = false; this.setBeh('roam'); } break;
        case 'copulate': break;
      }
      // her head follows the singer while she listens
      if ((this.beh === 'listen' || this.beh === 'accept') && M) {
        const rel = wrap(Math.atan2(M.ay - this.ay, M.ax - this.ax) - this.ayaw);
        this.listenHead = clamp(rel, -0.55, 0.55);
        if (Math.abs(rel) > 0.4) this.ayaw += Math.sign(rel) * 0.8 * dt;
      } else this.listenHead = null;
    }
    const still = this.beh === 'listen' || this.beh === 'accept' || this.beh === 'copulate' || this.beh === 'lay';
    this.walkLegs(dt, goal, face, wander && !still);
  }
  release() { if (this.mate) { if (this.mate.courter === this) this.mate.courter = null; this.mate = null; } }

  // a short flight: take off, arc over, land, then carry on with `then`
  startFlight(x, y, then) {
    this.release();
    if (this.courter) { this.courter.release(); this.courter = null; }
    const d = Math.hypot(x - this.ax, y - this.ay);
    this.fl = { x0: this.ax, y0: this.ay, x1: x, y1: y, t: 0, T: 0.9 + d * 0.16, h: 1.2 + d * 0.22, then };
    this.setBeh('fly');
  }
  flyStep(dt) {
    const F = this.fl; F.t += dt;
    const u = clamp(F.t / F.T, 0, 1), e = ease(u);
    this.ax = lerp(F.x0, F.x1, e); this.ay = lerp(F.y0, F.y1, e);
    this.ayaw += wrap(Math.atan2(F.y1 - F.y0, F.x1 - F.x0) - this.ayaw) * Math.min(1, dt * 6);
    this.alt = Math.sin(Math.PI * u) * F.h;
    if (u >= 1) { this.alt = 0; const then = F.then; this.fl = null; this.setBeh(then); }
  }
  foodStep(dt) {
    const f = this.food;
    if (!f || f.amount <= 0) { this.leaveFood(); return; }
    const d = Math.hypot(f.x - this.ax, f.y - this.ay), k = this.adult.root.scale.x;
    if (this.beh === 'toFood') {
      if (d < 1.0 * k + 0.35) { this.setBeh('feed'); return; }
      if (this.behT > 12) { this.leaveFood(); return; }
      this.walkLegs(dt, [f.x, f.y], null, false);
      return;
    }
    // feeding: facing the food, proboscis down on it
    this.walkLegs(dt, null, Math.atan2(f.y - this.ay, f.x - this.ax), false);
    this.eating = true;
    if (!this.G.foods.eat(f, dt)) { this.hunger = 0; this.leaveFood(); }        // eaten up: full
    else if (this.behT > 4) this.leaveFood();
  }
  leaveFood() { if (this.food) this.food.eaters = Math.max(0, this.food.eaters - 1); this.food = null; this.eating = false; if (this.beh !== 'fly') this.setBeh('roam'); }

  // walking: to a point, turning on the spot to a heading, or pottering about
  walkLegs(dt, goal, face, wander) {
    const body = this.adult;
    let wantL = 0, wantR = 0;
    if (goal) {
      const turn = clamp(wrap(Math.atan2(goal[1] - this.ay, goal[0] - this.ax) - this.ayaw) * 1.1, -0.85, 0.85);
      wantL = 1 - Math.max(0, turn); wantR = 1 + Math.min(0, turn);
    } else if (face != null) {
      const turn = wrap(face - this.ayaw);
      if (Math.abs(turn) > 0.25) { wantL = -0.45 * Math.sign(turn); wantR = 0.45 * Math.sign(turn); }
    } else if (wander) {
      this.actT = (this.actT ?? 2) - dt;
      if (this.actT <= 0) { this.walking = this.forward || Math.random() < 0.45; this.actT = rnd(1.5, 4); this.turn = rnd(-1.2, 1.2); }
      const site = this.G.site, far = Math.hypot(this.ax - site.position.x, this.ay - site.position.y) > 7;   // they keep near the fruit
      if (far) this.turn = wrap(Math.atan2(site.position.y - this.ay, site.position.x - this.ax) - this.ayaw);
      const turn = clamp(this.turn || 0, -0.8, 0.8), w = this.walking || this.forward ? 1 : 0;
      wantL = w * (1 - Math.max(0, turn)); wantR = w * (1 + Math.min(0, turn));
    }
    this.dL = approachV(this.dL, wantL, dt, 0.15); this.dR = approachV(this.dR, wantR, dt, 0.15);
    this.cpg.step(dt, this.dL, this.dR);
    const a = this._a ??= new Array(7);
    LEGS.forEach((leg, i) => { this.cpg.angles(i, a); body.setLeg(leg, a); });
    if (Math.abs(this.dL) + Math.abs(this.dR) > 0.05 && this.beh !== 'copulate') {
      const v = this.G.loco.at(this.dL, this.dR), k = body.root.scale.x;
      this.ayaw += v.wz * dt; if (this.turn != null) this.turn -= v.wz * dt;
      this.ax += (Math.cos(this.ayaw) * v.vx - Math.sin(this.ayaw) * v.vy) * dt * k;
      this.ay += (Math.sin(this.ayaw) * v.vx + Math.cos(this.ayaw) * v.vy) * dt * k;
    }
  }

  // a mated young female: over the fruit, abdomen tip down, an egg every few seconds
  layGoal() {
    if (this.spot?.corpse && !(this.spot.corpse.meat > 0)) this.spot = null;   // the body is gone
    const spot = this.spot ??= this.G.laySpot(this.ax, this.ay), k = this.adult.root.scale.x, tip = 1.7 * k;
    const tx = this.ax - Math.cos(this.ayaw) * tip, ty = this.ay - Math.sin(this.ayaw) * tip;
    if (Math.hypot(tx - spot.x, ty - spot.y) < spot.r * 0.6) { this.setBeh('lay'); return null; }
    this.aim ??= rnd(-1, 1);
    const dx = spot.x - this.ax, dy = spot.y - this.ay, d = Math.hypot(dx, dy) || 1;
    return [spot.x + dx / d * tip + this.aim * 0.3 * spot.r / 1.8, spot.y + dy / d * tip];
  }
  layStep(dt) {
    // the whole batch she carries comes out at once (one sound), then her abdomen pumps a moment
    this.bend = 0.7 + 0.3 * Math.sin(this.behT * 16);
    if (!this.spilled && (this.held || 0) >= 1) {
      this.spilled = true;
      const base = this.adult.byName.c_abdomen6.obj.getWorldPosition(new THREE.Vector3());
      base.x -= Math.cos(this.ayaw) * 0.1; base.y -= Math.sin(this.ayaw) * 0.1;
      for (let n = Math.floor(this.held); n > 0; n--) {
        const r = Math.sqrt(Math.random()) * 0.5, a = rnd(0, TAU);
        if (this.G.add(new THREE.Vector3(base.x + Math.cos(a) * r, base.y + Math.sin(a) * r, base.z), this.ayaw + rnd(-0.6, 0.6), this.gen + 1)) this.eggsLaid++;
      }
      this.held = 0;
      this.G.onLay?.(base);
    }
    if (this.behT > PUMP_S) { this.bend = 0; this.aim = null; this.setBeh('roam'); }
  }

  // flying: both wings beating, blurred
  poseFlightWings(dt) {
    const body = this.adult, flying = this.beh === 'fly';
    if (!flying && !this.wasFlying) return;
    this.wasFlying = flying;
    const q = this._fq ??= new THREE.Quaternion();
    body.ghostMat.opacity = flying ? 0.12 : body.ghostMat.opacity;
    this.wingPh = (this.wingPh || 0) + dt * 29 * TAU;
    const stroke = (ph, w) => body.wingQuat(w, -0.12 + 1.2 * Math.sin(ph), 0.1 * Math.sin(2 * ph), Math.PI / 2 - 0.6 * Math.cos(ph), 0.8, q);
    for (const w of body.wings) {
      if (!flying) { w.obj.quaternion.copy(w.wing.qRest); w.wing.ghosts.forEach((g) => { g.visible = false; }); continue; }
      w.obj.quaternion.copy(stroke(this.wingPh, w));
      w.wing.ghosts.forEach((g, gi) => { g.visible = true; g.quaternion.copy(stroke(this.wingPh + (gi + 0.5) / w.wing.ghosts.length * TAU, w)); });
    }
  }

  // a singing young male: one wing out, vibrating, with blurred copies, and a beam from it to her head
  poseSongWing(dt) {
    if (this.sex !== 'male') return;
    const body = this.adult, F = this.mate, singing = this.beh === 'sing' && F?.adult;
    if (singing || this.beam) {
      this.beam ??= createBeam(this.G.scene);
      let from = null, to = null;
      if (singing && this.singSide != null) {
        const w = body.wings[this.singSide];
        from = wingPoint(w, 0.6);
        to = F.adult.byName.c_head.obj.getWorldPosition(new THREE.Vector3()); to.z += 0.15;
      }
      this.beam.update(dt, singing && !!from, from || this._lastFrom, to || this._lastTo, 'pulse', 0.8);
      if (from) { this._lastFrom = from; this._lastTo = to; }
    }
    if (this.beh === 'fly') return;
    this.singW = approachV(this.singW || 0, singing ? 1 : 0, dt, 0.12);
    const side = F ? (wrap(Math.atan2(F.ay - this.ay, F.ax - this.ax) - this.ayaw) >= 0 ? 0 : 1) : 0;
    this.singSide = singing ? side : null;
    this.flutter = (this.flutter || 0) + dt * 23 * TAU;
    const q = this._q ??= new THREE.Quaternion();
    body.ghostMat.opacity = singing ? 0.16 : 0;
    body.wings.forEach((w, k) => {
      const out = k === side ? this.singW : 0;
      if (out < 0.002) { w.wing.ghosts.forEach((g) => { g.visible = false; }); return; }
      const sweep = (ph) => body.wingQuat(w, -0.05 + 0.3 * ph, 0.1 * ph, Math.PI / 2 - 0.15, 0.8, q);
      w.obj.quaternion.copy(w.wing.qRest).slerp(sweep(Math.sin(this.flutter) + (Math.random() - 0.5) * 0.5), out);
      w.wing.ghosts.forEach((g, gi) => { g.visible = out > 0.7; if (g.visible) g.quaternion.copy(w.wing.qRest).slerp(sweep(Math.sin((gi + 0.5) / w.wing.ghosts.length * TAU)), out); });
    });
  }

  dispose() {
    this.G.scene.remove(this.group); this.G.scene.remove(this.shadow);
    if (this.adult) this.G.scene.remove(this.adult.root, this.adult.skin);
    this.beam?.dispose();
  }
}
const AZ = new THREE.Vector3(0, 0, 1);
const approachV = (v, to, dt, tau) => v + (to - v) * (1 - Math.exp(-dt / tau));

// ------------------------------------------------------------ all of them
export class Growth {
  constructor(female, site) {
    this.f = female; this.site = site;
    this.scene = female.scene; this.loco = female.loco;
    this.list = [];                                // the 3D ones: pupae about to eclose, and adults
    this.brood = new Brood(female.scene, site);    // eggs, larvae and pupae, in real numbers
    this.brood.onEclose = (b) => {
      if (this.list.filter((o) => o.stage === 'pupa' || o.stage === 'adult').length >= ADULT_CAP) return false;   // no room: it flies off
      this.list.push(new Offspring(this, { x: b.x, y: b.y, z: 0.3 }, b.yaw, b.gen, b));
      return true;
    };
    this.days = 0;                                 // days since the first egg
    this.matings = 0;                              // among the young
    const tex = waveTexture('pulse');
    this.waves = Array.from({ length: 24 }, () => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.visible = false; sp.life = 0; sp.renderOrder = 10; female.scene.add(sp); return sp;
    });
    this.eggGeo = new THREE.SphereGeometry(1, 24, 16);
    const bump = chorionTexture();
    this.eggMat = new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.42, bumpMap: bump, bumpScale: 0.6, emissive: 0x1a1812 });
    this.shellMat = new THREE.MeshStandardMaterial({ color: 0xf6f3ea, roughness: 0.3, bumpMap: bump, bumpScale: 0.6, transparent: true, opacity: 0.75, depthWrite: false });
    this.segGeo = new THREE.SphereGeometry(1, 16, 12);
    this.larvaMat = new THREE.MeshPhysicalMaterial({ color: 0xf1ede0, roughness: 0.38, clearcoat: 0.6, transparent: true, opacity: 0.86, emissive: 0x16140e });
    this.gutMat = new THREE.MeshStandardMaterial({ color: 0x6b4a1c, roughness: 0.8 });
    this.darkMat = new THREE.MeshStandardMaterial({ color: 0x14100b, roughness: 0.6 });
    this.hookGeo = new THREE.ConeGeometry(0.03, 0.12, 8);
    this.capGeo = new THREE.SphereGeometry(0.33, 16, 10, 0, TAU, 0, Math.PI / 2);
    this.pupaMat = new THREE.MeshStandardMaterial({ color: 0xede3c7, roughness: 0.55 });
    this.shadowGeo = new THREE.PlaneGeometry(1, 1);
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false });
  }
  add(pos, yaw, gen = 1) {
    return this.brood.add(pos.x, pos.y, yaw, gen);   // (the layer makes the one sound for the whole clutch)
  }
  // a stretch of song flying from a young male's wing to a young female's head
  emitWave(from, to) {
    const sp = this.waves.find((w) => w.life <= 0);
    if (!sp) return;
    sp.from = from; sp.to = to; sp.life = 1; sp.visible = true;
  }
  // Dead adults on the ground (with the parents' bodies from the page): larvae feed on them, and females lay on them.
  corpses() {
    const c = [];
    for (const o of this.list) if (o.stage === 'dead' && o.adult) c.push(o.carcass ??= { x: o.ax, y: o.ay, r: 0.9, meat: CORPSE_MEAT, n: 0, eaten: () => o.vanish() });
    return c.concat(this.extraCorpses?.() || []);
  }
  // Where a female about to lay goes: the fruit, or - often, when there is one near - a dead fly
  // (given the choice, females lay on dead flies: Ahmad et al. 2015)
  laySpot(x, y) {
    const fruit = { x: this.site.position.x, y: this.site.position.y, r: this.site.userData.r };
    let best = null, bd = CORPSE_SEEK;
    for (const c of this.corpses()) { if (c.meat < CORPSE_MEAT * 0.3) continue; const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { bd = d; best = c; } }
    return best && Math.random() < CORPSE_LAY ? { x: best.x, y: best.y, r: best.r, corpse: best } : fruit;
  }
  clear() { for (const o of this.list) o.dispose(); this.list = []; this.brood.clear(); this.days = 0; this.matings = 0; for (const w of this.waves) { w.visible = false; w.life = 0; } }
  step(dt, days) {
    if (this.frozen) { dt = 0; days = 0; }         // (for looking at one moment)
    this.brood.corpses = this.corpses();
    this.brood.step(Math.min(dt, 0.05), days);
    if (!this.list.length) return;
    // Animation steps are capped: the walking oscillators integrate in 1 ms substeps, so a slow frame with
    // many flies would ask for hundreds of substeps each, making the next frame slower still, until it all stalls.
    dt = Math.min(dt, 0.05);
    this.days += days;
    for (const o of this.list) o.step(dt, days, this.site);
    for (const sp of this.waves) {
      if (sp.life <= 0) continue;
      sp.life -= dt / 0.7;
      if (sp.life <= 0) { sp.visible = false; continue; }
      const u = 1 - sp.life;
      sp.position.lerpVectors(sp.from, sp.to, u); sp.position.z += Math.sin(u * Math.PI) * 0.3;
      const k = 0.5 + 0.4 * u; sp.scale.set(0.8 * k, 0.3 * k, 1);
      sp.material.opacity = Math.min(1, u * 5) * Math.min(1, sp.life * 3);
    }
  }
  /** Anything still alive: eggs, larvae, pupae and adults. */
  alive() { return this.brood.alive() || this.list.some((o) => o.stage !== 'dead' && o.stage !== 'gone'); }
  counts() {
    const B = this.brood, bc = B.counts();
    const c = { egg: bc.egg, larva: bc.larva, pupa: bc.pupa, adult: 0, dead: B.dead.egg + B.dead.larva + B.dead.pupa + B.dead.cannibal, starved: 0, crowded: B.dead.larva, unhatched: B.dead.egg, cannibal: B.dead.cannibal, onCorpse: bc.onCorpse, female: 0, male: 0, gen: 0, matings: this.matings, dispersed: B.dispersed };
    for (const b of B.list) c.gen = Math.max(c.gen, b.gen);
    for (const o of this.list) {
      if (o.stage === 'egg') c.egg++; else if (o.larva) c.larva++; else if (o.stage === 'pupa') c.pupa++;
      else if (o.stage === 'adult') { c.adult++; c[o.sex]++; } else if (o.stage === 'dead' || o.stage === 'gone') { c.dead++; if (o.cause === 'starved') c.starved++; }
      if (o.stage !== 'gone') c.gen = Math.max(c.gen, o.gen);
    }
    return c;
  }
  /** The most advanced one still here, for the camera. */
  focus() {
    let best = null;
    for (const o of this.list) if (o.stage !== 'gone' && o.stage !== 'dead' && (!best || o.age > best.age)) best = o;
    return best;
  }
}
