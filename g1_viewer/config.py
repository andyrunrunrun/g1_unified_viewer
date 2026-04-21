from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXPORT_ROOT = PROJECT_ROOT / "exports"
MANIFEST_DIR = PROJECT_ROOT / "policy_manifests"
ASSET_ROOT = PROJECT_ROOT / "assets"

CANONICAL_G1_JOINT_NAMES_29 = [
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

SONIC_TO_MUJOCO_29 = [
    0,
    3,
    6,
    9,
    13,
    17,
    1,
    4,
    7,
    10,
    14,
    18,
    2,
    5,
    8,
    11,
    15,
    19,
    21,
    23,
    25,
    27,
    12,
    16,
    20,
    22,
    24,
    26,
    28,
]

DEFAULT_G1_MODEL_CANDIDATES = [
    ASSET_ROOT / "g1" / "g1_29dof_rev_1_0.xml",
]


def resolve_g1_model_path() -> Path:
    override = os.environ.get("G1_VIEWER_MJCF_PATH")
    if override:
        path = Path(override).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"G1_VIEWER_MJCF_PATH does not exist: {path}")
        return path

    for candidate in DEFAULT_G1_MODEL_CANDIDATES:
        if candidate.exists():
            return candidate

    raise FileNotFoundError(
        f"No bundled G1 model asset found under {ASSET_ROOT}. "
        "Set G1_VIEWER_MJCF_PATH to a valid MuJoCo XML if you want to override it."
    )
