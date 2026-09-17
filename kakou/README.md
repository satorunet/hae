# kakou — 脳加工

Adding circuits to the fly's connectome **by hand**, and measuring what each one buys.

[`shinka/`](../shinka/) mutates the same brain at random and lets a world keep what pays. This does the
opposite: a circuit is designed for a thing the brain cannot do, put in, and measured against the brain
without it. Where evolution has to take the place of an existing connection (the graph has no free
slots), engineering does not - `graft.mjs` grows the graph instead, so **nothing that was there is
touched**. With nothing wired in, the brain is spike-for-spike the connectome's (checked below).

**What has been built with it.** [`soroban/`](../soroban/) takes the four parts below — a ring that
holds, an inhibition that clears it, a disinhibited gate, and a state machine made of them — and builds
a **soroban** inside the same brain: eight rods of one-hot bead rings that add, subtract and multiply,
run live at [hae.satoru.net/soroban/](https://hae.satoru.net/soroban/).

## The workshop (`graft.mjs`)

```js
const W = await Workshop.open({ cells: 32 });    // 32 new neurons, connected to nothing
const hold = W.cells(32);
W.wire(drivers, hold, 60);                       // 60 synapses from each driver to each new cell
W.wire(hold, hold, 16, { self: false });
const brain = await W.build();                   // a FlyBrain with all of it in place
```

`.fbg` is CSR - ids, degrees, postsynaptic indices in three delta-coded byte planes, synapse counts in
two. `open()` decodes it, `build()` re-encodes with the new neurons at the end and extra empty slots on
whichever existing rows are going to send somewhere new, then fills those slots in wasm memory (the
deltas only matter at load time; after that `post`/`w` are plain arrays - shinka's `graphOf`).

**Fidelity.** Grown but unwired, against the plain v783 graph, seeds 1-3 of the sugar experiment:
0 of 138,639 neurons differ, spike for spike.

## What the brain cannot do: hold anything (`hold.mjs`, first half)

200 ms of sugar (the 20 `shiu:sugar` GRNs at 150 Hz), then nothing, 12 seeds per taste, and per 10 ms
bin a leave-one-out nearest-centroid classification of sugar against bitter over the whole brain's
rates (chance 0.5):

| after the taste stops | 0 | 10 | 20 | 30 | 40 | 50 | 60 ms and on |
|---|---|---|---|---|---|---|---|
| spikes per 10 ms | 81.3 | 46.0 | 24.9 | 14.8 | 9.4 | 0.8 | **0** |
| sugar vs bitter | 0.96 | 0.88 | 0.75 | 0.75 | 0.67 | **0.50** | 0.50 |

**The whole brain is silent 50 ms after the stimulus, and what it was is gone.** No working memory: a
fly asked to do something with what it saw a moment ago has nothing to do it with.

## Graft 1 - a ring that holds (`hold.mjs`)

32 new cells, fed by the 24 cells that answer sugar and not bitter (28.5 spikes/200 ms against 0.00).

**All-to-all does not work, at any strength.** 1 to 32 synapses per pair: the cells fire once after the
stimulus and stop (held 25 ms). They all fire *together*, so the volley they send each other arrives
while every one of them is refractory - and this model drops synaptic input that reaches a refractory
neuron (flybrain's README: reproduced from Brian2's generated code). Synchronous self-excitation puts
itself out.

**A ring does.** The cells are split into `G` groups, each exciting only the next, so activity travels
round instead of firing at once and each group is fed when it is out of its refractory period:

| groups | synapses per pair | held after the taste stops | bitter |
|---|---|---|---|
| 1 (all-to-all) | 4 - 32 | 25 ms | never lit |
| 2 | 16 | **> 10 s** | never lit |
| 3 | 32 | **> 10 s** | never lit |
| 4 | 32 | **> 10 s** | never lit |
| 8 | 4 - 32 | 25 ms | never lit |

At 10 s it is still going at the rate it started at (~108 Hz a cell, 848-864 spikes per 250 ms). So the
graft turns 50 ms into no limit at all - and that is the problem: **a loop that cannot stop is a latch,
not a memory.** Bitter never lights it, so what is held is specific.

## Graft 2 - clearing it (`erase.mjs`)

24 cells that answer bitter and not sugar, wired **inhibitory** onto every cell of the ring. Sugar
writes, the ring holds, bitter clears. Spikes in the ring per phase:

| inhibitory synapses | write | hold 500 | clear | +500 | +1000 | rewrite | hold 500 |
|---|---|---|---|---|---|---|---|
| 16 | 1056 | 1728 | **0** | 0 | 0 | 1072 | 1712 |
| 32 | 1040 | 1744 | **0** | 0 | 0 | 1088 | 1712 |
| 64 | 1040 | 1744 | **0** | 0 | 0 | 1072 | 1712 |
| 128 | 1024 | 1728 | 0 | 0 | 0 | 1088 | **80** |

16 to 64 synapses clear it completely, it stays silent for the 1.5 s watched, and it takes a second
write at full strength. Above ~128 the inhibition outlives the clear and the ring never recovers.

**So the brain now has a register: written by one taste, held indefinitely, cleared by another, and
written again.** Against 50 ms of nothing.

Wired only to itself, the ring changes the connectome's own behaviour not at all - over 1 s of sugar,
seeds 1-3: 0 of 138,639 original neurons differ, MN9 76.0 / 79.0 / 69.0 Hz in both. Which is also to say
it is **a memory the fly cannot use**. That is graft 3.

## Graft 3 - using it: a delayed match to sample (`gate.mjs`)

    cue (200 ms: LC11, an object in view, or LC6) -> a gap of nothing -> go (200 ms: the ocelli)

and the right answer is to feed (MN9) on the go **only if the cue was LC11**. The plain brain answers
0.0 spikes either way at any gap: it is silent 50 ms after the cue, and none of the three inputs drives
MN9 on its own (bristles 0.0 Hz, ocelli 0.0 Hz, LC11 0.0 Hz; sugar, for comparison, 63.8 Hz).

Vision rather than taste because the connectome has six object-detecting populations with known jobs -
LC4, LPLC2, LPLC1, LC6, LC11 - and none of them runs the model away (3,000-6,900 spikes per 200 ms at
150 Hz, and 60-290 in the 200 ms after it stops). Taste offers two things to tell apart; vision offers six.

**Two subthreshold excitations do not make an AND.** Fed from the register and from the go cells, at the
weakest weight there is - 2 synapses - the go alone already fires the gate 128 spikes: 24 drivers at
~198 Hz, integrated over tau_m = 20 ms, clear threshold however few synapses each one has. There is no
subthreshold regime to sit in.

**Nor does a veto on a gate that is driven hard.** Inhibition reaching a refractory neuron is dropped by
this model exactly as excitation is, so a gate held at saturation ignores 8 veto cells x 128 synapses of
it: 692 gate spikes on the right cue and 708 on the wrong one, at every strength tried.

**What works is disinhibition on a gate that is only just driven:**

    go --(gb)---------> gate --(200)--> MN9
    go --(60)--> veto --(-vg)--> gate
    register --(-128)--> veto

| go -> gate | veto -| gate | veto: right cue / wrong | gate: right / wrong | **MN9 on the go: right / wrong** |
|---|---|---|---|---|
| 2 | 32 or 128 | 0 / 332 | 80 / 0 | 5.0 / 0.0 |
| 4 | 32 or 128 | 0 / 332 | 180 / 0 | **11.3 / 0.0** |
| 8 | 32 or 128 | 0 / 332 | 292 / 0 | **18.0 / 0.0** |
| 16 | 128 | 0 / 332 | 416 / 0 | **25.5 / 0.0** |
| 32 | 32 | 0 / 332 | 540 / 452 | 33.5 / 28.0 |

The register silences the veto completely (332 spikes -> 0), and only then does the go get through. At
go->gate 8 and veto 128 the fly feeds 18 spikes' worth on the right cue and not at all on the wrong one,
**at gaps of 0, 500, 2,000, 5,000 and 10,000 ms alike** - the same 18.0 / 0.0 at every one, because the
ring does not decay.

**And it costs the fly nothing.** With the whole graft in place - register, clear, veto, gate, and the
gate wired into MN9 itself - against the plain brain over 1 s:

| | original neurons differing | total spikes | MN9 |
|---|---|---|---|
| sugar | 0 / 138,639 | 12,794 vs 12,794 | 78 vs 78 spikes |
| bitter | 0 / 138,639 | 4,197 vs 4,197 | 0 vs 0 |
| nothing | 0 / 138,639 | 0 vs 0 | 0 vs 0 |

So the animal eats as it always did, and in addition can answer a question about something that is no
longer there.

## The retina (`retina.mjs`)

The connectome's retina is **668 ommatidia an eye** - each carries exactly one R7 and one R8, so the 668
R7 cells *are* the ommatidia, and 4,044 R1-6 / 668 = 6.05 apiece, as it should be. Nothing on this site
had ever shown it a picture: the pages give the brain a handful of channels (LC11, LC4/LPLC2, R1-6 lumped
into one), so 668 sampling points an eye sat unused. Driven both eyes at 150 Hz the photoreceptors deliver
249,860 spikes in 200 ms and 470 in the 400 ms after they stop - hard-driven, but not self-sustaining.

`retina.mjs` gives each photoreceptor a line of sight and turns a scene into a firing rate per cell. How
many points there are is not guessed; **where each one looks is**, because the connectome has soma
positions and not optics, and `pos783.bin.gz` is a frontal view (x, y only) of a curved eye. So position
is used for the retinotopic *order* only - rows by the y order, each row spread evenly across the field -
and the result is checked against the animal:

| | median angle between neighbours | min | max |
|---|---|---|---|
| positions as they come, linearly | 1.75 deg | | |
| positions as they come, orthographic (asin) | 1.44 deg | | |
| **ordered, then evened into a raster** | **4.77 deg** | 2.00 | 6.07 |
| a real *Drosophila* | ~5 deg | | |

A 2-degree dark spot then darkens 1 ommatidium of 668, a 5-degree spot 5, a 10-degree spot 11. Neural
superposition is not modelled: each of the 4,044 R1-6 has its own direction (0.95 deg apart), so R1-6
samples about six times finer than the eye resolves. What the eye resolves is the 668.

## Where an image can get in, and what limits reading

[/hiragana/](../hiragana/) and [/suji/](../suji/) already put pictures into this brain, and not through
the eye: `juku/reader.mjs` deals a 16x16 picture round-robin across the **685 olfactory projection
neurons**, and the mushroom body learns it. At 100,000 practices the fly reads 46 letters at 84.35%.
So which way in is better, the nose or the eye? Counting excitatory synapses onto the 5,177 Kenyon cells:

| from | synapses onto Kenyon cells | cells that reach one |
|---|---|---|
| the 685 olfactory projection neurons | 328,622 | **302 of 685** |
| photoreceptors (R1-6, R7, R8) | **0** | 0 |
| optic and visual-projection cells | 13,543 | 218 |
| everything else | 468,870 | |

**The eye does not reach the learning machine at all.** Not one synapse from a photoreceptor lands on a
Kenyon cell, and the whole optic system reaches it with 4% of what olfaction delivers. The nose is the way
in to the mushroom body - and it is narrower than it looks: **383 of the 685 projection neurons never
reach a Kenyon cell**, so a picture dealt across all 685 is really going in through 302 channels.

And the readout is not what is holding it back. Per letter the fly is 0.50 to 1.00 right, and the
correlation between a letter's accuracy and the size of its MBON compartment (1,155-2,220 synapses,
1-3 MBONs) is **r = -0.019** - none. The letters it fails are the ones that look alike: な 0.50, は 0.50,
あ 0.60, に 0.60, ぬ 0.60, う 0.70, ち 0.70, ね 0.70. The limit is on the way in, not the way out.

So the next graft is not a wider retina and not more MBONs. It is **more channels into the Kenyon
cells** - and, if the eye is ever to teach the mushroom body anything, a visual path to them that the
connectome has almost none of.

## The eye does not carry, in this model (`see.mjs`)

Before anything is wired anywhere, the check that has to pass: shown a scene through `retina.mjs`, does
the fly's own visual system answer? Spikes by where they land, 200 ms, both eyes:

| drive | photoreceptors | optic lobe | visual projection | central brain | Kenyon cells |
|---|---|---|---|---|---|
| 30 Hz | 6,732 | 17 | **0** | **0** | **0** |
| 150 Hz | 33,798 | 1,334 | **0** | **0** | **0** |
| 400 Hz | 53,809 | 3,531 | **0** | **0** | **0** |
| 1,000 Hz | 98,031 | 6,905 | 1 | **0** | **0** |

**It does not conduct.** Not at any drive - at 1,000 Hz, which no photoreceptor does, one spike reaches a
visual projection neuron and nothing at all reaches the central brain.

**The wiring is not what is missing.** Photoreceptors reach 16,180 cells, and 2,572 of them receive 25
synapses or more from photoreceptors - about what it takes to carry a neuron from rest to threshold - and
each of those 2,572 sends 206.3 synapses onward. The olfactory receptor neurons, which work perfectly
well in this model, reach 3,179 cells of which 802 clear the same bar. Anatomically the eye is the better
connected of the two.

What fails is the dynamics. Those 25 synapses are spread over many photoreceptors, and photoreceptors
driven by independent Poisson input do not fire together; with tau_syn = 5 ms the arrivals do not sum.
And that is the shape of the problem rather than a surprise: *Drosophila* photoreceptors and the lamina
monopolar cells they feed **do not spike at all** - they are graded-potential neurons releasing
transmitter continuously, which is textbook and has been since the 1970s. A leaky-integrate-and-fire
model with a fixed millivolts-per-synapse rule has no way to represent that, and Shiu et al. validated
theirs on taste and feeding, not on vision. So this is a limit of the model, not a fact about flies -
flies see.

What the cells carry is worth having beside it:

| | cells | outgoing synapses per cell | with no output at all |
|---|---|---|---|
| R1-6 | 7,932 | **23.2** | **1,400** |
| R7 | 1,336 | 11.2 | 510 |
| R8 | 1,314 | 19.9 | 312 |
| olfactory receptor neurons | 2,246 | 158.5 | 7 |
| sugar GRNs | 20 | 343.9 | 0 |
| head bristles | 305 | 386.8 | 0 |
| LC11 | 127 | 904.7 | 0 |

A photoreceptor carries a seventh to a fifteenth of what another sensory neuron carries, and a fifth of
R1-6 carries nothing - some of which is the reconstruction, the retina being at the edge of the imaged
volume. Thin output and no synchrony together are what stops it.

## Graft 5 - a visual pathway, built (`bridge.mjs`)

If it does not conduct, build it. Each ommatidium's R7 - one per ommatidium, 1,336 over both eyes - wired
straight onto Kenyon cells in the shape the olfactory projection neurons use. Eight scenes (a 6-degree
spot in six places, a 30-degree disc, a bar across the field), four presentations each, and the question
is whether the Kenyon-cell codes separate them: leave-one-out nearest centroid, chance 0.125.

| drive | Kenyon cells per ommatidium | Kenyon spikes a scene | Kenyon cells firing | scenes told apart |
|---|---|---|---|---|
| 60 Hz | 0 (no bridge) | 0 | 0.0% | 0.125 |
| 60 Hz | 71 | 69 | 0.8% | 0.406 |
| 150 Hz | **71** | 899 | **5.4%** | **0.875** |
| 150 Hz | 150 | 3,777 | 12.3% | **1.000** |
| 400 Hz | 71 | 7,482 | 16.9% | **1.000** |
| 400 Hz | 300 | 27,680 | 38.4% | 1.000 |

At 150 Hz and 71 Kenyon cells an ommatidium the code is **5.4% sparse - what a real fly's mushroom body
runs at** - and it tells the eight scenes apart at 0.875. Worth setting beside the letters going in
through the nose, where 72.6% of the Kenyon cells fire and the code is dense: a picture through the eye
is spatially sparse to begin with, so the mushroom body gets the kind of input it is built for.

And it costs nothing. 1,336 x 71 x 12 = 1,138,272 synapses added over 94,856 connections, and against the
plain brain over 1 s: 0 of 138,639 neurons differ on sugar, on bitter and on nothing at all, MN9 78 vs 78
spikes, Kenyon cells 0 vs 0. In the dark the bridge is not there.

## Graft 4 - widening the way in (`channels.mjs`)

A picture goes into the mushroom body through 302 channels. Does widening them buy anything? Measured
without training, because what a wider way in can buy is set before the readout: present the 46 hiragana
(5 pictures each, the test fonts), and ask how separable the **Kenyon-cell codes** are - leave-one-out
nearest centroid, chance 0.022. New channels are new cells wired as a real projection neuron is (71
Kenyon cells, 12 synapses each); new Kenyon cells are wired as real ones are (6 channels in at 12
synapses, APL's inhibition in at -19, 22 synapses back to APL, so they are inside the loop that keeps the
code sparse). Everything outside the mushroom body is silenced, as `juku/reader.mjs` does.

| channels | Kenyon cells | Kenyon cells firing | letters told apart |
|---|---|---|---|
| 302 | 5,177 | 9.2% | 0.426 |
| 452 | 5,177 | 14.3% | 0.474 |
| **685** (the 383 wired in) | 5,177 | 29.1% | **0.526** |
| 685 | 10,354 | 14.6% | 0.526 |
| 602 | 5,177 | 19.4% | 0.543 |
| 602 | 10,354 | 6.6% | 0.509 |
| 902 | 5,177 | 32.2% | 0.561 |
| **1,602** | 5,177 | 57.7% | **0.626** |
| 1,602 | 20,708 | **5.3%** | 0.539 |
| 3,302 | 5,177 | 86.3% | 0.609 |

- **Widening works, up to a point.** 0.426 -> 0.626 at 1,602 channels, and then it turns over: 3,302
  channels is worse (0.609) with 86.3% of the Kenyon cells firing.
- **The cheapest win takes no new cells at all.** Wiring in the 383 projection neurons that are already
  there and reach no Kenyon cell - connections only, not one cell added - takes 0.426 to **0.526**.
- **Growing the Kenyon layer does what it is supposed to and does not help here.** Adding 15,531 Kenyon
  cells to the 1,602-channel brain brings the code back from 57.7% to **5.3%** - the APL loop works on
  cells that were not there an hour ago - but separability falls to 0.539. On this measure a denser code
  simply has more signal in it. Whether a sparse code is worth more *once it is learned from* is not
  something nearest centroid can answer; it is what the mushroom body's own readout is for.

## Graft 6 - a state machine in a connectome (`sequence.mjs`)

Nothing new is built here. Graft 1's ring is a state, graft 3's disinhibited gate is a transition, and
graft 2's inhibition clears a state. Put four rings in a row with three gates between them and the fly
answers to **A then B then C** and to nothing else:

    start --> S0
    A + S0 --> gate0 --> S1,  and -| S0
    B + S1 --> gate1 --> S2,  and -| S1
    C + S2 --> gate2 --> S3,  and -| S2
    S3 --> MN9

A, B and C are LC11, LC6 and LC4 - three object-detecting populations - and the start pulse is the ocelli.
Each is shown for 200 ms with 300 ms of nothing between. The drivers are clean: 33-40 spikes on their own
input and at most 0.59 on any other.

| sequence | S0 | S1 | S2 | S3 | MN9 | should | |
|---|---|---|---|---|---|---|---|
| ABC | 0 | 0 | 0 | 683 | 42.7 | fire | right |
| ACB | 0 | 0 | 677 | 0 | 0.0 | silent | right |
| BAC | 0 | 677 | 0 | 0 | 0.0 | silent | right |
| CAB | 0 | 0 | 677 | 0 | 0.0 | silent | right |
| AAB | 0 | 0 | 677 | 0 | 0.0 | silent | right |
| AB | 0 | 0 | 683 | 0 | 0.0 | silent | right |
| AABC | 0 | 0 | 0 | 677 | 42.7 | fire | right |
| ABAC | 0 | 0 | 0 | 677 | 42.7 | fire | right |
| CBABC | 0 | 0 | 0 | 683 | 42.7 | fire | right |
| CCC / BBB | 683 | 0 | 0 | 0 | 0.0 | silent | right |
| AAA | 0 | 683 | 0 | 0 | 0.0 | silent | right |
| ACAB | 0 | 0 | 677 | 0 | 0.0 | silent | right |

**20 of 20 sequences right**, and exactly one state is up at any time. What it computes is A then B then C
as a *subsequence* - anything may come between - which is what this machine is, and the test expects that
of it rather than of the letters.

200 new cells, 7,648 connections, 348,672 synapses. Against the plain brain over 1 s: 0 of 138,639 neurons
differ on sugar, on bitter and on nothing at all; MN9 78 vs 78 spikes.

**This is the answer to whether a brain can be engineered.** Order is not something a fly does, and a
state machine is not a thing evolution would hand anyone. It went in out of three circuits that were
measured this morning, and the animal it went into is unchanged.

## Graft 7 - the smallest conversation (`talk.mjs`)

Two brains, a question, an answer, and an action that depends on it.

    A wants food and cannot find it, so it asks - a wing buzz (DNg02).
    B has seen food, or has not. Hearing the question (Johnston's organ) and only if it knows,
      it answers - a click (the giant fibre, DNp01).
    A hears the answer (Johnston's wind and gravity neurons) and, only if it still wants food, eats (MN9).

Nothing new is built: `W.memory()` holds each fly's own fact, and the disinhibited AND gate of graft 3
puts a heard signal together with it. The two brains are stepped 5 ms at a time and each hears what the
other's motor neurons did in that slice, as shinka's world couples them. A's drive and B's knowledge are
LC4 and LC11 - **not** sugar, which drives MN9 at 63.8 Hz on its own and would decide the outcome before
any conversation happened.

| A wants | B knows | A holds | B holds | A asks | B's gate | B answers | A's gate | **A eats (MN9)** |
|---|---|---|---|---|---|---|---|---|
| yes | yes | 5,114 | 5,130 | 4,000 | 1,866 | 242 | 256 | **16** |
| yes | no | 5,114 | 0 | 4,000 | 0 | 77 | 0 | **0** |
| no | yes | 0 | 5,130 | 0 | 0 | 0 | 0 | **0** |
| no | no | 0 | 0 | 0 | 0 | 0 | 0 | **0** |

and the same two flies with no graft at all answer **0 everywhere**. Mean of 5 seeds; every seed the same.

Each half of it is past a plain fly in this model: B cannot hold "I saw food" for longer than 50 ms, and
neither of them can put a heard signal together with something it already knows.

One leak worth naming: B clicks 77 times in the row where it knows nothing. That is the giant fibre -
the escape neuron - startling at A's buzz, which is what a real fly does. It is a third of the rate of a
real answer and stays under what opens A's gate, so it never becomes a false yes, but it is there.

**In the browser**: [/kaiwa/](../kaiwa/) runs the same two brains on two NeuroMechFly bodies, with a
control for each link of the chain. `kakou/bake.mjs` writes the grafted graph both flies load
(`kaiwa/data/talk783.fbg.gz`, 28.5 MB) after checking it headless; the two brains together are 232 MB of
wasm and run a trial at about 3x real time, so the page plays it back at the speed it happened.

**And it does not take a whole brain to do it.** Of the 138,767 neurons, only **3,150 ever fire** in any
of the twelve conditions the page runs, and 195,599 of the 15,103,119 connections (1.3%) run between
those. Removing a neuron that never fires is the same as silencing it - its outgoing synapses were never
delivered either way - so `kakou/cut.mjs` keeps only those and checks the result: over 6 cuts x 2 x 6
seeds, **all 72 trials come out identical, spike for spike**. 28.5 MB becomes **281 KB**, and 107.6 MB of
wasm a brain becomes **4.1 MB**. The cut is specific to this demo; a neuron left out is one that did
nothing here.

Cutting the chain, 3 trials a cell:

| | B saw food: A ate | B did not: A ate | A asks | B answers |
|---|---|---|---|---|
| nothing cut | **3/3** | 0/3 | 4,000 | 241 |
| A deafened | 0/3 | 0/3 | 4,000 | 243 |
| B deafened | 0/3 | 0/3 | 4,000 | **0** |
| A's wings stopped | 0/3 | 0/3 | 4,000 | **0** |
| B's voice stopped | 0/3 | 0/3 | 4,000 | 243 |
| B shown nothing | 0/3 | 0/3 | 4,000 | 76 |

One cell is positive and every cut kills it, and the diagnostics say *where* each cut breaks it: deafen A
and B still answers (243) into a fly that cannot hear; deafen B and there is no answer at all (0), because
the question never arrived. A's own state is the same in every row. What decides whether it eats is
information only B ever had.

## What is not shown

Every graft here is measured on mechanism - what the circuit does, and what it costs the animal. **None
of them has been shown to make a learned task better.** The channel benchmark (`channels.mjs`) has its
baseline and no more; /hiragana/ has not been re-run on a grafted brain.

Two negative results worth keeping, both from trying to make the letters work:

- **More pixels do not help.** 1-nearest-neighbour across 40 fonts tells the 92 kana apart at 0.748 from
  16x16, 0.720 from 32x32 and 0.708 from 48x48. The fly gets 0.463. The information is already in 16x16
  and the brain is losing it.
- **Silence the rest of the brain, or measure nothing.** Run the same letters without silencing what is
  outside the mushroom body and 72.6% of the Kenyon cells fire and a run takes 148 s; silenced, it is
  9.2% and 52 s. The difference is the whole-brain model's olfactory runaway driving the Kenyon cells,
  not anything about the code. Every number above is with it silenced.
- **The olfactory route cannot use position.** `juku/reader.mjs` deals pixels across a shuffled deck of
  projection neurons: of 240 neighbouring pixel pairs, 5 land anywhere near each other. The route is
  permutation-invariant - scramble every picture the same way and nothing changes - so no number of
  channels through that door can ever give a local feature. Position only comes in through the eye.

## Running it

```sh
node kakou/hold.mjs                      # the baseline and the ring sweep
node kakou/hold.mjs groups=2 rec=16      # one configuration
node kakou/erase.mjs                     # write / hold / clear / rewrite
node kakou/gate.mjs                      # the delayed match to sample
node kakou/gate.mjs gb=8 vg=128 gap=10000
node kakou/gate.mjs cue=vpn:LC4:L+vpn:LC4:R other=vpn:LPLC2:L+vpn:LPLC2:R
node kakou/see.mjs                       # does the eye reach the brain (it does not)
node kakou/see.mjs hz=1000 base=10
node kakou/bridge.mjs                    # the visual pathway, built
node kakou/bridge.mjs fan=71 hz=150
node kakou/channels.mjs add=0 letters=8 samples=3   # the way in to the mushroom body
```

and what was built out of all of it:

```sh
node kakou/sequence.mjs                  # the state machine
node kakou/talk.mjs                      # two brains, one line between them
node soroban/soroban.mjs                 # the soroban these parts add up to
```

Brain model: Shiu et al., *Nature* 2024 (MIT); FlyWire connectome v783 (CC-BY 4.0).
