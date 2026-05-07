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

from .config import CANONICAL_G1_JOINT_NAMES_29, SONIC_TO_MUJOCO_29
from .models import CanonicalRobotState, ScanItem, StateSequence

SUPPORTED_TWIST2_EXTENSIONS = {".pkl", ".npz", ".npy", ".json"}


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


IMPORTERS: list[DatasetImporter] = [SonicImporter(), Twist2Importer()]


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
