import { normalizeQuat } from './utils/math.js';

const FALL_HEIGHT_THRESHOLD = 0.5;
const FALL_ROLL_PITCH_THRESHOLD_DEG = 55;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function vectorDistance(a = [], b = []) {
  const length = Math.max(a?.length ?? 0, b?.length ?? 0);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = finiteNumber(a?.[index]) - finiteNumber(b?.[index]);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function jointError(actual = [], reference = []) {
  const length = Math.min(actual?.length ?? 0, reference?.length ?? 0);
  if (!length) {
    return { mean: 0, max: 0 };
  }
  let sum = 0;
  let max = 0;
  for (let index = 0; index < length; index += 1) {
    const error = Math.abs(finiteNumber(actual[index]) - finiteNumber(reference[index]));
    sum += error;
    max = Math.max(max, error);
  }
  return { mean: sum / length, max };
}

function quatRollPitchDeg(quat = [1, 0, 0, 0]) {
  const [w, x, y, z] = normalizeQuat(quat);
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1
    ? Math.sign(sinp) * Math.PI / 2
    : Math.asin(sinp);
  return Math.hypot(roll, pitch) * 180 / Math.PI;
}

function normalizeContact(contact = {}) {
  const left = contact.leftFoot ?? contact.left ?? {};
  const right = contact.rightFoot ?? contact.right ?? {};
  const leftForce = finiteNumber(left.normalForce ?? left.force);
  const rightForce = finiteNumber(right.normalForce ?? right.force);
  return {
    leftActive: Boolean(left.active || leftForce > 1e-6),
    rightActive: Boolean(right.active || rightForce > 1e-6),
    leftNormalForce: leftForce,
    rightNormalForce: rightForce,
    totalNormalForce: leftForce + rightForce,
    pointCount: Array.isArray(contact.points) ? contact.points.length : 0
  };
}

function roundMetric(value, digits = 6) {
  return Number(finiteNumber(value).toFixed(digits));
}

export function trackingTelemetrySample({
  policyId = null,
  frameIndex = 0,
  reference = null,
  currentState = null,
  target = null,
  contact = null,
  timestamp = performance?.now?.() / 1000
} = {}) {
  const referenceState = reference?.state ?? reference ?? {};
  const actualState = currentState?.state ?? currentState ?? {};
  const baseHeight = finiteNumber(actualState.root_translation?.[2], 0);
  const rootPositionError = vectorDistance(
    actualState.root_translation?.slice?.(0, 2),
    referenceState.root_translation?.slice?.(0, 2)
  );
  const joint = jointError(actualState.joint_positions, referenceState.joint_positions);
  const targetJoint = target?.joint_positions
    ? jointError(actualState.joint_positions, target.joint_positions)
    : { mean: 0, max: 0 };
  const baseRollPitchDeg = quatRollPitchDeg(actualState.root_rotation_wxyz);
  const fallen = baseHeight > 0 && (
    baseHeight < FALL_HEIGHT_THRESHOLD
    || baseRollPitchDeg > FALL_ROLL_PITCH_THRESHOLD_DEG
  );

  return {
    timestamp: roundMetric(timestamp),
    policyId,
    frameIndex: Math.max(0, Math.floor(finiteNumber(frameIndex))),
    rootPositionError: roundMetric(rootPositionError),
    jointMeanAbsError: roundMetric(joint.mean),
    jointMaxAbsError: roundMetric(joint.max),
    targetMeanAbsError: roundMetric(targetJoint.mean),
    targetMaxAbsError: roundMetric(targetJoint.max),
    baseHeight: roundMetric(baseHeight),
    baseRollPitchDeg: roundMetric(baseRollPitchDeg),
    fallen,
    contact: normalizeContact(contact)
  };
}

export function evaluateMotionStartDifficulty({
  defaultJointPositions = [],
  firstFrame = null
} = {}) {
  const firstJoints = firstFrame?.joint_positions ?? [];
  const joint = jointError(firstJoints, defaultJointPositions);
  const rootHeight = finiteNumber(firstFrame?.root_translation?.[2], 0.78);
  const rootHeightDelta = Math.abs(rootHeight - 0.78);
  const score = joint.mean + 0.35 * joint.max + rootHeightDelta;
  const level = score >= 0.75 ? 'hard' : score >= 0.28 ? 'medium' : 'easy';
  return {
    score: roundMetric(score),
    level,
    jointMeanDelta: roundMetric(joint.mean),
    jointMaxDelta: roundMetric(joint.max),
    rootHeightDelta: roundMetric(rootHeightDelta),
    recommendTransition: level !== 'easy'
  };
}

export function createEvaluationRun({ policyId, motionName, frameCount = 0 } = {}) {
  return {
    policyId,
    motionName,
    frameCount: Math.max(0, Math.floor(finiteNumber(frameCount))),
    startedAt: Date.now(),
    samples: [],
    fallFrame: null
  };
}

export function recordEvaluationSample(run, sample) {
  if (!run || !sample) {
    return run;
  }
  run.samples.push(sample);
  if (sample.fallen && run.fallFrame === null) {
    run.fallFrame = Math.max(0, Math.floor(finiteNumber(sample.frameIndex)));
  }
  return run;
}

export function summarizeEvaluationRun(run) {
  const samples = run?.samples ?? [];
  const count = samples.length;
  const sums = samples.reduce((acc, sample) => ({
    root: acc.root + finiteNumber(sample.rootPositionError),
    jointMean: acc.jointMean + finiteNumber(sample.jointMeanAbsError),
    maxJoint: Math.max(acc.maxJoint, finiteNumber(sample.jointMaxAbsError)),
    minHeight: Math.min(acc.minHeight, finiteNumber(sample.baseHeight, Number.POSITIVE_INFINITY))
  }), {
    root: 0,
    jointMean: 0,
    maxJoint: 0,
    minHeight: Number.POSITIVE_INFINITY
  });
  const fallFrame = run?.fallFrame ?? null;
  const completedFrame = fallFrame !== null
    ? fallFrame
    : Math.max(0, ...samples.map((sample) => Math.max(0, Math.floor(finiteNumber(sample.frameIndex)))));
  const frameCount = Math.max(1, finiteNumber(run?.frameCount, 1));
  return {
    policyId: run?.policyId ?? null,
    motionName: run?.motionName ?? null,
    samples: count,
    fell: fallFrame !== null,
    fallFrame,
    completionRate: roundMetric(Math.min(1, (completedFrame + 1) / frameCount), 4),
    avgRootPositionError: count ? roundMetric(sums.root / count) : 0,
    avgJointMeanAbsError: count ? roundMetric(sums.jointMean / count) : 0,
    maxJointError: roundMetric(sums.maxJoint),
    minBaseHeight: Number.isFinite(sums.minHeight) ? roundMetric(sums.minHeight) : 0
  };
}
