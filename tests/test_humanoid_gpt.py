from __future__ import annotations

from pathlib import Path
import unittest

import numpy as np


class _FakeNode:
    def __init__(self, name: str, shape: list[int], type_name: str = "tensor(float)") -> None:
        self.name = name
        self.shape = shape
        self.type = type_name


class _FakeSession:
    def __init__(self) -> None:
        self.feeds: list[dict[str, np.ndarray]] = []

    def get_inputs(self) -> list[_FakeNode]:
        return [_FakeNode("obs", [1, 136])]

    def get_outputs(self) -> list[_FakeNode]:
        return [_FakeNode("continuous_actions", [1, 29])]

    def run(self, output_names: list[str], feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.feeds.append({key: value.copy() for key, value in feeds.items()})
        return [np.full((1, 29), 0.5, dtype=np.float32)]


def _state_payload(joint_names: list[str], default_joint_pos: np.ndarray, *, joint_offset: float, root_x: float) -> dict:
    return {
        "joint_names": joint_names,
        "state": {
            "joint_positions": (default_joint_pos + joint_offset).tolist(),
            "joint_velocities": np.full(29, 0.2, dtype=np.float32).tolist(),
            "root_translation": [root_x, 0.0, 0.78],
            "root_rotation_wxyz": [1.0, 0.0, 0.0, 0.0],
            "root_linear_velocity": [0.1, 0.0, 0.0],
            "root_angular_velocity": [0.0, 0.0, 0.3],
        },
    }


class HumanoidGPTBackendTest(unittest.TestCase):
    def test_builds_136_obs_and_caches_last_action(self) -> None:
        from g1_viewer.humanoid_gpt import (
            HUMANOID_GPT_ACTION_SCALE,
            HUMANOID_GPT_DEFAULT_JOINT_POS,
            HUMANOID_GPT_JOINT_NAMES,
            HumanoidGPTBackend,
        )

        fake_session = _FakeSession()
        default_joint_pos = np.asarray(HUMANOID_GPT_DEFAULT_JOINT_POS, dtype=np.float32)
        action_scale = np.asarray(HUMANOID_GPT_ACTION_SCALE, dtype=np.float32)
        backend = HumanoidGPTBackend(
            model_path=Path("unused.onnx"),
            session_factory=lambda _path: fake_session,
            max_cached_states=2,
        )
        payload = {
            "cache_id": "policy-cache",
            "reset_cache": True,
            "current_state": _state_payload(HUMANOID_GPT_JOINT_NAMES, default_joint_pos, joint_offset=0.1, root_x=0.0),
            "ref_curr": _state_payload(HUMANOID_GPT_JOINT_NAMES, default_joint_pos, joint_offset=0.2, root_x=1.0),
            "ref_next": _state_payload(HUMANOID_GPT_JOINT_NAMES, default_joint_pos, joint_offset=0.3, root_x=1.1),
        }

        first = backend.infer(payload)
        second = backend.infer({**payload, "reset_cache": False})

        self_obs = fake_session.feeds[0]["obs"]
        cached_obs = fake_session.feeds[1]["obs"]
        self.assertEqual(self_obs.shape, (1, 136))
        self.assertEqual(self_obs.dtype, np.float32)
        np.testing.assert_allclose(self_obs[0, 64:93], np.zeros(29, dtype=np.float32))
        np.testing.assert_allclose(cached_obs[0, 64:93], np.full(29, 0.5, dtype=np.float32))
        np.testing.assert_allclose(first["actions"], np.full(29, 0.5, dtype=np.float32))
        np.testing.assert_allclose(
            first["joint_positions"],
            default_joint_pos + 0.5 * 0.25 * action_scale,
        )
        self.assertEqual(first["cache_id"], "policy-cache")
        self.assertEqual(second["cache_id"], "policy-cache")
        self.assertEqual(first["input_names"], ["obs"])
        self.assertEqual(first["output_names"], ["continuous_actions"])

    def test_limits_cached_states(self) -> None:
        from g1_viewer.humanoid_gpt import (
            HUMANOID_GPT_DEFAULT_JOINT_POS,
            HUMANOID_GPT_JOINT_NAMES,
            HumanoidGPTBackend,
        )

        fake_session = _FakeSession()
        default_joint_pos = np.asarray(HUMANOID_GPT_DEFAULT_JOINT_POS, dtype=np.float32)
        payload = {
            "current_state": _state_payload(HUMANOID_GPT_JOINT_NAMES, default_joint_pos, joint_offset=0.0, root_x=0.0),
            "ref_curr": _state_payload(HUMANOID_GPT_JOINT_NAMES, default_joint_pos, joint_offset=0.0, root_x=0.0),
            "ref_next": _state_payload(HUMANOID_GPT_JOINT_NAMES, default_joint_pos, joint_offset=0.0, root_x=0.0),
            "reset_cache": True,
        }
        backend = HumanoidGPTBackend(
            model_path=Path("unused.onnx"),
            session_factory=lambda _path: fake_session,
            max_cached_states=2,
        )

        for cache_id in ["a", "b", "c"]:
            backend.infer({**payload, "cache_id": cache_id})

        self.assertEqual(list(backend._states.keys()), ["b", "c"])


if __name__ == "__main__":
    unittest.main()
