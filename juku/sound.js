// Sounds for the reading flies, all synthesized with WebAudio: a chime for ○,
// a low buzz for ×, a falling phrase for giving up, and the whine of the wings
// while it flies (a sawtooth at the wingbeat plus its octave, as on the other
// pages). Browsers only allow sound after a tap, so it starts on the first one.
export class Sound {
  constructor() {
    this.ctx = null;
    this.on = true;
    try { this.on = localStorage.getItem('hae-sound') !== '0'; } catch { /* no storage */ }
    const start = () => this.start();
    addEventListener('pointerdown', start, { capture: true });
    addEventListener('keydown', start, { capture: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend(); else if (this.on) this.ctx.resume();
    });
  }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && this.on && !document.hidden) this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.on ? 0.7 : 0; this.master.connect(ctx.destination);
    // the wings
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), lfo = ctx.createOscillator();
    const g2 = ctx.createGain(), lg = ctx.createGain(), filt = ctx.createBiquadFilter();
    this.buzzGain = ctx.createGain(); this.buzzGain.gain.value = 0;
    o1.type = 'sawtooth'; o2.type = 'square'; o1.frequency.value = 205; o2.frequency.value = 410.8;
    lfo.frequency.value = 6.5; lg.gain.value = 5; g2.gain.value = 0.2;
    filt.type = 'lowpass'; filt.frequency.value = 2200; filt.Q.value = 0.8;
    lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
    o1.connect(filt); o2.connect(g2); g2.connect(filt); filt.connect(this.buzzGain); this.buzzGain.connect(this.master);
    o1.start(); o2.start(); lfo.start();
    this.o1 = o1; this.o2 = o2;
  }
  setOn(on) {
    this.on = on;
    try { localStorage.setItem('hae-sound', on ? '1' : '0'); } catch { /* no storage */ }
    if (!this.ctx) { if (on) this.start(); return; }
    this.master.gain.setTargetAtTime(on ? 0.7 : 0, this.ctx.currentTime, 0.03);
    if (on) this.ctx.resume();
  }
  /** Wing whine: `level` 0..1 (how hard the wings beat), `pitch` a small offset in Hz. */
  buzz(level, pitch = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.buzzGain.gain.setTargetAtTime(0.16 * level, t, 0.05);
    this.o1.frequency.setTargetAtTime(205 + pitch, t, 0.08);
    this.o2.frequency.setTargetAtTime(410.8 + 2 * pitch, t, 0.08);
  }
  // a short note: frequency, start offset, length, waveform, loudness, optional glide target
  note(f, at, len, type = 'sine', vol = 0.25, glide = null) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime + at, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + len + 0.02);
  }
  ok() { this.note(988, 0, 0.16, 'triangle', 0.3); this.note(1319, 0.11, 0.32, 'triangle', 0.3); }
  ng() { this.note(220, 0, 0.12, 'square', 0.12); this.note(165, 0.13, 0.28, 'square', 0.12); }
  giveUp() { this.note(523, 0, 0.18, 'triangle', 0.22); this.note(415, 0.18, 0.18, 'triangle', 0.22); this.note(311, 0.36, 0.5, 'triangle', 0.22, 262); }
}
