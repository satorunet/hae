// The body's basic control, tuned by trial and error on the server: how it shares its weight over
// its supports and looks ahead, how stiff its joints are, how it steps, when it trusts its knees
// enough to lift its hands, and how it gets up after a fall (web/body-worker.js CONTROL, GAIT and the
// balance gains). This is not the fly brain learning - it is a plain search, standing in for the
// years of practice a body's own motor system would get; the fly's mushroom body then learns which
// way of using this body to choose (./server.mjs).
//
// An evolution strategy: each generation tries LAMBDA variations of the best settings so far, each
// in TRIALS trials (a body and a whole brain in ./trial.mjs, food dropped in front of it, and in one
// of them a shove partway through; in the other the food is dropped 1-1.4 m away, to be crawled to),
// scores them, and moves toward the best MU. Score per trial:
//   up to 1   how long before the first fall, as a share of the trial
//   up to 1   how far it crawled toward the food before any fall (all the way to within reach = 1)
//   + 1       it got to eat (+ 0.5 if it only got its mouth to the food)
//   + 0.5     it got itself up again after a fall (less the longer it took)
//   - 0.2     for each fall (up to three)
//
// Every generation the body's own hand-set settings (level 1's) are tried too. The pages only use the
// best settings once they are verified: tried in at least VERIFY_TRIES generations and, on the mean of
// those, better than the hand-set ones by VERIFY_MARGIN (control.json "verified"). A candidate that
// did well in one generation's few trials fell over far more on the page than the hand-set body.
//
//   node ningen/school/tune.mjs            (pm2: hae-ningen-tune)
//
// It writes, under ningen/school/state/:
//   control.json      the best settings so far and their score - what the pages and the school use
//   tune.jsonl        one line per generation
//   body-gens.json    the best settings as they were found, generation by generation (the last 40), for
//                     the pages to choose a body from
import { fork } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises';

const STATE = process.env.SCHOOL_STATE ? new URL(`file://${process.env.SCHOOL_STATE}/`) : new URL('state/', import.meta.url);
const WORKERS = +process.env.TUNE_WORKERS || 2;
const LAMBDA = +process.env.TUNE_LAMBDA || 8, MU = Math.ceil(LAMBDA / 2), TRIALS = +process.env.TUNE_TRIALS || 2, MAXT = 30;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const VERIFY_TRIES = 5, VERIFY_MARGIN = 0.15;

// [group, name, low, high, level 1's value, log scale?]
const SPACE = [
  ['CONTROL', 'unload', 0.05, 0.6, 0.25], ['CONTROL', 'ahead', 0, 0.25, 0.08], ['CONTROL', 'reg', 0.004, 0.1, 0.02, true],
  ['CONTROL', 'mu', 0.4, 1.0, 0.8], ['CONTROL', 'stiffness', 0.5, 2.5, 1, true], ['CONTROL', 'reserve', 30, 150, 60],
  ['CONTROL', 'rise', 1, 5, 2.5], ['CONTROL', 'upBoost', 1, 3, 1.5], ['CONTROL', 'kneelIn', 0.3, 0.9, 0.6], ['CONTROL', 'kneelHold', 0.1, 1.0, 0.3],
  ['GAIT', 'near', 0.01, 0.08, 0.03], ['GAIT', 'shrink', 0.5, 1.0, 0.8], ['GAIT', 'maxs', 0.02, 0.12, 0.05], ['GAIT', 'swing', 0.2, 0.6, 0.3],
  ['GAIT', 'lift', 0.02, 0.08, 0.05], ['GAIT', 'stride', 0.05, 0.25, 0.15], ['GAIT', 'speed', 0.1, 0.4, 0.28], ['GAIT', 'dip', 0.005, 0.03, 0.015],
  ['balance', 'angKp', 20, 150, 60], ['balance', 'angKd', 5, 30, 12], ['balance', 'zKp', 10, 80, 40], ['balance', 'zKd', 3, 20, 10],
  ['balance', 'xyKp', 5, 60, 40], ['balance', 'xyKd', 3, 20, 14],
  ['STANCE', 'hands', 0.03, 0.35, 0.22], ['STANCE', 'handsAhead', 0, 0.3, 0.1], ['STANCE', 'knees', 0.05, 0.3, 0.2],   // (starting wide: a broad base)
  ['GAIT', 'pattern', 0, 2, 2],
  ['TURN', 'rate', 0.1, 0.5, 0.3], ['TURN', 'step', 0.08, 0.5, 0.3], ['TURN', 'speed', 0.04, 0.2, 0.1],   // (coming round to food behind)
];
const toUnit = (v, [, , lo, hi, , lg]) => (lg ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo));
const fromUnit = (u, [, , lo, hi, , lg]) => { u = Math.max(0, Math.min(1, u)); return lg ? lo * Math.pow(hi / lo, u) : lo + u * (hi - lo); };
function settings(x) {
  const out = { CONTROL: {}, GAIT: {}, balance: {}, STANCE: {}, TURN: {} };
  SPACE.forEach((p, i) => (out[p[0]][p[1]] = +fromUnit(x[i], p).toFixed(4)));
  const b = out.balance;
  out.balance = { ang: [b.angKp, b.angKd], z: [b.zKp, b.zKd], xy: [b.xyKp, b.xyKd] };
  return out;
}
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());

await mkdir(STATE, { recursive: true });
const handX = SPACE.map((p) => toUnit(p[4], p));
let mean = handX.slice(), sigma = 0.12, gen = 0, best = null, hand = { scores: [] };
try {
  const saved = JSON.parse(await readFile(new URL('tune-state.json', STATE), 'utf8'));
  ({ mean, sigma, gen, best } = saved);
  if (saved.hand) hand = saved.hand;
  // (dimensions added since: they start from their level 1 values, and the best is tried again)
  if (mean.length < SPACE.length) { mean = mean.concat(handX.slice(mean.length)); if (best?.x) { best.x = best.x.concat(handX.slice(best.x.length)); best.scores = []; best.score = -1e9; } }
  // (scored before falls counted against it, or before the hand-set body was tried alongside: its tries start over)
  else if (best) { best.scores = []; best.score = -1e9; }
  log('resumed at generation', gen);
} catch { log('starting from level 1'); }

// ---------------------------------------------------------------- trial bodies
const children = [];
const queue = [];
function startChild() {
  const child = fork(new URL('trial.mjs', import.meta.url));
  child.busy = true;
  child.on('message', (m) => {
    if (m.error) log('trial error', m.error);
    if (m.ready || m.done) {
      if (m.done && child.job) { const j = child.job; child.job = null; j.resolve(m.done); }
      child.busy = false; pump();
    }
  });
  child.on('exit', (code) => { log('trial body exited', code); if (child.job) { child.job.resolve(null); child.job = null; } children.splice(children.indexOf(child), 1); setTimeout(() => { children.push(startChild()); }, 5000); });
  return child;
}
function pump() {
  for (const c of children) if (!c.busy && queue.length) { const j = queue.shift(); c.busy = true; c.job = j; c.send({ run: j.run }); }
}
const runTrial = (run) => new Promise((resolve) => { queue.push({ run, resolve }); pump(); });
for (let i = 0; i < WORKERS; i++) children.push(startChild());

let seq = 0;
async function evaluate(x) {
  const s = settings(x), foods = ['honey', 'meat', 'dung'];
  const runs = [];
  for (let t = 0; t < TRIALS; t++) {
    // trial 0: food far ahead (crawling to it); trial 1: food behind (coming round to it, one of the three
    // ways, at random); the last: a shove partway (getting up)
    const behind = t === 1 && TRIALS > 2;
    const r = t === 0 ? 1.2 + Math.random() * 0.4 : behind ? 0.5 + Math.random() * 0.4 : 0.9 + Math.random() * 0.3, a = behind ? Math.PI + (Math.random() - 0.5) * 1.2 : (Math.random() - 0.5) * 0.8;
    const TURN = { ...s.TURN, mode: behind ? ['pivot', 'reverse', 'arc'][Math.floor(Math.random() * 3)] : null };
    runs.push(runTrial({ id: ++seq, food: foods[Math.floor(Math.random() * 3)], params: { GAIT: s.GAIT, balance: s.balance, STANCE: s.STANCE, TURN }, control: s.CONTROL,
      x: r * Math.sin(a), y: -r * Math.cos(a), maxT: MAXT, seed: seq, tune: true, push: t === TRIALS - 1 ? { at: 6, v: [(Math.random() < 0.5 ? -1 : 1) * 2.2, 0, 0.4] } : null }));
  }
  const res = (await Promise.all(runs)).filter(Boolean);
  let score = 0;
  for (const r of res) {
    score += (r.firstFall == null ? MAXT : r.firstFall) / MAXT;
    score += r.progress || 0;
    if (r.ate != null) score += 1;
    else if (r.reached != null) score += 0.5;                             // (got its mouth to the food)
    const ok = r.getups.find((g) => g.ok);
    if (ok) score += 0.5 * (1 - Math.min(1, ok.t / 10));
    score -= 0.2 * Math.min(3, r.falls || 0);
  }
  return { score: res.length ? score / res.length : 0, res };
}

// ---------------------------------------------------------------- the search
const atomic = async (name, data) => { const u = new URL(name, STATE), tmp = new URL(name + '.tmp', STATE); await writeFile(tmp, data); await rename(tmp, u); };
let stop = false;
process.on('SIGINT', () => { stop = true; log('stopping after this generation'); });
process.on('SIGTERM', () => { stop = true; });
while (!stop) {
  gen++;
  // the best so far is tried again every generation, and judged on the mean of all its tries: two
  // trials are few, and a lucky pair (a score of 2 once, never again) must not stay the best
  const pop = Array.from({ length: LAMBDA }, (_, i) => (i === 0 && gen === 1 ? mean.slice() : i === 0 && best?.x ? best.x.slice() : mean.map((m) => Math.max(0, Math.min(1, m + sigma * gauss())))));
  const scored = [];
  for (const [i, x] of pop.entries()) {
    const e = await evaluate(x);
    if (i === 0 && best?.x && gen > 1) { best.scores = [...(best.scores || []), e.score]; best.score = +(best.scores.reduce((a, b) => a + b, 0) / best.scores.length).toFixed(3); e.score = best.score; }
    scored.push({ x, ...e });                                             // (trials of one candidate run side by side)
  }
  // the hand-set body, for comparison (the last 20 generations' tries)
  const h = await evaluate(handX);
  hand.scores = [...hand.scores, h.score].slice(-20);
  hand.score = +(hand.scores.reduce((a, b) => a + b, 0) / hand.scores.length).toFixed(3);
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MU);
  // weighted recombination of the best, and a step size that shrinks as the scores stop spreading
  const w = top.map((_, i) => Math.log(MU + 0.5) - Math.log(i + 1)), ws = w.reduce((a, b) => a + b, 0);
  mean = mean.map((_, d) => top.reduce((a, c, i) => a + (w[i] / ws) * c.x[d], 0));
  const spread = scored[0].score - scored[scored.length - 1].score;
  sigma = Math.max(0.03, Math.min(0.25, sigma * (spread > 0.3 ? 1.05 : 0.93)));
  // a newcomer only takes over if it beats the best's running mean (and then has to hold up next time)
  const lead = scored.find((c) => c.x !== pop[0] || !best?.x) || scored[0];
  if (!best || !best.x || lead.score > best.score) best = { score: +lead.score.toFixed(3), scores: [lead.score], gen, x: lead.x, settings: settings(lead.x) };
  const { x: _x, ...shown } = best;
  const tries = best.scores?.length || 1, verified = tries >= VERIFY_TRIES && hand.scores.length >= 3 && best.score > hand.score + VERIFY_MARGIN;
  await atomic('control.json', JSON.stringify({ ...shown, tries, verified, handScore: hand.score, level1: settings(handX), updated: new Date().toISOString() }, null, 1));
  await atomic('tune-state.json', JSON.stringify({ mean, sigma, gen, best, hand }));
  // (one entry per best found, kept up to date while it stays the best)
  let gens = [];
  try { gens = JSON.parse(await readFile(new URL('body-gens.json', STATE), 'utf8')).gens || []; } catch { /* first one */ }
  const entry = { gen: best.gen, score: best.score, tries, verified, handScore: hand.score, settings: best.settings, updated: new Date().toISOString() };
  const at = gens.findIndex((g) => g.gen === best.gen);
  if (at >= 0) gens[at] = entry; else gens.push(entry);
  await atomic('body-gens.json', JSON.stringify({ hand: { score: hand.score, settings: settings(handX) }, gens: gens.slice(-40) }));
  await appendFile(new URL('tune.jsonl', STATE), JSON.stringify({ at: new Date().toISOString(), gen, sigma: +sigma.toFixed(3), scores: scored.map((c) => +c.score.toFixed(3)), best: best.score,
    top: scored[0].res.map((r) => ({ firstFall: r.firstFall, ate: r.ate, getups: r.getups, falls: r.falls })) }) + '\n');
  log('generation', gen, 'scores', scored.map((c) => c.score.toFixed(2)).join(' '), 'best', best.score, 'tries', tries, verified ? 'verified' : 'not verified', 'hand-set', hand.score, 'sigma', sigma.toFixed(3));
}
for (const c of children) c.kill();
process.exit(0);
