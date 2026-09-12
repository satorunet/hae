# flybrain.js — the whole fruit-fly brain in WebAssembly

The Shiu et al. (2024, *Nature*) leaky integrate-and-fire model of the entire
*Drosophila* brain (philshiu/Drosophila_brain_model), rewritten as a ~9 KB
WebAssembly core plus a small ES-module wrapper. It runs in browsers and in Node 18+.

- FlyWire v630: 127,400 neurons, 14,687,178 connections (the paper's version)
- FlyWire v783: 138,639 neurons, 15,091,983 connections (the public release)

## Use

```js
import { FlyBrain } from 'https://hae.satoru.net/flybrain/flybrain.js';

const brain = await FlyBrain.load({
  graph: 'https://hae.satoru.net/flybrain/data/flywire630.fbg.gz',   // default
  onProgress: (p) => console.log(p.phase, p.loaded, p.total),
});

const SUGAR = ['720575940624963786', /* ... the 21 sugar GRNs ... */];
const MN9 = '720575940660219265';

brain.stimulate(SUGAR, 150);   // Poisson input at 150 Hz (FlyWire root ids)
brain.reset(1);                // back to rest, seed 1
const r = brain.run(1000);     // 1000 ms; r.idx / r.t = every spike (model index, ms)
brain.rate(MN9);               // ~83 Hz
```

| method | |
|---|---|
| `FlyBrain.load({ graph, wasm, params, onProgress })` | fetch and build the brain |
| `stimulate(ids, hz)` / `clearStimuli()` | Poisson input (0 Hz removes it) |
| `silence(ids, on)` | zero a neuron's outgoing synapses (as `model.py`'s silence) |
| `kick(ids, mV)` / `setVoltage(ids, mV)` | direct voltage input |
| `run(ms, { events })` | simulate; returns `{ spikes, idx, t, lost }` |
| `reset(seed)` | all neurons to rest, counters to zero (inputs persist) |
| `counts()` / `rate(ids)` / `voltages()` | spike counts, mean rate since reset, membrane potentials |
| `index(id)` / `id(i)` | FlyWire root id <-> model index; pass `{ byIndex: true }` to use indices |
| `outgoing(id)` | a neuron's postsynaptic targets and signed synapse counts |
| `time`, `activeCount`, `n`, `nnz`, `params` | |

Model constants (`params`) default to the paper's: dt 0.1 ms, v0 −52 mV,
threshold −45 mV, τm 20 ms, τsyn 5 ms, refractory 2.2 ms, delay 1.8 ms,
0.275 mV per synapse, Poisson kick 250 × 0.275 mV.

## How exact is it

- **Spike for spike identical to Brian2** on deterministic tests: the 21 sugar
  GRNs forced to fire once (32/32 spikes, same neurons, same 0.1 ms steps) and
  every 3 ms for 120 ms (2,897/2,897). `test/det.mjs`, `test/det2.mjs`.
- **Poisson sugar experiment** (150 Hz, 30 × 1 s) against a Brian2 rerun:
  per-neuron rate correlation 0.9997, MN9 83.1 ± 4.3 Hz vs 84.9 ± 4.9 Hz,
  1 of 438 active neurons outside 3 standard errors. `test/validate.mjs`.
- Two details of Brian2's generated code that the equations don't show are
  reproduced: `not_refractory` is evaluated once per step in the state updater,
  and every update of an `(unless refractory)` variable is masked by it —
  **synaptic input that reaches a refractory neuron is dropped, not held**.
  Without that, downstream rates come out ~30% too high.

## How fast

About 74 ms per simulated second for the sugar experiment in Node (13× real
time; Brian2's numpy backend took ~22 s per simulated second on the same
machine). The core is event-driven with an exact bound: between inputs a
neuron's trajectory is closed-form, and its peak can be bounded, so neurons that
provably cannot reach threshold before their next input are not stepped at all
— they are advanced in one jump when the next input arrives. Typically only a
few hundred of the 127k neurons are stepped.

## A property of the model worth knowing

On v783, stimulating olfactory receptor neurons (even at 10 Hz), thermo- or
hygrosensory neurons, or R1-6 photoreceptors throws the whole brain into a
self-sustaining state of ~450,000 spikes/s that continues after the input
stops. Brian2 does exactly the same (checked). The LIF model has no adaptation
or other brake, so some recurrent circuits, once lit, keep going.

## Files

- `flybrain.js`, `flybrain.wasm` — the library
- `src/brain.c`, `build.sh` — the core (freestanding C → wasm32 with Zig's clang)
- `data/flywire630.fbg.gz`, `data/flywire783.fbg.gz` — graphs (delta-coded byte planes, gzip)
- `data/groups783.json` — sensory / descending / motor neuron groups for v783 (from FlyWire annotations)
- `data/pos783.bin.gz` — neuron positions and classes for drawing
- `tools/` — the exporters; `test/` — validation, screens and probes

Demo: [/test02/](../test02/) — a fly in an arena driven by this brain.

Model code: philshiu/Drosophila_brain_model (MIT). Connectome and annotations:
FlyWire Consortium; Dorkenwald et al. 2024, Schlegel et al. 2024 (CC-BY 4.0).
