// A retina for the connectome's eye.
//
// The fly's eye is already in the graph - 4,044 R1-6 cells, 668 R7 and 662 R8 on the left, the same
// again on the right - and nothing on this site has ever shown it a picture. The pages give the brain a
// handful of channels (LC11, LC4/LPLC2, R1-6 lumped into one), so its 674 sampling points an eye sit
// unused. This maps them onto directions in the world and turns a scene into a firing rate for each cell.
//
// **How many points there are is not guessed.** Each ommatidium carries exactly one R7 and one R8, so
// the 668 R7 cells are the left eye's ommatidia - and 4,044 / 668 = 6.05 R1-6 apiece, as it should be.
// That is the eye's resolution: 668 an eye, ~5 degrees apart, which is what a fly has.
//
// **Where each one looks is assumed**, because the connectome gives soma positions and not lines of
// sight, and `pos783.bin.gz` is a frontal view (x, y only, 0..65535) of a curved eye:
//
//   - each population is normalised inside its *own* footprint (R1-6 and R7 do not overlap in the
//     frontal projection, so a cell cannot be assigned to an ommatidium by nearness - each photoreceptor
//     is given its own direction instead, and no ommatidium is reconstructed),
//   - position is used for the retinotopic *order* only, and the directions are then spread evenly over
//     the field: each cell's rank in x and in y among its own population becomes its azimuth and
//     elevation. Taking the frontal positions as they come, by either a linear or an orthographic
//     (asin) map, leaves the lattice clumped - the median angle between neighbouring ommatidia comes
//     out at 1.4-1.8 degrees, against the ~5 of a real fly, because the projection does not spread them
//     evenly. Ranking makes the lattice even and puts the acuity where it belongs.
//   - the left eye looks out to the left, the right to the right, each over about 170 degrees.
//   - **Neural superposition is not modelled** - in a real fly the six R1-6 of one cartridge come from
//     six neighbouring ommatidia and share a line of sight. Here each of the 4,044 has its own, so R1-6
//     samples about six times finer than the eye really resolves. What the eye resolves is the 668.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const BASE = new URL('../flybrain/', import.meta.url);
const DEG = Math.PI / 180;

export async function loadPositions() {
  const raw = new Uint8Array(gunzipSync(await readFile(new URL('data/pos783.bin.gz', BASE))));
  const dv = new DataView(raw.buffer, raw.byteOffset);
  if (String.fromCharCode(...raw.subarray(0, 4)) !== 'FLYP') throw new Error('not a .bin position file');
  const n = dv.getUint32(4, true);
  const X = new Uint16Array(raw.buffer.slice(raw.byteOffset + 8, raw.byteOffset + 8 + 2 * n));
  const Y = new Uint16Array(raw.buffer.slice(raw.byteOffset + 8 + 2 * n, raw.byteOffset + 8 + 4 * n));
  return { n, X, Y };
}

// The eye looks out at `axis` degrees of azimuth (0 = straight ahead, +90 = the fly's left) and covers
// `span` degrees across and `rise` up and down.
const EYE = { L: { axis: 60, flip: 1 }, R: { axis: -60, flip: -1 } };
const SPAN = 170, RISE = 140;

export async function buildRetina({ groups, span = SPAN, rise = RISE } = {}) {
  const { X, Y } = await loadPositions();
  const eyes = {};
  for (const side of ['L', 'R']) {
    const place = (idx) => {
      const n = idx.length;
      const rank = (get) => {                    // -1..1 by rank, so the lattice comes out even
        const order = idx.map((i, k) => [get(i), k]).sort((a, b) => a[0] - b[0]);
        const r = new Float64Array(n);
        for (let k = 0; k < n; k++) r[order[k][1]] = n > 1 ? 2 * k / (n - 1) - 1 : 0;
        return r;
      };
      // rows by the y order, then each row spread evenly across the field: a raster, so the lattice is
      // even in both directions and the acuity is the same everywhere
      const rows = Math.max(1, Math.round(Math.sqrt(n * rise / span)));
      const byY = idx.map((i, k) => [Y[i], k]).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
      const out = new Array(n);
      for (let r = 0; r < rows; r++) {
        const a = Math.floor(r * n / rows), b = Math.floor((r + 1) * n / rows);
        const row = byY.slice(a, b).sort((p, q) => X[idx[p]] - X[idx[q]]);
        const v = rows > 1 ? 2 * r / (rows - 1) - 1 : 0;
        for (let c = 0; c < row.length; c++) {
          const u = row.length > 1 ? 2 * c / (row.length - 1) - 1 : 0;
          const az = EYE[side].axis + EYE[side].flip * u * (span / 2);
          const el = -v * (rise / 2);                                  // y grows downward in the picture
          out[row[c]] = { cell: idx[row[c]], az, el, dir: dirOf(az * DEG, el * DEG) };
        }
      }
      return out;
    };
    eyes[side] = {
      om: place(groups[`visual:R7:${side}`].idx),                      // the 668 the eye really resolves
      r8: place(groups[`visual:R8:${side}`].idx),
      r16: place(groups[`visual:R1-6:${side}`].idx),
    };
  }
  return eyes;
}

const dirOf = (az, el) => [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];  // x left, y ahead, z up

/**
 * What each ommatidium sees of a scene. A scene is a list of discs on a background:
 *   { az, el, r, i }  - centre in degrees, radius in degrees, intensity (background is `bg`)
 * Returns intensity per ommatidium, 0..1, with the acceptance angle `accept` degrees (the fly's is
 * about 4-5 degrees, close to the 5 degrees between neighbouring ommatidia).
 */
export function look(points, objects, { bg = 1, accept = 5 } = {}) {
  const out = new Float64Array(points.length).fill(bg);
  for (let k = 0; k < points.length; k++) {
    for (const o of objects) {
      const d = angleBetween(points[k].dir, dirOf(o.az * DEG, o.el * DEG)) / DEG;
      if (d < o.r + accept / 2) {
        const cover = Math.min(1, Math.max(0, (o.r + accept / 2 - d) / accept));   // soft edge, one acceptance angle wide
        out[k] = out[k] * (1 - cover) + o.i * cover;
      }
    }
  }
  return out;
}

function angleBetween(a, b) {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d);
}

/**
 * Turn what the eye sees into firing rates, per model index.
 * Photoreceptors answer contrast, not light, so what is sent is how far each ommatidium is from the mean
 * of the scene: `hz` at full contrast, and `base` when everything is the same. R1-6 (achromatic) take the
 * intensity; R7 and R8 take it too until there is a scene with colour in it.
 */
export function rates(eyes, scene, { hz = 30, base = 2, dark = true, parts = ['om', 'r8', 'r16'], bg = 1, accept = 5 } = {}) {
  const out = new Map();
  for (const side of ['L', 'R']) for (const part of parts) {
    const pts = eyes[side][part];
    const I = look(pts, scene, { bg, accept });
    let mean = 0;
    for (const v of I) mean += v / I.length;
    for (let k = 0; k < pts.length; k++) {
      const c = dark ? Math.max(0, mean - I[k]) : Math.abs(I[k] - mean);       // a dark object on a bright sky
      out.set(pts[k].cell, base + hz * Math.min(1, c / Math.max(1e-6, mean)));
    }
  }
  return out;
}

/** Give a brain the scene: one stimulate() call per distinct rate. */
export function show(brain, rateMap) {
  const byRate = new Map();
  for (const [i, r] of rateMap) {
    const key = Math.round(r * 4) / 4;
    if (!byRate.has(key)) byRate.set(key, []);
    byRate.get(key).push(i);
  }
  for (const [r, cells] of byRate) brain.stimulate(cells, r, { byIndex: true });
  return byRate.size;
}
