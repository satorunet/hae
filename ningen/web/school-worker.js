// The page's copy of the fly's mushroom body (../school/chooser.mjs), with the weights the school
// has learned (../school/state/), choosing how the body goes for each food a visitor drops.
//
// main -> worker: {type:'init', level}            level: 'latest' (default), 1 (naive), or n
//                 {type:'level', level}           load another level's weights
//                 {type:'choose', id, food, decision}   decide for this food: decision 'approach'
//                                                 (when it lands) or 'feeding' (when the body gets there)
// worker -> main: {type:'ready', level, trials}  {type:'progress', loaded, total}
//                 {type:'choice', id, food, decision, k, option: {id, name, note, params}, drive}
//                 {type:'error', message}
import { FlyBrain } from '../../flybrain/flybrain.js';
import { makeChooser } from '../school/chooser.mjs?v=5';

const post = (m) => self.postMessage(m);
const STATE = new URL('../school/state/', import.meta.url);
let C = null, naive = null, level = 'latest';

async function gains(file) {
  const r = await fetch(new URL(file + '?t=' + Date.now(), STATE));
  if (!r.ok) return null;
  const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Float32Array(buf);
}
async function load(which) {
  level = which ?? 'latest';
  let g = null, trials = null;
  if (level !== 1 && level !== '1') {
    try {
      const status = await (await fetch(new URL('status.json?t=' + Date.now(), STATE))).json();
      trials = status.trials;
      const lv = level === 'latest' ? null : (status.levels || []).find((l) => String(l.level) === String(level));
      g = await gains(lv ? lv.file : 'brain-latest.bin.gz');
    } catch { g = null; }                                    // (no school yet: the naive brain)
  }
  C.importGains(g || naive);
  post({ type: 'ready', level: g ? level : 1, trials });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      C = await makeChooser({ FlyBrain, base: new URL('../../flybrain/', import.meta.url), onProgress: (p) => post({ type: 'progress', ...p }) });
      naive = C.exportGains().slice();
      await load(m.level);
    } else if (m.type === 'level') await load(m.level);
    else if (m.type === 'choose') {
      const c = C.choose(m.decision || 'approach', m.food);
      const { id, name, note, params } = c.option;
      post({ type: 'choice', id: m.id, n: m.n, food: m.food, decision: c.decision, k: c.k, option: { id, name, note, params }, drive: c.drive.map((v) => +v.toFixed(4)) });
    }
  } catch (err) {
    post({ type: 'error', message: String(err?.stack || err) });
  }
};
