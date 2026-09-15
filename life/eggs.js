// Egg-laying, after mating. What decides the moment an egg is laid is the female's
// brain: the egg-laying command neurons oviDNa (FlyWire v783) firing. What is not in
// the brain data - the post-mating switch (sex peptide from the male, sensed in her
// reproductive tract) and knowing she stands on a good spot - goes in as input to
// SMP550, oviDN's strongest excitatory input (an assumption; see the page).
//
//   maturing -> seeking the fruit -> probing (on it) -> laying (a whole batch at once) -> waiting for the next batch -> ...
import * as THREE from '../test03/vendor/three.module.min.js';
import { Growth } from './growth.js?v=33';

export const EGG_TEXT = {
  off: '', maturing: '交尾後、卵が成熟するのを待っている', seeking: '産卵場所（果物）を探して歩いている',
  probing: '果物の上で産卵管を当てて探っている', laying: 'たまった卵を一気に産んだ', rest: 'ひと休み', waiting: '次の卵がたまるのを待っている', done: '産み終えた',
};
// SMP550 input by phase (Hz)
export const SMP550_IN = { off: 0, maturing: 0, seeking: 10, probing: 35, laying: 35, rest: 10, waiting: 0, done: 0 };
const MATURE_S = 6;              // on screen; a mated female starts laying within hours
const LAY_HZ = 4;                // oviDNa above this for LAY_HOLD s: an egg
const LAY_HOLD = 1.0, LAY_S = 1.4, REST_S = 2.5;
// A well-fed mated female lays some 30-50 eggs a day at 25 °C, fewer as she ages. Here she lays at this
// rate for as long as she is over the fruit with oviDNa firing (the brain still decides when).
export const EGGS_PER_DAY = 50;
// Eggs build up in her at that rate (up to HOLD_MAX) and come out in one go once she is on the fruit
const HOLD_MAX = 80, BATCH_MIN = 40, PUMP_S = 1.2;
const SITE_AT = [-1.9, 1.7];      // where the fruit lies
const SITE_R = 1.8;              // the fruit's radius, mm
const TIP = 1.7;                 // from her thorax (where she is placed) back to the tip of her abdomen, mm
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));

export class EggLaying {
  constructor(female) {
    this.f = female;
    this.phase = 'off'; this.T = 0; this.hold = 0; this.bend = 0; this.count = 0;
    // an overripe banana, sliced and going off: the slice they lay on, a second one leaning against it,
    // a strip of blackening peel, a puddle of juice, and the white specks of yeast that draw flies to it
    const g = this.site = new THREE.Group();
    const T = bananaTextures();
    const wet = { roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.45 };   // moist, but not a mirror from above
    const slice = (r, h) => {
      const m = new THREE.Group();
      const side = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.02, h, 64, 1, true), new THREE.MeshPhysicalMaterial({ map: T.peel, roughness: 0.6, side: THREE.DoubleSide }));
      side.rotation.x = Math.PI / 2; m.add(side);
      const top = new THREE.Mesh(new THREE.CircleGeometry(r * 0.995, 64), new THREE.MeshPhysicalMaterial({ map: T.flesh, bumpMap: T.bump, bumpScale: 1.2, ...wet }));
      top.position.z = h / 2; m.add(top);
      // the flesh bulges a little above the peel ring
      const dome = new THREE.Mesh(new THREE.SphereGeometry(r * 0.92, 48, 12, 0, Math.PI * 2, 0, 0.18), new THREE.MeshPhysicalMaterial({ map: T.flesh, bumpMap: T.bump, bumpScale: 1.2, transparent: true, opacity: 0.55, ...wet }));
      dome.rotation.x = Math.PI / 2; dome.position.z = h / 2 - r * 0.92 * Math.cos(0.18) + 0.01; dome.scale.set(1, 1, 1); m.add(dome);
      return m;
    };
    const main = slice(SITE_R, 0.09);
    main.position.z = 0.045;
    g.add(main);
    const second = slice(SITE_R * 0.8, 0.09);
    second.position.set(-SITE_R * 1.35, SITE_R * 0.9, 0.2); second.rotation.set(0.35, -0.25, 0.6);
    g.add(second);
    // a curled strip of peel, black-spotted
    const curve = new THREE.CatmullRomCurve3([[2.2, -1.2, 0.05], [2.9, -0.4, 0.12], [3.1, 0.6, 0.3], [2.6, 1.4, 0.2]].map((p) => new THREE.Vector3(...p)));
    const peel = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.28, 10), new THREE.MeshPhysicalMaterial({ map: T.peel, roughness: 0.55 }));
    peel.scale.set(1, 1, 0.35);
    g.add(peel);
    // juice spreading round it
    const puddle = new THREE.Mesh(new THREE.CircleGeometry(SITE_R * 1.75, 48), new THREE.MeshPhysicalMaterial({ color: 0x6b4a14, transparent: true, opacity: 0.55, roughness: 0.08, clearcoat: 1 }));
    puddle.position.z = 0.006; puddle.scale.set(1.15, 0.9, 1);
    g.add(puddle);
    // drops of juice beading on the cut face
    const drop = new THREE.SphereGeometry(1, 12, 8), dropMat = new THREE.MeshPhysicalMaterial({ color: 0xf6e3a0, roughness: 0.05, transmission: 0.6, thickness: 0.2, clearcoat: 1, transparent: true, opacity: 0.8 });
    for (let k = 0; k < 9; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * SITE_R * 0.8, d = new THREE.Mesh(drop, dropMat), sz = 0.04 + Math.random() * 0.05;
      d.position.set(Math.cos(a) * r, Math.sin(a) * r, 0.095); d.scale.set(sz, sz, sz * 0.55);
      g.add(d);
    }
    // the fruit is there from the start, a little way from where she stands (inside the area she keeps to)
    g.position.set(SITE_AT[0], SITE_AT[1], 0);
    female.scene.add(g);
    g.userData.r = SITE_R;
    this.growth = new Growth(female, g);   // the eggs, and what they become
  }

  /** Mating has just ended (or "mated" was chosen): start over from maturing. */
  start() {
    if (this.phase !== 'off' || this.count) return;
    this.set('maturing');
  }
  stop() {
    this.set('off'); this.bend = 0;
    this.growth.clear(); this.count = 0;
  }
  /** She died: no more laying, but what she laid lives on. */
  halt() { if (this.phase !== 'off') this.set('done'); this.bend = 0; }
  set(p) {
    this.phase = p; this.T = 0; this.hold = 0;
    if (p === 'seeking') {
      // the fruit, or a dead fly (see Growth.laySpot); walk across it until her abdomen is over it: aim past its centre by most of her length
      const F = this.f, S = this.spot = this.growth.laySpot(F.x, F.y), dx = S.x - F.x, dy = S.y - F.y, d = Math.hypot(dx, dy) || 1, over = Math.min(TIP - 0.4, S.r * 0.6);
      this.walkTo = [S.x + dx / d * over, S.y + dy / d * over];
    }
  }
  get smp550() { return SMP550_IN[this.phase]; }
  /** Where she should walk to, or null. */
  get goal() { return this.phase === 'seeking' ? this.walkTo : null; }
  get busy() { return this.phase === 'probing' || this.phase === 'laying' || this.phase === 'rest'; }

  step(clock, oviDN, days = 0, age = 10) {
    const F = this.f;
    this.T += clock;
    // the eggs she carries, ripening at her daily rate (fewer as she ages); a batch waits for the fruit
    if (this.phase !== 'off' && this.phase !== 'maturing' && this.phase !== 'done') this.held = Math.min(HOLD_MAX, (this.held ?? 30) + days * EGGS_PER_DAY * clamp(1 - (age - 10) / 70, 0.35, 1));
    if (this.phase === 'waiting' && this.held >= BATCH_MIN) this.set('seeking');
    // what matters is where the tip of her abdomen is, not her thorax
    const tx = F.x - Math.cos(F.yaw) * TIP, ty = F.y - Math.sin(F.yaw) * TIP;
    const S = this.spot ?? { x: this.site.position.x, y: this.site.position.y, r: SITE_R };
    if (S.corpse && !(S.corpse.meat > 0) && ['seeking', 'probing'].includes(this.phase)) this.set('seeking');   // the body is gone: choose again
    const onSite = Math.hypot(tx - S.x, ty - S.y) < S.r * 0.7;
    switch (this.phase) {
      case 'maturing':
        if (this.T > MATURE_S) this.set('seeking');
        break;
      case 'seeking':
        if (onSite) { this.set('probing'); F.setAct('stand', 1); }
        else if (F.act === 'walk') F.turn = wrap(Math.atan2(this.walkTo[1] - F.y, this.walkTo[0] - F.x) - F.yaw);
        if (!onSite && Math.hypot(this.walkTo[0] - F.x, this.walkTo[1] - F.y) < 0.3) this.set('seeking');   // got there but not over it: aim again from here
        break;
      case 'probing':
        this.hold = oviDN > LAY_HZ ? this.hold + clock : 0;
        if (this.hold > LAY_HOLD && this.held >= 1) { this.set('laying'); this.layAll(); }
        else if (this.held < 1) this.set('waiting');
        if (!onSite && this.T > 2) this.set('seeking');
        break;
      case 'laying':
        // the whole batch comes out at once, with one sound; her abdomen pumps a moment after
        if (this.T > PUMP_S) this.set('rest');
        break;
      case 'rest':
        // she shuffles round a little, so the eggs are not all in one spot
        if (this.T < 0.5) F.yaw += clock * (this.turnDir ??= Math.random() < 0.5 ? 0.9 : -0.9);
        if (this.T > REST_S) { this.turnDir = null; this.set(this.held >= BATCH_MIN ? 'probing' : 'waiting'); }   // off about her day until the next batch
        break;
    }
    // the abdomen bends down to the fruit while she lays, and a little while she probes
    const want = this.phase === 'laying' ? 0.7 + 0.3 * Math.sin(this.T * 16) : this.phase === 'probing' ? 0.25 : 0;   // pumping fast as the batch comes
    this.bend += (want - this.bend) * Math.min(1, clock * 6);
    const j = F.body.joints;
    for (const n of ['c_abdomen12-c_abdomen3-pitch', 'c_abdomen3-c_abdomen4-pitch', 'c_abdomen4-c_abdomen5-pitch', 'c_abdomen5-c_abdomen6-pitch'])
      if (j[n]) j[n].q = -0.4 * this.bend;            // negative pitch bends the abdomen down
  }

  layAll() {
    const F = this.f, base = new THREE.Vector3();
    F.body.byName.c_abdomen6.obj.getWorldPosition(base);
    base.x -= Math.cos(F.yaw) * 0.15; base.y -= Math.sin(F.yaw) * 0.15;
    for (let n = Math.floor(this.held); n > 0; n--) {
      const r = Math.sqrt(Math.random()) * 0.65, a = Math.random() * Math.PI * 2;   // a clutch spread round the tip
      if (this.growth.add(new THREE.Vector3(base.x + Math.cos(a) * r, base.y + Math.sin(a) * r, base.z), F.yaw + (Math.random() - 0.5) * 1.2)) this.count++;
    }
    this.held = 0;
    this.growth.onLay?.(base);
  }
}

// the banana's textures, drawn once: cream flesh with its fibres, the brown dotted core and the
// darkening round it; yellow peel going brown with black spots; a bump map for the grain
function bananaTextures() {
  const canvas = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const flesh = canvas(512, 512, (g, W) => {
    const c = W / 2, R = W / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, R);
    gr.addColorStop(0, '#d9b76a'); gr.addColorStop(0.18, '#f0dca0'); gr.addColorStop(0.7, '#eed49a'); gr.addColorStop(0.93, '#d8b070'); gr.addColorStop(1, '#9a7030');
    g.fillStyle = gr; g.fillRect(0, 0, W, W);
    g.strokeStyle = 'rgba(160,120,60,0.18)'; g.lineWidth = 2;             // radial fibres
    for (let k = 0; k < 90; k++) { const a = k / 90 * Math.PI * 2 + Math.random() * 0.05; g.beginPath(); g.moveTo(c + Math.cos(a) * R * 0.2, c + Math.sin(a) * R * 0.2); g.lineTo(c + Math.cos(a) * R * 0.9, c + Math.sin(a) * R * 0.9); g.stroke(); }
    for (let k = 0; k < 3; k++) {                                           // the three-lobed core with its tiny dark seeds
      const a = k / 3 * Math.PI * 2 + 0.3; g.fillStyle = 'rgba(150,110,50,0.35)';
      g.beginPath(); g.ellipse(c + Math.cos(a) * R * 0.09, c + Math.sin(a) * R * 0.09, R * 0.1, R * 0.05, a, 0, Math.PI * 2); g.fill();
    }
    for (let k = 0; k < 26; k++) { const a = Math.random() * Math.PI * 2, r = Math.random() * R * 0.17; g.fillStyle = 'rgba(40,25,10,0.8)'; g.beginPath(); g.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 2 + Math.random() * 2.5, 0, Math.PI * 2); g.fill(); }
    for (let k = 0; k < 30; k++) { const a = Math.random() * Math.PI * 2, r = R * (0.3 + Math.random() * 0.6); g.fillStyle = `rgba(120,80,30,${0.08 + Math.random() * 0.15})`; g.beginPath(); g.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 6 + Math.random() * 20, 0, Math.PI * 2); g.fill(); }   // browning bruises
    for (let k = 0; k < 70; k++) { const a = Math.random() * Math.PI * 2, r = Math.random() * R * 0.85; g.fillStyle = 'rgba(255,255,245,0.85)'; g.beginPath(); g.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 0.8 + Math.random() * 1.6, 0, Math.PI * 2); g.fill(); }  // yeast
  });
  const peel = canvas(512, 128, (g, W, H) => {
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#c9a23a'); gr.addColorStop(0.5, '#b88a2a'); gr.addColorStop(1, '#8a6420');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let k = 0; k < 160; k++) { g.fillStyle = `rgba(35,20,8,${0.35 + Math.random() * 0.55})`; g.beginPath(); g.ellipse(Math.random() * W, Math.random() * H, 2 + Math.random() * 9, 2 + Math.random() * 6, Math.random() * 3, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = 'rgba(60,40,15,0.35)'; for (let x = 0; x < W; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 6, H); g.stroke(); }
  });
  const bump = canvas(256, 256, (g, W) => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, W, W);
    for (let k = 0; k < 900; k++) { const v = 100 + Math.random() * 80; g.fillStyle = `rgb(${v},${v},${v})`; g.beginPath(); g.arc(Math.random() * W, Math.random() * W, 1 + Math.random() * 3, 0, Math.PI * 2); g.fill(); }
  });
  bump.colorSpace = THREE.NoColorSpace;
  return { flesh, peel, bump };
}
