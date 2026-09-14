# ningen — 人体を制御するハエ脳実験

**https://hae.satoru.net/ningen/** — the whole *Drosophila* brain of the FlyWire connectome
drives a human musculoskeletal body, in the browser, in real time, and learns to use it.

Drop honey, dung or meat on the floor: its landing is heard, its smell and sight reach the fly's
brain, and whether the body sets off, which way it turns, whether it eats, startles or gets up again
comes from the brain's spikes. A fall counts only if the body is not up again within 8 s; eating is
a success. Every trial - visitors' and the server's own practice - is learned from.

This directory of the site's repository, [satorunet/hae](https://github.com/satorunet/hae), is all of it.

## What runs

- **Body** (`web/body-worker.js`, `web/muscles.mjs`): MyoSim's MyoFullBody (104 bones, 123 joints,
  416 muscles) in MuJoCo compiled to WebAssembly, on all fours with nothing holding it up. Hands and
  knees are placed by IK and a static walking plan (the centre of mass moved over the other limbs
  before one lifts), and a bounded least-squares solver shares the joint torques out over the
  muscles and the floor's pushes over the supports. Food is a second, small MuJoCo world.
- **Brain** (`web/brain-worker.js`): the Shiu et al. (2024) whole-brain LIF model (`flybrain/` of the
  site). In: taste neurons, olfactory receptor neurons per food, R1-6, LC11, LC4/LPLC2, Johnston's
  organ (wind and gravity; hearing), ocelli. Out: MN9 (feeding), DNa02 (turning), the odour-driven
  DNa03/13/15/16 and DNp09 (going), MDN (backing), DNg84/DNg35 (grooming), the giant fibre
  (escaping), DNp12/DNg24 (turning the head to a sound), DNp28/DNb06 (bending the elbows). The model
  runs away on olfactory input; 161 neurons found to drive that are silenced (`web/data/tame783.json`).
- **Who decides what**: the brain decides whether to go and how fast, stopping to eat, escaping,
  turning to a sound and bending the elbows. The body stands in for the ventral nerve cord the model
  lacks: while the brain drives it forward it heads for the food that smells strongest and puts its
  mouth to it (steering by the brain alone was tried, and the body circled or passed the food).
- **Learning**
  - *Mushroom body* (`school/chooser.mjs`, `school/strategies.mjs`): each food's odour through the
    Kenyon cells chooses how to approach, how to feed, how to get up after each fall and how to come
    round to food behind; dopamine on KC→MBON synapses from how each went.
  - *Motor synapses* (`web/reflex.mjs`): the excitatory synapses onto the elbow, steering and walking
    DNs are plastic too, with dopamine worked out from how steady the trunk was and whether the smell
    grew stronger just after.
  - *Basic control* (`school/tune.mjs`): an evolution strategy tunes weight shifting, stance, stepping,
    turning and getting-up settings; the page only uses settings verified against the hand-set ones,
    and each brain level carries the body settings it had.
- **School** (`school/server.mjs`, `school/trial.mjs`): takes visitors' trials (choices, outcome, what
  the motor synapses learned, a record of the brain and body, the motion to watch again) and practises
  with its own bodies; a new level every 100 trials. Recorded trials can be replayed from motion data
  and shared as `?case=N`.
- **Page** (`index.html`, `web/app.js`, `web/mouth.js`): three.js; a MakeHuman skin fitted to the
  skeleton (`fit_skin.py`), the brain's activity in a glass head, eyes that follow what the brain
  attends to, blinking, teeth, gums and tongue, and the NeuroMechFly fly riding on top.

## Running it

It is part of the site: it expects the site's `flybrain/` and `test03/` (three.js, the fly's body)
next to it, one directory up. Serve the repository's root
statically (`.mjs` as `application/javascript`, `.wasm` as `application/wasm`) and open `/ningen/`.

The school is optional (without it the page still runs, and nothing is learned or recorded):

```sh
pm2 start ningen/school/ecosystem.config.cjs     # hae-ningen-school (port 3021) and hae-ningen-tune
```

with `/ningen/api/` proxied to `127.0.0.1:3021`. Its state (learned brains, logs, recorded motion) is
written to `school/state/`, which is not kept in git.

## Credits and licences

- Brain model: Shiu et al., *Nature* 2024 (MIT); FlyWire connectome v783 (CC-BY 4.0)
- Body: [MyoSim MyoFullBody](https://github.com/MyoHub/myo_sim) (Apache-2.0; the inertia of the shoulder's helper bodies corrected)
- Physics: [MuJoCo](https://github.com/google-deepmind/mujoco) WebAssembly (Apache-2.0)
- Skin: [MakeHuman](https://github.com/makehumancommunity/makehuman) base mesh (CC0)
- Fly on the head: [flygym / NeuroMechFly v2](https://github.com/NeLy-EPFL/flygym) (Apache-2.0)
- 3D: [three.js](https://threejs.org/) (MIT)

The code of this experiment: MIT, as the rest of the site.
