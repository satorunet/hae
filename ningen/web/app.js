// The page: draws the person the body worker simulates, relays senses to the brain worker
// and its descending/motor output back to the body, and drops food wherever the floor is tapped.
import * as THREE from '../../test03/vendor/three.module.min.js';
import { loadFlyData, FlyBody, CPG, LEGS } from '../../test03/body3d.js?v=6';
import { buildMouth } from './mouth.js?v=32';
import { FOODS, FALL_FROM } from './foods.js?v=33';

// bump with every change: Cloudflare keeps .js files, so a new version needs a new URL
const V = '78';

const $ = (id) => document.getElementById(id);
const fail = (msg) => { $('err').textContent = msg; console.error(msg); };

// the tab bar (at the bottom on phones, top right on wide screens) shows one part of the page at a
// time, as on the site's top page: the experiment, the learning record, how it works, and the rest
const tabs = document.querySelectorAll('.tabbar [data-go]');
function setTab(tb) {
  document.body.dataset.tab = tb;
  tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.go === tb)));
  scrollTo(0, 0);
  if (tb === 'record') { loadRecord(); if (trialList.pages <= 1) loadTrials(true); }
}
tabs.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.go)));

// ------------------------------------------------------------------ record
// The learning experiment (being built): the fly's mushroom body chooses a way of using the body for
// each food, and learns from how it went - it ate (a success) or fell over (a failure). Its trainer
// writes ../school/state/status.json; until there is one, the tab says so. Whatever the file lacks
// is left out.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => Math.round(v <= 1 ? v * 100 : v) + '%';                     // (a rate as 0..1, or already in percent)
// the levels saved so far, in both level pickers (記録 and the one on the brain map in the experiment)
const levelList = { levels: [] };
function fillLevels(s) {
  const levels = Array.isArray(s?.levels) ? s.levels.filter((l) => l && isNum(l.level)) : [];
  if (!levels.length) return;
  const had = levelList.levels.length;
  levelList.levels = levels;
  if (!had && /^\d+$/.test(String(school.want)) && String(school.want) !== '1') sendBase();   // (its body was waiting for the list)
  const opts = [['latest', '最新']].concat(levels.map((l) => [String(l.level), levelName(l.level) + (l.level !== 1 && isNum(l.trials) ? `（${l.trials} 回）` : '')]));
  for (const sel of [$('lvsel'), $('lvmini')]) {
    if (!sel) continue;
    const html = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = school.want;
  }
}
async function loadLevels() {
  try {
    const r = await fetch(new URL('../school/state/status.json?t=' + Date.now(), import.meta.url), { cache: 'no-store' });
    if (r.ok) fillLevels(await r.json());
  } catch { /* none yet: 最新 and レベル1 */ }
}
async function loadRecord() {
  const box = $('rec');
  if (!box) return;
  loadControl(false);                                                            // (just the line about the tuning)
  let s = null;
  try {
    const r = await fetch(new URL('../school/state/status.json?t=' + Date.now(), import.meta.url), { cache: 'no-store' });
    if (r.ok) s = await r.json();
  } catch { /* not there yet, or not JSON */ }
  if (!s || typeof s !== 'object') { box.innerHTML = '<p class="note">学習の記録はまだありません（準備中）</p>'; return; }
  const hadNames = !!trialList.status;
  trialList.status = s;
  if (!hadNames && trialList.items.length) renderTrials();                       // (the option names have come)
  let html = '';
  // the headline numbers: the level, the trials so far, and how the last window of trials went
  const stats = [], win = s.window && typeof s.window === 'object' ? s.window : {};
  if (isNum(s.level)) stats.push(['レベル', s.level, '']);
  if (isNum(s.trials)) stats.push(['試行', s.trials.toLocaleString(), [isNum(s.visitors) ? `みんな：${s.visitors.toLocaleString()}` : '', isNum(s.practice) ? `自主練：${s.practice.toLocaleString()}` : ''].filter(Boolean).join('・')]);
  const lastN = isNum(win.n) ? `直近 ${win.n} 回` : '直近';
  if (isNum(win.success)) stats.push(['成功（食べた）', pct(win.success), lastN]);
  if (isNum(win['ate-fell'])) stats.push(['食べた後の失敗', pct(win['ate-fell']), lastN]);
  if (isNum(win.fall)) stats.push(['転倒', pct(win.fall), lastN]);
  if (isNum(win.out)) stats.push(['場外', pct(win.out), lastN]);
  if (isNum(win.timeout)) stats.push(['時間切れ', pct(win.timeout), lastN]);
  if (stats.length) html += `<div class="stats">${stats.map(([k, v, sub]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`).join('')}</div>`;
  // how it has gone: the rates (over the window before each point) against the trials
  const hist = Array.isArray(s.history) ? s.history.filter((h) => h && typeof h === 'object') : [];
  if (hist.length >= 2) {
    const W = 600, H = 200, xs = hist.map((h, i) => (isNum(h.trials) ? h.trials : i));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), X = (x) => (x1 > x0 ? (x - x0) / (x1 - x0) * W : W / 2);
    const series = [['success', '成功（食べた）', 'var(--good)'], ['ate-fell', '食べた後の失敗', 'var(--warm)'], ['fall', '転倒', 'var(--hot)'], ['timeout', '時間切れ', 'var(--faint)']];
    const shown = [];
    const lines = series.map(([key, name, col]) => {
      const pts = hist.map((h, i) => (isNum(h[key]) ? `${X(xs[i]).toFixed(1)},${(H - Math.min(1, Math.max(0, h[key] > 1 ? h[key] / 100 : h[key])) * H).toFixed(1)}` : null)).filter(Boolean);
      if (pts.length < 2) return '';
      shown.push([name, col]);
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    }).join('');
    const grid = [0, 0.5, 1].map((g) => `<line x1="0" x2="${W}" y1="${H - g * H}" y2="${H - g * H}" stroke="#252d36" vector-effect="non-scaling-stroke"/>`).join('');
    if (lines) {
      html += `<h2>成功と失敗の割合</h2><div class="recchart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="試行ごとの成功・失敗の割合">${grid}${lines}</svg>`
        + `<div class="axis"><span>試行 ${x0.toLocaleString()}</span><span>縦軸 0〜100%</span><span>${x1.toLocaleString()}</span></div>`
        + `<div class="legend">${shown.map(([name, col]) => `<span><i style="background:${col}"></i>${name}</span>`).join('')}</div></div>`;
    }
  }
  // the two decisions, what the fly now chooses in each for each food, and the options of each
  const decisions = s.decisions && typeof s.decisions === 'object' ? s.decisions : {};
  const dkeys = Object.keys(DECISION).filter((d) => decisions[d] || Object.values(s.choice || {}).some((c) => c && c[d]));
  const optsOf = (d) => (Array.isArray(decisions[d]?.options) ? decisions[d].options.filter((o) => o && typeof o === 'object') : []);
  const choice = s.choice && typeof s.choice === 'object' ? s.choice : {};
  const rows = Object.keys(FOODS).filter((k) => choice[k] && typeof choice[k] === 'object' && dkeys.some((d) => choice[k][d]));
  // the levels saved so far, to choose the brain the page uses from
  fillLevels(s);
  if (rows.length) {
    const cell = (d, c) => {
      if (!c || typeof c !== 'object') return '<td>–</td>';
      const o = optsOf(d).find((x) => x.id === c.id) || {}, note = c.note || o.note;
      return `<td><b>${esc(c.name || o.name || c.id)}</b>${note ? `<small>${esc(note)}</small>` : ''}</td>`;
    };
    html += `<h2>いま食べ物ごとに選んでいる体の使い方</h2><table class="choices"><thead><tr><th></th>${dkeys.map((d) => `<td class="dh">${esc(decisions[d]?.name || DECISION[d])}</td>`).join('')}</tr></thead>`
      + `<tbody>${rows.map((k) => `<tr><th>${esc(FOODS[k].label)}</th>${dkeys.map((d) => cell(d, choice[k][d])).join('')}</tr>`).join('')}</tbody></table>`;
  }
  // (the options folded away, so the list of trials below is near; left open if it was opened)
  let optsHtml = '';
  for (const d of dkeys) {
    const opts = optsOf(d);
    if (!opts.length) continue;
    const used = new Set(rows.map((k) => choice[k][d]?.id));
    const when = decisions[d]?.when ? `<small class="when">${esc(decisions[d].when)}</small>` : '';
    optsHtml += `<h2>選べる${esc(decisions[d]?.name || DECISION[d])}${when}</h2><ul class="strats">${opts.map((o) => `<li class="${used.has(o.id) ? 'on' : ''}"><b>${esc(o.name || o.id || '')}</b>${o.note ? `<small>${esc(o.note)}</small>` : ''}</li>`).join('')}</ul>`;
  }
  if (optsHtml) html += `<details class="opts"${box.querySelector('details.opts')?.open ? ' open' : ''}><summary>選べる${dkeys.map((d) => esc(decisions[d]?.name || DECISION[d])).join('・')}</summary>${optsHtml}</details>`;
  if (s.updated) {
    const when = new Date(isNum(s.updated) && s.updated < 1e12 ? s.updated * 1000 : s.updated);
    html += `<p class="note">更新: ${esc(Number.isNaN(when.getTime()) ? s.updated : when.toLocaleString('ja-JP'))}</p>`;
  }
  box.innerHTML = html || '<p class="note">学習の記録はまだありません（準備中）</p>';
}
setInterval(() => { if (document.body.dataset.tab === 'record') loadRecord(); }, 30e3);

// ------------------------------------------------------------------ workers
const bodyW = new Worker(new URL('./body-worker.js?v=' + V, import.meta.url), { type: 'module' });
const brainW = new Worker(new URL('./brain-worker.js?v=' + V, import.meta.url), { type: 'module' });
const load = { body: false, brain: 0, skin: false };
const showLoad = () => {
  if (!$('loadtext')) return;                                                    // (started: the school may still be loading)
  const p = (load.body ? 35 : 0) + (load.skin ? 15 : 0) + load.brain * 50;
  $('loadbar').style.setProperty('--p', p + '%');
  $('loadtext').textContent = `体${load.body ? ' ✓' : '…'}  皮膚${load.skin ? ' ✓' : '…'}  脳 ${Math.round(load.brain * 100)}%`
    + (school.ready || school.failed ? '' : `  学習 ${Math.round(school.load * 100)}%`);
};

let brainReady = false, brainBusy = false, pendingRates = null, brainOut = {}, brainWall = 0;
brainW.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { if (m.total) load.brain = Math.min(0.99, m.loaded / m.total); showLoad(); }
  else if (m.type === 'ready') { brainReady = true; load.brain = 1; reflexState.gains = m.reflex?.gains || null; showLoad(); maybeStart(); }
  else if (m.type === 'reflexDelta') { reflexState.gains = m.gains; const f = reflexState.waiting.get(m.id); if (f) { reflexState.waiting.delete(m.id); f(m); } }
  else if (m.type === 'tick') {
    brainBusy = false; brainOut = m.out; brainWall = brainWall * 0.9 + m.wall * 0.1;
    onFired(m);
    bodyW.postMessage({ type: 'brain', out: m.out });
    pumpBrain();
  } else if (m.type === 'error') fail('脳: ' + m.message);
};
function pumpBrain() {
  if (!brainReady || brainBusy || !pendingRates) return;
  brainBusy = true;
  brainW.postMessage({ type: 'tick', ms: 20, inputs: pendingRates });
  pendingRates = null;
}

let bodyReady = false, frame = null;
bodyW.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') { bodyReady = true; load.body = true; showLoad(); maybeStart(); loadControl(true); }
  else if (m.type === 'senses') { pendingRates = m.rates; pumpBrain(); }
  else if (m.type === 'frame') { frame = m; if (m.replay && replay.item) noteReplayFrame(m); }   // (taken as they come: frames can outrun the drawing)
  else if (m.type === 'trial') onTrial(m);
  else if (m.type === 'dopa') brainW.postMessage(m);                              // (the elbow reflex's dopamine, for its synapses)
  else if (m.type === 'out') { if (!frame?.replay && !($('banner').className.includes('ng') && !$('banner').hidden)) { playSfx('buzz'); showBanner('失敗：場外', true); } }
  else if (m.type === 'getup') { onGetup(m); showToast(m.ok ? `起き上がった（${Number(m.t).toFixed(1)}秒）` : '起き上がれず、元に戻した'); }
  else if (m.type === 'down') onDown(m);
  else if (m.type === 'error') {
    if (replay.pending) { console.warn('replay:', m.message); endReplay(false); showToast('この記録は再生できませんでした'); }
    else fail('体: ' + m.message);
  }
};
// (level 1, the fly before any learning, gets the body as it was then too: see NAIVE in body-worker.js)
let wantLevel = 'latest';
try { wantLevel = sessionStorage.getItem('ningen-level') || 'latest'; } catch { /* no storage */ }
bodyW.postMessage({ type: 'init', naive: wantLevel === '1' });
// the elbow reflex's synapses (reflex.mjs) as the school has them for this level: level 1 naive
brainW.postMessage({ type: 'init', reflex: wantLevel === '1' ? null : wantLevel === 'latest' ? 'motor2-latest.bin.gz' : `motor2-${wantLevel}.bin.gz` });
// what the synapses learned during a trial goes to the school with it: the change since the trial began
const reflexState = { waiting: new Map(), seq: 0, gains: null };
function reflexDelta() {
  if (!brainReady) return Promise.resolve(null);
  const id = ++reflexState.seq;
  return new Promise((resolve) => {
    reflexState.waiting.set(id, resolve);
    brainW.postMessage({ type: 'reflexDelta', id });
    setTimeout(() => { if (reflexState.waiting.delete(id)) resolve(null); }, 3000);
  });
}

// ------------------------------------------------------------------ the school
// The learning experiment (../school/): the page's copy of the fly's mushroom body (./school-worker.js)
// makes two decisions in each trial, from the food's smell - with the weights the school has learned
// so far, or those of an earlier level:
//   approach  when the food lands: how to get to it
//   feeding   when the body has got there: how to get the mouth down and eat without falling
// The body worker says when a trial starts, reaches the food, gets to eat, and how it ended; the page
// asks for each decision, tells the body the chosen ways (on top of its tuned base settings), rings
// the result, and sends the school what the brain chose, how it went, and the body worker's record.
// If the school cannot be loaded the body just goes its usual way and nothing is sent.
const schoolW = new Worker(new URL('./school-worker.js?v=' + V, import.meta.url), { type: 'module' });
const school = { ready: false, failed: false, load: 0, want: 'latest', level: null, trials: null, trial: null, runs: new Map(), last: null, ended: new Set() };
schoolW.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { if (m.total) { school.load = Math.min(0.99, m.loaded / m.total); showLoad(); } }
  else if (m.type === 'ready') { Object.assign(school, { ready: true, failed: false, load: 1, level: m.level, trials: m.trials }); showLoad(); showSchool(); }
  else if (m.type === 'choice') onChoice(m);
  else if (m.type === 'error') { console.warn('school:', m.message); school.failed = !school.ready; showSchool(); }
};
schoolW.onerror = (e) => { console.warn('school worker:', e.message); school.failed = true; showSchool(); };
const DECISION = { approach: '近づき方', feeding: '食べ方', getup: '起き上がり方', turnaround: '後ろへの向き方' };
const levelName = (lv) => (lv === 'latest' ? '最新' : String(lv) === '1' ? 'レベル1（学習前）' : `レベル${lv}`);
// (the level chosen is kept over a reload - リセット reloads the page)
try { const v = sessionStorage.getItem('ningen-level'); if (v) school.want = v; } catch { /* no storage */ }
for (const sel of [$('lvsel'), $('lvmini')]) if (sel) { if (![...sel.options].some((o) => o.value === school.want)) sel.add(new Option(levelName(school.want), school.want)); sel.value = school.want; }
schoolW.postMessage({ type: 'init', level: school.want === 'latest' ? 'latest' : Number(school.want) });
loadLevels();
// under the brain map: which level of brain is choosing, and what it chose last in the trial under way
function showSchool() {
  const el = $('school');
  if (school.failed) el.textContent = '脳の選択：なし';
  else if (!school.ready) el.textContent = '脳：読み込み中';
  else if (school.last) el.textContent = `${DECISION[school.last.decision] || '選択'}：${school.last.option.name}`;
  else el.textContent = '';
  el.hidden = !el.textContent;
  const mini = $('lvmini');
  if (mini) { mini.value = school.want; mini.disabled = !school.ready && !school.failed; }
  el.title = school.ready ? `${levelName(school.level)}の脳${school.trials != null ? `（学習 ${school.trials} 回）` : ''}` : '';
  const now = $('lvnow');
  if (now) now.textContent = school.ready ? `使用中：${levelName(school.level)}・体：${bodyLabel()}` : school.failed ? '読み込めませんでした' : '読み込み中…';
}
// {GROUP: {...}} objects merged group by group, later ones winning
function mergeParams(...all) {
  const out = {};
  for (const p of all) if (p && typeof p === 'object') for (const [g, v] of Object.entries(p)) out[g] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[g], ...v } : v;
  return out;
}
// the body's tuned base (../school/tune.mjs) that the chosen ways go on top of: its gait and balance.
// Only settings the tuner has verified - tried again and again and still better than the body's own
// hand-set ones - are used: a candidate that did well once (a lucky few trials) fell over far more
// on the page. Until then, and for level 1, the body keeps its own.
// The body's basic control goes with the brain's level - holding and moving the body is part of what
// the brain has learned by then: level 1 has the body from before any learning (NAIVE in the body
// worker), a saved level the verified settings it had when it was saved (none then: the hand-set
// ones), and 最新 the verified settings now.
function bodyLabel() {
  const want = String(school.want);
  if (want === '1') return '学習前';
  if (want !== 'latest') { const lv = levelList.levels.find((l) => String(l.level) === want); return lv?.body ? `自動調整 第${lv.body.gen}世代` : '手調整'; }
  return control.json?.verified === true ? `自動調整 第${control.json.gen}世代` : '手調整';
}
function tunedSettings() {
  const want = String(school.want);
  if (want === '1') return null;
  if (want !== 'latest') {
    const lv = levelList.levels.find((l) => String(l.level) === want);
    return lv?.body?.settings && typeof lv.body.settings === 'object' ? lv.body.settings : null;
  }
  const j = control.json;
  if (!j || j.verified !== true) return null;
  return j.settings && typeof j.settings === 'object' ? j.settings : null;
}
function baseParams() {
  const set = tunedSettings();
  return set ? { GAIT: set.GAIT, balance: set.balance, ...(set.TURN ? { TURN: set.TURN } : {}) } : {};
}
const FAILED = { fell: '転倒（8秒以内に起き上がれず）', out: '場外', timeout: '時間切れ' };
// the get-ups of a trial with how each went (the last one not up when the trial was lost to it: failed)
function getupsOf(run, result) {
  const last = Math.max(-1, ...run.getups.keys());
  return [...run.getups].map(([n, c]) => {
    const r = run.getupResults.get(n);
    return r ? { k: c.k, drive: c.drive, ok: r.ok, t: r.t } : result === 'fell' && n === last ? { k: c.k, drive: c.drive, ok: false, t: 8 } : null;
  }).filter(Boolean);
}
function onTrial(m) {
  // each trial's phases are acted on once, however often they might be heard
  let run = school.runs.get(m.id);
  if (school.ended.has(m.id) || frame?.replay) return;                            // (a recording plays: the live body is paused)
  if (m.phase === 'start') {
    if (run) return;
    showBanner(null);
    school.runs.set(m.id, run = { food: m.food, approach: null, feeding: null, turnaround: null, reached: false, ate: false, getups: new Map(), getupResults: new Map(), getupNow: null });
    reflexDelta();                                                               // (from here on)
    school.trial = m.id; school.last = null; showSchool();
    if (school.ready) schoolW.postMessage({ type: 'choose', id: m.id, food: m.food, decision: 'approach' });
    if (school.ready && m.behind) schoolW.postMessage({ type: 'choose', id: m.id, food: m.food, decision: 'turnaround' });   // (food behind: how to come round to it)
    return;
  }
  if (m.phase === 'reached') {
    if (!run || run.reached) return;
    run.reached = true;
    if (school.ready) schoolW.postMessage({ type: 'choose', id: m.id, food: m.food, decision: 'feeding' });
    return;
  }
  if (m.phase === 'ate') {
    if (!run || run.ate) return;
    run.ate = true;
    playSfx('chime'); showBanner('食べられた！', false);                        // (and it goes on eating)
    return;
  }
  if (m.phase !== 'end' || !run) return;                                         // (not one this page saw start: from before a リセット)
  school.ended.add(m.id); school.runs.delete(m.id);
  if (school.trial === m.id) { school.trial = null; school.last = null; showSchool(); }
  if (m.result === 'lost') return;                                               // (the food went off the floor: not a trial)
  if (m.result === 'finished') showBanner('完食！', false);
  else { playSfx('buzz'); showBanner('失敗：' + (m.ate != null ? '食べた後に' : '') + (FAILED[m.result] || m.result), true); }
  if (!run || !run.approach) return;                                             // (no choice was made: nothing to learn from)
  const pick = (c) => (c ? { k: c.k, drive: c.drive } : null);
  // (the reflex's change only from the latest brain: another level's synapses are not the school's now)
  (school.want === 'latest' ? reflexDelta() : Promise.resolve(null)).then((rd) => fetch(new URL('../api/trial', import.meta.url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ food: m.food, choices: { approach: pick(run.approach), feeding: pick(run.feeding), turnaround: pick(run.turnaround) }, result: m.result, reached: m.reached ?? null, ate: m.ate ?? null, t: m.t, record: m.record,
      reflex: rd ? rd.delta : null, getups: getupsOf(run, m.result) }) }))
    .then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      showToast('学習データを送信しました');
      const j = await r.json().catch(() => null);
      if (m.motion && j && j.trial != null && j.token) sendMotion(j.trial, j.token, m.motion);
    })
    .catch((err) => console.warn('trial not sent:', err.message));
}
// the trial's motion, to watch again later: gzipped here, sent with the token the school gave the trial
async function sendMotion(trial, token, motion) {
  try {
    const gz = await new Response(new Blob([motion]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const r = await fetch(new URL(`../api/motion?trial=${encodeURIComponent(trial)}&token=${encodeURIComponent(token)}`, import.meta.url),
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: gz });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (err) { console.warn('motion not sent:', err.message); }
}
// Down during a trial: the fly chooses how to get up (the body starts at it half a second after going
// down); up again, or not within 8 s, is learned from at the end with the rest of the trial
function onDown(m) {
  const run = school.runs.get(school.trial);
  if (!run || !school.ready || frame?.replay) return;
  schoolW.postMessage({ type: 'choose', id: school.trial, food: run.food, decision: 'getup', n: m.n });
}
function onGetup(m) {
  const run = school.runs.get(school.trial);
  if (!run || !run.getups.has(m.n)) return;
  run.getupResults.set(m.n, { ok: !!m.ok, t: m.t });
  run.getupNow = null;
  bodyW.postMessage({ type: 'strategy', params: runParams(run) });                  // (back to how it goes about the food)
}
const runParams = (run) => mergeParams(baseParams(), run.approach?.option.params, run.turnaround?.option.params, run.feeding?.option.params, run.getupNow?.option.params);
function onChoice(m) {
  const run = school.runs.get(m.id);
  if (!run || !m.option || !DECISION[m.decision]) return;                        // (that trial is over already)
  if (m.decision === 'getup') { const c = { k: m.k, drive: m.drive, option: m.option }; run.getups.set(m.n, c); run.getupNow = c; }
  else run[m.decision] = { k: m.k, drive: m.drive, option: m.option };
  bodyW.postMessage({ type: 'strategy', params: runParams(run) });
  school.last = { decision: m.decision, option: m.option }; showSchool();
  lastLabel = `${DECISION[m.decision]}：${m.option.name}`; lastNote = m.option.note || ''; labelAt = performance.now();
}
// the result over the scene: a success goes by itself, a failure waits for リセット
let bannerTimer = 0, toastTimer = 0;
function showBanner(text, failed) {
  clearTimeout(bannerTimer);
  $('banner').hidden = !text;
  if (!text) return;
  $('bannertext').textContent = text;
  $('banner').className = 'banner ' + (failed ? 'ng' : 'ok');
  $('resetbtn').hidden = !failed;
  if (!failed) bannerTimer = setTimeout(() => showBanner(null), 2500);
}
// (リセット reloads the whole page: brain, body, food and every bit of state start again from nothing)
$('resetbtn').addEventListener('click', () => { $('resetbtn').disabled = true; location.reload(); });
// リセット, or back to live (which the body worker starts over too): everything the page has of the
// scene goes at once - the food (lumps, puddles, honey still pouring that would otherwise land and be
// sent after it), honey on the person, the rings, the banner and note, the trial under way and its
// choices - and the camera looks at the centre again
function clearAll() {
  fadeIn(150);
  for (const p of drops) removeDrop(p);
  drops.length = 0;
  clearReplayPours();
  if (replayFood.size) animateReplayFood([]);
  school.runs.clear(); school.trial = null; school.last = null; showSchool();
  showBanner(null);
  clearTimeout(toastTimer); $('toast').hidden = true;
  sound.eating = null;
  labelAt = -1e9;
  orbit.target.x = 0; orbit.target.z = 0;
}
function showToast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200);
}
// The body's basic control settings, as the school's tuner (../school/tune.mjs) has found them so far:
// sent to the body once it is up (nothing waits for them), and again when the level changes - level 1
// is the fly before any learning, so its body gets the untuned defaults.
const control = { json: null };
async function loadControl(send) {
  try {
    const r = await fetch(new URL('../school/state/control.json?t=' + Date.now(), import.meta.url), { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || typeof j !== 'object') return;
    control.json = j; showSchool();
  } catch { return; }                                                            // (no tuner yet: the body keeps its own)
  const el = $('tune'), j = control.json;
  if (el && (isNum(j.gen) || isNum(j.score))) {
    el.textContent = `体の基礎制御の自動調整：第${isNum(j.gen) ? j.gen : '–'}世代・スコア${isNum(j.score) ? +j.score.toFixed(3) : '–'}${j.verified === true ? '（使用中）' : '（検証中：まだ使っていない）'}`;
    el.hidden = false;
  }
  if (send) sendBase();
}
function sendBase() {
  if (!bodyReady) return;
  const settings = tunedSettings();
  if (settings) bodyW.postMessage({ type: 'base', settings });
}
// another level's brain: the page starts over with it (a reload, like リセット - the level is kept
// for it in sessionStorage; only where that cannot be kept is the brain swapped in place)
function setLevel(v) {
  if (v === school.want) return;
  try {
    sessionStorage.setItem('ningen-level', v);
    if (sessionStorage.getItem('ningen-level') === v) {
      for (const sel of [$('lvsel'), $('lvmini')]) if (sel) sel.disabled = true;
      location.reload();
      return;
    }
  } catch { /* no storage */ }
  for (const sel of [$('lvsel'), $('lvmini')]) if (sel) sel.value = v;
  school.want = v; school.ready = false; school.failed = false; school.last = null; showSchool();
  sendBase();                                                                    // (level 1: the untuned body too)
  schoolW.postMessage({ type: 'level', level: v === 'latest' ? 'latest' : Number(v) });
}
for (const sel of [$('lvsel'), $('lvmini')]) sel?.addEventListener('change', (e) => setLevel(e.target.value));

function maybeStart() {
  if (!(bodyReady && brainReady && load.skin)) return;
  $('loading').remove();
  started = true;
  openSharedCase();
  fadeIn(0);
}
// The person appears gently - on the first start, after リセット and back to live - fading in over 0.8 s:
// the skin, the eyes, the mouth, the brain in the glass and the fly on top (whatever hangs from the
// skeleton). Each material is made see-through for the fade and put back as it was after it. The
// fade waits a moment first, so frames still on their way from before a reset are not seen.
const appear = { from: -1, mats: new Map() };
function fadeIn(delay) { appear.from = performance.now() + delay; }
function animateAppear(now) {
  if (appear.from < 0 || !skinMesh) return;
  const k = Math.min(1, Math.max(0, (now - appear.from) / 800)), e = k * k * (3 - 2 * k);
  const add = (m) => { if (m && !appear.mats.has(m)) { appear.mats.set(m, { transparent: m.transparent, opacity: m.opacity }); if (!m.transparent) { m.transparent = true; m.needsUpdate = true; } } };
  const visit = (o) => { if (o.material) for (const m of [].concat(o.material)) add(m); };
  visit(skinMesh);
  for (const b of bones) for (const c of b.children) c.traverse(visit);             // (the fly may have loaded meanwhile)
  for (const [m, was] of appear.mats) m.opacity = was.opacity * e;
  if (k < 1) return;
  for (const [m, was] of appear.mats) { m.opacity = was.opacity; if (m.transparent !== was.transparent) { m.transparent = was.transparent; m.needsUpdate = true; } }
  appear.mats.clear(); appear.from = -1;
}
let started = false, lastLabel = '', lastNote = '', labelAt = -1e9;

// ------------------------------------------------------------------ three
const stage = $('stage');
// a long press or a double tap on the scene must not select anything or bring up a callout menu
for (const ev of ['contextmenu', 'selectstart', 'dragstart']) stage.addEventListener(ev, (e) => e.preventDefault());
stage.addEventListener('dblclick', (e) => { e.preventDefault(); getSelection()?.removeAllRanges(); });
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 4 / 3, 0.05, 50);
scene.add(new THREE.HemisphereLight(0xe8eef5, 0x2a2018, 1.0));
const key = new THREE.DirectionalLight(0xfff4e8, 1.1); key.position.set(2, 4, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0x9fd0ff, 0.4); rim.position.set(-3, 2, -2); scene.add(rim);
const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 64), new THREE.MeshStandardMaterial({ color: 0x161c23, roughness: 1 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
// What the eyes are on (the body worker's attention, frame.look): a dashed line from between the eyes
// and a ring there - amber for a sound the brain turned the head to, red for something coming at the
// eyes, blue for the thing moving most in view, grey for straight ahead
const LOOK = { sound: 0xffb454, loom: 0xff6b6b, motion: 0x9fd0ff, ahead: 0x8a97a6 };
const lookRing = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.045, 32), new THREE.MeshBasicMaterial({ color: LOOK.ahead, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
const lookLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
  new THREE.LineDashedMaterial({ color: LOOK.ahead, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.5, depthTest: false }));
lookRing.renderOrder = lookLine.renderOrder = 10; lookRing.visible = lookLine.visible = false;
scene.add(lookRing, lookLine);
scene.add(new THREE.PolarGridHelper(2.2, 8, 8, 64, 0x26303a, 0x1d252d));

// orbit around the person (the target follows them as they walk): drag to turn, wheel/pinch to zoom
const orbit = { yaw: 0.9, pitch: 0.28, dist: 2.8, target: new THREE.Vector3(0, 0.45, 0) };   // low: the person is on all fours
function placeCamera() {
  if (orbit.face) return;                                                         // (#face: set with the frame)
  const c = Math.cos(orbit.pitch);
  camera.position.set(orbit.target.x + orbit.dist * c * Math.sin(orbit.yaw), orbit.target.y + orbit.dist * Math.sin(orbit.pitch), orbit.target.z + orbit.dist * c * Math.cos(orbit.yaw));
  camera.lookAt(orbit.target);
}
const pointers = new Map();
const cv = renderer.domElement;
// a tap (a touch that neither drags nor pinches) drops food on the floor where it points
let tap = null;
cv.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, [e.clientX, e.clientY]); cv.setPointerCapture(e.pointerId);
  tap = pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
});
cv.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10 && performance.now() - tap.t < 500) pourAt(e.clientX, e.clientY);
  tap = null;
});
cv.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
cv.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId); if (!prev) return;
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= 10) tap = null;
  if (pointers.size === 1) {
    orbit.yaw -= (e.clientX - prev[0]) * 0.006;
    orbit.pitch = Math.max(-0.2, Math.min(1.3, orbit.pitch + (e.clientY - prev[1]) * 0.005));
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const before = Math.hypot(a[0] - b[0], a[1] - b[1]);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const [a2, b2] = [...pointers.values()];
    orbit.dist = Math.max(1, Math.min(8, orbit.dist * before / Math.max(1, Math.hypot(a2[0] - b2[0], a2[1] - b2[1]))));
    return;
  }
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
});
cv.addEventListener('wheel', (e) => { e.preventDefault(); orbit.dist = Math.max(1, Math.min(8, orbit.dist * Math.exp(e.deltaY * 0.001))); }, { passive: false });

const world = new THREE.Group(); world.rotation.x = -Math.PI / 2; scene.add(world);   // MuJoCo z-up -> three y-up
let bones = [], pelvisId = 0, skinMesh = null, hipIds = null, restQuat = null;
// the face: eyes that dart about, and a mouth that works (a fly's proboscis never rests)
const face = { eyes: [], lids: [], blink: { next: 2, t0: -9 }, headId: 0, fwd: null, up: null, left: null, target: 'none', point: null, nextGaze: 0, mouth: 0, chewUntil: 0, nextChew: 2 };
const Y_AXIS = new THREE.Vector3(0, 1, 0);
function animateFace(now, prog) {
  const t = now / 1000;
  // the eyes are on what the body worker says they attend to (frame.look: MuJoCo x, y, z -> three x, z, -y)
  const look = frame && !frame.replay ? frame.look : null;
  const tgt = look ? new THREE.Vector3(look.p[0], look.p[2], -look.p[1]) : null;
  lookRing.visible = lookLine.visible = !!tgt && face.eyes.length > 0;
  // (nothing drawn for a point right at the face: the ring sat over the eyeballs)
  if (tgt && face.eyes.length && tgt.distanceTo(new THREE.Vector3().setFromMatrixPosition(face.eyes[0].matrixWorld)) < 0.3) lookRing.visible = lookLine.visible = false;
  if (tgt && face.eyes.length) {
    const mid = new THREE.Vector3();
    for (const e of face.eyes) mid.add(new THREE.Vector3().setFromMatrixPosition(e.matrixWorld));
    mid.multiplyScalar(1 / face.eyes.length);
    const col = LOOK[look.why] ?? LOOK.ahead;
    lookRing.material.color.setHex(col); lookLine.material.color.setHex(col);
    lookRing.material.opacity = look.why === 'ahead' ? 0.45 : 0.95; lookLine.material.opacity = look.why === 'ahead' ? 0.25 : 0.6;
    lookRing.position.copy(tgt); lookRing.lookAt(camera.position);
    lookLine.geometry.setFromPoints([mid, tgt]); lookLine.computeLineDistances();
  }
  if (tgt) {
    const head = bones[face.headId];
    const inv = new THREE.Quaternion().setFromRotationMatrix(head.matrixWorld).invert();
    for (const e of face.eyes) {
      const ew = new THREE.Vector3().setFromMatrixPosition(e.matrixWorld);
      const dir = tgt.clone().sub(ew).applyQuaternion(inv).normalize();       // in the head's frame
      // an eye turns about 26 degrees at most (further, the iris went in under the lid): clamp toward straight ahead
      const ang = face.fwd.angleTo(dir);
      if (ang > 0.45) dir.lerpVectors(face.fwd, dir, 0.45 / ang).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(face.fwd, dir);
      e.quaternion.slerp(q, 0.55);                                              // quick, like a saccade
    }
  }
  // blinking: every 2-6 s, a blink of 0.16 s (down fast, up a little slower) - and at once when the brain's
  // giant fibre sets the body escaping, as a startle
  if (prog.escape && !face.blink.startled) { face.blink.t0 = t; face.blink.startled = true; }
  if (!prog.escape) face.blink.startled = false;
  if (t >= face.blink.next) { face.blink.t0 = t; face.blink.next = t + 2 + Math.random() * 4 + (Math.random() < 0.15 ? -1.6 : 0); }
  const bu = (t - face.blink.t0) / 0.16, shut = location.hash === '#face-shut' ? 1 : bu < 0 || bu > 1 ? 0 : bu < 0.4 ? bu / 0.4 : 1 - (bu - 0.4) / 0.6;   // (#face-shut: to look at the lids)
  // (the lid's axis tipped from the face's up back by 60 degrees when open - clear of the iris - forward by 35 when shut)
  const tip = (-60 + 95 * shut) * Math.PI / 180, axis = face.up.clone().multiplyScalar(Math.cos(tip)).addScaledVector(face.fwd, Math.sin(tip)).normalize();
  for (const lid of face.lids) lid.quaternion.setFromUnitVectors(Y_AXIS, axis);
  // mouth: dabbing fast while feeding or probing the floor, chewing in bursts otherwise
  let open = 0;
  if ((prog.feed || 0) > 0.3) open = Math.max(0, Math.sin(2 * Math.PI * 8 * t)) ** 0.7;          // lapping and biting at the food
  else if ((prog.probe || 0) > 0.3) open = Math.max(0, Math.sin(2 * Math.PI * 5 * t)) ** 0.7;
  else {
    if (t >= face.nextChew) { face.chewUntil = t + 0.4 + Math.random() * 0.8; face.nextChew = face.chewUntil + 0.8 + Math.random() * 2.5; }
    if (t < face.chewUntil) open = 0.55 * Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
  }
  if (location.hash === '#face-open') open = 0.9;                                  // (#face-open: to look at the teeth)
  face.mouth += (open - face.mouth) * 0.6;
  if (skinMesh) skinMesh.morphTargetInfluences[4] = face.mouth;
  if (face.inner) face.inner.open(face.mouth);
}

// the person: MakeHuman's body mesh fitted onto MyoFullBody's skeleton (../fit_skin.py),
// skinned to one THREE.Bone per MuJoCo body
async function loadSkin() {
  const gz = (u) => fetch(new URL(u + '?v=' + V, import.meta.url)).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const [body, info, buf] = await Promise.all([
    fetch(new URL('./data/body.json?v=' + V, import.meta.url)).then((r) => r.json()),
    fetch(new URL('./data/skin.json?v=' + V, import.meta.url)).then((r) => r.json()),
    gz('./data/skin.bin.gz'),
  ]);
  pelvisId = body.bodies.indexOf('pelvis');
  bones = body.bodies.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; world.add(b); return b; });
  const dv = new DataView(buf), nv = dv.getUint32(0, true), nt = dv.getUint32(4, true);
  let o = 8;
  const pos = new Float32Array(buf.slice(o, o + nv * 12)); o += nv * 12;
  const idx = new Uint16Array(buf.slice(o, o + nt * 6)); o += nt * 6;
  const bi = new Uint8Array(buf.slice(o, o + nv * 4)); o += nv * 4;
  const bw = new Uint8Array(buf.slice(o, o + nv * 4)); o += nv * 4;
  const fillL = new Float32Array(buf.slice(o, o + nv * 12)); o += nv * 12;
  const fillR = new Float32Array(buf.slice(o, o + nv * 12)); o += nv * 12;
  const armL = new Float32Array(buf.slice(o, o + nv * 12)); o += nv * 12;
  const armR = new Float32Array(buf.slice(o, o + nv * 12)); o += nv * 12;
  const mouthOpen = new Float32Array(buf.slice(o, o + nv * 12));
  // The eyelids over the eyeballs: MakeHuman's skin was made for eyes set a little deeper, and the
  // eyeball spheres poked through it as a ring round each eye. Skin inside an eyeball (plus a skin's
  // thickness) is pushed out over it, and the skin around eased out with it - except in the eye's
  // opening, straight ahead, where the eyeball is to show.
  {
    const R = info.eyeRadius, cover = R + 0.0018, ease = R * 1.9, fwd = [0, -1, 0];      // (the face looks along -y at rest)
    for (const S of ['L', 'R']) {
      const c = info.eyes[S];
      for (let v = 0; v < nv; v++) {
        const dx = pos[3 * v] - c[0], dy = pos[3 * v + 1] - c[1], dz = pos[3 * v + 2] - c[2], dist = Math.hypot(dx, dy, dz);
        if (dist >= ease || dist < 1e-6) continue;
        const front = (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) / dist;
        if (front > 0.8) continue;                                           // (the opening)
        const want = cover + (ease - cover) * Math.max(0, (dist - R * 0.6) / (ease - R * 0.6)) ** 2;   // (full cover close in, nothing at the edge)
        const out = Math.max(0, want - dist) * Math.min(1, (0.8 - front) / 0.25);                      // (fading in away from the opening)
        if (out <= 0) continue;
        const k = (dist + out) / dist;
        pos[3 * v] = c[0] + dx * k; pos[3 * v + 1] = c[1] + dy * k; pos[3 * v + 2] = c[2] + dz * k;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Uint16Array.from(bi), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Float32Array.from(bw, (w) => w / 255), 4));
  g.computeVertexNormals();
  // flesh that swells over each hip as it flexes and round each shoulder as the arm rises (fit_skin.py step 6)
  g.morphAttributes.position = [fillL, fillR, armL, armR, mouthOpen].map((a) => new THREE.BufferAttribute(a, 3));
  g.morphTargetsRelative = true;
  // the brain case (above the brows, down the back of the head) is glass, so the fly's brain shows
  // inside: a 0..1 weight per vertex from the head's bind pose, fading in over 2 cm; triangles that
  // touch it are drawn as a second, see-through group
  const headBone = body.bodies.indexOf('head'), eyeY = info.eyes.L[1], eyeZ = info.eyes.L[2];
  const glass = new Float32Array(nv), zone = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    let w = 0;
    for (let j = 0; j < 4; j++) if (bi[4 * v + j] === headBone) w += bw[4 * v + j] / 255;
    const brow = eyeZ + 0.024 - 0.35 * (pos[3 * v + 1] - eyeY);           // the line tilts down toward the back
    const smooth = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
    glass[v] = smooth(0, 0.02, pos[3 * v + 2] - brow) * smooth(0.5, 0.9, w);
    // a band below it stays opaque but one-sided - not round the eyes: drawn in the see-through group, the
    // insides of the eye sockets showed through the lids as a ring round each eye
    const nearEye = ['L', 'R'].some((S) => Math.hypot(pos[3 * v] - info.eyes[S][0], pos[3 * v + 1] - info.eyes[S][1], pos[3 * v + 2] - info.eyes[S][2]) < 0.035);
    zone[v] = w > 0.5 && pos[3 * v + 2] - brow > (nearEye ? 0 : -0.03);
  }
  g.setAttribute('glass', new THREE.BufferAttribute(glass, 1));
  // Briefs: a 0..1 weight per vertex from the bind pose (MuJoCo frame: z up, the front toward -y), soft over
  // 4 mm at the edges - from a low waistband 8-10 cm above the hip joints (lower in front) down to the
  // crotch, the leg openings rising toward the hips, a little fuller behind; and 0..1 for the waistband
  {
    const hipL = info.rest.xpos[body.bodies.indexOf('femur_l')], hipR = info.rest.xpos[body.bodies.indexOf('femur_r')];
    const cx = (hipL[0] + hipR[0]) / 2, hz = (hipL[2] + hipR[2]) / 2, cy = (hipL[1] + hipR[1]) / 2;
    const cloth = new Float32Array(nv), band = new Float32Array(nv);
    const smooth = (e0, e1, x) => { const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
    for (let v = 0; v < nv; v++) {
      const x = pos[3 * v] - cx, y = pos[3 * v + 1] - cy, z = pos[3 * v + 2] - hz;
      const back = smooth(-0.02, 0.06, y);                                // (0 in front, 1 behind)
      const top = 0.08 + 0.02 * back;
      const bottom = -0.11 + 0.6 * Math.max(0, Math.abs(x) - 0.04) - 0.025 * back;
      const w = smooth(bottom - 0.002, bottom + 0.002, z) * (1 - smooth(top - 0.002, top + 0.002, z)) * (1 - smooth(0.19, 0.21, Math.abs(x)));
      cloth[v] = w; band[v] = w * smooth(top - 0.016, top - 0.012, z);
    }
    g.setAttribute('cloth', new THREE.BufferAttribute(cloth, 1));
    g.setAttribute('band', new THREE.BufferAttribute(band, 1));
  }
  const solidTri = [], glassTri = [];
  for (let t = 0; t < nt; t++) {
    const tri = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]];
    // (the glass group is one-sided, so through it one sees no ragged inside of the far wall)
    (tri.some((v) => zone[v]) ? glassTri : solidTri).push(...tri);
  }
  g.setIndex(new THREE.BufferAttribute(Uint16Array.from([...solidTri, ...glassTri]), 1));
  g.addGroup(0, solidTri.length, 0); g.addGroup(solidTri.length, glassTri.length, 1);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xd8a88a, roughness: 0.3, transparent: true, depthWrite: false });
  glassMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float glass;\nvarying float vGlass;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlass = glass;');
    // clear face-on, denser toward the outline, like a glass bowl
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlass;')
      .replace('#include <opaque_fragment>', `float rim = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.0);
        outgoingLight = mix(outgoingLight, outgoingLight * 0.6 + vec3(0.35, 0.42, 0.5) * rim, vGlass);
        diffuseColor.a *= mix(1.0, 0.08 + 0.5 * rim, vGlass);   // (times the material's opacity: the body fades in)
        #include <opaque_fragment>`);
  };
  // both sides: an open mouth shows the inside of the lips, which a back-culled skin left as a hole
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd8a88a, roughness: 0.58, side: THREE.DoubleSide });
  // (the briefs: dark navy cotton, matte, with a grey waistband)
  skinMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float cloth;\nattribute float band;\nvarying float vCloth;\nvarying float vBand;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloth = cloth; vBand = band;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vCloth;\nvarying float vBand;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.075, 0.1, 0.17), vec3(0.42, 0.44, 0.47), vBand), vCloth);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.92, vCloth);');
  };
  const skin = new THREE.SkinnedMesh(g, [skinMat, glassMat]);
  skin.renderOrder = 2;                                                     // the glass after the brain inside it
  skin.frustumCulled = false;
  skinMesh = skin; hipIds = { pelvis: body.bodies.indexOf('pelvis'), L: body.bodies.indexOf('femur_l'), R: body.bodies.indexOf('femur_r'), torso: body.bodies.indexOf('torso'), armL: body.bodies.indexOf('humerus_l'), armR: body.bodies.indexOf('humerus_r') };
  restQuat = info.rest.xquat;
  const rest = (b) => new THREE.Matrix4().compose(new THREE.Vector3(...info.rest.xpos[b]),
    new THREE.Quaternion(info.rest.xquat[b][1], info.rest.xquat[b][2], info.rest.xquat[b][3], info.rest.xquat[b][0]), new THREE.Vector3(1, 1, 1));
  bones.forEach((b, i) => b.matrix.copy(rest(i)));
  world.add(skin);
  world.updateMatrixWorld(true);
  skin.bind(new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert())));
  const head = body.bodies.indexOf('head');
  const white = new THREE.MeshStandardMaterial({ color: 0xf2efe9, roughness: 0.25 }), dark = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.3 });
  const lidMat = new THREE.MeshStandardMaterial({ color: 0xc9977b, roughness: 0.6 });
  // directions in the head's own frame: the face looks along world -y at rest
  const headRest = new THREE.Quaternion(info.rest.xquat[head][1], info.rest.xquat[head][2], info.rest.xquat[head][3], info.rest.xquat[head][0]).invert();
  face.headId = head;
  face.fwd = new THREE.Vector3(0, -1, 0).applyQuaternion(headRest);
  face.up = new THREE.Vector3(0, 0, 1).applyQuaternion(headRest);
  face.left = new THREE.Vector3(1, 0, 0).applyQuaternion(headRest);
  for (const S of ['L', 'R']) {
    const eye = new THREE.Group();
    eye.add(new THREE.Mesh(new THREE.SphereGeometry(info.eyeRadius, 16, 12), white));
    // (the iris a flattened cap lying on the eyeball, not a ball standing out of it)
    const iris = new THREE.Mesh(new THREE.SphereGeometry(info.eyeRadius * 0.5, 16, 10), dark);
    iris.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), face.fwd);
    iris.scale.set(1, 1, 0.3);
    iris.position.copy(face.fwd).multiplyScalar(info.eyeRadius * 0.88);
    eye.add(iris);
    eye.position.copy(new THREE.Vector3(...info.eyes[S]).applyMatrix4(rest(head).invert()));
    bones[head].add(eye); face.eyes.push(eye);
    // the upper lid: a thin shell of skin just outside the eyeball, fixed to the head (not turning with
    // the eye), tucked up under the brow when open and swung down over the eye to blink (animateFace)
    const lid = new THREE.Mesh(new THREE.SphereGeometry(info.eyeRadius * 1.1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), lidMat);
    lid.position.copy(eye.position);
    bones[head].add(lid); face.lids.push(lid);
  }
  // the fly's brain inside the glass, facing the viewer: the same picture as the top right
  face.brainTex = new THREE.CanvasTexture(bm);
  face.brainTex.colorSpace = THREE.SRGBColorSpace;
  const brain = new THREE.Sprite(new THREE.SpriteMaterial({ map: face.brainTex, transparent: true, depthWrite: false }));
  brain.scale.set(0.13, 0.13 / 2.08, 1);
  brain.renderOrder = 1;
  const mid = new THREE.Vector3().addVectors(new THREE.Vector3(...info.eyes.L), new THREE.Vector3(...info.eyes.R)).multiplyScalar(0.5);
  brain.position.copy(mid).applyMatrix4(rest(head).invert()).addScaledVector(face.up, 0.065).addScaledVector(face.fwd, -0.07);
  bones[head].add(brain);
  // the floor of the brain case, level with the brows, hiding the inside of the face below
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.atan(0.35));
  const plate = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshStandardMaterial({ color: 0x4a3034, roughness: 0.8, side: THREE.DoubleSide }));
  plate.matrixAutoUpdate = false;
  plate.matrix.copy(rest(head).invert()).multiply(new THREE.Matrix4().compose(
    new THREE.Vector3(mid.x, eyeY + 0.068, eyeZ + 0.024 - 0.35 * 0.068 - 0.002), tilt, new THREE.Vector3(0.064, 0.086, 1)));
  bones[head].add(plate);
  // the inside of the mouth: teeth, gums and tongue, the lower ones on the jaw (./mouth.js)
  face.inner = buildMouth(bones[head], info, rest(head), face);
  // the fly whose brain this is, riding on top of the head (NeuroMechFly, as on the other pages)
  loadRider(bones[head]).catch((e) => console.warn('fly body:', e.message));
  load.skin = true; showLoad(); maybeStart();
}
const rider = { fly: null, cpg: null, legs: LEGS.map(() => new Array(7)), rubSeed: {}, ikRub: {}, rubW: 0, neutral: [] };
async function loadRider(headBone) {
  const { J, bin } = await loadFlyData(new URL('../../test03/nmf/', import.meta.url).href, '?v=6');
  const fly = new FlyBody(J, bin, { ghosts: 2 }), cpg = new CPG(J);
  rider.neutral = LEGS.map((_, i) => cpg.neutral(i));
  // the front legs' rubbing pose, as on /suji/: tarsi together in front of and below the head
  for (const leg of ['lf', 'rf']) {
    const i = LEGS.indexOf(leg), sgn = leg[0] === 'l' ? 1 : -1;
    rider.rubSeed[leg] = fly.ik(leg, [0.9, sgn * 0.02, -0.68], rider.neutral[i], rider.neutral[i], 60, 0.02);
  }
  LEGS.forEach((leg, i) => fly.setLeg(leg, rider.neutral[i]));
  fly.update();
  fly.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(fly.root), size = box.getSize(new THREE.Vector3());
  const k = 0.14 / size.x;                                   // a 14 cm fly
  fly.root.scale.setScalar(k);
  // the fly's frame is x forward, y left, z up: line it up with the face, feet on the crown
  const holder = new THREE.Group();
  holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(face.fwd, face.left, face.up));
  holder.position.copy(face.up).multiplyScalar(0.115 - box.min.z * k);         // crown ~11.5 cm above the skull base
  holder.add(fly.root);
  headBone.add(holder);
  rider.fly = fly; rider.cpg = cpg;
}
function animateRider(dt, prog, t) {
  if (!rider.fly) return;
  // its legs tread while the person crawls, and shift about restlessly when it stops
  rider.rubW += (((prog.rub || 0) > 0.3 ? 1 : 0) - rider.rubW) * Math.min(1, dt * 6);
  const drive = (prog.walk ? 0.9 : 0.25 + 0.15 * Math.sin(performance.now() / 700)) * (1 - rider.rubW);
  rider.cpg.step(Math.min(0.05, dt), drive, drive);
  LEGS.forEach((leg, i) => {
    const a = rider.cpg.angles(i, rider.legs[i]);
    if (leg[1] === 'f' && rider.rubW > 0.001) {
      // when the person rubs their hands, the fly rubs its front legs: the tarsi cross and slide over
      // each other in front of the head, in time with the hands (left forward with the left hand)
      const sgn = leg[0] === 'l' ? 1 : -1, ph = 2 * Math.PI * 1.6 * t + (sgn > 0 ? 0 : Math.PI);
      const tgt = [0.9 + 0.06 * Math.sin(ph), sgn * (0.02 + 0.07 * Math.sin(ph)), -0.68 + 0.05 * Math.cos(ph)];
      const sol = rider.fly.ik(leg, tgt, rider.ikRub[leg] || rider.rubSeed[leg], rider.neutral[i], 3, 0.02);
      rider.ikRub[leg] = sol;
      for (let d = 0; d < 7; d++) a[d] += (sol[d] - a[d]) * rider.rubW;
    } else if (leg[1] === 'f') rider.ikRub[leg] = null;
    rider.fly.setLeg(leg, a);
  });
  rider.fly.update();
}
loadSkin().catch((e) => fail('皮膚: ' + e.message));

// ------------------------------------------------------------------ sound
// Every sound is made here with WebAudio, out of a second of white noise and a few oscillators - no
// recordings. A browser lets a page start sound only from a gesture, so the first touch anywhere on
// the page makes the context (or wakes it).
const sound = { ctx: null, out: null, noise: null, frame: null, amt: new Map(), eating: null, eatAt: 0, dripAt: 0 };
function wakeAudio() {
  if (!sound.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = sound.ctx = new AC();
    const comp = c.createDynamicsCompressor();                              // several at once never clip
    comp.connect(c.destination);
    sound.out = c.createGain(); sound.out.gain.value = 0.45; sound.out.connect(comp);
    sound.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = sound.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (sound.ctx.state === 'suspended') sound.ctx.resume();
}
document.addEventListener('pointerdown', wakeAudio, true);
// the time to schedule a sound at, or null while there is to be none
const soundNow = () => (sound.ctx && sound.ctx.state === 'running' ? sound.ctx.currentTime + 0.01 : null);
// noise through a filter whose frequency glides from f0 to f1, under a quick rise and a decay
function hiss(t, dur, f0, f1, gain, { type = 'bandpass', q = 1, attack = 0.004 } = {}) {
  const c = sound.ctx, src = c.createBufferSource(), flt = c.createBiquadFilter(), g = c.createGain();
  src.buffer = sound.noise;
  flt.type = type; flt.Q.value = q;
  flt.frequency.setValueAtTime(f0, t); flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt).connect(g).connect(sound.out);
  src.start(t, Math.random() * 0.6); src.stop(t + dur + 0.02);                // (a different stretch of the noise each time)
}
// a tone gliding from f0 to f1 under the same kind of envelope
function tone(t, dur, f0, f1, gain, { type = 'sine', attack = 0.003, hold = false } = {}) {
  const c = sound.ctx, o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack);
  if (hold) g.gain.setValueAtTime(gain, t + dur - 0.03);                          // (held flat, then cut)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(sound.out);
  o.start(t); o.stop(t + dur + 0.02);
}
const rnd = (a, b) => a + Math.random() * (b - a);
const SFX = {
  // food landing (k: how loud, 1 = a whole pour or lump)
  land: {
    // honey: a soft, slow plop - the pitch of a thick drop's bubble rising as it closes, on a dull thud
    honey: (t, k = 1) => { tone(t, 0.16, rnd(150, 190), rnd(420, 520), 0.2 * k, { attack: 0.015 }); hiss(t, 0.1, 600, 200, 0.14 * k, { type: 'lowpass' }); },
    // dung: a wet splat - a broad smear of noise closing down, a soft thump, little bubbles popping in it
    dung: (t) => {
      hiss(t, 0.24, 2600, 280, 0.4, { type: 'lowpass', q: 0.7, attack: 0.003 }); tone(t, 0.12, 110, 55, 0.28);
      for (let i = 0; i < 3; i++) tone(t + rnd(0.04, 0.18), 0.035, rnd(450, 800), rnd(900, 1500), 0.04);
    },
    // meat: a heavy, fleshy slap - a sharp crack in the middle range over a low thud
    meat: (t) => { hiss(t, 0.07, 1500, 600, 0.45, { q: 0.8, attack: 0.002 }); tone(t, 0.22, 130, 45, 0.55, { attack: 0.002 }); hiss(t + 0.01, 0.16, 420, 140, 0.22, { type: 'lowpass' }); },
  },
  // eating, one short burst at a time; each returns how long its burst lasts
  eat: {
    // honey: licks - a slurp rising in pitch as the tongue pulls in, and a small wet click after
    honey: (t) => {
      const n = 2 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) { const s = t + i * rnd(0.26, 0.32); hiss(s, 0.2, 700, 2600, 0.08, { q: 2.5, attack: 0.06 }); tone(s + 0.17, 0.04, 1000, 1500, 0.02); }
      return n * 0.3;
    },
    // dung: squelches - wet smacks with a bubbly gurgle in them
    dung: (t) => {
      const n = 2 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const s = t + i * rnd(0.3, 0.38);
        hiss(s, 0.13, 1900, 380, 0.13, { type: 'lowpass', q: 3 }); tone(s + 0.02, 0.07, 320, 170, 0.05);
        tone(s + rnd(0.05, 0.1), 0.03, rnd(600, 900), rnd(1000, 1400), 0.025);
      }
      return n * 0.35;
    },
    // meat: chewing - each bite a dull thud, and a tear of short crackling grains after it
    meat: (t) => {
      const n = 3 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const s = t + i * rnd(0.3, 0.38);
        tone(s, 0.09, 160, 85, 0.12);
        for (let g = 0; g < 6; g++) hiss(s + 0.04 + g * 0.017 + rnd(0, 0.008), 0.022, rnd(2200, 4000), 1600, 0.045, { q: 1.5, attack: 0.002 });
      }
      return n * 0.34;
    },
  },
};
Object.assign(SFX, {
  // a trial that ate: ピンポーン - a high ding and a lower dong, each ringing out like a bell
  chime: (t) => { for (const [dt, f] of [[0, 784], [0.36, 622]]) { tone(t + dt, 1.1, f, f, 0.22, { attack: 0.004 }); tone(t + dt, 0.45, 2 * f, 2 * f, 0.05, { attack: 0.003 }); tone(t + dt, 0.25, 3 * f, 3 * f, 0.02); } },
  // a trial that failed: ぶぶー - two harsh low buzzes, the second longer
  buzz: (t) => {
    for (const [dt, d] of [[0, 0.17], [0.24, 0.48]]) {
      tone(t + dt, d, 150, 146, 0.1, { type: 'square', attack: 0.01, hold: true });
      tone(t + dt, d, 152, 148, 0.08, { type: 'sawtooth', attack: 0.01, hold: true });
    }
  },
});
function playSfx(name) { const t = soundNow(); if (t != null) SFX[name](t); }
function landSound(kind, k) { const t = soundNow(); if (t != null) SFX.land[kind](t, k); }
// eating: the person is feeding and a food's amount went down since the last frame from the worker;
// a burst of that food's sound, then a pause of a second or so before the next
function listenEating(f, now) {
  const t = now / 1000;
  if (f !== sound.frame) {
    sound.frame = f;
    const amt = new Map();
    for (const w of f.scene.food) {
      const was = sound.amt.get(w.id);
      if (was != null && w.amount < was - 1e-4 && (f.prog.feed || 0) > 0.3) sound.eating = { id: w.id, at: t };
      amt.set(w.id, w.amount);
    }
    sound.amt = amt;
  }
  if (!sound.eating || t - sound.eating.at > 0.5 || t < sound.eatAt) return;
  const p = drops.find((o) => o.id === sound.eating.id), s = soundNow();
  if (!p || s == null) return;
  sound.eatAt = t + SFX.eat[p.kind](s) + rnd(0.7, 1.5);
}

// ------------------------------------------------------------------ food
// A tap on the floor drops the food chosen in the palette there, from above (./foods.js). Honey
// pours: a thread comes down, its tip falling first, runs for a while, lets go at the top and falls
// in after; where it lands - the floor, or a lump lying there - it heaps up under the thread and
// spreads slowly into a puddle. Meat and dung are dropped in the body worker's physics, which sends
// back where each lump is as it falls, tumbles and piles up; honey is sent once it has landed. The
// worker also sends how much of each food is left as it is eaten.
const G = 9.8, FALL = { pour: 1.4 };                  // (honey runs for 1.4 s)
let kind = 'honey';
// the palette shows only the chosen food; the ⋮ button opens it to choose another
const foodsBox = document.querySelector('.foods'), foodMenu = $('foodmenu');
const openFoods = (open) => { foodsBox.classList.toggle('open', open); foodMenu.setAttribute('aria-expanded', String(open)); };
foodMenu.addEventListener('click', () => openFoods(!foodsBox.classList.contains('open')));
document.querySelectorAll('[data-food]').forEach((b) => b.addEventListener('click', () => {
  if (!foodsBox.classList.contains('open')) return;
  kind = b.dataset.food;
  document.querySelectorAll('[data-food]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  openFoods(false);
}));
cv.addEventListener('pointerdown', () => openFoods(false));
const honeyMat = new THREE.MeshPhysicalMaterial({ color: 0xe0930f, emissive: 0x3d1d00, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04, transparent: true, opacity: 0.9 });
const threadGeo = new THREE.CylinderGeometry(1, 0.55, 1, 12, 1, true).translate(0, 0.5, 0);   // thinner at the bottom: it thins as it speeds up
const dropGeo = new THREE.SphereGeometry(1, 16, 12);
const domeGeo = new THREE.SphereGeometry(1, 40, 10, 0, Math.PI * 2, 0, Math.PI / 2);
const ringGeo = new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
// a lumpy blob: a sphere with its surface pushed in and out
function blob(seed, bump) {
  const g = new THREE.IcosahedronGeometry(1, 3), pos = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 5.1 + seed) * Math.sin(v.y * 4.3 + 2 * seed) * Math.sin(v.z * 4.7 + 3 * seed);
    v.multiplyScalar(1 + bump * n); pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
const LUMP_MAT = {
  meat: new THREE.MeshStandardMaterial({ color: 0x9c2b2e, roughness: 0.5, emissive: 0x1a0000 }),
  fat: new THREE.MeshStandardMaterial({ color: 0xeedccb, roughness: 0.6 }),
  dung: new THREE.MeshStandardMaterial({ color: 0x5b3b1f, roughness: 0.85 }),
};
const LUMP_GEO = Object.fromEntries(['meat', 'dung'].map((k) => [k, FOODS[k].parts.map((p) => blob(p.seed, p.bump))]));
// a lump in the worker's frame (MuJoCo, z up): the parts, laid out y-up, turned onto z
function lump(k) {
  const outer = new THREE.Group(), inner = new THREE.Group();
  inner.rotation.x = Math.PI / 2;
  FOODS[k].parts.forEach((p, i) => { const o = new THREE.Mesh(LUMP_GEO[k][i], LUMP_MAT[p.mat]); o.position.set(...p.c); o.scale.set(...p.s); inner.add(o); });
  outer.add(inner); outer.visible = false; world.add(outer);
  return outer;
}
const drops = [];
let dropId = 0;
const raycaster = new THREE.Raycaster(), floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const toThree = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
function pourAt(clientX, clientY) {
  if (!started || replay.pending || frame?.replay) return;                        // (watching a recording: taps only look)
  const rect = cv.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), camera);
  let hit = raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
  // honey is poured onto the person where the tap points at them, not onto the floor behind them
  const onSkin = kind === 'honey' && skinMesh ? castSkin(raycaster.ray) : null;
  if (onSkin) hit = new THREE.Vector3(onSkin.x, 0, onSkin.z);
  if (!hit || Math.hypot(hit.x, hit.z) > 2.1) return;
  const p = newDrop(kind, hit.x, hit.z, performance.now() / 1000);
  if (kind === 'honey') {
    // (kept in the body worker's recording, so that a replay can pour it again - see animateReplayPours)
    bodyW.postMessage({ type: 'pour', event: { kind: 'honey', x: p.x, y: -p.z, z: p.base, onBody: !!p.body, pour: FALL.pour, top: FALL_FROM } });
  } else bodyW.postMessage({ type: 'food', id: p.id, kind, x: p.x, y: -p.z });     // three (x, y, z) -> MuJoCo (x, -z, y)
  drops.push(p);
  lastLabel = FOODS[kind].label + 'を落とした'; lastNote = ''; labelAt = performance.now();
}
function newDrop(kind, x, z, t0) {
  const p = { id: ++dropId, kind, x, z, t0, falling: true, seen: false, done: false, landed: false,
    ring: new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: FOODS[kind].ring, transparent: true, depthWrite: false })),
    vol: 0, r: 0, heapH: 0, amount: 1, eye: new THREE.Vector3(x, FALL_FROM, z) };
  p.ring.visible = false; scene.add(p.ring);
  if (kind === 'honey') {
    const mesh = (geo) => { const o = new THREE.Mesh(geo, honeyMat); o.visible = false; scene.add(o); return o; };
    Object.assign(p, { thread: mesh(threadGeo), drop: mesh(dropGeo), tail: mesh(dropGeo), heap: mesh(dropGeo), puddle: mesh(domeGeo), sent: false,
      pour: 0, onBody: 0, given: 0, blobAt: -1, lookAt: 0, blobs: [], beads: [], coat: null, touched: false });
    // where it will land: the top of the person, or of whatever lump lies under the tap, or the floor
    Object.assign(p, landingUnder(x, z));
    // where its puddle is: under the stream, unless it runs off the person and reaches the floor elsewhere first
    p.px = p.x; p.pz = p.z; p.pbase = p.base;
  } else p.lump = lump(kind);
  p.parts = [p.thread, p.drop, p.tail, p.heap, p.puddle].filter(Boolean);
  return p;
}
function removeDrop(p) {
  p.parts.forEach((o) => scene.remove(o));
  for (const o of p.blobs || []) scene.remove(o.mesh);
  if (p.coat) { scene.remove(p.coat); p.coat.dispose(); }
  scene.remove(p.ring); p.ring.material.dispose();
  if (p.lump) world.remove(p.lump);
}
function nearestFood() {
  const head = bones[face.headId]; if (!head) return null;
  const hp = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  let best = null, bd = Infinity;
  for (const p of drops) if (p.landed && p.vol > 0.05) { const dd = Math.hypot(p.eye.x - hp.x, p.eye.z - hp.z); if (dd < bd) { bd = dd; best = p; } }
  return best;
}
function landRing(p, at) {
  p.ringT = p.u; p.ring.position.set(at.x, at.y + 0.002, at.z);
}
function animateHoney(p, u, dt, w) {
  const u2 = u - FALL.pour;
  const tailY = u2 > 0 ? FALL_FROM - 0.5 * G * u2 * u2 : FALL_FROM;
  // onto the person, the stream stops where it meets them, and they move: keep it on the skin under it
  if (tailY > p.base) aimHoney(p, u);
  const headY = p.base + Math.max(0, FALL_FROM - p.base - 0.5 * G * u * u);
  p.falling = headY > p.base;
  // the thread, from where its top has got to down to its tip
  const on = tailY > p.base;
  p.thread.visible = on;
  if (on) {
    const r = 0.008 * (0.8 + 0.2 * Math.sin(u * 23 + p.id));                    // a faint wobble in its thickness
    p.thread.position.set(p.x, headY, p.z); p.thread.scale.set(r, tailY - headY, r);
  }
  p.drop.visible = p.falling;
  if (p.falling) { const v = Math.min(1, u * 2); p.drop.position.set(p.x, headY + 0.004, p.z); p.drop.scale.set(0.007, 0.007 + 0.01 * v, 0.007); p.eye.set(p.x, headY, p.z); }
  p.tail.visible = u2 > 0 && on;
  if (p.tail.visible) { p.tail.position.set(p.x, tailY, p.z); p.tail.scale.set(0.005, 0.01, 0.005); }
  // landed on the floor or a lump: tell the body; from then on it sits where the worker says (on a lump,
  // it rides along). Landed on the person: it heaps where it hits and runs off them in drops, a new one
  // every 0.3 s carrying what has come down since, and the food is what of it reaches the floor
  const pouring = on && !p.falling, du = u - (p.lastU ?? u);                  // (by the clock, not the capped frame step)
  p.lastU = u;
  if (pouring && p.body) {
    if (!p.touched) { p.touched = true; if (!p.visual) landSound('honey'); }
    p.onBody += du / FALL.pour;
    if (!p.hitBead || p.hitBead.v !== p.body.v) p.beads.push(p.hitBead = { v: p.body.v, r: 0.014, t: u });
    p.hitBead.t = u;                                                            // (the coat where it hits stays fresh while it runs)
    if (u - p.blobAt > 0.3 && p.onBody - p.given > 0.04) { spawnBlob(p, p.body.v, p.onBody - p.given); p.given = p.onBody; p.blobAt = u; }
  } else if (pouring) {
    p.pour += du / FALL.pour;
    if (!p.sent) { floorHoney(p, p.x, p.z, p.base); if (!p.visual) landSound('honey'); }
  }
  if (!on && !p.ended) {
    // the stream has run out: what its last frame brought, and what has not gone off in a drop yet,
    // goes where it was falling - on the person, as one more drop
    p.ended = true;
    const rest = Math.max(0, 1 - p.pour - p.onBody);
    if (p.body) p.onBody += rest; else p.pour += rest;
    const last = p.blobs[p.blobs.length - 1];
    if (p.body && p.onBody - p.given > 0.02) spawnBlob(p, p.body.v, p.onBody - p.given);
    else if (last) last.vol += p.onBody - p.given;
    p.given = p.onBody;
  }
  animateSmear(p, u, dt);
  const poured = Math.min(1, p.pour);
  const at = w?.pos ? toThree(w.pos) : new THREE.Vector3(p.px, p.pbase, p.pz);
  if (p.landed) p.eye.copy(at);
  p.vol = Math.min(poured, p.amount);
  // it spreads slowly (honey is thick) and goes quickly when eaten; on a lump it stays smaller
  const want = FOODS.honey.r * Math.sqrt(p.vol) * (p.on ? 0.6 : 1);
  p.r += (want - p.r) * Math.min(1, dt * (want > p.r ? 2.2 : 6));
  p.puddle.visible = p.r > 0.002;
  if (p.puddle.visible) {
    const wob = poured < 1 ? 1 + 0.04 * Math.sin(u * 17) : 1;
    p.puddle.position.set(at.x, at.y + 0.0015, at.z);
    p.puddle.scale.set(p.r * wob, 0.0025 + 0.006 * Math.sqrt(p.vol), p.r / wob);
  }
  // a little heap under the thread while it runs, sinking into the puddle after
  // (on the person, a smaller one where it hits, gone as soon as the stream is)
  const heap = pouring ? 1 : 0;
  p.heapH += (heap - p.heapH) * Math.min(1, dt * (heap ? 5 : p.body ? 8 : 1.5));
  p.heap.visible = p.heapH > 0.02;
  if (p.heap.visible && p.body) { p.heap.position.set(p.x, p.base, p.z); p.heap.scale.set(0.011 * p.heapH, 0.007 * p.heapH, 0.011 * p.heapH); }
  else if (p.heap.visible) { p.heap.position.set(at.x, at.y, at.z); p.heap.scale.set(0.014 * p.heapH, 0.012 * p.heapH, 0.014 * p.heapH); }
  return on || p.r > 0.003 || p.blobs.length > 0 || p.beads.length > 0;
}
// honey reaches the floor (or a lump) for the first time: its puddle is there, and the body is told
function floorHoney(p, x, z, y) {
  p.sent = true; p.landed = true; p.px = x; p.pz = z; p.pbase = y;
  landRing(p, new THREE.Vector3(x, y, z));
  if (!p.visual) bodyW.postMessage({ type: 'food', id: p.id, kind: 'honey', x, y: -z, z: y, on: p.on && p.on.seen ? p.on.id : null });   // three (x, y, z) -> MuJoCo (x, -z, y)
}
function animateLump(p, dt, w) {
  if (w) {
    // where the physics has it (a lump appears once the worker has it in the air)
    p.lump.visible = true;
    p.lump.position.set(...w.pos);
    p.lump.quaternion.set(w.quat[1], w.quat[2], w.quat[3], w.quat[0]);
    const at = toThree(w.pos);
    if (p.last) {
      const vy = (at.y - p.last.y) / Math.max(dt, 1e-3);
      if (!p.landed && at.y < 0.6 && vy > -0.5) { p.landed = true; landRing(p, new THREE.Vector3(at.x, 0, at.z)); landSound(p.kind); }
    }
    p.last = at; p.eye.copy(at); p.falling = !p.landed;
  }
  p.r += (Math.sqrt(p.amount) - p.r) * Math.min(1, dt * (Math.sqrt(p.amount) > p.r ? 30 : 6));
  p.vol = p.amount;
  p.lump.scale.setScalar(2 * FOODS[p.kind].r * p.r);
  if (p.seen && !w) p.lump.visible = p.r > 0.03;
  return p.lump.visible;
}
function animateFood(t, dt, food) {
  const byId = new Map(food.map((f) => [f.id, f]));
  for (const p of drops) {
    p.u = t - p.t0;
    const w = byId.get(p.id);
    if (w) { p.seen = true; p.amount = w.amount; } else if (p.seen) p.amount = 0;
    const alive = p.kind === 'honey' ? animateHoney(p, p.u, dt, w) : animateLump(p, dt, w);
    // a ring where it lands
    const ru = p.ringT == null ? -1 : p.u - p.ringT;
    p.ring.visible = ru >= 0 && ru < 0.6;
    if (p.ring.visible) { const k = ru / 0.6; p.ring.scale.setScalar(0.02 + (p.kind === 'honey' ? 0.12 : 0.2) * Math.sqrt(k)); p.ring.material.opacity = 0.55 * (1 - k); }
    // (honey that never reached the floor - all of it left on the person - is done when it has gone from them)
    p.done = !alive && (p.seen ? p.amount <= 0 : p.kind === 'honey' && !p.sent && p.u > 1);
  }
  for (let i = drops.length - 1; i >= 0; i--) if (drops[i].done) {
    removeDrop(drops[i]);
    drops.splice(i, 1);
  }
}

// ------------------------------------------------------------------ honey on the person
// The skin is deformed on the GPU. To know where a stream of honey meets the person, and to run it
// down over them, the same skinning (bones and flesh morphs) is redone here on the CPU: for the whole
// skin when the stream needs aiming, otherwise only for the few vertices that honey is on. A drop runs
// from vertex to vertex along the mesh's edges, each time to the lowest neighbour it has not been on
// yet - so it follows the skin as the person moves, fills a hollow and spills over - slowly where the
// skin is flat and faster where it is steep, leaving a thin coat behind. Where the skin faces down
// (under the belly, an arm, the chin) it hangs, stretches and lets go; where it runs down to the floor
// (a hand, a knee) it is there already.
const skinCPU = { M: [], mAt: -1, all: null, allAt: -1, adj: null };
let frameNo = 0;
const coatMat = new THREE.MeshPhysicalMaterial({ color: 0xe0930f, emissive: 0x2a1400, roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.75, depthWrite: false });
const sA = new THREE.Vector3(), sB = new THREE.Vector3(), sC = new THREE.Vector3(), nA = new THREE.Vector3(), nB = new THREE.Vector3(), nC = new THREE.Vector3();
const sM = new THREE.Matrix4(), sQ = new THREE.Quaternion(), sS = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
// each bone's skinning matrix this frame, from rest-pose mesh coordinates straight to the scene's
function boneMats() {
  if (skinCPU.mAt === frameNo) return skinCPU.M;
  const sk = skinMesh.skeleton;
  for (let b = 0; b < sk.bones.length; b++) (skinCPU.M[b] ||= new THREE.Matrix4()).multiplyMatrices(sk.bones[b].matrixWorld, sk.boneInverses[b]).multiply(skinMesh.bindMatrix);
  skinCPU.mAt = frameNo;
  return skinCPU.M;
}
// vertex i where it is drawn now, and (if asked) the way its skin faces
function skinVertex(i, out, nrm) {
  const g = skinMesh.geometry, P = g.attributes.position.array, N = g.attributes.normal.array;
  const SI = g.attributes.skinIndex.array, SW = g.attributes.skinWeight.array, morph = g.morphAttributes.position, inf = skinMesh.morphTargetInfluences;
  const M = boneMats(), i3 = 3 * i;
  let x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
  for (let k = 0; k < morph.length; k++) if (inf[k]) { const a = morph[k].array; x += inf[k] * a[i3]; y += inf[k] * a[i3 + 1]; z += inf[k] * a[i3 + 2]; }
  let ox = 0, oy = 0, oz = 0, nx = 0, ny = 0, nz = 0;
  for (let j = 0; j < 4; j++) {
    const w = SW[4 * i + j]; if (!w) continue;
    const e = M[SI[4 * i + j]].elements;
    ox += w * (e[0] * x + e[4] * y + e[8] * z + e[12]); oy += w * (e[1] * x + e[5] * y + e[9] * z + e[13]); oz += w * (e[2] * x + e[6] * y + e[10] * z + e[14]);
    if (nrm) { nx += w * (e[0] * N[i3] + e[4] * N[i3 + 1] + e[8] * N[i3 + 2]); ny += w * (e[1] * N[i3] + e[5] * N[i3 + 1] + e[9] * N[i3 + 2]); nz += w * (e[2] * N[i3] + e[6] * N[i3 + 1] + e[10] * N[i3 + 2]); }
  }
  out.set(ox, oy, oz);
  if (nrm) nrm.set(nx, ny, nz).normalize();
  return out;
}
function skinAll() {
  if (skinCPU.allAt === frameNo) return skinCPU.all;
  const n = skinMesh.geometry.attributes.position.count, X = skinCPU.all ||= new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { skinVertex(i, sA); X[3 * i] = sA.x; X[3 * i + 1] = sA.y; X[3 * i + 2] = sA.z; }
  skinCPU.allAt = frameNo;
  return X;
}
// the vertices joined to each by an edge
function skinNeighbours() {
  if (skinCPU.adj) return skinCPU.adj;
  const I = skinMesh.geometry.index.array, sets = Array.from({ length: skinMesh.geometry.attributes.position.count }, () => new Set());
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) { const a = I[t + k], b = I[t + (k + 1) % 3]; sets[a].add(b); sets[b].add(a); }
  return (skinCPU.adj = sets.map((s) => Uint16Array.from(s)));
}
// where a ray (the tap) first meets the skin, or null
function castSkin(ray) {
  const X = skinAll(), I = skinMesh.geometry.index.array, o = ray.origin, d = ray.direction;
  let best = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const e1x = X[b] - X[a], e1y = X[b + 1] - X[a + 1], e1z = X[b + 2] - X[a + 2], e2x = X[c] - X[a], e2y = X[c + 1] - X[a + 1], e2z = X[c + 2] - X[a + 2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x, det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const tx = o.x - X[a], ty = o.y - X[a + 1], tz = o.z - X[a + 2], u = (tx * px + ty * py + tz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d.x * qx + d.y * qy + d.z * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (dist > 0 && dist < best) best = dist;
  }
  return best < Infinity ? ray.at(best, new THREE.Vector3()) : null;
}
// straight down at (x, z) from below yTop: the first skin facing up, as {y, v: its nearest vertex,
// dy: how far above that vertex}, or null
function castDown(x, z, yTop) {
  const X = skinAll(), I = skinMesh.geometry.index.array;
  let best = null;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ax = X[a], az = X[a + 2], bx = X[b], bz = X[b + 2], cx = X[c], cz = X[c + 2];
    if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx) || (z < az && z < bz && z < cz) || (z > az && z > bz && z > cz)) continue;
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (det >= -1e-12) continue;                               // edge-on, or facing down (the skin's triangles wind outward)
    const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det, w = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det;
    if (u < 0 || w < 0 || u + w > 1) continue;
    const y = X[a + 1] + u * (X[b + 1] - X[a + 1]) + w * (X[c + 1] - X[a + 1]);
    if (y >= yTop || (best && y <= best.y)) continue;
    const k = 1 - u - w >= Math.max(u, w) ? a : u >= w ? b : c;
    best = { y, v: k / 3, dy: y - X[k + 1] };
  }
  return best;
}
// what a pour at (x, z) lands on first: the person, a lump, or the floor
function landingUnder(x, z) {
  raycaster.set(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, -1, 0));
  const under = raycaster.intersectObjects(drops.filter((o) => o.lump && o.lump.visible).map((o) => o.lump), true)[0];
  const skin = skinMesh ? castDown(x, z, FALL_FROM) : null;
  if (skin && (!under || skin.y > under.point.y)) return { base: skin.y, on: null, body: skin };
  return { base: under ? under.point.y : 0, on: under ? drops.find((o) => o.lump && under.object.parent.parent === o.lump) : null, body: null };
}
// while the stream is in the air: follow the skin it falls on, and look again (at most four times a
// second) once that has slid out from under it - or, if it falls past the person, whether they have come under it
function aimHoney(p, u) {
  if (p.body) {
    skinVertex(p.body.v, sA);
    p.base = sA.y + p.body.dy;
    if (Math.hypot(sA.x - p.x, sA.z - p.z) < 0.025 || u - p.lookAt < 0.25) return;
  } else if (!skinMesh || u - p.lookAt < 0.25) return;
  p.lookAt = u;
  const skin = castDown(p.x, p.z, FALL_FROM);
  if (skin && (p.body || skin.y > p.base)) { p.body = skin; p.base = skin.y; return; }
  if (p.body) { const l = landingUnder(p.x, p.z); p.body = null; p.base = l.base; if (!p.sent) p.on = l.on; }
}
function spawnBlob(p, v, vol) {
  const mesh = new THREE.Mesh(dropGeo, honeyMat);
  mesh.visible = false; scene.add(mesh);
  p.blobs.push({ mesh, a: v, b: v, s: 1, vol, state: 'run', steps: 0, seen: new Set(), hang: 0, lands: 0, x: 0, y: 0, z: 0, vy: 0, to: null,
    dir: new THREE.Vector3(0, -1, 0), bead: new THREE.Vector3(0, -9, 0) });
}
function animateSmear(p, u, dt) {
  if (!skinMesh || (!p.blobs.length && !p.beads.length)) return;
  const adj = skinNeighbours();
  for (let i = p.blobs.length - 1; i >= 0; i--) {
    const o = p.blobs[i], r = 0.005 + 0.004 * Math.sqrt(Math.min(1, o.vol / 0.25));
    o.mesh.visible = true;
    if (o.state === 'run') {
      skinVertex(o.a, sA, nA); skinVertex(o.b, sB, nB);
      const L = sA.distanceTo(sB);
      if (L > 1e-5) o.s += dt * 0.08 * (0.25 + Math.max(0, (sA.y - sB.y) / L)) / L;    // 2 cm/s on the flat, 10 straight down
      if (o.s >= 1) {
        // at the next vertex: leave some coat, and see where to go on
        o.a = o.b; o.s = 0; sA.copy(sB); nA.copy(nB); o.seen.add(o.a); o.steps++;
        if (sA.distanceTo(o.bead) > 0.006 && p.beads.length < 90) { p.beads.push({ v: o.a, r: r * 0.9, t: u }); o.bead.copy(sA); }
        if (sA.y < 0.02) { blobToFloor(p, i, sA.x, sA.z); continue; }
        if (nA.y < -0.35) { o.state = 'hang'; o.hang = 0; }
        else {
          let best = -1, by = Infinity;
          for (const n of adj[o.a]) if (!o.seen.has(n)) { skinVertex(n, sC); if (sC.y < by) { by = sC.y; best = n; } }
          if (best >= 0 && o.steps < 400) { o.b = best; skinVertex(best, sB, nB); }
          else if (nA.y < 0.3) { o.state = 'hang'; o.hang = 0; }                  // nowhere new on a steep side: drip from it
          else { blobGone(p, i); continue; }                                        // stuck on top: it stays as coat
        }
      }
      const s = Math.min(1, o.s);
      sC.lerpVectors(sA, sB, s); nC.lerpVectors(nA, nB, s).normalize();
      if (o.b !== o.a) o.dir.lerp(sS.subVectors(sB, sA).normalize(), 0.25);
      // stretched along the way it runs and flattened against the skin
      const along = o.dir.sub(sS.copy(nC).multiplyScalar(o.dir.dot(nC))).normalize();
      if (along.lengthSq() < 0.5) along.set(0, -1, 0).addScaledVector(nC, nC.y).normalize();          // (downhill, then)
      if (along.lengthSq() < 0.5) along.set(1, 0, 0).addScaledVector(nC, -nC.x).normalize();          // (level skin: any way)
      sM.makeBasis(sS.crossVectors(along, nC).normalize(), along, nC);
      o.mesh.quaternion.setFromRotationMatrix(sM);
      o.mesh.position.copy(sC).addScaledVector(nC, r * 0.35);
      o.mesh.scale.set(r, r * 1.8, r * 0.6);
    } else if (o.state === 'hang') {
      // hanging under the skin: a drop gathers and stretches, then lets go
      skinVertex(o.a, sA, nA);
      o.hang += dt;
      const k = Math.min(1, o.hang / 0.7), len = r * (1 + 2.2 * k * k);
      o.mesh.quaternion.identity();
      o.mesh.position.set(sA.x, sA.y + nA.y * r * 0.3 - len * 0.8, sA.z);
      o.mesh.scale.set(r * (1 - 0.2 * k), len, r * (1 - 0.2 * k));
      if (k >= 1) {
        Object.assign(o, { state: 'fall', x: sA.x, y: sA.y - len * 1.6, z: sA.z, vy: 0 });
        o.to = o.lands < 3 ? castDown(o.x, o.z, o.y) : null;                      // onto more of the person, or the floor
      }
    } else {
      o.vy += G * dt; o.y -= o.vy * dt;
      const ground = o.to ? skinVertex(o.to.v, sA).y + o.to.dy : 0;
      if (o.y <= ground) {
        if (!o.to) { blobToFloor(p, i, o.x, o.z); continue; }
        Object.assign(o, { state: 'run', a: o.to.v, b: o.to.v, s: 1, steps: 0, lands: o.lands + 1 });
        o.seen.clear();
        continue;
      }
      o.mesh.quaternion.identity();
      o.mesh.position.set(o.x, o.y, o.z);
      o.mesh.scale.set(r * 0.75, r * (1.3 + Math.min(1, o.vy * 0.4)), r * 0.75);
    }
  }
  // the coat: a lens of honey on the skin at each place a drop went by, shrinking away after 3 s
  if (!p.coat) { p.coat = new THREE.InstancedMesh(dropGeo, coatMat, 90); p.coat.frustumCulled = false; p.coat.renderOrder = 3; scene.add(p.coat); }
  p.coat.visible = true;                                                         // (hidden while a recording played)
  p.beads = p.beads.filter((b) => u - b.t < 6);
  let n = 0;
  for (const b of p.beads) {
    if (n === 90) break;
    const k = 1 - Math.max(0, (u - b.t - 3) / 3);
    skinVertex(b.v, sA, nA);
    sQ.setFromUnitVectors(UP, nA);
    sM.compose(sA.addScaledVector(nA, 0.0008), sQ, sS.set(b.r * k, 0.0014 * k + 0.0004, b.r * k));
    p.coat.setMatrixAt(n++, sM);
  }
  p.coat.count = n;
  p.coat.instanceMatrix.needsUpdate = true;
}
function blobGone(p, i) { scene.remove(p.blobs[i].mesh); p.blobs.splice(i, 1); }
// a drop reaches the floor: the honey's puddle is where the first one did, and every one adds to it
function blobToFloor(p, i, x, z) {
  const o = p.blobs[i];
  if (p.visual) { if (!p.sent) floorHoney(p, x, z, 0); }
  else if (!p.sent) { floorHoney(p, x, z, 0); landSound('honey', 0.8); }
  else if (performance.now() - sound.dripAt > 150) { sound.dripAt = performance.now(); landSound('honey', 0.45); }
  p.pour += o.vol;
  blobGone(p, i);
}

// ------------------------------------------------------------------ watching a trial again
// A trial's motion (every joint position, the food and a little of the brain, 10 times a second) is
// kept by the school; the body worker plays it on the body in place of the live one, which waits,
// paused, and carries on exactly where it was when the page goes back to live. The list of trials is
// on 記録; picking one switches to 実験, where a bar under the scene plays, pauses, seeks and changes
// the speed. Food cannot be dropped meanwhile, and nothing is learned or rung.
const OUTCOME = { ate: '食べた', 'ate-fell': '食べた後に転倒', 'reached-fell': '着いてから転倒', fell: '転倒', out: '場外', timeout: '時間切れ', finished: '食べた' };
const FOOD_ICON = { honey: '🍯', meat: '🥩', dung: '💩' };
const replay = { pending: null, item: null, seekAt: 0, leftAt: -1e9, lastT: 0 };
const replayFood = new Map();
async function startReplay(item) {
  setTab('play');
  replay.pending = item; replay.item = item;
  setCaseUrl(item.trial);
  loadNeighbours(item.trial);
  clearReplayPours();
  stage.classList.add('replaying');
  $('replaybar').hidden = false;
  $('rbtitle').textContent = `読み込み中：ケース${replayTitle(item)}`;
  try {
    const r = await fetch(new URL(`../school/state/motion/${encodeURIComponent(item.trial)}.bin.gz`, import.meta.url));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    if (replay.pending !== item) return;                                         // (given up, or another picked, meanwhile)
    bodyW.postMessage({ type: 'replay', motion: buf }, [buf]);
  } catch (err) {
    console.warn('replay:', err.message);
    if (replay.pending === item) { endReplay(false); showToast('この記録は読み込めませんでした'); }
  }
}
function endReplay(tellBody) {
  if (tellBody) { bodyW.postMessage({ type: 'live' }); replay.leftAt = performance.now(); clearAll(); }
  setCaseUrl(null);
  replay.pending = null; replay.item = null;
  stage.classList.remove('replaying');
  $('replaybar').hidden = true;
}
const replayTitle = (it) => `＃${it.trial} ${it.who === 'practice' ? '自主練' : 'みんな'} ${FOODS[it.food]?.label || it.food || ''} ${OUTCOME[it.outcome] || it.outcome || ''}`;
// the bar, from what the frames say about the recording
function showReplay(f) {
  const R = f?.replay;
  if (!R) { if (!replay.pending && !$('replaybar').hidden) endReplay(false); return; }
  if (!replay.pending && !replay.item && performance.now() - replay.leftAt < 1000) return;   // (frames still on their way from before ライブに戻る)
  if (replay.pending) replay.pending = null;
  if (!replay.item) { stage.classList.add('replaying'); $('replaybar').hidden = false; }
  $('rbtitle').textContent = `ケース${replay.item ? replayTitle(replay.item) : ''}`;
  const seek = $('rbseek');
  seek.max = String(R.duration);
  if (performance.now() - replay.seekAt > 400) seek.value = String(R.t);           // (not while it is being dragged)
  $('rbtime').textContent = `${R.t.toFixed(1)} / ${R.duration.toFixed(1)} 秒`;
  const play = $('rbplay');
  play.textContent = R.playing ? '❚❚' : '▶'; play.setAttribute('aria-label', R.playing ? '一時停止' : '再生');
  document.querySelectorAll('.rbspeed [data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.speed === R.speed)));
  $('school').textContent = '脳：再生中'; $('school').hidden = false;
}
$('rbplay').addEventListener('click', () => { if (frame?.replay) bodyW.postMessage({ type: 'replayControl', playing: !frame.replay.playing }); });
$('rbseek').addEventListener('input', (e) => { replay.seekAt = performance.now(); bodyW.postMessage({ type: 'replayControl', seek: +e.target.value }); });
document.querySelectorAll('.rbspeed [data-speed]').forEach((b) => b.addEventListener('click', () => bodyW.postMessage({ type: 'replayControl', speed: +b.dataset.speed })));
$('rblive').addEventListener('click', () => { endReplay(true); showSchool(); labelAt = -1e9; });
// A case (a recorded trial) has its own address, ?case=N, to share: opening it plays that case. 前/次
// go to the nearest watchable case before or after it.
function setCaseUrl(n) {
  const u = new URL(location.href);
  if (n == null) u.searchParams.delete('case'); else u.searchParams.set('case', n);
  history.replaceState(null, '', u);
}
async function loadNeighbours(n) {
  replay.near = { n, prev: null, next: null };
  $('rbprev').disabled = $('rbnext').disabled = true;
  try {
    const r = await fetch(new URL(`../api/trials?near=${encodeURIComponent(n)}`, import.meta.url), { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (replay.near?.n !== n || !j) return;
    Object.assign(replay.near, { prev: j.prev, next: j.next, item: j.item });
    $('rbprev').disabled = !j.prev; $('rbnext').disabled = !j.next;
  } catch { /* the buttons stay off */ }
}
$('rbprev').addEventListener('click', () => { const it = replay.near?.prev; if (it) startReplay(it); });
$('rbnext').addEventListener('click', () => { const it = replay.near?.next; if (it) startReplay(it); });
$('rbshare').addEventListener('click', async () => {
  const n = replay.item?.trial; if (n == null) return;
  const u = new URL(location.pathname, location.origin); u.searchParams.set('case', n);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: `人体を制御するハエ脳実験 ケース＃${n}`, url: u.href });
    else { await navigator.clipboard.writeText(u.href); showToast(`ケース＃${n} のリンクをコピーしました`); }
  } catch { showToast(u.href); }
});
// (opened with ?case=N: that case plays once everything has loaded)
const sharedCase = new URL(location.href).searchParams.get('case');
async function openSharedCase() {
  if (sharedCase == null || !/^\d+$/.test(sharedCase)) return;
  try {
    const r = await fetch(new URL(`../api/trials?near=${sharedCase}`, import.meta.url), { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (j?.item?.motion) startReplay(j.item);
    else { showToast(`ケース＃${sharedCase} は再生できません`); setCaseUrl(null); }
  } catch { showToast(`ケース＃${sharedCase} を読み込めませんでした`); }
}
// Honey poured in a recording: the body worker passes each pour event as the replay reaches it (with
// how long before the recording it began); the pour is played on the recording's clock - so it
// pauses, changes speed and seeks with it - thread, heap and drips over the replayed body, as visuals
// only. Its puddle comes with the recorded food. A recording from before pours were kept has no such
// events: there, each honey's pour is made up from when its puddle first appears - a pour whose tip
// reaches the floor just then, of the usual length.
const replayPours = { events: new Map(), shown: new Map(), honey: new Map() };
function noteReplayFrame(m) {
  const R = m.replay;
  if (R.events?.length) notePours(R.events);
  for (const w of m.scene.food || []) {
    if (w.kind !== 'honey' || replayPours.honey.has(w.id) || !Array.isArray(w.pos)) continue;
    replayPours.honey.set(w.id, R.t);
    const poured = [...replayPours.events.values()].some((e) => !e.made && R.t - e.t0 > -1 && R.t - e.t0 < 12);
    if (poured) continue;                                                        // (the recording has the pour itself)
    const fall = Math.sqrt(2 * Math.max(0, FALL_FROM - (w.pos[2] || 0)) / G);
    replayPours.events.set(`made|${w.id}`, { x: w.pos[0], y: w.pos[1], t0: R.t - fall, endU: Infinity, made: true });
  }
}
function notePours(events) {
  for (const e of events) {
    if (e.type !== 'pour' || !isNum(e.x) || !isNum(e.y) || !isNum(e.t)) continue;
    const key = `${e.t}|${e.x}|${e.y}`;
    if (!replayPours.events.has(key)) replayPours.events.set(key, { x: e.x, y: e.y, t0: e.t - (e.early || 0), endU: Infinity });
  }
}
function animateReplayPours(f) {
  const R = f.replay;
  const back = R.t < replay.lastT - 1e-3, dt = back ? 0 : Math.min(0.1, Math.max(0, R.t - replay.lastT));
  replay.lastT = R.t;
  for (const [key, e] of replayPours.events) {
    const u = R.t - e.t0;
    let p = replayPours.shown.get(key);
    if (p && (back || u < 0)) { removeDrop(p); replayPours.shown.delete(key); p = null; }     // (seeking back: from there again)
    if (!p && u >= 0 && u < e.endU) { p = newDrop('honey', e.x, -e.y, e.t0); p.visual = true; replayPours.shown.set(key, p); }
    if (!p) continue;
    p.u = u;
    animateHoney(p, u, dt, null);
    p.puddle.visible = false; p.ring.visible = false;
    if (u > 1 && !p.thread.visible && !p.heap.visible && !p.blobs.length && !p.beads.length) { e.endU = u; removeDrop(p); replayPours.shown.delete(key); }
  }
}
function clearReplayPours() {
  for (const p of replayPours.shown.values()) removeDrop(p);
  replayPours.shown.clear(); replayPours.events.clear(); replayPours.honey.clear();
  replay.lastT = 0;
}
// the live food, out of sight while a recording plays (animateFood shows it again)
function hideDrops() {
  for (const p of drops) {
    p.parts.forEach((o) => { o.visible = false; });
    p.ring.visible = false;
    if (p.lump) p.lump.visible = false;
    for (const o of p.blobs || []) o.mesh.visible = false;
    if (p.coat) p.coat.visible = false;
  }
}
// the recording's food: lumps where it has them, honey as a puddle sized by what is left
function animateReplayFood(food) {
  const seen = new Set();
  for (const w of food) {
    if (!FOODS[w.kind]) continue;
    seen.add(w.id);
    let o = replayFood.get(w.id);
    if (!o) {
      o = w.kind === 'honey' ? new THREE.Mesh(domeGeo, honeyMat) : lump(w.kind);
      if (w.kind === 'honey') scene.add(o);
      replayFood.set(w.id, o);
    }
    o.visible = w.amount > 0.02;
    if (w.kind === 'honey') {
      const at = toThree(w.pos), r = FOODS.honey.r * Math.sqrt(w.amount);
      o.position.set(at.x, at.y + 0.0015, at.z); o.scale.set(r, 0.0025 + 0.006 * Math.sqrt(w.amount), r);
    } else {
      o.position.set(...w.pos);
      if (w.quat) o.quaternion.set(w.quat[1], w.quat[2], w.quat[3], w.quat[0]);
      o.scale.setScalar(2 * FOODS[w.kind].r * Math.sqrt(Math.max(0.05, w.amount)));
    }
  }
  for (const [id, o] of replayFood) if (!seen.has(id)) { o.parent?.remove(o); replayFood.delete(id); }
}
// 記録: the latest trials, newest first, a page at a time
const trialList = { items: [], pages: 0, busy: false, end: false, status: null };
async function loadTrials(fresh) {
  if (trialList.busy) return;
  trialList.busy = true;
  try {
    const before = !fresh && trialList.items.length ? `&before=${trialList.items[trialList.items.length - 1].trial}` : '';
    const r = await fetch(new URL(`../api/trials?limit=30${before}`, import.meta.url), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), items = Array.isArray(j?.items) ? j.items.filter((x) => x && x.trial != null) : [];
    if (fresh) { trialList.items = items; trialList.pages = 1; } else { trialList.items.push(...items); trialList.pages++; }
    trialList.end = items.length < 30;
  } catch (err) {
    console.warn('trials:', err.message);
    if (fresh) { trialList.items = []; trialList.pages = 0; trialList.end = true; }
  } finally { trialList.busy = false; }
  renderTrials();
}
function renderTrials() {
  const ul = $('trials');
  if (!ul) return;
  const decisions = trialList.status?.decisions || {};
  const nameOf = (d, id) => (Array.isArray(decisions[d]?.options) && decisions[d].options.find((o) => o && o.id === id)?.name) || id;
  if (!trialList.items.length) ul.innerHTML = '<li class="note">まだ記録がありません</li>';
  else ul.innerHTML = trialList.items.map((it) => {
    const at = new Date(it.at), when = Number.isNaN(at.getTime()) ? '' : at.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const ok = it.outcome === 'ate' || it.outcome === 'finished';
    const ways = ['approach', 'feeding'].map((d) => it.choices?.[d] && `${DECISION[d]}：${nameOf(d, it.choices[d])}`).filter(Boolean).join('・');
    const inner = `<span class="tn">＃${esc(it.trial)} ${esc(when)}</span><span class="tw${it.who === 'practice' ? '' : ' v'}">${it.who === 'practice' ? '自主練' : 'みんな'}</span>`
      + `<span class="to ${ok ? 'ok' : 'ng'}">${FOOD_ICON[it.food] || ''} ${esc(OUTCOME[it.outcome] || it.outcome || '')}</span>`
      + `<span class="tp">${isNum(it.t) ? `${it.t.toFixed(1)}秒` : ''}${it.motion ? ' ▶' : ''}</span>`
      + (ways ? `<span class="td">${esc(ways)}</span>` : '');
    return it.motion ? `<li><button class="trow" data-trial="${esc(it.trial)}" aria-label="＃${esc(it.trial)} を再生">${inner}</button></li>` : `<li><div class="trow">${inner}</div></li>`;
  }).join('');
  $('moretrials').hidden = trialList.end || !trialList.items.length;
}
$('trials').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-trial]');
  const it = b && trialList.items.find((x) => String(x.trial) === b.dataset.trial);
  if (it && started) startReplay(it);
});
$('moretrials').addEventListener('click', () => loadTrials(false));

function resize() { const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(stage); resize();

// ------------------------------------------------------------------ panels
const meter = (host, key, label, max, color) => {
  const r = document.createElement('div'); r.className = 'meter';
  r.innerHTML = `<span class="n">${label}</span><i style="--c:${color}"></i><span class="v">–</span>`;
  host.append(r); return { key, max, bar: r.querySelector('i'), v: r.querySelector('.v') };
};
const inMeters = [
  ['sugar', '<b>甘味</b> 唇・手', 200, 'var(--good)'], ['water', '<b>水</b> 唇・手', 200, 'var(--eye)'],
  ['salt', '<b>低塩</b> 唇・手', 200, 'var(--warm)'], ['bitter', '<b>苦味</b> 唇・手', 200, '#b58cff'],
  ['eyeL', '<b>目</b> 景色の動き', 60, 'var(--eye)'], ['windL', '<b>触角</b> 風・傾き 左', 50, 'var(--eye)'], ['windR', '<b>触角</b> 風・傾き 右', 50, 'var(--eye)'],
  ['ocelli', '<b>単眼</b> 空の揺れ', 50, 'var(--eye)'], ['smallL', '<b>LC11</b> 動く物 左', 20, 'var(--eye)'], ['smallR', '<b>LC11</b> 動く物 右', 20, 'var(--eye)'],
  ['loomL', '<b>LC4</b> 迫る物 左', 150, 'var(--hot)'], ['loomR', '<b>LC4</b> 迫る物 右', 150, 'var(--hot)'],
].map((a) => meter($('inputs'), ...a));
const outMeters = [
  ['MN9', '<b>MN9</b> 摂食', 150, 'var(--good)'], ['groomL', '<b>DNg84/35</b> 左', 300, 'var(--warm)'], ['groomR', '<b>DNg84/35</b> 右', 300, 'var(--warm)'],
  ['GFL', '<b>DNp01</b> 逃避 左', 300, 'var(--hot)'], ['GFR', '<b>DNp01</b> 逃避 右', 300, 'var(--hot)'],
  ['MDN', '<b>MDN</b> 後退', 150, 'var(--eye)'], ['DNa02L', '<b>DNa02</b> 左旋回', 150, 'var(--eye)'], ['DNa02R', '<b>DNa02</b> 右旋回', 150, 'var(--eye)'],
].map((a) => meter($('outputs'), ...a));
const progs = [['walk', '這う', 'var(--eye)'], ['back', '後ずさり', 'var(--eye)'], ['probe', '床をさぐる', 'var(--faint)'], ['rub', '手をすり合わせる', 'var(--faint)'], ['feed', '摂食', 'var(--good)'],
  ['groomL', '身づくろい 左手', 'var(--warm)'], ['groomR', '身づくろい 右手', 'var(--warm)'], ['escape', '逃避ジャンプ', 'var(--hot)']]
  .map(([k, l, c]) => { const s = document.createElement('span'); s.className = 'prog'; s.style.setProperty('--c', c); s.textContent = l; $('progs').append(s); return { k, s, word: l.split(' ')[0] }; });

// the fly's brain: every neuron at its FlyWire position in grey, the ones that just fired lit -
// sensory blue, central pale, descending/motor orange. The one picture is shown twice: at a glance
// at the top right, and as the brain inside the person's glass head (face.brainTex)
const bm = $('brainmap'), bg = bm.getContext('2d');
{
  const dpr = Math.min(2, devicePixelRatio || 1);
  bm.width = Math.round(176 * dpr); bm.height = Math.round(176 / 2.08 * dpr);
}
let brainPos = null, bmBack = null, bmX = null, bmY = null;
const glow = [];
(async () => {
  const r = await fetch(new URL('../../flybrain/data/pos783.bin.gz', import.meta.url));
  const raw = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const n = new DataView(raw.buffer).getUint32(4, true);
  brainPos = { n, x: new Uint16Array(raw.buffer.slice(8, 8 + 2 * n)), y: new Uint16Array(raw.buffer.slice(8 + 2 * n, 8 + 4 * n)), c: raw.slice(8 + 4 * n, 8 + 5 * n) };
  const W = bm.width, H = bm.height, pad = 2 * W / 176;
  bmX = new Float32Array(n); bmY = new Float32Array(n);
  for (let i = 0; i < n; i++) { bmX[i] = pad + brainPos.x[i] / 65535 * (W - 2 * pad); bmY[i] = pad + brainPos.y[i] / 65535 * (H - 2 * pad); }
  bmBack = document.createElement('canvas'); bmBack.width = W; bmBack.height = H;
  const b = bmBack.getContext('2d'), img = b.createImageData(W, H);
  for (let i = 0; i < n; i++) {
    if (brainPos.c[i] === 255) continue;
    const o = ((bmY[i] | 0) * W + (bmX[i] | 0)) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 150; img.data[o + 3] = Math.min(255, img.data[o + 3] + 10);
  }
  b.putImageData(img, 0, 0);
})().catch(() => {});
function onFired(m) {
  const now = performance.now();
  for (let k = 0; k < m.fired.length; k++) glow.push(now, m.fired[k]);
  if (glow.length > 16000) glow.splice(0, glow.length - 16000);
}
const GLOW_MS = 350, GLOW_COL = ['#59b7ff', '#d6e2ee', '#ffb454'];
function drawBrain(now) {
  if (!bmBack) return;
  let cut = 0;
  while (cut < glow.length && now - glow[cut] > GLOW_MS) cut += 2;
  if (cut) glow.splice(0, cut);
  bg.clearRect(0, 0, bm.width, bm.height); bg.drawImage(bmBack, 0, 0);
  const s = Math.max(1.5, bm.width / 120);
  for (let pass = 0; pass < 3; pass++) {
    bg.fillStyle = GLOW_COL[pass];
    const z = pass === 2 ? s * 1.8 : s;
    for (let k = 0; k < glow.length; k += 2) {
      const i = glow[k + 1], c = brainPos.c[i], grp = c === 0 ? 0 : (c === 6 || c === 7) ? 2 : 1;
      if (grp !== pass) continue;
      bg.globalAlpha = 1 - (now - glow[k]) / GLOW_MS;
      bg.fillRect(bmX[i] - z / 2, bmY[i] - z / 2, z, z);
    }
  }
  bg.globalAlpha = 1;
  if (face.brainTex) face.brainTex.needsUpdate = true;
}

// ------------------------------------------------------------------ draw
const v3 = new THREE.Vector3(), q4 = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
let panelAt = 0;
function draw(now) {
  const f = frame;
  if (f && bones.length) {
    for (let b = 0; b < bones.length; b++) {
      v3.set(f.xpos[3 * b], f.xpos[3 * b + 1], f.xpos[3 * b + 2]);
      q4.set(f.xquat[4 * b + 1], f.xquat[4 * b + 2], f.xquat[4 * b + 3], f.xquat[4 * b]);
      bones[b].matrix.compose(v3, q4, one);
    }
    // hip flexion per side: the thigh's rotation relative to the pelvis, since rest
    if (skinMesh) {
      const qOf = (i, src) => new THREE.Quaternion(src[4 * i + 1], src[4 * i + 2], src[4 * i + 3], src[4 * i]);
      const r = (i) => new THREE.Quaternion(restQuat[i][1], restQuat[i][2], restQuat[i][3], restQuat[i][0]);
      const since = (i) => qOf(i, f.xquat).multiply(r(i).invert());
      const pel = since(hipIds.pelvis).invert();
      const tor = since(hipIds.torso).invert();
      const bend = (inv, i) => { const rel = inv.clone().multiply(since(i)); return 2 * Math.acos(Math.min(1, Math.abs(rel.w))); };
      ['L', 'R'].forEach((S, k) => {
        skinMesh.morphTargetInfluences[k] = Math.min(1, Math.max(0, (bend(pel, hipIds[S]) - 0.25) / 1.1));
        skinMesh.morphTargetInfluences[2 + k] = Math.min(1, Math.max(0, (bend(tor, hipIds['arm' + S]) - 0.3) / 1.2));
      });
    }
    // follow the pelvis (MuJoCo x, y, z -> three x, z, -y)
    const px = f.xpos[3 * pelvisId], py = f.xpos[3 * pelvisId + 1];
    orbit.target.x += (px - orbit.target.x) * 0.05; orbit.target.z += (-py - orbit.target.z) * 0.05;
    // (#face: the camera close on the face, to look at the eyes)
    if (location.hash === '#hips') {                                               // (#hips: the camera low in front of the hips)
      const pb = bones[hipIds.pelvis], pp = new THREE.Vector3().setFromMatrixPosition(pb.matrixWorld), fw = face.fwd.clone().transformDirection(bones[face.headId].matrixWorld).setY(0).normalize();
      orbit.target.copy(pp); camera.position.copy(pp).addScaledVector(fw, 0.9).add(new THREE.Vector3(0.25, -0.1, 0)); camera.lookAt(pp); orbit.face = true;
    }
    if (location.hash.startsWith('#face') && bones[face.headId]) {
      const hp = new THREE.Vector3().setFromMatrixPosition(bones[face.headId].matrixWorld), fw = face.fwd.clone().transformDirection(bones[face.headId].matrixWorld);
      orbit.target.copy(hp); camera.position.copy(hp).addScaledVector(fw, 0.32).add(new THREE.Vector3(0.08, 0.05, 0)); camera.lookAt(hp); orbit.face = true;
    }

    if (now - panelAt > 100) {
      panelAt = now;
      const fresh = now - labelAt < 4000;
      if (f.replay) $('scene').innerHTML = '<b>再生中</b>';
      else $('scene').innerHTML = `<b>${fresh ? lastLabel : 'ハエ脳＋人体の観察'}</b>${fresh && lastNote ? `<small>${esc(lastNote)}</small>` : ''}`;
      for (const mtr of inMeters) { const v = f.rates[mtr.key] || 0; mtr.bar.style.setProperty('--w', Math.min(100, v / mtr.max * 100) + '%'); mtr.v.textContent = Math.round(v) + ' Hz'; }
      const bo = f.replay ? { ...f.brainOut, GFL: f.brainOut?.GF, GFR: f.brainOut?.GF } : brainOut;   // (a recording has its own)
      for (const mtr of outMeters) { const v = bo[mtr.key] || 0; mtr.bar.style.setProperty('--w', Math.min(100, v / mtr.max * 100) + '%'); mtr.v.textContent = Math.round(v); }
      const running = new Set();
      for (const p of progs) {
        const on = typeof f.prog[p.k] === 'boolean' ? f.prog[p.k] : (f.prog[p.k] || 0) > 0.3;
        p.s.classList.toggle('on', on);
        if (on) running.add(p.word);                                            // (both hands' grooming read as one)
      }
      $('state').textContent = '状態：' + (running.size ? [...running].join('・') : '静止');
      let mean = 0, top = 0; for (let i = 0; i < f.act.length; i++) { mean += f.act[i]; if (f.act[i] > top) top = f.act[i]; }
      const i = f.info || {};
      $('body').innerHTML = `<span>筋活動の平均（416 本）</span><span>${(mean / f.act.length / 255).toFixed(3)}</span>`
        + `<span>いちばん強い筋</span><span>${(top / 255).toFixed(2)}</span>`
        + `<span>床が支える力</span><span>${Math.round(i.support || 0)} N</span>`
        + `<span>筋で足りない力</span><span>${Math.round(i.unmet || 0)}</span>`
        + `<span>脳 20 ms の計算</span><span>${brainWall.toFixed(1)} ms</span>`;
    }
  }
  drawBrain(now);
  placeCamera();
  scene.updateMatrixWorld();
  // food after the bones are in place this frame: honey on the person follows their skin
  // (what it moves is brought up to date again as the scene renders)
  frameNo++;
  // while a recording plays, its food is drawn from the recording, and the live food waits unseen and silent
  if (frame?.replay && replay.item) { hideDrops(); animateReplayFood(frame.scene.food); animateReplayPours(frame); }
  else {
    if (replayFood.size) animateReplayFood([]);
    animateFood(now / 1000, Math.min(0.1, (now - (draw.last || now)) / 1000), frame ? frame.scene.food : []);
    if (frame) listenEating(frame, now);
  }
  showReplay(frame);
  if (frame && bones.length) { animateFace(now, frame.prog); animateRider((now - (draw.last || now)) / 1000, frame.prog, frame.t); }
  draw.last = now;
  animateAppear(now);
  if (stage.clientHeight > 0) renderer.render(scene, camera);                  // (not while another tab hides the stage)
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
