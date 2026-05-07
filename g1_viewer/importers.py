from __future__ import annotations

import csv
import json
import math
import pickle
import re
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

import numpy as np

from .config import CANONICAL_G1_JOINT_NAMES_29, SONIC_TO_MUJOCO_29, resolve_g1_model_path
from .models import CanonicalRobotState, ScanItem, StateSequence

SUPPORTED_TWIST2_EXTENSIONS = {".pkl", ".npz", ".npy", ".json"}
KIMODO_CSV_SOURCE_FPS = 30.0
KIMODO_CSV_TARGET_FPS = 50.0
KIMODO_CSV_BODY_INDEXES = [0, 4, 10, 18, 5, 11, 19, 9, 16, 22, 28, 17, 23, 29]


def _safe_uuid() -> str:
    return uuid.uuid4().hex[:12]


def _numeric_csv(path: Path) -> tuple[list[str], np.ndarray]:
    headers: list[str] = []
    rows: list[list[float]] = []
    with path.open("r", newline="") as handle:
        reader = csv.reader(handle)
        first_row = True
        for row in reader:
            if not row:
                continue
            cleaned = [cell.strip() for cell in row if cell.strip()]
            if not cleaned:
                continue
            if first_row:
                first_row = False
                try:
                    rows.append([float(cell) for cell in cleaned])
                except ValueError:
                    headers = cleaned
                continue
            rows.append([float(cell) for cell in cleaned])
    return headers, np.asarray(rows, dtype=float)


def _metadata_text(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("="):
            continue
        if ":" in stripped:
            key, value = stripped.split(":", 1)
            data[key.strip().lower().replace(" ", "_")] = value.strip()
    return data


def _infer_fps(metadata: dict[str, str], fallback: float) -> float:
    for key in ("output_fps", "fps", "source_fps", "frame_rate"):
        value = metadata.get(key)
        if value is None:
            continue
        match = re.search(r"[-+]?[0-9]*\.?[0-9]+", value)
        if match:
            return float(match.group(0))
    return fallback


def _reshape_body_array(flat_array: np.ndarray, width: int) -> np.ndarray:
    if flat_array.size == 0:
        return np.zeros((flat_array.shape[0], 0, width), dtype=float)
    if flat_array.shape[1] % width != 0:
        raise ValueError(f"Expected body array width divisible by {width}, got {flat_array.shape}")
    body_count = flat_array.shape[1] // width
    return flat_array.reshape(flat_array.shape[0], body_count, width)


def _xyzw_to_wxyz(quat: np.ndarray) -> np.ndarray:
    quat = np.asarray(quat, dtype=float)
    if quat.ndim == 1:
        return quat[[3, 0, 1, 2]]
    return quat[:, [3, 0, 1, 2]]


def _normalize_quaternions(quat: np.ndarray) -> np.ndarray:
    quat = np.asarray(quat, dtype=float)
    norm = np.linalg.norm(quat, axis=1, keepdims=True)
    norm = np.maximum(norm, 1e-9)
    return quat / norm


def _xyzw_roll_pitch_score(quat_xyzw: np.ndarray) -> float:
    quat_xyzw = _normalize_quaternions(quat_xyzw)
    x = quat_xyzw[:, 0]
    y = quat_xyzw[:, 1]
    z = quat_xyzw[:, 2]
    w = quat_xyzw[:, 3]
    sin_roll = 2.0 * (w * x + y * z)
    cos_roll = 1.0 - 2.0 * (x * x + y * y)
    roll = np.arctan2(sin_roll, cos_roll)
    sin_pitch = np.clip(2.0 * (w * y - z * x), -1.0, 1.0)
    pitch = np.arcsin(sin_pitch)
    return float(np.mean(np.abs(roll)) + np.mean(np.abs(pitch)))


def _detect_quat_order_xyzw_or_wxyz(root_rotation: np.ndarray, max_frames: int = 200) -> tuple[str, dict[str, float]]:
    root_rotation = np.asarray(root_rotation, dtype=float)
    if root_rotation.ndim != 2 or root_rotation.shape[1] != 4:
        raise ValueError(f"root_rotation must be shaped (T, 4), got {root_rotation.shape}")
    if root_rotation.shape[0] == 0:
        return "xyzw", {"xyzw": 0.0, "wxyz": math.inf}
    sample = root_rotation[: min(max_frames, root_rotation.shape[0])]
    xyzw_score = _xyzw_roll_pitch_score(sample)
    wxyz_score = _xyzw_roll_pitch_score(sample[:, [1, 2, 3, 0]])
    return (
        "xyzw" if xyzw_score <= wxyz_score else "wxyz",
        {"xyzw": xyzw_score, "wxyz": wxyz_score},
    )


def _axis_angle_to_wxyz(axis_angle: np.ndarray) -> np.ndarray:
    axis_angle = np.asarray(axis_angle, dtype=float)
    if axis_angle.ndim == 1:
        axis_angle = axis_angle[None, :]
    angle = np.linalg.norm(axis_angle, axis=1, keepdims=True)
    safe_angle = np.where(angle == 0.0, 1.0, angle)
    axis = axis_angle / safe_angle
    half = angle * 0.5
    quat = np.concatenate([np.cos(half), axis * np.sin(half)], axis=1)
    quat[angle[:, 0] == 0.0] = np.array([1.0, 0.0, 0.0, 0.0])
    return quat


def _finite_difference(values: np.ndarray, fps: float) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if values.shape[0] <= 1:
        return np.zeros_like(values)
    return np.gradient(values, 1.0 / fps, axis=0, edge_order=1)


def _slerp_wxyz(key_times: np.ndarray, quaternions_wxyz: np.ndarray, target_times: np.ndarray) -> np.ndarray:
    quaternions_wxyz = _normalize_quaternions(quaternions_wxyz)
    if target_times.size == 0:
        return np.zeros((0, 4), dtype=np.float64)
    if quaternions_wxyz.shape[0] == 1:
        return np.repeat(quaternions_wxyz, target_times.size, axis=0)

    indexes = np.searchsorted(key_times, target_times, side="right") - 1
    indexes = np.clip(indexes, 0, key_times.shape[0] - 2)
    t0 = key_times[indexes]
    t1 = key_times[indexes + 1]
    denom = np.maximum(t1 - t0, 1e-12)
    alpha = ((target_times - t0) / denom)[:, None]

    q0 = quaternions_wxyz[indexes]
    q1 = quaternions_wxyz[indexes + 1]
    dots = np.sum(q0 * q1, axis=1, keepdims=True)
    q1 = np.where(dots < 0.0, -q1, q1)
    dots = np.clip(np.abs(dots), 0.0, 1.0)

    near_linear = dots > 0.9995
    theta_0 = np.arccos(dots)
    sin_theta_0 = np.sin(theta_0)
    theta = theta_0 * alpha
    sin_theta = np.sin(theta)
    scale0 = np.sin(theta_0 - theta) / np.maximum(sin_theta_0, 1e-12)
    scale1 = sin_theta / np.maximum(sin_theta_0, 1e-12)
    spherical = scale0 * q0 + scale1 * q1
    linear = q0 + alpha * (q1 - q0)
    return _normalize_quaternions(np.where(near_linear, linear, spherical))


def _resample_motion(
    *,
    root_translation: np.ndarray,
    root_rotation_wxyz: np.ndarray,
    joint_positions: np.ndarray,
    source_fps: float,
    target_fps: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if abs(source_fps - target_fps) < 1e-6 or root_translation.shape[0] <= 1:
        return root_translation, root_rotation_wxyz, joint_positions

    source_times = np.arange(root_translation.shape[0], dtype=np.float64) / source_fps
    duration = source_times[-1]
    target_times = np.arange(0.0, duration + 1e-9, 1.0 / target_fps, dtype=np.float64)
    target_times = np.clip(target_times, source_times[0], source_times[-1])
    if target_times.size >= 2 and np.isclose(target_times[-1], target_times[-2]):
        target_times = target_times[:-1]

    root_resampled = np.empty((target_times.shape[0], 3), dtype=np.float64)
    joints_resampled = np.empty((target_times.shape[0], joint_positions.shape[1]), dtype=np.float64)
    for dim in range(root_resampled.shape[1]):
        root_resampled[:, dim] = np.interp(target_times, source_times, root_translation[:, dim])
    for dim in range(joints_resampled.shape[1]):
        joints_resampled[:, dim] = np.interp(target_times, source_times, joint_positions[:, dim])

    root_rotation_resampled = _slerp_wxyz(source_times, root_rotation_wxyz, target_times)
    return root_resampled, root_rotation_resampled, joints_resampled


def _run_g1_fk(
    *,
    root_translation: np.ndarray,
    root_rotation_wxyz: np.ndarray,
    joint_positions: np.ndarray,
    body_indexes: list[int],
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(resolve_g1_model_path()))
    data = mujoco.MjData(model)
    body_positions = np.zeros((joint_positions.shape[0], len(body_indexes), 3), dtype=np.float64)
    body_rotations = np.zeros((joint_positions.shape[0], len(body_indexes), 4), dtype=np.float64)
    body_names: list[str] = []

    for body_index in body_indexes:
        body_id = body_index + 1
        body_names.append(mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id) or f"body_{body_index}")

    for frame_index in range(joint_positions.shape[0]):
        data.qpos[:] = 0.0
        data.qpos[:3] = root_translation[frame_index]
        data.qpos[3:7] = root_rotation_wxyz[frame_index]
        data.qpos[7 : 7 + joint_positions.shape[1]] = joint_positions[frame_index]
        mujoco.mj_forward(model, data)
        for body_slot, body_index in enumerate(body_indexes):
            body_id = body_index + 1
            body_positions[frame_index, body_slot] = data.xpos[body_id]
            body_rotations[frame_index, body_slot] = data.xquat[body_id]

    return body_positions, body_rotations, body_names


def _sequence_from_arrays(
    *,
    name: str,
    source_format: str,
    source_path: Path,
    fps: float,
    joint_positions: np.ndarray,
    joint_velocities: np.ndarray | None = None,
    root_translation: np.ndarray | None = None,
    root_rotation_wxyz: np.ndarray | None = None,
    body_positions: np.ndarray | None = None,
    body_rotations_wxyz: np.ndarray | None = None,
    joint_names: list[str] | None = None,
    body_names: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> StateSequence:
    joint_positions = np.asarray(joint_positions, dtype=float)
    if joint_positions.ndim != 2:
        raise ValueError("joint_positions must be a 2D array")
    frame_count, joint_count = joint_positions.shape

    if joint_velocities is None or np.asarray(joint_velocities).size == 0:
        joint_velocities = np.zeros_like(joint_positions)
    joint_velocities = np.asarray(joint_velocities, dtype=float)

    if root_translation is None or np.asarray(root_translation).size == 0:
        root_translation = np.zeros((frame_count, 3), dtype=float)
    root_translation = np.asarray(root_translation, dtype=float)

    if root_rotation_wxyz is None or np.asarray(root_rotation_wxyz).size == 0:
        root_rotation_wxyz = np.tile(np.array([1.0, 0.0, 0.0, 0.0]), (frame_count, 1))
    root_rotation_wxyz = np.asarray(root_rotation_wxyz, dtype=float)

    if body_positions is None:
        body_positions = np.zeros((frame_count, 0, 3), dtype=float)
    body_positions = np.asarray(body_positions, dtype=float)

    if body_rotations_wxyz is None:
        body_rotations_wxyz = np.zeros((frame_count, 0, 4), dtype=float)
    body_rotations_wxyz = np.asarray(body_rotations_wxyz, dtype=float)

    if joint_names is None:
        joint_names = CANONICAL_G1_JOINT_NAMES_29[:joint_count] or [
            f"joint_{idx}" for idx in range(joint_count)
        ]
    if body_names is None:
        body_names = [f"body_{idx}" for idx in range(body_positions.shape[1])]
    metadata = dict(metadata or {})

    frames: list[CanonicalRobotState] = []
    for idx in range(frame_count):
        frames.append(
            CanonicalRobotState(
                timestamp=idx / fps,
                root_translation=root_translation[idx].tolist(),
                root_rotation_wxyz=root_rotation_wxyz[idx].tolist(),
                joint_positions=joint_positions[idx].tolist(),
                joint_velocities=joint_velocities[idx].tolist(),
                body_positions=body_positions[idx].tolist(),
                body_rotations_wxyz=body_rotations_wxyz[idx].tolist(),
                metadata={"frame_index": idx},
            )
        )

    return StateSequence(
        sequence_id=_safe_uuid(),
        name=name,
        source_format=source_format,  # type: ignore[arg-type]
        fps=fps,
        frame_count=frame_count,
        joint_names=joint_names,
        body_names=body_names,
        source_path=str(source_path),
        frames=frames,
        metadata=metadata,
    )


class DatasetImporter(ABC):
    format_name: str

    @abstractmethod
    def can_handle(self, path: Path) -> bool:
        raise NotImplementedError

    @abstractmethod
    def scan_items(self, path: Path) -> list[ScanItem]:
        raise NotImplementedError

    @abstractmethod
    def load(self, path: Path) -> StateSequence:
        raise NotImplementedError


class SonicImporter(DatasetImporter):
    format_name = "sonic"

    def can_handle(self, path: Path) -> bool:
        return path.is_dir() and (path / "joint_pos.csv").exists()

    def scan_items(self, path: Path) -> list[ScanItem]:
        candidates: list[Path] = []
        if self.can_handle(path):
            candidates.append(path)
        elif path.is_dir():
            for joint_csv in path.rglob("joint_pos.csv"):
                if joint_csv.parent not in candidates and self.can_handle(joint_csv.parent):
                    candidates.append(joint_csv.parent)
        return [
            ScanItem(
                path=str(candidate),
                name=candidate.name,
                format="sonic",
                item_type="directory",
            )
            for candidate in sorted(candidates)
        ]

    def load(self, path: Path) -> StateSequence:
        if not self.can_handle(path):
            raise ValueError(f"{path} is not a sonic motion directory")

        joint_headers, joint_pos = _numeric_csv(path / "joint_pos.csv")
        _, joint_vel = _numeric_csv(path / "joint_vel.csv") if (path / "joint_vel.csv").exists() else ([], np.zeros_like(joint_pos))
        _, body_pos_flat = _numeric_csv(path / "body_pos.csv") if (path / "body_pos.csv").exists() else ([], np.zeros((joint_pos.shape[0], 0)))
        _, body_quat_flat = _numeric_csv(path / "body_quat.csv") if (path / "body_quat.csv").exists() else ([], np.zeros((joint_pos.shape[0], 0)))

        metadata = _metadata_text(path / "metadata.txt")
        if (path / "fps.txt").exists():
            metadata["fps"] = (path / "fps.txt").read_text().strip()
        fps = _infer_fps(metadata, 50.0)

        if joint_pos.shape[1] == len(SONIC_TO_MUJOCO_29):
            joint_pos = joint_pos[:, SONIC_TO_MUJOCO_29]
            joint_vel = joint_vel[:, SONIC_TO_MUJOCO_29] if joint_vel.size else joint_vel
            joint_names = CANONICAL_G1_JOINT_NAMES_29.copy()
        else:
            joint_names = joint_headers or [f"joint_{idx}" for idx in range(joint_pos.shape[1])]

        body_positions = _reshape_body_array(body_pos_flat, 3)
        body_rotations = _reshape_body_array(body_quat_flat, 4)
        root_translation = body_positions[:, 0, :] if body_positions.shape[1] else np.zeros((joint_pos.shape[0], 3))
        root_rotation = body_rotations[:, 0, :] if body_rotations.shape[1] else np.tile(
            np.array([1.0, 0.0, 0.0, 0.0]),
            (joint_pos.shape[0], 1),
        )

        metadata["body_array_shape"] = str(body_positions.shape)
        return _sequence_from_arrays(
            name=path.name,
            source_format="sonic",
            source_path=path,
            fps=fps,
            joint_positions=joint_pos,
            joint_velocities=joint_vel,
            root_translation=root_translation,
            root_rotation_wxyz=root_rotation,
            body_positions=body_positions,
            body_rotations_wxyz=body_rotations,
            joint_names=joint_names,
            body_names=[f"body_{idx}" for idx in range(body_positions.shape[1])],
            metadata=metadata,
        )


class Twist2Importer(DatasetImporter):
    format_name = "twist2"

    def can_handle(self, path: Path) -> bool:
        if path.is_file() and path.suffix.lower() in SUPPORTED_TWIST2_EXTENSIONS:
            return self._sniff_motion_payload(path)
        if path.is_dir():
            return any(self._sniff_motion_payload(candidate) for candidate in self._iter_candidates(path))
        return False

    def scan_items(self, path: Path) -> list[ScanItem]:
        candidates: list[Path] = []
        if path.is_file() and self._sniff_motion_payload(path):
            candidates.append(path)
        elif path.is_dir():
            candidates.extend(candidate for candidate in self._iter_candidates(path) if self._sniff_motion_payload(candidate))
        return [
            ScanItem(
                path=str(candidate),
                name=candidate.stem,
                format="twist2",
                item_type="file",
            )
            for candidate in sorted(dict.fromkeys(candidates))
        ]

    def load(self, path: Path) -> StateSequence:
        payload = self._load_payload(path)
        payload = self._unwrap_payload(payload)

        fps = float(payload.get("fps", payload.get("frame_rate", 30.0)))
        joint_positions = self._first_array(payload, ("dof_pos", "joint_pos", "joint_positions", "dof"))
        if joint_positions is None:
            raise ValueError(f"Unable to find joint positions in {path}")
        joint_positions = np.asarray(joint_positions, dtype=float)
        if joint_positions.ndim == 1:
            joint_positions = joint_positions[None, :]

        joint_velocities = self._first_array(payload, ("joint_vel", "joint_velocities", "dof_vel"))
        if joint_velocities is not None:
            joint_velocities = np.asarray(joint_velocities, dtype=float)

        root_translation = self._first_array(
            payload,
            ("root_pos", "root_translation", "root_trans_offset", "root_trans", "base_pos"),
        )
        if root_translation is not None:
            root_translation = np.asarray(root_translation, dtype=float)

        root_rotation_order: str | None = None
        root_rotation_scores: dict[str, float] | None = None
        root_rotation = self._first_array(
            payload,
            ("root_rot", "root_rotation", "root_quat", "base_quat"),
        )
        if root_rotation is not None:
            root_rotation = np.asarray(root_rotation, dtype=float)
            if root_rotation.ndim == 1:
                root_rotation = root_rotation[None, :]
            if root_rotation.shape[1] == 3:
                root_rotation = _axis_angle_to_wxyz(root_rotation)
                root_rotation_order = "axis_angle"
            elif root_rotation.shape[1] == 4:
                root_rotation_order, root_rotation_scores = _detect_quat_order_xyzw_or_wxyz(root_rotation)
                if root_rotation_order == "wxyz":
                    root_rotation = _normalize_quaternions(root_rotation)
                else:
                    root_rotation = _xyzw_to_wxyz(_normalize_quaternions(root_rotation))
        body_positions = self._first_array(payload, ("local_body_pos", "body_pos_w", "body_positions"))
        if body_positions is not None:
            body_positions = np.asarray(body_positions, dtype=float)
            if body_positions.ndim == 2 and body_positions.shape[1] % 3 == 0:
                body_positions = _reshape_body_array(body_positions, 3)

        body_rotations = self._first_array(payload, ("body_quat_w", "body_rotations"))
        if body_rotations is not None:
            body_rotations = np.asarray(body_rotations, dtype=float)
            if body_rotations.ndim == 2 and body_rotations.shape[1] % 4 == 0:
                body_rotations = _reshape_body_array(body_rotations, 4)

        joint_names = payload.get("joint_names")
        if not isinstance(joint_names, list):
            joint_names = CANONICAL_G1_JOINT_NAMES_29[: joint_positions.shape[1]]
        body_names = payload.get("link_body_list")
        if not isinstance(body_names, list):
            body_names = [f"body_{idx}" for idx in range(body_positions.shape[1])] if body_positions is not None else []

        metadata = {
            "keys": sorted(payload.keys()),
            "original_suffix": path.suffix.lower(),
        }
        if root_rotation_order:
            metadata["root_rot_order"] = root_rotation_order
        if root_rotation_scores:
            metadata["root_rot_order_score_xyzw"] = root_rotation_scores["xyzw"]
            metadata["root_rot_order_score_wxyz"] = root_rotation_scores["wxyz"]
        return _sequence_from_arrays(
            name=path.stem,
            source_format="twist2",
            source_path=path,
            fps=fps,
            joint_positions=joint_positions,
            joint_velocities=joint_velocities,
            root_translation=root_translation,
            root_rotation_wxyz=root_rotation,
            body_positions=body_positions,
            body_rotations_wxyz=body_rotations,
            joint_names=joint_names,
            body_names=body_names,
            metadata=metadata,
        )

    def _iter_candidates(self, path: Path) -> list[Path]:
        return [
            candidate
            for candidate in path.rglob("*")
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_TWIST2_EXTENSIONS
        ]

    def _load_payload(self, path: Path) -> Any:
        suffix = path.suffix.lower()
        if suffix == ".pkl":
            with path.open("rb") as handle:
                return pickle.load(handle)
        if suffix == ".npz":
            with np.load(path, allow_pickle=True) as npz_file:
                return {key: npz_file[key] for key in npz_file.files}
        if suffix == ".npy":
            data = np.load(path, allow_pickle=True)
            if hasattr(data, "item"):
                try:
                    return data.item()
                except ValueError:
                    return data
            return data
        if suffix == ".json":
            return json.loads(path.read_text())
        raise ValueError(f"Unsupported motion file type: {path}")

    def _unwrap_payload(self, payload: Any) -> dict[str, Any]:
        if isinstance(payload, dict):
            if len(payload) == 1:
                nested = next(iter(payload.values()))
                if isinstance(nested, dict):
                    return nested
            return payload
        raise TypeError(f"Unexpected TWIST2 payload type: {type(payload)}")

    def _first_array(self, payload: dict[str, Any], keys: tuple[str, ...]) -> Any | None:
        for key in keys:
            if key in payload:
                return payload[key]
        return None

    def _sniff_motion_payload(self, path: Path) -> bool:
        try:
            payload = self._unwrap_payload(self._load_payload(path))
        except Exception:
            return False
        if {"root_pos", "root_rot", "dof_pos"}.issubset(payload.keys()):
            return True
        return {"root_trans_offset", "root_rot", "dof"}.issubset(payload.keys())


class KimodoCsvImporter(DatasetImporter):
    format_name = "kimodo_csv"

    def can_handle(self, path: Path) -> bool:
        return path.is_file() and path.suffix.lower() == ".csv" and self._sniff_g1_qpos_csv(path)

    def scan_items(self, path: Path) -> list[ScanItem]:
        candidates: list[Path] = []
        if path.is_file() and self.can_handle(path):
            candidates.append(path)
        elif path.is_dir():
            candidates.extend(candidate for candidate in path.rglob("*.csv") if self.can_handle(candidate))
        return [
            ScanItem(
                path=str(candidate),
                name=candidate.stem,
                format="kimodo_csv",
                item_type="file",
            )
            for candidate in sorted(dict.fromkeys(candidates))
        ]

    def load(self, path: Path) -> StateSequence:
        if not path.is_file():
            raise ValueError(f"{path} is not a Kimodo G1 qpos CSV")
        qpos = np.loadtxt(path, delimiter=",", dtype=np.float64)
        if qpos.ndim == 1:
            qpos = qpos[None, :]
        if qpos.ndim != 2 or qpos.shape[1] != 36:
            raise ValueError(f"Expected Kimodo G1 qpos CSV with shape (T, 36); got {qpos.shape}")

        root_translation = qpos[:, :3]
        root_rotation = _normalize_quaternions(qpos[:, 3:7])
        joint_positions = qpos[:, 7:]
        root_translation, root_rotation, joint_positions = _resample_motion(
            root_translation=root_translation,
            root_rotation_wxyz=root_rotation,
            joint_positions=joint_positions,
            source_fps=KIMODO_CSV_SOURCE_FPS,
            target_fps=KIMODO_CSV_TARGET_FPS,
        )
        joint_velocities = _finite_difference(joint_positions, KIMODO_CSV_TARGET_FPS)
        body_positions, body_rotations, body_names = _run_g1_fk(
            root_translation=root_translation,
            root_rotation_wxyz=root_rotation,
            joint_positions=joint_positions,
            body_indexes=KIMODO_CSV_BODY_INDEXES,
        )

        metadata = {
            "input_format": "kimodo_g1_qpos_csv",
            "source_fps": KIMODO_CSV_SOURCE_FPS,
            "output_fps": KIMODO_CSV_TARGET_FPS,
            "body_indexes": KIMODO_CSV_BODY_INDEXES,
            "original_shape": tuple(qpos.shape),
        }
        return _sequence_from_arrays(
            name=path.stem,
            source_format="kimodo_csv",
            source_path=path,
            fps=KIMODO_CSV_TARGET_FPS,
            joint_positions=joint_positions,
            joint_velocities=joint_velocities,
            root_translation=root_translation,
            root_rotation_wxyz=root_rotation,
            body_positions=body_positions,
            body_rotations_wxyz=body_rotations,
            joint_names=CANONICAL_G1_JOINT_NAMES_29.copy(),
            body_names=body_names,
            metadata=metadata,
        )

    def _sniff_g1_qpos_csv(self, path: Path) -> bool:
        try:
            rows_seen = 0
            with path.open("r", newline="") as handle:
                reader = csv.reader(handle)
                for row in reader:
                    cleaned = [cell.strip() for cell in row if cell.strip()]
                    if not cleaned:
                        continue
                    if len(cleaned) != 36:
                        return False
                    values = np.asarray([float(cell) for cell in cleaned], dtype=np.float64)
                    quat_norm = float(np.linalg.norm(values[3:7]))
                    if not np.isfinite(quat_norm) or quat_norm < 0.5 or quat_norm > 1.5:
                        return False
                    rows_seen += 1
                    if rows_seen >= 2:
                        return True
        except Exception:
            return False
        return rows_seen > 0


IMPORTERS: list[DatasetImporter] = [SonicImporter(), Twist2Importer(), KimodoCsvImporter()]


def detect_format(path: Path) -> str | None:
    for importer in IMPORTERS:
        if importer.can_handle(path):
            return importer.format_name
    return None


def scan_path(path_str: str) -> list[ScanItem]:
    path = Path(path_str).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Path does not exist: {path}")

    items: list[ScanItem] = []
    seen: set[str] = set()
    for importer in IMPORTERS:
        for item in importer.scan_items(path):
            if item.path in seen:
                continue
            seen.add(item.path)
            items.append(item)
    return sorted(items, key=lambda item: (item.format, item.name))


def load_sequence(path_str: str, format_hint: str | None = None) -> StateSequence:
    path = Path(path_str).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Path does not exist: {path}")

    if format_hint is not None:
        for importer in IMPORTERS:
            if importer.format_name == format_hint:
                return importer.load(path)
        raise ValueError(f"Unsupported format hint: {format_hint}")

    for importer in IMPORTERS:
        if importer.can_handle(path):
            return importer.load(path)
    raise ValueError(f"Unable to determine importer for path: {path}")
