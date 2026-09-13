# hae.satoru.net — a fruit-fly brain that learns to read and write

The site at **https://hae.satoru.net/**: the whole *Drosophila* brain model of
Shiu et al. (2024) running in the browser as WebAssembly, on the FlyWire
connectome, driving a NeuroMechFly body.

- **/** — ひらがな読み書き学習したハエ: the mushroom body trained on 46 hiragana.
  It reads a picture (or your handwriting), writes its answer on the ground with a
  front leg in stroke order, and is fed when it is right.
- **/suji/** — the same fly trained on MNIST digits 1-9.
- **/juku/kiroku.html** — visitors' handwriting and how the fly read it.
- **/tataki/**, **/game2/**, **/game/** — games with the flies; **/kansatsu/**,
  **/gakushu/**, **/meiro/**, **/test01-04/** — earlier experiments.

It is a static site (nginx) plus three small Node processes (pm2).

## How the reading fly works

- **Brain**: `flybrain/` — the Shiu et al. leaky integrate-and-fire model rewritten
  as a ~19 KB WebAssembly core (`src/brain.c`) with a JS wrapper. Spike-for-spike
  identical to Brian2 with plasticity off (`flybrain/test/det*.mjs`). See
  `flybrain/README.md`.
- **Learning** (added here, not in the published model): dopamine-gated plasticity
  on Kenyon-cell → MBON synapses. The fly answers first; only a wrong answer brings
  dopamine while the picture is still shown - depression for the right letter's
  compartment, potentiation (negative dopamine) for the letter it picked.
- **Reading**: pixels drive the 685 olfactory projection neurons; the mushroom body
  alone is simulated (the rest is silenced: any olfactory input tips the full model
  into a runaway). 96 MBONs are dealt into one compartment per letter; the answer is
  the compartment its MBONs are driven least by (`juku/reader.mjs`).
- **School**: `juku/trainer.mjs` practised each course on the server
  (`JUKU_MAX` = 100,000 pictures) and wrote `juku/state/<course>/`: the learned
  synapse gains (`brain-<n>.bin.gz`, Float32), `status.json` and `log.jsonl`.
  Final held-out scores: digits 89.6% (110,217 pictures), hiragana 76.1% on five
  fonts never used in practice (100,000 pictures, all 46 letters).
- **Pages**: `juku/page.js` (shared UI), `juku/worker.js` (the page's copy of the
  brain, loaded with the server's gains), `suji/flag.js` (the 3D fly: writing by IK,
  waiting, eating through a proboscis tube, flying), `juku/api.mjs` (the
  handwriting record).

## Running it

```sh
# static files: serve this directory (nginx in production; any static server works)
npx serve .            # then open http://localhost:3000/

# the trainers (optional; the repo already has the learned brains)
node juku/trainer.mjs suji
node juku/trainer.mjs hiragana
# or: pm2 start juku/ecosystem.config.cjs
```

`.mjs` files must be served as `application/javascript` (nginx does not know the
extension by default). The handwriting record needs `juku/api.mjs` behind
`/juku/api/`.

Rebuilding the WASM core: `ZIG="python3 -m ziglang" flybrain/build.sh`.

## Credits and licenses

Code written for this project: MIT (see `LICENSE`). Everything else keeps its own
license:

- **Brain model**: [philshiu/Drosophila_brain_model](https://github.com/philshiu/Drosophila_brain_model)
  (Shiu et al., *Nature* 2024), MIT.
- **Connectome** (`flybrain/data/flywire*.fbg.gz`, positions): FlyWire
  ([Dorkenwald, Matsliah et al. 2024](https://codex.flywire.ai/)), CC-BY 4.0.
  Cell-type annotations: [Schlegel et al. 2024](https://github.com/flyconnectome/flywire_annotations), CC-BY 4.0.
- **Body** (`test03/nmf/`): NeuroMechFly v2 from [flygym](https://github.com/NeLy-EPFL/flygym), Apache-2.0.
- **three.js** (`test03/vendor/`): MIT.
- **MNIST** (`juku/data/mnist12_*.bin.gz`, downsampled): Y. LeCun, C. Cortes, C. Burges, CC BY-SA 3.0.
- **Stroke order** (`suji/strokes.json`): derived from [KanjiVG](https://kanjivg.tagaini.net/), © Ulrich Apel, CC BY-SA 3.0.
- **Hiragana glyphs** (`hiragana/kana48.bin.gz`): rendered from Google Fonts Japanese
  families, SIL Open Font License 1.1.

The flight, grooming and writing movements are hand-made; flygym has no flight.
