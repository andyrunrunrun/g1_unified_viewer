from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import scripts.download_holomotion_v13 as downloader


class HoloMotionV13DownloaderTest(unittest.TestCase):
    def test_installs_local_snapshot_and_generates_browser_config(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            snapshot = root / "snapshot"
            model_root = snapshot / downloader.MODEL_FOLDER
            exported = model_root / "exported"
            exported.mkdir(parents=True)
            (exported / "policy.onnx").write_bytes(b"fake onnx")
            source_config_text = (
                "obs:\n"
                "  n_fut_frames: 7\n"
                "robot:\n"
                "  actuators:\n"
                "    all_joints:\n"
                "      effort_limit_sim:\n"
                "        .*_hip_pitch_joint: 88.0\n"
                "        joint_1: 12.5\n"
            )
            (model_root / "config.yaml").write_text(source_config_text, encoding="utf-8")
            plugin_dir = root / "plugin"
            config_path = plugin_dir / "holomotion_v13_policy_config.json"
            model_path = plugin_dir / "model.onnx"

            joint_names = ["left_hip_pitch_joint", "joint_1", *[f"joint_{idx}" for idx in range(2, 29)]]
            fake_meta = {
                "joint_names": joint_names,
                "default_joint_pos": [0.01 * idx for idx in range(29)],
                "action_scale": [1.0 for _ in range(29)],
                "stiffness": [10.0 for _ in range(29)],
                "damping": [1.0 for _ in range(29)],
                "onnx_meta": {
                    "in_keys": ["policy_obs"],
                    "out_keys": ["policy_actions"],
                    "input_shapes": {"policy_obs": [1, 522]},
                    "kv_dtype": "float32",
                },
            }

            with (
                patch.object(downloader, "PLUGIN_DIR", plugin_dir),
                patch.object(downloader, "CONFIG_PATH", config_path),
                patch.object(downloader, "MODEL_PATH", model_path),
                patch.object(downloader, "_read_onnx_session_metadata", return_value=fake_meta),
            ):
                installed = downloader.install_assets(snapshot)

            self.assertEqual(installed, model_path)
            self.assertEqual(model_path.read_bytes(), b"fake onnx")
            raw_config = config_path.read_text(encoding="utf-8")
            self.assertNotIn("Infinity", raw_config)
            payload = json.loads(raw_config, parse_constant=lambda value: self.fail(f"non-standard JSON: {value}"))
            self.assertEqual(payload["onnx"]["path"], "./model.onnx")
            self.assertEqual(payload["onnx"]["meta"]["in_keys"], ["policy_obs"])
            self.assertEqual(payload["policy_joint_names"], joint_names)
            self.assertEqual(payload["torque_limits"][0], 88.0)
            self.assertEqual(payload["torque_limits"][1], 12.5)
            self.assertEqual(payload["holomotion"]["version"], "1.3.0")
            self.assertEqual(payload["holomotion"]["n_fut_frames"], 7)

    def test_missing_source_config_uses_defaults_and_removes_stale_copy(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            model_root = root / "snapshot" / downloader.MODEL_FOLDER / "exported"
            model_root.mkdir(parents=True)
            (model_root / "policy.onnx").write_bytes(b"new onnx")
            plugin_dir = root / "plugin"
            plugin_dir.mkdir()
            (plugin_dir / "source_config.yaml").write_text("obs:\n  n_fut_frames: 3\n", encoding="utf-8")
            model_path = plugin_dir / "model.onnx"
            config_path = plugin_dir / "holomotion_v13_policy_config.json"
            fake_meta = {
                "joint_names": [f"joint_{idx}" for idx in range(29)],
                "default_joint_pos": [0.0] * 29,
                "action_scale": [1.0] * 29,
                "stiffness": [10.0] * 29,
                "damping": [1.0] * 29,
                "onnx_meta": {"in_keys": ["obs"], "out_keys": ["actions"]},
            }

            with (
                patch.object(downloader, "PLUGIN_DIR", plugin_dir),
                patch.object(downloader, "CONFIG_PATH", config_path),
                patch.object(downloader, "MODEL_PATH", model_path),
                patch.object(downloader, "_read_onnx_session_metadata", return_value=fake_meta),
            ):
                downloader.install_assets(root / "snapshot")

            payload = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["holomotion"]["n_fut_frames"], 10)
            self.assertFalse((plugin_dir / "source_config.yaml").exists())

    def test_validation_failure_preserves_existing_installation(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            model_root = root / "snapshot" / downloader.MODEL_FOLDER / "exported"
            model_root.mkdir(parents=True)
            (model_root / "policy.onnx").write_bytes(b"invalid new onnx")
            plugin_dir = root / "plugin"
            plugin_dir.mkdir()
            model_path = plugin_dir / "model.onnx"
            config_path = plugin_dir / "holomotion_v13_policy_config.json"
            model_path.write_bytes(b"working old onnx")
            config_path.write_text('{"working": true}\n', encoding="utf-8")

            with (
                patch.object(downloader, "PLUGIN_DIR", plugin_dir),
                patch.object(downloader, "CONFIG_PATH", config_path),
                patch.object(downloader, "MODEL_PATH", model_path),
                patch.object(downloader, "_read_onnx_session_metadata", side_effect=RuntimeError("invalid model")),
                self.assertRaisesRegex(RuntimeError, "invalid model"),
            ):
                downloader.install_assets(root / "snapshot")

            self.assertEqual(model_path.read_bytes(), b"working old onnx")
            self.assertEqual(config_path.read_text(encoding="utf-8"), '{"working": true}\n')


if __name__ == "__main__":
    unittest.main()
