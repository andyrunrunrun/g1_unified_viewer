import * as THREE from 'three';
import {
  clampFutureIndices,
  normalizeQuat,
  quatApplyInv,
  quatInverse,
  quatMultiply,
  quatToRot6d
} from './utils/math.js';

class BootIndicator {
  get size() {
    return 1;
  }

  compute() {
    return new Float32Array([0]);
  }
}

class ComplianceFlagObs {
  get size() {
    return 3;
  }

  compute(state) {
    const enabled = state?.complianceEnabled ? 1 : 0;
    const threshold = Number.isFinite(Number(state?.complianceThreshold)) ? Number(state.complianceThreshold) : 0;
    return new Float32Array([enabled, enabled * threshold, enabled * threshold / 0.05]);
  }
}

class RootAngVelB {
  get size() {
    return 3;
  }

  compute(state) {
    return new Float32Array(state.rootAngVel);
  }
}

class ProjectedGravityB {
  constructor() {
    this.gravity = new THREE.Vector3(0, 0, -1);
  }

  get size() {
    return 3;
  }

  compute(state) {
    const quat = state.rootQuat;
    const quatObj = new THREE.Quaternion(quat[1], quat[2], quat[3], quat[0]);
    const gravityLocal = this.gravity.clone().applyQuaternion(quatObj.clone().invert());
    return new Float32Array([gravityLocal.x, gravityLocal.y, gravityLocal.z]);
  }
}

class JointPos {
  constructor(policy, kwargs = {}) {
    this.posSteps = (kwargs.pos_steps ?? [0, 1, 2, 3, 4, 8]).slice();
    this.numJoints = policy.numActions;
    this.maxStep = Math.max(...this.posSteps);
    this.history = Array.from({ length: this.maxStep + 1 }, () => new Float32Array(this.numJoints));
  }

  get size() {
    return this.posSteps.length * this.numJoints;
  }

  reset(state) {
    const source = state?.jointPos ?? new Float32Array(this.numJoints);
    this.history[0].set(source);
    for (let i = 1; i < this.history.length; i += 1) {
      this.history[i].set(this.history[0]);
    }
  }

  update(state) {
    for (let i = this.history.length - 1; i > 0; i -= 1) {
      this.history[i].set(this.history[i - 1]);
    }
    this.history[0].set(state.jointPos);
  }

  compute() {
    const out = new Float32Array(this.size);
    let offset = 0;
    for (const step of this.posSteps) {
      out.set(this.history[Math.min(step, this.history.length - 1)], offset);
      offset += this.numJoints;
    }
    return out;
  }
}

class TrackingCommandObsRaw {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
    this.outputLength = (this.futureSteps.length - 1) * 3 + this.futureSteps.length * 6;
  }

  get size() {
    return this.outputLength;
  }

  compute(state) {
    const tracking = this.policy.tracking;
    if (!tracking?.isReady()) {
      return new Float32Array(this.outputLength);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    const basePos = tracking.refRootPos[indices[0]];
    const baseQuat = normalizeQuat(tracking.refRootQuat[indices[0]]);

    const posDiff = [];
    for (let i = 1; i < indices.length; i += 1) {
      const pos = tracking.refRootPos[indices[i]];
      const diff = [pos[0] - basePos[0], pos[1] - basePos[1], pos[2] - basePos[2]];
      const diffB = quatApplyInv(baseQuat, diff);
      posDiff.push(diffB[0], diffB[1], diffB[2]);
    }

    const qCurInv = quatInverse(normalizeQuat(state.rootQuat));
    const rot6d = [];
    for (const index of indices) {
      const rel = quatMultiply(qCurInv, normalizeQuat(tracking.refRootQuat[index]));
      rot6d.push(...quatToRot6d(rel));
    }
    return Float32Array.from([...posDiff, ...rot6d]);
  }
}

class TargetRootZObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
  }

  get size() {
    return this.futureSteps.length;
  }

  compute() {
    const tracking = this.policy.tracking;
    if (!tracking?.isReady()) {
      return new Float32Array(this.size);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    return Float32Array.from(indices.map((index) => tracking.refRootPos[index][2] + 0.035));
  }
}

class TargetJointPosObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
  }

  get size() {
    return this.futureSteps.length * (this.policy.tracking?.nJoints ?? 0) * 2;
  }

  compute(state) {
    const tracking = this.policy.tracking;
    if (!tracking?.isReady()) {
      return new Float32Array(this.size);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    const out = new Float32Array(indices.length * tracking.nJoints);
    const outDiff = new Float32Array(indices.length * tracking.nJoints);
    const current = state?.jointPos ?? new Float32Array(tracking.nJoints);
    let offset = 0;
    for (const index of indices) {
      const target = tracking.refJointPos[index];
      out.set(target, offset);
      for (let joint = 0; joint < tracking.nJoints; joint += 1) {
        outDiff[offset + joint] = target[joint] - (current[joint] ?? 0);
      }
      offset += tracking.nJoints;
    }
    const merged = new Float32Array(out.length + outDiff.length);
    merged.set(out, 0);
    merged.set(outDiff, out.length);
    return merged;
  }
}

class TargetProjectedGravityBObs {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.futureSteps = kwargs.future_steps ?? [0, 2, 4, 8, 16];
  }

  get size() {
    return this.futureSteps.length * 3;
  }

  compute() {
    const tracking = this.policy.tracking;
    if (!tracking?.isReady()) {
      return new Float32Array(this.size);
    }
    const indices = clampFutureIndices(tracking.refIdx, this.futureSteps, tracking.refLen);
    const out = new Float32Array(indices.length * 3);
    let offset = 0;
    for (const index of indices) {
      const gravityLocal = quatApplyInv(normalizeQuat(tracking.refRootQuat[index]), [0, 0, -1]);
      out[offset] = gravityLocal[0];
      out[offset + 1] = gravityLocal[1];
      out[offset + 2] = gravityLocal[2];
      offset += 3;
    }
    return out;
  }
}

class PrevActions {
  constructor(policy, kwargs = {}) {
    this.policy = policy;
    this.steps = Math.max(1, Math.floor(kwargs.history_steps ?? 4));
    this.numActions = policy.numActions;
    this.actionBuffer = Array.from({ length: this.steps }, () => new Float32Array(this.numActions));
  }

  get size() {
    return this.steps * this.numActions;
  }

  reset() {
    for (const buffer of this.actionBuffer) {
      buffer.fill(0);
    }
  }

  update() {
    for (let i = this.actionBuffer.length - 1; i > 0; i -= 1) {
      this.actionBuffer[i].set(this.actionBuffer[i - 1]);
    }
    this.actionBuffer[0].set(this.policy?.lastActions ?? new Float32Array(this.numActions));
  }

  compute() {
    const flattened = new Float32Array(this.size);
    for (let step = 0; step < this.steps; step += 1) {
      flattened.set(this.actionBuffer[step], step * this.numActions);
    }
    return flattened;
  }
}

export const Observations = {
  BootIndicator,
  ComplianceFlagObs,
  RootAngVelB,
  ProjectedGravityB,
  JointPos,
  TrackingCommandObsRaw,
  TargetRootZObs,
  TargetJointPosObs,
  TargetProjectedGravityBObs,
  PrevActions
};
