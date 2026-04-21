from __future__ import annotations

import time
from pathlib import Path

import glfw
import mujoco
import mujoco.viewer
import numpy as np

from .config import resolve_g1_model_path
from .models import CanonicalRobotState
from .session import SessionController


class NativeViewerRuntime:
    def __init__(
        self,
        controller: SessionController,
        *,
        model_path: Path | None = None,
        show_left_ui: bool = True,
        show_right_ui: bool = True,
        target_hz: float = 60.0,
    ) -> None:
        self.controller = controller
        self.model_path = model_path or resolve_g1_model_path()
        self.show_left_ui = show_left_ui
        self.show_right_ui = show_right_ui
        self.target_hz = max(10.0, float(target_hz))
        self.model = mujoco.MjModel.from_xml_path(str(self.model_path))
        self.data = mujoco.MjData(self.model)

    def run(self) -> None:
        with mujoco.viewer.launch_passive(
            self.model,
            self.data,
            key_callback=self._on_key,
            show_left_ui=self.show_left_ui,
            show_right_ui=self.show_right_ui,
        ) as handle:
            self.controller.mark_viewer_connected(True)
            self._configure_camera(handle.cam)
            try:
                while handle.is_running():
                    state = self.controller.tick()
                    summary = self.controller.get_session_summary()
                    with handle.lock():
                        self._apply_state(state)
                        mujoco.mj_forward(self.model, self.data)
                        handle.set_texts(
                            [
                                (
                                    None,
                                    mujoco.mjtGridPos.mjGRID_TOPLEFT,
                                    self._left_overlay(summary),
                                    self._right_overlay(summary),
                                )
                            ]
                        )
                        self.controller.update_camera(
                            lookat=np.asarray(handle.cam.lookat, dtype=float).tolist(),
                            distance=float(handle.cam.distance),
                            azimuth=float(handle.cam.azimuth),
                            elevation=float(handle.cam.elevation),
                        )
                    handle.sync()
                    time.sleep(1.0 / self.target_hz)
            finally:
                self.controller.mark_viewer_connected(False)

    def _configure_camera(self, camera: mujoco.MjvCamera) -> None:
        camera.type = mujoco.mjtCamera.mjCAMERA_FREE
        camera.distance = 3.2
        camera.azimuth = 140.0
        camera.elevation = -20.0
        camera.lookat[:] = np.array([0.0, 0.0, 0.8], dtype=float)

    def _apply_state(self, state: CanonicalRobotState) -> None:
        self.data.qpos[:] = 0.0
        self.data.qvel[:] = 0.0

        root_translation = np.asarray(state.root_translation or [0.0, 0.0, 0.78], dtype=float)
        root_rotation = np.asarray(state.root_rotation_wxyz or [1.0, 0.0, 0.0, 0.0], dtype=float)
        joint_positions = np.asarray(state.joint_positions, dtype=float)
        joint_velocities = (
            np.asarray(state.joint_velocities, dtype=float)
            if state.joint_velocities
            else np.zeros_like(joint_positions)
        )

        self.data.qpos[:3] = root_translation[:3]
        self.data.qpos[3:7] = root_rotation[:4]
        joint_qpos_len = min(len(joint_positions), self.model.nq - 7)
        joint_qvel_len = min(len(joint_velocities), self.model.nv - 6)
        self.data.qpos[7 : 7 + joint_qpos_len] = joint_positions[:joint_qpos_len]
        self.data.qvel[6 : 6 + joint_qvel_len] = joint_velocities[:joint_qvel_len]

    def _on_key(self, keycode: int) -> None:
        try:
            if keycode == glfw.KEY_SPACE:
                self.controller.toggle_play_pause()
            elif keycode == glfw.KEY_LEFT:
                summary = self.controller.get_session_summary()
                self.controller.seek(max(0, summary.current_frame - 1))
            elif keycode == glfw.KEY_RIGHT:
                summary = self.controller.get_session_summary()
                self.controller.seek(summary.current_frame + 1)
            elif keycode in {glfw.KEY_R, glfw.KEY_HOME}:
                self.controller.stop()
            elif keycode == glfw.KEY_LEFT_BRACKET:
                self.controller.set_trim_start_to_current()
            elif keycode == glfw.KEY_RIGHT_BRACKET:
                self.controller.set_trim_end_to_current()
            elif keycode == glfw.KEY_N:
                self.controller.next_clip()
            elif keycode == glfw.KEY_P:
                self.controller.previous_clip()
            elif keycode == glfw.KEY_L:
                self.controller.toggle_loop()
            self.controller.set_last_error(None)
        except Exception as exc:
            self.controller.set_last_error(str(exc))

    def _left_overlay(self, summary) -> str:
        sequence_name = summary.active_sequence.name if summary.active_sequence else "No clip loaded"
        frame_count = summary.active_sequence.frame_count if summary.active_sequence else 0
        return "\n".join(
            [
                f"Clip: {sequence_name}",
                f"Frame: {summary.current_frame}/{max(frame_count - 1, 0)}",
                f"Playback: {summary.playback_state} | Loop: {summary.loop_enabled}",
                f"View: {summary.view_mode} | Policy: {summary.active_policy_id or '-'}",
                f"Trim: {summary.trim_start} -> {summary.trim_end}",
            ]
        )

    def _right_overlay(self, summary) -> str:
        return "\n".join(
            [
                "Keys",
                "Space play/pause",
                "Left/Right seek",
                "R reset",
                "[ / ] trim start/end",
                "N / P next/prev clip",
                "L toggle loop",
                f"Viewer connected: {summary.viewer_connected}",
            ]
        )
