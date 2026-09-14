// The muscle driver of ../muscles.py, for MuJoCo's WebAssembly build (browser worker or Node).
//
// Every control step: PD on the joints the model lets move freely -> computed torque
// (M qacc + gravity/Coriolis) -> muscle excitations in [0, 1] by bounded least squares
// on the moment arms (accelerated projected gradient, warm-started) -> what the muscles
// cannot supply goes to residuals: the support on the free root, small reserves elsewhere.
export class MuscleDriver {
  constructor(mj, m, { kp = 120, kd = 22, reg = 2e-3, reserve = 8, rootForce = 3000, rootTorque = 1500, iters = 30, maxErr = Infinity, rootCarried = false, instant = false, bigReserve = reserve, stance = null, balance = null } = {}) {
    // maxErr: joint error the PD sees is capped (rad), so a sudden new target asks for a quick move, not an impossible one
    Object.assign(this, { mj, m, kp, kd, reg, reserve, rootForce, rootTorque, iters, maxErr });
    // rootCarried: the root is moved along its target by the caller, not by force, so the limbs'
    // torques must not count on the root accelerating toward it
    this.rootCarried = rootCarried;
    this.instant = instant;
    this.bigReserve = bigReserve;            // joint torque allowed beyond the muscles on the big joints (N m)
    // stance: () => [{ body, p }], the points where the body is on the floor now. Computed torque alone
    // plans each joint as if the body hung from its root, which only works if something holds the
    // root. Standing on its hands and knees, the body is held from below instead: the wrench the root
    // needs (to bear its weight and follow its target) is shared out as forces at the stance points,
    // and the joint torques that push those forces into the floor are added to what the muscles give.
    // (Feeding back the measured contact forces instead made the torque cancel its own push, and the
    // body sank to the floor.)
    this.stance = stance;
    // balance: { ang: [kp, kd], z: [kp, kd] } - with the root not carried, the root's tilt and height are
    // brought back toward their targets through the stance forces too (the body leaning on its limbs)
    this.balance = balance;
    if (stance) { this.jacp = new mj.DoubleBuffer(3 * m.nv); }
    const nv = m.nv, nu = m.nu;
    this.nv = nv; this.nu = nu;
    // Joints slaved to another by an equality (q_f = poly(q_leader): the lumbar levels follow
    // flex_extension, the scapula follows shoulder elevation, the patella the knee). Only leaders
    // are solved for, but a follower's load and a follower's muscle moments act on its leader
    // through dq_f/dq_leader, so they are folded in (virtual work). Without that, the weight of
    // the trunk on the lumbar levels went unanswered and the spine folded on all fours.
    const follower = new Set();
    const eqData = Float64Array.from(m.eq_data), nd = eqData.length / Math.max(1, m.neq);
    const jdof = Int32Array.from(m.jnt_dofadr), jq = Int32Array.from(m.jnt_qposadr);
    this.coupling = [];
    for (let e = 0; e < m.neq; e++) {
      if (m.eq_type[e] !== mj.mjtEq.mjEQ_JOINT.value) continue;
      follower.add(m.eq_obj1id[e]);
      if (m.eq_obj2id[e] >= 0) this.coupling.push({ f: jdof[m.eq_obj1id[e]], l: jdof[m.eq_obj2id[e]], ql: jq[m.eq_obj2id[e]], a: Array.from(eqData.subarray(e * nd + 1, e * nd + 5)) });
    }
    // Stiffness on top of computed torque. Computed torque corrects an error with M * kp * err,
    // which for a light limb is a few N m - smaller than the error in modelling the muscles, so an
    // arm holding its own weight settled 0.6 rad off target. A torque-level spring and damper
    // (N m / rad) closes that gap: full strength on the big joints, a little on fingers and toes.
    // (Scaling it by each joint's inertia failed: the shoulder's phantom chain reports almost none.)
    // Followers get none: they sit where their leader's coupling puts them.
    this.kt = new Float64Array(m.nv); this.kdt = new Float64Array(m.nv); this.reserveOf = new Float64Array(m.nv).fill(reserve);
    for (let j = 0; j < m.njnt; j++) {
      const k = m.jnt_dofadr[j], name = m.jnt(j).name;
      if (k < 6 || follower.has(j)) continue;          // followers sit where their leader puts them
      // three sizes: a stiff light joint chatters at this time step (the wrist hit 120 rad/s)
      const small = /^(cmc_|mp_flexion|ip_flexion|mcp\d|pm\d|md\d|mtp_)/.test(name);
      const medium = /^(pro_sup|flexion_|deviation|ankle|subtalar|neck_)/.test(name);
      const spine = /^(flex_extension|lat_bending|axial_rotation)$/.test(name);   // carries the trunk through its coupled levels
      this.kt[k] = small ? 0.8 : medium ? 6 : spine ? 400 : 60; this.kdt[k] = small ? 0.02 : medium ? 0.3 : spine ? 20 : 3;
      this.reserveOf[k] = small || medium ? this.reserve : spine ? 3 * this.bigReserve : this.bigReserve;
    }
    this.indep = []; this.follow = [];
    for (let k = 6; k < nv; k++) (follower.has(m.dof_jntid[k]) ? this.follow : this.indep).push(k);
    this.col = new Int32Array(nv).fill(-1);
    this.indep.forEach((k, r) => (this.col[k] = r));
    this.u = new Float64Array(nu);
    this.g = new Float64Array(nu); this.b = new Float64Array(nu);
    this.err = new mj.DoubleBuffer(nv);
    this.mq = new mj.DoubleBuffer(nv);
    this.qacc = new Array(nv).fill(0);
    const ni = this.indep.length;
    this.A = new Float64Array(ni * nu); this.rhs = new Float64Array(ni);
    this.tau = new Float64Array(nv); this.prod = new Float64Array(nv);
    this.resid = new Float64Array(nv);
    // constants copied once
    this.lr = Float64Array.from(m.actuator_lengthrange); this.acc0 = Float64Array.from(m.actuator_acc0);
    this.gp = Float64Array.from(m.actuator_gainprm); this.bp = Float64Array.from(m.actuator_biasprm);
    this.actadr = Int32Array.from(m.actuator_actadr);
  }

  gains(d) {
    const L = d.actuator_length, V = d.actuator_velocity, { lr, acc0, gp, bp, g, b } = this;
    const MIN = 1e-15;
    for (let i = 0; i < this.nu; i++) {
      const p = i * 10;
      let force = gp[p + 2];
      if (force < 0) force = gp[p + 3] / Math.max(MIN, acc0[i]);
      const r0 = gp[p], r1 = gp[p + 1], lmin = gp[p + 4], lmax = gp[p + 5], vmax = gp[p + 6], fvmax = gp[p + 8];
      const L0 = (lr[2 * i + 1] - lr[2 * i]) / Math.max(MIN, r1 - r0);
      const len = r0 + (L[i] - lr[2 * i]) / Math.max(MIN, L0);
      const vel = V[i] / Math.max(MIN, L0 * vmax);
      // active force-length
      let FL = 0;
      if (len >= lmin && len <= lmax) {
        const a = 0.5 * (lmin + 1), bb = 0.5 * (1 + lmax);
        if (len <= a) { const x = (len - lmin) / Math.max(MIN, a - lmin); FL = 0.5 * x * x; }
        else if (len <= 1) { const x = (1 - len) / Math.max(MIN, 1 - a); FL = 1 - 0.5 * x * x; }
        else if (len <= bb) { const x = (len - 1) / Math.max(MIN, bb - 1); FL = 1 - 0.5 * x * x; }
        else { const x = (lmax - len) / Math.max(MIN, lmax - bb); FL = 0.5 * x * x; }
      }
      // force-velocity
      const y = fvmax - 1;
      const FV = vel <= -1 ? 0 : vel <= 0 ? (vel + 1) * (vel + 1) : vel <= y ? fvmax - (y - vel) * (y - vel) / Math.max(MIN, y) : fvmax;
      g[i] = -force * FL * FV;
      // passive, from the bias parameters (they can differ from the gain's)
      let bforce = bp[p + 2];
      if (bforce < 0) bforce = bp[p + 3] / Math.max(MIN, acc0[i]);
      const bL0 = (lr[2 * i + 1] - lr[2 * i]) / Math.max(MIN, bp[p + 1] - bp[p]);
      const blen = bp[p] + (L[i] - lr[2 * i]) / Math.max(MIN, bL0);
      const bb = 0.5 * (1 + bp[p + 5]);
      let FP = 0;
      if (blen > 1) {
        if (blen <= bb) { const x = (blen - 1) / Math.max(MIN, bb - 1); FP = 0.5 * x * x; }
        else { const x = (blen - bb) / Math.max(MIN, bb - 1); FP = 0.5 + x; }
      }
      b[i] = -bforce * bp[p + 7] * FP;
    }
  }

  step(d, qRef, qvelRef = null) {
    const { mj, m, nv, nu, indep, col } = this;
    mj.mj_differentiatePos(m, this.err, 1.0, Array.from(d.qpos), Array.from(qRef));
    const err = this.err.GetView(), qvel = d.qvel, qacc = this.qacc;
    const cap = this.maxErr;
    for (let k = 0; k < nv; k++) {
      const e = k < 6 ? err[k] : Math.max(-cap, Math.min(cap, err[k]));
      qacc[k] = this.kp * e + this.kd * ((qvelRef ? qvelRef[k] : 0) - qvel[k]);
    }
    for (const k of this.follow) qacc[k] = 0;
    if (this.rootCarried) for (let k = 0; k < 6; k++) qacc[k] = 0;
    if (this.balance) {
      const { ang, z, xy } = this.balance;
      for (let k = 0; k < 2; k++) qacc[k] = xy ? xy[0] * err[k] - xy[1] * qvel[k] : 0;
      qacc[2] = z[0] * err[2] - z[1] * qvel[2];
      for (let k = 3; k < 6; k++) qacc[k] = ang[0] * err[k] - ang[1] * qvel[k];
    }
    const qpos = d.qpos;
    for (const c of this.coupling) {                     // slope of each follower on its leader, here
      const x = qpos[c.ql], a = c.a;
      c.s = a[0] + x * (2 * a[1] + x * (3 * a[2] + x * 4 * a[3]));
      qacc[c.f] = c.s * qacc[c.l];
    }
    mj.mj_mulM(m, d, this.mq, qacc);
    const Mq = this.mq.GetView(), bias = d.qfrc_bias, tau = this.tau;
    for (let k = 0; k < nv; k++) tau[k] = Mq[k] + bias[k];

    for (let k = 6; k < nv; k++) tau[k] += this.kt[k] * err[k] + this.kdt[k] * ((qvelRef ? qvelRef[k] : 0) - qvel[k]);
    this.support = 0;
    if (this.stance) this.shareOut(d, tau);
    if (this.contacts && d.nefc) {
      const type = d.efc_type, force = d.efc_force, v = new Array(d.nefc);
      for (let i = 0; i < d.nefc; i++) v[i] = type[i] >= 5 ? force[i] : 0;            // contact rows only
      mj.mj_mulJacTVec(m, d, this.qcon, v);
      const qc = this.qcon.GetView();
      for (let k = 6; k < nv; k++) tau[k] -= qc[k];
    }
    for (const c of this.coupling) tau[c.l] += c.s * tau[c.f];   // the leader carries its followers' load

    this.gains(d);
    const { A, rhs, g, b } = this, ni = indep.length;
    A.fill(0);
    for (let r = 0; r < ni; r++) rhs[r] = tau[indep[r]];
    const mom = d.actuator_moment, rownnz = d.moment_rownnz, rowadr = d.moment_rowadr, colind = d.moment_colind;
    const prod = this.prod.fill(0);
    const lead = this.leadOf || (this.leadOf = (() => { const t = new Map(); for (const c of this.coupling) t.set(c.f, c); return t; })());
    for (let i = 0; i < nu; i++) {
      for (let q = rowadr[i], e = rowadr[i] + rownnz[i]; q < e; q++) {
        const k = colind[q];
        let r = col[k], w = mom[q];
        if (r < 0) { const c = lead.get(k); if (!c) continue; r = col[c.l]; w *= c.s; if (r < 0) continue; }
        A[r * nu + i] += w * g[i]; rhs[r] -= w * b[i];
      }
    }
    const u = this.solve(ni);
    for (let i = 0; i < nu; i++) {
      const f = g[i] * u[i] + b[i];
      for (let q = rowadr[i], e = rowadr[i] + rownnz[i]; q < e; q++) prod[colind[q]] += mom[q] * f;
    }
    for (const c of this.coupling) prod[c.l] += c.s * prod[c.f];  // what the muscles do through the followers
    const resid = this.resid, clip = (x, c) => (x < -c ? -c : x > c ? c : x);
    let unmet = 0, rf = 0, rt = 0, rmax = 0, assist = 0
    for (let k = 0; k < nv; k++) {
      const res = tau[k] - prod[k];
      if (k < 3) { resid[k] = clip(res, this.rootForce); rf += resid[k] ** 2; }
      else if (k < 6) { resid[k] = clip(res, this.rootTorque); rt += resid[k] ** 2; }
      else if (col[k] >= 0) { resid[k] = clip(res, this.reserveOf[k]); unmet += (res - resid[k]) ** 2; rmax = Math.max(rmax, Math.abs(resid[k])); assist += Math.abs(resid[k]); }
      else resid[k] = 0;
    }
    const ctrl = d.ctrl, applied = d.qfrc_applied;
    let effort = 0;
    for (let i = 0; i < nu; i++) { ctrl[i] = u[i]; effort += u[i]; }
    if (this.instant) { const act = d.act; for (let i = 0; i < nu; i++) act[this.actadr[i]] = u[i]; }
    for (let k = 0; k < nv; k++) applied[k] = resid[k];
    return { support: this.support, rootForce: Math.sqrt(rf), rootTorque: Math.sqrt(rt), reserve: rmax, assist, unmet: Math.sqrt(unmet), effort: effort / nu };
  }

  // the root's wrench (tau[0..5]) as forces f_i at the stance points: min |sum J_i,root^T f_i - tau_root|^2
  // + lam |f|^2, pushing into the floor only; then tau_joint -= sum J_i,joint^T f_i (the floor pushes
  // f_i up the limb, so the limb must push -f_i down: its joints give J^T f)
  shareOut(d, tau) {
    const { mj, m, nv } = this, pts = this.stance();
    const n = pts.length;
    if (!n) return;
    const Js = pts.map((c) => { mj.mj_jac(m, d, this.jacp, null, c.p, c.body); return Float64Array.from(this.jacp.GetView()); });
    const N = 3 * n, A = Array.from({ length: N }, () => new Float64Array(N)), b = new Float64Array(N);
    // normal equations over the 6 root rows
    for (let r = 0; r < 6; r++) {
      const row = new Float64Array(N);
      for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) row[3 * i + a] = Js[i][a * nv + r];
      for (let x = 0; x < N; x++) { b[x] += row[x] * tau[r]; for (let y = 0; y < N; y++) A[x][y] += row[x] * row[y]; }
    }
    for (let x = 0; x < N; x++) A[x][x] += (self.__T?.reg ?? 0.02) * (x % 3 === 2 ? 1 : 5);   // (sideways forces cost more than vertical ones)
    const f = gauss(A, b);
    let fz = 0;
    for (let i = 0; i < n; i++) {
      if (f[3 * i + 2] < 0) f[3 * i + 2] = 0;                                  // the floor only pushes
      const lim = 0.8 * f[3 * i + 2];                                          // and holds sideways only so hard (friction)
      for (let a = 0; a < 2; a++) f[3 * i + a] = Math.max(-lim, Math.min(lim, f[3 * i + a]));
      fz += f[3 * i + 2];
    }
    for (let i = 0; i < n; i++) for (let k = 6; k < nv; k++) tau[k] -= Js[i][k] * f[3 * i] + Js[i][nv + k] * f[3 * i + 1] + Js[i][2 * nv + k] * f[3 * i + 2];
    this.support = fz;
  }

  // min |A u - rhs|^2 + lam |u|^2, 0 <= u <= 1
  solve(ni) {
    const { A, rhs, nu, u } = this;
    if (!this.work || this.work.r.length !== ni) this.work = { r: new Float64Array(ni), grad: new Float64Array(nu), y: new Float64Array(nu), un: new Float64Array(nu), v: new Float64Array(nu) };
    const { r, grad, y, un, v } = this.work;
    // lam from the largest column norm, L from a few power iterations on A^T A
    let colmax = 0;
    for (let i = 0; i < nu; i++) { let s = 0; for (let q = 0; q < ni; q++) s += A[q * nu + i] ** 2; if (s > colmax) colmax = s; }
    const lam = this.reg * colmax;
    if (!this.vpow) { this.vpow = new Float64Array(nu).fill(1 / Math.sqrt(nu)); }
    let L = 0;
    for (let it = 0; it < 4; it++) {
      for (let q = 0; q < ni; q++) { let s = 0; for (let i = 0; i < nu; i++) s += A[q * nu + i] * this.vpow[i]; r[q] = s; }
      let nrm = 0;
      for (let i = 0; i < nu; i++) { let s = 0; for (let q = 0; q < ni; q++) s += A[q * nu + i] * r[q]; v[i] = s; nrm += s * s; }
      nrm = Math.sqrt(nrm) || 1; L = nrm;
      for (let i = 0; i < nu; i++) this.vpow[i] = v[i] / nrm;
    }
    L = L * 1.05 + lam;
    y.set(u); let t = 1;
    for (let it = 0; it < this.iters; it++) {
      for (let q = 0; q < ni; q++) { let s = -rhs[q]; const row = q * nu; for (let i = 0; i < nu; i++) s += A[row + i] * y[i]; r[q] = s; }
      for (let i = 0; i < nu; i++) { let s = lam * y[i]; for (let q = 0; q < ni; q++) s += A[q * nu + i] * r[q]; grad[i] = s; }
      for (let i = 0; i < nu; i++) { const x = y[i] - grad[i] / L; un[i] = x < 0 ? 0 : x > 1 ? 1 : x; }
      const tn = 0.5 * (1 + Math.sqrt(1 + 4 * t * t)), w = (t - 1) / tn;
      for (let i = 0; i < nu; i++) { y[i] = un[i] + w * (un[i] - u[i]); u[i] = un[i]; }
      t = tn;
    }
    return u;
  }
}

function gauss(A, b) {                         // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / piv; if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let v = M[r][n]; for (let j = r + 1; j < n; j++) v -= M[r][j] * x[j]; x[r] = v / (M[r][r] || 1e-12); }
  return x;
}
