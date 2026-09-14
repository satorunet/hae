// Seeded, step-limited IK for the right hand to the lips and to the scalp: how close does it get?
import loadMujoco from '@mujoco/mujoco';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const mj = await loadMujoco();
const vfs = new mj.MjVFS(); vfs.addBuffer('b.mjb', gunzipSync(await readFile('data/myofullbody.mjb.gz')));
const m = mj.MjModel.from_binary_path('b.mjb', vfs), kin = new mj.MjData(m);
for (const s of 'rl') kin.qpos[m.jnt_qposadr[m.jnt(`shoulder_elv_${s}`).id]] = 0.08;
mj.mj_forward(m, kin);
const q0 = Float64Array.from(kin.qpos);
const names = ['elv_angle_r', 'shoulder_elv_r', 'shoulder_rot_r', 'elbow_flexion_r'];
const jids = names.map((n) => m.jnt(n).id), dofs = jids.map((j) => m.jnt_dofadr[j]), qa = jids.map((j) => m.jnt_qposadr[j]);
const R = Float64Array.from(m.jnt_range);
console.log('ranges', names.map((n, i) => `${n} [${R[2 * jids[i]].toFixed(2)}, ${R[2 * jids[i] + 1].toFixed(2)}]`).join(' '));
const hand = m.body('3proxph_r').id, head = m.body('head').id;
const jacp = new mj.DoubleBuffer(3 * m.nv);
const H = Array.from(kin.xpos.subarray(head * 3, head * 3 + 3));
const goals = { mouth: [H[0] - 0.035, H[1] - 0.16, H[2] - 0.055], scalpR: [-0.095, 0.19 + 0.03, 1.72] };
for (const [gname, goal] of Object.entries(goals)) for (const seed of [[0, 0.08, 0, 0], [1.3, 1.0, 0, 1.8], [1.4, 1.6, 0.5, 2.1]]) {
  const q = seed.slice();
  let err;
  for (let it = 0; it < 60; it++) {
    kin.qpos.set(q0); qa.forEach((a, i) => (kin.qpos[a] = q[i]));
    mj.mj_kinematics(m, kin); mj.mj_comPos(m, kin);
    const p = Array.from(kin.xpos.subarray(hand * 3, hand * 3 + 3));
    const e = [goal[0] - p[0], goal[1] - p[1], goal[2] - p[2]]; err = Math.hypot(...e);
    mj.mj_jac(m, kin, jacp, null, p, hand);
    const J = jacp.GetView(), nv = m.nv, Js = dofs.map((k) => [J[k], J[nv + k], J[2 * nv + k]]);
    const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const c of Js) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) M[3 * r + s] += c[r] * c[s];
    for (let r = 0; r < 3; r++) M[4 * r] += 0.05 ** 2;
    const x = solve3(M, e);
    q.forEach((v, i) => {
      let dq = Js[i][0] * x[0] + Js[i][1] * x[1] + Js[i][2] * x[2];
      dq = Math.max(-0.15, Math.min(0.15, dq));
      q[i] = Math.min(R[2 * jids[i] + 1], Math.max(R[2 * jids[i]], v + dq));
    });
  }
  console.log(gname.padEnd(7), 'seed', JSON.stringify(seed), '-> q', q.map((v) => v.toFixed(2)).join(' '), 'error', err.toFixed(3));
}
function solve3(M, b) {
  const [a, bb, c, dd, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(dd * i - f * g), C = dd * h - e * g, det = a * A + bb * B + c * C || 1e-12;
  const inv = [A, -(bb * i - c * h), bb * f - c * e, B, a * i - c * g, -(a * f - c * dd), C, -(a * h - bb * g), a * e - bb * dd].map((v) => v / det);
  return [inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2], inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2], inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2]];
}
