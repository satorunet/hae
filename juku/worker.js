// The page's copy of a fly from the school (juku/trainer.mjs): the same brain,
// with the synapse weights the server has learned so far loaded into it. The
// page asks questions from material the fly never practises on, and draws.
//
// Bump the ?v= on flybrain.js and flybrain.wasm together whenever either
// changes - Cloudflare keeps serving old copies otherwise.
import { FlyBrain } from '../flybrain/flybrain.js?v=5';
import { makeReader } from './reader.mjs?v=3';
import * as K from '../hiragana/kana.mjs?v=2';

const V = '?v=5';
const HERE = new URL('./', import.meta.url);
const post = (m, t) => self.postMessage(m, t || []);
let R = null, course = null, status = null, brainName = null;
let quiz = null;          // the material questions are drawn from
let allowed = null;       // letters unlocked (hiragana), null = all
// watching the brain: which population each neuron is in, and a KC's slot
let kind = null, kcSlot = null, live = false, liveTimer = null, working = false;

async function gunzipBytes(res) {
  const s = res.body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function init(c) {
  course = c;
  for (const fn of ['setPlasticity', 'driveByGroup', 'exportGains', 'importGains', 'dopamine'])
    if (typeof FlyBrain.prototype[fn] !== 'function')
      throw new Error(`flybrain.js is stale (no ${fn}) - bump the ?v= in juku/worker.js`);
  R = await makeReader({ FlyBrain, base: new URL('../flybrain/', HERE), course, v: V,
    onProgress: (p) => post({ type: 'progress', ...p }) });
  post({ type: 'progress', phase: 'material' });
  if (course === 'suji') {
    const buf = await gunzipBytes(await fetch(new URL('data/mnist12_test.bin.gz?v=1', HERE)));
    quiz = { buf, n: buf.length / 145 };
  } else {
    const [meta, gz] = await Promise.all([
      fetch(new URL('../hiragana/kana48.json?v=1', HERE)).then((r) => r.json()),
      fetch(new URL('../hiragana/kana48.bin.gz?v=1', HERE)),
    ]);
    const bank = K.unpackBank((await gunzipBytes(gz)).buffer, meta);
    quiz = { bank, fonts: K.TEST_FONTS.map((n) => meta.fonts.indexOf(n)), names: K.TEST_FONTS };
  }
  // a trainer that has only just started has not written its first record yet
  kind = new Uint8Array(R.brain.n); kcSlot = new Int32Array(R.brain.n).fill(-1);
  for (const i of R.ALPN) kind[i] = 1;
  R.KC.forEach((i, k) => { kind[i] = 2; kcSlot[i] = k; });
  for (const i of R.MBON) kind[i] = 3;
  try { await refresh(); } catch (e) { post({ type: 'status', status: null, message: e.message }); }
  post({ type: 'ready', labels: R.labels, kc: Uint32Array.from(R.KC), size: R.course.size,
    cells: { pn: R.ALPN.length, kc: R.KC.length, mbon: R.MBON.length }, chunkMs: R.CHUNK_MS,
    groups: R.groups.map((g) => ({ name: g.name, cells: g.cells.length, inputs: g.inputs })) });
}

// the newest record and, if it moved on, the newest brain
async function refresh() {
  const r = await fetch(new URL(`state/${course}/status.json?t=${Date.now()}`, HERE), { cache: 'no-store' });
  if (!r.ok) throw new Error(`no record from the server yet (HTTP ${r.status})`);
  status = await r.json();
  if (course === 'hiragana') {
    const n = K.ROWS.slice(0, status.level).join('').length;
    allowed = [...Array(n).keys()];
  }
  let loaded = false;
  if (status.brain !== brainName) {
    const b = await fetch(new URL(`state/${course}/${status.brain}`, HERE));
    if (b.ok) {
      const bytes = await gunzipBytes(b);
      R.importGains(new Float32Array(bytes.buffer, 0, bytes.length / 4));
      brainName = status.brain;
      loaded = true;
    }
  }
  post({ type: 'status', status, loaded, brain: brainName });
}

function question() {
  if (course === 'suji') {
    const n = Math.floor(Math.random() * quiz.n), rec = 145;
    return { img: Float32Array.from(quiz.buf.subarray(n * rec + 1, (n + 1) * rec), (v) => v / 255),
      truth: quiz.buf[n * rec] - 1, source: `MNIST テスト #${n}` };
  }
  const k = allowed[Math.floor(Math.random() * allowed.length)];
  const fi = Math.floor(Math.random() * quiz.fonts.length);
  const img = K.sample(quiz.bank, quiz.fonts[fi], k, K.mulberry32((Math.random() * 2 ** 32) >>> 0));
  return { img, truth: k, source: quiz.names[fi] };
}

// one slice of simulation, boiled down to what the page draws
function summarise(r) {
  let pn = 0, kc = 0, mb = 0;
  const slots = [];
  for (const i of r.idx) {
    const k = kind[i];
    if (k === 1) pn++;
    else if (k === 2) { kc++; slots.push(kcSlot[i]); }
    else if (k === 3) mb++;
  }
  return { pn, kc, mb, slots: Uint16Array.from(slots) };
}

// with the brain window open, the brain keeps running on background input
// between questions: 25 ms of it every 100 ms
function tick() {
  liveTimer = null;
  if (!live || working) return;
  const f = summarise(R.idle(R.CHUNK_MS));
  post({ type: 'tick', ...f }, [f.slots.buffer]);
  liveTimer = setTimeout(tick, 100);
}

function answer(img) {
  const frames = [];
  const seen = R.look(img, { onChunk: (r) => frames.push(summarise(r)) });
  const d = R.decide(seen.drive, allowed);
  return { answer: d.answer, second: d.second, margin: d.margin, drive: seen.drive, slots: seen.slots, frames };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'live') {
    live = m.on;
    if (live && !liveTimer && R) liveTimer = setTimeout(tick, 50);
    return;
  }
  working = true;
  try {
    if (m.type === 'init') await init(m.course);
    else if (m.type === 'refresh') await refresh();
    else if (m.type === 'ask') {
      const q = question(), a = answer(q.img);
      post({ type: 'answered', ...q, ...a }, [a.slots.buffer]);
    } else if (m.type === 'read') {
      const a = answer(new Float32Array(m.img));
      post({ type: 'readout', ...a }, [a.slots.buffer]);
    }
  } catch (err) {
    post({ type: 'error', message: err.message, during: m.type });
  }
  working = false;
  if (live && !liveTimer && R) liveTimer = setTimeout(tick, 100);
};
