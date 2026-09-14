"""Write the fixed MyoFullBody (body_model.py) as one MuJoCo binary for the browser,
plus reference numbers to check the JavaScript muscle code against.

  python export_model.py out_dir
"""
import json, os, sys
import numpy as np
import mujoco
from body_model import load
from muscles import MuscleDriver

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
m, d, _ = load()
mujoco.mj_saveModel(m, os.path.join(out, 'myofullbody.mjb'), None)
drv = MuscleDriver(m, root_limits=(3000.0, 1500.0))
g, b = drv.gains(d)
q_ref = d.qpos.copy()
q_ref[m.joint('elbow_flexion_r').qposadr[0]] += 0.6
info = drv.step(d, q_ref)
json.dump({
    'mujoco': mujoco.__version__, 'nq': m.nq, 'nv': m.nv, 'nu': m.nu, 'nbody': m.nbody,
    'qpos0': d.qpos.tolist(), 'gain': g.tolist(), 'bias': b.tolist(),
    'step': {'q_ref': q_ref.tolist(), 'ctrl': d.ctrl.tolist(), 'qfrc_applied': d.qfrc_applied.tolist(), 'info': info},
}, open(os.path.join(out, 'reference.json'), 'w'))
print('mujoco', mujoco.__version__, 'mjb', os.path.getsize(os.path.join(out, 'myofullbody.mjb')) // 1024, 'KB', info)
