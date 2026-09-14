// The human body, in a worker: MyoFullBody in MuJoCo (WebAssembly), 416 muscles
// driven toward the posture the fly's motor programs ask for, in real time.
//
// main -> worker: {type:'init'} | {type:'brain', out} | {type:'food', id, kind, x, y} | {type:'speed', x}
// worker -> main: {type:'ready', ...} | {type:'frame', ...} | {type:'senses', rates} | {type:'trial', phase, id, food, result?, t?} | {type:'error'}
//                 {type:'dopa', levels: [...]}   dopamine for the synapses onto the motor DNs (reflex.mjs REFLEX.groups), for the brain
//
// Each 10 ms of body time: scene -> (every 20 ms) senses to the brain; the latest brain
// output -> motor program levels -> posture, hand/knee footholds -> IK (every 20 ms) -> muscles.
import loadMujoco from './vendor/mujoco.js';
import { MuscleDriver } from './muscles.mjs?v=38';
import { FOODS, FALL_FROM } from './foods.js?v=33';
import { REFLEX } from './reflex.mjs?v=2';

const post = (m, t) => self.postMessage(m, t || []);
let mj, m, d, kin, drv;
const CTRL = 0.01;
let SUB = 5;

async function gunzip(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

// ------------------------------------------------------------------ model and landmarks
let COUPLED = [];
const PALM = {};
let PROSUP, ELBOW, TORSO, TIBIA, TALUS, NQ, FWD_L, LEFT_L, UP_L, HEAD, HAND, ARM, TRUNK, LEGJ, NECK, FINGERS, TOES, SHOULDER, HIP, PELVIS, qRest, qRef, MOUTH_L, SCALP_L, jacp, NB, NU;
let DOF_JNT, JNT_QADR, JNT_RANGE, ACTADR;             // copied once: model views cost a call each time
const qadr = (dof) => JNT_QADR[DOF_JNT[dof]];
function couple(q) {
  for (const c of COUPLED) { const x = q[c.l], a = c.a; q[c.f] = a[0] + x * (a[1] + x * (a[2] + x * (a[3] + x * a[4]))); }
}
const dofOf = (name) => m.jnt_dofadr[m.jnt(name).id];

function headFrame(dd) {
  const p = HEAD * 3, q = HEAD * 9;
  return { pos: [dd.xpos[p], dd.xpos[p + 1], dd.xpos[p + 2]], R: Array.from(dd.xmat.subarray(q, q + 9)) };
}
const mul = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const mulT = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const toWorld = (dd, local) => { const h = headFrame(dd); return add(h.pos, mul(h.R, local)); };

// The skin of the head (the vertices of the page's body mesh that move with the head), in the
// head's own frame, to know how low the face, chin and crown really are
let HEAD_SKIN = null, HEAD_MID = [0, 0, 0];
async function loadHeadSkin() {
  const info = await (await fetch(new URL('./data/skin.json?v=33', import.meta.url))).json();
  const buf = (await gunzip(new URL('./data/skin.bin.gz?v=33', import.meta.url))).buffer;
  const dv = new DataView(buf), nv = dv.getUint32(0, true), nt = dv.getUint32(4, true);
  const pos = new Float32Array(buf.slice(8, 8 + nv * 12)), o = 8 + nv * 12 + nt * 6;
  const bi = new Uint8Array(buf, o, nv * 4), bw = new Uint8Array(buf, o + nv * 4, nv * 4);
  const [w, x, y, z] = info.rest.xquat[HEAD], x0 = info.rest.xpos[HEAD];
  const R0 = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const pts = [];
  for (let v = 0; v < nv; v++) {
    let hw = 0;
    for (let j = 0; j < 4; j++) if (bi[4 * v + j] === HEAD) hw += bw[4 * v + j] / 255;
    if (hw > 0.6) pts.push(...mulT(R0, sub([pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]], x0)));
  }
  HEAD_SKIN = Float64Array.from(pts);
  const mid = [0, 1, 2].map((k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < pts.length; i += 3) { lo = Math.min(lo, pts[i]); hi = Math.max(hi, pts[i]); } return (lo + hi) / 2; });
  HEAD_MID = mid;
}
function headLowest(dd) {
  const p = HEAD * 3, q = HEAD * 9, R = dd.xmat, P = HEAD_SKIN;
  let low = Infinity;
  for (let i = 0; i < P.length; i += 3) low = Math.min(low, dd.xpos[p + 2] + R[q + 6] * P[i] + R[q + 7] * P[i + 1] + R[q + 8] * P[i + 2]);
  return low;
}

async function init() {
  mj = await loadMujoco({ locateFile: (p) => new URL('./vendor/' + p, import.meta.url).href });
  const vfs = new mj.MjVFS();
  vfs.addBuffer('body.mjb', await gunzip(new URL('./data/myofullbody.mjb.gz?v=27', import.meta.url)));
  m = mj.MjModel.from_binary_path('body.mjb', vfs);
  d = new mj.MjData(m); kin = new mj.MjData(m);
  SUB = Math.round(CTRL / m.opt.timestep);
  NB = m.nbody; NU = m.nu; NQ = m.nq;
  DOF_JNT = Int32Array.from(m.dof_jntid); JNT_QADR = Int32Array.from(m.jnt_qposadr);
  JNT_RANGE = Float64Array.from(m.jnt_range); ACTADR = Int32Array.from(m.actuator_actadr);
  // the arms hang exactly on shoulder_elv's lower limit; start just inside it (body_model.py)
  for (const s of 'rl') d.qpos[m.jnt_qposadr[m.jnt(`shoulder_elv_${s}`).id]] = 0.08;
  mj.mj_forward(m, d);
  qRest = Float64Array.from(d.qpos); qRef = Float64Array.from(d.qpos);
  HEAD = m.body('head').id; PELVIS = m.body('pelvis').id; TORSO = m.body('torso').id;
  // (body ids looked up once: every m.body(name) call leaves a little memory behind in the WebAssembly heap)
  TIBIA = { r: m.body('tibia_r').id, l: m.body('tibia_l').id }; TALUS = { r: m.body('talus_r').id, l: m.body('talus_l').id };
  HAND = { R: m.body('3proxph_r').id, L: m.body('3proxph_l').id };
  ELBOW = { R: m.body('ulna_r').id, L: m.body('ulna_l').id };
  ARM = {};
  for (const [S, s] of [['R', 'r'], ['L', 'l']]) {
    ARM[S] = [`elv_angle_${s}`, `shoulder_elv_${s}`, `shoulder_rot_${s}`, `elbow_flexion_${s}`, `flexion_${s}`, `pro_sup_${s}`].map(dofOf);
    PALM[S] = { palm: m.body(`thirdmc_${s}`).id, tip: m.body(`distph3_${s}`).id, index: m.body(`2proxph_${s}`).id, little: m.body(`5proxph_${s}`).id, wrist: m.body(`lunate_${s}`).id, indexTip: m.body(`distph2_${s}`).id, littleTip: m.body(`distph5_${s}`).id };
  }
  TRUNK = ['flex_extension', 'lat_bending', 'axial_rotation'].map(dofOf);
  LEGJ = {}; SHOULDER = {}; HIP = {};
  for (const s of 'rl') {
    LEGJ[s] = { hip: [`hip_flexion_${s}`, `hip_adduction_${s}`].map(dofOf), knee: dofOf(`knee_angle_${s}`), ankle: dofOf(`ankle_angle_${s}`) };
    SHOULDER[s] = m.body(`humerus_${s}`).id; HIP[s] = m.body(`femur_${s}`).id;
  }
  NECK = ['neck_nod', 'neck_turn'].map(dofOf);
  // joints slaved to others (scapula and clavicle to shoulder elevation, lumbar levels to the
  // spine, patella to the knee): the IK model must move them too, or a raised arm in the model
  // points half a radian away from the real one and the hand misses by 30-45 cm
  const eqd = Float64Array.from(m.eq_data), nd = eqd.length / Math.max(1, m.neq);
  COUPLED = [];
  for (let e = 0; e < m.neq; e++)
    if (m.eq_type[e] === mj.mjtEq.mjEQ_JOINT.value && m.eq_obj2id[e] >= 0)
      COUPLED.push({ f: JNT_QADR[m.eq_obj1id[e]], l: JNT_QADR[m.eq_obj2id[e]], a: Array.from(eqd.subarray(e * nd, e * nd + 5)) });
  // every finger joint (thumb included), per hand; all of them are crossed by the hand's muscles
  FINGERS = { R: [], L: [] };
  for (let j = 0; j < m.njnt; j++) {
    const name = m.jnt(j).name;
    if (!/^(cmc_|mp_flexion|ip_flexion|mcp\d_|pm\d_|md\d_)/.test(name)) continue;
    FINGERS[name.endsWith('_l') ? 'L' : 'R'].push({ dof: m.jnt_dofadr[j], lo: JNT_RANGE[2 * j], hi: JNT_RANGE[2 * j + 1], spread: name.includes('abduction'), open: OPEN_HAND[name.replace(/_[lr]$/, '')] ?? 0, v: 0, next: 0 });
  }
  TOES = ['mtp_angle_r', 'mtp_angle_l'].map(dofOf);
  PROSUP = { r: dofOf('pro_sup_r'), l: dofOf('pro_sup_l') };
  await loadHeadSkin();
  buildFoodWorld();
  const h = headFrame(d);
  // lips and the two halves of the scalp, fixed in the head (measured on the mesh; the face looks along -y)
  MOUTH_L = mulT(h.R, sub([-0.025, 0.118, 1.575], h.pos));
  FWD_L = mulT(h.R, [0, -1, 0]); LEFT_L = mulT(h.R, [1, 0, 0]); UP_L = mulT(h.R, [0, 0, 1]);   // the head's own directions
  SCALP_L = { L: mulT(h.R, sub([0.045, 0.19, 1.70], h.pos)), R: mulT(h.R, sub([-0.095, 0.19, 1.70], h.pos)) };
  jacp = new mj.DoubleBuffer(3 * m.nv);
  // no support: the body is held up by its hands and knees on the floor (the root gets no force)
  drv = new MuscleDriver(mj, m, { rootForce: 0, rootTorque: 0, rootCarried: true, bigReserve: 60, stance: stancePoints, balance: { ang: [60, 12], z: [40, 10], xy: [40, 14] } });
  applyControl();
  resetBody();                                              // (the same gentle start as after a reset)
  post({ type: 'ready', nbody: NB, nmuscle: NU, bodies: Array.from({ length: NB }, (_, i) => m.body(i).name) });
  last = performance.now();
  setTimeout(loop, 0);
}

// ------------------------------------------------------------------ the scene
// Food: the page asks for honey, meat or dung wherever the floor is tapped (./foods.js). The body
// crawls to the nearest, tastes it with the lips or a hand, and eats it up while the brain keeps MN9
// firing.
//
// Meat and dung are real objects, in a little physics world of their own next to the body's: they
// fall from above, tumble, bounce, pile up on each other and roll off, and the person's hands, arms,
// knees, shins, feet, trunk and head (capsules that follow the body) knock them about - though they
// do not push back on the body. Each kind has a few bodies kept waiting far off the floor; dropping
// one moves a free one into the air above the tap. As a lump is eaten its shapes shrink with it.
// Honey is not simulated: it lands as a puddle on the floor, or on the lump it was poured onto
// (the page finds which), and rides along on it.
const scene = { food: [] };
let fm, fd;                                                 // the food world
const SLOTS = { meat: 8, dung: 8 }, slots = { meat: [], dung: [] };
const PUSHERS = [                                           // [from body, to body, radius]
  ['humerus_r', 'ulna_r', 0.045], ['ulna_r', 'thirdmc_r', 0.035], ['thirdmc_r', 'distph3_r', 0.03],
  ['humerus_l', 'ulna_l', 0.045], ['ulna_l', 'thirdmc_l', 0.035], ['thirdmc_l', 'distph3_l', 0.03],
  ['femur_r', 'tibia_r', 0.075], ['tibia_r', 'talus_r', 0.05], ['calcn_r', 'toes_r', 0.035],
  ['femur_l', 'tibia_l', 0.075], ['tibia_l', 'talus_l', 0.05], ['calcn_l', 'toes_l', 0.035],
  ['pelvis', 'torso', 0.14], ['torso', 'neck', 0.12], ['head', 'head', 0.1],
];
let pushers = [];
function buildFoodWorld() {
  const f3 = (v) => v.map((x) => x.toFixed(4)).join(' ');
  let bodies = '', n = 0;
  for (const kind of Object.keys(SLOTS)) for (let i = 0; i < SLOTS[kind]; i++, n++) {
    const F = FOODS[kind], size = 2 * F.r;
    bodies += `<body name="${kind}${i}" pos="${100 + 2 * n} 0 0.3"><freejoint/>`
      + F.parts.map((p) => `<geom type="ellipsoid" pos="${f3([p.c[0] * size, -p.c[2] * size, p.c[1] * size])}" size="${f3([p.s[0] * size, p.s[2] * size, p.s[1] * size])}" density="${F.density}"/>`).join('')
      + '</body>';
  }
  // the pushers: capsules along the limbs (and a ball for the head), moved with the body every step;
  // they meet the food but not the floor
  pushers = PUSHERS.map(([a, b, r], i) => ({ a: m.body(a).id, b: m.body(b).id, r, name: `pusher${i}` }));
  for (const p of pushers) p.half = p.a === p.b ? 0 : Math.max(0.01, Math.hypot(...[0, 1, 2].map((k) => d.xpos[3 * p.a + k] - d.xpos[3 * p.b + k])) / 2 - p.r * 0.5);
  const push = pushers.map((p) => `<body name="${p.name}" mocap="true" pos="0 0 -5"><geom type="${p.half ? 'capsule' : 'sphere'}" size="${p.r}${p.half ? ' ' + p.half.toFixed(4) : ''}" contype="2" conaffinity="0"/></body>`).join('');
  // (soft, sticky and heavily damped contacts: a lump that lands does not bounce, and one that lands on
  // another stays on it or leans against it rather than skating off)
  const xml = `<mujoco><option timestep="0.005"/>
    <default><geom contype="1" conaffinity="3" condim="6" friction="2.5 0.2 0.08" solref="0.01 3"/></default>
    <worldbody><geom name="floor" type="plane" size="0 0 1" contype="1" conaffinity="1"/>${bodies}${push}</worldbody></mujoco>`;
  const vfs = new mj.MjVFS();
  vfs.addBuffer('food.xml', new TextEncoder().encode(xml));
  fm = mj.MjModel.from_xml_path('food.xml', vfs);
  fd = new mj.MjData(fm);
  const bodyJnt = Int32Array.from(fm.body_jntadr), geomAdr = Int32Array.from(fm.body_geomadr), geomNum = Int32Array.from(fm.body_geomnum);
  const qadrF = Int32Array.from(fm.jnt_qposadr), dadrF = Int32Array.from(fm.jnt_dofadr), gsize = fm.geom_size, gpos = fm.geom_pos, grb = fm.geom_rbound;
  for (const kind of Object.keys(SLOTS)) for (let i = 0; i < SLOTS[kind]; i++) {
    const b = fm.body(`${kind}${i}`).id, g0 = geomAdr[b], ng = geomNum[b];
    slots[kind].push({ b, q: qadrF[bodyJnt[b]], v: dadrF[bodyJnt[b]], g0, ng, park: [100 + 2 * (fm.body(`${kind}${i}`).id - 1), 0, 0.3],
      size: Array.from(gsize.subarray(3 * g0, 3 * (g0 + ng))), pos: Array.from(gpos.subarray(3 * g0, 3 * (g0 + ng))), rb: Array.from(grb.subarray(g0, g0 + ng)), used: false });
  }
  for (const p of pushers) p.mocap = fm.body_mocapid[fm.body(p.name).id];
  mj.mj_forward(fm, fd);
}
function shrinkSlot(sl, k) {                                // a lump's shapes at k times their size
  const gsize = fm.geom_size, gpos = fm.geom_pos, grb = fm.geom_rbound;
  for (let j = 0; j < 3 * sl.ng; j++) { gsize[3 * sl.g0 + j] = sl.size[j] * k; gpos[3 * sl.g0 + j] = sl.pos[j] * k; }
  for (let j = 0; j < sl.ng; j++) grb[sl.g0 + j] = sl.rb[j] * k;
}
function parkSlot(sl) {
  const qp = fd.qpos, qv = fd.qvel;
  qp[sl.q] = sl.park[0]; qp[sl.q + 1] = sl.park[1]; qp[sl.q + 2] = sl.park[2]; qp[sl.q + 3] = 1; qp[sl.q + 4] = qp[sl.q + 5] = qp[sl.q + 6] = 0;
  for (let j = 0; j < 6; j++) qv[sl.v + j] = 0;
  shrinkSlot(sl, 1); sl.used = false;
}
function addFood(msg) {
  const F = FOODS[msg.kind]; if (!F) return;
  const f = { id: msg.id, kind: msg.kind, amount: 1, shrunk: 1, at: null };
  if (F.parts) {
    // the oldest lump of this kind gives up its body if they are all in use
    let sl = slots[msg.kind].find((x) => !x.used);
    if (!sl) { const old = scene.food.find((o) => o.kind === msg.kind); removeFood(old); sl = old.slot; }
    sl.used = true; f.slot = sl;
    const qp = fd.qpos, qv = fd.qvel;
    // mostly upright, turned any way about the vertical and tipped a little, turning slowly as it falls
    const yaw = Math.random() * 2 * Math.PI, tip = (Math.random() - 0.5) * 0.5, ax = Math.random() * 2 * Math.PI;
    const qy = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], qt = [Math.cos(tip / 2), Math.cos(ax) * Math.sin(tip / 2), Math.sin(ax) * Math.sin(tip / 2), 0];
    const qr = [qt[0] * qy[0] - qt[3] * qy[3], qt[1] * qy[0] + qt[2] * qy[3], qt[2] * qy[0] - qt[1] * qy[3], qt[0] * qy[3] + qt[3] * qy[0]];
    qp[sl.q] = msg.x; qp[sl.q + 1] = msg.y; qp[sl.q + 2] = FALL_FROM;
    for (let j = 0; j < 4; j++) qp[sl.q + 3 + j] = qr[j];
    for (let j = 0; j < 3; j++) { qv[sl.v + j] = 0; qv[sl.v + 3 + j] = (Math.random() - 0.5) * 1; }
  } else {
    // honey: on the lump it landed on (kept in that lump's frame), or on the floor
    const on = msg.on != null && scene.food.find((o) => o.id === msg.on && o.slot);
    f.pos = [msg.x, msg.y, on ? msg.z : 0];
    hear(f.pos, LOUD.honey);
    if (on) { f.on = on; f.local = mulT(lumpFrame(on).R, sub(f.pos, lumpFrame(on).pos)); }
  }
  scene.food.push(f);
  if (scene.food.length > 16) removeFood(scene.food[0]);
}
function removeFood(f) {
  if (!f) return;
  scene.food = scene.food.filter((o) => o !== f);
  if (f.slot) parkSlot(f.slot);
  for (const o of scene.food) if (o.on === f) { o.on = null; o.pos[2] = 0; }   // honey on it drops to the floor
}
function lumpFrame(f) {
  const b = f.slot.b;
  return { pos: [fd.xpos[3 * b], fd.xpos[3 * b + 1], fd.xpos[3 * b + 2]], R: Array.from(fd.xmat.subarray(9 * b, 9 * b + 9)) };
}
// where each food is now, as the body sees it: its middle, its radius in plan, its top, and whether
// it is still in the air
function locateFood() {
  const gs = fm.geom_size, gx = fd.geom_xpos, xi = fd.xipos, qv = fd.qvel;
  for (const f of scene.food) {
    const F = FOODS[f.kind], k = Math.sqrt(Math.max(0, f.amount));
    if (f.slot) {
      const b = f.slot.b, v = f.slot.v;
      let top = -Infinity;
      for (let g = f.slot.g0; g < f.slot.g0 + f.slot.ng; g++) top = Math.max(top, gx[3 * g + 2] + Math.max(gs[3 * g], gs[3 * g + 1], gs[3 * g + 2]) * 0.8);
      // (in the air: still falling or flying off, faster than 0.6 m/s)
      f.at = { x: xi[3 * b], y: xi[3 * b + 1], top, r: F.r * k, air: Math.hypot(qv[v], qv[v + 1], qv[v + 2]) > 0.6 };
      if (f.wasAir && !f.at.air) hear([f.at.x, f.at.y, top], LOUD[f.kind] ?? 0.7);    // (it lands: a thud)
      f.wasAir = f.at.air;
    } else {
      if (f.on) { const L = lumpFrame(f.on); f.pos = add(L.pos, mul(L.R, f.local)); }
      f.at = { x: f.pos[0], y: f.pos[1], top: f.pos[2] + 0.01, r: F.r * k * (f.on ? 0.6 : 1), air: false };
    }
  }
}
const foodR = (f) => f.at.r;
const foodTop = (f) => f.at.top;
function foodUnder(p, slack) {                              // the food under a point (in plan), topmost first
  let best = null;
  for (const f of scene.food) if (f.at && !f.at.air && Math.hypot(p[0] - f.at.x, p[1] - f.at.y) < f.at.r + slack && (!best || f.at.top > best.at.top)) best = f;
  return best;
}
function foodAt(p, dz, slack) {                             // ... if the point is down in it, within dz of its top
  const f = foodUnder(p, slack);
  return f && p[2] < foodTop(f) + dz ? f : null;
}
function nearestFood(p) {
  let best = null, bd = Infinity;
  for (const f of scene.food) { if (!f.at || f.at.air) continue; const r = Math.hypot(p[0] - f.at.x, p[1] - f.at.y); if (r < bd) { bd = r; best = f; } }
  return best;
}
// the food world takes one control step: the pushers go to where the body's parts are, then it steps
function stepFood() {
  const mp = fd.mocap_pos, mq = fd.mocap_quat;
  for (const p of pushers) {
    const A = [0, 1, 2].map((k) => d.xpos[3 * p.a + k]);
    if (p.a === p.b) {                                      // the head: a ball over the middle of its skin
      const c = toWorld(d, HEAD_MID);
      mp[3 * p.mocap] = c[0]; mp[3 * p.mocap + 1] = c[1]; mp[3 * p.mocap + 2] = c[2];
      continue;
    }
    const B = [0, 1, 2].map((k) => d.xpos[3 * p.b + k]), ax = sub(B, A), n = norm(ax) || 1, u = scale(ax, 1 / n);
    mp[3 * p.mocap] = (A[0] + B[0]) / 2; mp[3 * p.mocap + 1] = (A[1] + B[1]) / 2; mp[3 * p.mocap + 2] = (A[2] + B[2]) / 2;
    // the capsule's axis (local z) along the segment: half the turn from z to it
    const w = 1 + u[2], qn = Math.hypot(w, -u[1], u[0]) || 1;
    if (w < 1e-6) { mq[4 * p.mocap] = 0; mq[4 * p.mocap + 1] = 1; mq[4 * p.mocap + 2] = 0; mq[4 * p.mocap + 3] = 0; }
    else { mq[4 * p.mocap] = w / qn; mq[4 * p.mocap + 1] = -u[1] / qn; mq[4 * p.mocap + 2] = u[0] / qn; mq[4 * p.mocap + 3] = 0; }
  }
  for (const f of scene.food) if (f.slot && Math.abs(f.shrunk - Math.sqrt(f.amount)) > 0.02) { f.shrunk = Math.sqrt(Math.max(0.05, f.amount)); shrinkSlot(f.slot, f.shrunk); }
  mj.mj_step(fm, fd); mj.mj_step(fm, fd);
  // anything that has left the floor for good is gone
  for (const f of scene.food.slice()) if (f.slot && (Math.hypot(fd.xpos[3 * f.slot.b], fd.xpos[3 * f.slot.b + 1]) > 2.6 || fd.xpos[3 * f.slot.b + 2] < -0.5)) removeFood(f);
  locateFood();
}

function resetLimbs() {
  for (const L of LIMBS) {
    const hand = L[1] === 'H', S = L[0], s = S.toLowerCase();
    limb[L] = hand ? { hand, dofs: ARM[S], body: HAND[S], mode: 'floor', q: SEED.floor.slice(), goal: null }
                   : { hand, dofs: LEGJ[s].hip, body: m.body(`tibia_${s}`).id, mode: 'knee', seed: [1.4, 0], q: [1.4, 0], goal: null };
  }
}

// A trial, for the learning experiment (../school/): from the first food to land while none is under
// way - food dropped after the last trial ended, with the body up on its hands and knees - to how
// it ends. On the way it posts the steps it gets through, so the page can make the second decision
// (how to feed) and sound the success:
//   {phase:'reached'}   the body has stopped at the food with its face over it
//   {phase:'ate'}       it has eaten a fifth of it (it goes on)
// and at the end {phase:'end', result, reached, ate} (the times of those steps, or null), result:
//   finished  it ate it all up
//   fell      the trunk has been down on the floor for half a second (before or after eating)
//   out       the body has crawled off the edge of the floor
//   timeout   a minute has gone by without either (a minute and a half, once it is eating)
//   lost      the food itself went off the floor (not the body's doing: not counted)
// Along the way it keeps a record of what the fly's brain did and how the body was used, sent with
// the end (and on to the school by the page): the brain's senses and commands (means and peaks, and
// a 0.5 s trace of the main ones), and the body's path, steps, posture and the floor's support.
const FIELD = 2.2, FALL_OK = 8;
const eaten = { total: 0, last: null };                     // everything eaten so far (a trial counts from where it was at its start)
const trial = { on: false, id: null, food: null, t0: 0, left: 1, rec: null, lastId: 0, reached: null, ate: null, eaten0: 0 };
const OUT_KEYS = ['MN9', 'groomL', 'groomR', 'GFL', 'GFR', 'DNa02L', 'DNa02R', 'MDN', 'DNp09'];
function trialRecord() {
  return { n: 0, brainSum: {}, brainMax: {}, senseSum: {}, senseMax: {}, trace: [], dist: 0, last: null, steps: 0, lastLimb: null,
    support: 0, tiltMax: 0, headMin: Infinity, reachedAt: null, eating: 0, dip: 0, frames: recent.frames.slice() };
}
function recordTrial(t) {
  const r = trial.rec;
  r.n++;
  for (const k of OUT_KEYS) { const v = brain[k] || 0; r.brainSum[k] = (r.brainSum[k] || 0) + v; r.brainMax[k] = Math.max(r.brainMax[k] || 0, v); }
  for (const [k, v] of Object.entries(rates)) { r.senseSum[k] = (r.senseSum[k] || 0) + v; r.senseMax[k] = Math.max(r.senseMax[k] || 0, v); }
  const p = [d.xpos[3 * PELVIS], d.xpos[3 * PELVIS + 1], d.xpos[3 * PELVIS + 2]];
  if (r.last) r.dist += Math.hypot(p[0] - r.last[0], p[1] - r.last[1]);
  r.last = p;
  if (gait.limb && gait.phase === 'swing' && r.lastLimb !== gait.limb + gait.t0) { r.steps++; r.lastLimb = gait.limb + gait.t0; }
  r.support += info.support || 0;
  const up = (d.xpos[3 * TORSO + 2] - p[2]) / (Math.hypot(d.xpos[3 * TORSO] - p[0], d.xpos[3 * TORSO + 1] - p[1], d.xpos[3 * TORSO + 2] - p[2]) || 1);
  r.tiltMax = Math.max(r.tiltMax, Math.abs(Math.asin(Math.max(-1, Math.min(1, up)))));
  if (r.n % 10 === 0) r.headMin = Math.min(r.headMin, headLowest(d));
  if (walker.there && r.reachedAt == null) r.reachedAt = t - trial.t0;
  if (prog.feed > 0.3) r.eating += CTRL;
  r.dip = Math.max(r.dip, dip);
  if (r.n % 50 === 0 && r.trace.length < 130)
    r.trace.push([+(t - trial.t0).toFixed(1), +p[0].toFixed(3), +p[1].toFixed(3), +p[2].toFixed(3), Math.round(brain.MN9 || 0), Math.round((brain.DNa02R || 0) - (brain.DNa02L || 0)), Math.round(rates.sugar || rates.water || 0), gait.limb || '-']);
}
function trialSummary() {
  const r = trial.rec, mean = (sum) => Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, +(v / Math.max(1, r.n)).toFixed(2)]));
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(1)]));
  return {
    brain: { mean: mean(r.brainSum), peak: round(r.brainMax), senses: mean(r.senseSum), sensePeak: round(r.senseMax) },
    body: { distance: +r.dist.toFixed(3), steps: r.steps, reachedFoodAt: r.reachedAt == null ? null : +r.reachedAt.toFixed(2), eatingSeconds: +r.eating.toFixed(2),
      meanSupportN: Math.round(r.support / Math.max(1, r.n)), maxTrunkTilt: +r.tiltMax.toFixed(3), minHeadClearance: r.headMin === Infinity ? null : +r.headMin.toFixed(3), deepestDip: +r.dip.toFixed(2),
      params: { CRAWL, FEED, STANCE, GAIT } },
    trace: { columns: ['t', 'x', 'y', 'z', 'MN9', 'DNa02 R-L', 'taste', 'stepping'], rows: r.trace },
  };
}
// The motion itself, as data, recorded 10 times a second during a trial (and sent with its end as
// `motion`, an ArrayBuffer): every joint position of the body, the food (where each piece is and how
// much is left) and what the body and brain were doing - enough to rebuild the trial afterwards and
// watch it again ({type:'replay'}; {type:'live'} then starts the live body over). Format (little-endian):
//   uint32 n, the length of a JSON header { v: 2, hz, nq, frames, foods: [kind...], maxFood,
//          trialStart (s into the recording), events: [{t, type:'pour', ...}] }
//   int16  frames x nq      joint positions, as differences from the frame before (the first as is):
//                           root position in mm, root orientation x 32000, joints in rad x 5000
//   int16  frames x maxFood x 8   food: [slot+1 (0 = none), x, y, z in mm, quaternion x 32000 (w, x, y, z)]
//   uint8  frames x maxFood        food amount x 255
//   uint8  frames x 12       prog bits (2 bytes), MN9, DNa02 L, DNa02 R, giant fibre, sugar, water, salt, bitter, eyes, wind (each /4 or /2, clipped)
const MOTION = { hz: 10, maxFood: 4, scale: (i) => (i < 3 ? 1000 : i < 7 ? 32000 : 5000) };
const PROG_BITS = ['walk', 'back', 'probe', 'rub', 'feed', 'groomL', 'groomR', 'escape'];
// Frames are taken all the time and the last few seconds kept, so a trial's recording begins a little
// before the food that started it came down (a lump falling, honey being poured); the page's pours
// ({type:'pour'}) are kept as events with their time, and put in the recording too.
const PRE_S = 6;
const recent = { frames: [], events: [] };
function captureFrame() {
  const q = new Int16Array(NQ);
  for (let i = 0; i < NQ; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(d.qpos[i] * MOTION.scale(i))));
  const foods = scene.food.slice(0, MOTION.maxFood).map((f) => {
    const pos = f.slot ? fd.xpos.subarray(3 * f.slot.b, 3 * f.slot.b + 3) : f.pos, quat = f.slot ? fd.xquat.subarray(4 * f.slot.b, 4 * f.slot.b + 4) : [1, 0, 0, 0];
    return { id: f.id, kind: f.kind, pos: [0, 1, 2].map((j) => Math.round(pos[j] * 1000)), quat: [0, 1, 2, 3].map((j) => Math.round(quat[j] * 32000)), amount: Math.round(Math.max(0, Math.min(1, f.amount)) * 255) };
  });
  let bits = 0;
  const pf = { ...prog, walk: Math.abs(walker.speed) > 0.05, back: walker.speed < -0.05, escape: d.time - escape.t < ESCAPE_S + 0.3 };
  PROG_BITS.forEach((k, i) => { if (pf[k] === true || pf[k] > 0.3) bits |= 1 << i; });
  const c = (v, div) => Math.max(0, Math.min(255, Math.round((v || 0) / div)));
  const brainB = Uint8Array.from([bits & 255, bits >> 8, c(brain.MN9, 4), c(brain.DNa02L, 4), c(brain.DNa02R, 4), c(Math.max(brain.GFL || 0, brain.GFR || 0), 4),
    c(rates.sugar, 2), c(rates.water, 2), c(rates.salt, 2), c(rates.bitter, 2), c(rates.eyeL, 1), c(Math.max(rates.windL || 0, rates.windR || 0), 1)]);
  const frame = { t: d.time, q, foods, brain: brainB };
  recent.frames.push(frame);
  while (recent.frames.length && recent.frames[0].t < d.time - PRE_S) recent.frames.shift();
  if (trial.on && trial.rec && trial.rec.frames.length < 120 * MOTION.hz) trial.rec.frames.push(frame);
  while (recent.events.length && recent.events[0].t < d.time - 120) recent.events.shift();
}
function encodeMotion(list, trialT0) {
  const frames = list.length, t0 = frames ? list[0].t : trialT0, MF = MOTION.maxFood;
  const ids = [], kinds = [];
  const q = new Int16Array(frames * NQ), food = new Int16Array(frames * MF * 8), amount = new Uint8Array(frames * MF), brainB = new Uint8Array(frames * 12);
  list.forEach((fr, f) => {
    for (let i = 0; i < NQ; i++) q[f * NQ + i] = f ? fr.q[i] - list[f - 1].q[i] : fr.q[i];
    fr.foods.forEach((it, k) => {
      let slot = ids.indexOf(it.id);
      if (slot < 0) { slot = ids.length; ids.push(it.id); kinds.push(it.kind); }
      food.set([slot + 1, ...it.pos, ...it.quat], (f * MF + k) * 8);
      amount[f * MF + k] = it.amount;
    });
    brainB.set(fr.brain, f * 12);
  });
  // events: the page's pours from the recording's start on, timed from it (and the trial's own start)
  const events = recent.events.filter((e) => e.t >= t0 - 3).map((e) => ({ ...e, t: Math.max(0, +(e.t - t0).toFixed(2)), early: +Math.max(0, t0 - e.t).toFixed(2) }));   // (early: how long before the recording it began)
  const header = new TextEncoder().encode(JSON.stringify({ v: 2, hz: MOTION.hz, nq: NQ, frames, foods: kinds, maxFood: MF, trialStart: +(trialT0 - t0).toFixed(2), events }));
  const parts = [new Uint32Array([header.length]), header, q, food, amount, brainB];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0) + 4);
  let o = 0;
  for (const p of parts) {
    const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    if (p instanceof Int16Array && o % 2) o++;                // (keep int16 runs on even offsets)
    out.set(bytes, o); o += bytes.length;
  }
  return out.slice(0, o).buffer;
}

// Watching a recorded trial again: the live body is set aside (its state kept), and the recorded
// joint positions are put back into the model one after another (in between frames, blended) -
// nothing is simulated - and sent to the page like live frames, with the recorded food, programs
// and brain signals. {type:'live'} puts the live body back where it was.
//   main -> worker: {type:'replay', motion (ArrayBuffer, as recorded; gzip allowed)}
//                   {type:'replayControl', playing?, speed?, seek? (s)}   {type:'live'}
//   worker -> main: frames carry `replay: {t, duration, playing, speed}` while it is on
const replay = { on: false, data: null, t: 0, playing: true, speed: 1, saved: null };
async function decodeMotion(buf) {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl)));
  let o = 4 + hl;
  const i16 = (n) => { if (o % 2) o++; const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = dv.getInt16(o + 2 * i, true); o += 2 * n; return a; };
  const u8 = (n) => { const a = bytes.slice(o, o + n); o += n; return a; };
  const F = head.frames, nq = head.nq, MF = head.maxFood;
  const dq = i16(F * nq), q = new Float64Array(F * nq), acc = new Int32Array(nq);
  for (let f = 0; f < F; f++) for (let i = 0; i < nq; i++) { acc[i] += dq[f * nq + i]; q[f * nq + i] = acc[i] / MOTION.scale(i); }
  return { head, q, food: i16(F * MF * 8), amount: u8(F * MF), brain: u8(F * 12), duration: (F - 1) / head.hz };
}
async function startReplay(buf) {
  const data = await decodeMotion(buf);
  if (data.head.nq !== NQ || data.head.frames < 2 || !(data.head.v >= 1)) throw new Error('motion does not fit this body');
  if (!replay.on) replay.saved = { qpos: Float64Array.from(d.qpos), qvel: Float64Array.from(d.qvel), act: Float64Array.from(d.act), time: d.time };
  Object.assign(replay, { on: true, data, t: 0, playing: true, started: false });
}
function stopReplay() {
  if (!replay.on) return;
  Object.assign(replay, { on: false, data: null, saved: null });
  resetBody();                                              // (back to live starts over, on all fours at the centre)
  last = performance.now(); simLag = 0;
}
let replayScene = null;
function replayStep(dt) {
  const R = replay, D = R.data, hz = D.head.hz, F = D.head.frames, nq = D.head.nq, MF = D.head.maxFood;
  const before = R.started ? R.t : -1;
  R.started = true;
  if (R.playing) R.t = Math.min(D.duration, R.t + dt * R.speed);
  // the events passed since the last frame (all of them again after seeking back)
  R.fired = (D.head.events || []).filter((e) => (R.t >= before ? e.t > before && e.t <= R.t : e.t <= R.t && e.t > R.t - 0.05));
  if (R.jumped) { R.fired = []; R.jumped = false; }
  if (R.t >= D.duration) R.playing = false;
  const x = R.t * hz, f0 = Math.min(F - 1, Math.floor(x)), f1 = Math.min(F - 1, f0 + 1), u = x - f0;
  for (let i = 0; i < nq; i++) d.qpos[i] = D.q[f0 * nq + i] + (D.q[f1 * nq + i] - D.q[f0 * nq + i]) * u;
  const qn = Math.hypot(d.qpos[3], d.qpos[4], d.qpos[5], d.qpos[6]) || 1;
  for (let i = 3; i < 7; i++) d.qpos[i] /= qn;
  d.qvel.fill(0);
  mj.mj_kinematics(m, d);
  const food = [];
  for (let k = 0; k < MF; k++) {
    const b = (f0 * MF + k) * 8, slot = D.food[b];
    if (!slot) continue;
    const amount = D.amount[f0 * MF + k] / 255, kind = D.head.foods[slot - 1];
    const pos = [D.food[b + 1] / 1000, D.food[b + 2] / 1000, D.food[b + 3] / 1000], quat = [D.food[b + 4], D.food[b + 5], D.food[b + 6], D.food[b + 7]].map((v) => v / 32000);
    food.push(kind === 'honey' ? { id: 1e6 + slot, kind, amount, pos } : { id: 1e6 + slot, kind, amount, pos, quat });
  }
  const br = D.brain.subarray(f0 * 12, f0 * 12 + 12), bits = br[0] | (br[1] << 8);
  const progR = Object.fromEntries(PROG_BITS.map((k, i) => [k, (bits >> i) & 1 ? 1 : 0]));
  progR.walk = !!progR.walk; progR.back = !!progR.back; progR.escape = !!progR.escape;
  replayScene = { food, prog: progR, brain: { MN9: br[2] * 4, DNa02L: br[3] * 4, DNa02R: br[4] * 4, GF: br[5] * 4 },
    rates: { sugar: br[6] * 2, water: br[7] * 2, salt: br[8] * 2, bitter: br[9] * 2, eyeL: br[10], eyeR: br[10], windL: br[11], windR: br[11] } };
}

// out of the field: any part of the body - chest, head, a hand, a knee, a foot - past the floor's edge
// (at once, trial or no trial: without one the page is told so by itself, once until a reset)
const offField = { told: false };
function outOfField() {
  const ids = [PELVIS, TORSO, HEAD, PALM.R.palm, PALM.L.palm, TIBIA.r, TIBIA.l, TALUS.r, TALUS.l];
  return ids.some((b) => Math.hypot(d.xpos[3 * b], d.xpos[3 * b + 1]) > FIELD);
}
function watchTrial() {
  const t = d.time;
  const out = outOfField();
  if (!out) offField.told = false;
  else if (!trial.on && !offField.told) { offField.told = true; post({ type: 'out' }); }
  if (!trial.on) {
    if (fallen.up || fallen.since >= 0) return;
    // new food down - or the body has started eating some that was already there
    let f = scene.food.find((o) => o.id > trial.lastId && o.at && !o.at.air);
    if (!f && meal.on && eaten.last && scene.food.includes(eaten.last)) f = eaten.last;
    if (f) {
      Object.assign(trial, { on: true, id: f.id, foodId: f.id, food: f.kind, t0: t, left: 1, rec: trialRecord(), reached: null, ate: null, eaten0: eaten.total });
      const px = d.xpos[3 * PELVIS], py = d.xpos[3 * PELVIS + 1];
      let dy = Math.atan2(f.at.x - px, -(f.at.y - py)) - walker.yaw; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
      post({ type: 'trial', phase: 'start', id: f.id, food: f.kind, behind: Math.abs(dy) > TURN.behind });   // (food behind: the page asks how to come round)
    }
    return;
  }
  recordTrial(t);
  const f = scene.food.find((o) => o.id === trial.foodId), since = +(t - trial.t0).toFixed(2);
  const step = (phase) => post({ type: 'trial', phase, id: trial.id, food: trial.food, t: since });
  if (trial.reached == null && (meal.on || foodAt(toWorld(d, MOUTH_L), 0.12, 0.05) || [PALM.R.palm, PALM.L.palm].some((b) => foodAt([d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]], 0.07, 0.03)))) { trial.reached = since; step('reached'); }
  let result = null;
  // eaten: a fifth of a piece of food, of whatever it ate while the trial was on (another piece than
  // the one that started it counts too)
  if (trial.ate == null && eaten.total - trial.eaten0 >= 0.2) { trial.ate = since; step('ate'); }
  if (f) trial.left = f.amount;
  else if (trial.ate != null) { if (!scene.food.length || !meal.on) result = 'finished'; }
  else if (!scene.food.length) result = trial.left < 0.85 ? 'finished' : 'lost';
  else { const g = scene.food.find((o) => o.at && !o.at.air); if (g) { trial.foodId = g.id; trial.left = g.amount; } }   // (its food went: the next one on the floor carries on)
  // a fall is only a failure if the body is not up again within FALL_OK seconds (then it carries on)
  if (fallen.since >= 0 && t - fallen.since > FALL_OK) result = 'fell';
  if (out) { result = 'out'; offField.told = true; }
  if (!result && t - trial.t0 > (trial.ate != null ? 90 : 60)) result = 'timeout';
  if (result) {
    trial.on = false;
    trial.lastId = Math.max(trial.lastId, ...scene.food.map((o) => o.id), trial.id);   // (food already down does not start another)
    if (result === 'finished' && trial.ate == null) trial.ate = since;
    const motion = encodeMotion(trial.rec.frames, trial.t0);
    post({ type: 'trial', phase: 'end', id: trial.id, food: trial.food, result, reached: trial.reached, ate: trial.ate, t: since, record: trialSummary(), motion }, [motion]);
  }
}

function updateScene() {
  stepFood();
  watchTrial();
  // eating: while feeding with the lips on it, it goes down (a whole one in 2.5-3.5 s)
  const food = foodAt(toWorld(d, MOUTH_L), 0.12, 0.03);
  if (food && prog.feed > 0.3) { const bite = CTRL / FOODS[food.kind].eat; food.amount -= bite; eaten.total += bite; eaten.last = food; }
  for (const f of scene.food.filter((o) => o.amount <= 0.1)) removeFood(f);   // (the last scrap goes with the last bite)
}

// What the body's own movement gives the fly's senses, every 20 ms (the brain reacts to it as it will):
//   eyes (photoreceptors R1-6, a tenth of each eye)  the image sliding as the head turns and travels
//   antennae (Johnston's organ, wind and gravity)    air on them as the head moves, and the head tilting
//   ocelli                                           the sky swinging as the head pitches and rolls
//   LC11 (small moving objects)                      the person's own hands moving in front of the
//                                                    face, and food falling or rolling, each by eye
//   LC4 / LPLC2 (looming)                            food coming at the eyes fast (not the own hands)
const motion = { pos: null, R: null, seen: new Map() };
// Sounds (the food landing): each heard for SOUND_S by Johnston's organ's hearing neurons of both
// antennae, louder the nearer, and louder on the side it came from (audL/audR). What the brain does
// with it is its own: in this model a sound on the left drives DNp12 on the left, on the right DNg24 on the
// right (measured on the whole-brain model), which turn the head that way (jerk: orient) - and a loud one the giant fibre.
const LOUD = { meat: 1, dung: 0.8, honey: 0.35 }, SOUND_S = 0.6;
// What the eyes are on (shown on the page): a sound the brain turned the head to, something coming at
// the eyes, the thing moving most in view (what drives LC11 most) - or straight ahead where the gaze
// meets the floor
const attention = { p: null, why: 'ahead', until: -1, sound: null, food: false };
// the heading (walker yaw) that faces a point from the head
function bearingTo(p) { const h = headFrame(d); return Math.atan2(p[0] - h.pos[0], -(p[1] - h.pos[1])); }
// Smells: each food's odour at each antenna (7 cm either side of the head), stronger the more food and
// the nearer, up to SMELL.hz on the olfactory receptor neurons of its glomeruli (brain-worker.js
// INPUTS od*; the whole-brain model runs away on smell unless a few neurons are silenced - data/tame783.json)
// (meat and dung smell stronger and carry further than a puddle of honey: rotting things give off far
// more, and more volatile, odour - so the brain gets their smell from across the floor)
// Hunger: a hungry fly's olfactory and gustatory receptor neurons answer food more strongly (starvation
// turns their gain up - sNPF and insulin signalling in the fly); here the body is always hungry, and
// its smell and taste reach the brain HUNGER times stronger.
const HUNGER = { smell: 1.8, taste: 1.5 };
const SMELL = { hz: 48, gap: 0.07, contrast: 6, strength: { honey: 1, meat: 2, dung: 2.2 }, reach: { honey: 1.0, meat: 1.5, dung: 1.6 } };
function smelling(r, h) {
  const left = mul(h.R, LEFT_L), conc = {};
  for (const S of ['L', 'R']) {
    const ant = add(h.pos, scale(left, S === 'L' ? SMELL.gap : -SMELL.gap));
    const c = { honey: 0, meat: 0, dung: 0 };
    for (const f of scene.food) {
      if (!f.at || !(f.kind in c)) continue;
      const dist = Math.hypot(f.at.x - ant[0], f.at.y - ant[1], (f.at.top || 0) - ant[2]);
      c[f.kind] += HUNGER.smell * SMELL.strength[f.kind] * Math.max(0, f.amount) / (1 + (dist / SMELL.reach[f.kind]) ** 2);
    }
    conc[S] = c;
  }
  for (const k of ['honey', 'meat', 'dung']) {
    // the side that smells it more gets more of it (a fly's two antennal lobes sharpen the difference
    // between its antennae: the ORNs of each side release more onto their own side's neurons): the
    // few per cent between two antennae 14 cm apart becomes SMELL.contrast times that
    const m = (conc.L[k] + conc.R[k]) / 2, dlt = m > 0 ? (conc.L[k] - conc.R[k]) / (2 * m) : 0;
    for (const [S, sg] of [['L', 1], ['R', -1]]) {
      const v = m * Math.max(0, 1 + sg * Math.max(-1, Math.min(1, SMELL.contrast * dlt)));
      // (receptor neurons answer about the logarithm of concentration: nearer and more still reads as
      // more, however strong - a hard ceiling left both antennae at it, and nearer the same as farther)
      r['od' + k[0].toUpperCase() + k.slice(1) + S] = +Math.min(SMELL.hz, 14 * Math.log(1 + 5 * v)).toFixed(1);
    }
  }
  sensed.smell = Object.keys(r).filter((k) => k.startsWith('od')).reduce((a, k) => a + r[k], 0);
}
const sounds = [];
function hear(p, loud) { if (d) sounds.push({ p, loud, t: d.time }); }
function hearing(r, h) {
  const left = mul(h.R, LEFT_L);
  r.audL = r.audR = 0;
  for (let i = sounds.length - 1; i >= 0; i--) {
    const s = sounds[i], age = d.time - s.t;
    if (age > SOUND_S || age < 0) { sounds.splice(i, 1); continue; }
    const dir = sub(s.p, h.pos), dist = norm(dir) || 1, side = (dir[0] * left[0] + dir[1] * left[1] + dir[2] * left[2]) / dist;
    const amp = s.loud * 160 / (1 + (dist / 0.8) ** 2) * (1 - age / SOUND_S);
    r.audL += amp * (0.55 + 0.45 * side); r.audR += amp * (0.55 - 0.45 * side);
    if (!attention.sound || amp > attention.sound.amp || d.time - attention.sound.t > SOUND_S) attention.sound = { p: s.p, amp, t: d.time };
  }
  r.audL = Math.min(100, r.audL); r.audR = Math.min(100, r.audR);
}
function moveSenses(r) {
  const h = headFrame(d), dt = 0.02;
  if (!motion.pos) { motion.pos = h.pos; motion.R = h.R; }
  const v = scale(sub(h.pos, motion.pos), 1 / dt), P = motion.R, R = h.R;
  // the head's turn since last time, in its own frame: dR = P^T R, small-angle axis * angle
  const dR = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => P[i] * R[j] + P[3 + i] * R[3 + j] + P[6 + i] * R[6 + j]));
  const w = scale([dR[7] - dR[5], dR[2] - dR[6], dR[3] - dR[1]], 0.5 / dt);
  motion.pos = h.pos; motion.R = h.R;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const yaw = Math.abs(dot(w, UP_L)), tilt = Math.hypot(dot(w, FWD_L), dot(w, LEFT_L)), speed = norm(v);
  const side = dot(v, mul(R, LEFT_L));                    // air from the left pushes the right antenna less
  const eye = Math.min(60, 5 * (yaw + tilt) + 50 * speed);
  r.eyeL = r.eyeR = eye;
  const wind = Math.min(50, 50 * speed + 3 * tilt);
  r.windL = Math.max(0, Math.min(50, wind - 40 * side)); r.windR = Math.max(0, Math.min(50, wind + 40 * side));
  r.ocelli = Math.min(50, 8 * tilt);
  hearing(r, h);
  smelling(r, h);
  // small things moving, and things looming, seen from between the eyes
  const at = toWorld(d, add(MOUTH_L, scale(UP_L, 0.08))), fwd = mul(R, FWD_L), left = mul(R, LEFT_L);
  r.smallL = r.smallR = r.loomL = r.loomR = 0;
  const things = ['R', 'L'].map((S) => ({ key: 'hand' + S, p: [0, 1, 2].map((i) => d.xpos[3 * PALM[S].palm + i]), rad: 0.05, own: true }));
  for (const f of scene.food) if (f.slot && f.at) things.push({ key: f.id, p: [f.at.x, f.at.y, fd.xipos[3 * f.slot.b + 2]], rad: f.at.r, own: false, vel: Array.from(fd.qvel.subarray(f.slot.v, f.slot.v + 3)) });
    else if (f.at) things.push({ key: f.id, p: [f.at.x, f.at.y, f.at.top], rad: f.at.r, own: false });   // (honey too: it is seen as it slides past the moving eye)
  const seen = new Map();
  let best = null;
  for (const o of things) {
    const to = sub(o.p, at), dist = Math.max(0.05, norm(to)), dir = scale(to, 1 / dist);
    const theta = 2 * Math.atan(o.rad / dist), before = motion.seen.get(o.key);
    seen.set(o.key, { dir, theta });
    const ahead = dot(dir, fwd);
    if (!before || ahead < -0.3) continue;               // (nothing right behind the head)
    const S = dot(to, left) > 0 ? 'L' : 'R';
    const slide = Math.acos(Math.min(1, dot(dir, before.dir))) / dt;
    // looming is the thing's own coming at the eye (as it would look to a still fly), so walking up
    // to food lying there does not read as an attack: expansion = size * closing speed / distance.
    // Only something flying (faster than 1 m/s) counts: food the person's own face nudges does not.
    const grow = o.vel && norm(o.vel) > 1 ? theta * Math.max(0, -dot(o.vel, dir)) / dist : 0;
    const small = ahead > 0.4 && theta < 0.6 ? 5 * slide * Math.min(1, theta / 0.1) : 0;
    if (small) r['small' + S] += small;   // (small motion: only ahead)
    if (!o.own && grow > 0.5) r['loom' + S] += 60 * grow;
    const pull = !o.own && grow > 0.5 ? 1000 * grow : small * (o.own ? 0.3 : 1);
    if (pull > 3 && (!best || pull > best.pull)) best = { p: o.p, pull, why: !o.own && grow > 0.5 ? 'loom' : 'motion', food: !o.own };
  }
  motion.seen = seen;
  if (best && (d.time >= attention.until || best.why === 'loom' || attention.why === 'motion') && !(attention.food && !best.food && d.time < attention.until + 1)) Object.assign(attention, { p: best.p, why: best.why, until: d.time + 0.5, food: best.food });
  if (d.time >= attention.until) {
    // (nothing in particular: where the gaze, straight out of the face, meets the floor - or 1.5 m ahead)
    const k = fwd[2] < -0.05 ? Math.max(0.6, Math.min(2.5, -at[2] / fwd[2])) : 1.5;   // (never right at the face)
    if (!(attention.food && d.time < attention.until + 1.5)) { attention.p = add(at, scale(fwd, k)); attention.why = 'ahead'; attention.food = false; }
  }
  for (const k of ['smallL', 'smallR']) r[k] = Math.min(20, r[k]);
  for (const k of ['loomL', 'loomR']) r[k] = Math.min(150, r[k]);
  for (const k of ['eyeL', 'eyeR', 'windL', 'windR', 'ocelli', 'smallL', 'smallR', 'loomL', 'loomR', 'audL', 'audR']) r[k] = 2 * Math.round(r[k] / 2);   // (in 2 Hz steps: fewer changes to the brain's input)
  return r;
}

function senses() {
  // the taste of the food on the lips, and more weakly of one under a palm (a fly tastes with its feet too)
  const r = { sugar: 0, water: 0, salt: 0, bitter: 0 };
  const palm = (S) => foodAt([0, 1, 2].map((i) => d.xpos[3 * PALM[S].palm + i]), 0.07, 0.06);   // (a palm against the side of a lump tastes it too)
  const lips = foodAt(toWorld(d, MOUTH_L), 0.12, 0.08), food = lips || palm('R') || palm('L');   // (the mouth reaches a few cm, as a proboscis does)
  if (food) for (const [ch, hz] of Object.entries(FOODS[food.kind].taste)) r[ch] = HUNGER.taste * (lips ? hz : hz * 2 / 3);
  sensed.taste = r.sugar + r.water + r.salt;
  return moveSenses(r);
}

// ------------------------------------------------------------------ motor programs
// The person moves like a fly: on all fours. Posture by what the brain is doing -
//   crawling   hands and knees on the floor, neck raised so the face looks ahead
//   grooming   up on the knees (a fly stands on its other legs), hands rubbing the head
//   feeding    chest lowered and head down to bring the mouth to the food (the proboscis)
//   escaping   a quick turn away from the looming side and a scurry off
// Hands and knees are placed by IK on footholds under the shoulders and hips; while crawling
// they step in diagonal pairs (right hand with left knee), like a trotting quadruped.
let brain = {};
const prog = { feed: 0, groomL: 0, groomR: 0, rub: 0, probe: 0 };
const cmd = { MN9: 0, groomL: 0, groomR: 0 }, meal = { until: -1, on: false };
const escape = { t: -9, away: 1 };
const ESCAPE_S = 0.9;
// Crawling in bouts. The brain model's walking neurons stay silent without input, so, as for
// the fly body in /test03/, the body itself sets off and stops; the brain steers: DNa02
// left/right turns it, MDN backs it up, DNp09 drives it forward. Feeding, grooming and
// escaping stop it. Food on the floor draws it (the body's doing: the brain here has no smell wired
// in): it heads for the nearest and stops with its face over it.
const walker = { x: 0, y: 0, yaw: 0, speed: 0, phase: 0, on: false, until: 1.5, turn: 0, amp: 0 };
const CRAWL = { pitch: 1.5, nod: 1.45, lumbar: -0.1 };   // pelvis carried at this pitch, spine a touch flexed (it settles a little extended), face lifted by the neck
const FEED = { pitch: 0.7, lumbar: -0.15, nod: -0.2 };     // how far feeding tips the chest and face down from the crawl: chin forward, so the lips come lowest, ~4 cm off the floor
// How the body walks and feeds - the part a strategy ({type:'strategy'}) changes, and what the fly's
// mushroom body learns to choose between (../school/). These defaults are level 1's.
//   near    the centre of mass must be this close to its place over the other three before a limb lifts (m)
//   shrink  that place is inside the other three's triangle shrunk to this much about its middle
//   maxs    the body is asked to shift at most this far at a time (m)
//   swing   a step takes this long (s), lifting the limb this high (m) and putting it this far ahead (m)
//   speed   crawling speed asked of the walker (m/s), turn its fastest turn (rad/s)
//   reach   the lips end up this far ahead of the pelvis when the face is down (m): where to stop at food
//   dip     how fast the face may go down (per 10 ms)
//   pattern the stepping order (PATTERNS): 0 down one side then the other, 1 crossing over, 2 diagonal pairs
const GAIT = { near: 0.03, shrink: 0.8, maxs: 0.05, swing: 0.3, lift: 0.05, stride: 0.15, speed: 0.28, turn: 0.4, reach: 0.52, dip: 0.015, pattern: 2 };   // (pattern 2, a hand with the opposite knee: in the first trials it crawled furthest)
// The body's basic control - what the server's search tunes ({type:'control'}; ../school/tune.mjs):
//   unload     a limb about to be lifted hands its load to the others over this long first (s)
//   ahead      balance answers where the body will be this far ahead at its present speed (s)
//   reg        how much the floor's pushes are kept small and spread over the supports
//   mu         how hard a support may push sideways, for how hard it pushes down
//   stiffness  joint stiffness, times its built-in value
//   reserve    joint torque the big joints may add beyond their muscles (N m)
//   rise       getting up after a fall: seconds to lift the body from where it lies to all fours
//   upBoost    balance gains while getting up, times their usual value
//   upMax      seconds of trying to get up before the body is put back on all fours
//   kneelIn    rubbing the hands: they come off the floor only once the centre of mass is inside the
//              knees' and shins' support shrunk to this much about its middle, and has stayed there
//              with the trunk up and still for kneelHold seconds; not managed in kneelWait, it gives up
const CONTROL = { unload: 0.25, ahead: 0.08, reg: 0.02, mu: 0.8, stiffness: 1, reserve: 60, rise: 2.5, upBoost: 1.5, upMax: 10, kneelIn: 0.6, kneelHold: 0.3, kneelWait: 2.5 };
// which of the body's own habits are on (rubbing the hands is off for now: kneeling up on nothing but its
// knees still upset the arms and the balance - 2026-09-14)
const HABITS = { rub: false };
// レベル1 (the fly before any learning, page level 1): the body as it was before it was taught how
// to put its hands down - kept as it was saved in levels/1/: hands close in under the shoulders, the
// palm only asked to lie level (so it as often lands turned over, palm up, the arm twisted), no
// elbow pointed back, no fingers spread to bear weight. It seldom holds itself up for long.
// ...and nothing yet of what came after: weight not handed over before a limb lifts, no looking ahead
// against a fall, footholds taken as planned rather than where the limbs are, one limb at a time
const NAIVE = { on: false, STANCE: { hands: 0.08, knees: 0.12, handsAhead: 0.02 }, GAIT: { pattern: 0 } };
const UP = {};
// coming round to food behind (a strategy's TURN, chosen by the fly when food lands behind): mode
// 'pivot' turns on the spot, 'reverse' backs up at `speed` while turning, 'arc' creeps forward while
// turning - at `rate` rad/s - until the food is within `ahead` rad of straight ahead. Without one,
// the body just turns as it walks.
// While coming round, each limb's place is turned `step` rad further about the centre of mass (planSteps),
// and the limb furthest from its place steps next, its weight moved off it first
const TURN = { mode: null, speed: 0.1, rate: 0.3, behind: 1.9, ahead: 1.0, step: 0.3 };
const TEST = {};                                            // switches for the test scripts ({type:'test'})
let headLift = 0, headLowKin = 1, dip = 0;
const pose = { pitch: 1.4, lumbar: 0, nod: 1.35, knee: 1.75, ankle: -0.6, z: 0.44, kneel: 0, roll: 0 };
// Bending the elbows, from the fly's brain: the chest is let down toward the floor, the arms bending
// under it, as much as the brain asks - both elbows together lower the chest (up to `pitch` more
// tilt), one more than the other drops that shoulder (up to `roll`). The descending neurons that
// answer the body's own tilting and swaying in this model (DNp28, driven by the ocelli and the
// antennae when the head tips, and DNb06, by air on one antenna as the head moves; measured on the
// whole-brain model, a rough choice and not a known function) are read as the command for each side:
// the body sways, and the fly crouches on its arms. It comes quickly and goes slowly.
const ELBOWS = { pitch: 0.2, roll: 0.08, full: 30, rise: 0.08, fall: 0.02, adapt: 0.003 };
const flex = { L: 0, R: 0, baseL: null, baseR: null };
// The dopamine that teaches the fly's synapses onto its motor neurons (see reflex.mjs): each WINDOW,
// how active each group was against how things went in the window after it - the elbows against how
// steady the trunk was, steering and walking against how much stronger the food smelt (and whether it
// got a taste).
const MOTOR = ['elbowL', 'elbowR', 'steerL', 'steerR', 'goL', 'goR'];
const reflex = { t0: -1, n: 0, act: null, spin: 0, fell: false, prev: null, usual: {}, steady: null, gain: null, smell0: null };
const sensed = { smell: 0, taste: 0 };
function motorLearn(kneel) {
  const t = d.time;
  // (only on its own: not kneeling, getting up, starting or replaying)
  if (kneel > 0.2 || fallen.up || t < spawn.until || replay.on) { reflex.t0 = -1; reflex.prev = null; return; }
  if (reflex.t0 < 0) Object.assign(reflex, { t0: t, n: 0, act: Object.fromEntries(MOTOR.map((k) => [k, 0])), spin: 0, fell: false, taste: 0, smell0: sensed.smell });
  reflex.act.elbowL += flex.L; reflex.act.elbowR += flex.R;
  reflex.act.steerL += brain.DNa02L || 0; reflex.act.steerR += brain.DNa02R || 0;
  reflex.act.goL += brain.goL || 0; reflex.act.goR += brain.goR || 0;
  reflex.spin += Math.hypot(d.qvel[3], d.qvel[4], d.qvel[5]);
  reflex.fell = reflex.fell || fallen.since >= 0;
  reflex.taste = Math.max(reflex.taste, sensed.taste);
  reflex.n++;
  if (t - reflex.t0 < REFLEX.WINDOW) return;
  const act = Object.fromEntries(MOTOR.map((k) => [k, reflex.act[k] / reflex.n]));
  const cur = { act, steady: -reflex.spin / reflex.n - (reflex.fell ? 3 : 0), gain: sensed.smell - reflex.smell0 + (reflex.taste > 0 ? 5 : 0) };
  const prev = reflex.prev;
  if (prev) {
    reflex.steady = reflex.steady == null ? cur.steady : reflex.steady + (cur.steady - reflex.steady) * 0.05;
    reflex.gain = reflex.gain == null ? cur.gain : reflex.gain + (cur.gain - reflex.gain) * 0.05;
    const levels = MOTOR.map((k) => {
      const more = prev.act[k] - reflex.usual[k];
      const went = k.startsWith('elbow') ? REFLEX.GAIN * (cur.steady - reflex.steady) : REFLEX.SMELL_GAIN * (cur.gain - reflex.gain);
      return +Math.max(-REFLEX.maxDopa, Math.min(REFLEX.maxDopa, -went * more)).toFixed(4);
    });
    if (!TEST.noreflex) post({ type: 'dopa', levels });
  }
  for (const k of MOTOR) reflex.usual[k] = reflex.usual[k] == null ? act[k] : reflex.usual[k] + (act[k] - reflex.usual[k]) * 0.05;
  reflex.prev = cur; Object.assign(reflex, { t0: t, n: 0, act: Object.fromEntries(MOTOR.map((k) => [k, 0])), spin: 0, fell: false, taste: 0, smell0: sensed.smell });
}

const LIMBS = ['RH', 'LH', 'RK', 'LK'];
const RUB = { hz: 1.6, gap: -0.015, stroke: 0.05, proSup: 0 };
// how far out from under the shoulders and hips the hands and knees go: on all fours people crawl
// with the knees apart, not with the thighs pressed together
// (wide by default: arms and legs spread well apart make a broad base to stand on - the knowledge the body
// starts with; the search and the learning can move away from it)
const STANCE = { hands: 0.22, knees: 0.2, handsAhead: 0.1 };   // handsAhead: how far in front of the shoulders the hands go down (m): the wrist bends back only 45 degrees in this model, so under the shoulders the palm could not lie flat and the heel of the hand stood 3-5 cm up
// (floor: the crawl's own settled arm - elbow back, wrist bent up, forearm pronated - so the
// start solves into it rather than the twisted, elbow-forward branch)
// A hand bearing weight is an open hand - fingers straight and spread, the thumb out - so the palm and
// all five fingers press on the floor (values per finger joint; the abduction signs were measured:
// + spreads the index finger from the middle one, - the ring and little fingers)
const OPEN_HAND = { mp_flexion: 0.45, ip_flexion: 0, mcp2_abduction: 0.22, mcp3_abduction: 0, mcp4_abduction: -0.18, mcp5_abduction: -0.24,
  mcp2_flexion: 0.02, pm2_flexion: 0.02, md2_flexion: 0.02, mcp3_flexion: 0.02, pm3_flexion: 0.02, mcp4_flexion: 0.02, md4_flexion: 0.02, mcp5_flexion: 0.02, pm5_flexion: 0.02, md5_flexion: 0.02 };
const SEED = { floor: [1.33, 1.05, -0.05, 1.05, -0.79, 1.52], head: [1.3, 1.0, 0, 1.8, 0, 0], air: [1.3, 1.6, 0, 0.4, 0, 0] };   // (floor: forearm turned palm down, wrist bent back)
const limb = {};                      // per limb: joint values, what it is doing, its target
let lastSide = 'L';

function behave() {
  const t = d.time, a = 0.08;
  // the brain's feeding and grooming commands, as rates over the last ~150 ms: counted in 20 ms bins
  // they come in bursts with empty bins between, and each empty bin used to drop the program
  for (const k of ['MN9', 'groomL', 'groomR']) cmd[k] += ((brain[k] || 0) - cmd[k]) * (CTRL / 0.15);
  const MN9 = cmd.MN9, gL = cmd.groomL, gR = cmd.groomR;
  // getting up: the palms go down flat first and the body rises on them - it rises at full speed only
  // while both palms are down on the floor and facing it (a quarter as fast otherwise, so a hand still
  // in the air or turned over does not leave it pushing up on nothing)
  if (fallen.up) {
    const planted = ['R', 'L'].every((S) => d.xpos[3 * PALM[S].palm + 2] < 0.05 && palmDown(S, d) > 0.5);
    fallen.up.planted = planted;
    fallen.up.prog += CTRL * (planted ? 1 : 0.25);
  }
  prog.feed += ((MN9 > 10 ? Math.min(1, MN9 / 30) : 0) - prog.feed) * a;
  prog.groomL += ((gL > 40 ? 1 : 0) - prog.groomL) * a;
  prog.groomR += ((gR > 40 ? 1 : 0) - prog.groomR) * a;
  // a meal: from the brain's first feeding command until it has been silent for a second, or the
  // food has gone from the mouth. The body's own habits (rubbing, patting, looking about, setting
  // off) do not start during a meal - they must not break into what the brain is doing.
  const atMouth = foodUnder(toWorld(d, MOUTH_L), 0.08);
  if (prog.feed > 0.3 && atMouth) meal.until = t + 1;
  meal.on = t < meal.until && !!atMouth;
  // Nothing carries the body, so the walker follows it: the posture is planned around where the
  // pelvis really is, and the walker's heading may lead the body's by at most 0.35 rad (the hands
  // and knees placed along it turn the body round)
  {
    // (the heading from between the hips to between the shoulders, level: it stays sensible however
    // the pelvis is tilted)
    const q = d.qpos, X = (b, i) => d.xpos[3 * b + i];
    const hx = (X(SHOULDER.r, 0) + X(SHOULDER.l, 0) - X(HIP.r, 0) - X(HIP.l, 0)) / 2, hy = (X(SHOULDER.r, 1) + X(SHOULDER.l, 1) - X(HIP.r, 1) - X(HIP.l, 1)) / 2;
    const heading = Math.hypot(hx, hy) > 0.05 ? Math.atan2(hx, -hy) : walker.yaw;
    walker.x = q[0] - qRest[0]; walker.y = q[1] - qRest[1];
    let dy = walker.yaw - heading; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
    walker.yaw = heading + Math.max(-0.2, Math.min(0.2, dy));
  }
  const GF = Math.max(brain.GFL || 0, brain.GFR || 0);
  if (GF > 30 && t - escape.t > 1.6) { escape.t = t; escape.away = lastSide === 'L' ? -1 : 1; }
  const te = t - escape.t, escaping = te >= 0 && te < ESCAPE_S;
  habits(t, escaping);
  prog.rub += ((habit.rub ? 1 : 0) - prog.rub) * 0.12;
  prog.probe += ((habit.probe ? 1 : 0) - prog.probe) * 0.2;
  walk(t, escaping);

  // posture: crawl, blended toward kneeling (grooming) and toward head-down (feeding)
  const kneel = Math.max(prog.groomL, prog.groomR, prog.rub);
  // the face goes down over 0.7 s at most: a faster dip overshot the posture and hit the floor
  dip += Math.max(-0.08, Math.min(GAIT.dip, Math.max(prog.feed, (walker.there || meal.on ? 1 : 0.85) * prog.probe) * (1 - kneel) - dip));
  const feed = dip;
  pose.kneel = kneel;
  pose.pitch = CRAWL.pitch + FEED.pitch * feed - (CRAWL.pitch - 0.15) * kneel;
  for (const S of ['L', 'R']) {
    // (what counts is the command above its own slow average: a steady drive - these DNs fire all the
    // while it crawls - would keep the chest low and the crawl slow; a sudden sway or tilt bends the arms)
    const drive = 0.7 * (brain['tilt' + S] || 0) + 0.3 * (brain['sway' + S] || 0);
    if (flex['base' + S] == null) flex['base' + S] = drive;                       // (from where it starts, not from nothing)
    flex['base' + S] += (drive - flex['base' + S]) * ELBOWS.adapt;
    const want = TEST.noflex ? 0 : Math.max(0, Math.min(1, (drive - flex['base' + S]) / ELBOWS.full));
    flex[S] += (want - flex[S]) * (want > flex[S] ? ELBOWS.rise : ELBOWS.fall);
  }
  motorLearn(kneel);
  pose.pitch += ELBOWS.pitch * (flex.L + flex.R) / 2 * (1 - kneel);
  pose.roll = ELBOWS.roll * (flex.L - flex.R) * (1 - kneel);            // (+: the left shoulder lower)
  pose.lumbar = CRAWL.lumbar * (1 - kneel) + FEED.lumbar * feed;
  // the face never goes into the floor (or the food). The lowest point of the head's skin is watched
  // both in the body and in the posture it is being asked for, so a quick dip is caught before it
  // lands: within 1.5 cm, the chest and neck lift the face; once 3 cm clear they let it down again.
  // (The chest does most of the lifting: the pelvis is carried, so its tilt is sure to follow, while
  // the neck alone could not always raise the head. The head's collision shapes still meet the floor,
  // as a last stop.)
  const under = foodUnder(toWorld(d, MOUTH_L), 0), ground = under ? foodTop(under) : 0;      // (on meat or dung, its top is the floor)
  const low = Math.min(headLowest(d), headLowKin + 0.02) - ground;     // (the body settles a little above its target)
  if (low < 0.015) headLift += Math.min(0.03, (0.015 - low) * 4);
  else if (low > 0.03) headLift -= Math.min(0.01, (low - 0.03) * 4);
  headLift = Math.max(0, Math.min(1, headLift));
  pose.pitch -= 0.5 * headLift;
  pose.nod = CRAWL.nod + FEED.nod * feed - (CRAWL.nod - 0.1) * kneel + 0.25 * prog.rub + 0.4 * headLift;
  // up on the knees the body sits back on its heels (knees bent right up, knees placed out ahead of
  // the hips): kneeling up tall on nothing but the knees it toppled
  pose.knee = 1.75 + 0.55 * kneel; pose.ankle = -0.6 - 0.25 * kneel;

  qRef.set(qRest);
  const cy = Math.cos(walker.yaw / 2), sy = Math.sin(walker.yaw / 2), cp = Math.cos(pose.pitch / 2), sp = Math.sin(pose.pitch / 2);
  // the body's middle over its supports: the root is asked to move by as much as the centre of mass
  // is off where the stepping plan wants it (the limbs on the floor push it there)
  const steps = planSteps(t, kneel);
  // (never more than 5 cm at a time: pushed hard toward a far target, the body rolled over past its supports)
  const DX = steps.target[0] - d.subtree_com[0], DY = steps.target[1] - d.subtree_com[1], DN = Math.hypot(DX, DY), MAXS = GAIT.maxs, ks = DN > MAXS ? MAXS / DN : 1;
  qRef[0] = d.qpos[0] + DX * ks; qRef[1] = d.qpos[1] + DY * ks;
  qRef[2] = pose.z;
  // turn about the vertical, roll about the heading, then pitch forward
  const cr = Math.cos(pose.roll / 2), sr = Math.sin(pose.roll / 2);
  qRef[3] = cy * cr * cp + sy * sr * sp; qRef[4] = cy * cr * sp - sy * sr * cp; qRef[5] = cy * sr * cp + cr * sy * sp; qRef[6] = cr * sy * cp - cy * sr * sp;
  qRef[qadr(TRUNK[0])] = pose.lumbar;
  qRef[qadr(NECK[0])] = pose.nod;
  for (const s of 'rl') { qRef[qadr(LEGJ[s].knee)] = pose.knee; qRef[qadr(LEGJ[s].ankle)] = pose.ankle; }
  applyLimbs();

  // where the shoulders and hips are in this posture, and the goals for hands and knees
  kin.qpos.set(qRef); couple(kin.qpos);
  mj.mj_kinematics(m, kin);
  headLowKin = headLowest(kin);
  const f = [Math.sin(walker.yaw), -Math.cos(walker.yaw), 0], l = [Math.cos(walker.yaw), Math.sin(walker.yaw), 0];
  const h = headFrame(d);                            // hands go where the real head is
  // the hands come off the floor only once the trunk is up (pelvis to head within ~40 degrees of
  // vertical): lifted earlier, with the weight still forward, the body fell on its face
  const pel = [d.xpos[3 * PELVIS], d.xpos[3 * PELVIS + 1], d.xpos[3 * PELVIS + 2]], tor = [d.xpos[3 * TORSO], d.xpos[3 * TORSO + 1], d.xpos[3 * TORSO + 2]];
  // the hands come off the floor only when the body could stay up without them: the trunk up, the
  // centre of mass well inside the support of the knees and shins, and both held for a moment
  const up = (tor[2] - pel[2]) / (norm(sub(tor, pel)) || 1) > 0.8;
  const legPts = [TIBIA.r, TIBIA.l, TALUS.l, TALUS.r].map((b) => [d.xpos[3 * b], d.xpos[3 * b + 1]]);
  const lc = [legPts.reduce((a, q) => a + q[0], 0) / 4, legPts.reduce((a, q) => a + q[1], 0) / 4], shrunk = legPts.map((q) => [lc[0] + CONTROL.kneelIn * (q[0] - lc[0]), lc[1] + CONTROL.kneelIn * (q[1] - lc[1])]);
  const com2 = [d.subtree_com[0], d.subtree_com[1]], inTri = (tri) => { const c2 = closestInTriangle(com2, tri); return c2[0] === com2[0] && c2[1] === com2[1]; };
  const overLegs = inTri([shrunk[0], shrunk[1], shrunk[2]]) || inTri([shrunk[0], shrunk[2], shrunk[3]]);
  const spinning = Math.hypot(d.qvel[3], d.qvel[4], d.qvel[5]) > 0.6;
  habit.balancedSince = up && overLegs && !spinning ? habit.balancedSince ?? t : null;
  if (habit.balancedSince != null && t - habit.balancedSince > CONTROL.kneelHold) habit.freed = true;
  if (!habit.rub && !prog.groomL && !prog.groomR) habit.freed = false;
  const handsFree = habit.freed && up;
  for (const L of LIMBS) {
    const side = L[0] === 'R' ? 'r' : 'l', sgn = side === 'l' ? 1 : -1, hand = L[1] === 'H';
    const lm = limb[L];
    let mode = 'floor', goal, palm = null, lift = 0;
    if (hand) {
      const sh = [d.xpos[3 * SHOULDER[side]], d.xpos[3 * SHOULDER[side] + 1], 0];
      const g = prog['groom' + L[0]];
      if (prog.rub > 0.3 && g <= 0.3 && !escaping && handsFree) {
        // a fly rubbing its front legs together: the hands meet at the midline in front of the chest,
        // palms together, and slide past each other - one forward while the other goes back -
        // about twice a second, slow enough for the arms to follow
        mode = 'head';
        const c = add(add(h.pos, scale(f, 0.30)), [0, 0, -0.2]);
        const rubPh = Math.sin(2 * Math.PI * RUB.hz * t), sgnL = L[0] === 'L' ? 1 : -1;
        goal = add(add(c, scale(l, sgnL * RUB.gap)), add(scale(f, RUB.stroke * rubPh * sgnL), [0, 0, 0.015 * rubPh * sgnL]));
      } else if (g > 0.3 && !escaping && handsFree) {
        mode = 'head';
        const ph = ((t * 1.6 + (L[0] === 'R' ? 0 : 0.5)) % 1);
        // stroke, pause, return, pause (in the smooth mode the pauses still read as a rub)
        const stroke = ph < 0.4 ? ph / 0.4 : ph < 0.55 ? 1 : ph < 0.85 ? 1 - (ph - 0.55) / 0.3 : 0, lift = ph >= 0.55 && ph < 0.85 ? 0.03 : 0;
        goal = add(h.pos, mul(h.R, add(SCALP_L[L[0]], [0, 0.05 - 0.1 * stroke, 0.02 + lift])));
      } else {
        const ft = steps.feet[L];
        lift = ft.lift;
        // the palm flat on the floor, fingers pointing ahead: the middle of the palm, the fingertip, both
        // knuckles and the wrist all at their height over the floor when the hand lies flat (with the
        // wrist left out the hand stood on its fingers, its heel 3-4 cm up)
        goal = [ft.xy[0], ft.xy[1], 0.017 + lift];
        palm = { tip: add(goal, add(scale(f, 0.1), [0, 0, -0.006])), knuckleZ: 0.012 + lift, wristZ: 0.026 + lift };
        if (NAIVE.on) { goal = [ft.xy[0], ft.xy[1], 0.03 + lift]; palm = { tip: add(goal, add(scale(f, 0.1), [0, 0, -0.012])), knuckleZ: goal[2] - 0.008, wristZ: 0 }; }
      }
    } else {
      const hip = [d.xpos[3 * HIP[side]], d.xpos[3 * HIP[side] + 1], 0];
      const ft = steps.feet[L];
      lift = ft.lift;
      goal = [ft.xy[0], ft.xy[1], 0.07 + lift];
    }
    // reaching up (head, air) starts from a seed; coming back down to the floor carries on from where the arm is
    if (hand && lm.mode !== mode) { if (mode !== 'floor') lm.q = SEED[mode].slice(); lm.mode = mode; }
    // The IK works on the target posture, but the real trunk and neck sit a little off it, so a
    // hand solved onto the head in the model landed 25 cm away in the world. Shift the goal by how
    // far the limb's base (shoulder or hip) really is from where the model has it.
    const base = hand ? SHOULDER[side] : HIP[side];
    // (Leaving out the shift the stepping plan asks of the body, so a limb on the floor is solved as
    // though the body had already got there, and pushes it along.)
    const shift = [qRef[0] - d.qpos[0], qRef[1] - d.qpos[1], 0];
    // (getting up, the real shoulders can be far from the posture's: the shift may be larger, so the palms still reach the floor)
    const reach = fallen.up ? 0.7 : 0.3;
    const off = [0, 1, 2].map((i) => Math.max(-reach, Math.min(reach, d.xpos[3 * base + i] - kin.xpos[3 * base + i] + shift[i])));
    lm.goal = sub(goal, off);
    lm.palm = palm && mode === 'floor' ? { tip: sub(palm.tip, off), knuckleZ: palm.knuckleZ - off[2], wristZ: palm.wristZ - off[2] } : null;
    lm.lift = lift;
  }
}

// Stepping, as a slow quadruped walks: one limb at a time, and only once the body's centre of mass
// is well inside the triangle of the other three (after 1.5 s of trying, that step is left out). With nothing holding the
// body up, lifting a limb any other way let it topple toward the gap. A limb on the floor stays
// where it was put. While crawling, each step puts the limb 15 cm ahead of its place under the
// shoulder or hip, in the order left knee, left hand, right knee, right hand; standing, a limb is
// stepped back to its place when it has been left more than 10 cm off it (the habits move those
// places: patting ahead, setting a knee down elsewhere). Kneeling, the hands are off the floor and
// the body is kept over the knees and shins.
// the order limbs are stepped in (GAIT.pattern): one at a time down one side then the other, one at a
// time crossing over (hand, then the opposite knee), or a hand and the opposite knee together - the
// way a baby crawls
const PATTERNS = [[['LK'], ['LH'], ['RK'], ['RH']], [['LH'], ['RK'], ['RH'], ['LK']], [['LH', 'RK'], ['RH', 'LK']]];
const gait = { next: 0, limb: null, limbs: [], phase: '', t0: 0, from: null };
const plant = {};
const homeNow = {};                                          // (each limb's place in the latest stepping plan)
function planSteps(t, kneel) {
  const f = [Math.sin(walker.yaw), -Math.cos(walker.yaw)], l = [Math.cos(walker.yaw), Math.sin(walker.yaw)];
  const crawling = (Math.abs(walker.speed) > 0.05 || !!walker.turning) && burst.go;   // (turning round, it steps as it crawls)
  const home = homeNow;
  for (const L of LIMBS) {
    const s = L[0] === 'R' ? 'r' : 'l', sgn = s === 'l' ? 1 : -1, hand = L[1] === 'H', sh = shuffleOf(L, t);
    const base = hand ? SHOULDER[s] : HIP[s];
    const ahead = (hand ? STANCE.handsAhead : -0.02 * (1 - kneel) + 0.28 * kneel) + sh.df + (crawling ? GAIT.stride * Math.sign(walker.speed) : 0);
    const side = (hand ? sgn * STANCE.hands : sgn * STANCE.knees * (1 - 0.5 * kneel)) + sh.dl;
    home[L] = [d.xpos[3 * base] + f[0] * ahead + l[0] * side, d.xpos[3 * base + 1] + f[1] * ahead + l[1] * side];
    // a hand is not put down on a lump of food, nor where it would shove one along: it goes down beside it
    if (hand) for (const fo of scene.food) {
      if (!fo.slot || !fo.at || fo.at.air) continue;
      const dx = home[L][0] - fo.at.x, dyy = home[L][1] - fo.at.y, gap = fo.at.r + 0.12, dd = Math.hypot(dx, dyy);
      if (dd >= gap) continue;
      const out = dx * l[0] + dyy * l[1], sg = Math.abs(out) > 0.01 ? Math.sign(out) : sgn;   // (to its own side of the lump)
      home[L] = [home[L][0] + l[0] * sg * (gap - dd), home[L][1] + l[1] * sg * (gap - dd)];
    }
    if (!plant[L]) plant[L] = home[L];
  }
  // coming round: every place turned a step further about the centre of mass - the hands go down to one
  // side and the knees to the other, which is what turns the body (places kept under the shoulders and
  // hips only moved as the body did, and it hardly turned at all)
  if (walker.turning) {
    const cx = d.subtree_com[0], cy = d.subtree_com[1], a = walker.turning * TURN.step, ca = Math.cos(a), sa = Math.sin(a);
    // (+ turn is to the left: the heading (sin yaw, -cos yaw) goes anticlockwise in the floor's x-y seen from above)
    for (const L of LIMBS) { const x = home[L][0] - cx, y = home[L][1] - cy; home[L] = [cx + ca * x - sa * y, cy + sa * x + ca * y]; }
  }
  const onFloor = (L) => L[1] === 'K' || limb[L].mode === 'floor';
  for (const L of LIMBS) if (!onFloor(L)) plant[L] = home[L];               // (a hand in the air comes down at its place)
  // a limb down on the floor is where it really is, not where it was meant to go: measured, the hands
  // stood 14-22 cm and the knees 10 cm from their planned places, and a weight shift planned over the
  // planned places put the body over no support at all
  if (!TEST.plannedSupport && !NAIVE.on) for (const L of LIMBS) {
    if (!onFloor(L) || (gait.limb && gait.limbs.includes(L) && gait.phase === 'swing')) continue;
    const b = L[1] === 'H' ? PALM[L[0]].palm : TIBIA[L[0].toLowerCase()];
    if (d.xpos[3 * b + 2] < (L[1] === 'H' ? 0.06 : 0.12)) plant[L] = [d.xpos[3 * b], d.xpos[3 * b + 1]];
  }
  const mid = (Ls) => { const pts = Ls.map((L) => plant[L]); return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]; };
  const com = [d.subtree_com[0], d.subtree_com[1]];
  const feet = Object.fromEntries(LIMBS.map((L) => [L, { xy: plant[L], lift: 0 }]));
  if (kneel > 0.3) {
    // up on the knees: over the knees and shins, no steps
    gait.limb = null;
    const knees = mid(['LK', 'RK']), ankles = ['r', 'l'].map((s) => { const b = TALUS[s]; return [d.xpos[3 * b], d.xpos[3 * b + 1]]; });
    return { target: [(2 * knees[0] + ankles[0][0] + ankles[1][0]) / 4, (2 * knees[1] + ankles[0][1] + ankles[1][1]) / 4], feet };
  }
  if (!gait.limb) {
    let Ls = null;
    if (walker.turning) {
      // coming round: one limb at a time, whichever is furthest from its place as the body turns (in a
      // fixed order an arm could be skipped turn after turn and left behind, twisting the body over it)
      let far = 0.03;
      for (const K of LIMBS) { const dd = Math.hypot(plant[K][0] - home[K][0], plant[K][1] - home[K][1]) * (K[1] === 'H' ? 1.3 : 1); if (onFloor(K) && dd > far) { far = dd; Ls = [K]; } }
    } else if (crawling) { const pat = PATTERNS[Math.max(0, Math.min(PATTERNS.length - 1, Math.round(GAIT.pattern)))]; Ls = pat[gait.next % pat.length]; gait.next++; }
    else {
      let far = 0.1;
      for (const K of LIMBS) { const dd = Math.hypot(plant[K][0] - home[K][0], plant[K][1] - home[K][1]); if (onFloor(K) && dd > far) { far = dd; Ls = [K]; } }
    }
    if (Ls && Ls.every(onFloor)) Object.assign(gait, { limb: Ls.join('+'), limbs: Ls, phase: 'shift', t0: t });
  }
  if (!gait.limb) return { target: crawling ? [com[0] + f[0] * 0.1 * Math.sign(walker.speed), com[1] + f[1] * 0.1 * Math.sign(walker.speed)] : mid(LIMBS.filter(onFloor)), feet };
  const Ls = gait.limbs, others = LIMBS.filter((K) => !Ls.includes(K) && onFloor(K));
  // the nearest point to the centre of mass inside the support of the others - the triangle of three,
  // or for a diagonal pair the line between the other two - shrunk about its middle (a margin): the
  // body only moves as far as it must. (While crawling it leans on ahead: it aims 10 cm in front.)
  let rest = mid(others);
  const aim = crawling ? [com[0] + f[0] * 0.1 * Math.sign(walker.speed), com[1] + f[1] * 0.1 * Math.sign(walker.speed)] : com;
  const shrunk = others.map((K) => [rest[0] + GAIT.shrink * (plant[K][0] - rest[0]), rest[1] + GAIT.shrink * (plant[K][1] - rest[1])]);
  if (others.length === 3) rest = closestInTriangle(aim, shrunk);
  else if (others.length === 2) rest = closestInTriangle(aim, [shrunk[0], shrunk[1], shrunk[1]]);
  if (gait.phase === 'shift') {
    if (Math.hypot(com[0] - rest[0], com[1] - rest[1]) < GAIT.near) Object.assign(gait, { phase: 'swing', t0: t, from: Object.fromEntries(Ls.map((K) => [K, plant[K]])) });
    else if (walker.turning && t - gait.t0 > 1.0) Object.assign(gait, { phase: 'swing', t0: t, from: Object.fromEntries(Ls.map((K) => [K, plant[K]])), low: true });   // (turning, the limb goes anyway - low and quick - rather than be left behind)
    else if (t - gait.t0 > 1.5) { gait.limb = null; return { target: mid(LIMBS.filter(onFloor)), feet }; }   // (could not get over the others: leave this one)
  }
  if (gait.phase === 'swing') {
    const u = Math.min(1, (t - gait.t0) / GAIT.swing), e = u * u * (3 - 2 * u);
    for (const K of Ls) {
      const from = gait.from[K], to = home[K];
      feet[K] = { xy: [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e], lift: GAIT.lift * (gait.low ? 0.5 : 1) * Math.sin(Math.PI * u) };
      if (u >= 1) plant[K] = to;
    }
    if (u >= 1) { gait.limb = null; gait.limbs = []; gait.low = false; }
  }
  return { target: rest, feet };
}

function closestInTriangle(p, [a, b, c]) {
  const cross = (o, u, v) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  const s1 = cross(a, b, p), s2 = cross(b, c, p), s3 = cross(c, a, p);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return p;
  const onSeg = (u, v) => {
    const dx = v[0] - u[0], dy = v[1] - u[1], k = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (dx * dx + dy * dy || 1)));
    return [u[0] + k * dx, u[1] + k * dy];
  };
  return [onSeg(a, b), onSeg(b, c), onSeg(c, a)].reduce((best, q) => (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1]) ? q : best));
}

// Who does what in walking. The brain decides: whether to go at all and how fast (the odour-driven
// descending neurons DNa03, DNa13, DNa15, DNa16 and DNp09 - goL/goR), backing up (MDN), stopping to eat
// (MN9, feeding), escaping (the giant fibre), turning the head to a sound. The body - standing in for
// the fly's ventral nerve cord, which this brain model does not have - carries it out: while the brain
// is driving it forward it heads for the food that smells strongest, stops with its face over it and
// puts its mouth down to it; the taste then reaches the brain, which feeds or not. DNa02's left and
// right still add their turn. (Steering by the brain alone was tried: this model has no circuit that
// compares the two antennae, its DNa02 answer smells lopsidedly, and the body went round and past food.)
// Nothing keeps it off the edge of the floor, and nothing sets it off when the brain is quiet.
const WALK = { goMin: 0.3, goFull: 3, turnPerHz: 0.03, smooth: 0.2, adapt: 0.002, follow: 1.5, seek: 2.5 };
const steer = { goL: 0, goR: 0, DNa02L: 0, DNa02R: 0, MDN: 0, DNp09: 0, baseL: null, baseR: null };
// the food the body heads for: the one that smells strongest at the head (as smelling works it out)
function strongestFood() {
  const h = headFrame(d);
  let best = null, bs = 0;
  for (const f of scene.food) {
    if (!f.at || f.at.air || !(f.kind in SMELL.strength)) continue;
    const dist = Math.hypot(f.at.x - h.pos[0], f.at.y - h.pos[1]);
    const v = SMELL.strength[f.kind] * Math.max(0, f.amount) / (1 + (dist / SMELL.reach[f.kind]) ** 2);
    if (v > bs) { bs = v; best = f; }
  }
  return best;
}
function walk(t, escaping) {
  const busy = prog.feed > 0.3 || meal.on || prog.groomL > 0.3 || prog.groomR > 0.3 || prog.rub > 0.2 || habit.rub || !!fallen.up || d.time < spawn.until;
  for (const k of ['goL', 'goR', 'DNa02L', 'DNa02R', 'MDN', 'DNp09']) steer[k] += ((brain[k] || 0) - steer[k]) * (CTRL / WALK.smooth);
  const go = Math.max(steer.goL, steer.goR, steer.DNp09);
  // (the brain's drive counts for 1.5 s after it last came: its bursts have gaps, and coming round to
  // food behind stopped and started with every one)
  if (go > WALK.goMin) walker.drivenAt = t;
  const driven = walker.drivenAt != null && t - walker.drivenAt < 1.5;
  // heading for the food and stopping over it (only while the brain drives it forward, or once there)
  const food = driven || walker.there ? strongestFood() : null;
  let seek = 0, there = false;
  if (food) {
    // bear on it from the pelvis, and stop where the lips will be over its middle once the head is down
    const px = d.xpos[3 * PELVIS], py = d.xpos[3 * PELVIS + 1];
    let dy = Math.atan2(food.at.x - px, -(food.at.y - py)) - walker.yaw; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
    // (once there it stays until well off it: the food shrinks as it is eaten, and the lips bob)
    const off = Math.hypot(px + GAIT.reach * Math.sin(walker.yaw) - food.at.x, py - GAIT.reach * Math.cos(walker.yaw) - food.at.y), R = FOODS[food.kind].r;
    // (arriving a little off the middle is enough: the face going down and the palms find it; closing in
    // those last few cm, the hands kept pushing a lump on ahead of them)
    there = walker.there ? off < R + 0.12 && Math.abs(dy) < 1.1 : off < R + 0.06 && Math.abs(dy) < 0.8;
    seek = there ? 0 : dy * WALK.seek;
    // food behind: come round to it the way chosen (until it is well ahead again)
    walker.turning = TURN.mode && !there && (Math.abs(dy) > TURN.behind || (walker.turning && Math.abs(dy) > TURN.ahead)) ? Math.sign(dy) || 1 : 0;
  } else walker.turning = 0;
  walker.there = there || meal.on;
  const drive = Math.max(0, Math.min(1, (go - WALK.goMin) / WALK.goFull));
  let want0 = escaping ? 0.45 : TEST.nowalk || busy || there ? 0 : steer.MDN > 10 ? -0.15 : GAIT.speed * drive;
  if (walker.turning && !escaping && !busy) want0 = TURN.mode === 'pivot' ? 0 : TURN.mode === 'reverse' ? -TURN.speed * Math.max(0.5, drive) : TURN.speed * drive;
  // (each side's DNa02 against its own slow average: in this model the left one answers smells from
  // either side far more than the right one does)
  steer.baseL = (steer.baseL ?? steer.DNa02L) + (steer.DNa02L - (steer.baseL ?? steer.DNa02L)) * WALK.adapt;
  steer.baseR = (steer.baseR ?? steer.DNa02R) + (steer.DNa02R - (steer.baseR ?? steer.DNa02R)) * WALK.adapt;
  // (DNa02's own turn counts for less once it is heading for food: its swings kept the mouth circling the food)
  let turn = escaping ? escape.away * 1.2 : seek + ((steer.DNa02L - steer.baseL) - (steer.DNa02R - steer.baseR)) * WALK.turnPerHz * (food ? 0.2 : 1);     // (+: to the left)
  // the body comes round to where the head is turned (the head turned by the brain toward a sound)
  if (!escaping && !food && gaze.bearing != null) turn += gaze.turn * WALK.follow;
  // (turning is slow: a body stepping on its own could not turn faster without tripping over its limbs)
  const TURNMAX = walker.turning && !escaping ? TURN.rate : GAIT.turn;
  if (walker.turning && !escaping) {
    turn = walker.turning * TURN.rate;
  }
  turn = Math.max(-TURNMAX, Math.min(TURNMAX, turn));
  if (TEST.noturn) turn = 0;
  // hands and knees cannot follow a sharp turn at full speed: slow down while turning (not the chosen way round: its speed is its own)
  const want = want0 * (escaping || walker.turning ? 1 : 1 - 0.6 * Math.min(1, Math.abs(turn) / TURNMAX));
  walker.speed += (want - walker.speed) * (jerky ? 0.3 : 0.04);
  if ((Math.abs(walker.speed) > 0.02 || ((driven || walker.turning) && Math.abs(turn) > 0.05)) && !busy && !there) walker.yaw += turn * CTRL;   // (it may turn on the spot)
  walker.x += Math.sin(walker.yaw) * walker.speed * CTRL;
  walker.y += -Math.cos(walker.yaw) * walker.speed * CTRL;
}

// Damped least squares per limb, warm-started, at most 0.15 rad a step. Arms: shoulder
// (3), elbow, wrist onto the middle knuckle. Legs: the hip (flexion, adduction) onto the
// knee, with knee and ankle angles set by the posture (shins along the floor).
function solveLimbs(iters = 3) {
  kin.qpos.set(qRef);
  for (const L of LIMBS) {
    const lm = limb[L];
    if (!lm.goal) continue;
    // a hand on the floor has a second, wrong solution: the upper arm twisted to its limit so the
    // elbow points forward (bent backwards to the eye); if the arm has slid into it, start over
    if (lm.hand && lm.mode === 'floor' && lm.q[2] > 1.0) lm.q = SEED.floor.slice();
    // ...and another with the hand turned over, palm up: if the palm faces up, start over from the seed
    if (!NAIVE.on && lm.hand && lm.mode === 'floor' && palmUp(L[0], kin)) lm.q = SEED.floor.slice();
    for (let it = 0; it < iters; it++) {
      lm.dofs.forEach((k, i) => (kin.qpos[qadr(k)] = lm.q[i]));
      couple(kin.qpos);
      mj.mj_kinematics(m, kin); mj.mj_comPos(m, kin);
      // rows: the main point (3), and on the floor also the fingertip (3) and the index and little
      // knuckles' heights (1 each) so the palm lies flat with the fingers ahead
      const nv = m.nv, n = lm.dofs.length, rows = [], errs = [], weights = [];
      const addPoint = (body, target, onlyZ, w = null) => {
        const p = [kin.xpos[body * 3], kin.xpos[body * 3 + 1], kin.xpos[body * 3 + 2]];
        mj.mj_jac(m, kin, jacp, null, p, body);
        const J = jacp.GetView();
        for (let r = onlyZ ? 2 : 0; r < 3; r++) {
          weights.push(w ?? (rows.length >= 3 ? 0.6 : 1));
          rows.push(lm.dofs.map((k) => J[r * nv + k]));
          errs.push((onlyZ ? target : target[r]) - p[r]);
        }
      };
      const palmOn = lm.hand && lm.palm;
      addPoint(palmOn ? PALM[L[0]].palm : lm.body, lm.goal, false);
      if (palmOn && NAIVE.on) {
        addPoint(PALM[L[0]].tip, lm.palm.tip, false);
        addPoint(PALM[L[0]].index, lm.palm.knuckleZ, true);
        addPoint(PALM[L[0]].little, lm.palm.knuckleZ, true);
      } else if (palmOn) {
        addPoint(PALM[L[0]].tip, lm.palm.tip, false);
        // (the knuckles and the index and little fingertips all level, weighted as much as the palm itself:
        // with less, the hand rolled onto its little finger with the index finger and thumb in the air)
        const HW = TEST.handW ?? (fallen.up ? [2, 1.6] : [1, 0.8]);   // (getting up: the palm flat on the floor matters most)
        addPoint(PALM[L[0]].index, lm.palm.knuckleZ, true, HW[0]);
        addPoint(PALM[L[0]].little, lm.palm.knuckleZ, true, HW[0]);
        if (HW[1]) { addPoint(PALM[L[0]].indexTip, lm.palm.knuckleZ - 0.004, true, HW[1]); addPoint(PALM[L[0]].littleTip, lm.palm.knuckleZ - 0.004, true, HW[1]); }
        addPoint(PALM[L[0]].wrist, lm.palm.wristZ, true);
        // and the elbow pointing back toward the knees and a little out, as a person's does on all fours,
        // the crook of the arm facing forward (left to the palm alone, the arm found a solution with the
        // elbows turned in toward each other, which looked put on backwards)
        const S = L[0], sgn = S === 'L' ? 1 : -1, fw = [Math.sin(walker.yaw), -Math.cos(walker.yaw), 0], lw = [Math.cos(walker.yaw), Math.sin(walker.yaw), 0];
        const sb = SHOULDER[S.toLowerCase()], sh = [kin.xpos[3 * sb], kin.xpos[3 * sb + 1], kin.xpos[3 * sb + 2]];
        const elbowGoal = add(add(scale(add(sh, lm.goal), 0.5), scale(fw, -0.07)), scale(lw, sgn * 0.03));
        addPoint(ELBOW[S], elbowGoal, false, TEST.elbowW ?? 0.2);
      }
      // damped least squares: (J^T J + l^2) dq = J^T e
      const A = Array.from({ length: n }, () => new Array(n).fill(0)), bvec = new Array(n).fill(0);
      rows.forEach((row, r) => { const w = weights[r]; for (let i = 0; i < n; i++) { bvec[i] += row[i] * errs[r] * w; for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j] * w * w; } });
      for (let i = 0; i < n; i++) A[i][i] += 0.04 ** 2;
      const dqs = solveN(A, bvec);
      const seed = lm.seed || SEED[lm.mode];
      for (let i = 0; i < n; i++) {
        const jid = DOF_JNT[lm.dofs[i]], lo = JNT_RANGE[2 * jid], hi = JNT_RANGE[2 * jid + 1];
        const dq = Math.max(-0.15, Math.min(0.15, dqs[i]));
        let v = lm.q[i] + dq + 0.02 * (seed[i] - lm.q[i]);
        if (lo < hi) v = Math.min(hi, Math.max(lo, v));      // (jnt_limited is not readable from the bindings)
        lm.q[i] = v;
      }
    }
    // keep the knees on the floor: nudge the pelvis height by the knees' mean error
    if (!limb[L].hand) kneeErr[L] = lm.goal[2] - kin.xpos[3 * lm.body + 2];
  }
    if (fallen.up) pose.z = fallen.up.z0 + (0.44 - fallen.up.z0) * Math.min(1, fallen.up.prog / (UP.rise ?? CONTROL.rise));   // (getting up: rising as the palms hold - see behave)
    else pose.z += Math.max(-0.01, Math.min(0.01, 0.25 * ((kneeErr.RK + kneeErr.LK) / 2)));
  pose.z = Math.max(0.3, Math.min(0.75, pose.z));
}
const kneeErr = { RK: 0, LK: 0 };
function applyLimbs() {
  for (const L of LIMBS) limb[L].dofs.forEach((k, i) => (qRef[qadr(k)] = limb[L].q[i]));
}
// which way the palm faces, +1 flat down and -1 flat up: (fingertip - wrist) x (index knuckle - little
// knuckle) points up for a right palm lying face down and down for a left one (mirror images)
function palmDown(S, dd) {
  const P = (b) => [dd.xpos[3 * b], dd.xpos[3 * b + 1], dd.xpos[3 * b + 2]], H = PALM[S];
  const a = sub(P(H.tip), P(H.wrist)), b = sub(P(H.index), P(H.little));
  const nz = (a[0] * b[1] - a[1] * b[0]) / ((norm(a) * norm(b)) || 1);
  return S === 'R' ? nz : -nz;
}
const palmUp = (S, dd) => palmDown(S, dd) < -0.3;
function solveN(A, b) {                       // Gaussian elimination with partial pivoting (n <= 6)
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / piv; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let v = M[r][n]; for (let j = r + 1; j < n; j++) v -= M[r][j] * x[j]; x[r] = v / (M[r][r] || 1e-12); }
  return x;
}
function solve3(M, b) {
  const [a, bb, c, dd, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(dd * i - f * g), C = dd * h - e * g;
  const det = a * A + bb * B + c * C || 1e-12;
  const inv = [A, -(bb * i - c * h), bb * f - c * e, B, a * i - c * g, -(a * f - c * dd), C, -(a * h - bb * g), a * e - bb * dd].map((v) => v / det);
  return mul(inv, b);
}

// ------------------------------------------------------------------ fly-like motion
// A fly is never still. Even with nothing going on it scurries a few steps and freezes, jerks
// its head round, rubs its front legs together, lifts and puts down one leg after another and
// its tarsi keep twitching. These habits are the body's own - the brain model gives no such
// output without input - and they give way to what the brain does ask for:
//   * crawling in bursts: 0.25-0.7 s of movement, 0.08-0.22 s frozen (walk() uses burst.go)
//   * the head snaps to a new direction every 0.15-0.6 s
//   * searching: a new bearing at every burst and now and then a loop back; at each stop the
//     face dips to the floor, a hand reaches ahead and pats it, the head casts side to side
//   * while stopped: rubbing the hands together in front of the face for 1.5-3 s now and then,
//     and otherwise one hand or knee at a time lifted and put down a little elsewhere
//   * every finger joint of both hands, and the toes, flick to a new angle every 0.08-0.25 s
//   * small shifts of the trunk
// "Smooth" keeps the same habits but lets every change ease in.
let jerky = true;
const burst = { go: true, until: 0 };
const gaze = { turn: 0, nod: 0, until: 1 };
const habit = { rub: false, rubUntil: 0, nextRub: 6, probe: false, probeUntil: 0, nextProbe: 1, cast: 1, trunk: 0, trunkUntil: 0, toes: [0, 0], toesUntil: 0, shuffleNext: 0.5 };
const shuffles = {};
function habits(t, escaping) {
  if (TEST.nohabits) { habit.rub = false; habit.probe = false; return; }
  const busy = prog.feed > 0.3 || meal.on || prog.groomL > 0.3 || prog.groomR > 0.3 || escaping || !!fallen.up || d.time < spawn.until;
  const still = Math.abs(walker.speed) < 0.03;
  // rubbing the hands: only from a still, settled body (not walking for 1.5 s, no fall for 5 s); the
  // body first sits back on its heels with the hands still down, and gives up if it cannot get
  // balanced on its knees and shins alone in time (handsFree, behave)
  walker.stillSince = still ? walker.stillSince ?? t : null;
  const settled = walker.stillSince != null && t - walker.stillSince > 1.5 && (fallen.lastAt == null || t - fallen.lastAt > 5);
  if (habit.rub && (t >= habit.rubUntil || busy || (!habit.freed && t - habit.rubStart > CONTROL.kneelWait))) { habit.rub = false; habit.freed = false; habit.nextRub = t + 2 + Math.random() * 5; }
  else if (HABITS.rub && !habit.rub && !busy && !walker.there && settled && t >= habit.nextRub) { habit.rub = true; habit.freed = false; habit.rubStart = t; habit.rubUntil = t + CONTROL.kneelWait + 1.5 + Math.random() * 1.5; }
  // at food the face goes down to it (the mouth put to what it walked to - then its taste reaches the
  // brain, which feeds or not); no probing, patting or shuffling of its own otherwise
  // (only once the body has come to rest there for a moment, and then for at least 0.4 s: dipping as it
  // stopped swung the head into the floor, and the dip itself moves the mouth, which must not end it)
  habit.stillAt = still && walker.there ? habit.stillAt ?? t : null;
  if (((walker.there && habit.stillAt !== null && t - habit.stillAt > 0.25) || meal.on) && !escaping) { habit.probe = true; habit.probeUntil = t + 0.4; }
  else if (habit.probe && (t >= habit.probeUntil || busy)) habit.probe = false;
}
// a limb's shuffle: lifted for 0.2 s while it moves to the new spot, then left there
function shuffleOf(L, t) {
  const sh = shuffles[L];
  if (!sh || Math.abs(walker.speed) > 0.03) { delete shuffles[L]; return { df: 0, dl: 0, lift: 0 }; }
  if (sh.back && t >= sh.back) { shuffles[L] = { t0: t, df: 0, dl: 0, from: { df: sh.df, dl: sh.dl } }; return shuffleOf(L, t); }
  const u = Math.min(1, (t - sh.t0) / 0.18), e = u * u * (3 - 2 * u), f0 = sh.from || { df: 0, dl: 0 };
  return { df: f0.df + (sh.df - f0.df) * e, dl: f0.dl + (sh.dl - f0.dl) * e, lift: u < 1 ? 0.05 * Math.sin(Math.PI * u) : 0 };
}
function jerk() {
  const t = d.time;
  drv.kp = 120; drv.kd = 22; drv.maxErr = Infinity;
  burst.go = true;                                                     // (no stop-and-go of its own)
  const busy = prog.groomL > 0.3 || prog.groomR > 0.3 || prog.feed > 0.3 || meal.on || walker.there;   // (the face held down over food)
  // the head looks ahead, except when the brain turns it (no casting about of its own)
  if (t >= gaze.until) { gaze.turn = 0; gaze.nod = 0; gaze.bearing = null; }
  habit.trunk = 0; habit.toes = [0, 0];
  // orienting: the brain's DNp12 (left) / DNg24 (right) - a sound on that side - turn the head toward it, quickly,
  // and it looks that way for a moment (+ turn is to the left)
  // (smoothed over ~0.15 s and taken above its own slow average: these DNs also fire now and then as
  // the body moves, one side more than the other)
  const orientNow = (brain.orientL || 0) - (brain.orientR || 0);
  gaze.orientS = (gaze.orientS || 0) + (orientNow - (gaze.orientS || 0)) * 0.07;
  gaze.orientBase = (gaze.orientBase || 0) + (gaze.orientS - (gaze.orientBase || 0)) * 0.003;
  const orient = gaze.orientS - gaze.orientBase;
  if (Math.abs(orient) > 6 && !busy) {
    // (the head goes to where the sound came from - the ears place it; that it turns at all, and to
    // which side, is the brain's doing)
    const snd = attention.sound && t - attention.sound.t < SOUND_S ? attention.sound.p : null;
    const toward = snd ? bearingTo(snd) : walker.yaw + Math.sign(orient) * 0.6;
    let dy = toward - walker.yaw; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
    if (!snd || Math.sign(dy) === Math.sign(orient) || Math.abs(dy) < 0.3) {
      gaze.bearing = toward; gaze.nod = 0; gaze.until = t + 3; gaze.orienting = t + 0.25;
      if (snd && attention.why !== 'loom') Object.assign(attention, { p: snd, why: 'sound', until: t + 1.5, food: true });
    }
  }
  // following food with the eyes: while the brain is walking the body, the head stays on food it has
  // seen moving past (or heard land) and the body comes round under it
  const walking = Math.max(steer.goL, steer.goR) > WALK.goMin;
  if (walking && attention.food && attention.p && t < attention.until + 1.5) { gaze.bearing = bearingTo(attention.p); gaze.until = Math.max(gaze.until, t + 0.5); }
  // (it keeps looking where it turned to while the body comes round under the head)
  if (gaze.bearing != null && t < gaze.until) { let dy = gaze.bearing - walker.yaw; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI)); gaze.turn = Math.max(-0.9, Math.min(0.9, dy)); }
  else gaze.bearing = null;
  const ease = jerky || t < (gaze.orienting || 0) ? Math.max(jerky ? 1 : 0, 0.25) : 0.06;
  smooth.turn += (gaze.turn - smooth.turn) * ease; smooth.nod += (gaze.nod - smooth.nod) * ease;
  smooth.trunk += (habit.trunk - smooth.trunk) * ease;
  qRef[qadr(NECK[1])] += smooth.turn;
  qRef[qadr(NECK[0])] += smooth.nod;
  qRef[qadr(TRUNK[1])] += smooth.trunk;
  TOES.forEach((k, i) => { smooth.toes[i] += (habit.toes[i] - smooth.toes[i]) * ease; qRef[qadr(k)] += smooth.toes[i]; });
  // fingers: a hand on the floor bearing weight is held open (OPEN_HAND); in the air they rest a little
  // curled, and held up (rubbing, grooming) they curl more
  const rubbing = prog.rub > 0.3;
  if (rubbing) for (const S of ['r', 'l']) qRef[qadr(PROSUP[S])] = RUB.proSup;
  for (const S of ['R', 'L']) {
    const lmS = limb[S + 'H'], up = lmS.mode !== 'floor', bearing = !NAIVE.on && !up && !rubbing && (lmS.lift || 0) < 0.01;
    if (bearing) {
      for (const fj of FINGERS[S]) { fj.v += (fj.open - fj.v) * 0.3; qRef[qadr(fj.dof)] = fj.v; }
      continue;
    }
    for (const fj of FINGERS[S]) {
      fj.target = fj.spread ? fj.lo + 0.5 * (fj.hi - fj.lo) : Math.max(fj.lo, 0) + (up ? 0.45 : 0.08) * (fj.hi - Math.max(fj.lo, 0));
      const want = rubbing ? (fj.spread ? 0 : Math.max(fj.lo, 0) + 0.08 * (fj.hi - Math.max(fj.lo, 0))) : (fj.target ?? 0);
      fj.v += (want - fj.v) * (rubbing ? 0.2 : ease);
      qRef[qadr(fj.dof)] = fj.v;
    }
  }
}
const smooth = { turn: 0, nod: 0, trunk: 0, toes: [0, 0] };

// Where the body is on the floor now, for the muscle driver to share its weight out over: the palms
// that are down and each leg's knee and ankle when low (the shin lies on the floor) - or, while
// getting up after a fall, every place a part of the body touches the floor (a back, an arm, a hip),
// one point per body part. (Using every contact all the time made the pushes fight each other and the
// body crumpled as soon as it stood.) A limb the stepping plan is about to lift is weighted down over
// CONTROL.unload seconds, so the others have taken its load before it goes.
let LIMB_OF = null, GEOMS = null;
function stancePoints() {
  if (!LIMB_OF) {
    LIMB_OF = new Int8Array(NB).fill(-1);
    for (let b = 0; b < NB; b++) {
      const name = m.body(b).name, side = name.endsWith('_r') ? 'R' : name.endsWith('_l') ? 'L' : null;
      if (!side) continue;
      if (/^(radius|ulna|lunate|scaphoid|pisiform|triquetrum|capitate|trapez|hamate|firstmc|secondmc|thirdmc|fourthmc|fifthmc|proximal_thumb|distal_thumb|\dproxph|midph|distph)/.test(name)) LIMB_OF[b] = LIMBS.indexOf(side + 'H');
      else if (/^(tibia|talus|calcn|toes|patella)/.test(name)) LIMB_OF[b] = LIMBS.indexOf(side + 'K');
    }
  }
  const lifting = gait.limb ? gait.limbs.map((K) => LIMBS.indexOf(K)) : [];
  const w = !lifting.length ? 1 : gait.phase === 'swing' ? 0.02 : Math.max(0.1, 1 - (d.time - gait.t0) / CONTROL.unload);
  const weigh = (body) => (NAIVE.on ? 1 : lifting.includes(LIMB_OF[body]) ? w : 1);
  if (!fallen.up) {
    const pts = [], P = (b) => [d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]];
    for (const S of ['R', 'L']) {
      const palm = P(PALM[S].palm);
      if (palm[2] < 0.06 && limb[S + 'H'].mode === 'floor') {
        // the palm and the base of the index and little fingers: an open hand pushes over its whole width
        pts.push({ body: PALM[S].palm, p: palm, w: weigh(PALM[S].palm) });
        if (!NAIVE.on) for (const b of [PALM[S].index, PALM[S].little]) { const q = P(b); if (q[2] < 0.04) pts.push({ body: b, p: q, w: weigh(b) }); }
      }
    }
    for (const s of ['r', 'l']) for (const id of [TIBIA[s], TALUS[s]]) { const p = P(id); if (p[2] < 0.14) pts.push({ body: id, p, w: weigh(id) }); }
    return pts;
  }
  // (lying down: every part whose collision shapes come within 3 cm of the floor, at its lowest point.
  // Not from MuJoCo's contact list - reading d.contact copies the whole list into the WebAssembly heap
  // every time and never gives it back, and a few thousand get-ups used up its 2 GB)
  if (!GEOMS) {
    const gb = Int32Array.from(m.geom_bodyid), ct = Int32Array.from(m.geom_contype), rb = Float64Array.from(m.geom_rbound);
    GEOMS = [];
    for (let g = 0; g < m.ngeom; g++) if (gb[g] > 0 && ct[g]) GEOMS.push({ g, body: gb[g], r: rb[g] });
  }
  const byBody = new Map(), gx = d.geom_xpos;
  for (const { g, body, r } of GEOMS) {
    const bottom = gx[3 * g + 2] - Math.min(r, 0.08);
    if (bottom > 0.03) continue;
    const e = byBody.get(body) || { body, p: [0, 0, 0], n: 0 };
    e.p[0] += gx[3 * g]; e.p[1] += gx[3 * g + 1]; e.n++;
    byBody.set(body, e);
  }
  for (const e of byBody.values()) e.p[2] = 0;
  return [...byBody.values()].map((e) => ({ body: e.body, p: [e.p[0] / e.n, e.p[1] / e.n, 0], w: weigh(e.body) }));
}
// The tuned basic settings (../school/state/control.json, from ../school/tune.mjs): the control, and
// the walking and balance values the strategies are then applied on top of
function setBase(st = {}) {
  if (st.CONTROL) applyControl(st.CONTROL);
  LEVEL1 = JSON.parse(JSON.stringify({ CRAWL, FEED, STANCE, GAIT, UP, TURN, balance: drv.balance }));
  if (st.GAIT) Object.assign(LEVEL1.GAIT, st.GAIT);
  if (st.balance) Object.assign(LEVEL1.balance, st.balance);
  if (st.STANCE) Object.assign(LEVEL1.STANCE, st.STANCE);
  if (st.TURN) Object.assign(LEVEL1.TURN, st.TURN);
  if (NAIVE.on) { Object.assign(LEVEL1.STANCE, NAIVE.STANCE); Object.assign(LEVEL1.GAIT, NAIVE.GAIT); LEVEL1.balance.ahead = 0; }
  applyStrategy({});
}
function applyControl(p = {}) {
  Object.assign(CONTROL, p);
  drv.reg = CONTROL.reg; drv.mu = CONTROL.mu;
  drv.balance = { ...drv.balance, ahead: NAIVE.on ? 0 : CONTROL.ahead };
  drv.tune({ stiffness: CONTROL.stiffness, big: CONTROL.reserve });
}
// Fallen over (the trunk down on the floor): the body tries to get itself up - the posture asked of
// it rises from where it lies to all fours over CONTROL.rise seconds, with the balance held harder,
// pushing on whatever touches the floor. Up again (the trunk and pelvis back at their height for half
// a second) ends it; after CONTROL.upMax seconds it is put back on all fours where it lies instead.
const fallen = { since: -1, count: 0, up: null, ups: 0, upTimes: [] };
function checkFallen() {
  const down = d.xpos[3 * TORSO + 2] < 0.24 || d.qpos[2] < 0.2;
  const t = d.time;
  if (fallen.up) {
    const upright = d.xpos[3 * TORSO + 2] > 0.4 && d.qpos[2] > 0.32;
    fallen.up.okSince = upright ? fallen.up.okSince ?? t : null;
    if (fallen.up.okSince != null && t - fallen.up.okSince > 0.5) {
      fallen.ups++; fallen.upTimes.push(+(t - fallen.up.t0).toFixed(2)); if (fallen.upTimes.length > 20) fallen.upTimes.shift();
      post({ type: 'getup', n: fallen.n, ok: true, t: +(t - fallen.since).toFixed(2) });   // (t: since it went down)
      fallen.up = null; fallen.since = -1; drv.balance = { ...drv.balance, ...fallen.gains };
      return;
    }
    if (t - fallen.up.t0 < CONTROL.upMax) return;
    post({ type: 'getup', n: fallen.n, ok: false, t: +(t - fallen.since).toFixed(2) });
    fallen.up = null; drv.balance = { ...drv.balance, ...fallen.gains };
  } else {
    if (!down) { fallen.since = -1; return; }
    if (fallen.since < 0) { fallen.since = t; fallen.told = false; }
    // (down for a quarter of a second - not just a dip of the chest: the page asks the fly how to get up)
    if (!fallen.told && t - fallen.since >= 0.25) { fallen.told = true; fallen.n = (fallen.n || 0) + 1; post({ type: 'down', n: fallen.n, t: +t.toFixed(2) }); }
    if (t - fallen.since < 0.5 + (UP.delay || 0)) return;          // (lying still a moment first, if that is the way chosen)
    // start getting up
    fallen.count++; fallen.lastAt = t;
    fallen.gains = { ang: drv.balance.ang, z: drv.balance.z, xy: drv.balance.xy };
    boostForGetup();
    fallen.up = { t0: t, z0: Math.max(0.15, d.qpos[2]), prog: 0 };
    habit.rub = habit.probe = false;
    for (const k in plant) delete plant[k];
    return;
  }
  const x = d.qpos[0], y = d.qpos[1], yaw = walker.yaw;
  d.qpos.set(qRest); d.qpos[0] = x; d.qpos[1] = y;
  d.qpos[3] = Math.cos(yaw / 2); d.qpos[4] = d.qpos[5] = 0; d.qpos[6] = Math.sin(yaw / 2);
  d.qvel.fill(0); mj.mj_forward(m, d);
  resetLimbs(); pose.z = 0.44; headLift = 0; dip = 0; flex.L = flex.R = 0; flex.baseL = flex.baseR = null; pose.roll = 0;
  for (const k in prog) prog[k] = 0;
  habit.rub = habit.probe = false;
  startOnAllFours();
  fallen.since = -1;
}

// A strategy: new values for the walking and feeding parameters (any of CRAWL, FEED, STANCE, GAIT,
// and the driver's balance gains), on top of level 1's - so each strategy is the same whatever came before
let LEVEL1 = null;
function applyStrategy(p = {}) {
  if (!LEVEL1) LEVEL1 = JSON.parse(JSON.stringify({ CRAWL, FEED, STANCE, GAIT, UP, TURN, balance: drv.balance }));
  for (const [k, obj] of Object.entries({ CRAWL, FEED, STANCE, GAIT, TURN })) Object.assign(obj, LEVEL1[k], p[k] || {});
  for (const k of Object.keys(UP)) delete UP[k];
  Object.assign(UP, LEVEL1.UP || {}, p.UP || {});
  drv.balance = { ...LEVEL1.balance, ...(p.balance || {}) };
  if (fallen.up) boostForGetup();                                        // (a way of getting up chosen while it is already at it)
}
// How to get up (a strategy's UP, chosen by the fly when it goes down): rise over UP.rise s with the
// balance held UP.boost times harder, after lying still UP.delay s - or the basic control's values
function boostForGetup() {
  const b = UP.boost ?? CONTROL.upBoost;
  fallen.gains = { ang: drv.balance.ang, z: drv.balance.z, xy: drv.balance.xy };
  const boost = (g) => [g[0] * b, g[1] * Math.sqrt(b)];
  drv.balance = { ...drv.balance, ang: boost(drv.balance.ang), z: boost(drv.balance.z), xy: boost(drv.balance.xy) };
}
// Start over (for the learning trials): no food, the body on all fours at (x, y) facing yaw
function resetBody({ x = 0, y = 0, yaw = 0 } = {}) {
  for (const f of scene.food.slice()) removeFood(f);
  trial.on = false; trial.lastId = 0;
  if (replay.on) Object.assign(replay, { on: false, data: null, saved: null });
  recent.frames.length = 0; recent.events.length = 0;       // (a recording must not reach back past a reset)
  // everything that could carry a struggle over: the simulation's own state (velocities, muscle
  // activations, solver warm start), the driver's last excitations, and the balance gains a get-up
  // had raised
  const time = d.time;
  mj.mj_resetData(m, d);
  d.time = time;                                            // (the habits' and the page's clocks run on)
  if (drv.u) drv.u.fill(0);
  if (fallen.up && fallen.gains) drv.balance = { ...drv.balance, ...fallen.gains };
  fallen.since = -1; fallen.count = 0; fallen.up = null;     // (before settling: a get-up still under way pulled the new body down)
  applyStrategy({});
  for (const L in shuffles) delete shuffles[L];
  gait.limb = null; gait.limbs = []; burst.go = true; walker.on = false; walker.until = d.time + 1.5; walker.stillSince = null;
  habit.nextRub = d.time + 4; habit.freed = false; habit.balancedSince = null; fallen.lastAt = null;
  d.qpos.set(qRest); d.qpos[0] = qRest[0] + x; d.qpos[1] = qRest[1] + y;
  d.qpos[3] = Math.cos(yaw / 2); d.qpos[4] = d.qpos[5] = 0; d.qpos[6] = Math.sin(yaw / 2);
  d.qvel.fill(0); mj.mj_forward(m, d);
  walker.yaw = yaw; walker.speed = 0; walker.there = false;
  resetLimbs(); pose.z = 0.44; headLift = 0; dip = 0; flex.L = flex.R = 0; flex.baseL = flex.baseR = null; pose.roll = 0;
  for (const k in prog) prog[k] = 0;
  for (const k in cmd) cmd[k] = 0;
  meal.until = -1; meal.on = false; escape.t = -9;
  habit.rub = habit.probe = false;
  startOnAllFours();
  fallen.since = -1; fallen.count = 0; fallen.up = null;
}

// Begin on all fours, gently: solve the posture for a while without physics, set the body down so
// its hands and knees just touch the floor (it used to appear a few cm up and drop, with a jolt), let
// the muscles come up to the activity that posture needs before physics starts (they began at nothing
// and the body sagged at once), and for its first 1.5 s it only settles - no setting off, no habits.
const spawn = { until: -1 };
function startOnAllFours() {
  for (let i = 0; i < 60; i++) { behave(); solveLimbs(4); applyLimbs(); }
  d.qpos.set(qRef); d.qvel.fill(0); d.act.fill(0); mj.mj_forward(m, d);
  const low = Math.min(d.xpos[3 * PALM.R.palm + 2] - 0.015, d.xpos[3 * PALM.L.palm + 2] - 0.015, d.xpos[3 * TIBIA.r + 2] - 0.055, d.xpos[3 * TIBIA.l + 2] - 0.055);
  d.qpos[2] -= low; qRef[2] -= low; pose.z -= low;
  mj.mj_forward(m, d);
  const instant = drv.instant;
  drv.instant = true;
  for (let i = 0; i < 5; i++) { drv.step(d, qRef); mj.mj_forward(m, d); }
  drv.instant = instant;
  for (const L in plant) delete plant[L];              // (the planned footholds were for the standing body)
  gait.limb = null;
  // then 0.6 s of physics before anything is shown, with the body's motion damped away, so it appears
  // already resting on its hands and knees (the page sees only the settled body)
  spawn.until = d.time + 2.1;
  for (let i = 0; i < 60; i++) {
    behave(); if (i % 2 === 0) solveLimbs(2); applyLimbs();
    drv.step(d, qRef);
    for (let sstep = 0; sstep < SUB; sstep++) { mj.mj_step(m, d); for (let v = 0; v < m.nv; v++) d.qvel[v] *= 0.97; }
  }
}

// ------------------------------------------------------------------ real-time loop
let last = 0, simLag = 0, speed = 1, info = {}, rates = {}, k = 0;
let rtSim = 0, rtWall = 0, realtime = 1;          // body seconds per wall second, over the last second
function loop() {
  const now = performance.now();
  if (replay.on) {
    replayStep(Math.min(0.1, (now - last) / 1000)); last = now;
    sendFrame();
    setTimeout(loop, 16);
    return;
  }
  rtWall += (now - last) / 1000;
  simLag += Math.min(100, now - last) * speed / 1000;
  last = now;
  const t0 = performance.now();
  let steps = 0;
  while (simLag >= CTRL && performance.now() - t0 < 30) {
    updateScene();
    if (k % 2 === 0) {
      rates = senses();
      if (rates.loomL > rates.loomR) lastSide = 'L'; else if (rates.loomR > rates.loomL) lastSide = 'R';
      post({ type: 'senses', rates });
    }
    behave();
    if (k % Math.round(1 / (CTRL * MOTION.hz)) === 0) captureFrame();
    if (k % 2 === 0) solveLimbs(2);
    applyLimbs();
    jerk();
    info = drv.step(d, qRef);
    for (let sstep = 0; sstep < SUB; sstep++) mj.mj_step(m, d);
    checkFallen();
    simLag -= CTRL; k++; steps++;
  }
  if (simLag > 0.2) simLag = 0.2;                    // cannot keep up: slow motion rather than a backlog
  rtSim += steps * CTRL;
  if (rtWall > 1) { realtime = rtSim / rtWall; rtSim = rtWall = 0; }
  sendFrame();
  setTimeout(loop, Math.max(0, 16 - (performance.now() - now)));
}

function sendFrame() {
  const xpos = Float32Array.from(d.xpos), xquat = Float32Array.from(d.xquat);
  const act = new Uint8Array(NU);
  const A = d.act;
  for (let i = 0; i < NU; i++) act[i] = Math.max(0, Math.min(255, A[ACTADR[i]] * 255));
  if (replay.on) {
    const R = replay, S = replayScene;
    post({ type: 'frame', t: R.t, xpos, xquat, act: new Uint8Array(NU), scene: { food: S.food }, prog: S.prog, info: {}, rates: S.rates, brainOut: S.brain, realtime: 1, falls: 0,
      replay: { t: +R.t.toFixed(2), duration: +R.data.duration.toFixed(2), playing: R.playing, speed: R.speed, trialStart: R.data.head.trialStart || 0, events: R.fired || [] } }, [xpos.buffer, xquat.buffer]);
    return;
  }
  post({
    type: 'frame', t: d.time, xpos, xquat, act,
    scene: { food: scene.food.map((f) => f.slot
      ? { id: f.id, amount: f.amount, pos: Array.from(fd.xpos.subarray(3 * f.slot.b, 3 * f.slot.b + 3)), quat: Array.from(fd.xquat.subarray(4 * f.slot.b, 4 * f.slot.b + 4)) }
      : { id: f.id, amount: f.amount, pos: f.pos.slice(), on: f.on ? f.on.id : null }) },
    prog: { ...prog, rub: prog.rub, probe: prog.probe, escape: d.time - escape.t < ESCAPE_S + 0.3, walk: Math.abs(walker.speed) > 0.05, back: walker.speed < -0.05 },
    info, rates, realtime, falls: fallen.count || 0,
    look: attention.p ? { p: attention.p.map((v) => +v.toFixed(3)), why: attention.why } : null,
  }, [xpos.buffer, xquat.buffer, act.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') { if (msg.naive) { NAIVE.on = true; Object.assign(STANCE, NAIVE.STANCE); Object.assign(GAIT, NAIVE.GAIT); } await init(); }
    else if (msg.type === 'brain') brain = msg.out;
    else if (msg.type === 'food') { if (!replay.on) addFood(msg); }
    else if (msg.type === 'replay') await startReplay(msg.motion);
    else if (msg.type === 'pour') { if (!replay.on) recent.events.push({ ...msg.event, type: 'pour', t: d.time }); }   // (the page pouring honey: {event: {kind, x, y, z, ...}})
    else if (msg.type === 'replayControl') {
      if (msg.playing != null) { replay.playing = !!msg.playing; if (replay.playing && replay.data && replay.t >= replay.data.duration) replay.t = 0; }
      if (msg.speed) replay.speed = Math.max(0.1, Math.min(8, +msg.speed));
      if (msg.seek != null && replay.data) { replay.t = Math.max(0, Math.min(replay.data.duration, +msg.seek)); replay.jumped = true; }
    }
    else if (msg.type === 'live') stopReplay();
    else if (msg.type === 'speed') speed = msg.x;
    else if (msg.type === 'motion') jerky = !!msg.jerky;
    else if (msg.type === 'crawl') Object.assign(CRAWL, msg.pose);      // for tuning from a test
    else if (msg.type === 'feed') Object.assign(FEED, msg.pose);
    else if (msg.type === 'strategy') applyStrategy(msg.params);
    else if (msg.type === 'control') applyControl(msg.params);
    else if (msg.type === 'base') setBase(msg.settings);
    else if (msg.type === 'reset') resetBody(msg);
    else if (msg.type === 'test') { Object.assign(TEST, msg.test); if (msg.test.elbows) Object.assign(ELBOWS, msg.test.elbows); }
    else if (msg.type === 'push') for (let i = 0; i < 3; i++) d.qvel[i] += msg.v[i];          // (a shove, for testing getting up)
    else if (msg.type === 'rub') Object.assign(RUB, msg.rub);
    else if (msg.type === 'limbs') post({ type: 'limbs', q: Object.fromEntries(LIMBS.map((L) => [L, limb[L].q.slice()])) });   // for a test
    else if (msg.type === 'gaitState') post({ type: 'gaitState', plant: JSON.parse(JSON.stringify(plant)), goals: Object.fromEntries(LIMBS.map((L) => [L, limb[L].goal])), limb: gait.limb, phase: gait.phase, target: [qRef[0], qRef[1]], com: [d.subtree_com[0], d.subtree_com[1]] });   // for a test
  } catch (err) {
    post({ type: 'error', message: String(err?.stack || err) });
  }
};
