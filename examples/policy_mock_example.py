from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from g1_viewer.importers import load_sequence
from g1_viewer.models import SimulationSnapshot
from g1_viewer.policies import PolicyRegistry, PolicyRunnerManager


def main() -> int:
    sample_path = REPO_ROOT / "examples" / "sample_data" / "twist2_demo.pkl"
    manifest_dir = REPO_ROOT / "policy_manifests"

    registry = PolicyRegistry(manifest_dir)
    manager = PolicyRunnerManager(registry)

    sequence = load_sequence(str(sample_path))
    policy_inputs = {
        "robot_state": {
            "root_position": sequence.frames[0].root_translation,
            "root_rotation_wxyz": sequence.frames[0].root_rotation_wxyz,
            "joint_positions": sequence.frames[0].joint_positions,
            "joint_velocities": sequence.frames[0].joint_velocities,
        },
        "reference_target": {
            "target_root_position": sequence.frames[0].root_translation,
            "target_root_rotation_wxyz": sequence.frames[0].root_rotation_wxyz,
            "target_joint_positions": sequence.frames[0].joint_positions,
            "target_joint_velocities": sequence.frames[0].joint_velocities,
        },
        "frame_index": 0,
        "dt": 0.0,
    }
    snapshot = SimulationSnapshot(
        timestamp=sequence.frames[0].timestamp,
        state=sequence.frames[0],
        metadata={"policy_inputs": policy_inputs},
    )

    print("available policies:", [policy.policy_id for policy in manager.list_policies()])
    print("start:", manager.start("mock_g1_policy"))
    print("step:", manager.mock_step("mock_g1_policy", snapshot))
    manager.stop("mock_g1_policy")
    print("stopped mock_g1_policy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
