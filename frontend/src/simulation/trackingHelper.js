import * as THREE from 'three';
import { linspaceRows, quatInverse, quatMultiply, slerpMany, yawComponent } from './utils/math.js';

function clampIndex(index, length) {
  if (index < 0) {
    return 0;
  }
  if (index >= length) {
    return length - 1;
  }
  return index;
}

function toFloat32Rows(rows) {
  if (!Array.isArray(rows)) {
    return null;
  }
  return rows.map((row) => Float32Array.from(row));
}

function normalizeMotionClip(clip) {
  const jointPos = toFloat32Rows(clip?.joint_pos ?? clip?.jointPos);
  const rootPos = toFloat32Rows(clip?.root_pos ?? clip?.rootPos);
  const rootQuat = toFloat32Rows(clip?.root_quat ?? clip?.rootQuat);
  if (!jointPos || !rootPos || !rootQuat) {
    return null;
  }
  return { jointPos, rootPos, rootQuat };
}

export class TrackingHelper {
  constructor(config) {
    this.transitionSteps = config.transition_steps ?? 100;
    this.datasetJointNames = config.dataset_joint_names ?? [];
    this.policyJointNames = config.policy_joint_names ?? [];
    this.motions = {};
    this.motionMeta = {};
    this.nJoints = this.policyJointNames.length;
    this.mapDatasetToPolicy = this._buildDatasetToPolicyMap();

    const configMotionMeta = config.motion_meta && typeof config.motion_meta === 'object'
      ? config.motion_meta
      : {};
    for (const [name, clip] of Object.entries(config.motions ?? {})) {
      const normalized = normalizeMotionClip(clip);
      if (!normalized) {
        continue;
      }
      normalized.jointPos = normalized.jointPos.map((row) => this._mapDatasetJointPosToPolicy(row));
      this.motions[name] = normalized;
      const meta = configMotionMeta[name];
      this.motionMeta[name] = {
        complianceSuitable: typeof meta?.compliance_suitable === 'boolean' ? meta.compliance_suitable : true
      };
    }
    if (!this.motions.default) {
      throw new Error('TrackingHelper requires a "default" motion.');
    }
    this.reset();
  }

  addMotions(motions, options = {}) {
    const added = [];
    const skipped = [];
    const invalid = [];
    const allowOverwrite = Boolean(options.overwrite);
    const motionMetaInput = options.motion_meta && typeof options.motion_meta === 'object'
      ? options.motion_meta
      : {};

    if (!motions || typeof motions !== 'object') {
      return { added, skipped, invalid };
    }

    for (const [name, clip] of Object.entries(motions)) {
      if (!name) {
        invalid.push(name);
        continue;
      }
      if (!allowOverwrite && this.motions[name]) {
        skipped.push(name);
        continue;
      }
      const normalized = normalizeMotionClip(clip);
      if (!normalized) {
        invalid.push(name);
        continue;
      }
      normalized.jointPos = normalized.jointPos.map((row) => this._mapDatasetJointPosToPolicy(row));
      this.motions[name] = normalized;
      const meta = motionMetaInput[name];
      this.motionMeta[name] = {
        complianceSuitable: typeof meta?.compliance_suitable === 'boolean' ? meta.compliance_suitable : true
      };
      added.push(name);
    }

    return { added, skipped, invalid };
  }

  isReady() {
    return this.refLen > 0;
  }

  playbackState() {
    const clampedIdx = Math.max(0, Math.min(this.refIdx, Math.max(this.refLen - 1, 0)));
    const transitionLen = this.transitionLen ?? 0;
    const motionLen = this.motionLen ?? 0;
    const inTransition = transitionLen > 0 && clampedIdx < transitionLen;
    return {
      available: this.refLen > 0,
      currentName: this.currentName,
      currentDone: this.currentDone,
      refIdx: clampedIdx,
      refLen: this.refLen,
      transitionLen,
      motionLen,
      inTransition,
      isDefault: this.currentName === 'default'
    };
  }

  reset(state = null) {
    this.currentDone = true;
    this.refIdx = 0;
    this.refLen = 0;
    this.transitionLen = 0;
    this.motionLen = 0;
    this.refJointPos = [];
    this.refRootQuat = [];
    this.refRootPos = [];
    this.currentName = 'default';
    this.requestMotion('default', state);
  }

  requestMotion(name, state, options = {}) {
    if (!this.motions[name]) {
      return false;
    }
    if (this.currentName === 'default' || name === 'default' || name === this.currentName) {
      this._startMotionFromCurrent(name, state, options);
      return true;
    }
    return false;
  }

  advance() {
    if (this.refLen === 0) {
      return;
    }
    if (this.refIdx < this.refLen - 1) {
      this.refIdx += 1;
      if (this.refIdx === this.refLen - 1) {
        this.currentDone = true;
      }
    }
  }

  getFrame(index) {
    const clamped = clampIndex(index, this.refLen);
    return {
      jointPos: this.refJointPos[clamped],
      rootQuat: this.refRootQuat[clamped],
      rootPos: this.refRootPos[clamped]
    };
  }

  _readCurrentState(state) {
    if (state) {
      return {
        jointPos: Array.from(state.jointPos),
        rootPos: Array.from(state.rootPos),
        rootQuat: Array.from(state.rootQuat)
      };
    }
    const fallback = this.motions.default;
    return {
      jointPos: Array.from(fallback?.jointPos?.[0] ?? new Float32Array(this.nJoints)),
      rootPos: Array.from(fallback?.rootPos?.[0] ?? new Float32Array([0, 0, 0.78])),
      rootQuat: Array.from(fallback?.rootQuat?.[0] ?? new Float32Array([1, 0, 0, 0]))
    };
  }

  _alignMotionToCurrent(motion, current) {
    const p0 = new THREE.Vector3(...motion.rootPos[0]);
    const pc = new THREE.Vector3(...current.rootPos);
    const q0 = yawComponent(motion.rootQuat[0]);
    const qc = yawComponent(current.rootQuat);
    const qDeltaWxyz = quatMultiply(qc, quatInverse(q0));
    const qDelta = new THREE.Quaternion(qDeltaWxyz[1], qDeltaWxyz[2], qDeltaWxyz[3], qDeltaWxyz[0]);

    const jointPos = motion.jointPos.map((row) => Float32Array.from(row));
    const offset = new THREE.Vector3(pc.x, pc.y, p0.z);
    const rootPos = motion.rootPos.map((row) => {
      const pos = new THREE.Vector3(...row);
      pos.sub(p0).applyQuaternion(qDelta).add(offset);
      return Float32Array.from([pos.x, pos.y, pos.z]);
    });
    const rootQuat = motion.rootQuat.map((row) => {
      const q = new THREE.Quaternion(row[1], row[2], row[3], row[0]);
      const aligned = qDelta.clone().multiply(q);
      return Float32Array.from([aligned.w, aligned.x, aligned.y, aligned.z]);
    });
    return { jointPos, rootPos, rootQuat };
  }

  _buildTransition(current, firstFrame, stepsOverride = null) {
    const rawSteps = stepsOverride ?? this.transitionSteps;
    const steps = Math.max(0, Math.floor(rawSteps));
    if (steps === 0) {
      return { jointPos: [], rootQuat: [], rootPos: [] };
    }
    return {
      jointPos: linspaceRows(current.jointPos, firstFrame.jointPos[0], steps),
      rootPos: linspaceRows(current.rootPos, firstFrame.rootPos[0], steps),
      rootQuat: slerpMany(current.rootQuat, firstFrame.rootQuat[0], steps)
    };
  }

  _startMotionFromCurrent(name, state, options = {}) {
    const current = this._readCurrentState(state);
    const motion = this._sliceMotionFromFrame(this.motions[name], options.startFrame);
    const aligned = this._alignMotionToCurrent(motion, current);
    const transition = this._buildTransition(current, aligned, options.transitionSteps);
    this.refJointPos = [...transition.jointPos, ...aligned.jointPos];
    this.refRootQuat = [...transition.rootQuat, ...aligned.rootQuat];
    this.refRootPos = [...transition.rootPos, ...aligned.rootPos];
    this.transitionLen = transition.jointPos.length;
    this.motionLen = aligned.jointPos.length;
    this.refIdx = 0;
    this.refLen = this.refJointPos.length;
    this.currentName = name;
    this.currentDone = this.refLen <= 1;
  }

  _sliceMotionFromFrame(motion, startFrame = 0) {
    const length = motion?.jointPos?.length ?? 0;
    const start = clampIndex(Math.floor(Number(startFrame) || 0), length);
    return {
      jointPos: motion.jointPos.slice(start),
      rootPos: motion.rootPos.slice(start),
      rootQuat: motion.rootQuat.slice(start)
    };
  }

  _buildDatasetToPolicyMap() {
    if (!this.datasetJointNames.length || !this.policyJointNames.length) {
      throw new Error('TrackingHelper requires dataset_joint_names and policy_joint_names.');
    }
    const datasetIndex = new Map();
    for (let i = 0; i < this.datasetJointNames.length; i += 1) {
      datasetIndex.set(this.datasetJointNames[i], i);
    }
    return this.policyJointNames.map((name) => {
      if (!datasetIndex.has(name)) {
        throw new Error(`TrackingHelper: joint "${name}" missing in dataset_joint_names.`);
      }
      return datasetIndex.get(name);
    });
  }

  _mapDatasetJointPosToPolicy(jointPos) {
    const out = new Float32Array(this.policyJointNames.length);
    for (let i = 0; i < this.mapDatasetToPolicy.length; i += 1) {
      out[i] = jointPos[this.mapDatasetToPolicy[i]] ?? 0;
    }
    return out;
  }
}
