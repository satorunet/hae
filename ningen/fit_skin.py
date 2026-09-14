"""Put MakeHuman's skin (CC0) on MyoFullBody's skeleton.

  python fit_skin.py <makehuman dir with base.obj, default.mhskel, default_weights.mhw> out_dir

0. Sex: MakeHuman's macro targets make the base mesh a young adult man.
1. Frames: MakeHuman is decimetres, y up, facing +z; MuJoCo here is metres, z up,
   facing -y. A similarity (axes, one scale from standing height, hips on hips)
   brings the mesh over the skeleton.
2. Limbs: MakeHuman stands in an A-pose with bent elbows; MyoFullBody's arms hang
   straight. Each limb segment (hip->knee, knee->ankle, ankle->toes, sternum->shoulder,
   shoulder->elbow, elbow->wrist, wrist->middle knuckle, pelvis centre->hip) gets its
   own rotation and stretch so MakeHuman's joints land exactly on MyoFullBody's joint
   centres; the forearm and hand are also twisted so the palms face the same way.
   Every vertex takes these segment maps blended by MakeHuman's own skin weights, so
   the skin bends smoothly over the new joints.
3. The trunk skin is moved back onto the spine, and the head shrunk onto the skull.
4. Binding: MakeHuman's bones are mapped onto MyoFullBody bodies (upper arm -> humerus,
   forearm -> ulna/radius, fingers -> phalanges ...), up to four per vertex, for
   linear blend skinning in the browser.
5. The weights around the hips and in the hands are cleaned and smoothed (see there).
6. Soft tissue is added over the belly, flanks, buttocks and shoulders, plus morphs per side that
   swell as a hip flexes and as an arm is raised.

out: skin.bin.gz (positions, triangles, body indices, weights, left/right hip and shoulder morphs) and skin.json
"""
import gzip, json, os, struct, sys
import numpy as np
import mujoco
from body_model import load

MH, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------ MakeHuman
V, faces, group = [], [], None
for line in open(os.path.join(MH, 'base.obj')):
    if line.startswith('v '):
        V.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('g '):
        group = line.split()[1]
    elif line.startswith('f ') and group == 'body':
        faces.append([int(t.split('/')[0]) - 1 for t in line.split()[1:]])
V = np.array(V)
# A man: MakeHuman's base mesh sits halfway between the sexes (with breasts). Apply its macro
# targets for a young adult male - the three ethnic male-young targets a third each, and the
# universal male-young average muscle and weight - before anything is measured on the mesh.
def apply_target(name, weight):
    path = os.path.join(MH, name)
    if not os.path.exists(path):
        return 0
    n = 0
    for line in open(path):
        parts = line.split()
        if len(parts) == 4 and not line.startswith('#'):
            V[int(parts[0])] += weight * np.array([float(x) for x in parts[1:]]); n += 1
    return n
moved = sum(apply_target(f'{e}-male-young.target', 1 / 3) for e in ('african', 'asian', 'caucasian'))
moved += apply_target('universal-male-young-averagemuscle-averageweight.target', 1.0)
print('male targets moved', moved, 'vertex entries')
used = sorted({i for f in faces for i in f})
sk = json.load(open(os.path.join(MH, 'default.mhskel')))
W = json.load(open(os.path.join(MH, 'default_weights.mhw')))['weights']
J = {k: V[v].mean(0) for k, v in sk['joints'].items()}
head = lambda b: J[sk['bones'][b]['head']]
tail = lambda b: J[sk['bones'][b]['tail']]

# ------------------------------------------------------------------ MyoFullBody at rest
m, d, _ = load()
X = lambda name: d.xpos[m.body(name).id].copy()
skull = None
lo, hi = np.full(3, 9.0), np.full(3, -9.0)
for g in range(m.ngeom):
    if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH and m.geom_group[g] in (0, 1, 2):
        mid = m.geom_dataid[g]
        v = m.mesh_vert[m.mesh_vertadr[mid]:m.mesh_vertadr[mid] + m.mesh_vertnum[mid]]
        w = v @ d.geom_xmat[g].reshape(3, 3).T + d.geom_xpos[g]
        lo, hi = np.minimum(lo, w.min(0)), np.maximum(hi, w.max(0))
        if m.body(m.geom_bodyid[g]).name == 'head' and m.mesh(mid).name == 'hat_skull':
            skull = (w.min(0), w.max(0))

# ------------------------------------------------------------------ 1. similarity
AX = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)          # MH (x, y, z) -> MJ (x, -z, y)
mh_h = V[used, 1].max() - V[used, 1].min()
S = (hi[2] + 0.008) / mh_h                                          # skull top plus scalp, soles on the floor
hips_mh = (head('upperleg01.L') + head('upperleg01.R')) / 2
hips_mj = (X('femur_l') + X('femur_r')) / 2
T = hips_mj - S * AX @ hips_mh
sim = lambda p: (S * (AX @ np.asarray(p).T)).T + T
P0 = sim(V)                                                         # every vertex, globally placed


def rot_between(a, b):
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1 / (1 + c))


def twist_to(R, axis, ref_from, ref_to, amount=1.0):
    """Extra rotation about `axis` (after R) that turns R@ref_from toward ref_to."""
    n = axis / np.linalg.norm(axis)
    a = R @ ref_from; a -= n * (n @ a)
    b = ref_to - n * (n @ ref_to)
    if np.linalg.norm(a) < 1e-9 or np.linalg.norm(b) < 1e-9:
        return R
    a /= np.linalg.norm(a); b /= np.linalg.norm(b)
    ang = np.arctan2(n @ np.cross(a, b), a @ b) * amount
    K = np.array([[0, -n[2], n[1]], [n[2], 0, -n[0]], [-n[1], n[0], 0]])
    return (np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * K @ K) @ R


def segment_map(a_mh, b_mh, a_mj, b_mj, twist=None, amount=1.0):
    """Affine taking the (globally placed) MH segment a->b onto the MJ segment."""
    a0, b0 = sim(a_mh), sim(b_mh)
    u0 = b0 - a0
    R = rot_between(u0, b_mj - a_mj)
    if twist is not None:
        R = twist_to(R, b_mj - a_mj, *twist, amount=amount)
    k = np.linalg.norm(b_mj - a_mj) / np.linalg.norm(u0)
    n = u0 / np.linalg.norm(u0)
    D = np.eye(3) + (k - 1) * np.outer(n, n)                         # stretch along the bone only
    A = R @ D
    return lambda P: (A @ (P - a0).T).T + a_mj


maps = {}
ident = lambda P: P
for s, S_ in (('l', 'L'), ('r', 'R')):
    toe_mh = np.mean([head(f'toe{i}-1.{S_}') for i in range(1, 6)], axis=0)
    across_foot_mh = AX @ (head(f'toe5-1.{S_}') - head(f'toe1-1.{S_}'))
    across_foot_mj = np.array([1.0 if s == 'l' else -1.0, 0, 0])
    palm_mh = AX @ (head(f'finger5-1.{S_}') - head(f'finger2-1.{S_}'))
    palm_mj = X(f'5proxph_{s}') - X(f'2proxph_{s}')
    maps[f'pelvis.{S_}'] = segment_map(head(f'pelvis.{S_}'), head(f'upperleg01.{S_}'), sim(head(f'pelvis.{S_}')), X(f'femur_{s}'))
    thigh = segment_map(head(f'upperleg01.{S_}'), head(f'lowerleg01.{S_}'), X(f'femur_{s}'), X(f'tibia_{s}'))
    shin = segment_map(head(f'lowerleg01.{S_}'), head(f'foot.{S_}'), X(f'tibia_{s}'), X(f'talus_{s}'))
    foot = segment_map(head(f'foot.{S_}'), toe_mh, X(f'talus_{s}'), X(f'toes_{s}'), twist=(across_foot_mh, across_foot_mj))
    maps.update({f'upperleg01.{S_}': thigh, f'upperleg02.{S_}': thigh, f'lowerleg01.{S_}': shin, f'lowerleg02.{S_}': shin, f'foot.{S_}': foot})
    for b in sk['bones']:
        if b.startswith('toe') and b.endswith('.' + S_):
            maps[b] = foot
    shoulder = segment_map(head(f'clavicle.{S_}'), head(f'upperarm01.{S_}'), X(f'clavicle_{s}'), X(f'humerus_{s}'))
    maps[f'clavicle.{S_}'] = shoulder; maps[f'shoulder01.{S_}'] = shoulder
    upper = segment_map(head(f'upperarm01.{S_}'), head(f'lowerarm01.{S_}'), X(f'humerus_{s}'), X(f'ulna_{s}'))
    maps[f'upperarm01.{S_}'] = upper; maps[f'upperarm02.{S_}'] = upper
    maps[f'lowerarm01.{S_}'] = segment_map(head(f'lowerarm01.{S_}'), head(f'wrist.{S_}'), X(f'ulna_{s}'), X(f'lunate_{s}'), twist=(palm_mh, palm_mj), amount=0.5)
    maps[f'lowerarm02.{S_}'] = segment_map(head(f'lowerarm01.{S_}'), head(f'wrist.{S_}'), X(f'ulna_{s}'), X(f'lunate_{s}'), twist=(palm_mh, palm_mj))
    hand = segment_map(head(f'wrist.{S_}'), head(f'finger3-1.{S_}'), X(f'lunate_{s}'), X(f'3proxph_{s}'), twist=(palm_mh, palm_mj))
    for b in sk['bones']:
        if b.endswith('.' + S_) and (b.startswith('wrist') or b.startswith('metacarpal') or b.startswith('finger')):
            maps[b] = hand

# 3. trunk and head. MyoFullBody's spine sits further back than MakeHuman's (at the chest
# its spinous processes were 8 cm behind the skin): move the trunk skin back by height so
# the back lies 1.5 cm behind the spine, measured on the meshes (0 at the pelvis, 9.5 cm at the chest).
TRUNK_BACK = {'spine05': 0.01, 'spine04': 0.045, 'spine03': 0.07, 'spine02': 0.09, 'spine01': 0.095,
              'breast.L': 0.095, 'breast.R': 0.095, 'neck01': 0.095, 'neck02': 0.095}
# the rib cage is also deeper than MakeHuman's chest: after moving back, thicken the
# chest front to back about y = 0.215 (the middle of the rib cage)
CHEST_DEPTH = {'spine03': 1.08, 'spine02': 1.18, 'spine01': 1.18, 'breast.L': 1.18, 'breast.R': 1.18, 'neck01': 1.1}


def trunk_map(dy, k, yc=0.215):
    return lambda P: np.column_stack([P[:, 0], yc + k * (P[:, 1] + dy - yc), P[:, 2]])


for b, dy in TRUNK_BACK.items():
    maps[b] = trunk_map(dy, CHEST_DEPTH.get(b, 1.0))
# The skull is smaller than MakeHuman's head (17 vs 22 cm front to back): scale the head about
# the top of the neck so the scalp clears the skull by 8 mm, and put the nose 2 cm in front of it.
headbones = {b for b in sk['bones'] if b in ('head', 'jaw', 'neck03') or any(b.startswith(p) for p in
             ('eye', 'oculi', 'orbicularis', 'oris', 'levator', 'risorius', 'temporalis', 'special', 'tongue'))}
pivot = sim(head('head'))
hv = sorted({vi for vi, w in W['head'] if w > 0.5})
# the scale that puts the top of the scalp 8 mm above the top of the skull
K_HEAD = (skull[1][2] + 0.008 - pivot[2]) / (P0[hv, 2].max() - pivot[2])
scaled = pivot + K_HEAD * (P0[hv] - pivot)
sk_lo, sk_hi = skull
shift = np.array([(sk_lo[0] + sk_hi[0]) / 2 - scaled[:, 0].mean(), (sk_lo[1] - 0.02) - scaled[:, 1].min(), 0.0])
head_map = lambda P: pivot + K_HEAD * (P - pivot) + shift
for b in headbones:
    maps[b] = head_map

# 2b. blend: each vertex = sum over its MH bones of weight * that bone's map (global placement if none)
nV = len(V)
acc = np.zeros((nV, 3)); wsum = np.zeros(nV)
for b, lst in W.items():
    f = maps.get(b, ident)
    idx = np.array([vi for vi, w in lst]); ws = np.array([w for vi, w in lst])
    acc[idx] += ws[:, None] * f(P0[idx])
    wsum[idx] += ws
P = np.where(wsum[:, None] > 0, acc / np.maximum(wsum, 1e-9)[:, None], P0)

# ------------------------------------------------------------------ 4. binding to MuJoCo bodies
def mj_body(b):
    side = {'L': 'l', 'R': 'r'}.get(b[-1]) if b[-2:] in ('.L', '.R') else None
    base = b[:-2] if side else b
    if base in ('root', 'pelvis'): return 'pelvis'
    if base == 'spine05': return 'lumbar5'
    if base == 'spine04': return 'lumbar3'
    if base == 'spine03': return 'lumbar1'
    if base in ('spine02', 'spine01', 'breast', 'neck01'): return 'torso'
    if b in headbones or base in ('neck02', 'head'): return 'head'
    if base == 'clavicle': return f'clavicle_{side}'
    if base == 'shoulder01': return f'scapula_{side}'
    if base.startswith('upperarm'): return f'humerus_{side}'
    if base == 'lowerarm01': return f'ulna_{side}'
    if base == 'lowerarm02': return f'radius_{side}'
    if base == 'wrist': return f'lunate_{side}'
    if base.startswith('metacarpal'): return f"{['secondmc', 'thirdmc', 'fourthmc', 'fifthmc'][int(base[-1]) - 1]}_{side}"
    if base.startswith('finger1'): return f"{['firstmc', 'proximal_thumb', 'distal_thumb'][int(base[-1]) - 1]}_{side}"
    if base.startswith('finger'):
        n, k = int(base[6]), int(base[-1])
        return f"{n}proxph_{side}" if k == 1 else f"midph{n}_{side}" if k == 2 else f"distph{n}_{side}"
    if base.startswith('upperleg'): return f'femur_{side}'
    if base.startswith('lowerleg'): return f'tibia_{side}'
    if base == 'foot': return f'calcn_{side}'
    if base.startswith('toe'): return f'toes_{side}'
    raise KeyError(b)

infl = [dict() for _ in range(nV)]
for b, lst in W.items():
    bid = m.body(mj_body(b)).id
    for vi, w in lst:
        infl[vi][bid] = infl[vi].get(bid, 0) + w

# 5. Clean the weights where the hips bend. MakeHuman's thigh weights reach up over the buttocks
# and the lower belly, where the same skin is also bound to the lumbar spine; flexing the hip
# 80 degrees on all fours then tore the lower back open and folded the belly in. So:
#   * no vertex follows both a thigh and the spine - the spine's share goes to the pelvis;
#   * above the hip joint the thigh's share fades out over 15 cm, into the pelvis;
#   * the weights of the hip region (pelvis, thighs, lumbar spine) and of each hand are
#     smoothed over the mesh, so a bend spreads over a band of skin instead of one seam.
NB_ = m.nbody
Wd = np.zeros((nV, NB_))
for vi, dct in enumerate(infl):
    for bid, w in dct.items():
        Wd[vi, bid] += w
bid = lambda n: m.body(n).id
PELVIS, FEMUR = bid('pelvis'), [bid('femur_l'), bid('femur_r')]
SPINE = [bid(n) for n in ('lumbar5', 'lumbar3', 'lumbar1')]
hip_z = (X('femur_l')[2] + X('femur_r')[2]) / 2
for fb in FEMUR:
    both = (Wd[:, fb] > 0) & (Wd[:, SPINE].sum(1) > 0)
    Wd[both, PELVIS] += Wd[both][:, SPINE].sum(1); Wd[np.ix_(both, SPINE)] = 0
    above = np.clip((P[:, 2] - (hip_z + 0.02)) / 0.15, 0, 1)
    moved = Wd[:, fb] * above
    Wd[:, fb] -= moved; Wd[:, PELVIS] += moved
nbrs = [set() for _ in range(nV)]
for f in faces:
    for i in range(4):
        nbrs[f[i]].add(f[(i + 1) % 4]); nbrs[f[(i + 1) % 4]].add(f[i])
def smooth_region(region, iters):
    region = np.array(region)
    inside = [v for v in np.where((Wd[:, region].sum(1) > 0.999 * Wd.sum(1)) & (Wd.sum(1) > 0))[0] if nbrs[v]]
    idx = [np.array(sorted(nbrs[v]), dtype=int) for v in inside]
    for _ in range(iters):
        new = Wd[:, region].copy()
        for v, nb in zip(inside, idx):
            new[v] = 0.5 * Wd[v, region] + 0.5 * Wd[nb][:, region].mean(0)
        Wd[:, region] = new
    return len(inside)
n_hip = smooth_region([PELVIS, *FEMUR, *SPINE, bid('torso')], 25)
hand_bodies = {S: [i for i in range(NB_) if m.body(i).name.endswith('_' + S) and any(k in m.body(i).name for k in ('ph', 'mc', 'thumb', 'lunate', 'capitate', 'radius', 'ulna'))] for S in 'lr'}
n_hand = sum(smooth_region(hand_bodies[S], 6) for S in 'lr')
infl = [{int(b_): float(w) for b_, w in enumerate(row) if w > 1e-4} for row in Wd]
print('head scale', round(K_HEAD, 3)); print('smoothed weights on', n_hip, 'hip-region and', n_hand, 'hand vertices')

remap = {old: new for new, old in enumerate(used)}
nv = len(used)
# 6. Flesh. MakeHuman's default body is lean, and bending at the hips on all fours showed it:
# the belly folded flat and the buttocks went angular, as if the hip joint poked through. Add
# soft tissue along the outward normal - a little belly, love handles, fuller buttocks and groin -
# and a second layer that only swells while a hip is flexed (a morph target per side, driven by
# the page from the hip angle) to fill the crease in front and round out the buttock behind.
Pu = P.copy()
nrm = np.zeros_like(Pu)
for f in faces:
    a_, b_, c_, e_ = f
    n1 = np.cross(Pu[b_] - Pu[a_], Pu[c_] - Pu[a_]); n2 = np.cross(Pu[c_] - Pu[a_], Pu[e_] - Pu[a_])
    for v in f: nrm[v] += n1 + n2
nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
def bump(x, lo, peak, hi):
    x = np.asarray(x)
    up = np.clip((x - lo) / max(1e-9, peak - lo), 0, 1); down = np.clip((hi - x) / max(1e-9, hi - peak), 0, 1)
    t = np.where(x < peak, up, down)
    return t * t * (3 - 2 * t)
armish = np.zeros(nV, bool)
arm_ids = {i for i in range(m.nbody) if any(k in m.body(i).name for k in ('humerus', 'ulna', 'radius', 'lunate', 'capitate', 'ph', 'mc', 'thumb', 'scaphoid', 'pisiform', 'triquetrum', 'trapez', 'hamate'))}
for vi, dct in enumerate(infl):
    armish[vi] = sum(w for b_, w in dct.items() if b_ in arm_ids) > 0.3 * max(1e-9, sum(dct.values()))
xc = X('pelvis')[0]
front = np.clip(-nrm[:, 1], 0, 1); back = np.clip(nrm[:, 1], 0, 1); side = np.clip(np.abs(nrm[:, 0]), 0, 1)
z = Pu[:, 2]
# only a thin layer is always there; most of the soft tissue appears when the hips bend (below),
# so the waist is lean when kneeling up or standing and bunches when folded on all fours
fat = (0.006 * bump(z, 0.92, 1.05, 1.22) * front          # belly
       + 0.010 * bump(z, 0.76, 0.90, 1.04) * back          # buttocks
       + 0.004 * bump(z, 0.86, 0.92, 0.99) * front)        # groin
fat[armish] = 0
fill = (0.035 * bump(z, 0.82, 0.90, 0.99) * front          # the crease in front of the hip
        + 0.030 * bump(z, 0.94, 1.03, 1.16) * front        # lower belly bunching up
        + 0.015 * bump(z, 0.97, 1.07, 1.17) * side         # love handles pushed out
        + 0.030 * bump(z, 0.76, 0.90, 1.04) * back)        # the buttock rounding over the joint
fill[armish] = 0
# the shoulders: a rounder deltoid and a fuller upper arm, and (morph) the armpit and the front
# and back of the shoulder filling out as the arm is raised
near = lambda c, r: np.clip(1 - np.linalg.norm(Pu - c, axis=1) / r, 0, 1) ** 2
humerus_w = {side_: np.array([dct.get(m.body(f'humerus_{side_.lower()}').id, 0) / max(1e-9, sum(dct.values())) for dct in infl]) for side_ in 'LR'}
SHOULDER_FILL = {}
for side_ in 'LR':
    sh = X(f'humerus_{side_.lower()}'); out_ = np.array([1.0 if side_ == 'L' else -1.0, 0, 0])
    deltoid = 0.012 * near(sh + 0.035 * out_ + [0, 0, 0.02], 0.13)
    upper = 0.006 * humerus_w[side_] * bump(z, 1.18, 1.32, 1.46)
    fat = fat + deltoid + upper
    pit = 0.025 * near(sh - 0.05 * out_ + [0, 0, -0.09], 0.11) + 0.015 * near(sh + [0, -0.07, -0.02], 0.1) + 0.015 * near(sh + [0, 0.07, -0.02], 0.1)
    SHOULDER_FILL[side_] = nrm * pit[:, None]
# the mouth: MakeHuman's jaw weights opened about the jaw hinge (0.4 rad), as a morph the page
# plays for chewing and for the dabbing "proboscis"
# (the lower lip hangs off the jaw on its own bones - oris01 in the middle, oris07 at the corners -
# so their weights open with it; left out, the chin dropped and the lips stayed shut)
jaw_w = np.zeros(nV)
for bone in ('jaw', 'oris01', 'oris07.L', 'oris07.R'):
    for vi, w in W[bone]:
        jaw_w[vi] += w
jaw_w = np.minimum(jaw_w, 1.0)
hinge = head_map(sim(head('jaw'))[None])[0]
th = 0.45
Rx = np.array([[1, 0, 0], [0, np.cos(th), -np.sin(th)], [0, np.sin(th), np.cos(th)]])
MOUTH = ((Pu - hinge) @ Rx.T + hinge - Pu) * jaw_w[:, None]
P = Pu + nrm * fat[:, None]
FILL = {side_: (nrm * (fill * ((Pu[:, 0] > xc) if side_ == 'L' else (Pu[:, 0] <= xc)))[:, None]) for side_ in 'LR'}
print('flesh: up to', round(float(fat.max()) * 100, 1), 'cm static,', round(float(fill.max()) * 100, 1), 'cm when the hip bends')
pos = P[used].astype('<f4')
bi = np.zeros((nv, 4), '<u1'); bw = np.zeros((nv, 4), '<u1')
for new, old in enumerate(used):
    top = sorted(infl[old].items(), key=lambda kv: -kv[1])[:4] or [(m.body('torso').id, 1.0)]
    tot = sum(w for _, w in top)
    ws = [int(round(255 * w / tot)) for _, w in top]
    ws[0] += 255 - sum(ws)
    for k, ((bid, _), w) in enumerate(zip(top, ws)):
        bi[new, k] = bid; bw[new, k] = w
tris = []
for f in faces:
    a, b_, c, e = (remap[i] for i in f)
    tris += [a, b_, c, a, c, e]
tris = np.array(tris, '<u2')
with gzip.open(os.path.join(OUT, 'skin.bin.gz'), 'wb', 9) as fh:
    fh.write(struct.pack('<II', nv, len(tris) // 3))
    fh.write(pos.tobytes()); fh.write(tris.tobytes()); fh.write(bi.tobytes()); fh.write(bw.tobytes())
    for side_ in 'LR':                                    # hip-flexion morphs, left then right (float32 xyz per vertex)
        fh.write(FILL[side_][used].astype('<f4').tobytes())
    for side_ in 'LR':                                    # arm-raising morphs, left then right
        fh.write(SHOULDER_FILL[side_][used].astype('<f4').tobytes())
    fh.write(MOUTH[used].astype('<f4').tobytes())         # mouth opening
eyes = {S_: head_map(sim(head(f'eye.{S_}'))[None])[0].round(4).tolist() for S_ in 'LR'}
mouth_c = head_map(sim((head('oris01') + head('oris05')) / 2)[None])[0].round(4).tolist()
json.dump({'vertices': nv, 'triangles': len(tris) // 3, 'eyes': eyes, 'eyeRadius': round(0.012, 4), 'mouth': mouth_c,
           'jawHinge': hinge.round(4).tolist(), 'jawAngle': th,
           'rest': {'xpos': d.xpos.round(5).tolist(), 'xquat': d.xquat.round(6).tolist()},
           'license': 'MakeHuman base mesh, default skeleton and weights: CC0 (makehumancommunity/makehuman)'},
          open(os.path.join(OUT, 'skin.json'), 'w'))
print('scale', round(S, 4), 'vertices', nv, 'triangles', len(tris) // 3,
      'skin bbox', P[used].min(0).round(3), P[used].max(0).round(3), 'skeleton bbox', lo.round(3), hi.round(3))
