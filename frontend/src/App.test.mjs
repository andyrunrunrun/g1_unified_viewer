import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf-8');
const viteConfigSource = readFileSync(new URL('../vite.config.mjs', import.meta.url), 'utf-8');

function functionBody(name) {
  const match = source.match(new RegExp(`async function ${name}\\(\\) \\{(?<body>[\\s\\S]*?)\\n\\}`));
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
  assert.match(source, /class="test-actions"/);
  assert.match(source, /id="resetStanceButton"/);
  assert.match(source, /\{\{ t\('test\.resetStance'\) \}\}/);
  assert.match(source, /@click="runCommand\(resetPhysicsToDefaultStance/);
  assert.match(source, /:disabled="!session\?\.physics_enabled \|\| !activeSequence"/);
  assert.match(source, /async function resetPhysicsToDefaultStance\(\)/);
  const body = functionBody('resetPhysicsToDefaultStance');

  assert.match(body, /session\.value\?\.physics_enabled/);
  assert.match(body, /resetViewerToDefaultStance\(\)/);
  assert.match(body, /startBrowserPhysicsLoop\('default_stance'\)/);
  assert.doesNotMatch(body, /postJson\('\/api\/session\/playback'/);
});

test('test state reset is visually separated from stance recovery', () => {
  assert.match(source, /class="test-maintenance"/);
  assert.match(source, /id="resetTestButton"/);
  assert.match(source, /\{\{ t\('test\.clear'\) \}\}/);
  assert.match(source, /'test\.clearDone'/);
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
  assert.match(source, /inferBrowserPhysicsTarget\(frameIndex,\s*defaultStanceFramePayload\(\)\)/);
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.doesNotMatch(loopBody, /target = browserPolicyRuntime\.defaultStance\(\)/);
  assert.doesNotMatch(loopBody, /browserPolicyState\.value = browserPolicyRuntime\.status\(\);\s*\n\s*\}\s*else/);
});

test('browser physics policy input uses live MuJoCo state as observation', () => {
  assert.match(source, /function currentPhysicsStatePayload/);
  const match = source.match(/async function inferBrowserPhysicsTarget\([^)]*\) \{(?<body>[\s\S]*?)\n\}/);
  assert.ok(match, 'missing inferBrowserPhysicsTarget()');
  const body = match.groups.body;

  assert.match(body, /current_state:\s*currentPhysicsStatePayload\(payload\.joint_names\)/);
  assert.match(source, /viewer\?\.readState\(jointNames\)/);
});

test('playback selects the active clip as ONNX tracking target while pause selects default', () => {
  assert.match(source, /const ACTIVE_BROWSER_MOTION_NAME = 'active_clip'/);
  assert.match(source, /const ACTIVE_BROWSER_MOTION_TRANSITION_STEPS = 0/);
  assert.match(source, /async function prepareBrowserTrackingMotion\(\)/);
  assert.match(source, /async function switchBrowserPolicyTrackingToActiveClip\(startFrame = browserPhysics\.referenceFrame\)/);
  assert.match(source, /browserPolicyRuntime\.setMotionClip\(ACTIVE_BROWSER_MOTION_NAME,\s*frameCache\)/);
  assert.match(source, /browserPolicyRuntime\.requestMotion\(\s*ACTIVE_BROWSER_MOTION_NAME,\s*currentPhysicsStatePayload/);
  assert.match(source, /\{\s*startFrame,\s*transitionSteps:\s*ACTIVE_BROWSER_MOTION_TRANSITION_STEPS\s*\}/);
  assert.match(source, /browserPolicyRuntime\.requestMotion\('default',\s*currentPhysicsStatePayload/);

  const playBody = functionBody('playPlayback');
  const pauseBody = functionBody('pausePlayback');

  assert.match(playBody, /switchBrowserPolicyTrackingToActiveClip\(\)/);
  assert.doesNotMatch(playBody, /browserPhysics\.targetMode\s*=\s*'tracking'/);
  assert.match(pauseBody, /pausePhysicsToDefaultStance\(\)/);
});

test('physics playback does not start backend reference playback', () => {
  const playBody = functionBody('playPlayback');

  assert.match(source, /const playbackDisplayState = computed/);
  assert.match(source, /id="playbackBadge" class="badge">\{\{ t\('badges\.playback'\) \}\}: \{\{ playbackDisplayState \}\}/);
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
  assert.match(source, /<header class="topbar">[\s\S]*id="languageToggle"/);
  assert.doesNotMatch(source, /<aside class="sidebar right">[\s\S]*id="languageToggle"/);
  assert.match(source, /@click="setUiLanguage\('zh'\)"/);
  assert.match(source, /@click="setUiLanguage\('en'\)"/);
  assert.match(source, /\{\{ t\('data\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('motion\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('trim\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('test\.title'\) \}\}/);
  assert.match(source, /\{\{ t\('diagnostics\.title'\) \}\}/);
  assert.match(source, /:placeholder="t\('data\.pathPlaceholder'\)"/);
  assert.match(source, /statusText\(commandStatus\)/);
  assert.match(source, /setStatus\(treeStatus, 'data\.scanLoading'\)/);
  assert.match(source, /setStatus\(policyStatus, 'policy\.pluginsLoaded'\)/);
  assert.match(source, /policy\.display_name_i18n/);
  assert.match(source, /policy\.description_i18n/);
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
  assert.match(source, /const nextFrameFloat = browserPhysics\.referenceFrameFloat \+ fps \* browserPhysics\.controlDt/);
  assert.match(source, /if \(nextFrameFloat > maxFrame\.value\) \{[\s\S]*?if \(session\.value\?\.loop_enabled\) \{[\s\S]*?looped: true[\s\S]*?\}[\s\S]*?ended: true/);
  assert.match(source, /function shouldHoldCompletedTracking\(\)/);
  assert.match(source, /browserPolicyRuntime\.trackingState\(\)/);
  assert.match(source, /const referenceFrame = advanceBrowserPhysicsReferenceFrame\(\)/);
  assert.match(source, /if \(referenceFrame\.looped\) \{[\s\S]*?await switchBrowserPolicyTrackingToActiveClip\(referenceFrame\.frameIndex\)/);
  assert.match(source, /target = await inferBrowserPhysicsTarget\(referenceFrame\.frameIndex\)/);
});

test('physics completion holds the final active target before default stance', () => {
  assert.match(source, /const BROWSER_PHYSICS_END_HOLD_SECONDS = 0\.6/);
  assert.match(source, /function browserPhysicsEndHoldSteps\(\)/);
  assert.match(source, /return Math\.ceil\(BROWSER_PHYSICS_END_HOLD_SECONDS \/ browserPhysics\.controlDt\)/);
  assert.match(source, /endHoldStepsRemaining: 0/);
  const advanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const loopBody = source.match(/async function browserPhysicsLoop\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(advanceBody, /shouldHoldCompletedTracking\(\) \|\| browserPhysics\.endHoldStepsRemaining > 0/);
  assert.match(advanceBody, /frameIndex: maxFrame\.value, looped: false, ended: false, holdingEnd: true/);
  assert.match(loopBody, /if \(referenceFrame\.ended\) \{[\s\S]*?resetBrowserPolicyTrackingToDefault\(\)/);
  assert.match(loopBody, /else \{[\s\S]*?target = await inferBrowserPhysicsTarget\(referenceFrame\.frameIndex\)/);
});

test('completed non-loop playback resets progress to the first frame', () => {
  const physicsAdvanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const localPlaybackBody = source.match(/function localPlaybackStep\(timestamp\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(physicsAdvanceBody, /browserPhysics\.endHoldStepsRemaining = 0/);
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

test('trim export UI lets users choose format, twist2 extension, and output directory', () => {
  assert.match(source, /id="exportFormatSelect"/);
  assert.match(source, /v-model="exportFormat"/);
  assert.match(source, /id="twist2ExtensionSelect"/);
  assert.match(source, /v-model="twist2Extension"/);
  assert.match(source, /id="exportOutputDirInput"/);
  assert.match(source, /v-model="exportOutputDir"/);

  const exportBody = functionBody('exportTrim');
  assert.match(exportBody, /export_format:\s*exportFormat\.value/);
  assert.match(exportBody, /output_dir:\s*exportOutputDir\.value\.trim\(\) \|\| null/);
  assert.match(exportBody, /twist2_extension:\s*exportFormat\.value === 'twist2' \? twist2Extension\.value : null/);
});
