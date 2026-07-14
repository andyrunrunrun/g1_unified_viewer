from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import scripts.download_humanoid_gpt as downloader


class HumanoidGPTDownloaderTest(unittest.TestCase):
    def test_installs_local_snapshot_and_generates_browser_config(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            snapshot = root / "snapshot"
            ckpt_dir = snapshot / "storage" / "ckpts"
            ckpt_dir.mkdir(parents=True)
            (ckpt_dir / "pns_wo_priv216.onnx").write_bytes(b"fake humanoid gpt onnx")

            plugin_dir = root / "plugin"
            config_path = plugin_dir / "humanoid_gpt_policy_config.json"
            model_path = plugin_dir / "model.onnx"
            fake_meta = {
                "in_keys": ["obs"],
                "out_keys": ["continuous_actions"],
                "input_shapes": {"obs": [1, 136]},
                "output_shapes": {"continuous_actions": [1, 29]},
                "input_dtypes": {"obs": "float32"},
                "output_dtypes": {"continuous_actions": "float32"},
            }

            with (
                patch.object(downloader, "PLUGIN_DIR", plugin_dir),
                patch.object(downloader, "CONFIG_PATH", config_path),
                patch.object(downloader, "MODEL_PATH", model_path),
                patch.object(downloader, "_read_onnx_session_metadata", return_value=fake_meta),
            ):
                installed = downloader.install_assets(snapshot)

            self.assertEqual(installed, model_path)
            self.assertEqual(model_path.read_bytes(), b"fake humanoid gpt onnx")
            payload = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["onnx"]["path"], "./model.onnx")
            self.assertEqual(payload["onnx"]["meta"]["in_keys"], ["obs"])
            self.assertEqual(payload["onnx"]["meta"]["out_keys"], ["continuous_actions"])
            self.assertEqual(payload["onnx"]["meta"]["input_shapes"]["obs"], [1, 136])
            self.assertEqual(len(payload["policy_joint_names"]), 29)
            self.assertEqual(len(payload["default_joint_pos"]), 29)
            self.assertEqual(len(payload["action_scale"]), 29)
            self.assertEqual(payload["humanoid_gpt"]["source_repo"], downloader.REPO_ID)
            self.assertEqual(payload["humanoid_gpt"]["checkpoint_path"], downloader.CHECKPOINT_REPO_PATH)

    def test_validation_failure_preserves_existing_installation(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            ckpt_dir = root / "snapshot" / "storage" / "ckpts"
            ckpt_dir.mkdir(parents=True)
            (ckpt_dir / "pns_wo_priv216.onnx").write_bytes(b"invalid new onnx")
            plugin_dir = root / "plugin"
            plugin_dir.mkdir()
            model_path = plugin_dir / "model.onnx"
            config_path = plugin_dir / "humanoid_gpt_policy_config.json"
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
