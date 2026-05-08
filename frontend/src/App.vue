<template>
  <div class="shell industrial-shell" :data-theme="uiTheme">
    <header class="topbar command-bar">
      <div class="brand-block">
        <p class="eyebrow">{{ t('app.eyebrow') }}</p>
        <h1>G1 Unified Viewer</h1>
      </div>
      <div class="topbar-controls">
        <div class="topbar-status-strip" aria-label="Console status">
          <span id="viewerBadge" class="status-chip viewer-status-chip" :class="{ ok: viewerReady }">{{ viewerReady ? t('viewer.ready') : t('viewer.loading') }}</span>
          <span id="modeBadge" class="status-chip">{{ t('badges.mode') }}: {{ topbarModeLabel }}</span>
          <span id="playbackBadge" class="status-chip">{{ t('badges.playback') }}: {{ playbackDisplayState }}</span>
        </div>
        <div class="topbar-toolbar">
          <button
            id="physicsToggleButton"
            :class="['physics-toggle-card', session?.physics_enabled ? 'active' : '']"
            type="button"
            :aria-label="session?.physics_enabled ? t('physics.on') : t('physics.off')"
            :aria-pressed="session?.physics_enabled ? 'true' : 'false'"
            :title="session?.physics_enabled ? t('physics.on') : t('physics.off')"
            @click="runCommand(togglePhysics, 'status.physicsUpdated')"
          >
            <span class="physics-toggle-indicator" aria-hidden="true"></span>
            <span class="physics-toggle-copy">
              <strong>{{ t('physics.label') }}</strong>
              <span>{{ session?.physics_enabled ? t('physics.onShort') : t('physics.offShort') }}</span>
            </span>
          </button>
          <div class="topbar-mode-cluster">
            <div id="languageToggle" class="language-toggle" :aria-label="t('app.language')">
              <Languages class="language-icon" aria-hidden="true" />
              <div class="language-toggle-options">
                <button type="button" :class="uiLanguage === 'zh' ? 'active' : ''" aria-label="切换到中文" @click="setUiLanguage('zh')">
                  <span>中</span>
                </button>
                <button type="button" :class="uiLanguage === 'en' ? 'active' : ''" aria-label="Switch to English" @click="setUiLanguage('en')">
                  <span>EN</span>
                </button>
              </div>
            </div>
            <button
              id="themeToggleButton"
              class="topbar-icon-button theme-toggle-button"
              type="button"
              :aria-label="uiThemeLabel"
              :aria-pressed="uiTheme === 'light' ? 'true' : 'false'"
              :title="uiThemeLabel"
              @click="toggleUiTheme"
            >
              <component :is="uiThemeIcon" :class="['control-icon', uiTheme === 'dark' ? 'theme-icon-sun' : 'theme-icon-moon']" aria-hidden="true" />
              <span>{{ uiThemeLabel }}</span>
            </button>
            <button
              id="physicsCompactToggleButton"
              :class="['topbar-icon-button', 'physics-compact-toggle', session?.physics_enabled ? 'active' : '']"
              type="button"
              :aria-label="session?.physics_enabled ? t('physics.on') : t('physics.off')"
              :aria-pressed="session?.physics_enabled ? 'true' : 'false'"
              :title="session?.physics_enabled ? t('physics.on') : t('physics.off')"
              @click="runCommand(togglePhysics, 'status.physicsUpdated')"
            >
              <Power class="control-icon" aria-hidden="true" />
              <span>{{ session?.physics_enabled ? t('physics.on') : t('physics.off') }}</span>
            </button>
          </div>
        </div>
      </div>
    </header>

    <main class="workspace-shell layout industrial-layout">
      <aside class="left-rail sidebar workflow-rail">
        <section class="panel workflow-card workflow-panel data-browser-card">
          <div class="panel-title">
            <h2><Database class="section-icon" aria-hidden="true" />{{ t('data.title') }}</h2>
            <p>{{ t('data.subtitle') }}</p>
          </div>
          <input id="pathInput" v-model="pathInput" type="text" :placeholder="t('data.pathPlaceholder')" />
          <div class="browser-actions">
            <button id="browserUpButton" class="command-button ghost" :disabled="!browserParent" @click="goToParentDirectory">
              <ArrowUpToLine class="control-icon" aria-hidden="true" />
              <span>{{ t('data.up') }}</span>
            </button>
            <button id="scanButton" class="command-button primary" @click="scanTree">
              <Search class="control-icon" aria-hidden="true" />
              <span>{{ t('data.scan') }}</span>
            </button>
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

        <section class="panel workflow-card workflow-panel motion-workflow-card">
          <div class="panel-title">
            <h2><Activity class="section-icon" aria-hidden="true" />{{ t('motion.title') }}</h2>
            <p>{{ t('motion.subtitle') }}</p>
          </div>
          <div id="clipSummary" class="stat-grid compact-stat-grid">
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
            :style="{ '--timeline-progress': timelineProgress }"
            :disabled="!activeSequence"
            @input="seekTo(Number($event.target.value))"
          />
          <div class="two-col">
            <input id="frameInput" v-model.number="frameInput" type="number" min="0" :max="maxFrame" :disabled="!activeSequence" />
            <button id="seekButton" class="command-button secondary" :disabled="!activeSequence" @click="seekTo(frameInput)">
              <LocateFixed class="control-icon" aria-hidden="true" />
              <span>{{ t('motion.seek') }}</span>
            </button>
          </div>
          <div class="three-col">
            <button id="playButton" class="command-button primary" :disabled="!activeSequence" @click="runCommand(playPlayback, 'motion.playDone')">
              <Play class="control-icon" aria-hidden="true" />
              <span>{{ t('motion.play') }}</span>
            </button>
            <button id="pauseButton" class="command-button secondary" :disabled="!activeSequence" @click="runCommand(pausePlayback, 'motion.pauseDone')">
              <Pause class="control-icon" aria-hidden="true" />
              <span>{{ t('motion.pause') }}</span>
            </button>
            <button id="stopButton" class="command-button secondary" :disabled="!activeSequence" @click="runCommand(stopPlayback, 'motion.stopDone')">
              <Square class="control-icon" aria-hidden="true" />
              <span>{{ t('motion.stop') }}</span>
            </button>
          </div>
          <label id="motionStartTransitionToggle" class="toggle-row motion-start-transition-toggle">
            <input v-model="motionStartTransitionEnabled" type="checkbox" :disabled="!session?.physics_enabled" />
            <span class="toggle-copy">
              <strong>{{ t('motion.startTransition') }}</strong>
              <small>{{ t(motionStartTransitionEnabled ? 'motion.startTransitionOn' : 'motion.startTransitionOff') }}</small>
            </span>
          </label>
          <div class="target-smoothing-control target-smoothing-panel">
            <input id="targetSmoothingToggle" v-model="targetSmoothingEnabled" type="checkbox" :disabled="!session?.physics_enabled" />
            <div class="target-smoothing-body">
              <label class="toggle-copy" for="targetSmoothingToggle">
                <strong>{{ t('motion.targetSmoothing') }}</strong>
                <small>{{ t(targetSmoothingEnabled ? 'motion.targetSmoothingOn' : 'motion.targetSmoothingOff') }}</small>
              </label>
              <label class="target-smoothing-alpha">
                <span>{{ t('motion.targetSmoothingAlpha') }}</span>
                <strong class="alpha-value">{{ targetSmoothingAlphaDisplay }}</strong>
                <input
                  id="targetSmoothingAlpha"
                  v-model.number="targetSmoothingAlpha"
                  type="range"
                  :style="{ '--target-smoothing-progress': targetSmoothingAlphaProgress }"
                  min="0.01"
                  max="1"
                  step="0.01"
                  :disabled="!targetSmoothingEnabled || !session?.physics_enabled"
                />
              </label>
            </div>
          </div>
          <div id="commandStatus" :class="['status', commandStatus.error ? 'error' : '']">{{ statusText(commandStatus) }}</div>
        </section>

        <section class="panel workflow-card workflow-panel trim-export-card">
          <div class="panel-title">
            <h2><Scissors class="section-icon" aria-hidden="true" />{{ t('trim.title') }}</h2>
            <p>{{ t('trim.subtitle') }}</p>
          </div>
          <div class="two-col">
            <input
              id="trimStartInput"
              v-model.number="trimStartInput"
              type="number"
              min="0"
              :max="maxFrame"
              :disabled="!activeSequence"
              @focus="beginTrimFrameEdit('start')"
              @keyup.enter="commitTrimStart"
              @blur="commitTrimStart"
            />
            <input
              id="trimEndInput"
              v-model.number="trimEndInput"
              type="number"
              min="0"
              :max="maxFrame"
              :disabled="!activeSequence"
              @focus="beginTrimFrameEdit('end')"
              @keyup.enter="commitTrimEnd"
              @blur="commitTrimEnd"
            />
          </div>
          <div class="two-col">
            <button id="markTrimStartButton" class="command-button ghost" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/trim', { action: 'mark_start' }), 'trim.markStartDone')">
              <CornerDownRight class="control-icon" aria-hidden="true" />
              <span>{{ t('trim.markStart') }}</span>
            </button>
            <button id="markTrimEndButton" class="command-button ghost" :disabled="!activeSequence" @click="runCommand(() => postJson('/api/session/trim', { action: 'mark_end' }), 'trim.markEndDone')">
              <CornerDownLeft class="control-icon" aria-hidden="true" />
              <span>{{ t('trim.markEnd') }}</span>
            </button>
          </div>
          <div class="export-grid">
            <label class="field">
              <span>{{ t('trim.format') }}</span>
              <select id="exportFormatSelect" v-model="exportFormat" :disabled="!activeSequence">
                <option value="sonic">sonic</option>
                <option value="twist2">twist2</option>
                <option value="motion_tracking_npz">motion_tracking_npz</option>
                <option value="kimodo_csv">kimodo_csv</option>
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
          <label class="field">
            <span>{{ t('trim.outputName') }}</span>
            <input id="exportOutputNameInput" v-model="exportOutputName" type="text" :placeholder="activeSequence?.name || t('trim.outputNamePlaceholder')" :disabled="!activeSequence" />
          </label>
          <div id="trimSummary" class="note">{{ t('trim.summary', { start: session?.trim_start ?? 0, end: session?.trim_end ?? 0 }) }}</div>
          <button id="exportButton" class="command-button secondary" :disabled="!activeSequence" @click="runCommand(exportTrim, 'trim.exportDone')">
            <Download class="control-icon" aria-hidden="true" />
            <span>{{ t('trim.export') }}</span>
          </button>
        </section>
      </aside>

      <section class="stage-column viewer-column">
        <header class="viewer-stage-header">
          <div class="stage-heading">
            <p class="eyebrow stage-eyebrow">{{ t('viewer.eyebrow') }}</p>
            <p class="stage-motion-name">{{ activeSequence?.name || t('viewer.noMotionTitle') }}</p>
          </div>

          <div class="viewer-toolbar">
            <div class="viewer-actions">
              <div class="viewer-command-strip">
                <div class="viewer-control-cluster">
                  <button
                    id="resetStanceButton"
                    class="command-button secondary icon-command"
                    type="button"
                    :disabled="!session?.physics_enabled"
                    :title="t('test.resetStance')"
                    @click="runCommand(resetPhysicsToDefaultStance, 'test.resetStanceDone')"
                  >
                    <RotateCcw class="control-icon" aria-hidden="true" />
                    <span>{{ t('test.resetStance') }}</span>
                  </button>
                  <button
                    id="contactForceToggleButton"
                    :class="['command-button', 'ghost', 'icon-command', contactForceMarkersEnabled ? 'active' : '']"
                    type="button"
                    :title="contactForceMarkerLabel"
                    @click="toggleContactForceMarkers"
                  >
                    <Footprints class="control-icon" aria-hidden="true" />
                    <span>{{ contactForceMarkerLabel }}</span>
                  </button>
                  <button
                    id="cameraFollowToggleButton"
                    :class="['command-button', 'ghost', 'icon-command', cameraFollowEnabled ? 'active' : '']"
                    type="button"
                    :title="cameraFollowLabel"
                    @click="toggleCameraFollow"
                  >
                    <Radio class="control-icon" aria-hidden="true" />
                    <span>{{ cameraFollowLabel }}</span>
                  </button>
                </div>
                <label class="camera-preset-field" for="cameraPresetSelect">
                  <Camera class="control-icon" aria-hidden="true" />
                  <select id="cameraPresetSelect" v-model="selectedCameraPreset" :aria-label="t('evaluation.cameraPresets')" @change="applySelectedCameraPreset">
                    <option v-for="preset in cameraPresetOptions" :key="preset.value" :value="preset.value">{{ preset.label }}</option>
                  </select>
                </label>
              </div>

            </div>

            <div class="stage-status-stack">
              <span :class="['badge', 'stage-ready-badge', viewerReady ? 'ok' : '']">{{ statusText(viewerStatus) }}</span>
            </div>
          </div>
        </header>

        <section class="panel viewer-stage-panel">
          <div class="viewer-stage-shell">
            <div class="viewer-frame">
              <div ref="viewerContainer" class="mujoco-stage"></div>
              <div class="viewer-overlay">
                <span>{{ activeSequence?.source_format || t('viewer.noClip') }}</span>
                <strong>{{ viewerFrameIndex }} / {{ maxFrame }}</strong>
                <span>{{ session?.physics_enabled ? t('viewer.physics') : t('viewer.reference') }}</span>
              </div>
            </div>
          </div>
        </section>
      </section>

      <aside class="right-rail sidebar right control-rail">
        <section class="panel control-card control-panel policy-control-card">
          <div class="panel-title">
            <h2><Cpu class="section-icon" aria-hidden="true" />{{ t('policy.title') }}</h2>
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

        <section id="evaluationPanel" class="panel control-card control-panel evaluation-panel evaluation-control-card">
          <div class="panel-title">
            <h2><ChartColumn class="section-icon" aria-hidden="true" />{{ t('evaluation.title') }}</h2>
            <p>{{ t('evaluation.subtitle') }}</p>
          </div>
          <div class="difficulty-strip" :class="motionStartDifficultyDisplay.level">
            <span>{{ t('evaluation.startDifficulty') }}</span>
            <strong>{{ motionStartDifficultyDisplay.label }}</strong>
            <small>{{ motionStartDifficultyDisplay.detail }}</small>
          </div>
          <div class="metric-grid">
            <div v-for="[label, value, tone] in trackingMetricEntries" :key="label" :class="['metric-tile', tone]">
              <span class="metric-label">{{ label }}</span>
              <strong>{{ value }}</strong>
            </div>
          </div>
          <div class="contact-force-list">
            <div v-for="[label, value, tone] in contactMetricEntries" :key="label" :class="['contact-force-row', tone]">
              <span>{{ label }}</span>
              <strong>{{ value }}</strong>
            </div>
          </div>
          <div class="reference-overlay-stack">
            <label id="globalReferenceOverlayToggle" class="toggle-row reference-overlay-toggle global-reference-overlay-toggle">
              <input v-model="globalReferenceOverlayEnabled" type="checkbox" :disabled="!session?.physics_enabled" />
              <span class="toggle-copy">
                <strong>{{ t('evaluation.globalReferenceOverlay') }}</strong>
                <small>{{ t(globalReferenceOverlayEnabled ? 'evaluation.globalReferenceOverlayOn' : 'evaluation.globalReferenceOverlayOff') }}</small>
              </span>
            </label>
            <label id="relativeReferenceOverlayToggle" class="toggle-row reference-overlay-toggle relative-reference-overlay-toggle">
              <input v-model="relativeReferenceOverlayEnabled" type="checkbox" :disabled="!session?.physics_enabled" />
              <span class="toggle-copy">
                <strong>{{ t('evaluation.relativeReferenceOverlay') }}</strong>
                <small>{{ t(relativeReferenceOverlayEnabled ? 'evaluation.relativeReferenceOverlayOn' : 'evaluation.relativeReferenceOverlayOff') }}</small>
              </span>
            </label>
          </div>
          <div class="comparison-section primary-comparison-section">
            <div class="comparison-section-header">
              <div>
                <h3>{{ t('evaluation.comparisonTitle') }}</h3>
                <p>{{ t('evaluation.comparisonSubtitle') }}</p>
              </div>
              <span class="comparison-section-badge">{{ t('evaluation.comparisonBadge') }}</span>
            </div>
            <div class="comparison-selects inline-comparison-selects">
              <label class="field">
                <span>{{ t('evaluation.policyA') }}</span>
                <select id="comparisonPolicyA" v-model="comparisonPolicyA" :disabled="evaluationTelemetry.comparing">
                  <option v-for="policy in comparablePolicies" :key="`a:${policy.policy_id}`" :value="policy.policy_id">{{ policyLabel(policy) }}</option>
                </select>
              </label>
              <label class="field">
                <span>{{ t('evaluation.policyB') }}</span>
                <select id="comparisonPolicyB" v-model="comparisonPolicyB" :disabled="evaluationTelemetry.comparing">
                  <option v-for="policy in comparablePolicies" :key="`b:${policy.policy_id}`" :value="policy.policy_id">{{ policyLabel(policy) }}</option>
                </select>
              </label>
            </div>
            <button id="runComparisonButton" class="command-button primary" :disabled="!activeSequence || !session?.physics_enabled || evaluationTelemetry.comparing" @click="runCommand(runPolicyComparison, 'evaluation.comparisonDone')">
              <GitCompareArrows class="control-icon" aria-hidden="true" />
              <span>{{ evaluationTelemetry.comparing ? t('evaluation.comparing') : t('evaluation.runComparison') }}</span>
            </button>
            <div v-if="evaluationTelemetry.comparing && evaluationTelemetry.comparisonProgress" class="comparison-progress">
              <span class="recording-dot active"></span>
              <span>{{ statusText(evaluationTelemetry.comparisonProgress) }}</span>
            </div>
            <div class="comparison-results inline-comparison-results">
              <div v-for="result in evaluationTelemetry.comparisonResults" :key="`${result.policyId}:${result.startedAt || result.policyId}`" class="comparison-row">
                <strong>{{ result.policyId }}</strong>
                <span>{{ t(result.fell ? 'evaluation.fell' : 'evaluation.stable') }} / {{ percent(result.completionRate) }}</span>
                <small>{{ t('evaluation.avgJoint') }} {{ formatMetric(result.avgJointMeanAbsError, 3) }}</small>
              </div>
            </div>
          </div>
          <div class="recording-panel">
            <div class="panel-title recording-panel-title">
              <h2><Video class="section-icon" aria-hidden="true" />{{ t('evaluation.advancedTitle') }}</h2>
              <p>{{ t('evaluation.advancedSubtitle') }}</p>
            </div>
            <div class="recording-section">
              <label class="recording-file-field" for="recordingFileNameInput">
                <span>{{ t('evaluation.recordFileName') }}</span>
                <input
                  id="recordingFileNameInput"
                  v-model="recordingFileName"
                  type="text"
                  :disabled="evaluationTelemetry.recording"
                  :placeholder="t('evaluation.recordFileNamePlaceholder')"
                />
              </label>
              <div class="recording-controls">
                <button id="recordingStartButton" class="command-button secondary" :disabled="evaluationTelemetry.recording" @click="runCommand(startViewerRecording, null)">
                  <Video class="control-icon" aria-hidden="true" />
                  <span>{{ t('evaluation.recordStart') }}</span>
                </button>
                <button id="recordingStopButton" class="command-button secondary" :disabled="!evaluationTelemetry.recording" @click="runCommand(stopViewerRecording, null)">
                  <Square class="control-icon" aria-hidden="true" />
                  <span>{{ t('evaluation.recordStop') }}</span>
                </button>
              </div>
              <div class="recording-state">
                <span :class="['recording-dot', evaluationTelemetry.recording ? 'active' : '']"></span>
                <span>{{ evaluationTelemetry.recording ? t('evaluation.recording') : t('evaluation.recordIdle') }}</span>
                <a v-if="evaluationTelemetry.recordingUrl" :href="evaluationTelemetry.recordingUrl" :download="recordingDownloadName">{{ t('evaluation.recordDownload') }}</a>
              </div>
            </div>
          </div>
        </section>

        <details id="diagnosticsPanel" class="panel diagnostics advanced-panel diagnostics-panel debug-drawer">
          <summary class="advanced-summary debug-summary">
            <div>
              <h2><TerminalSquare class="section-icon" aria-hidden="true" />{{ t('diagnostics.title') }}</h2>
              <p>{{ t('diagnostics.subtitle') }}</p>
            </div>
            <span>{{ t('diagnostics.expand') }}</span>
          </summary>
          <div class="advanced-body">
            <div class="debug-grid">
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
            </div>
          </div>
        </details>
      </aside>
    </main>

    <transition name="export-toast">
      <aside
        v-if="exportToast.visible"
        id="exportToast"
        class="export-toast"
        role="status"
        aria-live="polite"
      >
        <div class="export-toast-indicator" aria-hidden="true"></div>
        <div class="export-toast-copy">
          <strong>{{ t('trim.exportSuccess') }}</strong>
          <span>{{ exportToast.path }}</span>
        </div>
        <button id="exportToastClose" class="export-toast-close" type="button" :aria-label="t('trim.dismissExportToast')" @click="dismissExportToast">
          ×
        </button>
      </aside>
    </transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  Activity,
  ArrowUpToLine,
  Camera,
  ChartColumn,
  CornerDownLeft,
  CornerDownRight,
  Cpu,
  Database,
  Download,
  Footprints,
  GitCompareArrows,
  Languages,
  LocateFixed,
  Moon,
  Pause,
  Play,
  Power,
  Radio,
  RotateCcw,
  Scissors,
  Search,
  Square,
  Sun,
  TerminalSquare,
  Video
} from 'lucide-vue-next';
import { fetchJson, formatJson, postJson } from './api.js';
import { BrowserMujocoViewer } from './simulation/browserMujocoViewer.js';
import {
  DEFAULT_BROWSER_POLICY_MANIFESTS,
  browserRunnablePolicies,
  createBrowserPolicyRuntime,
  normalizeFrameCacheAsMotionClip
} from './simulation/policyRuntime.js';
import {
  createEvaluationRun,
  evaluateMotionStartDifficulty,
  recordEvaluationSample,
  summarizeEvaluationRun,
  trackingTelemetrySample
} from './simulation/evaluationMetrics.js';
import { quatInverse, quatMultiply, yawComponent } from './simulation/utils/math.js';

const viewerContainer = ref(null);
const session = ref(null);
const policies = ref([...DEFAULT_BROWSER_POLICY_MANIFESTS]);
const selectedPolicyId = ref(DEFAULT_BROWSER_POLICY_MANIFESTS[0]?.policy_id ?? null);
const selectedPolicyGroupId = ref('mock');
const uiLanguage = ref('zh');
const uiTheme = ref('dark');
const selectedCameraPreset = ref('default');
const cameraFollowEnabled = ref(true);
const DEFAULT_DATASET_ROOT = '/home/huanghao/source/datasets/gmr_retarget_x/AMASS_numpy123';
const pathInput = ref(DEFAULT_DATASET_ROOT);
const treeNodes = ref([]);
const browserRoot = ref('');
const browserParent = ref(null);
const frameInput = ref(0);
const trimStartInput = ref(0);
const trimEndInput = ref(0);
const editingTrimStart = ref(false);
const editingTrimEnd = ref(false);
const exportFormat = ref('sonic');
const twist2Extension = ref('.pkl');
const exportOutputDir = ref('');
const exportOutputName = ref('');
const lastExportOutputSequenceId = ref(null);
const exportToast = reactive({
  visible: false,
  path: ''
});
const recordingFileName = ref('g1-viewer-recording');
const recordingMimeType = ref('video/mp4');
const globalReferenceOverlayEnabled = ref(false);
const relativeReferenceOverlayEnabled = ref(false);
const contactForceMarkersEnabled = ref(true);
const motionStartTransitionEnabled = ref(true);
const targetSmoothingEnabled = ref(false);
const targetSmoothingAlpha = ref(0.1);
const comparisonPolicyA = ref(null);
const comparisonPolicyB = ref(null);
const viewerStatus = ref({ key: 'viewer.initializing' });
const viewerReady = ref(false);
const commandStatus = ref({ key: 'status.waiting', error: false });
const treeStatus = ref({ key: 'data.defaultRootReady', error: false });
const policyStatus = ref({ key: 'policy.browserLocal', error: false });
const browserPolicyState = ref({
  active_policy_id: null,
  last_policy_result: null
});
const evaluationTelemetry = reactive({
  latest: null,
  history: [],
  contact: null,
  startDifficulty: null,
  activeRun: null,
  comparisonResults: [],
  comparisonProgress: null,
  comparing: false,
  recording: false,
  recordingUrl: null
});
const globalReferenceAnchor = reactive({
  pending: true,
  valid: false,
  reference_root_translation: null,
  reference_root_rotation_wxyz: null,
  root_translation: null,
  root_rotation_wxyz: null,
  yaw_delta_wxyz: null,
  reason: 'initial'
});

const SESSION_POLL_INTERVAL_MS = 500;
const POLICY_PLUGIN_REFRESH_INTERVAL_MS = 5000;
const LOCAL_PLAYBACK_RENDER_INTERVAL_MS = 30;
const FRAME_CACHE_CHUNK_SIZE = 240;
const DEFAULT_BROWSER_PHYSICS_CONTROL_DT = 0.02;
const MOCK_BROWSER_POLICY_ID = 'mock_passthrough';
const ACTIVE_BROWSER_MOTION_NAME = 'active_clip';
const BROWSER_MOTION_START_TRANSITION_SECONDS = 2;
const BROWSER_PHYSICS_END_HOLD_SECONDS = 0.6;
const TARGET_SMOOTHING_ALPHA_MIN = 0.01;
const TARGET_SMOOTHING_ALPHA_MAX = 1;
const UI_MESSAGES = Object.freeze({
  zh: {
    app: {
      eyebrow: 'G1 浏览器 MuJoCo 控制台',
      subtitle: '数据集播放、策略控制和动作裁剪工具。',
      language: '界面语言',
      themeDay: '白天模式',
      themeNight: '黑夜模式'
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
      modeMotion: '动作',
      modePolicy: '策略',
      playback: '播放',
      policy: '策略'
    },
    physics: {
      label: '物理',
      on: '物理开启',
      off: '物理关闭',
      onShort: '开启',
      offShort: '关闭'
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
      startTransition: '起步过渡',
      startTransitionOn: '物理播放前用 2 秒从站姿过渡到动作首帧。',
      startTransitionOff: '物理播放直接进入动作首帧。',
      targetSmoothing: '目标平滑',
      targetSmoothingOn: '对策略目标动作做 EMA 平滑；更稳但会增加跟随延迟。',
      targetSmoothingOff: '策略直接接收当前目标动作。',
      targetSmoothingAlpha: 'Alpha',
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
      outputName: '导出文件名',
      outputNamePlaceholder: '默认使用当前动作名',
      summary: '裁剪区间: {start} 至 {end}',
      export: '导出裁剪',
      exportSuccess: '导出成功',
      dismissExportToast: '关闭导出提示',
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
      mockOnlyWhenPhysicsOff: '关闭物理后只能使用 mock 策略。'
    },
    evaluation: {
      title: '评估',
      subtitle: '跟踪误差、接触力与策略 A/B。',
      advancedTitle: '录屏',
      advancedSubtitle: '录制当前 Viewer，并导出回放文件。',
      comparisonTitle: '策略 A/B',
      comparisonSubtitle: '直接在主评估区切换并运行对比。',
      comparisonBadge: '主对比区',
      cameraPresets: '相机预设',
      cameraDefault: '默认',
      cameraFront: '前',
      cameraSide: '侧',
      cameraBack: '后',
      cameraTop: '顶',
      cameraFollow: '跟随相机',
      cameraFollowOn: '跟随开',
      cameraFollowOff: '跟随关',
      cameraReset: '重置相机',
      front: '前',
      side: '侧',
      top: '顶',
      follow: '跟随',
      resetCamera: '复位',
      startDifficulty: '起步难度',
      difficultyWaiting: '等待动作',
      difficultyEasy: '容易',
      difficultyMedium: '中等',
      difficultyHard: '困难',
      recommendTransition: '建议开启 2s 起步过渡',
      rootError: 'Root XY',
      jointMean: '关节均值',
      jointMax: '关节最大',
      targetMean: '目标误差',
      baseHeight: 'Base 高度',
      rollPitch: 'Roll/Pitch',
      leftFoot: '左脚压力',
      rightFoot: '右脚压力',
      contactPoints: '接触点',
      contactForceLinesOn: '力线开',
      contactForceLinesOff: '力线关',
      referenceOverlay: '参考姿态',
      referenceOverlayOn: '显示半透明参考动作姿态。',
      referenceOverlayOff: '隐藏参考动作姿态。',
      globalReferenceOverlay: '全局参考',
      globalReferenceOverlayOn: '第一帧 root 与机器人同步，之后保持动作全局轨迹。',
      globalReferenceOverlayOff: '隐藏全局参考姿态。',
      relativeReferenceOverlay: '相对参考',
      relativeReferenceOverlayOn: '每帧 root 跟随机器人，用于比较局部姿态。',
      relativeReferenceOverlayOff: '隐藏相对参考姿态。',
      recordStart: '录制',
      recordStop: '停止',
      recordFileName: '文件名',
      recordFileNamePlaceholder: '输入视频文件名',
      recording: '录制中',
      recordIdle: '录制空闲',
      recordDownload: '下载',
      policyA: '策略 A',
      policyB: '策略 B',
      runComparison: '运行 A/B',
      comparing: '对比中',
      comparingProgress: '后台评估 {policy}: {progress}',
      stable: '稳定',
      fell: '摔倒',
      avgJoint: '关节均值',
      comparisonDone: 'A/B 对比完成。',
      comparisonRequired: '请先开启物理，并选择两个策略。'
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
      physicsRequired: '请先开启物理。'
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
      expand: '展开',
      cameraWaiting: '等待 MuJoCo viewer 连接...',
      noLogs: '暂无日志。'
    },
    status: {
      waiting: '等待操作。',
      physicsUpdated: '物理状态已更新。',
      loadedMotion: '已加载 {name}'
    }
  },
  en: {
    app: {
      eyebrow: 'G1 Browser MuJoCo Console',
      subtitle: 'Dataset playback, policy controls, and trim tools.',
      language: 'Interface language',
      themeDay: 'Day Mode',
      themeNight: 'Night Mode'
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
      modeMotion: 'Motion',
      modePolicy: 'Policy',
      playback: 'Playback',
      policy: 'Policy'
    },
    physics: {
      label: 'Physics',
      on: 'Physics On',
      off: 'Physics Off',
      onShort: 'On',
      offShort: 'Off'
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
      startTransition: 'Start transition',
      startTransitionOn: 'Use a 2s physics transition into the first motion frame.',
      startTransitionOff: 'Start physics playback directly from the first motion frame.',
      targetSmoothing: 'Target smoothing',
      targetSmoothingOn: 'EMA smooths policy targets; steadier but adds tracking latency.',
      targetSmoothingOff: 'Policy receives the current target directly.',
      targetSmoothingAlpha: 'Alpha',
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
      subtitle: 'Clip bounds and export.',
      markStart: 'Mark Start',
      markEnd: 'Mark End',
      format: 'Format',
      twist2Extension: 'twist2 suffix',
      outputFolder: 'Output folder',
      outputPlaceholder: 'Leave blank to use the default exports folder',
      outputName: 'Output name',
      outputNamePlaceholder: 'Defaults to current motion name',
      summary: 'Trim range: {start} to {end}',
      export: 'Export Trim',
      exportSuccess: 'Export complete',
      dismissExportToast: 'Dismiss export notification',
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
    evaluation: {
      title: 'Evaluation',
      subtitle: 'Tracking error, contact forces, and policy A/B.',
      advancedTitle: 'Recording',
      advancedSubtitle: 'Capture the current viewer and export playback files.',
      comparisonTitle: 'Policy A/B',
      comparisonSubtitle: 'Run direct side-by-side comparisons from the main workbench.',
      comparisonBadge: 'Primary compare',
      cameraPresets: 'Camera presets',
      cameraDefault: 'Default',
      cameraFront: 'Front',
      cameraSide: 'Side',
      cameraBack: 'Back',
      cameraTop: 'Top',
      cameraFollow: 'Follow camera',
      cameraFollowOn: 'Follow On',
      cameraFollowOff: 'Follow Off',
      cameraReset: 'Reset camera',
      front: 'Front',
      side: 'Side',
      top: 'Top',
      follow: 'Follow',
      resetCamera: 'Reset',
      startDifficulty: 'Start Difficulty',
      difficultyWaiting: 'Waiting',
      difficultyEasy: 'Easy',
      difficultyMedium: 'Medium',
      difficultyHard: 'Hard',
      recommendTransition: 'Recommend 2s start transition',
      rootError: 'Root XY',
      jointMean: 'Joint Mean',
      jointMax: 'Joint Max',
      targetMean: 'Target Err',
      baseHeight: 'Base Height',
      rollPitch: 'Roll/Pitch',
      leftFoot: 'Left Foot',
      rightFoot: 'Right Foot',
      contactPoints: 'Contact Pts',
      contactForceLinesOn: 'Forces On',
      contactForceLinesOff: 'Forces Off',
      referenceOverlay: 'Reference ghost',
      referenceOverlayOn: 'Show the translucent reference motion pose.',
      referenceOverlayOff: 'Hide the reference motion pose.',
      globalReferenceOverlay: 'Global ref',
      globalReferenceOverlayOn: 'Align root to the robot on frame 0, then keep the global motion path.',
      globalReferenceOverlayOff: 'Hide the global reference pose.',
      relativeReferenceOverlay: 'Relative ref',
      relativeReferenceOverlayOn: 'Keep root on the robot each frame to compare local pose.',
      relativeReferenceOverlayOff: 'Hide the relative reference pose.',
      recordStart: 'Record',
      recordStop: 'Stop',
      recordFileName: 'File name',
      recordFileNamePlaceholder: 'Enter video file name',
      recording: 'Recording',
      recordIdle: 'Record idle',
      recordDownload: 'Download',
      policyA: 'Policy A',
      policyB: 'Policy B',
      runComparison: 'Run A/B',
      comparing: 'Comparing',
      comparingProgress: 'Background eval {policy}: {progress}',
      stable: 'Stable',
      fell: 'Fell',
      avgJoint: 'Avg joint',
      comparisonDone: 'A/B comparison finished.',
      comparisonRequired: 'Turn Physics on and select two policies first.'
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
      expand: 'Open',
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
let exportToastTimer = null;
let physicsLoopPromise = null;
let viewer = null;
let lastPolicySelectionSignature = '';
let frameCacheRequestToken = 0;
let frameCacheAbortController = null;
const browserPolicyRuntime = createBrowserPolicyRuntime();
let frameCache = {
  sequenceId: null,
  loadingSequenceId: null,
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
  endHoldActive: false,
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
const timelineProgress = computed(() => {
  const max = Math.max(1, maxFrame.value);
  const ratio = Math.min(1, Math.max(0, viewerFrameIndex.value / max));
  return `${Math.round(ratio * 100)}%`;
});
const targetSmoothingAlphaProgress = computed(() => {
  const alpha = clampTargetSmoothingAlpha(targetSmoothingAlpha.value);
  const ratio = (alpha - TARGET_SMOOTHING_ALPHA_MIN) / (TARGET_SMOOTHING_ALPHA_MAX - TARGET_SMOOTHING_ALPHA_MIN);
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
});
const targetSmoothingAlphaDisplay = computed(() => clampTargetSmoothingAlpha(targetSmoothingAlpha.value).toFixed(2));
const uiThemeLabel = computed(() => (uiTheme.value === 'dark' ? t('app.themeDay') : t('app.themeNight')));
const uiThemeIcon = computed(() => (uiTheme.value === 'dark' ? Sun : Moon));
const contactForceMarkerLabel = computed(() => (
  contactForceMarkersEnabled.value
    ? t('evaluation.contactForceLinesOn')
    : t('evaluation.contactForceLinesOff')
));
const cameraFollowLabel = computed(() => (
  cameraFollowEnabled.value
    ? t('evaluation.cameraFollowOn')
    : t('evaluation.cameraFollowOff')
));
const cameraPresetOptions = computed(() => [
  { value: 'default', label: t('evaluation.cameraDefault') },
  { value: 'front', label: t('evaluation.cameraFront') },
  { value: 'side', label: t('evaluation.cameraSide') },
  { value: 'back', label: t('evaluation.cameraBack') },
  { value: 'top', label: t('evaluation.cameraTop') }
]);
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
const topbarModeLabel = computed(() => {
  const mode = session.value?.view_mode ?? '-';
  if (mode === 'dataset') {
    return t('badges.modeMotion');
  }
  if (mode === 'policy') {
    return t('badges.modePolicy');
  }
  return mode;
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
const comparablePolicies = computed(() => policies.value.filter((policy) => policy.policy_id !== MOCK_BROWSER_POLICY_ID));
const trackingMetricEntries = computed(() => {
  const latest = evaluationTelemetry.latest;
  return [
    [t('evaluation.rootError'), formatMetric(latest?.rootPositionError, 3), metricTone(latest?.rootPositionError, 0.2, 0.45)],
    [t('evaluation.jointMean'), formatMetric(latest?.jointMeanAbsError, 3), metricTone(latest?.jointMeanAbsError, 0.18, 0.45)],
    [t('evaluation.jointMax'), formatMetric(latest?.jointMaxAbsError, 3), metricTone(latest?.jointMaxAbsError, 0.55, 1.2)],
    [t('evaluation.targetMean'), formatMetric(latest?.targetMeanAbsError, 3), metricTone(latest?.targetMeanAbsError, 0.18, 0.45)],
    [t('evaluation.baseHeight'), formatMetric(latest?.baseHeight, 2), Number(latest?.baseHeight ?? 0) < 0.55 ? 'danger' : 'ok'],
    [t('evaluation.rollPitch'), `${formatMetric(latest?.baseRollPitchDeg, 1)} deg`, metricTone(latest?.baseRollPitchDeg, 25, 50)]
  ];
});
const contactMetricEntries = computed(() => {
  const contact = evaluationTelemetry.latest?.contact || {};
  return [
    [t('evaluation.leftFoot'), `${formatMetric(contact.leftNormalForce, 1)} N`, contact.leftActive ? 'ok' : 'muted'],
    [t('evaluation.rightFoot'), `${formatMetric(contact.rightNormalForce, 1)} N`, contact.rightActive ? 'ok' : 'muted'],
    [t('evaluation.contactPoints'), String(contact.pointCount ?? 0), contact.pointCount ? 'ok' : 'muted']
  ];
});
const motionStartDifficultyDisplay = computed(() => {
  const difficulty = evaluationTelemetry.startDifficulty;
  if (!difficulty) {
    return {
      level: 'waiting',
      label: t('evaluation.difficultyWaiting'),
      detail: '-'
    };
  }
  const labelKey = {
    easy: 'evaluation.difficultyEasy',
    medium: 'evaluation.difficultyMedium',
    hard: 'evaluation.difficultyHard'
  }[difficulty.level] || 'evaluation.difficultyWaiting';
  return {
    level: difficulty.level,
    label: `${t(labelKey)} ${formatMetric(difficulty.score, 2)}`,
    detail: difficulty.recommendTransition
      ? t('evaluation.recommendTransition')
      : `${t('evaluation.jointMean')} ${formatMetric(difficulty.jointMeanDelta, 3)}`
  };
});
const recordingDownloadName = computed(() => {
  const baseName = sanitizeRecordingFileName(recordingFileName.value);
  const extension = recordingExtensionForMime(recordingMimeType.value);
  return `${baseName}.${extension}`;
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
  mouse_drag_force: viewer?.getDragForceState?.(),
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

function dismissExportToast() {
  if (exportToastTimer) {
    window.clearTimeout(exportToastTimer);
    exportToastTimer = null;
  }
  exportToast.visible = false;
}

function showExportToast(path) {
  if (exportToastTimer) {
    window.clearTimeout(exportToastTimer);
  }
  exportToast.path = String(path || '');
  exportToast.visible = true;
  exportToastTimer = window.setTimeout(dismissExportToast, 4000);
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

function formatMetric(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '-';
  }
  return numeric.toFixed(digits);
}

function percent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '-';
  }
  return `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%`;
}

function metricTone(value, warn, danger) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 'muted';
  }
  if (numeric >= danger) {
    return 'danger';
  }
  if (numeric >= warn) {
    return 'warn';
  }
  return 'ok';
}

function sanitizeRecordingFileName(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_');
  return cleaned || 'g1-viewer-recording';
}

function recordingExtensionForMime(mimeType) {
  return String(mimeType || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm';
}

function setUiLanguage(language) {
  if (language === 'zh' || language === 'en') {
    uiLanguage.value = language;
  }
}

function setUiTheme(theme) {
  uiTheme.value = theme === 'light' ? 'light' : 'dark';
  applyUiTheme();
}

function toggleUiTheme() {
  setUiTheme(uiTheme.value === 'dark' ? 'light' : 'dark');
}

function applyUiTheme(theme = uiTheme.value) {
  const resolvedTheme = theme === 'light' ? 'light' : 'dark';
  uiTheme.value = resolvedTheme;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
  localStorage.setItem('g1-viewer-ui-theme', resolvedTheme);
}

function restoreUiTheme() {
  const storedTheme = localStorage.getItem('g1-viewer-ui-theme');
  setUiTheme(storedTheme === 'light' ? 'light' : 'dark');
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

function ensureComparisonSelection() {
  const candidates = comparablePolicies.value;
  if (!candidates.length) {
    comparisonPolicyA.value = null;
    comparisonPolicyB.value = null;
    return;
  }
  if (!candidates.some((policy) => policy.policy_id === comparisonPolicyA.value)) {
    comparisonPolicyA.value = candidates.find((policy) => policy.policy_id === selectedPolicyId.value)?.policy_id
      || candidates[0]?.policy_id
      || null;
  }
  if (!candidates.some((policy) => policy.policy_id === comparisonPolicyB.value)) {
    comparisonPolicyB.value = candidates.find((policy) => policy.policy_id !== comparisonPolicyA.value)?.policy_id
      || candidates[1]?.policy_id
      || comparisonPolicyA.value;
  }
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

function clampTargetSmoothingAlpha(value = targetSmoothingAlpha.value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.1;
  }
  return Math.min(TARGET_SMOOTHING_ALPHA_MAX, Math.max(TARGET_SMOOTHING_ALPHA_MIN, numeric));
}

function configureBrowserTargetSmoothing() {
  targetSmoothingAlpha.value = clampTargetSmoothingAlpha(targetSmoothingAlpha.value);
  browserPolicyRuntime.configureTargetSmoothing({
    enabled: targetSmoothingEnabled.value,
    alpha: targetSmoothingAlpha.value
  });
  browserPhysics.lastPolicyOutput = null;
}

function configurePolicyRuntimeTargetSmoothing(runtime) {
  targetSmoothingAlpha.value = clampTargetSmoothingAlpha(targetSmoothingAlpha.value);
  runtime?.configureTargetSmoothing?.({
    enabled: targetSmoothingEnabled.value,
    alpha: targetSmoothingAlpha.value
  });
}

function browserPolicyIsActive() {
  return Boolean(browserPolicyRuntime.activePolicyId);
}

function syncInputsFromSession() {
  if (!session.value) {
    return;
  }
  if (!localPlayback.active && !browserPhysics.active) {
    viewerFrameIndex.value = session.value.current_frame;
  }
  frameInput.value = viewerFrameIndex.value;
  if (!editingTrimStart.value) {
    trimStartInput.value = session.value.trim_start;
  }
  if (!editingTrimEnd.value) {
    trimEndInput.value = session.value.trim_end;
  }
  const sequence = activeSequence.value;
  const sequenceId = sequence?.sequence_id ?? null;
  if (sequenceId !== lastExportOutputSequenceId.value) {
    lastExportOutputSequenceId.value = sequenceId;
    exportOutputName.value = sequence?.name ?? '';
  }
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
    ensureComparisonSelection();
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
    ensureComparisonSelection();
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
  const boundedFrame = Math.min(Math.max(Number(frameIndex) || 0, 0), maxFrame.value);
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

function cachedFrameCount() {
  return frameCache.frames.filter(Boolean).length;
}

function frameCacheReadyForActiveSequence() {
  return Boolean(
    activeSequence.value
    && frameCache.sequenceId === activeSequence.value.sequence_id
    && !frameCache.loadingSequenceId
    && cachedFrameCount() >= activeSequence.value.frame_count
  );
}

function updateMotionStartDifficulty() {
  if (!frameCacheReadyForActiveSequence()) {
    evaluationTelemetry.startDifficulty = null;
    return null;
  }
  try {
    const defaultTarget = browserPolicyRuntime.defaultStance();
    evaluationTelemetry.startDifficulty = evaluateMotionStartDifficulty({
      defaultJointPositions: defaultTarget?.joint_positions || [],
      firstFrame: frameCache.frames[0]
    });
    browserPolicyState.value = browserPolicyRuntime.status();
    return evaluationTelemetry.startDifficulty;
  } catch (_error) {
    evaluationTelemetry.startDifficulty = null;
    return null;
  }
}

function resolveBrowserPhysicsControlDt(target = null) {
  const candidate = Number(target?.control_dt ?? browserPhysics.controlDt ?? DEFAULT_BROWSER_PHYSICS_CONTROL_DT);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_BROWSER_PHYSICS_CONTROL_DT;
}

function syncBrowserPhysicsControlDt(target = null) {
  browserPhysics.controlDt = resolveBrowserPhysicsControlDt(target);
  return browserPhysics.controlDt;
}

function cloneVector(values, fallback = []) {
  const source = Array.isArray(values) || ArrayBuffer.isView(values) ? values : fallback;
  return Array.from(source || fallback, (value) => Number(value ?? 0));
}

function rotateXyByYawDelta(deltaQuatWxyz = [1, 0, 0, 0], x = 0, y = 0) {
  const yawDelta = yawComponent(deltaQuatWxyz);
  const w = Number(yawDelta[0] ?? 1);
  const z = Number(yawDelta[3] ?? 0);
  const cos = (w * w) - (z * z);
  const sin = 2 * w * z;
  return [
    (cos * x) - (sin * y),
    (sin * x) + (cos * y)
  ];
}

function cloneReferencePayload(referencePayload = null) {
  if (!referencePayload?.state) {
    return null;
  }
  return {
    ...referencePayload,
    joint_names: [...(referencePayload.joint_names || [])],
    body_names: [...(referencePayload.body_names || [])],
    state: {
      ...referencePayload.state,
      root_translation: cloneVector(referencePayload.state.root_translation, [0, 0, 0.78]),
      root_rotation_wxyz: cloneVector(referencePayload.state.root_rotation_wxyz, [1, 0, 0, 0]),
      joint_positions: cloneVector(referencePayload.state.joint_positions, []),
      joint_velocities: referencePayload.state.joint_velocities
        ? cloneVector(referencePayload.state.joint_velocities, [])
        : referencePayload.state.joint_velocities,
      body_positions: Array.isArray(referencePayload.state.body_positions)
        ? referencePayload.state.body_positions.map((row) => cloneVector(row, [0, 0, 0]))
        : referencePayload.state.body_positions,
      body_rotations_wxyz: Array.isArray(referencePayload.state.body_rotations_wxyz)
        ? referencePayload.state.body_rotations_wxyz.map((row) => cloneVector(row, [1, 0, 0, 0]))
        : referencePayload.state.body_rotations_wxyz
    }
  };
}

function scheduleGlobalReferenceRootSync(reason = 'motion_start') {
  globalReferenceAnchor.pending = true;
  globalReferenceAnchor.reason = reason;
}

function currentRootAnchorState(currentStatePayload = null) {
  return currentStatePayload?.state || viewer?.readState?.(frameCache.jointNames);
}

function updateGlobalReferenceAnchor(referencePayload = null, currentStatePayload = null) {
  const currentState = currentRootAnchorState(currentStatePayload);
  if (!referencePayload?.state || !currentState?.root_translation || !currentState?.root_rotation_wxyz) {
    return false;
  }
  const referenceRoot = cloneVector(referencePayload.state.root_translation, [0, 0, 0.78]);
  const referenceQuat = cloneVector(referencePayload.state.root_rotation_wxyz, [1, 0, 0, 0]);
  const currentQuat = cloneVector(currentState.root_rotation_wxyz, referenceQuat);
  const yawDelta = quatMultiply(yawComponent(currentQuat), quatInverse(yawComponent(referenceQuat)));
  globalReferenceAnchor.reference_root_translation = referenceRoot;
  globalReferenceAnchor.reference_root_rotation_wxyz = referenceQuat;
  globalReferenceAnchor.root_translation = cloneVector(currentState.root_translation, referencePayload.state.root_translation || [0, 0, 0.78]);
  globalReferenceAnchor.root_rotation_wxyz = cloneVector(currentState.root_rotation_wxyz, referencePayload.state.root_rotation_wxyz || [1, 0, 0, 0]);
  globalReferenceAnchor.yaw_delta_wxyz = yawDelta;
  globalReferenceAnchor.valid = true;
  globalReferenceAnchor.pending = false;
  return true;
}

function calibrateGlobalReferenceMotion(startFrame = 0, currentStatePayload = null) {
  const sourceFrame = Math.min(Math.max(Number(startFrame) || 0, 0), maxFrame.value);
  const sourcePayload = framePayloadForIndex(sourceFrame);
  const anchorStatePayload = currentStatePayload || currentPhysicsStatePayload(sourcePayload?.joint_names || frameCache.jointNames);
  if (!sourcePayload?.state || !anchorStatePayload?.state) {
    return false;
  }
  return updateGlobalReferenceAnchor(sourcePayload, anchorStatePayload);
}

function makeRootMatchedReferencePayload(referencePayload = null, rootState = null) {
  const payload = cloneReferencePayload(referencePayload);
  if (!payload?.state || !rootState?.root_translation || !rootState?.root_rotation_wxyz) {
    return payload;
  }
  payload.state.root_translation = cloneVector(rootState.root_translation, payload.state.root_translation);
  payload.state.root_rotation_wxyz = cloneVector(rootState.root_rotation_wxyz, payload.state.root_rotation_wxyz);
  return payload;
}

function makeGlobalAnchoredReferencePayload(referencePayload = null) {
  const payload = cloneReferencePayload(referencePayload);
  if (!payload?.state || !globalReferenceAnchor.valid) {
    return payload;
  }
  const referenceRoot = globalReferenceAnchor.reference_root_translation || payload.state.root_translation || [0, 0, 0.78];
  const anchorRoot = globalReferenceAnchor.root_translation || referenceRoot;
  const sourceRoot = payload.state.root_translation || referenceRoot;
  const [offsetX, offsetY] = rotateXyByYawDelta(
    globalReferenceAnchor.yaw_delta_wxyz || [1, 0, 0, 0],
    Number(sourceRoot[0] ?? 0) - Number(referenceRoot[0] ?? 0),
    Number(sourceRoot[1] ?? 0) - Number(referenceRoot[1] ?? 0)
  );
  payload.state.root_translation = [
    Number(anchorRoot[0] ?? 0) + offsetX,
    Number(anchorRoot[1] ?? 0) + offsetY,
    Number(anchorRoot[2] ?? 0.78) + (Number(sourceRoot[2] ?? referenceRoot[2] ?? 0.78) - Number(referenceRoot[2] ?? 0.78))
  ];
  payload.state.root_rotation_wxyz = quatMultiply(
    globalReferenceAnchor.yaw_delta_wxyz || [1, 0, 0, 0],
    payload.state.root_rotation_wxyz || [1, 0, 0, 0]
  );
  return payload;
}

function globalReferencePayloadSource(referencePayload = null) {
  if (!referencePayload?.state) {
    return referencePayload;
  }
  const sourceFrameCandidate = Number(referencePayload.frame_index ?? viewerFrameIndex.value);
  const sourceFrame = Math.min(
    Math.max(Number.isFinite(sourceFrameCandidate) ? sourceFrameCandidate : 0, 0),
    maxFrame.value
  );
  return framePayloadForIndex(sourceFrame) || referencePayload;
}

function makeGlobalReferencePayload(referencePayload = null, currentStatePayload = null) {
  if (!referencePayload?.state) {
    return null;
  }
  if (globalReferenceAnchor.pending || !globalReferenceAnchor.valid) {
    const sourceFrame = referencePayload.sequence_id === 'default_stance'
      ? 0
      : Math.min(Math.max(Number(referencePayload.frame_index ?? viewerFrameIndex.value) || 0, 0), maxFrame.value);
    calibrateGlobalReferenceMotion(sourceFrame, currentStatePayload);
  }
  if (!globalReferenceAnchor.valid) {
    return cloneReferencePayload(referencePayload);
  }
  return makeGlobalAnchoredReferencePayload(referencePayload);
}

function makeRelativeReferencePayload(referencePayload = null, currentStatePayload = null) {
  const currentState = currentRootAnchorState(currentStatePayload);
  return makeRootMatchedReferencePayload(referencePayload, currentState);
}

function syncReferenceOverlays(referencePayload = null) {
  const physicsEnabled = Boolean(session.value?.physics_enabled && referencePayload);
  const currentStatePayload = currentPhysicsStatePayload(referencePayload?.joint_names || frameCache.jointNames);
  const globalEnabled = Boolean(globalReferenceOverlayEnabled.value && physicsEnabled);
  const relativeEnabled = Boolean(relativeReferenceOverlayEnabled.value && physicsEnabled);
  viewer?.setReferenceOverlayEnabled?.(globalEnabled, 'global');
  viewer?.setReferenceOverlayEnabled?.(relativeEnabled, 'relative');
  if (globalEnabled) {
    const globalSourcePayload = globalReferencePayloadSource(referencePayload);
    const globalPayload = makeGlobalReferencePayload(globalSourcePayload, currentStatePayload);
    viewer?.updateReferenceOverlay?.(globalPayload, 'global');
  }
  if (relativeEnabled) {
    const relativePayload = makeRelativeReferencePayload(referencePayload, currentStatePayload);
    viewer?.updateReferenceOverlay?.(relativePayload, 'relative');
  }
}

function syncPhysicsProgressFromReference(referencePayload = null) {
  if (!referencePayload || referencePayload.sequence_id === 'default_stance') {
    return;
  }
  const frameIndex = Math.min(Math.max(Number(referencePayload.frame_index) || 0, 0), maxFrame.value);
  browserPhysics.referenceFrame = frameIndex;
  browserPhysics.referenceFrameFloat = frameIndex;
  viewerFrameIndex.value = frameIndex;
  frameInput.value = frameIndex;
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

function makeSimulationStatePayload(simulation, jointNames = frameCache.jointNames) {
  const state = simulation?.readState?.(jointNames);
  if (!state) {
    return null;
  }
  return {
    joint_names: jointNames || frameCache.jointNames,
    body_names: frameCache.bodyNames,
    state
  };
}

function currentTrackingReferencePayload() {
  return browserPolicyRuntime.currentTrackingReferencePayload({
    body_names: frameCache.bodyNames
  });
}

async function prepareBrowserTrackingMotion() {
  if (!frameCacheReadyForActiveSequence()) {
    throw new Error(t('motion.framesRequired'));
  }
  await ensureBrowserPolicyActive();
  normalizeFrameCacheAsMotionClip(frameCache);
  browserPolicyRuntime.setMotionClip(ACTIVE_BROWSER_MOTION_NAME, frameCache);
}

function resetBrowserPolicyTrackingToDefault() {
  browserPolicyRuntime.requestMotion('default', currentPhysicsStatePayload(frameCache.jointNames));
}

function browserMotionStartTransitionSteps() {
  if (!motionStartTransitionEnabled.value) {
    return 0;
  }
  return Math.max(0, Math.ceil(BROWSER_MOTION_START_TRANSITION_SECONDS / browserPhysics.controlDt));
}

async function switchBrowserPolicyTrackingToActiveClip(startFrame = browserPhysics.referenceFrame) {
  await prepareBrowserTrackingMotion();
  const currentStatePayload = currentPhysicsStatePayload(frameCache.jointNames);
  if (Number(startFrame) === 0) {
    scheduleGlobalReferenceRootSync('motion_start');
    calibrateGlobalReferenceMotion(0, currentStatePayload);
  }
  browserPolicyRuntime.requestMotion(
    ACTIVE_BROWSER_MOTION_NAME,
    currentStatePayload,
    { startFrame, transitionSteps: browserMotionStartTransitionSteps() }
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
  browserPhysics.endHoldActive = false;
  browserPhysics.lastPolicyOutput = null;
  browserPhysics.targetMode = 'default_stance';
  browserPhysics.loopToken += 1;
  browserPhysics.controlDt = DEFAULT_BROWSER_PHYSICS_CONTROL_DT;
}

function stopBrowserPhysicsLoop() {
  resetBrowserPhysics();
  viewer?.setPhysicsInteractionEnabled?.(false);
  viewer?.setReferenceOverlayEnabled?.(false, 'global');
  viewer?.setReferenceOverlayEnabled?.(false, 'relative');
}

function policyDisabled(policy) {
  return !session.value?.physics_enabled && policy.policy_id !== MOCK_BROWSER_POLICY_ID;
}

async function ensureBrowserPolicyActive() {
  if (browserPolicyRuntime.activePolicyId) {
    configureBrowserTargetSmoothing();
    return;
  }
  const manifest = policies.value.find((policy) => policy.policy_id === selectedPolicyId.value)
    || policies.value.find((policy) => policy.policy_id === MOCK_BROWSER_POLICY_ID);
  await browserPolicyRuntime.activate(manifest);
  configureBrowserTargetSmoothing();
  browserPolicyState.value = browserPolicyRuntime.status();
  updateMotionStartDifficulty();
}

async function inferBrowserPhysicsTarget(frameIndex, payloadOverride = null) {
  await ensureBrowserPolicyActive();
  const payload = payloadOverride || framePayloadForIndex(frameIndex);
  if (!payload) {
    return browserPhysics.lastPolicyOutput;
  }
  const currentState = currentPhysicsStatePayload(payload.joint_names);
  const output = await browserPolicyRuntime.step({
    reference: {
      joint_names: payload.joint_names,
      body_names: payload.body_names,
      state: payload.state
    },
    current_state: currentState
  });
  browserPolicyState.value = browserPolicyRuntime.status();
  if (output) {
    browserPhysics.lastPolicyOutput = output;
    syncBrowserPhysicsControlDt(output);
  }
  return browserPhysics.lastPolicyOutput;
}

function telemetryReferencePayload(referencePayload, currentState) {
  if (
    browserPhysics.targetMode !== 'default_stance'
    || !referencePayload?.state
    || !currentState?.root_translation
  ) {
    return referencePayload;
  }
  return {
    ...referencePayload,
    state: {
      ...referencePayload.state,
      root_translation: [
        currentState.root_translation[0],
        currentState.root_translation[1],
        referencePayload.state.root_translation?.[2] ?? currentState.root_translation[2]
      ]
    }
  };
}

function recordTrackingTelemetry({
  frameIndex = viewerFrameIndex.value,
  referencePayload = null,
  target = null,
  currentState = null,
  contact = null,
  policyId = browserPolicyState.value.active_policy_id,
  publish = true
} = {}) {
  if (!referencePayload || !currentState) {
    return null;
  }
  const resolvedContact = contact || viewer?.readContactSummary?.();
  const sample = trackingTelemetrySample({
    policyId,
    frameIndex,
    reference: telemetryReferencePayload(referencePayload, currentState),
    currentState,
    target,
    contact: resolvedContact
  });
  if (publish) {
    evaluationTelemetry.latest = sample;
    evaluationTelemetry.contact = resolvedContact;
    evaluationTelemetry.history.push(sample);
    if (evaluationTelemetry.history.length > 360) {
      evaluationTelemetry.history.splice(0, evaluationTelemetry.history.length - 360);
    }
  }
  if (evaluationTelemetry.activeRun) {
    recordEvaluationSample(evaluationTelemetry.activeRun, sample);
  }
  return sample;
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
  browserPhysics.endHoldActive = false;
  return resetViewerToDefaultStance();
}

function browserPhysicsEndHoldSteps() {
  return Math.ceil(BROWSER_PHYSICS_END_HOLD_SECONDS / browserPhysics.controlDt);
}

function advanceBrowserPhysicsSourceFrame() {
  const fps = Math.max(1, Number(activeSequence.value.fps) || 30);
  const nextFrameFloat = browserPhysics.referenceFrameFloat + fps * browserPhysics.controlDt;
  if (nextFrameFloat > maxFrame.value) {
    if (session.value?.loop_enabled) {
      browserPhysics.endHoldStepsRemaining = 0;
      browserPhysics.endHoldActive = false;
      browserPhysics.referenceFrameFloat = 0;
      browserPhysics.referenceFrame = 0;
      return { frameIndex: 0, looped: true, ended: false };
    }
    browserPhysics.endHoldStepsRemaining = 0;
    browserPhysics.endHoldActive = false;
    browserPhysics.referenceFrameFloat = 0;
    browserPhysics.referenceFrame = 0;
    return { frameIndex: 0, looped: false, ended: true };
  }
  browserPhysics.endHoldStepsRemaining = 0;
  browserPhysics.endHoldActive = false;
  browserPhysics.referenceFrameFloat = nextFrameFloat;
  browserPhysics.referenceFrame = Math.floor(browserPhysics.referenceFrameFloat);
  return { frameIndex: browserPhysics.referenceFrame, looped: false, ended: false };
}

function advanceBrowserPhysicsReferenceFrame() {
  const trackingState = browserPolicyRuntime.trackingState();
  if (!trackingState?.available) {
    return advanceBrowserPhysicsSourceFrame();
  }
  if (trackingState.isDefault) {
    return { frameIndex: browserPhysics.referenceFrame, looped: false, ended: false };
  }
  const sourceFrame = Math.min(
    Math.max(Number(trackingState.sourceFrame ?? (trackingState.refIdx - trackingState.transitionLen)) || 0, 0),
    maxFrame.value
  );
  if (trackingState.inTransition) {
    browserPhysics.endHoldStepsRemaining = 0;
    browserPhysics.endHoldActive = false;
    browserPhysics.referenceFrameFloat = sourceFrame;
    browserPhysics.referenceFrame = sourceFrame;
    return { frameIndex: sourceFrame, looped: false, ended: false, transitioning: true };
  }
  if (trackingState.currentDone) {
    if (session.value?.loop_enabled) {
      browserPhysics.endHoldStepsRemaining = 0;
      browserPhysics.endHoldActive = false;
      browserPhysics.referenceFrameFloat = 0;
      browserPhysics.referenceFrame = 0;
      return { frameIndex: 0, looped: true, ended: false };
    }
    if (!browserPhysics.endHoldActive) {
      browserPhysics.endHoldActive = true;
      browserPhysics.endHoldStepsRemaining = browserPhysicsEndHoldSteps();
    }
    if (browserPhysics.endHoldStepsRemaining > 0) {
      browserPhysics.endHoldStepsRemaining -= 1;
      browserPhysics.referenceFrameFloat = sourceFrame;
      browserPhysics.referenceFrame = sourceFrame;
      return { frameIndex: sourceFrame, looped: false, ended: false, holdingEnd: true };
    }
    browserPhysics.endHoldStepsRemaining = 0;
    browserPhysics.endHoldActive = false;
    browserPhysics.referenceFrameFloat = 0;
    browserPhysics.referenceFrame = 0;
    return { frameIndex: 0, looped: false, ended: true };
  }
  browserPhysics.endHoldStepsRemaining = 0;
  browserPhysics.endHoldActive = false;
  browserPhysics.referenceFrameFloat = sourceFrame;
  browserPhysics.referenceFrame = sourceFrame;
  return { frameIndex: browserPhysics.referenceFrame, looped: false, ended: false };
}

async function browserPhysicsLoop() {
  const token = browserPhysics.loopToken;
  while (browserPhysics.active && token === browserPhysics.loopToken) {
    const loopStart = performance.now();
    try {
      let target = browserPhysics.lastPolicyOutput;
      let referencePayload = null;
      if (browserPhysics.targetMode === 'default_stance') {
        const frameIndex = viewerFrameIndex.value;
        referencePayload = defaultStanceFramePayload();
        target = await inferBrowserPhysicsTarget(frameIndex, referencePayload);
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
          referencePayload = defaultStanceFramePayload();
          target = await inferBrowserPhysicsTarget(referenceFrame.frameIndex, referencePayload);
        } else {
          referencePayload = currentTrackingReferencePayload() || framePayloadForIndex(referenceFrame.frameIndex);
          target = await inferBrowserPhysicsTarget(referenceFrame.frameIndex, referencePayload);
          referencePayload = currentTrackingReferencePayload() || referencePayload;
          syncPhysicsProgressFromReference(referencePayload);
        }
      }

      if (!browserPhysics.active || token !== browserPhysics.loopToken) {
        break;
      }
      syncReferenceOverlays(referencePayload);
      const steppedState = viewer.stepPhysics({
        joint_names: target?.joint_names || frameCache.jointNames,
        joint_positions: target?.joint_positions || [],
        kp: target?.kp,
        kd: target?.kd,
        torque_limits: target?.torque_limits,
        physics_options: target?.physics_options,
        steps: viewer.getPhysicsDecimation(target?.control_dt ?? browserPhysics.controlDt),
        now: performance.now()
      });
      recordTrackingTelemetry({
        frameIndex: viewerFrameIndex.value,
        referencePayload,
        target,
        currentState: steppedState
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
  if (targetMode !== 'default_stance' && !frameCacheReadyForActiveSequence()) {
    throw new Error(t('motion.framesRequired'));
  }
  stopLocalPlaybackLoop();
  const previousMode = browserPhysics.targetMode;
  const startFrame = viewerFrameIndex.value;
  browserPhysics.targetMode = targetMode;
  if (!browserPhysics.active) {
    if (targetMode === 'default_stance') {
      await resetViewerToDefaultStance();
    } else {
      await resetViewerToDefaultStance();
      browserPhysics.targetMode = targetMode;
      browserPhysics.referenceFrame = startFrame;
      browserPhysics.referenceFrameFloat = startFrame;
      browserPhysics.endHoldStepsRemaining = 0;
      browserPhysics.endHoldActive = false;
      browserPhysics.lastPolicyOutput = null;
      await switchBrowserPolicyTrackingToActiveClip(startFrame);
      await inferBrowserPhysicsTarget(startFrame);
    }
  } else if (previousMode !== targetMode) {
    if (targetMode === 'default_stance') {
      await resetViewerToDefaultStance();
    } else {
      browserPhysics.referenceFrameFloat = browserPhysics.referenceFrame;
      browserPhysics.endHoldStepsRemaining = 0;
      browserPhysics.endHoldActive = false;
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
    scheduleGlobalReferenceRootSync('no_motion');
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
      viewerStatus.value = makeStatus('viewer.cachedFrames', { count: cachedFrameCount() });
      if ((session.value?.current_frame ?? 0) === 0) {
        scheduleGlobalReferenceRootSync('motion_start');
      }
    }
  }
}

function cancelFrameCacheRequest() {
  frameCacheAbortController?.abort();
  frameCacheAbortController = null;
}

async function loadFrameCacheForActiveSequence() {
  const sequence = activeSequence.value;
  if (!sequence || frameCache.sequenceId === sequence.sequence_id || frameCache.loadingSequenceId === sequence.sequence_id) {
    syncViewerFromSession();
    return;
  }

  cancelFrameCacheRequest();
  const token = frameCacheRequestToken + 1;
  frameCacheRequestToken = token;
  const controller = new AbortController();
  frameCacheAbortController = controller;
  frameCache = {
    sequenceId: null,
    loadingSequenceId: sequence.sequence_id,
    jointNames: [],
    bodyNames: [],
    frames: []
  };
  stopLocalPlaybackLoop();
  viewerStatus.value = makeStatus('viewer.loadingFrames');

  try {
    for (let start = 0; start < sequence.frame_count; start += FRAME_CACHE_CHUNK_SIZE) {
      const payload = await postJson('/api/get_frames', {
        sequence_id: sequence.sequence_id,
        start,
        end: Math.min(sequence.frame_count, start + FRAME_CACHE_CHUNK_SIZE),
        stride: 1
      }, { signal: controller.signal });
      if (token !== frameCacheRequestToken || controller.signal.aborted) {
        return;
      }
      if (!frameCache.sequenceId) {
        frameCache = {
          sequenceId: payload.sequence_id,
          loadingSequenceId: sequence.sequence_id,
          jointNames: payload.joint_names || sequence.joint_names || [],
          bodyNames: payload.body_names || sequence.body_names || [],
          frames: []
        };
      }
      frameCache.frames.splice(start, payload.frames.length, ...payload.frames);
      if (start === 0) {
        syncViewerFromSession();
      }
      viewerStatus.value = makeStatus('viewer.cachedFrames', {
        count: cachedFrameCount()
      });
      await sleep(0);
    }
    frameCache.loadingSequenceId = null;
    if (browserPolicyIsActive()) {
      updateMotionStartDifficulty();
    }
    scheduleGlobalReferenceRootSync('motion_loaded');
    viewerStatus.value = makeStatus('viewer.cachedFrames', { count: cachedFrameCount() });
    syncViewerFromSession();
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }
    if (token === frameCacheRequestToken) {
      viewerStatus.value = error.message;
    }
  } finally {
    if (frameCacheAbortController === controller) {
      frameCacheAbortController = null;
    }
    if (token === frameCacheRequestToken && frameCache.loadingSequenceId === sequence.sequence_id) {
      frameCache.loadingSequenceId = null;
    }
  }
}

async function refreshSession() {
  try {
    session.value = await fetchJson('/api/session');
    renderSession();
    void loadFrameCacheForActiveSequence();
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
  cancelFrameCacheRequest();
  frameCacheRequestToken += 1;
  frameCache = {
    sequenceId: null,
    loadingSequenceId: null,
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
    viewerFrameIndex.value = 0;
    frameInput.value = 0;
    browserPhysics.endHoldStepsRemaining = 0;
    browserPhysics.endHoldActive = false;
    browserPhysics.lastPolicyOutput = null;
    scheduleGlobalReferenceRootSync('motion_switch');
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
    browserPhysics.endHoldActive = false;
    viewerFrameIndex.value = boundedFrame;
    frameInput.value = boundedFrame;
    if (boundedFrame === 0) {
      scheduleGlobalReferenceRootSync('seek_start');
    }
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

function beginTrimFrameEdit(target) {
  if (target === 'start') {
    editingTrimStart.value = true;
    return;
  }
  if (target === 'end') {
    editingTrimEnd.value = true;
  }
}

async function commitTrimStart() {
  editingTrimStart.value = false;
  await setTrimStart();
}

async function commitTrimEnd() {
  editingTrimEnd.value = false;
  await setTrimEnd();
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
  configureBrowserTargetSmoothing();
  browserPolicyState.value = browserPolicyRuntime.status();
  updateMotionStartDifficulty();
  selectedPolicyGroupId.value = selectedPolicyGroupForPolicy(manifest);
  browserPhysics.lastPolicyOutput = null;
  browserPhysics.endHoldStepsRemaining = 0;
  browserPhysics.endHoldActive = false;
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
    magnitude: 80,
    duration: 0.15
  });
  setStatus(commandStatus, makeStatus('test.browserImpulseQueued', { preset }));
}

function applyCameraPreset(preset) {
  viewer?.applyCameraPreset?.(preset);
}

function applySelectedCameraPreset() {
  applyCameraPreset(selectedCameraPreset.value);
}

function toggleContactForceMarkers() {
  contactForceMarkersEnabled.value = !contactForceMarkersEnabled.value;
  viewer?.setContactMarkersEnabled?.(contactForceMarkersEnabled.value);
}

function toggleCameraFollow() {
  cameraFollowEnabled.value = !cameraFollowEnabled.value;
  viewer?.setCameraFollowEnabled?.(cameraFollowEnabled.value);
}

function startViewerRecording() {
  viewer?.startRecording?.({ fps: 30, mimeType: 'video/mp4' });
  evaluationTelemetry.recording = Boolean(viewer?.isRecording?.());
  recordingMimeType.value = viewer?.recordingMimeType?.() || 'video/mp4';
}

async function stopViewerRecording() {
  const blob = await viewer?.stopRecording?.();
  evaluationTelemetry.recording = false;
  if (blob) {
    recordingMimeType.value = blob.type || recordingMimeType.value || 'video/mp4';
    if (evaluationTelemetry.recordingUrl) {
      URL.revokeObjectURL?.(evaluationTelemetry.recordingUrl);
    }
    evaluationTelemetry.recordingUrl = URL.createObjectURL(blob);
  }
}

async function createEvaluationPolicyRuntime(policyId) {
  const manifest = policies.value.find((policy) => policy.policy_id === policyId);
  if (!manifest) {
    throw new Error(t('policy.noneAvailable'));
  }
  const runtime = createBrowserPolicyRuntime();
  configurePolicyRuntimeTargetSmoothing(runtime);
  await runtime.activate(manifest);
  runtime.setMotionClip(ACTIVE_BROWSER_MOTION_NAME, frameCache);
  return runtime;
}

function evaluationDefaultStancePayload(runtime) {
  const target = runtime.defaultStance();
  return {
    target,
    payload: makePolicyTargetPayload(target, 0, 'evaluation_default_stance')
  };
}

function evaluationMotionStartTransitionSteps(controlDt) {
  if (!motionStartTransitionEnabled.value) {
    return 0;
  }
  const dt = Number.isFinite(Number(controlDt)) && Number(controlDt) > 0
    ? Number(controlDt)
    : DEFAULT_BROWSER_PHYSICS_CONTROL_DT;
  return Math.max(0, Math.ceil(BROWSER_MOTION_START_TRANSITION_SECONDS / dt));
}

async function inferEvaluationPolicyTarget(runtime, simulation, frameIndex, referencePayload) {
  const currentState = makeSimulationStatePayload(simulation, referencePayload?.joint_names || frameCache.jointNames);
  const output = await runtime.step({
    reference: {
      joint_names: referencePayload.joint_names,
      body_names: referencePayload.body_names,
      state: referencePayload.state
    },
    current_state: currentState
  });
  return output || runtime.lastOutput;
}

async function runPolicyEvaluation(policyId) {
  const evaluationRuntime = await createEvaluationPolicyRuntime(policyId);
  const evaluationSimulation = viewer?.createEvaluationSimulation?.();
  if (!evaluationSimulation) {
    throw new Error('MuJoCo evaluation simulation is not available.');
  }
  const { target: defaultTarget, payload: defaultPayload } = evaluationDefaultStancePayload(evaluationRuntime);
  evaluationSimulation.resetPhysics(defaultPayload);
  evaluationRuntime.requestMotion(
    ACTIVE_BROWSER_MOTION_NAME,
    makeSimulationStatePayload(evaluationSimulation, frameCache.jointNames),
    {
      startFrame: 0,
      transitionSteps: evaluationMotionStartTransitionSteps(defaultTarget?.control_dt)
    }
  );
  const run = createEvaluationRun({
    policyId,
    motionName: activeSequence.value?.name,
    frameCount: frameCache.frames.length
  });
  evaluationTelemetry.activeRun = run;
  const maxEvaluationFrame = Math.min(maxFrame.value, Math.max(0, frameCache.frames.length - 1));
  try {
    for (let frameIndex = 0; frameIndex <= maxEvaluationFrame; frameIndex += 1) {
      const referencePayload = framePayloadForIndex(frameIndex);
      const target = await inferEvaluationPolicyTarget(evaluationRuntime, evaluationSimulation, frameIndex, referencePayload);
      const steppedState = evaluationSimulation.stepPhysics({
        joint_names: target?.joint_names || frameCache.jointNames,
        joint_positions: target?.joint_positions || [],
        kp: target?.kp,
        kd: target?.kd,
        torque_limits: target?.torque_limits,
        physics_options: target?.physics_options,
        steps: evaluationSimulation.getPhysicsDecimation(target?.control_dt ?? DEFAULT_BROWSER_PHYSICS_CONTROL_DT),
        now: performance.now()
      });
      const sample = recordTrackingTelemetry({
        frameIndex,
        referencePayload,
        target,
        currentState: steppedState,
        contact: evaluationSimulation.readContactSummary(),
        policyId,
        publish: false
      });
      if (sample?.fallen) {
        break;
      }
      if (frameIndex % 8 === 0) {
        evaluationTelemetry.comparisonProgress = makeStatus('evaluation.comparingProgress', {
          policy: policyId,
          progress: percent((frameIndex + 1) / (maxEvaluationFrame + 1))
        });
        await sleep(0);
      }
    }
  } finally {
    evaluationTelemetry.activeRun = null;
    evaluationSimulation.dispose?.();
  }
  return {
    ...summarizeEvaluationRun(run),
    startedAt: run.startedAt
  };
}

async function runPolicyComparison() {
  if (!session.value?.physics_enabled || !comparisonPolicyA.value || !comparisonPolicyB.value) {
    throw new Error(t('evaluation.comparisonRequired'));
  }
  if (!frameCacheReadyForActiveSequence()) {
    throw new Error(t('motion.framesRequired'));
  }
  evaluationTelemetry.comparing = true;
  const originalPolicyId = selectedPolicyId.value;
  const originalMode = browserPhysics.targetMode;
  const wasActive = browserPhysics.active;
  stopBrowserPhysicsLoop();
  try {
    const results = [];
    for (const policyId of [comparisonPolicyA.value, comparisonPolicyB.value]) {
      results.push(await runPolicyEvaluation(policyId));
    }
    evaluationTelemetry.comparisonResults = results;
  } finally {
    evaluationTelemetry.comparing = false;
    evaluationTelemetry.comparisonProgress = null;
    if (originalPolicyId) {
      await switchSelectedPolicy(originalPolicyId, { resetStance: false });
    }
    await resetViewerToDefaultStance();
    if (wasActive) {
      await startBrowserPhysicsLoop(originalMode);
    }
  }
}

watch(() => session.value?.physics_enabled, (enabled) => {
  if (!enabled) {
    motionStartTransitionEnabled.value = false;
    targetSmoothingEnabled.value = false;
  }
});

watch([targetSmoothingEnabled, targetSmoothingAlpha], () => {
  configureBrowserTargetSmoothing();
});

watch(globalReferenceOverlayEnabled, (enabled) => {
  viewer?.setReferenceOverlayEnabled?.(Boolean(enabled && session.value?.physics_enabled), 'global');
});

watch(relativeReferenceOverlayEnabled, (enabled) => {
  viewer?.setReferenceOverlayEnabled?.(Boolean(enabled && session.value?.physics_enabled), 'relative');
});

watch(contactForceMarkersEnabled, (enabled) => {
  viewer?.setContactMarkersEnabled?.(contactForceMarkersEnabled.value);
});

watch(cameraFollowEnabled, () => {
  viewer?.setCameraFollowEnabled?.(cameraFollowEnabled.value);
});

watch(policies, () => {
  ensureComparisonSelection();
});

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
    output_name: exportOutputName.value.trim() || null,
    twist2_extension: exportFormat.value === 'twist2' ? twist2Extension.value : null
  });
  setStatus(commandStatus, makeStatus('trim.exportedTo', { path: payload.output_path }));
  showExportToast(payload.output_path);
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
    viewer.setContactMarkersEnabled?.(contactForceMarkersEnabled.value);
    viewer.setCameraFollowEnabled?.(cameraFollowEnabled.value);
    viewer.applyCameraPreset?.(selectedCameraPreset.value);
    viewerReady.value = true;
    viewerStatus.value = makeStatus('viewer.readyShort');
  } catch (error) {
    viewerStatus.value = error.message;
  }
}

onMounted(async () => {
  restoreUiTheme();
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
  if (exportToastTimer) {
    window.clearTimeout(exportToastTimer);
  }
  stopLocalPlaybackLoop();
  stopBrowserPhysicsLoop();
  cancelFrameCacheRequest();
  if (evaluationTelemetry.recordingUrl) {
    URL.revokeObjectURL?.(evaluationTelemetry.recordingUrl);
  }
  viewer?.dispose();
});
</script>
