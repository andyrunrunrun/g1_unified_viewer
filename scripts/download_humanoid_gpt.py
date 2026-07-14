#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from g1_viewer.humanoid_gpt import (
    HUMANOID_GPT_ACTION_SCALE,
    HUMANOID_GPT_DAMPING,
    HUMANOID_GPT_DEFAULT_JOINT_POS,
    HUMANOID_GPT_JOINT_NAMES,
    HUMANOID_GPT_STIFFNESS,
    HUMANOID_GPT_TORQUE_LIMITS,
    MODEL_PATH,
    OBS_DIM,
    POLICY_ACTION_SCALE,
)


REPO_ID = "GalaxyGeneralRobotics/Humanoid-GPT"
CHECKPOINT_REPO_PATH = "storage/ckpts/pns_wo_priv216.onnx"
CHECKPOINT_FILENAME = Path(CHECKPOINT_REPO_PATH).name
RAW_MODEL_URL = f"https://github.com/{REPO_ID}/raw/refs/heads/main/{CHECKPOINT_REPO_PATH}"
PLUGIN_DIR = Path(__file__).resolve().parent.parent / "policy_plugins" / "humanoid_gpt"
CONFIG_PATH = PLUGIN_DIR / "humanoid_gpt_policy_config.json"


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
        raise RuntimeError("onnxruntime is required to inspect Humanoid-GPT ONNX metadata") from exc

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    inputs = session.get_inputs()
    outputs = session.get_outputs()
    return {
        "in_keys": [node.name for node in inputs],
        "out_keys": [node.name for node in outputs],
        "input_shapes": {node.name: _node_shape(node) for node in inputs},
        "output_shapes": {node.name: _node_shape(node) for node in outputs},
        "input_dtypes": {node.name: _tensor_dtype_name(getattr(node, "type", "")) for node in inputs},
        "output_dtypes": {node.name: _tensor_dtype_name(getattr(node, "type", "")) for node in outputs},
    }


def _build_config(onnx_meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "onnx": {
            "path": "./model.onnx",
            "meta": {
                **onnx_meta,
                "source_repo": REPO_ID,
                "checkpoint_path": CHECKPOINT_REPO_PATH,
            },
        },
        "policy_joint_names": HUMANOID_GPT_JOINT_NAMES,
        "default_joint_pos": HUMANOID_GPT_DEFAULT_JOINT_POS,
        "reset_joint_pos": HUMANOID_GPT_DEFAULT_JOINT_POS,
        "reset_root_translation": [0.0, 0.0, 0.78],
        "action_scale": HUMANOID_GPT_ACTION_SCALE,
        "stiffness": HUMANOID_GPT_STIFFNESS,
        "damping": HUMANOID_GPT_DAMPING,
        "torque_limits": HUMANOID_GPT_TORQUE_LIMITS,
        "control_dt": 0.02,
        "action_clip": 10.0,
        "physics_options": {
            "timestep": 0.001,
        },
        "humanoid_gpt": {
            "source_repo": REPO_ID,
            "checkpoint_path": CHECKPOINT_REPO_PATH,
            "obs_dim": OBS_DIM,
            "policy_action_scale": POLICY_ACTION_SCALE,
            "g1_version": "5010",
        },
    }


def _find_checkpoint(root: Path) -> Path:
    if root.is_file():
        return root
    candidates = [
        root / CHECKPOINT_REPO_PATH,
        root / CHECKPOINT_FILENAME,
        *sorted(root.glob(f"**/{CHECKPOINT_FILENAME}")),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError(f"Could not find {CHECKPOINT_REPO_PATH} under {root}")


def _validate_downloaded_model(path: Path) -> None:
    head = path.read_bytes()[:128]
    if b"git-lfs.github.com/spec" in head:
        raise RuntimeError(
            "Downloaded Humanoid-GPT file is a Git LFS pointer, not the ONNX payload. "
            "Download the LFS object manually and rerun with --snapshot-root or --checkpoint."
        )
    if path.stat().st_size < 1024:
        raise RuntimeError(f"Downloaded Humanoid-GPT model is unexpectedly small: {path.stat().st_size} bytes")


def download_checkpoint(output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    request = Request(RAW_MODEL_URL, headers={"User-Agent": "g1-unified-viewer"})
    try:
        with urlopen(request, timeout=120) as response, output_path.open("wb") as file:
            shutil.copyfileobj(response, file)
    except (HTTPError, URLError, OSError) as exc:
        raise RuntimeError(
            "Failed to download Humanoid-GPT checkpoint from GitHub. "
            "Check network access, or download GalaxyGeneralRobotics/Humanoid-GPT "
            "manually and rerun with --snapshot-root or --checkpoint."
        ) from exc
    _validate_downloaded_model(output_path)
    return output_path


def install_assets(snapshot_root: Path) -> Path:
    checkpoint_path = _find_checkpoint(snapshot_root)
    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(checkpoint_path, MODEL_PATH)
    model_meta = _read_onnx_session_metadata(MODEL_PATH)
    config = _build_config(model_meta)
    CONFIG_PATH.write_text(json.dumps(config, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return MODEL_PATH


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and install Humanoid-GPT motion tracking assets.")
    parser.add_argument("--snapshot-root", type=Path, default=None, help="Use an existing Humanoid-GPT repo/snapshot root.")
    parser.add_argument("--checkpoint", type=Path, default=None, help="Use an existing pns_wo_priv216.onnx file.")
    parser.add_argument("--download-path", type=Path, default=None, help="Optional path for the downloaded ONNX before install.")
    args = parser.parse_args()

    if args.checkpoint is not None:
        source = args.checkpoint
    elif args.snapshot_root is not None:
        source = args.snapshot_root
    else:
        download_path = args.download_path or (PLUGIN_DIR / ".download" / CHECKPOINT_FILENAME)
        source = download_checkpoint(download_path)
    model_path = install_assets(source)
    print(f"Installed Humanoid-GPT model: {model_path}")
    print(f"Generated config: {CONFIG_PATH}")


if __name__ == "__main__":
    main()
