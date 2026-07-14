#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from huggingface_hub import snapshot_download
from huggingface_hub.errors import HfHubHTTPError, LocalEntryNotFoundError


REPO_ID = "HorizonRobotics/HoloMotion_models"
MODEL_FOLDER = "HoloMotion_motion_tracking_model"
PLUGIN_DIR = Path(__file__).resolve().parent.parent / "policy_plugins" / "holomotion_v13"
CONFIG_PATH = PLUGIN_DIR / "holomotion_v13_policy_config.json"
MODEL_PATH = PLUGIN_DIR / "model.onnx"
SOURCE_CONFIG_PATH = PLUGIN_DIR / "source_config.yaml"

G1_BODY_NAMES = [
    "pelvis",
    "left_hip_pitch_link",
    "left_hip_roll_link",
    "left_hip_yaw_link",
    "left_knee_link",
    "left_ankle_pitch_link",
    "left_ankle_roll_link",
    "right_hip_pitch_link",
    "right_hip_roll_link",
    "right_hip_yaw_link",
    "right_knee_link",
    "right_ankle_pitch_link",
    "right_ankle_roll_link",
    "waist_yaw_link",
    "waist_roll_link",
    "torso_link",
    "left_shoulder_pitch_link",
    "left_shoulder_roll_link",
    "left_shoulder_yaw_link",
    "left_elbow_link",
    "left_wrist_roll_link",
    "left_wrist_pitch_link",
    "left_wrist_yaw_link",
    "right_shoulder_pitch_link",
    "right_shoulder_roll_link",
    "right_shoulder_yaw_link",
    "right_elbow_link",
    "right_wrist_roll_link",
    "right_wrist_pitch_link",
    "right_wrist_yaw_link",
]

G1_KEYBODY_NAMES = [
    "left_knee_link",
    "right_knee_link",
    "left_ankle_roll_link",
    "right_ankle_roll_link",
    "left_elbow_link",
    "right_elbow_link",
    "left_wrist_yaw_link",
    "right_wrist_yaw_link",
]

HOLOMOTION_OBS_TERMS = [
    "actor_ref_gravity_projection_cur",
    "actor_ref_base_linvel_cur",
    "actor_ref_base_angvel_cur",
    "actor_ref_dof_pos_cur",
    "actor_ref_root_height_cur",
    "actor_projected_gravity",
    "actor_rel_robot_root_ang_vel",
    "actor_dof_pos",
    "actor_dof_vel",
    "actor_last_action",
    "actor_ref_dof_pos_fut",
    "actor_ref_root_height_fut",
    "actor_ref_gravity_projection_fut",
    "actor_ref_base_linvel_fut",
    "actor_ref_base_angvel_fut",
]


def _parse_csv_floats(value: str, key: str) -> list[float]:
    try:
        return [float(item) for item in str(value).split(",") if item != ""]
    except ValueError as exc:
        raise RuntimeError(f"ONNX metadata field {key!r} contains non-float values") from exc


def _parse_csv_strings(value: str) -> list[str]:
    return [item for item in str(value).split(",") if item != ""]


def _node_shape(node: Any) -> list[int]:
    shape = list(getattr(node, "shape", []) or [])
    out: list[int] = []
    for dim in shape:
        out.append(int(dim) if isinstance(dim, int) and dim > 0 else 1)
    return out or [1]


def _tensor_dtype_name(type_str: str) -> str:
    normalized = str(type_str).lower()
    if "float16" in normalized:
        return "float16"
    if "float64" in normalized or "double" in normalized:
        return "float64"
    if "int64" in normalized:
        return "int64"
    if "int32" in normalized:
        return "int32"
    return "float32"


def _read_onnx_session_metadata(path: Path) -> dict[str, Any]:
    try:
        import onnxruntime as ort
    except Exception as exc:
        raise RuntimeError("onnxruntime is required to inspect HoloMotion v1.3 ONNX metadata") from exc

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    custom_meta = session.get_modelmeta().custom_metadata_map
    required = ["action_scale", "joint_stiffness", "joint_damping", "default_joint_pos", "joint_names"]
    missing = [key for key in required if key not in custom_meta]
    if missing:
        raise RuntimeError(f"ONNX metadata is missing required keys: {missing}")

    inputs = session.get_inputs()
    outputs = session.get_outputs()
    input_shapes = {node.name: _node_shape(node) for node in inputs}
    input_dtypes = {node.name: _tensor_dtype_name(getattr(node, "type", "")) for node in inputs}
    output_shapes = {node.name: _node_shape(node) for node in outputs}
    output_dtypes = {node.name: _tensor_dtype_name(getattr(node, "type", "")) for node in outputs}
    kv_node = next((node for node in inputs if "past_key_values" in node.name), None)
    kv_dtype = _tensor_dtype_name(getattr(kv_node, "type", "float32")) if kv_node is not None else "float32"

    return {
        "joint_names": _parse_csv_strings(custom_meta["joint_names"]),
        "default_joint_pos": _parse_csv_floats(custom_meta["default_joint_pos"], "default_joint_pos"),
        "action_scale": _parse_csv_floats(custom_meta["action_scale"], "action_scale"),
        "stiffness": _parse_csv_floats(custom_meta["joint_stiffness"], "joint_stiffness"),
        "damping": _parse_csv_floats(custom_meta["joint_damping"], "joint_damping"),
        "onnx_meta": {
            "in_keys": [node.name for node in inputs],
            "out_keys": [node.name for node in outputs],
            "input_shapes": input_shapes,
            "input_dtypes": input_dtypes,
            "output_shapes": output_shapes,
            "output_dtypes": output_dtypes,
            "kv_dtype": kv_dtype,
        },
    }


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as file:
        payload = yaml.safe_load(file) or {}
    return payload if isinstance(payload, dict) else {}


def _resolve_n_fut_frames(source_config: dict[str, Any]) -> int:
    try:
        value = source_config.get("obs", {}).get("n_fut_frames", 10)
        return int(value)
    except Exception:
        return 10


def _find_first_mapping_by_key(value: Any, target_key: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    for key, child in value.items():
        if key == target_key and isinstance(child, dict):
            return child
        nested = _find_first_mapping_by_key(child, target_key)
        if nested:
            return nested
    return {}


def _pattern_matches(pattern: str, joint_name: str) -> bool:
    if pattern == joint_name:
        return True
    try:
        return re.fullmatch(pattern, joint_name) is not None
    except re.error:
        return False


def _resolve_torque_limits(source_config: dict[str, Any], joint_names: list[str]) -> list[float]:
    effort_limits = _find_first_mapping_by_key(source_config, "effort_limit_sim")
    resolved: list[float] = []
    for joint_name in joint_names:
        limit = 0.0
        for pattern, value in effort_limits.items():
            if _pattern_matches(str(pattern), joint_name):
                try:
                    limit = float(value)
                except (TypeError, ValueError):
                    limit = 0.0
                break
        resolved.append(limit)
    return resolved


def _validate_vector(name: str, values: list[float] | list[str], expected: int = 29) -> None:
    if len(values) != expected:
        raise RuntimeError(f"Expected {expected} entries for {name}, got {len(values)}")


def _build_config(model_meta: dict[str, Any], source_config: dict[str, Any]) -> dict[str, Any]:
    joint_names = model_meta["joint_names"]
    default_joint_pos = model_meta["default_joint_pos"]
    action_scale = model_meta["action_scale"]
    stiffness = model_meta["stiffness"]
    damping = model_meta["damping"]
    for name, values in [
        ("joint_names", joint_names),
        ("default_joint_pos", default_joint_pos),
        ("action_scale", action_scale),
        ("joint_stiffness", stiffness),
        ("joint_damping", damping),
    ]:
        _validate_vector(name, values)

    return {
        "onnx": {
            "path": "./model.onnx",
            "meta": {
                **model_meta["onnx_meta"],
                "source_repo": REPO_ID,
                "source_folder": MODEL_FOLDER,
            },
        },
        "policy_joint_names": joint_names,
        "default_joint_pos": default_joint_pos,
        "reset_joint_pos": default_joint_pos,
        "reset_root_translation": [0.0, 0.0, 0.8],
        "action_scale": action_scale,
        "stiffness": stiffness,
        "damping": damping,
        "torque_limits": _resolve_torque_limits(source_config, joint_names),
        "control_dt": 0.02,
        "action_clip": 10.0,
        "physics_options": {
            "timestep": 0.001,
        },
        "holomotion": {
            "version": "1.3.0",
            "source_repo": REPO_ID,
            "source_folder": MODEL_FOLDER,
            "n_fut_frames": _resolve_n_fut_frames(source_config),
            "ref_motion_filter_cutoff_hz": 0.0,
            "keybody_names": G1_KEYBODY_NAMES,
            "body_names": G1_BODY_NAMES,
            "obs_terms": HOLOMOTION_OBS_TERMS,
        },
    }


def _find_downloaded_file(root: Path, pattern: str) -> Path:
    candidates = sorted(root.glob(pattern))
    if not candidates:
        raise RuntimeError(f"Downloaded snapshot did not contain {pattern}")
    return candidates[0]


def download_snapshot(cache_dir: Path | None = None) -> Path:
    kwargs: dict[str, Any] = {
        "repo_id": REPO_ID,
        "allow_patterns": [f"{MODEL_FOLDER}/**"],
    }
    if cache_dir is not None:
        kwargs["cache_dir"] = str(cache_dir)
    try:
        return Path(snapshot_download(**kwargs))
    except (HfHubHTTPError, LocalEntryNotFoundError, OSError) as exc:
        raise RuntimeError(
            "Failed to download HoloMotion v1.3 from Hugging Face. "
            "Check network access, or download HorizonRobotics/HoloMotion_models "
            "manually and rerun with --snapshot-root pointing at the snapshot root."
        ) from exc


def install_assets(snapshot_root: Path) -> Path:
    model_root = snapshot_root / MODEL_FOLDER
    onnx_path = _find_downloaded_file(model_root, "exported/*.onnx")
    source_config = model_root / "config.yaml"

    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx_path, MODEL_PATH)
    if source_config.exists():
      shutil.copy2(source_config, SOURCE_CONFIG_PATH)

    model_meta = _read_onnx_session_metadata(MODEL_PATH)
    config = _build_config(model_meta, _load_yaml(SOURCE_CONFIG_PATH))
    CONFIG_PATH.write_text(json.dumps(config, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return MODEL_PATH


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and install HoloMotion v1.3 motion tracking assets.")
    parser.add_argument("--cache-dir", type=Path, default=None, help="Optional Hugging Face cache directory.")
    parser.add_argument("--snapshot-root", type=Path, default=None, help="Use an existing downloaded snapshot instead of downloading.")
    args = parser.parse_args()

    snapshot_root = args.snapshot_root if args.snapshot_root is not None else download_snapshot(args.cache_dir)
    model_path = install_assets(snapshot_root)
    print(f"Installed HoloMotion v1.3 model: {model_path}")
    print(f"Generated config: {CONFIG_PATH}")


if __name__ == "__main__":
    main()
