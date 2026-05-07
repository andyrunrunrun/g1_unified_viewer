const SONIC_MUJOCO_JOINT_ORDER = [
  'left_hip_pitch_joint',
  'left_hip_roll_joint',
  'left_hip_yaw_joint',
  'left_knee_joint',
  'left_ankle_pitch_joint',
  'left_ankle_roll_joint',
  'right_hip_pitch_joint',
  'right_hip_roll_joint',
  'right_hip_yaw_joint',
  'right_knee_joint',
  'right_ankle_pitch_joint',
  'right_ankle_roll_joint',
  'waist_yaw_joint',
  'waist_roll_joint',
  'waist_pitch_joint',
  'left_shoulder_pitch_joint',
  'left_shoulder_roll_joint',
  'left_shoulder_yaw_joint',
  'left_elbow_joint',
  'left_wrist_roll_joint',
  'left_wrist_pitch_joint',
  'left_wrist_yaw_joint',
  'right_shoulder_pitch_joint',
  'right_shoulder_roll_joint',
  'right_shoulder_yaw_joint',
  'right_elbow_joint',
  'right_wrist_roll_joint',
  'right_wrist_pitch_joint',
  'right_wrist_yaw_joint'
];

const ISAACLAB_TO_MUJOCO = [
  0, 3, 6, 9, 13, 17, 1, 4, 7, 10, 14, 18, 2, 5, 8,
  11, 15, 19, 21, 23, 25, 27, 12, 16, 20, 22, 24, 26, 28
];

const MUJOCO_TO_ISAACLAB = [
  0, 6, 12, 1, 7, 13, 2, 8, 14, 3, 9, 15, 22, 4, 10,
  16, 23, 5, 11, 17, 24, 18, 25, 19, 26, 20, 27, 21, 28
];

function cloneArray(values, fallback = []) {
  if (!values) {
    return Array.from(fallback);
  }
  return Array.from(values);
}

function toFloatArray(value, length, fallback = 0) {
  const out = new Float32Array(length);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    for (let index = 0; index < length; index += 1) {
      const next = Number(value[index]);
      out[index] = Number.isFinite(next) ? next : fallback;
    }
    return out;
  }
  out.fill(Number.isFinite(Number(value)) ? Number(value) : fallback);
  return out;
}

function normalizeMotionClip(frameCache) {
  const frames = frameCache?.frames ?? [];
  return {
    jointPos: frames.map((frame) => Float32Array.from(frame.joint_positions ?? [])),
    jointVel: frames.map((frame) => Float32Array.from(frame.joint_velocities ?? [])),
    rootPos: frames.map((frame) => Float32Array.from(frame.root_translation ?? [0, 0, 0.78])),
    rootQuat: frames.map((frame) => Float32Array.from(frame.root_rotation_wxyz ?? [1, 0, 0, 0]))
  };
}

function makeDefaultClip(defaultJointPos, resetRootTranslation) {
  const joint = Float32Array.from(defaultJointPos);
  return {
    jointPos: [joint],
    jointVel: [new Float32Array(joint.length)],
    rootPos: [Float32Array.from(resetRootTranslation)],
    rootQuat: [Float32Array.from([1, 0, 0, 0])]
  };
}

function lerpRows(start, end, steps) {
  if (steps <= 0) {
    return [];
  }
  const result = [];
  const denom = steps + 1;
  const length = Math.max(start?.length ?? 0, end?.length ?? 0);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / denom;
    const row = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const a = Number(start?.[index] ?? 0);
      const b = Number(end?.[index] ?? 0);
      row[index] = (1 - t) * a + t * b;
    }
    result.push(row);
  }
  return result;
}

function slerpQuats(startQuat, endQuat, steps) {
  if (steps <= 0) {
    return [];
  }
  const start = normalizeQuat(startQuat);
  let end = normalizeQuat(endQuat);
  let dot = start[0] * end[0] + start[1] * end[1] + start[2] * end[2] + start[3] * end[3];
  if (dot < 0) {
    dot = -dot;
    end = end.map((value) => -value);
  }
  const result = [];
  const denom = steps + 1;
  if (1 - dot < 1e-6) {
    for (let step = 1; step <= steps; step += 1) {
      const t = step / denom;
      result.push(Float32Array.from(normalizeQuat(start.map((value, index) => (
        (1 - t) * value + t * end[index]
      )))));
    }
    return result;
  }
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / denom;
    const coeff0 = Math.sin((1 - t) * omega) / sinOmega;
    const coeff1 = Math.sin(t * omega) / sinOmega;
    result.push(Float32Array.from([
      coeff0 * start[0] + coeff1 * end[0],
      coeff0 * start[1] + coeff1 * end[1],
      coeff0 * start[2] + coeff1 * end[2],
      coeff0 * start[3] + coeff1 * end[3]
    ]));
  }
  return result;
}

function clampIndex(index, length) {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(Number(index) || 0), 0), length - 1);
}

function finiteArray(values, length, fallback = 0) {
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = Number(values?.[index]);
    out[index] = Number.isFinite(value) ? value : fallback;
  }
  return out;
}

function normalizeQuat(quat) {
  const w = Number(quat?.[0] ?? 1);
  const x = Number(quat?.[1] ?? 0);
  const y = Number(quat?.[2] ?? 0);
  const z = Number(quat?.[3] ?? 0);
  const norm = Math.hypot(w, x, y, z);
  if (!Number.isFinite(norm) || norm < 1e-9) {
    return [1, 0, 0, 0];
  }
  const inv = 1 / norm;
  return [w * inv, x * inv, y * inv, z * inv];
}

function quatConjugate(quat) {
  const [w, x, y, z] = normalizeQuat(quat);
  return [w, -x, -y, -z];
}

function quatMultiply(a, b) {
  const [aw, ax, ay, az] = normalizeQuat(a);
  const [bw, bx, by, bz] = normalizeQuat(b);
  return normalizeQuat([
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw
  ]);
}

function quatRotate(quat, vector) {
  const q = normalizeQuat(quat);
  const v = [0, Number(vector?.[0] ?? 0), Number(vector?.[1] ?? 0), Number(vector?.[2] ?? 0)];
  const rotated = quatMultiply(quatMultiply(q, v), quatConjugate(q));
  return [rotated[1], rotated[2], rotated[3]];
}

function headingQuat(quat) {
  const rotatedX = quatRotate(quat, [1, 0, 0]);
  const heading = Math.atan2(rotatedX[1], rotatedX[0]);
  const half = 0.5 * heading;
  return [Math.cos(half), 0, 0, Math.sin(half)];
}

function headingQuatInv(quat) {
  const rotatedX = quatRotate(quat, [1, 0, 0]);
  const heading = Math.atan2(rotatedX[1], rotatedX[0]);
  const half = -0.5 * heading;
  return [Math.cos(half), 0, 0, Math.sin(half)];
}

function yawAlignClipToState({ rootPos, rootQuat, anchorIndex, targetRootPos, targetRootQuat }) {
  const safeAnchorIndex = clampIndex(anchorIndex, rootPos.length);
  const anchorRootPos = rootPos[safeAnchorIndex] ?? [0, 0, 0.78];
  const anchorRootQuat = rootQuat[safeAnchorIndex] ?? [1, 0, 0, 0];
  const qDelta = quatMultiply(headingQuat(targetRootQuat), headingQuatInv(anchorRootQuat));
  const qDeltaThree = {
    w: qDelta[0],
    x: qDelta[1],
    y: qDelta[2],
    z: qDelta[3]
  };
  const rotateXY = (x, y) => [
    (1 - 2 * (qDeltaThree.z * qDeltaThree.z)) * x - (2 * qDeltaThree.w * qDeltaThree.z) * y,
    (2 * qDeltaThree.w * qDeltaThree.z) * x + (1 - 2 * (qDeltaThree.z * qDeltaThree.z)) * y
  ];
  const anchoredRootPos = rootPos.map((row) => {
    const dx = Number(row?.[0] ?? 0) - Number(anchorRootPos?.[0] ?? 0);
    const dy = Number(row?.[1] ?? 0) - Number(anchorRootPos?.[1] ?? 0);
    const [x, y] = rotateXY(dx, dy);
    return Float32Array.from([
      Number(targetRootPos?.[0] ?? 0) + x,
      Number(targetRootPos?.[1] ?? 0) + y,
      Number(row?.[2] ?? anchorRootPos?.[2] ?? 0.78)
    ]);
  });
  const anchoredRootQuat = rootQuat.map((row) => Float32Array.from(quatMultiply(qDelta, row ?? [1, 0, 0, 0])));
  return { rootPos: anchoredRootPos, rootQuat: anchoredRootQuat };
}

function quatToSonicRot6d(quat) {
  const [w, x, y, z] = normalizeQuat(quat);
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - w * z);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  return new Float32Array([r00, r01, r10, r11, r20, r21]);
}

class SonicTracking {
  constructor(policy) {
    this.policy = policy;
    this.motions = new Map();
    this.reset();
  }

  reset() {
    this.currentName = 'default';
    this.refIdx = 0;
    this.refLen = 1;
    this.transitionLen = 0;
    this.motionLen = 1;
    this.motionStartIndex = 0;
    this.currentDone = true;
    this.transitionClip = null;
  }

  setMotionClip(name, frameCache) {
    if (!name || !frameCache) {
      return false;
    }
    const clip = normalizeMotionClip(frameCache);
    if (!clip.jointPos.length) {
      return false;
    }
    this.motions.set(name, clip);
    return true;
  }

  requestMotion(name, state = null, options = {}) {
    if (name !== 'default' && !this.motions.has(name)) {
      return false;
    }
    this.currentName = name;
    const motionLen = this._clip().jointPos.length;
    this.refIdx = 0;
    this.motionStartIndex = clampIndex(options.startFrame ?? 0, motionLen);
    this.transitionLen = Math.max(0, Math.floor(Number(options.transitionSteps) || 0));
    this.motionLen = Math.max(1, motionLen - this.motionStartIndex);
    this.refLen = this.transitionLen + this.motionLen;
    this.currentDone = this.refLen <= 1;
    this.transitionClip = this._buildTransitionClip(state, this._clip(), this.motionStartIndex, this.transitionLen);
    return true;
  }

  advance() {
    if (this.refIdx < this.refLen - 1) {
      this.refIdx += 1;
    }
    if (this.refIdx >= this.refLen - 1) {
      this.currentDone = true;
    }
  }

  frameForStep(step = 0) {
    const clip = this._clip();
    const targetIndex = this.currentName === 'default'
      ? 0
      : this.refIdx + step * this.policy.motionStep;
    if (this.transitionClip && targetIndex < this.transitionLen) {
      return {
        jointPos: this.transitionClip.jointPos[targetIndex] ?? this.transitionClip.jointPos.at(-1),
        jointVel: this.transitionClip.jointVel[targetIndex] ?? new Float32Array(this.policy.numActions),
        rootPos: this.transitionClip.rootPos[targetIndex] ?? this.transitionClip.rootPos.at(-1),
        rootQuat: this.transitionClip.rootQuat[targetIndex] ?? this.transitionClip.rootQuat.at(-1)
      };
    }
    const motionIndex = this.currentName === 'default'
      ? 0
      : clampIndex(this.motionStartIndex + targetIndex - this.transitionLen, clip.jointPos.length);
    return {
      jointPos: clip.jointPos[motionIndex] ?? clip.jointPos[0],
      jointVel: clip.jointVel[motionIndex] ?? new Float32Array(this.policy.numActions),
      rootPos: clip.rootPos[motionIndex] ?? clip.rootPos[0],
      rootQuat: clip.rootQuat[motionIndex] ?? clip.rootQuat[0]
    };
  }

  getFrame(index = this.refIdx) {
    const previousIdx = this.refIdx;
    this.refIdx = clampIndex(index, this.refLen);
    const frame = this.frameForStep(0);
    this.refIdx = previousIdx;
    return {
      jointPos: frame.jointPos,
      rootPos: frame.rootPos,
      rootQuat: frame.rootQuat
    };
  }

  isReady() {
    return this.refLen > 0;
  }

  anchorCurrentFrameToState(state = null) {
    if (!state || !this.isReady()) {
      return false;
    }
    const targetRootPos = state.rootPos;
    const targetRootQuat = state.rootQuat;
    if (!targetRootPos || !targetRootQuat) {
      return false;
    }
    if (this.transitionClip && this.refIdx < this.transitionLen) {
      const aligned = yawAlignClipToState({
        rootPos: this.transitionClip.rootPos,
        rootQuat: this.transitionClip.rootQuat,
        anchorIndex: this.refIdx,
        targetRootPos,
        targetRootQuat
      });
      this.transitionClip.rootPos = aligned.rootPos;
      this.transitionClip.rootQuat = aligned.rootQuat;
      return true;
    }
    if (this.currentName === 'default') {
      return true;
    }
    const clip = this._clip();
    const motionIndex = clampIndex(this.motionStartIndex + this.refIdx - this.transitionLen, clip.jointPos.length);
    const aligned = yawAlignClipToState({
      rootPos: clip.rootPos,
      rootQuat: clip.rootQuat,
      anchorIndex: motionIndex,
      targetRootPos,
      targetRootQuat
    });
    clip.rootPos = aligned.rootPos;
    clip.rootQuat = aligned.rootQuat;
    return true;
  }

  playbackState() {
    const inTransition = this.transitionLen > 0 && this.refIdx < this.transitionLen;
    const sourceFrame = this.currentName === 'default'
      ? 0
      : this.motionStartIndex + Math.max(0, this.refIdx - this.transitionLen);
    return {
      available: true,
      currentName: this.currentName,
      currentDone: this.currentDone,
      refIdx: this.refIdx,
      refLen: this.refLen,
      transitionLen: this.transitionLen,
      motionLen: this.motionLen,
      sourceStartFrame: this.motionStartIndex,
      sourceFrame,
      inTransition,
      isDefault: this.currentName === 'default'
    };
  }

  _clip() {
    if (this.currentName === 'default') {
      return this.policy.defaultClip;
    }
    return this.motions.get(this.currentName) ?? this.policy.defaultClip;
  }

  _buildTransitionClip(state, clip, startIndex, steps) {
    if (this.currentName === 'default' || steps <= 0) {
      return null;
    }
    const firstJoint = clip.jointPos[startIndex] ?? clip.jointPos[0];
    const firstRootPos = clip.rootPos[startIndex] ?? clip.rootPos[0];
    const firstRootQuat = clip.rootQuat[startIndex] ?? clip.rootQuat[0];
    const currentJoint = state?.jointPos ?? this.policy.resetJointPos ?? this.policy.defaultJointPos;
    const currentRootPos = state?.rootPos ?? this.policy.resetRootTranslation ?? [0, 0, 0.78];
    const currentRootQuat = state?.rootQuat ?? [1, 0, 0, 0];
    return {
      jointPos: lerpRows(currentJoint, firstJoint, steps),
      jointVel: Array.from({ length: steps }, () => new Float32Array(this.policy.numActions)),
      rootPos: lerpRows(currentRootPos, firstRootPos, steps),
      rootQuat: slerpQuats(currentRootQuat, firstRootQuat, steps)
    };
  }
}

class SonicBrowserPolicy {
  constructor(manifest, host) {
    this.manifest = manifest;
    this.host = host;
    this.ort = host.ort;
    this.config = null;
    this.encoderSession = null;
    this.decoderSession = null;
    this.policyJointNames = SONIC_MUJOCO_JOINT_ORDER.slice();
    this.numActions = this.policyJointNames.length;
    this.defaultJointPos = new Float32Array(this.numActions);
    this.resetJointPos = new Float32Array(this.numActions);
    this.resetRootTranslation = new Float32Array([0, 0, 0.78]);
    this.actionScale = new Float32Array(this.numActions);
    this.stiffness = new Float32Array(this.numActions);
    this.damping = new Float32Array(this.numActions);
    this.torqueLimits = new Float32Array(this.numActions);
    this.controlDt = 0.02;
    this.actionClip = 10;
    this.physicsOptions = null;
    this.lastActions = new Float32Array(this.numActions);
    this.history = [];
    this.tokenState = new Float32Array(64);
    this.encoderInputDim = 1762;
    this.decoderInputDim = 994;
    this.proprioHistoryFrames = 10;
    this.motionFutureFrames = 10;
    this.motionStep = 5;
    this.encoderMode = 0;
    this.headingState = {
      initBaseQuat: [1, 0, 0, 0],
      initRefQuat: [1, 0, 0, 0],
      deltaHeading: 0
    };
    this.targetSmoothing = {
      enabled: false,
      alpha: 0.1,
      values: new Map()
    };
    this.defaultClip = makeDefaultClip(this.defaultJointPos, this.resetRootTranslation);
    this.tracking = new SonicTracking(this);
    this.isInferencing = false;
  }

  async load() {
    this.config = await this.host.loadPolicyConfig(this.manifest.config_path);
    this.policyJointNames = Array.isArray(this.config.policy_joint_names)
      ? this.config.policy_joint_names.slice()
      : SONIC_MUJOCO_JOINT_ORDER.slice();
    this.numActions = this.policyJointNames.length;
    this.defaultJointPos = toFloatArray(this.config.default_joint_pos, this.numActions, 0);
    this.resetJointPos = toFloatArray(this.config.reset_joint_pos ?? this.config.default_joint_pos, this.numActions, 0);
    this.resetRootTranslation = toFloatArray(this.config.reset_root_translation ?? [0, 0, 0.78], 3, 0);
    this.actionScale = toFloatArray(this.config.action_scale, this.numActions, 1);
    this.stiffness = toFloatArray(this.config.stiffness, this.numActions, 0);
    this.damping = toFloatArray(this.config.damping, this.numActions, 0);
    this.torqueLimits = toFloatArray(this.config.torque_limits, this.numActions, Number.POSITIVE_INFINITY);
    this.actionClip = Number.isFinite(Number(this.config.action_clip)) ? Number(this.config.action_clip) : 10;
    this.controlDt = Number.isFinite(Number(this.config.control_dt)) && Number(this.config.control_dt) > 0
      ? Number(this.config.control_dt)
      : 0.02;
    this.physicsOptions = this.host.clonePhysicsOptions?.(this.config.physics_options)
      ?? JSON.parse(JSON.stringify(this.config.physics_options ?? null));
    this.encoderInputDim = Number(this.config.sonic?.encoder_input_dim ?? 1762);
    this.decoderInputDim = Number(this.config.sonic?.decoder_input_dim ?? 994);
    this.proprioHistoryFrames = Number(this.config.sonic?.proprio_history_frames ?? 10);
    this.motionFutureFrames = Number(this.config.sonic?.motion_future_frames ?? 10);
    this.motionStep = Number(this.config.sonic?.motion_step ?? 5);
    this.encoderMode = Number(this.config.sonic?.encoder_mode ?? 0);
    this.tokenState = new Float32Array(Number(this.config.sonic?.token_dim ?? 64));
    this.lastActions = new Float32Array(this.numActions);
    this.defaultClip = makeDefaultClip(this.defaultJointPos, this.resetRootTranslation);
    this.tracking = new SonicTracking(this);
    this.tracking.reset();

    this.encoderSession = await this._loadOnnxSession(this.config.onnx?.encoder?.path);
    this.decoderSession = await this._loadOnnxSession(this.config.onnx?.decoder?.path);
    this.reset();
    return this;
  }

  reset(state = null) {
    this.lastActions = new Float32Array(this.numActions);
    this.tokenState = new Float32Array(this.tokenState.length);
    this.resetTargetSmoothing();
    this.history = [];
    const resetState = state ?? {
      jointPos: this.resetJointPos,
      jointVel: new Float32Array(this.numActions),
      rootQuat: new Float32Array([1, 0, 0, 0]),
      rootAngVel: new Float32Array(3)
    };
    for (let index = 0; index < this.proprioHistoryFrames; index += 1) {
      this.history.push(this._buildHistoryEntry(resetState));
    }
    this.tracking.reset();
    this._resetHeadingState(resetState, this.defaultClip.rootQuat[0]);
  }

  configureTargetSmoothing(options = {}) {
    const enabled = Boolean(options.enabled);
    const alpha = Math.min(1, Math.max(0.01, Number(options.alpha ?? this.targetSmoothing.alpha) || 0.1));
    const changed = enabled !== this.targetSmoothing.enabled;
    this.targetSmoothing.enabled = enabled;
    this.targetSmoothing.alpha = alpha;
    if (changed || !enabled) {
      this.resetTargetSmoothing();
    }
    return { enabled, alpha };
  }

  resetTargetSmoothing() {
    this.targetSmoothing.values.clear();
  }

  smoothTargetVector(key, values) {
    const input = ArrayBuffer.isView(values) ? values : Float32Array.from(values ?? []);
    if (!this.targetSmoothing.enabled) {
      return input;
    }
    const previous = this.targetSmoothing.values.get(key);
    const output = new Float32Array(input.length);
    if (!previous || previous.length !== input.length) {
      output.set(input);
    } else {
      const alpha = this.targetSmoothing.alpha;
      const keep = 1 - alpha;
      for (let index = 0; index < input.length; index += 1) {
        output[index] = alpha * input[index] + keep * previous[index];
      }
    }
    this.targetSmoothing.values.set(key, Float32Array.from(output));
    return output;
  }

  setMotionClip(name, frameCache) {
    return this.tracking.setMotionClip(name, frameCache);
  }

  requestMotion(name, statePayload, options = {}) {
    const state = statePayload ? this._referenceToPolicyState(statePayload) : null;
    const accepted = this.tracking.requestMotion(name, state, options);
    if (accepted) {
      this._resetHeadingState(state, this.tracking.frameForStep(0).rootQuat);
    }
    return accepted;
  }

  async step(input = {}) {
    if (this.isInferencing) {
      return null;
    }
    if (!this.encoderSession || !this.decoderSession) {
      throw new Error('SONIC policy is not loaded.');
    }
    this.isInferencing = true;
    try {
      const reference = input.reference ?? {};
      const referenceState = reference.state ?? {};
      const state = this._referenceToPolicyState(input.current_state ?? reference);
      this.tracking.anchorCurrentFrameToState?.(state);
      const encoderInput = this._buildEncoderInput(state);
      const encoded = await this.encoderSession.run({
        [this.encoderSession.inputNames[0] ?? 'obs_dict']: new this.ort.Tensor('float32', encoderInput, [1, encoderInput.length])
      });
      this.tokenState = this._readFirstOutput(encoded, this.encoderSession.outputNames[0], this.tokenState.length);

      const decoderInput = this._buildDecoderInput(state);
      const decoded = await this.decoderSession.run({
        [this.decoderSession.inputNames[0] ?? 'obs_dict']: new this.ort.Tensor('float32', decoderInput, [1, decoderInput.length])
      });
      const action = this._readFirstOutput(decoded, this.decoderSession.outputNames[0], this.numActions);
      this._pushHistory(this._buildHistoryEntry(state));
      this.tracking.advance();
      this.tracking.anchorCurrentFrameToState?.(state);
      const jointPositions = this._actionToJointTargets(action);
      return this._makeOutput(jointPositions, this.tracking.frameForStep(0) ?? referenceState);
    } finally {
      this.isInferencing = false;
    }
  }

  defaultStance() {
    return {
      mode: 'joint_position_target',
      joint_names: cloneArray(this.policyJointNames),
      joint_positions: cloneArray(this.resetJointPos).map((value) => Number(Number(value).toFixed(6))),
      kp: cloneArray(this.stiffness).map((value) => Number(Number(value).toFixed(6))),
      kd: cloneArray(this.damping).map((value) => Number(Number(value).toFixed(6))),
      torque_limits: cloneArray(this.torqueLimits).map((value) => Number(Number(value).toFixed(6))),
      root_translation: cloneArray(this.resetRootTranslation, [0, 0, 0.78]).map((value) => Number(Number(value).toFixed(6))),
      root_rotation_wxyz: [1, 0, 0, 0],
      control_dt: this.controlDt,
      ...(this.physicsOptions ? { physics_options: JSON.parse(JSON.stringify(this.physicsOptions)) } : {})
    };
  }

  async _loadOnnxSession(path) {
    const modelPath = this.host.resolveStaticAssetPath(this.manifest.config_path, path);
    const response = await fetch(modelPath);
    if (!response.ok) {
      throw new Error(`Failed to load SONIC ONNX model: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    return this.ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
  }

  _referenceToPolicyState(reference) {
    const state = reference?.state ?? {};
    const jointNames = reference?.joint_names ?? [];
    const sourceIndex = new Map(jointNames.map((name, index) => [name, index]));
    const jointPositions = state.joint_positions ?? [];
    const jointVelocities = state.joint_velocities ?? [];
    const jointPos = new Float32Array(this.numActions);
    const jointVel = new Float32Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      const source = sourceIndex.get(this.policyJointNames[index]);
      jointPos[index] = Number(jointPositions[source] ?? this.defaultJointPos[index] ?? 0);
      jointVel[index] = Number(jointVelocities[source] ?? 0);
    }
    return {
      jointPos,
      jointVel,
      rootPos: finiteArray(state.root_translation ?? [0, 0, 0.78], 3, 0),
      rootQuat: finiteArray(state.root_rotation_wxyz ?? [1, 0, 0, 0], 4, 0),
      rootAngVel: finiteArray(state.root_angular_velocity ?? [0, 0, 0], 3, 0)
    };
  }

  _buildEncoderInput(state = null) {
    const out = new Float32Array(this.encoderInputDim);
    out[0] = this.encoderMode;
    let offset = 4;
    for (let frame = 0; frame < this.motionFutureFrames; frame += 1) {
      const target = this.tracking.frameForStep(frame);
      out.set(this._motionJointArray(target.jointPos), offset);
      offset += this.numActions;
    }
    offset = 294;
    for (let frame = 0; frame < this.motionFutureFrames; frame += 1) {
      const target = this.tracking.frameForStep(frame);
      out.set(this._motionJointArray(target.jointVel, 0), offset);
      offset += this.numActions;
    }
    offset = 601;
    for (let frame = 0; frame < this.motionFutureFrames; frame += 1) {
      const target = this.tracking.frameForStep(frame);
      out.set(this._motionAnchorOrientation(target.rootQuat, state), offset);
      offset += 6;
    }
    return out;
  }

  _buildDecoderInput(state) {
    const out = new Float32Array(this.decoderInputDim);
    let offset = 0;
    out.set(this.tokenState, offset);
    offset += this.tokenState.length;
    const history = this._historyWithCurrent(state);
    for (const entry of history) {
      out.set(entry.baseAngVel, offset);
      offset += 3;
    }
    for (const entry of history) {
      out.set(entry.bodyQ, offset);
      offset += this.numActions;
    }
    for (const entry of history) {
      out.set(entry.bodyDq, offset);
      offset += this.numActions;
    }
    for (const entry of history) {
      out.set(entry.lastAction, offset);
      offset += this.numActions;
    }
    for (const entry of history) {
      out.set(entry.gravityDir, offset);
      offset += 3;
    }
    return out;
  }

  _historyWithCurrent(state) {
    const current = this._buildHistoryEntry(state);
    const merged = [...this.history, current];
    return merged.slice(-this.proprioHistoryFrames);
  }

  _buildHistoryEntry(state) {
    const bodyQ = new Float32Array(this.numActions);
    const bodyDq = new Float32Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      const sourceIndex = MUJOCO_TO_ISAACLAB[index] ?? index;
      bodyQ[index] = Number(state?.jointPos?.[sourceIndex] ?? this.defaultJointPos[sourceIndex] ?? 0)
        - Number(this.defaultJointPos[sourceIndex] ?? 0);
      bodyDq[index] = Number(state?.jointVel?.[sourceIndex] ?? 0);
    }
    return {
      baseAngVel: finiteArray(state?.rootAngVel ?? [0, 0, 0], 3, 0),
      bodyQ,
      bodyDq,
      lastAction: Float32Array.from(this.lastActions),
      gravityDir: Float32Array.from(this.host.math.quatApplyInv(state?.rootQuat ?? [1, 0, 0, 0], [0, 0, -1]))
    };
  }

  _pushHistory(entry) {
    this.history.push(entry);
    while (this.history.length > this.proprioHistoryFrames) {
      this.history.shift();
    }
  }

  _jointArray(values) {
    const out = new Float32Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      out[index] = Number(values?.[index] ?? this.defaultJointPos[index] ?? 0);
    }
    return out;
  }

  _motionJointArray(values, fallback = this.defaultJointPos) {
    const out = new Float32Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      const sourceIndex = MUJOCO_TO_ISAACLAB[index] ?? index;
      out[index] = Number(values?.[sourceIndex] ?? fallback?.[sourceIndex] ?? 0);
    }
    return out;
  }

  _resetHeadingState(state = null, initRefQuat = [1, 0, 0, 0]) {
    this.headingState = {
      initBaseQuat: normalizeQuat(state?.rootQuat ?? [1, 0, 0, 0]),
      initRefQuat: normalizeQuat(initRefQuat ?? [1, 0, 0, 0]),
      deltaHeading: 0
    };
  }

  _motionAnchorOrientation(rootQuat, state = null) {
    const currentBaseQuat = normalizeQuat(state?.rootQuat ?? this.headingState.initBaseQuat);
    const applyDeltaHeading = quatMultiply(
      headingQuat(this.headingState.initBaseQuat),
      headingQuatInv(this.headingState.initRefQuat)
    );
    const referenceRootQuat = quatMultiply(applyDeltaHeading, rootQuat ?? [1, 0, 0, 0]);
    const baseToReferenceQuat = quatMultiply(quatConjugate(currentBaseQuat), referenceRootQuat);
    return quatToSonicRot6d(baseToReferenceQuat);
  }

  _actionToJointTargets(action) {
    const jointPositions = new Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      const rawIndex = ISAACLAB_TO_MUJOCO[index] ?? index;
      const raw = Number(action[rawIndex] ?? 0);
      const clipped = Math.max(-this.actionClip, Math.min(this.actionClip, raw));
      this.lastActions[rawIndex] = raw;
      jointPositions[index] = Number(this.defaultJointPos[index] ?? 0) + Number(this.actionScale[index] ?? 1) * clipped;
    }
    return jointPositions;
  }

  _makeOutput(jointPositions, referenceState) {
    return {
      mode: 'joint_position_target',
      joint_names: cloneArray(this.policyJointNames),
      joint_positions: jointPositions,
      kp: cloneArray(this.stiffness),
      kd: cloneArray(this.damping),
      torque_limits: cloneArray(this.torqueLimits),
      root_translation: cloneArray(referenceState.root_translation ?? referenceState.rootPos, [0, 0, 0.78]),
      root_rotation_wxyz: cloneArray(referenceState.root_rotation_wxyz ?? referenceState.rootQuat, [1, 0, 0, 0]),
      control_dt: this.controlDt,
      ...(this.physicsOptions ? { physics_options: JSON.parse(JSON.stringify(this.physicsOptions)) } : {})
    };
  }

  _readFirstOutput(outputs, preferredName, length) {
    const tensor = outputs[preferredName] ?? Object.values(outputs)[0];
    const data = tensor?.data ?? [];
    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = Number(data[index] ?? 0);
    }
    return out;
  }
}

export async function createBrowserPolicy(manifest, host) {
  return new SonicBrowserPolicy(manifest, host);
}
