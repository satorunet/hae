"""Drive MyoFullBody's 416 muscles toward a target posture.

Every control step (10 ms):
  1. the joint-space error to the target posture gives a desired acceleration
     (PD: qacc = kp * (q_ref - q) - kd * qvel),
  2. inverse dynamics (mj_inverse) turns it into the generalized forces needed,
     including gravity, the feet on the floor and the model's own constraints,
  3. the muscle excitations u in [0, 1] that best produce those forces are found by
     bounded least squares on the moment arms: tau = J^T (gain(len, vel) * u + passive),
  4. whatever the muscles cannot supply is left to *residual* forces - on the free
     root (the body's 6 degrees of freedom in space, which no muscle can push) and
     small reserves on every joint - and those are recorded, so it is always visible
     how much of the movement was not done by muscle.

This is the "computed muscle control" idea used with OpenSim models, kept simple.
"""
import numpy as np
import mujoco

FORWARD = np.array([0.0, -1.0, 0.0])    # the model faces -y
RIGHT = np.array([-1.0, 0.0, 0.0])      # its right is -x
UP = np.array([0.0, 0.0, 1.0])


class MuscleDriver:
    def __init__(self, m, kp=120.0, kd=22.0, reg=2e-3, reserve=8.0, root_limits=(400.0, 200.0), iters=80,
                 instant=False, mode='bias'):
        self.m, self.kp, self.kd, self.reg, self.iters = m, kp, kd, reg, iters
        self.mode = mode
        self.instant = instant                  # True: activation = excitation at once (no 15-50 ms rise)
        self.reserve = reserve                  # N m (or N) any joint may get beyond its muscles
        self.root_force, self.root_torque = root_limits
        self.nu, self.nv = m.nu, m.nv
        self.J = np.zeros((m.nu, m.nv))
        self.u = np.zeros(m.nu)
        self.scratch = mujoco.MjData(m)
        # joints driven by an equality constraint (patella, scapula "phantoms", lumbar
        # couplings) follow their leader; only the leaders are tracked and solved for
        follower = {int(m.eq_obj1id[e]) for e in range(m.neq) if m.eq_type[e] == mujoco.mjtEq.mjEQ_JOINT}
        self.indep = np.array([k for k in range(6, m.nv) if int(m.dof_jntid[k]) not in follower])
        self.follow = np.array([k for k in range(6, m.nv) if int(m.dof_jntid[k]) in follower])

    def gains(self, d):
        """Force per unit activation, and passive force, of every muscle at its current length/velocity."""
        m = self.m
        g = np.empty(self.nu); b = np.empty(self.nu)
        for i in range(self.nu):
            L, V = d.actuator_length[i], d.actuator_velocity[i]
            lr, acc0 = m.actuator_lengthrange[i], m.actuator_acc0[i]
            g[i] = mujoco.mju_muscleGain(L, V, lr, acc0, m.actuator_gainprm[i, :9])
            b[i] = mujoco.mju_muscleBias(L, lr, acc0, m.actuator_biasprm[i, :9])
        return g, b

    def moments(self, d):
        mujoco.mju_sparse2dense(self.J, d.actuator_moment, d.moment_rownnz, d.moment_rowadr, d.moment_colind)
        return self.J

    def _eq_project(self, s, qacc):
        """Remove the part of qacc that the equality constraints forbid (J_eq qacc = 0)."""
        m = self.m
        rows = np.where(s.efc_type[:s.nefc] == mujoco.mjtConstraint.mjCNSTR_EQUALITY)[0]
        if not len(rows):
            return qacc
        if mujoco.mj_isSparse(m):
            Jd = np.zeros((s.nefc, m.nv))
            mujoco.mju_sparse2dense(Jd, s.efc_J, s.efc_J_rownnz, s.efc_J_rowadr, s.efc_J_colind)
        else:
            Jd = s.efc_J[:s.nefc * m.nv].reshape(s.nefc, m.nv)
        Je = Jd[rows]
        lam = np.linalg.lstsq(Je @ Je.T + 1e-9 * np.eye(len(rows)), Je @ qacc, rcond=None)[0]
        return qacc - Je.T @ lam

    def _solve(self, A, r):
        """min |A u - r|^2 + reg |u|^2 over 0 <= u <= 1, accelerated projected gradient from the last u."""
        lam = self.reg * float((A * A).sum(0).max())
        L = float(np.linalg.norm(A, 2) ** 2) + lam
        u = self.u.copy(); y = u.copy(); t = 1.0
        for _ in range(self.iters):
            grad = A.T @ (A @ y - r) + lam * y
            un = np.clip(y - grad / L, 0.0, 1.0)
            tn = 0.5 * (1 + np.sqrt(1 + 4 * t * t))
            y = un + ((t - 1) / tn) * (un - u)
            u, t = un, tn
        return u

    def step(self, d, q_ref, qvel_ref=None):
        """Set d.ctrl (muscles) and d.qfrc_applied (residuals). Returns a dict of what was needed."""
        m, s = self.m, self.scratch
        err = np.zeros(self.nv)
        mujoco.mj_differentiatePos(m, err, 1.0, d.qpos, q_ref)
        qv_ref = np.zeros(self.nv) if qvel_ref is None else qvel_ref
        qacc = self.kp * err + self.kd * (qv_ref - d.qvel)
        qacc[self.follow] = 0.0

        if self.mode == 'inverse':
            # inverse dynamics on a copy, so the live state is untouched
            s.qpos[:] = d.qpos; s.qvel[:] = d.qvel; s.act[:] = d.act; s.time = d.time
            mujoco.mj_forward(m, s)
            qacc = self._eq_project(s, qacc)
            s.qacc[:] = qacc
            mujoco.mj_inverse(m, s)
            tau = s.qfrc_inverse.copy()
        else:
            # computed torque without the constraint solve: M qacc + gravity/Coriolis;
            # the equality constraints, joint limits and the floor act in the simulation itself
            tau = np.zeros(self.nv)
            mujoco.mj_mulM(m, d, tau, qacc)
            tau += d.qfrc_bias
        J = self.moments(d)
        g, b = self.gains(d)
        ix = self.indep
        A = J[:, ix].T * g                     # independent joints x muscles
        rhs = tau[ix] - J[:, ix].T @ b
        u = self._solve(A, rhs)
        produced = J.T @ (g * u + b)
        res = tau - produced
        resid = np.zeros(self.nv)
        resid[:3] = np.clip(res[:3], -self.root_force, self.root_force)
        resid[3:6] = np.clip(res[3:6], -self.root_torque, self.root_torque)
        resid[ix] = np.clip(res[ix], -self.reserve, self.reserve)
        d.ctrl[:] = u
        if self.instant:
            d.act[m.actuator_actadr] = u
        d.qfrc_applied[:] = resid
        self.u = u
        return {
            'root_force': float(np.linalg.norm(resid[:3])),
            'root_torque': float(np.linalg.norm(resid[3:6])),
            'reserve': float(np.abs(resid[ix]).max()),
            'unmet': float(np.linalg.norm(res[ix] - resid[ix])),
            'effort': float(np.mean(u)),
        }
