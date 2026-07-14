export function cloneArray(values, fallback = []) {
  if (!values) {
    return Array.from(fallback);
  }
  return Array.from(values);
}

export function toFloatArray(value, length, fallback = 0) {
  const out = new Float32Array(length);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    for (let index = 0; index < length; index += 1) {
      const next = Number(value[index]);
      out[index] = Number.isFinite(next) ? next : fallback;
    }
    return out;
  }
  out.fill(Number.isFinite(Number(value)) ? Number(value) : fallback);
  return out;
}

export function normalizeQuat(quat) {
  const w = Number(quat?.[0] ?? 1);
  const x = Number(quat?.[1] ?? 0);
  const y = Number(quat?.[2] ?? 0);
  const z = Number(quat?.[3] ?? 0);
  const norm = Math.hypot(w, x, y, z);
  if (!Number.isFinite(norm) || norm < 1e-9) {
    return [1, 0, 0, 0];
  }
  const inv = 1 / norm;
  return [w * inv, x * inv, y * inv, z * inv];
}

export function quatConjugate(quat) {
  const [w, x, y, z] = normalizeQuat(quat);
  return [w, -x, -y, -z];
}

export const quatInverse = quatConjugate;

export function quatMultiply(a, b) {
  const [aw, ax, ay, az] = normalizeQuat(a);
  const [bw, bx, by, bz] = normalizeQuat(b);
  return normalizeQuat([
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw
  ]);
}

export function quatApplyInv(quat, vec) {
  const [w, x, y, z] = normalizeQuat(quat);
  const vx = Number(vec?.[0] ?? 0);
  const vy = Number(vec?.[1] ?? 0);
  const vz = Number(vec?.[2] ?? 0);
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  const cx = y * tz - z * ty;
  const cy = z * tx - x * tz;
  const cz = x * ty - y * tx;
  return [
    vx - w * tx + cx,
    vy - w * ty + cy,
    vz - w * tz + cz
  ];
}

export function quatAngularDistance(a, b) {
  const qa = normalizeQuat(a);
  const qb = normalizeQuat(b);
  const dot = Math.abs(
    qa[0] * qb[0]
    + qa[1] * qb[1]
    + qa[2] * qb[2]
    + qa[3] * qb[3]
  );
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
}
