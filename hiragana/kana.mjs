// Hiragana pictures for the fly: every question is a glyph from one of the
// bundled fonts, bent a little differently each time - rotated, sheared,
// stretched, warped, thickened - so the fly never sees the same picture twice.
// Shared by the server-side trainer (Node) and the page (browser).

export const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
// the levels: one row of the gojūon table at a time
export const ROWS = ['あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの',
  'はひふへほ', 'まみむめも', 'やゆよ', 'らりるれろ', 'わをん'];
// never taught - the level test reads these fonts only
export const TEST_FONTS = ['KleeOne', 'ZenKurenaido', 'ShipporiMincho', 'MPLUSRounded1c', 'SawarabiGothic'];

export const SIZE = 16;          // what the fly sees: SIZE x SIZE pixels
export const INK = 30;           // every picture carries this much ink in total

export function unpackBank(buf, meta) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'KANA') throw new Error('kana bank');
  const M = u8[4], nf = u8[5], nk = u8[6];
  return { M, nf, nk, fonts: meta.fonts, px: u8.subarray(8),
    glyph(f, k) { const o = (f * nk + k) * M * M; return this.px.subarray(o, o + M * M); } };
}

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// bilinear lookup into an M x M byte image, 0..1
function lookup(g, M, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= M || yy >= M ? 0 : g[yy * M + xx]);
  return ((at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
          (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy) / 255;
}

/** One distorted copy of a glyph, still M x M (Float32, 0..1). */
export function distort(g, M, rnd, amount = 1) {
  const u = (a) => (rnd() * 2 - 1) * a * amount;
  const rot = u(0.2), shear = u(0.25), sx = 1 + u(0.16), sy = 1 + u(0.16);
  const c = Math.cos(rot), s = Math.sin(rot);
  // forward map A = R * Shear * Scale; sample with its inverse
  const a11 = c * sx, a12 = (c * shear - s) * sy, a21 = s * sx, a22 = (s * shear + c) * sy;
  const det = a11 * a22 - a12 * a21;
  const i11 = a22 / det, i12 = -a12 / det, i21 = -a21 / det, i22 = a11 / det;
  // a smooth warp: two random low-frequency waves per axis
  const waves = Array.from({ length: 4 }, () => ({
    kx: (0.5 + rnd() * 1.5) * Math.PI / M, ky: (0.5 + rnd() * 1.5) * Math.PI / M,
    ph: rnd() * 6.283, amp: u(1.8),
  }));
  const out = new Float32Array(M * M), h = (M - 1) / 2;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const X = x - h, Y = y - h;
    let px = i11 * X + i12 * Y + h, py = i21 * X + i22 * Y + h;
    px += waves[0].amp * Math.sin(waves[0].kx * x + waves[0].ky * y + waves[0].ph)
        + waves[1].amp * Math.sin(waves[1].kx * y + waves[1].ph);
    py += waves[2].amp * Math.sin(waves[2].kx * x + waves[2].ky * y + waves[2].ph)
        + waves[3].amp * Math.sin(waves[3].kx * x + waves[3].ph);
    out[y * M + x] = lookup(g, M, px, py);
  }
  // stroke weight: thicken now and then (thin fonts carry too little ink otherwise)
  const grow = rnd() < 0.45 * amount ? 1 : 0;
  if (!grow) return out;
  const t = new Float32Array(M * M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let m = out[y * M + x];
    if (x > 0) m = Math.max(m, out[y * M + x - 1]);
    if (x < M - 1) m = Math.max(m, out[y * M + x + 1]);
    if (y > 0) m = Math.max(m, out[(y - 1) * M + x]);
    if (y < M - 1) m = Math.max(m, out[(y + 1) * M + x]);
    t[y * M + x] = m;
  }
  return t;
}

/**
 * Centre a picture on its ink, scale its longer side to 78% of the frame,
 * shrink it to SIZE x SIZE and give it a fixed amount of ink - the same for
 * fonts, distorted fonts and finger drawings, so all of them light up about
 * as many Kenyon cells.
 */
export function normalise(img, M, S = SIZE, ink = INK) {
  let x0 = M, x1 = -1, y0 = M, y1 = -1;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++)
    if (img[y * M + x] > 0.2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const out = new Float32Array(S * S);
  if (x1 < 0) return out;
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1, M * 0.1);
  const k = side / (0.78 * S);                  // source pixels per output pixel
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, SS = 4;
  const lin = (xx, yy) => {
    const X0 = Math.floor(xx), Y0 = Math.floor(yy), fx = xx - X0, fy = yy - Y0;
    const at = (a, b) => (a < 0 || b < 0 || a >= M || b >= M ? 0 : img[b * M + a]);
    return (at(X0, Y0) * (1 - fx) + at(X0 + 1, Y0) * fx) * (1 - fy) +
           (at(X0, Y0 + 1) * (1 - fx) + at(X0 + 1, Y0 + 1) * fx) * fy;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let s = 0;
    for (let b = 0; b < SS; b++) for (let a = 0; a < SS; a++)
      s += lin(cx + (x + (a + 0.5) / SS - S / 2) * k, cy + (y + (b + 0.5) / SS - S / 2) * k);
    out[y * S + x] = s / (SS * SS);
  }
  let tot = 0;
  for (const v of out) tot += v;
  if (tot > 0.5) {
    // push the ink up to the target; pixels saturate at 1, so repeat until it holds
    for (let it = 0; it < 6; it++) {
      let t = 0;
      for (const v of out) t += v;
      if (Math.abs(t - ink) < 0.3) break;
      const r = ink / t;
      for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i] * r);
    }
  }
  return out;
}

/** A fresh picture of kana k in font f. */
export function sample(bank, f, k, rnd, amount = 1, S = SIZE) {
  const g = bank.glyph(f, k);
  return normalise(amount > 0 ? distort(g, bank.M, rnd, amount) : Float32Array.from(g, (v) => v / 255), bank.M, S);
}
