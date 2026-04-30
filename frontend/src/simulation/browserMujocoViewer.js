import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import loadMujoco from 'mujoco-js';
import { Reflector } from './utils/Reflector.js';

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

function createSimulationWrapper(mujoco, model, data) {
  return {
    get qpos() {
      return data.qpos;
    },
    get qvel() {
      return data.qvel;
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
    free() {
      data.delete();
      model.delete();
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

function makeMaterial(model, geomId) {
  let color = [
    model.geom_rgba[geomId * 4],
    model.geom_rgba[geomId * 4 + 1],
    model.geom_rgba[geomId * 4 + 2],
    model.geom_rgba[geomId * 4 + 3]
  ];
  const materialId = model.geom_matid[geomId];
  if (materialId !== -1) {
    color = [
      model.mat_rgba[materialId * 4],
      model.mat_rgba[materialId * 4 + 1],
      model.mat_rgba[materialId * 4 + 2],
      model.mat_rgba[materialId * 4 + 3]
    ];
  }
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color[0], color[1], color[2]),
    transparent: color[3] < 1.0,
    opacity: color[3]
  });
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
      mesh = new Reflector(new THREE.PlaneGeometry(80, 80), { clipBias: 0.003 });
      mesh.rotateX(-Math.PI / 2);
      mesh.material.depthWrite = false;
      mesh.renderOrder = -1;
    } else {
      mesh = new THREE.Mesh(makeGeometry(mujoco, model, geomId, meshes), makeMaterial(model, geomId));
    }
    mesh.castShadow = geomId !== 0;
    mesh.receiveShadow = true;
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
  sunlight.castShadow = true;
  root.add(sunlight);
  lights.push(sunlight);

  return { model, data, simulation, bodies, lights, bodyNames };
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
    this.jointAddressByName = new Map();
    this.lastFrameKey = null;
    this.disposed = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101820);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    this.camera.position.set(3.0, 2.2, 3.0);
    this.scene.add(this.camera);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.75, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.update();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.renderer.setAnimationLoop(() => this.render());
    this.resize();
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
    this.jointNamesMJC = decodeNames(this.model, this.model.name_jntadr, this.model.njnt);
    this.jointAddressByName = new Map(
      this.jointNamesMJC.map((name, index) => [name, this.model.jnt_qposadr[index]])
    );
    this.applyDefaultPose();
    this.statusCallback('Browser MuJoCo viewer ready');
  }

  applyDefaultPose() {
    if (!this.simulation) {
      return;
    }
    this.simulation.forward();
    this.syncBodies();
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
    const qpos = this.simulation.qpos;
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
    const values = state.joint_positions || [];
    for (let index = 0; index < names.length; index += 1) {
      const address = this.jointAddressByName.get(names[index]);
      if (address !== undefined && address < qpos.length) {
        qpos[address] = Number(values[index] ?? 0);
      }
    }
    this.simulation.forward();
    this.syncBodies();
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
  }

  render() {
    if (this.disposed) {
      return;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.simulation?.free();
    this.renderer.dispose();
    this.container.replaceChildren();
  }
}
