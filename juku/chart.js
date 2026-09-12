// The school record as a line chart: held-out test score and running practice
// score against pictures practised, one percentage axis, with level-ups
// marked. Canvas, with a crosshair tooltip.
const TEST = '#3a9be6', RUN = '#c97a1f';
export const COLORS = { test: TEST, run: RUN };

export class RecordChart {
  constructor(canvas, tip, { chance = null, levelName = null } = {}) {
    this.c = canvas; this.tip = tip; this.chance = chance; this.levelName = levelName;
    this.h = []; this.hover = null;
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    addEventListener('resize', () => this.draw());
  }
  set(history) { this.h = history || []; this.draw(); }

  geom() {
    const w = this.c.clientWidth || 600, h = this.c.clientHeight || 220;
    const L = 38, R = 12, T = 12, B = 26;
    const n0 = 0, n1 = Math.max(1, ...this.h.map((p) => p.n));
    return { w, h, L, R, T, B,
      x: (n) => L + (n - n0) / (n1 - n0) * (w - L - R),
      y: (v) => T + (1 - v) * (h - T - B), n1 };
  }

  move(e) {
    if (!this.h.length) return;
    const r = this.c.getBoundingClientRect(), g = this.geom(), px = e.clientX - r.left;
    let best = 0;
    this.h.forEach((p, i) => { if (Math.abs(g.x(p.n) - px) < Math.abs(g.x(this.h[best].n) - px)) best = i; });
    this.hover = best; this.draw();
  }

  draw() {
    const c = this.c, dpr = Math.min(2, devicePixelRatio || 1), g = this.geom();
    c.width = g.w * dpr; c.height = g.h * dpr;
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, g.w, g.h);
    x.font = '11px system-ui, sans-serif';
    // grid + y labels
    for (let v = 0; v <= 1.0001; v += 0.25) {
      x.strokeStyle = v === 0 ? '#3a4552' : '#222a33'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(g.L, Math.round(g.y(v)) + .5); x.lineTo(g.w - g.R, Math.round(g.y(v)) + .5); x.stroke();
      x.fillStyle = '#7d8a99'; x.textAlign = 'right'; x.textBaseline = 'middle';
      x.fillText(`${Math.round(v * 100)}%`, g.L - 6, g.y(v));
    }
    if (this.chance != null) {
      x.setLineDash([3, 4]); x.strokeStyle = '#4a5563';
      x.beginPath(); x.moveTo(g.L, g.y(this.chance)); x.lineTo(g.w - g.R, g.y(this.chance)); x.stroke();
      x.setLineDash([]);
    }
    x.fillStyle = '#7d8a99'; x.textAlign = 'right'; x.textBaseline = 'alphabetic';
    x.fillText(`練習 ${g.n1.toLocaleString()} 枚`, g.w - g.R, g.h - 6);
    x.textAlign = 'left'; x.fillText('0', g.L, g.h - 6);
    if (!this.h.length) {
      x.fillStyle = '#7d8a99'; x.textAlign = 'center';
      x.fillText('最初のテストを待っています…', (g.L + g.w) / 2, g.h / 2);
      return;
    }
    // level-ups: a thin tick where the level changed
    for (let i = 1; i < this.h.length; i++) if (this.h[i].level !== this.h[i - 1].level) {
      const px = Math.round(g.x(this.h[i].n)) + .5;
      x.strokeStyle = '#3a4552'; x.beginPath(); x.moveTo(px, g.T); x.lineTo(px, g.h - g.B); x.stroke();
      const label = this.levelName ? this.levelName(this.h[i].level) : `Lv${this.h[i].level}`;
      const right = px + 3 + x.measureText(label).width < g.w - g.R;   // else put it left of the line
      x.fillStyle = '#9aa7b5'; x.textAlign = right ? 'left' : 'right'; x.textBaseline = 'top';
      x.fillText(label, right ? px + 3 : px - 3, g.T);
    }
    const line = (key, col) => {
      x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.beginPath();
      this.h.forEach((p, i) => (i ? x.lineTo(g.x(p.n), g.y(p[key])) : x.moveTo(g.x(p.n), g.y(p[key]))));
      x.stroke();
    };
    line('run', RUN); line('test', TEST);
    // while there are few tests, mark each one (a single test is otherwise invisible)
    if (this.h.length < 60) for (const [key, col] of [['run', RUN], ['test', TEST]]) for (const p of this.h) {
      x.beginPath(); x.arc(g.x(p.n), g.y(p[key]), 4, 0, 6.2832);
      x.fillStyle = col; x.fill(); x.lineWidth = 2; x.strokeStyle = '#151a20'; x.stroke();
    }
    // crosshair + tooltip
    if (this.hover != null) {
      const p = this.h[this.hover], px = g.x(p.n);
      x.strokeStyle = '#56626f'; x.lineWidth = 1;
      x.beginPath(); x.moveTo(Math.round(px) + .5, g.T); x.lineTo(Math.round(px) + .5, g.h - g.B); x.stroke();
      for (const [key, col] of [['run', RUN], ['test', TEST]]) {
        x.beginPath(); x.arc(px, g.y(p[key]), 4.5, 0, 6.2832);
        x.fillStyle = col; x.fill(); x.lineWidth = 2; x.strokeStyle = '#151a20'; x.stroke();
      }
      const when = new Date(p.t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      this.tip.innerHTML = `<b>練習 ${p.n.toLocaleString()} 枚</b>（${when}）<br>` +
        `<i style="background:${TEST}"></i>テスト ${(100 * p.test).toFixed(1)}%<br>` +
        `<i style="background:${RUN}"></i>練習中 ${(100 * p.run).toFixed(1)}%` +
        (this.levelName ? `<br>${this.levelName(p.level)}` : '');
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(g.w - tw, Math.max(0, px + 12 > g.w - tw ? px - tw - 12 : px + 12))}px`;
      this.tip.style.top = `${g.T}px`;
    } else this.tip.hidden = true;
  }
}
