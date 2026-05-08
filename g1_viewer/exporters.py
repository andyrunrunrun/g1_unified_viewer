from __future__ import annotations

import csv
import json
import pickle
import re
from pathlib import Path

import numpy as np

from .config import EXPORT_ROOT, SONIC_TO_MUJOCO_29
from .models import ExportMotionFormat, StateSequence, Twist2ExportExtension


def _sanitize_name(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", name).strip("_") or "clip"


def _export_name_stem(name: str) -> str:
    sanitized = _sanitize_name(name)
    for suffix in (".csv", ".npz", ".pkl", ".json"):
        if sanitized.lower().endswith(suffix):
            return sanitized[: -len(suffix)] or "clip"
    return sanitized


def _wxyz_to_xyzw(quaternions: np.ndarray) -> np.ndarray:
    quaternions = np.asarray(quaternions, dtype=np.float32)
    if quaternions.ndim == 1:
        return quaternions[[1, 2, 3, 0]]
    return quaternions[:, [1, 2, 3, 0]]


def trim_sequence(sequence: StateSequence, start_frame: int, end_frame: int) -> StateSequence:
    if start_frame < 0 or end_frame < 0:
        raise ValueError("Trim frames must be non-negative")
    if end_frame < start_frame:
        raise ValueError("end_frame must be greater than or equal to start_frame")
    if end_frame >= sequence.frame_count:
        raise ValueError("end_frame exceeds clip length")

    trimmed_frames = sequence.frames[start_frame : end_frame + 1]
    trimmed = StateSequence(
        sequence_id=f"{sequence.sequence_id}_trim_{start_frame}_{end_frame}",
        name=f"{sequence.name}_trim_{start_frame}_{end_frame}",
        source_type=sequence.source_type,
        source_format=sequence.source_format,
        fps=sequence.fps,
        frame_count=len(trimmed_frames),
        joint_names=sequence.joint_names,
        body_names=sequence.body_names,
        source_path=sequence.source_path,
        frames=trimmed_frames,
        metadata={
            **sequence.metadata,
            "trim_start_frame": start_frame,
            "trim_end_frame": end_frame,
        },
    )
    return trimmed


def _sequence_with_export_name(sequence: StateSequence, output_name: str | None) -> StateSequence:
    if not output_name or not output_name.strip():
        return sequence
    name_stem = _export_name_stem(output_name)
    if hasattr(sequence, "model_copy"):
        return sequence.model_copy(update={"name": name_stem})
    return sequence.copy(update={"name": name_stem})


def export_trimmed_sequence(
    sequence: StateSequence,
    start_frame: int,
    end_frame: int,
    export_root: Path | None = None,
    export_format: ExportMotionFormat | None = None,
    twist2_extension: Twist2ExportExtension | None = None,
    use_format_subdir: bool | None = None,
    output_name: str | None = None,
) -> Path:
    trimmed = trim_sequence(sequence, start_frame, end_frame)
    export_name = output_name if output_name and output_name.strip() else sequence.name
    trimmed = _sequence_with_export_name(trimmed, export_name)
    export_root = export_root or EXPORT_ROOT
    export_root.mkdir(parents=True, exist_ok=True)

    target_format = export_format or _default_export_format(trimmed)
    if use_format_subdir is None:
        use_format_subdir = export_root == EXPORT_ROOT

    if target_format == "sonic":
        return _export_sonic(trimmed, export_root, use_format_subdir=use_format_subdir)
    if target_format == "twist2":
        return _export_twist2(
            trimmed,
            export_root,
            suffix=twist2_extension,
            use_format_subdir=use_format_subdir,
        )
    if target_format == "motion_tracking_npz":
        return _export_motion_tracking_npz(trimmed, export_root, use_format_subdir=use_format_subdir)
    if target_format == "kimodo_csv":
        return _export_kimodo_csv(trimmed, export_root, use_format_subdir=use_format_subdir)
    raise ValueError(f"Unsupported export format: {target_format}")


def _default_export_format(sequence: StateSequence) -> ExportMotionFormat:
    if sequence.source_format in {"sonic", "twist2", "motion_tracking_npz", "kimodo_csv"}:
        return sequence.source_format
    raise ValueError(f"Unsupported export format: {sequence.source_format}")


def _export_sonic(sequence: StateSequence, export_root: Path, *, use_format_subdir: bool = True) -> Path:
    base_dir = export_root / "sonic" if use_format_subdir else export_root
    target_dir = base_dir / _sanitize_name(sequence.name)
    target_dir.mkdir(parents=True, exist_ok=True)

    joint_pos = np.asarray([frame.joint_positions for frame in sequence.frames], dtype=float)
    joint_vel = np.asarray([frame.joint_velocities for frame in sequence.frames], dtype=float)
    body_pos = np.asarray([frame.body_positions for frame in sequence.frames], dtype=float)
    body_rot = np.asarray([frame.body_rotations_wxyz for frame in sequence.frames], dtype=float)
    joint_headers = sequence.joint_names
    if joint_pos.shape[1] == len(SONIC_TO_MUJOCO_29):
        mujoco_to_sonic = np.argsort(np.asarray(SONIC_TO_MUJOCO_29))
        joint_pos = joint_pos[:, mujoco_to_sonic]
        joint_vel = joint_vel[:, mujoco_to_sonic] if joint_vel.size else joint_vel
        joint_headers = [sequence.joint_names[index] for index in mujoco_to_sonic]

    _write_csv(
        target_dir / "joint_pos.csv",
        joint_headers,
        joint_pos,
    )
    _write_csv(
        target_dir / "joint_vel.csv",
        joint_headers,
        joint_vel,
    )

    if body_pos.size:
        body_pos_headers = []
        for body_name in sequence.body_names:
            body_pos_headers.extend([f"{body_name}_x", f"{body_name}_y", f"{body_name}_z"])
        _write_csv(target_dir / "body_pos.csv", body_pos_headers, body_pos.reshape(body_pos.shape[0], -1))

    if body_rot.size:
        body_rot_headers = []
        for body_name in sequence.body_names:
            body_rot_headers.extend([f"{body_name}_w", f"{body_name}_x", f"{body_name}_y", f"{body_name}_z"])
        _write_csv(target_dir / "body_quat.csv", body_rot_headers, body_rot.reshape(body_rot.shape[0], -1))

    metadata = {
        "name": sequence.name,
        "fps": sequence.fps,
        "frame_count": sequence.frame_count,
        **sequence.metadata,
    }
    (target_dir / "fps.txt").write_text(f"{sequence.fps}\n")
    (target_dir / "metadata.txt").write_text(
        "\n".join(f"{key}: {value}" for key, value in metadata.items()) + "\n"
    )
    (target_dir / "info.txt").write_text(
        json.dumps(
            {
                "joint_names": sequence.joint_names,
                "body_names": sequence.body_names,
            },
            indent=2,
        )
        + "\n"
    )
    return target_dir


def _export_twist2(
    sequence: StateSequence,
    export_root: Path,
    *,
    suffix: Twist2ExportExtension | None = None,
    use_format_subdir: bool = True,
) -> Path:
    source_path = Path(sequence.source_path)
    suffix = suffix or (source_path.suffix.lower() if source_path.suffix else ".pkl")
    target_dir = export_root / "twist2" if use_format_subdir else export_root
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{_sanitize_name(sequence.name)}{suffix if suffix in {'.pkl', '.npz', '.json'} else '.pkl'}"

    payload = {
        "fps": float(sequence.fps),
        "root_pos": np.asarray([frame.root_translation for frame in sequence.frames], dtype=np.float32),
        "root_rot": _wxyz_to_xyzw(
            np.asarray([frame.root_rotation_wxyz for frame in sequence.frames], dtype=np.float32)
        ),
        "dof_pos": np.asarray([frame.joint_positions for frame in sequence.frames], dtype=np.float32),
        "local_body_pos": np.asarray([frame.body_positions for frame in sequence.frames], dtype=np.float32),
        "link_body_list": sequence.body_names,
    }

    if target_path.suffix == ".npz":
        np.savez(target_path, **payload)
    elif target_path.suffix == ".json":
        serializable = {
            key: value.tolist() if hasattr(value, "tolist") else value
            for key, value in payload.items()
        }
        target_path.write_text(json.dumps(serializable, indent=2) + "\n")
    else:
        with target_path.open("wb") as handle:
            pickle.dump(payload, handle)
    return target_path


def _export_motion_tracking_npz(
    sequence: StateSequence,
    export_root: Path,
    *,
    use_format_subdir: bool = True,
) -> Path:
    target_dir = export_root / "motion_tracking_npz" if use_format_subdir else export_root
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{_sanitize_name(sequence.name)}.npz"

    payload = {
        "fps": float(sequence.fps),
        "root_pos": np.asarray([frame.root_translation for frame in sequence.frames], dtype=np.float32),
        "root_rot": _wxyz_to_xyzw(
            np.asarray([frame.root_rotation_wxyz for frame in sequence.frames], dtype=np.float32)
        ),
        "dof_pos": np.asarray([frame.joint_positions for frame in sequence.frames], dtype=np.float32),
        "local_body_pos": np.asarray([frame.body_positions for frame in sequence.frames], dtype=np.float32),
        "joint_names": np.asarray(sequence.joint_names),
        "body_names": np.asarray(sequence.body_names),
    }
    np.savez(target_path, **payload)
    return target_path


def _export_kimodo_csv(
    sequence: StateSequence,
    export_root: Path,
    *,
    use_format_subdir: bool = True,
) -> Path:
    target_dir = export_root / "kimodo_csv" if use_format_subdir else export_root
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{_sanitize_name(sequence.name)}.csv"

    root_pos = np.asarray([frame.root_translation for frame in sequence.frames], dtype=np.float64)
    root_rot = np.asarray([frame.root_rotation_wxyz for frame in sequence.frames], dtype=np.float64)
    joint_pos = np.asarray([frame.joint_positions for frame in sequence.frames], dtype=np.float64)
    if joint_pos.shape[1] != 29:
        raise ValueError(f"kimodo_csv export requires 29 joint positions, got {joint_pos.shape[1]}")

    qpos = np.concatenate([root_pos, root_rot, joint_pos], axis=1)
    np.savetxt(target_path, qpos, delimiter=",")
    return target_path


def _write_csv(path: Path, headers: list[str], array: np.ndarray) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(array.tolist())
