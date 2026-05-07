import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvaluationRun,
  evaluateMotionStartDifficulty,
  recordEvaluationSample,
  summarizeEvaluationRun,
  trackingTelemetrySample
} from './evaluationMetrics.js';

test('tracking telemetry computes root, joint, fall, and contact metrics', () => {
  const sample = trackingTelemetrySample({
    policyId: 'policy_a',
    frameIndex: 12,
    reference: {
      state: {
        root_translation: [1, 0, 0.8],
        root_rotation_wxyz: [1, 0, 0, 0],
        joint_positions: [0, 1, 2]
      }
    },
    currentState: {
      root_translation: [1.3, 0.4, 0.42],
      root_rotation_wxyz: [0.7071068, 0.7071068, 0, 0],
      joint_positions: [0.1, 0.4, 2.9]
    },
    target: {
      joint_positions: [0.2, 0.8, 2.5]
    },
    contact: {
      leftFoot: { active: true, normalForce: 18 },
      rightFoot: { active: false, normalForce: 0 },
      points: [{ bodyName: 'left_ankle_roll_link' }]
    }
  });

  assert.equal(sample.policyId, 'policy_a');
  assert.equal(sample.frameIndex, 12);
  assert.equal(Number(sample.rootPositionError.toFixed(3)), 0.5);
  assert.equal(Number(sample.jointMeanAbsError.toFixed(3)), 0.533);
  assert.equal(Number(sample.jointMaxAbsError.toFixed(3)), 0.9);
  assert.equal(Number(sample.targetMeanAbsError.toFixed(3)), 0.3);
  assert.equal(sample.baseHeight, 0.42);
  assert.equal(sample.fallen, true);
  assert.equal(sample.contact.leftActive, true);
  assert.equal(sample.contact.rightActive, false);
  assert.equal(sample.contact.totalNormalForce, 18);
  assert.ok(sample.baseRollPitchDeg > 80);
});

test('motion start difficulty scores first-frame distance from default stance', () => {
  const easy = evaluateMotionStartDifficulty({
    defaultJointPositions: [0, 0, 0],
    firstFrame: { joint_positions: [0.05, 0.02, -0.03], root_translation: [0, 0, 0.78] }
  });
  const hard = evaluateMotionStartDifficulty({
    defaultJointPositions: [0, 0, 0],
    firstFrame: { joint_positions: [0.8, -0.7, 0.6], root_translation: [0, 0, 0.45] }
  });

  assert.equal(easy.level, 'easy');
  assert.equal(easy.recommendTransition, false);
  assert.equal(hard.level, 'hard');
  assert.equal(hard.recommendTransition, true);
  assert.ok(hard.score > easy.score);
});

test('evaluation run summary records stability, tracking errors, completion and fall frame', () => {
  const run = createEvaluationRun({ policyId: 'policy_b', motionName: 'walk', frameCount: 100 });
  recordEvaluationSample(run, {
    rootPositionError: 0.1,
    jointMeanAbsError: 0.2,
    jointMaxAbsError: 0.5,
    fallen: false,
    frameIndex: 0,
    baseHeight: 0.75
  });
  recordEvaluationSample(run, {
    rootPositionError: 0.3,
    jointMeanAbsError: 0.4,
    jointMaxAbsError: 1.2,
    fallen: true,
    frameIndex: 42,
    baseHeight: 0.31
  });

  const summary = summarizeEvaluationRun(run);

  assert.equal(summary.policyId, 'policy_b');
  assert.equal(summary.samples, 2);
  assert.equal(summary.fell, true);
  assert.equal(summary.fallFrame, 42);
  assert.equal(summary.completionRate, 0.43);
  assert.equal(summary.avgRootPositionError, 0.2);
  assert.equal(summary.avgJointMeanAbsError, 0.3);
  assert.equal(summary.maxJointError, 1.2);
});
