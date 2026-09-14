// The human body, in a worker: MyoFullBody in MuJoCo (WebAssembly), 416 muscles
// driven toward the posture the fly's motor programs ask for, in real time.
//
// main -> worker: {type:'init'} | {type:'brain', out} | {type:'food', id, kind, x, y} | {type:'speed', x}
// worker -> main: {type:'ready', ...} | {type:'frame', ...} | {type:'senses', rates} | {type:'error'}
//
// Each 10 ms of body time: scene -> (every 20 ms) senses to the brain; the latest brain
// output -> motor program levels -> posture, hand/knee footholds -> IK (every 20 ms) -> muscles.
import loadMujoco from './vendor/mujoco.js';
import { MuscleDriver } from './muscles.mjs?v=38';
import { FOODS, FALL_FROM } from './foods.js?v=33';

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
let FWD_L, LEFT_L, UP_L, HEAD, HAND, ARM, TRUNK, LEGJ, NECK, FINGERS, TOES, SHOULDER, HIP, PELVIS, qRest, qRef, MOUTH_L, SCALP_L, jacp, NB, NU;
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
  NB = m.nbody; NU = m.nu;
  DOF_JNT = Int32Array.from(m.dof_jntid); JNT_QADR = Int32Array.from(m.jnt_qposadr);
  JNT_RANGE = Float64Array.from(m.jnt_range); ACTADR = Int32Array.from(m.actuator_actadr);
  // the arms hang exactly on shoulder_elv's lower limit; start just inside it (body_model.py)
  for (const s of 'rl') d.qpos[m.jnt_qposadr[m.jnt(`shoulder_elv_${s}`).id]] = 0.08;
  mj.mj_forward(m, d);
  qRest = Float64Array.from(d.qpos); qRef = Float64Array.from(d.qpos);
  HEAD = m.body('head').id; PELVIS = m.body('pelvis').id;
  HAND = { R: m.body('3proxph_r').id, L: m.body('3proxph_l').id };
  ARM = {};
  for (const [S, s] of [['R', 'r'], ['L', 'l']]) {
    ARM[S] = [`elv_angle_${s}`, `shoulder_elv_${s}`, `shoulder_rot_${s}`, `elbow_flexion_${s}`, `flexion_${s}`, `pro_sup_${s}`].map(dofOf);
    PALM[S] = { palm: m.body(`thirdmc_${s}`).id, tip: m.body(`distph3_${s}`).id, index: m.body(`2proxph_${s}`).id, little: m.body(`5proxph_${s}`).id };
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
    FINGERS[name.endsWith('_l') ? 'L' : 'R'].push({ dof: m.jnt_dofadr[j], lo: JNT_RANGE[2 * j], hi: JNT_RANGE[2 * j + 1], spread: name.includes('abduction'), v: 0, next: 0 });
  }
  TOES = ['mtp_angle_r', 'mtp_angle_l'].map(dofOf);
  await loadHeadSkin();
  buildFoodWorld();
  const h = headFrame(d);
  // lips and the two halves of the scalp, fixed in the head (measured on the mesh; the face looks along -y)
  MOUTH_L = mulT(h.R, sub([-0.025, 0.118, 1.575], h.pos));
  FWD_L = mulT(h.R, [0, -1, 0]); LEFT_L = mulT(h.R, [1, 0, 0]); UP_L = mulT(h.R, [0, 0, 1]);   // the head's own directions
  SCALP_L = { L: mulT(h.R, sub([0.045, 0.19, 1.70], h.pos)), R: mulT(h.R, sub([-0.095, 0.19, 1.70], h.pos)) };
  jacp = new mj.DoubleBuffer(3 * m.nv);
  // no support: the body is held up by its hands and knees on the floor (the root gets no force)
  drv = new MuscleDriver(mj, m, { rootForce: 0, rootTorque: 0, rootCarried: true, bigReserve: 60, stance: stancePoints, balance: self.__T?.bal || { ang: [60, 12], z: [40, 10], xy: [40, 14] } });
  resetLimbs();
  startOnAllFours();
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

function updateScene() {
  stepFood();
  // eating: while feeding with the lips on it, it goes down (a whole one in 2.5-3.5 s)
  const food = foodAt(toWorld(d, MOUTH_L), 0.12, 0.03);
  if (food && prog.feed > 0.3) food.amount -= CTRL / FOODS[food.kind].eat;
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
  // small things moving, and things looming, seen from between the eyes
  const at = toWorld(d, add(MOUTH_L, scale(UP_L, 0.08))), fwd = mul(R, FWD_L), left = mul(R, LEFT_L);
  r.smallL = r.smallR = r.loomL = r.loomR = 0;
  const things = ['R', 'L'].map((S) => ({ key: 'hand' + S, p: [0, 1, 2].map((i) => d.xpos[3 * PALM[S].palm + i]), rad: 0.05, own: true }));
  for (const f of scene.food) if (f.slot && f.at) things.push({ key: f.id, p: [f.at.x, f.at.y, fd.xipos[3 * f.slot.b + 2]], rad: f.at.r, own: false, vel: Array.from(fd.qvel.subarray(f.slot.v, f.slot.v + 3)) });
  const seen = new Map();
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
    if (ahead > 0.4 && theta < 0.6) r['small' + S] += 5 * slide * Math.min(1, theta / 0.1);   // (small motion: only ahead)
    if (!o.own && grow > 0.5) r['loom' + S] += 60 * grow;
  }
  motion.seen = seen;
  for (const k of ['smallL', 'smallR']) r[k] = Math.min(20, r[k]);
  for (const k of ['loomL', 'loomR']) r[k] = Math.min(150, r[k]);
  for (const k of ['eyeL', 'eyeR', 'windL', 'windR', 'ocelli', 'smallL', 'smallR', 'loomL', 'loomR']) r[k] = 2 * Math.round(r[k] / 2);   // (in 2 Hz steps: fewer changes to the brain's input)
  return r;
}

function senses() {
  // the taste of the food on the lips, and more weakly of one under a palm (a fly tastes with its feet too)
  const r = { sugar: 0, water: 0, salt: 0, bitter: 0 };
  const palm = (S) => foodAt([0, 1, 2].map((i) => d.xpos[3 * PALM[S].palm + i]), 0.07, 0.02);
  const lips = foodAt(toWorld(d, MOUTH_L), 0.12, 0.03), food = lips || palm('R') || palm('L');
  if (food) for (const [ch, hz] of Object.entries(FOODS[food.kind].taste)) r[ch] = lips ? hz : hz * 2 / 3;
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
const CRAWL = { pitch: 1.5, nod: 1.45, lumbar: -0.1 };
const FEED = { pitch: 0.7, lumbar: -0.15, nod: -0.2 };     // how far feeding tips the chest and face down from the crawl: chin forward, so the lips come lowest, ~4 cm off the floor   // pelvis carried at this pitch, spine a touch flexed (it settles a little extended), face lifted by the neck
let headLift = 0, headLowKin = 1, dip = 0;
const pose = { pitch: 1.4, lumbar: 0, nod: 1.35, knee: 1.75, ankle: -0.6, z: 0.44, kneel: 0 };
const LIMBS = ['RH', 'LH', 'RK', 'LK'];
const RUB = { hz: 1.6, gap: -0.015, stroke: 0.05, proSup: 0 };
// how far out from under the shoulders and hips the hands and knees go: on all fours people crawl
// with the knees apart, not with the thighs pressed together
const STANCE = { hands: 0.08, knees: 0.12 };
// (floor: the crawl's own settled arm - elbow back, wrist bent up, forearm pronated - so the
// start solves into it rather than the twisted, elbow-forward branch)
const SEED = { floor: [1.33, 1.05, -0.05, 1.05, -0.79, 1.52], head: [1.3, 1.0, 0, 1.8, 0, 0], air: [1.3, 1.6, 0, 0.4, 0, 0] };
const limb = {};                      // per limb: joint values, what it is doing, its target
let lastSide = 'L';

function behave() {
  const t = d.time, a = 0.08;
  // the brain's feeding and grooming commands, as rates over the last ~150 ms: counted in 20 ms bins
  // they come in bursts with empty bins between, and each empty bin used to drop the program
  for (const k of ['MN9', 'groomL', 'groomR']) cmd[k] += ((brain[k] || 0) - cmd[k]) * (CTRL / 0.15);
  const MN9 = cmd.MN9, gL = cmd.groomL, gR = cmd.groomR;
  prog.feed += ((MN9 > 15 ? Math.min(1, MN9 / 60) : 0) - prog.feed) * a;
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
  dip += Math.max(-0.08, Math.min(0.015, Math.max(prog.feed, (walker.there || meal.on ? 1 : 0.85) * prog.probe) * (1 - kneel) - dip));
  const feed = dip;
  pose.kneel = kneel;
  pose.pitch = CRAWL.pitch + FEED.pitch * feed - (CRAWL.pitch - 0.15) * kneel;
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
  if (self.__T) self.__tgt = steps.target;
  // (never more than 5 cm at a time: pushed hard toward a far target, the body rolled over past its supports)
  const DX = steps.target[0] - d.subtree_com[0], DY = steps.target[1] - d.subtree_com[1], DN = Math.hypot(DX, DY), MAXS = self.__T?.maxs ?? 0.05, ks = DN > MAXS ? MAXS / DN : 1;
  qRef[0] = d.qpos[0] + DX * ks; qRef[1] = d.qpos[1] + DY * ks;
  qRef[2] = pose.z;
  qRef[3] = cy * cp; qRef[4] = cy * sp; qRef[5] = sy * sp; qRef[6] = sy * cp;     // turn about the vertical, then pitch forward
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
  const TORSO = m.body('torso').id;
  const pel = [d.xpos[3 * PELVIS], d.xpos[3 * PELVIS + 1], d.xpos[3 * PELVIS + 2]], tor = [d.xpos[3 * TORSO], d.xpos[3 * TORSO + 1], d.xpos[3 * TORSO + 2]];
  const handsFree = (tor[2] - pel[2]) / (norm(sub(tor, pel)) || 1) > 0.8;
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
        // the palm flat on the floor, fingers pointing ahead (the tip and both knuckles at floor height)
        goal = [ft.xy[0], ft.xy[1], 0.03 + lift];
        palm = { tip: add(goal, add(scale(f, 0.1), [0, 0, -0.012])), knuckleZ: goal[2] - 0.008 };
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
    const off = [0, 1, 2].map((i) => Math.max(-0.3, Math.min(0.3, d.xpos[3 * base + i] - kin.xpos[3 * base + i] + shift[i])));
    lm.goal = sub(goal, off);
    lm.palm = palm && mode === 'floor' ? { tip: sub(palm.tip, off), knuckleZ: palm.knuckleZ - off[2] } : null;
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
const gait = { order: ['LK', 'LH', 'RK', 'RH'], next: 0, limb: null, phase: '', t0: 0, from: null };
const plant = {};
function planSteps(t, kneel) {
  const f = [Math.sin(walker.yaw), -Math.cos(walker.yaw)], l = [Math.cos(walker.yaw), Math.sin(walker.yaw)];
  const crawling = Math.abs(walker.speed) > 0.05 && burst.go;
  const home = {};
  for (const L of LIMBS) {
    const s = L[0] === 'R' ? 'r' : 'l', sgn = s === 'l' ? 1 : -1, hand = L[1] === 'H', sh = shuffleOf(L, t);
    const base = hand ? SHOULDER[s] : HIP[s];
    const ahead = (hand ? 0.02 : -0.02 * (1 - kneel) + 0.28 * kneel) + sh.df + (crawling ? 0.15 * Math.sign(walker.speed) : 0);
    const side = (hand ? sgn * STANCE.hands : sgn * STANCE.knees * (1 - 0.5 * kneel)) + sh.dl;
    home[L] = [d.xpos[3 * base] + f[0] * ahead + l[0] * side, d.xpos[3 * base + 1] + f[1] * ahead + l[1] * side];
    if (!plant[L]) plant[L] = home[L];
  }
  const onFloor = (L) => L[1] === 'K' || limb[L].mode === 'floor';
  for (const L of LIMBS) if (!onFloor(L)) plant[L] = home[L];               // (a hand in the air comes down at its place)
  const mid = (Ls) => { const pts = Ls.map((L) => plant[L]); return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]; };
  const com = [d.subtree_com[0], d.subtree_com[1]];
  const feet = Object.fromEntries(LIMBS.map((L) => [L, { xy: plant[L], lift: 0 }]));
  if (kneel > 0.3) {
    // up on the knees: over the knees and shins, no steps
    gait.limb = null;
    const knees = mid(['LK', 'RK']), ankles = ['r', 'l'].map((s) => { const b = m.body(`talus_${s}`).id; return [d.xpos[3 * b], d.xpos[3 * b + 1]]; });
    return { target: [(2 * knees[0] + ankles[0][0] + ankles[1][0]) / 4, (2 * knees[1] + ankles[0][1] + ankles[1][1]) / 4], feet };
  }
  if (!gait.limb) {
    let L = null;
    if (crawling) { L = gait.order[gait.next % 4]; gait.next++; }
    else {
      let far = 0.1;
      for (const K of LIMBS) { const dd = Math.hypot(plant[K][0] - home[K][0], plant[K][1] - home[K][1]); if (onFloor(K) && dd > far) { far = dd; L = K; } }
    }
    if (L) Object.assign(gait, { limb: L, phase: 'shift', t0: t });
  }
  if (!gait.limb) return { target: crawling ? [com[0] + f[0] * 0.1 * Math.sign(walker.speed), com[1] + f[1] * 0.1 * Math.sign(walker.speed)] : mid(LIMBS.filter(onFloor)), feet };
  const L = gait.limb, others = LIMBS.filter((K) => K !== L && onFloor(K));
  // the nearest point to the centre of mass inside the triangle of the other three, shrunk to 70%
  // about its middle (a margin): the body only moves as far as it must
  let rest = mid(others);
  if (others.length === 3) {
    const c = rest, tri = others.map((K) => [c[0] + (self.__T?.shrink ?? 0.8) * (plant[K][0] - c[0]), c[1] + (self.__T?.shrink ?? 0.8) * (plant[K][1] - c[1])]);
    // (while crawling the body leans on ahead: it aims 10 cm in front of where it is, within that triangle)
    const aim = crawling ? [com[0] + f[0] * 0.1 * Math.sign(walker.speed), com[1] + f[1] * 0.1 * Math.sign(walker.speed)] : com;
    rest = closestInTriangle(aim, tri);
  }
  if (gait.phase === 'shift') {
    if (Math.hypot(com[0] - rest[0], com[1] - rest[1]) < (self.__T?.near ?? 0.03)) Object.assign(gait, { phase: 'swing', t0: t, from: plant[L] });
    else if (t - gait.t0 > 1.5) { gait.limb = null; return { target: mid(LIMBS.filter(onFloor)), feet }; }   // (could not get over the others: leave this one)
  }
  if (gait.phase === 'swing') {
    const u = Math.min(1, (t - gait.t0) / 0.3), e = u * u * (3 - 2 * u), to = home[L];
    feet[L] = { xy: [gait.from[0] + (to[0] - gait.from[0]) * e, gait.from[1] + (to[1] - gait.from[1]) * e], lift: 0.05 * Math.sin(Math.PI * u) };
    if (u >= 1) { plant[L] = to; gait.limb = null; }
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

function walk(t, escaping) {
  const busy = prog.feed > 0.3 || meal.on || prog.groomL > 0.3 || prog.groomR > 0.3 || prog.rub > 0.2 || habit.rub;
  if (t >= walker.until) {
    walker.on = !walker.on;
    walker.until = t + (walker.on ? 2 + Math.random() * 4 : 0.6 + Math.random() * 1.2);
  }
  // searching: every burst sets off on a new bearing, and now and then it loops back on itself
  if (burst.go && !walker.wasGo) walker.turn = Math.random() < 0.15 ? (Math.random() < 0.5 ? -1 : 1) * 1.2 : (Math.random() - 0.5) * 1.6;
  walker.wasGo = burst.go;
  const food = nearestFood(toWorld(d, MOUTH_L));
  let seek = 0, there = false;
  if (food) {
    // bear on the puddle from the pelvis, and stop where the lips will be over its middle once the
    // head is down (feeding brings them back to 52 cm ahead of the pelvis, from 60 cm while crawling)
    const px = d.xpos[3 * PELVIS], py = d.xpos[3 * PELVIS + 1];
    let dy = Math.atan2(food.at.x - px, -(food.at.y - py)) - walker.yaw; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
    // (once there it stays there until well off it: the food shrinks as it is eaten, and the lips
    // bob, and neither should send the body off again)
    const off = Math.hypot(px + 0.52 * Math.sin(walker.yaw) - food.at.x, py - 0.52 * Math.cos(walker.yaw) - food.at.y), R = FOODS[food.kind].r;
    there = walker.there ? off < R + 0.06 && Math.abs(dy) < 1 : off < 0.5 * R + 0.03 && Math.abs(dy) < 0.6;
    seek = there ? 0 : dy * 2.5;
  }
  walker.there = there;
  const back = (brain.MDN || 0) > 20, forward = (brain.DNp09 || 0) > 20;
  const want0 = escaping ? 0.45 : self.__T?.nowalk || busy || there ? 0 : back ? -0.15 : (walker.on || forward || food) ? 0.28 : 0;
  let turn = escaping ? escape.away * 1.2 : (food ? seek : walker.turn) + ((brain.DNa02R || 0) - (brain.DNa02L || 0)) * 0.03;
  const r = Math.hypot(walker.x, walker.y);
  if (r > (food ? 1.9 : 0.9)) {                                         // away from the edge of the floor, early and gently
    const toCentre = Math.atan2(-walker.x, walker.y);
    let dy = toCentre - walker.yaw; dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
    turn += dy * Math.min(1, (r - 0.9) / 0.4) * 1.5;
  }
  // (turning is slow: a body stepping on its own could not turn faster without tripping over its limbs)
  const TURN = self.__T?.turnmax ?? 0.4;
  turn = Math.max(-TURN, Math.min(TURN, turn));
  if (self.__T?.noturn) turn = 0;
  // hands and knees cannot follow a sharp turn at full speed: slow down while turning
  const want = want0 * (escaping ? 1 : (1 - 0.6 * Math.min(1, Math.abs(turn) / TURN)) * (burst.go ? 1 : 0));
  walker.speed += (want - walker.speed) * (jerky ? 0.3 : 0.04);        // a fly starts and stops at once
  if (Math.abs(walker.speed) > 0.02 || (food && !there && !busy && burst.go)) walker.yaw += turn * CTRL;
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
    for (let it = 0; it < iters; it++) {
      lm.dofs.forEach((k, i) => (kin.qpos[qadr(k)] = lm.q[i]));
      couple(kin.qpos);
      mj.mj_kinematics(m, kin); mj.mj_comPos(m, kin);
      // rows: the main point (3), and on the floor also the fingertip (3) and the index and little
      // knuckles' heights (1 each) so the palm lies flat with the fingers ahead
      const nv = m.nv, n = lm.dofs.length, rows = [], errs = [];
      const addPoint = (body, target, onlyZ) => {
        const p = [kin.xpos[body * 3], kin.xpos[body * 3 + 1], kin.xpos[body * 3 + 2]];
        mj.mj_jac(m, kin, jacp, null, p, body);
        const J = jacp.GetView();
        for (let r = onlyZ ? 2 : 0; r < 3; r++) {
          rows.push(lm.dofs.map((k) => J[r * nv + k]));
          errs.push((onlyZ ? target : target[r]) - p[r]);
        }
      };
      const palmOn = lm.hand && lm.palm;
      addPoint(palmOn ? PALM[L[0]].palm : lm.body, lm.goal, false);
      if (palmOn) {
        addPoint(PALM[L[0]].tip, lm.palm.tip, false);
        addPoint(PALM[L[0]].index, lm.palm.knuckleZ, true);
        addPoint(PALM[L[0]].little, lm.palm.knuckleZ, true);
      }
      // damped least squares: (J^T J + l^2) dq = J^T e
      const A = Array.from({ length: n }, () => new Array(n).fill(0)), bvec = new Array(n).fill(0);
      rows.forEach((row, r) => { for (let i = 0; i < n; i++) { bvec[i] += row[i] * errs[r] * (r >= 3 ? 0.6 : 1); for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j] * (r >= 3 ? 0.36 : 1); } });
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
    pose.z += Math.max(-0.01, Math.min(0.01, 0.25 * ((kneeErr.RK + kneeErr.LK) / 2)));
  pose.z = Math.max(0.3, Math.min(0.75, pose.z));
}
const kneeErr = { RK: 0, LK: 0 };
function applyLimbs() {
  for (const L of LIMBS) limb[L].dofs.forEach((k, i) => (qRef[qadr(k)] = limb[L].q[i]));
}
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
  if (self.__T?.nohabits) { habit.rub = false; habit.probe = false; return; }
  const busy = prog.feed > 0.3 || meal.on || prog.groomL > 0.3 || prog.groomR > 0.3 || escaping;
  const still = Math.abs(walker.speed) < 0.03;
  if (habit.rub && (t >= habit.rubUntil || busy)) { habit.rub = false; habit.nextRub = t + 2 + Math.random() * 5; }
  else if (!habit.rub && !busy && !walker.there && still && t >= habit.nextRub) { habit.rub = true; habit.rubUntil = t + 1.5 + Math.random() * 1.5; }
  // at food the face stays down on it (dabbing, then feeding once the taste has reached the brain)
  // (only once the body has come to rest there for a moment: dipping as it stopped swung the head into the floor)
  habit.stillAt = still && walker.there ? habit.stillAt ?? t : null;
  if (((walker.there && habit.stillAt !== null && t - habit.stillAt > 0.25) || meal.on) && !escaping) { habit.rub = false; habit.probe = true; habit.probeUntil = t + 0.4; }
  // probing: whenever it stops, the face goes down to the floor for a moment (a fly dabbing its proboscis)
  else if (habit.probe && (t >= habit.probeUntil || busy || habit.rub)) { habit.probe = false; habit.nextProbe = t + 0.4 + Math.random() * 1.2; }
  else if (!habit.probe && !busy && !habit.rub && !walker.there && still && t >= habit.nextProbe) { habit.probe = true; habit.probeUntil = t + 0.3 + Math.random() * 0.35; }
  // tapping and shuffling: a hand reaches ahead and pats the floor (tasting with the "feet"), or a limb is put down elsewhere
  if (!busy && !walker.there && still && !habit.rub && t >= habit.shuffleNext) {
    const hand = Math.random() < 0.7, L = hand ? (Math.random() < 0.5 ? 'RH' : 'LH') : (Math.random() < 0.5 ? 'RK' : 'LK');
    shuffles[L] = hand ? { t0: t, df: 0.06 + Math.random() * 0.1, dl: (Math.random() - 0.5) * 0.12, back: t + 0.25 + Math.random() * 0.2 }
                       : { t0: t, df: (Math.random() - 0.5) * 0.08, dl: (Math.random() - 0.5) * 0.05 };
    habit.shuffleNext = t + 0.18 + Math.random() * 0.35;
  }
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
  if (t >= burst.until) {
    burst.go = !jerky || !burst.go;
    burst.until = t + (burst.go ? 0.25 + Math.random() * 0.45 : 0.08 + Math.random() * 0.14);
  }
  const busy = prog.groomL > 0.3 || prog.groomR > 0.3 || prog.feed > 0.3 || meal.on || walker.there;   // (the face held down over food)
  if (t >= gaze.until) {
    // casting: the head swings to one side, then the other, each time a different amount
    habit.cast = -habit.cast;
    gaze.turn = busy ? 0 : habit.cast * (0.2 + Math.random() * 0.55);
    gaze.nod = busy ? 0 : (Math.random() - 0.5) * 0.45;
    gaze.until = t + 0.15 + Math.random() * 0.45;
  }
  if (t >= habit.trunkUntil) { habit.trunk = (Math.random() - 0.5) * 0.12; habit.trunkUntil = t + 0.2 + Math.random() * 0.4; }
  if (t >= habit.toesUntil) { habit.toes = [0, 1].map(() => (Math.random() - 0.5) * 0.8); habit.toesUntil = t + 0.12 + Math.random() * 0.3; }
  const ease = jerky ? 1 : 0.06;
  smooth.turn += (gaze.turn - smooth.turn) * ease; smooth.nod += (gaze.nod - smooth.nod) * ease;
  smooth.trunk += (habit.trunk - smooth.trunk) * ease;
  qRef[qadr(NECK[1])] += smooth.turn;
  qRef[qadr(NECK[0])] += smooth.nod;
  qRef[qadr(TRUNK[1])] += smooth.trunk;
  TOES.forEach((k, i) => { smooth.toes[i] += (habit.toes[i] - smooth.toes[i]) * ease; qRef[qadr(k)] += smooth.toes[i]; });
  // fingers: on the floor they drum and splay; held up (rubbing, grooming) they curl more
  const rubbing = prog.rub > 0.3;
  if (rubbing) for (const S of ['r', 'l']) qRef[qadr(dofOf(`pro_sup_${S}`))] = RUB.proSup;
  for (const S of ['R', 'L']) {
    const up = limb[S + 'H'].mode !== 'floor';
    for (const fj of FINGERS[S]) {
      if (t >= fj.next) {
        const r = Math.random();
        fj.target = fj.spread ? fj.lo + (0.2 + 0.6 * r) * (fj.hi - fj.lo)
          : Math.max(fj.lo, 0) + (up ? 0.2 + 0.55 * r : 0.02 + 0.12 * r) * (fj.hi - Math.max(fj.lo, 0));   // flat on the floor they only flex a little
        fj.next = t + 0.08 + Math.random() * 0.17;
      }
      const want = rubbing ? (fj.spread ? 0 : Math.max(fj.lo, 0) + 0.08 * (fj.hi - Math.max(fj.lo, 0))) : (fj.target ?? 0);
      fj.v += (want - fj.v) * (rubbing ? 0.2 : ease);
      qRef[qadr(fj.dof)] = fj.v;
    }
  }
}
const smooth = { turn: 0, nod: 0, trunk: 0, toes: [0, 0] };

// Where the body is on the floor now (for the muscle driver to share its weight out over): palms
// that are down, and each leg's knee and ankle when low (the shin lies on the floor)
function stancePoints() {
  const pts = [], P = (b) => [d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]];
  for (const S of ['R', 'L']) {
    const palm = P(PALM[S].palm);
    if (palm[2] < 0.06 && limb[S + 'H'].mode === 'floor') pts.push({ body: PALM[S].palm, p: palm });
  }
  for (const s of ['r', 'l']) for (const b of [`tibia_${s}`, `talus_${s}`]) { const id = m.body(b).id, p = P(id); if (p[2] < 0.14) pts.push({ body: id, p }); }
  return pts;
}

// Begin on all fours: solve the posture for a while without physics and put the body there.
// Fallen over (the trunk down on the floor) and still there after 2.5 s: the body cannot get itself
// up, so it is put back on all fours where it lies, facing the same way.
const fallen = { since: -1 };
function checkFallen() {
  const TORSO = m.body('torso').id, down = d.xpos[3 * TORSO + 2] < 0.24 || d.qpos[2] < 0.2;
  if (!down) { fallen.since = -1; return; }
  if (fallen.since < 0) fallen.since = d.time;
  if (d.time - fallen.since < 2.5) return;
  const x = d.qpos[0], y = d.qpos[1], yaw = walker.yaw;
  d.qpos.set(qRest); d.qpos[0] = x; d.qpos[1] = y;
  d.qpos[3] = Math.cos(yaw / 2); d.qpos[4] = d.qpos[5] = 0; d.qpos[6] = Math.sin(yaw / 2);
  d.qvel.fill(0); mj.mj_forward(m, d);
  resetLimbs(); pose.z = 0.44; headLift = 0; dip = 0;
  for (const k in prog) prog[k] = 0;
  habit.rub = habit.probe = false;
  startOnAllFours();
  fallen.since = -1; fallen.count = (fallen.count || 0) + 1;
}

function startOnAllFours() {
  for (let i = 0; i < 60; i++) { behave(); solveLimbs(4); applyLimbs(); }
  d.qpos.set(qRef); d.qvel.fill(0); d.act.fill(0); mj.mj_forward(m, d);
  for (const L in plant) delete plant[L];              // (the planned footholds were for the standing body)
  gait.limb = null;
}

// ------------------------------------------------------------------ real-time loop
let last = 0, simLag = 0, speed = 1, info = {}, rates = {}, k = 0;
let rtSim = 0, rtWall = 0, realtime = 1;          // body seconds per wall second, over the last second
function loop() {
  const now = performance.now();
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
  post({
    type: 'frame', t: d.time, xpos, xquat, act,
    scene: { food: scene.food.map((f) => f.slot
      ? { id: f.id, amount: f.amount, pos: Array.from(fd.xpos.subarray(3 * f.slot.b, 3 * f.slot.b + 3)), quat: Array.from(fd.xquat.subarray(4 * f.slot.b, 4 * f.slot.b + 4)) }
      : { id: f.id, amount: f.amount, pos: f.pos.slice(), on: f.on ? f.on.id : null }) },
    prog: { ...prog, rub: prog.rub, probe: prog.probe, escape: d.time - escape.t < ESCAPE_S + 0.3, walk: Math.abs(walker.speed) > 0.05, back: walker.speed < -0.05 },
    info, rates, realtime, com: self.__T ? [d.subtree_com[0], d.subtree_com[1]] : undefined, fell: self.__T ? fallen.count || 0 : undefined, gait: self.__T ? (gait.limb ? gait.limb + ':' + gait.phase : '-') + ' tgt ' + (self.__tgt || []).map((v) => v.toFixed(2)) + ' yaw ' + walker.yaw.toFixed(2) : undefined,
  }, [xpos.buffer, xquat.buffer, act.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') await init();
    else if (msg.type === 'brain') brain = msg.out;
    else if (msg.type === 'food') addFood(msg);
    else if (msg.type === 'speed') speed = msg.x;
    else if (msg.type === 'motion') jerky = !!msg.jerky;
    else if (msg.type === 'crawl') Object.assign(CRAWL, msg.pose);      // for tuning from a test
    else if (msg.type === 'feed') Object.assign(FEED, msg.pose);
    else if (msg.type === 'rub') Object.assign(RUB, msg.rub);
    else if (msg.type === 'limbs') post({ type: 'limbs', q: Object.fromEntries(LIMBS.map((L) => [L, limb[L].q.slice()])) });   // for a test
  } catch (err) {
    post({ type: 'error', message: String(err?.stack || err) });
  }
};
