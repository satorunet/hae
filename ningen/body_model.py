"""MyoFullBody as used here, with two fixes to the composed model:

* the massless "phantom" bodies of the shoulder chain (clavphant, scapphant,
  humphant, humphant1) carry an inertia of 1 kg m^2 each - six times the torso's -
  which makes every arm movement fight a flywheel; they get a negligible one;
* the arms hang exactly on shoulder_elv's lower limit (0 rad), so the rest pose
  is nudged 0.08 rad inside it.
"""
import numpy as np
import mujoco
import myo_sim

PHANTOMS = ('clavphant', 'scapphant', 'humphant', 'humphant1')


def load():
    spec = myo_sim.load_spec('myofullbody')
    for b in spec.bodies:
        if b.name.rsplit('_', 1)[0] in PHANTOMS:
            b.inertia = [1e-6, 1e-6, 1e-6]
            b.explicitinertial = True
    m = spec.compile()
    d = mujoco.MjData(m)
    for side in 'rl':
        j = m.joint(f'shoulder_elv_{side}')
        d.qpos[j.qposadr[0]] = 0.08
    mujoco.mj_forward(m, d)
    return m, d, spec
