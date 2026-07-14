from __future__ import annotations

from collections import OrderedDict
from contextlib import nullcontext
import math
import os
from pathlib import Path
import threading
from typing import Any, Callable

import numpy as np

from .config import POLICY_PLUGIN_DIR


MODEL_PATH = POLICY_PLUGIN_DIR / "humanoid_gpt" / "model.onnx"
DEFAULT_MAX_CACHED_STATES = 32
OBS_DIM = 136
ACTION_DIM = 29
POLICY_ACTION_SCALE = 0.25

HUMANOID_GPT_JOINT_NAMES = [
    "left_hip_pitch_joint",
    "left_hip_roll_joint",
    "left_hip_yaw_joint",
    "left_knee_joint",
    "left_ankle_pitch_joint",
    "left_ankle_roll_joint",
    "right_hip_pitch_joint",
    "right_hip_roll_joint",
    "right_hip_yaw_joint",
    "right_knee_joint",
    "right_ankle_pitch_joint",
    "right_ankle_roll_joint",
    "waist_yaw_joint",
    "waist_roll_joint",
    "waist_pitch_joint",
    "left_shoulder_pitch_joint",
    "left_shoulder_roll_joint",
    "left_shoulder_yaw_joint",
    "left_elbow_joint",
    "left_wrist_roll_joint",
    "left_wrist_pitch_joint",
    "left_wrist_yaw_joint",
    "right_shoulder_pitch_joint",
    "right_shoulder_roll_joint",
    "right_shoulder_yaw_joint",
    "right_elbow_joint",
    "right_wrist_roll_joint",
    "right_wrist_pitch_joint",
    "right_wrist_yaw_joint",
]

HUMANOID_GPT_DEFAULT_JOINT_POS = [
    -0.1,
    0.0,
    0.0,
    0.3,
    -0.2,
    0.0,
    -0.1,
    0.0,
    0.0,
    0.3,
    -0.2,
    0.0,
    0.0,
    0.0,
    0.0,
    0.2,
    0.3,
    0.0,
    1.28,
    0.0,
    0.0,
    0.0,
    0.2,
    -0.3,
    0.0,
    1.28,
    0.0,
    0.0,
    0.0,
]

HUMANOID_GPT_STIFFNESS = [
    40.17923737,
    99.09842682,
    40.17923737,
    99.09842682,
    28.5012455,
    28.5012455,
    40.17923737,
    99.09842682,
    40.17923737,
    99.09842682,
    28.5012455,
    28.5012455,
    40.17923737,
    28.5012455,
    28.5012455,
    14.25062275,
    14.25062275,
    14.25062275,
    14.25062275,
    14.25062275,
    16.77832794,
    16.77832794,
    14.25062275,
    14.25062275,
    14.25062275,
    14.25062275,
    14.25062275,
    16.77832794,
    16.77832794,
]

HUMANOID_GPT_DAMPING = [
    2.5578897,
    6.30880165,
    2.5578897,
    6.30880165,
    1.81444573,
    1.81444573,
    2.5578897,
    6.30880165,
    2.5578897,
    6.30880165,
    1.81444573,
    1.81444573,
    2.5578897,
    1.81444573,
    1.81444573,
    0.90722287,
    0.90722287,
    0.90722287,
    0.90722287,
    0.90722287,
    1.06814146,
    1.06814146,
    0.90722287,
    0.90722287,
    0.90722287,
    0.90722287,
    0.90722287,
    1.06814146,
    1.06814146,
]

HUMANOID_GPT_TORQUE_LIMITS = [
    88.0,
    139.0,
    88.0,
    139.0,
    50.0,
    50.0,
    88.0,
    139.0,
    88.0,
    139.0,
    50.0,
    50.0,
    88.0,
    50.0,
    50.0,
    25.0,
    25.0,
    25.0,
    25.0,
    25.0,
    5.0,
    5.0,
    25.0,
    25.0,
    25.0,
    25.0,
    25.0,
    5.0,
    5.0,
]

HUMANOID_GPT_ACTION_SCALE = (
    np.asarray(HUMANOID_GPT_TORQUE_LIMITS, dtype=np.float32)
    / np.asarray(HUMANOID_GPT_STIFFNESS, dtype=np.float32)
).tolist()


def _as_float_array(values: Any, length: int, fallback: float | list[float] = 0.0) -> np.ndarray:
    if isinstance(fallback, list):
        out = np.asarray(fallback, dtype=np.float32).copy()
    else:
        out = np.full(length, float(fallback), dtype=np.float32)
    if out.shape[0] != length:
        out = np.resize(out, length).astype(np.float32)
    if values is None:
        return out
    source = np.asarray(values, dtype=np.float32).reshape(-1)
    count = min(length, source.shape[0])
    out[:count] = source[:count]
    return out


def _normalize_quat_wxyz(quat: Any) -> np.ndarray:
    out = _as_float_array(quat, 4, [1.0, 0.0, 0.0, 0.0])
    norm = float(np.linalg.norm(out))
    if not math.isfinite(norm) or norm < 1e-8:
        return np.asarray([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    return out / norm


def _yaw_from_quat_wxyz(quat: Any) -> float:
    w, x, y, z = _normalize_quat_wxyz(quat)
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def _wrap_pi(value: float) -> float:
    return (value + math.pi) % (2.0 * math.pi) - math.pi


def _projected_gravity(quat: Any) -> np.ndarray:
    w, x, y, z = _normalize_quat_wxyz(quat)
    return np.asarray(
        [
            -2.0 * (x * z - w * y),
            -2.0 * (y * z + w * x),
            -(1.0 - 2.0 * (x * x + y * y)),
        ],
        dtype=np.float32,
    )


def _rotate_xy_into_heading(vec: np.ndarray, yaw: float) -> np.ndarray:
    c = math.cos(-yaw)
    s = math.sin(-yaw)
    return np.asarray(
        [
            c * float(vec[0]) - s * float(vec[1]),
            s * float(vec[0]) + c * float(vec[1]),
        ],
        dtype=np.float32,
    )


def _rotate_vector_into_heading(vec: np.ndarray, yaw: float) -> np.ndarray:
    xy = _rotate_xy_into_heading(vec[:2], yaw)
    return np.asarray([xy[0], xy[1], float(vec[2])], dtype=np.float32)


def _state_from_payload(payload: Any) -> dict[str, np.ndarray]:
    payload = payload if isinstance(payload, dict) else {}
    state = payload.get("state") if isinstance(payload.get("state"), dict) else payload
    joint_names = payload.get("joint_names") or HUMANOID_GPT_JOINT_NAMES
    joint_index = {name: index for index, name in enumerate(joint_names)}
    source_pos = state.get("joint_positions", state.get("jointPos"))
    source_vel = state.get("joint_velocities", state.get("jointVel"))
    source_pos_arr = np.asarray(source_pos if source_pos is not None else [], dtype=np.float32).reshape(-1)
    source_vel_arr = np.asarray(source_vel if source_vel is not None else [], dtype=np.float32).reshape(-1)
    default_pos = np.asarray(HUMANOID_GPT_DEFAULT_JOINT_POS, dtype=np.float32)
    joint_pos = default_pos.copy()
    joint_vel = np.zeros(ACTION_DIM, dtype=np.float32)
    for index, joint_name in enumerate(HUMANOID_GPT_JOINT_NAMES):
        source_index = joint_index.get(joint_name, index if index < source_pos_arr.shape[0] else None)
        if source_index is not None and source_index < source_pos_arr.shape[0]:
            joint_pos[index] = source_pos_arr[source_index]
        if source_index is not None and source_index < source_vel_arr.shape[0]:
            joint_vel[index] = source_vel_arr[source_index]
    return {
        "joint_pos": joint_pos,
        "joint_vel": joint_vel,
        "root_pos": _as_float_array(state.get("root_translation", state.get("rootPos")), 3, [0.0, 0.0, 0.78]),
        "root_quat": _normalize_quat_wxyz(state.get("root_rotation_wxyz", state.get("rootQuat"))),
        "root_lin_vel": _as_float_array(state.get("root_linear_velocity", state.get("rootLinVel")), 3, 0.0),
        "root_ang_vel": _as_float_array(state.get("root_angular_velocity", state.get("rootAngVel")), 3, 0.0),
    }


def _build_observation(current: dict[str, np.ndarray], ref_curr: dict[str, np.ndarray], ref_next: dict[str, np.ndarray], last_action: np.ndarray) -> np.ndarray:
    default_pos = np.asarray(HUMANOID_GPT_DEFAULT_JOINT_POS, dtype=np.float32)
    current_yaw = _yaw_from_quat_wxyz(current["root_quat"])
    ref_yaw = _yaw_from_quat_wxyz(ref_curr["root_quat"])
    yaw_d = _wrap_pi(ref_yaw - current_yaw)
    xy_d = _rotate_xy_into_heading(ref_curr["root_pos"][:2] - current["root_pos"][:2], current_yaw)
    ref_next_yaw = _yaw_from_quat_wxyz(ref_next["root_quat"])
    ref_cvel = np.concatenate(
        [
            _rotate_vector_into_heading(ref_next["root_ang_vel"], ref_next_yaw),
            _rotate_vector_into_heading(ref_next["root_lin_vel"], ref_next_yaw),
        ]
    ).astype(np.float32)
    obs = np.concatenate(
        [
            current["root_ang_vel"],
            _projected_gravity(current["root_quat"]),
            current["joint_pos"] - default_pos,
            current["joint_vel"],
            last_action,
            ref_next["joint_pos"] - default_pos,
            np.asarray([ref_next["root_pos"][2]], dtype=np.float32),
            _projected_gravity(ref_next["root_quat"]),
            ref_cvel,
            np.asarray([math.cos(yaw_d), math.sin(yaw_d)], dtype=np.float32),
            xy_d,
        ]
    ).astype(np.float32)
    if obs.shape[0] != OBS_DIM:
        raise RuntimeError(f"Humanoid-GPT observation has {obs.shape[0]} values, expected {OBS_DIM}")
    return obs.reshape(1, OBS_DIM)


def _node_names(nodes: list[Any]) -> list[str]:
    return [str(getattr(node, "name", "")) for node in nodes]


class HumanoidGPTBackend:
    def __init__(
        self,
        model_path: Path = MODEL_PATH,
        max_cached_states: int = DEFAULT_MAX_CACHED_STATES,
        session_factory: Callable[[Path], Any] | None = None,
    ) -> None:
        self.model_path = model_path
        self.max_cached_states = max(1, int(max_cached_states))
        self._session_factory = session_factory
        self._lock = threading.Lock()
        self._session: Any | None = None
        self._input_names: list[str] = []
        self._output_names: list[str] = []
        self._states: OrderedDict[str, np.ndarray] = OrderedDict()
        self._state_lock = threading.Lock()
        self._cache_stripes = tuple(threading.Lock() for _ in range(16))

    def _make_session_options(self) -> Any:
        import onnxruntime as ort

        session_options = ort.SessionOptions()
        session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session_options.intra_op_num_threads = int(os.environ.get("HUMANOID_GPT_ORT_INTRA_THREADS", "1"))
        session_options.inter_op_num_threads = int(os.environ.get("HUMANOID_GPT_ORT_INTER_THREADS", "1"))
        try:
            session_options.add_session_config_entry("session.intra_op.allow_spinning", "1")
            session_options.add_session_config_entry("session.inter_op.allow_spinning", "1")
            session_options.add_session_config_entry("session.dynamic_block_base", "0")
        except Exception:
            pass
        return session_options

    def _create_session(self) -> Any:
        if self._session_factory is not None:
            return self._session_factory(self.model_path)
        if not self.model_path.exists():
            raise RuntimeError(f"Humanoid-GPT model is missing: {self.model_path}")
        try:
            import onnxruntime as ort
        except Exception as exc:
            raise RuntimeError("onnxruntime is required for Humanoid-GPT backend inference.") from exc
        return ort.InferenceSession(
            str(self.model_path),
            sess_options=self._make_session_options(),
            providers=["CPUExecutionProvider"],
        )

    def _ensure_session(self) -> Any:
        if self._session is not None:
            return self._session
        with self._lock:
            if self._session is not None:
                return self._session
            session = self._create_session()
            self._input_names = _node_names(session.get_inputs())
            self._output_names = _node_names(session.get_outputs())
            self._session = session
            return session

    def _last_action(self, cache_id: str | None, reset_cache: bool) -> np.ndarray:
        with self._state_lock:
            if not cache_id or reset_cache or cache_id not in self._states:
                return np.zeros(ACTION_DIM, dtype=np.float32)
            self._states.move_to_end(cache_id)
            return self._states[cache_id].copy()

    def _store_action(self, cache_id: str | None, action: np.ndarray) -> None:
        with self._state_lock:
            if not cache_id:
                return
            self._states[cache_id] = action.astype(np.float32).copy()
            self._states.move_to_end(cache_id)
            while len(self._states) > self.max_cached_states:
                self._states.popitem(last=False)

    def infer(self, payload: dict[str, Any]) -> dict[str, Any]:
        cache_id = str(payload.get("cache_id") or "") or None
        guard = self._cache_stripes[hash(cache_id) % len(self._cache_stripes)] if cache_id else nullcontext()
        with guard:
            return self._infer(payload, cache_id)

    def _infer(self, payload: dict[str, Any], cache_id: str | None) -> dict[str, Any]:
        session = self._ensure_session()
        reset_cache = bool(payload.get("reset_cache"))
        current = _state_from_payload(payload.get("current_state"))
        ref_curr = _state_from_payload(payload.get("ref_curr") or payload.get("reference"))
        ref_next = _state_from_payload(payload.get("ref_next") or payload.get("ref_curr") or payload.get("reference"))
        last_action = self._last_action(cache_id, reset_cache)
        obs = _build_observation(current, ref_curr, ref_next, last_action)
        input_name = next((name for name in self._input_names if "obs" in name), self._input_names[0] if self._input_names else "obs")
        output_name = (
            next((name for name in self._output_names if name == "continuous_actions"), None)
            or next((name for name in self._output_names if "action" in name), None)
            or (self._output_names[0] if self._output_names else "continuous_actions")
        )
        outputs = session.run([output_name], {input_name: obs})
        actions = np.asarray(outputs[0], dtype=np.float32).reshape(-1)
        if actions.shape[0] < ACTION_DIM:
            raise RuntimeError(f"Humanoid-GPT returned {actions.shape[0]} actions, expected {ACTION_DIM}")
        actions = actions[:ACTION_DIM]
        self._store_action(cache_id, actions)
        action_scale = np.asarray(HUMANOID_GPT_ACTION_SCALE, dtype=np.float32)
        default_pos = np.asarray(HUMANOID_GPT_DEFAULT_JOINT_POS, dtype=np.float32)
        clipped_actions = np.clip(actions, -10.0, 10.0)
        joint_positions = default_pos + clipped_actions * POLICY_ACTION_SCALE * action_scale
        response: dict[str, Any] = {
            "actions": actions.tolist(),
            "joint_positions": joint_positions.astype(np.float32).tolist(),
            "input_names": self._input_names,
            "output_names": self._output_names,
        }
        if cache_id:
            response["cache_id"] = cache_id
        return response


_backend = HumanoidGPTBackend()


def infer_humanoid_gpt(payload: dict[str, Any]) -> dict[str, Any]:
    return _backend.infer(payload)
