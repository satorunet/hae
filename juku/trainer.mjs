// The flies' school: runs on the server all the time, one process per course.
//
//   node juku/trainer.mjs suji        MNIST digits 1-9
//   node juku/trainer.mjs hiragana    46 hiragana, one row of the table at a time
//
// Every practice picture is new to the fly when it is asked (MNIST's 54k
// training digits in a shuffled cycle; hiragana freshly distorted from one of
// 35 training fonts), so the running score is an honest one. Every EVAL_EVERY
// pictures it also sits a fixed test it never learns from (MNIST's test set;
// hiragana in 5 fonts it has never seen), and that is what moves it up a level.
//
// It writes, under juku/state/<course>/:
//   status.json         what the pages poll: level, counts, the score history
//   brain-<n>.bin.gz    the learned synapse weights (Float32), n = pictures practised
//   live.json           the last few practice questions, rewritten every few seconds
//   log.jsonl           one line per test, never trimmed
import { readFile, writeFile, mkdir, rename, readdir, unlink, appendFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';
import { makeReader } from './reader.mjs';
import * as K from '../hiragana/kana.mjs';

const course = process.argv[2];
const ROOT = new URL('../', import.meta.url);
const STATE = process.env.JUKU_STATE ? new URL(`file://${process.env.JUKU_STATE}/`) : new URL(`state/${course}/`, import.meta.url);
const SAVE_EVERY_MS = 3 * 60e3;
const KEEP_BRAINS = 3;
const WINDOW = 500;                 // the running score is over the last this many
const log = (...a) => console.log(new Date().toISOString(), course, ...a);

await mkdir(STATE, { recursive: true });
const R = await makeReader({ FlyBrain, base: new URL('flybrain/', ROOT), course });
const NL = R.labels.length;
log('ready', { groups: R.groups.map((g) => `${g.name}:${g.inputs}`).join(' ') });

// ---------------------------------------------------------------- the material
let nextPicture, testSet, allowedNow, levelInfo;

if (course === 'suji') {
  const load = async (f) => new Uint8Array(gunzipSync(await readFile(new URL('juku/data/' + f, ROOT))));
  const train = await load('mnist12_train.bin.gz'), test = await load('mnist12_test.bin.gz');
  const rec = 145, nTrain = train.length / rec;
  const img = (buf, n) => Float32Array.from(buf.subarray(n * rec + 1, (n + 1) * rec), (v) => v / 255);
  // a fixed shuffled order, walked forever; the position is part of the saved state
  const order = [...Array(nTrain).keys()];
  const rnd = K.mulberry32(20260913);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  nextPicture = (st) => {
    const n = order[st.cursor % nTrain];
    st.cursor++;
    return { img: img(train, n), truth: train[n * rec] - 1 };
  };
  // 50 per digit from the start of MNIST's test set
  testSet = () => {
    const per = new Array(9).fill(0), out = [];
    for (let n = 0; n * rec < test.length && out.length < 450; n++) {
      const d = test[n * rec] - 1;
      if (per[d] < 50) { per[d]++; out.push({ img: img(test, n), truth: d }); }
    }
    return out;
  };
  allowedNow = () => null;
  levelInfo = () => ({ level: 1, of: 1 });
} else if (course === 'hiragana') {
  const meta = JSON.parse(await readFile(new URL('hiragana/kana48.json', ROOT), 'utf8'));
  const bank = K.unpackBank(gunzipSync(await readFile(new URL('hiragana/kana48.bin.gz', ROOT))), meta);
  const testFonts = K.TEST_FONTS.map((n) => meta.fonts.indexOf(n));
  const trainFonts = [...Array(bank.nf).keys()].filter((f) => !testFonts.includes(f));
  const rowEnd = (level) => K.ROWS.slice(0, level).join('').length;
  allowedNow = (st) => [...Array(rowEnd(st.level)).keys()];
  nextPicture = (st) => {
    const rnd = K.mulberry32(0x5eed + st.practised * 7919);
    const n = rowEnd(st.level), newRow = rowEnd(st.level - 1);
    // half the time from the newest row, so a new row is not drowned by the old ones
    const k = st.level > 1 && rnd() < 0.5 ? newRow + Math.floor(rnd() * (n - newRow)) : Math.floor(rnd() * n);
    const f = trainFonts[Math.floor(rnd() * trainFonts.length)];
    return { img: K.sample(bank, f, k, rnd), truth: k };
  };
  // 5 unseen fonts x each letter unlocked so far x 2 distortions, always the same pictures
  testSet = (st) => {
    const out = [], rnd = K.mulberry32(777);
    for (let rep = 0; rep < 2; rep++) for (const f of testFonts) for (let k = 0; k < NL; k++) {
      const img = K.sample(bank, f, k, rnd);       // drawn for all 46 so each picture never changes
      if (k < rowEnd(st.level)) out.push({ img, truth: k });
    }
    return out;
  };
  levelInfo = (st) => ({ level: st.level, of: K.ROWS.length, letters: K.ROWS.slice(0, st.level).join('') });
}
const LEVEL_UP = 0.75;               // held-out score needed for the next row
const EVAL_EVERY = +process.env.JUKU_EVAL || (course === 'suji' ? 2000 : 1500);

// ---------------------------------------------------------------- state
let st = {
  course, started: Date.now(), practised: 0, wrong: 0, cursor: 0, level: 1,
  history: [],                      // {t, n, test, run, level}
  recent: [],                       // 1/0 for the last WINDOW questions
  lastTest: null,
};

async function loadState() {
  try {
    const s = JSON.parse(await readFile(new URL('status.json', STATE), 'utf8'));
    const saved = JSON.parse(await readFile(new URL('trainer.json', STATE), 'utf8'));
    const gz = await readFile(new URL(s.brain, STATE));
    const gains = new Float32Array(new Uint8Array(gunzipSync(gz)).buffer);
    R.importGains(gains);
    st = { ...st, ...saved };
    log('resumed at', st.practised);
  } catch (e) {
    if (e.code !== 'ENOENT') log('could not resume, starting fresh:', e.message);
  }
}

async function save() {
  const gains = R.exportGains();
  const name = `brain-${st.practised}.bin.gz`;
  await writeFile(new URL(name + '.tmp', STATE), gzipSync(Buffer.from(gains.buffer), { level: 6 }));
  await rename(new URL(name + '.tmp', STATE), new URL(name, STATE));
  const runOk = st.recent.reduce((a, b) => a + b, 0);
  const status = {
    course, labels: R.labels, updated: Date.now(), started: st.started,
    practised: st.practised, wrong: st.wrong,
    running: st.recent.length ? runOk / st.recent.length : null, window: st.recent.length,
    ...levelInfo(st), levelUp: LEVEL_UP,
    lastTest: st.lastTest, history: thin(st.history),
    brain: name, gains: gains.length,
    readouts: R.groups.map((g) => ({ name: g.name, cells: g.cells.length, inputs: g.inputs })),
  };
  await writeFile(new URL('trainer.json.tmp', STATE), JSON.stringify(st));
  await rename(new URL('trainer.json.tmp', STATE), new URL('trainer.json', STATE));
  await writeFile(new URL('status.json.tmp', STATE), JSON.stringify(status));
  await rename(new URL('status.json.tmp', STATE), new URL('status.json', STATE));
  // keep the newest few brains (a page may still be fetching the previous one)
  const old = (await readdir(STATE)).filter((f) => /^brain-\d+\.bin\.gz$/.test(f))
    .sort((a, b) => parseInt(b.slice(6)) - parseInt(a.slice(6))).slice(KEEP_BRAINS);
  for (const f of old) await unlink(new URL(f, STATE)).catch(() => {});
}

// at most ~600 points for the page; the full record is in log.jsonl
function thin(h) {
  if (h.length <= 600) return h;
  const step = h.length / 600, out = [];
  for (let i = 0; i < 600; i++) out.push(h[Math.floor(i * step)]);
  out[out.length - 1] = h[h.length - 1];
  return out;
}

function sitTest() {
  const set = testSet(st), allowed = allowedNow(st);
  let ok = 0;
  const per = new Array(NL).fill(0), perOk = new Array(NL).fill(0);
  set.forEach((q, i) => {
    const seen = R.look(q.img, { seed: 1000 + i });    // looking only: no dopamine, no learning
    const d = R.decide(seen.drive, allowed);
    per[q.truth]++;
    if (d.answer === q.truth) { ok++; perOk[q.truth]++; }
  });
  return { score: ok / set.length, n: set.length, perLetter: per.map((n, c) => (n ? perOk[c] / n : null)) };
}

// ---------------------------------------------------------------- the loop
await loadState();
let lastSave = Date.now(), lastLive = 0;
const feed = [];                    // [truth, answer] of the latest practice questions
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });

while (!stopping) {
  const q = nextPicture(st);
  const r = R.practise(q.img, q.truth, allowedNow(st));
  st.practised++;
  if (!r.ok) st.wrong++;
  st.recent.push(r.ok ? 1 : 0);
  if (st.recent.length > WINDOW) st.recent.shift();
  feed.push([q.truth, r.answer]);
  if (feed.length > 40) feed.shift();
  if (Date.now() - lastLive > 3000) {
    lastLive = Date.now();
    const runOk = st.recent.reduce((a, b) => a + b, 0);
    const live = JSON.stringify({ t: lastLive, practised: st.practised, level: st.level,
      running: runOk / st.recent.length, window: st.recent.length, feed });
    await writeFile(new URL('live.json.tmp', STATE), live);
    await rename(new URL('live.json.tmp', STATE), new URL('live.json', STATE));
  }

  if (st.practised % EVAL_EVERY === 0) {
    const t0 = Date.now();
    const test = sitTest();
    const run = st.recent.reduce((a, b) => a + b, 0) / st.recent.length;
    const point = { t: Date.now(), n: st.practised, test: +test.score.toFixed(4), run: +run.toFixed(4), level: st.level };
    st.history.push(point);
    st.lastTest = { ...point, size: test.n, perLetter: test.perLetter.map((v) => (v == null ? null : +v.toFixed(2))) };
    await appendFile(new URL('log.jsonl', STATE), JSON.stringify(st.lastTest) + '\n');
    log(`n=${st.practised} test=${(100 * test.score).toFixed(1)}% run=${(100 * run).toFixed(1)}% level=${st.level} (${Date.now() - t0} ms)`);
    if (course === 'hiragana' && test.score >= LEVEL_UP && st.level < K.ROWS.length) {
      st.level++;
      st.recent = [];
      log('level up ->', st.level, K.ROWS[st.level - 1]);
    }
    await save(); lastSave = Date.now();
  } else if (Date.now() - lastSave > SAVE_EVERY_MS) {
    await save(); lastSave = Date.now();
  }
  // let the event loop breathe (signals, and nothing else is starved)
  if (st.practised % 50 === 0) await new Promise((res) => setImmediate(res));
}
await save();
log('stopped at', st.practised);
