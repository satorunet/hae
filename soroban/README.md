# soroban — ハエにそろばん覚えさせてみた

**[hae.satoru.net/soroban/](https://hae.satoru.net/soroban/)** — a soroban built out of new neurons
inside a real fly's connectome, and a fly that works it with its own six legs.

[`kakou/`](../kakou/) showed that circuits can be added to this brain by hand: a ring that holds, an
inhibition that clears it, a disinhibited gate that puts two things together, and four of those in a
row making a state machine. Nothing here is a new mechanism. Everything here is a new *machine*: first
a calculator that counts (`machine.mjs`, below), and then the thing the page actually runs — **a
soroban**, eight rods of beads inside the brain, moved by rules rather than counted.

The page is the same brain, live: 8-digit addition, subtraction and multiplication, the beads driven by
what the rings are showing, and a NeuroMechFly body reaching for every bead with inverse kinematics.

## Why a soroban fits this brain

A rod is already the shape of what this brain can hold. A ring of cells that feeds itself holds **one**
state, so a digit wants to be one-hot — and a soroban rod *is* one-hot twice over: a five-bead that is
up or down, and four one-beads of which some number are up. `5h + e`.

And a soroban never counts. `7 + 8` on a rod is not fifteen of anything; it is *take the five, give
back its complement, carry one*. Every rule is "in this state, with this input, go to that state",
which is exactly the disinhibited gate of kakou graft 3 and the state machine of graft 6. The counting
machine below needs up to nine turns of a clock per digit; the soroban needs **one**, and the whole
operand goes in at the same time because every rod is different cells.

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

# Before the soroban: the counting machine

The rest of this is how the brain was taught to hold a number at all, and the calculator that came out
of it — ten rings a digit, counted up one at a time, with the digits read by the fly's own eye.

## What a fly cannot do

Half a second is beyond it. 200 ms of a taste and 50 ms later the whole brain is silent, 0 spikes of
138,639 neurons, and what it was is gone (`kakou/hold.mjs`). A fly asked to remember 4 while it looks
at a 7 has nowhere to put the 4.

## A digit (`digit.mjs`)

Ten rings of 32 cells, one per value, one of them up. Incrementing is the transition k → k+1: a gate
that the tick opens only where the digit is now, which writes the next ring and puts its own out.

**One pulse walks the whole counter.** Wire that gate straight from one ring to the next and a single
200 ms tick does not advance the digit by one - it advances it by four, because as soon as k+1 is up
the same pulse is standing at k+1's gate:

| ticks of a 200 ms pulse | 1 | 2 | 3 |
|---|---|---|---|
| a counter with one layer of rings | **4** | **8** | **2** |
| what it should say | 1 | 2 | 3 |

So the digit is built the way hardware is, **master and slave**: the tick writes a shadow, and only the
tock copies the shadow into the digit. Nothing is ever read in the phase that writes it.

    TICK   M[k] & asked  ->  gate  ->  writes S[k+1], clears M[k], and if k = 9 writes the carry
    TOCK   S[k]          ->  gate  ->  writes M[k]
    CLEAR  every shadow and every carry is wiped

| | |
|---|---|
| counting 0,1,...,9,0,1,... | **40 of 40 ticks right** |
| the carry ring | up exactly on the 9 → 0 tick, and only then |
| cost | 1,160 new cells (20 rings, 20 gates, 20 vetoes, a carry) |

## How hard you may write a ring (`write.mjs`)

kakou's `W.memory()` writes with 60 synapses a driver, which is what graft 1 was measured with -
drivers being cells *downstream* of a taste, firing 28 spikes in 200 ms. This machine writes its rings
from cells driven at 150 Hz directly, and from gates. At 60 the ring takes the write and dies.

32 cells, 24 drivers at 150 Hz for 200 ms, then 600 ms of nothing; the spikes in the last 200 ms:

| ring | feed 4 | 8 | 12 | 16 | 24 | 32 | 60 |
|---|---|---|---|---|---|---|---|
| **2 groups, 16 synapses a pair** | 680 | 680 | 680 | **676** | 688 | 688 | 512 on some seeds, out on others |
| 2 groups, 8 | out | out | out | out | out | out | out |
| 3 groups, 16 | out | out | out | out | out | out | out |
| 3 groups, 32 | 568 | 565 | 710 | 1131 | 1131 | 1133 | 851 |
| 4 groups, 32 | 426 | 684 | 678 | 682 | 766 | 848 | 686 |

It is graft 1's own failure arriving through the front door: a ring holds because the wave goes round
and each group is fed out of its refractory period, and a write hard enough to fire every cell at once
leaves the volley landing in the refractory period, where this model drops it. **Self-excitation that
is synchronous puts itself out - and so does a write that synchronises it.**

And how hard is too hard depends on who is writing. In the machine the rings are written by gates of 16
cells, and there the ceiling is lower still: the counter is right 40 of 40 ticks at 8, 12 and 16
synapses, and **5 of 40 at 24**. Everything here writes with 16.

## The machine (`machine.mjs`)

Two registers of D digits and one wire between them.

    ACC   the accumulator. It counts up by one, and carries.
    OP    the operand. It counts down by one, and stops at zero.

    TICK   OP[k] & run       -> gate -> OP holds k-1,  and this gate is what asks ACC to count up
           ACC[j] & (asked, or the digit below carried) -> gate -> ACC's shadow holds j+1
           ACC[9] & ...      -> gate -> ... and writes this digit's carry, which asks the next digit
    TOCK   every shadow that is up becomes its register's digit
    CLEAR  shadows, carries and the "asked" ring are wiped

Adding a digit is a loop, and **the loop stops itself**: there is no down-gate on OP's state 0, so once
the operand digit is spent nothing asks and the accumulator stands still. This matters more than it
looks. Nobody outside the brain ever has to know what the digit was - which is the whole point, because
the digits come from the fly's eye and the fly is the only one that has read them.

Three vetoes on one gate make the three-way AND (kakou graft 3: two subthreshold excitations do not add
up to one, but a gate that is barely driven and vetoed opens when the veto is silenced). One veto per
accumulator digit carries the question "is this digit being asked", and it is silenced by the operand's
gate, or by the carry below it, or by the borrow below it - an OR for the price of nothing.

### Adding (`add.mjs`)

3 digits, 7,320 new cells, phases of 200 ms. Every number goes in one digit at a time; the machine is
told nothing but "the operand is in, now turn the clock".

| sum | loaded | turns of the clock | the fly says | |
|---|---|---|---|---|
| 12+34 | 012 034 | 2+1+0 then 4+3+0 | **046** | right |
| 47+38 | 047 038 | 7+4+0 then 8+3+0 | **085** | right |
| 99+1 | 099 001 | 9+9+0 then 1+0+0 | **100** | right |
| 123+456 | 123 456 | 3+2+1 then 6+5+4 | **579** | right |
| 777+345 | 777 345 | 7+7+7 then 5+4+3 | **122** | right |
| 908+92 | 908 092 | 8+0+9 then 2+9+0 | **000** | right |
| 500+500 | 500 500 | 0+0+5 then 0+0+5 | **000** | right |
| 1+999 | 001 999 | 1+0+0 then 9+9+9 | **000** | right |

8 of 8, 24.8 s of fly in 99 s of wall clock. The machine works mod 1000, so 908+92 is 000 with the
carry running off the top, which is what a machine of three digits does.

### The clock (`add.mjs ripple=1`)

The clock comes from outside - tick, tock, clear, zero, wipe and one run line per digit position, each
a real sensory population pulsed at 150 Hz (Johnston's organ, the bristles, the ocelli, four of the
object-detecting visual populations). **The fly is not making the rhythm, it is hearing it.** Building
an oscillator that paces itself is a different graft and is not in this one.

How long a phase has to be is set by the carry. The accumulator is put at 999 and asked for one more:

| | |
|---|---|
| the operand's gate asks | 20 ms |
| digit 0 writes its shadow | 80 ms |
| digit 1 | 120 ms |
| digit 2 | 160 ms |

**A carry costs 40 ms a digit**, because the gate that carries silences the next digit's veto in 2 ms
but the ring behind it needs ~40 ms to come up and hold it there. So the tick is made 200 ms + 80 ms
per digit above the first. The rest is slack: at 100 ms phases (a 260 ms tick) the same eight sums are
still 8 of 8 in two thirds of the time, and at 60 ms it falls apart - 1 of 8, the operand registers
losing their place as well as the carries.

### Taking away, and multiplying (`keisan.mjs`)

Two more things out of the same parts. **Minus** is a second bank of gates on the accumulator that
counts down, with a borrow where the carry was; which bank fires is decided by a veto per direction,
so the "plus" line silences one, the "minus" line the other, and a tick with neither does nothing.
**Times** is a loop register - one more operand register, wired to no accumulator, that nothing wipes
between operands - and multiplying is adding the same number until that register is spent. What stops
the multiplication is a ring going quiet.

3 digits, 9,432 new cells:

| | the fly says | | | the fly says | |
|---|---|---|---|---|---|
| 12+34 | 046 | right | 80−27 | **053** | right |
| 99+1 | 100 | right | 500−321 | **179** | right |
| 123+456 | 579 | right | 12−30 | **982** | right (ten's complement) |
| 7×8 | **056** | 8 rounds of 7 | 23×4 | **092** | 4 rounds of 23 |
| 111×9 | **999** | 9 rounds of 111 | | | |

10 of 10, 38.2 s of fly.

## The digits come from the eye (`yomu.mjs`)

[`/suji/`](../suji/) has a fly that reads handwritten numerals - pictures go in where odours do, the
mushroom body makes a sparse code of each one, and 110,217 practices of dopamine-gated depression left
it right on 89.6% of MNIST's test digits. That fly could read a digit and do nothing with it.

This is the same fly with the machine grafted in, **one brain**: it looks at a picture, what it read is
written into a ring register, and the registers add. Nothing is held outside the brain in between.

**Does a brain that is holding a number still read?** 90 test digits, the same pictures both ways:

| | |
|---|---|
| reset between pictures, as /suji/ runs it | 92.2% |
| never reset, two registers holding a digit throughout | **90.0%** (584 Kenyon cells a picture) |

and the registers are still showing what they were given afterwards. Holding a number costs the
reading about two points, which is the price of never resetting rather than anything about the graft.

**Twelve sums of two two-digit numbers, every digit read from a picture:**

| | |
|---|---|
| digits read right | 44 / 48 (91.7%) |
| sums right end to end | 8 / 12 |
| sums where every digit was read right | 8, **of which the arithmetic was right 8** |

Every wrong answer is a misread digit, and in every one of them the machine added exactly what the fly
thought it saw (23+15 read as 73+15 and answered 88). **The arithmetic never made a mistake.**

## What is not in the brain

One comparison. The answer to "which digit is this" is the compartment whose MBONs the picture drives
*least*, and that is worked out in arithmetic outside, as it is on /suji/, /hiragana/ and /kana/. It
cannot be done with neurons here: over 40 test digits the drive rule is right **38** times and the
least-*spiking* compartment **2**, because in a brain silenced outside the mushroom body the MBONs
barely fire at all (0-41 spikes a compartment). So the reading is the fly's, the comparison is not, and
everything after it - the digit, the carry, the borrow, the sum - is back inside.

Also outside: the clock, and the decision to stop turning it, which is made by looking at whether the
operand register is showing 0. That is the machine's own signal, not knowledge of the operand.

And the fly has no zero. /suji/ was taught MNIST's 1-9, so the numbers it is *shown* have no zero in
them. Its answers do.

## What it costs the animal

With the whole machine in place, against the plain connectome over 1 s:

| | neurons differing | total spikes | MN9 |
|---|---|---|---|
| sugar | **0 / 138,639** | 12,360 vs 12,360 | 75 vs 75 spikes |
| bitter | **0 / 138,639** | 4,222 vs 4,222 | 0 vs 0 |
| nothing | **0 / 138,639** | 0 vs 0 | 0 vs 0 |

The fly eats as it always did. The calculator is silent until the clock starts.

## One trap, fixed in the workshop

A new cell wired to more targets than it had free slots used to run off the end of its row in the CSR
and **quietly rewire the cell next to it**. That is what a shared veto with 160 targets did here: the
machine's second digit counted along with the first, for no reason visible in the wiring. `graft.mjs`
now gives a new cell as many slots as its links need and throws if a row is ever overrun.

## In the browser (`bake.mjs`)

*(The page now runs the soroban — see below. This is the counting machine's own bake.)*

The page ran the same machine, live. The grafted brain is 148,199 neurons and 16.4 million connections,
so `bake.mjs` cuts it twice: to the machine plus the 264 sensory cells it is wired from, and then to the
synapses that carry anything (a new cell is given 96 outgoing slots and uses a few dozen; the rest point
at itself with nothing in them). The connectome's own rows are left exactly as they are, so /suji/'s
learned weights still line up with them.

| | |
|---|---|
| the machine alone | 9,824 neurons, 603,948 connections, **34 KB** gzipped |
| with the mushroom body, so the page can also *read* | 16,117 neurons, 1,174,654 connections, **788 KB** |
| wasm | 19.4 MB, and it runs at **3.3x real time** |
| checked before writing | the cut brain's answers, digit for digit, against the machine in the whole brain |
| and the reading checked too | **89.4%** of 180 MNIST test digits, against 89.6% for the whole brain |

With 手書き on, the page does what `yomu.mjs` does: it shows the fly a handwritten numeral, the mushroom
body reads it, and **what it read is what goes into the register**. Headless, over 5 sums shown that way,
49 of 49 digits were read right and all 5 sums came out as the fly read them.

## The soroban in the browser (`bake-soroban.mjs`)

The grafted brain is 173,399 neurons. The page cannot hold that, so the bake cuts it to the cells that
actually fire plus the machine and the lines it listens to, and drops the empty synapse slots on the
new rows only — the connectome's own rows are left exactly as they are.

| | |
|---|---|
| 8 rods and the loop rod | 34,760 new cells on top of 138,639 |
| what the page loads | **34,976 neurons, 2,584,695 connections, 118 KB** gzipped |
| checked before writing | every answer of the cut brain against the same machine in the whole brain |
| a sum | ~1.3–2.7 s of fly time, about 2.5x real time |

The beads themselves are physics: they slide on their rods and stop against the beam, the frame and
each other, and the fly's six legs are aimed at them by inverse kinematics on the NeuroMechFly body
shared with the rest of the site. The number over the board is read off the **beads**, not off the
rings, so it only agrees with the machine once the fly has finished hitting them.

## Running it

```sh
node soroban/soroban.mjs                # the soroban: add the standard set and check every digit
node soroban/soroban.mjs sums=999+1,123+456
node soroban/soroban.mjs race=1         # soroban against the counting machine, in fly time
node soroban/bake-soroban.mjs digits=8  # the brain the page loads, cut and checked
```

and the counting machine that came first:

```sh
node soroban/digit.mjs                  # one digit: count to 9, wrap, carry
node soroban/digit.mjs oneshot=1        # and what happens without the slave layer
node soroban/write.mjs                  # how hard a ring may be written
node soroban/add.mjs                    # three-digit addition
node soroban/add.mjs fidelity=1         # and what it costs the animal
node soroban/add.mjs digits=3 ripple=1  # how long a carry takes to travel
node soroban/keisan.mjs                 # plus, minus and times
node soroban/keisan.mjs sums=500-321,23*4
node soroban/yomu.mjs control=1 n=12    # the digits read from MNIST by the fly itself
node soroban/hyou.mjs                   # can it *recall* the table instead of counting it out?
node soroban/bake.mjs                   # its own cut brain
```

The share card is drawn, not shot: `python3 soroban/tools/og-card.py && rsvg-convert -w 1200 -h 630
soroban/og-card.svg -o og-soroban.png`.

Brain model: Shiu et al., *Nature* 2024 (MIT); FlyWire connectome v783 (CC-BY 4.0); MNIST digits
(CC BY-SA 3.0). The workshop is [`kakou/graft.mjs`](../kakou/graft.mjs); the reader is
[`juku/reader.mjs`](../juku/reader.mjs) with /suji/'s trained weights.
