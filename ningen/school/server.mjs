// The fly-human's school: the fly brain's mushroom body learning how to use the human body to get
// at food (./chooser.mjs), in two decisions - how to approach it, and, once there, how to feed
// (./strategies.mjs). It learns from two kinds of trial -
//   * visitors': on the page, a visitor drops food, the page's copy of the brain makes the decisions,
//     the body goes for it, and the page sends how it went;
//   * its own practice (when turned on): a body and a whole brain in a child process (./trial.mjs).
// Every trial ends in dopamine in each chosen compartment, at the level outcomeLevels gives for how
// that part of the trial went - a fall after eating still teaches the feeding decision not to fall.
//
//   node ningen/school/server.mjs     (pm2: hae-ningen-school, behind nginx at /ningen/api/)
//
//   POST /trial    { food, choices: { approach: {k, drive}, feeding: {k, drive} | null },
//                    result, reached, ate, t, record }
//                  a visitor's trial: the food, what the page's brain chose (and its compartments'
//                  drives), how it ended and when it reached and began eating the food, and the
//                  worker's record of what the fly's brain did and how the body was used
//                  -> { ok, outcome, trial, token, ... }
//   POST /motion?trial=&token=   the trial's motion data (the worker's `motion`, gzipped, as the body)
//   GET  /trials?limit=&before=   the latest trials, newest first (for choosing one to watch again)
//   GET  /trials?near=N           trial N, and the watchable ones just before and after it
//   GET  /status                                 what state/status.json holds
//
// It writes, under ningen/school/state/:
//   status.json          what the page's 記録 tab shows (rewritten after each trial, at most every 5 s)
//   brain-latest.bin.gz  the learned synapse weights (Float32), for the pages; at most every 20 s
//   level-<n>.bin.gz     the weights when level n began (every 100 trials; level 1 is the naive brain);
//                        status.json's levels also keep the body's verified control settings of then
//   log.jsonl            one line per trial (with the brain's and the body's record), never trimmed
//   motion/<trial>.bin.gz  each trial's motion data, for watching it again (the latest MOTION_KEEP)
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { FlyBrain } from '../../flybrain/flybrain.js';
import { makeChooser } from './chooser.mjs';
import { DECISIONS, DECISION_KEYS, TRIAL_DECISIONS, mergeParams, outcomeLevels, getupLevel } from './strategies.mjs';
import { REFLEX } from '../web/reflex.mjs';

const PORT = +process.env.SCHOOL_PORT || 3021;
const PRACTICE = process.env.SCHOOL_PRACTICE != null ? +process.env.SCHOOL_PRACTICE : 1;   // practice bodies
const STATE = process.env.SCHOOL_STATE ? new URL(`file://${process.env.SCHOOL_STATE}/`) : new URL('state/', import.meta.url);
const PER_LEVEL = 100, WINDOW = 100, HISTORY_EVERY = 20, MOTION_KEEP = 3000, LIST_KEEP = 1000;
const RESULTS = ['finished', 'fell', 'out', 'timeout'];
const log = (...a) => console.log(new Date().toISOString(), ...a);

await mkdir(new URL('motion/', STATE), { recursive: true });
const C = await makeChooser({ FlyBrain, base: new URL('../../flybrain/', import.meta.url) });

// ---------------------------------------------------------------- state
// the outcome of a trial for the record: ate (and kept its feet) / ate-fell (ate, then fell or went
// off the floor) / reached-fell (got there, fell before eating) / fell / out / timeout
const outcome = ({ result, reached, ate }) => {
  const failed = result === 'fell' || result === 'out';
  if (ate != null) return failed ? 'ate-fell' : 'ate';
  if (failed) return reached != null ? 'reached-fell' : result;
  return 'timeout';
};
const OUTCOMES = ['ate', 'ate-fell', 'reached-fell', 'fell', 'out', 'timeout'];
const st = { version: 2, trials: 0, visitors: 0, practice: 0, recent: [], history: [], levels: [{ level: 1, trials: 0, file: null }] };
try {
  const saved = JSON.parse(await readFile(new URL('state.json', STATE), 'utf8'));
  if (saved.version !== 2) throw Object.assign(new Error('old'), { code: 'OLD' });
  Object.assign(st, saved);
  C.importGains(new Float32Array(gunzipSync(await readFile(new URL('brain-latest.bin.gz', STATE))).buffer.slice(0)));
  log('resumed', st.trials, 'trials');
} catch (e) { if (e.code !== 'ENOENT' && e.code !== 'OLD') throw e; log('a new brain'); }
const level = () => 1 + Math.floor(st.trials / PER_LEVEL);
// The elbow reflex's synapses (../web/reflex.mjs): every trial brings back how much they changed while
// it ran (the page's brain, or a practice body's), and that change is added here. The wiring fixes their
// number; the first practice run sets it, and a change of another length is not taken.
let reflex = null;
st.reflex = st.reflex || { updates: 0 };
try { reflex = new Float32Array(gunzipSync(await readFile(new URL(`${REFLEX.file}-latest.bin.gz`, STATE))).buffer.slice(0)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
function addReflex(delta, who) {
  if (!Array.isArray(delta) || !delta.length || delta.length > 20000) return false;
  if (!reflex) { if (who !== 'practice') return false; reflex = new Float32Array(delta.length).fill(1); }
  if (delta.length !== reflex.length) return false;
  for (let i = 0; i < reflex.length; i++) {
    const v = +delta[i];
    if (!Number.isFinite(v)) continue;
    reflex[i] = Math.max(REFLEX.gainMin, Math.min(REFLEX.gainMax, reflex[i] + Math.max(-REFLEX.maxDelta, Math.min(REFLEX.maxDelta, v))));
  }
  st.reflex.updates++;
  return true;
}
function reflexStats() {
  if (!reflex) return { updates: st.reflex.updates, synapses: 0 };
  let sum = 0, dev = 0, up = 0, down = 0;
  for (const g of reflex) { sum += g; dev += Math.abs(g - 1); if (g > 1.01) up++; else if (g < 0.99) down++; }
  return { updates: st.reflex.updates, synapses: reflex.length, mean: +(sum / reflex.length).toFixed(4), change: +(dev / reflex.length).toFixed(4), stronger: up, weaker: down };
}
// the latest trials, for the list of ones to watch again (rebuilt from the log at start)
const list = [], tokens = new Map();
try {
  for (const l of (await readFile(new URL('log.jsonl', STATE), 'utf8')).trim().split('\n').slice(-LIST_KEEP)) if (l) list.push(summary(JSON.parse(l)));
} catch (e) { if (e.code !== 'ENOENT') throw e; }
function summary(r) {
  return { trial: r.trial, at: r.at, level: r.level, who: r.who, food: r.food, outcome: r.outcome, t: r.t, reached: r.reached, ate: r.ate,
    choices: Object.fromEntries(Object.entries(r.choices || {}).map(([dk, c]) => [dk, c.id])), motion: !!r.motion };
}

const atomic = async (name, data) => { const u = new URL(name, STATE), tmp = new URL(name + '.tmp', STATE); await writeFile(tmp, data); await rename(tmp, u); };
let dirty = false, lastBrain = 0, lastStatus = 0, statusTimer = null;
async function saveBrain(force) {
  if (!dirty || (!force && Date.now() - lastBrain < 20e3)) return;
  dirty = false; lastBrain = Date.now();
  await atomic('brain-latest.bin.gz', gzipSync(Buffer.from(C.exportGains().buffer)));
  if (reflex) await atomic(`${REFLEX.file}-latest.bin.gz`, gzipSync(Buffer.from(reflex.buffer)));
  await atomic('state.json', JSON.stringify(st));
}
function rates(list) {
  const n = list.length, of = (o) => (n ? +(list.filter((x) => x === o).length / n).toFixed(3) : 0);
  const r = { n };
  for (const o of OUTCOMES) r[o] = of(o);
  r.success = +(r.ate + r['ate-fell']).toFixed(3);                        // got to eat
  r.fall = +(r['ate-fell'] + r['reached-fell'] + r.fell + r.out).toFixed(3);
  return r;
}
function status() {
  const choice = {};
  for (const food of C.foods) {
    choice[food] = {};
    const all = C.sniff(food, 7).drive;
    for (const dk of DECISION_KEYS) {
      const drive = C.range(dk).map((c) => all[c]), k = drive.indexOf(Math.min(...drive)), o = DECISIONS[dk].options[k];
      choice[food][dk] = { k, id: o.id, name: o.name, note: o.note, drives: drive.map((v) => +v.toFixed(4)) };
    }
  }
  return {
    level: level(), trials: st.trials, visitors: st.visitors, practice: st.practice,
    window: rates(st.recent), history: st.history,
    decisions: Object.fromEntries(DECISION_KEYS.map((dk) => [dk, { name: DECISIONS[dk].name, when: DECISIONS[dk].when, options: DECISIONS[dk].options.map(({ id, name, note }) => ({ id, name, note })) }])),
    choice, levels: st.levels, reflex: reflexStats(), updated: new Date().toISOString(),
  };
}
function writeStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(async () => {
    statusTimer = null; lastStatus = Date.now();
    await atomic('status.json', JSON.stringify(status()));
  }, Math.max(0, 5000 - (Date.now() - lastStatus)));
}

// one trial's end, from a visitor or from practice
async function record(who, { food, choices, result, reached, ate, t, rec = null, motion = null, reflexDelta = null, getups = [] }) {
  addReflex(reflexDelta, who);
  const lv = outcomeLevels({ reached, ate, result });
  const give = {};
  for (const dk of TRIAL_DECISIONS) if (choices[dk] && lv[dk] != null) give[dk] = [choices[dk].k, lv[dk]];
  C.learn(food, give);
  // each get-up teaches its own choice: up within 8 s, the sooner the better
  for (const g of getups) { g.dopamine = getupLevel(g); C.learn(food, { getup: [g.k, g.dopamine] }); }
  dirty = true;
  const o = outcome({ result, reached, ate });
  st.trials++; st[who === 'visitor' ? 'visitors' : 'practice']++;
  st.recent.push(o); if (st.recent.length > WINDOW) st.recent.shift();
  if (st.trials % HISTORY_EVERY === 0) st.history.push({ trials: st.trials, ...rates(st.recent) });
  const picked = Object.fromEntries(TRIAL_DECISIONS.filter((dk) => choices[dk]).map((dk) => [dk, { k: choices[dk].k, id: DECISIONS[dk].options[choices[dk].k].id, drive: choices[dk].drive || null, dopamine: give[dk]?.[1] ?? null }]));
  if (motion) await saveMotion(st.trials, motion);
  const line = { at: new Date().toISOString(), trial: st.trials, level: level(), who, food, choices: picked, getups: getups.map((g) => ({ id: DECISIONS.getup.options[g.k].id, ok: g.ok, t: g.t, dopamine: g.dopamine })), result, outcome: o, reached, ate, t, motion: !!motion, record: rec };
  await appendFile(new URL('log.jsonl', STATE), JSON.stringify(line) + '\n');
  list.push(summary(line)); if (list.length > LIST_KEEP) list.shift();
  if (st.trials % PER_LEVEL === 0) {
    const file = `level-${level()}.bin.gz`;
    await atomic(file, gzipSync(Buffer.from(C.exportGains().buffer)));
    // the body's basic control goes with the level: the verified settings the body had then (null: its
    // own hand-set ones) - how to hold and move the body is part of what the brain has learned by then
    await loadControl();
    let reflexFile = null;
    if (reflex) { reflexFile = `${REFLEX.file}-${level()}.bin.gz`; await atomic(reflexFile, gzipSync(Buffer.from(reflex.buffer))); }
    st.levels.push({ level: level(), trials: st.trials, file, body: control ? { gen: controlGen, settings: control } : null, reflex: reflexFile });
    log('level', level());
  }
  await saveBrain();
  writeStatus();
  return o;
}
async function saveMotion(trial, gz) {
  await writeFile(new URL(`motion/${trial}.bin.gz`, STATE), gz);
  const old = trial - MOTION_KEEP;
  if (old > 0) await unlink(new URL(`motion/${old}.bin.gz`, STATE)).catch(() => {});
  const item = list.find((x) => x.trial === trial); if (item) item.motion = true;
}

// ---------------------------------------------------------------- visitors
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((x) => now - x < 60e3);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 12;                  // a trial takes a good few seconds: 12 a minute is plenty
}
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const time = (v) => (v == null ? null : +v >= 0 && +v <= 200 ? +(+v).toFixed(2) : undefined);
function choiceOf(dk, c) {
  if (!c) return null;
  const k = Math.floor(+c.k), n = DECISIONS[dk].options.length;
  if (!(k >= 0 && k < n)) return undefined;
  return { k, drive: Array.isArray(c.drive) && c.drive.length === n ? c.drive.map((v) => +(+v).toFixed(4)) : null };
}
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, status());
    // one trial to watch, with the nearest ones before and after it that can be watched too (a shared link, 前/次)
    if (req.method === 'GET' && url.pathname === '/trials' && url.searchParams.has('near')) {
      const n = +url.searchParams.get('near'), watchable = list.filter((x) => x.motion);
      const item = list.find((x) => x.trial === n) || null;
      const prev = watchable.filter((x) => x.trial < n).at(-1) || null, next = watchable.find((x) => x.trial > n) || null;
      return send(res, 200, { item, prev, next });
    }
    if (req.method === 'GET' && url.pathname === '/trials') {
      const limit = Math.max(1, Math.min(100, +url.searchParams.get('limit') || 30)), before = +url.searchParams.get('before') || Infinity;
      return send(res, 200, { items: list.filter((x) => x.trial < before).slice(-limit).reverse() });
    }
    if (req.method === 'POST' && url.pathname === '/motion') {
      const trial = +url.searchParams.get('trial'), tok = tokens.get(trial);
      if (!tok || tok.token !== url.searchParams.get('token') || Date.now() - tok.at > 10 * 60e3) return send(res, 403, { error: 'no such trial' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 600000) return send(res, 413, { error: 'too big' }); }
      const gz = Buffer.concat(chunks);
      let raw;
      try { raw = gunzipSync(gz, { maxOutputLength: 4e6 }); } catch { return send(res, 400, { error: 'not gzip' }); }
      const hl = raw.readUInt32LE(0), head = JSON.parse(raw.subarray(4, 4 + hl).toString('utf8'));
      if (!(head.v >= 1 && head.v <= 2) || !(head.frames > 1)) return send(res, 400, { error: 'bad motion' });
      tokens.delete(trial);
      await saveMotion(trial, gz);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/trial') {
      const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
      if (limited(ip)) return send(res, 429, { error: 'slow down' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 96000) return send(res, 413, { error: 'too big' }); }
      const m = JSON.parse(body);
      const choices = Object.fromEntries(TRIAL_DECISIONS.map((dk) => [dk, choiceOf(dk, m.choices?.[dk])]));
      const getups = (Array.isArray(m.getups) ? m.getups.slice(0, 12) : []).map((g) => ({ ...choiceOf('getup', g), ok: !!g?.ok, t: time(g?.t) })).filter((g) => g.k != null && g.t != null);
      const t = time(m.t), reached = time(m.reached), ate = time(m.ate);
      if (!C.foods.includes(m.food) || !choices.approach || Object.values(choices).includes(undefined) || !RESULTS.includes(m.result)
        || t == null || t === undefined || reached === undefined || ate === undefined) return send(res, 400, { error: 'bad trial' });
      const rec = m.record && typeof m.record === 'object' ? m.record : null;
      const o = await record('visitor', { food: m.food, choices, result: m.result, reached, ate, t, rec, reflexDelta: m.reflex, getups });
      const token = randomBytes(12).toString('hex');
      tokens.set(st.trials, { token, at: Date.now() });
      if (tokens.size > 500) tokens.delete(tokens.keys().next().value);
      return send(res, 200, { ok: true, outcome: o, trial: st.trials, token, trials: st.trials, level: level() });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', e.message);
    send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, '127.0.0.1', () => log('listening', PORT, 'practice bodies', PRACTICE));

// ---------------------------------------------------------------- practice
let seq = 0, control = null, controlGen = null;
async function loadControl() {
  // (only verified settings, as on the page)
  try { const j = JSON.parse(await readFile(new URL('control.json', STATE), 'utf8')); control = j.verified === true ? j.settings : null; controlGen = control ? j.gen : null; } catch { control = null; controlGen = null; }
}
function practise() {
  const child = fork(new URL('trial.mjs', import.meta.url));
  const next = async () => {
    await loadControl();
    const food = C.foods[Math.floor(Math.random() * C.foods.length)];
    const a = C.choose('approach', food);
    // food in front of the face, 30-80 cm ahead of the lips (which are ~60 cm ahead of the pelvis, at the
    // origin) and up to 35 degrees either side (the body faces -y) - not onto the body
    // (a third of the time behind the body instead, 50-90 cm behind the pelvis: practice in coming round to it)
    const behind = Math.random() < 1 / 3;
    const r = behind ? 0.5 + Math.random() * 0.4 : 0.9 + Math.random() * 0.5, ang = behind ? Math.PI + (Math.random() - 0.5) * 1.2 : (Math.random() - 0.5) * 1.2;
    const base = control ? { GAIT: control.GAIT, balance: control.balance, STANCE: control.STANCE, ...(control.TURN ? { TURN: control.TURN } : {}) } : {};
    const tr = behind ? C.choose('turnaround', food) : null;
    child.pending = { food, approach: a, feeding: null, turnaround: tr, base, getups: new Map() };
    child.send({ run: { id: ++seq, food, params: mergeParams(base, a.option.params, tr?.option.params), control: control?.CONTROL || null, x: r * Math.sin(ang), y: -r * Math.cos(ang), maxT: 60, seed: seq,
      reflex: reflex ? Array.from(reflex) : null } });
  };
  child.on('message', async (m) => {
    if (m.error) log('trial error', m.error);
    if (m.ready) next();
    const now = (p, extra) => mergeParams(p.base, p.approach.option.params, p.turnaround?.option.params, p.feeding?.option.params, extra);
    if (m.reached && child.pending && !child.pending.feeding) {
      const p = child.pending, f = C.choose('feeding', p.food);
      p.feeding = f;
      child.send({ feed: { params: now(p) } });
    }
    if (m.down && child.pending) {
      const p = child.pending, g = C.choose('getup', p.food);
      p.getups.set(m.down.n, g);
      child.send({ feed: { params: now(p, g.option.params) } });
    }
    if (m.done) {
      const p = child.pending, d = m.done;
      if (RESULTS.includes(d.result)) {
        const choices = { approach: { k: p.approach.k, drive: p.approach.drive }, feeding: p.feeding ? { k: p.feeding.k, drive: p.feeding.drive } : null, turnaround: p.turnaround ? { k: p.turnaround.k, drive: p.turnaround.drive } : null };
        // each get-up chosen, with how it went (not up when the trial was lost to that fall: failed)
        const ups = [...p.getups].map(([n, g]) => { const r = (d.getups || []).find((u) => u.n === n); return r ? { k: g.k, ok: r.ok, t: r.t } : d.result === 'fell' && n === Math.max(...p.getups.keys()) ? { k: g.k, ok: false, t: 8 } : null; }).filter(Boolean);
        const o = await record('practice', { food: p.food, choices, result: d.result, reached: d.reached, ate: d.ate, t: d.t, rec: d.record, motion: d.motion ? gzipSync(Buffer.from(d.motion)) : null, reflexDelta: d.reflexDelta, getups: ups });
        log('practice', p.food, p.approach.option.id, p.feeding?.option.id || '-', p.turnaround ? 'behind:' + p.turnaround.option.id : '', o, d.t + 's', Math.round(d.wall / 1000) + 's wall');
      }
      next();
    }
  });
  child.on('exit', (code) => { log('practice body exited', code); setTimeout(practise, 10e3); });
}
for (let i = 0; i < PRACTICE; i++) practise();

writeStatus();
const quit = async () => { dirty = true; await saveBrain(true); await atomic('status.json', JSON.stringify(status())); process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);
