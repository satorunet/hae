// Search a hands-and-knees posture: pelvis pitch, lumbar extension -> knees on the floor,
// can the hands reach the floor under the shoulders, and where does the face look?
import loadMujoco from '@mujoco/mujoco';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const mj = await loadMujoco();
const vfs = new mj.MjVFS(); vfs.addBuffer('b.mjb', gunzipSync(await readFile('data/myofullbody.mjb.gz')));
const m = mj.MjModel.from_binary_path('b.mjb', vfs), d = new mj.MjData(m);
for (const s of 'rl') d.qpos[m.jnt_qposadr[m.jnt(`shoulder_elv_${s}`).id]] = 0.08;
mj.mj_forward(m, d);
const q0 = Float64Array.from(d.qpos);
const QA = (n) => m.jnt_qposadr[m.jnt(n).id], DOF = (n) => m.jnt_dofadr[m.jnt(n).id];
const R = Float64Array.from(m.jnt_range);
const body = (n) => m.body(n).id, P = (b) => [d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]];
const head = body('head');
const HR0 = Array.from(d.xmat.subarray(head * 9, head * 9 + 9));
const faceL = [-HR0[3], -HR0[4], -HR0[5]];                   // head-frame direction of world -y at rest (R^T v)
const jacp = new mj.DoubleBuffer(3 * m.nv);
function ik(bodyName, names, goal, iters = 80, seed) {
  const b = body(bodyName), dofs = names.map(DOF), qa = names.map(QA), jid = names.map((n) => m.jnt(n).id);
  if (seed) qa.forEach((a, i) => (d.qpos[a] = seed[i]));
  let err = 0;
  for (let it = 0; it < iters; it++) {
    mj.mj_kinematics(m, d); mj.mj_comPos(m, d);
    const p = P(b), e = [goal[0] - p[0], goal[1] - p[1], goal[2] - p[2]]; err = Math.hypot(...e);
    mj.mj_jac(m, d, jacp, null, p, b);
    const J = jacp.GetView(), nv = m.nv, Js = dofs.map((k) => [J[k], J[nv + k], J[2 * nv + k]]);
    const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const c of Js) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) M[3 * r + s] += c[r] * c[s];
    for (let r = 0; r < 3; r++) M[4 * r] += 0.03 ** 2;
    const x = solve3(M, e);
    qa.forEach((a, i) => { const dq = Math.max(-0.15, Math.min(0.15, Js[i][0] * x[0] + Js[i][1] * x[1] + Js[i][2] * x[2])); d.qpos[a] = Math.min(R[2 * jid[i] + 1], Math.max(R[2 * jid[i]], d.qpos[a] + dq)); });
  }
  return err;
}
function solve3(M, b) {
  const [a, bb, c, dd, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(dd * i - f * g), C = dd * h - e * g, det = a * A + bb * B + c * C || 1e-12;
  const inv = [A, -(bb * i - c * h), bb * f - c * e, B, a * i - c * g, -(a * f - c * dd), C, -(a * h - bb * g), a * e - bb * dd].map((v) => v / det);
  return [inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2], inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2], inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2]];
}
console.log('ranges flex_ext', R[2 * m.jnt('flex_extension').id], R[2 * m.jnt('flex_extension').id + 1], 'hip_flex', R[2 * m.jnt('hip_flexion_r').id], R[2 * m.jnt('hip_flexion_r').id + 1], 'knee', R[2 * m.jnt('knee_angle_r').id + 1], 'ankle', R[2 * m.jnt('ankle_angle_r').id], R[2 * m.jnt('ankle_angle_r').id + 1]);
for (const pitch of [1.35, 1.45]) for (const lumbar of [0.0]) for (const fwd of [0.05]) for (const nod of [0, 0.8, 1.2]) {
  d.qpos.set(q0);
  d.qpos[3] = Math.cos(pitch / 2); d.qpos[4] = Math.sin(pitch / 2); d.qpos[5] = 0; d.qpos[6] = 0;
  d.qpos[QA('flex_extension')] = lumbar;
  d.qpos[QA('neck_nod')] = nod;
  for (const s of 'rl') { d.qpos[QA(`hip_flexion_${s}`)] = Math.min(2.0, pitch); d.qpos[QA(`knee_angle_${s}`)] = 1.75; d.qpos[QA(`ankle_angle_${s}`)] = -0.6; }
  mj.mj_kinematics(m, d);
  const knee = (P(body('tibia_r'))[2] + P(body('tibia_l'))[2]) / 2;
  d.qpos[2] += 0.07 - knee;                                  // knees 7 cm above the floor (the knee joint centre)
  mj.mj_kinematics(m, d);
  const out = [];
  for (const s of 'rl') {
    const sh = P(body(`humerus_${s}`));
    const goal = [sh[0] + (s === 'l' ? 0.03 : -0.03), sh[1] - fwd, 0.03];
    out.push(ik(`3proxph_${s}`, [`elv_angle_${s}`, `shoulder_elv_${s}`, `shoulder_rot_${s}`, `elbow_flexion_${s}`, `flexion_${s}`], goal, 80, [1.3, 1.3, 0, 0.3, 0]).toFixed(3));
  }
  mj.mj_kinematics(m, d);
  const H = Array.from(d.xmat.subarray(head * 9, head * 9 + 9));
  const face = [H[0] * faceL[0] + H[1] * faceL[1] + H[2] * faceL[2], H[3] * faceL[0] + H[4] * faceL[1] + H[5] * faceL[2], H[6] * faceL[0] + H[7] * faceL[1] + H[8] * faceL[2]];
  const toe = Math.min(P(body('toes_r'))[2], P(body('toes_l'))[2]);
  console.log(`pitch ${pitch} nod ${nod}: pelvis z ${d.qpos[2].toFixed(2)} shoulder z ${P(body('humerus_r'))[2].toFixed(2)} head z ${P(head)[2].toFixed(2)} face dir z ${face[2].toFixed(2)} (0 = level, -1 = floor) hand err R/L ${out.join('/')} toes z ${toe.toFixed(2)}`);
}
