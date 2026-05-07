function normalizeQuat(quat) {
  const [w, x, y, z] = quat;
  const n = Math.hypot(w, x, y, z);
  if (n < 1e-9) {
    return [1, 0, 0, 0];
  }
  const inv = 1 / n;
  return [w * inv, x * inv, y * inv, z * inv];
}

function quatMultiply(a, b) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw
  ];
}

function quatInverse(quat) {
  const [w, x, y, z] = quat;
  const normSq = w * w + x * x + y * y + z * z;
  if (normSq < 1e-9) {
    return [1, 0, 0, 0];
  }
  const inv = 1 / normSq;
  return [w * inv, -x * inv, -y * inv, -z * inv];
}

function quatApplyInv(quat, vec) {
  const [w, x, y, z] = normalizeQuat(quat);
  const vx = vec[0];
  const vy = vec[1];
  const vz = vec[2];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  const cx = y * tz - z * ty;
  const cy = z * tx - x * tz;
  const cz = x * ty - y * tx;
  return [
    vx - w * tx + cx,
    vy - w * ty + cy,
    vz - w * tz + cz
  ];
}

function clampFutureIndices(base, steps, length) {
  return steps.map((step) => {
    const idx = base + step;
    if (idx < 0) {
      return 0;
    }
    if (idx >= length) {
      return length - 1;
    }
    return idx;
  });
}

function readVector(values, length, fallback = 0) {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = Number(values?.[index]);
    out[index] = Number.isFinite(value) ? value : fallback;
  }
  return out;
}

function readRootQuat(values) {
  return normalizeQuat([
    Number(values?.[0] ?? 1),
    Number(values?.[1] ?? 0),
    Number(values?.[2] ?? 0),
    Number(values?.[3] ?? 0)
  ]);
}

function quatToEulerWxyz(quat) {
  const [w, x, y, z] = normalizeQuat(quat);
  const roll = Math.atan2(
    2 * (w * x + y * z),
    1 - 2 * (x * x + y * y)
  );
  const pitchSine = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const pitch = Math.asin(pitchSine);
  const yaw = Math.atan2(
    2 * (w * z + x * y),
    1 - 2 * (y * y + z * z)
  );
  return [roll, pitch, yaw];
}

function estimateRowVelocity(rows, index, dt, length) {
  const out = new Float32Array(length);
  if (!rows?.length || dt <= 0) {
    return out;
  }
  const currentIndex = Math.max(0, Math.min(index, rows.length - 1));
  const otherIndex = currentIndex < rows.length - 1 ? currentIndex + 1 : currentIndex - 1;
  if (otherIndex < 0 || otherIndex >= rows.length) {
    return out;
  }
  const sign = otherIndex > currentIndex ? 1 : -1;
  const current = rows[currentIndex];
  const other = rows[otherIndex];
  for (let axis = 0; axis < length; axis += 1) {
    out[axis] = sign * (Number(other?.[axis] ?? 0) - Number(current?.[axis] ?? 0)) / dt;
  }
  return out;
}

function estimateAngularVelocity(quats, index, dt) {
  const out = new Float32Array(3);
  if (!quats?.length || dt <= 0) {
    return out;
  }
  const currentIndex = Math.max(0, Math.min(index, quats.length - 1));
  const otherIndex = currentIndex < quats.length - 1 ? currentIndex + 1 : currentIndex - 1;
  if (otherIndex < 0 || otherIndex >= quats.length) {
    return out;
  }
  const current = readRootQuat(quats[currentIndex]);
  const other = readRootQuat(quats[otherIndex]);
  let delta = otherIndex > currentIndex
    ? quatMultiply(other, quatInverse(current))
    : quatMultiply(current, quatInverse(other));
  delta = normalizeQuat(delta);
  if (delta[0] < 0) {
    delta = delta.map((value) => -value);
  }
  const w = Math.max(-1, Math.min(1, delta[0]));
  const sinHalfAngle = Math.sqrt(Math.max(0, 1 - w * w));
  if (sinHalfAngle < 1e-6) {
    out[0] = (2 * delta[1]) / dt;
    out[1] = (2 * delta[2]) / dt;
    out[2] = (2 * delta[3]) / dt;
    return out;
  }
  const angle = 2 * Math.acos(w);
  const scale = angle / (sinHalfAngle * dt);
  out[0] = delta[1] * scale;
  out[1] = delta[2] * scale;
  out[2] = delta[3] * scale;
  return out;
}

export class Twist2StudentFutureObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.numActions = policy.numActions;
    this.motionSteps = (kwargs.motion_steps ?? [0]).slice();
    this.futureSteps = (kwargs.future_steps ?? [0]).slice();
    this.historyLen = Math.max(0, Math.floor(kwargs.history_len ?? 10));
    this.policyDt = Number(kwargs.policy_dt ?? 0.02);
    this.angularVelocityFrame = kwargs.angular_velocity_frame === 'world' ? 'world' : 'local';
    this.historyReset = kwargs.history_reset === 'zeros' ? 'zeros' : 'current';
    this.obsScales = {
      ang_vel: Number(kwargs.obs_scales?.ang_vel ?? 0.25),
      dof_pos: Number(kwargs.obs_scales?.dof_pos ?? 1),
      dof_vel: Number(kwargs.obs_scales?.dof_vel ?? 0.05)
    };
    this.zeroDofVelIndices = (kwargs.zero_dof_vel_indices ?? [4, 5, 10, 11]).slice();
    this.mimicSingleSize = 6 + this.numActions;
    this.mimicSize = this.motionSteps.length * this.mimicSingleSize;
    this.proprioSize = 3 + 2 + 3 * this.numActions;
    this.obsSingleSize = this.mimicSize + this.proprioSize;
    this.futureSize = this.futureSteps.length * this.mimicSingleSize;
    this.history = Array.from({ length: this.historyLen }, () => new Float32Array(this.obsSingleSize));
  }

  get size() {
    return this.obsSingleSize * (this.historyLen + 1) + this.futureSize;
  }

  reset(state = null) {
    if (this.historyReset === 'zeros') {
      for (const entry of this.history) {
        entry.fill(0);
      }
      return;
    }
    const resetState = state ?? {
      jointPos: this.policy.defaultJointPos,
      jointVel: new Float32Array(this.numActions),
      rootPos: new Float32Array([0, 0, 0.78]),
      rootQuat: new Float32Array([1, 0, 0, 0]),
      rootAngVel: new Float32Array(3)
    };
    const current = this._buildObsSingle(resetState);
    for (const entry of this.history) {
      entry.set(current);
    }
  }

  compute(state) {
    const current = this._buildObsSingle(state);
    const future = this._buildFutureObs();
    const out = new Float32Array(this.size);
    let offset = 0;
    out.set(current, offset);
    offset += current.length;
    for (const entry of this.history) {
      out.set(entry, offset);
      offset += entry.length;
    }
    out.set(future, offset);
    this._pushHistory(current);
    return out;
  }

  _pushHistory(current) {
    if (this.historyLen === 0) {
      return;
    }
    for (let index = 0; index < this.history.length - 1; index += 1) {
      this.history[index].set(this.history[index + 1]);
    }
    this.history[this.history.length - 1].set(current);
  }

  _buildObsSingle(state) {
    const out = new Float32Array(this.obsSingleSize);
    let offset = 0;
    for (const step of this.motionSteps) {
      out.set(this._buildMimicFrame(step, 'motion'), offset);
      offset += this.mimicSingleSize;
    }
    out.set(this._buildProprio(state), offset);
    return out;
  }

  _buildFutureObs() {
    const out = new Float32Array(this.futureSize);
    let offset = 0;
    for (const step of this.futureSteps) {
      out.set(this._buildMimicFrame(step, 'future'), offset);
      offset += this.mimicSingleSize;
    }
    return out;
  }

  _buildMimicFrame(step, slot = 'motion') {
    const tracking = this.policy.tracking;
    const out = new Float32Array(this.mimicSingleSize);
    if (!tracking?.isReady()) {
      return out;
    }
    const [index] = clampFutureIndices(tracking.refIdx, [step], tracking.refLen);
    const rootPos = readVector(tracking.refRootPos[index], 3, 0);
    const rootQuat = readRootQuat(tracking.refRootQuat[index]);
    const rootVel = estimateRowVelocity(tracking.refRootPos, index, this.policyDt, 3);
    const rootVelLocal = quatApplyInv(rootQuat, rootVel);
    const rootAngVel = estimateAngularVelocity(tracking.refRootQuat, index, this.policyDt);
    const rootAngVelLocal = quatApplyInv(rootQuat, rootAngVel);
    const [roll, pitch] = quatToEulerWxyz(rootQuat);

    out[0] = rootVelLocal[0];
    out[1] = rootVelLocal[1];
    out[2] = rootPos[2];
    out[3] = roll;
    out[4] = pitch;
    out[5] = rootAngVelLocal[2];
    out.set(readVector(tracking.refJointPos[index], this.numActions, 0), 6);
    return this.policy.smoothTargetVector?.(`Twist2StudentFutureObs:${slot}:${step}`, out) ?? out;
  }

  _buildProprio(state = {}) {
    const out = new Float32Array(this.proprioSize);
    const rootQuat = readRootQuat(state?.rootQuat);
    const rootAngVelWorld = readVector(state?.rootAngVel, 3, 0);
    const rootAngVel = this.angularVelocityFrame === 'world'
      ? rootAngVelWorld
      : quatApplyInv(rootQuat, rootAngVelWorld);
    const [roll, pitch] = quatToEulerWxyz(rootQuat);
    const jointPos = readVector(state?.jointPos, this.numActions, 0);
    const jointVel = readVector(state?.jointVel, this.numActions, 0);
    const defaultJointPos = readVector(this.policy.defaultJointPos, this.numActions, 0);
    const lastActions = readVector(this.policy.lastActions, this.numActions, 0);

    let offset = 0;
    out[offset] = rootAngVel[0] * this.obsScales.ang_vel;
    out[offset + 1] = rootAngVel[1] * this.obsScales.ang_vel;
    out[offset + 2] = rootAngVel[2] * this.obsScales.ang_vel;
    offset += 3;
    out[offset] = roll;
    out[offset + 1] = pitch;
    offset += 2;
    for (let index = 0; index < this.numActions; index += 1) {
      out[offset + index] = (jointPos[index] - defaultJointPos[index]) * this.obsScales.dof_pos;
    }
    offset += this.numActions;
    for (let index = 0; index < this.numActions; index += 1) {
      out[offset + index] = jointVel[index] * this.obsScales.dof_vel;
    }
    for (const index of this.zeroDofVelIndices) {
      if (index >= 0 && index < this.numActions) {
        out[offset + index] = 0;
      }
    }
    offset += this.numActions;
    out.set(lastActions, offset);
    return out;
  }
}
