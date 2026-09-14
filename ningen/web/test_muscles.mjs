// Compare the JavaScript muscle driver with the Python one (reference.json from export_model.py).
import loadMujoco from '@mujoco/mujoco';
import { readFile } from 'node:fs/promises';
import { MuscleDriver } from './muscles.mjs';
const dir = process.argv[2];
const mj = await loadMujoco();
const vfs = new mj.MjVFS();
vfs.addBuffer('body.mjb', new Uint8Array(await readFile(`${dir}/myofullbody_physics.mjb`)));
const m = mj.MjModel.from_binary_path('body.mjb', vfs), d = new mj.MjData(m);
const ref = JSON.parse(await readFile(`${dir}/reference.json`, 'utf8'));
d.qpos.set(ref.qpos0); mj.mj_forward(m, d);
const drv = new MuscleDriver(mj, m, { iters: 80 });
drv.gains(d);
let dg = 0, db = 0;
for (let i = 0; i < m.nu; i++) { dg = Math.max(dg, Math.abs(drv.g[i] - ref.gain[i])); db = Math.max(db, Math.abs(drv.b[i] - ref.bias[i])); }
console.log('gain max diff', dg.toExponential(2), 'bias max diff', db.toExponential(2), 'indep', drv.indep.length);
const info = drv.step(d, ref.step.q_ref);
let dc = 0, da = 0;
for (let i = 0; i < m.nu; i++) dc = Math.max(dc, Math.abs(d.ctrl[i] - ref.step.ctrl[i]));
for (let k = 0; k < m.nv; k++) da = Math.max(da, Math.abs(d.qfrc_applied[k] - ref.step.qfrc_applied[k]));
console.log('ctrl max diff', dc.toFixed(4), 'applied max diff', da.toFixed(2), 'js', info, 'py', ref.step.info);
// timing of a control step with the default iterations, and a standing run
const drv2 = new MuscleDriver(mj, m);
d.qpos.set(ref.qpos0); d.qvel.fill(0); mj.mj_forward(m, d);
const q = Float64Array.from(ref.qpos0);
let tc = 0, tp = 0, last;
for (let k = 0; k < 300; k++) {
  const a = performance.now(); last = drv2.step(d, q); const b = performance.now();
  for (let s = 0; s < 5; s++) mj.mj_step(m, d);
  tc += b - a; tp += performance.now() - b;
}
console.log(`3 s standing: pelvis z ${d.xpos[m.body('pelvis').id * 3 + 2].toFixed(3)} head z ${d.xpos[m.body('head').id * 3 + 2].toFixed(3)}`, last);
console.log(`per 10 ms control: driver ${(tc / 300).toFixed(2)} ms + physics ${(tp / 300).toFixed(2)} ms = ${((tc + tp) / 300).toFixed(2)} ms`);
