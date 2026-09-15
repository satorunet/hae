// A courting pair. The female's whole brain (FlyWire v783) runs in a worker and
// decides what she does: DNp12 (left/right) turns her toward the song and the
// receptivity command vpoDN (DNp37) makes her stand still for the male. The male
// is a hand-written script (male.js); his song is what her brain hears, from
// where he actually is, and what you hear too.
import * as THREE from '../test03/vendor/three.module.min.js';
import { FlagFly } from '../suji/flag.js?v=40';
import { MaleFly, MALE_STATE_TEXT, COPULATE_S } from './male.js?v=42';
import { EggLaying, EGG_TEXT } from './eggs.js?v=41';
import { lifespan, poseDying, CORPSE_MEAT } from './growth.js?v=33';
import { Foods, HUNGRY_S, STARVE } from './food.js?v=6';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

// what the rows show: [group, label, what it is, Hz for a full bar]
const ROWS = [
  ['joL', '聴覚 JO（左）', 'ジョンストン器官の聴覚ニューロン', 250],
  ['joR', '聴覚 JO（右）', '', 250],
  ['relay', '聴覚中継 DNg29', '歌の信号がここまで届く', 100],
  ['wed104', '抑制 WED104', 'vpoEN を抑える GABA 細胞（強い連続音で発火）', 60],
  ['vpoEN', '歌検出 vpoEN', '本物の蠅では歌で興奮する', 30],
  ['pC1', '交尾意欲 pC1', 'dsx 陽性。メスの受け入れの状態', 30],
  ['vpoDN', '受け入れ指令 vpoDN', 'DNp37。膣板を開く下行性ニューロン', 25],
  ['orientL', '音へ向く DNp12（左）', '', 120],
  ['orientR', '音へ向く DNp12（右）', '', 120],
  ['smp550', '産卵の興奮入力 SMP550', 'oviDN への最大の興奮性入力（ここへの入力は仮定）', 40],
  ['oviIN', '産卵の抑制 oviIN', 'oviDN を抑える GABA 細胞', 30],
  ['oviDNa', '産卵指令 oviDNa', '卵を産む下行性ニューロン。4 Hz を超えると産む', 12],
];
// mating status -> input to pC1 (Hz): at rest, and extra while she hears a song (the assumed song->pC1 drive)
const STATUS = { virgin: { base: 5, song: 15 }, mated: { base: 1, song: 3 } };
const RECEPTIVE_HZ = 8;          // vpoDN above this: she stands still for the male

// manual: the song buttons and slider; male: the male fly sings, from where he is
const st = { mode: 'male', song: 'off', side: -0.6, gain: 1, status: 'virgin', assist: true };
const rate = {};                 // smoothed Hz per group
const hist = [];
let ready = false, started = false, fly = null, male = null, egg = null, foods = null;
// the day clock: development and ageing are squeezed, behaviour is not. The parents came out of their
// pupae a few days before; each has a lifespan drawn like a real one (mostly 40-60 days at 25 °C)
const life = { day: 0, dayS: 8, cam: 'all', female: { age: 3, span: lifespan(), dead: false }, male: { age: 4, span: lifespan(), dead: false } };
window.__life = life;

// ------------------------------------------------------------ the female
class CourtFly extends FlagFly {
  constructor(canvas) {
    super(canvas);
    this.court = { receptive: 0, orient: 0, song: false, held: false };
    this.roam = 11;                                // she ranges over the fruit and the food around it (flag.js keeps to 3 mm)
  }
  // the page is one column made for phones: the view is nearly square there, a little wider on a big screen
  resize() {
    if (!this.ready) return;
    const w = this.canvas.clientWidth || 320, h = Math.round(Math.max(240, Math.min(w * (w < 560 ? 1 : 0.75), innerHeight * 0.62)));
    this.canvas.style.height = h + 'px';
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const ref = 1.9;                               // (as flag.js: keep the horizontal field of view of a wide panel)
    this.camera.fov = w / h < ref ? 2 * Math.atan(Math.tan(16 * Math.PI / 180) * ref / (w / h)) * 180 / Math.PI : 32;
    this.camera.updateProjectionMatrix();
  }
  chooseAct() {
    const C = this.court;
    if (life.female.dead) { this.setAct('stand', 99); return; }
    if (C.held) { this.setAct('stand', 0.8); return; }                            // mating
    if ((life.female.hunger || 0) > 1 && this.goEat()) return;                     // hungry: food before anything else
    if ((C.receptive > 0.5 && C.song) || egg?.busy) { this.setAct('stand', 0.8); return; }   // standing still for a singing male, or over the fruit
    const g = egg?.goal;
    if (g) { this.setAct('walk', 1.2); this.turn = Math.atan2(Math.sin(Math.atan2(g[1] - this.y, g[0] - this.x) - this.yaw), Math.cos(Math.atan2(g[1] - this.y, g[0] - this.x) - this.yaw)); return; }
    if (C.song) {                                  // she stops and listens (turning on the spot, see listen()); now and then a step
      if (Math.random() < 0.2) { this.setAct('walk', rnd(0.5, 1.0)); this.turn = clamp(C.orient * 1.6, -1.4, 1.4); }
      else this.setAct('stand', rnd(1.0, 2.0));
      return;
    }
    super.chooseAct();
  }
  // to the nearest food, then eat it (her mouthparts work it in the 'feed' act); false if there is none
  goEat() {
    if (!foods) return false;
    const f = this.meal && this.meal.amount > 0 ? this.meal : foods.nearest(this.x, this.y);
    if (!f) return false;
    if (this.meal !== f) { if (this.meal) this.meal.eaters--; this.meal = f; f.eaters++; }
    const d = Math.hypot(f.x - this.x, f.y - this.y);
    if (d > 1.1) { this.setAct('walk', 1.2); this.turn = Math.atan2(Math.sin(Math.atan2(f.y - this.y, f.x - this.x) - this.yaw), Math.cos(Math.atan2(f.y - this.y, f.x - this.x) - this.yaw)); }
    else this.setAct('feed', 1.5);
    return true;
  }
  // she flies about when nothing holds her: not while a male courts her, not while she lays, not dead
  startFlight() {
    const courted = male?.visible && ['approach', 'tap', 'sing', 'mount', 'copulate'].includes(male.state);
    const laying = egg && ['maturing', 'seeking', 'probing', 'laying', 'rest'].includes(egg.phase);
    if (!courted && !laying && !life.female.dead && !this.meal) super.startFlight(); else this.setAct('stand', 1);
  }
}

// ------------------------------------------------------------ sound
// D. melanogaster's song, made audible: pulse song = short pulses of ~225 Hz every
// ~35 ms; sine song = a hum of ~150 Hz. (The real song is far too quiet to hear.)
// So that it sounds like a wing and not a machine: every wing stroke also pushes a puff of air (noise
// shaped to the stroke), the pitch wanders a little, no two pulses are quite alike or quite evenly spaced,
// and the whole thing is softened by a filter the way a small, close sound is.
const audio = { ctx: null, on: false, pan: null, gain: null, nextPulse: 0, hum: null, humGain: null, pulseBufs: [] };
function audioInit() {
  const ctx = audio.ctx = new AudioContext(), sr = ctx.sampleRate;
  audio.gain = ctx.createGain(); audio.gain.gain.value = 0;
  audio.pan = ctx.createStereoPanner();
  // a tiny wing heard close: little low end, the overtones and the rush of air carry it
  const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 380; high.Q.value = 0.5;
  const shine = ctx.createBiquadFilter(); shine.type = 'peaking'; shine.frequency.value = 1100; shine.Q.value = 0.8; shine.gain.value = 7;
  const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 5000; low.Q.value = 0.3;
  audio.gain.connect(high).connect(shine).connect(low).connect(audio.pan).connect(ctx.destination);
  // air: white noise, low-passed only slightly (one pole), for the hiss of each stroke
  const airNoise = () => { let y = 0; return () => (y += 0.7 * ((Math.random() * 2 - 1) - y)); };
  // pulses: a few wing strokes of about 225 Hz under a quick swell and fade; a dozen variants to pick from
  for (let v = 0; v < 12; v++) {
    const n = Math.round(sr * 0.03), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), air = airNoise();
    const f = 225 * (0.9 + Math.random() * 0.2), peak = 0.008 + Math.random() * 0.004, width = 0.0032 + Math.random() * 0.0015;
    let ph = Math.random() * 6.28, max = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, env = Math.exp(-(((t - peak) / (t < peak ? width * 0.7 : width * 1.4)) ** 2));
      ph += 2 * Math.PI * f * (1 - 0.06 * (t - peak) / 0.01) / sr;   // the pitch sags a touch through the pulse
      const stroke = Math.sin(ph), puff = Math.abs(Math.sin(ph / 2)) ** 3;   // air moves most at the middle of each stroke
      d[i] = env * (0.3 * stroke + 0.3 * Math.sin(2 * ph + 0.7) + 0.2 * Math.sin(3 * ph + 1.9) + 0.12 * Math.sin(4 * ph + 0.3) + 0.55 * air() * puff);
      max = Math.max(max, Math.abs(d[i]));
    }
    for (let i = 0; i < n; i++) d[i] /= max;
    audio.pulseBufs.push(buf);
  }
  // hum: 3 s of wing vibrating at about 150 Hz, the pitch and loudness wandering, air puffing with each stroke; looped
  const n = sr * 3, hb = ctx.createBuffer(1, n, sr), h = hb.getChannelData(0), air = airNoise(), fade = Math.round(sr * 0.08);
  let ph = 0, drift = 0, amp = 1, max = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    drift += (Math.random() * 2 - 1) * 0.02 - drift * 0.0004;                 // a slow random wander in pitch
    const f = 150 + 5 * Math.sin(2 * Math.PI * t / 3 * 2) + drift * 3 + 2 * Math.sin(2 * Math.PI * 7 * t);
    ph += 2 * Math.PI * f / sr;
    amp += ((0.75 + 0.25 * Math.sin(2 * Math.PI * t / 3 * 4 + 1) + (Math.random() - 0.5) * 0.4) - amp) * 0.0008;
    const puff = Math.abs(Math.sin(ph / 2)) ** 3;
    h[i] = amp * (0.25 * Math.sin(ph) + 0.28 * Math.sin(2 * ph + 0.4) + 0.2 * Math.sin(3 * ph + 1.1) + 0.12 * Math.sin(4 * ph + 2.2) + 0.08 * Math.sin(5 * ph + 0.9) + 0.5 * air() * puff);
    max = Math.max(max, Math.abs(h[i]));
  }
  for (let i = 0; i < fade; i++) { const k = i / fade; h[n - fade + i] = h[n - fade + i] * (1 - k) + h[i] * k; }   // the loop joins without a click
  for (let i = 0; i < n; i++) h[i] /= max;
  audio.hum = ctx.createBufferSource(); audio.hum.buffer = hb; audio.hum.loop = true; audio.hum.loopStart = fade / sr; audio.hum.loopEnd = 3;
  audio.humGain = ctx.createGain(); audio.humGain.gain.value = 0;
  audio.hum.connect(audio.humGain).connect(audio.gain); audio.hum.start();
  setInterval(audioTick, 50);
}
function currentSong() {
  if (st.mode === 'male') return male?.singing ? male.songType : 'off';
  return st.song;
}
function audioTick() {
  const ctx = audio.ctx, now = ctx.currentTime, song = audio.on ? currentSong() : 'off';
  audio.pan.pan.setTargetAtTime(clamp(st.side, -1, 1), now, 0.05);
  audio.gain.gain.setTargetAtTime(audio.on ? 0.3 * clamp(st.gain, 0.15, 1) : 0, now, 0.05);   // a fly's wing is a small sound
  audio.humGain.gain.setTargetAtTime(song === 'sine' ? 0.4 : 0, now, 0.06);
  if (song !== 'pulse') { audio.nextPulse = 0; return; }
  if (audio.nextPulse < now) audio.nextPulse = now + 0.02;
  while (audio.nextPulse < now + 0.15) {                 // schedule a little ahead, about 35 ms apart (never quite even)
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = audio.pulseBufs[Math.floor(Math.random() * audio.pulseBufs.length)];
    s.playbackRate.value = 0.97 + Math.random() * 0.06;
    g.gain.value = 0.55 + Math.random() * 0.35;
    s.connect(g).connect(audio.gain); s.start(audio.nextPulse);
    audio.nextPulse += 0.035 * (0.92 + Math.random() * 0.16);
  }
}

// ------------------------------------------------------------ brain
const worker = new Worker(new URL('./brain-worker.js?v=3', import.meta.url), { type: 'module' });
let sent = '';
function send() {
  const S = STATUS[st.status], song = currentSong();
  const pc1 = S.base + (song !== 'off' && st.assist ? Math.round(S.song * clamp(st.gain, 0, 1)) : 0);
  const msg = { type: 'set', song, side: +st.side.toFixed(2), gain: +st.gain.toFixed(2), pc1, smp550: egg ? egg.smp550 : 0 };
  const key = JSON.stringify(msg);
  if (key !== sent) { worker.postMessage(msg); sent = key; }
}
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    const total = m.total || 29901431;
    $('#load').textContent = m.phase === 'download' ? `脳を読み込み中 ${(m.loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(0)} MB` : '脳を展開中…';
  } else if (m.type === 'ready') {
    ready = true; $('#load').hidden = true; send();
    const sb = $('#startbtn'); if (sb && fly) { sb.disabled = false; sb.textContent = '▶ 開始'; }
  } else if (m.type === 'error') {
    $('#load').textContent = '脳を読み込めなかった: ' + m.message;
  } else if (m.type === 'tick') {
    for (const [g, n] of Object.entries(m.counts)) {
      const hz = n / (m.ms / 1000);
      rate[g] = rate[g] == null ? hz : rate[g] + (hz - rate[g]) * 0.12;
    }
    hist.push({ vpoDN: rate.vpoDN, pC1: rate.pC1, oviDNa: rate.oviDNa, song: currentSong() !== 'off' });
    if (hist.length > 240) hist.shift();
    behave();
  }
};
worker.postMessage({ type: 'init' });

// the female's brain -> her body
function behave() {
  if (!fly) return;
  const C = fly.court;
  C.receptive = clamp((rate.vpoDN || 0) / RECEPTIVE_HZ, 0, 1.5);
  C.orient = clamp(((rate.orientL || 0) - (rate.orientR || 0)) / 20, -1, 1);     // more on the left -> turn left
  C.song = currentSong() !== 'off';
  C.held = !!male && male.visible && (male.state === 'copulate' || (male.state === 'mount' && male.stateT > 0.5));
  const hungry = (life.female.hunger || 0) > 1 && fly.meal;
  if ((C.held || (C.receptive > 0.5 && C.song && !hungry)) && fly.act === 'walk') fly.setAct('stand', 0.8);
}

// ------------------------------------------------------------ every frame
let lastT = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now(), clock = Math.min(0.5, (now - lastT) / 1000), dt = Math.min(0.05, clock);
  lastT = now;
  if (st.mode === 'male' && male?.ready && male.visible && fly) {
    if (life.female.dead && ['approach', 'tap', 'sing', 'mount'].includes(male.state)) male.set('wander');   // no courting the dead
    // while she is off to eat because she is hungry, she is not standing for him, whatever vpoDN did a moment ago
    const offToEat = (life.female.hunger || 0) > 1 && fly.meal && !fly.court.held;
    male.step(dt, offToEat ? 0 : fly.court.receptive, st.status === 'mated', clock);
    const s = male.songFor();
    st.side = s.side; st.gain = s.gain;
  }
  if (!started) { if (ready) send(); drawBars(); drawTrace(); return; }   // waiting for the start button
  if (fly && ready) tickLife(clock);
  if (egg && fly) { if (!life.female.dead) egg.step(clock, rate.oviDNa || 0, life.extinct ? 0 : clock / life.dayS, life.female.age); egg.growth.step(clock, life.extinct ? 0 : clock / life.dayS); }
  stepHearts(clock);
  stepBubble();
  loveHearts(clock);
  if (fly) listen(clock);
  if (foods) { foods.step(clock); if (fly && !life.female.dead) feedFemale(clock); }
  if (ready) send();
  drawBars(); drawTrace();
}

// the mother eats when hungry (the walking and the 'feed' act come from chooseAct above)
function feedFemale(clock) {
  life.female.hunger = (life.female.hunger ?? 0.3) + clock / HUNGRY_S;
  if (life.female.hunger > 1 && !fly.meal && !fly.court.held && fly.actT > 0.3) fly.actT = 0.3;   // hungry: decide again soon
  const f = fly.meal;
  if (!f) return;
  if (f.amount <= 0) { fly.meal = null; return; }
  const d = Math.hypot(f.x - fly.x, f.y - fly.y);
  if (fly.act === 'walk') fly.turn = Math.atan2(Math.sin(Math.atan2(f.y - fly.y, f.x - fly.x) - fly.yaw), Math.cos(Math.atan2(f.y - fly.y, f.x - fly.x) - fly.yaw));
  if (fly.act === 'feed' && d < 1.4) {
    if (!foods.eat(f, clock)) { life.female.hunger = 0; f.eaters = Math.max(0, f.eaters - 1); fly.meal = null; fly.setAct('stand', 0.5); }   // eaten up: full
  }
}

const ALL_VIEW_ANG = -2.2;                      // the overview camera's fixed direction
const view = { zoom: 1 };                       // wheel / pinch / the +- buttons: <1 closer, >1 further
const setZoom = (z) => { view.zoom = clamp(z, 0.3, 3); };

// hearts drifting up from a pair that has just started to mate
const hearts = [];
let heartTex = null;
function heartTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 70); g.scale(2.6, 2.6);
  g.beginPath(); g.moveTo(0, 12); g.bezierCurveTo(-24, -4, -12, -22, 0, -10); g.bezierCurveTo(12, -22, 24, -4, 0, 12); g.closePath();
  g.shadowColor = 'rgba(255,90,140,0.9)'; g.shadowBlur = 6;
  const gr = g.createLinearGradient(0, -20, 0, 12); gr.addColorStop(0, '#ff9cc0'); gr.addColorStop(1, '#ff3d7f');
  g.fillStyle = gr; g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function burstHearts(pos) { floaters(pos, heartTex ??= heartTexture(), 5); chime(); }
// while a pair is mating, a heart or two keeps drifting up from them (quietly; the chime is for the start)
const LOVE_EVERY_S = 1.1;
function loveHearts(dt) {
  const beat = (who, pos) => {
    who.loveT = (who.loveT ?? 0) + dt;
    if (who.loveT < LOVE_EVERY_S) return;
    who.loveT = 0;
    floaters(pos, heartTex ??= heartTexture(), 1 + (Math.random() < 0.5 ? 1 : 0), 0.4 + Math.random() * 0.25);
  };
  if (male?.visible && male.state === 'copulate' && fly) beat(male, new THREE.Vector3(fly.x, fly.y, fly.z0 + 1.6));
  else if (male) male.loveT = 0;
  if (egg) for (const o of egg.growth.list) {
    if (o.sex === 'male' && o.beh === 'copulate' && o.mate) beat(o, new THREE.Vector3(o.mate.ax, o.mate.ay, (o.mate.z0 || 0) + 1.5));
    else o.loveT = 0;
  }
}
// a skull rising from a fly that has just died
let skullTex = null;
function skullTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 6; g.fillStyle = '#f4f1ea';
  g.beginPath(); g.arc(64, 54, 36, Math.PI * 0.9, Math.PI * 2.1); g.lineTo(88, 88); g.lineTo(40, 88); g.closePath(); g.fill();   // cranium and jaw
  g.fillRect(44, 84, 40, 16);
  g.shadowBlur = 0; g.fillStyle = '#1b1f26';
  g.beginPath(); g.ellipse(50, 58, 10, 12, 0, 0, Math.PI * 2); g.ellipse(78, 58, 10, 12, 0, 0, Math.PI * 2); g.fill();          // eye sockets
  g.beginPath(); g.moveTo(64, 70); g.lineTo(58, 80); g.lineTo(70, 80); g.closePath(); g.fill();                                        // nose
  for (let x = 50; x <= 78; x += 7) g.fillRect(x, 88, 2.5, 12);                                                                         // teeth
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function showDeath(pos) { floaters(pos, skullTex ??= skullTexture(), 1, 1.1); knell(); }
// eggs with a sparkle rising from a female laying her clutch
let layTex = null;
function layTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  // an egg, narrow end up, glowing warm
  g.save(); g.translate(58, 70);
  g.beginPath(); g.moveTo(0, -42); g.bezierCurveTo(26, -42, 36, 2, 34, 16); g.bezierCurveTo(32, 36, 16, 44, 0, 44);
  g.bezierCurveTo(-16, 44, -32, 36, -34, 16); g.bezierCurveTo(-36, 2, -26, -42, 0, -42); g.closePath();
  g.shadowColor = 'rgba(255,210,90,0.95)'; g.shadowBlur = 14;
  const gr = g.createRadialGradient(-10, -12, 4, 0, 6, 48); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.6, '#fbf3dc'); gr.addColorStop(1, '#e8cf8e');
  g.fillStyle = gr; g.fill();
  g.shadowBlur = 0; g.lineWidth = 3; g.strokeStyle = '#d9a93a'; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.ellipse(-13, -16, 6, 11, -0.4, 0, Math.PI * 2); g.fill();   // shine
  g.restore();
  // sparkles
  const star = (x, y, r) => { g.beginPath(); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, q = k % 2 ? r * 0.28 : r; g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); } g.closePath(); g.fill(); };
  g.fillStyle = '#fff3a8'; g.shadowColor = 'rgba(255,220,80,1)'; g.shadowBlur = 8;
  star(104, 26, 16); star(98, 66, 9); star(18, 30, 8);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function showLaying(pos) { floaters(new THREE.Vector3(pos.x, pos.y, (pos.z || 0) + 0.8), layTex ??= layTexture(), 3, 0.9); }
function floaters(pos, tex, count, size = 0) {
  for (let k = 0; k < count; k++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.position.copy(pos); sp.renderOrder = 20;
    fly.scene.add(sp);
    hearts.push({ sp, t: -k * 0.25, x: pos.x, y: pos.y, z: pos.z, ph: Math.random() * 6, dx: (Math.random() - 0.5) * (count > 1 ? 1.2 : 0.2), size: size || 0.45 + Math.random() * 0.3, slow: count === 1 });
  }
}
function stepHearts(dt) {
  if (window.__heartsHeld) return;               // (for looking at them)
  for (const h of [...hearts]) {
    h.t += dt;
    const u = Math.max(0, h.t) / (h.slow ? 3.6 : 3);
    h.sp.visible = h.t > 0;
    h.sp.position.set(h.x + h.dx * u + Math.sin(h.ph + h.t * 3) * 0.25, h.y + Math.cos(h.ph + h.t * 2.5) * 0.2, h.z + u * 3.2);
    const s = h.size * (0.6 + 0.5 * Math.min(1, u * 4));
    h.sp.scale.set(s, s, 1);
    h.sp.material.opacity = Math.min(1, u * 6) * Math.max(0, 1 - Math.max(0, u - 0.6) / 0.4);
    if (u >= 1) { fly.scene.remove(h.sp); hearts.splice(hearts.indexOf(h), 1); }
  }
}
// a bright little rising chime for a mating
function chime() {
  if (!audio.on || !audio.ctx) return;
  const ctx = audio.ctx, t0 = ctx.currentTime;
  [[1047, 0], [1319, 0.1], [1568, 0.2]].forEach(([f, dt]) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
    o.connect(g).connect(ctx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.4);
  });
}
// a slow falling three notes when a fly dies
function knell() {
  if (!audio.on || !audio.ctx) return;
  const ctx = audio.ctx, t0 = ctx.currentTime;
  [[587, 0], [466, 0.28], [349, 0.56]].forEach(([f, dt], i) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
    const v = ctx.createOscillator(), vg = ctx.createGain(); v.frequency.value = 6; vg.gain.value = 5; v.connect(vg).connect(o.frequency);   // a little vibrato
    const len = i === 2 ? 0.9 : 0.34;
    g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.22, t0 + dt + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + len);
    o.connect(g).connect(ctx.destination); o.start(t0 + dt); o.stop(t0 + dt + len + 0.05); v.start(t0 + dt); v.stop(t0 + dt + len + 0.05);
  });
}
// a soft "pon" as food is put down with a tap
function feedSound() {
  if (!audio.on || !audio.ctx) return;
  const ctx = audio.ctx, t = ctx.currentTime;
  for (const [f0, f1, dt, v] of [[520, 780, 0, 0.3], [780, 1170, 0.07, 0.18]]) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t + dt); o.frequency.exponentialRampToValueAtTime(f1, t + dt + 0.06);
    g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(v, t + dt + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.22);
    o.connect(g).connect(ctx.destination); o.start(t + dt); o.stop(t + dt + 0.25);
  }
}

// a very short "pok" per egg, pitch wandering a little so a run of them sounds like a run
function plop() {
  if (!audio.on || !audio.ctx) return;
  const ctx = audio.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  const f = 1100 * (0.85 + Math.random() * 0.3);
  o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.035);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.05);
}

function popCount(sel, n) {
  const el = $(sel), b = el.querySelector('b');
  if (b.textContent === String(n)) return;
  const up = n > Number(b.textContent);
  b.textContent = n;
  el.classList.toggle('many', n >= 100);   // three digits and up: a smaller number
  el.classList.remove('up', 'down'); void el.offsetWidth; el.classList.add(up ? 'up' : 'down');
}

// days go by: the parents age and, in time, die
function tickLife(clock) {
  if (life.female.dead) life.female.deadT += clock;   // (the falling-over keeps going even once the day clock stops)
  // everyone gone: the clock stops where it is
  if (!life.extinct && life.female.dead && (life.male.dead || !male?.visible) && !(egg && egg.growth.alive())) {
    life.extinct = true;
    $('#day').textContent = `全滅（${Math.floor(life.day) + 1} 日目）`;
  }
  if (life.extinct) return;
  const days = clock / life.dayS;
  life.day += days;
  for (const who of ['female', 'male']) {
    const L = life[who];
    if (L.dead) continue;
    L.age += days;
    const hunger = who === 'female' ? life.female.hunger : male?.visible ? male.hunger : 0;
    if ((hunger || 0) >= STARVE) L.cause = 'starved';
    if (L.age >= L.span || L.cause === 'starved') {
      L.dead = true; L.deadT = 0;
      if (who === 'female') showDeath(new THREE.Vector3(fly.x, fly.y, 1.6)); else if (male?.visible) showDeath(new THREE.Vector3(male.x, male.y, 1.4));
      if (who === 'female') { egg?.halt(); fly.setAct('stand', 99); }
      else male?.die();
    }
  }
  $('#day').textContent = `${Math.floor(life.day) + 1} 日目`;
  const hungerText = (h) => (h > 1 ? `・空腹 ${Math.round(100 * Math.min(1, (h - 1) / (STARVE - 1)))}%` : '');
  const ageText = (L, h) => (L.dead ? (L.cause === 'starved' ? `餓死（${Math.floor(L.age)} 日）` : `死んだ（${Math.round(L.span)} 日で寿命）`) : `${Math.floor(L.age)} 日（寿命目安 ${Math.round(L.span)} 日）${hungerText(h || 0)}`);
  $('#ages').textContent = `最初のメス ${ageText(life.female, life.female.hunger)}　最初のオス ${ageText(life.male, male?.hunger)}`;
  // how many of each are alive on screen (the first pair and their grown young), popping when it changes
  const gc = egg ? egg.growth.counts() : { female: 0, male: 0, egg: 0, pupa: 0 };
  popCount('#nf', (life.female.dead ? 0 : 1) + gc.female);
  popCount('#nm', (life.male.dead || !male?.visible ? 0 : 1) + gc.male);
  popCount('#ne', gc.egg);   // eggs lying there now, not yet hatched
  popCount('#np', (gc.larva || 0) + gc.pupa);   // pupae and larvae together
  recordPop(); 
  if (egg) {
    const c = egg.growth.counts(), n = egg.count;
    $('#kids').textContent = n ? ` 卵 ${c.egg}・幼虫 ${c.larva}・さなぎ ${c.pupa}・画面の成虫 ${c.adult}（メス ${c.female}・オス ${c.male}）${c.dispersed ? `・飛び去った ${c.dispersed}` : ''}・死んだ ${c.dead}（孵化せず ${c.unhatched}${c.cannibal ? `・幼虫どうしの共食い ${c.cannibal}` : ''}・幼虫の過密 ${c.crowded}・餓死 ${c.starved}）${c.onCorpse ? `・死骸を食べている幼虫 ${c.onCorpse}` : ''}　第 ${c.gen} 世代まで・子同士の交尾 ${c.matings} 回（最初の母が産んだ卵 ${n} 個）` : 'まだ卵は産まれていない';
  }
}

// She listens: her head turns toward the song and the aristae of her antennae (the feathery
// tips that catch the sound and drive Johnston's organ) vibrate with it. Her body turns toward
// it on the spot, by the brain's DNp12 left-right difference. Applied right before each render.
const listenSt = { head: 0, ar: 0 };
function listen(clock) {
  const C = fly.court, song = currentSong(), on = song !== 'off' && !life.female.dead && !C.held;
  // where the song comes from, relative to her heading (left positive)
  const rel = st.mode === 'male' && male?.visible ? Math.atan2(Math.sin(Math.atan2(male.y - fly.y, male.x - fly.x) - fly.yaw), Math.cos(Math.atan2(male.y - fly.y, male.x - fly.x) - fly.yaw)) : -st.side * Math.PI / 2;
  listenSt.head += ((on ? clamp(rel, -0.55, 0.55) : 0) - listenSt.head) * Math.min(1, clock * 4);
  listenSt.ar += ((on ? clamp(st.gain, 0.2, 1) : 0) - listenSt.ar) * Math.min(1, clock * 6);
  if (on && fly.act !== 'walk' && !egg?.busy && Math.abs(C.orient) > 0.08) fly.yaw += clamp(C.orient, -1, 1) * 0.9 * clock;
}
function poseListening() {
  const j = fly.body.joints, t = performance.now() / 1000, a = listenSt.ar;
  if (j['c_thorax-c_head-yaw']) j['c_thorax-c_head-yaw'].q += listenSt.head;
  if (a < 0.01) return;
  const song = currentSong(), buzz = song === 'pulse' ? ((t * 1000) % 35 < 12 ? 1 : 0.15) : 0.6;
  for (const sd of ['l', 'r']) {
    const k = sd === 'l' ? 1 : -1;
    if (j[`${sd}_funiculus-${sd}_arista-yaw`]) j[`${sd}_funiculus-${sd}_arista-yaw`].q = k * 0.35 * a * buzz * Math.sin(t * 2 * Math.PI * 27 + k);
    if (j[`c_head-${sd}_pedicel-pitch`]) j[`c_head-${sd}_pedicel-pitch`].q = -0.25 * a;        // antennae raised, forward
    if (j[`c_head-${sd}_pedicel-yaw`]) j[`c_head-${sd}_pedicel-yaw`].q = 0.18 * a * Math.sign(listenSt.head || k);
  }
}

const sideText = (s) => (s < -0.25 ? '左から' : s > 0.25 ? '右から' : '正面・後ろから');

// ------------------------------------------------------------ the panel
function drawBars() {
  if (document.body.dataset.tab === 'brain') $('#bars').innerHTML = ROWS.map(([g, label, note, full]) => {
    const v = rate[g] || 0;
    return `<div class="row"><div class="lab"><b>${label}</b>${note ? `<small>${note}</small>` : ''}</div>` +
      `<div class="bar"><i class="${g}" style="width:${(100 * clamp(v / full, 0, 1)).toFixed(1)}%"></i></div><em>${v.toFixed(0)} Hz</em></div>`;
  }).join('');
  const r = clamp((rate.vpoDN || 0) / RECEPTIVE_HZ, 0, 1), song = currentSong();
  const eggText = egg && egg.phase !== 'off' ? `${EGG_TEXT[egg.phase]}（産んだ卵 ${egg.count} 個）` : '';
  const fem = !ready ? '脳を読み込み中' : life.female.dead ? (life.female.cause === 'starved' ? '餓死した' : `死んだ（${Math.round(life.female.span)} 日の寿命）`)
    : (life.female.hunger || 0) > 1 && fly?.meal && !fly.court.held ? (fly.act === 'feed' ? '餌を食べている（空腹なので最優先）' : '空腹で餌へ向かっている（最優先）') : fly?.court.held ? 'オスを受け入れて止まっている'
    : eggText && !(song !== 'off' && egg.phase === 'maturing') ? eggText
    : r >= 1 ? '立ち止まっている（受け入れの指令 vpoDN が出ている）'
    : song !== 'off' ? (Math.abs(fly?.court.orient || 0) > 0.15 ? '歌の方へ向き直って聴いている' : '立ち止まって歌を聴いている') : 'ふつうに過ごしている';
  $('#state').innerHTML = `<i class="sx f"></i>`; $('#state').append(fem);
  $('#state').className = 'state' + (r >= 1 || fly?.court.held ? ' on' : song !== 'off' ? ' listen' : '');
  const ms = $('#mstate');
  if (st.mode === 'male' && male?.visible) {
    let t = MALE_STATE_TEXT[male.state] || '';
    if (male.state === 'sing') t += male.songType === 'sine' ? '（正弦歌）' : '（パルス歌）';
    if (male.state === 'copulate') t += `（実際は約 20 分。ここでは ${COPULATE_S} 秒 — 残り ${Math.max(0, Math.ceil(COPULATE_S - male.stateT))} 秒）`;
    ms.innerHTML = `<i class="sx m"></i>`; ms.append(t); ms.hidden = false;
  } else ms.hidden = true;
}
// The male runs on a script, not a brain. For his current behaviour, light the neurons that experiments
// show are at work in a real courting male (not simulated firing).
const MALE_BRAIN = [
  ['LC10a', '視覚の追跡', 'メスを目で追う', ['approach', 'tap', 'sing']],
  ['ppk23', '前脚の味覚', 'メスのフェロモン 7,11-HD を味で感じる', ['tap', 'mount']],
  ['P1', '求愛の司令', 'オス特有。匂い・味・視覚をまとめて求愛を始める', ['approach', 'tap', 'sing', 'mount']],
  ['pIP10', '歌の下行性', '脳から胸へ「歌え」を送る', ['sing']],
  ['vPR6 など', '歌の回路（胸部）', '翅を震わせて歌のパルスを作る', ['sing']],
  ['Crz', '交尾の長さ（腹部）', '交尾を続ける時間と精子の受け渡し', ['copulate']],
];
function drawMaleBrain() {
  const s = male?.visible && !male.dead ? male.state : male?.dead ? 'dead' : 'hidden';
  if (s === drawMaleBrain.last) return;   // (only when it changes, so the glow keeps going)
  drawMaleBrain.last = s;
  $('#mbars').innerHTML = MALE_BRAIN.map(([name, label, note, states]) => {
    const on = states.includes(s);
    return `<div class="mrow${on ? ' on' : ''}"><div class="lab"><b>${label} ${name}</b><small>${note}</small></div><div class="lamp"><i></i></div><em>${on ? '働く' : '—'}</em></div>`;
  }).join('');
  $('#mbnote').textContent = s === 'dead' ? 'オスは死んでいる' : s === 'hidden' ? 'オスはまだいない' : `いまのオス: ${MALE_STATE_TEXT[s] || s}`;
}
// ------------------------------------------------------------ a fly's brain, in a bubble over it
// Tap a fly: a small bubble follows it. The first female's is her simulated brain; the others run on a
// script or rules, so theirs says which known neurons their current behaviour uses (not computed).
let bubbleTop = 6;
const bubbles = new Map();   // fly -> { el, body, drawn }: one bubble per tapped fly, each closed by its own ×
const flyPoint = (w) => (w === 'female' ? (life.female.dead && !fly.body.root.visible ? null : [fly.x, fly.y, 0.9])
  : w === 'male' ? (male?.visible ? [male.x, male.y, 0.8] : null)
  : w.stage === 'adult' || (w.stage === 'dead' && w.adult) ? [w.ax, w.ay, 0.7] : null);
function pickFly(px, py, r) {
  const cands = ['female', 'male', ...(egg ? egg.growth.list : [])];
  let best = null, bd = 44;
  for (const w of cands) {
    const p = flyPoint(w); if (!p) continue;
    const v = new THREE.Vector3(...p).project(fly.camera), x = (v.x + 1) / 2 * r.width, y = (1 - v.y) / 2 * r.height, d = Math.hypot(x - px, y - py);
    if (v.z < 1 && d < bd) { bd = d; best = w; }
  }
  if (!best) return false;
  if (bubbles.has(best)) closeBubble(best);   // tapping it again takes its bubble away
  else openBubble(best);
  return true;
}
function openBubble(w) {
  const el = document.createElement('div'), head = document.createElement('div'), pic = document.createElement('canvas'), body = document.createElement('div'), x = document.createElement('button');
  head.className = 't'; pic.className = 'bpic';
  el.className = 'flybub'; x.className = 'bx'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', '閉じる');
  x.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('pointerdown', () => { el.style.zIndex = String(++bubbleTop); });   // a tap on a bubble brings it to the front
  el.style.zIndex = String(++bubbleTop);
  x.addEventListener('click', (e) => { e.stopPropagation(); closeBubble(w); });
  el.append(x, head, pic, body);
  $('.stage').append(el);
  const B = { el, head, pic, body, drawn: 0, lights: {}, pinned: null };
  bubbles.set(w, B);
  // drag it anywhere on the view; once moved it stays there, with a line back to its fly
  let grab = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target === x) return;
    e.stopPropagation(); e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect(), sr = fly.renderer.domElement.getBoundingClientRect();
    grab = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: r.left - sr.left + r.width / 2, top: r.top - sr.top, moved: false };   // (its centre-top, in the view)
  });
  el.addEventListener('pointermove', (e) => {
    if (!grab || e.pointerId !== grab.id) return;
    const ddx = e.clientX - grab.sx, ddy = e.clientY - grab.sy;
    if (!grab.moved && Math.hypot(ddx, ddy) < 4) return;
    grab.moved = true;
    const c = fly.renderer.domElement, hw = el.offsetWidth / 2;
    B.pinned = { left: clamp(grab.left + ddx, hw, c.clientWidth - hw), top: clamp(grab.top + ddy, 0, Math.max(0, c.clientHeight - el.offsetHeight)) };   // kept inside the view
    drawBubble(w);
  });
  const release = (e) => { if (grab && e.pointerId === grab.id) grab = null; };
  el.addEventListener('pointerup', release); el.addEventListener('pointercancel', release);
  el.style.touchAction = 'none';
  stepBubble();
}
function closeBubble(w) { const b = bubbles.get(w); if (!b) return; b.el.remove(); b.line?.remove(); bubbles.delete(w); }
// The brain picture the top page uses: every FlyWire neuron as a faint dot at its soma position (flybrain/data/pos783),
// with the cells of each group drawn over it in colour, brighter the harder they fire (0..1). Front view, dorsal up.
const brainPic = { xs: null, ys: null, groups: null, bases: new Map() };
(async () => {
  const [pos, court, maleG] = await Promise.all([
    fetch(new URL('../flybrain/data/pos783.bin.gz?v=1', import.meta.url)).then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    fetch(new URL('./data/court783.json?v=2', import.meta.url)).then((r) => r.json()),
    fetch(new URL('./data/male783.json?v=1', import.meta.url)).then((r) => r.json()),
  ]);
  const n = new DataView(pos).getUint32(4, true);
  brainPic.xs = new Uint16Array(pos, 8, n); brainPic.ys = new Uint16Array(pos, 8 + 2 * n, n);
  brainPic.groups = { ...court.groups, ...maleG.groups };
})().catch(() => { /* no picture, the rest still works */ });
const PIC_ASPECT = 0.5, PIC_PAD = 3;
const GROUP_COLOR = { joL: '#59b7ff', joR: '#59b7ff', relay: '#59b7ff', wed104: '#ff6b6b', vpoEN: '#ffb454', pC1: '#b69cff', vpoDN: '#54d98c',
  orientL: '#8cc6ff', orientR: '#8cc6ff', smp550: '#ff8fb0', oviIN: '#ff6b6b', oviDNa: '#ff8fb0', LC10a: '#59b7ff' };
function brainBase(w, h, dpr) {             // the whole brain, dim; drawn once for each size
  const key = `${w}x${h}@${dpr}`;
  if (brainPic.bases.has(key)) return brainPic.bases.get(key);
  const c = document.createElement('canvas'); c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'), { xs, ys } = brainPic, sx = (w - 2 * PIC_PAD) / 65535 * dpr, sy = (h - 2 * PIC_PAD) / 65535 * dpr, r = Math.max(0.6, w / 700) * dpr;
  g.fillStyle = '#070a0d'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(78,92,108,.32)';
  for (let i = 0; i < xs.length; i++) g.fillRect(PIC_PAD * dpr + xs[i] * sx, PIC_PAD * dpr + ys[i] * sy, r, r);
  brainPic.bases.set(key, c);
  return c;
}
/** lights: { group: level 0..1 }; the groups listed are marked faintly even when quiet, so their place shows */
function paintBrain(c, lights) {
  const w = c.clientWidth;
  if (!w || !brainPic.xs) return;
  const dpr = Math.min(2, devicePixelRatio || 1), h = Math.round(w * PIC_ASPECT);
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; c.style.height = h + 'px'; }
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(brainBase(w, h, dpr), 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (w - 2 * PIC_PAD) / 65535, sy = (h - 2 * PIC_PAD) / 65535, { xs, ys } = brainPic;
  for (const [k, v0] of Object.entries(lights)) {
    const ids = brainPic.groups[k]; if (!ids) continue;
    const v = clamp(v0, 0, 1), few = ids.length <= 12, r = Math.max(0.9, w / 260) * (few ? 2 : 1) * (1 + 0.8 * v);
    g.fillStyle = GROUP_COLOR[k] || '#59b7ff';
    if (few && v > 0.05) {                     // a handful of cells: a soft glow so they can be seen at all
      g.globalAlpha = 0.35 * v; g.beginPath();
      for (const i of ids) { const x = PIC_PAD + xs[i] * sx, y = PIC_PAD + ys[i] * sy; g.moveTo(x + r * 2.4, y); g.arc(x, y, r * 2.4, 0, 6.2832); }
      g.fill();
    }
    g.globalAlpha = 0.22 + 0.78 * v; g.beginPath();
    for (const i of ids) { const x = PIC_PAD + xs[i] * sx, y = PIC_PAD + ys[i] * sy; g.moveTo(x + r, y); g.arc(x, y, r, 0, 6.2832); }
    g.fill();
  }
  g.globalAlpha = 1;
}
const femaleLights = () => Object.fromEntries(ROWS.map(([k, , , full]) => [k, life.female.dead ? 0 : (rate[k] || 0) / full]));
const maleLights = (state, dead) => { const n = dead ? [] : neuronsFor(state); return { LC10a: n.includes('LC10a') ? 1 : 0, pC1: n.includes('P1') ? 1 : 0 }; };
const neuronsFor = (state) => MALE_BRAIN.filter(([, , , st]) => st.includes(state)).map(([n]) => n);
const bar = (label, v, full, color) => `<div class="r"><span>${label}</span><i><s style="width:${(100 * clamp(v / full, 0, 1)).toFixed(0)}%;background:${color}"></s></i><em>${v.toFixed(0)}Hz</em></div>`;
function stepBubble() { for (const w of [...bubbles.keys()]) drawBubble(w); }
function drawBubble(w) {
  const B = bubbles.get(w), el = B.el;
  const p = flyPoint(w);
  if (!p) { closeBubble(w); return; }   // its body is gone
  const v = new THREE.Vector3(...p).project(fly.camera), c = fly.renderer.domElement;
  const bx = ((v.x + 1) / 2) * c.clientWidth, by = ((1 - v.y) / 2) * c.clientHeight, half = el.offsetWidth / 2;
  if (B.pinned) {                          // moved by hand: it stays put, and a line joins it to its fly
    el.style.left = `${B.pinned.left}px`; el.style.top = `${B.pinned.top}px`;
    el.classList.add('pinned'); el.classList.remove('below');
    const ns = 'http://www.w3.org/2000/svg';
    if (!B.line) { B.line = document.createElementNS(ns, 'svg'); B.line.setAttribute('class', 'bubline'); B.line.innerHTML = '<line/><circle r="2.5"/>'; $('.stage').append(B.line); }
    const r = el.getBoundingClientRect(), sr = c.getBoundingClientRect(), ex = clamp(bx, r.left - sr.left, r.right - sr.left), ey = clamp(by, r.top - sr.top, r.bottom - sr.top);
    const L = B.line.firstChild, dot = B.line.lastChild;
    L.setAttribute('x1', ex); L.setAttribute('y1', ey); L.setAttribute('x2', bx); L.setAttribute('y2', by);
    dot.setAttribute('cx', bx); dot.setAttribute('cy', by);
    B.line.style.zIndex = el.style.zIndex;
  } else {
    el.style.left = `${Math.min(Math.max(bx, half + 4), c.clientWidth - half - 4)}px`; el.style.top = `${by}px`;
    el.style.setProperty('--tail', `${Math.round(bx - Math.min(Math.max(bx, half + 4), c.clientWidth - half - 4))}px`);   // the tail still points at the fly
    el.classList.toggle('below', by - el.offsetHeight - 14 < 0);   // no room above it: under the fly instead
  }
  paintBrain(B.pic, B.lights);
  if (performance.now() - B.drawn < 250) return;   // the text a few times a second
  B.drawn = performance.now();
  const F = '<i class="sx f"></i>', M = '<i class="sx m"></i>';
  const dead = w === 'female' ? life.female.dead : w === 'male' ? male.dead : w.stage === 'dead';
  let head, html;
  if (w === 'female') {
    B.lights = femaleLights();
    head = `${F}最初のメス <span class="d">全脳を計算中</span>`;
    html = dead ? '<div class="d">死んでいる</div>'
      : bar('受入 vpoDN', rate.vpoDN || 0, 30, '#54d98c') + bar('意欲 pC1', rate.pC1 || 0, 30, '#b69cff') + bar('産卵 oviDNa', rate.oviDNa || 0, 12, '#ff8fb0');
  } else if (w.sex === 'male' || w === 'male') {
    const st = w === 'male' ? male.state : { approach: 'approach', sing: 'sing', mount: 'mount', copulate: 'copulate' }[w.beh], n = dead ? [] : neuronsFor(st);
    B.lights = maleLights(st, dead);
    head = `${M}${w === 'male' ? '最初のオス' : `子のオス <span class="d">第 ${w.gen} 世代</span>`}`;
    html = (dead ? '<div class="d">死んでいる</div>' : `${w === 'male' ? `<div>${MALE_STATE_TEXT[male.state] || ''}</div>` : ''}<div class="${n.length ? 'n' : 'd'}">${n.length ? `働く: ${n.join('・')}` : '求愛の回路は静か'}</div>`)
      + '<div class="d">脳は未計算。行動は決めた手順どおりで、実験で知られる細胞を光らせている（P1 はメスの脳の相同細胞 pC1 の位置）</div>';
  } else {
    const listening = ['listen', 'accept'].includes(w.beh);
    B.lights = { pC1: dead ? 0 : w.virgin ? (listening ? 0.8 : 0.2) : 0.05, vpoDN: !dead && w.virgin && listening ? 1 : 0, oviDNa: !dead && w.beh === 'lay' ? 1 : 0, smp550: !dead && w.beh === 'lay' ? 0.9 : 0, joL: listening ? 0.6 : 0, joR: listening ? 0.6 : 0 };
    const t = dead ? '死んでいる' : w.beh === 'lay' ? '産卵中: oviDNa が高い' : listening && w.virgin ? '歌で vpoDN が上がり受け入れる' : w.virgin ? '未交尾: 歌を聴けば受け入れる' : '交尾済み: vpoDN が上がらず拒む';
    head = `${F}子のメス <span class="d">第 ${w.gen} 世代</span>`;
    html = `<div class="${dead ? 'd' : 'n'}">${t}</div><div class="d">脳は未計算。最初のメスの全脳の反応を規則にして光らせている</div>`;
  }
  B.head.innerHTML = head;
  B.body.innerHTML = html;
}
function drawTrace() {
  if (document.body.dataset.tab !== 'brain') return;
  drawMaleBrain();
  paintBrain($('#fpic'), femaleLights());
  paintBrain($('#mpic'), maleLights(male?.visible && !male.dead ? male.state : null, !male || male.dead));
  const c = $('#trace'), dpr = Math.min(2, devicePixelRatio || 1);
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const top = 30, step = w / 239, off = 240 - hist.length;
  hist.forEach((p, i) => { if (p.song) { g.fillStyle = 'rgba(255,180,84,.13)'; g.fillRect((off + i) * step, 0, step + 0.6, h); } });
  g.strokeStyle = '#3a4652'; g.setLineDash([3, 3]); g.beginPath();
  const yT = h - 4 - (RECEPTIVE_HZ / top) * (h - 8); g.moveTo(0, yT); g.lineTo(w, yT); g.stroke(); g.setLineDash([]);
  for (const [key, color] of [['pC1', '#b69cff'], ['vpoDN', '#54d98c'], ['oviDNa', '#ff8fb0']]) {
    g.strokeStyle = color; g.lineWidth = 1.8; g.beginPath();
    hist.forEach((p, i) => { const x = (off + i) * step, y = h - 4 - clamp((p[key] || 0) / top, 0, 1) * (h - 8); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
}

// ------------------------------------------------------------ numbers over time
// A sample every tenth of a day of how many there are (the same counts as the boxes above the graph),
// drawn as lines; the tabs pick which. "すべて" puts adults, eggs and larvae on one log scale, as they differ a hundredfold.
const popHist = [];
const POP_SERIES = {
  adult: ['成虫', '#9be3b4'], female: ['<i class="sx f"></i>メス', '#ff9cc0'], male: ['<i class="sx m"></i>オス', '#8cc6ff'], egg: ['卵', '#f3e7c4'], larva: ['幼虫（さなぎ含む）', '#e7b77a'],
};
const POP_TABS = { all: ['adult', 'egg', 'larva'], adult: ['adult'], sex: ['female', 'male'], egg: ['egg'], larva: ['larva'] };
let popTab = 'all', popDrawnAt = 0, popGeo = null, popPick = null;
function recordPop() {
  const nf = +$('#nf b').textContent, nm = +$('#nm b').textContent;
  const sample = { day: life.day, female: nf, male: nm, adult: nf + nm, egg: +$('#ne b').textContent, larva: +$('#np b').textContent };
  const last = popHist[popHist.length - 1];
  if (!last || life.day - last.day >= 0.1) popHist.push(sample); else Object.assign(last, sample, { day: last.day });
  if (performance.now() - popDrawnAt > 300) drawPop();
}
function drawPop() {
  popDrawnAt = performance.now();
  const c = $('#popchart'), dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const keys = POP_TABS[popTab], log = popTab === 'all', L = 34, R = 10, T = 10, B = 22, pw = w - L - R, ph = h - T - B;
  const days = Math.max(5, Math.ceil(popHist.length ? popHist[popHist.length - 1].day : 0));
  let top = 1;
  for (const p of popHist) for (const k of keys) top = Math.max(top, p[k]);
  const nice = (v) => { const e = 10 ** Math.floor(Math.log10(v)), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };
  const ymax = log ? 10 ** Math.ceil(Math.log10(Math.max(10, top))) : nice(Math.max(4, top));
  const Y = (v) => T + ph - (log ? Math.log10(1 + v) / Math.log10(1 + ymax) : v / ymax) * ph;
  const X = (d) => L + (d / days) * pw;
  popGeo = { L, pw, days, T, ph, Y, keys };
  // grid and labels
  g.font = '10px system-ui, sans-serif'; g.fillStyle = '#6f7c8a'; g.strokeStyle = '#1f2831'; g.lineWidth = 1;
  const tstep = nice(ymax / 5), ticks = log ? Array.from({ length: Math.log10(ymax) + 1 }, (_, i) => (i ? 10 ** i : 0)) : Array.from({ length: Math.floor(ymax / tstep) + 1 }, (_, i) => i * tstep);
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const v of ticks) { const y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); g.fillText(v >= 1000 ? `${v / 1000}k` : String(v), L - 5, y); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  const every = days <= 10 ? 1 : days <= 30 ? 5 : days <= 80 ? 10 : 20;
  for (let d = 0; d <= days; d += every) g.fillText(`${d + 1}日`, X(d), h - B + 6);
  if (log) { g.textAlign = 'left'; g.fillText('対数目盛', L + 4, T); }
  // lines
  for (const k of keys) {
    g.strokeStyle = POP_SERIES[k][1]; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
    const stepN = Math.max(1, Math.floor(popHist.length / pw));   // no more points than pixels
    popHist.forEach((p, i) => { if (i % stepN && i !== popHist.length - 1) return; const x = X(p.day), y = Y(p[k]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  // the touched day: a line through it and dots on each series
  if (popPick != null && popHist.length) {
    const p = popHist.reduce((a, q) => (Math.abs(q.day - popPick) < Math.abs(a.day - popPick) ? q : a)), x = X(p.day);
    g.strokeStyle = 'rgba(230,238,244,.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
    for (const k of keys) { g.fillStyle = POP_SERIES[k][1]; g.beginPath(); g.arc(x, Y(p[k]), 3.5, 0, Math.PI * 2); g.fill(); }
    const tip = $('#poptip');
    tip.innerHTML = `<b>${Math.floor(p.day) + 1} 日目</b><br>` + keys.map((k) => `<i style="background:${POP_SERIES[k][1]}"></i>${POP_SERIES[k][0]} <b>${p[k]}</b>`).join('<br>');
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(4, x > w / 2 ? x - tip.offsetWidth - 10 : x + 10), w - tip.offsetWidth - 4)}px`;
  } else $('#poptip').hidden = true;
  const now = popHist[popHist.length - 1] || {};
  $('#popleg').innerHTML = keys.map((k) => `<span><i style="background:${POP_SERIES[k][1]}"></i>${POP_SERIES[k][0]} <b>${now[k] ?? 0}</b></span>`).join('');
}
document.querySelectorAll('#poptabs button').forEach((b) => b.addEventListener('click', () => {
  popTab = b.dataset.v;
  document.querySelectorAll('#poptabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  drawPop();
}));
addEventListener('resize', () => drawPop());
{ // touch or drag on the graph: show that day's numbers (a tap outside it hides them)
  const c = $('#popchart');
  const pick = (e) => { if (!popGeo) return; const r = c.getBoundingClientRect(); popPick = Math.max(0, Math.min(popGeo.days, ((e.clientX - r.left) - popGeo.L) / popGeo.pw * popGeo.days)); drawPop(); };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); pick(e); });
  c.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') pick(e); });
  c.style.touchAction = 'pan-y';
  document.addEventListener('pointerdown', (e) => { if (e.target !== c && popPick != null) { popPick = null; drawPop(); } });
}
// the buttons at the bottom tuck themselves away when nothing is touched for a while, and come back on any touch
{
  const bar = $('.tabbar'); let idle = 0;
  const wake = () => { bar.classList.remove('tuck'); clearTimeout(idle); idle = setTimeout(() => bar.classList.add('tuck'), 3500); };
  for (const ev of ['pointerdown', 'scroll', 'keydown', 'wheel']) addEventListener(ev, wake, { passive: true });
  addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && e.clientY > innerHeight - 120) wake(); }, { passive: true });
  wake();
}
// the buttons at the bottom: one screen at a time
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  document.body.dataset.tab = b.dataset.go;
  document.querySelectorAll('.tabbar button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  scrollTo(0, 0);
  if (b.dataset.go === 'play') fly?.resize();
  drawMaleBrain.last = null;
  drawPop(); drawBars(); drawTrace();
}));
drawPop();

// ------------------------------------------------------------ controls
function press(sel, v) { document.querySelectorAll(sel).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v))); }
$('#speed').addEventListener('change', (e) => { life.dayS = +e.target.value; });
$('#restart').addEventListener('click', () => location.reload());
function setSound(on) {
  if (!audio.ctx) audioInit();
  audio.ctx.resume();
  audio.on = on;
  $('#sound').innerHTML = `<i class="fa-solid ${on ? 'fa-volume-high' : 'fa-volume-xmark'}" aria-hidden="true"></i>`;
  $('#sound').setAttribute('aria-label', on ? '音: オン' : '音: オフ'); $('#sound').title = on ? '音: オン' : '音: オフ';
  $('#sound').setAttribute('aria-pressed', String(on));
}
$('#sound').addEventListener('click', () => setSound(!audio.on));
// the start button: the male comes in, the clock starts, and the sound goes on (a click is what lets a page play sound)
$('#startbtn').addEventListener('click', () => {
  if (started || !ready || !male?.ready) return;
  started = true;
  $('#start').hidden = true;
  setSound(true);
  male.show(true);
});

// ------------------------------------------------------------ start
new CourtFly($('#fly')).load().then(async (f) => {
  fly = f; window.__fly = f;
  male = new MaleFly(f); window.__male = male;
  await male.load();
  egg = new EggLaying(f); window.__egg = egg;
  foods = new Foods(f.scene, egg.site); window.__foods = foods;
  egg.growth.foods = foods; male.foods = foods;
  // the parents' bodies, once dead, lie there for larvae to find (and females to lay on)
  egg.growth.extraCorpses = () => {
    const c = [], carcass = (who, x, y, gone) => (who.carcass ??= { x, y, r: 0.9, meat: CORPSE_MEAT, n: 0, eaten: gone });
    if (life.female.dead && fly.body.root.visible) c.push(carcass(fly, fly.x, fly.y, () => { fly.body.root.visible = false; }));
    if (male.dead && male.visible) c.push(carcass(male, male.x, male.y, () => male.show(false)));
    return c;
  };

  egg.growth.onLay = (pos) => { plop(); showLaying(pos); };
  egg.growth.onMate = burstHearts; male.onMate = burstHearts;
  egg.growth.onDie = showDeath;
  // a tap (not a drag) on the view puts food down on the ground where it lands
  const canvas = f.renderer.domElement, ray = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit = new THREE.Vector3();
  let down = null;
  // zooming: the wheel, or two fingers pinching (a pinch is never taken for a tap)
  const touches = new Map();
  let pinch = null;
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(view.zoom * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  canvas.addEventListener('pointerdown', (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom }; down = null;
    } else if (touches.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      setZoom(pinch.zoom * pinch.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)));
    }
  });
  const lift = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  canvas.addEventListener('pointercancel', (e) => { lift(e); down = null; });
  canvas.addEventListener('pointerup', (e) => {
    const wasPinch = !!pinch || touches.size > 1;
    lift(e);
    if (wasPinch || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || performance.now() - down.t > 600) { down = null; return; }
    down = null;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), f.camera);
    if (pickFly(e.clientX - r.left, e.clientY - r.top, r)) return;   // a fly: show its brain in a bubble
    if (ray.ray.intersectPlane(ground, hit) && Math.hypot(hit.x, hit.y) < 40) { foods.spawn([hit.x, hit.y]); feedSound(); }
  });
  canvas.style.cursor = 'pointer';
  canvas.style.touchAction = 'none';
  $('#zoomin').addEventListener('click', () => setZoom(view.zoom / 1.25));
  $('#zoomout').addEventListener('click', () => setZoom(view.zoom * 1.25));
  window.__view = view;
  male.onCopulated = () => { st.status = 'mated'; egg.start(); };
  // keep both flies in view: the female's own camera, pulled back to take in the male
  const render = f.renderer.render.bind(f.renderer), look = { x: f.x, y: f.y, r: 0 };
  f.renderer.render = (scene, cam) => {
    if (life.female.dead) poseDying(f.body, f.x, f.y, f.yaw, f.z0, 1, life.female.deadT);
    else { poseListening(); f.body.update(); }
    if (!Number.isFinite(look.x) || !Number.isFinite(look.y)) { look.x = f.x; look.y = f.y; look.r = 0; }   // never let a bad frame stick
    const kid = life.cam === 'kids' ? egg.growth.focus() : null;
    if (life.cam === 'all') {                                    // everyone and the fruit, from above
      const pts = [[f.x, f.y]];
      if (male.visible) pts.push([male.x, male.y]);
      pts.push([egg.site.position.x, egg.site.position.y]);
      for (const o of egg.growth.list) if (o.stage !== 'gone') pts.push(o.adult && o.ax != null ? [o.ax, o.ay] : [o.x, o.y]);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.max(5, Math.hypot(x1 - x0, y1 - y0) / 2 + 3);
      // a fixed viewing angle (it does not swing round with anyone), high up; it only drifts and zooms,
      // slowly, and zooms out faster than in so no one leaves the frame
      if (look.allInit !== true) { look.x = cx; look.y = cy; look.r = R; look.allInit = true; }
      look.x += (cx - look.x) * 0.015; look.y += (cy - look.y) * 0.015;
      look.r += (R - look.r) * (R > look.r ? 0.05 : 0.008);
      const ang = ALL_VIEW_ANG, d = (look.r * 1.25 + 3) * view.zoom;
      cam.position.set(look.x + Math.cos(ang) * d, look.y + Math.sin(ang) * d, (look.r * 1.7 + 4) * view.zoom);
      cam.lookAt(look.x, look.y, 0);
    } else if (kid) {
      look.allInit = false;                                                   // follow the young one furthest along
      const kx = kid.adult && kid.ax != null ? kid.ax : kid.x, ky = kid.adult && kid.ay != null ? kid.ay : kid.y;
      look.x += (kx - look.x) * 0.06; look.y += (ky - look.y) * 0.06;
      const r = kid.adult ? 7 : kid.stage === 'egg' ? 3.2 : 5, ang = f.camAng;
      cam.position.set(look.x + Math.cos(ang) * r, look.y + Math.sin(ang) * r, r * 0.55);
      cam.lookAt(look.x, look.y, 0.2);
    } else if (male.visible) {
      const d = Math.hypot(male.x - f.x, male.y - f.y), mx = (male.x + f.x) / 2, my = (male.y + f.y) / 2;
      look.x += (mx - look.x) * 0.06; look.y += (my - look.y) * 0.06;
      look.r += (Math.min(d, 7) * 1.1 - look.r) * 0.04;
      // while he is on her back the view climbs, or he just looks to be standing behind her
      const up = male.mountW, ang = f.camAng, r = 6.4 + look.r - 1.2 * up;
      cam.position.set(look.x + Math.cos(ang) * r, look.y + Math.sin(ang) * r, 2.2 + 0.45 * look.r + 3.2 * up);
      cam.lookAt(look.x, look.y, 0.5 + 0.9 * up);
    } else { look.x = f.x; look.y = f.y; look.r = 0; }
    render(scene, cam);
  };
  if (ready) { $('#startbtn').disabled = false; $('#startbtn').textContent = '▶ 開始'; }
  requestAnimationFrame(frame);
}).catch((e) => { $('#flynote').textContent = '3D の蠅を読み込めなかった: ' + e.message; });
addEventListener('resize', () => fly?.resize());
