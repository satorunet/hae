// The fly's answer, signalled with a flag.
//
// The body is the same NeuroMechFly skeleton the other pages use (test03), so
// the legs are real leg chains: raising the flag is inverse kinematics on the
// two front tarsi, and the flag is carried where those two tips meet. The
// numeral is drawn onto the cloth.
//
// The skeleton's frame is z-up (as in MuJoCo and flygym), so this scene is too.
import * as THREE from '../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG } from '../test03/body3d.js?v=6';

const V = '?v=6';
const NMF = new URL('../test03/nmf/', import.meta.url).href;
const LEG_ORDER = ['lf', 'lm', 'lh', 'rf', 'rm', 'rh'];
const FRONT = ['lf', 'rf'];
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class FlagFly {
  constructor(canvas) {
    this.canvas = canvas;
    this.ready = false;
    this.t = 0;
    this.state = 'idle';         // idle | thinking | raising | waving | lowering
    this.digit = null;
    this.sure = 1;
    this.lift = 0;               // 0 = legs on the ground, 1 = flag fully up
    this.want = 0;
  }

  async load() {
    const { J, bin } = await loadFlyData(NMF, V);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.2;

    const scene = this.scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x20262e, 1.4));
    const sun = new THREE.DirectionalLight(0xfff3e2, 2.4);
    sun.position.set(-5, -6, 9);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.7);
    rim.position.set(7, 5, 2);
    scene.add(rim);

    this.camera = new THREE.PerspectiveCamera(32, 1.6, 0.05, 200);
    this.camera.up.set(0, 0, 1);

    // a patch of ground in the xy plane, so the fly stands on something
    const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 56),
      new THREE.MeshStandardMaterial({ color: 0x1a212a, roughness: 0.96 }));
    scene.add(ground);

    this.body = new FlyBody(J, bin, { ghosts: 4 });
    scene.add(this.body.root);
    this.cpg = new CPG(J);
    this.stand = {};                                   // flygym's neutral angles
    LEG_ORDER.forEach((leg, i) => {
      this.stand[leg] = this.cpg.neutral(i);
      this.body.setLeg(leg, this.stand[leg]);
    });
    this.downTip = {};
    for (const leg of FRONT) this.downTip[leg] = this.body.legTip(leg).slice();
    this.z0 = -this.body.legTip('lm')[2];              // thorax height while standing

    this.flag = this.makeFlag();
    scene.add(this.flag.group);
    this.body.root.position.set(0, 0, this.z0);
    this.body.update();

    this.ready = true;
    this.resize();
    this.loop();
    return this;
  }

  // a pole along +z with the cloth hanging off its upper half, gripped at z = 0
  makeFlag() {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.3, 8),
      new THREE.MeshStandardMaterial({ color: 0xc6cdd6, roughness: 0.45, metalness: 0.35 }));
    pole.rotation.x = Math.PI / 2;                     // the cylinder's axis onto +z
    pole.position.z = 0.42;
    group.add(pole);

    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 128;
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.5, 14, 8),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
    cloth.rotation.x = Math.PI / 2;                    // the plane's y onto +z
    cloth.position.set(0.37, 0, 0.79);
    group.add(cloth);
    group.visible = false;
    return { group, pole, cloth, cvs, tex, base: cloth.geometry.attributes.position.array.slice() };
  }

  setDigit(d, sure = 1) {
    const { cvs, tex } = this.flag;
    const g = cvs.getContext('2d');
    g.fillStyle = sure > 0.45 ? '#f4f7fb' : '#ece3cc';   // a hesitant answer is written on tea-stained cloth
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#aeb8c4'; g.lineWidth = 5; g.strokeRect(2.5, 2.5, 123, 123);
    g.fillStyle = '#141a21';
    g.font = '700 86px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(d), 64, 68);
    tex.needsUpdate = true;
  }

  /** Hold up the flag for `digit`. `sure` in 0..1: a low value raises it slowly and wobbles. */
  show(digit, sure = 1) {
    this.digit = digit;
    this.sure = Math.max(0, Math.min(1, sure));
    this.setDigit(digit, this.sure);
    this.flag.group.visible = true;
    this.state = 'raising'; this.want = 1; this.stateT = 0;
  }
  /** Flag away, legs on the ground: the fly is working. */
  think() { this.state = 'thinking'; this.want = 0; this.digit = null; }
  /** Put it away. */
  lower() { this.state = 'lowering'; this.want = 0; }

  resize() {
    if (!this.ready) return;
    const w = this.canvas.clientWidth || 320;
    const h = Math.round(Math.max(190, Math.min(330, w * 0.62)));
    this.canvas.style.height = h + 'px';
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop = () => {
    requestAnimationFrame(this.loop);
    if (!this.ready) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now; this.t += dt;

    const speed = this.state === 'raising' ? 1.1 + 1.9 * this.sure : 2.4;
    this.lift += Math.max(-dt * speed, Math.min(dt * speed, this.want - this.lift));
    if (this.state === 'raising' && this.lift > 0.995) this.state = 'waving';
    if (this.state === 'lowering' && this.lift < 0.005) { this.state = 'idle'; this.flag.group.visible = false; }
    if (this.state === 'thinking' && this.lift < 0.005) this.flag.group.visible = false;
    const k = ease(this.lift);

    const breathe = Math.sin(this.t * 2.3) * 0.01;
    // confident: a steady wave. unsure: a slow wobble.
    const wob = this.state === 'waving'
      ? Math.sin(this.t * (2.4 + 5 * this.sure)) * (0.05 + 0.2 * (1 - this.sure))
      : 0;

    // the two front tarsi travel from where they stand up to a point in front
    // of the head, close enough together to share one pole
    const mid = [0, 0, 0];
    for (const leg of FRONT) {
      const side = leg === 'lf' ? 1 : -1;
      const d = this.downTip[leg];
      const up = [d[0] + 0.72, side * 0.09, d[2] + 1.42];
      const target = [
        d[0] + (up[0] - d[0]) * k,
        d[1] + (up[1] - d[1]) * k + wob * 0.12 * side,
        d[2] + (up[2] - d[2]) * k + wob * 0.28 + breathe,
      ];
      this.body.setLeg(leg, this.body.ik(leg, target, this.body.getLeg(leg), this.stand[leg], 5, 0.02));
      const tip = this.body.legTip(leg);
      for (let i = 0; i < 3; i++) mid[i] += tip[i] / 2;
    }
    // the other four stand, with a little idle shuffle
    for (const [li, leg] of [[1, 'lm'], [2, 'lh'], [4, 'rm'], [5, 'rh']]) {
      const s = this.stand[leg].slice();
      s[0] += Math.sin(this.t * 1.7 + li) * 0.018;
      this.body.setLeg(leg, s);
    }
    // it rears back as the flag goes up, and the thorax follows the hind legs
    this.body.root.rotation.y = -0.30 * k;
    this.body.root.position.z = this.z0 + breathe + 0.45 * k;
    this.body.update();

    if (this.flag.group.visible) {
      const p = new THREE.Vector3(mid[0], mid[1], mid[2]);
      this.body.root.localToWorld(p);
      this.flag.group.position.copy(p);
      this.flag.group.rotation.set(wob * 0.35, -0.1 - 0.25 * (1 - k), 0);
      this.flag.group.scale.setScalar(1.25);
      const a = this.flag.cloth.geometry.attributes.position, b = this.flag.base;
      for (let i = 0; i < a.count; i++) {
        const x = b[3 * i], y = b[3 * i + 1];
        a.array[3 * i + 2] = Math.sin(this.t * 6 + x * 8 + y * 2) * 0.035 * (x + 0.37);
      }
      a.needsUpdate = true;
      this.flag.cloth.geometry.computeVertexNormals();
    }

    // three-quarter view from the front, pulling back a touch as the flag rises
    const r = 5.8 + 1.2 * k, a2 = 0.66;
    this.camera.position.set(Math.cos(a2) * r, -Math.sin(a2) * r, 1.5 + 1.3 * k);
    this.camera.lookAt(0.35, 0, 0.8 + 1.7 * k);
    this.renderer.render(this.scene, this.camera);
  };
}
