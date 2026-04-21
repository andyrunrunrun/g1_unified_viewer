from __future__ import annotations

import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from g1_viewer.api import create_app
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


if __name__ == "__main__":
    unittest.main()
