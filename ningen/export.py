"""Pack a run for the browser viewer.

  python export.py run_dir out_dir

model.json   geoms (body, mesh, local pose, colour), muscles as chains of path sites fixed
             in their bodies (drawn as straight segments; wrapping surfaces are left out)
meshes.bin   per mesh: vertex count, face count, Float32 vertices, Uint32 faces
frames.bin   Float32 body positions + quaternions for every frame
run.json     per frame: muscle activation (0-255, base64), brain outputs, sensory inputs,
             motor program levels, support force, scene objects and label
"""
import base64, json, os, struct, sys
import numpy as np
import mujoco
from body_model import load

run_dir, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
m, d, _ = load()
R = json.load(open(os.path.join(run_dir, 'run.json')))
meta, fr = R['meta'], R['frames']

used = sorted({g['mesh'] for g in meta['geoms']})
remap = {mid: k for k, mid in enumerate(used)}
with open(os.path.join(out, 'meshes.bin'), 'wb') as f:
    f.write(struct.pack('<I', len(used)))
    for mid in used:
        va, vn = m.mesh_vertadr[mid], m.mesh_vertnum[mid]
        fa, fn = m.mesh_faceadr[mid], m.mesh_facenum[mid]
        f.write(struct.pack('<II', vn, fn))
        f.write(m.mesh_vert[va:va + vn].astype('<f4').tobytes())
        f.write(m.mesh_face[fa:fa + fn].astype('<u4').tobytes())

muscles = []
for a in range(m.nu):
    ti = int(m.actuator_trnid[a, 0])
    pts = []
    for w in range(m.tendon_adr[ti], m.tendon_adr[ti] + m.tendon_num[ti]):
        if m.wrap_type[w] == mujoco.mjtWrap.mjWRAP_SITE:
            sid = int(m.wrap_objid[w])
            pts.append([int(m.site_bodyid[sid]), m.site_pos[sid].round(5).tolist()])
    muscles.append({'name': m.actuator(a).name, 'path': pts})

model = {'geoms': [dict(g, mesh=remap[g['mesh']]) for g in meta['geoms']], 'muscles': muscles,
         'bodies': meta['bodies'], 'fps': meta['fps'], 'scenes': meta['scenes']}
json.dump(model, open(os.path.join(out, 'model.json'), 'w'))

pos = np.array(fr['body_pos'], dtype='<f4'); quat = np.array(fr['body_quat'], dtype='<f4')
np.concatenate([pos, quat], axis=2).astype('<f4').tofile(os.path.join(out, 'frames.bin'))
act = (np.clip(np.array(fr['act']), 0, 1) * 255).astype(np.uint8)
run = {'n': len(fr['t']), 'nbody': pos.shape[1], 't': fr['t'], 'brain': fr['brain'], 'inputs': fr['inputs'],
       'prog': fr['prog'], 'support': fr['support'], 'scene': fr['scene'],
       'act': base64.b64encode(act.tobytes()).decode(), 'nmuscle': act.shape[1]}
json.dump(run, open(os.path.join(out, 'run.json'), 'w'))
for f in sorted(os.listdir(out)):
    print(f, os.path.getsize(os.path.join(out, f)) // 1024, 'KB')
