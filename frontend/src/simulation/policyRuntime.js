import * as ort from 'onnxruntime-web';
import { Observations } from './observationHelpers.js';
import { TrackingHelper } from './trackingHelper.js';
import { toFloatArray } from './utils/math.js';

export const BROWSER_POLICY_MANIFESTS = Object.freeze([
  {
    policy_id: 'mock_passthrough',
    display_name: 'Mock Passthrough',
    framework: 'mock',
    control_mode: 'joint_position_target',
    config_path: '/examples/checkpoints/g1/tracking_policy_latest.json',
    description: 'Browser-local target passthrough. With physics off this behaves like motion playback.'
  },
  {
    policy_id: 'g1_tracking_onnx',
    display_name: 'G1 Tracking ONNX',
    framework: 'onnx',
    control_mode: 'joint_position_target',
    config_path: '/examples/checkpoints/g1/tracking_policy_latest.json',
    description: 'Browser ONNX Runtime Web policy loader compatible with humanoid-policy-viewer checkpoints.'
  }
]);

function cloneArray(values, fallback = []) {
  if (!values) {
    return Array.from(fallback);
  }
  return Array.from(values);
}

function resolveStaticAssetPath(configPath, assetPath) {
  if (!assetPath) {
    return '';
  }
  if (/^(https?:)?\/\//.test(assetPath) || assetPath.startsWith('/')) {
    return assetPath;
  }
  if (assetPath.startsWith('./examples/')) {
    return `/${assetPath.slice(2)}`;
  }
  const origin = globalThis.location?.origin ?? 'http://localhost';
  return new URL(assetPath, new URL(configPath, origin)).pathname;
}

function makeTensor(name, value) {
  if (name === 'is_init') {
    return new ort.Tensor('bool', [Boolean(value)], [1]);
  }
  const data = ArrayBuffer.isView(value) ? value : Float32Array.from(value ?? []);
  return new ort.Tensor('float32', data, [1, data.length]);
}

function makeDefaultStanceTarget({ policyJointNames, defaultJointPos, stiffness, damping }) {
  return {
    mode: 'joint_position_target',
    joint_names: cloneArray(policyJointNames),
    joint_positions: cloneArray(defaultJointPos).map((value) => Number(Number(value).toFixed(8))),
    kp: cloneArray(stiffness).map((value) => Number(Number(value).toFixed(8))),
    kd: cloneArray(damping).map((value) => Number(Number(value).toFixed(8))),
    root_translation: [0, 0, 0.78],
    root_rotation_wxyz: [1, 0, 0, 0]
  };
}

async function loadPolicyConfig(configPath, { required = true } = {}) {
  if (!configPath) {
    return null;
  }
  let response;
  try {
    response = await fetch(configPath);
  } catch (error) {
    if (!required) {
      return null;
    }
    throw error;
  }
  if (!response.ok) {
    if (!required) {
      return null;
    }
    throw new Error(`Failed to load browser policy config: ${response.status}`);
  }
  return response.json();
}

function referenceToPolicyState(reference, policyJointNames) {
  const state = reference?.state ?? {};
  const referenceJointNames = reference?.joint_names ?? [];
  const referenceJointIndex = new Map(referenceJointNames.map((name, index) => [name, index]));
  const jointPositions = state.joint_positions ?? [];
  const jointVelocities = state.joint_velocities ?? [];
  const jointPos = new Float32Array(policyJointNames.length);
  const jointVel = new Float32Array(policyJointNames.length);

  for (let index = 0; index < policyJointNames.length; index += 1) {
    const sourceIndex = referenceJointIndex.get(policyJointNames[index]);
    jointPos[index] = Number(jointPositions[sourceIndex] ?? 0);
    jointVel[index] = Number(jointVelocities[sourceIndex] ?? 0);
  }

  return {
    jointPos,
    jointVel,
    rootPos: Float32Array.from(cloneArray(state.root_translation, [0, 0, 0.78])),
    rootQuat: Float32Array.from(cloneArray(state.root_rotation_wxyz, [1, 0, 0, 0])),
    rootAngVel: Float32Array.from(cloneArray(state.root_angular_velocity, [0, 0, 0])),
    complianceEnabled: Boolean(reference?.compliance_enabled),
    complianceThreshold: Number(reference?.compliance_threshold ?? 10)
  };
}

function summarizeOutput(output) {
  return {
    mode: output.mode,
    joint_count: output.joint_names?.length ?? 0,
    has_root_target: Array.isArray(output.root_translation)
  };
}

export function normalizeFrameCacheAsMotionClip(frameCache) {
  const frames = frameCache?.frames ?? [];
  return {
    root_pos: frames.map((frame) => cloneArray(frame.root_translation, [0, 0, 0.78])),
    root_quat: frames.map((frame) => cloneArray(frame.root_rotation_wxyz, [1, 0, 0, 0])),
    joint_pos: frames.map((frame) => cloneArray(frame.joint_positions))
  };
}

export class MockPassthroughPolicy {
  constructor(manifest = BROWSER_POLICY_MANIFESTS[0]) {
    this.manifest = manifest;
    this.policyJointNames = [];
    this.defaultJointPos = [];
    this.stiffness = [];
    this.damping = [];
  }

  async load() {
    const config = await loadPolicyConfig(this.manifest?.config_path, { required: false });
    this.policyJointNames = Array.isArray(config?.policy_joint_names)
      ? config.policy_joint_names.slice()
      : [];
    this.defaultJointPos = cloneArray(config?.default_joint_pos).slice(0, this.policyJointNames.length);
    this.stiffness = cloneArray(config?.stiffness).slice(0, this.policyJointNames.length);
    this.damping = cloneArray(config?.damping).slice(0, this.policyJointNames.length);
    return this;
  }

  reset() {}

  setMotionClip(name, frameCache) {
    return Boolean(name && frameCache);
  }

  requestMotion() {
    return true;
  }

  async step(input = {}) {
    const reference = input.reference ?? {};
    const state = reference.state ?? {};
    return {
      mode: 'joint_position_target',
      joint_names: cloneArray(reference.joint_names),
      joint_positions: cloneArray(state.joint_positions),
      kp: cloneArray(state.stiffness),
      kd: cloneArray(state.damping),
      root_translation: cloneArray(state.root_translation, [0, 0, 0.78]),
      root_rotation_wxyz: cloneArray(state.root_rotation_wxyz, [1, 0, 0, 0])
    };
  }

  defaultStance() {
    return makeDefaultStanceTarget(this);
  }
}

export class BrowserOnnxPolicy {
  constructor(manifest) {
    this.manifest = manifest;
    this.config = null;
    this.session = null;
    this.inputState = {};
    this.policyJointNames = [];
    this.numActions = 0;
    this.lastActions = new Float32Array();
    this.defaultJointPos = new Float32Array();
    this.actionScale = new Float32Array();
    this.stiffness = new Float32Array();
    this.damping = new Float32Array();
    this.actionClip = 10;
    this.tracking = null;
    this.obsModules = [];
    this.numObs = 0;
    this.isInferencing = false;
  }

  async load() {
    if (!this.manifest?.config_path) {
      throw new Error('ONNX policy manifest missing config_path.');
    }
    const rawConfig = await loadPolicyConfig(this.manifest.config_path);
    const tracking = await this._loadTrackingConfig(rawConfig);
    this.config = { ...rawConfig, tracking };
    this.policyJointNames = Array.isArray(this.config.policy_joint_names)
      ? this.config.policy_joint_names.slice()
      : [];
    if (this.policyJointNames.length === 0) {
      throw new Error('ONNX policy config missing policy_joint_names.');
    }
    this.numActions = this.policyJointNames.length;
    this.defaultJointPos = toFloatArray(this.config.default_joint_pos, this.numActions, 0);
    this.actionScale = toFloatArray(this.config.action_scale, this.numActions, 1);
    this.stiffness = toFloatArray(this.config.stiffness, this.numActions, 0);
    this.damping = toFloatArray(this.config.damping, this.numActions, 0);
    this.actionClip = Number.isFinite(Number(this.config.action_clip)) ? Number(this.config.action_clip) : 10;
    this.lastActions = new Float32Array(this.numActions);
    this.tracking = tracking ? new TrackingHelper(tracking) : null;
    this.obsModules = this._buildObsModules(this.config.obs_config);
    this.numObs = this.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);

    const modelPath = resolveStaticAssetPath(this.manifest.config_path, this.config?.onnx?.path);
    const modelResponse = await fetch(modelPath);
    if (!modelResponse.ok) {
      throw new Error(`Failed to load ONNX policy model: ${modelResponse.status}`);
    }
    const modelArrayBuffer = await modelResponse.arrayBuffer();
    this.session = await ort.InferenceSession.create(modelArrayBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    this.reset();
    return this;
  }

  async _loadTrackingConfig(config) {
    if (!config.tracking) {
      return null;
    }
    const tracking = { ...config.tracking, policy_joint_names: config.policy_joint_names?.slice() ?? [] };
    if (tracking.motions_path && !tracking.motions) {
      const motionsPath = resolveStaticAssetPath(this.manifest.config_path, tracking.motions_path);
      const response = await fetch(motionsPath);
      if (!response.ok) {
        throw new Error(`Failed to load tracking motions: ${response.status}`);
      }
      const payload = await response.json();
      if (payload.format === 'tracking-motion-index-v1') {
        const indexed = await this._loadMotionIndex(payload, motionsPath);
        tracking.motions = indexed.motions;
        tracking.motion_meta = indexed.motionMeta;
      } else {
        tracking.motions = payload;
      }
    }
    return tracking;
  }

  async _loadMotionIndex(payload, motionsPath) {
    const motions = {};
    const motionMeta = {};
    const basePath = payload.base_path ?? './motions';
    const baseUrl = new URL(basePath.endsWith('/') ? basePath : `${basePath}/`, new URL(motionsPath, globalThis.location?.origin ?? 'http://localhost'));
    for (const entry of payload.motions ?? []) {
      if (!entry?.name || !entry?.file) {
        continue;
      }
      const motionUrl = new URL(entry.file, baseUrl).pathname;
      const response = await fetch(motionUrl);
      if (!response.ok) {
        throw new Error(`Failed to load tracking motion ${entry.name}: ${response.status}`);
      }
      motions[entry.name] = await response.json();
      motionMeta[entry.name] = {
        compliance_suitable: typeof entry.compliance_suitable === 'boolean' ? entry.compliance_suitable : true
      };
    }
    return { motions, motionMeta };
  }

  _buildObsModules(obsConfig) {
    const obsList = Array.isArray(obsConfig?.policy) ? obsConfig.policy : [];
    return obsList.map((entry) => {
      const ObsClass = Observations[entry.name];
      if (!ObsClass) {
        throw new Error(`Unknown observation type: ${entry.name}`);
      }
      const kwargs = { ...entry };
      delete kwargs.name;
      return new ObsClass(this, kwargs);
    });
  }

  reset(state = null) {
    this.inputState = {};
    this.lastActions = new Float32Array(this.numActions);
    this.tracking?.reset(state);
    for (const obs of this.obsModules) {
      obs.reset?.(state);
    }
    const inKeys = this.config?.onnx?.meta?.in_keys ?? [];
    if (inKeys.includes('is_init')) {
      this.inputState.is_init = new ort.Tensor('bool', [true], [1]);
    }
    if (inKeys.includes('adapt_hx')) {
      this.inputState.adapt_hx = new ort.Tensor('float32', new Float32Array(128), [1, 128]);
    }
  }

  _buildObservation(state) {
    this.tracking?.advance();
    const obsForPolicy = new Float32Array(this.numObs);
    let offset = 0;
    for (const obs of this.obsModules) {
      obs.update?.(state);
      const obsValue = obs.compute(state);
      const obsArray = ArrayBuffer.isView(obsValue) ? obsValue : Float32Array.from(obsValue);
      obsForPolicy.set(obsArray, offset);
      offset += obsArray.length;
    }
    return obsForPolicy;
  }

  _buildInputs(state) {
    const meta = this.config?.onnx?.meta ?? {};
    const inKeys = meta.in_keys ?? [];
    const feeds = {};
    const observation = this._buildObservation(state);
    for (let index = 0; index < inKeys.length; index += 1) {
      const key = inKeys[index];
      const sessionName = this.session.inputNames[index] ?? key;
      if (key === 'policy') {
        feeds[sessionName] = new ort.Tensor('float32', observation, [1, observation.length]);
      } else if (this.inputState[key]) {
        feeds[sessionName] = this.inputState[key];
      } else {
        feeds[sessionName] = makeTensor(key, []);
      }
    }
    return feeds;
  }

  _readOutput(outputs) {
    const outKeys = this.config?.onnx?.meta?.out_keys ?? [];
    const named = {};
    for (let index = 0; index < outKeys.length; index += 1) {
      const key = outKeys[index];
      const sessionName = this.session.outputNames[index] ?? key;
      named[key] = outputs[sessionName];
    }
    if (named['next,adapt_hx']) {
      this.inputState.is_init = new ort.Tensor('bool', [false], [1]);
      this.inputState.adapt_hx = named['next,adapt_hx'];
    }
    return named.action?.data;
  }

  async step(input = {}) {
    if (this.isInferencing) {
      return null;
    }
    if (!this.session || !this.config) {
      throw new Error('ONNX policy is not loaded.');
    }
    this.isInferencing = true;
    try {
      const reference = input.reference ?? {};
      const referenceState = reference.state ?? {};
      const policyState = referenceToPolicyState(input.current_state ?? reference, this.policyJointNames);
      const outputs = await this.session.run(this._buildInputs(policyState));
      const action = this._readOutput(outputs);
      if (!action || action.length < this.policyJointNames.length) {
        throw new Error('ONNX policy returned no valid action output.');
      }

      const jointPositions = this.policyJointNames.map((_, index) => {
        const raw = Math.max(-this.actionClip, Math.min(this.actionClip, Number(action[index] ?? 0)));
        this.lastActions[index] = raw;
        return Number(this.defaultJointPos[index] ?? 0) + Number(this.actionScale[index] ?? 1) * raw;
      });

      return {
        mode: 'joint_position_target',
        joint_names: cloneArray(this.policyJointNames),
        joint_positions: jointPositions,
        kp: cloneArray(this.stiffness),
        kd: cloneArray(this.damping),
        root_translation: cloneArray(referenceState.root_translation, [0, 0, 0.78]),
        root_rotation_wxyz: cloneArray(referenceState.root_rotation_wxyz, [1, 0, 0, 0])
      };
    } finally {
      this.isInferencing = false;
    }
  }

  defaultStance() {
    return makeDefaultStanceTarget(this);
  }

  setMotionClip(name, frameCache) {
    if (!this.tracking || !name) {
      return false;
    }
    const clip = normalizeFrameCacheAsMotionClip(frameCache);
    const result = this.tracking.addMotions({ [name]: clip }, {
      overwrite: true,
      motion_meta: {
        [name]: { compliance_suitable: true }
      }
    });
    return result.added.includes(name);
  }

  requestMotion(name, statePayload, options = {}) {
    if (!this.tracking || !name) {
      return false;
    }
    const state = statePayload
      ? referenceToPolicyState(statePayload, this.policyJointNames)
      : null;
    return this.tracking.requestMotion(name, state, options);
  }
}

export class BrowserPolicyRuntime {
  constructor() {
    this.activePolicy = null;
    this.activePolicyId = null;
    this.lastOutput = null;
  }

  async activate(manifest) {
    if (!manifest) {
      throw new Error('No browser policy manifest selected.');
    }
    const nextPolicy = manifest.framework === 'mock'
      ? new MockPassthroughPolicy(manifest)
      : new BrowserOnnxPolicy(manifest);
    await nextPolicy.load();
    this.activePolicy = nextPolicy;
    this.activePolicyId = manifest.policy_id;
    this.lastOutput = null;
    return this.status();
  }

  deactivate() {
    this.activePolicy = null;
    this.activePolicyId = null;
    this.lastOutput = null;
  }

  reset() {
    this.activePolicy?.reset?.();
    this.lastOutput = null;
  }

  async step(input) {
    if (!this.activePolicy) {
      throw new Error('No browser policy is active.');
    }
    const output = await this.activePolicy.step(input);
    if (output) {
      this.lastOutput = output;
    }
    return output;
  }

  defaultStance() {
    if (!this.activePolicy?.defaultStance) {
      throw new Error('No browser policy default stance is available.');
    }
    const output = this.activePolicy.defaultStance();
    this.lastOutput = output;
    return output;
  }

  setMotionClip(name, frameCache) {
    return this.activePolicy?.setMotionClip?.(name, frameCache) ?? false;
  }

  requestMotion(name, statePayload, options = {}) {
    return this.activePolicy?.requestMotion?.(name, statePayload, options) ?? false;
  }

  status() {
    return {
      active_policy_id: this.activePolicyId,
      last_policy_result: this.lastOutput ? summarizeOutput(this.lastOutput) : null
    };
  }
}

export function createBrowserPolicyRuntime() {
  return new BrowserPolicyRuntime();
}
