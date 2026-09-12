"""Measure NeuroMechFly walking in flygym's MuJoCo physics for a grid of 2-D
descending signals (HybridTurningController): forward/lateral speed, yaw rate,
thorax height and tilt.

    python calib_locomotion.py        # ~6 min on 6 cores
writes locomotion_runs.json (raw) and ../nmf/locomotion.json (what the page reads;
a run where the fly fell over is replaced by the mean of its two lower neighbours).
    python calib_locomotion.py one    # a single run at (1, 1)
"""
import json, sys, time
import numpy as np
from multiprocessing import Pool

def run(sig, T=2.0, T0=0.6):
    from flygym import Simulation
    from flygym.anatomy import BodySegment, ContactBodiesPreset
    from flygym.compose import FlatGroundWorld
    from flygym_demo.complex_terrain import (HybridTurningController, HybridControllerObservation,
        LocomotionAction, PreprogrammedSteps, apply_locomotion_action, make_locomotion_fly)
    from flygym.utils.math import Rotation3D
    fly = make_locomotion_fly(name="f", add_adhesion=True)
    world = FlatGroundWorld()
    world.add_fly(fly, [0, 0, 0.8], Rotation3D("quat", [1, 0, 0, 0]),
                  bodysegs_with_ground_contact=ContactBodiesPreset.TIBIA_TARSUS_ONLY,
                  add_ground_contact_sensors=False)
    sim = Simulation(world)
    pp = PreprogrammedSteps()
    order = fly.get_actuated_jointdofs_order("position")
    ctl = HybridTurningController(timestep=sim.timestep, preprogrammed_steps=pp, output_dof_order=order)
    sim.reset(); ctl.reset(seed=0)
    apply_locomotion_action(sim, fly.name, LocomotionAction(joint_angles=pp.default_pose_by_dof_order(order), adhesion_onoff=np.ones(6, bool)))
    sim.warmup()
    ti = fly.get_bodysegs_order().index(BodySegment("c_thorax"))
    bid = sim._internal_bodyids_by_fly[fly.name][ti]
    n = int(T / sim.timestep); P = np.zeros((n, 3)); H = np.zeros(n); R = np.zeros((n, 3, 3)); PH = np.zeros(n)
    t0 = time.time()
    for i in range(n):
        obs = HybridControllerObservation.from_sim(sim, fly.name)
        a = ctl.step(np.array(sig, float), obs)
        apply_locomotion_action(sim, fly.name, a)
        sim.step()
        P[i] = sim.mj_data.xpos[bid]; R[i] = sim.mj_data.xmat[bid].reshape(3, 3)
        PH[i] = ctl.cpg_network.curr_phases[0]
    wall = time.time() - t0
    k = int(T0 / sim.timestep)
    hx = R[:, :, 0]; yaw = np.unwrap(np.arctan2(hx[:, 1], hx[:, 0]))
    dur = (n - k) * sim.timestep
    d = P[-1] - P[k]
    # displacement in the mean heading frame
    ym = (yaw[k] + yaw[-1]) / 2
    fwd = d[0] * np.cos(ym) + d[1] * np.sin(ym); lat = -d[0] * np.sin(ym) + d[1] * np.cos(ym)
    pitch = np.degrees(np.arcsin(-R[k:, 2, 0])).mean(); roll = np.degrees(np.arctan2(R[k:, 2, 1], R[k:, 2, 2])).mean()
    ok = bool(np.isfinite(P).all() and P[-1, 2] > 0.2)
    return dict(sig=list(sig), vx=fwd / dur, vy=lat / dur, wz=(yaw[-1] - yaw[k]) / dur,
                z=float(P[k:, 2].mean()), zsd=float(P[k:, 2].std()), pitch=float(pitch), roll=float(roll), ok=ok, wall=wall, dt=sim.timestep)

def write_map(runs, vals):
    from pathlib import Path
    g = {tuple(r["sig"]): r for r in runs}
    out = []
    for r in runs:
        r = dict(r)
        if not r["ok"]:
            a, b = r["sig"]
            nb = [g[(a, vals[vals.index(b) - 1])], g[(vals[vals.index(a) - 1], b)]]
            for k in ("vx", "vy", "wz"):
                r[k] = sum(float(n[k]) for n in nb) / 2
            r["filled"] = "mean of neighbours (the physics run fell over)"
        e = {"sig": list(r["sig"]), **{k: round(float(r[k]), 3) for k in ("vx", "vy", "wz", "z", "pitch", "roll")}}
        if "filled" in r:
            e["filled"] = r["filled"]
        out.append(e)
    doc = {"source": "flygym 2.1 MuJoCo, HybridTurningController on flat ground, dt=1e-4 s, 2 s runs (first 0.6 s dropped); tools/calib_locomotion.py",
           "units": {"vx": "mm/s forward", "vy": "mm/s left", "wz": "rad/s CCW (left)", "z": "mm thorax height"},
           "values": vals, "runs": out}
    Path(__file__).resolve().parent.parent.joinpath("nmf/locomotion.json").write_text(json.dumps(doc, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "one":
        print(run((1.0, 1.0))); sys.exit()
    vals = [-1.0, -0.6, 0.0, 0.4, 0.7, 1.0, 1.3]
    grid = [(a, b) for a in vals for b in vals]
    with Pool(6) as p: res = p.map(run, grid)
    json.dump(res, open("locomotion_runs.json", "w"), indent=1, default=float)
    write_map(res, vals)
    for r in res: print(r["sig"], "vx %.2f vy %.2f wz %.2f z %.3f pitch %.1f roll %.1f ok %s" % (r["vx"], r["vy"], r["wz"], r["z"], r["pitch"], r["roll"], r["ok"]))
