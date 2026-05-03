<template>
  <div class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">{{ t('app.eyebrow') }}</p>
        <h1>G1 Unified Viewer</h1>
        <p>{{ t('app.subtitle') }}</p>
      </div>
      <div class="topbar-controls">
        <div id="languageToggle" class="language-toggle" :aria-label="t('app.language')">
          <button type="button" :class="uiLanguage === 'zh' ? 'active' : ''" @click="setUiLanguage('zh')">中文</button>
          <button type="button" :class="uiLanguage === 'en' ? 'active' : ''" @click="setUiLanguage('en')">EN</button>
        </div>
        <div class="status-grid">
          <span id="viewerBadge" :class="['badge', viewerReady ? 'ok' : '']">{{ viewerReady ? t('viewer.ready') : t('viewer.loading') }}</span>
          <span id="modeBadge" class="badge">{{ t('badges.mode') }}: {{ session?.view_mode ?? '-' }}</span>
          <span id="playbackBadge" class="badge">{{ t('badges.playback') }}: {{ playbackDisplayState }}</span>
          <span id="policyBadge" class="badge">{{ t('badges.policy') }}: {{ browserPolicyState.active_policy_id || '-' }}</span>
          <span id="physicsBadge" :class="['badge', session?.physics_enabled ? 'warn' : '']">{{ session?.physics_enabled ? t('physics.on') : t('physics.off') }}</span>
          <button id="physicsToggleButton" class="secondary" @click="runCommand(togglePhysics, 'status.physicsUpdated')">
            {{ session?.physics_enabled ? t('physics.on') : t('physics.off') }}
          </button>
        </div>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <section class="panel">
          <div class="panel-title">
            <h2>{{ t('data.title') }}</h2>
            <p>{{ t('data.subtitle') }}</p>
          </div>
          <input id="pathInput" v-model="pathInput" type="text" :placeholder="t('data.pathPlaceholder')" />
          <div class="browser-actions">
            <button id="browserUpButton" class="ghost" :disabled="!browserParent" @click="goToParentDirectory">{{ t('data.up') }}</button>
            <button id="scanButton" @click="scanTree">{{ t('data.scan') }}</button>
          </div>
          <div id="browserPath" class="path-chip" :title="browserRoot || pathInput">{{ browserRootDisplayName() }}</div>
          <div id="treeStatus" :class="['status', treeStatus.error ? 'error' : '']">{{ statusText(treeStatus) }}</div>
          <div id="treeRoot" class="tree">
            <button
              v-for="entry in visibleTreeNodes"
              :key="`${entry.node.path}:${entry.depth}`"
              :class="['tree-node', entry.node.node_type, entry.node.path === activePath ? 'active' : '']"
              :style="{ '--tree-depth': entry.depth }"
              :title="entry.node.relative_path || entry.node.name"
              @click="handleTreeNode(entry.node)"
            >
              <span class="tree-icon">{{ entry.node.node_type === 'directory' ? t('data.dir') : t('data.motionAbbrev') }}</span>
              <span class="tree-text">
                <span class="tree-label">{{ browserNodeDisplayName(entry.node) }}</span>
                <span v-if="browserNodeParentPath(entry.node)" class="tree-parent">{{ browserNodeParentPath(entry.node) }}</span>
              </span>
              <span v-if="entry.node.format" class="tree-format">{{ entry.node.format }}</span>
            </button>
          </div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>{{ t('motion.title') }}</h2>
            <p>{{ t('motion.subtitle') }}</p>
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
            <button id="seekButton" class="secondary" :disabled="!activeSequence" @click="seekTo(frameInput)">{{ t('motion.seek') }}</button>
          </div>
          <div class="three-col">
            <button id="playButton" :disabled="!activeSequence" @click="runCommand(playPlayback, 'motion.playDone')">{{ t('motion.play') }}</button>
            <button id="pauseButton" class="secondary" :disabled="!activeSequence" @click="runCommand(pausePlayback, 'motion.pauseDone')">{{ t('motion.pause') }}</button>
            <button id="stopButton" class="secondary" :disabled="!activeSequence" @click="runCommand(stopPlayback, 'motion.stopDone')">{{ t('motion.stop') }}</button>
          </div>
          <div id="commandStatus" :class="['status', commandStatus.error ? 'error' : '']">{{ statusText(commandStatus) }}</div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>{{ t('trim.title') }}</h2>
            <p>{{ t('trim.subtitle') }}</p>
          </div>
          <div class="two-col">
            <input id="trimStartInput" v-model.number="trimStartInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" @change="setTrimStart" />
            <input id="trimEndInput" v-model.number="trimEndInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" @change="setTrimEnd" />
          </div>
          <div class="two-col">
            <button id="markTrimStartButton" class="ghost" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/trim', { action: 'mark_start' }), 'trim.markStartDone')">{{ t('trim.markStart') }}</button>
            <button id="markTrimEndButton" class="ghost" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/trim', { action: 'mark_end' }), 'trim.markEndDone')">{{ t('trim.markEnd') }}</button>
          </div>
          <div class="export-grid">
            <label class="field">
              <span>{{ t('trim.format') }}</span>
              <select id="exportFormatSelect" v-model="exportFormat" :disabled="!activeSequence">
                <option value="sonic">sonic</option>
                <option value="twist2">twist2</option>
              </select>
            </label>
            <label class="field">
              <span>{{ t('trim.twist2Extension') }}</span>
              <select id="twist2ExtensionSelect" v-model="twist2Extension" :disabled="!activeSequence || exportFormat !== 'twist2'">
                <option value=".pkl">.pkl</option>
                <option value=".npz">.npz</option>
                <option value=".json">.json</option>
              </select>
            </label>
          </div>
          <label class="field">
            <span>{{ t('trim.outputFolder') }}</span>
            <input id="exportOutputDirInput" v-model="exportOutputDir" type="text" :placeholder="t('trim.outputPlaceholder')" :disabled="!activeSequence" />
          </label>
          <div id="trimSummary" class="note">{{ t('trim.summary', { start: session?.trim_start ?? 0, end: session?.trim_end ?? 0 }) }}</div>
          <button id="exportButton" class="secondary" :disabled="!activeSequence" @click="runCommand(exportTrim, 'trim.exportDone')">{{ t('trim.export') }}</button>
        </section>
      </aside>

      <section class="viewer-column">
        <div class="viewer-toolbar">
          <div>
            <p class="eyebrow">{{ t('viewer.eyebrow') }}</p>
            <h2>{{ activeSequence?.name || t('viewer.noMotionTitle') }}</h2>
          </div>
          <span :class="['badge', viewerReady ? 'ok' : '']">{{ statusText(viewerStatus) }}</span>
        </div>
        <div class="viewer-frame">
          <div ref="viewerContainer" class="mujoco-stage"></div>
          <div class="viewer-overlay">
            <span>{{ activeSequence?.source_format || t('viewer.noClip') }}</span>
            <strong>{{ viewerFrameIndex }} / {{ maxFrame }}</strong>
            <span>{{ session?.physics_enabled ? t('viewer.physics') : t('viewer.reference') }}</span>
          </div>
        </div>
      </section>

      <aside class="sidebar right">
        <section class="panel">
          <div class="panel-title">
            <h2>{{ t('policy.title') }}</h2>
            <p>{{ t('policy.subtitle') }}</p>
          </div>
          <div id="policyStatus" :class="['status', policyStatus.error ? 'error' : '']">{{ statusText(policyStatus) }}</div>
          <div id="policyList" class="policy-browser">
            <div id="policyGroupList" class="policy-group-list">
              <button
                v-for="group in policyGroups"
                :key="group.id"
                :class="['policy-folder', group.id === selectedPolicyGroupId ? 'active' : '', group.id === 'mock' ? 'mock' : '']"
                :disabled="group.id === 'mock' && policyDisabled(group.policies[0])"
                @click="runCommand(() => selectPolicyGroup(group.id), 'policy.groupSelected', policyStatus)"
              >
                <span class="folder-icon">{{ group.id === 'mock' ? t('policy.mockIcon') : t('policy.folderIcon') }}</span>
                <span class="folder-text">
                  <strong>{{ group.label }}</strong>
                  <small>{{ group.count }} {{ group.count === 1 ? t('policy.model') : t('policy.models') }}</small>
                </span>
                <span v-if="group.active" class="folder-dot"></span>
              </button>
            </div>
            <div id="policyModelList" class="policy-list">
              <button
                v-for="policy in visiblePolicies"
                :key="policy.policy_id"
                :class="['policy-card', policy.policy_id === selectedPolicyId || policy.policy_id === browserPolicyState.active_policy_id ? 'active' : '']"
                :data-policy-id="policy.policy_id"
                :disabled="policyDisabled(policy)"
                @click="runCommand(() => switchSelectedPolicy(policy.policy_id), 'policy.switchDone', policyStatus)"
              >
                <strong>{{ policyLabel(policy) }}</strong>
                <span>{{ policy.policy_id }} / {{ policy.control_mode }}</span>
                <small>{{ policyDescription(policy) || t('policy.noDescription') }}</small>
              </button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-title">
            <h2>{{ t('test.title') }}</h2>
            <p>{{ t('test.subtitle') }}</p>
          </div>
          <div class="two-col">
            <input id="impulseMagnitudeInput" v-model.number="impulseMagnitude" type="number" min="1" max="500" />
            <input id="impulseDurationInput" v-model.number="impulseDuration" type="number" min="0.01" max="5" step="0.01" />
          </div>
          <div class="impulse-grid">
            <button class="impulseButton ghost" data-preset="push_forward" @click="runCommand(() => queueImpulse('push_forward'), statusMessage('test.impulseQueued', { preset: 'push_forward' }))">{{ t('test.forward') }}</button>
            <button class="impulseButton ghost" data-preset="push_backward" @click="runCommand(() => queueImpulse('push_backward'), statusMessage('test.impulseQueued', { preset: 'push_backward' }))">{{ t('test.backward') }}</button>
            <button class="impulseButton ghost" data-preset="push_left" @click="runCommand(() => queueImpulse('push_left'), statusMessage('test.impulseQueued', { preset: 'push_left' }))">{{ t('test.left') }}</button>
            <button class="impulseButton ghost" data-preset="push_right" @click="runCommand(() => queueImpulse('push_right'), statusMessage('test.impulseQueued', { preset: 'push_right' }))">{{ t('test.right') }}</button>
            <button class="impulseButton ghost" data-preset="lift_up" @click="runCommand(() => queueImpulse('lift_up'), statusMessage('test.impulseQueued', { preset: 'lift_up' }))">{{ t('test.lift') }}</button>
          </div>
          <div class="test-actions">
            <button
              id="resetStanceButton"
              class="secondary"
              :disabled="!session?.physics_enabled || !activeSequence"
              @click="runCommand(resetPhysicsToDefaultStance, 'test.resetStanceDone')"
            >
              {{ t('test.resetStance') }}
            </button>
          </div>
          <div class="test-maintenance">
            <button id="resetTestButton" class="ghost" @click="runCommand(() => postJson('/api/viewer/test/reset'), 'test.clearDone')">{{ t('test.clear') }}</button>
          </div>
        </section>

        <section class="panel diagnostics">
          <div class="panel-title">
            <h2>{{ t('diagnostics.title') }}</h2>
            <p>{{ t('diagnostics.subtitle') }}</p>
          </div>
          <h3>{{ t('diagnostics.policyFeed') }}</h3>
          <pre id="policyPane">{{ policyPane }}</pre>
          <h3>{{ t('diagnostics.cameraFeed') }}</h3>
          <pre id="cameraPane">{{ cameraPane }}</pre>
          <h3>{{ t('diagnostics.log') }}</h3>
          <pre id="logPane">{{ logPane }}</pre>
          <h3>{{ t('diagnostics.observation') }}</h3>
          <pre id="observationPane">{{ observationPane }}</pre>
          <h3>{{ t('diagnostics.action') }}</h3>
          <pre id="actionPane">{{ actionPane }}</pre>
          <h3>{{ t('diagnostics.dragTest') }}</h3>
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
import {
  DEFAULT_BROWSER_POLICY_MANIFESTS,
  browserRunnablePolicies,
  createBrowserPolicyRuntime,
  normalizeFrameCacheAsMotionClip
} from './simulation/policyRuntime.js';

const viewerContainer = ref(null);
const session = ref(null);
const policies = ref([...DEFAULT_BROWSER_POLICY_MANIFESTS]);
const selectedPolicyId = ref(DEFAULT_BROWSER_POLICY_MANIFESTS[0]?.policy_id ?? null);
const selectedPolicyGroupId = ref('mock');
const uiLanguage = ref('zh');
const DEFAULT_DATASET_ROOT = '/home/huanghao/source/datasets/gmr_retarget_x/AMASS_numpy123';
const pathInput = ref(DEFAULT_DATASET_ROOT);
const treeNodes = ref([]);
const browserRoot = ref('');
const browserParent = ref(null);
const frameInput = ref(0);
const trimStartInput = ref(0);
const trimEndInput = ref(0);
const exportFormat = ref('sonic');
const twist2Extension = ref('.pkl');
const exportOutputDir = ref('');
const impulseMagnitude = ref(80);
const impulseDuration = ref(0.15);
const viewerStatus = ref({ key: 'viewer.initializing' });
const viewerReady = ref(false);
const commandStatus = ref({ key: 'status.waiting', error: false });
const treeStatus = ref({ key: 'data.defaultRootReady', error: false });
const policyStatus = ref({ key: 'policy.browserLocal', error: false });
const browserPolicyState = ref({
  active_policy_id: null,
  last_policy_result: null
});

const SESSION_POLL_INTERVAL_MS = 500;
const POLICY_PLUGIN_REFRESH_INTERVAL_MS = 5000;
const LOCAL_PLAYBACK_RENDER_INTERVAL_MS = 30;
const DEFAULT_BROWSER_PHYSICS_CONTROL_DT = 0.02;
const MOCK_BROWSER_POLICY_ID = 'mock_passthrough';
const ACTIVE_BROWSER_MOTION_NAME = 'active_clip';
const ACTIVE_BROWSER_MOTION_TRANSITION_STEPS = 0;
const BROWSER_PHYSICS_END_HOLD_SECONDS = 0.6;
const UI_MESSAGES = Object.freeze({
  zh: {
    app: {
      eyebrow: 'G1 浏览器 MuJoCo 控制台',
      subtitle: '浏览器 MuJoCo WASM 渲染、数据集播放、策略控制和动作裁剪工具。',
      language: '界面语言'
    },
    viewer: {
      eyebrow: '浏览器 MuJoCo WASM',
      ready: '浏览器 Viewer 就绪',
      loading: '浏览器 Viewer 加载中',
      initializing: 'viewer 初始化中',
      readyShort: 'viewer 就绪',
      loadingFrames: '正在加载动作帧',
      cachedFrames: '已缓存 {count} 帧',
      holdingDefaultStance: '浏览器物理正在保持默认站姿',
      physicsRunning: '浏览器物理运行中',
      noMotionTitle: '加载动作后驱动模型',
      noClip: '无动作',
      physics: '物理',
      reference: '参考'
    },
    badges: {
      mode: '模式',
      playback: '播放',
      policy: '策略'
    },
    physics: {
      on: 'Physics 开',
      off: 'Physics 关'
    },
    data: {
      title: '数据',
      subtitle: '加载本地动作片段。',
      pathPlaceholder: '输入数据根目录',
      up: '上一级',
      scan: '扫描',
      dir: '目录',
      motionAbbrev: '动作',
      defaultRootReady: '默认数据根目录已填入，点击扫描读取。',
      noDirectory: '未选择目录',
      rootRequired: '请输入数据根目录。',
      scanLoading: '扫描目录中...',
      currentDirectory: '当前目录: {root}，当前层节点数: {count}'
    },
    motion: {
      title: '动作',
      subtitle: '浏览器缓存播放。',
      name: '名称',
      format: '格式',
      currentFrame: '当前帧',
      notLoaded: '未加载',
      seek: '跳转',
      play: '播放',
      pause: '暂停',
      stop: '停止',
      playing: '播放中',
      paused: '已暂停',
      playDone: '开始播放。',
      pauseDone: '已暂停。',
      stopDone: '已停止。',
      seekDone: '已跳到第 {frame} 帧。',
      framesRequired: '请先加载动作帧。',
      motionRequired: '请先加载动作。'
    },
    playback: {
      playing: '播放中',
      paused: '已暂停',
      stopped: '已停止'
    },
    trim: {
      title: '裁剪导出',
      subtitle: '标记动作片段边界。',
      markStart: '标记起点',
      markEnd: '标记终点',
      format: '格式',
      twist2Extension: 'twist2 后缀',
      outputFolder: '输出文件夹',
      outputPlaceholder: '留空使用默认 exports 目录',
      summary: '裁剪区间: {start} 至 {end}',
      export: '导出裁剪',
      markStartDone: '已标记裁剪起点。',
      markEndDone: '已标记裁剪终点。',
      startUpdated: '已更新裁剪起点。',
      endUpdated: '已更新裁剪终点。',
      exportDone: '裁剪导出完成。',
      exportedTo: '已导出到 {path}'
    },
    policy: {
      title: '策略',
      subtitle: '选择策略种类，再选择模型。',
      model: '个模型',
      models: '个模型',
      mockIcon: '模拟',
      folderIcon: '目录',
      noDescription: '无描述',
      switchDone: '策略已切换。',
      groupSelected: '策略列表已切换。',
      pluginsLoaded: '策略插件已加载。',
      browserLocal: '策略在浏览器本地运行。',
      fallbackList: '使用内置策略列表: {message}',
      noneAvailable: '没有可切换的策略。',
      mockOnlyWhenPhysicsOff: '关闭仿真后只能使用 mock 策略。'
    },
    test: {
      title: '测试',
      subtitle: '物理冲击测试。',
      forward: '向前',
      backward: '向后',
      left: '向左',
      right: '向右',
      lift: '抬起',
      resetStance: '恢复站姿',
      clear: '清空测试状态',
      resetStanceDone: '已恢复默认站姿。',
      clearDone: '测试状态已清空。',
      impulseQueued: '已排队测试冲击: {preset}',
      browserImpulseQueued: '已排队浏览器物理冲击: {preset}',
      physicsRequired: '请先开启 Physics。'
    },
    diagnostics: {
      title: '诊断',
      subtitle: 'Session 调试信息。',
      policyFeed: '策略信息',
      cameraFeed: '相机信息',
      log: '日志',
      observation: '观测',
      action: '动作输出',
      dragTest: '拖拽/测试',
      cameraWaiting: '等待 MuJoCo viewer 连接...',
      noLogs: '暂无日志。'
    },
    status: {
      waiting: '等待操作。',
      physicsUpdated: 'Physics 状态已更新。',
      loadedMotion: '已加载 {name}'
    }
  },
  en: {
    app: {
      eyebrow: 'G1 Browser MuJoCo Console',
      subtitle: 'Browser MuJoCo WASM renderer with dataset playback, policy controls, and trim tools.',
      language: 'Interface language'
    },
    viewer: {
      eyebrow: 'Browser MuJoCo WASM',
      ready: 'Browser Viewer Ready',
      loading: 'Browser Viewer Loading',
      initializing: 'viewer initializing',
      readyShort: 'viewer ready',
      loadingFrames: 'loading motion frames',
      cachedFrames: 'cached {count} frames',
      holdingDefaultStance: 'browser physics holding default stance',
      physicsRunning: 'browser physics running',
      noMotionTitle: 'Load a motion to drive the model',
      noClip: 'no clip',
      physics: 'physics',
      reference: 'reference'
    },
    badges: {
      mode: 'Mode',
      playback: 'Playback',
      policy: 'Policy'
    },
    physics: {
      on: 'Physics ON',
      off: 'Physics OFF'
    },
    data: {
      title: 'Data',
      subtitle: 'Load local motion clips.',
      pathPlaceholder: 'Enter dataset root',
      up: 'Up',
      scan: 'Scan',
      dir: 'DIR',
      motionAbbrev: 'MOT',
      defaultRootReady: 'Default dataset root is filled. Click Scan to load.',
      noDirectory: 'No directory selected',
      rootRequired: 'Enter a dataset root.',
      scanLoading: 'Scanning directory...',
      currentDirectory: 'Current directory: {root}, nodes in this level: {count}'
    },
    motion: {
      title: 'Motion',
      subtitle: 'Cached browser playback.',
      name: 'Name',
      format: 'Format',
      currentFrame: 'Current frame',
      notLoaded: 'Not loaded',
      seek: 'Seek',
      play: 'Play',
      pause: 'Pause',
      stop: 'Stop',
      playing: 'playing',
      paused: 'paused',
      playDone: 'Playback started.',
      pauseDone: 'Paused.',
      stopDone: 'Stopped.',
      seekDone: 'Jumped to frame {frame}.',
      framesRequired: 'Load motion frames first.',
      motionRequired: 'Load a motion first.'
    },
    playback: {
      playing: 'playing',
      paused: 'paused',
      stopped: 'stopped'
    },
    trim: {
      title: 'Trim & Export',
      subtitle: 'Mark clip bounds.',
      markStart: 'Mark Start',
      markEnd: 'Mark End',
      format: 'Format',
      twist2Extension: 'twist2 suffix',
      outputFolder: 'Output folder',
      outputPlaceholder: 'Leave blank to use the default exports folder',
      summary: 'Trim range: {start} to {end}',
      export: 'Export Trim',
      markStartDone: 'Trim start marked.',
      markEndDone: 'Trim end marked.',
      startUpdated: 'Trim start updated.',
      endUpdated: 'Trim end updated.',
      exportDone: 'Trim export finished.',
      exportedTo: 'Exported to {path}'
    },
    policy: {
      title: 'Policy',
      subtitle: 'Choose a policy folder, then select a model.',
      model: 'model',
      models: 'models',
      mockIcon: 'MOCK',
      folderIcon: 'DIR',
      noDescription: 'No description',
      switchDone: 'Policy switched.',
      groupSelected: 'Policy folder selected.',
      pluginsLoaded: 'Policy plugins loaded.',
      browserLocal: 'Policies run locally in the browser.',
      fallbackList: 'Using bundled policy list: {message}',
      noneAvailable: 'No policy is available.',
      mockOnlyWhenPhysicsOff: 'Only the mock policy can be used when physics is off.'
    },
    test: {
      title: 'Test',
      subtitle: 'Physics impulse tests.',
      forward: 'Forward',
      backward: 'Backward',
      left: 'Left',
      right: 'Right',
      lift: 'Lift',
      resetStance: 'Reset Stance',
      clear: 'Clear Test State',
      resetStanceDone: 'Default stance restored.',
      clearDone: 'Test state cleared.',
      impulseQueued: 'Queued test impulse: {preset}',
      browserImpulseQueued: 'Queued browser physics impulse: {preset}',
      physicsRequired: 'Turn Physics on first.'
    },
    diagnostics: {
      title: 'Diagnostics',
      subtitle: 'Session debug feed.',
      policyFeed: 'Policy Feed',
      cameraFeed: 'Camera Feed',
      log: 'Log',
      observation: 'Observation',
      action: 'Action',
      dragTest: 'Drag/Test',
      cameraWaiting: 'Waiting for MuJoCo viewer connection...',
      noLogs: 'No logs yet.'
    },
    status: {
      waiting: 'Waiting for operation.',
      physicsUpdated: 'Physics state updated.',
      loadedMotion: 'Loaded {name}'
    }
  }
});

let pollHandle = null;
let policyRefreshHandle = null;
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
  endHoldStepsRemaining: 0,
  lastPolicyOutput: null,
  targetMode: 'default_stance',
  switchingMotion: false,
  controlDt: DEFAULT_BROWSER_PHYSICS_CONTROL_DT,
  loopToken: 0
});

const activeSequence = computed(() => session.value?.active_sequence ?? null);
const activePath = computed(() => session.value?.active_item_path || activeSequence.value?.source_path || '');
const maxFrame = computed(() => Math.max(0, (activeSequence.value?.frame_count ?? 0) - 1));
const viewerFrameIndex = ref(0);
const playbackDisplayState = computed(() => {
  if (session.value?.physics_enabled) {
    return browserPhysics.targetMode === 'tracking' ? t('motion.playing') : t('motion.paused');
  }
  const state = session.value?.playback_state;
  if (!state) {
    return '-';
  }
  const key = `playback.${state}`;
  const label = t(key);
  return label === key ? state : label;
});
const clipSummaryEntries = computed(() => [
  [t('motion.name'), activeSequence.value?.name ?? t('motion.notLoaded')],
  [t('motion.format'), activeSequence.value?.source_format ?? '-'],
  [t('motion.currentFrame'), `${viewerFrameIndex.value} / ${maxFrame.value}`],
  ['FPS', activeSequence.value ? Number(activeSequence.value.fps).toFixed(2) : '-']
]);
const visibleTreeNodes = computed(() => flattenBrowserNodes(treeNodes.value));
const policyGroups = computed(() => {
  const mockPolicy = policies.value.find((policy) => policy.policy_id === MOCK_BROWSER_POLICY_ID);
  const groups = [];
  if (mockPolicy) {
    groups.push({
      id: 'mock',
      label: policyLabel(mockPolicy),
      count: 1,
      active: selectedPolicyId.value === mockPolicy.policy_id || browserPolicyState.value.active_policy_id === mockPolicy.policy_id,
      policies: [mockPolicy]
    });
  }

  const byFormat = new Map();
  for (const policy of policies.value) {
    if (policy.policy_id === MOCK_BROWSER_POLICY_ID) {
      continue;
    }
    const formatId = policy.format_id || policy.policy_id;
    if (!byFormat.has(formatId)) {
      byFormat.set(formatId, []);
    }
    byFormat.get(formatId).push(policy);
  }

  for (const [formatId, groupPolicies] of [...byFormat.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const firstPolicy = groupPolicies[0];
    groups.push({
      id: formatId,
      label: policyGroupLabel(formatId, firstPolicy),
      count: groupPolicies.length,
      active: groupPolicies.some((policy) => (
        selectedPolicyId.value === policy.policy_id
        || browserPolicyState.value.active_policy_id === policy.policy_id
      )),
      policies: groupPolicies
    });
  }
  return groups;
});
const visiblePolicies = computed(() => {
  const group = policyGroups.value.find((candidate) => candidate.id === selectedPolicyGroupId.value)
    || policyGroups.value[0];
  if (group?.id === 'mock') {
    return [];
  }
  return group?.policies ?? [];
});
const policyPane = computed(() => formatJson({
  active_policy_id: browserPolicyState.value.active_policy_id,
  physics_enabled: session.value?.physics_enabled,
  last_policy_result: browserPolicyState.value.last_policy_result,
  last_error: session.value?.last_error
}));
const cameraPane = computed(() => session.value?.viewer_camera
  ? formatJson({ connected: session.value.viewer_connected, camera: session.value.viewer_camera })
  : t('diagnostics.cameraWaiting'));
const logPane = computed(() => session.value?.last_log_messages?.length ? session.value.last_log_messages.join('\n') : t('diagnostics.noLogs'));
const observationPane = computed(() => formatJson(session.value?.last_observation_summary));
const actionPane = computed(() => formatJson(session.value?.last_action_summary));
const dragPane = computed(() => formatJson({
  viewer_interaction: session.value?.viewer_interaction,
  test_state: session.value?.test_state
}));

function formatTemplate(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  ));
}

function makeStatus(key, params = {}, error = false) {
  return { key, params, error };
}

function setStatus(target, message, error = false) {
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    target.value = { ...message, error: Boolean(error || message.error) };
    return;
  }
  if (typeof message === 'string' && message.includes('.') && t(message) !== message) {
    target.value = makeStatus(message, {}, error);
    return;
  }
  target.value = { text: String(message ?? ''), error };
}

function t(key, params = {}) {
  const parts = key.split('.');
  let value = UI_MESSAGES[uiLanguage.value] || UI_MESSAGES.zh;
  for (const part of parts) {
    value = value?.[part];
  }
  if (typeof value === 'string') {
    return formatTemplate(value, params);
  }
  let fallback = UI_MESSAGES.zh;
  for (const part of parts) {
    fallback = fallback?.[part];
  }
  return typeof fallback === 'string' ? formatTemplate(fallback, params) : key;
}

function statusMessage(key, params = {}) {
  return makeStatus(key, params);
}

function statusText(status) {
  if (typeof status === 'string') {
    return status;
  }
  if (status?.key) {
    return t(status.key, status.params || {});
  }
  return status?.text || '';
}

function setUiLanguage(language) {
  if (language === 'zh' || language === 'en') {
    uiLanguage.value = language;
  }
}

function localizedValue(value, fallback = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value[uiLanguage.value] || value.zh || value.en || fallback;
  }
  return typeof value === 'string' && value ? value : fallback;
}

function policyLabel(policy) {
  if (!policy) {
    return '';
  }
  return localizedValue(policy.display_name_i18n, policy.display_name || policy.policy_id || '');
}

function policyDescription(policy) {
  if (!policy) {
    return '';
  }
  return localizedValue(policy.description_i18n, policy.description || '');
}

function policyGroupLabel(formatId, policy) {
  if (formatId === 'mock') {
    return policyLabel(policy);
  }
  if (formatId === 'motion_tracking') {
    return uiLanguage.value === 'zh' ? '运动追踪' : 'Motion Tracking';
  }
  if (formatId === 'twist2') {
    return 'Twist2';
  }
  return localizedValue(policy?.format_name_i18n, formatId || policyLabel(policy));
}

function selectedPolicyGroupForPolicy(policy) {
  if (!policy || policy.policy_id === MOCK_BROWSER_POLICY_ID) {
    return 'mock';
  }
  return policy.format_id || policy.policy_id;
}

function ensurePolicySelectionGroup() {
  const selectedPolicy = policies.value.find((policy) => policy.policy_id === selectedPolicyId.value);
  const nextGroup = selectedPolicyGroupForPolicy(selectedPolicy);
  if (policyGroups.value.some((group) => group.id === nextGroup)) {
    selectedPolicyGroupId.value = nextGroup;
    return;
  }
  selectedPolicyGroupId.value = policyGroups.value[0]?.id ?? 'mock';
}

function flattenBrowserNodes(nodes, depth = 0) {
  const entries = [];
  for (const node of nodes ?? []) {
    entries.push({ node, depth });
    if (node.children?.length) {
      entries.push(...flattenBrowserNodes(node.children, depth + 1));
    }
  }
  return entries;
}

function browserNodeDisplayName(node) {
  const label = node.relative_path || node.name || '';
  const parts = label.split('/');
  return parts.at(-1) || label;
}

function browserNodeParentPath(node) {
  const label = node.relative_path || node.name || '';
  const parts = label.split('/');
  if (parts.length <= 1) {
    return '';
  }
  return parts.slice(0, -1).join('/');
}

function browserRootDisplayName() {
  return browserRoot.value || pathInput.value || t('data.noDirectory');
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
    selected: selectedPolicyId.value,
    group: selectedPolicyGroupId.value
  });
  if (signature === lastPolicySelectionSignature) {
    return;
  }
  lastPolicySelectionSignature = signature;
}

async function loadPolicyPlugins(options = {}) {
  const quiet = Boolean(options.quiet);
  try {
    const payload = await fetchJson('/api/policy-plugins');
    policies.value = browserRunnablePolicies(payload.policies);
    if (!policies.value.length) {
      policies.value = [...DEFAULT_BROWSER_POLICY_MANIFESTS];
    }
    if (!policies.value.some((policy) => policy.policy_id === selectedPolicyId.value)) {
      selectedPolicyId.value = policies.value[0]?.policy_id ?? null;
    }
    ensurePolicySelectionGroup();
    if (!quiet) {
      setStatus(policyStatus, 'policy.pluginsLoaded');
    }
  } catch (error) {
    if (quiet) {
      return;
    }
    policies.value = [...DEFAULT_BROWSER_POLICY_MANIFESTS];
    selectedPolicyId.value = policies.value[0]?.policy_id ?? null;
    ensurePolicySelectionGroup();
    setStatus(policyStatus, makeStatus('policy.fallbackList', { message: error.message }), true);
  }
}

async function selectPolicyGroup(groupId) {
  const group = policyGroups.value.find((candidate) => candidate.id === groupId);
  if (!group) {
    return;
  }
  selectedPolicyGroupId.value = group.id;
  if (group.id === 'mock') {
    await switchSelectedPolicy(MOCK_BROWSER_POLICY_ID);
  }
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

function resolveBrowserPhysicsControlDt(target = null) {
  const candidate = Number(target?.control_dt ?? browserPhysics.controlDt ?? DEFAULT_BROWSER_PHYSICS_CONTROL_DT);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_BROWSER_PHYSICS_CONTROL_DT;
}

function syncBrowserPhysicsControlDt(target = null) {
  browserPhysics.controlDt = resolveBrowserPhysicsControlDt(target);
  return browserPhysics.controlDt;
}

function defaultStanceFramePayload() {
  const target = browserPolicyRuntime.defaultStance();
  syncBrowserPhysicsControlDt(target);
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
    { startFrame, transitionSteps: ACTIVE_BROWSER_MOTION_TRANSITION_STEPS }
  );
}

async function stepBrowserPolicyAtFrame(frameIndex) {
  const payload = framePayloadForIndex(frameIndex);
  if (!payload) {
    throw new Error(t('motion.framesRequired'));
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
  browserPhysics.endHoldStepsRemaining = 0;
  browserPhysics.lastPolicyOutput = null;
  browserPhysics.targetMode = 'default_stance';
  browserPhysics.loopToken += 1;
  browserPhysics.controlDt = DEFAULT_BROWSER_PHYSICS_CONTROL_DT;
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
    syncBrowserPhysicsControlDt(output);
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
  syncBrowserPhysicsControlDt(target);
  const payload = makePolicyTargetPayload(target, viewerFrameIndex.value, 'default_stance');
  if (payload) {
    viewer?.resetPhysics(payload);
  }
  resetBrowserPolicyTrackingToDefault();
  viewerStatus.value = makeStatus('viewer.holdingDefaultStance');
  return target;
}

function pausePhysicsToDefaultStance() {
  browserPhysics.targetMode = 'default_stance';
  browserPhysics.endHoldStepsRemaining = 0;
  return resetViewerToDefaultStance();
}

function browserPhysicsEndHoldSteps() {
  return Math.ceil(BROWSER_PHYSICS_END_HOLD_SECONDS / browserPhysics.controlDt);
}

function shouldHoldCompletedTracking() {
  const trackingState = browserPolicyRuntime.trackingState();
  return Boolean(
    trackingState
    && trackingState.available
    && !trackingState.isDefault
    && !trackingState.currentDone
  );
}

function advanceBrowserPhysicsReferenceFrame() {
  const fps = Math.max(1, Number(activeSequence.value.fps) || 30);
  const nextFrameFloat = browserPhysics.referenceFrameFloat + fps * browserPhysics.controlDt;
  if (nextFrameFloat > maxFrame.value) {
    if (session.value?.loop_enabled) {
      browserPhysics.endHoldStepsRemaining = 0;
      browserPhysics.referenceFrameFloat = 0;
      browserPhysics.referenceFrame = 0;
      return { frameIndex: 0, looped: true, ended: false };
    }
    if (shouldHoldCompletedTracking() || browserPhysics.endHoldStepsRemaining > 0) {
      if (browserPhysics.endHoldStepsRemaining === 0) {
        browserPhysics.endHoldStepsRemaining = browserPhysicsEndHoldSteps();
      }
      browserPhysics.endHoldStepsRemaining -= 1;
      browserPhysics.referenceFrameFloat = maxFrame.value;
      browserPhysics.referenceFrame = maxFrame.value;
      return { frameIndex: maxFrame.value, looped: false, ended: false, holdingEnd: true };
    }
    browserPhysics.endHoldStepsRemaining = 0;
    browserPhysics.referenceFrameFloat = 0;
    browserPhysics.referenceFrame = 0;
    return { frameIndex: 0, looped: false, ended: true };
  }
  browserPhysics.endHoldStepsRemaining = 0;
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

      if (!browserPhysics.active || token !== browserPhysics.loopToken) {
        break;
      }
      viewer.stepPhysics({
        joint_names: target?.joint_names || frameCache.jointNames,
        joint_positions: target?.joint_positions || [],
        kp: target?.kp,
        kd: target?.kd,
        torque_limits: target?.torque_limits,
        physics_options: target?.physics_options,
        steps: viewer.getPhysicsDecimation(target?.control_dt ?? browserPhysics.controlDt),
        now: performance.now()
      });
      viewerStatus.value = browserPhysics.targetMode === 'default_stance'
        ? makeStatus('viewer.holdingDefaultStance')
        : makeStatus('viewer.physicsRunning');
    } catch (error) {
      setStatus(policyStatus, error.message, true);
    }

    const elapsed = performance.now() - loopStart;
    const sleepTime = (browserPhysics.controlDt * 1000) - elapsed;
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
      browserPhysics.endHoldStepsRemaining = 0;
      await switchBrowserPolicyTrackingToActiveClip();
      await inferBrowserPhysicsTarget(browserPhysics.referenceFrame);
    }
  } else if (previousMode !== targetMode) {
    if (targetMode === 'default_stance') {
      await resetViewerToDefaultStance();
    } else {
      browserPhysics.referenceFrameFloat = browserPhysics.referenceFrame;
      browserPhysics.endHoldStepsRemaining = 0;
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
    if (browserPhysics.switchingMotion) {
      return;
    }
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
      viewerStatus.value = makeStatus('viewer.cachedFrames', { count: frameCache.frames.length });
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
  viewerStatus.value = makeStatus('viewer.loadingFrames');

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
    viewerStatus.value = makeStatus('viewer.cachedFrames', { count: frameCache.frames.length });
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
    if (successText) {
      setStatus(statusRef, successText);
    }
  } catch (error) {
    setStatus(statusRef, error.message, true);
  }
}

async function scanTree() {
  const path = pathInput.value.trim();
  if (!path) {
    setStatus(treeStatus, 'data.rootRequired', true);
    return;
  }
  await scanTreeAt(path);
}

async function scanTreeAt(path) {
  try {
    setStatus(treeStatus, 'data.scanLoading');
    const payload = await postJson('/api/browser/list', { path });
    browserRoot.value = payload.root;
    browserParent.value = payload.parent || null;
    pathInput.value = payload.root;
    treeNodes.value = payload.nodes;
    setStatus(treeStatus, makeStatus('data.currentDirectory', { root: payload.root, count: payload.nodes.length }));
  } catch (error) {
    setStatus(treeStatus, error.message, true);
  }
}

async function goToParentDirectory() {
  if (!browserParent.value) {
    return;
  }
  await scanTreeAt(browserParent.value);
}

async function handleTreeNode(node) {
  if (node.node_type === 'directory') {
    await scanTreeAt(node.path);
    return;
  }
  if (node.node_type !== 'motion') {
    return;
  }
  const wasPhysicsEnabled = Boolean(session.value?.physics_enabled);
  browserPhysics.switchingMotion = wasPhysicsEnabled;
  frameCacheRequestToken += 1;
  frameCache = {
    sequenceId: null,
    jointNames: [],
    bodyNames: [],
    frames: []
  };
  stopLocalPlaybackLoop();
  if (!wasPhysicsEnabled) {
    stopBrowserPhysicsLoop();
  } else {
    stopBrowserPhysicsLoop();
    browserPhysics.targetMode = 'default_stance';
    browserPhysics.switchingMotion = true;
    browserPhysics.referenceFrame = 0;
    browserPhysics.referenceFrameFloat = 0;
    browserPhysics.endHoldStepsRemaining = 0;
    browserPhysics.lastPolicyOutput = null;
    resetBrowserPolicyTrackingToDefault();
  }
  try {
    await postJson('/api/session/load', { path: node.path, format: node.format });
    await refreshSession();
    if (wasPhysicsEnabled) {
      await resetViewerToDefaultStance();
      await startBrowserPhysicsLoop('default_stance');
    }
    setStatus(commandStatus, makeStatus('status.loadedMotion', { name: node.name }));
  } catch (error) {
    setStatus(commandStatus, error.message, true);
  } finally {
    browserPhysics.switchingMotion = false;
  }
}

async function seekTo(frame) {
  const boundedFrame = Math.min(Math.max(Number(frame) || 0, 0), maxFrame.value);
  if (session.value?.physics_enabled) {
      browserPhysics.referenceFrame = boundedFrame;
      browserPhysics.referenceFrameFloat = boundedFrame;
      browserPhysics.endHoldStepsRemaining = 0;
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
    statusMessage('motion.seekDone', { frame })
  );
}

async function setTrimStart() {
  await runCommand(
    () => postJson('/api/session/trim', { action: 'set_start', frame_index: Number(trimStartInput.value) }),
    'trim.startUpdated'
  );
}

async function setTrimEnd() {
  await runCommand(
    () => postJson('/api/session/trim', { action: 'set_end', frame_index: Number(trimEndInput.value) }),
    'trim.endUpdated'
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
    throw new Error(t('test.physicsRequired'));
  }
  await resetViewerToDefaultStance();
  await startBrowserPhysicsLoop('default_stance');
}

async function switchSelectedPolicy(policyId, options = {}) {
  const manifest = policies.value.find((policy) => policy.policy_id === policyId);
  if (!manifest) {
    throw new Error(t('policy.noneAvailable'));
  }
  if (!session.value?.physics_enabled && policyId !== MOCK_BROWSER_POLICY_ID) {
    throw new Error(t('policy.mockOnlyWhenPhysicsOff'));
  }
  await postJson('/api/session/playback', { action: 'pause' });
  selectedPolicyId.value = policyId;
  await browserPolicyRuntime.activate(manifest);
  browserPolicyState.value = browserPolicyRuntime.status();
  selectedPolicyGroupId.value = selectedPolicyGroupForPolicy(manifest);
  browserPhysics.lastPolicyOutput = null;
  browserPhysics.endHoldStepsRemaining = 0;
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
    throw new Error(t('test.physicsRequired'));
  }
  viewer?.queueImpulse({
    preset,
    magnitude: Number(impulseMagnitude.value),
    duration: Number(impulseDuration.value)
  });
  setStatus(commandStatus, makeStatus('test.browserImpulseQueued', { preset }));
}

async function exportTrim() {
  if (!activeSequence.value) {
    throw new Error(t('motion.motionRequired'));
  }
  const payload = await postJson('/api/trim_export', {
    sequence_id: activeSequence.value.sequence_id,
    start_frame: Number(trimStartInput.value),
    end_frame: Number(trimEndInput.value),
    export_format: exportFormat.value,
    output_dir: exportOutputDir.value.trim() || null,
    twist2_extension: exportFormat.value === 'twist2' ? twist2Extension.value : null
  });
  setStatus(commandStatus, makeStatus('trim.exportedTo', { path: payload.output_path }));
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
    viewerStatus.value = makeStatus('viewer.readyShort');
  } catch (error) {
    viewerStatus.value = error.message;
  }
}

onMounted(async () => {
  await loadPolicyPlugins();
  await initViewer();
  await refreshSession();
  pollHandle = window.setInterval(refreshSession, SESSION_POLL_INTERVAL_MS);
  policyRefreshHandle = window.setInterval(() => {
    loadPolicyPlugins({ quiet: true });
  }, POLICY_PLUGIN_REFRESH_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (pollHandle) {
    window.clearInterval(pollHandle);
  }
  if (policyRefreshHandle) {
    window.clearInterval(policyRefreshHandle);
  }
  stopLocalPlaybackLoop();
  stopBrowserPhysicsLoop();
  viewer?.dispose();
});
</script>
