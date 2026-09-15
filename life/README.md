# life — ハエLIFE

**https://hae.satoru.net/life/** — a fly's life, from courtship song to generations of offspring, in the
browser. The first female runs the whole *Drosophila* brain of the FlyWire connectome: she hears the
male's song, turns to it, stands still to accept him and lays her eggs by the firing of her own neurons.
Her eggs hatch, grow through larva and pupa to adults that court, mate and lay in their turn, in real
numbers and with the deaths a real brood has.

This directory of the site's repository, [satorunet/hae](https://github.com/satorunet/hae), is all of it.

## What runs

- **Brain** (`brain-worker.js`): the Shiu et al. (2024) whole-brain LIF model (`flybrain/` of the site),
  with the 161 runaway neurons silenced (`ningen/web/data/tame783.json`). Groups (`data/court783.json`,
  cell types from Schlegel et al. 2024):
  - in: Johnston's organ JO-A/B, left and right by where the song comes from (pulse song 225 Hz every
    35 ms, sine song 150 Hz); pC1 as mating drive (virgin 5 Hz, mated 1 Hz, and an assumed +15 / +3 Hz
    while a song is heard, because song → vpoEN does not propagate in this model); SMP550 while she
    looks for a place to lay (10 Hz) and probes the fruit (35 Hz), standing in for the sex-peptide and
    substrate signals the brain data does not have
  - out: DNp12 left/right (turning to the song), vpoDN = DNp37 (over 8 Hz she stands still for the
    male), oviDNa (over 4 Hz for a second she lays)
- **Bodies** (`app.js`, `male.js`): NeuroMechFly v2 (flygym) from `test03/` and the walking fly of
  `suji/flag.js`. On this page the male runs no brain: approach → tap → wing song → mount → copulation is scripted,
  and his song reaches her brain from where he is. The young are low-poly crowd meshes.
- **Laying** (`eggs.js`): eggs ripen in her at ~50 a day (fewer with age, up to 80 held) and a clutch
  comes out at once when oviDNa fires on the fruit — or on a dead fly nearby, which females pick
  (Ahmad et al. 2015).
- **Brood** (`brood.js`): eggs, larvae and pupae in real numbers as instanced meshes (growing without
  limit). Days at 25 °C (egg 1 d, three larval instars, wandering, pupa ~4.5 d); ~10 % of eggs do not
  hatch, larvae on one fruit die faster the more there are, some pupae do not eclose. Crowded ones push
  each other into the gaps. Larvae smell dead adults within 4 mm and feed on them; on crowded food small
  larvae now and then attack a third-instar larva and eat it from within in about two hours
  (Vijendravarma et al. 2013). Eggs are not eaten (their wax hides them, Narasimha et al. 2019), and
  adults do not eat eggs, larvae or carcasses (Ahmad et al. 2015).
- **The young** (`growth.js`): eclosion (lid, ptilinum, teneral colour), maturing, courting, mating
  and laying by rules taken from what the first female's brain did (virgin + song → vpoDN over
  threshold → accept; mated → reject). Hunger, food (`food.js`, tap to put some down), flights,
  lifespans of 40–60 days, starvation and death.
- **Page** (`index.html`): one column made for phones, screens switched at the bottom (watch / numbers /
  brain / other). Counts over time with a tap-for-values graph; tap a fly for a bubble with its brain,
  drawn on the FlyWire neurons at their soma positions (`flybrain/data/pos783.bin.gz`): the first
  female's simulated firing, and for the others the cells known to work in what they are doing
  (LC10a, and P1 at the place of its female counterpart pC1 — `data/male783.json`). Song, laying,
  mating and death have sounds and marks.

Bubbles can be dragged anywhere on the view (a dotted line keeps them tied to their fly).

The male was also tried with a brain of his own — the Male CNS v1.0 connectome (Janelia FlyEM with
Cambridge, MRC LMB and Google Research; CC-BY 4.0), brain and ventral nerve cord, in the same LIF model
with the synapse weight scaled for its ~1.9× denser synapse counts. P1 → pIP10 → dPR1 (the song command
reaching the thorax) works, the senses alone do not reach P1, pC1 drives vpoDN in the female where P1
drives pIP10 in the male, and LC10a reaches pIP10 only in the male — but the behaviour on screen hardly
changed, so this page keeps one brain. The two-brain version runs at https://hae.satoru.net/life-dev/.

What is simulated and what is assumed is written out on the page, under その他.

## Running it

It is part of the site: it expects `flybrain/`, `test03/`, `suji/flag.js` and
`ningen/web/data/tame783.json` one directory up. Serve the repository's root statically
(`.wasm` as `application/wasm`) and open `/life/`. No server is needed.

## Credits and licences

- Brain model: Shiu et al., *Nature* 2024 (MIT); FlyWire connectome v783 (CC-BY 4.0); cell types
  Schlegel et al., *Nature* 2024 (CC-BY 4.0)
- Body: [flygym / NeuroMechFly v2](https://github.com/NeLy-EPFL/flygym) (Apache-2.0)
- 3D: [three.js](https://threejs.org/) (MIT)
- Behaviour data: Ahmad et al., *Sci Rep* 2015; Vijendravarma et al., *Nat Commun* 2013; Narasimha
  et al., *PLOS Biol* 2019; the male circuit (Thistle et al. 2012, Toda et al. 2012, Ribeiro et al.
  2018, von Philipsborn et al. 2011, Tayler et al. 2012)

The code of this experiment: MIT, as the rest of the site.
