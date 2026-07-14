import {
  cloneArray,
  normalizeQuat,
  quatApplyInv,
  quatInverse,
  quatMultiply,
  toFloatArray
} from '../shared/policyMath.js';

function projectedGravity(quat) {
  return quatApplyInv(quat, [0, 0, -1]);
}

function clampIndex(index, length) {
  if (length <= 0) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(Number(index) || 0), 0), length - 1);
}

function readRows(rows, width) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => Float32Array.from(toFloatArray(row, width, 0)));
}

function readBodyRows(rows, fallbackBodyCount = 0, width = 3) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => {
    if (!Array.isArray(row)) {
      return Array.from({ length: fallbackBodyCount }, () => new Float32Array(width));
    }
    return row.map((item) => Float32Array.from(toFloatArray(item, width, 0)));
  });
}

function hasFiniteVector(values, width = 3) {
  if (!values || values.length < width) {
    return false;
  }
  for (let index = 0; index < width; index += 1) {
    if (!Number.isFinite(Number(values[index]))) {
      return false;
    }
  }
  return true;
}

function isZeroVector(values, width = 3) {
  if (!hasFiniteVector(values, width)) {
    return false;
  }
  for (let index = 0; index < width; index += 1) {
    if (Math.abs(Number(values[index] ?? 0)) > 1e-9) {
      return false;
    }
  }
  return true;
}

function useProvidedVectorOrEstimate(values, estimate, width = 3) {
  if (!hasFiniteVector(values, width)) {
    return estimate;
  }
  if (isZeroVector(values, width) && !isZeroVector(estimate, width)) {
    return estimate;
  }
  return Float32Array.from(values);
}

function readFps(frameCache, fallback = 50) {
  const candidates = [
    frameCache?.fps,
    frameCache?.metadata?.motion_fps,
    frameCache?.metadata?.fps
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return fallback;
}

function estimateLinearVelocity(rows, index, fps, width = 3) {
  if (!rows.length || rows.length <= 1) {
    return new Float32Array(width);
  }
  const current = clampIndex(index, rows.length);
  const other = current < rows.length - 1 ? current + 1 : current - 1;
  const sign = other > current ? 1 : -1;
  const out = new Float32Array(width);
  for (let axis = 0; axis < width; axis += 1) {
    out[axis] = sign * (Number(rows[other]?.[axis] ?? 0) - Number(rows[current]?.[axis] ?? 0)) * fps;
  }
  return out;
}

function quatAngularVelocity(fromQuat, toQuat, fps) {
  let delta = quatMultiply(toQuat, quatInverse(fromQuat));
  if (delta[0] < 0) {
    delta = delta.map((value) => -value);
  }
  const w = Math.max(-1, Math.min(1, Number(delta[0] ?? 1)));
  const sinHalfAngle = Math.sqrt(Math.max(0, 1 - w * w));
  if (sinHalfAngle < 1e-6) {
    return Float32Array.from([
      2 * Number(delta[1] ?? 0) * fps,
      2 * Number(delta[2] ?? 0) * fps,
      2 * Number(delta[3] ?? 0) * fps
    ]);
  }
  const angle = 2 * Math.acos(w);
  const scale = angle * fps / sinHalfAngle;
  return Float32Array.from([
    Number(delta[1] ?? 0) * scale,
    Number(delta[2] ?? 0) * scale,
    Number(delta[3] ?? 0) * scale
  ]);
}

function estimateAngularVelocity(rows, index, fps) {
  if (!rows.length || rows.length <= 1) {
    return new Float32Array(3);
  }
  const current = clampIndex(index, rows.length);
  const other = current < rows.length - 1 ? current + 1 : current - 1;
  return other > current
    ? quatAngularVelocity(rows[current], rows[other], fps)
    : quatAngularVelocity(rows[other], rows[current], fps);
}

function estimateBodyLinearVelocities(bodyRows, index, fps, bodyCount) {
  if (!bodyRows.length || bodyRows.length <= 1) {
    return Array.from({ length: bodyCount }, () => new Float32Array(3));
  }
  const current = clampIndex(index, bodyRows.length);
  const other = current < bodyRows.length - 1 ? current + 1 : current - 1;
  const sign = other > current ? 1 : -1;
  return Array.from({ length: bodyCount }, (_, bodyIndex) => {
    const out = new Float32Array(3);
    for (let axis = 0; axis < 3; axis += 1) {
      out[axis] = sign * (Number(bodyRows[other]?.[bodyIndex]?.[axis] ?? 0) - Number(bodyRows[current]?.[bodyIndex]?.[axis] ?? 0)) * fps;
    }
    return out;
  });
}

function estimateBodyAngularVelocities(bodyRows, index, fps, bodyCount) {
  if (!bodyRows.length || bodyRows.length <= 1) {
    return Array.from({ length: bodyCount }, () => new Float32Array(3));
  }
  const current = clampIndex(index, bodyRows.length);
  const other = current < bodyRows.length - 1 ? current + 1 : current - 1;
  return Array.from({ length: bodyCount }, (_, bodyIndex) => (
    other > current
      ? quatAngularVelocity(bodyRows[current]?.[bodyIndex], bodyRows[other]?.[bodyIndex], fps)
      : quatAngularVelocity(bodyRows[other]?.[bodyIndex], bodyRows[current]?.[bodyIndex], fps)
  ));
}

function bodyRow(row, index, width = 3) {
  if (Array.isArray(row)) {
    return row[index] ?? new Float32Array(width);
  }
  return new Float32Array(width);
}

function bodyQuatRow(row, index) {
  if (Array.isArray(row)) {
    return row[index] ?? new Float32Array([1, 0, 0, 0]);
  }
  return new Float32Array([1, 0, 0, 0]);
}

function remapRows(rows, sourceNames, targetNames, fallback = []) {
  const sourceIndex = new Map((sourceNames ?? []).map((name, index) => [name, index]));
  if (!sourceIndex.size || !targetNames?.length) {
    return readRows(rows, targetNames?.length ?? 0);
  }
  return (rows ?? []).map((row) => {
    const out = new Float32Array(targetNames.length);
    for (let index = 0; index < targetNames.length; index += 1) {
      const source = sourceIndex.get(targetNames[index]);
      out[index] = Number(row?.[source] ?? fallback?.[index] ?? 0);
    }
    return out;
  });
}

function remapBodyRows(rows, sourceNames, targetNames, width, fallback) {
  const sourceIndex = new Map((sourceNames ?? []).map((name, index) => [name, index]));
  const parsed = readBodyRows(rows, sourceNames?.length ?? targetNames?.length ?? 0, width);
  if (!sourceIndex.size || !targetNames?.length) {
    return parsed;
  }
  return parsed.map((frameRows) => targetNames.map((name) => {
    const source = sourceIndex.get(name);
    return Float32Array.from(frameRows[source] ?? fallback);
  }));
}

function normalizeFrameCache(frameCache, config) {
  const frames = frameCache?.frames ?? [];
  const providedBodyNames = frameCache?.body_names ?? frameCache?.bodyNames;
  const sourceBodyNames = providedBodyNames ?? config.bodyNames;
  const bodyNames = config.bodyNames?.length ? config.bodyNames : sourceBodyNames;
  if (providedBodyNames?.length) {
    const requiredBodyNames = [config.rootBodyName, ...(config.keybodyNames ?? [])].filter(Boolean);
    const missingBodyNames = requiredBodyNames.filter((name) => !providedBodyNames.includes(name));
    if (missingBodyNames.length) {
      throw new Error(`HoloMotion frame cache is missing required bodies: ${missingBodyNames.join(', ')}`);
    }
  }
  const bodyCount = bodyNames.length;
  const jointNames = frameCache?.joint_names ?? frameCache?.jointNames ?? config.policyJointNames;
  const fps = readFps(frameCache);
  const rootPos = frames.map((frame) => Float32Array.from(frame.root_translation ?? [0, 0, 0.78]));
  const rootQuat = frames.map((frame) => Float32Array.from(frame.root_rotation_wxyz ?? [1, 0, 0, 0]));
  const bodyPos = remapBodyRows(
    frames.map((frame) => frame.body_positions),
    sourceBodyNames,
    bodyNames,
    3,
    [0, 0, 0]
  );
  const bodyQuat = remapBodyRows(
    frames.map((frame) => frame.body_rotations_wxyz),
    sourceBodyNames,
    bodyNames,
    4,
    [1, 0, 0, 0]
  );
  const providedBodyLinVel = remapBodyRows(
    frames.map((frame) => frame.body_linear_velocities),
    sourceBodyNames,
    bodyNames,
    3,
    [0, 0, 0]
  );
  const providedBodyAngVel = remapBodyRows(
    frames.map((frame) => frame.body_angular_velocities),
    sourceBodyNames,
    bodyNames,
    3,
    [0, 0, 0]
  );
  return {
    bodyNames,
    jointPos: remapRows(frames.map((frame) => frame.joint_positions), jointNames, config.policyJointNames, config.defaultJointPos),
    jointVel: remapRows(frames.map((frame) => frame.joint_velocities), jointNames, config.policyJointNames),
    rootPos,
    rootQuat,
    rootLinVel: frames.map((frame, index) => (
      useProvidedVectorOrEstimate(frame.root_linear_velocity, estimateLinearVelocity(rootPos, index, fps, 3), 3)
    )),
    rootAngVel: frames.map((frame, index) => (
      useProvidedVectorOrEstimate(frame.root_angular_velocity, estimateAngularVelocity(rootQuat, index, fps), 3)
    )),
    bodyPos,
    bodyQuat,
    bodyLinVel: frames.map((frame, index) => {
      const rows = frame.body_linear_velocities;
      const estimates = estimateBodyLinearVelocities(bodyPos, index, fps, bodyCount);
      if (!Array.isArray(rows) || !rows.length) {
        return estimates;
      }
      const provided = providedBodyLinVel[index];
      return Array.from({ length: bodyCount }, (_, bodyIndex) => (
        useProvidedVectorOrEstimate(provided?.[bodyIndex], estimates[bodyIndex], 3)
      ));
    }),
    bodyAngVel: frames.map((frame, index) => {
      const rows = frame.body_angular_velocities;
      const estimates = estimateBodyAngularVelocities(bodyQuat, index, fps, bodyCount);
      if (!Array.isArray(rows) || !rows.length) {
        return estimates;
      }
      const provided = providedBodyAngVel[index];
      return Array.from({ length: bodyCount }, (_, bodyIndex) => (
        useProvidedVectorOrEstimate(provided?.[bodyIndex], estimates[bodyIndex], 3)
      ));
    })
  };
}

function makeDefaultClip(defaultJointPos, resetRootTranslation, bodyNames, rootBodyIndex = 0) {
  const bodyCount = bodyNames.length || 1;
  const bodyPos = Array.from({ length: bodyCount }, () => Float32Array.from([0, 0, Number(resetRootTranslation?.[2] ?? 0.78)]));
  bodyPos[clampIndex(rootBodyIndex, bodyCount)] = Float32Array.from(resetRootTranslation ?? [0, 0, 0.78]);
  const bodyQuat = Array.from({ length: bodyCount }, () => Float32Array.from([1, 0, 0, 0]));
  const bodyVel = Array.from({ length: bodyCount }, () => new Float32Array(3));
  return {
    bodyNames,
    jointPos: [Float32Array.from(defaultJointPos)],
    jointVel: [new Float32Array(defaultJointPos.length)],
    rootPos: [Float32Array.from(resetRootTranslation)],
    rootQuat: [Float32Array.from([1, 0, 0, 0])],
    rootLinVel: [new Float32Array(3)],
    rootAngVel: [new Float32Array(3)],
    bodyPos: [bodyPos],
    bodyQuat: [bodyQuat],
    bodyLinVel: [bodyVel],
    bodyAngVel: [bodyVel.map((row) => Float32Array.from(row))]
  };
}

function yawComponent(quat) {
  const [w, x, y, z] = normalizeQuat(quat);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const half = yaw * 0.5;
  return [Math.cos(half), 0, 0, Math.sin(half)];
}

function yawAlignClipToState(clip, anchorIndex, state) {
  const targetRootPos = state?.rootPos;
  const targetRootQuat = state?.rootQuat;
  if (!targetRootPos || !targetRootQuat || !clip.rootPos.length) {
    return null;
  }
  const safeIndex = clampIndex(anchorIndex, clip.rootPos.length);
  const anchorPos = clip.rootPos[safeIndex] ?? [0, 0, 0.78];
  const qDelta = quatMultiply(yawComponent(targetRootQuat), quatInverse(yawComponent(clip.rootQuat[safeIndex])));
  const [qw, , , qz] = qDelta;
  return {
    anchorPos: Float32Array.from(anchorPos),
    qDelta: Float32Array.from(qDelta),
    qw,
    qz,
    targetX: Number(targetRootPos[0] ?? 0),
    targetY: Number(targetRootPos[1] ?? 0)
  };
}

function rotateAlignmentXY(alignment, x, y) {
  return [
    (1 - 2 * alignment.qz * alignment.qz) * x - (2 * alignment.qw * alignment.qz) * y,
    (2 * alignment.qw * alignment.qz) * x + (1 - 2 * alignment.qz * alignment.qz) * y
  ];
}

function alignPosition(row, alignment) {
  const [x, y] = rotateAlignmentXY(
    alignment,
    Number(row?.[0] ?? 0) - Number(alignment.anchorPos[0] ?? 0),
    Number(row?.[1] ?? 0) - Number(alignment.anchorPos[1] ?? 0)
  );
  return Float32Array.from([
    alignment.targetX + x,
    alignment.targetY + y,
    Number(row?.[2] ?? alignment.anchorPos[2] ?? 0.78)
  ]);
}

function alignVector(row, alignment) {
  const [x, y] = rotateAlignmentXY(alignment, Number(row?.[0] ?? 0), Number(row?.[1] ?? 0));
  return Float32Array.from([x, y, Number(row?.[2] ?? 0)]);
}

function applyYawAlignment(frame, alignment) {
  if (!alignment) {
    return frame;
  }
  return {
    ...frame,
    rootPos: alignPosition(frame.rootPos, alignment),
    rootQuat: Float32Array.from(quatMultiply(alignment.qDelta, frame.rootQuat)),
    rootLinVel: alignVector(frame.rootLinVel, alignment),
    rootAngVel: alignVector(frame.rootAngVel, alignment),
    bodyPos: frame.bodyPos.map((row) => alignPosition(row, alignment)),
    bodyQuat: frame.bodyQuat.map((row) => Float32Array.from(quatMultiply(alignment.qDelta, row))),
    bodyLinVel: frame.bodyLinVel.map((row) => alignVector(row, alignment)),
    bodyAngVel: frame.bodyAngVel.map((row) => alignVector(row, alignment))
  };
}

function lerpArray(start, end, alpha) {
  const width = Math.max(start?.length ?? 0, end?.length ?? 0);
  const out = new Float32Array(width);
  for (let index = 0; index < width; index += 1) {
    const from = Number(start?.[index] ?? end?.[index] ?? 0);
    const to = Number(end?.[index] ?? from);
    out[index] = from + (to - from) * alpha;
  }
  return out;
}

function slerpQuat(start, end, alpha) {
  const from = normalizeQuat(start);
  let to = normalizeQuat(end);
  let dot = from.reduce((sum, value, index) => sum + value * to[index], 0);
  if (dot < 0) {
    to = to.map((value) => -value);
    dot = -dot;
  }
  if (dot > 0.9995) {
    return Float32Array.from(normalizeQuat(from.map((value, index) => value + (to[index] - value) * alpha)));
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const startScale = Math.sin((1 - alpha) * theta) / sinTheta;
  const endScale = Math.sin(alpha * theta) / sinTheta;
  return Float32Array.from(from.map((value, index) => value * startScale + to[index] * endScale));
}

class HoloMotionTracking {
  constructor(policy) {
    this.policy = policy;
    this.motions = new Map();
    this.reset();
  }

  reset(state = null) {
    this.currentName = 'default';
    this.refIdx = 0;
    this.refLen = 1;
    this.sourceStartFrame = 0;
    this.currentDone = true;
    this.alignment = null;
    this.transitionLen = 0;
    this.transitionIndex = 0;
    this.transitionStartState = null;
    if (state) {
      this.anchorCurrentFrameToState(state);
    }
  }

  setMotionClip(name, frameCache) {
    if (!name || !frameCache) {
      return false;
    }
    const clip = normalizeFrameCache(frameCache, this.policy);
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
    this.refLen = this._clip().jointPos.length;
    this.sourceStartFrame = name === 'default' ? 0 : clampIndex(options.startFrame ?? 0, this.refLen);
    this.refIdx = this.sourceStartFrame;
    this.alignment = null;
    this.transitionLen = name === 'default' || !state
      ? 0
      : Math.max(0, Math.floor(Number(options.transitionSteps) || 0));
    this.transitionIndex = 0;
    this.transitionStartState = this.transitionLen > 0 ? {
      jointPos: Float32Array.from(state.jointPos ?? this.policy.defaultJointPos),
      jointVel: Float32Array.from(state.jointVel ?? new Float32Array(this.policy.numActions)),
      rootPos: Float32Array.from(state.rootPos ?? this.policy.resetRootTranslation),
      rootQuat: Float32Array.from(state.rootQuat ?? [1, 0, 0, 0]),
      rootLinVel: Float32Array.from(state.rootLinVel ?? [0, 0, 0]),
      rootAngVel: Float32Array.from(state.rootAngVel ?? [0, 0, 0])
    } : null;
    this.currentDone = this.transitionLen === 0 && this.refIdx >= this.refLen - 1;
    if (state) {
      this.anchorCurrentFrameToState(state);
    }
    return true;
  }

  advance() {
    if (this._inTransition()) {
      this.transitionIndex += 1;
      if (!this._inTransition()) {
        this.currentDone = this.refIdx >= this.refLen - 1;
      }
      return;
    }
    if (this.refIdx < this.refLen - 1) {
      this.refIdx += 1;
    }
    if (this.refIdx >= this.refLen - 1) {
      this.currentDone = true;
    }
  }

  isReady() {
    return this.refLen > 0;
  }

  playbackState() {
    const inTransition = this._inTransition();
    return {
      available: this.isReady(),
      currentName: this.currentName,
      currentDone: this.currentDone,
      refIdx: clampIndex(this.refIdx, this.refLen),
      refLen: this.refLen,
      transitionLen: this.transitionLen,
      motionLen: Math.max(1, this.refLen - this.sourceStartFrame),
      sourceStartFrame: this.sourceStartFrame,
      sourceFrame: clampIndex(this.refIdx, this.refLen),
      inTransition,
      isDefault: this.currentName === 'default'
    };
  }

  getFrame(index = this.refIdx) {
    const frame = this.frame(index);
    return {
      jointPos: frame.jointPos,
      rootPos: frame.rootPos,
      rootQuat: frame.rootQuat
    };
  }

  anchorCurrentFrameToState(state = null) {
    if (!state || this.currentName === 'default') {
      return false;
    }
    const clip = this._clip();
    this.alignment = yawAlignClipToState(clip, this.refIdx, state);
    return Boolean(this.alignment);
  }

  frame(index = this.refIdx) {
    const frame = this._sourceFrame(index);
    if (this._inTransition() && clampIndex(index, this.refLen) === this.refIdx) {
      return this._transitionFrame(frame, this.transitionIndex);
    }
    return frame;
  }

  _sourceFrame(index) {
    const clip = this._clip();
    const idx = clampIndex(index, clip.jointPos.length);
    return applyYawAlignment({
      clip,
      idx,
      jointPos: clip.jointPos[idx] ?? new Float32Array(this.policy.numActions),
      jointVel: clip.jointVel[idx] ?? new Float32Array(this.policy.numActions),
      rootPos: clip.rootPos[idx] ?? new Float32Array([0, 0, 0.78]),
      rootQuat: clip.rootQuat[idx] ?? new Float32Array([1, 0, 0, 0]),
      rootLinVel: clip.rootLinVel[idx] ?? new Float32Array(3),
      rootAngVel: clip.rootAngVel[idx] ?? new Float32Array(3),
      bodyPos: clip.bodyPos[idx] ?? [],
      bodyQuat: clip.bodyQuat[idx] ?? [],
      bodyLinVel: clip.bodyLinVel[idx] ?? [],
      bodyAngVel: clip.bodyAngVel[idx] ?? []
    }, this.alignment);
  }

  futureFrames(count) {
    return Array.from({ length: count }, (_, offset) => {
      const stepOffset = offset + 1;
      if (this._inTransition()) {
        const futureTransitionIndex = this.transitionIndex + stepOffset;
        if (futureTransitionIndex < this.transitionLen) {
          return this._transitionFrame(this._sourceFrame(this.refIdx), futureTransitionIndex);
        }
        const sourceOffset = futureTransitionIndex - this.transitionLen;
        return this._sourceFrame(clampIndex(this.refIdx + sourceOffset, this.refLen));
      }
      return this._sourceFrame(clampIndex(this.refIdx + stepOffset, this.refLen));
    });
  }

  _inTransition() {
    return this.transitionIndex < this.transitionLen;
  }

  _transitionFrame(frame, transitionIndex) {
    if (!this.transitionStartState || this.transitionLen <= 0) {
      return frame;
    }
    const alpha = Math.min(1, Math.max(0, (transitionIndex + 1) / this.transitionLen));
    return {
      ...frame,
      jointPos: lerpArray(this.transitionStartState.jointPos, frame.jointPos, alpha),
      jointVel: lerpArray(this.transitionStartState.jointVel, frame.jointVel, alpha),
      rootPos: lerpArray(this.transitionStartState.rootPos, frame.rootPos, alpha),
      rootQuat: slerpQuat(this.transitionStartState.rootQuat, frame.rootQuat, alpha),
      rootLinVel: lerpArray(this.transitionStartState.rootLinVel, frame.rootLinVel, alpha),
      rootAngVel: lerpArray(this.transitionStartState.rootAngVel, frame.rootAngVel, alpha)
    };
  }

  _clip() {
    if (this.currentName === 'default') {
      return this.policy.defaultClip;
    }
    return this.motions.get(this.currentName) ?? this.policy.defaultClip;
  }
}

export class HoloMotionBrowserPolicy {
  constructor(manifest, host) {
    this.manifest = manifest;
    this.host = host;
    this.ort = host.ort;
    this.config = null;
    this.session = null;
    this.policyJointNames = [];
    this.numActions = 0;
    this.defaultJointPos = new Float32Array();
    this.resetJointPos = new Float32Array();
    this.resetRootTranslation = new Float32Array([0, 0, 0.8]);
    this.actionScale = new Float32Array();
    this.stiffness = new Float32Array();
    this.damping = new Float32Array();
    this.torqueLimits = new Float32Array();
    this.controlDt = 0.02;
    this.actionClip = 10;
    this.physicsOptions = null;
    this.nFutFrames = 10;
    this.keybodyNames = [];
    this.bodyNames = [];
    this.rootBodyName = 'pelvis';
    this.rootBodyIndex = 0;
    this.keybodyIndexes = [];
    this.obsTerms = [];
    this.refMotionFilterCutoffHz = 0;
    this.lastActions = new Float32Array();
    this.kvCache = null;
    this.kvShape = [3, 2, 1, 32, 4, 64];
    this.kvDtype = 'float32';
    this.kvInputName = null;
    this.kvOutputName = null;
    this.obsInputName = 'obs';
    this.actionOutputName = 'actions';
    this.stepInputName = null;
    this.stepIndex = 0;
    this.defaultClip = makeDefaultClip([], this.resetRootTranslation, []);
    this.tracking = new HoloMotionTracking(this);
    this.isInferencing = false;
  }

  async load() {
    await this._loadConfig();
    const modelPath = this.host.resolveStaticAssetPath(this.manifest.config_path, this.config.onnx?.path);
    const response = await fetch(modelPath);
    if (!response.ok) {
      throw new Error(`Failed to load HoloMotion ONNX model: ${response.status}`);
    }
    const modelBuffer = await response.arrayBuffer();
    await this._loadOnnxSession(modelBuffer);
    return this;
  }

  async _loadConfig() {
    this.config = await this.host.loadPolicyConfig(this.manifest.config_path);
    this.policyJointNames = this.config.policy_joint_names?.slice() ?? [];
    this.numActions = this.policyJointNames.length;
    this.defaultJointPos = toFloatArray(this.config.default_joint_pos, this.numActions, 0);
    this.resetJointPos = toFloatArray(this.config.reset_joint_pos ?? this.config.default_joint_pos, this.numActions, 0);
    this.resetRootTranslation = toFloatArray(this.config.reset_root_translation ?? [0, 0, 0.8], 3, 0);
    this.actionScale = toFloatArray(this.config.action_scale, this.numActions, 1);
    this.stiffness = toFloatArray(this.config.stiffness, this.numActions, 0);
    this.damping = toFloatArray(this.config.damping, this.numActions, 0);
    this.torqueLimits = toFloatArray(this.config.torque_limits, this.numActions, Number.POSITIVE_INFINITY);
    this.controlDt = Number(this.config.control_dt ?? 0.02);
    this.actionClip = Number(this.config.action_clip ?? 10);
    this.physicsOptions = this.host.clonePhysicsOptions?.(this.config.physics_options) ?? null;
    this.nFutFrames = Number(this.config.holomotion?.n_fut_frames ?? 10);
    this.keybodyNames = this.config.holomotion?.keybody_names?.slice() ?? [];
    this.bodyNames = this.config.holomotion?.body_names?.slice() ?? [];
    this.rootBodyName = this.bodyNames.includes('pelvis') ? 'pelvis' : (this.bodyNames[0] ?? 'pelvis');
    this.rootBodyIndex = Math.max(0, this.bodyNames.indexOf(this.rootBodyName));
    this.keybodyIndexes = this.keybodyNames.map((name) => this.bodyNames.indexOf(name)).filter((index) => index >= 0);
    this.obsTerms = this.config.holomotion?.obs_terms?.slice() ?? [];
    this.refMotionFilterCutoffHz = Number(this.config.holomotion?.ref_motion_filter_cutoff_hz ?? 0);
    this.kvShape = this.config.onnx?.meta?.input_shapes?.past_key_values?.slice() ?? this.kvShape;
    this.kvDtype = String(this.config.onnx?.meta?.kv_dtype ?? 'float32').toLowerCase();
    this.defaultClip = makeDefaultClip(
      this.defaultJointPos,
      this.resetRootTranslation,
      this.bodyNames.length ? this.bodyNames : ['pelvis'],
      this.rootBodyIndex
    );
    this.tracking = new HoloMotionTracking(this);
    this.lastActions = new Float32Array(this.numActions);
  }

  async _loadOnnxSession(modelSource) {
    this.session = await this.ort.InferenceSession.create(modelSource, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    this._resolveOnnxIo();
    this.reset();
  }

  reset(state = null) {
    this.lastActions = new Float32Array(this.numActions);
    this.resetKvCache();
    this.stepIndex = 0;
    this.tracking.reset(state);
  }

  resetKvCache() {
    if (!this.kvInputName) {
      this.kvCache = null;
      return;
    }
    const size = this.kvShape.reduce((product, value) => product * Number(value || 1), 1);
    this.kvCache = this.kvDtype === 'float16' && typeof Uint16Array !== 'undefined'
      ? new Uint16Array(size)
      : new Float32Array(size);
  }

  setMotionClip(name, frameCache) {
    return this.tracking.setMotionClip(name, frameCache);
  }

  requestMotion(name, statePayload, options = {}) {
    const state = statePayload ? this._referenceToPolicyState(statePayload) : null;
    return this.tracking.requestMotion(name, state, options);
  }

  async step(input = {}) {
    if (this.isInferencing) {
      return null;
    }
    if (!this.session) {
      throw new Error('HoloMotion policy is not loaded.');
    }
    this.isInferencing = true;
    try {
      const state = this._referenceToPolicyState(input.current_state ?? input.reference);
      this.tracking.anchorCurrentFrameToState(state);
      const obs = this._buildObservation(state);
      const feeds = {
        [this.obsInputName]: new this.ort.Tensor('float32', obs, [1, obs.length])
      };
      if (this.kvInputName && this.kvCache) {
        feeds[this.kvInputName] = new this.ort.Tensor(this.kvDtype, this.kvCache, this.kvShape);
      }
      if (this.stepInputName) {
        feeds[this.stepInputName] = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(this.stepIndex)]), [1]);
      }
      const outputs = await this.session.run(feeds);
      const actionTensor = outputs[this.actionOutputName] ?? outputs.actions ?? outputs[this.session.outputNames?.[0]];
      const kvTensor = this.kvOutputName ? outputs[this.kvOutputName] : null;
      if (kvTensor?.data) {
        this.kvCache = this.kvDtype === 'float16' && typeof Uint16Array !== 'undefined'
          ? Uint16Array.from(kvTensor.data)
          : Float32Array.from(kvTensor.data);
      }
      this.stepIndex += 1;
      const action = actionTensor?.data;
      if (!action || action.length < this.numActions) {
        throw new Error('HoloMotion policy returned no valid action output.');
      }
      const jointPositions = this._actionToJointTargets(action);
      const frame = this.tracking.frame();
      this.tracking.advance();
      return this._makeOutput(jointPositions, frame);
    } finally {
      this.isInferencing = false;
    }
  }

  defaultStance() {
    return this._makeOutput(cloneArray(this.resetJointPos), this.tracking.frame());
  }

  _resolveOnnxIo() {
    const inputNames = this.session?.inputNames ?? [];
    const outputNames = this.session?.outputNames ?? [];
    const meta = this.config?.onnx?.meta ?? {};
    const metaInputs = meta.in_keys ?? [];
    const metaOutputs = meta.out_keys ?? [];
    const firstInput = inputNames[0] ?? metaInputs[0] ?? 'obs';
    const firstOutput = outputNames[0] ?? metaOutputs[0] ?? 'actions';
    this.obsInputName = inputNames.find((name) => name.includes('obs'))
      ?? inputNames.find((name) => metaInputs.includes(name))
      ?? metaInputs.find((name) => name.includes('obs'))
      ?? firstInput;
    this.kvInputName = inputNames.find((name) => name.includes('past_key_values'))
      ?? (metaInputs.includes('past_key_values') ? 'past_key_values' : null);
    this.stepInputName = inputNames.find((name) => name.includes('step_idx') || name === 'current_pos')
      ?? metaInputs.find((name) => name.includes('step_idx') || name === 'current_pos')
      ?? null;
    this.actionOutputName = outputNames.find((name) => name.includes('actions'))
      ?? metaOutputs.find((name) => name.includes('actions'))
      ?? firstOutput;
    this.kvOutputName = outputNames.find((name) => name.includes('present_key_values'))
      ?? (metaOutputs.includes('present_key_values') ? 'present_key_values' : null);

    if (this.kvInputName) {
      const shapeKey = meta.input_shapes?.[this.kvInputName] ? this.kvInputName : 'past_key_values';
      this.kvShape = meta.input_shapes?.[shapeKey]?.slice?.() ?? this.kvShape;
    }
  }

  _buildObservation(state) {
    const frame = this.tracking.frame();
    const future = this.tracking.futureFrames(this.nFutFrames);
    const parts = [];
    for (const term of this.obsTerms) {
      parts.push(this._obsTerm(term, state, frame, future));
    }
    const size = parts.reduce((sum, item) => sum + item.length, 0);
    const out = new Float32Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  _obsTerm(term, state, frame, future) {
    switch (term) {
      case 'actor_ref_gravity_projection_cur':
        return Float32Array.from(projectedGravity(frame.rootQuat));
      case 'actor_ref_gravity_projection_fut':
        return this._flattenRows(future.map((item) => projectedGravity(item.rootQuat)));
      case 'actor_ref_base_linvel_cur':
        return Float32Array.from(quatApplyInv(frame.rootQuat, frame.rootLinVel));
      case 'actor_ref_base_linvel_fut':
        return this._flattenRows(future.map((item) => quatApplyInv(item.rootQuat, item.rootLinVel)));
      case 'actor_ref_base_angvel_cur':
        return Float32Array.from(quatApplyInv(frame.rootQuat, frame.rootAngVel));
      case 'actor_ref_base_angvel_fut':
        return this._flattenRows(future.map((item) => quatApplyInv(item.rootQuat, item.rootAngVel)));
      case 'actor_ref_dof_pos_cur':
        return Float32Array.from(frame.jointPos);
      case 'actor_ref_dof_pos_fut':
        return this._flattenRows(future.map((item) => item.jointPos));
      case 'actor_ref_motion_filter_cutoff_hz':
        return Float32Array.from([this.refMotionFilterCutoffHz]);
      case 'actor_ref_root_height_cur':
        return Float32Array.from([Number(frame.rootPos[2] ?? 0)]);
      case 'actor_ref_root_height_fut':
        return Float32Array.from(future.map((item) => Number(item.rootPos[2] ?? 0)));
      case 'actor_ref_keybody_rel_pos_cur':
        return this._keybodyRelPos(frame);
      case 'actor_ref_keybody_rel_pos_fut':
        return this._flattenRows(future.map((item) => this._keybodyRelPos(item)));
      case 'actor_projected_gravity':
        return Float32Array.from(projectedGravity(state.rootQuat));
      case 'actor_rel_robot_root_ang_vel':
        return Float32Array.from(quatApplyInv(state.rootQuat, state.rootAngVel ?? [0, 0, 0]));
      case 'actor_dof_pos':
        return this._robotDofPos(state);
      case 'actor_dof_vel':
        return Float32Array.from(state.jointVel ?? new Float32Array(this.numActions));
      case 'actor_last_action':
        return Float32Array.from(this.lastActions);
      default:
        return new Float32Array();
    }
  }

  _keybodyRelPos(frame) {
    const out = new Float32Array(this.keybodyIndexes.length * 3);
    const rootPos = bodyRow(frame.bodyPos, this.rootBodyIndex, 3);
    const rootQuat = bodyQuatRow(frame.bodyQuat, this.rootBodyIndex);
    let offset = 0;
    for (const bodyIndex of this.keybodyIndexes) {
      const pos = bodyRow(frame.bodyPos, bodyIndex, 3);
      const rel = [
        Number(pos[0] ?? 0) - Number(rootPos[0] ?? 0),
        Number(pos[1] ?? 0) - Number(rootPos[1] ?? 0),
        Number(pos[2] ?? 0) - Number(rootPos[2] ?? 0)
      ];
      out.set(quatApplyInv(rootQuat, rel), offset);
      offset += 3;
    }
    return out;
  }

  _robotDofPos(state) {
    const out = new Float32Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      out[index] = Number(state.jointPos?.[index] ?? 0) - Number(this.defaultJointPos[index] ?? 0);
    }
    return out;
  }

  _flattenRows(rows) {
    const total = rows.reduce((sum, row) => sum + row.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const row of rows) {
      out.set(row, offset);
      offset += row.length;
    }
    return out;
  }

  _referenceToPolicyState(payload = {}) {
    const state = payload?.state ?? payload ?? {};
    const jointNames = payload?.joint_names ?? this.policyJointNames;
    const jointIndex = new Map(jointNames.map((name, index) => [name, index]));
    const jointPos = new Float32Array(this.numActions);
    const jointVel = new Float32Array(this.numActions);
    for (let index = 0; index < this.numActions; index += 1) {
      const sourceIndex = jointIndex.get(this.policyJointNames[index]);
      jointPos[index] = Number(state.joint_positions?.[sourceIndex] ?? state.jointPos?.[index] ?? this.defaultJointPos[index] ?? 0);
      jointVel[index] = Number(state.joint_velocities?.[sourceIndex] ?? state.jointVel?.[index] ?? 0);
    }
    return {
      jointPos,
      jointVel,
      rootPos: Float32Array.from(state.root_translation ?? state.rootPos ?? [0, 0, 0.8]),
      rootQuat: Float32Array.from(state.root_rotation_wxyz ?? state.rootQuat ?? [1, 0, 0, 0]),
      rootAngVel: Float32Array.from(state.root_angular_velocity ?? state.rootAngVel ?? [0, 0, 0])
    };
  }

  _actionToJointTargets(action) {
    const jointPositions = [];
    for (let index = 0; index < this.numActions; index += 1) {
      const raw = Number(action[index] ?? 0);
      const clipped = Math.max(-this.actionClip, Math.min(this.actionClip, raw));
      this.lastActions[index] = raw;
      jointPositions.push(Number(this.defaultJointPos[index] ?? 0) + Number(this.actionScale[index] ?? 1) * clipped);
    }
    return jointPositions;
  }

  _makeOutput(jointPositions, frame) {
    const output = {
      mode: 'joint_position_target',
      joint_names: cloneArray(this.policyJointNames),
      joint_positions: cloneArray(jointPositions),
      kp: cloneArray(this.stiffness),
      kd: cloneArray(this.damping),
      torque_limits: cloneArray(this.torqueLimits),
      root_translation: cloneArray(frame?.rootPos, this.resetRootTranslation),
      root_rotation_wxyz: cloneArray(frame?.rootQuat, [1, 0, 0, 0]),
      control_dt: this.controlDt
    };
    if (this.physicsOptions) {
      output.physics_options = JSON.parse(JSON.stringify(this.physicsOptions));
    }
    return output;
  }
}

export async function createBrowserPolicy(manifest, host) {
  return new HoloMotionBrowserPolicy(manifest, host);
}
