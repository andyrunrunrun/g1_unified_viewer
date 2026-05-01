import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./App.vue', import.meta.url), 'utf-8');

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
  assert.match(source, /steps:\s*viewer\.getPhysicsDecimation\(\)/);
  assert.match(source, /kp:\s*target\?\.kp/);
  assert.match(source, /kd:\s*target\?\.kd/);
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
  assert.match(source, />\s*Reset Stance\s*</);
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
  assert.match(source, />\s*Clear Test State\s*</);
  assert.match(source, /测试状态已清空。/);
});

test('browser physics control loop follows humanoid-policy-viewer async timing pattern', () => {
  assert.match(source, /async function browserPhysicsLoop\(\)/);
  assert.match(source, /await sleep\(sleepTime\)/);
  assert.match(source, /browserPhysics\.targetMode === 'default_stance'/);
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
  assert.match(source, /async function prepareBrowserTrackingMotion\(\)/);
  assert.match(source, /async function switchBrowserPolicyTrackingToActiveClip\(startFrame = browserPhysics\.referenceFrame\)/);
  assert.match(source, /browserPolicyRuntime\.setMotionClip\(ACTIVE_BROWSER_MOTION_NAME,\s*frameCache\)/);
  assert.match(source, /browserPolicyRuntime\.requestMotion\(\s*ACTIVE_BROWSER_MOTION_NAME,\s*currentPhysicsStatePayload/);
  assert.match(source, /\{\s*startFrame\s*\}/);
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
  assert.match(source, /id="playbackBadge" class="badge">播放: \{\{ playbackDisplayState \}\}/);
  assert.match(playBody, /if \(session\.value\?\.physics_enabled\) \{[\s\S]*?startBrowserPhysicsLoop\('tracking'\)[\s\S]*?return;/);
  assert.match(playBody, /return;[\s\S]*postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'play'\s*\}\)/);
  assert.doesNotMatch(playBody.trim(), /^await postJson\('\/api\/session\/playback',\s*\{\s*action:\s*'play'\s*\}\);/);
});

test('physics seek and stop stay inside browser physics instead of driving backend reference playback', () => {
  assert.match(source, /async function stopPlayback\(\)/);
  assert.match(source, /@click="runCommand\(stopPlayback, '已停止。'\)"/);
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
  assert.match(source, /@click="runCommand\(\(\) => switchSelectedPolicy\(policy\.policy_id\), '策略已切换。', policyStatus\)"/);
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
  assert.match(source, /const nextFrameFloat = browserPhysics\.referenceFrameFloat \+ fps \* BROWSER_PHYSICS_CONTROL_DT/);
  assert.match(source, /if \(nextFrameFloat > maxFrame\.value\) \{[\s\S]*?if \(session\.value\?\.loop_enabled\) \{[\s\S]*?looped: true[\s\S]*?\}[\s\S]*?ended: true/);
  assert.match(source, /const referenceFrame = advanceBrowserPhysicsReferenceFrame\(\)/);
  assert.match(source, /if \(referenceFrame\.looped\) \{[\s\S]*?await switchBrowserPolicyTrackingToActiveClip\(referenceFrame\.frameIndex\)/);
  assert.match(source, /target = await inferBrowserPhysicsTarget\(referenceFrame\.frameIndex\)/);
});

test('completed non-loop playback resets progress to the first frame', () => {
  const physicsAdvanceBody = source.match(/function advanceBrowserPhysicsReferenceFrame\(\) \{(?<body>[\s\S]*?)\n\}/).groups.body;
  const localPlaybackBody = source.match(/function localPlaybackStep\(timestamp\) \{(?<body>[\s\S]*?)\n\}/).groups.body;

  assert.match(physicsAdvanceBody, /browserPhysics\.referenceFrameFloat = 0/);
  assert.match(physicsAdvanceBody, /browserPhysics\.referenceFrame = 0/);
  assert.match(physicsAdvanceBody, /return \{ frameIndex: 0, looped: false, ended: true \}/);
  assert.match(localPlaybackBody, /nextFrame = 0/);
  assert.match(localPlaybackBody, /localPlayback\.active = false/);
});
