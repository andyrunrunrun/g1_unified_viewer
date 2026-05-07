import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BrowserOnnxPolicy,
  BrowserPolicyRuntime,
  DEFAULT_BROWSER_POLICY_MANIFESTS,
  MockPassthroughPolicy,
  browserRunnablePolicies,
  normalizeFrameCacheAsMotionClip
} from './policyRuntime.js';
import { TrackingHelper } from './trackingHelper.js';
import { quatToRot6d } from './utils/math.js';
import { createBrowserPolicy as createSonicBrowserPolicy } from '../../../policy_plugins/sonic/SonicPolicy.js';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

function roundZeros(value) {
  const rounded = Number(value.toFixed(6));
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

test('frontend declares onnxruntime-web for browser ONNX policy inference', () => {
  assert.equal(typeof packageJson.dependencies['onnxruntime-web'], 'string');
});

test('fallback browser policy manifests expose mock passthrough and motion tracking policies', () => {
  assert.ok(DEFAULT_BROWSER_POLICY_MANIFESTS.some((policy) => policy.policy_id === 'mock_passthrough'));
  const onnxPolicy = DEFAULT_BROWSER_POLICY_MANIFESTS.find((policy) => policy.policy_id === 'motion_tracking');

  assert.equal(onnxPolicy.framework, 'onnx');
  assert.equal(onnxPolicy.runtime, 'browser');
  assert.equal(onnxPolicy.format_id, 'motion_tracking');
  assert.equal(onnxPolicy.config_path, '/api/policy-plugins/motion_tracking/config');
  assert.equal(onnxPolicy.display_name_i18n.zh, '运动追踪');
});

test('browser policy manifest filter keeps only browser mock and ONNX policies', () => {
  const policies = browserRunnablePolicies([
    { policy_id: 'mock_passthrough', runtime: 'browser', framework: 'mock' },
    { policy_id: 'motion_tracking', runtime: 'browser', framework: 'onnx' },
    { policy_id: 'sonic', runtime: 'browser', framework: 'custom_js' },
    { policy_id: 'python_runner', runtime: 'python_subprocess', framework: 'python' },
    { policy_id: 'unsupported_browser', runtime: 'browser', framework: 'torchscript' }
  ]);

  assert.deepEqual(policies.map((policy) => policy.policy_id), ['mock_passthrough', 'motion_tracking', 'sonic']);
});

test('browser policy runtime activates custom JS policy plugins through the manifest module path', async () => {
  const originalImport = globalThis.__g1ImportBrowserPolicyModule;
  const calls = [];
  globalThis.__g1ImportBrowserPolicyModule = async (path) => {
    calls.push(path);
    return {
      async createBrowserPolicy(manifest, host) {
        assert.equal(manifest.policy_id, 'sonic');
        assert.equal(typeof host.loadPolicyConfig, 'function');
        assert.equal(typeof host.resolveStaticAssetPath, 'function');
        return {
          async load() {
            this.loaded = true;
            return this;
          },
          async step() {
            return {
              mode: 'joint_position_target',
              joint_names: ['joint_a'],
              joint_positions: [0.1]
            };
          },
          defaultStance() {
            return {
              mode: 'joint_position_target',
              joint_names: ['joint_a'],
              joint_positions: [0]
            };
          }
        };
      }
    };
  };

  try {
    const runtime = new BrowserPolicyRuntime();
    await runtime.activate({
      policy_id: 'sonic',
      runtime: 'browser',
      framework: 'custom_js',
      module_path: '/policy-plugins/sonic/SonicPolicy.js'
    });

    const output = await runtime.step({});

    assert.deepEqual(calls, ['/policy-plugins/sonic/SonicPolicy.js']);
    assert.equal(runtime.activePolicyId, 'sonic');
    assert.deepEqual(output.joint_positions, [0.1]);
    assert.deepEqual(runtime.defaultStance().joint_positions, [0]);
  } finally {
    if (originalImport === undefined) {
      delete globalThis.__g1ImportBrowserPolicyModule;
    } else {
      globalThis.__g1ImportBrowserPolicyModule = originalImport;
    }
  }
});

test('SONIC browser plugin is registered as a custom JS policy with local model assets', () => {
  const pluginDir = new URL('../../../policy_plugins/sonic/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('policy.json', pluginDir), 'utf-8'));
  const config = JSON.parse(readFileSync(new URL('sonic_policy.json', pluginDir), 'utf-8'));
  const moduleSource = readFileSync(new URL('SonicPolicy.js', pluginDir), 'utf-8');

  assert.equal(manifest.policy_id, 'sonic');
  assert.equal(manifest.runtime, 'browser');
  assert.equal(manifest.framework, 'custom_js');
  assert.equal(manifest.module_path, './SonicPolicy.js');
  assert.equal(manifest.config_path, '/policy-plugins/sonic/sonic_policy.json');
  assert.equal(manifest.format_id, 'sonic');
  assert.equal(config.control_dt, 0.02);
  assert.equal(config.onnx.encoder.path, './model_encoder.onnx');
  assert.equal(config.onnx.decoder.path, './model_decoder.onnx');
  assert.equal(config.onnx.planner.path, './planner_sonic.onnx');
  assert.equal(config.onnx.planner.enabled, false);
  assert.deepEqual(config.onnx.encoder.meta.in_shapes, [[1, 1762]]);
  assert.deepEqual(config.onnx.decoder.meta.in_shapes, [[1, 994]]);
  assert.equal(config.policy_joint_names.length, 29);
  assert.equal(config.default_joint_pos.length, 29);
  assert.equal(config.stiffness.length, 29);
  assert.equal(config.damping.length, 29);
  assert.equal(existsSync(new URL('model_encoder.onnx', pluginDir)), true);
  assert.equal(existsSync(new URL('model_decoder.onnx', pluginDir)), true);
  assert.match(moduleSource, /export async function createBrowserPolicy/);
  assert.match(moduleSource, /class SonicBrowserPolicy/);
});

test('SONIC encoder input keeps deployment observation offsets for g1 motion tokens', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    {
      math: {
        quatToRot6d,
        quatApplyInv() {
          return [0, 0, -1];
        }
      }
    }
  );
  const frames = Array.from({ length: 60 }, (_, frame) => ({
    joint_positions: Array.from({ length: 29 }, (_, joint) => 1000 + frame * 100 + joint),
    joint_velocities: Array.from({ length: 29 }, (_, joint) => 2000 + frame * 100 + joint),
    root_translation: [0, 0, 0.78],
    root_rotation_wxyz: [1, 0, 0, 0]
  }));

  assert.equal(policy.setMotionClip('active_clip', { frames }), true);
  assert.equal(policy.requestMotion('active_clip', null, { startFrame: 0, transitionSteps: 0 }), true);

  const input = policy._buildEncoderInput();

  assert.equal(input.length, 1762);
  assert.equal(input[0], 0);
  assert.equal(input[4], 1000);
  assert.equal(input[4 + 1], 1006);
  assert.equal(input[4 + 2], 1012);
  assert.equal(input[4 + 29], 1500);
  assert.equal(input[4 + 29 + 1], 1506);
  assert.equal(input[4 + 29 + 2], 1512);
  assert.equal(input[294], 2000);
  assert.equal(input[294 + 1], 2006);
  assert.equal(input[294 + 2], 2012);
  assert.equal(input[294 + 29], 2500);
  assert.equal(input[294 + 29 + 1], 2506);
  assert.equal(input[294 + 29 + 2], 2512);
  assert.deepEqual(Array.from(input.slice(584, 601)), new Array(17).fill(0));
  assert.deepEqual(Array.from(input.slice(601, 607)), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(Array.from(input.slice(661, 673)), new Array(12).fill(0));
  assert.deepEqual(Array.from(input.slice(793, 1762)), new Array(969).fill(0));
});

test('SONIC encoder anchor orientation uses deployment heading alignment', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    { math: { quatToRot6d } }
  );
  const yaw90 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const frames = Array.from({ length: 60 }, () => ({
    joint_positions: Array.from({ length: 29 }, () => 0),
    joint_velocities: Array.from({ length: 29 }, () => 0),
    root_translation: [0, 0, 0.78],
    root_rotation_wxyz: yaw90
  }));

  assert.equal(policy.setMotionClip('turning_clip', { frames }), true);
  assert.equal(policy.requestMotion('turning_clip', {
    joint_names: [],
    state: {
      root_rotation_wxyz: yaw90
    }
  }, { startFrame: 0, transitionSteps: 0 }), true);

  const input = policy._buildEncoderInput({ rootQuat: Float32Array.from(yaw90) });

  assert.deepEqual(Array.from(input.slice(601, 607)).map(roundZeros), [1, 0, 0, 1, 0, 0]);
});

test('SONIC reset realigns default heading state to the current base orientation', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    {
      math: {
        quatToRot6d,
        quatApplyInv() {
          return [0, 0, -1];
        }
      }
    }
  );
  const yaw90 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const frames = Array.from({ length: 60 }, () => ({
    joint_positions: Array.from({ length: 29 }, () => 0),
    joint_velocities: Array.from({ length: 29 }, () => 0),
    root_translation: [0, 0, 0.78],
    root_rotation_wxyz: yaw90
  }));

  assert.equal(policy.setMotionClip('turning_clip', { frames }), true);
  assert.equal(policy.requestMotion('turning_clip', {
    joint_names: [],
    state: { root_rotation_wxyz: yaw90 }
  }, { startFrame: 0, transitionSteps: 0 }), true);

  const resetState = {
    jointPos: new Float32Array(29),
    jointVel: new Float32Array(29),
    rootQuat: Float32Array.from(yaw90),
    rootAngVel: new Float32Array(3)
  };
  policy.reset(resetState);
  const input = policy._buildEncoderInput(resetState);

  assert.deepEqual(Array.from(input.slice(601, 607)).map(roundZeros), [1, 0, 0, 1, 0, 0]);
});

test('SONIC motion start transition interpolates targets instead of holding the first motion frame', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    { math: { quatToRot6d } }
  );
  policy.motionStep = 1;
  const frames = Array.from({ length: 4 }, (_, frame) => ({
    joint_positions: Array.from({ length: 29 }, () => 10 + frame),
    joint_velocities: Array.from({ length: 29 }, () => 20 + frame),
    root_translation: [10 + frame, 0, 0.78],
    root_rotation_wxyz: [1, 0, 0, 0]
  }));
  const currentState = {
    joint_names: [],
    state: {
      joint_positions: [],
      joint_velocities: [],
      root_translation: [0, 0, 0.78],
      root_rotation_wxyz: [1, 0, 0, 0]
    }
  };

  assert.equal(policy.setMotionClip('active_clip', { frames }), true);
  assert.equal(policy.requestMotion('active_clip', currentState, { startFrame: 0, transitionSteps: 3 }), true);

  assert.equal(policy.tracking.transitionLen, 3);
  assert.equal(policy.tracking.frameForStep(0).jointPos[0], 2.5);
  assert.equal(policy.tracking.frameForStep(1).jointPos[0], 5);
  assert.equal(policy.tracking.frameForStep(2).jointPos[0], 7.5);
  policy.tracking.advance();
  policy.tracking.advance();
  policy.tracking.advance();
  assert.equal(policy.tracking.frameForStep(0).jointPos[0], 10);
});

test('SONIC motion start transition honors requested start frame after interpolation', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    { math: { quatToRot6d } }
  );
  policy.motionStep = 1;
  const frames = Array.from({ length: 5 }, (_, frame) => ({
    joint_positions: Array.from({ length: 29 }, () => frame),
    joint_velocities: Array.from({ length: 29 }, () => frame),
    root_translation: [frame, 0, 0.78],
    root_rotation_wxyz: [1, 0, 0, 0]
  }));

  assert.equal(policy.setMotionClip('active_clip', { frames }), true);
  assert.equal(policy.requestMotion('active_clip', {
    joint_names: [],
    state: {
      joint_positions: [],
      joint_velocities: [],
      root_translation: [0, 0, 0.78],
      root_rotation_wxyz: [1, 0, 0, 0]
    }
  }, { startFrame: 2, transitionSteps: 2 }), true);

  assert.equal(Number(policy.tracking.frameForStep(0).jointPos[0].toFixed(6)), Number((2 / 3).toFixed(6)));
  policy.tracking.advance();
  assert.equal(Number(policy.tracking.frameForStep(0).jointPos[0].toFixed(6)), Number((4 / 3).toFixed(6)));
  policy.tracking.advance();
  assert.equal(policy.tracking.frameForStep(0).jointPos[0], 2);
});

test('SONIC tracking can re-anchor its current root pose to the live robot root', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    { math: { quatToRot6d } }
  );
  policy.motionStep = 1;
  const frames = Array.from({ length: 4 }, (_, frame) => ({
    joint_positions: Array.from({ length: 29 }, () => frame),
    joint_velocities: Array.from({ length: 29 }, () => 0),
    root_translation: [10 + frame, 20, 0.78 + frame * 0.01],
    root_rotation_wxyz: [1, 0, 0, 0]
  }));

  assert.equal(policy.setMotionClip('active_clip', { frames }), true);
  assert.equal(policy.requestMotion('active_clip', null, { startFrame: 0, transitionSteps: 0 }), true);
  policy.tracking.advance();
  assert.equal(policy.tracking.anchorCurrentFrameToState({
    rootPos: Float32Array.from([3, 4, 0.9]),
    rootQuat: Float32Array.from([1, 0, 0, 0])
  }), true);

  assert.deepEqual(Array.from(policy.tracking.frameForStep(0).rootPos).map((value) => Number(value.toFixed(6))), [3, 4, 0.79]);
  policy.tracking.advance();
  assert.deepEqual(Array.from(policy.tracking.frameForStep(0).rootPos).map((value) => Number(value.toFixed(6))), [4, 4, 0.8]);
});

test('SONIC step outputs the anchored tracking root pose', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    {
      ort: {
        Tensor: class {
          constructor(_type, data) {
            this.data = data;
          }
        }
      },
      math: {
        quatApplyInv() {
          return [0, 0, -1];
        }
      }
    }
  );
  policy.motionStep = 1;
  policy.encoderSession = {
    inputNames: ['encoder'],
    outputNames: ['token'],
    async run() {
      return { token: { data: new Float32Array(policy.tokenState.length) } };
    }
  };
  policy.decoderSession = {
    inputNames: ['decoder'],
    outputNames: ['action'],
    async run() {
      return { action: { data: new Float32Array(policy.numActions) } };
    }
  };
  const frames = Array.from({ length: 3 }, (_, frame) => ({
    joint_positions: Array.from({ length: 29 }, () => frame),
    joint_velocities: Array.from({ length: 29 }, () => 0),
    root_translation: [10 + frame, 20, 0.78 + frame * 0.01],
    root_rotation_wxyz: [1, 0, 0, 0]
  }));
  assert.equal(policy.setMotionClip('active_clip', { frames }), true);
  assert.equal(policy.requestMotion('active_clip', null, { startFrame: 0, transitionSteps: 0 }), true);

  const output = await policy.step({
    reference: {
      joint_names: [],
      state: {
        root_translation: [99, 99, 0.78],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: []
      }
    },
    current_state: {
      joint_names: [],
      state: {
        root_translation: [3, 4, 0.9],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [],
        joint_velocities: [],
        root_angular_velocity: [0, 0, 0]
      }
    }
  });

  assert.deepEqual(output.root_translation.map((value) => Number(value.toFixed(6))), [3, 4, 0.79]);
});

test('SONIC decoder proprioception remaps MuJoCo joint state into deployment policy order', async () => {
  const policy = await createSonicBrowserPolicy(
    { policy_id: 'sonic' },
    {
      math: {
        quatApplyInv() {
          return [0, 0, -1];
        }
      }
    }
  );
  policy.defaultJointPos = new Float32Array(29);
  policy.resetJointPos = new Float32Array(29);
  policy.resetRootTranslation = new Float32Array([0, 0, 0.78]);
  policy.reset();

  const input = policy._buildDecoderInput({
    jointPos: Float32Array.from(Array.from({ length: 29 }, (_, index) => index)),
    jointVel: Float32Array.from(Array.from({ length: 29 }, (_, index) => 100 + index)),
    rootQuat: new Float32Array([1, 0, 0, 0]),
    rootAngVel: new Float32Array([1, 2, 3])
  });

  const bodyQCurrent = 64 + 30 + 9 * 29;
  const bodyDqCurrent = 64 + 30 + 290 + 9 * 29;

  assert.equal(input[bodyQCurrent + 1], 6);
  assert.equal(input[bodyQCurrent + 2], 12);
  assert.equal(input[bodyDqCurrent + 1], 106);
  assert.equal(input[bodyDqCurrent + 2], 112);
});

test('bundled ONNX policy config keeps model assets relative to the policy plugin folder', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/motion_tracking/tracking_policy_latest.json', import.meta.url), 'utf-8'));

  assert.equal(config.onnx.path, './policy_latest.onnx');
  assert.equal(config.control_dt, 0.02);
  assert.doesNotMatch(config.onnx.path, /examples\/checkpoints/);
});

test('bundled twist2 policy model lives inside its format folder', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  const manifest = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/policy_format.json', import.meta.url), 'utf-8'));
  const pluginDir = new URL('../../../policy_plugins/twist2/', import.meta.url);
  const models = readdirSync(pluginDir)
    .filter((name) => name.endsWith('.onnx'))
    .sort();

  assert.equal(manifest.format_id, 'twist2');
  assert.equal(manifest.policy_id_prefix, 'twist2');
  assert.equal(config.onnx.path, undefined);
  assert.ok(models.length >= 2);
  for (const modelName of models) {
    const model = readFileSync(new URL(modelName, pluginDir));
    assert.ok(model.byteLength > 1024);
  }
});

test('twist2 observation implementation lives inside the twist2 policy plugin folder', () => {
  const sharedSource = readFileSync(new URL('./observationHelpers.js', import.meta.url), 'utf-8');
  const twist2Url = new URL('../../../policy_plugins/twist2/Twist2StudentFutureObs.js', import.meta.url);
  const oldFrontendUrl = new URL('./twist2/Twist2StudentFutureObs.js', import.meta.url);

  assert.match(sharedSource, /from '\.\.\/\.\.\/\.\.\/policy_plugins\/twist2\/Twist2StudentFutureObs\.js'/);
  assert.doesNotMatch(sharedSource, /class Twist2StudentFutureObs/);
  assert.ok(existsSync(twist2Url));
  assert.equal(existsSync(oldFrontendUrl), false);
  assert.match(readFileSync(twist2Url, 'utf-8'), /export class Twist2StudentFutureObs/);
});

function makeTrackingClip(jointNames, frames = 3) {
  const jointPos = [];
  const rootPos = [];
  const rootQuat = [];
  for (let frame = 0; frame < frames; frame += 1) {
    jointPos.push(jointNames.map((_, index) => 0.01 * frame + 0.001 * index));
    rootPos.push([0.02 * frame, 0, 0.78]);
    rootQuat.push([1, 0, 0, 0]);
  }
  return {
    joint_pos: jointPos,
    root_pos: rootPos,
    root_quat: rootQuat
  };
}

const TWIST2_MUJOCO_JOINT_ORDER = [
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

test('twist2 plugin uses the MuJoCo/TWIST2 DOF order for actions and tracking targets', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  const defaultByJoint = Object.fromEntries(config.policy_joint_names.map((name, index) => [name, config.default_joint_pos[index]]));

  assert.deepEqual(config.policy_joint_names, TWIST2_MUJOCO_JOINT_ORDER);
  assert.deepEqual(config.tracking.dataset_joint_names, TWIST2_MUJOCO_JOINT_ORDER);
  assert.equal(config.action_scale.length, TWIST2_MUJOCO_JOINT_ORDER.length);
  assert.equal(config.stiffness.length, TWIST2_MUJOCO_JOINT_ORDER.length);
  assert.equal(config.damping.length, TWIST2_MUJOCO_JOINT_ORDER.length);
  assert.equal(config.default_joint_pos.length, TWIST2_MUJOCO_JOINT_ORDER.length);
  assert.equal(defaultByJoint.left_knee_joint, 0.4);
  assert.equal(defaultByJoint.right_knee_joint, 0.4);
  assert.equal(defaultByJoint.left_shoulder_roll_joint, 0.4);
  assert.equal(defaultByJoint.right_shoulder_roll_joint, -0.4);
  assert.equal(defaultByJoint.left_elbow_joint, 1.2);
  assert.equal(defaultByJoint.right_elbow_joint, 1.2);
});

test('twist2 plugin uses 50 Hz control timing, gains, and torque limits', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));

  assert.equal(config.normalization_clip_actions, 5.0);
  assert.equal(config.action_clip, 10.0);
  assert.equal(config.control_dt, 0.02);
  assert.equal(config.obs_config.policy[0].policy_dt, 0.02);
  assert.deepEqual(config.torque_limits, [
    100, 100, 100, 150, 40, 40,
    100, 100, 100, 150, 40, 40,
    150, 150, 150,
    40, 40, 40, 40, 4, 4, 4,
    40, 40, 40, 40, 4, 4, 4
  ]);
  assert.deepEqual(config.stiffness.slice(19, 22), [4, 4, 4]);
  assert.deepEqual(config.stiffness.slice(26, 29), [4, 4, 4]);
  assert.deepEqual(config.damping.slice(19, 22), [0.2, 0.2, 0.2]);
  assert.deepEqual(config.damping.slice(26, 29), [0.2, 0.2, 0.2]);
  assert.equal(config.obs_config.policy[0].angular_velocity_frame, 'world');
  assert.deepEqual(config.physics_options, {
    timestep: 0.002,
    solver: 'PGS',
    geom_friction: {
      floor: [1.6, 0.005, 0.0001]
    }
  });
});

test('twist2 plugin separates policy default posture from MuJoCo reset posture', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));

  assert.deepEqual(config.reset_root_translation, [0, 0, 0.793]);
  assert.equal(config.default_joint_pos[16], 0.4);
  assert.equal(config.default_joint_pos[23], -0.4);
  assert.equal(config.reset_joint_pos[16], 0.2);
  assert.equal(config.reset_joint_pos[23], -0.2);
  assert.equal(config.reset_joint_pos.length, TWIST2_MUJOCO_JOINT_ORDER.length);
});

test('twist2 plugin builds the student-future ONNX observation shape expected by its model', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  assert.deepEqual(config.onnx.meta.in_shapes, [[[1, 1432]]]);
  assert.deepEqual(config.onnx.meta.out_keys, ['action']);

  const policy = new BrowserOnnxPolicy({ policy_id: 'twist2_1017_25k' });
  policy.config = config;
  policy.policyJointNames = config.policy_joint_names.slice();
  policy.numActions = policy.policyJointNames.length;
  policy.defaultJointPos = new Float32Array(config.default_joint_pos);
  policy.actionScale = new Float32Array(config.action_scale);
  policy.stiffness = new Float32Array(config.stiffness);
  policy.damping = new Float32Array(config.damping);
  policy.torqueLimits = new Float32Array(config.torque_limits);
  policy.lastActions = new Float32Array(policy.numActions);
  policy.tracking = new TrackingHelper({
    ...config.tracking,
    policy_joint_names: policy.policyJointNames,
    transition_steps: 0,
    motions: {
      default: makeTrackingClip(config.tracking.dataset_joint_names, 4)
    }
  });
  policy.obsModules = policy._buildObsModules(config.obs_config);
  policy.numObs = policy.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);
  policy.reset();

  const observation = policy._buildObservation({
    jointPos: new Float32Array(policy.numActions),
    jointVel: new Float32Array(policy.numActions),
    rootPos: new Float32Array([0, 0, 0.78]),
    rootQuat: new Float32Array([1, 0, 0, 0]),
    rootAngVel: new Float32Array([0, 0, 0])
  });

  assert.equal(policy.numObs, 1432);
  assert.equal(observation.length, 1432);
});

test('twist2 student-future observation masks ankle velocity proprioception like TWIST2 training', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  const policy = new BrowserOnnxPolicy({ policy_id: 'twist2_1017_25k' });
  policy.config = config;
  policy.policyJointNames = config.policy_joint_names.slice();
  policy.numActions = policy.policyJointNames.length;
  policy.defaultJointPos = new Float32Array(config.default_joint_pos);
  policy.actionScale = new Float32Array(config.action_scale);
  policy.stiffness = new Float32Array(config.stiffness);
  policy.damping = new Float32Array(config.damping);
  policy.torqueLimits = new Float32Array(config.torque_limits);
  policy.lastActions = new Float32Array(policy.numActions);
  policy.tracking = new TrackingHelper({
    ...config.tracking,
    policy_joint_names: policy.policyJointNames
  });
  policy.obsModules = policy._buildObsModules(config.obs_config);
  policy.numObs = policy.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);
  policy.reset();

  const observation = policy._buildObservation({
    jointPos: new Float32Array(config.default_joint_pos),
    jointVel: Float32Array.from(config.policy_joint_names.map((_, index) => 10 + index)),
    rootPos: new Float32Array([0, 0, 0.78]),
    rootQuat: new Float32Array([1, 0, 0, 0]),
    rootAngVel: new Float32Array([0, 0, 0])
  });

  const dofVelStart = 35 + 3 + 2 + config.policy_joint_names.length;
  const ankleIndices = [4, 5, 10, 11];
  for (const index of ankleIndices) {
    assert.equal(observation[dofVelStart + index], 0);
  }
  assert.equal(Number(observation[dofVelStart].toFixed(6)), 0.5);
  assert.equal(Number(observation[dofVelStart + 3].toFixed(6)), 0.65);
  assert.equal(Number(observation[dofVelStart + 6].toFixed(6)), 0.8);
});

test('twist2 student-future observation can use MuJoCo world-frame angular velocity for sim2sim parity', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  const policy = new BrowserOnnxPolicy({ policy_id: 'twist2_1017_25k' });
  policy.config = config;
  policy.policyJointNames = config.policy_joint_names.slice();
  policy.numActions = policy.policyJointNames.length;
  policy.defaultJointPos = new Float32Array(config.default_joint_pos);
  policy.actionScale = new Float32Array(config.action_scale);
  policy.stiffness = new Float32Array(config.stiffness);
  policy.damping = new Float32Array(config.damping);
  policy.torqueLimits = new Float32Array(config.torque_limits);
  policy.lastActions = new Float32Array(policy.numActions);
  policy.tracking = new TrackingHelper({
    ...config.tracking,
    policy_joint_names: policy.policyJointNames
  });
  policy.obsModules = policy._buildObsModules(config.obs_config);
  policy.numObs = policy.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);
  policy.reset();

  const yaw90 = Math.sqrt(0.5);
  const observation = policy._buildObservation({
    jointPos: new Float32Array(config.default_joint_pos),
    jointVel: new Float32Array(policy.numActions),
    rootPos: new Float32Array([0, 0, 0.78]),
    rootQuat: new Float32Array([yaw90, 0, 0, yaw90]),
    rootAngVel: new Float32Array([1, 0, 0])
  });

  assert.equal(config.obs_config.policy[0].angular_velocity_frame, 'world');
  assert.equal(Number(observation[35].toFixed(6)), 0.25);
  assert.equal(Number(observation[36].toFixed(6)), 0);
  assert.equal(Number(observation[37].toFixed(6)), 0);
});

test('twist2 student-future history reset starts with zero history like TWIST2 sim deployment', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  const policy = new BrowserOnnxPolicy({ policy_id: 'twist2_1017_25k' });
  policy.config = config;
  policy.policyJointNames = config.policy_joint_names.slice();
  policy.numActions = policy.policyJointNames.length;
  policy.defaultJointPos = new Float32Array(config.default_joint_pos);
  policy.actionScale = new Float32Array(config.action_scale);
  policy.stiffness = new Float32Array(config.stiffness);
  policy.damping = new Float32Array(config.damping);
  policy.torqueLimits = new Float32Array(config.torque_limits);
  policy.lastActions = new Float32Array(policy.numActions);
  policy.tracking = new TrackingHelper({
    ...config.tracking,
    policy_joint_names: policy.policyJointNames
  });
  policy.obsModules = policy._buildObsModules(config.obs_config);
  policy.numObs = policy.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);

  policy.reset({
    jointPos: Float32Array.from(config.default_joint_pos.map((value) => value + 0.5)),
    jointVel: Float32Array.from(config.policy_joint_names.map((_, index) => index + 1)),
    rootPos: new Float32Array([0, 0, 0.793]),
    rootQuat: new Float32Array([1, 0, 0, 0]),
    rootAngVel: new Float32Array([1, 2, 3])
  });

  const observation = policy._buildObservation({
    jointPos: new Float32Array(config.default_joint_pos),
    jointVel: new Float32Array(policy.numActions),
    rootPos: new Float32Array([0, 0, 0.793]),
    rootQuat: new Float32Array([1, 0, 0, 0]),
    rootAngVel: new Float32Array([0, 0, 0])
  });

  assert.equal(config.obs_config.policy[0].history_reset, 'zeros');
  assert.deepEqual(Array.from(observation.slice(127, 127 + 127)), new Array(127).fill(0));
});

test('twist2 target smoothing keeps current and future target slots independent', () => {
  const config = JSON.parse(readFileSync(new URL('../../../policy_plugins/twist2/tracking_policy_latest.json', import.meta.url), 'utf-8'));
  const policy = new BrowserOnnxPolicy({ policy_id: 'twist2_1017_25k' });
  policy.config = config;
  policy.policyJointNames = config.policy_joint_names.slice();
  policy.numActions = policy.policyJointNames.length;
  policy.defaultJointPos = new Float32Array(config.default_joint_pos);
  policy.actionScale = new Float32Array(config.action_scale);
  policy.stiffness = new Float32Array(config.stiffness);
  policy.damping = new Float32Array(config.damping);
  policy.torqueLimits = new Float32Array(config.torque_limits);
  policy.lastActions = new Float32Array(policy.numActions);
  policy.tracking = new TrackingHelper({
    ...config.tracking,
    policy_joint_names: policy.policyJointNames,
    transition_steps: 0,
    motions: {
      default: makeTrackingClip(config.tracking.dataset_joint_names, 4)
    }
  });
  policy.obsModules = policy._buildObsModules(config.obs_config);
  policy.numObs = policy.obsModules.reduce((sum, obs) => sum + (obs.size ?? 0), 0);
  policy.reset();
  policy.configureTargetSmoothing({ enabled: true, alpha: 0.5 });

  policy._buildObservation({
    jointPos: new Float32Array(policy.numActions),
    jointVel: new Float32Array(policy.numActions),
    rootPos: new Float32Array([0, 0, 0.78]),
    rootQuat: new Float32Array([1, 0, 0, 0]),
    rootAngVel: new Float32Array([0, 0, 0])
  });

  assert.ok(policy.targetSmoothing.values.has('Twist2StudentFutureObs:motion:0'));
  assert.ok(policy.targetSmoothing.values.has('Twist2StudentFutureObs:future:0'));
  assert.notEqual(
    policy.targetSmoothing.values.get('Twist2StudentFutureObs:motion:0'),
    policy.targetSmoothing.values.get('Twist2StudentFutureObs:future:0')
  );
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
    assert.equal(output.control_dt, 0.02);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ONNX policy default stance uses configured MuJoCo reset posture and control dt', () => {
  const policy = Object.create(BrowserOnnxPolicy.prototype);
  Object.assign(policy, {
    policyJointNames: ['left_shoulder_roll_joint', 'right_shoulder_roll_joint'],
    defaultJointPos: new Float32Array([0.4, -0.4]),
    resetJointPos: new Float32Array([0.2, -0.2]),
    resetRootTranslation: new Float32Array([0, 0, 0.793]),
    stiffness: new Float32Array([4, 4]),
    damping: new Float32Array([0.2, 0.2]),
    torqueLimits: new Float32Array([4, 4]),
    controlDt: 0.01
  });

  const output = BrowserOnnxPolicy.prototype.defaultStance.call(policy);

  assert.deepEqual(output.joint_positions, [0.2, -0.2]);
  assert.deepEqual(output.root_translation, [0, 0, 0.793]);
  assert.equal(output.control_dt, 0.01);
});

test('ONNX policy outputs per-policy MuJoCo physics options without making them global', async () => {
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
    resetJointPos: new Float32Array([0]),
    resetRootTranslation: new Float32Array([0, 0, 0.78]),
    actionScale: new Float32Array([1]),
    stiffness: new Float32Array([40]),
    damping: new Float32Array([2]),
    torqueLimits: new Float32Array([100]),
    controlDt: 0.01,
    physicsOptions: {
      timestep: 0.001,
      solver: 'PGS',
      geom_friction: { floor: [1.6, 0.005, 0.0001] }
    },
    actionClip: 10,
    lastActions: new Float32Array([0]),
    isInferencing: false,
    _buildInputs() {
      return {};
    },
    _readOutput() {
      return new Float32Array([0.25]);
    }
  });

  const output = await BrowserOnnxPolicy.prototype.step.call(policy, {
    reference: {
      joint_names: ['joint_a'],
      state: {
        root_translation: [0, 0, 0.78],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0]
      }
    }
  });
  const defaultStance = BrowserOnnxPolicy.prototype.defaultStance.call(policy);

  assert.deepEqual(output.physics_options, policy.physicsOptions);
  assert.deepEqual(defaultStance.physics_options, policy.physicsOptions);
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

test('tracking helper can override transition length for external active clips', () => {
  const helper = new TrackingHelper({
    transition_steps: 100,
    dataset_joint_names: ['joint_a'],
    policy_joint_names: ['joint_a'],
    motions: {
      default: {
        joint_pos: [[0]],
        root_pos: [[0, 0, 0.78]],
        root_quat: [[1, 0, 0, 0]]
      },
      active_clip: {
        joint_pos: [[0], [1], [2]],
        root_pos: [[0, 0, 0.78], [1, 0, 0.78], [2, 0, 0.78]],
        root_quat: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]]
      }
    }
  });

  assert.equal(helper.requestMotion('active_clip', null, { transitionSteps: 0 }), true);
  assert.equal(helper.transitionLen, 0);
  assert.equal(helper.refLen, 3);
  assert.equal(helper.motionLen, 3);
});

test('browser policy runtime exposes tracking state for completion timing', () => {
  const runtime = new BrowserPolicyRuntime();
  runtime.activePolicy = {
    tracking: {
      playbackState() {
        return {
          available: true,
          currentName: 'active_clip',
          currentDone: true,
          refIdx: 3,
          refLen: 4,
          transitionLen: 0,
          motionLen: 4,
          inTransition: false,
          isDefault: false
        };
      }
    }
  };

  assert.equal(runtime.trackingState().currentName, 'active_clip');
  assert.equal(runtime.trackingState().currentDone, true);
});

test('browser policy runtime exposes the current tracking target as policy joint payload', () => {
  const runtime = new BrowserPolicyRuntime();
  runtime.activePolicy = {
    tracking: {
      playbackState() {
        return {
          available: true,
          currentName: 'active_clip',
          currentDone: false,
          refIdx: 1,
          refLen: 3,
          transitionLen: 0,
          motionLen: 3,
          inTransition: false,
          isDefault: false
        };
      },
      getFrame(index) {
        assert.equal(index, 1);
        return {
          jointPos: Float32Array.from([0.2, -0.1]),
          rootPos: Float32Array.from([3, 4, 0.82]),
          rootQuat: Float32Array.from([1, 0, 0, 0])
        };
      }
    },
    policyJointNames: ['joint_a', 'joint_b']
  };

  const payload = runtime.currentTrackingReferencePayload({
    body_names: ['pelvis']
  });

  assert.deepEqual(payload.joint_names, ['joint_a', 'joint_b']);
  assert.deepEqual(payload.body_names, ['pelvis']);
  assert.deepEqual(payload.state.joint_positions, [0.2, -0.1]);
  assert.deepEqual(payload.state.root_translation, [3, 4, 0.82]);
  assert.deepEqual(payload.state.root_rotation_wxyz, [1, 0, 0, 0]);
  assert.equal(payload.frame_index, 1);
});

test('browser policy runtime re-anchors tracking root heading without copying live roll or pitch', () => {
  const roll45 = [0.9238795325, 0.3826834324, 0, 0];
  const pitch30 = [0.9659258263, 0, 0.2588190451, 0];
  const helper = new TrackingHelper({
    dataset_joint_names: ['joint_a'],
    policy_joint_names: ['joint_a'],
    transition_steps: 0,
    motions: {
      default: {
        joint_pos: [[0]],
        root_pos: [[0, 0, 0.78]],
        root_quat: [[1, 0, 0, 0]]
      },
      active_clip: {
        joint_pos: [[0], [1], [2]],
        root_pos: [[10, 20, 0.78], [11, 20, 0.8], [12, 20, 0.82]],
        root_quat: [[1, 0, 0, 0], roll45, roll45]
      }
    }
  });
  assert.equal(helper.requestMotion('active_clip', null, { transitionSteps: 0 }), true);
  helper.advance();

  helper.anchorCurrentFrameToState({
    rootPos: Float32Array.from([3, 4, 0.91]),
    rootQuat: Float32Array.from(pitch30)
  });

  assert.deepEqual(Array.from(helper.refRootPos[1]).map((value) => Number(value.toFixed(6))), [3, 4, 0.8]);
  assert.deepEqual(Array.from(helper.refRootPos[2]).map((value) => Number(value.toFixed(6))), [4, 4, 0.82]);
  assert.deepEqual(Array.from(helper.refRootQuat[1]).map((value) => roundZeros(value)), roll45.map((value) => roundZeros(value)));
});

test('ONNX policy can EMA smooth target observation vectors with configurable alpha', () => {
  const policy = new BrowserOnnxPolicy({ policy_id: 'twist2_1017_25k' });

  policy.configureTargetSmoothing({ enabled: true, alpha: 0.25 });

  assert.deepEqual(
    Array.from(policy.smoothTargetVector('body', Float32Array.from([0, 10]))),
    [0, 10]
  );
  assert.deepEqual(
    Array.from(policy.smoothTargetVector('body', Float32Array.from([8, 2]))).map((value) => Number(value.toFixed(6))),
    [2, 8]
  );
  assert.deepEqual(
    Array.from(policy.smoothTargetVector('future', Float32Array.from([4]))),
    [4]
  );

  policy.configureTargetSmoothing({ enabled: false, alpha: 0.25 });
  assert.deepEqual(
    Array.from(policy.smoothTargetVector('body', Float32Array.from([9, 9]))),
    [9, 9]
  );

  policy.configureTargetSmoothing({ enabled: true, alpha: 0.5 });
  assert.deepEqual(
    Array.from(policy.smoothTargetVector('body', Float32Array.from([6, 6]))),
    [6, 6]
  );
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

test('ONNX tracking anchors the actual policy reference frame to the live robot root', async () => {
  let capturedTrackingRoot = null;
  const policy = Object.create(BrowserOnnxPolicy.prototype);
  Object.assign(policy, {
    session: {
      inputNames: ['input'],
      async run() {
        return {};
      }
    },
    config: { onnx: { meta: { in_keys: ['policy'] } } },
    policyJointNames: ['joint_a'],
    defaultJointPos: new Float32Array([0]),
    actionScale: new Float32Array([1]),
    stiffness: new Float32Array([40]),
    damping: new Float32Array([2]),
    actionClip: 10,
    lastActions: new Float32Array([0]),
    isInferencing: false,
    inputState: {},
    obsModules: [{
      size: 1,
      update() {},
      compute() {
        capturedTrackingRoot = Array.from(policy.tracking.refRootPos[policy.tracking.refIdx]);
        return new Float32Array([0]);
      }
    }],
    numObs: 1,
    _readOutput() {
      return new Float32Array([0]);
    }
  });
  policy.tracking = new TrackingHelper({
    dataset_joint_names: ['joint_a'],
    policy_joint_names: ['joint_a'],
    transition_steps: 0,
    motions: {
      default: {
        joint_pos: [[0]],
        root_pos: [[0, 0, 0.78]],
        root_quat: [[1, 0, 0, 0]]
      },
      active_clip: {
        joint_pos: [[0], [1]],
        root_pos: [[10, 20, 0.78], [11, 20, 0.8]],
        root_quat: [[1, 0, 0, 0], [1, 0, 0, 0]]
      }
    }
  });
  assert.equal(policy.tracking.requestMotion('active_clip', null, { transitionSteps: 0 }), true);

  const output = await BrowserOnnxPolicy.prototype.step.call(policy, {
    reference: {
      joint_names: ['joint_a'],
      state: {
        root_translation: [99, 99, 0.78],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0]
      }
    },
    current_state: {
      joint_names: ['joint_a'],
      state: {
        joint_positions: [0],
        joint_velocities: [0],
        root_translation: [3, 4, 0.91],
        root_rotation_wxyz: [1, 0, 0, 0],
        root_angular_velocity: [0, 0, 0]
      }
    }
  });

  assert.deepEqual(capturedTrackingRoot.map((value) => Number(value.toFixed(6))), [3, 4, 0.8]);
  assert.deepEqual(output.root_translation, [3, 4, 0.8]);
});

test('ONNX policy clips position targets with TWIST2 raw action limits but preserves raw action history', async () => {
  const policy = Object.create(BrowserOnnxPolicy.prototype);
  Object.assign(policy, {
    session: {
      async run() {
        return {};
      }
    },
    config: {},
    policyJointNames: ['joint_a', 'joint_b'],
    defaultJointPos: new Float32Array([0.1, -0.1]),
    actionScale: new Float32Array([0.5, 0.5]),
    stiffness: new Float32Array([40, 50]),
    damping: new Float32Array([2, 3]),
    torqueLimits: new Float32Array([12, 13]),
    controlDt: 0.01,
    actionClip: 10,
    lastActions: new Float32Array([0, 0]),
    isInferencing: false,
    _buildInputs() {
      return {};
    },
    _readOutput() {
      return new Float32Array([12, -12]);
    }
  });

  const output = await BrowserOnnxPolicy.prototype.step.call(policy, {
    reference: {
      joint_names: ['joint_a', 'joint_b'],
      state: {
        root_translation: [0, 0, 0.78],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0, 0]
      }
    }
  });

  assert.deepEqual(output.joint_positions.map((value) => Number(value.toFixed(6))), [5.1, -5.1]);
  assert.deepEqual(output.torque_limits, [12, 13]);
  assert.equal(output.control_dt, 0.01);
  assert.deepEqual(Array.from(policy.lastActions), [12, -12]);
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
  const manifest = DEFAULT_BROWSER_POLICY_MANIFESTS.find((policy) => policy.policy_id === 'mock_passthrough');

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
