import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf-8');
const apiSource = readFileSync(new URL('./api.js', import.meta.url), 'utf-8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf-8');
const indexHtmlSource = readFileSync(new URL('../index.html', import.meta.url), 'utf-8');
const viteConfigSource = readFileSync(new URL('../vite.config.mjs', import.meta.url), 'utf-8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');

function cssBlock(selectorPattern, label = selectorPattern) {
  const match = stylesSource.match(new RegExp(`${selectorPattern}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing CSS block for ${label}`);
  return match.groups.body;
}

function functionBody(name) {
  const match = source.match(new RegExp(`async function ${name}\\(\\) \\{(?<body>[\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing ${name}()`);
  return match.groups.body;
}

function asyncFunctionBody(name) {
  const match = source.match(new RegExp(`async function ${name}\\([^)]*\\) \\{(?<body>[\\s\\S]*?)\\n\\}`));
  assert.ok(match, `missing ${name}()`);
  return match.groups.body;
}

test('viewer uses cached browser frames instead of high-frequency session state polling', () => {
  const refreshSessionBody = functionBody('refreshSession');

  assert.doesNotMatch(refreshSessionBody, /refreshViewerState\(\)/);
  assert.doesNotMatch(source, /VIEWER_STATE_POLL_INTERVAL_MS/);
  assert.doesNotMatch(source, /viewerPollHandle = window\.setInterval\(refreshViewerState/);
  assert.match(source, /\/api\/get_frames/);
  assert.match(source, /startLocalPlayback\(/);
  assert.match(source, /pollHandle = window\.setInterval\(refreshSession, SESSION_POLL_INTERVAL_MS\)/);
});

test('motion frame cache loads in cancellable chunks without blocking session polling', () => {
  assert.match(apiSource, /export async function postJson\(url,\s*payload,\s*options = \{\}\)/);
  assert.match(apiSource, /signal:\s*options\.signal/);

  assert.match(source, /const FRAME_CACHE_CHUNK_SIZE = \d+/);
  assert.match(source, /let frameCacheAbortController = null/);
  assert.match(source, /function cancelFrameCacheRequest\(\)/);
  assert.match(source, /frameCacheAbortController\?\.abort\(\)/);

  const refreshBody = functionBody('refreshSession');
  assert.match(refreshBody, /void loadFrameCacheForActiveSequence\(\)/);
  assert.doesNotMatch(refreshBody, /await loadFrameCacheForActiveSequence\(\)/);

  const cacheBody = functionBody('loadFrameCacheForActiveSequence');
  assert.match(cacheBody, /frameCache\.loadingSequenceId === sequence\.sequence_id/);
  assert.match(cacheBody, /fps:\s*Number\(sequence\.fps\) \|\| 50/);
  assert.match(cacheBody, /new AbortController\(\)/);
  assert.match(cacheBody, /for \(let start = 0; start < sequence\.frame_count; start \+= FRAME_CACHE_CHUNK_SIZE\)/);
  assert.match(cacheBody, /end:\s*Math\.min\(sequence\.frame_count,\s*start \+ FRAME_CACHE_CHUNK_SIZE\)/);
  assert.match(cacheBody, /signal:\s*controller\.signal/);
  assert.match(cacheBody, /token !== frameCacheRequestToken \|\| controller\.signal\.aborted/);
  assert.match(cacheBody, /frameCache\.frames\.splice\(start,\s*payload\.frames\.length,\s*\.\.\.payload\.frames\)/);
  assert.match(cacheBody, /await sleep\(0\)/);

  assert.match(source, /function frameCacheReadyForActiveSequence\(\)/);
  assert.match(source, /!frameCache\.loadingSequenceId/);
  assert.match(source, /cachedFrameCount\(\) >= activeSequence\.value\.frame_count/);
  assert.match(source, /async function prepareBrowserTrackingMotion\(\) \{[\s\S]*?if \(!frameCacheReadyForActiveSequence\(\)\) \{[\s\S]*?throw new Error\(t\('motion\.framesRequired'\)\)/);
  assert.match(source, /async function runPolicyComparison\(\) \{[\s\S]*?if \(!frameCacheReadyForActiveSequence\(\)\) \{[\s\S]*?throw new Error\(t\('motion\.framesRequired'\)\)/);

  const handleBody = source.match(/async function handleTreeNode\(node\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  assert.match(handleBody, /cancelFrameCacheRequest\(\)/);
});

test('browser tab uses the G1 console favicon', () => {
  const faviconUrl = new URL('../public/favicon.svg', import.meta.url);

  assert.match(indexHtmlSource, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
  assert.equal(existsSync(faviconUrl), true);
  const faviconSource = readFileSync(faviconUrl, 'utf-8');
  assert.match(faviconSource, /<svg[^>]+viewBox="0 0 64 64"/);
  assert.match(faviconSource, /G1/);
});

test('policy controls use the browser policy runtime instead of backend policy endpoints', () => {
  assert.match(source, /createBrowserPolicyRuntime/);
  assert.match(source, /normalizeFrameCacheAsMotionClip/);
  assert.doesNotMatch(source, /\/api\/policies\/active/);
  assert.doesNotMatch(source, /\/api\/policies\/step/);
  assert.doesNotMatch(source, /\/api\/policies['"`]/);
});

test('policy cards load browser runnable policy plugins from the backend registry', () => {
  assert.match(source, /DEFAULT_BROWSER_POLICY_MANIFESTS/);
  assert.match(source, /browserRunnablePolicies/);
  assert.match(source, /async function loadPolicyPlugins\(options = \{\}\)/);
  assert.match(source, /fetchJson\('\/api\/policy-plugins'\)/);
  assert.match(source, /policies\.value = browserRunnablePolicies\(payload\.policies\)/);
  assert.match(source, /policies\.value = \[\.\.\.DEFAULT_BROWSER_POLICY_MANIFESTS\]/);
  assert.match(source, /await loadPolicyPlugins\(\)/);
  assert.match(source, /const POLICY_PLUGIN_REFRESH_INTERVAL_MS = 5000/);
  assert.match(source, /policyRefreshHandle = window\.setInterval\(\(\) => \{[\s\S]*?loadPolicyPlugins\(\{ quiet: true \}\)/);
  assert.match(source, /window\.clearInterval\(policyRefreshHandle\)/);
  assert.doesNotMatch(source, /import \{[^}]*\bBROWSER_POLICY_MANIFESTS\b/);
  assert.doesNotMatch(source, /\[\.\.\.BROWSER_POLICY_MANIFESTS\]/);
});

test('vite dev proxy points policy APIs to the 8050 backend', () => {
  assert.match(viteConfigSource, /'\/api': 'http:\/\/127\.0\.0\.1:8050'/);
  assert.match(viteConfigSource, /'\/policy-plugins': 'http:\/\/127\.0\.0\.1:8050'/);
  assert.doesNotMatch(viteConfigSource, /127\.0\.0\.1:8000/);
});

test('physics mode runs browser MuJoCo steps instead of polling backend state', () => {
  assert.match(source, /startBrowserPhysicsLoop/);
  assert.match(source, /viewer\.stepPhysics/);
  assert.match(source, /queueBrowserImpulse/);
  assert.doesNotMatch(source, /refreshViewerState\(\)/);
  assert.doesNotMatch(source, /\/api\/session\/state/);
  assert.doesNotMatch(source, /\/api\/viewer\/test\/impulse/);
});

test('browser physics uses policy gains and viewer timestep decimation', () => {
  assert.doesNotMatch(source, /BROWSER_PHYSICS_SUBSTEPS\s*=\s*2/);
  assert.match(source, /const DEFAULT_BROWSER_PHYSICS_CONTROL_DT = 0\.02/);
  assert.match(source, /steps:\s*viewer\.getPhysicsDecimation\(target\?\.control_dt \?\? browserPhysics\.controlDt\)/);
  assert.match(source, /kp:\s*target\?\.kp/);
  assert.match(source, /kd:\s*target\?\.kd/);
  assert.match(source, /physics_options:\s*target\?\.physics_options/);
});

test('turning physics on pauses playback and resets to default stance', () => {
  const body = functionBody('togglePhysics');

  assert.match(source, /async function resetViewerToDefaultStance\(\)/);
  assert.match(source, /function pausePhysicsToDefaultStance\(\)/);
  assert.match(body, /postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'pause'\s*\}\)/);
  assert.match(body, /resetViewerToDefaultStance\(\)/);
});

test('physics pause holds the default stance instead of stopping the physics loop', () => {
  assert.match(source, /@click="runCommand\(pausePlayback/);
  assert.match(source, /async function pausePlayback\(\)/);
  const body = functionBody('pausePlayback');

  assert.match(body, /pausePhysicsToDefaultStance\(\)/);
  assert.doesNotMatch(body, /stopBrowserPhysicsLoop\(\)/);
});

test('reset stance button recovers browser physics to default stance', () => {
  assert.match(source, /id="resetStanceButton"/);
  assert.match(source, /\{\{ t\('test\.resetStance'\) \}\}/);
  assert.match(source, /@click="runCommand\(resetPhysicsToDefaultStance/);
  assert.match(source, /:disabled="!session\?\.physics_enabled"/);
  assert.match(source, /async function resetPhysicsToDefaultStance\(\)/);
  const body = functionBody('resetPhysicsToDefaultStance');

  assert.match(body, /session\.value\?\.physics_enabled/);
  assert.match(body, /resetViewerToDefaultStance\(\)/);
  assert.match(body, /startBrowserPhysicsLoop\('default_stance'\)/);
  assert.doesNotMatch(body, /postJson\('\/api\/session\/playback'/);
});

test('test state reset endpoint is not exposed as a main UI command', () => {
  assert.doesNotMatch(source, /id="resetTestButton"/);
  assert.doesNotMatch(source, /class="test-maintenance"/);
  assert.doesNotMatch(source, /'test\.clearDone'/);
  assert.doesNotMatch(source, /postJson\('\/api\/viewer\/test\/reset'\)/);
});

test('browser physics control loop follows humanoid-policy-viewer async timing pattern', () => {
  assert.match(source, /async function browserPhysicsLoop\(\)/);
  assert.match(source, /await sleep\(sleepTime\)/);
  assert.match(source, /browserPhysics\.targetMode === 'default_stance'/);
  assert.match(source, /if \(!browserPhysics\.active \|\| token !== browserPhysics\.loopToken\) \{[\s\S]*?break;[\s\S]*?\}[\s\S]*?viewer\.stepPhysics/);
  assert.doesNotMatch(source, /function browserPhysicsStep\(timestamp\)/);
  assert.doesNotMatch(source, /window\.requestAnimationFrame\(browserPhysicsStep\)/);
  assert.doesNotMatch(source, /while \(browserPhysics\.accumulator >= stepInterval\)/);
});

test('default stance mode keeps active ONNX policy inferencing against default reference', () => {
  assert.match(source, /function defaultStanceFramePayload\(\)/);
  assert.match(source, /function resetBrowserPolicyTrackingToDefault\(\)/);
  assert.match(source, /referencePayload = defaultStanceFramePayload\(\)/);
  assert.match(source, /inferBrowserPhysicsTarget\(frameIndex,\s*referencePayload\)/);
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.doesNotMatch(loopBody, /target = browserPolicyRuntime\.defaultStance\(\)/);
  assert.doesNotMatch(loopBody, /browserPolicyState\.value = browserPolicyRuntime\.status\(\);\s*\n\s*\}\s*else/);
});

test('browser physics policy input uses live MuJoCo state as observation', () => {
  assert.match(source, /function currentPhysicsStatePayload/);
  const match = source.match(/async function inferBrowserPhysicsTarget\([^)]*\) \{(?<body>[\s\S]*?)\n\}/);
  assert.ok(match, 'missing inferBrowserPhysicsTarget()');
  const body = match.groups.body;

  assert.match(body, /const currentState = currentPhysicsStatePayload\(payload\.joint_names\)/);
  assert.match(body, /current_state:\s*currentState/);
  assert.match(source, /viewer\?\.readState\(jointNames\)/);
});

test('playback selects the active clip as ONNX tracking target while pause selects default', () => {
  assert.match(source, /const ACTIVE_BROWSER_MOTION_NAME = 'active_clip'/);
  assert.match(source, /const BROWSER_MOTION_START_TRANSITION_SECONDS = 2/);
  assert.match(source, /const motionStartTransitionEnabled = ref\(true\)/);
  assert.match(source, /function browserMotionStartTransitionSteps\(\)/);
  assert.match(source, /async function prepareBrowserTrackingMotion\(\)/);
  assert.match(source, /async function switchBrowserPolicyTrackingToActiveClip\(startFrame = browserPhysics\.referenceFrame\)/);
  assert.match(source, /browserPolicyRuntime\.setMotionClip\(ACTIVE_BROWSER_MOTION_NAME,\s*frameCache\)/);
  assert.match(source, /const currentStatePayload = currentPhysicsStatePayload\(frameCache\.jointNames\)/);
  assert.match(source, /browserPolicyRuntime\.requestMotion\(\s*ACTIVE_BROWSER_MOTION_NAME,\s*currentStatePayload/);
  assert.match(source, /\{\s*startFrame,\s*transitionSteps:\s*browserMotionStartTransitionSteps\(\)\s*\}/);
  assert.match(source, /function resetBrowserPolicyTrackingToDefault\(\)/);

  const playBody = functionBody('playPlayback');
  const pauseBody = functionBody('pausePlayback');

  assert.match(playBody, /switchBrowserPolicyTrackingToActiveClip\(\)/);
  assert.doesNotMatch(playBody, /browserPhysics\.targetMode\s*=\s*'tracking'/);
  assert.match(pauseBody, /pausePhysicsToDefaultStance\(\)/);
});

test('motion start transition is a physics-only user toggle', () => {
  assert.match(source, /id="motionStartTransitionToggle"/);
  assert.match(source, /v-model="motionStartTransitionEnabled"/);
  assert.match(source, /\{\{ t\('motion\.startTransition'\) \}\}/);
  assert.match(source, /\{\{ t\(motionStartTransitionEnabled \? 'motion\.startTransitionOn' : 'motion\.startTransitionOff'\) \}\}/);
  assert.match(source, /BROWSER_MOTION_START_TRANSITION_SECONDS \/ browserPhysics\.controlDt/);

  const playBody = functionBody('playPlayback');
  assert.match(playBody, /if \(session\.value\?\.physics_enabled\) \{[\s\S]*?switchBrowserPolicyTrackingToActiveClip\(\)/);
  assert.match(playBody, /return;[\s\S]*postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'play'\s*\}\)/);
}
);

test('policy target smoothing is a physics policy toggle with adjustable alpha', () => {
  assert.match(source, /id="targetSmoothingToggle"/);
  assert.match(source, /v-model="targetSmoothingEnabled"/);
  assert.match(source, /<label class="target-smoothing-alpha">[\s\S]*<span>\{\{ t\('motion\.targetSmoothingAlpha'\) \}\}<\/span>[\s\S]*<strong class="alpha-value">\{\{ targetSmoothingAlphaDisplay \}\}<\/strong>[\s\S]*id="targetSmoothingAlpha"/);
  assert.match(source, /id="targetSmoothingAlpha"/);
  assert.match(source, /v-model\.number="targetSmoothingAlpha"/);
  assert.match(source, /:style="\{ '--target-smoothing-progress': targetSmoothingAlphaProgress \}"/);
  assert.match(source, /min="0\.01"/);
  assert.match(source, /max="1"/);
  assert.match(source, /step="0\.01"/);
  assert.match(source, /\{\{ targetSmoothingAlphaDisplay \}\}/);
  assert.match(source, /const targetSmoothingAlphaProgress = computed/);
  assert.match(source, /function configureBrowserTargetSmoothing\(\)/);
  assert.match(source, /browserPolicyRuntime\.configureTargetSmoothing/);
});

test('motion start transition does not consume source motion progress', () => {
  const body = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(body, /const trackingState = browserPolicyRuntime\.trackingState\(\)/);
  assert.match(body, /if \(trackingState\.inTransition\) \{[\s\S]*?frameIndex: sourceFrame/);
  assert.match(body, /if \(trackingState\.inTransition\) \{[\s\S]*?transitioning: true/);
  assert.ok(
    body.indexOf('trackingState.inTransition') < body.indexOf('trackingState.currentDone'),
    'transition hold must run before completion handling'
  );
});

test('inactive physics tracking starts transition from default stance, not source motion frame', () => {
  const body = asyncFunctionBody('startBrowserPhysicsLoop');

  assert.match(body, /const startFrame = viewerFrameIndex\.value/);
  assert.doesNotMatch(body, /viewer\.resetPhysics\(resetPayload\)/);
  assert.match(body, /await resetViewerToDefaultStance\(\)[\s\S]*browserPhysics\.targetMode = targetMode/);
  assert.match(body, /browserPhysics\.referenceFrame = startFrame/);
  assert.match(body, /await switchBrowserPolicyTrackingToActiveClip\(startFrame\)/);
});

test('physics playback does not start backend reference playback', () => {
  const playBody = functionBody('playPlayback');

  assert.match(source, /const playbackDisplayState = computed/);
  assert.match(source, /id="playbackBadge" class="status-chip">\{\{ t\('badges\.playback'\) \}\}: \{\{ playbackDisplayState \}\}/);
  assert.match(playBody, /if \(session\.value\?\.physics_enabled\) \{[\s\S]*?startBrowserPhysicsLoop\('tracking'\)[\s\S]*?return;/);
  assert.match(playBody, /return;[\s\S]*postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'play'\s*\}\)/);
  assert.doesNotMatch(playBody.trim(), /^await postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'play'\s*\}\);/);
});

test('physics seek and stop stay inside browser physics instead of driving backend reference playback', () => {
  assert.match(source, /async function stopPlayback\(\)/);
  assert.match(source, /@click="runCommand\(stopPlayback, 'motion\.stopDone'\)"/);
  assert.match(source, /if \(session\.value\?\.physics_enabled\) \{[\s\S]*?browserPhysics\.referenceFrame = boundedFrame;[\s\S]*?return;[\s\S]*?\}\n\s*stopLocalPlaybackLoop\(\);/);
  assert.match(source, /await switchBrowserPolicyTrackingToActiveClip\(boundedFrame\)/);
  assert.match(source, /async function stopPlayback\(\) \{[\s\S]*?if \(session\.value\?\.physics_enabled\) \{[\s\S]*?pausePhysicsToDefaultStance\(\)[\s\S]*?return;[\s\S]*?\}\n\s*await postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'stop'\s*\}\)/);
});

test('policy cards switch policies directly without lifecycle buttons', () => {
  assert.doesNotMatch(source, /id="startPolicyButton"/);
  assert.doesNotMatch(source, /id="stopPolicyButton"/);
  assert.doesNotMatch(source, /id="stepPolicyButton"/);
  assert.doesNotMatch(source, /activateSelectedPolicy/);
  assert.doesNotMatch(source, /stopSelectedPolicy/);
  assert.doesNotMatch(source, /stepSelectedPolicy/);
  assert.match(source, /async function switchSelectedPolicy\(policyId, options = \{\}\)/);
  assert.match(source, /@click="runCommand\(\(\) => switchSelectedPolicy\(policy\.policy_id\), 'policy\.switchDone', policyStatus\)"/);
});

test('policy switching resets stance and physics off only allows mock policy', () => {
  assert.match(source, /const MOCK_BROWSER_POLICY_ID = 'mock_passthrough'/);
  assert.match(source, /function policyDisabled\(policy\)/);
  assert.match(source, /:disabled="policyDisabled\(policy\)"/);
  assert.match(source, /policy\.policy_id !== MOCK_BROWSER_POLICY_ID/);
  assert.match(source, /switchSelectedPolicy\(MOCK_BROWSER_POLICY_ID,\s*\{\s*resetStance:\s*false\s*\}\)/);
  assert.match(source, /await browserPolicyRuntime\.activate\(manifest\)/);
  assert.match(source, /await postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'pause'\s*\}\)/);
  assert.match(source, /await resetViewerToDefaultStance\(\)/);
  assert.match(source, /await startBrowserPhysicsLoop\('default_stance'\)/);
});

test('policy selector uses mock first and folder style ONNX categories', () => {
  assert.match(source, /const selectedPolicyGroupId = ref\('mock'\)/);
  assert.match(source, /const policyGroups = computed/);
  assert.match(source, /const visiblePolicies = computed/);
  assert.match(source, /function selectPolicyGroup\(groupId\)/);
  assert.match(source, /if \(group\.policies\.length === 1 && group\.policies\[0\]\?\.policy_id\) \{[\s\S]*?await switchSelectedPolicy\(group\.policies\[0\]\.policy_id\)[\s\S]*?return;[\s\S]*?\}/);
  assert.match(source, /if \(group\?\.id === 'mock'\) \{[\s\S]*?return \[\];[\s\S]*?\}/);
  assert.match(source, /id="policyGroupList"/);
  assert.match(source, /id="policyModelList"/);
  assert.match(source, /v-for="group in policyGroups"/);
  assert.match(source, /group\.id === 'mock'/);
  assert.match(source, /@click="runCommand\(\(\) => selectPolicyGroup\(group\.id\), 'policy\.groupSelected', policyStatus\)"/);
  assert.match(source, /v-for="policy in visiblePolicies"/);
  assert.match(source, /policyLabel\(policy\)/);
  assert.match(source, /policyDescription\(policy\)/);
});

test('ui language toggle is global and localizes the whole interface', () => {
  assert.match(source, /const uiLanguage = ref\('zh'\)/);
  assert.match(source, /const UI_MESSAGES = Object\.freeze/);
  assert.match(source, /function setUiLanguage\(language\)/);
  assert.match(source, /function t\(key, params = \{\}\)/);
  assert.match(source, /function statusText\(status\)/);
  assert.match(source, /function localizedValue\(value, fallback = ''\)/);
  assert.match(source, /id="languageToggle"/);
  assert.match(source, /<header class="topbar command-bar">[\s\S]*id="languageToggle"/);
  assert.doesNotMatch(source, /<aside class="sidebar right">[\s\S]*id="languageToggle"/);
  assert.match(source, /@click="setUiLanguage\('zh'\)"/);
  assert.match(source, /@click="setUiLanguage\('en'\)"/);
  assert.match(source, /\{\{ t\('data\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('motion\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('trim\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('test\.resetStance'\) \}\}/);
  assert.match(source, /\{\{ t\('diagnostics\.title'\) \}\}/);
  assert.match(source, /:placeholder="t\('data\.pathPlaceholder'\)"/);
  assert.match(source, /statusText\(commandStatus\)/);
  assert.match(source, /setStatus\(treeStatus, 'data\.scanLoading'\)/);
  assert.match(source, /setStatus\(policyStatus, 'policy\.pluginsLoaded'\)/);
  assert.match(source, /policy\.display_name_i18n/);
  assert.match(source, /policy\.description_i18n/);
});

test('top command bar separates status readouts from compact action controls', () => {
  assert.match(source, /<header class="topbar command-bar">/);
  assert.match(source, /<div class="topbar-status-strip" aria-label="Console status">/);
  assert.match(source, /class="status-chip viewer-status-chip"/);
  assert.match(source, /:class="\{ ok: viewerReady \}"/);
  assert.match(source, /class="topbar-toolbar"/);
  const statusStrip = source.match(/<div class="topbar-status-strip" aria-label="Console status">(?<body>[\s\S]*?)<\/div>\s*<div class="topbar-toolbar">/);
  assert.ok(statusStrip, 'missing topbar status strip');
  assert.doesNotMatch(statusStrip.groups.body, /id="policyBadge"/);
  assert.doesNotMatch(source, /id="policyBadge"/);
  assert.match(source, /id="physicsToggleButton"[\s\S]*:class="\['physics-toggle-card', session\?\.physics_enabled \? 'active' : ''\]"/);
  assert.match(source, /id="physicsToggleButton"[\s\S]*<span class="physics-toggle-indicator" aria-hidden="true"><\/span>/);
  assert.match(source, /id="physicsToggleButton"[\s\S]*<strong>\{\{ t\('physics\.label'\) \}\}<\/strong>/);
  assert.match(source, /class="topbar-mode-cluster"/);
  assert.match(source, /id="languageToggle" class="language-toggle"/);
  assert.match(source, /<Languages class="language-icon" aria-hidden="true" \/>/);
  assert.match(source, /id="themeToggleButton"[\s\S]*class="topbar-icon-button theme-toggle-button"/);
  assert.match(source, /id="physicsCompactToggleButton"[\s\S]*class="\['topbar-icon-button', 'physics-compact-toggle', session\?\.physics_enabled \? 'active' : ''\]"/);
  assert.ok(source.indexOf('id="physicsToggleButton"') < source.indexOf('id="languageToggle"'), 'physics card should lead the toolbar');
  assert.ok(source.indexOf('id="themeToggleButton"') < source.indexOf('id="physicsCompactToggleButton"'), 'theme button should sit before the compact physics power button');
  assert.match(source, /id="themeToggleButton"[\s\S]*:aria-pressed="uiTheme === 'light' \? 'true' : 'false'"/);
  assert.match(source, /id="physicsToggleButton"[\s\S]*:aria-pressed="session\?\.physics_enabled \? 'true' : 'false'"/);
  assert.match(source, /id="physicsCompactToggleButton"[\s\S]*:aria-pressed="session\?\.physics_enabled \? 'true' : 'false'"/);
  assert.doesNotMatch(source, /<div class="status-grid">[\s\S]*id="physicsToggleButton"/);
});

test('top mode badge maps dataset mode to motion wording', () => {
  assert.match(source, /const topbarModeLabel = computed/);
  assert.match(source, /if \(mode === 'dataset'\) \{\s*return t\('badges\.modeMotion'\);\s*\}/);
  assert.match(source, /if \(mode === 'policy'\) \{\s*return t\('badges\.modePolicy'\);\s*\}/);
  assert.match(source, /id="modeBadge" class="status-chip">\{\{ t\('badges\.mode'\) \}\}: \{\{ topbarModeLabel \}\}/);
});

test('ui theme toggle switches the whole console between day and night palettes', () => {
  assert.match(source, /const uiTheme = ref\('dark'\)/);
  assert.match(source, /const uiThemeLabel = computed/);
  assert.match(source, /const uiThemeIcon = computed/);
  assert.match(source, /function setUiTheme\(theme\)/);
  assert.match(source, /function toggleUiTheme\(\)/);
  assert.match(source, /function applyUiTheme\(theme = uiTheme\.value\)/);
  assert.match(source, /localStorage\.getItem\('g1-viewer-ui-theme'\)/);
  assert.match(source, /localStorage\.setItem\('g1-viewer-ui-theme'/);
  assert.match(source, /document\.documentElement\.dataset\.theme = resolvedTheme/);
  assert.match(source, /<div class="shell industrial-shell" :data-theme="uiTheme">/);
  assert.match(source, /id="themeToggleButton"/);
  assert.match(source, /@click="toggleUiTheme"/);
  assert.match(source, /<component :is="uiThemeIcon"/);
  assert.match(source, /<span>\{\{ uiThemeLabel \}\}<\/span>/);
  assert.match(source, /app\.themeDay/);
  assert.match(source, /app\.themeNight/);
});

test('industrial console UI uses lucide icons and workbench landmarks', () => {
  assert.match(packageSource, /"lucide-vue-next"/);
  assert.match(source, /from 'lucide-vue-next'/);
  assert.match(source, /<header class="topbar command-bar">/);
  assert.match(source, /<main class="workspace-shell layout industrial-layout">/);
  assert.match(source, /<aside class="left-rail sidebar workflow-rail">/);
  assert.match(source, /<section class="stage-column viewer-column">/);
  assert.match(source, /<aside class="right-rail sidebar right control-rail">/);
  assert.match(source, /class="command-button primary"/);
  assert.match(source, /class="control-icon"/);
  assert.match(source, /<Play\b/);
  assert.match(source, /<Pause\b/);
  assert.match(source, /<Square\b/);
  assert.match(source, /<Power\b/);
  assert.match(source, /<Search\b/);
  assert.match(source, /<Download\b/);
  assert.match(source, /<Languages\b/);
});

test('viewer toolbar owns stance recovery and contact-force visibility controls', () => {
  const toolbarMatch = source.match(/<div class="viewer-toolbar">(?<body>[\s\S]*?)<div class="viewer-frame">/);
  assert.ok(toolbarMatch, 'missing viewer toolbar');
  const toolbar = toolbarMatch.groups.body;

  assert.match(toolbar, /id="resetStanceButton"/);
  assert.match(toolbar, /@click="runCommand\(resetPhysicsToDefaultStance/);
  assert.match(toolbar, /:disabled="!session\?\.physics_enabled"/);
  assert.match(toolbar, /\{\{ t\('test\.resetStance'\) \}\}/);
  assert.match(toolbar, /id="contactForceToggleButton"/);
  assert.match(toolbar, /@click="toggleContactForceMarkers"/);
  assert.match(toolbar, /\{\{ contactForceMarkerLabel \}\}/);
  assert.match(toolbar, /id="cameraPresetSelect"/);
  assert.match(toolbar, /v-model="selectedCameraPreset"/);
  assert.match(toolbar, /@change="applySelectedCameraPreset"/);
  assert.match(toolbar, /v-for="preset in cameraPresetOptions"/);
  assert.match(toolbar, /id="cameraFollowToggleButton"/);
  assert.match(toolbar, /@click="toggleCameraFollow"/);
  assert.match(toolbar, /\{\{ cameraFollowLabel \}\}/);
  assert.doesNotMatch(toolbar, /@click="applyCameraPreset\('front'\)"/);
  assert.doesNotMatch(toolbar, /@click="applyCameraPreset\('side'\)"/);
  assert.doesNotMatch(toolbar, /@click="applyCameraPreset\('top'\)"/);
  assert.doesNotMatch(toolbar, /@click="applyCameraPreset\('follow'\)"/);
  assert.match(source, /const contactForceMarkersEnabled = ref\(true\)/);
  assert.match(source, /const contactForceMarkerLabel = computed/);
  assert.match(source, /const selectedCameraPreset = ref\('default'\)/);
  assert.match(source, /const cameraFollowEnabled = ref\(true\)/);
  assert.match(source, /const cameraFollowLabel = computed/);
  assert.match(source, /const cameraPresetOptions = computed/);
  assert.match(source, /\{ value: 'default', label: t\('evaluation\.cameraDefault'\) \}/);
  assert.match(source, /\{ value: 'back', label: t\('evaluation\.cameraBack'\) \}/);
  assert.doesNotMatch(source, /\{ value: 'follow', label: t\('evaluation\.cameraFollow'\) \}/);
  assert.match(source, /function toggleContactForceMarkers\(\)/);
  assert.match(source, /function toggleCameraFollow\(\)/);
  assert.match(source, /function applySelectedCameraPreset\(\)/);
  assert.match(source, /viewer\?\.setContactMarkersEnabled\?\.\(contactForceMarkersEnabled\.value\)/);
  assert.match(source, /viewer\?\.setCameraFollowEnabled\?\.\(cameraFollowEnabled\.value\)/);
  assert.match(source, /watch\(contactForceMarkersEnabled/);
});

test('test impulse panel is hidden from the main interface', () => {
  assert.doesNotMatch(source, /<section class="panel control-panel">[\s\S]*\{\{ t\('test\.title'\) \}\}[\s\S]*<\/section>/);
  assert.doesNotMatch(source, /id="impulseMagnitudeInput"/);
  assert.doesNotMatch(source, /id="impulseDurationInput"/);
  assert.doesNotMatch(source, /class="impulseButton/);
  assert.doesNotMatch(source, /id="resetTestButton"/);
  assert.doesNotMatch(source, /postJson\('\/api\/viewer\/test\/reset'\)/);
  assert.match(source, /\{\{ t\('diagnostics\.title'\) \}\}/);
});

test('diagnostics are a collapsed debug drawer by default', () => {
  assert.match(source, /<details id="diagnosticsPanel" class="panel diagnostics advanced-panel diagnostics-panel debug-drawer">/);
  assert.match(source, /<summary class="advanced-summary debug-summary">/);
  assert.doesNotMatch(source, /<details id="diagnosticsPanel"[^>]*\sopen/);
  assert.match(source, /class="debug-grid"/);
  assert.match(source, /\{\{ t\('diagnostics\.expand'\) \}\}/);
});

test('workspace is organized as a hero stage with dedicated left and right rails', () => {
  assert.match(source, /<main class="workspace-shell layout industrial-layout">/);
  assert.match(source, /<aside class="left-rail sidebar workflow-rail">/);
  assert.match(source, /<section class="stage-column viewer-column">/);
  assert.match(source, /<aside class="right-rail sidebar right control-rail">/);
  assert.match(source, /<section class="panel viewer-stage-panel">/);
  assert.match(source, /<header class="viewer-stage-header">/);
  assert.match(source, /<section class="panel workflow-card workflow-panel data-browser-card">/);
  assert.match(source, /<section class="panel workflow-card workflow-panel motion-workflow-card">/);
  assert.match(source, /<section class="panel workflow-card workflow-panel trim-export-card">/);
  assert.match(source, /<section class="panel control-card control-panel policy-control-card">/);
  assert.match(source, /<section id="evaluationPanel" class="panel control-card control-panel evaluation-panel evaluation-control-card">/);
});

test('viewer header promotes live motion context and high-frequency controls', () => {
  assert.match(source, /<p class="eyebrow stage-eyebrow">\{\{ t\('viewer\.eyebrow'\) \}\}<\/p>/);
  assert.match(source, /<p class="stage-motion-name">\{\{ activeSequence\?\.name \|\| t\('viewer\.noMotionTitle'\) \}\}<\/p>/);
  assert.doesNotMatch(source, /class="stage-meta-strip"/);
  assert.doesNotMatch(source, /class="stage-meta-chip"/);
  assert.doesNotMatch(source, /class="stage-policy-chip"/);
  assert.doesNotMatch(source, /class="stage-runtime-copy"/);
  assert.match(source, /id="cameraPresetSelect"/);
  assert.match(source, /id="cameraFollowToggleButton"/);
  assert.match(source, /id="resetStanceButton"/);
  assert.match(source, /id="contactForceToggleButton"/);
  assert.match(source, /id="globalReferenceOverlayToggle"/);
  assert.match(source, /id="relativeReferenceOverlayToggle"/);
});

test('recording utilities are fully visible inside the evaluation panel', () => {
  assert.doesNotMatch(source, /<details class="panel advanced-panel evaluation-advanced-panel">/);
  assert.match(source, /class="recording-panel"/);
  assert.match(source, /class="panel-title recording-panel-title"/);
  assert.match(source, /\{\{ t\('evaluation\.advancedTitle'\) \}\}/);
  assert.match(source, /<div class="recording-section">/);
  assert.match(source, /<details id="diagnosticsPanel" class="panel diagnostics advanced-panel diagnostics-panel debug-drawer">/);
  assert.match(source, /<div class="debug-grid">/);
  assert.doesNotMatch(source, /class="comparison-block"/);
});

test('topbar removes the policy chip and promotes physics as the primary quick control', () => {
  assert.doesNotMatch(source, /id="policyBadge"/);
  assert.doesNotMatch(source, /class="toolbar-policy-chip/);
  assert.match(source, /id="physicsCompactToggleButton"/);
  assert.match(source, /id="physicsToggleButton"/);
  assert.match(source, /<strong>\{\{ t\('physics\.label'\) \}\}<\/strong>/);
});

test('session refresh does not override local browser physics target mode', () => {
  const startBody = source.match(/function startLocalPlayback\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const syncBody = source.match(/function syncViewerFromSession\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(source, /targetMode: 'default_stance'/);
  assert.match(startBody, /startBrowserPhysicsLoop\(browserPhysics\.targetMode\)/);
  assert.match(syncBody, /startBrowserPhysicsLoop\(browserPhysics\.targetMode\)/);
  assert.doesNotMatch(startBody, /session\.value\?\.playback_state === 'playing' \? 'tracking' : 'default_stance'/);
  assert.doesNotMatch(syncBody, /session\.value\?\.playback_state === 'playing' \? 'tracking' : 'default_stance'/);
});

test('physics progress only loops when policy tracking is restarted', () => {
  assert.match(source, /function advanceBrowserPhysicsReferenceFrame\(\)/);
  assert.match(source, /function advanceBrowserPhysicsSourceFrame\(\)/);
  assert.match(source, /browserPolicyRuntime\.trackingState\(\)/);
  assert.match(source, /trackingState\.currentDone/);
  assert.match(source, /trackingState\.sourceFrame/);
  assert.match(source, /if \(!trackingState\?\.available\) \{[\s\S]*?return advanceBrowserPhysicsSourceFrame\(\)/);
  assert.match(source, /const referenceFrame = advanceBrowserPhysicsReferenceFrame\(\)/);
  assert.match(source, /if \(referenceFrame\.looped\) \{[\s\S]*?await switchBrowserPolicyTrackingToActiveClip\(referenceFrame\.frameIndex\)/);
  assert.match(source, /target = await inferBrowserPhysicsTarget\(referenceFrame\.frameIndex,\s*referencePayload\)/);
});

test('physics completion holds the final active target before default stance', () => {
  assert.match(source, /const BROWSER_PHYSICS_END_HOLD_SECONDS = 0\.6/);
  assert.match(source, /function browserPhysicsEndHoldSteps\(\)/);
  assert.match(source, /return Math\.ceil\(BROWSER_PHYSICS_END_HOLD_SECONDS \/ browserPhysics\.controlDt\)/);
  assert.match(source, /endHoldStepsRemaining: 0/);
  assert.match(source, /endHoldActive: false/);
  const advanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(advanceBody, /trackingState\.currentDone/);
  assert.match(advanceBody, /if \(!browserPhysics\.endHoldActive\) \{/);
  assert.match(advanceBody, /browserPhysics\.endHoldActive = true/);
  assert.match(advanceBody, /browserPhysics\.endHoldActive = false/);
  assert.match(advanceBody, /frameIndex: sourceFrame, looped: false, ended: false, holdingEnd: true/);
  assert.match(loopBody, /if \(referenceFrame\.ended\) \{[\s\S]*?resetBrowserPolicyTrackingToDefault\(\)/);
  assert.match(loopBody, /else \{[\s\S]*?referencePayload = currentTrackingReferencePayload\(\) \|\| framePayloadForIndex\(referenceFrame\.frameIndex\)/);
});

test('static active clip tails leave tracking without running the active policy until clip end', () => {
  const advanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(advanceBody, /trackingState\.staticTail/);
  assert.ok(
    advanceBody.indexOf('trackingState.staticTail') < advanceBody.indexOf('trackingState.currentDone'),
    'static tail handling must run before normal completion hold'
  );
  assert.match(advanceBody, /staticTail: true/);
  assert.match(loopBody, /if \(referenceFrame\.ended\) \{[\s\S]*?resetBrowserPolicyTrackingToDefault\(\)/);
});

test('default stance recovery resets browser policy state from the live robot state', () => {
  const resetBody = source.match(/function resetBrowserPolicyTrackingToDefault\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(resetBody, /const currentStatePayload = currentPhysicsStatePayload\(frameCache\.jointNames\)/);
  assert.match(resetBody, /browserPolicyRuntime\.reset\(currentStatePayload\)/);
  assert.match(resetBody, /browserPolicyRuntime\.requestMotion\('default', currentStatePayload\)/);
});

test('completed non-loop playback resets progress to the first frame', () => {
  const physicsAdvanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const localPlaybackBody = source.match(/function localPlaybackStep\(timestamp\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(physicsAdvanceBody, /browserPhysics\.endHoldStepsRemaining = 0/);
  assert.match(physicsAdvanceBody, /browserPhysics\.endHoldActive = false/);
  assert.match(physicsAdvanceBody, /browserPhysics\.referenceFrameFloat = 0/);
  assert.match(physicsAdvanceBody, /browserPhysics\.referenceFrame = 0/);
  assert.match(physicsAdvanceBody, /return \{ frameIndex: 0, looped: false, ended: true \}/);
  assert.match(localPlaybackBody, /nextFrame = 0/);
  assert.match(localPlaybackBody, /localPlayback\.active = false/);
});

test('motion browser renders lazy directory results with relative path labels', () => {
  assert.match(source, /function flattenBrowserNodes\(nodes, depth = 0\)/);
  assert.match(source, /const visibleTreeNodes = computed\(\(\) => flattenBrowserNodes\(treeNodes\.value\)\)/);
  assert.match(source, /v-for="entry in visibleTreeNodes"/);
  assert.match(source, /browserNodeDisplayName\(entry\.node\)/);
  assert.match(source, /browserNodeParentPath\(entry\.node\)/);
  assert.match(source, /:title="entry\.node\.relative_path \|\| entry\.node\.name"/);
  assert.match(source, /:style="\{ '--tree-depth': entry\.depth \}"/);

  const handleBody = source.match(/async function handleTreeNode\(node\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  assert.match(handleBody, /if \(node\.node_type === 'directory'\) \{[\s\S]*?await scanTreeAt\(node\.path\)[\s\S]*?return;/);
  assert.match(handleBody, /if \(node\.node_type !== 'motion'\) \{\s*return;\s*\}/);
});

test('motion browser pages large directories and appends load-more results', () => {
  assert.match(source, /const BROWSER_PAGE_SIZE = \d+/);
  assert.match(source, /const browserTotalCount = ref\(0\)/);
  assert.match(source, /const browserOffset = ref\(0\)/);
  assert.match(source, /const browserHasMore = computed\(\(\) => treeNodes\.value\.length < browserTotalCount\.value\)/);
  assert.match(source, /id="browserLoadMoreButton"/);
  assert.match(source, /v-if="browserHasMore"/);
  assert.match(source, /@click="loadMoreBrowserNodes"/);

  const scanBody = asyncFunctionBody('scanTreeAt');
  assert.match(scanBody, /offset:\s*0/);
  assert.match(scanBody, /limit:\s*BROWSER_PAGE_SIZE/);
  assert.match(scanBody, /treeNodes\.value = payload\.nodes/);
  assert.match(scanBody, /browserTotalCount\.value = payload\.total_count \?\? payload\.nodes\.length/);
  assert.match(scanBody, /browserOffset\.value = payload\.offset \+ payload\.nodes\.length/);

  const loadMoreBody = asyncFunctionBody('loadMoreBrowserNodes');
  assert.match(loadMoreBody, /path:\s*browserRoot\.value/);
  assert.match(loadMoreBody, /offset:\s*browserOffset\.value/);
  assert.match(loadMoreBody, /limit:\s*BROWSER_PAGE_SIZE/);
  assert.match(loadMoreBody, /treeNodes\.value = \[\.\.\.treeNodes\.value,\s*\.\.\.payload\.nodes\]/);
  assert.match(loadMoreBody, /browserOffset\.value = payload\.offset \+ payload\.nodes\.length/);
});

test('motion browser exposes parent navigation for lazy folder browsing', () => {
  assert.match(source, /const DEFAULT_DATASET_ROOT = '\/home\/huanghao\/source\/datasets\/gmr_retarget_x\/AMASS_numpy123'/);
  assert.match(source, /const pathInput = ref\(DEFAULT_DATASET_ROOT\)/);
  assert.match(source, /const browserRoot = ref\(''\)/);
  assert.match(source, /const browserParent = ref\(null\)/);
  assert.match(source, /id="browserUpButton"/);
  assert.match(source, /:disabled="!browserParent"/);
  assert.match(source, /@click="goToParentDirectory"/);
  assert.match(source, /function browserRootDisplayName\(\)/);
  assert.match(source, /async function scanTreeAt\(path\)/);
  assert.match(source, /browserRoot\.value = payload\.root/);
  assert.match(source, /browserParent\.value = payload\.parent \|\| null/);

  const upBody = functionBody('goToParentDirectory');
  assert.match(upBody, /if \(!browserParent\.value\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(upBody, /await scanTreeAt\(browserParent\.value\)/);
});

test('motion switching preserves active browser physics and returns to default stance', () => {
  const handleBody = source.match(/async function handleTreeNode\(node\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(source, /switchingMotion: false/);
  assert.match(handleBody, /const wasPhysicsEnabled = Boolean\(session\.value\?\.physics_enabled\)/);
  assert.match(handleBody, /browserPhysics\.switchingMotion = wasPhysicsEnabled/);
  assert.match(handleBody, /if \(!wasPhysicsEnabled\) \{[\s\S]*?stopBrowserPhysicsLoop\(\)[\s\S]*?\}/);
  assert.match(handleBody, /else \{[\s\S]*?stopBrowserPhysicsLoop\(\)[\s\S]*?browserPhysics\.targetMode = 'default_stance'[\s\S]*?resetBrowserPolicyTrackingToDefault\(\)[\s\S]*?\}/);
  assert.doesNotMatch(handleBody, /stopBrowserPhysicsLoop\(\);\s*\n\s*await runCommand/);
  assert.match(handleBody, /await postJson\('\/api\/session\/load',\s*\{\s*path: node\.path,\s*format: node\.format\s*\}\)/);
  assert.match(handleBody, /if \(wasPhysicsEnabled\) \{[\s\S]*?await resetViewerToDefaultStance\(\)[\s\S]*?await startBrowserPhysicsLoop\('default_stance'\)[\s\S]*?\}/);
  assert.match(handleBody, /finally \{[\s\S]*?browserPhysics\.switchingMotion = false[\s\S]*?\}/);
  assert.match(source, /if \(session\.value\?\.physics_enabled\) \{[\s\S]*?if \(browserPhysics\.switchingMotion\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?startBrowserPhysicsLoop/);
});

test('motion browser shortens long relative paths without losing tooltip detail', () => {
  assert.match(source, /function browserNodeDisplayName\(node\)/);
  assert.match(source, /function browserNodeParentPath\(node\)/);
  assert.match(source, /const parts = label\.split\('\/'\)/);
  assert.match(source, /return parts\.at\(-1\) \|\| label/);
  assert.match(source, /return parts\.slice\(0, -1\)\.join\('\/'\)/);
});

test('trim export UI lets users choose format, twist2 extension, output directory, and output name', () => {
  assert.match(source, /id="exportFormatSelect"/);
  assert.match(source, /v-model="exportFormat"/);
  assert.match(source, /<option value="motion_tracking_npz">motion_tracking_npz<\/option>/);
  assert.match(source, /<option value="holomotion_npz">holomotion_npz<\/option>/);
  assert.match(source, /<option value="kimodo_csv">kimodo_csv<\/option>/);
  assert.match(source, /id="twist2ExtensionSelect"/);
  assert.match(source, /v-model="twist2Extension"/);
  assert.match(source, /id="exportOutputDirInput"/);
  assert.match(source, /v-model="exportOutputDir"/);
  assert.match(source, /id="exportOutputNameInput"/);
  assert.match(source, /v-model="exportOutputName"/);

  const exportBody = functionBody('exportTrim');
  assert.match(exportBody, /export_format:\s*exportFormat\.value/);
  assert.match(exportBody, /output_dir:\s*exportOutputDir\.value\.trim\(\) \|\| null/);
  assert.match(exportBody, /output_name:\s*exportOutputName\.value\.trim\(\) \|\| null/);
  assert.match(exportBody, /twist2_extension:\s*exportFormat\.value === 'twist2' \? twist2Extension\.value : null/);
});

test('trim export success shows a dismissible toast with the output path', () => {
  assert.match(source, /id="exportToast"/);
  assert.match(source, /role="status"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /exportToast\.visible/);
  assert.match(source, /exportToast\.path/);
  assert.match(source, /id="exportToastClose"/);
  assert.match(source, /@click="dismissExportToast"/);
  assert.match(source, /function showExportToast\(path\)/);
  assert.match(source, /function dismissExportToast\(\)/);
  assert.match(source, /window\.setTimeout\(dismissExportToast,\s*4000\)/);
  assert.match(source, /window\.clearTimeout\(exportToastTimer\)/);
  assert.match(source, /t\('trim\.exportSuccess'\)/);

  const exportBody = functionBody('exportTrim');
  assert.match(exportBody, /showExportToast\(payload\.output_path\)/);
});

test('trim frame inputs keep local edits until committed', () => {
  assert.match(source, /@focus="beginTrimFrameEdit\('start'\)"/);
  assert.match(source, /@keyup\.enter="commitTrimStart"/);
  assert.match(source, /@blur="commitTrimStart"/);
  assert.match(source, /@focus="beginTrimFrameEdit\('end'\)"/);
  assert.match(source, /@keyup\.enter="commitTrimEnd"/);
  assert.match(source, /@blur="commitTrimEnd"/);

  const syncBody = source.match(/function syncInputsFromSession\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  assert.match(syncBody, /if \(!editingTrimStart\.value\) \{[\s\S]*?trimStartInput\.value = session\.value\.trim_start/);
  assert.match(syncBody, /if \(!editingTrimEnd\.value\) \{[\s\S]*?trimEndInput\.value = session\.value\.trim_end/);

  const startBody = functionBody('commitTrimStart');
  assert.match(startBody, /editingTrimStart\.value = false/);
  assert.match(startBody, /setTrimStart\(\)/);

  const endBody = functionBody('commitTrimEnd');
  assert.match(endBody, /editingTrimEnd\.value = false/);
  assert.match(endBody, /setTrimEnd\(\)/);
});

test('timeline slider exposes live progress as a CSS variable for the custom track fill', () => {
  assert.match(source, /id="timeline"/);
  assert.match(source, /:style="\{\s*'--timeline-progress': timelineProgress\s*\}"/);
  assert.match(source, /const timelineProgress = computed\(\(\) =>/);
  assert.match(source, /const max = Math\.max\(1,\s*maxFrame\.value\)/);
  assert.match(source, /const ratio = Math\.min\(1,\s*Math\.max\(0,\s*viewerFrameIndex\.value \/ max\)\)/);
  assert.match(source, /return `\$\{Math\.round\(ratio \* 100\)\}%`/);
});

test('motion workflow is promoted ahead of trim export in the left rail', () => {
  const leftRailMatch = source.match(/<aside class="left-rail sidebar workflow-rail">(?<body>[\s\S]*?)<\/aside>/);
  assert.ok(leftRailMatch, 'missing left rail');
  const body = leftRailMatch.groups.body;

  assert.ok(body.indexOf('motion-workflow-card') < body.indexOf('trim-export-card'), 'motion workflow should appear before trim/export');
  assert.match(source, /id="motionStartTransitionToggle" class="toggle-row motion-start-transition-toggle"/);
  assert.match(source, /class="target-smoothing-control target-smoothing-panel"/);
});

test('motion transition and smoothing controls use reference toggle color treatment', () => {
  const transitionBlock = cssBlock('\\.motion-start-transition-toggle', '.motion-start-transition-toggle');
  const transitionLabelBlock = cssBlock('\\.motion-start-transition-toggle \\.toggle-copy strong', '.motion-start-transition-toggle label');
  const smoothingBlock = cssBlock('\\.target-smoothing-panel', '.target-smoothing-panel');
  const smoothingLabelBlock = cssBlock('\\.target-smoothing-panel \\.toggle-copy strong,\\s*\\.target-smoothing-alpha \\.alpha-value', '.target-smoothing-panel label');

  assert.match(transitionBlock, /border-color:\s*color-mix\(in srgb,\s*var\(--accent-2\)\s*36%,\s*var\(--line\)\s*64%\)/);
  assert.match(transitionBlock, /background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s*88%,\s*var\(--accent-2\)\s*12%\)/);
  assert.match(transitionLabelBlock, /color:\s*color-mix\(in srgb,\s*var\(--accent-2\)\s*78%,\s*var\(--ink\)\s*22%\)/);
  assert.match(smoothingBlock, /border-color:\s*color-mix\(in srgb,\s*var\(--amber\)\s*40%,\s*var\(--line\)\s*60%\)/);
  assert.match(smoothingBlock, /background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s*88%,\s*var\(--amber\)\s*12%\)/);
  assert.match(smoothingLabelBlock, /color:\s*var\(--amber\)/);
  assert.doesNotMatch(transitionBlock, /linear-gradient/);
  assert.doesNotMatch(smoothingBlock, /linear-gradient/);
});

test('evaluation panel stacks reference toggles above A\\/B comparison and recording', () => {
  const evaluationPanelMatch = source.match(/<section id="evaluationPanel"(?<body>[\s\S]*?)<\/section>\s*<details id="diagnosticsPanel"/);
  assert.ok(evaluationPanelMatch, 'missing evaluation panel');
  const body = evaluationPanelMatch.groups.body;

  assert.match(body, /class="reference-overlay-stack"/);
  assert.match(body, /id="globalReferenceOverlayToggle"/);
  assert.match(body, /id="relativeReferenceOverlayToggle"/);
  assert.match(body, /<div class="comparison-section primary-comparison-section">/);
  assert.match(body, /id="comparisonPolicyA"/);
  assert.match(body, /id="comparisonPolicyB"/);
  assert.match(body, /id="runComparisonButton"/);
  assert.match(body, /class="comparison-results inline-comparison-results"/);
  assert.match(body, /class="recording-panel"/);
  assert.match(body, /class="recording-section"/);
  assert.ok(body.indexOf('id="globalReferenceOverlayToggle"') < body.indexOf('id="comparisonPolicyA"'), 'reference toggles should appear before A/B comparison');
  assert.ok(body.indexOf('id="comparisonPolicyA"') < body.indexOf('id="recordingFileNameInput"'), 'A/B comparison should appear before recording controls');
});

test('evaluation workbench imports telemetry helpers and exposes tracking metrics', () => {
  assert.match(source, /from '\.\/simulation\/evaluationMetrics\.js'/);
  assert.match(source, /trackingTelemetrySample/);
  assert.match(source, /evaluateMotionStartDifficulty/);
  assert.match(source, /createEvaluationRun/);
  assert.match(source, /recordEvaluationSample/);
  assert.match(source, /summarizeEvaluationRun/);
  assert.match(source, /const evaluationTelemetry = reactive/);
  assert.match(source, /id="evaluationPanel"/);
  assert.match(source, /\{\{ t\('evaluation\.title'\) \}\}/);
  assert.match(source, /trackingMetricEntries/);
  assert.match(source, /contactMetricEntries/);
  assert.match(source, /motionStartDifficultyDisplay/);
});

test('browser physics loop records tracking telemetry after MuJoCo stepping', () => {
  assert.match(source, /function recordTrackingTelemetry/);
  assert.match(source, /function telemetryReferencePayload/);
  assert.match(source, /viewer\?\.readContactSummary\?\.\(\)/);
  assert.match(source, /trackingTelemetrySample\(\{/);
  assert.match(source, /reference:\s*telemetryReferencePayload\(referencePayload,\s*currentState\)/);
  assert.match(source, /recordEvaluationSample\(evaluationTelemetry\.activeRun,\s*sample\)/);
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(loopBody, /let referencePayload = null/);
  assert.match(loopBody, /referencePayload = defaultStanceFramePayload\(\)/);
  assert.match(loopBody, /referencePayload = currentTrackingReferencePayload\(\) \|\| framePayloadForIndex\(referenceFrame\.frameIndex\)/);
  assert.match(loopBody, /const steppedState = viewer\.stepPhysics\(/);
  assert.match(loopBody, /recordTrackingTelemetry\(\{\s*frameIndex: viewerFrameIndex\.value/);
});

test('global and relative reference pose overlays have separate root anchoring behavior', () => {
  assert.match(source, /const globalReferenceOverlayEnabled = ref\(false\)/);
  assert.match(source, /const relativeReferenceOverlayEnabled = ref\(false\)/);
  assert.match(source, /id="globalReferenceOverlayToggle"/);
  assert.match(source, /id="relativeReferenceOverlayToggle"/);
  assert.match(source, /v-model="globalReferenceOverlayEnabled"/);
  assert.match(source, /v-model="relativeReferenceOverlayEnabled"/);
  assert.match(source, /\{\{ t\('evaluation\.globalReferenceOverlay'\) \}\}/);
  assert.match(source, /\{\{ t\('evaluation\.relativeReferenceOverlay'\) \}\}/);
  assert.doesNotMatch(source, /class="stage-toggle-strip"/);
  const evaluationPanelMatch = source.match(/<section id="evaluationPanel"(?<body>[\s\S]*?)<\/section>\s*<details id="diagnosticsPanel"/);
  assert.ok(evaluationPanelMatch, 'missing evaluation panel');
  assert.match(evaluationPanelMatch.groups.body, /id="globalReferenceOverlayToggle"/);
  assert.match(evaluationPanelMatch.groups.body, /id="relativeReferenceOverlayToggle"/);
  assert.match(evaluationPanelMatch.groups.body, /class="reference-overlay-stack"/);
  assert.match(source, /const globalReferenceAnchor = reactive/);
  assert.match(source, /function scheduleGlobalReferenceRootSync/);
  assert.match(source, /function globalReferencePayloadSource\(referencePayload = null\)/);
  assert.match(source, /framePayloadForIndex\(sourceFrame\)/);
  const globalSourceBody = source.match(/function globalReferencePayloadSource\(referencePayload = null\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  assert.doesNotMatch(globalSourceBody, /sequence_id === 'default_stance'/);
  assert.match(globalSourceBody, /const sourceFrameCandidate = Number\(referencePayload\.frame_index \?\? viewerFrameIndex\.value\)/);
  assert.match(globalSourceBody, /return framePayloadForIndex\(sourceFrame\) \|\| referencePayload/);
  assert.match(source, /function calibrateGlobalReferenceMotion\(startFrame = 0,\s*currentStatePayload = null\)/);
  assert.match(source, /const sourcePayload = framePayloadForIndex\(sourceFrame\)/);
  assert.match(source, /return updateGlobalReferenceAnchor\(sourcePayload,\s*anchorStatePayload\)/);
  assert.match(source, /function makeGlobalAnchoredReferencePayload/);
  assert.match(source, /function makeGlobalReferencePayload\(referencePayload = null,\s*currentStatePayload = null\)/);
  assert.match(source, /function makeRelativeReferencePayload\(referencePayload = null,\s*currentStatePayload = null\)/);
  assert.match(source, /const globalSourcePayload = globalReferencePayloadSource\(referencePayload\)/);
  assert.match(source, /makeGlobalReferencePayload\(globalSourcePayload,\s*currentStatePayload\)/);
  assert.match(source, /quatMultiply\(yawComponent\(currentQuat\),\s*quatInverse\(yawComponent\(referenceQuat\)\)\)/);
  assert.match(source, /globalReferenceAnchor\.yaw_delta_wxyz/);
  assert.match(source, /rotateXyByYawDelta/);
  assert.match(source, /Number\(anchorRoot\[2\] \?\? 0\.78\) \+ \(Number\(sourceRoot\[2\] \?\? referenceRoot\[2\] \?\? 0\.78\) - Number\(referenceRoot\[2\] \?\? 0\.78\)\)/);
  assert.doesNotMatch(source, /globalReferenceAnchor\.rotation_delta_wxyz/);
  assert.match(source, /function syncReferenceOverlays\(referencePayload = null\)/);
  assert.match(source, /viewer\?\.setReferenceOverlayEnabled\?\.\(globalEnabled,\s*'global'\)/);
  assert.match(source, /viewer\?\.setReferenceOverlayEnabled\?\.\(relativeEnabled,\s*'relative'\)/);
  assert.match(source, /viewer\?\.updateReferenceOverlay\?\.\(globalPayload,\s*'global'\)/);
  assert.match(source, /viewer\?\.updateReferenceOverlay\?\.\(relativePayload,\s*'relative'\)/);
  assert.match(source, /scheduleGlobalReferenceRootSync\('motion_start'\)/);
  assert.match(source, /calibrateGlobalReferenceMotion\(0,\s*currentStatePayload\)/);
  assert.match(source, /calibrateGlobalReferenceMotion\(sourceFrame,\s*currentStatePayload\)/);
  const globalOverlayWatch = source.match(/watch\(globalReferenceOverlayEnabled,\s*\(enabled\) => \{(?<body>[\s\S]*?)\n\}\);/).groups.body;
  assert.doesNotMatch(globalOverlayWatch, /scheduleGlobalReferenceRootSync/);
  assert.match(source, /function currentTrackingReferencePayload\(\)/);
  assert.match(source, /browserPolicyRuntime\.currentTrackingReferencePayload\(\{\s*body_names:\s*frameCache\.bodyNames\s*\}\)/);
  assert.match(source, /referencePayload = currentTrackingReferencePayload\(\) \|\| framePayloadForIndex\(referenceFrame\.frameIndex\)/);

  const stopBody = source.match(/function stopBrowserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  assert.match(stopBody, /viewer\?\.setReferenceOverlayEnabled\?\.\(false,\s*'global'\)/);
  assert.match(stopBody, /viewer\?\.setReferenceOverlayEnabled\?\.\(false,\s*'relative'\)/);

  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  assert.match(loopBody, /syncReferenceOverlays\(referencePayload\)/);
  assert.ok(
    loopBody.indexOf('syncReferenceOverlays(referencePayload)') < loopBody.indexOf('const steppedState = viewer.stepPhysics'),
    'reference overlays should be updated from the reference payload before visible physics stepping'
  );
});

test('physics reference progress follows policy tracking state instead of source fps', () => {
  const advanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(source, /function syncPhysicsProgressFromReference\(referencePayload = null\)/);
  assert.match(source, /viewerFrameIndex\.value = frameIndex/);
  assert.match(source, /frameInput\.value = frameIndex/);
  assert.match(advanceBody, /const trackingState = browserPolicyRuntime\.trackingState\(\)/);
  assert.match(advanceBody, /trackingState\.refIdx - trackingState\.transitionLen/);
  assert.doesNotMatch(advanceBody, /activeSequence\.value\.fps/);
  assert.doesNotMatch(advanceBody, /fps \* browserPhysics\.controlDt/);
  assert.match(loopBody, /await inferBrowserPhysicsTarget\(referenceFrame\.frameIndex,\s*referencePayload\)/);
  assert.match(loopBody, /syncPhysicsProgressFromReference\(referencePayload\)/);
});

test('default stance telemetry anchors root xy to the live base instead of world origin', () => {
  const body = source.match(/function telemetryReferencePayload\([^)]*\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(body, /browserPhysics\.targetMode !== 'default_stance'/);
  assert.match(body, /currentState\?\.root_translation/);
  assert.match(body, /root_translation:\s*\[\s*currentState\.root_translation\[0\]/);
  assert.match(body, /referencePayload\.state\.root_translation\?\.\[2\]/);
});

test('motion start difficulty is recomputed from active policy default stance and first frame', () => {
  assert.match(source, /function updateMotionStartDifficulty\(\)/);
  assert.match(source, /browserPolicyRuntime\.defaultStance\(\)/);
  assert.match(source, /evaluateMotionStartDifficulty\(\{/);
  assert.match(source, /defaultJointPositions:\s*defaultTarget\?\.joint_positions/);
  assert.match(source, /firstFrame:\s*frameCache\.frames\[0\]/);
  assert.match(source, /updateMotionStartDifficulty\(\)/);
});

test('evaluation workbench exposes camera preset and named MP4 recording controls', () => {
  assert.match(source, /id="cameraPresetSelect"/);
  assert.match(source, /id="cameraFollowToggleButton"/);
  assert.match(source, /const cameraPresetOptions = computed/);
  assert.match(source, /function applySelectedCameraPreset\(\)/);
  assert.match(source, /function toggleCameraFollow\(\)/);
  assert.match(source, /function applyCameraPreset\(preset\)/);
  assert.match(source, /viewer\?\.applyCameraPreset\?\.\(preset\)/);
  assert.match(source, /id="recordingStartButton"/);
  assert.match(source, /id="recordingStopButton"/);
  assert.match(source, /id="recordingFileNameInput"/);
  assert.match(source, /v-model="recordingFileName"/);
  assert.match(source, /recordingDownloadName/);
  assert.match(source, /function startViewerRecording\(\)/);
  assert.match(source, /function stopViewerRecording\(\)/);
  assert.match(source, /viewer\?\.startRecording\?\.\(\{\s*fps:\s*30,\s*mimeType:\s*'video\/mp4'\s*\}\)/);
  assert.match(source, /viewer\?\.stopRecording\?\.\(\)/);
  assert.match(source, /download="recordingDownloadName"/);
});

test('evaluation A/B comparison runs two policies from reset stance and summarizes runs', () => {
  assert.match(source, /async function runPolicyComparison\(\)/);
  assert.match(source, /async function runPolicyEvaluation\(policyId\)/);
  assert.match(source, /const comparisonPolicyA = ref/);
  assert.match(source, /const comparisonPolicyB = ref/);
  assert.match(source, /id="comparisonPolicyA"/);
  assert.match(source, /id="comparisonPolicyB"/);
  assert.match(source, /id="runComparisonButton"/);
  assert.match(source, /createEvaluationPolicyRuntime\(policyId\)/);
  assert.match(source, /viewer\?\.createEvaluationSimulation\?\.\(\)/);
  assert.match(source, /createEvaluationRun\(\{/);
  assert.match(source, /summarizeEvaluationRun\(run\)/);
  assert.match(source, /evaluationTelemetry\.comparisonResults/);
});

test('evaluation A/B comparison runs in the background without driving the visible MuJoCo viewer', () => {
  const evaluationBody = source.match(/async function runPolicyEvaluation\(policyId\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(evaluationBody, /const evaluationRuntime = await createEvaluationPolicyRuntime\(policyId\)/);
  assert.match(evaluationBody, /const evaluationSimulation = viewer\?\.createEvaluationSimulation\?\.\(\)/);
  assert.match(evaluationBody, /evaluationSimulation\.stepPhysics\(/);
  assert.match(evaluationBody, /evaluationSimulation\.resetPhysics\(/);
  assert.doesNotMatch(evaluationBody, /switchSelectedPolicy\(policyId/);
  assert.doesNotMatch(evaluationBody, /resetViewerToDefaultStance\(\)/);
  assert.doesNotMatch(evaluationBody, /viewer\?\.stepPhysics/);
  assert.doesNotMatch(evaluationBody, /viewerFrameIndex\.value\s*=\s*frameIndex/);
  assert.doesNotMatch(evaluationBody, /frameInput\.value\s*=\s*frameIndex/);
});
