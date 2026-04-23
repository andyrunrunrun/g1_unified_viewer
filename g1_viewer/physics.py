from __future__ import annotations

import numpy as np

from .models import CanonicalRobotState


def _filled_vector(values: list[float], size: int, default: list[float]) -> np.ndarray:
    data = np.asarray(values or default, dtype=float)
    if data.size >= size:
        return data[:size]
    filled = np.zeros(size, dtype=float)
    filled[: data.size] = data
    return filled


def reset_data_to_state(model, data, state: CanonicalRobotState) -> None:
    data.qpos[:] = 0.0
    data.qvel[:] = 0.0
    if getattr(data, "ctrl", None) is not None and data.ctrl.size > 0:
        data.ctrl[:] = 0.0

    data.qpos[:3] = _filled_vector(state.root_translation, 3, [0.0, 0.0, 0.78])
    data.qpos[3:7] = _filled_vector(state.root_rotation_wxyz, 4, [1.0, 0.0, 0.0, 0.0])

    qpos_count = min(len(state.joint_positions), model.nq - 7)
    qvel_count = min(len(state.joint_velocities), model.nv - 6)
    if qpos_count > 0:
        data.qpos[7 : 7 + qpos_count] = np.asarray(state.joint_positions[:qpos_count], dtype=float)
    if qvel_count > 0:
        data.qvel[6 : 6 + qvel_count] = np.asarray(state.joint_velocities[:qvel_count], dtype=float)


def state_from_data(data, joint_count: int) -> CanonicalRobotState:
    bounded_joint_count = max(0, int(joint_count))
    return CanonicalRobotState(
        timestamp=0.0,
        root_translation=np.asarray(data.qpos[:3], dtype=float).tolist(),
        root_rotation_wxyz=np.asarray(data.qpos[3:7], dtype=float).tolist(),
        joint_positions=np.asarray(data.qpos[7 : 7 + bounded_joint_count], dtype=float).tolist(),
        joint_velocities=np.asarray(data.qvel[6 : 6 + bounded_joint_count], dtype=float).tolist(),
    )


def compute_pd_torque_targets(
    data,
    target_positions: list[float],
    kp: float = 30.0,
    kd: float = 1.5,
) -> np.ndarray:
    target = np.asarray(target_positions, dtype=float)
    if target.size == 0:
        return target

    current = np.asarray(data.qpos[7 : 7 + target.size], dtype=float)
    current_vel = np.asarray(data.qvel[6 : 6 + target.size], dtype=float)
    torque = kp * (target - current) - kd * current_vel
    return np.clip(torque, -80.0, 80.0)
