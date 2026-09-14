import numpy as np, mujoco, myo_sim
from muscles import MuscleDriver
m, d = myo_sim.load('myofullbody'); mujoco.mj_forward(m, d)
drv = MuscleDriver(m); q_ref = d.qpos.copy(); steps = 5
dof = [m.joint(int(m.dof_jntid[k])).name for k in range(m.nv)]
# rerun step internals once at rest and after 0.3 s
for k in range(31):
    info = drv.step(d, q_ref)
    if k in (0, 30):
        s = drv.scratch; tau = s.qfrc_inverse.copy()
        J = drv.moments(d); g, b = drv.gains(d)
        prod = J.T @ (g * drv.u + b); res = tau - prod
        ix = drv.indep
        top = ix[np.argsort(-np.abs(res[ix]))[:10]]
        print('t', round(d.time, 2), 'unmet top', [(dof[j], round(float(tau[j]), 0), round(float(prod[j]), 0)) for j in top])
        # max muscle capacity per dof: sum of positive and negative moment * gain
        cap_pos = np.clip(J[:, top], 0, None).T @ g; cap_neg = np.clip(J[:, top], None, 0).T @ g
        print('   capacity +', np.round(cap_pos, 0), '\n   capacity -', np.round(cap_neg, 0))
        print('   root tau', np.round(tau[:6], 0), 'ncon', d.ncon)
    for _ in range(steps): mujoco.mj_step(m, d)
