<template>
  <div class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">G1 Browser MuJoCo Console</p>
        <h1>G1 Unified Viewer</h1>
        <p>Browser MuJoCo WASM rendering, Python SessionController orchestration, and policy controls in one dense workspace.</p>
      </div>
      <div class="status-grid">
        <span id="viewerBadge" :class="['badge', viewerReady ? 'ok' : '']">{{ viewerReady ? 'Browser Viewer Ready' : 'Browser Viewer Loading' }}</span>
        <span id="modeBadge" class="badge">模式: {{ session?.view_mode ?? '-' }}</span>
        <span id="playbackBadge" class="badge">播放: {{ session?.playback_state ?? '-' }}</span>
        <span id="policyBadge" class="badge">策略: {{ session?.active_policy_id || '-' }}</span>
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
            <p>Scan and load local motion files through the existing browser API.</p>
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
            <p>Playback controls stay bound to grouped session endpoints.</p>
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
            :value="session?.current_frame ?? 0"
            :disabled="!activeSequence"
            @input="seekTo(Number($event.target.value))"
          />
          <div class="two-col">
            <input id="frameInput" v-model.number="frameInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" />
            <button id="seekButton" class="secondary" :disabled="!activeSequence" @click="seekTo(frameInput)">Seek</button>
          </div>
          <div class="three-col">
            <button id="playButton" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/playback', { action: 'play' }), '开始播放。')">Play</button>
            <button id="pauseButton" class="secondary" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/playback', { action: 'pause' }), '已暂停。')">Pause</button>
            <button id="stopButton" class="secondary" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/playback', { action: 'stop' }), '已停止。')">Stop</button>
          </div>
          <div id="commandStatus" :class="['status', commandStatus.error ? 'error' : '']">{{ commandStatus.text }}</div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>Trim & Export</h2>
            <p>Mark or edit trim bounds without leaving the viewer.</p>
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
            <strong>{{ session?.current_frame ?? 0 }} / {{ maxFrame }}</strong>
            <span>{{ session?.physics_enabled ? 'physics' : 'reference' }}</span>
          </div>
        </div>
      </section>

      <aside class="sidebar right">
        <section class="panel">
          <div class="panel-title">
            <h2>Policy</h2>
            <p>Policy lifecycle remains owned by SessionController.</p>
          </div>
          <div class="three-col">
            <button id="startPolicyButton" @click="runCommand(activateSelectedPolicy, '策略已启动。', policyStatus)">Start</button>
            <button id="stopPolicyButton" class="secondary" @click="runCommand(() => postJson('/api/policies/active', { policy_id: null }), '策略已停止。', policyStatus)">Stop</button>
            <button id="stepPolicyButton" class="secondary" @click="runCommand(stepSelectedPolicy, '策略单步完成。', policyStatus)">Step</button>
          </div>
          <div id="policyStatus" :class="['status', policyStatus.error ? 'error' : '']">{{ policyStatus.text }}</div>
          <div id="policyList" class="policy-list">
            <button
              v-for="policy in policies"
              :key="policy.policy_id"
              :class="['policy-card', policy.policy_id === selectedPolicyId || policy.policy_id === session?.active_policy_id ? 'active' : '']"
              :data-policy-id="policy.policy_id"
              @click="selectPolicy(policy.policy_id)"
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
            <p>Impulse commands still target the native physics runtime when connected.</p>
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
          <button id="resetTestButton" class="secondary" @click="runCommand(() => postJson('/api/viewer/test/reset'), '测试状态已重置。')">Reset Test</button>
        </section>

        <section class="panel diagnostics">
          <div class="panel-title">
            <h2>Diagnostics</h2>
            <p>Raw session state is kept visible for debugging and automation.</p>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchJson, formatJson, postJson } from './api.js';
import { BrowserMujocoViewer } from './simulation/browserMujocoViewer.js';

const viewerContainer = ref(null);
const session = ref(null);
const policies = ref([]);
const selectedPolicyId = ref(null);
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
const policyStatus = ref({ text: '策略清单加载中。', error: false });

let pollHandle = null;
let viewer = null;
let lastPolicySelectionSignature = '';

const activeSequence = computed(() => session.value?.active_sequence ?? null);
const activePath = computed(() => session.value?.active_item_path || activeSequence.value?.source_path || '');
const maxFrame = computed(() => Math.max(0, (activeSequence.value?.frame_count ?? 0) - 1));
const clipSummaryEntries = computed(() => [
  ['名称', activeSequence.value?.name ?? '未加载'],
  ['格式', activeSequence.value?.source_format ?? '-'],
  ['当前帧', `${session.value?.current_frame ?? 0} / ${maxFrame.value}`],
  ['FPS', activeSequence.value ? Number(activeSequence.value.fps).toFixed(2) : '-']
]);
const policyPane = computed(() => formatJson({
  active_policy_id: session.value?.active_policy_id,
  physics_enabled: session.value?.physics_enabled,
  last_policy_result: session.value?.last_policy_result,
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
  frameInput.value = session.value.current_frame;
  trimStartInput.value = session.value.trim_start;
  trimEndInput.value = session.value.trim_end;
}

function syncPolicyCardStates() {
  const signature = JSON.stringify({
    active: session.value?.active_policy_id ?? null,
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

async function refreshSession() {
  try {
    session.value = await fetchJson('/api/session');
    renderSession();
    await refreshViewerState();
  } catch (error) {
    setStatus(commandStatus, error.message, true);
  }
}

async function refreshViewerState() {
  if (!viewer || !activeSequence.value) {
    return;
  }
  try {
    const payload = await fetchJson('/api/session/state');
    viewer.applyState(payload);
  } catch (error) {
    if (!String(error.message).includes('No active sequence')) {
      viewerStatus.value = error.message;
    }
  }
}

async function refreshPolicies() {
  try {
    const payload = await fetchJson('/api/policies');
    policies.value = payload.policies;
    if (!selectedPolicyId.value && policies.value.length > 0) {
      selectedPolicyId.value = policies.value[0].policy_id;
    }
    setStatus(policyStatus, '策略清单已加载。');
  } catch (error) {
    setStatus(policyStatus, error.message, true);
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
  await runCommand(
    () => postJson('/api/session/load', { path: node.path, format: node.format }),
    `已加载 ${node.name}`
  );
}

async function seekTo(frame) {
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
  await postJson('/api/session/physics', { enabled: !(session.value?.physics_enabled ?? false) });
}

function selectPolicy(policyId) {
  selectedPolicyId.value = policyId;
  syncPolicyCardStates();
  setStatus(policyStatus, `已选择策略 ${policyId}`);
}

async function activateSelectedPolicy() {
  if (!selectedPolicyId.value) {
    throw new Error('没有可启动的策略。');
  }
  await postJson('/api/policies/active', { policy_id: selectedPolicyId.value });
}

async function stepSelectedPolicy() {
  if (!selectedPolicyId.value) {
    throw new Error('没有可测试的策略。');
  }
  await postJson('/api/policies/step', { policy_id: selectedPolicyId.value });
}

async function queueImpulse(preset) {
  await postJson('/api/viewer/test/impulse', {
    preset,
    magnitude: Number(impulseMagnitude.value),
    duration: Number(impulseDuration.value)
  });
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
  await refreshPolicies();
  pollHandle = window.setInterval(refreshSession, 500);
});

onBeforeUnmount(() => {
  if (pollHandle) {
    window.clearInterval(pollHandle);
  }
  viewer?.dispose();
});
</script>
