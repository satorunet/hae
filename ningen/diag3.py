import numpy as np, mujoco, myo_sim
m, d = myo_sim.load('myofullbody'); mujoco.mj_forward(m, d)
for b in ['clavicle_r','clavphant_r','scapula_r','scapphant_r','humphant_r','humphant1_r','humerus_r','ulna_r','radius_r','lunate_r','femur_r','tibia_r','patella_r','torso','head','pelvis']:
    i = m.body(b).id; print(f'{b:12s} mass {m.body_mass[i]:8.3f} inertia {np.round(m.body_inertia[i],4)}')
j = m.joint('shoulder_elv_r'); print('shoulder_elv_r qpos0', m.qpos0[j.qposadr[0]], 'range', j.range, 'damping', m.dof_damping[j.dofadr[0]], 'stiffness', m.jnt_stiffness[j.id], 'armature', m.dof_armature[j.dofadr[0]])
print('passive at rest', np.round(d.qfrc_passive[j.dofadr[0]], 1), 'bias', np.round(d.qfrc_bias[j.dofadr[0]], 1), 'constraint', np.round(d.qfrc_constraint[j.dofadr[0]], 1))
for e in range(m.neq):
    if 'shoulder1_r2_r' == m.joint(m.eq_obj1id[e]).name or 'unrothum_r1_r' == m.joint(m.eq_obj1id[e]).name:
        print('eq', m.joint(m.eq_obj1id[e]).name, '<-', m.joint(m.eq_obj2id[e]).name if m.eq_obj2id[e] >= 0 else None, np.round(m.eq_data[e][:5], 3))
