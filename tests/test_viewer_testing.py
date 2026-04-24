from types import SimpleNamespace
import unittest
from unittest.mock import patch

import mujoco
import numpy as np

from g1_viewer.viewer_runtime import _update_active_impulse
from g1_viewer.viewer_testing import ActiveImpulse
from g1_viewer.viewer_testing import apply_impulse_wrench, summarize_perturbation


class ViewerTestingHelpersTest(unittest.TestCase):
    def test_summarize_perturbation_reports_translate_drag(self) -> None:
        model = object()
        data = SimpleNamespace(
            xfrc_applied=np.array(
                [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 4.0, 0.0, 0.0, 0.0, 0.0],
                dtype=float,
            )
        )
        perturb = SimpleNamespace(
            select=1,
            active=int(mujoco.mjtPertBit.mjPERT_TRANSLATE),
            active2=0,
        )

        with patch("g1_viewer.viewer_testing.mujoco.mj_id2name", return_value="pelvis"):
            summary = summarize_perturbation(model, data, perturb, now=12.0)

        self.assertTrue(summary.drag_active)
        self.assertEqual(summary.selected_body_id, 1)
        self.assertEqual(summary.selected_body_name, "pelvis")
        self.assertEqual(summary.perturb_mode, "translate")
        self.assertAlmostEqual(summary.force_magnitude, 5.0)

    def test_apply_impulse_wrench_writes_force_to_target_body_slot(self) -> None:
        data = SimpleNamespace(xfrc_applied=np.zeros(12, dtype=float))

        apply_impulse_wrench(data, body_id=1, force=np.array([10.0, -2.0, 3.0], dtype=float))

        np.testing.assert_allclose(data.xfrc_applied[6:9], [10.0, -2.0, 3.0])
        np.testing.assert_allclose(data.xfrc_applied[9:12], [0.0, 0.0, 0.0])

    def test_update_active_impulse_expires_without_xfrc_array(self) -> None:
        controller = SimpleNamespace()
        result_calls: list[tuple[str, str]] = []

        def mark_viewer_test_result(*, event: str, status: str) -> None:
            result_calls.append((event, status))

        controller.mark_viewer_test_result = mark_viewer_test_result
        active_impulse = ActiveImpulse(
            body_id=1,
            force=np.array([10.0, 0.0, 0.0], dtype=float),
            expires_at=4.0,
        )

        next_impulse = _update_active_impulse(
            controller,
            SimpleNamespace(),
            active_impulse,
            tick_now=5.0,
        )

        self.assertIsNone(next_impulse)
        self.assertEqual(result_calls, [("impulse completed", "idle")])
