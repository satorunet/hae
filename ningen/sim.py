"""A fly's brain in a human body: one run of the scenes, recorded for playback.

  python sim.py out_dir [seconds]

Loop (every 10 ms of body time, the brain every 20 ms):
  senses   the scene -> the fly's sensory channels (ningen/brain.mjs):
             sugar  : sugar within 3 cm of the lips (labellar sugar neurons)
             bitter : the same for the bitter cube
             headL/R: dust resting on the left / right half of the head (head bristles)
             loomL/R: how fast a dark ball grows in the eyes' view, by side (LC4/LPLC2)
  brain    FlyWire whole-brain model, 20 ms at a time
  behaviour  the descending/motor neurons pick a motor program
             MN9 (proboscis motor neuron)  -> bring the mouth to the food: lean in, both hands to the mouth
             DNg84/DNg35 (front-leg grooming) -> that side's hand rubs that side of the head
             DNp01 giant fibre (escape jump)  -> crouch and spring away from the looming side, arms up
             MDN (moonwalker)                 -> step back
  body     the program sets hand/trunk targets -> IK -> target posture -> 416 muscles (muscles.py)

What is and is not the fly: which program runs, when, how strongly and how they
suppress each other comes from the brain's spikes. What each program looks like in a
human body is written here, and the pelvis is carried by a support whose force is
recorded (see muscles.py) - the legs do not bear the body's weight.
"""
import json, os, subprocess, sys, time
import numpy as np
import mujoco
from body_model import load
from muscles import MuscleDriver

OUT = sys.argv[1]
SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 34.0
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

m, d, spec = load()
drv = MuscleDriver(m, root_limits=(3000.0, 1500.0))
CTRL = 0.01
SUB = int(round(CTRL / m.opt.timestep))
FPS = 30

# ------------------------------------------------------------------ the scenes
SCENES = [
    (0.0, 'idle', '何もない'),
    (3.0, 'sugar', '唇に砂糖'),
    (9.0, 'idle', '砂糖をどける'),
    (11.0, 'dust', '頭にほこり'),
    (17.0, 'idle', 'ほこりを払う'),
    (19.0, 'loom', '黒い球が左前から迫る'),
    (25.0, 'idle', '何もない'),
    (27.0, 'dust+sugar', 'ほこりまみれで唇に砂糖'),
    (33.0, 'idle', '何もない'),
]


def scene_at(t):
    cur = SCENES[0]
    for s in SCENES:
        if t >= s[0]:
            cur = s
    return cur


# ------------------------------------------------------------------ body landmarks
head = m.body('head').id
HEAD0 = d.xpos[head].copy()
HEADR0 = d.xmat[head].reshape(3, 3).copy()
MOUTH_W = np.array([-0.025, 0.118, 1.575])            # front of the jaw at rest (world)
MOUTH_L = HEADR0.T @ (MOUTH_W - HEAD0)                # ... in the head's frame
SCALP_L = {s: HEADR0.T @ (np.array([sx, 0.19, 1.70]) - HEAD0) for s, sx in (('L', 0.045), ('R', -0.095))}
HAND = {'R': m.body('3proxph_r').id, 'L': m.body('3proxph_l').id}


def world(local):
    return d.xpos[head] + d.xmat[head].reshape(3, 3) @ local


def joint_dofs(names):
    return [int(m.joint(n).dofadr[0]) for n in names]


ARM = {s: joint_dofs([f'elv_angle_{s.lower()}', f'shoulder_elv_{s.lower()}', f'shoulder_rot_{s.lower()}',
                      f'elbow_flexion_{s.lower()}', f'pro_sup_{s.lower()}']) for s in 'RL'}
TRUNK = joint_dofs(['flex_extension', 'lat_bending', 'axial_rotation'])
LEG = {s: joint_dofs([f'hip_flexion_{s}', f'knee_angle_{s}', f'ankle_angle_{s}']) for s in 'rl'}

q_rest = d.qpos.copy()
q_ref = d.qpos.copy()
kin = mujoco.MjData(m)                                # the target posture, solved kinematically


def qadr(dof):
    return int(m.jnt_qposadr[m.dof_jntid[dof]])


def ik(targets, iters=6):
    """Move q_ref so each (body, local point, world target, dofs) reaches its target."""
    kin.qpos[:] = q_ref
    for _ in range(iters):
        mujoco.mj_kinematics(m, kin); mujoco.mj_comPos(m, kin)
        for body, point_w_fn, target, dofs in targets:
            p = point_w_fn(kin)
            e = target - p
            jp = np.zeros((3, m.nv))
            mujoco.mj_jac(m, kin, jp, None, p, body)
            Js = jp[:, dofs]
            dq = Js.T @ np.linalg.solve(Js @ Js.T + 0.02 ** 2 * np.eye(3), e)
            for k, dof in enumerate(dofs):
                a = qadr(dof)
                lo, hi = m.jnt_range[m.dof_jntid[dof]]
                v = kin.qpos[a] + 0.6 * dq[k]
                kin.qpos[a] = np.clip(v, lo, hi) if m.jnt_limited[m.dof_jntid[dof]] else v
    q_ref[:] = kin.qpos


# ------------------------------------------------------------------ scene objects (not physical, just sensed and drawn)
state = {'sugar': None, 'bitter': None, 'dust': [], 'ball': None}
rng = np.random.default_rng(7)


def update_objects(t, dt_scene):
    kind = scene_at(t)[1]
    t0 = scene_at(t)[0]
    mouth = world(MOUTH_L)
    if 'sugar' in kind:
        # a sugar cube on a stick comes to the lips over 1.2 s and stays there
        k = min(1.0, (t - t0) / 1.2)
        start = mouth + np.array([0.0, -0.45, -0.05])
        target = mouth + np.array([0.0, -0.012, 0.0])      # follows the lips wherever the head is
        state['sugar'] = (start + (target - start) * (1 - (1 - k) ** 3)).tolist()
    else:
        state['sugar'] = None
    if 'dust' in kind:
        if not state['dust']:
            state['dust'] = [{'side': s, 'local': (SCALP_L[s] + rng.normal(0, 0.02, 3)).tolist()} for s in 'LR' for _ in range(14)]
    elif state['dust']:
        state['dust'] = []
    if kind == 'loom':
        # a 12 cm ball from 2.5 m away, front-left, arriving in 1.6 s; again every 2.5 s
        ph = (t - t0) % 2.5
        eye = world(MOUTH_L) + np.array([0, 0, 0.08])
        direction = np.array([0.55, -1.0, 0.1]); direction /= np.linalg.norm(direction)
        dist = max(0.12, 2.5 - 2.5 * min(1.0, ph / 1.6))
        state['ball'] = {'pos': (eye + direction * dist).tolist(), 'r': 0.06} if ph < 1.9 else None
    else:
        state['ball'] = None


last_theta = {'L': 0.0, 'R': 0.0}


def senses(t):
    rates = {}
    mouth = world(MOUTH_L)
    if state['sugar'] is not None:
        dist = np.linalg.norm(np.array(state['sugar']) - mouth)
        rates['sugar'] = 150.0 if dist < 0.03 else 0.0
    for s, key in (('L', 'headL'), ('R', 'headR')):
        n = sum(1 for p in state['dust'] if p['side'] == s)
        rates[key] = min(200.0, 12.0 * n)
    # looming: angular size growth of the ball, split by which side of the head it is on
    for s in 'LR':
        rates['loom' + s] = 0.0
    if state['ball'] is not None:
        eye = mouth + np.array([0, 0, 0.08])
        v = np.array(state['ball']['pos']) - eye
        dist = np.linalg.norm(v)
        theta = 2 * np.arctan(state['ball']['r'] / dist)
        side = 'L' if v[0] > 0 else 'R'
        growth = (theta - last_theta[side]) / 0.02
        last_theta[side] = theta
        rates['loom' + side] = float(np.clip(growth * 60.0, 0, 250))
    else:
        last_theta['L'] = last_theta['R'] = 0.0
    return rates


# ------------------------------------------------------------------ the brain
brain = subprocess.Popen(['node', os.path.join(HERE, 'brain.mjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
hello = json.loads(brain.stdout.readline())
assert hello.get('ready'), hello


def think(rates):
    brain.stdin.write(json.dumps({'ms': 20, 'inputs': rates}) + '\n')
    return json.loads(brain.stdout.readline())['out']


# ------------------------------------------------------------------ motor programs
drive = {k: 0.0 for k in ['MN9', 'groomL', 'groomR', 'GF', 'escL', 'escR', 'MDN', 'DNp09', 'DNa02L', 'DNa02R']}
prog = {'feed': 0.0, 'groomL': 0.0, 'groomR': 0.0, 'escape': 0.0}
escape = {'t': -9.0, 'away': 1.0}
support = {'z': 0.0, 'y': 0.0, 'x': 0.0}


def smooth(key, value, tau):
    drive[key] += (value - drive[key]) * (1 - np.exp(-0.02 / tau))


def behave(t):
    # which program, and how strongly: spikes -> 0..1 levels (thresholds as in /test03/)
    prog['feed'] += (float(drive['MN9'] > 15) * min(1, drive['MN9'] / 60) - prog['feed']) * 0.08
    prog['groomL'] += (float(drive['groomL'] > 40) - prog['groomL']) * 0.08
    prog['groomR'] += (float(drive['groomR'] > 40) - prog['groomR']) * 0.08
    if drive['GF'] > 30 and t - escape['t'] > 1.5:
        escape['t'] = t
        escape['away'] = -1.0 if drive['escL'] + last_side_bias() >= drive['escR'] else 1.0

    q_ref[:] = q_rest
    # --- escape: 0-0.18 s crouch, 0.18-0.45 s spring (support lifts and carries away), land by 1.2 s
    te = t - escape['t']
    crouch = spring = 0.0
    if 0 <= te < 1.2:
        crouch = np.clip(te / 0.18, 0, 1) * (1 - np.clip((te - 0.18) / 0.12, 0, 1))
        spring = np.clip((te - 0.18) / 0.27, 0, 1) * (1 - np.clip((te - 0.6) / 0.6, 0, 1))
    for s in 'rl':
        hip, knee, ankle = LEG[s]
        q_ref[qadr(hip)] += 0.9 * crouch
        q_ref[qadr(knee)] += 1.3 * crouch             # knee_angle is positive in flexion
        q_ref[qadr(ankle)] += 0.45 * crouch
    support['z'] = -0.16 * crouch + 0.28 * np.sin(np.pi * np.clip((te - 0.18) / 0.7, 0, 1)) if 0 <= te < 1.2 else support['z'] * 0.95
    if 0 <= te < 1.2:
        support['x'] = escape['away'] * 0.9 * np.clip((te - 0.18) / 0.8, 0, 1) * 0.5
        support['y'] = 0.35 * np.clip((te - 0.18) / 0.8, 0, 1)
    # the root target carries the support offset (it is what the recorded support force does)
    q_ref[0] = q_rest[0] + support['x']; q_ref[1] = q_rest[1] + support['y']; q_ref[2] = q_rest[2] + support['z']

    # --- trunk: lean in to feed
    q_ref[qadr(TRUNK[0])] += -0.35 * prog['feed']      # negative flex_extension leans forward

    targets = []
    arms_up = spring
    for S in 'RL':
        g = prog['groom' + S]
        f = prog['feed']
        if g > 0.05:
            ph = 2 * np.pi * 2.2 * t + (0 if S == 'R' else np.pi)
            circle = np.array([0.0, 0.03 * np.cos(ph), 0.03 * np.sin(ph)])
            scalp = SCALP_L[S] + HEADR0.T @ circle
            tgt_fn = lambda kd, L=scalp: kd.xpos[head] + kd.xmat[head].reshape(3, 3) @ L
            weight = g
        elif f > 0.05:
            tgt_fn = lambda kd, S=S: kd.xpos[head] + kd.xmat[head].reshape(3, 3) @ (MOUTH_L + np.array([0.04 if S == 'L' else -0.04, -0.06, -0.02]))
            weight = f
        elif arms_up > 0.05:
            tgt_fn = lambda kd, S=S: kd.xpos[head] + np.array([0.35 if S == 'L' else -0.35, -0.05, 0.25])
            weight = arms_up
        else:
            continue
        targets.append((S, tgt_fn, weight))
    if targets:
        kin.qpos[:] = q_ref
        mujoco.mj_kinematics(m, kin)
        rest_hand = {S: kin.xpos[HAND[S]].copy() for S in 'RL'}
        tl = []
        for S, fn, w in targets:
            goal = rest_hand[S] + w * (fn(kin) - rest_hand[S])
            tl.append((HAND[S], lambda kd, b=HAND[S]: kd.xpos[b].copy(), goal, ARM[S]))
        ik(tl)


def last_side_bias():
    return 0.0


# ------------------------------------------------------------------ recording
vis_geoms = [g for g in range(m.ngeom) if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH and m.geom_group[g] in (0, 1, 2)]
frames = {'t': [], 'body_pos': [], 'body_quat': [], 'act': [], 'tendon': [], 'scene': [], 'brain': [], 'inputs': [], 'prog': [], 'support': []}


def tendon_paths():
    out = []
    for a in range(m.nu):
        ti = int(m.actuator_trnid[a, 0])
        adr, num = int(d.ten_wrapadr[ti]), int(d.ten_wrapnum[ti])
        pts = d.wrap_xpos.reshape(-1, 3)[adr:adr + num]
        obj = d.wrap_obj.reshape(-1)[adr:adr + num]
        out.append(pts[obj != -2].round(4).tolist())
    return out


# ------------------------------------------------------------------ run
print(f'running {SECONDS} s; brain {hello["n"]} neurons', flush=True)
wall0 = time.time()
rates, out, info = {}, {}, {}
next_frame = 0.0
nsteps = int(SECONDS / CTRL)
for k in range(nsteps):
    t = d.time
    update_objects(t, CTRL)
    if k % 2 == 0:
        rates = senses(t)
        out = think(rates)
        smooth('MN9', out['MN9'], 0.06)
        smooth('groomL', out['groomL'], 0.08); smooth('groomR', out['groomR'], 0.08)
        drive['GF'] = max(out['GFL'], out['GFR'])
        smooth('escL', out['escL'], 0.05); smooth('escR', out['escR'], 0.05)
        smooth('MDN', out['MDN'], 0.1)
        # grooming holds MN9 down in the brain itself; nothing is added here
    behave(t)
    info = drv.step(d, q_ref)
    for _ in range(SUB):
        mujoco.mj_step(m, d)
    if t >= next_frame:
        next_frame += 1.0 / FPS
        frames['t'].append(round(t, 3))
        frames['body_pos'].append(d.xpos.round(4).tolist())
        frames['body_quat'].append(d.xquat.round(4).tolist())
        frames['act'].append(d.act.round(3).tolist())
        frames['tendon'].append(tendon_paths())
        frames['scene'].append({'sugar': state['sugar'], 'ball': state['ball'],
                                'dust': [(d.xpos[head] + d.xmat[head].reshape(3, 3) @ np.array(p['local'])).round(4).tolist() for p in state['dust']],
                                'label': scene_at(t)[2]})
        frames['brain'].append({k2: round(v, 1) for k2, v in out.items()})
        frames['inputs'].append({k2: round(v, 1) for k2, v in rates.items()})
        frames['prog'].append({k2: round(float(v), 3) for k2, v in prog.items()} | {'escape': round(float(t - escape['t']), 2)})
        frames['support'].append({kk: round(vv, 1) for kk, vv in info.items()})
    if k % 200 == 0:
        print(f"t={t:5.2f} {scene_at(t)[1]:11s} in={ {k2: round(v) for k2, v in rates.items() if v} } "
              f"MN9={out.get('MN9', 0):.0f} groom={out.get('groomL', 0):.0f}/{out.get('groomR', 0):.0f} GF={out.get('GFL', 0):.0f}/{out.get('GFR', 0):.0f} "
              f"prog={ {k2: round(float(v), 2) for k2, v in prog.items()} } support={info.get('root_force', 0):.0f}N unmet={info.get('unmet', 0):.0f} "
              f"wall={time.time() - wall0:.0f}s", flush=True)

brain.stdin.close(); brain.wait(timeout=10)
meta = {
    'fps': FPS, 'bodies': [m.body(i).name for i in range(m.nbody)],
    'muscles': [m.actuator(i).name for i in range(m.nu)],
    'scenes': SCENES,
    'geoms': [{'body': int(m.geom_bodyid[g]), 'mesh': int(m.geom_dataid[g]), 'pos': m.geom_pos[g].round(5).tolist(),
               'quat': m.geom_quat[g].round(5).tolist(), 'rgba': m.geom_rgba[g].round(3).tolist()} for g in vis_geoms],
}
with open(os.path.join(OUT, 'run.json'), 'w') as f:
    json.dump({'meta': meta, 'frames': frames}, f)
print('wrote', os.path.join(OUT, 'run.json'), 'frames', len(frames['t']), 'wall', round(time.time() - wall0), 's')
