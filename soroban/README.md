# soroban — ハエにそろばん覚えさせてみた

**[hae.satoru.net/soroban/](https://hae.satoru.net/soroban/)** — a soroban built out of new neurons
inside a real fly's connectome, worked by a fly with its own six legs.

The brain is the FlyWire v783 connectome, 138,639 neurons and 16.35 M connections, run as the
whole-brain leaky integrate-and-fire model of Shiu et al. Nothing in it was rewired. New neurons were
added beside it, and out of them: eight rods of beads that add, subtract and multiply 8-digit numbers.
The number on the page is not computed anywhere else — it is read off which neurons are firing.

## What a fly cannot do

Give it 200 ms of sugar and stop: 50 ms later not one of the 138,639 neurons is still firing
([`kakou/hold.mjs`](../kakou/)). Half a second is beyond it, so "do something about what you just saw"
has nowhere to live.

## The four parts that were added (the calculation API)

The connectome has no free synapse slots, so a new connection would have to take an existing one.
[`kakou/graft.mjs`](../kakou/graft.mjs) grows the graph instead: new cells at the end of the CSR and
extra empty slots on the rows that need them. **Grown but unwired, the brain is spike-for-spike the
connectome's — 0 of 138,639 neurons differ.**

| | what it is | how it had to be built |
|---|---|---|
| **save & loop** | holds a value | a ring wired all-to-all goes out at once: everyone fires together and the volley lands in each other's refractory period. Split into groups that push only the next group, it runs like a bucket brigade and still holds after 10 s. Holding *is* circulating — a delay line, not a flip-flop |
| **reset** | clears it | another cell saying "stop" into the ring. Too weak and it survives; too strong and it never comes back up. 16–64 synapses works, 128 does not |
| **if** | "only when" | two subthreshold inputs do **not** add up here — one alone gets through. What works is the other way round: a cell that constantly vetoes the path, and the condition silences *it*. Every soroban rule is this shape |
| **program control** | one step after another | save = the state, if = the condition to move on, reset = forget the last state. Three in a row answer only to A-then-B-then-C, which is place → move → commit |

## Why a soroban, out of those four

No circuit here adds. A box that takes two numbers and returns their sum cannot be built from this
material. But a soroban does not add either — it *moves beads*: the number is not recorded anywhere,
it **is** where the beads are, and arithmetic is a pile of rules of the form "in this arrangement, move
that bead". So a soroban needs exactly two things: somewhere to keep a value, and rules to move it by.

    one bead        = one save & loop
    one rule        = one if
    clearing a rod  = reset
    place/move/commit = program control

A rod is also the right shape twice over: a ring holds **one** state, and a rod is a five-bead that is
up or down and four one-beads of which some are up. `5h + e`.

## A rod (`soroban.mjs`)

    h   a one-hot pair     the five-bead: up or down
    e   a one-hot five     the one-beads: 0-4 of them up
    b   the operand        the same again, holding the digit being put in
    c5 / c5no              did the one-beads pass five
    cout                   did the rod pass ten

    TICK    e + be  -> the earth gate  -> writes the shadow, says whether it reached five
            h + bh + c5 -> the heaven gate -> writes the shadow, says whether the rod carried
    TOCK    every shadow becomes the beads
    CARRY   one carry tick ripples every cout into the rod above
    CLEAR   shadows and carries are wiped
    SET     a digit straight onto the beads, the way a hand places a number

Master and slave, as in the counting machine: nothing is ever read in the phase that writes it.
Taking away is a second bank of gates with a borrow where the carry was; multiplying is a **loop rod**
that is not part of the number, counted down a round at a time until it is spent.

Eight rods and the loop rod: 34,760 new cells, phases of 100 ms, a tick of 740 ms (a carry costs 40 ms
a rod to travel, so the tick has to be long enough for the deepest ripple).


## Placing, not clearing

The board is not wiped between sums, and this is most of what makes the page feel quick.

* What is keyed in is **placed** straight onto the beads, one pulse, the way a hand does.
* The **second** number is never put on the board at all — at `=` the first one is already standing
  there, so there is no ご破算 and no placing, only the move itself.
* The answer is left standing, so a sum carried on from it starts from where it is.
* Adding and multiplying are the same either way round, so whichever number is already up is the one
  the machine treats as placed.

| | placed each time | from the beads as they stand |
|---|---|---|
| 12 + 34 | 1.45 s of fly | **1.25 s** |
| 5000 − 1234 | 2.45 s | **2.25 s** |
| 123 × 9 | 26.35 s | **23.80 s** |

**One trap, and the rule that came out of it.** Writing a digit over a rod that already has beads up
leaves that rod half-driven: the board *reads* right, but a borrow that has to travel through it later
comes out wrong (`7 − 9` answered `49999998` instead of `99999998`). A rod is now emptied before the
new digit goes on, which is what a hand does anyway, and a rod already showing the wanted digit is not
touched at all.


## Where the learning is, and where it is not

The mushroom body is a learning machine already, and it is used — for **reading the digits**.
Handwriting has no rule, so that part is [`/suji/`](../suji/)'s: 110,217 practices of dopamine-gated
depression, ~90% on MNIST test digits, kept as synaptic gains in the same brain.

From the moment a digit is on the beads, nothing is learned. "In this arrangement, move that bead" can
be written down, so it is wired, not taught — **rules where rules exist, learning only where they do
not**. `hyou.mjs` tried the other way, learning the addition table by heart: the carry came easily, the
digit never did. Moving beads is both quicker and right.

The honey after a correct sum is decoration. There is no plasticity anywhere in the soroban.

## Eight digits

Eight rods, plus one that is not part of the number and counts the rounds of a multiplication.
99999999 + 1 is 00000000 and 0 − 1 is 99999999: it overflows off the top like an odometer. More rods
means more digits — they are wired side by side, `digits=N`.

## What it costs the animal

Nothing. With the soroban in place and no line pulsed, the brain is the connectome's, spike for spike,
on sugar, on bitter and on silence. The soroban is silent until something drives it.

## Cutting it down for the browser

The grafted brain is 173,399 neurons; nobody is downloading that. The bake does the expensive part on
the server: build the graft, run every check sum in the **whole** brain, then keep only the cells that
actually fired and the cells that drive them, and drop the empty synapse slots — on the new rows only,
so the connectome's own rows still line up with /suji/'s learned weights. Deleting a cell that never
fires is the same as silencing it, and it is checked: **the cut brain's answers must equal the whole
brain's, digit for digit, or nothing is written.**

| | |
|---|---|
| grafted | 138,639 + **34,760** new cells = 173,399 |
| what the page loads | **34,976 neurons, 2,584,695 connections, 118 KB** gzipped |
| the engine | [`flybrain/`](../flybrain/) — 19 KB of WebAssembly |
| a sum | 1.3–2.7 s of fly time, ~2.5x real time |

---

# Using it

Node 20+ (22 here). No install, no dependencies: the brain files are in `data/`, the engine is
`../flybrain/`.

## The soroban, headless

```sh
node soroban/soroban.mjs                    # the standard set of sums, every digit checked
node soroban/soroban.mjs sums=999+1,123+456,7*8,500-321
node soroban/soroban.mjs digits=8 ms=100    # rods, and the length of a phase
```

```
15520 new cells, 3 rods, phase 200 ms, tick 440 ms

       12+34 = 046   right   1.75 s of fly in 0.7 s
     500-321 = 179   right   0.90 s of fly in 1.5 s
         7*8 = 056   right   23.75 s of fly in 14.3 s
```

`build({ digits, plain, loop, ms })` returns a `Soroban`; the methods are the machine's:

```js
import { Workshop } from '../kakou/graft.mjs';
import { build } from './soroban.mjs';

const plain = await (await Workshop.open({ cells: 1 })).build();   // the connectome, to pick drivers in
const M = await build({ digits: 8, plain, loop: true, ms: 100 });
M.reset(1); M.zero();
M.place(12);            // straight onto the beads, one pulse
M.put(34); M.add();     // the operand in, then one move (+ the carry ripple if any rod carried)
M.number();             // '00000046' - read off the beads
M.put(8); M.sub();      // and take away
M.times(23, 4);         // rounds of adding, counted down on the loop rod
```

## Baking the brain the page loads

```sh
node soroban/bake-soroban.mjs digits=8 ms=100 loop=1
# -> data/soroban.fbg.gz, soroban.json, soroban-pos.bin.gz, brain-outline.bin.gz
```

It refuses to write if the cut brain disagrees with the whole brain on any check sum. **Re-run it after
any change to `soroban.mjs`**, and bump the versions below, or the page will keep running the old one.

## The page

| file | |
|---|---|
| `index.html` | the four tabs, and the reload guard (`const mine = N`) |
| `app.js` | keypad, the number read off the beads, the brain map, `PAGE_V` |
| `stage.js` | the 3D board: bead physics, the fly, inverse kinematics on the six legs |
| `soroban-worker.js` | the brain itself, in a worker. `BUILD` must match what `app.js` checks |
| `shikumi.html` | the long explanation |

Browsers hold on to these, so **every changed file gets a new `?v=`**: `app.js?v=N` and `const mine = N`
in `index.html`, `stage.js?v=N` and `soroban-worker.js?v=N` in `app.js`, `data/…?v=N` in the worker.
`PAGE_V` is printed on the page, so a stale file can be seen at a glance.

The worker's protocol is four messages in and four out:

```js
worker.postMessage({ type: 'init' });                  // -> progress, then ready { n, nnz, build, mb }
worker.postMessage({ type: 'show', n: 1234 });         // place a number on the beads (typing)
worker.postMessage({ type: 'run', a, op, b });         // op is '+', '-' or '*'
worker.postMessage({ type: 'stop' });
// back: { type:'frame', tag, flyMs, rods, fired, spikes } every 20 ms of fly time,
//       { type:'say' }, { type:'done', answer, flyMs, wall }, { type:'error' }
```

## Testing it without a browser

Everything above was measured this way — stub the three globals a worker gets and import it:

```js
globalThis.fetch = async (u) => new Response(await readFile(new URL(u).pathname.split('?')[0]));
globalThis.postMessage = (m) => { if (m.type === 'done') console.log(m.answer); };
await import('./soroban-worker.js');
globalThis.onmessage({ data: { type: 'init' } });
```

The page itself runs the same way with a DOM stub: `app.js` only ever touches `getElementById`,
`addEventListener` and `requestAnimationFrame`.

## The share card

```sh
python3 soroban/tools/og-card.py
rsvg-convert -w 1200 -h 630 soroban/og-card.svg -o og-soroban.png
```

Drawn, not screenshotted — but the beads are laid out by the real rule, so the board in it is a number
you can read.

---

Brain model: Shiu et al., *Nature* 2024 (MIT); connectome: FlyWire v783 (CC-BY 4.0); body:
[NeuroMechFly v2](https://github.com/NeLy-EPFL/flygym) (Apache-2.0); 3D: three.js (MIT).
The workshop is [`kakou/`](../kakou/).

The directory also holds an earlier calculator that adds by counting (`machine.mjs`, `digit.mjs`,
`add.mjs`, `keisan.mjs`, `bake.mjs`); the soroban replaced it.
