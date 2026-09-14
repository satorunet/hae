"""The physics-only model for the browser: body_model.py without its visual meshes.

Bone meshes are drawn by three.js from their own file; MuJoCo only needs the
bodies, joints, muscles, wrapping objects and collision shapes. Masses and
inertias are checked to be unchanged.

  python export_physics.py out_dir
"""
import os, sys
import numpy as np
import mujoco
import myo_sim
from body_model import PHANTOMS

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
spec = myo_sim.load_spec('myofullbody')
for b in spec.bodies:
    if b.name.rsplit('_', 1)[0] in PHANTOMS:
        b.inertia = [1e-6, 1e-6, 1e-6]
        b.explicitinertial = True
full = spec.compile()
# MyoFullBody has no neck: the head is welded to the torso. On all fours that leaves the face
# looking at the floor, so give the head two hinges at the base of the skull - nod (about the
# body's left-right axis) and turn (about its long axis). No muscle crosses them in the model;
# the page drives them with the driver's small reserve torques and says so.
d0 = mujoco.MjData(full); mujoco.mj_forward(full, d0)
hid = full.body('head').id
Rh = d0.xmat[hid].reshape(3, 3)
head = spec.body('head')
# the nod (positive raises the face; checked on screen) turns about the base of the neck (C7-T1, measured on the vertebra meshes at rest), so raising
# the face on all fours lifts the whole head above the shoulders; the turn is at the skull
NECK_BASE = np.array([-0.025, 0.225, 1.50])
for name, world_axis, rng, at in (('neck_nod', [-1, 0, 0], [-0.5, 1.5], NECK_BASE), ('neck_turn', [0, 0, 1], [-1.1, 1.1], d0.xpos[hid])):
    j = head.add_joint()
    j.name = name; j.type = mujoco.mjtJoint.mjJNT_HINGE
    j.axis = (Rh.T @ np.array(world_axis, float)).tolist(); j.pos = (Rh.T @ (at - d0.xpos[hid])).tolist()
    j.range = rng; j.limited = mujoco.mjtLimited.mjLIMITED_TRUE
    j.damping = [0.4, 0, 0]; j.armature = 0.005
# Hands that touch. MyoFullBody's hands have only visual meshes, so rubbed hands passed through
# each other and palms through the floor. Give each metacarpal and phalanx a capsule fitted to its
# bone mesh (principal axis, length, thickness), the head an ellipsoid over the skull, and let
# them collide by explicit pairs only: left hand with right hand, hands with the floor, hands with
# the head (a hand never collides with its own forearm, which would fight the joint).
HAND_BONES = ['firstmc', 'secondmc', 'thirdmc', 'fourthmc', 'fifthmc', 'proximal_thumb', 'distal_thumb'] + \
    [f'{k}proxph' for k in range(2, 6)] + [f'midph{k}' for k in range(2, 6)] + [f'distph{k}' for k in range(2, 6)]
dF = mujoco.MjData(full); mujoco.mj_forward(full, dF)
def body_mesh_points(body_name):
    bid_ = full.body(body_name).id
    Rb, xb = dF.xmat[bid_].reshape(3, 3), dF.xpos[bid_]
    pts = []
    for g in range(full.ngeom):
        if full.geom_bodyid[g] == bid_ and full.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH:
            mid = full.geom_dataid[g]
            v = full.mesh_vert[full.mesh_vertadr[mid]:full.mesh_vertadr[mid] + full.mesh_vertnum[mid]]
            w = v @ dF.geom_xmat[g].reshape(3, 3).T + dF.geom_xpos[g]
            pts.append((w - xb) @ Rb)                               # into the body frame
    return np.concatenate(pts) if pts else None
hand_geoms = {'l': [], 'r': []}
for side in 'lr':
    for bone in HAND_BONES:
        pts = body_mesh_points(f'{bone}_{side}')
        if pts is None or len(pts) < 10:
            continue
        c = pts.mean(0); u, sv, vt = np.linalg.svd(pts - c, full_matrices=False)
        axis = vt[0]; proj = (pts - c) @ axis
        across = np.linalg.norm((pts - c) - np.outer(proj, axis), axis=1)
        r = float(np.clip(np.percentile(across, 80), 0.004, 0.012))
        half = max(0.0, (proj.max() - proj.min()) / 2 - r)
        mid_ = c + axis * (proj.max() + proj.min()) / 2
        gname = f'touch_{bone}_{side}'
        g = spec.body(f'{bone}_{side}').add_geom()
        g.name = gname; g.type = mujoco.mjtGeom.mjGEOM_CAPSULE
        g.fromto = np.concatenate([mid_ - axis * half, mid_ + axis * half]).tolist(); g.size = [r, 0, 0]
        g.contype = 0; g.conaffinity = 0; g.group = 3; g.rgba = [0.8, 0.5, 0.4, 0]
        hand_geoms[side].append(gname)
skull = body_mesh_points('head')
hc = (skull.max(0) + skull.min(0)) / 2; hr = (skull.max(0) - skull.min(0)) / 2 + 0.01
g = spec.body('head').add_geom()
g.name = 'touch_head'; g.type = mujoco.mjtGeom.mjGEOM_ELLIPSOID; g.pos = hc.tolist(); g.size = hr.tolist()
g.contype = 0; g.conaffinity = 0; g.group = 3; g.rgba = [0, 0, 0, 0]
pairs = [(a_, b_) for a_ in hand_geoms['l'] for b_ in hand_geoms['r']]
pairs += [(h_, 'floor') for sd in 'lr' for h_ in hand_geoms[sd]] + [(h_, 'touch_head') for sd in 'lr' for h_ in hand_geoms[sd]]
for a_, b_ in pairs:
    pr = spec.add_pair()
    pr.geomname1 = a_; pr.geomname2 = b_; pr.condim = 3
print('hand capsules', len(hand_geoms['l']), '+', len(hand_geoms['r']), 'contact pairs', len(pairs))

# freeze every body's inertial as compiled, then drop mesh geoms that do not collide
for b in spec.bodies:
    if b.name == 'world':
        continue
    i = full.body(b.name).id
    b.mass = float(full.body_mass[i]); b.ipos = full.body_ipos[i].tolist(); b.iquat = full.body_iquat[i].tolist()
    b.inertia = full.body_inertia[i].tolist(); b.fullinertia = [np.nan] * 6; b.explicitinertial = True
dropped = 0
for g in list(spec.geoms):
    if g.type == mujoco.mjtGeom.mjGEOM_MESH and g.contype == 0 and g.conaffinity == 0:
        spec.delete(g); dropped += 1
for msh in list(spec.meshes):
    spec.delete(msh)
for tex in spec.textures:                       # floor/backdrop images: replace with 1-pixel flat textures
    tex.file = ''; tex.content_type = ''
    tex.builtin = mujoco.mjtBuiltin.mjBUILTIN_FLAT
    tex.width = tex.height = 1
    tex.cubefiles = [''] * 6
m = spec.compile()
assert m.nbody == full.nbody and m.nu == full.nu and m.nv == full.nv + 2
dm = np.abs(m.body_mass - full.body_mass).max(); di = np.abs(m.body_inertia - full.body_inertia).max()
path = os.path.join(out, 'myofullbody_physics.mjb')
mujoco.mj_saveModel(m, path, None)
print('dropped geoms', dropped, 'meshes left', m.nmesh, 'mass diff', dm, 'inertia diff', di, 'size', os.path.getsize(path) // 1024, 'KB')
