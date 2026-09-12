// test03 — the FlyWire brain (flybrain.js, in a worker) drives flygym's NeuroMechFly body in 3D.
//
// Brain: 20 ms windows exchanged with brain-worker.js (sensory rates in, DN/motor rates out).
// Body:  integrated in 1 ms steps of *simulated* time (so slow motion slows everything),
//        posed and rendered once per animation frame.
import * as THREE from './vendor/three.module.min.js';
import { loadFlyBody, CPG, LocoMap, LEGS } from './body3d.js?v=6';  // (bump ?v= in index.html for main.js)

const V = '?v=1';
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, target, dt, tau) => v + (target - v) * (1 - Math.exp(-dt / tau));
const TAU = Math.PI * 2;

const TICK = 20;                 // ms of brain time per exchange with the worker
const H = 0.001;                 // s, body integration step
const AW = 120, AH = 80;         // arena, mm (x right, y up on the map, z up)
const WALK_Z = 1.12;             // thorax height while walking, from the flygym physics runs
const WINGBEAT = 210;            // Hz
const G = 9810;                  // mm/s^2

// ------------------------------------------------------------------ labels
const IN_ROWS = [
  ['sugar', '甘味 GRN'], ['bitter', '苦味 GRN'], ['water', '水 GRN'],
  ['headL', '頭の毛・触角 左'], ['headR', '頭の毛・触角 右'],
  ['loomL', 'LC4/LPLC2 左'], ['loomR', 'LC4/LPLC2 右'], ['smell', '匂い ORN（実験）'],
];
const OUT_ROWS = [
  ['__sec', '摂食'], ['MN9', 'MN9 口吻伸展'], ['PROB', 'CB0700 口吻'],
  ['__sec', '身づくろい'], ['groomL', 'DNg84+35 左'], ['groomR', 'DNg84+35 右'], ['aDN', 'aDN1/aDN2 触角'],
  ['__sec', '逃避'], ['GFL', 'DNp01 GF 左'], ['GFR', 'DNp01 GF 右'], ['escL', 'DNp04/02 左'], ['escR', 'DNp04/02 右'],
  ['__sec', '歩行'], ['DNa02L', 'DNa02 左'], ['DNa02R', 'DNa02 右'], ['MDN', 'MDN 後退'], ['DNp09', 'DNp09 前進'],
  ['__sec', '体への下行信号（flygym）'], ['dL', '左の脚 振幅'], ['dR', '右の脚 振幅'],
];
function buildRows(el, rows, cls, max) {
  const refs = {};
  el.innerHTML = '';
  for (const [k, label] of rows) {
    if (k === '__sec') { const d = document.createElement('div'); d.className = 'sec'; d.textContent = label; el.appendChild(d); continue; }
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="nm" title="${label}">${label}</span><span class="bar ${cls}"><i></i></span><span class="val">0</span>`;
    el.appendChild(row);
    refs[k] = { bar: row.querySelector('i'), val: row.querySelector('.val'), wrap: row.querySelector('.bar'), max: k === 'dL' || k === 'dR' ? 1.4 : max };
  }
  return refs;
}
const inRefs = buildRows($('in-rows'), IN_ROWS, 'in', 150);
const outRefs = buildRows($('out-rows'), OUT_ROWS, '', 200);
function setRow(ref, v, hotAt, digits) {
  if (!ref) return;
  ref.bar.style.width = clamp(Math.abs(v) / ref.max * 100, 0, 100) + '%';
  ref.val.textContent = digits ? v.toFixed(digits) : v >= 10 ? Math.round(v) : v.toFixed(v > 0 ? 1 : 0);
  if (hotAt !== undefined) ref.wrap.classList.toggle('hot', v >= hotAt);
}

// ------------------------------------------------------------------ world
const world = { t: 0, patches: [], dusts: [], looms: [], trail: [], smell: false };
const fly = {
  x: 60, y: 40, z: WALK_Z, yaw: Math.PI / 2, pitch: 0, roll: 0,
  state: 'walk', stateT: 0, pauseT: 0, om: 0, dL: 0, dR: 0, speed: 0,
  prob: 0, groomPh: 0, groomSlow: 0, dustL: 0, dustR: 0, touchL: 0, touchR: 0,
  wingOpen: 0, flap: 0, wingPh: 0, w: { groom: 0, tuck: 0, reach: 0, jump: 0 },
  flight: null, lastFlightEnd: 0, onPatch: null,
};
const drive = { MN9: 0, PROB: 0, groomL: 0, groomR: 0, aDN: 0, GFL: 0, GFR: 0, escL: 0, escR: 0, DNa02L: 0, DNa02R: 0, MDN: 0, DNp09: 0 };
let inputs = {};
let loomTimer = 0, loomOn = false, loomEvery = 9;

function addPatch(type, x, y, r = 3.2) { world.patches.push({ type, x, y, r, amount: 1, obj: null }); sceneDirty = true; }
function addDust(x, y, r = 7) {
  const pts = Array.from({ length: 90 }, () => { const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * r; return [Math.cos(a) * d, Math.sin(a) * d, 0.4 + Math.random() * 0.8]; });
  world.dusts.push({ x, y, r, pts }); sceneDirty = true;
}
function launchLoom(x, y) {
  const hx = fly.x, hy = fly.y, hz = Math.max(fly.z, WALK_Z) + 6;
  const sx = x, sy = y, sz = 26, d = Math.hypot(hx - sx, hy - sy, hz - sz) || 1;
  world.looms.push({ x: sx, y: sy, z: sz, vx: (hx - sx) / d * 70, vy: (hy - sy) / d * 70, vz: (hz - sz) / d * 70, R: 5, life: 0, prevA: null, obj: null });
  log('⚫ 影が迫ってくる');
}

function scenario(name) {
  world.patches = []; world.dusts = []; world.looms = []; world.trail = [];
  Object.assign(fly, { x: 60, y: 34, z: WALK_Z, yaw: Math.PI / 2, pitch: 0, roll: 0, state: 'walk', stateT: 0, prob: 0, dustL: 0, dustR: 0, touchL: 0, touchR: 0, flight: null, wingOpen: 0, flap: 0 });
  loomTimer = 0; loomOn = false; loomEvery = 9;
  if (name === 'best') { addPatch('sugar', 60, 48); addPatch('sugar', 28, 60); addPatch('sugar', 92, 24); loomOn = true; loomTimer = 3; loomEvery = 12; }
  if (name === 'feed' || name === 'all') { addPatch('sugar', 60, 48); addPatch('sugar', 28, 62); addPatch('sugar', 92, 30); addPatch('sugar', 94, 64); }
  if (name === 'bitter' || name === 'all') { addPatch('mix', 60, 48); addPatch('bitter', 34, 30); addPatch('sugar', 88, 58); if (name === 'bitter') addPatch('mix', 30, 62); }
  if (name === 'dust' || name === 'all') { addDust(60, 48, 8); addDust(30, 36, 7); if (name === 'dust') addDust(90, 58, 7); }
  if (name === 'predator' || name === 'all') { loomOn = true; loomTimer = 4; }
  if (name === 'all') world.patches = world.patches.filter((p, i, a) => a.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 4) === i);
  sceneDirty = true;
  hint(name);
}

// ------------------------------------------------------------------ senses (once per brain tick)
function headPos() { const c = Math.cos(fly.yaw), s = Math.sin(fly.yaw); return [fly.x + c * 0.55, fly.y + s * 0.55, fly.z - 0.2]; }
function sense() {
  const f = fly, inp = { sugar: 0, bitter: 0, water: 0, headL: 0, headR: 0, loomL: 0, loomR: 0, smell: world.smell ? 20 : 0 };
  const [hx, hy] = headPos();
  f.onPatch = null;
  if (!airborne()) {
    for (const p of world.patches) {
      if (p.amount <= 0.01 || Math.hypot(hx - p.x, hy - p.y) > p.r) continue;
      f.onPatch = p;
      const c = Math.min(1, p.amount * 3);
      if (p.type === 'sugar') inp.sugar = 150 * c;
      if (p.type === 'water') inp.water = 150 * c;
      if (p.type === 'bitter') inp.bitter = 150 * c;
      if (p.type === 'mix') { inp.sugar = 150 * c; inp.bitter = 150 * c; }
    }
  }
  inp.headL = clamp(55 * f.dustL + (f.touchL > 0 ? 120 : 0), 0, 150);
  inp.headR = clamp(55 * f.dustR + (f.touchR > 0 ? 120 : 0), 0, 150);
  // looming: expansion rate of the object's angular size, seen from the head
  const [ex, ey, ez] = headPos();
  for (const s of world.looms) {
    const dx = s.x - ex, dy = s.y - ey, dz = s.z - ez, d = Math.max(0.5, Math.hypot(dx, dy, dz));
    const a = 2 * Math.atan(s.R / d);
    const da = s.prevA === null ? 0 : (a - s.prevA) / (TICK / 1000);
    s.prevA = a;
    const hz = clamp(da * 70, 0, 120);
    const side = -Math.sin(f.yaw) * dx + Math.cos(f.yaw) * dy;       // > 0: on the fly's left
    const ahead = Math.cos(f.yaw) * dx + Math.sin(f.yaw) * dy;
    if (Math.abs(side) < 0.35 * Math.abs(ahead) && ahead > 0) { inp.loomL += hz * 0.8; inp.loomR += hz * 0.8; }
    else if (side > 0) inp.loomL += hz; else inp.loomR += hz;
  }
  inp.loomL = clamp(inp.loomL, 0, 120); inp.loomR = clamp(inp.loomR, 0, 120);
  return inp;
}

// ------------------------------------------------------------------ behaviour (once per brain tick)
const airborne = () => fly.state === 'takeoff' || fly.state === 'flight' || fly.state === 'landing';
function setState(s) { if (fly.state === s) return; const prev = fly.state; fly.state = s; fly.stateT = 0; onState(prev, s); }
function decide(out) {
  for (const k in drive) drive[k] = drive[k] + ((out[k] || 0) - drive[k]) * (k.startsWith('GF') ? 1 : 0.3);
  const f = fly, groom = Math.max(drive.groomL, drive.groomR), gfSpike = (out.GFL || 0) + (out.GFR || 0) > 0;
  if (airborne() || f.state === 'land') return;
  if (gfSpike) {
    const awayRight = drive.escL >= drive.escR;          // the side whose escape DNs fire is the threat side
    startTakeoff('escape', `DNp01 発火（左 ${Math.round(out.GFL)}・右 ${Math.round(out.GFR)} Hz）→ ${awayRight ? '右' : '左'}へ跳ぶ`, f.yaw + (awayRight ? -1.1 : 1.1));
  } else if (groom > 40 || (f.state === 'groom' && (groom > 22 || f.stateT < 0.6))) setState('groom');
  else if (drive.MN9 > 15 || (f.state === 'feed' && drive.MN9 > 8)) setState('feed');
  else if (f.state === 'groom' || f.state === 'feed') setState('walk');
}

function startTakeoff(mode, why, dir) {
  const f = fly;
  f.flight = {
    mode, why, dir, launched: false, t: 0, phase: 'cruise', course: dir, turn: 0, u: 0, saccade: false, segT: 0.2,
    U: mode === 'escape' ? 330 : 190 + Math.random() * 60,
    h: mode === 'escape' ? 14 + Math.random() * 14 : 8 + Math.random() * 14,
    T: mode === 'escape' ? 1.2 + Math.random() * 1.2 : 1.5 + Math.random() * 2.5,
    goal: null, wp: null, dist: 0, maxSpeed: 0,
  };
  f.vz = 0;
  setState('takeoff');
  if ($('auto-slow').checked) slowmo = mode === 'escape' ? { t0: world.t, hold: 0.07, factor: 0.04 } : { t0: world.t, hold: 0.17, factor: 0.06 };
}

// ------------------------------------------------------------------ body dynamics (1 ms steps)
let cpg = null, loco = null, body = null;
function motorStep(dt) {
  const f = fly;
  world.t += dt; f.stateT += dt;
  f.touchL = Math.max(0, f.touchL - dt); f.touchR = Math.max(0, f.touchR - dt);
  const W = f.w;
  if (airborne()) flightStep(dt);
  else groundStep(dt);

  // pose weights, in simulated time
  const tuck = (f.state === 'flight' || (f.state === 'takeoff' && f.flight.launched)) && !(f.flight && f.flight.reach);
  W.groom = approach(W.groom, f.state === 'groom' ? 1 : 0, dt, 0.12);
  W.tuck = approach(W.tuck, tuck ? 1 : 0, dt, 0.04);
  W.reach = approach(W.reach, (f.flight && f.flight.reach) || (f.state === 'land' && f.stateT < 0.1) ? 1 : 0, dt, 0.05);
  W.jump = approach(W.jump, f.state === 'takeoff' && f.flight.pushing ? 1 : 0, dt, 0.003);
  f.prob = approach(f.prob, f.state === 'feed' ? clamp(drive.MN9 / 55, 0.35, 1) : 0, dt, 0.08);
  if (f.state === 'groom') { f.groomPh += dt * TAU * 5.5; f.groomSlow += dt * TAU * 0.35; }
  // wings: flapping from take-off to shortly after touch-down
  const flapping = f.state === 'flight' || f.state === 'landing' || (f.state === 'takeoff' && f.flight.flapOn);
  f.flap = approach(f.flap, flapping ? 1 : 0, dt, flapping ? 0.006 : 0.02);
  if (f.flap > 0.01) f.wingPh += dt * TAU * WINGBEAT;
  const open = airborne() || (f.state === 'land' && f.stateT < 0.05);
  const openNow = f.state === 'takeoff' ? f.flight.wingsUp : open;
  f.wingOpen = approach(f.wingOpen, openNow ? 1 : 0, dt, openNow ? (f.flight && f.flight.mode === 'escape' ? 0.004 : 0.03) : 0.06);

  // contact with the world
  if (!airborne()) {
    for (const d of world.dusts) if (Math.hypot(f.x - d.x, f.y - d.y) < d.r) {
      f.dustL = clamp(f.dustL + dt * f.speed * (0.03 + Math.random() * 0.03), 0, 1);
      f.dustR = clamp(f.dustR + dt * f.speed * (0.03 + Math.random() * 0.03), 0, 1);
    }
  }
  if (f.state === 'groom') {
    f.dustL = clamp(f.dustL - dt * 0.55 * (drive.groomL / 150), 0, 1);
    f.dustR = clamp(f.dustR - dt * 0.55 * (drive.groomR / 150), 0, 1);
  }
  if (f.state === 'feed' && f.onPatch) f.onPatch.amount = clamp(f.onPatch.amount - dt * 0.05 * (drive.MN9 / 50), 0, 1);

  // looming objects
  for (const s of world.looms) { s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.life += dt; }
  const before = world.looms.length;
  world.looms = world.looms.filter((s) => s.life < 2.2 && s.z > -s.R && s.x > -30 && s.x < AW + 30 && s.y > -30 && s.y < AH + 30);
  if (world.looms.length !== before) sceneDirty = true;
  if (loomOn) { loomTimer -= dt; if (loomTimer <= 0) { loomTimer = loomEvery; const a = Math.random() * TAU; launchLoom(clamp(f.x + Math.cos(a) * 45, -10, AW + 10), clamp(f.y + Math.sin(a) * 45, -10, AH + 10)); } }
  // spontaneous take-off (the body's default, not the brain)
  if (f.state === 'walk' && $('auto-fly').checked && world.t - f.lastFlightEnd > 6 && Math.random() < dt / 22 && ready) {
    startTakeoff('voluntary', '自発的な離陸（体の既定動作・脳の指令ではない）', f.yaw + (Math.random() - 0.5) * 0.6);
  }
  trailT += dt;
  if (trailT > 0.03) { trailT = 0; world.trail.push([f.x, f.y, airborne() ? f.z : 0.03]); if (world.trail.length > 700) world.trail.shift(); }
}
let trailT = 0;

function groundStep(dt) {
  const f = fly;
  let base = 0;
  if (f.state === 'walk') {
    // walking bouts with short pauses (body default)
    if (f.pauseT > 0) f.pauseT -= dt; else if (Math.random() < dt / 9) f.pauseT = 0.4 + Math.random() * 1.6;
    base = f.pauseT > 0 ? 0 : 1;
    if (drive.MDN > 20) base = -0.8;                                       // moonwalker DNs: walk backward
  }
  // exploration (body), wall avoidance (body), DNa02 asymmetry (brain): + = turn right
  f.om += (-f.om / 0.6) * dt + (Math.random() - 0.5) * 2.2 * Math.sqrt(dt);
  const toC = wrap(Math.atan2(AH / 2 - f.y, AW / 2 - f.x) - f.yaw);
  const wall = Math.min(f.x, AW - f.x, f.y, AH - f.y);
  const avoid = wall < 9 ? -Math.sign(toC) * (9 - wall) * 0.09 : 0;
  const dna02 = clamp((drive.DNa02R - drive.DNa02L) * 0.006, -0.5, 0.5);
  const turn = clamp(f.om + avoid + dna02, -0.75, 0.75);
  f.dL = base * (1 + turn); f.dR = base * (1 - turn);
  if (f.state === 'land') { f.dL = f.dR = 0; if (f.stateT > 0.35) setState('walk'); }
  cpg.step(dt, f.dL, f.dR);
  // body velocity: flygym MuJoCo walking, measured for this descending signal
  const m = cpg.mag, sL = (m[0] + m[1] + m[2]) / 3 * Math.sign(cpg.freq[0]), sR = (m[3] + m[4] + m[5]) / 3 * Math.sign(cpg.freq[3]);
  const v = loco.at(sL, sR);
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  let vx = v.vx, vy = v.vy;
  if (f.state === 'land' && f.flight) { const k = Math.exp(-f.stateT / 0.03); vx += f.flight.u * k; }  // skid at touch-down
  f.x += (c * vx - s * vy) * dt; f.y += (s * vx + c * vy) * dt; f.yaw = wrap(f.yaw + v.wz * dt);
  f.speed = Math.hypot(vx, vy);
  f.x = clamp(f.x, 1.5, AW - 1.5); f.y = clamp(f.y, 1.5, AH - 1.5);
}

function pickWaypoint(minDist) {
  const f = fly;
  for (let k = 0; k < 30; k++) {
    const p = { x: 14 + Math.random() * (AW - 28), y: 14 + Math.random() * (AH - 28) };
    if (Math.hypot(p.x - f.x, p.y - f.y) > minDist) return p;
  }
  return { x: AW / 2, y: AH / 2 };
}
function flightStep(dt) {
  const f = fly, F = f.flight;
  F.t += dt;
  if (f.state === 'takeoff') {
    // escape (GF "short mode"): legs push first, wings open during the jump.
    // voluntary ("long mode"): wings raise first, then the legs push.
    const esc = F.mode === 'escape';
    const tPush = esc ? 0.003 : 0.14, tLaunch = esc ? 0.008 : 0.155, tWings = esc ? 0.006 : 0.0, tFlap = esc ? 0.012 : 0.1;
    F.pushing = F.t > tPush && F.t < tLaunch + 0.004;
    F.wingsUp = F.t > tWings; F.flapOn = F.t > tFlap;
    if (!F.launched && F.t >= tLaunch) {
      F.launched = true;
      const v0 = esc ? 420 : 190, el = esc ? 0.85 : 1.15;
      F.u = v0 * Math.cos(el); f.vz = v0 * Math.sin(el); F.course = F.dir;
    }
    if (F.launched) {
      f.vz -= G * (1 - f.flap * 0.95) * dt;
      f.x += Math.cos(F.course) * F.u * dt; f.y += Math.sin(F.course) * F.u * dt; f.z += f.vz * dt;
      f.yaw = wrap(f.yaw + wrap(F.course - f.yaw) * (1 - Math.exp(-dt / 0.02)));
      f.pitch = approach(f.pitch, 0.7, dt, 0.03);
      if (F.t > tLaunch + 0.03) { setState('flight'); F.t = 0; }
    }
    f.z = Math.max(f.z, WALK_Z);
    return;
  }

  // --- guidance: straight segments broken by saccades, inside the arena, then an approach to land
  const look = Math.min(F.u * 0.06, 18);                                  // mm ahead
  const px = f.x + Math.cos(F.course) * look, py = f.y + Math.sin(F.course) * look;
  const leaving = px < 6 || px > AW - 6 || py < 6 || py > AH - 6;
  if (F.phase === 'cruise' && F.t > F.T) {
    F.phase = 'approach';
    const food = world.patches.filter((q) => q.amount > 0.05);
    if (food.length && Math.random() < 0.5) {       // sometimes land next to food
      const p = food[Math.floor(Math.random() * food.length)], a = Math.random() * TAU;
      F.goal = { x: clamp(p.x + Math.cos(a) * (p.r + 3), 10, AW - 10), y: clamp(p.y + Math.sin(a) * (p.r + 3), 10, AH - 10) };
    } else F.goal = pickWaypoint(25);
    F.wp = F.goal; F.saccade = true;
  }
  if (F.phase === 'cruise') {
    F.segT -= dt;
    if (!F.saccade && (F.segT <= 0 || leaving)) {
      F.wp = pickWaypoint(35); F.saccade = true; F.segT = 0.12 + Math.random() * 0.25;
      F.h = clamp(F.h + (Math.random() - 0.5) * 10, 5, 32);
    }
  }
  const tgt = F.wp || { x: AW / 2, y: AH / 2 };
  const d = Math.hypot(tgt.x - f.x, tgt.y - f.y);
  const want = Math.atan2(tgt.y - f.y, tgt.x - f.x);
  const e = wrap(want - F.course);
  // Drosophila flies straight and changes course in fast saccades (~90 deg in 50 ms);
  // only the final approach is steered continuously
  if (F.phase === 'approach' && d < 6) F.final = true;
  let rate = F.saccade ? clamp(e * 30, -32, 32) : F.phase === 'approach' ? clamp(e * 8, -8, 8) : (Math.random() - 0.5) * 1.2;
  if (F.saccade && (Math.abs(e) < 0.1 || d < 12)) F.saccade = false;
  if (F.final) rate = 0;                                                  // final glide: straight down, no circling
  F.course = wrap(F.course + rate * dt); F.turn = rate;

  let U = F.U, h = F.h;
  if (F.phase === 'approach') {
    const high = f.z - WALK_Z;                                            // slow down while still high
    U = F.final ? 25 : clamp(d * 4, 25, F.U) * clamp(d / (1.5 * high + 1), 0.25, 1);
    h = F.final ? WALK_Z - 0.6 : clamp(WALK_Z + d * 0.3, WALK_Z, F.h);
    F.reach = d < 14 && f.z < 9;
    if (F.t > F.T + 4) h = WALK_Z - 0.5;                                   // don't circle forever
  }
  F.u = approach(F.u, U, dt, 0.1);
  f.vz = approach(f.vz, clamp((h - f.z) * 6, -160, 220), dt, 0.06);
  f.x += Math.cos(F.course) * F.u * dt; f.y += Math.sin(F.course) * F.u * dt; f.z += f.vz * dt;
  f.x = clamp(f.x, 2, AW - 2); f.y = clamp(f.y, 2, AH - 2);
  F.maxSpeed = Math.max(F.maxSpeed, Math.hypot(F.u, f.vz));
  f.speed = Math.hypot(F.u, f.vz);
  // attitude: heading follows the course, banked turns, nose-up body that levels with speed, flare to land
  f.yaw = wrap(f.yaw + wrap(F.course - f.yaw) * (1 - Math.exp(-dt / 0.015)));
  f.roll = approach(f.roll, clamp(Math.atan(F.u * -rate / G), -1.05, 1.05), dt, 0.02);
  const flare = F.phase === 'approach' && d < 8 ? 0.35 * (1 - d / 8) : 0;
  f.pitch = approach(f.pitch, 0.78 - 0.42 * clamp(F.u / 350, 0, 1) + flare, dt, 0.05);
  if (F.phase === 'approach') setStateIf('landing', f.state === 'flight' && d < 18);
  if (f.z <= WALK_Z && F.phase === 'approach' && f.vz <= 0) {
    f.z = WALK_Z; f.roll = 0; F.reach = false;
    const secs = F.t;
    setState('land');
    f.lastFlightEnd = world.t;
    log(`🛬 <b>着地</b>（飛行 ${secs.toFixed(1)} 秒・最高 秒速 ${Math.round(F.maxSpeed)} mm）`);
  }
}
function setStateIf(s, cond) { if (cond) setState(s); }

const BEH = {
  walk: ['🚶', '歩行', () => fly.pauseT > 0 ? '立ち止まり中（体の既定動作）' : 'flygym の CPG と実測の脚の軌道。歩くこと自体は体の既定動作'],
  feed: ['👅', '摂食（口吻を伸ばす）', () => `MN9 ${Math.round(drive.MN9)} Hz ＞ 15 Hz`],
  groom: ['🧹', '身づくろい', () => `DNg84/DNg35 ${Math.round(Math.max(drive.groomL, drive.groomR))} Hz ＞ 40 Hz`],
  takeoff: ['🦘', '離陸', () => fly.flight ? fly.flight.why : ''],
  flight: ['🪽', '飛行', () => fly.flight ? `秒速 ${Math.round(fly.speed)} mm・高さ ${fly.z.toFixed(0)} mm・羽ばたき ${WINGBEAT} 回/秒` : ''],
  landing: ['🛬', '着陸態勢', () => '脚を前に伸ばして減速'],
  land: ['🛬', '着地', () => ''],
};
function onState(prev, now) {
  const f = fly;
  if (now === 'feed') log(`👅 <b>摂食</b>: 甘味 GRN ${Math.round(inputs.sugar || 0)} Hz → MN9 ${Math.round(drive.MN9)} Hz`);
  if (now === 'groom') log(`🧹 <b>身づくろい</b>: 頭の毛への刺激 → DNg84/DNg35 ${Math.round(Math.max(drive.groomL, drive.groomR))} Hz` + ((inputs.sugar || 0) > 0 ? '（砂糖の上だが MN9 は抑えられている）' : ''));
  if (now === 'takeoff') log(`${f.flight.mode === 'escape' ? '🦘' : '🪽'} <b>離陸</b>: ${f.flight.why}`);
  if (prev === 'feed' && now === 'walk') log(f.onPatch && f.onPatch.amount <= 0.02 ? '砂糖を食べ終えた' : `摂食をやめた（MN9 ${Math.round(drive.MN9)} Hz）`);
  if (prev === 'groom' && now !== 'groom') log('身づくろい終了');
}

// ------------------------------------------------------------------ pose (once per frame)
const IK = {};
const legSide = (leg) => (leg[0] === 'l' ? 1 : -1);
function poseTargets(leg, i) {
  const f = fly, s = legSide(leg), pos = leg[1], W = f.w, T = [];
  if (pos === 'f' && W.groom > 0.001) {
    // mostly sweeps over the eye and the top of the head, now and then the two legs rub each other
    const ph = f.groomPh + (s > 0 ? 0 : Math.PI * 0.9), mix = clamp(0.2 + 0.9 * Math.sin(f.groomSlow), 0, 1);
    const sweep = [0.62 + 0.1 * Math.sin(ph), s * (0.28 + 0.1 * Math.cos(ph)), 0.16 + 0.22 * Math.sin(ph)];
    const rub = [0.86 + 0.05 * Math.cos(ph), s * (0.04 + 0.05 * Math.sin(ph)), -0.24 + 0.05 * Math.cos(ph)];
    T.push([W.groom, sweep.map((v, k) => lerp(v, rub[k], mix))]);
  }
  if (W.tuck > 0.001) T.push([W.tuck, pos === 'f' ? [0.5, s * 0.28, -0.62] : pos === 'm' ? [-0.5, s * 0.42, -0.9] : [-1.45, s * 0.3, -0.82]]);
  if (W.reach > 0.001) T.push([W.reach, pos === 'f' ? [1.1, s * 0.62, -1.0] : pos === 'm' ? [0.05, s * 1.15, -1.1] : [-1.35, s * 0.95, -1.1]]);
  if (W.jump > 0.001 && pos === 'm') T.push([W.jump, [-0.62, s * 0.7, -1.78]]);
  return T;
}
function poseLegs() {
  const a = new Array(7);
  for (const [i, leg] of LEGS.entries()) {
    cpg.angles(i, a);
    const T = poseTargets(leg, i);
    let w = 0; const tgt = [0, 0, 0];
    for (const [wk, p] of T) { w += wk; tgt[0] += wk * p[0]; tgt[1] += wk * p[1]; tgt[2] += wk * p[2]; }
    if (w > 0.001) {
      for (let k = 0; k < 3; k++) tgt[k] /= w;
      const init = IK[leg] && IK[leg].w > 0.001 ? IK[leg].a : a.slice();
      const sol = body.ik(leg, tgt, init, cpg.neutral(i), 5, 0.02);
      IK[leg] = { a: sol, w };
      const k = Math.min(1, w);
      for (let d = 0; d < 7; d++) a[d] = lerp(a[d], sol[d], k);
    } else IK[leg] = null;
    body.setLeg(leg, a);
  }
}
const jset = (name, v) => { const j = body.joints[name]; if (j) j.q = v; };
let antT = 0;
function poseHeadAndWings(simDtFrame, blur) {
  const f = fly;
  // proboscis extension (rostrum swings down, haustellum unfolds)
  jset('c_head-c_rostrum-pitch', -1.25 * f.prob);
  jset('c_rostrum-c_haustellum-pitch', -1.6 * f.prob);
  jset('c_thorax-c_head-pitch', 0.18 * f.prob + (f.state === 'groom' ? 0.12 * Math.sin(f.groomPh * 0.5) : 0));
  jset('c_thorax-c_head-yaw', f.state === 'groom' ? 0.1 * Math.sin(f.groomSlow * 2) : 0);
  // antennae twitch a little
  antT += simDtFrame;
  for (const s of ['l', 'r']) jset(`${s}_pedicel-${s}_funiculus-roll`, 0.12 * Math.sin(antT * 3.1 + (s === 'l' ? 0 : 1.3)) * (f.state === 'groom' ? 3 : 1));
  // abdomen: slightly raised in flight
  jset('c_thorax-c_abdomen12-pitch', -0.12 * f.w.tuck);
  // halteres beat in antiphase with the wings
  for (const s of ['l', 'r']) jset(`c_thorax-${s}_haltere-pitch`, f.flap * 0.9 * Math.sin(f.wingPh + Math.PI));
  body.update();
  // wings
  const A = 1.3, phi0 = -0.12, alpha = 0.7, beta = 0.8, q = new THREE.Quaternion(), qg = new THREE.Quaternion();
  const stroke = (ph) => {
    const flapK = f.flap;
    const phi = lerp(phi0 - A, phi0 + A * Math.sin(ph), flapK);
    const dev = 0.12 * Math.sin(2 * ph) * flapK;
    const gam = lerp(Math.PI / 2, Math.PI / 2 - (Math.PI / 2 - alpha) * Math.tanh(2.5 * Math.cos(ph)) / Math.tanh(2.5), flapK);
    return [phi, dev, gam];
  };
  const showGhost = blur > 0.02 && f.wingOpen > 0.8 && f.flap > 0.5;
  body.wingMat.opacity = 1 - 0.62 * (showGhost ? blur : 0);
  body.ghostMat.opacity = 0.075 * blur;
  for (const w of body.wings) {
    const [phi, dev, gam] = stroke(f.wingPh);
    body.wingQuat(w, phi, dev, gam, beta, q);
    w.obj.quaternion.copy(w.wing.qRest).slerp(q, f.wingOpen);
    w.wing.ghosts.forEach((g, k) => {
      g.visible = showGhost;
      if (!showGhost) return;
      const [p2, d2, g2] = stroke(f.wingPh + (k + 0.5) / w.wing.ghosts.length * TAU);
      body.wingQuat(w, p2, d2, g2, beta, qg);
      g.quaternion.copy(w.wing.qRest).slerp(qg, f.wingOpen);
    });
  }
  body.setDust(f.dustL, f.dustR);
}

// stance feet on the floor: fit the body height and tilt to the weighted stance tips
const ground = { z: WALK_Z, pitch: 0, roll: 0 };
function groundPose(simDtFrame) {
  const f = fly;
  let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (const [i, leg] of LEGS.entries()) {
    let w = cpg.mag[i] > 0.15 ? cpg.stance(i) : 1;
    if (leg[1] === 'f') w *= 1 - f.w.groom;
    w *= 1 - Math.max(f.w.tuck, f.w.jump * (leg[1] === 'm' ? 0 : 1));
    if (w < 0.02) continue;
    const p = body.legTip(leg);
    // z_world = Z + z + pitch*x + roll*y  (small angles, pitch = nose up, roll = left side up)
    const row = [1, p[0], p[1]];
    for (let a = 0; a < 3; a++) { r[a] += w * row[a] * -p[2]; for (let b = 0; b < 3; b++) S[a][b] += w * row[a] * row[b]; }
  }
  S[1][1] += 0.4; S[2][2] += 0.4; S[0][0] += 1e-6;                          // keep the tilt modest
  const sol = solve3(S, r);
  const k = 1 - Math.exp(-Math.max(simDtFrame, 1e-5) / 0.03);
  ground.z += (clamp(sol[0], 0.6, 2.2) - ground.z) * k;
  ground.pitch += (clamp(sol[1], -0.2, 0.2) - ground.pitch) * k;
  ground.roll += (clamp(sol[2], -0.2, 0.2) - ground.roll) * k;
}
function solve3(A, b) {
  const [a, bb, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g) || 1e-12;
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
function placeFly(simDtFrame) {
  const f = fly, root = body.root;
  if (!airborne() || (f.state === 'takeoff' && !f.flight.launched)) {
    groundPose(simDtFrame);
    const k = 1 - Math.exp(-Math.max(simDtFrame, 1e-5) / (f.state === 'land' ? 0.025 : 0.01));
    f.z += (ground.z - f.z) * k; f.pitch += (ground.pitch - f.pitch) * k; f.roll += (ground.roll - f.roll) * k;
  }
  root.position.set(f.x, f.y, f.z);
  _qa.setFromAxisAngle(AZ, f.yaw); _qb.setFromAxisAngle(AY, -f.pitch); _qc.setFromAxisAngle(AX, f.roll);
  root.quaternion.copy(_qa).multiply(_qb).multiply(_qc);
}

// ------------------------------------------------------------------ three.js scene
const view = $('view'), stage = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 16 / 10, 0.05, 2000);
camera.up.set(0, 0, 1);
scene.add(new THREE.HemisphereLight(0xf4f7ff, 0x8f8676, 1.35));
const sun = new THREE.DirectionalLight(0xfff3e2, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
Object.assign(sun.shadow.camera, { near: 1, far: 260 });
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.35, -0.5, 1).normalize();
const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5); fill.position.set(60, 90, 30); scene.add(fill);

function floorTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#efeadf'; g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${120 + Math.random() * 60},${110 + Math.random() * 50},${90 + Math.random() * 40},0.05)`; g.fillRect(Math.random() * 1024, Math.random() * 1024, 2 + Math.random() * 4, 1 + Math.random() * 2); }
  g.strokeStyle = 'rgba(120,112,96,0.16)'; g.lineWidth = 2;
  for (let k = 1; k < 10; k++) { g.beginPath(); g.moveTo(k * 102.4, 0); g.lineTo(k * 102.4, 1024); g.moveTo(0, k * 102.4); g.lineTo(1024, k * 102.4); g.stroke(); }
  g.strokeStyle = 'rgba(110,100,84,0.42)'; g.lineWidth = 4; g.strokeRect(0, 0, 1024, 1024);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(AW / 10, AH / 10); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(AW, AH), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.92 }));
floor.position.set(AW / 2, AH / 2, 0); floor.receiveShadow = true; scene.add(floor);
const table = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshStandardMaterial({ color: 0x9d968a, roughness: 1 }));
table.position.set(AW / 2, AH / 2, -0.05); scene.add(table);
const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.7 });
for (const [x, y, w, h] of [[AW / 2, -0.6, AW + 2.4, 1.2], [AW / 2, AH + 0.6, AW + 2.4, 1.2], [-0.6, AH / 2, 1.2, AH], [AW + 0.6, AH / 2, 1.2, AH]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 4), wallMat); m.position.set(x, y, 2); m.castShadow = true; m.receiveShadow = true; scene.add(m);
}

// patches, dust, looms, trail, marker
const PC = { sugar: [0xf6ecc4, '砂糖'], bitter: [0xb58a5c, '苦味'], mix: [0xe0bf7a, '砂糖＋苦味'], water: [0xcfe6f7, '水'] };
const patchGroup = new THREE.Group(), dustGroup = new THREE.Group(), loomGroup = new THREE.Group();
scene.add(patchGroup, dustGroup, loomGroup);
const dropGeo = new THREE.SphereGeometry(1, 40, 10, 0, TAU, 0, Math.PI / 2);
function labelSprite(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.strokeText(text, 128, 32); g.fillStyle = '#3a342b'; g.fillText(text, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, sizeAttenuation: false, depthTest: false, transparent: true }));
  s.scale.set(0.16, 0.04, 1); s.renderOrder = 10;
  return s;
}
let sceneDirty = true;
function rebuildScene() {
  patchGroup.clear(); dustGroup.clear();
  for (const p of world.patches) {
    const [col, name] = PC[p.type];
    const m = new THREE.Mesh(dropGeo, new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.12, clearcoat: 1, transparent: true, opacity: 0.72 }));
    m.receiveShadow = true;
    const lab = labelSprite(name);
    const g = new THREE.Group(); g.add(m, lab);
    p.obj = { g, m, lab, name };
    patchGroup.add(g);
  }
  const specks = world.dusts.reduce((n, d) => n + d.pts.length, 0);
  if (specks) {
    const im = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 6, 5), new THREE.MeshStandardMaterial({ color: 0x8b8272, roughness: 1 }), specks);
    const M = new THREE.Matrix4(); let n = 0;
    for (const d of world.dusts) for (const [px, py, s] of d.pts) { M.makeScale(s, s, s * 0.7).setPosition(d.x + px, d.y + py, 0.06); im.setMatrixAt(n++, M); }
    im.castShadow = true; im.receiveShadow = true; dustGroup.add(im);
    for (const d of world.dusts) { const lab = labelSprite('ほこり'); lab.position.set(d.x, d.y + d.r + 1, 1); lab.userData.label = true; dustGroup.add(lab); }
  }
  loomGroup.clear();
  for (const s of world.looms) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(s.R, 32, 20), new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.5 }));
    m.castShadow = true; s.obj = m; loomGroup.add(m);
  }
  sceneDirty = false;
}
function syncScene() {
  if (sceneDirty || loomGroup.children.length !== world.looms.length) rebuildScene();
  const labels = cam.mode === 'top';
  for (const p of world.patches) {
    const k = Math.sqrt(0.3 + 0.7 * p.amount), o = p.obj;
    o.m.scale.set(p.r * k, p.r * k, 0.14 + 0.1 * p.amount); o.m.position.set(p.x, p.y, 0);
    o.m.material.opacity = 0.3 + 0.5 * p.amount;
    o.lab.position.set(p.x, p.y - p.r - 1.6, 1); o.lab.visible = labels;
  }
  for (const c of dustGroup.children) if (c.userData.label) c.visible = labels;
  for (const s of world.looms) s.obj.position.set(s.x, s.y, s.z);
}
const trailGeo = new THREE.BufferGeometry(), trailPos = new Float32Array(700 * 3);
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x7d766a, transparent: true, opacity: 0.55 }));
trail.frustumCulled = false; scene.add(trail);
function syncTrail() {
  const n = world.trail.length;
  for (let i = 0; i < n; i++) trailPos.set(world.trail[i], i * 3);
  trailGeo.setDrawRange(0, n); trailGeo.attributes.position.needsUpdate = true;
}
const marker = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.0, 40), new THREE.MeshBasicMaterial({ color: 0xeb6834, transparent: true, opacity: 0.85, depthTest: false }));
marker.renderOrder = 5; scene.add(marker);
// a ring that keeps the flying fly easy to spot from far away
const flyRing = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.strokeStyle = 'rgba(235,104,52,0.9)'; g.lineWidth = 7; g.beginPath(); g.arc(64, 64, 52, 0, TAU); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, sizeAttenuation: false, depthTest: false, transparent: true }));
  sp.scale.set(0.07, 0.07, 1); sp.renderOrder = 6; sp.visible = false; scene.add(sp);
  return sp;
})();

function applyStageTheme() { scene.background = new THREE.Color(css('--stage') || '#d7dde2'); scene.fog = new THREE.Fog(scene.background, 260, 900); }
applyStageTheme();

// ------------------------------------------------------------------ camera
const cam = { mode: 'chase', az: 0.75, el: 0.36, zoom: 1, yawS: fly.yaw, pos: new THREE.Vector3(60, 20, 10), look: new THREE.Vector3(60, 40, 1) };
function updateCamera(realDt) {
  const f = fly, fp = new THREE.Vector3(f.x, f.y, f.z);
  const air = airborne();
  if (cam.mode === 'top') {
    const aspect = camera.aspect, fov = THREE.MathUtils.degToRad(camera.fov);
    const hNeed = Math.max(AH * 1.08, AW * 1.08 / aspect) / 2 / Math.tan(fov / 2);
    const eye = new THREE.Vector3(AW / 2, AH / 2 - hNeed * 0.12, hNeed * cam.zoom);
    cam.pos.lerp(eye, 1 - Math.exp(-realDt / 0.25)); cam.look.lerp(new THREE.Vector3(AW / 2, AH / 2, 0), 1 - Math.exp(-realDt / 0.25));
  } else if (air && !(f.state === 'takeoff' || (f.state === 'flight' && f.flight.t < 0.12))) {
    // in flight: a fixed vantage point above the arena, panning gently (no swinging chase)
    if (!cam.vantage) cam.vantage = pickVantage(fp);
    const center = new THREE.Vector3(AW / 2, AH / 2, 0);
    const eye = cam.vantage.clone().sub(center).multiplyScalar(cam.zoom).add(center);
    cam.pos.lerp(eye, 1 - Math.exp(-realDt / 0.5));
    cam.look.lerp(center.lerp(new THREE.Vector3(f.x, f.y, f.z * 0.5), 0.5), 1 - Math.exp(-realDt / 0.6));
    cam.yawS += wrap(f.yaw - cam.yawS) * (1 - Math.exp(-realDt / 0.6));
    cam.retT = 0;
  } else {
    // on the ground and during the take-off: follow closely (easing back in after a flight)
    cam.vantage = null; cam.retT = (cam.retT ?? 9) + realDt;
    const ease = clamp(cam.retT / 1.5, 0, 1);
    const dist = (air ? 15 : 6.5) * cam.zoom * (cam.mode === 'side' ? 1.1 : 1);
    let az;
    if (cam.mode === 'chase') {
      cam.yawS += wrap(f.yaw - cam.yawS) * (1 - Math.exp(-realDt / (air ? 0.9 : 0.6)));
      az = cam.yawS + Math.PI + cam.az;                 // behind the fly, offset to a 3/4 view (or by orbit drag)
    } else az = cam.az;
    const el = cam.mode === 'chase' && air ? Math.min(1.3, cam.el + 0.2) : cam.el;
    const eye = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)).multiplyScalar(dist).add(fp);
    eye.z = Math.max(eye.z, 0.6);
    const k = 1 - Math.exp(-realDt / lerp(0.7, air ? 0.35 : 0.18, ease));
    cam.pos.lerp(eye, k);
    cam.look.lerp(fp, 1 - Math.exp(-realDt / lerp(0.4, air ? 0.05 : 0.08, ease)));
  }
  camera.position.copy(cam.pos); camera.lookAt(cam.look);
  // shadow frustum around the fly (small = sharp)
  const S = cam.mode === 'top' ? 70 : air ? 30 : 7;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
  sun.shadow.camera.updateProjectionMatrix();
  const gpt = cam.mode === 'top' ? new THREE.Vector3(AW / 2, AH / 2, 0) : new THREE.Vector3(f.x, f.y, 0);
  sun.target.position.copy(gpt); sun.position.copy(gpt).addScaledVector(SUN_DIR, 120);
  marker.visible = cam.mode === 'top'; marker.position.set(f.x, f.y, 0.05);
  flyRing.visible = cam.mode === 'top' ? air : !!cam.vantage; flyRing.position.set(f.x, f.y, f.z);
  mm.style.display = cam.mode === 'top' ? 'none' : '';
  for (const m of body.microchaetae) m.visible = camera.position.distanceTo(fp) < 16;
}
// of four viewpoints above the arena's edges, the one on the camera's current side
function pickVantage(fp) {
  const V4 = [[AW / 2, -12, 118], [AW / 2, AH + 12, 118], [-12, AH / 2, 124], [AW + 12, AH / 2, 124]].map((v) => new THREE.Vector3(...v));
  const dir = cam.pos.clone().sub(fp).setZ(0).normalize(), c = new THREE.Vector3(AW / 2, AH / 2, 0);
  return V4.reduce((best, v) => (v.clone().sub(c).setZ(0).normalize().dot(dir) > best.clone().sub(c).setZ(0).normalize().dot(dir) ? v : best));
}
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  resizeMinimap();
}

// ------------------------------------------------------------------ minimap
const mm = $('minimap'), mg = mm.getContext('2d');
let mmS = 1, mmD = 1;
function resizeMinimap() { mmD = window.devicePixelRatio || 1; const w = mm.clientWidth; mmS = w / AW; mm.width = Math.round(w * mmD); mm.height = Math.round(AH * mmS * mmD); mm.style.height = AH * mmS + 'px'; }
function drawMinimap() {
  const S = mmS, X = (x) => x * S, Y = (y) => (AH - y) * S;
  mg.setTransform(mmD, 0, 0, mmD, 0, 0);
  mg.fillStyle = 'rgba(239,234,223,0.94)'; mg.fillRect(0, 0, AW * S, AH * S);
  mg.strokeStyle = 'rgba(110,100,84,0.25)'; mg.lineWidth = 0.5;
  for (let x = 10; x < AW; x += 10) { mg.beginPath(); mg.moveTo(X(x), 0); mg.lineTo(X(x), AH * S); mg.stroke(); }
  for (let y = 10; y < AH; y += 10) { mg.beginPath(); mg.moveTo(0, Y(y)); mg.lineTo(AW * S, Y(y)); mg.stroke(); }
  for (const d of world.dusts) { mg.fillStyle = 'rgba(128,118,100,0.35)'; mg.beginPath(); mg.arc(X(d.x), Y(d.y), d.r * S, 0, TAU); mg.fill(); }
  const col = { sugar: '#d9b52c', bitter: '#7a4a1e', mix: '#a8741f', water: '#2a78d6' };
  for (const p of world.patches) { mg.globalAlpha = 0.3 + 0.7 * p.amount; mg.fillStyle = col[p.type]; mg.beginPath(); mg.arc(X(p.x), Y(p.y), Math.max(2, p.r * S), 0, TAU); mg.fill(); mg.globalAlpha = 1; }
  mg.strokeStyle = 'rgba(80,74,64,0.55)'; mg.lineWidth = 1; mg.beginPath();
  world.trail.forEach(([x, y], i) => (i ? mg.lineTo(X(x), Y(y)) : mg.moveTo(X(x), Y(y)))); mg.stroke();
  for (const s of world.looms) { mg.fillStyle = 'rgba(10,10,10,0.55)'; mg.beginPath(); mg.arc(X(s.x), Y(s.y), s.R * S, 0, TAU); mg.fill(); }
  const f = fly, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  mg.fillStyle = airborne() ? '#2a78d6' : '#eb6834';
  mg.beginPath(); mg.moveTo(X(f.x + c * 3), Y(f.y + s * 3)); mg.lineTo(X(f.x - c * 2 - s * 1.6), Y(f.y - s * 2 + c * 1.6)); mg.lineTo(X(f.x - c * 2 + s * 1.6), Y(f.y - s * 2 - c * 1.6)); mg.fill();
}

// ------------------------------------------------------------------ brain map (same as test02)
const bm = $('brainmap'), bg = bm.getContext('2d');
let pos = null, bmBack = null, bmW = 0, bmH = 0, pxX = null, pxY = null;
const glow = [];
async function loadPositions() {
  const res = await fetch('../flybrain/data/pos783.bin.gz?v=1');
  const raw = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const n = new DataView(raw.buffer).getUint32(4, true);
  pos = { n, x: new Uint16Array(raw.buffer.slice(8, 8 + 2 * n)), y: new Uint16Array(raw.buffer.slice(8 + 2 * n, 8 + 4 * n)), c: raw.slice(8 + 4 * n, 8 + 5 * n) };
  resizeBrain();
}
function isDark() { return matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark'; }
function resizeBrain() {
  if (!pos) return;
  const d = window.devicePixelRatio || 1;
  bmW = bm.clientWidth; bmH = Math.round(bmW / 2.08);
  bm.width = Math.round(bmW * d); bm.height = Math.round(bmH * d); bm.style.height = bmH + 'px';
  pxX = new Float32Array(pos.n); pxY = new Float32Array(pos.n);
  const pad = 6;
  for (let i = 0; i < pos.n; i++) { pxX[i] = (pad + pos.x[i] / 65535 * (bmW - 2 * pad)) * d; pxY[i] = (pad + pos.y[i] / 65535 * (bmH - 2 * pad)) * d; }
  bmBack = document.createElement('canvas'); bmBack.width = bm.width; bmBack.height = bm.height;
  const b = bmBack.getContext('2d'); const img = b.createImageData(bm.width, bm.height);
  const base = isDark() ? 200 : 60;
  for (let i = 0; i < pos.n; i++) {
    if (pos.c[i] === 255) continue;
    const o = ((pxY[i] | 0) * bm.width + (pxX[i] | 0)) * 4;
    img.data[o] = base; img.data[o + 1] = base; img.data[o + 2] = base; img.data[o + 3] = Math.min(255, img.data[o + 3] + 14);
  }
  b.putImageData(img, 0, 0);
}
function drawBrain(now) {
  if (!bmBack) return;
  bg.setTransform(1, 0, 0, 1, 0, 0); bg.clearRect(0, 0, bm.width, bm.height); bg.drawImage(bmBack, 0, 0);
  const cols = [css('--c-input'), css('--c-central'), css('--c-output')];
  const d = window.devicePixelRatio || 1, sz = 2.2 * d;
  while (glow.length && now - glow[0][0] > 350) glow.shift();
  for (let pass = 0; pass < 3; pass++) {
    bg.fillStyle = cols[pass];
    for (const [t, i] of glow) {
      const c = pos.c[i], grp = c === 0 ? 0 : (c === 6 || c === 7) ? 2 : 1;
      if (grp !== pass) continue;
      bg.globalAlpha = 1 - (now - t) / 350;
      bg.fillRect(pxX[i] - sz / 2, pxY[i] - sz / 2, grp === 2 ? sz * 1.8 : sz, grp === 2 ? sz * 1.8 : sz);
    }
  }
  bg.globalAlpha = 1;
}

// ------------------------------------------------------------------ sparkline + gait diagram
const sp = $('spark'), sg = sp.getContext('2d'), hist = [];
function drawSpark() {
  const d = window.devicePixelRatio || 1, W = sp.clientWidth, Hh = sp.clientHeight;
  if (sp.width !== Math.round(W * d)) { sp.width = Math.round(W * d); sp.height = Math.round(Hh * d); }
  sg.setTransform(d, 0, 0, d, 0, 0); sg.clearRect(0, 0, W, Hh);
  const N = 500, maxV = Math.max(200000, ...hist) * 1.05, y = (v) => Hh - 2 - (v / maxV) * (Hh - 14);
  sg.strokeStyle = css('--grid'); sg.beginPath(); sg.moveTo(0, Hh - 1.5); sg.lineTo(W, Hh - 1.5); sg.stroke();
  sg.setLineDash([3, 3]); sg.strokeStyle = css('--c-output'); sg.beginPath(); sg.moveTo(0, y(150000)); sg.lineTo(W, y(150000)); sg.stroke(); sg.setLineDash([]);
  sg.strokeStyle = css('--c-central'); sg.lineWidth = 1.5; sg.beginPath();
  hist.forEach((v, i) => { const x = W - (hist.length - 1 - i) * (W / N); i ? sg.lineTo(x, y(v)) : sg.moveTo(x, y(v)); }); sg.stroke();
  sg.fillStyle = css('--muted'); sg.font = '10px system-ui, sans-serif';
  sg.fillText(`${Math.round((hist[hist.length - 1] || 0) / 1000)}k/秒`, 4, 10);
}
const gaitHist = [];     // [t, bits]
function recordGait() {
  const f = fly;
  let bits = 0;
  if (!airborne()) for (let i = 0; i < 6; i++) {
    let st = cpg.mag[i] > 0.15 ? cpg.stance(i) > 0.5 : true;
    if (i % 3 === 0 && f.w.groom > 0.5) st = false;
    if (st) bits |= 1 << i;
  }
  gaitHist.push([world.t, bits]);
  while (gaitHist.length && world.t - gaitHist[0][0] > 1.6) gaitHist.shift();
}
const gc = $('gait'), gg = gc.getContext('2d');
function drawGait() {
  const d = window.devicePixelRatio || 1, W = gc.clientWidth, Hh = gc.clientHeight;
  if (gc.width !== Math.round(W * d)) { gc.width = Math.round(W * d); gc.height = Math.round(Hh * d); }
  gg.setTransform(d, 0, 0, d, 0, 0); gg.clearRect(0, 0, W, Hh);
  const names = ['左前', '左中', '左後', '右前', '右中', '右後'], L = 34, rowH = (Hh - 4) / 6, span = 1.5, t1 = world.t;
  gg.font = '10px system-ui, sans-serif'; gg.fillStyle = css('--ink-2');
  names.forEach((n, i) => gg.fillText(n, 0, 2 + rowH * i + rowH * 0.7));
  gg.fillStyle = css('--ink');
  for (let k = 1; k < gaitHist.length; k++) {
    const [ta, bits] = gaitHist[k - 1], tb = gaitHist[k][0];
    const xa = L + (W - L) * (1 - (t1 - ta) / span), xb = L + (W - L) * (1 - (t1 - tb) / span);
    if (xb < L) continue;
    for (let i = 0; i < 6; i++) if (bits & (1 << i)) gg.fillRect(Math.max(L, xa), 2 + rowH * i + 2, Math.max(0.6, xb - Math.max(L, xa)), rowH - 4);
  }
  gg.strokeStyle = css('--grid');
  for (let i = 0; i <= 6; i++) { gg.beginPath(); gg.moveTo(L, 2 + rowH * i); gg.lineTo(W, 2 + rowH * i); gg.stroke(); }
}

// ------------------------------------------------------------------ log / hint / status
function log(html) {
  const el = document.createElement('div');
  el.innerHTML = `<span style="color:var(--muted)">${world.t.toFixed(1)}s</span> ${html}`;
  $('log').prepend(el);
  while ($('log').children.length > 60) $('log').lastChild.remove();
}
const HINTS = {
  best: '砂糖を食べ、ときどき自分から飛び、12秒ごとに迫る影からは逃避ジャンプで飛び立ちます。速度を「×1/50」にすると羽ばたきが見えます。',
  free: '道具を選んで床をクリックしてください。',
  feed: '砂糖に口が触れると、甘味の味覚ニューロン → MN9 が発火して口吻を伸ばします。',
  bitter: '真ん中は砂糖＋苦味。苦味の味覚ニューロンが MN9 を止めるので、ハエは食べずに通り過ぎます。',
  dust: 'ほこりを通ると頭の毛が刺激され、身づくろい用の下行性ニューロンが発火して前脚で頭をこすります。',
  predator: '9秒ごとに黒い物体が迫ります。LC4/LPLC2 → ジャイアントファイバー DNp01 が発火すると跳んで飛び立ちます。',
  all: '全部入り。ほこりまみれで砂糖に着くと、MN9 が抑えられて食べられません。',
};
const TOOL_HINT = { sugar: 'クリックで砂糖を置く', bitter: 'クリックで苦味を置く', mix: 'クリックで砂糖＋苦味を置く', water: 'クリックで水を置く', dust: 'クリックでほこり。ハエの上なら頭に直接',
  shadow: 'クリックした場所の上空から、ハエに向かって黒い物体が迫る', touch: 'ハエの頭の左右どちらかをクリック', move: 'ハエをドラッグ', erase: '物をクリックで消す', orbit: 'ドラッグで視点を回す（ホイールで拡大・縮小）' };
function hint(s) { $('hint').textContent = HINTS[s] || ''; }

// ------------------------------------------------------------------ worker + loops
let worker, ready = false, busy = false, paused = false, speed = 1, lastFrame = performance.now(), brainT = 0, bodyAcc = 0;
let perf = { wall: 0, spikes: 0, awake: 0, t: 0 }, runaway = 0, runawayShown = false, slowmo = null;
function startWorker() {
  worker = new Worker('brain-worker.js' + V, { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (m.phase === 'download' && m.total) { $('load-bar').style.width = (m.loaded / m.total * 100) + '%'; $('load-msg').textContent = `脳の配線を読み込み中… ${(m.loaded / 1e6).toFixed(1)} / ${(m.total / 1e6).toFixed(1)} MB`; }
      if (m.phase === 'decompress') $('load-msg').textContent = '展開して WebAssembly に組み立て中…';
    } else if (m.type === 'ready') {
      ready = true; $('overlay').hidden = true;
      for (const id of ['btn-play', 'btn-reset', 'btn-smell', 'btn-fly']) $(id).disabled = false;
      brainT = world.t;
      log(`脳の準備完了: ${m.n.toLocaleString()} ニューロン・${m.nnz.toLocaleString()} 結合`);
    } else if (m.type === 'tick') { busy = false; onTick(m); if (!paused && brainT < world.t + bodyAcc + 2 * TICK / 1000) sendTick(); }
    else if (m.type === 'error') { $('load-msg').textContent = 'エラー: ' + m.message; $('overlay').hidden = false; }
  };
  worker.postMessage({ type: 'init' });
}
function sendTick() { inputs = sense(); busy = true; brainT += TICK / 1000; worker.postMessage({ type: 'tick', ms: TICK, inputs }); }
function onTick(m) {
  decide(m.out);
  const now = performance.now();
  for (let k = 0; k < m.fired.length; k++) glow.push([now, m.fired[k]]);
  if (glow.length > 12000) glow.splice(0, glow.length - 12000);
  const rate = m.spikes / (m.ms / 1000);
  hist.push(rate); if (hist.length > 500) hist.shift();
  perf.wall = perf.wall + (m.wall - perf.wall) * 0.1; perf.spikes = rate; perf.awake = m.awake; perf.t = m.t;
  runaway = rate > 150000 ? runaway + 1 : 0;
  if (runaway > 25 && !runawayShown) {
    runawayShown = true;
    $('warn').innerHTML = '⚠️ <b>暴走（自己持続）状態</b>: 刺激をやめても脳全体が毎秒数十万回発火し続けています。これはこのモデル（Shiu et al. の LIF を v783 の配線で動かしたもの）自体の性質で、元の Brian2 でも同じことが起きます。' + ($('auto-reset').checked ? ' 2秒後に脳をリセットします。' : '');
    $('warn').classList.add('show');
    log('⚠️ <b>暴走を検出</b>（' + Math.round(rate / 1000) + 'k スパイク/秒）');
    if ($('auto-reset').checked) setTimeout(resetBrain, 2000);
  }
}
function resetBrain() {
  if (!ready) return;
  world.smell = false; $('btn-smell').classList.remove('on');
  worker.postMessage({ type: 'reset' });
  runaway = 0; runawayShown = false; $('warn').classList.remove('show');
  log('脳をリセット（全ニューロンを静止電位へ）');
}
function effectiveSpeed() {
  if (!slowmo) return speed;
  const dt = world.t - slowmo.t0;
  if (dt < slowmo.hold) return Math.min(speed, slowmo.factor);
  const r = slowmo.factor * Math.exp((dt - slowmo.hold) / 0.05);     // ease back to the chosen speed
  if (r >= speed) { slowmo = null; return speed; }
  return r;
}

let uiTimer = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  let simDtFrame = 0;
  if (body && !paused) {
    const sp = ready ? effectiveSpeed() : 0;
    bodyAcc = Math.min(bodyAcc + dtReal * sp, 0.25);
    // the body may lead the brain by at most two ticks
    while (bodyAcc >= H && (!ready || world.t < brainT + 2 * TICK / 1000)) { bodyAcc -= H; motorStep(H); simDtFrame += H; }
    if (ready && !busy && brainT < world.t + TICK / 1000) sendTick();
    if (!ready) { cpg.step(dtReal, 0, 0); }
  }
  if (body) {
    poseLegs();
    const blur = simDtFrame > 0 ? clamp((WINGBEAT * simDtFrame - 0.15) / 0.35, 0, 1) : blur0;
    blur0 = blur;
    poseHeadAndWings(simDtFrame, blur);
    placeFly(simDtFrame);
    if (simDtFrame > 0) recordGait();
    syncScene(); syncTrail();
    updateCamera(dtReal);
    renderer.render(scene, camera);
    drawMinimap();
    const sl = slowmo ? effectiveSpeed() : 0;
    $('slowtag').hidden = !sl;
    if (sl) $('slowtag').textContent = `🎞 スローモーション ×${sl < 0.1 ? '1/' + Math.round(1 / sl) : sl.toFixed(2)}`;
    $('hud').textContent = airborne() ? `秒速 ${Math.round(fly.speed)} mm ・ 高さ ${fly.z.toFixed(1)} mm` : `秒速 ${fly.speed.toFixed(1)} mm`;
  }
  drawBrain(now);
  if (now - uiTimer > 100) { uiTimer = now; updatePanels(); drawSpark(); drawGait(); }
  requestAnimationFrame(frame);
}
let blur0 = 0;
function updatePanels() {
  for (const [k] of IN_ROWS) setRow(inRefs[k], inputs[k] || 0);
  for (const [k] of OUT_ROWS) {
    if (k === '__sec') continue;
    if (k === 'dL' || k === 'dR') { setRow(outRefs[k], fly[k], undefined, 2); continue; }
    setRow(outRefs[k], drive[k] || 0, k === 'MN9' ? 15 : (k === 'groomL' || k === 'groomR') ? 40 : k.startsWith('GF') ? 1 : undefined);
  }
  const f = fly, b = BEH[f.state] || BEH.walk;
  $('beh-em').textContent = b[0]; $('beh-t').textContent = ready ? b[1] : '準備中'; $('beh-why').textContent = ready ? b[2]() : '';
  const rt = perf.wall ? TICK / perf.wall : 0;
  $('status').innerHTML = ready ? `<span>脳の時間 <b>${(perf.t / 1000 || 0).toFixed(1)} s</b></span><span>全脳 <b>${Math.round(perf.spikes).toLocaleString()}</b> スパイク/秒</span><span>計算中 <b>${perf.awake}</b> ニューロン</span><span>脳の計算速度 <b>×${rt.toFixed(1)}</b> 実時間</span><span>ほこり 左 ${Math.round(f.dustL * 100)}% ・右 ${Math.round(f.dustR * 100)}%</span>` : '';
}

// ------------------------------------------------------------------ input
let tool = 'sugar', dragging = null;
$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tool]'); if (!b) return;
  tool = b.dataset.tool;
  for (const x of $('tools').querySelectorAll('button[data-tool]')) x.classList.toggle('on', x === b);
  $('hint').textContent = TOOL_HINT[tool];
  view.style.cursor = tool === 'orbit' ? 'grab' : tool === 'move' ? 'move' : 'crosshair';
});
$('camsel').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  cam.mode = b.dataset.cam; cam.zoom = 1;
  if (cam.mode === 'side') { cam.az = fly.yaw + Math.PI / 2; cam.el = 0.18; }
  if (cam.mode === 'chase') { cam.az = 0.75; cam.el = 0.36; }
  for (const x of $('camsel').children) x.classList.toggle('on', x === b);
});
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), floorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function floorPoint(e) {
  const r = view.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(floorPlane, p) ? [p.x, p.y] : null;
}
function applyTool(x, y) {
  const f = fly, onFly = Math.hypot(x - f.x, y - f.y) < (cam.mode === 'top' ? 3.5 : 1.6);
  if (tool === 'sugar' || tool === 'bitter' || tool === 'mix' || tool === 'water') { if (x > 2 && x < AW - 2 && y > 2 && y < AH - 2) addPatch(tool, x, y); }
  if (tool === 'dust') { if (onFly) { f.dustL = f.dustR = 1; log('🌫 頭にほこりをかけた'); } else addDust(x, y); }
  if (tool === 'shadow') launchLoom(x, y);
  if (tool === 'touch') {
    const side = -Math.sin(f.yaw) * (x - f.x) + Math.cos(f.yaw) * (y - f.y) > 0 ? 'L' : 'R';
    if (side === 'L') f.touchL = 0.4; else f.touchR = 0.4;
    log(`👆 頭の${side === 'L' ? '左' : '右'}側に触れた`);
  }
  if (tool === 'erase') {
    world.patches = world.patches.filter((p) => Math.hypot(p.x - x, p.y - y) > p.r + 1);
    world.dusts = world.dusts.filter((d) => Math.hypot(d.x - x, d.y - y) > d.r);
    sceneDirty = true;
  }
}
view.addEventListener('pointerdown', (e) => {
  if (tool === 'orbit' || e.button === 2) { dragging = { kind: 'orbit', x: e.clientX, y: e.clientY }; view.setPointerCapture(e.pointerId); return; }
  const p = floorPoint(e); if (!p) return;
  if (tool === 'move') { if (!airborne() && Math.hypot(p[0] - fly.x, p[1] - fly.y) < 6) { dragging = { kind: 'move' }; view.setPointerCapture(e.pointerId); } return; }
  applyTool(p[0], p[1]);
});
view.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  if (dragging.kind === 'orbit') {
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y; dragging.x = e.clientX; dragging.y = e.clientY;
    if (cam.mode === 'top') { cam.mode = 'side'; cam.az = -Math.PI / 2; cam.el = 0.9; for (const x of $('camsel').children) x.classList.toggle('on', x.dataset.cam === 'side'); }
    cam.az -= dx * 0.008; cam.el = clamp(cam.el + dy * 0.006, 0.03, 1.45);
  } else { const p = floorPoint(e); if (p) { fly.x = clamp(p[0], 2, AW - 2); fly.y = clamp(p[1], 2, AH - 2); world.trail = []; } }
});
view.addEventListener('pointerup', () => { dragging = null; });
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom = clamp(cam.zoom * Math.exp(e.deltaY * 0.0012), 0.25, 6); }, { passive: false });
mm.addEventListener('pointerdown', (e) => {
  const r = mm.getBoundingClientRect(), x = (e.clientX - r.left) / mmS, y = AH - (e.clientY - r.top) / mmS;
  if (tool === 'move') { if (!airborne()) { fly.x = clamp(x, 2, AW - 2); fly.y = clamp(y, 2, AH - 2); world.trail = []; } return; }
  if (tool !== 'orbit') applyTool(x, y);
});
$('btn-play').addEventListener('click', () => { paused = !paused; $('btn-play').textContent = paused ? '▶ 再開' : '⏸ 一時停止'; });
$('btn-reset').addEventListener('click', resetBrain);
$('btn-fly').addEventListener('click', () => {
  if (airborne() || fly.state === 'land') return;
  startTakeoff('voluntary', '「飛ばす」ボタン（体の既定動作・脳の指令ではない）', fly.yaw + (Math.random() - 0.5) * 0.6);
});
$('speed').addEventListener('change', (e) => { speed = +e.target.value; });
$('scenario').addEventListener('change', (e) => { scenario(e.target.value); log(`シナリオ: ${e.target.selectedOptions[0].textContent}`); });
$('btn-smell').addEventListener('click', () => {
  world.smell = !world.smell; $('btn-smell').classList.toggle('on', world.smell);
  log(world.smell ? '🧪 匂いの受容ニューロン（ORN DM1、左右）に 20 Hz の入力を開始' : '🧪 匂いの入力を停止');
});
window.addEventListener('resize', () => resizeBrain());
new ResizeObserver(() => resize()).observe(stage);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { resizeBrain(); applyStageTheme(); });
window.addEventListener('keydown', (e) => { if (e.key === 'f' && !e.repeat && document.activeElement === document.body) $('btn-fly').click(); });

// ------------------------------------------------------------------ start
resize();
scenario('best');
(async () => {
  try {
    const [b, L] = await Promise.all([loadFlyBody('nmf/', V), fetch('nmf/locomotion.json' + V).then((r) => r.json())]);
    body = b; cpg = new CPG(body.J); loco = new LocoMap(L);
    scene.add(body.root);
    for (const [i, leg] of LEGS.entries()) body.setLeg(leg, cpg.neutral(i));
    $('load-msg').textContent = '脳の配線（約30MB）を読み込んでいます…';
    startWorker();
  } catch (err) {
    $('load-msg').textContent = '体の読み込みに失敗: ' + (err && err.message || err);
  }
})();
loadPositions();
window.__sim = { world, fly, drive, cam, flyNdc: () => new THREE.Vector3(fly.x, fly.y, fly.z).project(camera).toArray(), get body() { return body; }, get cpg() { return cpg; }, startTakeoff, setSpeed: (s) => { speed = s; }, launchLoom };
requestAnimationFrame(frame);
