from __future__ import annotations

import json
import re
import time
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from g1_viewer.api import create_app
from g1_viewer.importers import detect_format as importer_detect_format, load_sequence
from g1_viewer.models import (
    CanonicalRobotState,
    SimulationSnapshot,
    ViewerImpulseRequest,
    ViewerInteractionSummary,
)
from g1_viewer.policies import PolicyRegistry, _resolve_runner_path, _slugify
from g1_viewer.session import SessionController


REPO_ROOT = Path(__file__).resolve().parent.parent
SONIC_SAMPLE = REPO_ROOT / "examples" / "sample_data" / "sonic_demo"
TWIST2_SAMPLE = REPO_ROOT / "examples" / "sample_data" / "twist2_demo.pkl"


def _twist2_policy_id_for_model(model_path: Path) -> str:
    model_stem = _slugify(model_path.stem)
    return model_stem if model_stem.startswith("twist2_") else f"twist2_{model_stem}"


class PolicyPluginRegistryTest(unittest.TestCase):
    def test_discovers_policy_json_inside_policy_plugin_folders(self) -> None:
        with TemporaryDirectory() as temp_dir:
            plugin_dir = Path(temp_dir) / "demo_browser_policy"
            plugin_dir.mkdir()
            manifest_path = plugin_dir / "policy.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "policy_id": "demo_browser_policy",
                        "display_name": "Demo Browser Policy",
                        "robot_type": "g1",
                        "runtime": "browser",
                        "framework": "onnx",
                        "config_path": "/examples/checkpoints/g1/tracking_policy_latest.json",
                        "control_mode": "joint_position_target",
                    }
                ),
                encoding="utf-8",
            )

            policies = PolicyRegistry(Path(temp_dir)).discover()

            self.assertEqual([policy.policy_id for policy in policies], ["demo_browser_policy"])
            self.assertEqual(policies[0].runtime, "browser")
            self.assertEqual(policies[0].framework, "onnx")
            self.assertEqual(policies[0].manifest_path, str(manifest_path))
            self.assertEqual(policies[0].plugin_path, str(plugin_dir))

    def test_relative_python_entrypoint_resolves_from_plugin_folder(self) -> None:
        with TemporaryDirectory() as temp_dir:
            plugin_dir = Path(temp_dir) / "demo_python_policy"
            plugin_dir.mkdir()
            runner_path = plugin_dir / "runner.py"
            runner_path.write_text("print('runner')\n", encoding="utf-8")
            (plugin_dir / "policy.json").write_text(
                json.dumps(
                    {
                        "policy_id": "demo_python_policy",
                        "display_name": "Demo Python Policy",
                        "robot_type": "g1",
                        "runtime": "python_subprocess",
                        "framework": "python",
                        "env_python": "__CURRENT_PYTHON__",
                        "entrypoint": "runner.py",
                        "control_mode": "joint_position_target",
                    }
                ),
                encoding="utf-8",
            )

            manifest = PolicyRegistry(Path(temp_dir)).discover()[0]
            command = _resolve_runner_path(manifest)

            self.assertEqual(Path(command[1]), runner_path.resolve())

    def test_policy_format_folder_generates_a_policy_for_each_onnx_model(self) -> None:
        with TemporaryDirectory() as temp_dir:
            plugin_dir = Path(temp_dir) / "twist2"
            plugin_dir.mkdir()
            (plugin_dir / "tracking_policy_latest.json").write_text(
                json.dumps({"onnx": {"path": "./template.onnx"}, "policy_joint_names": ["joint_a"]}),
                encoding="utf-8",
            )
            (plugin_dir / "policy_latest.onnx").write_bytes(b"default model")
            (plugin_dir / "walk_fast.onnx").write_bytes(b"new model")
            (plugin_dir / "policy_format.json").write_text(
                json.dumps(
                    {
                        "format_id": "twist2",
                        "display_name": "Twist2 Tracking",
                        "robot_type": "g1",
                        "runtime": "browser",
                        "framework": "onnx",
                        "control_mode": "joint_position_target",
                        "config_template": "tracking_policy_latest.json",
                        "policy_id_prefix": "twist2",
                        "display_name_i18n": {
                            "zh": "Twist2 追踪",
                            "en": "Twist2 Tracking",
                        },
                        "description_i18n": {
                            "zh": "Twist2 浏览器 ONNX 策略。",
                            "en": "Twist2 browser ONNX policy.",
                        },
                        "model_overrides": {
                            "policy_latest.onnx": {
                                "policy_id": "twist2_default",
                                "display_name": "Twist2 Default",
                                "display_name_i18n": {
                                    "zh": "Twist2 默认",
                                    "en": "Twist2 Default",
                                },
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            policies = PolicyRegistry(Path(temp_dir)).discover()
            by_id = {policy.policy_id: policy for policy in policies}

            self.assertEqual(set(by_id), {"twist2_default", "twist2_walk_fast"})
            self.assertEqual(by_id["twist2_default"].display_name, "Twist2 Default")
            self.assertEqual(by_id["twist2_default"].display_name_i18n["zh"], "Twist2 默认")
            self.assertEqual(by_id["twist2_walk_fast"].display_name, "Twist2 Tracking / walk_fast")
            self.assertEqual(by_id["twist2_walk_fast"].display_name_i18n["en"], "Twist2 Tracking / walk_fast")
            self.assertEqual(by_id["twist2_walk_fast"].description_i18n["zh"], "Twist2 浏览器 ONNX 策略。")
            self.assertEqual(by_id["twist2_walk_fast"].format_id, "twist2")
            self.assertEqual(by_id["twist2_walk_fast"].model_file, "walk_fast.onnx")
            self.assertEqual(by_id["twist2_walk_fast"].config_path, "/api/policy-plugins/twist2_walk_fast/config")

    def test_policy_registry_rediscovers_new_onnx_models_after_initial_list(self) -> None:
        with TemporaryDirectory() as temp_dir:
            plugin_dir = Path(temp_dir) / "twist2"
            plugin_dir.mkdir()
            (plugin_dir / "tracking_policy_latest.json").write_text(
                json.dumps({"onnx": {"meta": {"in_keys": ["policy"]}}, "policy_joint_names": ["joint_a"]}),
                encoding="utf-8",
            )
            (plugin_dir / "first.onnx").write_bytes(b"first model")
            (plugin_dir / "policy_format.json").write_text(
                json.dumps(
                    {
                        "format_id": "twist2",
                        "display_name": "Twist2 Tracking",
                        "robot_type": "g1",
                        "runtime": "browser",
                        "framework": "onnx",
                        "config_template": "tracking_policy_latest.json",
                        "policy_id_prefix": "twist2",
                    }
                ),
                encoding="utf-8",
            )

            registry = PolicyRegistry(Path(temp_dir))
            self.assertEqual([policy.policy_id for policy in registry.list()], ["twist2_first"])

            (plugin_dir / "second.onnx").write_bytes(b"second model")

            policy_ids = {policy.policy_id for policy in registry.list()}
            self.assertEqual(policy_ids, {"twist2_first", "twist2_second"})
            config = registry.policy_config("twist2_second")
            self.assertEqual(config["onnx"]["path"], "/policy-plugins/twist2/second.onnx")

    def test_policy_format_config_rewrites_onnx_path_for_selected_model(self) -> None:
        with TemporaryDirectory() as temp_dir:
            plugin_dir = Path(temp_dir) / "twist2"
            plugin_dir.mkdir()
            (plugin_dir / "tracking_policy_latest.json").write_text(
                json.dumps({"onnx": {"meta": {"in_keys": ["policy"]}}, "policy_joint_names": ["joint_a"]}),
                encoding="utf-8",
            )
            (plugin_dir / "walk_fast.onnx").write_bytes(b"new model")
            (plugin_dir / "policy_format.json").write_text(
                json.dumps(
                    {
                        "format_id": "twist2",
                        "display_name": "Twist2 Tracking",
                        "robot_type": "g1",
                        "runtime": "browser",
                        "framework": "onnx",
                        "config_template": "tracking_policy_latest.json",
                        "policy_id_prefix": "twist2",
                    }
                ),
                encoding="utf-8",
            )

            registry = PolicyRegistry(Path(temp_dir))
            registry.discover()
            config = registry.policy_config("twist2_walk_fast")

            self.assertEqual(config["onnx"]["path"], "/policy-plugins/twist2/walk_fast.onnx")
            self.assertEqual(config["policy_joint_names"], ["joint_a"])


class SessionControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_backend_policy_loop_uses_50hz_control_interval(self) -> None:
        self.assertEqual(self.controller._policy_step_interval, 1.0 / 50.0)

    def test_load_seek_and_tick_dataset_sequence(self) -> None:
        items = self.controller.scan_path(str(SONIC_SAMPLE))
        self.assertEqual(len(items), 1)

        sequence = self.controller.load_clip(str(SONIC_SAMPLE), "sonic")
        self.assertEqual(sequence.source_format, "sonic")

        summary = self.controller.get_session_summary()
        self.assertEqual(summary.active_sequence.sequence_id, sequence.sequence_id)
        self.assertEqual(summary.current_frame, 0)
        self.assertEqual(summary.trim_end, sequence.frame_count - 1)
        self.assertEqual(summary.view_mode, "dataset")

        self.controller.seek(2)
        self.assertEqual(self.controller.get_session_summary().current_frame, 2)

        self.controller.set_loop(True)
        self.controller.play(now=10.0)
        self.controller.tick(now=10.08)
        advanced = self.controller.get_session_summary()
        self.assertEqual(advanced.playback_state, "playing")
        self.assertEqual(advanced.current_frame, 2)

        self.controller.tick(now=10.12)
        wrapped = self.controller.get_session_summary()
        self.assertLess(wrapped.current_frame, sequence.frame_count)
        self.assertTrue(wrapped.loop_enabled)

    def test_non_loop_playback_resets_to_first_frame_when_complete(self) -> None:
        sequence = self.controller.load_clip(str(SONIC_SAMPLE), "sonic")

        self.controller.play(now=10.0)
        self.controller.tick(now=20.0)
        summary = self.controller.get_session_summary()

        self.assertEqual(summary.playback_state, "stopped")
        self.assertEqual(summary.current_frame, 0)
        self.assertFalse(summary.loop_enabled)
        self.assertGreater(sequence.frame_count, 1)

    def test_start_and_stop_policy_updates_view_mode(self) -> None:
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")

        start_result = self.controller.start_policy("mock_g1_policy")
        self.assertEqual(start_result["policy_id"], "mock_g1_policy")

        stepped_state = self.controller.tick(now=time.monotonic())
        self.assertGreater(len(stepped_state.joint_positions), 0)

        summary = self.controller.get_session_summary()
        self.assertEqual(summary.view_mode, "policy")
        self.assertEqual(summary.active_policy_id, "mock_g1_policy")
        self.assertEqual(summary.playback_state, "paused")

        self.controller.stop_policy()
        stopped = self.controller.get_session_summary()
        self.assertEqual(stopped.view_mode, "dataset")
        self.assertIsNone(stopped.active_policy_id)


class SessionStateSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(SONIC_SAMPLE), "sonic")

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_toggle_physics_updates_summary_and_logs(self) -> None:
        summary = self.controller.toggle_physics(True)
        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.active_policy_id, "mock_g1_policy")
        self.assertEqual(summary.view_mode, "policy")
        enabled_logs = " ".join(summary.last_log_messages).lower()
        self.assertIn("physics enabled", enabled_logs)
        self.assertNotIn("policy started", enabled_logs)

        summary = self.controller.toggle_physics(False)
        self.assertFalse(summary.physics_enabled)
        self.assertIsNone(summary.active_policy_id)
        self.assertEqual(summary.view_mode, "dataset")
        disabled_logs = " ".join(summary.last_log_messages).lower()
        self.assertIn("physics disabled", disabled_logs)
        self.assertNotIn("policy stopped", disabled_logs)

    def test_seek_while_physics_on_keeps_session_state_consistent(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.seek(2)
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.current_frame, 2)
        self.assertIn("seek", " ".join(summary.last_log_messages).lower())
        self.assertEqual(summary.last_observation_summary, {})
        self.assertEqual(summary.last_action_summary, {})

    def test_seek_while_physics_on_forces_immediate_policy_refresh(self) -> None:
        self.controller.toggle_physics(True)
        initial_state = self.controller.tick(now=10.0)
        self.controller.seek(2)
        summary_after_seek = self.controller.get_session_summary()

        refreshed_state = self.controller.tick(now=10.001)
        sequence_id = self.controller.get_session_summary().active_sequence.sequence_id
        frame = self.controller.get_sequence(sequence_id).frames[2]

        self.assertNotEqual(initial_state.joint_positions, refreshed_state.joint_positions)
        self.assertEqual(summary_after_seek.last_policy_result, {})
        self.assertEqual(refreshed_state.joint_positions, frame.joint_positions)

    def test_toggle_physics_reset_flag_is_consumed_once(self) -> None:
        self.controller.toggle_physics(True)

        self.assertTrue(self.controller.consume_physics_reset_flag())
        self.assertFalse(self.controller.consume_physics_reset_flag())

    def test_prepare_physics_reset_resets_runner_and_returns_reference_state(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.seek(2)

        with patch.object(self.controller._policy_manager, "reset", wraps=self.controller._policy_manager.reset) as reset_mock:
            reference = self.controller.prepare_physics_reset(now=12.0)

        self.assertIsNotNone(reference)
        self.assertEqual(reference.metadata["frame_index"], 2)
        reset_mock.assert_called_once()
        self.assertFalse(self.controller.consume_physics_reset_flag())

    def test_stop_while_physics_enabled_requests_reset_and_clears_simulated_state(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.update_simulated_state(
            CanonicalRobotState(
                timestamp=1.0,
                root_translation=[0.0, 0.0, 0.78],
                joint_positions=[0.2, -0.1, 0.3],
                joint_velocities=[0.0, 0.0, 0.0],
            )
        )

        summary = self.controller.stop()

        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.current_frame, 0)
        self.assertTrue(self.controller.consume_physics_reset_flag())
        self.assertIsNone(self.controller.simulated_state())

    def test_tick_returns_simulated_state_and_advances_playback_in_physics_mode(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.play(now=10.0)
        simulated_state = CanonicalRobotState(
            timestamp=10.0,
            root_translation=[0.0, 0.0, 0.78],
            joint_positions=[0.4, -0.3, 0.2],
            joint_velocities=[0.0, 0.0, 0.0],
        )
        self.controller.update_simulated_state(simulated_state)

        state = self.controller.tick(now=10.04)
        summary = self.controller.get_session_summary()

        self.assertEqual(state.joint_positions, simulated_state.joint_positions)
        self.assertGreater(summary.current_frame, 0)

    def test_start_policy_enters_coherent_policy_runtime_mode(self) -> None:
        self.controller.start_policy("mock_g1_policy")
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.active_policy_id, "mock_g1_policy")
        self.assertEqual(summary.view_mode, "policy")

    def test_start_policy_marks_reset_and_logs_lifecycle(self) -> None:
        self.controller.start_policy("mock_g1_policy")
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertTrue(self.controller.consume_physics_reset_flag())
        self.assertFalse(self.controller.consume_physics_reset_flag())
        self.assertIn("policy started", " ".join(summary.last_log_messages).lower())

    def test_stop_policy_after_physics_enable_keeps_summary_coherent(self) -> None:
        self.controller.toggle_physics(True)
        summary = self.controller.stop_policy()

        self.assertFalse(summary.physics_enabled)
        self.assertIsNone(summary.active_policy_id)
        self.assertEqual(summary.view_mode, "dataset")
        self.assertEqual(summary.last_observation_summary, {})
        self.assertEqual(summary.last_action_summary, {})

    def test_stop_policy_marks_reset_and_logs_lifecycle(self) -> None:
        self.controller.start_policy("mock_g1_policy")
        self.assertTrue(self.controller.consume_physics_reset_flag())
        summary = self.controller.stop_policy()

        self.assertFalse(summary.physics_enabled)
        self.assertIsNone(summary.active_policy_id)
        self.assertEqual(summary.view_mode, "dataset")
        self.assertTrue(self.controller.consume_physics_reset_flag())
        self.assertFalse(self.controller.consume_physics_reset_flag())
        self.assertIn("policy stopped", " ".join(summary.last_log_messages).lower())

    def test_repeated_stop_policy_preserves_pending_reset(self) -> None:
        self.controller.start_policy("mock_g1_policy")
        self.assertTrue(self.controller.consume_physics_reset_flag())

        self.controller.stop_policy()
        self.controller.stop_policy()

        self.assertTrue(self.controller.consume_physics_reset_flag())
        self.assertFalse(self.controller.consume_physics_reset_flag())

    def test_toggle_physics_off_logs_policy_stop_for_manual_policy(self) -> None:
        self.controller.start_policy("mock_g1_policy")

        summary = self.controller.toggle_physics(False)
        logs = " ".join(summary.last_log_messages).lower()

        self.assertFalse(summary.physics_enabled)
        self.assertIsNone(summary.active_policy_id)
        self.assertIn("policy stopped", logs)
        self.assertIn("physics disabled", logs)

    def test_load_clip_preserves_enabled_physics_runtime(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.seek(1)
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.active_policy_id, "mock_g1_policy")
        self.assertEqual(summary.view_mode, "policy")
        self.assertEqual(summary.current_frame, 0)
        self.assertEqual(summary.last_observation_summary, {})
        self.assertEqual(summary.last_action_summary, {})
        self.assertTrue(self.controller.consume_physics_reset_flag())

    def test_load_clip_logs_policy_stop_for_manual_policy(self) -> None:
        self.controller.start_policy("mock_g1_policy")

        summary = self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        logs = " ".join(self.controller.get_session_summary().last_log_messages).lower()

        self.assertEqual(summary.source_format, "twist2")
        self.assertIn("policy stopped", logs)

    def test_twist2_loader_detects_xyzw_root_rot(self) -> None:
        with TemporaryDirectory() as temp_dir:
            motion_path = Path(temp_dir) / "xyzw_motion.json"
            motion_path.write_text(
                json.dumps(
                    {
                        "fps": 50,
                        "root_pos": [[0.0, 0.0, 0.78], [0.1, 0.0, 0.78]],
                        "root_rot": [
                            [0.0, 0.0, 0.0, 1.0],
                            [0.0, 0.0, 0.70710678, 0.70710678],
                        ],
                        "dof_pos": [[0.0], [0.1]],
                    }
                )
            )

            sequence = load_sequence(str(motion_path), "twist2")

        self.assertEqual(sequence.metadata["root_rot_order"], "xyzw")
        self.assertEqual(sequence.frames[0].root_rotation_wxyz, [1.0, 0.0, 0.0, 0.0])
        self.assertAlmostEqual(sequence.frames[1].root_rotation_wxyz[0], 0.70710678)
        self.assertAlmostEqual(sequence.frames[1].root_rotation_wxyz[3], 0.70710678)

    def test_twist2_loader_detects_wxyz_root_rot(self) -> None:
        with TemporaryDirectory() as temp_dir:
            motion_path = Path(temp_dir) / "wxyz_motion.json"
            motion_path.write_text(
                json.dumps(
                    {
                        "fps": 50,
                        "root_pos": [[0.0, 0.0, 0.78], [0.1, 0.0, 0.78]],
                        "root_rot": [
                            [1.0, 0.0, 0.0, 0.0],
                            [0.70710678, 0.0, 0.0, 0.70710678],
                        ],
                        "dof_pos": [[0.0], [0.1]],
                    }
                )
            )

            sequence = load_sequence(str(motion_path), "twist2")

        self.assertEqual(sequence.metadata["root_rot_order"], "wxyz")
        self.assertEqual(sequence.frames[0].root_rotation_wxyz, [1.0, 0.0, 0.0, 0.0])
        self.assertAlmostEqual(sequence.frames[1].root_rotation_wxyz[0], 0.70710678)
        self.assertAlmostEqual(sequence.frames[1].root_rotation_wxyz[3], 0.70710678)


class ViewerTestStateControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_session_summary_exposes_default_viewer_and_test_state(self) -> None:
        summary = self.controller.get_session_summary()

        self.assertEqual(summary.playback_state, "empty")
        self.assertIsNone(summary.active_sequence)
        self.assertFalse(summary.viewer_interaction.drag_active)
        self.assertEqual(summary.viewer_interaction.perturb_mode, "none")
        self.assertFalse(summary.test_state.pending_impulse)
        self.assertEqual(summary.test_state.last_impulse_command, {})

    def test_queue_viewer_impulse_updates_summary(self) -> None:
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.mark_viewer_connected(True)
        self.controller.toggle_physics(True)

        summary = self.controller.queue_viewer_impulse(
            ViewerImpulseRequest(preset="push_forward", magnitude=90.0, duration=0.25)
        )

        self.assertTrue(summary.test_state.pending_impulse)
        self.assertEqual(summary.test_state.last_test_event, "impulse queued")
        self.assertEqual(summary.test_state.last_impulse_command["preset"], "push_forward")

    def test_loading_new_clip_clears_stale_viewer_and_test_state(self) -> None:
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.mark_viewer_connected(True)
        self.controller.toggle_physics(True)
        self.controller.set_viewer_interaction(
            ViewerInteractionSummary(
                drag_active=True,
                selected_body_id=1,
                selected_body_name="pelvis",
                perturb_mode="translate",
                force_magnitude=32.0,
                last_drag_timestamp=12.0,
            )
        )
        self.controller.queue_viewer_impulse(
            ViewerImpulseRequest(preset="push_left", magnitude=60.0, duration=0.15)
        )

        self.controller.load_clip(str(SONIC_SAMPLE), "sonic")
        summary = self.controller.get_session_summary()

        self.assertFalse(summary.viewer_interaction.drag_active)
        self.assertEqual(summary.viewer_interaction.perturb_mode, "none")
        self.assertFalse(summary.test_state.pending_impulse)
        self.assertEqual(summary.test_state.last_impulse_command, {})

    def test_disconnect_blocks_stale_viewer_callbacks_from_repopulating_state(self) -> None:
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.mark_viewer_connected(True)
        self.controller.toggle_physics(True)
        self.controller.mark_viewer_connected(False)

        self.controller.set_viewer_interaction(
            ViewerInteractionSummary(
                drag_active=True,
                selected_body_id=2,
                selected_body_name="torso",
                perturb_mode="rotate",
                force_magnitude=48.0,
                last_drag_timestamp=4.0,
            )
        )
        self.controller.mark_viewer_test_result(event="late callback", status="complete")
        summary = self.controller.get_session_summary()

        self.assertFalse(summary.viewer_interaction.drag_active)
        self.assertEqual(summary.viewer_interaction.perturb_mode, "none")
        self.assertEqual(summary.test_state.last_test_event, "")
        self.assertEqual(summary.test_state.last_test_status, "")

    def test_reset_transition_blocks_stale_viewer_callbacks_from_repopulating_state(self) -> None:
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.mark_viewer_connected(True)
        self.controller.toggle_physics(True)
        self.controller.toggle_physics(False)

        self.controller.set_viewer_interaction(
            ViewerInteractionSummary(
                drag_active=True,
                selected_body_id=3,
                selected_body_name="pelvis",
                perturb_mode="translate",
                force_magnitude=12.0,
                last_drag_timestamp=8.0,
            )
        )
        self.controller.mark_viewer_test_result(event="late callback", status="complete")
        summary = self.controller.get_session_summary()

        self.assertFalse(summary.viewer_interaction.drag_active)
        self.assertEqual(summary.viewer_interaction.perturb_mode, "none")
        self.assertEqual(summary.test_state.last_test_event, "")
        self.assertEqual(summary.test_state.last_test_status, "")


class ControlPanelApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_control_panel_session_endpoints(self) -> None:
        session = self.client.get("/api/session")
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.json()["playback_state"], "empty")

        scan = self.client.post("/api/scan", json={"path": str(SONIC_SAMPLE)})
        self.assertEqual(scan.status_code, 200)
        self.assertEqual(len(scan.json()["items"]), 1)

        load = self.client.post("/api/load_clip", json={"path": str(SONIC_SAMPLE), "format": "sonic"})
        self.assertEqual(load.status_code, 200)
        sequence = load.json()["sequence"]

        seek = self.client.post("/api/playback/seek", json={"frame_index": 1})
        self.assertEqual(seek.status_code, 200)
        self.assertEqual(seek.json()["current_frame"], 1)

        trim_start = self.client.post("/api/playback/trim_start", json={"frame_index": 1})
        trim_end = self.client.post("/api/playback/trim_end", json={"frame_index": 2})
        self.assertEqual(trim_start.status_code, 200)
        self.assertEqual(trim_end.status_code, 200)
        self.assertEqual(trim_end.json()["trim_end"], 2)

        loop = self.client.post("/api/playback/loop", json={"enabled": True})
        self.assertEqual(loop.status_code, 200)
        self.assertTrue(loop.json()["loop_enabled"])

        policies = self.client.get("/api/policies")
        self.assertEqual(policies.status_code, 200)
        self.assertGreaterEqual(len(policies.json()["policies"]), 1)

        start_policy = self.client.post("/api/policies/start", json={"policy_id": "mock_g1_policy"})
        self.assertEqual(start_policy.status_code, 200)

        mock_step = self.client.post("/api/policies/mock_step", json={"policy_id": "mock_g1_policy"})
        self.assertEqual(mock_step.status_code, 200)
        self.assertIn("mode", mock_step.json()["result"])

        export = self.client.post(
            "/api/trim_export",
            json={
                "sequence_id": sequence["sequence_id"],
                "start_frame": 1,
                "end_frame": 2,
            },
        )
        self.assertEqual(export.status_code, 200)
        self.assertTrue(Path(export.json()["output_path"]).exists())

        stop_policy = self.client.post("/api/policies/stop", json={"policy_id": "mock_g1_policy"})
        self.assertEqual(stop_policy.status_code, 200)

        summary = self.client.get("/api/session").json()
        self.assertEqual(summary["view_mode"], "dataset")
        self.assertEqual(summary["current_frame"], 1)


class GroupedApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_grouped_session_and_policy_endpoints_share_state(self) -> None:
        load = self.client.post("/api/session/load", json={"path": str(SONIC_SAMPLE), "format": "sonic"})
        self.assertEqual(load.status_code, 200)

        seek = self.client.post("/api/session/playback", json={"action": "seek", "frame_index": 1})
        self.assertEqual(seek.status_code, 200)
        self.assertEqual(seek.json()["current_frame"], 1)

        trim = self.client.post("/api/session/trim", json={"action": "set_start", "frame_index": 1})
        self.assertEqual(trim.status_code, 200)
        self.assertEqual(trim.json()["trim_start"], 1)

        physics = self.client.post("/api/session/physics", json={"enabled": True})
        self.assertEqual(physics.status_code, 200)
        self.assertTrue(physics.json()["physics_enabled"])

        activate = self.client.post("/api/policies/active", json={"policy_id": "mock_g1_policy"})
        self.assertEqual(activate.status_code, 200)

        step = self.client.post("/api/policies/step", json={"policy_id": "mock_g1_policy"})
        self.assertEqual(step.status_code, 200)
        self.assertIn("mode", step.json()["result"])

    def test_policy_plugins_endpoint_lists_browser_and_python_plugins(self) -> None:
        response = self.client.get("/api/policy-plugins")

        self.assertEqual(response.status_code, 200)
        policies = response.json()["policies"]
        policy_ids = {policy["policy_id"] for policy in policies}
        twist2_models = sorted((REPO_ROOT / "policy_plugins" / "twist2").glob("*.onnx"))
        expected_twist2_policy_ids = {_twist2_policy_id_for_model(model_path) for model_path in twist2_models}
        self.assertIn("mock_passthrough", policy_ids)
        self.assertIn("motion_tracking", policy_ids)
        self.assertGreaterEqual(len(expected_twist2_policy_ids), 2)
        self.assertTrue(expected_twist2_policy_ids.issubset(policy_ids))
        self.assertIn("mock_g1_policy", policy_ids)
        self.assertNotIn("g1_tracking_onnx", policy_ids)
        onnx_policy = next(policy for policy in policies if policy["policy_id"] == "motion_tracking")
        self.assertEqual(onnx_policy["runtime"], "browser")
        self.assertEqual(onnx_policy["framework"], "onnx")
        self.assertEqual(
            onnx_policy["config_path"],
            "/api/policy-plugins/motion_tracking/config",
        )
        self.assertEqual(onnx_policy["format_id"], "motion_tracking")
        self.assertEqual(onnx_policy["model_file"], "policy_latest.onnx")
        self.assertEqual(onnx_policy["display_name_i18n"]["zh"], "运动追踪")
        by_id = {policy["policy_id"]: policy for policy in policies}
        sonic_policy = by_id["sonic"]
        self.assertEqual(sonic_policy["runtime"], "browser")
        self.assertEqual(sonic_policy["framework"], "custom_js")
        self.assertEqual(sonic_policy["module_path"], "./SonicPolicy.js")
        self.assertEqual(sonic_policy["config_path"], "/policy-plugins/sonic/sonic_policy.json")
        for model_path in twist2_models:
            policy_id = _twist2_policy_id_for_model(model_path)
            twist2_policy = by_id[policy_id]
            self.assertEqual(twist2_policy["format_id"], "twist2")
            self.assertEqual(twist2_policy["model_file"], model_path.name)
            self.assertEqual(twist2_policy["display_name_i18n"]["zh"], f"Twist2 / {model_path.stem}")

    def test_policy_plugin_assets_are_served_from_the_policy_folder(self) -> None:
        config_response = self.client.get("/policy-plugins/motion_tracking/tracking_policy_latest.json")
        self.assertEqual(config_response.status_code, 200)
        self.assertEqual(config_response.json()["onnx"]["path"], "./policy_latest.onnx")

        twist2_config_response = self.client.get("/policy-plugins/twist2/tracking_policy_latest.json")
        self.assertEqual(twist2_config_response.status_code, 200)
        self.assertNotIn("path", twist2_config_response.json()["onnx"])

        model_response = self.client.get("/policy-plugins/motion_tracking/policy_latest.onnx")
        self.assertEqual(model_response.status_code, 200)
        self.assertEqual(model_response.headers["content-type"], "application/octet-stream")
        self.assertGreater(len(model_response.content), 1024)

        twist2_model_response = self.client.get("/policy-plugins/twist2/twist2_1017_25k.onnx")
        self.assertEqual(twist2_model_response.status_code, 200)
        self.assertEqual(twist2_model_response.headers["content-type"], "application/octet-stream")
        self.assertGreater(len(twist2_model_response.content), 1024)

    def test_policy_plugin_dynamic_config_points_to_the_selected_model(self) -> None:
        response = self.client.get("/api/policy-plugins/motion_tracking/config")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["onnx"]["path"], "/policy-plugins/motion_tracking/policy_latest.onnx")
        self.assertIn("policy_joint_names", payload)

        for model_path in sorted((REPO_ROOT / "policy_plugins" / "twist2").glob("*.onnx")):
            policy_id = _twist2_policy_id_for_model(model_path)
            twist2_response = self.client.get(f"/api/policy-plugins/{policy_id}/config")

            self.assertEqual(twist2_response.status_code, 200)
            twist2_payload = twist2_response.json()
            self.assertEqual(twist2_payload["onnx"]["path"], f"/policy-plugins/twist2/{model_path.name}")
            self.assertIn("policy_joint_names", twist2_payload)

    def test_session_state_endpoint_returns_current_state_and_joint_names(self) -> None:
        self.client.post("/api/session/load", json={"path": str(SONIC_SAMPLE), "format": "sonic"})
        self.client.post("/api/session/playback", json={"action": "seek", "frame_index": 1})

        state_response = self.client.get("/api/session/state")

        self.assertEqual(state_response.status_code, 200)
        payload = state_response.json()
        self.assertEqual(payload["frame_index"], 1)
        self.assertGreater(len(payload["joint_names"]), 0)
        self.assertEqual(len(payload["state"]["joint_positions"]), len(payload["joint_names"]))

    def test_session_state_endpoint_reports_frame_index_after_tick(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})
        self.controller.play(now=0.0)
        self.controller._last_playback_time = time.monotonic() - 0.5

        state_response = self.client.get("/api/session/state")

        self.assertEqual(state_response.status_code, 200)
        payload = state_response.json()
        self.assertEqual(payload["frame_index"], payload["state"]["metadata"]["frame_index"])
        self.assertGreater(payload["frame_index"], 0)

    def test_session_summary_advances_playback_without_full_state_polling(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})
        self.controller.play(now=0.0)
        self.controller._last_playback_time = time.monotonic() - 0.5

        summary_response = self.client.get("/api/session")

        self.assertEqual(summary_response.status_code, 200)
        payload = summary_response.json()
        self.assertGreater(payload["current_frame"], 0)

    def test_legacy_playback_seek_alias_still_works(self) -> None:
        self.client.post("/api/session/load", json={"path": str(SONIC_SAMPLE), "format": "sonic"})
        response = self.client.post("/api/playback/seek", json={"frame_index": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["current_frame"], 2)

    def test_grouped_policy_active_requires_explicit_policy_id_or_null(self) -> None:
        self.client.post("/api/session/load", json={"path": str(SONIC_SAMPLE), "format": "sonic"})
        self.client.post("/api/policies/start", json={"policy_id": "mock_g1_policy"})

        typo_response = self.client.post("/api/policies/active", json={"policyId": "mock_g1_policy"})
        self.assertEqual(typo_response.status_code, 422)
        self.assertEqual(self.client.get("/api/session").json()["active_policy_id"], "mock_g1_policy")

        stop_response = self.client.post("/api/policies/active", json={"policy_id": None})
        self.assertEqual(stop_response.status_code, 200)
        self.assertIsNone(self.client.get("/api/session").json()["active_policy_id"])

    def test_grouped_validation_matches_legacy_aliases(self) -> None:
        grouped_seek = self.client.post("/api/session/playback", json={"action": "seek"})
        legacy_seek = self.client.post("/api/playback/seek", json={})
        self.assertEqual(grouped_seek.status_code, 422)
        self.assertEqual(legacy_seek.status_code, 422)

        grouped_trim = self.client.post("/api/session/trim", json={"action": "set_start"})
        legacy_trim = self.client.post("/api/playback/trim_start", json={})
        self.assertEqual(grouped_trim.status_code, 422)
        self.assertEqual(legacy_trim.status_code, 422)

        grouped_step = self.client.post("/api/policies/step", json={})
        legacy_step = self.client.post("/api/policies/mock_step", json={})
        self.assertEqual(grouped_step.status_code, 422)
        self.assertEqual(legacy_step.status_code, 422)


class ViewerTestApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_impulse_endpoint_requires_connected_viewer(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})

        response = self.client.post(
            "/api/viewer/test/impulse",
            json={"preset": "push_forward", "magnitude": 80.0, "duration": 0.15},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Viewer is not connected", response.text)

    def test_impulse_endpoint_requires_enabled_physics(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})
        self.controller.mark_viewer_connected(True)

        response = self.client.post(
            "/api/viewer/test/impulse",
            json={"preset": "push_forward", "magnitude": 80.0, "duration": 0.15},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Physics must be enabled", response.text)

    def test_impulse_endpoint_updates_session_summary(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})
        self.controller.mark_viewer_connected(True)
        self.client.post("/api/session/physics", json={"enabled": True})

        response = self.client.post(
            "/api/viewer/test/impulse",
            json={"preset": "push_right", "magnitude": 120.0, "duration": 0.2},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["test_state"]["pending_impulse"])
        self.assertEqual(payload["test_state"]["last_impulse_command"]["preset"], "push_right")

    def test_reset_endpoint_clears_test_state(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})
        self.controller.mark_viewer_connected(True)
        self.client.post("/api/session/physics", json={"enabled": True})
        self.controller.set_viewer_interaction(
            ViewerInteractionSummary(
                drag_active=True,
                selected_body_id=3,
                selected_body_name="pelvis",
                perturb_mode="translate",
                force_magnitude=42.0,
                last_drag_timestamp=9.0,
            )
        )
        self.client.post(
            "/api/viewer/test/impulse",
            json={"preset": "lift_up", "magnitude": 70.0, "duration": 0.1},
        )

        response = self.client.post("/api/viewer/test/reset")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["test_state"]["pending_impulse"])
        self.assertFalse(payload["viewer_interaction"]["drag_active"])
        self.assertEqual(payload["test_state"]["last_impulse_command"], {})
        self.assertEqual(payload["test_state"]["last_test_event"], "")
        self.assertEqual(payload["test_state"]["last_test_status"], "")


class RootPageSmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_root_page_contains_rebuilt_console_sections(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn('id="app"', body)
        self.assertIn("G1 Unified Viewer", body)
        self.assertIn('type="module"', body)

    def test_browser_scene_manifest_endpoint(self) -> None:
        response = self.client.get("/api/assets/browser-scene")
        self.assertEqual(response.status_code, 200)
        payload = response.json()

        self.assertEqual(payload["robot"], "g1")
        self.assertEqual(payload["scene_path"], "g1/g1.xml")
        self.assertEqual(payload["files_index_url"], "/examples/scenes/files.json")
        self.assertIn("g1/g1.xml", payload["files"])
        self.assertIn("g1/meshes/pelvis.STL", payload["files"])

    def test_browser_scene_groundplane_uses_classic_blue_checker_texture(self) -> None:
        scene_path = REPO_ROOT / "frontend" / "public" / "examples" / "scenes" / "g1" / "g1.xml"
        root = ET.parse(scene_path).getroot()
        groundplane = root.find(".//asset/texture[@name='groundplane']")

        self.assertIsNotNone(groundplane)
        self.assertEqual(groundplane.get("rgb1"), "0.2 0.3 0.4")
        self.assertEqual(groundplane.get("rgb2"), "0.1 0.2 0.3")
        self.assertEqual(groundplane.get("markrgb"), "0.8 0.8 0.8")

    def test_frontend_favicon_endpoint(self) -> None:
        response = self.client.get("/favicon.ico")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/vnd.microsoft.icon")

    def test_root_page_preserves_console_dom_contract(self) -> None:
        frontend_source = REPO_ROOT / "frontend" / "src" / "App.vue"
        body = frontend_source.read_text(encoding="utf-8")

        for control_id in ("resetStanceButton", "contactForceToggleButton", "cameraPresetSelect", "dragPane"):
            self.assertIn(f'id="{control_id}"', body)
        for removed_test_control_id in ("resetTestButton", "impulseMagnitudeInput", "impulseDurationInput"):
            self.assertNotIn(f'id="{removed_test_control_id}"', body)

        for legacy_id in (
            "pathInput",
            "scanButton",
            "playButton",
            "pauseButton",
            "stopButton",
            "timeline",
            "frameInput",
            "seekButton",
            "trimStartInput",
            "trimEndInput",
            "markTrimStartButton",
            "markTrimEndButton",
            "trimSummary",
            "exportButton",
            "policyList",
            "physicsToggleButton",
            "viewerBadge",
            "modeBadge",
            "playbackBadge",
            "treeRoot",
            "treeStatus",
            "clipSummary",
            "commandStatus",
            "policyStatus",
            "policyList",
            "evaluationPanel",
            "logPane",
            "observationPane",
            "actionPane",
        ):
            self.assertIn(f'id="{legacy_id}"', body)

        self.assertIn("switchSelectedPolicy(policy.policy_id)", body)
        self.assertIn(':disabled="policyDisabled(policy)"', body)

        camera_options = re.findall(r"\{ value: '([^']+)', label: t\('evaluation\.camera[^']+'\) \}", body)
        self.assertEqual(camera_options, ["default", "front", "side", "back", "top"])

    def test_root_page_script_avoids_policy_list_rebuild_during_session_poll(self) -> None:
        frontend_source = REPO_ROOT / "frontend" / "src" / "App.vue"
        body = frontend_source.read_text(encoding="utf-8")

        self.assertIn("function syncPolicyCardStates()", body)
        render_session_match = re.search(
            r"function renderSession\(\) \{(?P<body>.*?)\n\}",
            body,
            re.DOTALL,
        )
        self.assertIsNotNone(render_session_match)
        self.assertNotIn("renderPolicies();", render_session_match.group("body"))


class ReadmeSmokeTest(unittest.TestCase):
    def test_readme_mentions_dual_interface_and_physics_modes(self) -> None:
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("FastAPI", readme)
        self.assertIn("浏览器 MuJoCo", readme)
        self.assertIn("关闭 Physics", readme)
        self.assertIn("开启 Physics", readme)


class BrowserApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_browser_list_returns_directory_and_motion_nodes(self) -> None:
        sample_root = REPO_ROOT / "examples" / "sample_data"
        response = self.client.post("/api/browser/list", json={"path": str(sample_root)})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        nodes = {node["name"]: node for node in payload["nodes"]}

        self.assertIn("sonic_demo", nodes)
        self.assertIn("twist2_demo.pkl", nodes)
        self.assertEqual(nodes["sonic_demo"]["node_type"], "motion")
        self.assertEqual(nodes["sonic_demo"]["format"], "sonic")
        self.assertFalse(nodes["sonic_demo"]["has_children"])
        self.assertEqual(nodes["twist2_demo.pkl"]["node_type"], "motion")
        self.assertEqual(nodes["twist2_demo.pkl"]["format"], "twist2")

    def test_browser_list_returns_only_current_directory_level(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            pack_dir = temp_root / "pack"
            sub_dir = pack_dir / "sub"
            sub_dir.mkdir(parents=True)
            motion_file = sub_dir / "motion.json"
            motion_file.write_text(
                json.dumps(
                    {
                        "root_pos": [[0.0, 0.0, 0.0]],
                        "root_rot": [[0.0, 0.0, 0.0, 1.0]],
                        "dof_pos": [[0.0]],
                    }
                )
            )

            response = self.client.post("/api/browser/list", json={"path": str(temp_root)})

            self.assertEqual(response.status_code, 200)
            root_nodes = {node["name"]: node for node in response.json()["nodes"]}
            self.assertIn("pack", root_nodes)
            pack_node = root_nodes["pack"]
            self.assertEqual(pack_node["node_type"], "directory")
            self.assertTrue(pack_node["has_children"])
            self.assertEqual(pack_node["children"], [])
            self.assertNotIn("pack/sub", root_nodes)

            sub_response = self.client.post("/api/browser/list", json={"path": str(pack_dir)})
            self.assertEqual(sub_response.status_code, 200)
            self.assertEqual(sub_response.json()["parent"], str(temp_root.resolve()))
            sub_nodes = {node["name"]: node for node in sub_response.json()["nodes"]}
            self.assertIn("sub", sub_nodes)
            sub_node = sub_nodes["sub"]
            self.assertEqual(sub_node["name"], "sub")
            self.assertEqual(sub_node["relative_path"], "sub")
            self.assertEqual(sub_node["node_type"], "directory")
            self.assertTrue(sub_node["has_children"])
            self.assertEqual(sub_node["children"], [])

            motion_response = self.client.post("/api/browser/list", json={"path": str(sub_dir)})
            self.assertEqual(motion_response.status_code, 200)
            self.assertEqual(motion_response.json()["parent"], str(pack_dir.resolve()))
            motion_nodes = {node["name"]: node for node in motion_response.json()["nodes"]}
            motion_node = motion_nodes["motion.json"]
            self.assertEqual(motion_node["name"], "motion.json")
            self.assertEqual(motion_node["relative_path"], "motion.json")
            self.assertEqual(motion_node["node_type"], "motion")
            self.assertEqual(motion_node["format"], "twist2")

    def test_browser_list_returns_parent_for_navigation(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            child_dir = temp_root / "child"
            child_dir.mkdir()
            (child_dir / "motion.pkl").write_bytes(b"placeholder")

            response = self.client.post("/api/browser/list", json={"path": str(child_dir)})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["root"], str(child_dir.resolve()))
            self.assertEqual(response.json()["parent"], str(temp_root.resolve()))

    def test_browser_list_lazily_enters_nested_sonic_motion_dirs(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            library_dir = temp_root / "library"
            dance_dir = library_dir / "dance"
            motion_dir = temp_root / "library" / "dance" / "take_01"
            motion_dir.mkdir(parents=True)
            (motion_dir / "joint_pos.csv").write_text("hip\n0.0\n")

            response = self.client.post("/api/browser/list", json={"path": str(temp_root)})

            self.assertEqual(response.status_code, 200)
            library_node = response.json()["nodes"][0]
            self.assertEqual(library_node["name"], "library")
            self.assertEqual(library_node["node_type"], "directory")
            self.assertTrue(library_node["has_children"])
            self.assertEqual(library_node["children"], [])

            library_response = self.client.post("/api/browser/list", json={"path": str(library_dir)})
            self.assertEqual(library_response.status_code, 200)
            dance_node = library_response.json()["nodes"][0]
            self.assertEqual(dance_node["name"], "dance")
            self.assertEqual(dance_node["node_type"], "directory")
            self.assertTrue(dance_node["has_children"])
            self.assertEqual(dance_node["children"], [])

            dance_response = self.client.post("/api/browser/list", json={"path": str(dance_dir)})
            self.assertEqual(dance_response.status_code, 200)
            motion_node = dance_response.json()["nodes"][0]
            self.assertEqual(motion_node["name"], "take_01")
            self.assertEqual(motion_node["relative_path"], "take_01")
            self.assertEqual(motion_node["path"], str(motion_dir.resolve()))
            self.assertEqual(motion_node["node_type"], "motion")
            self.assertEqual(motion_node["format"], "sonic")

    def test_browser_list_rejects_missing_root(self) -> None:
        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "never-created-child"
            response = self.client.post("/api/browser/list", json={"path": str(missing_path)})
            self.assertEqual(response.status_code, 400)
            self.assertIn("Path does not exist", response.text)

    def test_browser_list_clears_stale_session_items_after_scan(self) -> None:
        scan_response = self.client.post("/api/scan", json={"path": str(SONIC_SAMPLE)})
        self.assertEqual(scan_response.status_code, 200)
        self.assertGreater(len(scan_response.json()["items"]), 0)

        sample_root = REPO_ROOT / "examples" / "sample_data"
        browser_response = self.client.post("/api/browser/list", json={"path": str(sample_root)})
        self.assertEqual(browser_response.status_code, 200)

        session_response = self.client.get("/api/session")
        self.assertEqual(session_response.status_code, 200)
        self.assertEqual(session_response.json()["items"], [])

    def test_browser_list_does_not_detect_format_on_directories(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            pack_dir = temp_root / "pack"
            sub_dir = pack_dir / "sub"
            sub_dir.mkdir(parents=True)
            motion_file = sub_dir / "motion.json"
            motion_file.write_text(
                json.dumps(
                    {
                        "root_pos": [[0.0, 0.0, 0.0]],
                        "root_rot": [[0.0, 0.0, 0.0, 1.0]],
                        "dof_pos": [[0.0]],
                    }
                )
            )

            def fast_format_guard(path: Path) -> str | None:
                if path.is_dir():
                    raise AssertionError(f"browser format detection called on directory: {path}")
                return "twist2" if path.suffix.lower() == ".json" else None

            with patch("g1_viewer.browser._fast_motion_format", side_effect=fast_format_guard):
                response = self.client.post("/api/browser/list", json={"path": str(temp_root)})

            self.assertEqual(response.status_code, 200)
            nodes = {node["name"]: node for node in response.json()["nodes"]}
            self.assertIn("pack", nodes)
            self.assertEqual(nodes["pack"]["node_type"], "directory")
            self.assertTrue(nodes["pack"]["has_children"])

    def test_browser_list_detects_twist2_by_extension_without_sniffing_payloads(self) -> None:
        with TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            motion_file = temp_root / "huge_motion.pkl"
            motion_file.write_bytes(b"not a pickle and should not be opened during scan")

            response = self.client.post("/api/browser/list", json={"path": str(temp_root)})

            self.assertEqual(response.status_code, 200)
            nodes = response.json()["nodes"]
            self.assertEqual(len(nodes), 1)
            self.assertEqual(nodes[0]["name"], "huge_motion.pkl")
            self.assertEqual(nodes[0]["node_type"], "motion")
            self.assertEqual(nodes[0]["format"], "twist2")


class TrimExportApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_trim_export_can_force_sonic_to_custom_output_dir_without_format_subdir(self) -> None:
        with TemporaryDirectory() as temp_dir:
            sequence = self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
            output_dir = Path(temp_dir) / "clips"

            response = self.client.post(
                "/api/trim_export",
                json={
                    "sequence_id": sequence.sequence_id,
                    "start_frame": 0,
                    "end_frame": 1,
                    "export_format": "sonic",
                    "output_dir": str(output_dir),
                },
            )

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            output_path = Path(payload["output_path"])
            self.assertEqual(payload["export_format"], "sonic")
            self.assertEqual(output_path.parent, output_dir)
            self.assertTrue((output_path / "joint_pos.csv").exists())
            self.assertFalse((output_dir / "sonic").exists())

    def test_trim_export_can_force_twist2_extension_to_custom_output_dir(self) -> None:
        with TemporaryDirectory() as temp_dir:
            sequence = self.controller.load_clip(str(SONIC_SAMPLE), "sonic")
            output_dir = Path(temp_dir) / "clips"

            response = self.client.post(
                "/api/trim_export",
                json={
                    "sequence_id": sequence.sequence_id,
                    "start_frame": 0,
                    "end_frame": 1,
                    "export_format": "twist2",
                    "output_dir": str(output_dir),
                    "twist2_extension": ".json",
                },
            )

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            output_path = Path(payload["output_path"])
            self.assertEqual(payload["export_format"], "twist2")
            self.assertEqual(output_path.parent, output_dir)
            self.assertEqual(output_path.suffix, ".json")
            self.assertTrue(output_path.exists())
            self.assertFalse((output_dir / "twist2").exists())


class PolicyStepSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_step_policy_with_snapshot_does_not_require_active_clip(self) -> None:
        snapshot = SimulationSnapshot(
            timestamp=1.5,
            state=CanonicalRobotState(
                timestamp=1.5,
                root_translation=[0.0, 0.0, 0.78],
                joint_positions=[0.1, -0.2, 0.3],
                joint_velocities=[0.0, 0.0, 0.0],
            ),
            metadata={"source": "explicit_snapshot"},
        )

        result = self.controller.step_policy("mock_g1_policy", snapshot=snapshot, now=1.5)
        summary = self.controller.get_session_summary()

        self.assertEqual(result["mode"], "joint_position_target")
        self.assertEqual(len(result["values"]), 3)
        self.assertIsNone(summary.active_sequence)
        self.assertEqual(summary.active_policy_id, "mock_g1_policy")
        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.playback_state, "empty")

    def test_tick_after_snapshot_step_keeps_snapshot_state_as_base(self) -> None:
        snapshot = SimulationSnapshot(
            timestamp=1.5,
            state=CanonicalRobotState(
                timestamp=1.5,
                root_translation=[0.0, 0.0, 0.78],
                joint_positions=[0.1, -0.2, 0.3],
                joint_velocities=[0.0, 0.0, 0.0],
            ),
            metadata={"source": "explicit_snapshot"},
        )

        self.controller.step_policy("mock_g1_policy", snapshot=snapshot, now=1.5)
        state = self.controller.tick(now=1.6)

        self.assertEqual(len(state.joint_positions), 3)
        self.assertNotEqual(state.joint_positions, [])


class MockPolicyContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.toggle_physics(True)

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_mock_policy_uses_robot_state_and_reference_target(self) -> None:
        result = self.controller.physics_step(self.controller.reference_state(), now=time.monotonic())
        summary = self.controller.get_session_summary()

        self.assertEqual(result["mode"], "joint_position_target")
        self.assertIn("robot_state", summary.last_observation_summary)
        self.assertIn("reference_target", summary.last_observation_summary)
        self.assertIn("target_joint_positions", summary.last_observation_summary["reference_target"])
        self.assertEqual(
            len(result["values"]),
            len(summary.last_observation_summary["reference_target"]["target_joint_positions"]),
        )


class PhysicsRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.toggle_physics(True)

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_physics_step_populates_action_and_observation_summaries(self) -> None:
        robot_state = self.controller.reference_state()
        result = self.controller.physics_step(robot_state, now=time.monotonic())
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertEqual(result["mode"], "joint_position_target")
        self.assertIn("robot_state", summary.last_observation_summary)
        self.assertEqual(summary.last_action_summary["mode"], "joint_position_target")
        self.assertGreater(summary.last_action_summary["value_count"], 0)


if __name__ == "__main__":
    unittest.main()
