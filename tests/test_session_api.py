from __future__ import annotations

import json
import math
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from g1_viewer.api import create_app
from g1_viewer.importers import detect_format as importer_detect_format
from g1_viewer.models import CanonicalRobotState, SimulationSnapshot
from g1_viewer.session import SessionController


REPO_ROOT = Path(__file__).resolve().parent.parent
SONIC_SAMPLE = REPO_ROOT / "examples" / "sample_data" / "sonic_demo"
TWIST2_SAMPLE = REPO_ROOT / "examples" / "sample_data" / "twist2_demo.pkl"


class SessionControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()

    def tearDown(self) -> None:
        self.controller.shutdown()

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
        expected = [
            float(position) + 0.05 * math.sin(10.001 * 2.0 + index * 0.3)
            for index, position in enumerate(frame.joint_positions)
        ]

        self.assertNotEqual(initial_state.joint_positions, refreshed_state.joint_positions)
        self.assertEqual(summary_after_seek.last_policy_result, {})
        self.assertEqual(len(expected), len(refreshed_state.joint_positions))
        for actual, target in zip(refreshed_state.joint_positions, expected):
            self.assertAlmostEqual(actual, target, places=6)

    def test_toggle_physics_reset_flag_is_consumed_once(self) -> None:
        self.controller.toggle_physics(True)

        self.assertTrue(self.controller.consume_physics_reset_flag())
        self.assertFalse(self.controller.consume_physics_reset_flag())

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

    def test_load_clip_resets_physics_related_session_state(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.seek(1)
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        summary = self.controller.get_session_summary()

        self.assertFalse(summary.physics_enabled)
        self.assertIsNone(summary.active_policy_id)
        self.assertEqual(summary.view_mode, "dataset")
        self.assertEqual(summary.last_observation_summary, {})
        self.assertEqual(summary.last_action_summary, {})

    def test_load_clip_logs_policy_stop_for_manual_policy(self) -> None:
        self.controller.start_policy("mock_g1_policy")

        summary = self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        logs = " ".join(self.controller.get_session_summary().last_log_messages).lower()

        self.assertEqual(summary.source_format, "twist2")
        self.assertIn("policy stopped", logs)


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

    def test_browser_list_rejects_missing_root(self) -> None:
        with TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "never-created-child"
            response = self.client.post("/api/browser/list", json={"path": str(missing_path)})
            self.assertEqual(response.status_code, 400)
            self.assertIn("Path does not exist", response.text)

    def test_browser_list_keeps_nested_twist2_dirs_expandable(self) -> None:
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

            root_response = self.client.post("/api/browser/list", json={"path": str(temp_root)})
            self.assertEqual(root_response.status_code, 200)
            root_nodes = {node["name"]: node for node in root_response.json()["nodes"]}
            self.assertIn("pack", root_nodes)
            self.assertEqual(root_nodes["pack"]["node_type"], "directory")
            self.assertTrue(root_nodes["pack"]["has_children"])
            self.assertNotIn("motion.json", root_nodes)

            pack_response = self.client.post("/api/browser/list", json={"path": str(pack_dir)})
            self.assertEqual(pack_response.status_code, 200)
            pack_nodes = {node["name"]: node for node in pack_response.json()["nodes"]}
            self.assertIn("sub", pack_nodes)
            self.assertEqual(pack_nodes["sub"]["node_type"], "directory")
            self.assertTrue(pack_nodes["sub"]["has_children"])
            self.assertNotIn("motion.json", pack_nodes)

            sub_response = self.client.post("/api/browser/list", json={"path": str(sub_dir)})
            self.assertEqual(sub_response.status_code, 200)
            sub_nodes = {node["name"]: node for node in sub_response.json()["nodes"]}
            self.assertIn("motion.json", sub_nodes)
            self.assertEqual(sub_nodes["motion.json"]["node_type"], "motion")
            self.assertEqual(sub_nodes["motion.json"]["format"], "twist2")

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

            def detect_format_guard(path: Path) -> str | None:
                if path.is_dir():
                    raise AssertionError(f"detect_format called on directory: {path}")
                return importer_detect_format(path)

            with patch("g1_viewer.browser.detect_format", side_effect=detect_format_guard):
                response = self.client.post("/api/browser/list", json={"path": str(temp_root)})

            self.assertEqual(response.status_code, 200)
            nodes = {node["name"]: node for node in response.json()["nodes"]}
            self.assertIn("pack", nodes)
            self.assertEqual(nodes["pack"]["node_type"], "directory")
            self.assertTrue(nodes["pack"]["has_children"])


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
