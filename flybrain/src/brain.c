/*
 * flybrain core: the Shiu et al. (2024) whole-brain LIF model, in WebAssembly.
 *
 * Model (same equations and constants as philshiu/Drosophila_brain_model):
 *   dv/dt = (v0 - v + g) / tau_m     (unless refractory)
 *   dg/dt = -g / tau_syn             (unless refractory)
 *   spike when v > v_th; then v = v_rst, g = 0, refractory for t_rfc
 *   presynaptic spike -> g_post += w_syn * (signed synapse count), after t_dly
 *   Poisson input      -> v += w_syn * f_poi   (a kick far above threshold)
 *
 * Integration is exact (the system is linear), as with Brian2's 'linear'
 * method. Each step follows Brian2's default schedule:
 *   state update -> thresholds -> synapses (+ Poisson) -> resets
 * and reproduces two details of Brian2's generated code that the equations do
 * not show: not_refractory is evaluated once per step (in the state updater),
 * and every update of an (unless refractory) variable is masked by it - input
 * that reaches a refractory neuron is dropped, not held.
 *
 * Speed: event-driven, with an exact bound.
 *   Between inputs a neuron's future is closed-form:
 *       u(t) = u0 e^{-t/tau_m} + g0 * h(t),   u = v - v0,
 *       h(t) = A (e^{-t/tau_syn} - e^{-t/tau_m}),   A = tau_syn / (tau_syn - tau_m)
 *   and h peaks at h_max, so  max_t u(t) <= max(u0, 0) + max(g0, 0) * h_max.
 *   A neuron whose bound stays below threshold cannot spike before its next
 *   input, so it "sleeps": its (v, g) are stored with the step they are valid
 *   for and advanced in one jump (powers of the per-step decay factors) when
 *   the next input arrives. Only neurons that *could* cross threshold are
 *   stepped - typically a few hundred, out of 127k.
 *
 * Freestanding C: no libc, no libm. exp() values come in from JS through
 * fb_set_params().
 */
typedef unsigned char u8;
typedef short i16;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;

#define EXPORT(name) __attribute__((export_name(#name)))
#define LONG_AGO (-1000000000)
#define POW_N 65536              /* decay-power tables; beyond this, decay == 0 */

/* ------------------------------------------------------------------ memory */
extern u8 __heap_base;
static u32 heap_top;

EXPORT(fb_alloc) u32 fb_alloc(u32 bytes) {
    if (!heap_top) heap_top = (u32)&__heap_base;
    u32 p = (heap_top + 15u) & ~15u;
    u32 end = p + bytes;
    u32 have = (u32)__builtin_wasm_memory_size(0) * 65536u;
    if (end > have) {
        u32 pages = (end - have + 65535u) / 65536u;
        if (__builtin_wasm_memory_grow(0, pages) == (__SIZE_TYPE__)-1) return 0;
    }
    heap_top = end;
    return p;
}

/* ------------------------------------------------------------------- state */
/* graph (CSR by presynaptic neuron) */
static u32 N, NNZ;
static u32 *indptr;         /* N + 1 */
static u32 *post;           /* NNZ */
static i16 *wcount;         /* NNZ, signed synapse count (sign = transmitter) */

/* per neuron */
static double *v, *g;       /* mV, valid as of step tu[i] (awake: as of now) */
static i32 *tu;             /* step whose state update v, g already include */
static i32 *ls;             /* step of last spike */
static u8 *flags;           /* bit 0 awake, 1 silenced, 2 Poisson target */
static u32 *counts;         /* spikes since fb_reset */
static u32 *poi_thr;        /* Poisson threshold on a uniform u32: p * 2^32 */

/* neurons stepped every step */
static u32 *awake;
static u32 n_awake;

/* Poisson inputs */
static u32 *poi_list;
static u32 n_poi;

/* delay line: spikes of the last (D + 1) steps */
static u32 *ring;           /* (D + 1) * N */
static u32 *ring_n;         /* D + 1 */
static u32 D;

/* spikes of the current step */
static u32 *fired;
static u32 n_fired;

/* spike record for the caller (neuron index, step), capped */
static u32 *rec_idx, *rec_step;
static u32 rec_cap, rec_n, rec_lost;

/* parameters */
static double P_v0 = -52.0, P_vth = -45.0, P_vrst = -52.0;
static double P_em, P_eg, P_a;   /* exp(-dt/tau_m), exp(-dt/tau_syn), tau_syn/(tau_syn-tau_m) */
static double P_hmax;            /* peak of h(t) */
static double P_wsyn = 0.275, P_kick = 68.75;
static i32 P_rfc = 22;           /* refractory, in steps */
static double *em_pow, *eg_pow;  /* em^n, eg^n for n < POW_N */

static i32 t_step;

/* PCG32 */
static u64 rng_state = 0x853c49e6748fea9bULL, rng_inc = 0xda3e39cb94b95bdbULL;
static inline u32 rng_u32(void) {
    u64 old = rng_state;
    rng_state = old * 6364136223846793005ULL + rng_inc;
    u32 xs = (u32)(((old >> 18u) ^ old) >> 27u);
    u32 rot = (u32)(old >> 59u);
    return (xs >> rot) | (xs << ((-rot) & 31));
}

/* Brian2 sets refractory = 0 for Poisson targets */
static inline i32 rfc_of(u32 i) { return (flags[i] & 4u) ? 0 : P_rfc; }

/* can neuron i reach threshold before its next input? */
static inline i32 may_cross(u32 i) {
    const double u = v[i] - P_v0, gi = g[i];
    return (u > 0 ? u : 0) + (gi > 0 ? gi * P_hmax : 0) > (P_vth - P_v0) - 1e-9;
}

/* bring a sleeping neuron's state up to step t (its state update included) */
static inline void advance(u32 i, i32 t) {
    /* integrating steps s in (tu, t] with s - ls >= rfc */
    if (t <= tu[i]) return;
    i32 from = tu[i];
    const i32 unfrozen = ls[i] + rfc_of(i) - 1;
    if (unfrozen > from) from = unfrozen;
    const i32 n = t - from;
    tu[i] = t;
    if (n <= 0) return;
    const double gi = g[i];
    if (gi == 0.0 && v[i] == P_v0) return;            /* at rest: a fixed point */
    const double em = n < POW_N ? em_pow[n] : 0.0, eg = n < POW_N ? eg_pow[n] : 0.0;
    const double ag = P_a * gi;
    v[i] = P_v0 + (v[i] - P_v0 - ag) * em + ag * eg;
    g[i] = gi * eg;
}

static inline void wake(u32 i) {
    if (!(flags[i] & 1u)) { flags[i] |= 1u; awake[n_awake++] = i; }
}

/* ---------------------------------------------------------------- setup */
EXPORT(fb_init) i32 fb_init(u32 n, u32 nnz, u32 delay_steps, u32 rec_capacity) {
    N = n; NNZ = nnz; D = delay_steps; rec_cap = rec_capacity;
    indptr   = (u32 *)fb_alloc((n + 1) * 4);
    post     = (u32 *)fb_alloc(nnz * 4);
    wcount   = (i16 *)fb_alloc(nnz * 2);
    v        = (double *)fb_alloc(n * 8);
    g        = (double *)fb_alloc(n * 8);
    tu       = (i32 *)fb_alloc(n * 4);
    ls       = (i32 *)fb_alloc(n * 4);
    flags    = (u8 *)fb_alloc(n);
    counts   = (u32 *)fb_alloc(n * 4);
    poi_thr  = (u32 *)fb_alloc(n * 4);
    awake    = (u32 *)fb_alloc(n * 4);
    poi_list = (u32 *)fb_alloc(n * 4);
    ring     = (u32 *)fb_alloc((D + 1) * n * 4);
    ring_n   = (u32 *)fb_alloc((D + 1) * 4);
    fired    = (u32 *)fb_alloc(n * 4);
    rec_idx  = (u32 *)fb_alloc(rec_cap * 4);
    rec_step = (u32 *)fb_alloc(rec_cap * 4);
    em_pow   = (double *)fb_alloc(POW_N * 8);
    eg_pow   = (double *)fb_alloc(POW_N * 8);
    if (!indptr || !post || !wcount || !v || !g || !tu || !ls || !flags || !counts ||
        !poi_thr || !awake || !poi_list || !ring || !ring_n || !fired || !rec_idx ||
        !rec_step || !em_pow || !eg_pow) return -1;
    __builtin_memset(flags, 0, n);
    __builtin_memset(poi_thr, 0, n * 4);
    n_poi = 0;
    return 0;
}

EXPORT(fb_set_params) void fb_set_params(double v0, double vth, double vrst,
                                         double em, double eg, double a, double hmax,
                                         double wsyn, double kick, i32 rfc_steps) {
    P_v0 = v0; P_vth = vth; P_vrst = vrst;
    P_em = em; P_eg = eg; P_a = a; P_hmax = hmax;
    P_wsyn = wsyn; P_kick = kick; P_rfc = rfc_steps;
    em_pow[0] = 1.0; eg_pow[0] = 1.0;
    for (u32 k = 1; k < POW_N; k++) { em_pow[k] = em_pow[k - 1] * em; eg_pow[k] = eg_pow[k - 1] * eg; }
}

EXPORT(fb_reset) void fb_reset(u32 seed_lo, u32 seed_hi) {
    for (u32 i = 0; i < N; i++) {
        v[i] = P_v0; g[i] = 0.0; tu[i] = -1; ls[i] = LONG_AGO; counts[i] = 0;
        flags[i] &= (u8)~1u;
    }
    for (u32 s = 0; s <= D; s++) ring_n[s] = 0;
    n_awake = 0; n_fired = 0; t_step = 0; rec_n = 0; rec_lost = 0;
    /* standard PCG32 seeding: stream and state both from the seed */
    const u64 seed = ((u64)seed_hi << 32) | seed_lo;
    rng_state = 0; rng_inc = ((seed ^ 0xda3e39cb94b95bdbULL) << 1u) | 1u;
    rng_u32(); rng_state += seed + 0x853c49e6748fea9bULL; rng_u32();
}

/* rate in Hz, dt in ms; rate 0 removes the input */
EXPORT(fb_set_poisson) void fb_set_poisson(u32 i, double rate_hz, double dt_ms) {
    double p = rate_hz * dt_ms * 1e-3;
    if (p < 0) p = 0;
    if (p > 1) p = 1;
    const u32 thr = p >= 1.0 ? 0xffffffffu : (u32)(p * 4294967296.0);
    if (!(flags[i] & 1u)) advance(i, t_step - 1);   /* rfc changes with the flag */
    if (thr && !(flags[i] & 4u)) { flags[i] |= 4u; poi_list[n_poi++] = i; }
    poi_thr[i] = thr;
    if (!thr && (flags[i] & 4u)) {
        flags[i] &= (u8)~4u;
        for (u32 k = 0; k < n_poi; k++)
            if (poi_list[k] == i) { poi_list[k] = poi_list[--n_poi]; break; }
    }
}

EXPORT(fb_clear_poisson) void fb_clear_poisson(void) {
    while (n_poi) fb_set_poisson(poi_list[n_poi - 1], 0, 0);
}

/* silencing zeroes a neuron's outgoing synapses, as model.py's silence() does */
EXPORT(fb_set_silenced) void fb_set_silenced(u32 i, i32 on) {
    if (on) flags[i] |= 2u; else flags[i] &= (u8)~2u;
}

/* direct, unmasked voltage inputs from the caller, between steps */
EXPORT(fb_kick) void fb_kick(u32 i, double mv) {
    if (!(flags[i] & 1u)) advance(i, t_step - 1);
    v[i] += mv; wake(i);
}
EXPORT(fb_set_v) void fb_set_v(u32 i, double mv) {
    if (!(flags[i] & 1u)) advance(i, t_step - 1);
    v[i] = mv; wake(i);
}

/* ---------------------------------------------------------------- run */
EXPORT(fb_run) u32 fb_run(u32 steps) {
    u32 total = 0;
    const double v0 = P_v0, vth = P_vth, vrst = P_vrst, em = P_em, eg = P_eg,
                 a = P_a, wsyn = P_wsyn;
    for (u32 st = 0; st < steps; st++, t_step++) {
        const i32 t = t_step;
        n_fired = 0;

        /* 1+2: state update and threshold for awake neurons; the rest cannot cross */
        u32 keep = 0;
        for (u32 k = 0; k < n_awake; k++) {
            const u32 i = awake[k];
            tu[i] = t;
            if ((t - ls[i]) >= rfc_of(i)) {             /* not_refractory */
                const double gi = g[i], ag = a * gi;
                const double vi = v0 + (v[i] - v0 - ag) * em + ag * eg;
                v[i] = vi; g[i] = gi * eg;
                if (vi > vth) { fired[n_fired++] = i; ls[i] = t; continue; }
                if (!may_cross(i)) { flags[i] &= (u8)~1u; continue; }   /* sleep */
            }
            awake[keep++] = i;
        }
        n_awake = keep;

        /* 3: synapses - deliver the spikes of step t - D, masked by not_refractory */
        const u32 slot_out = (u32)(t + 1) % (D + 1);   /* == (t - D) mod (D + 1) */
        const u32 *out = ring + slot_out * N;
        const u32 nout = ring_n[slot_out];
        for (u32 k = 0; k < nout; k++) {
            const u32 j = out[k];
            if (flags[j] & 2u) continue;                 /* silenced */
            const u32 e = indptr[j + 1];
            for (u32 q = indptr[j]; q < e; q++) {
                const u32 i = post[q];
                const i32 li = ls[i];
                if (li == t || t - li < rfc_of(i)) continue;   /* refractory: dropped */
                if (!(flags[i] & 1u)) advance(i, t);
                g[i] += wsyn * (double)wcount[q];
                if (!(flags[i] & 1u) && may_cross(i)) wake(i);
            }
        }
        ring_n[slot_out] = 0;
        /* Poisson inputs, masked the same way */
        for (u32 k = 0; k < n_poi; k++) {
            const u32 i = poi_list[k];
            if (rng_u32() < poi_thr[i]) {
                const i32 li = ls[i];
                if (li == t || t - li < rfc_of(i)) continue;
                if (!(flags[i] & 1u)) advance(i, t);
                v[i] += P_kick;
                wake(i);
            }
        }

        /* 4: resets (the spiking neuron goes to sleep at v_rst), queue the spikes */
        const u32 slot_in = (u32)t % (D + 1);
        u32 *in = ring + slot_in * N;
        for (u32 k = 0; k < n_fired; k++) {
            const u32 i = fired[k];
            v[i] = vrst; g[i] = 0.0; tu[i] = t;
            flags[i] &= (u8)~1u;                         /* it left the awake list above */
            if (may_cross(i)) wake(i);                   /* only if v_rst is high */
            counts[i]++;
            in[k] = i;
            if (rec_n < rec_cap) { rec_idx[rec_n] = i; rec_step[rec_n] = (u32)t; rec_n++; }
            else rec_lost++;
        }
        ring_n[slot_in] = n_fired;
        total += n_fired;
    }
    return total;
}

/* the caller drains the record after each fb_run */
EXPORT(fb_rec_clear) void fb_rec_clear(void) { rec_n = 0; rec_lost = 0; }

/* bring every neuron's v and g up to date (for reading them from JS) */
EXPORT(fb_sync) void fb_sync(void) {
    for (u32 i = 0; i < N; i++) if (!(flags[i] & 1u)) advance(i, t_step - 1);
}

/* ---------------------------------------------------------------- views */
EXPORT(fb_ptr_indptr)  u32 fb_ptr_indptr(void)  { return (u32)indptr; }
EXPORT(fb_ptr_post)    u32 fb_ptr_post(void)    { return (u32)post; }
EXPORT(fb_ptr_w)       u32 fb_ptr_w(void)       { return (u32)wcount; }
EXPORT(fb_ptr_v)       u32 fb_ptr_v(void)       { return (u32)v; }
EXPORT(fb_ptr_g)       u32 fb_ptr_g(void)       { return (u32)g; }
EXPORT(fb_ptr_counts)  u32 fb_ptr_counts(void)  { return (u32)counts; }
EXPORT(fb_ptr_awake)   u32 fb_ptr_awake(void)   { return (u32)awake; }
EXPORT(fb_ptr_rec_idx) u32 fb_ptr_rec_idx(void) { return (u32)rec_idx; }
EXPORT(fb_ptr_rec_step)u32 fb_ptr_rec_step(void){ return (u32)rec_step; }
EXPORT(fb_rec_count)   u32 fb_rec_count(void)   { return rec_n; }
EXPORT(fb_rec_lost)    u32 fb_rec_lost(void)    { return rec_lost; }
EXPORT(fb_n_awake)     u32 fb_n_awake(void)     { return n_awake; }
EXPORT(fb_now)         i32 fb_now(void)         { return t_step; }
