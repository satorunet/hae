"""Export the NeuroMechFly v2 body (flygym 2.x) for the browser.

Writes, under ../nmf/:
  body.json   kinematic tree (bodies, hinge joints, neutral angles, geoms/colors),
              the baked PreprogrammedSteps tables (flygym's recorded walking steps),
              and the CPG parameters of flygym's tripod network
  meshes.bin.gz  the 69 body meshes, int16-quantized vertices + uint16 faces

The browser does its own forward kinematics (MuJoCo's rule: body pos/quat, then
each hinge joint in order), so it needs neither MuJoCo nor SciPy.

    pip install -e flygym   # https://github.com/NeLy-EPFL/flygym (Apache-2.0)
    python export_nmf.py
"""
import fnmatch
import gzip
import json
import struct
from pathlib import Path
import tempfile

import mujoco as mj
import numpy as np
import yaml
from flygym import assets_dir
from flygym.anatomy import ALL_SEGMENT_NAMES, AxisOrder, JointPreset, Skeleton
from flygym.compose import FlatGroundWorld, KinematicPosePreset, NeuroMechFly
from flygym.utils.math import Rotation3D
from flygym_demo.complex_terrain.preprogrammed import PreprogrammedSteps

OUT = Path(__file__).resolve().parent.parent / "nmf"
N_PHASE = 360


def segment_colors():
    """Representative RGBA per body segment, from flygym's visuals.yaml."""
    vis = yaml.safe_load(open(assets_dir / "model/neuromechfly/visuals.yaml"))
    colors = {}
    for p in vis.values():
        rgba = p["material"].get("rgba", [1, 1, 1, 1])
        tex = p.get("texture")
        if tex:
            rgb1 = tex.get("rgb1", [0.6] * 3)
            rgb = [(a + b) / 2 for a, b in zip(rgb1, tex.get("rgb2", rgb1))] if tex.get("builtin") == "gradient" else rgb1
        else:
            rgb = rgba[:3]
        pats = p["apply_to"]
        for pat in [pats] if isinstance(pats, str) else pats:
            for seg in fnmatch.filter(ALL_SEGMENT_NAMES, pat):
                colors[seg] = [round(float(c), 4) for c in (*rgb, rgba[3] if len(rgba) > 3 else 1.0)]
    return colors


def build():
    pose = KinematicPosePreset.NEUTRAL.get_pose_by_axis_order(AxisOrder.YAW_PITCH_ROLL)
    sk = Skeleton(axis_order=AxisOrder.YAW_PITCH_ROLL, joint_preset=JointPreset.ALL_BIOLOGICAL)
    fly = NeuroMechFly(name="nmf")
    fly.add_joints(sk, neutral_pose=pose)
    world = FlatGroundWorld()
    world.add_fly(fly, (0, 0, 0.5), Rotation3D("quat", (1, 0, 0, 0)))
    tmp = Path(tempfile.mkdtemp())
    world.save_xml_with_assets(tmp, "fly.xml")
    m = mj.MjModel.from_xml_path(str(tmp / "fly.xml"))
    d = mj.MjData(m)
    mj.mj_resetDataKeyframe(m, d, 0)
    mj.mj_forward(m, d)
    return m, d


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    m, d = build()
    colors = segment_colors()
    short = lambda s: s.split("/")[-1]

    bodies, meshes, blob = [], [], bytearray()
    geom_of_body = {int(m.geom_bodyid[g]): g for g in range(m.ngeom) if m.geom_dataid[g] >= 0}
    body_index = {}
    for b in range(1, m.nbody):
        name = short(m.body(b).name)
        body_index[b] = len(bodies)
        joints = []
        for j in range(m.body_jntadr[b], m.body_jntadr[b] + m.body_jntnum[b]):
            if m.jnt_type[j] != mj.mjtJoint.mjJNT_HINGE:
                continue
            joints.append({
                "name": short(m.joint(j).name),
                "axis": [round(float(x), 6) for x in m.jnt_axis[j]],
                "pos": [round(float(x), 6) for x in m.jnt_pos[j]],
                "q0": round(float(d.qpos[m.jnt_qposadr[j]]), 6),
            })
        entry = {
            "name": name,
            "parent": body_index.get(int(m.body_parentid[b]), -1),
            "pos": [round(float(x), 6) for x in m.body_pos[b]],
            "quat": [round(float(x), 6) for x in m.body_quat[b]],
            "joints": joints,
        }
        g = geom_of_body.get(b)
        if g is not None:
            mid = int(m.geom_dataid[g])
            va, vn = m.mesh_vertadr[mid], m.mesh_vertnum[mid]
            fa, fn = m.mesh_faceadr[mid], m.mesh_facenum[mid]
            V = m.mesh_vert[va:va + vn].astype(np.float64)
            F = m.mesh_face[fa:fa + fn].astype(np.uint16)
            lo, hi = V.min(0), V.max(0)
            sc = np.maximum(hi - lo, 1e-9) / 65535.0
            Q = np.round((V - lo) / sc - 32768).astype(np.int16)
            voff = len(blob)
            blob += Q.tobytes()
            foff = len(blob)
            blob += F.tobytes()
            while len(blob) % 4:
                blob += b"\0"
            # the tip of each tarsus5, in its body frame: the mesh vertex farthest from the joint
            Vb = (np.array([mj_quat_rotate(m.geom_quat[g], v) for v in V]) + m.geom_pos[g])
            meshes.append({"voff": voff, "vn": int(vn), "foff": foff, "fn": int(fn),
                           "lo": [float(x) for x in lo], "sc": [float(x) for x in sc]})
            entry["geom"] = {
                "mesh": len(meshes) - 1,
                "pos": [round(float(x), 6) for x in m.geom_pos[g]],
                "quat": [round(float(x), 6) for x in m.geom_quat[g]],
                "rgba": colors.get(name, [0.6, 0.45, 0.25, 1]),
            }
            if name.endswith("tarsus5"):
                tip = Vb[np.argmax(np.linalg.norm(Vb, axis=1))]
                entry["tip"] = [round(float(x), 5) for x in tip]
        bodies.append(entry)

    steps = PreprogrammedSteps()
    phases = np.linspace(0, 2 * np.pi, N_PHASE, endpoint=False)
    legs = {}
    for leg in steps.legs:
        A = np.array([steps.get_joint_angles(leg, p, 1.0) for p in phases])
        legs[leg] = {
            "angles": np.round(A, 5).ravel().tolist(),
            "neutral": [round(float(v), 5) for v in steps.neutral_pos[leg].ravel()],
            "swing": [float(x) for x in steps.swing_period[leg]],
        }
    # joint-name templates ("{leg}" -> lf, lm, ...) in the order of the table columns
    dofs = [("c_thorax" if p == "thorax" else "{leg}_" + p) + "-{leg}_" + c + "-" + ax
            for p, c, ax in steps.dofs_per_leg]
    phase_biases = np.pi * np.array([[0, 1, 0, 1, 0, 1], [1, 0, 1, 0, 1, 0]] * 3)
    out = {
        "source": "NeuroMechFly v2 via flygym 2.x (Apache-2.0), JointPreset.ALL_BIOLOGICAL, yaw-pitch-roll",
        "bodies": bodies,
        "meshes": meshes,
        "steps": {"legs": list(steps.legs), "dofs": dofs, "n": N_PHASE, "table": legs,
                  "recorded_step_duration_s": float(steps.duration)},
        "cpg": {"freq": 12.0, "amp": 1.0, "coupling": 10.0, "convergence": 20.0,
                "phase_biases": phase_biases.tolist()},
    }
    (OUT / "body.json").write_text(json.dumps(out, separators=(",", ":")))
    (OUT / "meshes.bin.gz").write_bytes(gzip.compress(bytes(blob), 9))
    print(f"{len(bodies)} bodies, {sum(len(b['joints']) for b in bodies)} joints, {len(meshes)} meshes, "
          f"{sum(x['fn'] for x in meshes)} faces, meshes.bin.gz from {len(blob)/1e6:.2f} MB")


def mj_quat_rotate(q, v):
    res = np.zeros(3)
    mj.mju_rotVecQuat(res, np.asarray(v, float), np.asarray(q, float))
    return res


if __name__ == "__main__":
    main()
