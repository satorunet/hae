import time, numpy as np, mujoco, myo_sim
from muscles import MuscleDriver
m, d = myo_sim.load('myofullbody'); mujoco.mj_forward(m, d)
drv = MuscleDriver(m)
dofname = []
for j in range(m.njnt):
    n = {0: 6, 1: 3}.get(int(m.jnt_type[j]), 1)
    dofname += [m.joint(j).name + (f'[{k}]' if n > 1 else '') for k in range(n)]
t = time.time(); err = np.zeros(m.nv); s = drv.scratch
s.qpos[:] = d.qpos; s.qvel[:] = 0; s.qacc[:] = 0; mujoco.mj_inverse(m, s); tau = s.qfrc_inverse.copy(); t1 = time.time()
J = drv.moments(d); t2 = time.time(); g, b = drv.gains(d); t3 = time.time()
print('inverse ms', round((t1-t)*1e3,1), 'moments ms', round((t2-t1)*1e3,1), 'gains ms', round((t3-t2)*1e3,1))
# which dofs have no muscle at all
nomus = [dofname[k] for k in range(6, m.nv) if np.abs(J[:, k]).max() < 1e-9]
print('dofs with no muscle moment:', len(nomus), nomus)
print('largest |tau| dofs at rest:', [(dofname[k], round(float(tau[k]),1)) for k in np.argsort(-np.abs(tau))[:15]])
print('eq constraint dofs? eq obj1 joints:', [m.joint(m.eq_obj1id[e]).name for e in range(m.neq)][:51])
print('floor contact at start ncon', d.ncon, 'min foot z', min(d.geom_xpos[i][2] for i in range(m.ngeom) if 'foot' in m.geom(i).name))
