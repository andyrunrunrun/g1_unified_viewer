import { HoloMotionBrowserPolicy } from '../holomotion/HoloMotionPolicy.js?g1_holomotion_base=v13';

export class HoloMotionV13BrowserPolicy extends HoloMotionBrowserPolicy {
  constructor(manifest, host) {
    super(manifest, host);
    this.backendCacheId = `holomotion-v13-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.backendCacheNeedsReset = true;
  }

  async load() {
    await this._loadConfig();
    this._resolveOnnxIo();
    this.reset();
    return this;
  }

  reset(state = null) {
    super.reset(state);
    this.backendCacheNeedsReset = true;
  }

  _resolveOnnxIo() {
    const meta = this.config?.onnx?.meta ?? {};
    const metaInputs = meta.in_keys ?? [];
    const metaOutputs = meta.out_keys ?? [];
    this.obsInputName = metaInputs.find((name) => name.includes('obs')) ?? metaInputs[0] ?? 'obs';
    this.kvInputName = metaInputs.find((name) => name.includes('past_key_values')) ?? null;
    this.stepInputName = metaInputs.find((name) => name.includes('step_idx') || name === 'current_pos') ?? null;
    this.actionOutputName = metaOutputs.find((name) => name.includes('actions')) ?? metaOutputs[0] ?? 'actions';
    this.kvOutputName = metaOutputs.find((name) => name.includes('present_key_values')) ?? null;
    if (this.kvInputName) {
      const shapeKey = meta.input_shapes?.[this.kvInputName] ? this.kvInputName : 'past_key_values';
      this.kvShape = meta.input_shapes?.[shapeKey]?.slice?.() ?? this.kvShape;
    }
  }

  async _runBackendInference(obs) {
    const response = await fetch('/api/holomotion-v13/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        obs: Array.from(obs),
        cache_id: this.backendCacheId,
        reset_cache: this.backendCacheNeedsReset,
        past_key_values: null,
        past_key_values_shape: this.kvInputName ? this.kvShape : null,
        step_idx: this.stepIndex
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HoloMotion v1.3 backend inference failed: ${response.status}${text ? ` ${text}` : ''}`);
    }
    const result = await response.json();
    this.backendCacheNeedsReset = false;
    return result;
  }

  async step(input = {}) {
    if (this.isInferencing) {
      return null;
    }
    this.isInferencing = true;
    try {
      const state = this._referenceToPolicyState(input.current_state ?? input.reference);
      this.tracking.anchorCurrentFrameToState(state);
      const obs = this._buildObservation(state);
      const result = await this._runBackendInference(obs);
      if (result.present_key_values) {
        this.kvCache = Float32Array.from(result.present_key_values);
        if (Array.isArray(result.present_key_values_shape) && result.present_key_values_shape.length) {
          this.kvShape = result.present_key_values_shape.slice();
        }
      }
      this.stepIndex += 1;
      const action = result.actions;
      if (!action || action.length < this.numActions) {
        throw new Error('HoloMotion v1.3 backend returned no valid action output.');
      }
      const jointPositions = this._actionToJointTargets(action);
      const frame = this.tracking.frame();
      this.tracking.advance();
      return this._makeOutput(jointPositions, frame);
    } finally {
      this.isInferencing = false;
    }
  }
}

export async function createBrowserPolicy(manifest, host) {
  return new HoloMotionV13BrowserPolicy(manifest, host);
}
