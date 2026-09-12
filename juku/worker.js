// The page's copy of a fly from the school (juku/trainer.mjs): the same brain,
// with the synapse weights the server has learned so far loaded into it. The
// page asks questions from material the fly never practises on, and draws.
//
// Bump the ?v= on flybrain.js and flybrain.wasm together whenever either
// changes - Cloudflare keeps serving old copies otherwise.
import { FlyBrain } from '../flybrain/flybrain.js?v=5';
import { makeReader } from './reader.mjs?v=2';
import * as K from '../hiragana/kana.mjs?v=2';

const V = '?v=5';
const HERE = new URL('./', import.meta.url);
const post = (m, t) => self.postMessage(m, t || []);
let R = null, course = null, status = null, brainName = null;
let quiz = null;          // the material questions are drawn from
let allowed = null;       // letters unlocked (hiragana), null = all

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
  try { await refresh(); } catch (e) { post({ type: 'status', status: null, message: e.message }); }
  post({ type: 'ready', labels: R.labels, kc: Uint32Array.from(R.KC), size: R.course.size,
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

function answer(img) {
  const seen = R.look(img);
  const d = R.decide(seen.drive, allowed);
  return { answer: d.answer, second: d.second, margin: d.margin, drive: seen.drive, slots: seen.slots };
}

self.onmessage = async (e) => {
  const m = e.data;
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
};
