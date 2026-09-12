/**
 * flybrain.js — the Shiu et al. (2024) whole fruit-fly brain model, running
 * in WebAssembly. Works in browsers and in Node 18+ (ES module).
 *
 *   import { FlyBrain } from './flybrain.js';
 *   const brain = await FlyBrain.load();                  // fetches wasm + graph
 *   brain.stimulate(SUGAR_IDS, 150);                      // Poisson input, Hz
 *   const r = brain.run(1000);                            // simulate 1000 ms
 *   brain.rate(MN9_ID);                                   // Hz since reset
 *
 * Neurons are addressed by FlyWire root id (BigInt, Number or string) or by
 * model index (a plain integer < brain.n, with { byIndex: true }).
 */

export const DEFAULT_PARAMS = Object.freeze({
  dt: 0.1,          // ms, Brian2's default clock
  v0: -52,          // mV resting potential
  vRst: -52,        // mV reset
  vTh: -45,         // mV threshold
  tauM: 20,         // ms membrane time constant
  tauSyn: 5,        // ms synaptic time constant
  tRfc: 2.2,        // ms refractory period
  tDly: 1.8,        // ms synaptic delay
  wSyn: 0.275,      // mV per synapse (the model's single free parameter)
  fPoi: 250,        // Poisson kick = wSyn * fPoi
});

const HERE = typeof import.meta !== 'undefined' ? import.meta.url : '';

async function readBytes(src, onProgress) {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  const url = src instanceof URL ? src : new URL(src, HERE || undefined);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`flybrain: ${url} -> HTTP ${res.status}`);
  if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer());
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress({ phase: 'download', loaded: got, total });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function gunzip(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;      // already raw
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await import('node:zlib');
  return new Uint8Array(gunzipSync(bytes));
}

export class FlyBrain {
  /**
   * @param {object} [o]
   * @param {string|URL|ArrayBuffer|Uint8Array} [o.wasm]   default: ./flybrain.wasm
   * @param {string|URL|ArrayBuffer|Uint8Array} [o.graph]  default: ./data/flywire630.fbg.gz
   * @param {object} [o.params]      overrides for DEFAULT_PARAMS
   * @param {number} [o.recordCapacity]  spike events kept per run() call
   * @param {(p:{phase:string,loaded?:number,total?:number})=>void} [o.onProgress]
   */
  static async load(o = {}) {
    const wasmSrc = o.wasm ?? new URL('./flybrain.wasm', HERE);
    const graphSrc = o.graph ?? new URL('./data/flywire630.fbg.gz', HERE);
    const [wasmBytes, graphGz] = await Promise.all([
      readBytes(wasmSrc),
      readBytes(graphSrc, o.onProgress),
    ]);
    o.onProgress?.({ phase: 'decompress' });
    const graph = await gunzip(graphGz);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    const brain = new FlyBrain(instance.exports, graph, o);
    o.onProgress?.({ phase: 'ready' });
    return brain;
  }

  constructor(x, graph, o) {
    this._x = x;
    const dv = new DataView(graph.buffer, graph.byteOffset, graph.byteLength);
    const magic = String.fromCharCode(...graph.subarray(0, 4));
    if (magic !== 'FLYB') throw new Error('flybrain: not a .fbg graph');
    const n = dv.getUint32(8, true), nnz = dv.getUint32(12, true);
    this.n = n;
    this.nnz = nnz;
    this.params = { ...DEFAULT_PARAMS, ...(o.params || {}) };
    const P = this.params;
    this.delaySteps = Math.round(P.tDly / P.dt);
    this.recordCapacity = o.recordCapacity ?? 1 << 20;

    if (x.fb_init(n, nnz, this.delaySteps, this.recordCapacity) !== 0)
      throw new Error('flybrain: out of memory');

    // ids
    let off = 16;
    this.ids = new BigUint64Array(graph.slice(off, off + 8 * n).buffer);
    off += 8 * n;
    this._index = new Map();
    for (let i = 0; i < n; i++) this._index.set(this.ids[i], i);
    // CSR rows
    const deg = new Uint32Array(graph.slice(off, off + 4 * n).buffer);
    off += 4 * n;
    const mem = () => x.memory.buffer;
    const indptr = new Uint32Array(mem(), x.fb_ptr_indptr(), n + 1);
    indptr[0] = 0;
    for (let i = 0; i < n; i++) indptr[i + 1] = indptr[i] + deg[i];
    // postsynaptic indices from three delta-coded byte planes
    const p0 = graph.subarray(off, off + nnz), p1 = graph.subarray(off + nnz, off + 2 * nnz),
          p2 = graph.subarray(off + 2 * nnz, off + 3 * nnz);
    off += 3 * nnz;
    const post = new Uint32Array(mem(), x.fb_ptr_post(), nnz);
    for (let i = 0, q = 0; i < n; i++) {
      const e = indptr[i + 1];
      let prev = 0;
      for (let first = true; q < e; q++, first = false) {
        const d = p0[q] | (p1[q] << 8) | (p2[q] << 16);
        prev = first ? d : prev + d;
        post[q] = prev;
      }
    }
    // signed synapse counts from two byte planes
    const lo = graph.subarray(off, off + nnz), hi = graph.subarray(off + nnz, off + 2 * nnz);
    const w = new Int16Array(mem(), x.fb_ptr_w(), nnz);
    for (let q = 0; q < nnz; q++) w[q] = (lo[q] | (hi[q] << 8)) << 16 >> 16;

    this._applyParams();
    this.reset(1);
  }

  _applyParams() {
    const P = this.params;
    if (P.tauSyn === P.tauM) throw new Error('flybrain: tauSyn must differ from tauM');
    const em = Math.exp(-P.dt / P.tauM), eg = Math.exp(-P.dt / P.tauSyn);
    const a = P.tauSyn / (P.tauSyn - P.tauM);
    // peak of the voltage response to a unit g, h(t) = a (e^-t/tauSyn - e^-t/tauM);
    // the core uses it to prove a neuron cannot reach threshold before its next input
    const tPeak = Math.log(P.tauM / P.tauSyn) / (1 / P.tauSyn - 1 / P.tauM);
    const hMax = a * (Math.exp(-tPeak / P.tauSyn) - Math.exp(-tPeak / P.tauM)) * (1 + 1e-9);
    this._x.fb_set_params(P.v0, P.vTh, P.vRst, em, eg, a, hMax, P.wSyn, P.wSyn * P.fPoi,
      Math.round(P.tRfc / P.dt));
  }

  /** Change model constants (dt and tDly are fixed at load time). */
  setParams(p) {
    for (const k of ['dt', 'tDly']) if (k in p && p[k] !== this.params[k])
      throw new Error(`flybrain: ${k} can only be set at load time`);
    Object.assign(this.params, p);
    this._applyParams();
  }

  /** FlyWire id (BigInt | number | string) -> model index, or -1. */
  index(id) {
    const i = this._index.get(typeof id === 'bigint' ? id : BigInt(id));
    return i === undefined ? -1 : i;
  }
  /** model index -> FlyWire id (BigInt) */
  id(i) { return this.ids[i]; }

  _idx(list, byIndex) {
    const arr = Array.isArray(list) || ArrayBuffer.isView(list) ? list : [list];
    const out = [];
    for (const v of arr) {
      const i = byIndex ? Number(v) : this.index(v);
      if (i < 0 || i >= this.n) throw new Error(`flybrain: unknown neuron ${v}`);
      out.push(i);
    }
    return out;
  }

  /** Back to rest: all voltages at v0, no spikes in flight, counters zeroed. Inputs persist. */
  reset(seed = 1) {
    const s = BigInt.asUintN(64, BigInt(seed));
    this._x.fb_reset(Number(s & 0xffffffffn), Number(s >> 32n));
    this._t0 = 0;
  }

  /** Drive neurons with independent Poisson input at `hz` (0 removes it). */
  stimulate(neurons, hz, { byIndex = false } = {}) {
    for (const i of this._idx(neurons, byIndex)) this._x.fb_set_poisson(i, hz, this.params.dt);
  }
  /** Remove every Poisson input. */
  clearStimuli() { this._x.fb_clear_poisson(); }

  /** Silence neurons: their outgoing synapses carry nothing. */
  silence(neurons, on = true, { byIndex = false } = {}) {
    for (const i of this._idx(neurons, byIndex)) this._x.fb_set_silenced(i, on ? 1 : 0);
  }

  /**
   * Switch on the mushroom body's learning rule: dopamine-gated depression of
   * the synapses from `pre` (Kenyon cells) onto the neurons of each group.
   *
   * A group is one dopamine compartment: the postsynaptic cells whose synapses
   * it covers, plus the modulator cells (DANs) whose spikes release dopamine
   * into it. A synapse weakens by eta * (its presynaptic trace) * (the group's
   * dopamine) per millisecond of overlap, so only the cells that were active
   * while dopamine arrived lose their drive - which is what makes the memory
   * specific to one odour.
   *
   * @param {object} o
   * @param {number[]} o.pre        presynaptic (plastic) neurons, model indices
   * @param {{post:number[], modulators:(number[]|[number,number][])}[]} o.groups
   *        one entry per compartment; modulators may carry a weight per cell
   * @param {number} [o.eta=0.02]     learning rate
   * @param {number} [o.tauTrace=40]  presynaptic trace time constant, ms
   * @param {number} [o.tauDopa=80]   dopamine time constant, ms
   * @param {number} [o.gainMin=0]    floor on a synapse's gain
   * @param {number} [o.tauForget=0]  gains drift back to 1 with this time constant, ms (0 = never)
   * @param {number} [o.everyMs=1]    how often the rule is applied
   */
  setPlasticity(o) {
    const x = this._x, dt = this.params.dt;
    const groups = o.groups || [];
    let nMod = 0;
    for (const g of groups) nMod += (g.modulators || []).length;
    if (x.fb_plastic_init(groups.length, Math.max(1, nMod)) !== 0)
      throw new Error('flybrain: out of memory for plasticity');
    this.setPlasticityParams(o);
    for (const j of o.pre) if (x.fb_plastic_pre(j) !== 0)
      throw new Error('flybrain: out of memory for plasticity');
    const groupOf = new Map();                 // postsynaptic neuron -> its group
    const marked = groups.map(() => 0);
    groups.forEach((g, c) => {
      for (const i of g.post) groupOf.set(i, c);
      for (const m of g.modulators || []) {
        const [i, w] = Array.isArray(m) ? m : [m, 1];
        x.fb_mod_add(i, c, w);
      }
    });
    for (const j of o.pre) {                   // one pass over the plastic rows
      const { post } = this.outgoing(j, { byIndex: true });
      for (const i of post) {
        const c = groupOf.get(i);
        if (c !== undefined) { x.fb_plastic_mark(j, i, c); marked[c]++; }
      }
    }
    this._plastic = { groups, marked };
    return marked;
  }

  /** Retune the learning rule without rebuilding it. */
  setPlasticityParams({ eta = 0.02, tauTrace = 40, tauDopa = 80, gainMin = 0,
                        tauForget = 0, everyMs = 1 } = {}) {
    const dt = this.params.dt, every = Math.max(1, Math.round(everyMs / dt));
    this._x.fb_plastic_params(eta, Math.exp(-dt / tauTrace), Math.exp(-every * dt / tauDopa),
      gainMin, tauForget > 0 ? 1 - Math.exp(-every * dt / tauForget) : 0, every);
  }

  /** Forget: every learned gain back to 1. */
  forget() { this._x.fb_plastic_forget(); }

  /** Set a group's dopamine level directly (the modulator cells add to it). */
  dopamine(group, level) { this._x.fb_dopa_set(group, level); }

  /** Mean gain of a group's plastic synapses - 1 is naive, 0 is fully depressed. */
  gain(group) { return this._x.fb_gain_mean(group); }

  /**
   * Mean gain of the plastic synapses leaving each of `pre`, averaged over the
   * cells that have any - how much of their drive that population has lost.
   */
  gainFrom(pre, { byIndex = false } = {}) {
    let s = 0, n = 0;
    for (const j of this._idx(pre, byIndex)) {
      const g = this._x.fb_gain_pre(j);
      if (g >= 0) { s += g; n++; }
    }
    return n ? s / n : 1;
  }

  /** The gain of one synapse, or -1 if it is not plastic. */
  gainOf(pre, post, { byIndex = false } = {}) {
    const [j] = this._idx(pre, byIndex), [i] = this._idx(post, byIndex);
    return this._x.fb_gain_of(j, i);
  }

  /** Add `mv` to the membrane potential of neurons right now. */
  kick(neurons, mv = 10, { byIndex = false } = {}) {
    for (const i of this._idx(neurons, byIndex)) this._x.fb_kick(i, mv);
  }

  /** Set the membrane potential of neurons to `mv` right now. */
  setVoltage(neurons, mv, { byIndex = false } = {}) {
    for (const i of this._idx(neurons, byIndex)) this._x.fb_set_v(i, mv);
  }

  /**
   * Advance the simulation by `ms`.
   * @returns {{spikes:number, idx:Uint32Array, t:Float64Array, lost:number}}
   *   idx/t are the spike events of this call (t in ms since reset); they are
   *   copies, safe to keep. Pass { events: false } to skip copying them.
   */
  run(ms, { events = true } = {}) {
    const x = this._x;
    const steps = Math.max(0, Math.round(ms / this.params.dt));
    x.fb_rec_clear();
    const spikes = x.fb_run(steps);
    if (!events) return { spikes, idx: null, t: null, lost: x.fb_rec_lost() };
    const k = x.fb_rec_count();
    const idx = new Uint32Array(x.memory.buffer, x.fb_ptr_rec_idx(), k).slice();
    const st = new Uint32Array(x.memory.buffer, x.fb_ptr_rec_step(), k);
    const t = new Float64Array(k);
    for (let j = 0; j < k; j++) t[j] = st[j] * this.params.dt;
    return { spikes, idx, t, lost: x.fb_rec_lost() };
  }

  /** Simulated time since reset, ms. */
  get time() { return this._x.fb_now() * this.params.dt; }
  /** Neurons being stepped right now - the ones that could reach threshold (the core's workload). */
  get activeCount() { return this._x.fb_n_awake(); }

  /** Spike counts since reset (live view into wasm memory; copy if you keep it). */
  counts() { return new Uint32Array(this._x.memory.buffer, this._x.fb_ptr_counts(), this.n); }
  /** Membrane potentials of every neuron, mV (a snapshot view, valid until the next run()). */
  voltages() {
    this._x.fb_sync();
    return new Float64Array(this._x.memory.buffer, this._x.fb_ptr_v(), this.n);
  }

  /**
   * The neurons near threshold (being stepped) - cheap, no full sync.
   * @returns {Uint32Array} a copy of their model indices
   */
  activeNeurons() {
    const x = this._x;
    return new Uint32Array(x.memory.buffer, x.fb_ptr_awake(), x.fb_n_awake()).slice();
  }

  /** Mean firing rate since reset, Hz, for one neuron or the mean over a list. */
  rate(neurons, { byIndex = false } = {}) {
    const c = this.counts(), T = this.time / 1000;
    if (!T) return 0;
    const ix = this._idx(neurons, byIndex);
    let s = 0;
    for (const i of ix) s += c[i];
    return s / ix.length / T;
  }

  /** Outgoing connections of a neuron: { post: Uint32Array, synapses: Int16Array } (views). */
  outgoing(neuron, { byIndex = false } = {}) {
    const i = this._idx(neuron, byIndex)[0], x = this._x;
    const ip = new Uint32Array(x.memory.buffer, x.fb_ptr_indptr(), this.n + 1);
    const a = ip[i], b = ip[i + 1];
    return {
      post: new Uint32Array(x.memory.buffer, x.fb_ptr_post() + 4 * a, b - a),
      synapses: new Int16Array(x.memory.buffer, x.fb_ptr_w() + 2 * a, b - a),
    };
  }
}
