// The workshop: adding circuits to the connectome by hand.
//
// shinka mutates the brain at random and lets the world keep what pays. This does the opposite - a
// circuit is designed, put in, and measured. The constraint evolution works under (the graph has no
// free slots, so a new connection must take the place of an old one) is not a constraint on
// engineering, so this grows the graph instead: new neurons at the end, and extra empty slots on
// whichever existing rows are going to send somewhere new. Nothing that was there is touched, so with
// nothing wired in the brain runs exactly as the connectome does.
//
//   const W = await Workshop.open({ cells: 64 });      // 64 new neurons, nothing connected yet
//   const hold = W.cells(32);                          // take 32 of them
//   W.connect(drivers, hold, 40);                      // 40 synapses from each driver to each hold cell
//   W.wire(hold, hold, 12, { self: false });           // and hold cells to each other
//   await W.build();                                   // -> a FlyBrain with all of it in place
//
// .fbg is CSR: ids (u64), degrees (u32), post in three delta-coded byte planes, synapse counts in two.
// The deltas only matter at load time - once the brain is up, post/w are plain arrays in wasm memory
// (shinka's graphOf), so the added slots are filled there and the encoder only has to get the shape right.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { FlyBrain } from '../flybrain/flybrain.js';
import { graphOf } from '../shinka/genome.mjs';

const BASE = new URL('../flybrain/', import.meta.url);

export function decode(raw) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (String.fromCharCode(...raw.subarray(0, 4)) !== 'FLYB') throw new Error('not a .fbg graph');
  const n = dv.getUint32(8, true), nnz = dv.getUint32(12, true);
  let off = 16;
  const ids = new BigUint64Array(raw.slice(off, off + 8 * n).buffer); off += 8 * n;
  const deg = new Uint32Array(raw.slice(off, off + 4 * n).buffer); off += 4 * n;
  const p0 = raw.subarray(off, off + nnz), p1 = raw.subarray(off + nnz, off + 2 * nnz), p2 = raw.subarray(off + 2 * nnz, off + 3 * nnz);
  off += 3 * nnz;
  const post = new Uint32Array(nnz);
  for (let i = 0, q = 0; i < n; i++) {
    const e = q + deg[i];
    let prev = 0;
    for (let first = true; q < e; q++, first = false) {
      const d = p0[q] | (p1[q] << 8) | (p2[q] << 16);
      prev = first ? d : prev + d;
      post[q] = prev;
    }
  }
  const lo = raw.subarray(off, off + nnz), hi = raw.subarray(off + nnz, off + 2 * nnz);
  const w = new Int16Array(nnz);
  for (let q = 0; q < nnz; q++) w[q] = (lo[q] | (hi[q] << 8)) << 16 >> 16;
  return { n, nnz, ids, deg, post, w, header: raw.slice(0, 16) };
}

export function encode({ n, ids, deg, post, w, header }) {
  let nnz = 0;
  for (let i = 0; i < n; i++) nnz += deg[i];
  const out = new Uint8Array(16 + 8 * n + 4 * n + 5 * nnz);
  out.set(header.subarray(0, 16));
  const dv = new DataView(out.buffer);
  dv.setUint32(8, n, true); dv.setUint32(12, nnz, true);
  let o = 16;
  new Uint8Array(ids.buffer, ids.byteOffset, 8 * n).forEach((b, k) => { out[o + k] = b; });
  o += 8 * n;
  new Uint8Array(deg.buffer, deg.byteOffset, 4 * n).forEach((b, k) => { out[o + k] = b; });
  o += 4 * n;
  const P0 = o, P1 = o + nnz, P2 = o + 2 * nnz;
  for (let i = 0, q = 0; i < n; i++) {
    const e = q + deg[i];
    let prev = 0;
    for (let first = true; q < e; q++, first = false) {
      const d = first ? post[q] : post[q] - prev;         // rows stay non-decreasing, so d >= 0
      if (d < 0) throw new Error(`row ${i} is not sorted (delta ${d})`);
      out[P0 + q] = d & 255; out[P1 + q] = (d >> 8) & 255; out[P2 + q] = (d >> 16) & 255;
      prev = post[q];
    }
  }
  o += 3 * nnz;
  for (let q = 0; q < nnz; q++) { out[o + q] = w[q] & 255; out[o + nnz + q] = (w[q] >> 8) & 255; }
  return out;
}

export class Workshop {
  // cells: how many new neurons; slots: free outgoing slots each of them gets;
  // room: free slots added to every existing row that is asked to send somewhere new (grown on demand)
  static async open({ graph = 'data/flywire783.fbg.gz', cells = 64, slots = 64, room = 8 } = {}) {   // slots: outgoing slots per new cell
    const raw = new Uint8Array(gunzipSync(await readFile(new URL(graph, BASE))));   // (a Buffer's .slice is a view, not a copy)
    return new Workshop(decode(raw), { cells, slots, room });
  }
  constructor(G, { cells, slots, room }) {
    this.base = G;
    this.n0 = G.n;                       // the connectome's own neurons: 0 .. n0-1
    this.newCells = cells;
    this.slots = slots;
    this.room = room;
    this.extra = new Map();              // existing row -> extra slots wanted
    this.links = [];                     // {pre, post, syn}
    this._taken = 0;
  }
  /** Take k of the new neurons; returns their model indices. */
  cells(k) {
    if (this._taken + k > this.newCells) throw new Error('not enough new cells');
    const out = [];
    for (let i = 0; i < k; i++) out.push(this.n0 + this._taken++);
    return out;
  }
  /** One connection, pre -> post, of `syn` synapses (negative = inhibitory). */
  link(pre, post, syn) {
    if (pre < this.n0) this.extra.set(pre, (this.extra.get(pre) || 0) + 1);
    this.links.push({ pre, post, syn });
    return this;
  }
  /** Every cell of `pre` to every cell of `post`. */
  wire(pre, post, syn, { self = true } = {}) {
    for (const a of pre) for (const b of post) if (self || a !== b) this.link(a, b, syn);
    return this;
  }
  connect(pre, post, syn) { return this.wire(pre, post, syn); }

  /**
   * A memory. `n` new cells wired as a ring, which is the only shape that holds in this model - all to
   * all does not, at any strength, because the cells fire together and the volley they send each other
   * lands in their refractory period, where this model drops it.
   *
   *     const seen = W.memory();          // 32 cells, holds for good once written
   *     seen.write(sugarCells);           // this writes it
   *     seen.clear(bitterCells);          // and this empties it
   *     W.wire(seen, somethingElse, 8);   // it is an array of cells, so it wires like any other
   *
   * Measured: written, it holds at ~108 Hz a cell for at least 10 s with no decay, and is silent until
   * it is written. `clear` takes it to exactly zero, and it can be written again at full strength.
   */
  memory(n = 32, { groups = 2, rec = 16, write = 60, clear = 32 } = {}) {
    if (groups < 2) throw new Error('a memory needs at least 2 groups: one ring of cells firing together puts itself out');
    const need = Math.ceil(n / groups);
    if (this.slots < need) throw new Error(`each cell needs ${need} outgoing slots for the ring; open the workshop with slots: ${need + 8} or more`);
    const cells = this.cells(n);
    const ring = [...Array(groups)].map((_, k) => cells.filter((_, i) => i % groups === k));
    for (let k = 0; k < groups; k++) this.wire(ring[k], ring[(k + 1) % groups], rec);
    cells.ring = ring;
    cells.write = (from, syn = write) => { this.wire(from, ring[0], syn); return cells; };
    cells.clear = (from, syn = clear) => { this.wire(from, cells, -syn); return cells; };
    return cells;
  }

  /** Build the graph and load it. Returns a FlyBrain with everything wired. */
  async build(opts = {}) {
    const G = this.base, n = this.n0 + this.newCells;
    const ids = new BigUint64Array(n), deg = new Uint32Array(n);
    ids.set(G.ids);
    for (let k = 0; k < this.newCells; k++) ids[this.n0 + k] = BigInt(k + 1);
    for (let i = 0; i < this.n0; i++) deg[i] = G.deg[i] + (this.extra.get(i) || 0);
    // a new cell gets `slots` outgoing slots, or as many as its links actually need: one link past
    // the end of a row used to run into the next cell's slots and quietly rewire it
    const want = new Map();
    for (const { pre } of this.links) if (pre >= this.n0) want.set(pre, (want.get(pre) || 0) + 1);
    for (let k = 0; k < this.newCells; k++) deg[this.n0 + k] = Math.max(this.slots, want.get(this.n0 + k) || 0);
    let nnz = 0;
    for (let i = 0; i < n; i++) nnz += deg[i];
    const post = new Uint32Array(nnz), w = new Int16Array(nnz);
    const start = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    // the connectome's own rows, copied across; the extra slots repeat the row's last target with 0
    // synapses (delta 0, and nothing delivered) until they are filled in
    const free = new Map();
    for (let i = 0, q = 0; i < this.n0; i++) {
      const a = start[i], d = G.deg[i];
      post.set(G.post.subarray(q, q + d), a);
      w.set(G.w.subarray(q, q + d), a);
      const ex = this.extra.get(i) || 0;
      if (ex) {
        const last = d ? post[a + d - 1] : i;
        for (let k = 0; k < ex; k++) { post[a + d + k] = last; w[a + d + k] = 0; }
        free.set(i, a + d);
      }
      q += d;
    }
    for (let k = 0; k < this.newCells; k++) {          // new cells: every slot points at itself, 0 synapses
      const i = this.n0 + k, a = start[i];
      for (let j = 0; j < this.slots; j++) { post[a + j] = i; w[a + j] = 0; }
      free.set(i, a);
    }
    // the new connections go into the free slots here, before the graph is encoded, so that a graph
    // written out with `encode` carries them (kakou/bake.mjs does that for /kaiwa/)
    const cursor = new Map(free);
    for (const { pre, post: to, syn } of this.links) {
      const q = cursor.get(pre);
      if (q === undefined || q >= start[pre + 1]) throw new Error(`no free slot for ${pre} (open the workshop with more slots, or room)`);
      post[q] = to; w[q] = Math.max(-32767, Math.min(32767, Math.round(syn)));
      cursor.set(pre, q + 1);
    }
    // .fbg codes each row's targets as deltas, so a row has to be non-decreasing. Order within a row
    // means nothing to the model, so every touched row is sorted (with its synapse counts).
    for (const i of cursor.keys()) {
      const a = start[i], b = start[i + 1];
      const order = [...Array(b - a).keys()].sort((x, y) => post[a + x] - post[a + y]);
      const p2 = order.map((k) => post[a + k]), w2 = order.map((k) => w[a + k]);
      for (let k = 0; k < order.length; k++) { post[a + k] = p2[k]; w[a + k] = w2[k]; }
    }
    this.baked = { n, ids, deg, post, w, header: G.header };
    const raw = encode(this.baked);
    const brain = await FlyBrain.load({ graph: raw.buffer, wasm: new URL('flybrain.wasm', BASE), ...opts });
    this.brain = brain;
    return brain;
  }
}
