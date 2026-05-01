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
