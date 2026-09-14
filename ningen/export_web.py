"""Bone meshes and muscle paths for the real-time page (ningen/web/).

  python export_web.py web/data

bones.bin.gz  per mesh: uint32 nvert, uint32 nface, float32 min[3], float32 scale[3],
              uint16 vertices (quantized to the mesh's box), uint16/uint32 faces
body.json     visual geoms (body id, mesh, local pose, colour) and each muscle's
              path sites (body id, local position) - straight segments between them - and
              its peak isometric force, from which the page sizes the muscle
"""
import gzip, json, os, struct, sys
import numpy as np
import mujoco
from body_model import load

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
m, d, _ = load()
vis = [g for g in range(m.ngeom) if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH and m.geom_group[g] in (0, 1, 2)]
used = sorted({int(m.geom_dataid[g]) for g in vis})
remap = {mid: k for k, mid in enumerate(used)}
buf = bytearray(struct.pack('<I', len(used)))
for mid in used:
    va, vn = m.mesh_vertadr[mid], m.mesh_vertnum[mid]
    fa, fn = m.mesh_faceadr[mid], m.mesh_facenum[mid]
    v = m.mesh_vert[va:va + vn].astype(np.float64)
    lo, hi = v.min(0), v.max(0)
    scale = np.maximum(hi - lo, 1e-9) / 65535.0
    q = np.round((v - lo) / scale).astype('<u2')
    faces = m.mesh_face[fa:fa + fn]
    buf += struct.pack('<II', vn, fn) + lo.astype('<f4').tobytes() + scale.astype('<f4').tobytes() + q.tobytes()
    buf += faces.astype('<u2' if vn < 65536 else '<u4').tobytes()
open(os.path.join(out, 'bones.bin.gz'), 'wb').write(gzip.compress(bytes(buf), 9))

muscles = []
for a in range(m.nu):
    ti = int(m.actuator_trnid[a, 0])
    pts = []
    for w in range(m.tendon_adr[ti], m.tendon_adr[ti] + m.tendon_num[ti]):
        if m.wrap_type[w] == mujoco.mjtWrap.mjWRAP_SITE:
            sid = int(m.wrap_objid[w])
            pts.append([int(m.site_bodyid[sid]), [round(float(x), 5) for x in m.site_pos[sid]]])
    # peak isometric force (N): gainprm[2], or scale / acc0 when it is left to MuJoCo
    f0 = m.actuator_gainprm[a, 2] if m.actuator_gainprm[a, 2] > 0 else m.actuator_gainprm[a, 3] / max(1e-9, m.actuator_acc0[a])
    muscles.append({'name': m.actuator(a).name, 'path': pts, 'f0': round(float(f0), 1)})
body = {
    'geoms': [{'body': int(m.geom_bodyid[g]), 'mesh': remap[int(m.geom_dataid[g])],
               'pos': [round(float(x), 5) for x in m.geom_pos[g]], 'quat': [round(float(x), 5) for x in m.geom_quat[g]]} for g in vis],
    'muscles': muscles,
    'bodies': [m.body(i).name for i in range(m.nbody)],
}
json.dump(body, open(os.path.join(out, 'body.json'), 'w'))
for f in ('bones.bin.gz', 'body.json'):
    print(f, os.path.getsize(os.path.join(out, f)) // 1024, 'KB')
