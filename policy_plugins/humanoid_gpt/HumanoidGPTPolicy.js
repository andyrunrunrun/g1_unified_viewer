import { HoloMotionBrowserPolicy } from '../holomotion/HoloMotionPolicy.js?g1_humanoid_gpt_base=v1';

function arrayFrom(values, fallback = []) {
  const raw = values ? Array.from(values) : Array.from(fallback);
  return raw.map((value) => Number(Number(value ?? 0).toFixed(6)));
}

function stateField(payload = {}) {
  return payload?.state && typeof payload.state === 'object' ? payload.state : payload;
}

export class HumanoidGPTBrowserPolicy extends HoloMotionBrowserPolicy {
  constructor(manifest, host) {
    super(manifest, host);
    this.backendCacheId = `humanoid-gpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.backendCacheNeedsReset = true;
  }

  async load() {
    await this._loadConfig();
    this.reset();
    return this;
  }

  reset(state = null) {
    super.reset(state);
    this.backendCacheNeedsReset = true;
  }

  requestMotion(name, statePayload, options = {}) {
    const accepted = super.requestMotion(name, statePayload, options);
    if (accepted) {
      this.backendCacheNeedsReset = true;
    }
    return accepted;
  }

  _referenceToHumanoidState(payload = {}) {
    const base = this._referenceToPolicyState(payload);
    const state = stateField(payload);
    return {
      ...base,
      rootLinVel: Float32Array.from(state.root_linear_velocity ?? state.rootLinVel ?? [0, 0, 0])
    };
  }

  _statePayload(state) {
    return {
      joint_names: arrayFrom(this.policyJointNames),
      state: {
        joint_positions: arrayFrom(state?.jointPos, this.defaultJointPos),
        joint_velocities: arrayFrom(state?.jointVel, new Float32Array(this.numActions)),
        root_translation: arrayFrom(state?.rootPos, this.resetRootTranslation),
        root_rotation_wxyz: arrayFrom(state?.rootQuat, [1, 0, 0, 0]),
        root_linear_velocity: arrayFrom(state?.rootLinVel, [0, 0, 0]),
        root_angular_velocity: arrayFrom(state?.rootAngVel, [0, 0, 0])
      }
    };
  }

  _framePayload(frame) {
    return {
      joint_names: arrayFrom(this.policyJointNames),
      state: {
        joint_positions: arrayFrom(frame?.jointPos, this.defaultJointPos),
        joint_velocities: arrayFrom(frame?.jointVel, new Float32Array(this.numActions)),
        root_translation: arrayFrom(frame?.rootPos, this.resetRootTranslation),
        root_rotation_wxyz: arrayFrom(frame?.rootQuat, [1, 0, 0, 0]),
        root_linear_velocity: arrayFrom(frame?.rootLinVel, [0, 0, 0]),
        root_angular_velocity: arrayFrom(frame?.rootAngVel, [0, 0, 0])
      }
    };
  }

  _nextFrame() {
    const nextIndex = Math.min(
      Number(this.tracking.refIdx ?? 0) + 1,
      Math.max(Number(this.tracking.refLen ?? 1) - 1, 0)
    );
    return this.tracking.frame(nextIndex);
  }

  async _runBackendInference(payload) {
    const response = await fetch('/api/humanoid-gpt/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Humanoid-GPT backend inference failed: ${response.status}${text ? ` ${text}` : ''}`);
    }
    return response.json();
  }

  async step(input = {}) {
    if (this.isInferencing) {
      return null;
    }
    this.isInferencing = true;
    try {
      const state = this._referenceToHumanoidState(input.current_state ?? input.reference);
      this.tracking.anchorCurrentFrameToState(state);
      const frame = this.tracking.frame();
      const result = await this._runBackendInference({
        current_state: this._statePayload(state),
        ref_curr: this._framePayload(frame),
        ref_next: this._framePayload(this._nextFrame()),
        cache_id: this.backendCacheId,
        reset_cache: this.backendCacheNeedsReset
      });
      this.backendCacheNeedsReset = false;
      if (Array.isArray(result.actions)) {
        this.lastActions = Float32Array.from(result.actions.slice(0, this.numActions));
      }
      const jointPositions = Array.isArray(result.joint_positions) && result.joint_positions.length >= this.numActions
        ? result.joint_positions.slice(0, this.numActions)
        : this._actionToJointTargets(result.actions ?? []);
      this.tracking.advance();
      return this._makeOutput(jointPositions, frame);
    } finally {
      this.isInferencing = false;
    }
  }
}

export async function createBrowserPolicy(manifest, host) {
  return new HumanoidGPTBrowserPolicy(manifest, host);
}
