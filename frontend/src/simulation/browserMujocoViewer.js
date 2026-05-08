import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import loadMujoco from 'mujoco-js';
import { Reflector } from './utils/Reflector.js';

export const RENDERER_OPTIONS = Object.freeze({ antialias: true });
export const VIEWER_PIXEL_RATIO_LIMIT = 1.5;
export const VIEWER_SHADOWS_ENABLED = true;
export const RENDER_THROTTLE_MS = 30;
const DRAG_FORCE_SCALE = 60.0;
const DRAG_FORCE_MAX = 30.0;
const DRAG_FORCE_ARROW_COLOR = 0xffc857;
const CONTACT_FORCE_ARROW_SCALE = 0.01;
const CONTACT_FORCE_ARROW_MAX = 0.55;
const CONTACT_ARROW_COLOR_LEFT = 0x58c08d;
const CONTACT_ARROW_COLOR_RIGHT = 0x6ea8c7;
const CONTACT_ARROW_COLOR_OTHER = 0xd0a257;
const CONTACT_SUMMARY_MAX_CONTACTS = 256;
const REFERENCE_OVERLAY_COLOR = 0x7bd3ee;
const REFERENCE_OVERLAY_OPACITY = 0.26;
const RELATIVE_REFERENCE_OVERLAY_COLOR = 0xf2c86b;
const RELATIVE_REFERENCE_OVERLAY_OPACITY = 0.22;
const CAMERA_PRESET_DISTANCE = 3.2;
const CAMERA_PRESET_HEIGHT = 1.45;
const CAMERA_TOP_HEIGHT_OFFSET = 4.5;

const REFERENCE_OVERLAY_STYLES = Object.freeze({
  global: {
    color: REFERENCE_OVERLAY_COLOR,
    opacity: REFERENCE_OVERLAY_OPACITY,
    name: 'Global Reference Motion Ghost'
  },
  relative: {
    color: RELATIVE_REFERENCE_OVERLAY_COLOR,
    opacity: RELATIVE_REFERENCE_OVERLAY_OPACITY,
    name: 'Relative Reference Motion Ghost'
  }
});

function ensureDirectory(mujoco, path) {
  if (!mujoco.FS.analyzePath(path).exists) {
    mujoco.FS.mkdir(path);
  }
}

async function stageSceneFiles(mujoco, files) {
  ensureDirectory(mujoco, '/working');

  for (const file of files) {
    const parts = file.split('/');
    let current = '/working';
    for (const part of parts.slice(0, -1)) {
      current = `${current}/${part}`;
      ensureDirectory(mujoco, current);
    }

    const response = await fetch(`/examples/scenes/${file}`);
    if (!response.ok) {
      throw new Error(`Failed to load scene asset ${file}: ${response.status}`);
    }
    const target = `/working/${file}`;
    if (/\.(png|stl|skn)$/i.test(file)) {
      mujoco.FS.writeFile(target, new Uint8Array(await response.arrayBuffer()));
    } else {
      mujoco.FS.writeFile(target, await response.text());
    }
  }
}

function getPosition(buffer, index, target, swizzle = true) {
  if (swizzle) {
    return target.set(buffer[index * 3], buffer[index * 3 + 2], -buffer[index * 3 + 1]);
  }
  return target.set(buffer[index * 3], buffer[index * 3 + 1], buffer[index * 3 + 2]);
}

function getQuaternion(buffer, index, target, swizzle = true) {
  if (swizzle) {
    return target.set(
      -buffer[index * 4 + 1],
      -buffer[index * 4 + 3],
      buffer[index * 4 + 2],
      -buffer[index * 4]
    );
  }
  return target.set(buffer[index * 4], buffer[index * 4 + 1], buffer[index * 4 + 2], buffer[index * 4 + 3]);
}

function setSwizzledPosition(target, position) {
  return target.set(position[0] ?? 0, position[2] ?? 0, -(position[1] ?? 0));
}

function setSwizzledQuaternion(target, rotationWxyz) {
  return target.set(
    -(rotationWxyz[1] ?? 0),
    -(rotationWxyz[3] ?? 0),
    rotationWxyz[2] ?? 0,
    -(rotationWxyz[0] ?? 1)
  );
}

function threeVectorToMujoco(values) {
  return [
    Number(values?.x ?? values?.[0] ?? 0),
    -Number(values?.z ?? values?.[2] ?? 0),
    Number(values?.y ?? values?.[1] ?? 0)
  ];
}

function mujocoVectorToThree(values, target = new THREE.Vector3()) {
  const read = (index) => Number(values?.[index] ?? values?.get?.(index) ?? 0);
  return target.set(read(0), read(2), -read(1));
}

function makeDragForceState() {
  return {
    active: false,
    bodyId: null,
    bodyName: null,
    physicsObject: null,
    grabDistance: 0,
    previousControlsEnabled: true,
    localHit: new THREE.Vector3(),
    worldHit: new THREE.Vector3(),
    currentWorld: new THREE.Vector3(),
    force: [0, 0, 0]
  };
}

function clampVectorLength(vector, maxLength) {
  const length = vector.length();
  if (length > maxLength && length > 0) {
    vector.multiplyScalar(maxLength / length);
  }
  return vector;
}

export function hasBodyPositionTrack(payload) {
  const bodyNames = payload?.body_names;
  const bodyPositions = payload?.state?.body_positions;
  return Array.isArray(bodyNames)
    && Array.isArray(bodyPositions)
    && bodyNames.length > 0
    && bodyPositions.length >= bodyNames.length;
}

export function hasJointPositionTrack(payload) {
  const jointNames = payload?.joint_names;
  const jointPositions = payload?.state?.joint_positions;
  return Array.isArray(jointNames)
    && Array.isArray(jointPositions)
    && jointNames.length > 0
    && jointPositions.length >= jointNames.length;
}

function createSimulationWrapper(mujoco, model, data, options = {}) {
  const ownsModel = options.ownsModel !== false;
  const force = new Float64Array(3);
  const torque = new Float64Array(3);
  const point = new Float64Array(3);

  return {
    get qpos() {
      return data.qpos;
    },
    get qvel() {
      return data.qvel;
    },
    get ctrl() {
      return data.ctrl;
    },
    get qfrc_applied() {
      return data.qfrc_applied;
    },
    get xfrc_applied() {
      return data.xfrc_applied;
    },
    get xpos() {
      return data.xpos;
    },
    get xquat() {
      return data.xquat;
    },
    get light_xpos() {
      return data.light_xpos;
    },
    get light_xdir() {
      return data.light_xdir;
    },
    forward() {
      mujoco.mj_forward(model, data);
    },
    step() {
      mujoco.mj_step(model, data);
    },
    resetData() {
      mujoco.mj_resetData(model, data);
    },
    applyForce(fx, fy, fz, tx, ty, tz, px, py, pz, bodyId) {
      force[0] = fx;
      force[1] = fy;
      force[2] = fz;
      torque[0] = tx;
      torque[1] = ty;
      torque[2] = tz;
      point[0] = px;
      point[1] = py;
      point[2] = pz;
      mujoco.mj_applyFT(model, data, force, torque, point, bodyId, data.qfrc_applied);
    },
    free() {
      data?.delete?.();
      if (ownsModel) {
        model?.delete?.();
      }
    }
  };
}

function decodeNames(model, addressArray, count) {
  const textDecoder = new TextDecoder('utf-8');
  const namesArray = new Uint8Array(model.names);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    let start = addressArray[index];
    let end = start;
    while (end < namesArray.length && namesArray[end] !== 0) {
      end += 1;
    }
    names.push(textDecoder.decode(namesArray.subarray(start, end)));
  }
  return names;
}

function readGeomFriction(model, geomId) {
  const friction = model?.geom_friction;
  const offset = Number(geomId) * 3;
  if (!friction || offset + 2 >= friction.length) {
    return [];
  }
  return [
    Number(friction[offset] ?? 0),
    Number(friction[offset + 1] ?? 0),
    Number(friction[offset + 2] ?? 0)
  ];
}

function clonePhysicsOptions(options = {}) {
  return JSON.parse(JSON.stringify(options || {}));
}

function mergePhysicsOptions(defaults, overrides) {
  const base = clonePhysicsOptions(defaults);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return base;
  }
  const merged = { ...base, ...clonePhysicsOptions(overrides) };
  merged.geom_friction = {
    ...(base.geom_friction || {}),
    ...(overrides.geom_friction || {})
  };
  return merged;
}

function resolveSolverValue(mujoco, solver) {
  if (Number.isFinite(Number(solver))) {
    return Number(solver);
  }
  const key = String(solver || '').trim().toUpperCase();
  const solverMap = {
    PGS: mujoco?.mjtSolver?.mjSOL_PGS?.value,
    CG: mujoco?.mjtSolver?.mjSOL_CG?.value,
    NEWTON: mujoco?.mjtSolver?.mjSOL_NEWTON?.value
  };
  return Number.isFinite(Number(solverMap[key])) ? Number(solverMap[key]) : null;
}

function makeGeometry(mujoco, model, geomId, meshes) {
  const type = model.geom_type[geomId];
  const size = [
    model.geom_size[geomId * 3],
    model.geom_size[geomId * 3 + 1],
    model.geom_size[geomId * 3 + 2]
  ];

  if (type === mujoco.mjtGeom.mjGEOM_SPHERE.value) {
    return new THREE.SphereGeometry(size[0], 24, 16);
  }
  if (type === mujoco.mjtGeom.mjGEOM_CAPSULE.value) {
    return new THREE.CapsuleGeometry(size[0], size[1] * 2.0, 16, 16);
  }
  if (type === mujoco.mjtGeom.mjGEOM_CYLINDER.value) {
    return new THREE.CylinderGeometry(size[0], size[0], size[1] * 2.0, 24);
  }
  if (type === mujoco.mjtGeom.mjGEOM_BOX.value) {
    return new THREE.BoxGeometry(size[0] * 2.0, size[2] * 2.0, size[1] * 2.0);
  }
  if (type === mujoco.mjtGeom.mjGEOM_ELLIPSOID.value) {
    const geometry = new THREE.SphereGeometry(1, 24, 16);
    geometry.scale(size[0], size[2], size[1]);
    return geometry;
  }
  if (type === mujoco.mjtGeom.mjGEOM_MESH.value) {
    const meshId = model.geom_dataid[geomId];
    if (meshes[meshId]) {
      return meshes[meshId];
    }
    const geometry = new THREE.BufferGeometry();
    const vertexBuffer = model.mesh_vert.slice(
      model.mesh_vertadr[meshId] * 3,
      (model.mesh_vertadr[meshId] + model.mesh_vertnum[meshId]) * 3
    );
    const normalBuffer = model.mesh_normal.slice(
      model.mesh_vertadr[meshId] * 3,
      (model.mesh_vertadr[meshId] + model.mesh_vertnum[meshId]) * 3
    );
    for (let vertex = 0; vertex < vertexBuffer.length; vertex += 3) {
      const y = vertexBuffer[vertex + 1];
      vertexBuffer[vertex + 1] = vertexBuffer[vertex + 2];
      vertexBuffer[vertex + 2] = -y;
      const normalY = normalBuffer[vertex + 1];
      normalBuffer[vertex + 1] = normalBuffer[vertex + 2];
      normalBuffer[vertex + 2] = -normalY;
    }
    const faceBuffer = model.mesh_face.slice(
      model.mesh_faceadr[meshId] * 3,
      (model.mesh_faceadr[meshId] + model.mesh_facenum[meshId]) * 3
    );
    geometry.setAttribute('position', new THREE.BufferAttribute(vertexBuffer, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normalBuffer, 3));
    geometry.setIndex(Array.from(faceBuffer));
    meshes[meshId] = geometry;
    return geometry;
  }
  return new THREE.SphereGeometry(size[0] || 0.02, 12, 8);
}

function arrayIsZeroFilled(values) {
  if (!values || values.length === 0) {
    return true;
  }
  for (const value of values) {
    if (Array.isArray(value)) {
      if (!arrayIsZeroFilled(value)) {
        return false;
      }
    } else if (Math.abs(Number(value) || 0) > 1e-8) {
      return false;
    }
  }
  return true;
}

function clampControl(model, actuatorIndex, value) {
  const range = model?.actuator_ctrlrange;
  if (!range || range.length < (actuatorIndex + 1) * 2) {
    return value;
  }
  const min = range[actuatorIndex * 2];
  const max = range[actuatorIndex * 2 + 1];
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return value;
  }
  return Math.min(Math.max(value, min), max);
}

function clampSymmetricLimit(value, limit) {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) {
    return value;
  }
  return Math.min(Math.max(value, -max), max);
}

function zeroArray(values) {
  if (!values) {
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    values[index] = 0;
  }
}

function writePayloadToSimulation(simulation, payload, jointAddressByName = new Map()) {
  if (!simulation || !payload?.state) {
    return false;
  }
  return writePayloadToQpos(simulation.qpos, payload, jointAddressByName);
}

function writePayloadToQpos(qpos, payload, jointAddressByName = new Map()) {
  if (!qpos || !payload?.state) {
    return false;
  }
  const state = payload.state;
  const root = state.root_translation || [0, 0, 0.78];
  const quat = state.root_rotation_wxyz || [1, 0, 0, 0];
  qpos[0] = root[0] ?? 0;
  qpos[1] = root[1] ?? 0;
  qpos[2] = root[2] ?? 0.78;
  qpos[3] = quat[0] ?? 1;
  qpos[4] = quat[1] ?? 0;
  qpos[5] = quat[2] ?? 0;
  qpos[6] = quat[3] ?? 0;

  const names = payload.joint_names || [];
  const values = payload.state.joint_positions || [];
  for (let index = 0; index < names.length; index += 1) {
    const address = jointAddressByName.get(names[index]);
    if (address !== undefined && address < qpos.length) {
      qpos[address] = Number(values[index] ?? 0);
    }
  }
  return true;
}

function applyPdControlStep({
  simulation,
  model,
  jointNames = [],
  targets = [],
  kp = [],
  kd = [],
  torqueLimits = [],
  jointAddressByName = new Map(),
  jointVelocityAddressByName = new Map(),
  actuatorAddressByJointName = new Map(),
  defaultKp = 35,
  defaultKd = 1.5
}) {
  const count = Math.min(jointNames.length, targets.length);
  for (let index = 0; index < count; index += 1) {
    const jointName = jointNames[index];
    const qposAddress = jointAddressByName?.get(jointName) ?? 7 + index;
    const qvelAddress = jointVelocityAddressByName?.get(jointName) ?? 6 + index;
    const ctrlAddress = actuatorAddressByJointName?.get(jointName) ?? index;
    if (
      qposAddress >= simulation.qpos.length
      || qvelAddress >= simulation.qvel.length
      || ctrlAddress >= (simulation.ctrl?.length ?? 0)
    ) {
      continue;
    }
    const stiffness = Number(kp[index] ?? defaultKp);
    const damping = Number(kd[index] ?? defaultKd);
    const torque = stiffness * (Number(targets[index] ?? 0) - simulation.qpos[qposAddress])
      - damping * simulation.qvel[qvelAddress];
    simulation.ctrl[ctrlAddress] = clampControl(
      model,
      ctrlAddress,
      clampSymmetricLimit(torque, torqueLimits[index])
    );
  }
}

function readSimulationState({
  simulation,
  jointNames = [],
  jointNamesMJC = [],
  jointAddressByName = new Map(),
  jointVelocityAddressByName = new Map()
} = {}) {
  const qpos = simulation?.qpos;
  const qvel = simulation?.qvel;
  if (!qpos || !qvel) {
    return null;
  }
  const names = jointNames.length ? jointNames : (jointNamesMJC || []);
  const jointPositions = [];
  const jointVelocities = [];
  for (let index = 0; index < names.length; index += 1) {
    const qposAddress = jointAddressByName?.get(names[index]) ?? 7 + index;
    const qvelAddress = jointVelocityAddressByName?.get(names[index]) ?? 6 + index;
    jointPositions.push(Number(qpos[qposAddress] ?? 0));
    jointVelocities.push(Number(qvel[qvelAddress] ?? 0));
  }
  return {
    timestamp: (globalThis.performance?.now?.() ?? Date.now()) / 1000,
    root_translation: [Number(qpos[0] ?? 0), Number(qpos[1] ?? 0), Number(qpos[2] ?? 0.78)],
    root_rotation_wxyz: [Number(qpos[3] ?? 1), Number(qpos[4] ?? 0), Number(qpos[5] ?? 0), Number(qpos[6] ?? 0)],
    root_linear_velocity: [Number(qvel[0] ?? 0), Number(qvel[1] ?? 0), Number(qvel[2] ?? 0)],
    root_angular_velocity: [Number(qvel[3] ?? 0), Number(qvel[4] ?? 0), Number(qvel[5] ?? 0)],
    joint_positions: jointPositions,
    joint_velocities: jointVelocities
  };
}

function physicsDecimationForModel(model, targetControlDt = 0.02) {
  const timestep = Number(model?.opt?.timestep ?? 0);
  if (!Number.isFinite(timestep) || timestep <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(Number(targetControlDt) / timestep));
}

function roundVector(vector, digits = 6) {
  vector.set(
    Number(vector.x.toFixed(digits)),
    Number(vector.y.toFixed(digits)),
    Number(vector.z.toFixed(digits))
  );
  return vector;
}

function classifyFootSide(bodyNames = []) {
  const names = bodyNames.map((name) => String(name || '').toLowerCase());
  const isFootName = (name) => /(ankle|foot|sole|toe)/.test(name);
  if (names.some((name) => name.includes('left') && isFootName(name))) {
    return 'left';
  }
  if (names.some((name) => name.includes('right') && isFootName(name))) {
    return 'right';
  }
  return 'other';
}

function emptyFootContact() {
  return {
    active: false,
    normalForce: 0,
    tangentForce: 0,
    pointCount: 0,
    slipping: false
  };
}

function createContactForceBuffer(mujoco) {
  if (typeof mujoco?.DoubleBuffer !== 'function') {
    return null;
  }
  try {
    return new mujoco.DoubleBuffer(6);
  } catch {
    return null;
  }
}

function contactForceBufferView(buffer) {
  const view = buffer?.GetView?.();
  return view && typeof view.length === 'number' ? view : null;
}

function readContactForceInto({ mujoco, model, data, index, target, buffer = null } = {}) {
  zeroArray(target);
  if (typeof mujoco?.mj_contactForce !== 'function') {
    return target;
  }

  const bufferView = contactForceBufferView(buffer);
  if (buffer && bufferView) {
    zeroArray(bufferView);
    try {
      mujoco.mj_contactForce(model, data, index, buffer);
      for (let forceIndex = 0; forceIndex < target.length; forceIndex += 1) {
        target[forceIndex] = Number(bufferView[forceIndex] ?? 0);
      }
      return target;
    } catch {
      zeroArray(target);
    }
  }

  try {
    mujoco.mj_contactForce(model, data, index, target);
  } catch {
    zeroArray(target);
  }
  return target;
}

function pushFootContact(summary, side, point) {
  const target = side === 'left'
    ? summary.leftFoot
    : side === 'right'
      ? summary.rightFoot
      : null;
  if (!target) {
    return;
  }
  target.active = target.active || point.active;
  target.normalForce += point.normalForce;
  target.tangentForce += point.tangentForce;
  target.pointCount += 1;
  target.slipping = target.slipping || point.slipping;
}

function safeContactCount(data, model) {
  const rawCount = Number(data?.ncon ?? 0);
  if (!Number.isFinite(rawCount) || rawCount <= 0) {
    return 0;
  }
  const contactCount = Math.floor(rawCount);
  const modelLimit = Number(model?.nconmax ?? 0);
  if (Number.isFinite(modelLimit) && modelLimit > 0 && contactCount > modelLimit) {
    return 0;
  }
  if (contactCount > CONTACT_SUMMARY_MAX_CONTACTS) {
    return 0;
  }
  return contactCount;
}

function readContactSummaryFromData({ mujoco, model, data, bodyNames = [] } = {}) {
  const contactCount = safeContactCount(data, model);
  const summary = {
    count: 0,
    leftFoot: emptyFootContact(),
    rightFoot: emptyFootContact(),
    points: []
  };
  if (!contactCount || !model) {
    return summary;
  }

  let contacts = null;
  try {
    contacts = data?.contact;
  } catch {
    return summary;
  }
  if (typeof contacts?.get !== 'function') {
    contacts?.delete?.();
    return summary;
  }

  const force = new Float64Array(6);
  const contactForceBuffer = createContactForceBuffer(mujoco);
  const position = new THREE.Vector3();
  try {
    for (let index = 0; index < contactCount; index += 1) {
      const contact = contacts.get(index);
      if (!contact) {
        continue;
      }
      try {
        readContactForceInto({ mujoco, model, data, index, target: force, buffer: contactForceBuffer });
        const geomIds = [Number(contact.geom1 ?? contact.geom?.[0] ?? -1), Number(contact.geom2 ?? contact.geom?.[1] ?? -1)];
        const bodyIds = geomIds.map((geomId) => Number(model?.geom_bodyid?.[geomId] ?? -1));
        const names = bodyIds.map((bodyId) => bodyNames?.[bodyId] || `body_${bodyId}`);
        const normalForce = Math.max(0, Number(force[0] ?? 0));
        const tangentForce = Math.hypot(Number(force[1] ?? 0), Number(force[2] ?? 0));
        const side = classifyFootSide(names);
        const friction = Math.max(
          ...geomIds.map((geomId) => Number(model?.geom_friction?.[geomId * 3] ?? contact.friction?.[0] ?? 0)),
          0
        );
        mujocoVectorToThree(contact.pos, position);
        const point = {
          index,
          side,
          active: normalForce > 1e-6,
          normalForce,
          tangentForce,
          slipping: normalForce > 1e-6 && friction > 0 && tangentForce > normalForce * friction * 0.85,
          position: [position.x, position.y, position.z],
          geomIds,
          bodyIds,
          bodyNames: names
        };
        summary.points.push(point);
        pushFootContact(summary, side, point);
      } finally {
        contact?.delete?.();
      }
    }
  } finally {
    contactForceBuffer?.delete?.();
    contacts?.delete?.();
  }
  summary.count = summary.points.length;
  return summary;
}

function applyPhysicsOptionsToModel({ mujoco, model, geomIdByName }, physicsOptions) {
  const timestep = Number(physicsOptions.timestep);
  if (Number.isFinite(timestep) && timestep > 0 && model.opt) {
    model.opt.timestep = timestep;
  }

  const solver = resolveSolverValue(mujoco, physicsOptions.solver);
  if (solver !== null && model.opt) {
    model.opt.solver = solver;
  }

  for (const [name, values] of Object.entries(physicsOptions.geom_friction || {})) {
    const geomId = geomIdByName?.get(name);
    if (geomId === undefined || !model.geom_friction) {
      continue;
    }
    const offset = geomId * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(values?.[axis]);
      if (Number.isFinite(value) && offset + axis < model.geom_friction.length) {
        model.geom_friction[offset + axis] = value;
      }
    }
  }
}

function recordingMimeType(preferredType = null) {
  const candidates = [
    preferredType,
    'video/mp4',
    'video/mp4;codecs=avc1.42E01E',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ].filter(Boolean);
  const recorder = globalThis.MediaRecorder;
  if (!recorder?.isTypeSupported) {
    return candidates[0] || 'video/webm';
  }
  return candidates.find((candidate) => recorder.isTypeSupported(candidate)) || 'video/webm';
}

function buildActuatorAddressByJointName(model, mujoco, jointNames) {
  const actuatorAddressByJointName = new Map();
  const jointTransmission = mujoco?.mjtTrn?.mjTRN_JOINT?.value;
  const actuatorTransmissionTypes = model?.actuator_trntype;
  const actuatorJointIds = model?.actuator_trnid;
  if (!model || !actuatorTransmissionTypes || !actuatorJointIds || jointTransmission === undefined) {
    return actuatorAddressByJointName;
  }

  for (let actuatorIndex = 0; actuatorIndex < model.nu; actuatorIndex += 1) {
    if (actuatorTransmissionTypes[actuatorIndex] !== jointTransmission) {
      continue;
    }
    const jointIndex = actuatorJointIds[actuatorIndex * 2];
    const jointName = jointNames[jointIndex];
    if (jointName) {
      actuatorAddressByJointName.set(jointName, actuatorIndex);
    }
  }
  return actuatorAddressByJointName;
}

export function createMaterialResources(model, geomId) {
  let color = [
    model.geom_rgba[geomId * 4],
    model.geom_rgba[geomId * 4 + 1],
    model.geom_rgba[geomId * 4 + 2],
    model.geom_rgba[geomId * 4 + 3]
  ];
  let texture = undefined;
  const materialId = model.geom_matid[geomId];
  if (materialId !== -1) {
    color = [
      model.mat_rgba[materialId * 4],
      model.mat_rgba[materialId * 4 + 1],
      model.mat_rgba[materialId * 4 + 2],
      model.mat_rgba[materialId * 4 + 3]
    ];

    const mjNTEXROLE = 10;
    const mjTEXROLE_RGB = 1;
    const textureId = model.mat_texid[(materialId * mjNTEXROLE) + mjTEXROLE_RGB];
    if (textureId !== -1) {
      const width = model.tex_width[textureId];
      const height = model.tex_height[textureId];
      const offset = model.tex_adr[textureId];
      const channels = model.tex_nchannel[textureId];
      const rgba = new Uint8Array(width * height * 4);

      for (let pixel = 0; pixel < width * height; pixel += 1) {
        const source = offset + pixel * channels;
        const target = pixel * 4;
        rgba[target] = model.tex_data[source];
        rgba[target + 1] = channels > 1 ? model.tex_data[source + 1] : rgba[target];
        rgba[target + 2] = channels > 2 ? model.tex_data[source + 2] : rgba[target];
        rgba[target + 3] = channels > 3 ? model.tex_data[source + 3] : 255;
      }

      texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
      texture.repeat = new THREE.Vector2(
        model.mat_texrepeat[materialId * 2],
        model.mat_texrepeat[materialId * 2 + 1]
      );
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;
    }
  }

  return {
    color: new THREE.Color(color[0], color[1], color[2]),
    opacity: color[3],
    texture
  };
}

function makeMaterial(model, geomId) {
  const materialResources = createMaterialResources(model, geomId);
  const materialId = model.geom_matid[geomId];
  const materialOptions = {
    color: materialResources.color,
    transparent: materialResources.opacity < 1.0,
    opacity: materialResources.opacity,
    specularIntensity: materialId !== -1 ? model.mat_specular[materialId] : undefined,
    reflectivity: materialId !== -1 ? model.mat_reflectance[materialId] : undefined,
    roughness: materialId !== -1 ? Math.max(0, 1.0 - model.mat_shininess[materialId]) : undefined,
    metalness: materialId !== -1 ? model.mat_metallic[materialId] : undefined
  };
  if (materialResources.texture) {
    materialOptions.map = materialResources.texture;
  }
  return new THREE.MeshPhysicalMaterial(materialOptions);
}

export function makePlaneMesh(texture) {
  const mesh = new Reflector(new THREE.PlaneGeometry(100, 100), {
    clipBias: 0.003,
    texture,
    textureWidth: 512,
    textureHeight: 512,
    multisample: 2
  });
  mesh.rotateX(-Math.PI / 2);
  mesh.material.depthWrite = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  return mesh;
}

async function loadScene(mujoco, scenePath, parent) {
  if (parent.simulation) {
    parent.simulation.free();
  }

  const model = mujoco.MjModel.loadFromXML(`/working/${scenePath}`);
  const data = new mujoco.MjData(model);
  const simulation = createSimulationWrapper(mujoco, model, data);
  const bodyNames = decodeNames(model, model.name_bodyadr, model.nbody);

  const root = new THREE.Group();
  root.name = 'MuJoCo Root';
  parent.scene.add(root);

  const bodies = {};
  const meshes = {};
  const lights = [];

  for (let geomId = 0; geomId < model.ngeom; geomId += 1) {
    if (!(model.geom_group[geomId] < 3)) {
      continue;
    }
    const bodyId = model.geom_bodyid[geomId];
    if (!bodies[bodyId]) {
      bodies[bodyId] = new THREE.Group();
      bodies[bodyId].name = bodyNames[bodyId] || `body_${bodyId}`;
      bodies[bodyId].bodyID = bodyId;
    }

    const type = model.geom_type[geomId];
    let mesh;
    if (type === mujoco.mjtGeom.mjGEOM_PLANE.value) {
      mesh = makePlaneMesh(createMaterialResources(model, geomId).texture);
    } else {
      mesh = new THREE.Mesh(makeGeometry(mujoco, model, geomId, meshes), makeMaterial(model, geomId));
    }
    mesh.castShadow = VIEWER_SHADOWS_ENABLED && geomId !== 0;
    mesh.receiveShadow = VIEWER_SHADOWS_ENABLED;
    mesh.bodyID = bodyId;
    getPosition(model.geom_pos, geomId, mesh.position);
    if (type !== mujoco.mjtGeom.mjGEOM_PLANE.value) {
      getQuaternion(model.geom_quat, geomId, mesh.quaternion);
    }
    bodies[bodyId].add(mesh);
  }

  for (let bodyId = 0; bodyId < model.nbody; bodyId += 1) {
    if (!bodies[bodyId]) {
      bodies[bodyId] = new THREE.Group();
      bodies[bodyId].name = bodyNames[bodyId] || `body_${bodyId}`;
      bodies[bodyId].bodyID = bodyId;
    }
    if (bodyId === 0 || !bodies[0]) {
      root.add(bodies[bodyId]);
    } else {
      bodies[0].add(bodies[bodyId]);
    }
  }

  const sunlight = new THREE.DirectionalLight(0xffffff, 2.4);
  sunlight.position.set(4, 8, 5);
  sunlight.shadow.mapSize.width = 1024;
  sunlight.shadow.mapSize.height = 1024;
  sunlight.shadow.camera.near = 0.1;
  sunlight.shadow.camera.far = 12;
  sunlight.castShadow = VIEWER_SHADOWS_ENABLED;
  root.add(sunlight);
  lights.push(sunlight);

  return { model, data, simulation, bodies, lights, bodyNames, modelRoot: root };
}

export class BrowserMujocoViewer {
  constructor(container, statusCallback = () => {}) {
    this.container = container;
    this.statusCallback = statusCallback;
    this.mujoco = null;
    this.model = null;
    this.data = null;
    this.simulation = null;
    this.bodies = {};
    this.bodyIdByName = new Map();
    this.modelRoot = null;
    this.highDetailBodies = [];
    this.bodyTrackPositions = [];
    this.referenceOverlayEnabled = false;
    this.referenceOverlay = null;
    this.referenceOverlayBodies = {};
    this.referenceOverlayMaterials = [];
    this.referenceOverlayQpos = null;
    this.referenceOverlayXpos = null;
    this.referenceOverlayXquat = null;
    this.referenceOverlayData = null;
    this.referenceBodyTrackPositions = [];
    this.referenceOverlays = {};
    this.jointAddressByName = new Map();
    this.jointVelocityAddressByName = new Map();
    this.actuatorAddressByJointName = new Map();
    this.geomIdByName = new Map();
    this.defaultPhysicsOptions = null;
    this.currentPhysicsOptionsSignature = '';
    this.lastFrameKey = null;
    this.followEnabled = true;
    this.followHeight = 0.75;
    this.followBodyId = null;
    this.followDesired = new THREE.Vector3();
    this.followTarget = new THREE.Vector3();
    this.followDelta = new THREE.Vector3();
    this.followInitialized = false;
    this.disposed = false;
    this.renderRequested = false;
    this.lastRenderTime = 0;
    this.activeImpulse = null;
    this.physicsInteractionEnabled = false;
    this.dragForce = makeDragForceState();
    this.contactMarkersEnabled = true;
    this.contactMarkerGroup = new THREE.Group();
    this.contactMarkerGroup.name = 'Contact Force Markers';
    this.contactMarkerPool = [];
    this.recording = null;
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x263f59);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    this.camera.position.set(3.0, 2.2, 3.0);
    this.scene.add(this.camera);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.16));
    this.renderer = new THREE.WebGLRenderer(RENDERER_OPTIONS);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, VIEWER_PIXEL_RATIO_LIMIT));
    this.renderer.shadowMap.enabled = VIEWER_SHADOWS_ENABLED;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.75, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.handleControlsChange = () => this.requestRender();
    this.controls.addEventListener('change', this.handleControlsChange);
    this.controls.update();

    this.dragForceArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 0),
      1,
      DRAG_FORCE_ARROW_COLOR
    );
    this.dragForceArrow.line.material.transparent = true;
    this.dragForceArrow.cone.material.transparent = true;
    this.dragForceArrow.line.material.opacity = 0.85;
    this.dragForceArrow.cone.material.opacity = 0.85;
    this.dragForceArrow.visible = false;
    this.scene.add(this.dragForceArrow);
    this.scene.add(this.contactMarkerGroup);

    this.handlePointerDown = (event) => this.beginDragForce(event);
    this.handlePointerMove = (event) => this.moveDragForce(event);
    this.handlePointerUp = () => this.endDragForce();
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown, true);
    document.addEventListener('pointermove', this.handlePointerMove, true);
    document.addEventListener('pointerup', this.handlePointerUp, true);
    document.addEventListener('pointercancel', this.handlePointerUp, true);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.renderer.setAnimationLoop(this.render.bind(this));
  }

  async init(sceneManifest) {
    this.statusCallback('Loading MuJoCo WASM...');
    this.mujoco = await loadMujoco();
    this.mujoco.FS.mkdir('/working');
    this.mujoco.FS.mount(this.mujoco.MEMFS, { root: '.' }, '/working');
    this.statusCallback('Staging G1 scene assets...');
    await stageSceneFiles(this.mujoco, sceneManifest.files);
    this.statusCallback('Building Three.js scene...');
    const loaded = await loadScene(this.mujoco, sceneManifest.scene_path, this);
    Object.assign(this, loaded);
    this.bodyIdByName = new Map(this.bodyNames.map((name, index) => [name, index]));
    this.geomNamesMJC = decodeNames(this.model, this.model.name_geomadr, this.model.ngeom);
    this.geomIdByName = new Map(this.geomNamesMJC.map((name, index) => [name, index]));
    this.followBodyId = this.bodyIdByName.get('pelvis') ?? this.bodyIdByName.get('base') ?? (this.model.nbody > 1 ? 1 : 0);
    this.followInitialized = false;
    this.highDetailBodies = Object.entries(this.bodies)
      .filter(([bodyId]) => Number(bodyId) > 0)
      .map(([, body]) => body);
    this.jointNamesMJC = decodeNames(this.model, this.model.name_jntadr, this.model.njnt);
    this.jointAddressByName = new Map(
      this.jointNamesMJC.map((name, index) => [name, this.model.jnt_qposadr[index]])
    );
    this.jointVelocityAddressByName = new Map(
      this.jointNamesMJC.map((name, index) => [name, this.model.jnt_dofadr[index]])
    );
    this.actuatorAddressByJointName = buildActuatorAddressByJointName(this.model, this.mujoco, this.jointNamesMJC);
    this.defaultPhysicsOptions = this.capturePhysicsOptions();
    this.applyDefaultPose();
    this.requestRender();
    this.statusCallback('Browser MuJoCo viewer ready');
  }

  applyDefaultPose() {
    if (!this.simulation) {
      return;
    }
    this.simulation.forward();
    this.syncBodies();
    this.requestRender();
  }

  capturePhysicsOptions() {
    const geomFriction = {};
    for (const name of ['floor']) {
      const geomId = this.geomIdByName?.get(name);
      if (geomId !== undefined) {
        geomFriction[name] = readGeomFriction(this.model, geomId);
      }
    }
    return {
      timestep: Number(this.model?.opt?.timestep ?? 0.002),
      solver: Number(this.model?.opt?.solver ?? 2),
      geom_friction: geomFriction
    };
  }

  configurePhysics(options = null) {
    if (!this.model) {
      return;
    }
    if (!this.defaultPhysicsOptions) {
      this.defaultPhysicsOptions = this.capturePhysicsOptions();
    }
    const physicsOptions = mergePhysicsOptions(this.defaultPhysicsOptions, options);
    const signature = JSON.stringify(physicsOptions);
    if (signature === this.currentPhysicsOptionsSignature) {
      return;
    }
    this.currentPhysicsOptionsSignature = signature;
    applyPhysicsOptionsToModel(this, physicsOptions);
  }

  applyState(payload) {
    if (!this.simulation || !payload?.state) {
      return;
    }
    const frameKey = `${payload.sequence_id}:${payload.frame_index}:${payload.state.timestamp}`;
    if (frameKey === this.lastFrameKey) {
      return;
    }
    this.lastFrameKey = frameKey;
    writePayloadToSimulation(this.simulation, payload, this.jointAddressByName);
    if (hasJointPositionTrack(payload) || !hasBodyPositionTrack(payload) || !this.canApplyNamedBodyTrack(payload)) {
      this.setHighDetailVisible(true);
      this.simulation.forward();
      this.syncBodies();
    } else {
      this.setHighDetailVisible(true);
      this.syncBodyPositionTrack(payload);
    }
    this.requestRender();
  }

  normalizeReferenceOverlayKey(key = 'global') {
    return key === 'relative' ? 'relative' : 'global';
  }

  referenceOverlayStyle(key = 'global') {
    return REFERENCE_OVERLAY_STYLES[this.normalizeReferenceOverlayKey(key)] || REFERENCE_OVERLAY_STYLES.global;
  }

  ensureReferenceOverlay(key = 'global') {
    const overlayKey = this.normalizeReferenceOverlayKey(key);
    if (!this.referenceOverlays) {
      this.referenceOverlays = {};
    }
    if (this.referenceOverlays?.[overlayKey]?.group || !this.modelRoot || !this.model) {
      return this.referenceOverlays?.[overlayKey]?.group || null;
    }
    const style = this.referenceOverlayStyle(overlayKey);
    const overlay = new THREE.Group();
    overlay.name = style.name;
    overlay.visible = false;
    const bodies = {};
    const materials = [];

    for (let bodyId = 0; bodyId < this.model.nbody; bodyId += 1) {
      const sourceBody = this.bodies?.[bodyId];
      const ghostBody = new THREE.Group();
      ghostBody.name = `${overlayKey}_reference_${sourceBody?.name || this.bodyNames?.[bodyId] || `body_${bodyId}`}`;
      ghostBody.bodyID = bodyId;
      ghostBody.visible = bodyId > 0;
      bodies[bodyId] = ghostBody;
      if (bodyId === 0) {
        overlay.add(ghostBody);
      } else {
        overlay.add(ghostBody);
      }

      sourceBody?.traverse?.((child) => {
        if (!child.isMesh || child.isReflector) {
          return;
        }
        const material = new THREE.MeshBasicMaterial({
          color: style.color,
          transparent: true,
          opacity: style.opacity,
          depthWrite: false
        });
        const mesh = new THREE.Mesh(child.geometry, material);
        mesh.position.copy(child.position);
        mesh.quaternion.copy(child.quaternion);
        mesh.scale.copy(child.scale);
        mesh.renderOrder = 4;
        ghostBody.add(mesh);
        materials.push(material);
      });
    }

    this.referenceOverlays[overlayKey] = {
      group: overlay,
      bodies,
      materials,
      qpos: null,
      xpos: null,
      xquat: null,
      data: null,
      bodyTrackPositions: []
    };
    if (overlayKey === 'global') {
      this.referenceOverlay = overlay;
      this.referenceOverlayBodies = bodies;
      this.referenceOverlayMaterials = materials;
    }
    this.modelRoot.add(overlay);
    return overlay;
  }

  setReferenceOverlayEnabled(enabled, key = 'global') {
    const overlayKey = this.normalizeReferenceOverlayKey(key);
    const nextEnabled = Boolean(enabled);
    if (overlayKey === 'global') {
      this.referenceOverlayEnabled = nextEnabled;
    }
    const overlay = this.ensureReferenceOverlay(overlayKey);
    const record = this.referenceOverlays?.[overlayKey];
    if (record) {
      record.enabled = nextEnabled;
    }
    if (overlay) {
      overlay.visible = nextEnabled;
      this.requestRender?.();
    }
  }

  updateReferenceOverlay(payload, key = 'global') {
    const overlayKey = this.normalizeReferenceOverlayKey(key);
    const record = this.referenceOverlays?.[overlayKey];
    const enabled = overlayKey === 'global'
      ? this.referenceOverlayEnabled
      : record?.enabled;
    if (!enabled || !payload?.state) {
      return false;
    }
    const overlay = this.ensureReferenceOverlay(overlayKey);
    if (!overlay) {
      return false;
    }
    overlay.visible = true;
    if (hasJointPositionTrack(payload) || !hasBodyPositionTrack(payload) || !this.canApplyNamedReferenceBodyTrack(payload)) {
      this.updateReferenceOverlayFromJoints(payload, overlayKey);
    } else {
      this.syncReferenceBodyPositionTrack(payload, overlayKey);
    }
    this.requestRender?.();
    return true;
  }

  updateReferenceOverlayFromJoints(payload, key = 'global') {
    if (!this.model) {
      return;
    }
    const overlayKey = this.normalizeReferenceOverlayKey(key);
    const record = this.referenceOverlays?.[overlayKey] || {};
    if (this.mujoco?.MjData && !record.data) {
      record.data = new this.mujoco.MjData(this.model);
    }
    const qpos = record.data?.qpos || record.qpos;
    if (!qpos || qpos.length !== (this.simulation?.qpos?.length ?? this.model.nq ?? 0)) {
      record.qpos = new Float64Array(this.simulation?.qpos?.length ?? this.model.nq ?? 0);
    }
    const targetQpos = record.data?.qpos || record.qpos;
    writePayloadToQpos(targetQpos, payload, this.jointAddressByName);
    this.referenceOverlays[overlayKey] = record;
    if (record.data) {
      this.mujoco.mj_forward(this.model, record.data);
      this.syncReferenceOverlayBodies(record.data.xpos, record.data.xquat, overlayKey);
      return;
    }

    const xpos = record.xpos || new Float64Array((this.model.nbody || 0) * 3);
    const xquat = record.xquat || new Float64Array((this.model.nbody || 0) * 4);
    record.xpos = xpos;
    record.xquat = xquat;
    this.writeFallbackReferenceRootPose(payload, xpos, xquat);
    this.syncReferenceOverlayBodies(xpos, xquat, overlayKey);
  }

  writeFallbackReferenceRootPose(payload, xpos, xquat) {
    const root = payload.state.root_translation || [0, 0, 0.78];
    const quat = payload.state.root_rotation_wxyz || [1, 0, 0, 0];
    for (let bodyId = 0; bodyId < this.model.nbody; bodyId += 1) {
      xpos[bodyId * 3] = root[0] ?? 0;
      xpos[bodyId * 3 + 1] = root[1] ?? 0;
      xpos[bodyId * 3 + 2] = root[2] ?? 0.78;
      xquat[bodyId * 4] = quat[0] ?? 1;
      xquat[bodyId * 4 + 1] = quat[1] ?? 0;
      xquat[bodyId * 4 + 2] = quat[2] ?? 0;
      xquat[bodyId * 4 + 3] = quat[3] ?? 0;
    }
  }

  syncReferenceOverlayBodies(xpos, xquat, key = 'global') {
    const overlayKey = this.normalizeReferenceOverlayKey(key);
    const bodies = this.referenceOverlays?.[overlayKey]?.bodies || this.referenceOverlayBodies;
    for (let bodyId = 0; bodyId < this.model.nbody; bodyId += 1) {
      const body = bodies?.[bodyId];
      if (!body) {
        continue;
      }
      getPosition(xpos, bodyId, body.position);
      getQuaternion(xquat, bodyId, body.quaternion);
      body.updateWorldMatrix?.();
    }
  }

  canApplyNamedReferenceBodyTrack(payload) {
    if (arrayIsZeroFilled(payload?.state?.body_positions)) {
      return false;
    }
    return payload.body_names?.some((bodyName) => this.bodyIdByName?.has(bodyName));
  }

  syncReferenceBodyPositionTrack(payload, key = 'global') {
    const overlayKey = this.normalizeReferenceOverlayKey(key);
    const record = this.referenceOverlays?.[overlayKey] || {};
    const state = payload.state;
    const root = new THREE.Vector3();
    const rootQuaternion = new THREE.Quaternion();
    setSwizzledPosition(root, state.root_translation || [0, 0, 0.78]);
    setSwizzledQuaternion(rootQuaternion, state.root_rotation_wxyz || [1, 0, 0, 0]);

    const bodyPositions = state.body_positions || [];
    const bodyRotations = state.body_rotations_wxyz || [];
    if (!record.bodyTrackPositions) {
      record.bodyTrackPositions = [];
    }
    const tempPosition = new THREE.Vector3();
    const tempQuaternion = new THREE.Quaternion();
    for (let trackIndex = 0; trackIndex < bodyPositions.length; trackIndex += 1) {
      const bodyName = payload.body_names[trackIndex];
      const bodyId = this.bodyIdByName?.get(bodyName);
      const body = record.bodies?.[bodyId] || this.referenceOverlayBodies?.[bodyId];
      const position = bodyPositions[trackIndex];
      if (!position) {
        continue;
      }
      setSwizzledPosition(tempPosition, position);
      tempPosition.applyQuaternion(rootQuaternion).add(root);
      if (!record.bodyTrackPositions[trackIndex]) {
        record.bodyTrackPositions[trackIndex] = new THREE.Vector3();
      }
      record.bodyTrackPositions[trackIndex].copy(tempPosition);

      if (!body) {
        continue;
      }
      body.position.copy(tempPosition);

      const rotation = bodyRotations[trackIndex];
      if (rotation) {
        setSwizzledQuaternion(tempQuaternion, rotation);
        body.quaternion.copy(rootQuaternion).multiply(tempQuaternion);
      } else if (trackIndex === 0) {
        body.quaternion.copy(rootQuaternion);
      }
      body.updateWorldMatrix?.();
    }
    this.referenceOverlays[overlayKey] = record;
    if (overlayKey === 'global') {
      this.referenceBodyTrackPositions = record.bodyTrackPositions;
    }
  }

  resetPhysics(payload) {
    if (!this.simulation) {
      return;
    }
    this.simulation.resetData?.();
    this.lastFrameKey = null;
    const normalizedPayload = payload?.state
      ? payload
      : {
          sequence_id: 'physics_reset',
          frame_index: 0,
          joint_names: this.jointNamesMJC || [],
          body_names: this.bodyNames || [],
          state: payload
        };
    this.applyState(normalizedPayload);
    zeroArray(this.simulation.ctrl);
    zeroArray(this.simulation.qfrc_applied);
    this.activeImpulse = null;
    this.endDragForce();
  }

  stepPhysics(options = {}) {
    if (!this.simulation || !this.model) {
      return null;
    }
    this.configurePhysics(options.physics_options);
    const steps = Math.max(1, Math.floor(options.steps ?? 1));
    const jointNames = options.joint_names || [];
    const targets = options.joint_positions || [];
    const kp = options.kp || [];
    const kd = options.kd || [];
    const torqueLimits = options.torque_limits || [];
    const now = Number(options.now ?? performance.now());
    this.setPhysicsInteractionEnabled(true);

    for (let step = 0; step < steps; step += 1) {
      zeroArray(this.simulation.ctrl);
      zeroArray(this.simulation.qfrc_applied);
      this.applyActiveImpulse(now);
      this.applyDragForce();

      applyPdControlStep({
        simulation: this.simulation,
        model: this.model,
        jointNames,
        targets,
        kp,
        kd,
        torqueLimits,
        jointAddressByName: this.jointAddressByName,
        jointVelocityAddressByName: this.jointVelocityAddressByName,
        actuatorAddressByJointName: this.actuatorAddressByJointName,
        defaultKp: options.defaultKp ?? 35,
        defaultKd: options.defaultKd ?? 1.5
      });

      this.simulation.step();
    }

    this.simulation.forward();
    this.syncBodies();
    this.requestRender();
    return this.readState(jointNames);
  }

  setPhysicsInteractionEnabled(enabled) {
    this.physicsInteractionEnabled = Boolean(enabled);
    if (!this.physicsInteractionEnabled) {
      this.endDragForce();
    }
  }

  updatePointerRay(clientX, clientY) {
    const rect = this.renderer?.domElement?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) {
      return false;
    }
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  pickDragBody(event) {
    if (!this.updatePointerRay(event.clientX, event.clientY)) {
      return null;
    }
    const intersects = this.raycaster.intersectObjects(this.modelRoot ? [this.modelRoot] : this.scene.children, true);
    return intersects.find((intersect) => intersect.object?.bodyID !== undefined) || null;
  }

  beginDragForce(event) {
    if (!this.physicsInteractionEnabled || !this.simulation) {
      return;
    }
    const hit = this.pickDragBody(event);
    if (!hit?.object || hit.object.bodyID === undefined || Number(hit.object.bodyID) <= 0) {
      return;
    }
    event.preventDefault?.();
    const bodyId = Number(hit.object.bodyID);
    const body = this.bodies[bodyId];
    this.dragForce.active = true;
    this.dragForce.bodyId = bodyId;
    this.dragForce.bodyName = body?.name || this.bodyNames?.[bodyId] || `body_${bodyId}`;
    this.dragForce.physicsObject = hit.object;
    this.dragForce.grabDistance = Number(hit.distance ?? 0);
    this.dragForce.previousControlsEnabled = this.controls?.enabled !== false;
    this.dragForce.worldHit.copy(hit.point);
    this.dragForce.currentWorld.copy(hit.point);
    this.dragForce.localHit.copy(hit.point);
    if (body?.worldToLocal) {
      body.worldToLocal(this.dragForce.localHit);
    }
    if (this.controls) {
      this.controls.enabled = false;
    }
    this.setDragForceArrowVisible(true);
    this.updateDragForceTarget(event.clientX, event.clientY);
    this.requestRender();
  }

  moveDragForce(event) {
    if (!this.dragForce?.active) {
      return;
    }
    event.preventDefault?.();
    this.updateDragForceTarget(event.clientX, event.clientY);
    this.requestRender();
  }

  updateDragForceTarget(clientX, clientY) {
    if (!this.dragForce?.active || !this.updatePointerRay(clientX, clientY)) {
      return;
    }
    this.dragForce.currentWorld
      .copy(this.raycaster.ray.origin)
      .addScaledVector(this.raycaster.ray.direction, this.dragForce.grabDistance);
    this.updateDragForceArrow();
  }

  endDragForce() {
    if (!this.dragForce) {
      return;
    }
    const restoreControls = this.dragForce.active && this.dragForce.previousControlsEnabled;
    if (restoreControls && this.controls) {
      this.controls.enabled = true;
    }
    this.dragForce.active = false;
    this.dragForce.bodyId = null;
    this.dragForce.bodyName = null;
    this.dragForce.physicsObject = null;
    this.dragForce.force = [0, 0, 0];
    this.setDragForceArrowVisible(false);
    this.requestRender?.();
  }

  setDragForceArrowVisible(visible) {
    if (this.dragForceArrow) {
      this.dragForceArrow.visible = Boolean(visible);
    }
  }

  updateDragForceArrow() {
    if (!this.dragForceArrow || !this.dragForce?.active) {
      return;
    }
    const offset = new THREE.Vector3().subVectors(this.dragForce.currentWorld, this.dragForce.worldHit);
    const length = offset.length();
    this.dragForceArrow.position.copy(this.dragForce.worldHit);
    if (length > 1e-6) {
      this.dragForceArrow.setDirection(offset.normalize());
      this.dragForceArrow.setLength(length);
    } else {
      this.dragForceArrow.setLength(0.001);
    }
  }

  getPhysicsDecimation(targetControlDt = 0.02) {
    return physicsDecimationForModel(this.model, targetControlDt);
  }

  readState(jointNames = this.jointNamesMJC || []) {
    return readSimulationState({
      simulation: this.simulation,
      jointNames,
      jointNamesMJC: this.jointNamesMJC,
      jointAddressByName: this.jointAddressByName,
      jointVelocityAddressByName: this.jointVelocityAddressByName
    });
  }

  readContactSummary() {
    const summary = readContactSummaryFromData({
      mujoco: this.mujoco,
      model: this.model,
      data: this.data,
      bodyNames: this.bodyNames
    });
    if (this.contactMarkersEnabled !== false) {
      this.setContactMarkers(summary);
    }
    return summary;
  }

  setContactMarkersEnabled(enabled) {
    this.contactMarkersEnabled = Boolean(enabled);
    if (this.contactMarkerGroup) {
      this.contactMarkerGroup.visible = this.contactMarkersEnabled;
    }
    if (!this.contactMarkersEnabled) {
      for (const marker of this.contactMarkerPool || []) {
        marker.visible = false;
      }
      this.requestRender?.();
    }
  }

  setContactMarkers(summary = {}) {
    if (!this.contactMarkerGroup) {
      return;
    }
    const points = Array.isArray(summary.points) ? summary.points : [];
    for (let index = this.contactMarkerPool.length; index < points.length; index += 1) {
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 0),
        0.001,
        CONTACT_ARROW_COLOR_OTHER
      );
      arrow.line.material.transparent = true;
      arrow.cone.material.transparent = true;
      arrow.line.material.opacity = 0.78;
      arrow.cone.material.opacity = 0.86;
      this.contactMarkerPool.push(arrow);
      this.contactMarkerGroup.add(arrow);
    }

    for (let index = 0; index < this.contactMarkerPool.length; index += 1) {
      const arrow = this.contactMarkerPool[index];
      const point = points[index];
      if (!point || !point.active) {
        arrow.visible = false;
        continue;
      }
      const color = point.side === 'left'
        ? CONTACT_ARROW_COLOR_LEFT
        : point.side === 'right'
          ? CONTACT_ARROW_COLOR_RIGHT
          : CONTACT_ARROW_COLOR_OTHER;
      const length = Math.min(CONTACT_FORCE_ARROW_MAX, Math.max(0.035, point.normalForce * CONTACT_FORCE_ARROW_SCALE));
      arrow.position.set(...point.position);
      arrow.setColor(color);
      arrow.setDirection(new THREE.Vector3(0, 1, 0));
      arrow.setLength(length, Math.min(0.12, length * 0.36), Math.min(0.07, length * 0.18));
      arrow.visible = true;
    }
    this.requestRender?.();
  }

  queueImpulse({ preset, magnitude = 80, duration = 0.15, bodyName = null } = {}) {
    const forceByPreset = {
      push_forward: [magnitude, 0, 0],
      push_backward: [-magnitude, 0, 0],
      push_left: [0, magnitude, 0],
      push_right: [0, -magnitude, 0],
      lift_up: [0, 0, magnitude]
    };
    const force = forceByPreset[preset];
    if (!force) {
      throw new Error(`Unknown impulse preset: ${preset}`);
    }
    this.activeImpulse = {
      bodyId: this.resolveImpulseBodyId(bodyName),
      force,
      expiresAt: performance.now() + Number(duration) * 1000
    };
  }

  resolveImpulseBodyId(bodyName) {
    if (bodyName && this.bodyIdByName.has(bodyName)) {
      return this.bodyIdByName.get(bodyName);
    }
    for (const candidate of ['pelvis', 'base', 'torso_link', 'trunk']) {
      if (this.bodyIdByName.has(candidate)) {
        return this.bodyIdByName.get(candidate);
      }
    }
    return this.model?.nbody > 1 ? 1 : 0;
  }

  applyActiveImpulse(now) {
    if (!this.activeImpulse) {
      return;
    }
    if (now > this.activeImpulse.expiresAt) {
      this.activeImpulse = null;
      return;
    }
    const body = this.bodies[this.activeImpulse.bodyId];
    const point = body?.position || { x: 0, y: 0, z: 0 };
    const force = threeVectorToMujoco(this.activeImpulse.force);
    const mujocoPoint = threeVectorToMujoco(point);
    this.simulation.applyForce?.(
      force[0],
      force[1],
      force[2],
      0,
      0,
      0,
      mujocoPoint[0],
      mujocoPoint[1],
      mujocoPoint[2],
      this.activeImpulse.bodyId
    );
  }

  applyDragForce() {
    if (!this.dragForce?.active || this.dragForce.bodyId === null || this.dragForce.bodyId === undefined) {
      return;
    }
    const body = this.bodies[this.dragForce.bodyId];
    if (!body) {
      this.endDragForce();
      return;
    }
    body.updateWorldMatrix?.(true, false);
    this.dragForce.worldHit.copy(this.dragForce.localHit);
    body.localToWorld?.(this.dragForce.worldHit);
    const forceVector = new THREE.Vector3()
      .subVectors(this.dragForce.currentWorld, this.dragForce.worldHit)
      .multiplyScalar(DRAG_FORCE_SCALE);
    clampVectorLength(forceVector, DRAG_FORCE_MAX);
    this.dragForce.force = [forceVector.x, forceVector.y, forceVector.z];
    const force = threeVectorToMujoco(forceVector);
    const point = threeVectorToMujoco(this.dragForce.worldHit);
    this.simulation.applyForce?.(
      force[0],
      force[1],
      force[2],
      0,
      0,
      0,
      point[0],
      point[1],
      point[2],
      this.dragForce.bodyId
    );
    this.updateDragForceArrow();
  }

  getDragForceState() {
    return {
      active: Boolean(this.dragForce?.active),
      body_id: this.dragForce?.bodyId ?? null,
      body_name: this.dragForce?.bodyName ?? null,
      force: this.dragForce?.force || [0, 0, 0],
      hit_point: this.dragForce?.worldHit
        ? [this.dragForce.worldHit.x, this.dragForce.worldHit.y, this.dragForce.worldHit.z]
        : null,
      target_point: this.dragForce?.currentWorld
        ? [this.dragForce.currentWorld.x, this.dragForce.currentWorld.y, this.dragForce.currentWorld.z]
        : null
    };
  }

  canApplyNamedBodyTrack(payload) {
    if (arrayIsZeroFilled(payload?.state?.body_positions)) {
      return false;
    }
    return payload.body_names.some((bodyName) => this.bodyIdByName.has(bodyName));
  }

  syncBodyPositionTrack(payload) {
    const state = payload.state;
    const root = new THREE.Vector3();
    const rootQuaternion = new THREE.Quaternion();
    setSwizzledPosition(root, state.root_translation || [0, 0, 0.78]);
    setSwizzledQuaternion(rootQuaternion, state.root_rotation_wxyz || [1, 0, 0, 0]);

    const bodyPositions = state.body_positions || [];
    const bodyRotations = state.body_rotations_wxyz || [];
    const tempPosition = new THREE.Vector3();
    const tempQuaternion = new THREE.Quaternion();
    for (let trackIndex = 0; trackIndex < bodyPositions.length; trackIndex += 1) {
      const bodyName = payload.body_names[trackIndex];
      const bodyId = this.bodyIdByName.get(bodyName);
      const body = this.bodies[bodyId];
      const position = bodyPositions[trackIndex];
      if (!position) {
        continue;
      }
      setSwizzledPosition(tempPosition, position);
      tempPosition.applyQuaternion(rootQuaternion).add(root);
      if (!this.bodyTrackPositions[trackIndex]) {
        this.bodyTrackPositions[trackIndex] = new THREE.Vector3();
      }
      this.bodyTrackPositions[trackIndex].copy(tempPosition);

      if (!body) {
        continue;
      }
      body.position.copy(tempPosition);

      const rotation = bodyRotations[trackIndex];
      if (rotation) {
        setSwizzledQuaternion(tempQuaternion, rotation);
        body.quaternion.copy(rootQuaternion).multiply(tempQuaternion);
      } else if (trackIndex === 0) {
        body.quaternion.copy(rootQuaternion);
      }
      body.updateWorldMatrix();
    }
  }

  setHighDetailVisible(visible) {
    for (const body of this.highDetailBodies) {
      body.visible = visible;
    }
  }

  cameraPresetTarget() {
    const body = this.bodies?.[this.followBodyId];
    if (body?.position) {
      return new THREE.Vector3(body.position.x, this.followHeight ?? 0.75, body.position.z);
    }
    return this.controls?.target?.clone?.() || new THREE.Vector3(0, this.followHeight ?? 0.75, 0);
  }

  setCameraFollowEnabled(enabled) {
    this.followEnabled = Boolean(enabled);
    this.followInitialized = false;
    this.requestRender?.();
    return true;
  }

  applyCameraPreset(preset = 'default') {
    if (!this.camera || !this.controls) {
      return false;
    }

    const normalizedPreset = preset === 'reset' ? 'default' : preset;
    const target = normalizedPreset === 'default'
      ? new THREE.Vector3(0, this.followHeight ?? 0.75, 0)
      : this.cameraPresetTarget();
    const cameraPosition = new THREE.Vector3();
    if (normalizedPreset === 'front') {
      cameraPosition.set(target.x + CAMERA_PRESET_DISTANCE, CAMERA_PRESET_HEIGHT, target.z);
    } else if (normalizedPreset === 'side') {
      cameraPosition.set(target.x, CAMERA_PRESET_HEIGHT, target.z + CAMERA_PRESET_DISTANCE);
    } else if (normalizedPreset === 'back') {
      cameraPosition.set(target.x - CAMERA_PRESET_DISTANCE, CAMERA_PRESET_HEIGHT, target.z);
    } else if (normalizedPreset === 'top') {
      cameraPosition.set(target.x, target.y + CAMERA_TOP_HEIGHT_OFFSET, target.z);
    } else if (normalizedPreset === 'default') {
      cameraPosition.set(3.0, 2.2, 3.0);
      this.followInitialized = false;
    } else {
      return false;
    }
    roundVector(cameraPosition);

    this.controls.target.copy(target);
    this.camera.position.copy(cameraPosition);
    this.camera.up?.set?.(0, 1, 0);
    this.camera.lookAt?.(target);
    this.controls.update?.();
    this.requestRender?.();
    return true;
  }

  updateCameraFollow() {
    if (!this.followEnabled || this.followBodyId === null || this.followBodyId === undefined) {
      return;
    }
    const body = this.bodies[this.followBodyId];
    if (!body) {
      return;
    }
    const desired = this.followDesired || new THREE.Vector3();
    desired.set(body.position.x, this.followHeight, body.position.z);
    if (!this.followInitialized) {
      this.followTarget.copy(desired);
      this.followInitialized = true;
    } else {
      this.followTarget.copy(desired);
    }
    this.followDelta.subVectors(this.followTarget, this.controls.target);
    if (this.followDelta.lengthSq() < 1e-10) {
      return;
    }
    this.controls.target.copy(this.followTarget);
    this.camera.position.add(this.followDelta);
  }

  syncBodies() {
    if (!this.simulation) {
      return;
    }
    for (let bodyId = 0; bodyId < this.model.nbody; bodyId += 1) {
      const body = this.bodies[bodyId];
      if (!body) {
        continue;
      }
      getPosition(this.simulation.xpos, bodyId, body.position);
      getQuaternion(this.simulation.xquat, bodyId, body.quaternion);
      body.updateWorldMatrix();
    }
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.lastRenderTime = 0;
  }

  requestRender() {
    if (this.disposed || this.renderRequested) {
      return;
    }
    this.renderRequested = true;
  }

  render() {
    if (this.disposed) {
      return;
    }
    const now = performance.now();
    const shouldRender = this.renderRequested || now - this.lastRenderTime >= RENDER_THROTTLE_MS;
    if (!shouldRender) {
      return;
    }
    this.renderRequested = false;
    this.lastRenderTime = now;
    this.updateCameraFollow();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  startRecording({ fps = 30, mimeType = null } = {}) {
    if (this.isRecording()) {
      return false;
    }
    const canvas = this.renderer?.domElement;
    if (!canvas?.captureStream || typeof globalThis.MediaRecorder !== 'function') {
      throw new Error('Browser recording is not supported in this environment.');
    }
    const stream = canvas.captureStream(Math.max(1, Number(fps) || 30));
    const selectedMimeType = recordingMimeType(mimeType);
    const chunks = [];
    const recorder = new globalThis.MediaRecorder(stream, { mimeType: selectedMimeType });
    recorder.ondataavailable = (event) => {
      if (event?.data && Number(event.data.size ?? 0) > 0) {
        chunks.push(event.data);
      }
    };
    this.recording = {
      recorder,
      stream,
      chunks,
      mimeType: selectedMimeType
    };
    recorder.start();
    return true;
  }

  stopRecording() {
    if (!this.recording) {
      return Promise.resolve(null);
    }
    const recording = this.recording;
    return new Promise((resolve) => {
      recording.recorder.onstop = () => {
        for (const track of recording.stream?.getTracks?.() || []) {
          track.stop?.();
        }
        if (this.recording === recording) {
          this.recording = null;
        }
        resolve(new Blob(recording.chunks, { type: recording.mimeType || 'video/mp4' }));
      };
      if (recording.recorder.state === 'inactive') {
        recording.recorder.onstop();
        return;
      }
      recording.recorder.stop();
    });
  }

  isRecording() {
    return this.recording?.recorder?.state === 'recording';
  }

  recordingMimeType() {
    return this.recording?.mimeType || null;
  }

  createEvaluationSimulation() {
    if (!this.mujoco || !this.model) {
      throw new Error('MuJoCo viewer is not ready.');
    }
    return new BrowserMujocoEvaluationSimulation(this);
  }

  dispose() {
    this.disposed = true;
    this.endDragForce();
    if (this.recording?.recorder?.state === 'recording') {
      this.recording.recorder.stop();
    }
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown, true);
    document.removeEventListener('pointermove', this.handlePointerMove, true);
    document.removeEventListener('pointerup', this.handlePointerUp, true);
    document.removeEventListener('pointercancel', this.handlePointerUp, true);
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.controls.removeEventListener('change', this.handleControlsChange);
    this.controls.dispose();
    this.referenceOverlayData?.delete?.();
    for (const overlay of Object.values(this.referenceOverlays || {})) {
      overlay?.data?.delete?.();
    }
    this.simulation?.free();
    this.renderer.dispose();
    this.container.replaceChildren();
  }
}

export class BrowserMujocoEvaluationSimulation {
  constructor(viewer) {
    this.mujoco = viewer.mujoco;
    this.model = viewer.model;
    this.data = new this.mujoco.MjData(this.model);
    this.simulation = createSimulationWrapper(this.mujoco, this.model, this.data, { ownsModel: false });
    this.bodyNames = viewer.bodyNames || [];
    this.jointNamesMJC = viewer.jointNamesMJC || [];
    this.jointAddressByName = viewer.jointAddressByName || new Map();
    this.jointVelocityAddressByName = viewer.jointVelocityAddressByName || new Map();
    this.actuatorAddressByJointName = viewer.actuatorAddressByJointName || new Map();
    this.geomIdByName = viewer.geomIdByName || new Map();
    this.defaultPhysicsOptions = clonePhysicsOptions(viewer.defaultPhysicsOptions || viewer.capturePhysicsOptions?.() || null);
    this.currentPhysicsOptionsSignature = '';
  }

  configurePhysics(options = null) {
    if (!this.model) {
      return;
    }
    const physicsOptions = mergePhysicsOptions(this.defaultPhysicsOptions, options);
    const signature = JSON.stringify(physicsOptions);
    if (signature === this.currentPhysicsOptionsSignature) {
      return;
    }
    this.currentPhysicsOptionsSignature = signature;
    applyPhysicsOptionsToModel(this, physicsOptions);
  }

  resetPhysics(payload) {
    if (!this.simulation) {
      return;
    }
    this.simulation.resetData?.();
    const normalizedPayload = payload?.state
      ? payload
      : {
          sequence_id: 'evaluation_reset',
          frame_index: 0,
          joint_names: this.jointNamesMJC || [],
          body_names: this.bodyNames || [],
          state: payload
        };
    writePayloadToSimulation(this.simulation, normalizedPayload, this.jointAddressByName);
    zeroArray(this.simulation.ctrl);
    zeroArray(this.simulation.qfrc_applied);
    this.simulation.forward();
  }

  stepPhysics(options = {}) {
    if (!this.simulation || !this.model) {
      return null;
    }
    this.configurePhysics(options.physics_options);
    const steps = Math.max(1, Math.floor(options.steps ?? 1));
    const jointNames = options.joint_names || [];
    const targets = options.joint_positions || [];
    const kp = options.kp || [];
    const kd = options.kd || [];
    const torqueLimits = options.torque_limits || [];

    for (let step = 0; step < steps; step += 1) {
      zeroArray(this.simulation.ctrl);
      zeroArray(this.simulation.qfrc_applied);
      applyPdControlStep({
        simulation: this.simulation,
        model: this.model,
        jointNames,
        targets,
        kp,
        kd,
        torqueLimits,
        jointAddressByName: this.jointAddressByName,
        jointVelocityAddressByName: this.jointVelocityAddressByName,
        actuatorAddressByJointName: this.actuatorAddressByJointName,
        defaultKp: options.defaultKp ?? 35,
        defaultKd: options.defaultKd ?? 1.5
      });
      this.simulation.step();
    }

    this.simulation.forward();
    return this.readState(jointNames);
  }

  getPhysicsDecimation(targetControlDt = 0.02) {
    return physicsDecimationForModel(this.model, targetControlDt);
  }

  readState(jointNames = this.jointNamesMJC || []) {
    return readSimulationState({
      simulation: this.simulation,
      jointNames,
      jointNamesMJC: this.jointNamesMJC,
      jointAddressByName: this.jointAddressByName,
      jointVelocityAddressByName: this.jointVelocityAddressByName
    });
  }

  readContactSummary() {
    return readContactSummaryFromData({
      mujoco: this.mujoco,
      model: this.model,
      data: this.data,
      bodyNames: this.bodyNames
    });
  }

  dispose() {
    if (this.model) {
      applyPhysicsOptionsToModel(this, mergePhysicsOptions(this.defaultPhysicsOptions, null));
    }
    this.simulation?.free?.();
    this.simulation = null;
    this.data = null;
  }
}
