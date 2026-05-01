import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BROWSER_POLICY_MANIFESTS,
  BrowserOnnxPolicy,
  BrowserPolicyRuntime,
  MockPassthroughPolicy,
  normalizeFrameCacheAsMotionClip
} from './policyRuntime.js';
import { TrackingHelper } from './trackingHelper.js';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

test('frontend declares onnxruntime-web for browser ONNX policy inference', () => {
  assert.equal(typeof packageJson.dependencies['onnxruntime-web'], 'string');
});

test('browser policy manifests expose mock passthrough and ONNX tracking policies', () => {
  assert.ok(BROWSER_POLICY_MANIFESTS.some((policy) => policy.policy_id === 'mock_passthrough'));
  const onnxPolicy = BROWSER_POLICY_MANIFESTS.find((policy) => policy.policy_id === 'g1_tracking_onnx');

  assert.equal(onnxPolicy.framework, 'onnx');
  assert.equal(onnxPolicy.config_path, '/examples/checkpoints/g1/tracking_policy_latest.json');
});

test('mock passthrough policy returns the reference whole-body target unchanged', async () => {
  const policy = new MockPassthroughPolicy();
  await policy.load();

  const output = await policy.step({
    reference: {
      joint_names: ['left_hip_pitch_joint', 'right_hip_pitch_joint'],
      state: {
        root_translation: [1, 2, 0.8],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0.1, -0.2]
      }
    }
  });

  assert.equal(output.mode, 'joint_position_target');
  assert.deepEqual(output.joint_names, ['left_hip_pitch_joint', 'right_hip_pitch_joint']);
  assert.deepEqual(output.joint_positions, [0.1, -0.2]);
  assert.deepEqual(output.root_translation, [1, 2, 0.8]);
  assert.deepEqual(output.root_rotation_wxyz, [1, 0, 0, 0]);
});

test('mock passthrough policy can forward PD gains for browser physics control', async () => {
  const policy = new MockPassthroughPolicy();
  await policy.load();

  const output = await policy.step({
    reference: {
      joint_names: ['joint_a', 'joint_b'],
      state: {
        joint_positions: [0.1, -0.2],
        stiffness: [40, 20],
        damping: [2, 1]
      }
    }
  });

  assert.deepEqual(output.kp, [40, 20]);
  assert.deepEqual(output.kd, [2, 1]);
});

test('mock passthrough policy loads G1 config defaults for browser physics stance', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    assert.equal(path, '/examples/checkpoints/g1/tracking_policy_latest.json');
    return {
      ok: true,
      async json() {
        return {
          policy_joint_names: ['joint_a', 'joint_b'],
          default_joint_pos: [0.15, -0.25],
          stiffness: [40, 20],
          damping: [2, 1]
        };
      }
    };
  };

  try {
    const policy = new MockPassthroughPolicy({
      policy_id: 'mock_passthrough',
      framework: 'mock',
      config_path: '/examples/checkpoints/g1/tracking_policy_latest.json'
    });
    await policy.load();
    const output = policy.defaultStance();

    assert.equal(output.mode, 'joint_position_target');
    assert.deepEqual(output.joint_names, ['joint_a', 'joint_b']);
    assert.deepEqual(output.joint_positions, [0.15, -0.25]);
    assert.deepEqual(output.kp, [40, 20]);
    assert.deepEqual(output.kd, [2, 1]);
    assert.deepEqual(output.root_translation, [0, 0, 0.78]);
    assert.deepEqual(output.root_rotation_wxyz, [1, 0, 0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser policy runtime exposes default stance from the active policy', async () => {
  const runtime = new BrowserPolicyRuntime();
  await runtime.activate({
    policy_id: 'mock_passthrough',
    framework: 'mock'
  });
  runtime.activePolicy.defaultStance = () => ({
    mode: 'joint_position_target',
    joint_names: ['joint_a'],
    joint_positions: [0.2],
    kp: [30],
    kd: [1.5],
    root_translation: [0, 0, 0.78],
    root_rotation_wxyz: [1, 0, 0, 0]
  });

  const output = runtime.defaultStance();

  assert.deepEqual(output.joint_positions, [0.2]);
  assert.equal(runtime.status().last_policy_result.joint_count, 1);
}
);

test('browser policy runtime can switch tracking motions for ONNX policies', () => {
  const runtime = new BrowserPolicyRuntime();
  const calls = [];
  runtime.activePolicy = {
    setMotionClip(name, frameCache) {
      calls.push(['set', name, frameCache.sequenceId]);
      return true;
    },
    requestMotion(name, state) {
      calls.push(['request', name, state?.state?.root_translation?.[2]]);
      return true;
    }
  };

  assert.equal(runtime.setMotionClip('active_clip', { sequenceId: 'seq1', frames: [] }), true);
  assert.equal(runtime.requestMotion('active_clip', { state: { root_translation: [0, 0, 0.7] } }), true);

  assert.deepEqual(calls, [
    ['set', 'active_clip', 'seq1'],
    ['request', 'active_clip', 0.7]
  ]);
});

test('ONNX policy outputs config PD gains in policy joint order', () => {
  const source = readFileSync(new URL('./policyRuntime.js', import.meta.url), 'utf-8');

  assert.match(source, /this\.stiffness = toFloatArray\(this\.config\.stiffness/);
  assert.match(source, /this\.damping = toFloatArray\(this\.config\.damping/);
  assert.match(source, /kp: cloneArray\(this\.stiffness\)/);
  assert.match(source, /kd: cloneArray\(this\.damping\)/);
  assert.match(source, /defaultStance\(\)/);
  assert.match(source, /setMotionClip\(name, frameCache\)/);
  assert.match(source, /requestMotion\(name, statePayload, options = \{\}\)/);
});

test('ONNX policy owns tracking motion registration and request methods', () => {
  assert.equal(typeof BrowserOnnxPolicy.prototype.setMotionClip, 'function');
  assert.equal(typeof BrowserOnnxPolicy.prototype.requestMotion, 'function');

  assert.equal(MockPassthroughPolicy.prototype.setMotionClip.call({}, 'active_clip', { frames: [] }), true);
  assert.equal(MockPassthroughPolicy.prototype.requestMotion.call({}), true);
});

test('tracking helper can restart the active clip from a requested frame', () => {
  const helper = new TrackingHelper({
    transition_steps: 0,
    dataset_joint_names: ['joint_a'],
    policy_joint_names: ['joint_a'],
    motions: {
      default: {
        joint_pos: [[0]],
        root_pos: [[0, 0, 0.78]],
        root_quat: [[1, 0, 0, 0]]
      },
      active_clip: {
        joint_pos: [[0], [1], [2], [3]],
        root_pos: [[0, 0, 0.78], [1, 0, 0.78], [2, 0, 0.78], [3, 0, 0.78]],
        root_quat: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]]
      }
    }
  });

  assert.equal(helper.requestMotion('active_clip', null, { startFrame: 2 }), true);
  assert.equal(helper.currentName, 'active_clip');
  assert.equal(helper.motionLen, 2);
  assert.equal(helper.refJointPos[0][0], 2);
  assert.equal(helper.refRootPos[0][0], 0);

  assert.equal(helper.requestMotion('active_clip', null, { startFrame: 3 }), true);
  assert.equal(helper.motionLen, 1);
  assert.equal(helper.refJointPos[0][0], 3);
});

test('ONNX policy observes current MuJoCo state instead of the target reference', async () => {
  let capturedState = null;
  const policy = Object.create(BrowserOnnxPolicy.prototype);
  Object.assign(policy, {
    session: {
      async run() {
        return {};
      }
    },
    config: {},
    policyJointNames: ['joint_a'],
    defaultJointPos: new Float32Array([0]),
    actionScale: new Float32Array([1]),
    stiffness: new Float32Array([40]),
    damping: new Float32Array([2]),
    actionClip: 10,
    lastActions: new Float32Array([0]),
    isInferencing: false,
    _buildInputs(state) {
      capturedState = state;
      return {};
    },
    _readOutput() {
      return new Float32Array([0.25]);
    }
  });

  await BrowserOnnxPolicy.prototype.step.call(policy, {
    reference: {
      joint_names: ['joint_a'],
      state: {
        joint_positions: [9],
        root_translation: [9, 9, 9],
        root_rotation_wxyz: [0, 1, 0, 0]
      }
    },
    current_state: {
      joint_names: ['joint_a'],
      state: {
        joint_positions: [0.4],
        joint_velocities: [0.5],
        root_translation: [1, 2, 3],
        root_rotation_wxyz: [1, 0, 0, 0],
        root_angular_velocity: [0.1, 0.2, 0.3]
      }
    }
  });

  assert.equal(Number(capturedState.jointPos[0].toFixed(6)), 0.4);
  assert.equal(Number(capturedState.jointVel[0].toFixed(6)), 0.5);
  assert.deepEqual(Array.from(capturedState.rootPos), [1, 2, 3]);
  assert.deepEqual(Array.from(capturedState.rootAngVel).map((value) => Number(value.toFixed(6))), [0.1, 0.2, 0.3]);
});

test('frame cache is normalized into humanoid-policy-viewer motion clip shape', () => {
  const clip = normalizeFrameCacheAsMotionClip({
    frames: [
      {
        root_translation: [0, 0, 0.8],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0.1, 0.2]
      },
      {
        root_translation: [1, 0, 0.8],
        root_rotation_wxyz: [0, 0, 0, 1],
        joint_positions: [0.3, 0.4]
      }
    ]
  });

  assert.deepEqual(clip.root_pos, [[0, 0, 0.8], [1, 0, 0.8]]);
  assert.deepEqual(clip.root_quat, [[1, 0, 0, 0], [0, 0, 0, 1]]);
  assert.deepEqual(clip.joint_pos, [[0.1, 0.2], [0.3, 0.4]]);
});

test('browser policy runtime activates and steps mock policy locally', async () => {
  const runtime = new BrowserPolicyRuntime();
  const manifest = BROWSER_POLICY_MANIFESTS.find((policy) => policy.policy_id === 'mock_passthrough');

  await runtime.activate(manifest);
  const output = await runtime.step({
    reference: {
      joint_names: ['joint_a'],
      state: {
        root_translation: [0, 0, 0.8],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0.42]
      }
    }
  });

  assert.equal(runtime.activePolicyId, 'mock_passthrough');
  assert.deepEqual(output.joint_positions, [0.42]);
});
