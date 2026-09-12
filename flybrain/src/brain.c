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
 * On top of the published model, and off until the caller switches it on:
 * dopamine-gated depression of a nominated set of synapses (see "plasticity"
 * below). With it off the core is bit-identical to the model above.
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

/* ------------------------------------------------------------ plasticity
 * The mushroom body's learning rule: a Kenyon-cell -> MBON synapse weakens
 * when that KC's recent activity coincides with dopamine in the MBON's
 * compartment (Hige et al. 2015; Owald & Waddell 2015). Nothing here runs
 * until fb_plastic_init(), and then only the synapses the caller nominates
 * are affected.
 *
 *   trace[j] += 1        on a spike of a nominated presynaptic neuron j
 *   dopa[c]  += weight   on a spike of a modulator neuron (a DAN) of group c
 *   gain     -= eta * trace[pre] * dopa[group]      clipped to [gain_min, 1]
 *   gain     -> 1 slowly                            (forgetting)
 * and the synapse delivers w_syn * count * gain.
 */
static u32 pl_on;
static float **rowgain;     /* N: per-synapse gain for a nominated row, or 0 */
static i32 **rowgrp;        /* N: dopamine group of each synapse in the row, -1 none */
static u32 *pl_pres;        /* the nominated presynaptic neurons */
static u32 n_pl_pres;
static double *dopa;        /* n_group */
static u32 n_group;
static double *trace;       /* N, valid as of step t_tr[i] */
static i32 *t_tr;
static double *tr_pow;      /* trace decay^n, n < POW_N */
static u32 *elig, n_elig;   /* presynaptic neurons whose trace is still alive */
static u32 *mod_at;         /* N -> first modulator entry of that neuron, or NONE */
static i32 *mod_grp; static float *mod_w; static u32 *mod_next;
static u32 n_mod, cap_mod;
static double P_eta = 0.02, P_trdec = 1.0, P_dodec = 1.0, P_gmin = 0.0, P_recov = 0.0;
static i32 P_every = 10;    /* apply the rule every this many steps */
#define NONE 0xffffffffu

static inline double trace_at(u32 j, i32 t) {
    const i32 n = t - t_tr[j];
    if (n <= 0) return trace[j];
    return n < POW_N ? trace[j] * tr_pow[n] : 0.0;
}

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
    if (pl_on) {                       /* learned gains survive a reset; the rest does not */
        for (u32 k = 0; k < n_elig; k++) { trace[elig[k]] = 0.0; flags[elig[k]] &= (u8)~8u; }
        n_elig = 0;
        for (u32 c = 0; c < n_group; c++) dopa[c] = 0.0;
        for (u32 i = 0; i < N; i++) t_tr[i] = 0;
    }
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

/* ------------------------------------------------------- plasticity setup */
EXPORT(fb_plastic_init) i32 fb_plastic_init(u32 groups, u32 mod_capacity) {
    n_group = groups; cap_mod = mod_capacity; n_mod = 0; n_pl_pres = 0; n_elig = 0;
    rowgain = (float **)fb_alloc(N * 4);
    rowgrp  = (i32 **)fb_alloc(N * 4);
    pl_pres = (u32 *)fb_alloc(N * 4);
    elig    = (u32 *)fb_alloc(N * 4);
    trace   = (double *)fb_alloc(N * 8);
    t_tr    = (i32 *)fb_alloc(N * 4);
    mod_at  = (u32 *)fb_alloc(N * 4);
    dopa    = (double *)fb_alloc((groups + 1) * 8);
    tr_pow  = (double *)fb_alloc(POW_N * 8);
    mod_grp = (i32 *)fb_alloc(cap_mod * 4);
    mod_w   = (float *)fb_alloc(cap_mod * 4);
    mod_next= (u32 *)fb_alloc(cap_mod * 4);
    if (!rowgain || !rowgrp || !pl_pres || !elig || !trace || !t_tr || !mod_at ||
        !dopa || !tr_pow || !mod_grp || !mod_w || !mod_next) return -1;
    for (u32 i = 0; i < N; i++) { rowgain[i] = 0; rowgrp[i] = 0; mod_at[i] = NONE;
                                  trace[i] = 0.0; t_tr[i] = 0; }
    for (u32 c = 0; c <= groups; c++) dopa[c] = 0.0;
    pl_on = 1;
    return 0;
}

/* nominate a presynaptic neuron: its whole row gets a gain (1) and a group (-1) */
EXPORT(fb_plastic_pre) i32 fb_plastic_pre(u32 j) {
    if (rowgain[j]) return 0;
    const u32 deg = indptr[j + 1] - indptr[j];
    float *gn = (float *)fb_alloc((deg ? deg : 1) * 4);
    i32 *gr = (i32 *)fb_alloc((deg ? deg : 1) * 4);
    if (!gn || !gr) return -1;
    for (u32 k = 0; k < deg; k++) { gn[k] = 1.0f; gr[k] = -1; }
    rowgain[j] = gn; rowgrp[j] = gr; pl_pres[n_pl_pres++] = j;
    return 0;
}

/* make the j -> i synapse plastic, in dopamine group c */
EXPORT(fb_plastic_mark) i32 fb_plastic_mark(u32 j, u32 i, i32 c) {
    if (!rowgrp[j]) return -1;
    const u32 b = indptr[j], e = indptr[j + 1];
    i32 hit = -1;
    for (u32 q = b; q < e; q++) if (post[q] == i) { rowgrp[j][q - b] = c; hit = 0; }
    return hit;
}

/* a modulator neuron: each spike adds w to group c's dopamine */
EXPORT(fb_mod_add) i32 fb_mod_add(u32 j, i32 c, double w) {
    if (n_mod >= cap_mod) return -1;
    mod_grp[n_mod] = c; mod_w[n_mod] = (float)w; mod_next[n_mod] = mod_at[j];
    mod_at[j] = n_mod++;
    return 0;
}

EXPORT(fb_plastic_params) void fb_plastic_params(double eta, double tr_decay,
                                                 double do_decay, double gain_min,
                                                 double recover, i32 every) {
    P_eta = eta; P_trdec = tr_decay; P_dodec = do_decay;
    P_gmin = gain_min; P_recov = recover; P_every = every > 0 ? every : 1;
    tr_pow[0] = 1.0;
    for (u32 k = 1; k < POW_N; k++) tr_pow[k] = tr_pow[k - 1] * tr_decay;
}

/* forget everything: gains back to 1, traces and dopamine to zero */
EXPORT(fb_plastic_forget) void fb_plastic_forget(void) {
    for (u32 k = 0; k < n_pl_pres; k++) {
        const u32 j = pl_pres[k], deg = indptr[j + 1] - indptr[j];
        for (u32 q = 0; q < deg; q++) rowgain[j][q] = 1.0f;
    }
    for (u32 c = 0; c < n_group; c++) dopa[c] = 0.0;
    for (u32 k = 0; k < n_elig; k++) { trace[elig[k]] = 0.0; flags[elig[k]] &= (u8)~8u; }
    n_elig = 0;
}

EXPORT(fb_dopa_set) void fb_dopa_set(i32 c, double level) {
    if (c >= 0 && (u32)c < n_group) dopa[c] = level;
}

/* mean gain of group c's synapses, and how many they are */
EXPORT(fb_gain_mean) double fb_gain_mean(i32 c) {
    double s = 0.0; u32 n = 0;
    for (u32 k = 0; k < n_pl_pres; k++) {
        const u32 j = pl_pres[k], b = indptr[j], e = indptr[j + 1];
        for (u32 q = b; q < e; q++)
            if (rowgrp[j][q - b] == c) { s += rowgain[j][q - b]; n++; }
    }
    return n ? s / (double)n : 0.0;
}

/* Read the learned weights of one presynaptic population, per group: reset,
 * add the cells one by one, then read the sums and counts. This is how a
 * postsynaptic cell sees that population - the drive it has left. */
static double *probe_sum;
static u32 *probe_n;

EXPORT(fb_gain_probe_reset) i32 fb_gain_probe_reset(void) {
    if (!probe_sum) {
        probe_sum = (double *)fb_alloc((n_group + 1) * 8);
        probe_n = (u32 *)fb_alloc((n_group + 1) * 4);
        if (!probe_sum || !probe_n) return -1;
    }
    for (u32 c = 0; c < n_group; c++) { probe_sum[c] = 0.0; probe_n[c] = 0; }
    return 0;
}

EXPORT(fb_gain_probe_add) void fb_gain_probe_add(u32 j) {
    if (!rowgain[j]) return;
    const u32 b = indptr[j], e = indptr[j + 1];
    for (u32 q = b; q < e; q++) {
        const i32 c = rowgrp[j][q - b];
        if (c >= 0) { probe_sum[c] += (double)rowgain[j][q - b]; probe_n[c]++; }
    }
}

EXPORT(fb_ptr_probe_sum) u32 fb_ptr_probe_sum(void) { return (u32)probe_sum; }
EXPORT(fb_ptr_probe_n)   u32 fb_ptr_probe_n(void)   { return (u32)probe_n; }

/* mean gain of one presynaptic cell's plastic synapses, or -1 if it has none */
EXPORT(fb_gain_pre) double fb_gain_pre(u32 j) {
    if (!rowgain[j]) return -1.0;
    const u32 b = indptr[j], e = indptr[j + 1];
    double s = 0.0; u32 n = 0;
    for (u32 q = b; q < e; q++)
        if (rowgrp[j][q - b] >= 0) { s += (double)rowgain[j][q - b]; n++; }
    return n ? s / (double)n : -1.0;
}

/* the gain of one synapse, or -1 if it is not plastic */
EXPORT(fb_gain_of) double fb_gain_of(u32 j, u32 i) {
    if (!rowgain[j]) return -1.0;
    const u32 b = indptr[j], e = indptr[j + 1];
    for (u32 q = b; q < e; q++)
        if (post[q] == i && rowgrp[j][q - b] >= 0) return rowgain[j][q - b];
    return -1.0;
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
            const u32 b = indptr[j], e = indptr[j + 1];
            const float *rg = pl_on ? rowgain[j] : 0;    /* learned gains, if any */
            for (u32 q = b; q < e; q++) {
                const u32 i = post[q];
                const i32 li = ls[i];
                if (li == t || t - li < rfc_of(i)) continue;   /* refractory: dropped */
                if (!(flags[i] & 1u)) advance(i, t);
                double dg = wsyn * (double)wcount[q];
                if (rg) dg *= (double)rg[q - b];
                g[i] += dg;
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
            if (pl_on) {
                if (rowgain[i]) {                        /* a nominated presynaptic cell */
                    trace[i] = trace_at(i, t) + 1.0;
                    t_tr[i] = t;
                    if (!(flags[i] & 8u)) { flags[i] |= 8u; elig[n_elig++] = i; }
                }
                for (u32 m = mod_at[i]; m != NONE; m = mod_next[m])
                    dopa[mod_grp[m]] += (double)mod_w[m];   /* a dopaminergic cell */
            }
            if (rec_n < rec_cap) { rec_idx[rec_n] = i; rec_step[rec_n] = (u32)t; rec_n++; }
            else rec_lost++;
        }
        ring_n[slot_in] = n_fired;
        total += n_fired;

        /* 5: learning - dopamine meets a recently active presynaptic cell */
        if (pl_on && (t % P_every) == 0) {
            u32 wet = 0;
            for (u32 c = 0; c < n_group; c++) if (dopa[c] > 1e-9) wet = 1;
            if (wet) {
                u32 keep2 = 0;
                for (u32 k = 0; k < n_elig; k++) {
                    const u32 j = elig[k];
                    const double tr = trace_at(j, t);
                    if (tr < 1e-4) { flags[j] &= (u8)~8u; trace[j] = 0.0; continue; }
                    elig[keep2++] = j;
                    const u32 b = indptr[j], e = indptr[j + 1];
                    const i32 *gr = rowgrp[j]; float *gn = rowgain[j];
                    const double dtr = P_eta * tr;
                    for (u32 q = b; q < e; q++) {
                        const i32 c = gr[q - b];
                        if (c < 0) continue;
                        const double d = dopa[c];
                        if (d <= 1e-9) continue;
                        double m = (double)gn[q - b] - dtr * d;
                        if (m < P_gmin) m = P_gmin;
                        gn[q - b] = (float)m;
                    }
                }
                n_elig = keep2;
            } else {
                u32 keep2 = 0;
                for (u32 k = 0; k < n_elig; k++) {
                    const u32 j = elig[k];
                    if (trace_at(j, t) < 1e-4) { flags[j] &= (u8)~8u; trace[j] = 0.0; }
                    else elig[keep2++] = j;
                }
                n_elig = keep2;
            }
            for (u32 c = 0; c < n_group; c++) dopa[c] *= P_dodec;
            if (P_recov > 0.0) {                          /* forgetting */
                for (u32 k = 0; k < n_pl_pres; k++) {
                    const u32 j = pl_pres[k], b = indptr[j], e = indptr[j + 1];
                    const i32 *gr = rowgrp[j]; float *gn = rowgain[j];
                    for (u32 q = b; q < e; q++)
                        if (gr[q - b] >= 0 && gn[q - b] < 1.0f)
                            gn[q - b] += (float)((1.0 - (double)gn[q - b]) * P_recov);
                }
            }
        }
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
