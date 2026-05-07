import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';

import {
  BrowserMujocoViewer,
  createMaterialResources,
  hasBodyPositionTrack,
  makePlaneMesh,
  RENDERER_OPTIONS,
  VIEWER_SHADOWS_ENABLED,
  VIEWER_PIXEL_RATIO_LIMIT
} from './browserMujocoViewer.js';

const viewerSource = readFileSync(new URL('./browserMujocoViewer.js', import.meta.url), 'utf-8');
const g1SceneSource = readFileSync(new URL('../../public/examples/scenes/g1/g1.xml', import.meta.url), 'utf-8');

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} should be close to ${expected}`);
}

function makeTexturedModel() {
  const matTexId = new Int32Array(10).fill(-1);
  matTexId[1] = 0;

  return {
    geom_rgba: new Float32Array([0.1, 0.2, 0.3, 1.0]),
    geom_matid: new Int32Array([0]),
    mat_rgba: new Float32Array([0.48, 0.42, 0.3, 1.0]),
    mat_texid: matTexId,
    mat_texrepeat: new Float32Array([5, 5]),
    tex_adr: new Int32Array([0]),
    tex_data: new Uint8Array([122, 107, 77, 77, 66, 46]),
    tex_height: new Int32Array([1]),
    tex_nchannel: new Int32Array([3]),
    tex_width: new Int32Array([2])
  };
}

test('createMaterialResources converts MuJoCo texture data into a repeatable Three texture', () => {
  const resources = createMaterialResources(makeTexturedModel(), 0);

  assertClose(resources.color.r, 0.48);
  assertClose(resources.color.g, 0.42);
  assertClose(resources.color.b, 0.3);
  assertClose(resources.opacity, 1.0);
  assert.ok(resources.texture instanceof THREE.DataTexture);
  assert.equal(resources.texture.image.width, 2);
  assert.equal(resources.texture.image.height, 1);
  assert.deepEqual([...resources.texture.image.data], [122, 107, 77, 255, 77, 66, 46, 255]);
  assert.equal(resources.texture.repeat.x, 5);
  assert.equal(resources.texture.repeat.y, 5);
  assert.equal(resources.texture.wrapS, THREE.RepeatWrapping);
  assert.equal(resources.texture.wrapT, THREE.RepeatWrapping);
});

test('makePlaneMesh applies the MuJoCo texture to a reflective MuJoCo-style ground', () => {
  const texture = new THREE.Texture();

  const mesh = makePlaneMesh(texture);

  assert.equal(mesh.isReflector, true);
  assert.equal(mesh.material.map, texture);
  assert.equal(mesh.material.depthWrite, false);
  assert.equal(mesh.receiveShadow, true);
  assert.equal(mesh.renderOrder, -1);
});

test('viewer rendering follows the humanoid-policy-viewer high-detail render loop', () => {
  assert.equal(RENDERER_OPTIONS.antialias, true);
  assert.notEqual(RENDERER_OPTIONS.preserveDrawingBuffer, true);
  assert.equal(VIEWER_SHADOWS_ENABLED, true);
  assert.match(viewerSource, /new THREE\.MeshPhysicalMaterial/);
  assert.ok(VIEWER_PIXEL_RATIO_LIMIT <= 1.5);
  assert.match(viewerSource, /setAnimationLoop\(/);
  assert.match(viewerSource, /RENDER_THROTTLE_MS = 30/);
  assert.match(viewerSource, /DRAG_FORCE_ARROW_COLOR = 0xffc857/);
  assert.doesNotMatch(viewerSource, /0xff3b3b/);
  assert.doesNotMatch(viewerSource, /Body Track Proxy/);
});

test('applyState keeps high detail meshes visible for body position tracks without MuJoCo forward kinematics', () => {
  let forwardCalls = 0;
  let renderRequests = 0;
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.simulation = {
    qpos: new Float64Array(7),
    forward() {
      forwardCalls += 1;
    }
  };
  viewer.jointAddressByName = new Map();
  viewer.bodies = {
    0: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), updateWorldMatrix() {} },
    1: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), updateWorldMatrix() {} }
  };
  viewer.model = { nbody: 2 };
  viewer.bodyIdByName = new Map([['pelvis', 0], ['head_link', 1]]);
  viewer.bodyTrackPositions = [];
  viewer.lastFrameKey = null;
  let highDetailVisible = true;
  viewer.setHighDetailVisible = (visible) => {
    highDetailVisible = visible;
  };
  viewer.requestRender = () => {
    renderRequests += 1;
  };

  viewer.applyState({
    sequence_id: 'seq',
    frame_index: 1,
    body_names: ['pelvis', 'head_link'],
    state: {
      timestamp: 0.02,
      root_translation: [1, 2, 3],
      root_rotation_wxyz: [1, 0, 0, 0],
      body_positions: [[0, 0, 0], [0.1, 0.2, 0.3]],
      body_rotations_wxyz: []
    }
  });

  assert.equal(forwardCalls, 0);
  assert.equal(renderRequests, 1);
  assert.equal(highDetailVisible, true);
  assert.equal(viewer.bodies[0].position.x, 1);
  assert.equal(viewer.bodies[0].position.y, 3);
  assert.equal(viewer.bodies[0].position.z, -2);
  assert.equal(viewer.bodies[1].position.x, 1.1);
  assert.equal(viewer.bodies[1].position.y, 3.3);
  assert.equal(viewer.bodies[1].position.z, -2.2);
  assert.equal(viewer.bodyTrackPositions[1].x, 1.1);
});

test('applyState prefers MuJoCo forward kinematics when joint positions are available', () => {
  let forwardCalls = 0;
  let syncCalls = 0;
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.simulation = {
    qpos: new Float64Array(8),
    forward() {
      forwardCalls += 1;
    }
  };
  viewer.jointAddressByName = new Map([['left_hip_pitch_joint', 7]]);
  viewer.bodies = {
    0: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), updateWorldMatrix() {} },
    1: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), updateWorldMatrix() {} }
  };
  viewer.model = { nbody: 2 };
  viewer.bodyIdByName = new Map([['pelvis', 0], ['head_link', 1]]);
  viewer.bodyTrackPositions = [];
  viewer.lastFrameKey = null;
  viewer.setHighDetailVisible = () => {};
  viewer.syncBodies = () => {
    syncCalls += 1;
  };
  viewer.requestRender = () => {};

  viewer.applyState({
    sequence_id: 'seq',
    frame_index: 2,
    joint_names: ['left_hip_pitch_joint'],
    body_names: ['pelvis', 'head_link'],
    state: {
      timestamp: 0.04,
      root_translation: [1, 2, 3],
      root_rotation_wxyz: [1, 0, 0, 0],
      joint_positions: [0.25],
      body_positions: [[99, 99, 99], [88, 88, 88]],
      body_rotations_wxyz: [[1, 0, 0, 0], [1, 0, 0, 0]]
    }
  });

  assert.equal(forwardCalls, 1);
  assert.equal(syncCalls, 1);
  assert.equal(viewer.simulation.qpos[7], 0.25);
  assert.equal(viewer.bodies[1].position.x, 0);
});

test('reference overlay builds translucent ghost bodies and updates them without stepping visible physics', () => {
  let forwardCalls = 0;
  let syncCalls = 0;
  let renderRequests = 0;
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = { nbody: 2 };
  viewer.modelRoot = new THREE.Group();
  viewer.bodies = {
    0: new THREE.Group(),
    1: new THREE.Group()
  };
  viewer.bodies[0].name = 'world';
  viewer.bodies[1].name = 'pelvis';
  viewer.bodies[0].bodyID = 0;
  viewer.bodies[1].bodyID = 1;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  viewer.bodies[1].add(mesh);
  viewer.simulation = {
    qpos: new Float64Array(8),
    forward() {
      forwardCalls += 1;
    }
  };
  viewer.jointAddressByName = new Map([['joint_a', 7]]);
  viewer.syncBodies = () => {
    syncCalls += 1;
  };
  viewer.requestRender = () => {
    renderRequests += 1;
  };

  viewer.setReferenceOverlayEnabled(true);
  viewer.updateReferenceOverlay({
    sequence_id: 'seq',
    frame_index: 3,
    joint_names: ['joint_a'],
    body_names: [],
    state: {
      root_translation: [1, 2, 0.8],
      root_rotation_wxyz: [1, 0, 0, 0],
      joint_positions: [0.4]
    }
  });

  assert.equal(viewer.referenceOverlayEnabled, true);
  assert.equal(viewer.referenceOverlay.visible, true);
  assert.equal(viewer.modelRoot.children.includes(viewer.referenceOverlay), true);
  assert.equal(viewer.referenceOverlayBodies[1].visible, true);
  assert.equal(viewer.simulation.qpos[0], 0);
  assert.equal(forwardCalls, 0);
  assert.equal(syncCalls, 0);
  assert.equal(renderRequests, 2);
  assert.ok(viewer.referenceOverlayMaterials.length > 0);
  assert.equal(viewer.referenceOverlayMaterials[0].transparent, true);
  assert.ok(viewer.referenceOverlayMaterials[0].opacity < 0.4);

  viewer.setReferenceOverlayEnabled(false);

  assert.equal(viewer.referenceOverlay.visible, false);
});

test('reference overlay can follow named body position tracks directly', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = { nbody: 2 };
  viewer.modelRoot = new THREE.Group();
  viewer.bodies = {
    0: new THREE.Group(),
    1: new THREE.Group()
  };
  viewer.bodies[0].name = 'world';
  viewer.bodies[1].name = 'head_link';
  viewer.bodies[0].bodyID = 0;
  viewer.bodies[1].bodyID = 1;
  viewer.bodies[1].add(new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshBasicMaterial()));
  viewer.bodyIdByName = new Map([['head_link', 1]]);
  viewer.requestRender = () => {};
  viewer.setReferenceOverlayEnabled(true);

  viewer.updateReferenceOverlay({
    sequence_id: 'seq',
    frame_index: 1,
    joint_names: [],
    body_names: ['head_link'],
    state: {
      root_translation: [1, 2, 3],
      root_rotation_wxyz: [1, 0, 0, 0],
      body_positions: [[0.1, 0.2, 0.3]]
    }
  });

  assert.deepEqual(viewer.referenceOverlayBodies[1].position.toArray(), [1.1, 3.3, -2.2]);
});

test('global and relative reference overlays can be updated independently', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = { nbody: 2 };
  viewer.modelRoot = new THREE.Group();
  viewer.bodies = {
    0: new THREE.Group(),
    1: new THREE.Group()
  };
  viewer.bodies[0].name = 'world';
  viewer.bodies[1].name = 'pelvis';
  viewer.bodies[0].bodyID = 0;
  viewer.bodies[1].bodyID = 1;
  viewer.bodies[1].add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  viewer.bodyIdByName = new Map([['pelvis', 1]]);
  viewer.requestRender = () => {};

  viewer.setReferenceOverlayEnabled(true, 'global');
  viewer.setReferenceOverlayEnabled(true, 'relative');
  viewer.updateReferenceOverlay({
    sequence_id: 'seq',
    frame_index: 0,
    joint_names: [],
    body_names: ['pelvis'],
    state: {
      root_translation: [1, 2, 0.8],
      root_rotation_wxyz: [1, 0, 0, 0],
      body_positions: [[0, 0, 0]]
    }
  }, 'global');
  viewer.updateReferenceOverlay({
    sequence_id: 'seq',
    frame_index: 0,
    joint_names: [],
    body_names: ['pelvis'],
    state: {
      root_translation: [4, 5, 0.8],
      root_rotation_wxyz: [1, 0, 0, 0],
      body_positions: [[0, 0, 0]]
    }
  }, 'relative');

  assert.notEqual(viewer.referenceOverlays.global.group, viewer.referenceOverlays.relative.group);
  assert.equal(viewer.referenceOverlays.global.group.visible, true);
  assert.equal(viewer.referenceOverlays.relative.group.visible, true);
  assert.equal(viewer.referenceOverlays.global.materials[0].color.getHex(), 0x7bd3ee);
  assert.equal(viewer.referenceOverlays.relative.materials[0].color.getHex(), 0xf2c86b);
  assert.deepEqual(viewer.referenceOverlays.global.bodies[1].position.toArray(), [1, 0.8, -2]);
  assert.deepEqual(viewer.referenceOverlays.relative.bodies[1].position.toArray(), [4, 0.8, -5]);

  viewer.setReferenceOverlayEnabled(false, 'global');

  assert.equal(viewer.referenceOverlays.global.group.visible, false);
  assert.equal(viewer.referenceOverlays.relative.group.visible, true);
});

test('stepPhysics applies PD torque targets and advances MuJoCo locally', () => {
  let stepCalls = 0;
  let forwardCalls = 0;
  let syncCalls = 0;
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = {
    nu: 2,
    nq: 9,
    nv: 8,
    actuator_ctrlrange: new Float64Array([-5, 5, -5, 5])
  };
  viewer.simulation = {
    qpos: new Float64Array([0, 0, 0.8, 1, 0, 0, 0, 0.1, -0.2]),
    qvel: new Float64Array([0, 0, 0, 0, 0, 0, 0.5, -0.5]),
    ctrl: new Float64Array(2),
    qfrc_applied: new Float64Array(8),
    forward() {
      forwardCalls += 1;
    },
    step() {
      stepCalls += 1;
    }
  };
  viewer.syncBodies = () => {
    syncCalls += 1;
  };
  viewer.requestRender = () => {};
  viewer.actuatorAddressByJointName = new Map([
    ['joint_a', 0],
    ['joint_b', 1]
  ]);

  const state = viewer.stepPhysics({
    joint_names: ['joint_a', 'joint_b'],
    joint_positions: [0.2, -0.1],
    kp: [40, 40],
    kd: [2, 2],
    steps: 3
  });

  assert.equal(stepCalls, 3);
  assert.equal(forwardCalls, 1);
  assert.equal(syncCalls, 1);
  assert.equal(viewer.simulation.ctrl[0], 3);
  assert.equal(viewer.simulation.ctrl[1], 5);
  assert.deepEqual(state.joint_positions, [0.1, -0.2]);
});

test('physics decimation follows MuJoCo timestep like humanoid-policy-viewer', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = { opt: { timestep: 0.005 } };

  assert.equal(viewer.getPhysicsDecimation(), 4);
  assert.equal(viewer.getPhysicsDecimation(0.01), 2);
});

test('G1 MuJoCo scene keeps policy-neutral timestep, solver, friction, and armatures', () => {
  const expectedArmatures = [
    ['left_hip_pitch_joint', '0.0103'],
    ['left_hip_roll_joint', '0.0251'],
    ['left_hip_yaw_joint', '0.0103'],
    ['left_knee_joint', '0.0251'],
    ['left_ankle_pitch_joint', '0.003597'],
    ['left_ankle_roll_joint', '0.003597'],
    ['right_hip_pitch_joint', '0.0103'],
    ['right_hip_roll_joint', '0.0251'],
    ['right_hip_yaw_joint', '0.0103'],
    ['right_knee_joint', '0.0251'],
    ['right_ankle_pitch_joint', '0.003597'],
    ['right_ankle_roll_joint', '0.003597'],
    ['waist_yaw_joint', '0.0103'],
    ['waist_roll_joint', '0.0103'],
    ['waist_pitch_joint', '0.0103'],
    ['left_shoulder_pitch_joint', '0.003597'],
    ['left_shoulder_roll_joint', '0.003597'],
    ['left_shoulder_yaw_joint', '0.003597'],
    ['left_elbow_joint', '0.003597'],
    ['left_wrist_roll_joint', '0.003597'],
    ['left_wrist_pitch_joint', '0.00425'],
    ['left_wrist_yaw_joint', '0.00425'],
    ['right_shoulder_pitch_joint', '0.003597'],
    ['right_shoulder_roll_joint', '0.003597'],
    ['right_shoulder_yaw_joint', '0.003597'],
    ['right_elbow_joint', '0.003597'],
    ['right_wrist_roll_joint', '0.003597'],
    ['right_wrist_pitch_joint', '0.00425'],
    ['right_wrist_yaw_joint', '0.00425']
  ];

  assert.match(g1SceneSource, /<option timestep="0\.002" solver="Newton"\/>/);
  assert.match(g1SceneSource, /<geom name="floor"[^>]*friction="1\.0 \.1 \.1"/);
  for (const [jointName, armature] of expectedArmatures) {
    assert.match(
      g1SceneSource,
      new RegExp(`<joint name="${jointName}"[^>]*armature="${armature}"`)
    );
  }
});

test('viewer applies and resets per-policy MuJoCo physics options', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.mujoco = {
    mjtSolver: {
      mjSOL_PGS: { value: 0 },
      mjSOL_CG: { value: 1 },
      mjSOL_NEWTON: { value: 2 }
    }
  };
  viewer.model = {
    opt: { timestep: 0.002, solver: 2 },
    geom_friction: new Float64Array([
      1.0, 0.1, 0.1,
      0.7, 0.2, 0.2
    ])
  };
  viewer.geomIdByName = new Map([['floor', 0], ['other', 1]]);
  viewer.defaultPhysicsOptions = {
    timestep: 0.002,
    solver: 2,
    geom_friction: {
      floor: [1.0, 0.1, 0.1]
    }
  };

  viewer.configurePhysics({
    timestep: 0.001,
    solver: 'PGS',
    geom_friction: {
      floor: [1.6, 0.005, 0.0001]
    }
  });

  assert.equal(viewer.model.opt.timestep, 0.001);
  assert.equal(viewer.model.opt.solver, 0);
  assert.deepEqual([...viewer.model.geom_friction.slice(0, 3)], [1.6, 0.005, 0.0001]);

  viewer.configurePhysics(null);

  assert.equal(viewer.model.opt.timestep, 0.002);
  assert.equal(viewer.model.opt.solver, 2);
  assert.deepEqual([...viewer.model.geom_friction.slice(0, 3)], [1.0, 0.1, 0.1]);
});

test('readState includes freejoint root velocities for browser policy proprioception', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.simulation = {
    qpos: new Float64Array([1, 2, 0.8, 1, 0, 0, 0, 0.1]),
    qvel: new Float64Array([0.4, 0.5, 0.6, 0.01, 0.02, 0.03, 0.7])
  };
  viewer.jointNamesMJC = ['joint_a'];
  viewer.jointAddressByName = new Map([['joint_a', 7]]);
  viewer.jointVelocityAddressByName = new Map([['joint_a', 6]]);

  const state = viewer.readState(['joint_a']);

  assert.deepEqual(state.root_linear_velocity, [0.4, 0.5, 0.6]);
  assert.deepEqual(state.root_angular_velocity, [0.01, 0.02, 0.03]);
});

test('stepPhysics writes controls through MuJoCo actuator-to-joint mapping instead of policy order', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = {
    nu: 3,
    nq: 10,
    nv: 9,
    actuator_ctrlrange: new Float64Array([-10, 10, -10, 10, -10, 10])
  };
  viewer.simulation = {
    qpos: new Float64Array([0, 0, 0.8, 1, 0, 0, 0, 0, 0, 0]),
    qvel: new Float64Array(9),
    ctrl: new Float64Array(3),
    qfrc_applied: new Float64Array(9),
    forward() {},
    step() {}
  };
  viewer.jointAddressByName = new Map([
    ['left_hip_pitch_joint', 7],
    ['right_hip_pitch_joint', 8],
    ['waist_yaw_joint', 9]
  ]);
  viewer.jointVelocityAddressByName = new Map([
    ['left_hip_pitch_joint', 6],
    ['right_hip_pitch_joint', 7],
    ['waist_yaw_joint', 8]
  ]);
  viewer.actuatorAddressByJointName = new Map([
    ['left_hip_pitch_joint', 0],
    ['waist_yaw_joint', 1],
    ['right_hip_pitch_joint', 2]
  ]);
  viewer.syncBodies = () => {};
  viewer.requestRender = () => {};

  viewer.stepPhysics({
    joint_names: ['left_hip_pitch_joint', 'right_hip_pitch_joint', 'waist_yaw_joint'],
    joint_positions: [0.1, 0.2, 0.3],
    kp: [10, 10, 10],
    kd: [0, 0, 0]
  });

  assert.deepEqual([...viewer.simulation.ctrl], [1, 3, 2]);
});

test('stepPhysics clamps policy torques to TWIST2 torque safety limits before actuator ranges', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = {
    nu: 2,
    nq: 9,
    nv: 8,
    actuator_ctrlrange: new Float64Array([-100, 100, -20, 20])
  };
  viewer.simulation = {
    qpos: new Float64Array([0, 0, 0.8, 1, 0, 0, 0, 0, 0]),
    qvel: new Float64Array(8),
    ctrl: new Float64Array(2),
    qfrc_applied: new Float64Array(8),
    forward() {},
    step() {}
  };
  viewer.jointAddressByName = new Map([
    ['hip', 7],
    ['ankle', 8]
  ]);
  viewer.jointVelocityAddressByName = new Map([
    ['hip', 6],
    ['ankle', 7]
  ]);
  viewer.actuatorAddressByJointName = new Map([
    ['hip', 0],
    ['ankle', 1]
  ]);
  viewer.syncBodies = () => {};
  viewer.requestRender = () => {};

  viewer.stepPhysics({
    joint_names: ['hip', 'ankle'],
    joint_positions: [1, 1],
    kp: [100, 100],
    kd: [0, 0],
    torque_limits: [45, 45]
  });

  assert.deepEqual([...viewer.simulation.ctrl], [45, 20]);
});

test('stepPhysics falls under gravity when no policy target is provided', () => {
  let stepCalls = 0;
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.model = { nu: 1, nq: 8, nv: 7 };
  viewer.simulation = {
    qpos: new Float64Array([0, 0, 0.8, 1, 0, 0, 0, 0.1]),
    qvel: new Float64Array(7),
    ctrl: new Float64Array([4]),
    qfrc_applied: new Float64Array([1, 2, 3]),
    forward() {},
    step() {
      stepCalls += 1;
    }
  };
  viewer.syncBodies = () => {};
  viewer.requestRender = () => {};

  viewer.stepPhysics({ steps: 2 });

  assert.equal(stepCalls, 2);
  assert.equal(viewer.simulation.ctrl[0], 0);
  assert.deepEqual([...viewer.simulation.qfrc_applied], [0, 0, 0]);
});

test('evaluation simulation uses its own MuJoCo data and does not render the visible viewer', () => {
  let constructedData = 0;
  let stepCalls = 0;
  let visibleSyncCalls = 0;
  let visibleRenderCalls = 0;
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.mujoco = {
    MjData: class {
      constructor(model) {
        constructedData += 1;
        this.model = model;
        this.qpos = new Float64Array([0, 0, 0.8, 1, 0, 0, 0, 0]);
        this.qvel = new Float64Array(7);
        this.ctrl = new Float64Array(1);
        this.qfrc_applied = new Float64Array(7);
        this.xfrc_applied = new Float64Array(6);
        this.xpos = new Float64Array(6);
        this.xquat = new Float64Array(8);
        this.light_xpos = new Float64Array(3);
        this.light_xdir = new Float64Array(3);
      }

      delete() {
        this.deleted = true;
      }
    },
    mj_forward() {},
    mj_resetData(_model, data) {
      data.qpos.fill(0);
      data.qpos[2] = 0.8;
      data.qpos[3] = 1;
    },
    mj_step(_model, data) {
      stepCalls += 1;
      data.qpos[7] += 0.01;
    }
  };
  viewer.model = {
    nu: 1,
    nq: 8,
    nv: 7,
    opt: { timestep: 0.002 }
  };
  viewer.simulation = {
    qpos: new Float64Array([9, 9, 9, 1, 0, 0, 0, 9]),
    qvel: new Float64Array(7),
    ctrl: new Float64Array(1),
    qfrc_applied: new Float64Array(7)
  };
  viewer.jointNamesMJC = ['joint_a'];
  viewer.bodyNames = ['world'];
  viewer.jointAddressByName = new Map([['joint_a', 7]]);
  viewer.jointVelocityAddressByName = new Map([['joint_a', 6]]);
  viewer.actuatorAddressByJointName = new Map([['joint_a', 0]]);
  viewer.syncBodies = () => {
    visibleSyncCalls += 1;
  };
  viewer.requestRender = () => {
    visibleRenderCalls += 1;
  };

  const simulation = viewer.createEvaluationSimulation();
  simulation.resetPhysics({
    sequence_id: 'default_stance',
    frame_index: 0,
    joint_names: ['joint_a'],
    body_names: ['world'],
    state: {
      root_translation: [1, 2, 0.8],
      root_rotation_wxyz: [1, 0, 0, 0],
      joint_positions: [0.2]
    }
  });
  const state = simulation.stepPhysics({
    joint_names: ['joint_a'],
    joint_positions: [0.3],
    kp: [10],
    kd: [0],
    steps: 3
  });

  assert.equal(constructedData, 1);
  assert.equal(stepCalls, 3);
  assert.equal(visibleSyncCalls, 0);
  assert.equal(visibleRenderCalls, 0);
  assert.notEqual(simulation.simulation.qpos, viewer.simulation.qpos);
  assert.equal(viewer.simulation.qpos[0], 9);
  assert.deepEqual(state.root_translation, [1, 2, 0.8]);
  assert.ok(state.joint_positions[0] > 0.2);
});

test('evaluation simulation reads contacts without updating visible contact markers', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.bodyNames = ['world', 'left_ankle_roll_link'];
  viewer.model = {
    nbody: 2,
    nu: 0,
    nq: 7,
    nv: 6,
    geom_bodyid: new Int32Array([0, 1])
  };
  viewer.mujoco = {
    MjData: class {
      constructor() {
        this.qpos = new Float64Array([0, 0, 0.8, 1, 0, 0, 0]);
        this.qvel = new Float64Array(6);
        this.ctrl = new Float64Array();
        this.qfrc_applied = new Float64Array(6);
        this.xfrc_applied = new Float64Array(12);
        this.xpos = new Float64Array(6);
        this.xquat = new Float64Array(8);
        this.light_xpos = new Float64Array(3);
        this.light_xdir = new Float64Array(3);
        this.ncon = 1;
        this.contact = {
          get() {
            return { geom1: 0, geom2: 1, pos: [1, 2, 3] };
          }
        };
      }

      delete() {}
    },
    mj_forward() {},
    mj_resetData() {},
    mj_step() {},
    mj_contactForce(_model, _data, _index, out) {
      out[0] = 7;
    }
  };
  let markerCalls = 0;
  viewer.setContactMarkers = () => {
    markerCalls += 1;
  };

  const simulation = viewer.createEvaluationSimulation();
  const summary = simulation.readContactSummary();

  assert.equal(summary.leftFoot.active, true);
  assert.equal(summary.leftFoot.normalForce, 7);
  assert.equal(markerCalls, 0);
});

test('evaluation simulation restores shared model physics options when disposed', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.mujoco = {
    MjData: class {
      constructor() {
        this.qpos = new Float64Array(7);
        this.qvel = new Float64Array(6);
        this.ctrl = new Float64Array();
        this.qfrc_applied = new Float64Array(6);
        this.xfrc_applied = new Float64Array(6);
        this.xpos = new Float64Array(3);
        this.xquat = new Float64Array(4);
        this.light_xpos = new Float64Array(3);
        this.light_xdir = new Float64Array(3);
      }

      delete() {}
    },
    mjtSolver: {
      mjSOL_PGS: { value: 0 },
      mjSOL_CG: { value: 1 },
      mjSOL_NEWTON: { value: 2 }
    },
    mj_forward() {},
    mj_resetData() {},
    mj_step() {}
  };
  viewer.model = {
    opt: { timestep: 0.002, solver: 2 },
    geom_friction: new Float64Array([1.0, 0.1, 0.1])
  };
  viewer.geomIdByName = new Map([['floor', 0]]);
  viewer.defaultPhysicsOptions = {
    timestep: 0.002,
    solver: 2,
    geom_friction: {
      floor: [1.0, 0.1, 0.1]
    }
  };

  const simulation = viewer.createEvaluationSimulation();
  simulation.configurePhysics({
    timestep: 0.001,
    solver: 'PGS',
    geom_friction: {
      floor: [1.7, 0.01, 0.01]
    }
  });
  assert.equal(viewer.model.opt.timestep, 0.001);
  assert.equal(viewer.model.opt.solver, 0);

  simulation.dispose();

  assert.equal(viewer.model.opt.timestep, 0.002);
  assert.equal(viewer.model.opt.solver, 2);
  assert.deepEqual([...viewer.model.geom_friction], [1.0, 0.1, 0.1]);
});

test('active impulses convert Three world coordinates back to MuJoCo coordinates', () => {
  const calls = [];
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.bodies = {
    2: { position: new THREE.Vector3(1, 2, 3) }
  };
  viewer.activeImpulse = {
    bodyId: 2,
    force: [10, 20, 30],
    expiresAt: 1000
  };
  viewer.simulation = {
    applyForce(...args) {
      calls.push(args);
    }
  };

  viewer.applyActiveImpulse(500);

  assert.deepEqual(calls[0], [10, -30, 20, 0, 0, 0, 1, -3, 2, 2]);
});

test('mouse drag force stays disabled until browser physics is enabled', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.physicsInteractionEnabled = false;
  viewer.dragForce = { active: false };
  viewer.pickDragBody = () => ({
    object: { bodyID: 2 },
    point: new THREE.Vector3(1, 2, 3),
    distance: 4
  });

  viewer.beginDragForce({ clientX: 10, clientY: 20, preventDefault() {} });

  assert.equal(viewer.dragForce.active, false);
});

test('mouse drag force ignores the world body so floor drags keep orbit controls', () => {
  const controls = { enabled: true };
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.physicsInteractionEnabled = true;
  viewer.simulation = {};
  viewer.controls = controls;
  viewer.bodies = { 0: { name: 'world' } };
  viewer.dragForce = {
    active: false,
    localHit: new THREE.Vector3(),
    worldHit: new THREE.Vector3(),
    currentWorld: new THREE.Vector3(),
    force: [0, 0, 0]
  };
  viewer.pickDragBody = () => ({
    object: { bodyID: 0 },
    point: new THREE.Vector3(1, 0, 3),
    distance: 4
  });

  viewer.beginDragForce({ clientX: 10, clientY: 20, preventDefault() {} });

  assert.equal(viewer.dragForce.active, false);
  assert.equal(controls.enabled, true);
});

test('mouse drag force grabs body meshes and restores orbit controls on release', () => {
  const controls = { enabled: true };
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.physicsInteractionEnabled = true;
  viewer.simulation = {};
  viewer.controls = controls;
  viewer.bodies = { 2: { name: 'pelvis' } };
  viewer.dragForce = {
    active: false,
    localHit: new THREE.Vector3(),
    worldHit: new THREE.Vector3(),
    currentWorld: new THREE.Vector3(),
    force: [0, 0, 0]
  };
  viewer.updateDragForceTarget = () => {};
  viewer.setDragForceArrowVisible = (visible) => {
    viewer.arrowVisible = visible;
  };
  viewer.pickDragBody = () => ({
    object: { bodyID: 2 },
    point: new THREE.Vector3(1, 2, 3),
    distance: 4
  });

  viewer.beginDragForce({ clientX: 10, clientY: 20, preventDefault() {} });

  assert.equal(viewer.dragForce.active, true);
  assert.equal(viewer.dragForce.bodyId, 2);
  assert.equal(controls.enabled, false);
  assert.equal(viewer.arrowVisible, true);

  viewer.endDragForce();

  assert.equal(viewer.dragForce.active, false);
  assert.equal(controls.enabled, true);
  assert.equal(viewer.arrowVisible, false);
});

test('mouse drag forces are clamped and applied through MuJoCo body force', () => {
  const calls = [];
  const body = new THREE.Group();
  body.position.set(1, 2, 3);
  body.quaternion.identity();
  body.updateWorldMatrix(true, false);
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.bodies = { 2: body };
  viewer.dragForce = {
    active: true,
    bodyId: 2,
    localHit: new THREE.Vector3(0, 0, 0),
    worldHit: new THREE.Vector3(),
    currentWorld: new THREE.Vector3(11, 2, 3),
    force: [0, 0, 0]
  };
  viewer.simulation = {
    applyForce(...args) {
      calls.push(args);
    }
  };
  viewer.updateDragForceArrow = () => {};

  viewer.applyDragForce();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [30, -0, 0, 0, 0, 0, 1, -3, 2, 2]);
  assert.deepEqual(viewer.dragForce.force, [30, 0, 0]);
});

test('contact summary classifies foot contacts and normal forces', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.bodyNames = ['world', 'left_ankle_roll_link', 'right_ankle_roll_link'];
  viewer.model = {
    geom_bodyid: new Int32Array([0, 1, 2])
  };
  viewer.data = {
    ncon: 2,
    contact: {
      get(index) {
        return [
          { geom1: 0, geom2: 1, pos: [1, 2, 3] },
          { geom1: 0, geom2: 2, pos: [4, 5, 6] }
        ][index];
      }
    }
  };
  viewer.mujoco = {
    mj_contactForce(_model, _data, index, out) {
      out[0] = index === 0 ? 12 : 8;
    }
  };
  viewer.setContactMarkers = (summary) => {
    viewer.markerSummary = summary;
  };

  const summary = viewer.readContactSummary();

  assert.equal(summary.leftFoot.active, true);
  assert.equal(summary.rightFoot.active, true);
  assert.equal(summary.leftFoot.normalForce, 12);
  assert.equal(summary.rightFoot.normalForce, 8);
  assert.equal(summary.points.length, 2);
  assert.equal(viewer.markerSummary.points.length, 2);
});

test('contact summary reads normal forces through MuJoCo DoubleBuffer bindings', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.bodyNames = ['world', 'left_ankle_roll_link'];
  viewer.model = {
    geom_bodyid: new Int32Array([0, 1])
  };
  viewer.data = {
    ncon: 1,
    contact: {
      get() {
        return { geom1: 0, geom2: 1, pos: [1, 2, 3] };
      }
    }
  };
  viewer.mujoco = {
    DoubleBuffer: class {
      constructor(size) {
        this.view = new Float64Array(size);
        this.deleted = false;
      }

      GetView() {
        return this.view;
      }

      delete() {
        this.deleted = true;
      }
    },
    mj_contactForce(_model, _data, _index, out) {
      const view = out?.GetView?.();
      if (view) {
        view[0] = 21;
      }
    }
  };
  viewer.setContactMarkers = (summary) => {
    viewer.markerSummary = summary;
  };

  const summary = viewer.readContactSummary();

  assert.equal(summary.leftFoot.active, true);
  assert.equal(summary.leftFoot.normalForce, 21);
  assert.equal(viewer.markerSummary.leftFoot.normalForce, 21);
});

test('contact force markers can be hidden while retaining contact telemetry', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.bodyNames = ['world', 'left_ankle_roll_link'];
  viewer.model = {
    geom_bodyid: new Int32Array([0, 1])
  };
  viewer.data = {
    ncon: 1,
    contact: {
      get() {
        return { geom1: 0, geom2: 1, pos: [1, 2, 3] };
      }
    }
  };
  viewer.mujoco = {
    mj_contactForce(_model, _data, _index, out) {
      out[0] = 9;
    }
  };
  viewer.contactMarkerGroup = { visible: true };
  viewer.contactMarkerPool = [{ visible: true }];
  let markerCalls = 0;
  BrowserMujocoViewer.prototype.setContactMarkersEnabled.call(viewer, false);
  viewer.setContactMarkers = () => {
    markerCalls += 1;
  };

  const summary = viewer.readContactSummary();

  assert.equal(summary.leftFoot.normalForce, 9);
  assert.equal(markerCalls, 0);
  assert.equal(viewer.contactMarkersEnabled, false);
  assert.equal(viewer.contactMarkerGroup.visible, false);
  assert.equal(viewer.contactMarkerPool[0].visible, false);
});

test('camera presets switch default, front, side, back, and top views without changing follow mode', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.followBodyId = 1;
  viewer.followEnabled = true;
  viewer.followInitialized = true;
  viewer.bodies = {
    1: { position: new THREE.Vector3(2, 0.8, -3) }
  };
  viewer.controls = {
    target: new THREE.Vector3(),
    updateCalls: 0,
    update() {
      this.updateCalls += 1;
    }
  };
  viewer.camera = {
    position: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0),
    lookAtTarget: null,
    lookAt(target) {
      this.lookAtTarget = target.clone();
    }
  };
  viewer.requestRender = () => {};

  viewer.applyCameraPreset('front');
  assert.equal(viewer.followEnabled, true);
  assert.deepEqual(viewer.controls.target.toArray(), [2, 0.75, -3]);
  assert.deepEqual(viewer.camera.position.toArray(), [5.2, 1.45, -3]);

  viewer.applyCameraPreset('side');
  assert.equal(viewer.followEnabled, true);
  assert.deepEqual(viewer.camera.position.toArray(), [2, 1.45, 0.2]);

  viewer.applyCameraPreset('back');
  assert.equal(viewer.followEnabled, true);
  assert.deepEqual(viewer.camera.position.toArray(), [-1.2, 1.45, -3]);

  viewer.applyCameraPreset('top');
  assert.equal(viewer.followEnabled, true);
  assert.deepEqual(viewer.camera.position.toArray(), [2, 5.25, -3]);

  viewer.applyCameraPreset('default');
  assert.equal(viewer.followEnabled, true);
  assert.deepEqual(viewer.camera.position.toArray(), [3, 2.2, 3]);
});

test('camera follow can be toggled independently from camera presets', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.followEnabled = true;
  viewer.followInitialized = true;
  viewer.requestRender = () => {};

  assert.equal(viewer.setCameraFollowEnabled(false), true);
  assert.equal(viewer.followEnabled, false);
  assert.equal(viewer.followInitialized, false);

  assert.equal(viewer.setCameraFollowEnabled(true), true);
  assert.equal(viewer.followEnabled, true);
  assert.equal(viewer.followInitialized, false);
});

test('viewer recording prefers mp4 and returns the actual recording mime type', () => {
  const chunks = [];
  class FakeMediaRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      FakeMediaRecorder.instance = this;
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: { size: 4, label: 'chunk' } });
      this.onstop?.();
    }
  }
  FakeMediaRecorder.isTypeSupported = (type) => type === 'video/mp4';
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalBlob = globalThis.Blob;
  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.Blob = class FakeBlob {
    constructor(parts, options) {
      chunks.push(...parts);
      this.parts = parts;
      this.type = options.type;
      this.size = parts.length;
    }
  };

  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.renderer = {
    domElement: {
      captureStream(fps) {
        return { fps };
      }
    }
  };

  try {
    assert.equal(viewer.startRecording({ fps: 30, mimeType: 'video/mp4' }), true);
    assert.equal(FakeMediaRecorder.instance.options.mimeType, 'video/mp4');
    assert.equal(viewer.isRecording(), true);
    const promise = viewer.stopRecording();
    return promise.then((blob) => {
      assert.equal(blob.type, 'video/mp4');
      assert.equal(chunks.length, 1);
      assert.equal(viewer.isRecording(), false);
    });
  } finally {
    globalThis.MediaRecorder = originalMediaRecorder;
    globalThis.Blob = originalBlob;
  }
});

test('viewer recording falls back to webm when mp4 recording is unavailable', () => {
  class FakeMediaRecorder {
    constructor(stream, options) {
      this.stream = stream;
      this.options = options;
      this.state = 'inactive';
      FakeMediaRecorder.instance = this;
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: { size: 4, label: 'chunk' } });
      this.onstop?.();
    }
  }
  FakeMediaRecorder.isTypeSupported = (type) => type === 'video/webm;codecs=vp9';
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalBlob = globalThis.Blob;
  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.Blob = class FakeBlob {
    constructor(_parts, options) {
      this.type = options.type;
    }
  };

  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.renderer = {
    domElement: {
      captureStream(fps) {
        return { fps };
      }
    }
  };

  try {
    assert.equal(viewer.startRecording({ fps: 30, mimeType: 'video/mp4' }), true);
    assert.equal(FakeMediaRecorder.instance.options.mimeType, 'video/webm;codecs=vp9');
    return viewer.stopRecording().then((blob) => {
      assert.equal(blob.type, 'video/webm;codecs=vp9');
    });
  } finally {
    globalThis.MediaRecorder = originalMediaRecorder;
    globalThis.Blob = originalBlob;
  }
});

test('updateCameraFollow keeps moving humanoid centered while preserving camera offset', () => {
  const viewer = Object.create(BrowserMujocoViewer.prototype);
  viewer.followEnabled = true;
  viewer.followHeight = 0.75;
  viewer.followBodyId = 1;
  viewer.followInitialized = false;
  viewer.followTarget = new THREE.Vector3();
  viewer.followDelta = new THREE.Vector3();
  viewer.controls = { target: new THREE.Vector3(0, 0.75, 0) };
  viewer.camera = { position: new THREE.Vector3(3, 2.2, 3) };
  viewer.bodies = {
    1: { position: new THREE.Vector3(2, 1.4, -4) }
  };

  viewer.updateCameraFollow();

  assert.equal(viewer.controls.target.x, 2);
  assert.equal(viewer.controls.target.y, 0.75);
  assert.equal(viewer.controls.target.z, -4);
  assert.equal(viewer.camera.position.x, 5);
  assert.equal(viewer.camera.position.y, 2.2);
  assert.equal(viewer.camera.position.z, -1);

  viewer.bodies[1].position.set(4, 1.4, -6);
  viewer.updateCameraFollow();

  assert.equal(viewer.controls.target.x, 4);
  assert.equal(viewer.controls.target.z, -6);
  assert.equal(viewer.camera.position.x, 7);
  assert.equal(viewer.camera.position.z, -3);
});

test('hasBodyPositionTrack requires body names and matching position count', () => {
  assert.equal(hasBodyPositionTrack({ body_names: ['pelvis'], state: { body_positions: [[0, 0, 0]] } }), true);
  assert.equal(hasBodyPositionTrack({ body_names: [], state: { body_positions: [[0, 0, 0]] } }), false);
  assert.equal(hasBodyPositionTrack({ body_names: ['pelvis'], state: { body_positions: [] } }), false);
});
