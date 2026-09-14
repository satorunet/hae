import numpy as np, mujoco
from body_model import load
m, d, _ = load(); q0 = d.qpos.copy()
def probe(joint, val, body, label):
    d.qpos[:] = q0; a = m.joint(joint).qposadr[0]; d.qpos[a] += val; mujoco.mj_kinematics(m, d)
    p = d.body(body).xpos.copy(); d.qpos[:] = q0; mujoco.mj_kinematics(m, d); p0 = d.body(body).xpos.copy()
    print(f'{joint:16s} {val:+.2f} -> {body:10s} moves {np.round(p - p0, 3)}  ({label}; forward=-y, up=+z)', 'range', np.round(m.joint(joint).range, 2))
probe('flex_extension', -0.35, 'head', 'lean?')
probe('flex_extension', +0.35, 'head', 'lean?')
probe('hip_flexion_r', 0.9, 'tibia_r', 'thigh forward?')
probe('knee_angle_r', -1.3, 'talus_r', 'knee bend?')
probe('knee_angle_r', 1.3, 'talus_r', 'knee bend?')
probe('ankle_angle_r', 0.45, 'toes_r', 'ankle')
probe('shoulder_elv_r', 1.2, '3proxph_r', 'arm raise')
probe('elbow_flexion_r', 1.5, '3proxph_r', 'elbow bend')
