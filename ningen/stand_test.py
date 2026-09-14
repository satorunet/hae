# Can the muscles hold the model standing in its initial pose? Reports residuals and speed.
import time, numpy as np, mujoco
from muscles import MuscleDriver
from body_model import load
m, d, _ = load()
import sys
kw = dict(a.split('=') for a in sys.argv[1:])
drv = MuscleDriver(m, root_limits=(3000.0, 1500.0), kp=float(kw.get('kp', 120)), kd=float(kw.get('kd', 22)), instant=kw.get('instant') == '1', mode=kw.get('mode', 'bias'))
print(kw)
q_ref = d.qpos.copy()
steps = int(0.01 / m.opt.timestep)
t0 = time.time(); log = []
for k in range(300):                  # 3 s
    info = drv.step(d, q_ref)
    for _ in range(steps): mujoco.mj_step(m, d)
    if k % 50 == 49:
        up = d.body('torso').xmat.reshape(3, 3)[:, 2]
        print(f"t={d.time:.2f} pelvis z={d.body('pelvis').xpos[2]:.3f} head z={d.body('head').xpos[2]:.3f} "
              f"root F={info['root_force']:.0f}N T={info['root_torque']:.0f}Nm "
              f"reserve={info['reserve']:.1f} unmet={info['unmet']:.1f} effort={info['effort']:.3f} ncon={d.ncon}")
print('wall s per sim s', round((time.time() - t0) / 3, 2))
top = np.argsort(-drv.u)[:12]
print('most active muscles', [(m.actuator(i).name, round(float(drv.u[i]), 2)) for i in top])
