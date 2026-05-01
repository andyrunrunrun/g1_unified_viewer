<template>
  <div class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">G1 Browser MuJoCo Console</p>
        <h1>G1 Unified Viewer</h1>
        <p>Browser MuJoCo WASM renderer with dataset playback, policy controls, and trim tools.</p>
      </div>
      <div class="status-grid">
        <span id="viewerBadge" :class="['badge', viewerReady ? 'ok' : '']">{{ viewerReady ? 'Browser Viewer Ready' : 'Browser Viewer Loading' }}</span>
        <span id="modeBadge" class="badge">模式: {{ session?.view_mode ?? '-' }}</span>
        <span id="playbackBadge" class="badge">播放: {{ playbackDisplayState }}</span>
        <span id="policyBadge" class="badge">策略: {{ browserPolicyState.active_policy_id || '-' }}</span>
        <span id="physicsBadge" :class="['badge', session?.physics_enabled ? 'warn' : '']">{{ session?.physics_enabled ? 'Physics ON' : 'Physics OFF' }}</span>
        <button id="physicsToggleButton" class="secondary" @click="runCommand(togglePhysics, 'Physics 状态已更新。')">
          {{ session?.physics_enabled ? 'Physics ON' : 'Physics OFF' }}
        </button>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <section class="panel">
          <div class="panel-title">
            <h2>Data</h2>
            <p>Load local motion clips.</p>
          </div>
          <input id="pathInput" v-model="pathInput" type="text" placeholder="输入数据根目录" />
          <button id="scanButton" @click="scanTree">Scan</button>
          <div id="treeStatus" :class="['status', treeStatus.error ? 'error' : '']">{{ treeStatus.text }}</div>
          <div id="treeRoot" class="tree">
            <button
              v-for="node in treeNodes"
              :key="node.path"
              :class="['tree-node', node.node_type, node.path === activePath ? 'active' : '']"
              @click="handleTreeNode(node)"
            >
              {{ node.node_type === 'directory' ? '[dir]' : '[motion]' }} {{ node.name }}
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>Motion</h2>
            <p>Cached browser playback.</p>
          </div>
          <div id="clipSummary" class="stat-grid">
            <div v-for="[label, value] in clipSummaryEntries" :key="label" class="stat">
              <span>{{ label }}</span>
              <strong>{{ value }}</strong>
            </div>
          </div>
          <input
            id="timeline"
            type="range"
            min="0"
            :max="maxFrame"
            :value="viewerFrameIndex"
            :disabled="!activeSequence"
            @input="seekTo(Number($event.target.value))"
          />
          <div class="two-col">
            <input id="frameInput" v-model.number="frameInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" />
            <button id="seekButton" class="secondary" :disabled="!activeSequence" @click="seekTo(frameInput)">Seek</button>
          </div>
          <div class="three-col">
            <button id="playButton" :disabled="!activeSequence" @click="runCommand(playPlayback, '开始播放。')">Play</button>
            <button id="pauseButton" class="secondary" :disabled="!activeSequence" @click="runCommand(pausePlayback, '已暂停。')">Pause</button>
            <button id="stopButton" class="secondary" :disabled="!activeSequence" @click="runCommand(stopPlayback, '已停止。')">Stop</button>
          </div>
          <div id="commandStatus" :class="['status', commandStatus.error ? 'error' : '']">{{ commandStatus.text }}</div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>Trim & Export</h2>
            <p>Mark clip bounds.</p>
          </div>
          <div class="two-col">
            <input id="trimStartInput" v-model.number="trimStartInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" @change="setTrimStart" />
            <input id="trimEndInput" v-model.number="trimEndInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" @change="setTrimEnd" />
          </div>
          <div class="two-col">
            <button id="markTrimStartButton" class="ghost" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/trim', { action: 'mark_start' }), '已标记裁剪起点。')">Mark Start</button>
            <button id="markTrimEndButton" class="ghost" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/trim', { action: 'mark_end' }), '已标记裁剪终点。')">Mark End</button>
          </div>
          <div id="trimSummary" class="note">裁剪区间: {{ session?.trim_start ?? 0 }} 至 {{ session?.trim_end ?? 0 }}</div>
          <button id="exportButton" class="secondary" :disabled="!activeSequence" @click="runCommand(exportTrim, '裁剪导出完成。')">Export Trim</button>
        </section>
      </aside>

      <section class="viewer-column">
        <div class="viewer-toolbar">
          <div>
            <p class="eyebrow">Browser MuJoCo WASM</p>
            <h2>{{ activeSequence?.name || 'Load a motion to drive the model' }}</h2>
          </div>
          <span :class="['badge', viewerStatus.includes('ready') ? 'ok' : '']">{{ viewerStatus }}</span>
        </div>
        <div class="viewer-frame">
          <div ref="viewerContainer" class="mujoco-stage"></div>
          <div class="viewer-overlay">
            <span>{{ activeSequence?.source_format || 'no clip' }}</span>
            <strong>{{ viewerFrameIndex }} / {{ maxFrame }}</strong>
            <span>{{ session?.physics_enabled ? 'physics' : 'reference' }}</span>
          </div>
        </div>
      </section>

      <aside class="sidebar right">
        <section class="panel">
          <div class="panel-title">
            <h2>Policy</h2>
            <p>Click a policy to switch it.</p>
          </div>
          <div id="policyStatus" :class="['status', policyStatus.error ? 'error' : '']">{{ policyStatus.text }}</div>
          <div id="policyList" class="policy-list">
            <button
              v-for="policy in policies"
              :key="policy.policy_id"
              :class="['policy-card', policy.policy_id === selectedPolicyId || policy.policy_id === browserPolicyState.active_policy_id ? 'active' : '']"
              :data-policy-id="policy.policy_id"
              :disabled="policyDisabled(policy)"
              @click="runCommand(() => switchSelectedPolicy(policy.policy_id), '策略已切换。', policyStatus)"
            >
              <strong>{{ policy.display_name }}</strong>
              <span>{{ policy.policy_id }} / {{ policy.control_mode }}</span>
              <small>{{ policy.description || '无描述' }}</small>
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>Test</h2>
            <p>Physics impulse tests.</p>
          </div>
          <div class="two-col">
            <input id="impulseMagnitudeInput" v-model.number="impulseMagnitude" type="number" min="1" max="500" />
            <input id="impulseDurationInput" v-model.number="impulseDuration" type="number" min="0.01" max="5" step="0.01" />
          </div>
          <div class="impulse-grid">
            <button class="impulseButton ghost" data-preset="push_forward" @click="runCommand(() => queueImpulse('push_forward'), '已排队测试冲击: push_forward')">Forward</button>
            <button class="impulseButton ghost" data-preset="push_backward" @click="runCommand(() => queueImpulse('push_backward'), '已排队测试冲击: push_backward')">Backward</button>
            <button class="impulseButton ghost" data-preset="push_left" @click="runCommand(() => queueImpulse('push_left'), '已排队测试冲击: push_left')">Left</button>
            <button class="impulseButton ghost" data-preset="push_right" @click="runCommand(() => queueImpulse('push_right'), '已排队测试冲击: push_right')">Right</button>
            <button class="impulseButton ghost" data-preset="lift_up" @click="runCommand(() => queueImpulse('lift_up'), '已排队测试冲击: lift_up')">Lift</button>
          </div>
          <div class="test-actions">
            <button
              id="resetStanceButton"
              class="secondary"
              :disabled="!session?.physics_enabled || !activeSequence"
              @click="runCommand(resetPhysicsToDefaultStance, '已恢复默认站姿。')"
            >
              Reset Stance
            </button>
          </div>
          <div class="test-maintenance">
            <button id="resetTestButton" class="ghost" @click="runCommand(() => postJson('/api/viewer/test/reset'), '测试状态已清空。')">Clear Test State</button>
          </div>
        </section>

        <section class="panel diagnostics">
          <div class="panel-title">
            <h2>Diagnostics</h2>
            <p>Session debug feed.</p>
          </div>
          <h3>Policy Feed</h3>
          <pre id="policyPane">{{ policyPane }}</pre>
          <h3>Camera Feed</h3>
          <pre id="cameraPane">{{ cameraPane }}</pre>
          <h3>Log</h3>
          <pre id="logPane">{{ logPane }}</pre>
          <h3>Observation</h3>
          <pre id="observationPane">{{ observationPane }}</pre>
          <h3>Action</h3>
          <pre id="actionPane">{{ actionPane }}</pre>
          <h3>Drag/Test</h3>
          <pre id="dragPane">{{ dragPane }}</pre>
        </section>
      </aside>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { fetchJson, formatJson, postJson } from './api.js';
import { BrowserMujocoViewer } from './simulation/browserMujocoViewer.js';
import { BROWSER_POLICY_MANIFESTS, createBrowserPolicyRuntime, normalizeFrameCacheAsMotionClip } from './simulation/policyRuntime.js';

const viewerContainer = ref(null);
const session = ref(null);
const policies = ref([...BROWSER_POLICY_MANIFESTS]);
const selectedPolicyId = ref(BROWSER_POLICY_MANIFESTS[0]?.policy_id ?? null);
const pathInput = ref('');
const treeNodes = ref([]);
const frameInput = ref(0);
const trimStartInput = ref(0);
const trimEndInput = ref(0);
const impulseMagnitude = ref(80);
const impulseDuration = ref(0.15);
const viewerStatus = ref('viewer initializing');
const viewerReady = ref(false);
const commandStatus = ref({ text: '等待操作。', error: false });
const treeStatus = ref({ text: '输入数据根目录后扫描。', error: false });
const policyStatus = ref({ text: '策略在浏览器本地运行。', error: false });
const browserPolicyState = ref({
  active_policy_id: null,
  last_policy_result: null
});

const SESSION_POLL_INTERVAL_MS = 500;
const LOCAL_PLAYBACK_RENDER_INTERVAL_MS = 30;
const BROWSER_PHYSICS_CONTROL_DT = 0.02;
const MOCK_BROWSER_POLICY_ID = 'mock_passthrough';
const ACTIVE_BROWSER_MOTION_NAME = 'active_clip';

let pollHandle = null;
let playbackFrameHandle = null;
let physicsLoopPromise = null;
let viewer = null;
let lastPolicySelectionSignature = '';
let frameCacheRequestToken = 0;
const browserPolicyRuntime = createBrowserPolicyRuntime();
let frameCache = {
  sequenceId: null,
  jointNames: [],
  bodyNames: [],
  frames: []
};
let localPlayback = {
  active: false,
  lastTimestamp: 0,
  accumulator: 0,
  lastRenderTimestamp: 0
};
const browserPhysics = reactive({
  active: false,
  referenceFrame: 0,
  referenceFrameFloat: 0,
  lastPolicyOutput: null,
  targetMode: 'default_stance',
  loopToken: 0
});

const activeSequence = computed(() => session.value?.active_sequence ?? null);
const activePath = computed(() => session.value?.active_item_path || activeSequence.value?.source_path || '');
const maxFrame = computed(() => Math.max(0, (activeSequence.value?.frame_count ?? 0) - 1));
const viewerFrameIndex = ref(0);
const playbackDisplayState = computed(() => {
  if (session.value?.physics_enabled) {
    return browserPhysics.targetMode === 'tracking' ? 'playing' : 'paused';
  }
  return session.value?.playback_state ?? '-';
});
const clipSummaryEntries = computed(() => [
  ['名称', activeSequence.value?.name ?? '未加载'],
  ['格式', activeSequence.value?.source_format ?? '-'],
  ['当前帧', `${viewerFrameIndex.value} / ${maxFrame.value}`],
  ['FPS', activeSequence.value ? Number(activeSequence.value.fps).toFixed(2) : '-']
]);
const policyPane = computed(() => formatJson({
  active_policy_id: browserPolicyState.value.active_policy_id,
  physics_enabled: session.value?.physics_enabled,
  last_policy_result: browserPolicyState.value.last_policy_result,
  last_error: session.value?.last_error
}));
const cameraPane = computed(() => session.value?.viewer_camera
  ? formatJson({ connected: session.value.viewer_connected, camera: session.value.viewer_camera })
  : '等待 MuJoCo viewer 连接...');
const logPane = computed(() => session.value?.last_log_messages?.length ? session.value.last_log_messages.join('\n') : '暂无日志。');
const observationPane = computed(() => formatJson(session.value?.last_observation_summary));
const actionPane = computed(() => formatJson(session.value?.last_action_summary));
const dragPane = computed(() => formatJson({
  viewer_interaction: session.value?.viewer_interaction,
  test_state: session.value?.test_state
}));

function setStatus(target, text, error = false) {
  target.value = { text, error };
}

function syncInputsFromSession() {
  if (!session.value) {
    return;
  }
  if (!localPlayback.active && !browserPhysics.active) {
    viewerFrameIndex.value = session.value.current_frame;
  }
  frameInput.value = viewerFrameIndex.value;
  trimStartInput.value = session.value.trim_start;
  trimEndInput.value = session.value.trim_end;
}

function syncPolicyCardStates() {
  const signature = JSON.stringify({
    active: browserPolicyState.value.active_policy_id ?? null,
    selected: selectedPolicyId.value
  });
  if (signature === lastPolicySelectionSignature) {
    return;
  }
  lastPolicySelectionSignature = signature;
}

function renderSession() {
  syncInputsFromSession();
  syncPolicyCardStates();
}

function framePayloadForIndex(frameIndex) {
  if (!activeSequence.value || frameCache.sequenceId !== activeSequence.value.sequence_id) {
    return null;
  }
  const boundedFrame = Math.min(Math.max(Number(frameIndex) || 0, 0), frameCache.frames.length - 1);
  const state = frameCache.frames[boundedFrame];
  if (!state) {
    return null;
  }
  return {
    sequence_id: frameCache.sequenceId,
    frame_index: boundedFrame,
    joint_names: frameCache.jointNames,
    body_names: frameCache.bodyNames,
    state
  };
}

function applyCachedFrame(frameIndex) {
  const payload = framePayloadForIndex(frameIndex);
  if (!payload) {
    return false;
  }
  viewerFrameIndex.value = payload.frame_index;
  frameInput.value = payload.frame_index;
  viewer?.applyState(payload);
  return true;
}

function applyPolicyOutput(output, frameIndex = viewerFrameIndex.value) {
  if (!output || output.mode !== 'joint_position_target') {
    return false;
  }
  viewerFrameIndex.value = Math.min(Math.max(Number(frameIndex) || 0, 0), maxFrame.value);
  frameInput.value = viewerFrameIndex.value;
  viewer?.applyState({
    sequence_id: frameCache.sequenceId,
    frame_index: viewerFrameIndex.value,
    joint_names: output.joint_names || frameCache.jointNames,
    body_names: frameCache.bodyNames,
    state: {
      root_translation: output.root_translation,
      root_rotation_wxyz: output.root_rotation_wxyz,
      joint_positions: output.joint_positions
    }
  });
  return true;
}

function defaultStanceFramePayload() {
  const target = browserPolicyRuntime.defaultStance();
  return makePolicyTargetPayload(target, viewerFrameIndex.value, 'default_stance');
}

function currentPhysicsStatePayload(jointNames) {
  const state = viewer?.readState(jointNames);
  if (!state) {
    return null;
  }
  return {
    joint_names: jointNames || frameCache.jointNames,
    body_names: frameCache.bodyNames,
    state
  };
}

async function prepareBrowserTrackingMotion() {
  await ensureBrowserPolicyActive();
  normalizeFrameCacheAsMotionClip(frameCache);
  browserPolicyRuntime.setMotionClip(ACTIVE_BROWSER_MOTION_NAME, frameCache);
}

function resetBrowserPolicyTrackingToDefault() {
  browserPolicyRuntime.requestMotion('default', currentPhysicsStatePayload(frameCache.jointNames));
}

async function switchBrowserPolicyTrackingToActiveClip(startFrame = browserPhysics.referenceFrame) {
  await prepareBrowserTrackingMotion();
  browserPolicyRuntime.requestMotion(
    ACTIVE_BROWSER_MOTION_NAME,
    currentPhysicsStatePayload(frameCache.jointNames),
    { startFrame }
  );
}

async function stepBrowserPolicyAtFrame(frameIndex) {
  const payload = framePayloadForIndex(frameIndex);
  if (!payload) {
    throw new Error('请先加载动作帧。');
  }
  const output = await browserPolicyRuntime.step({
    reference: {
      joint_names: payload.joint_names,
      body_names: payload.body_names,
      state: payload.state
    },
    motion_clip: {
      sequence_id: frameCache.sequenceId,
      frame_count: frameCache.frames.length
    }
  });
  browserPolicyState.value = browserPolicyRuntime.status();
  if (output) {
    applyPolicyOutput(output, payload.frame_index);
  }
  return output;
}

function resetLocalPlayback() {
  localPlayback.active = false;
  localPlayback.lastTimestamp = 0;
  localPlayback.accumulator = 0;
  localPlayback.lastRenderTimestamp = 0;
}

function stopLocalPlaybackLoop() {
  resetLocalPlayback();
  if (playbackFrameHandle) {
    window.cancelAnimationFrame(playbackFrameHandle);
    playbackFrameHandle = null;
  }
}

function resetBrowserPhysics() {
  browserPhysics.active = false;
  browserPhysics.referenceFrame = viewerFrameIndex.value;
  browserPhysics.referenceFrameFloat = viewerFrameIndex.value;
  browserPhysics.lastPolicyOutput = null;
  browserPhysics.targetMode = 'default_stance';
  browserPhysics.loopToken += 1;
}

function stopBrowserPhysicsLoop() {
  resetBrowserPhysics();
}

function policyDisabled(policy) {
  return !session.value?.physics_enabled && policy.policy_id !== MOCK_BROWSER_POLICY_ID;
}

async function ensureBrowserPolicyActive() {
  if (browserPolicyRuntime.activePolicyId) {
    return;
  }
  const manifest = policies.value.find((policy) => policy.policy_id === selectedPolicyId.value)
    || policies.value.find((policy) => policy.policy_id === MOCK_BROWSER_POLICY_ID);
  await browserPolicyRuntime.activate(manifest);
  browserPolicyState.value = browserPolicyRuntime.status();
}

async function inferBrowserPhysicsTarget(frameIndex, payloadOverride = null) {
  await ensureBrowserPolicyActive();
  const payload = payloadOverride || framePayloadForIndex(frameIndex);
  if (!payload) {
    return browserPhysics.lastPolicyOutput;
  }
  const output = await browserPolicyRuntime.step({
    reference: {
      joint_names: payload.joint_names,
      body_names: payload.body_names,
      state: payload.state
    },
    current_state: currentPhysicsStatePayload(payload.joint_names)
  });
  browserPolicyState.value = browserPolicyRuntime.status();
  if (output) {
    browserPhysics.lastPolicyOutput = output;
  }
  return browserPhysics.lastPolicyOutput;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function makePolicyTargetPayload(target, frameIndex = viewerFrameIndex.value, sequenceId = frameCache.sequenceId || 'default_stance') {
  if (!target) {
    return null;
  }
  return {
    sequence_id: sequenceId,
    frame_index: Math.min(Math.max(Number(frameIndex) || 0, 0), maxFrame.value),
    joint_names: target.joint_names || frameCache.jointNames,
    body_names: frameCache.bodyNames,
    state: {
      root_translation: target.root_translation,
      root_rotation_wxyz: target.root_rotation_wxyz,
      joint_positions: target.joint_positions
    }
  };
}

async function resetViewerToDefaultStance() {
  await ensureBrowserPolicyActive();
  const target = browserPolicyRuntime.defaultStance();
  browserPolicyState.value = browserPolicyRuntime.status();
  browserPhysics.targetMode = 'default_stance';
  browserPhysics.lastPolicyOutput = target;
  const payload = makePolicyTargetPayload(target, viewerFrameIndex.value, 'default_stance');
  if (payload) {
    viewer?.resetPhysics(payload);
  }
  resetBrowserPolicyTrackingToDefault();
  viewerStatus.value = 'browser physics holding default stance';
  return target;
}

function pausePhysicsToDefaultStance() {
  browserPhysics.targetMode = 'default_stance';
  return resetViewerToDefaultStance();
}

function advanceBrowserPhysicsReferenceFrame() {
  const fps = Math.max(1, Number(activeSequence.value.fps) || 30);
  const nextFrameFloat = browserPhysics.referenceFrameFloat + fps * BROWSER_PHYSICS_CONTROL_DT;
  if (nextFrameFloat > maxFrame.value) {
    if (session.value?.loop_enabled) {
      browserPhysics.referenceFrameFloat = 0;
      browserPhysics.referenceFrame = 0;
      return { frameIndex: 0, looped: true, ended: false };
    }
    browserPhysics.referenceFrameFloat = 0;
    browserPhysics.referenceFrame = 0;
    return { frameIndex: 0, looped: false, ended: true };
  }
  browserPhysics.referenceFrameFloat = nextFrameFloat;
  browserPhysics.referenceFrame = Math.floor(browserPhysics.referenceFrameFloat);
  return { frameIndex: browserPhysics.referenceFrame, looped: false, ended: false };
}

async function browserPhysicsLoop() {
  const token = browserPhysics.loopToken;
  while (browserPhysics.active && token === browserPhysics.loopToken) {
    const loopStart = performance.now();
    try {
      let target = browserPhysics.lastPolicyOutput;
      if (browserPhysics.targetMode === 'default_stance') {
        const frameIndex = viewerFrameIndex.value;
        target = await inferBrowserPhysicsTarget(frameIndex, defaultStanceFramePayload());
      } else {
        const referenceFrame = advanceBrowserPhysicsReferenceFrame();
        if (referenceFrame.looped) {
          await switchBrowserPolicyTrackingToActiveClip(referenceFrame.frameIndex);
        }
        viewerFrameIndex.value = referenceFrame.frameIndex;
        frameInput.value = referenceFrame.frameIndex;
        if (referenceFrame.ended) {
          browserPhysics.targetMode = 'default_stance';
          resetBrowserPolicyTrackingToDefault();
          target = await inferBrowserPhysicsTarget(referenceFrame.frameIndex, defaultStanceFramePayload());
        } else {
          target = await inferBrowserPhysicsTarget(referenceFrame.frameIndex);
        }
      }

      viewer.stepPhysics({
        joint_names: target?.joint_names || frameCache.jointNames,
        joint_positions: target?.joint_positions || [],
        kp: target?.kp,
        kd: target?.kd,
        steps: viewer.getPhysicsDecimation(),
        now: performance.now()
      });
      viewerStatus.value = browserPhysics.targetMode === 'default_stance'
        ? 'browser physics holding default stance'
        : 'browser physics running';
    } catch (error) {
      setStatus(policyStatus, error.message, true);
    }

    const elapsed = performance.now() - loopStart;
    const sleepTime = (BROWSER_PHYSICS_CONTROL_DT * 1000) - elapsed;
    await sleep(sleepTime);
  }
}

async function startBrowserPhysicsLoop(targetMode = 'tracking') {
  if (!activeSequence.value || frameCache.sequenceId !== activeSequence.value.sequence_id || !viewer) {
    return;
  }
  stopLocalPlaybackLoop();
  const previousMode = browserPhysics.targetMode;
  browserPhysics.targetMode = targetMode;
  if (!browserPhysics.active) {
    const resetPayload = framePayloadForIndex(viewerFrameIndex.value);
    if (targetMode === 'default_stance') {
      await resetViewerToDefaultStance();
    } else if (resetPayload) {
      viewer.resetPhysics(resetPayload);
      browserPhysics.referenceFrame = resetPayload.frame_index;
      browserPhysics.referenceFrameFloat = resetPayload.frame_index;
      await switchBrowserPolicyTrackingToActiveClip();
      await inferBrowserPhysicsTarget(browserPhysics.referenceFrame);
    }
  } else if (previousMode !== targetMode) {
    if (targetMode === 'default_stance') {
      await resetViewerToDefaultStance();
    } else {
      browserPhysics.referenceFrameFloat = browserPhysics.referenceFrame;
      browserPhysics.lastPolicyOutput = null;
      await switchBrowserPolicyTrackingToActiveClip();
      await inferBrowserPhysicsTarget(browserPhysics.referenceFrame);
    }
  }
  browserPhysics.active = true;
  if (!physicsLoopPromise) {
    browserPhysics.loopToken += 1;
    physicsLoopPromise = browserPhysicsLoop().finally(() => {
      physicsLoopPromise = null;
    });
  }
}

function localPlaybackStep(timestamp) {
  playbackFrameHandle = null;
  if (!localPlayback.active || !activeSequence.value) {
    return;
  }

  const fps = Math.max(1, Number(activeSequence.value.fps) || 30);
  if (!localPlayback.lastTimestamp) {
    localPlayback.lastTimestamp = timestamp;
  }
  const elapsed = Math.max(0, timestamp - localPlayback.lastTimestamp);
  localPlayback.lastTimestamp = timestamp;
  localPlayback.accumulator += (elapsed / 1000) * fps;

  const shouldApply = timestamp - localPlayback.lastRenderTimestamp >= LOCAL_PLAYBACK_RENDER_INTERVAL_MS;
  if (localPlayback.accumulator >= 1 && shouldApply) {
    const steps = Math.floor(localPlayback.accumulator);
    localPlayback.accumulator -= steps;
    let nextFrame = viewerFrameIndex.value + steps;
    if (nextFrame > maxFrame.value) {
      if (session.value?.loop_enabled) {
        nextFrame %= maxFrame.value + 1;
      } else {
        nextFrame = 0;
        localPlayback.active = false;
      }
    }
    if (browserPolicyRuntime.activePolicyId) {
      stepBrowserPolicyAtFrame(nextFrame).catch((error) => setStatus(policyStatus, error.message, true));
      localPlayback.lastRenderTimestamp = timestamp;
    } else if (applyCachedFrame(nextFrame)) {
      localPlayback.lastRenderTimestamp = timestamp;
    }
  }

  if (localPlayback.active) {
    playbackFrameHandle = window.requestAnimationFrame(localPlaybackStep);
  }
}

function startLocalPlayback() {
  if (!activeSequence.value || frameCache.sequenceId !== activeSequence.value.sequence_id) {
    return;
  }
  if (session.value?.physics_enabled) {
    startBrowserPhysicsLoop(browserPhysics.targetMode).catch((error) => {
      viewerStatus.value = error.message;
    });
    return;
  }
  if (localPlayback.active) {
    return;
  }
  localPlayback.active = session.value?.playback_state === 'playing';
  if (!localPlayback.active) {
    return;
  }
  localPlayback.lastTimestamp = 0;
  localPlayback.accumulator = 0;
  if (!playbackFrameHandle) {
    playbackFrameHandle = window.requestAnimationFrame(localPlaybackStep);
  }
}

function syncViewerFromSession() {
  if (!activeSequence.value) {
    viewerFrameIndex.value = 0;
    stopLocalPlaybackLoop();
    return;
  }
  if (session.value?.physics_enabled) {
    stopLocalPlaybackLoop();
    startBrowserPhysicsLoop(browserPhysics.targetMode).catch((error) => {
      viewerStatus.value = error.message;
    });
    return;
  }
  stopBrowserPhysicsLoop();
  if (session.value?.playback_state === 'playing') {
    if (!localPlayback.active) {
      applyCachedFrame(session.value?.current_frame ?? 0);
    }
    startLocalPlayback();
  } else {
    stopLocalPlaybackLoop();
    if (applyCachedFrame(session.value?.current_frame ?? 0)) {
      viewerStatus.value = `cached ${frameCache.frames.length} frames`;
    }
  }
}

async function loadFrameCacheForActiveSequence() {
  const sequence = activeSequence.value;
  if (!sequence || frameCache.sequenceId === sequence.sequence_id) {
    syncViewerFromSession();
    return;
  }

  const token = frameCacheRequestToken + 1;
  frameCacheRequestToken = token;
  frameCache = {
    sequenceId: null,
    jointNames: [],
    bodyNames: [],
    frames: []
  };
  stopLocalPlaybackLoop();
  viewerStatus.value = 'loading motion frames';

  try {
    const payload = await postJson('/api/get_frames', {
      sequence_id: sequence.sequence_id,
      start: 0,
      end: sequence.frame_count,
      stride: 1
    });
    if (token !== frameCacheRequestToken) {
      return;
    }
    frameCache = {
      sequenceId: payload.sequence_id,
      jointNames: payload.joint_names || sequence.joint_names || [],
      bodyNames: payload.body_names || sequence.body_names || [],
      frames: payload.frames || []
    };
    viewerStatus.value = `cached ${frameCache.frames.length} frames`;
    syncViewerFromSession();
  } catch (error) {
    if (token === frameCacheRequestToken) {
      viewerStatus.value = error.message;
    }
  }
}

async function refreshSession() {
  try {
    session.value = await fetchJson('/api/session');
    renderSession();
    await loadFrameCacheForActiveSequence();
  } catch (error) {
    setStatus(commandStatus, error.message, true);
  }
}

async function runCommand(operation, successText, statusRef = commandStatus) {
  try {
    await operation();
    await refreshSession();
    setStatus(statusRef, successText);
  } catch (error) {
    setStatus(statusRef, error.message, true);
  }
}

async function scanTree() {
  const path = pathInput.value.trim();
  if (!path) {
    setStatus(treeStatus, '请输入数据根目录。', true);
    return;
  }
  try {
    setStatus(treeStatus, '扫描目录中...');
    const payload = await postJson('/api/browser/list', { path });
    treeNodes.value = payload.nodes;
    setStatus(treeStatus, `根目录: ${payload.root}，节点数: ${payload.nodes.length}`);
  } catch (error) {
    setStatus(treeStatus, error.message, true);
  }
}

async function handleTreeNode(node) {
  if (node.node_type !== 'motion') {
    pathInput.value = node.path;
    await scanTree();
    return;
  }
  frameCacheRequestToken += 1;
  frameCache = {
    sequenceId: null,
    jointNames: [],
    bodyNames: [],
    frames: []
  };
  stopLocalPlaybackLoop();
  stopBrowserPhysicsLoop();
  await runCommand(
    () => postJson('/api/session/load', { path: node.path, format: node.format }),
    `已加载 ${node.name}`
  );
}

async function seekTo(frame) {
  const boundedFrame = Math.min(Math.max(Number(frame) || 0, 0), maxFrame.value);
  if (session.value?.physics_enabled) {
    browserPhysics.referenceFrame = boundedFrame;
    browserPhysics.referenceFrameFloat = boundedFrame;
    viewerFrameIndex.value = boundedFrame;
    frameInput.value = boundedFrame;
    browserPhysics.lastPolicyOutput = null;
    if (browserPhysics.targetMode === 'tracking') {
      await switchBrowserPolicyTrackingToActiveClip(boundedFrame);
      await inferBrowserPhysicsTarget(boundedFrame);
      return;
    }
    await pausePhysicsToDefaultStance();
    return;
  }
  stopLocalPlaybackLoop();
  stopBrowserPhysicsLoop();
  viewerFrameIndex.value = boundedFrame;
  applyCachedFrame(viewerFrameIndex.value);
  await runCommand(
    () => postJson('/api/session/playback', { action: 'seek', frame_index: Number(frame) }),
    `已跳到第 ${frame} 帧。`
  );
}

async function setTrimStart() {
  await runCommand(
    () => postJson('/api/session/trim', { action: 'set_start', frame_index: Number(trimStartInput.value) }),
    '已更新裁剪起点。'
  );
}

async function setTrimEnd() {
  await runCommand(
    () => postJson('/api/session/trim', { action: 'set_end', frame_index: Number(trimEndInput.value) }),
    '已更新裁剪终点。'
  );
}

async function togglePhysics() {
  const nextEnabled = !(session.value?.physics_enabled ?? false);
  if (nextEnabled) {
    await postJson('/api/session/playback', { action: 'pause' });
  }
  await postJson('/api/session/physics', { enabled: nextEnabled });
  if (nextEnabled) {
    await resetViewerToDefaultStance();
    await startBrowserPhysicsLoop('default_stance');
  } else {
    stopBrowserPhysicsLoop();
    if (selectedPolicyId.value !== MOCK_BROWSER_POLICY_ID || browserPolicyRuntime.activePolicyId !== MOCK_BROWSER_POLICY_ID) {
      await switchSelectedPolicy(MOCK_BROWSER_POLICY_ID, { resetStance: false });
    }
    applyCachedFrame(viewerFrameIndex.value);
  }
}

async function playPlayback() {
  if (session.value?.physics_enabled) {
    await switchBrowserPolicyTrackingToActiveClip();
    await startBrowserPhysicsLoop('tracking');
    return;
  }
  await postJson('/api/session/playback', { action: 'play' });
}

async function pausePlayback() {
  if (session.value?.physics_enabled) {
    await pausePhysicsToDefaultStance();
    return;
  }
  await postJson('/api/session/playback', { action: 'pause' });
}

async function stopPlayback() {
  if (session.value?.physics_enabled) {
    await pausePhysicsToDefaultStance();
    return;
  }
  await postJson('/api/session/playback', { action: 'stop' });
}

async function resetPhysicsToDefaultStance() {
  if (!session.value?.physics_enabled) {
    throw new Error('请先开启 Physics。');
  }
  await resetViewerToDefaultStance();
  await startBrowserPhysicsLoop('default_stance');
}

async function switchSelectedPolicy(policyId, options = {}) {
  const manifest = policies.value.find((policy) => policy.policy_id === policyId);
  if (!manifest) {
    throw new Error('没有可切换的策略。');
  }
  if (!session.value?.physics_enabled && policyId !== MOCK_BROWSER_POLICY_ID) {
    throw new Error('关闭仿真后只能使用 mock 策略。');
  }
  await postJson('/api/session/playback', { action: 'pause' });
  selectedPolicyId.value = policyId;
  await browserPolicyRuntime.activate(manifest);
  browserPolicyState.value = browserPolicyRuntime.status();
  browserPhysics.lastPolicyOutput = null;
  syncPolicyCardStates();
  if (options.resetStance === false) {
    applyCachedFrame(viewerFrameIndex.value);
    return;
  }
  if (session.value?.physics_enabled) {
    await resetViewerToDefaultStance();
    await startBrowserPhysicsLoop('default_stance');
    return;
  }
  applyCachedFrame(viewerFrameIndex.value);
}

async function queueImpulse(preset) {
  queueBrowserImpulse(preset);
}

function queueBrowserImpulse(preset) {
  if (!session.value?.physics_enabled) {
    throw new Error('请先开启 Physics。');
  }
  viewer?.queueImpulse({
    preset,
    magnitude: Number(impulseMagnitude.value),
    duration: Number(impulseDuration.value)
  });
  setStatus(commandStatus, `已排队浏览器物理冲击: ${preset}`);
}

async function exportTrim() {
  if (!activeSequence.value) {
    throw new Error('请先加载动作。');
  }
  const payload = await postJson('/api/trim_export', {
    sequence_id: activeSequence.value.sequence_id,
    start_frame: Number(trimStartInput.value),
    end_frame: Number(trimEndInput.value)
  });
  setStatus(commandStatus, `已导出到 ${payload.output_path}`);
}

async function initViewer() {
  await nextTick();
  if (!viewerContainer.value) {
    return;
  }
  try {
    const manifest = await fetchJson('/api/assets/browser-scene');
    viewer = new BrowserMujocoViewer(viewerContainer.value, (message) => {
      viewerStatus.value = message;
    });
    await viewer.init(manifest);
    viewerReady.value = true;
    viewerStatus.value = 'viewer ready';
  } catch (error) {
    viewerStatus.value = error.message;
  }
}

onMounted(async () => {
  await initViewer();
  await refreshSession();
  pollHandle = window.setInterval(refreshSession, SESSION_POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (pollHandle) {
    window.clearInterval(pollHandle);
  }
  stopLocalPlaybackLoop();
  stopBrowserPhysicsLoop();
  viewer?.dispose();
});
</script>
