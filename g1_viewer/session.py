from __future__ import annotations

from collections import deque
import threading
import time
from pathlib import Path
from typing import Any

from .browser import list_browser_nodes
from .config import MANIFEST_DIR
from .exporters import export_trimmed_sequence
from .importers import load_sequence, scan_path
from .models import (
    BrowserNode,
    CanonicalRobotState,
    ScanItem,
    SessionSummary,
    SimulationSnapshot,
    StateSequence,
    ViewerCameraState,
    model_to_dict,
    summarize_sequence,
)
from .policies import PolicyRegistry, PolicyRunnerManager


def _clone_state(state: CanonicalRobotState) -> CanonicalRobotState:
    return CanonicalRobotState(**model_to_dict(state))


class SessionController:
    def __init__(
        self,
        *,
        policy_registry: PolicyRegistry | None = None,
        policy_manager: PolicyRunnerManager | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._policy_registry = policy_registry or PolicyRegistry(MANIFEST_DIR)
        self._policy_manager = policy_manager or PolicyRunnerManager(self._policy_registry)
        self._policy_registry.discover()

        self._catalog_root: str | None = None
        self._items: list[ScanItem] = []
        self._sequences: dict[str, StateSequence] = {}
        self._active_sequence_id: str | None = None
        self._active_item_path: str | None = None

        self._current_frame = 0
        self._trim_start = 0
        self._trim_end = 0
        self._playback_state = "empty"
        self._loop_enabled = False
        self._last_playback_time: float | None = None
        self._frame_accumulator = 0.0

        self._active_policy_id: str | None = None
        self._policy_state: CanonicalRobotState | None = None
        self._last_policy_result: dict[str, Any] = {}
        self._last_policy_step_time: float | None = None
        self._policy_started_by_physics = False
        self._policy_step_interval = 1.0 / 30.0
        self._physics_enabled = False
        self._reference_state: CanonicalRobotState | None = None
        self._simulated_state: CanonicalRobotState | None = None
        self._physics_needs_reset = False
        self._last_observation_summary: dict[str, Any] = {}
        self._last_action_summary: dict[str, Any] = {}
        self._log_messages: deque[str] = deque(maxlen=12)

        self._viewer_connected = False
        self._viewer_camera: ViewerCameraState | None = None
        self._last_error: str | None = None

    def shutdown(self) -> None:
        with self._lock:
            self._viewer_connected = False
        self._policy_manager.stop_all()

    def scan_path(self, path_str: str) -> list[ScanItem]:
        items = scan_path(path_str)
        with self._lock:
            self._catalog_root = str(Path(path_str).expanduser().resolve())
            self._items = items
            self._last_error = None
            return list(self._items)

    def list_browser(self, path_str: str) -> tuple[str, list[BrowserNode]]:
        root, nodes = list_browser_nodes(path_str)
        with self._lock:
            self._catalog_root = root
            self._items = []
            self._last_error = None
        return root, nodes

    def load_clip(self, path_str: str, format_hint: str | None = None) -> StateSequence:
        sequence = load_sequence(path_str, format_hint)
        active_item_path = str(Path(path_str).expanduser().resolve())
        with self._lock:
            stopped_manual_policy = self._active_policy_id is not None and not self._policy_started_by_physics
            self._stop_policy_locked()
            self._clear_physics_state_locked(disable_physics=True, needs_reset=False)
            self._sequences[sequence.sequence_id] = sequence
            self._active_sequence_id = sequence.sequence_id
            self._active_item_path = active_item_path
            self._current_frame = 0
            self._trim_start = 0
            self._trim_end = max(0, sequence.frame_count - 1)
            self._playback_state = "stopped"
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            self._last_error = None
            if stopped_manual_policy:
                self._push_log_locked("policy stopped")
            return sequence

    def get_sequence(self, sequence_id: str) -> StateSequence:
        with self._lock:
            if sequence_id not in self._sequences:
                raise KeyError(sequence_id)
            return self._sequences[sequence_id]

    def list_policies(self):
        return self._policy_manager.list_policies()

    def play(self, now: float | None = None) -> SessionSummary:
        with self._lock:
            self._require_active_sequence_locked()
            self._playback_state = "playing"
            self._last_playback_time = time.monotonic() if now is None else now
            self._frame_accumulator = 0.0
            return self._build_summary_locked()

    def pause(self) -> SessionSummary:
        with self._lock:
            if self._playback_state != "empty":
                self._playback_state = "paused"
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            return self._build_summary_locked()

    def stop(self) -> SessionSummary:
        with self._lock:
            if self._playback_state != "empty":
                self._playback_state = "stopped"
            self._current_frame = 0
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            if self._physics_enabled:
                self._clear_physics_state_locked(disable_physics=False, needs_reset=True)
            return self._build_summary_locked()

    def toggle_physics(self, enabled: bool) -> SessionSummary:
        with self._lock:
            self._require_active_sequence_locked()
            self._physics_enabled = bool(enabled)
            self._clear_physics_state_locked(disable_physics=False, needs_reset=True)
            if self._physics_enabled and self._active_policy_id is None:
                self.start_policy(
                    "mock_g1_policy",
                    _emit_lifecycle_log=False,
                    _started_by_physics_toggle=True,
                )
            elif not self._physics_enabled and self._active_policy_id is not None:
                stopped_manual_policy = not self._policy_started_by_physics
                self._stop_policy_locked()
                if stopped_manual_policy:
                    self._push_log_locked("policy stopped")
            self._push_log_locked("physics enabled" if self._physics_enabled else "physics disabled")
            return self._build_summary_locked()

    def seek(self, frame_index: int) -> SessionSummary:
        with self._lock:
            sequence = self._require_active_sequence_locked()
            self._current_frame = min(max(frame_index, 0), sequence.frame_count - 1)
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            if self._physics_enabled:
                self._clear_physics_state_locked(disable_physics=False, needs_reset=True)
            self._push_log_locked(f"seek to frame {self._current_frame}")
            return self._build_summary_locked()

    def consume_physics_reset_flag(self) -> bool:
        with self._lock:
            should_reset = self._physics_needs_reset
            self._physics_needs_reset = False
            return should_reset

    def prepare_physics_reset(self, now: float | None = None) -> CanonicalRobotState | None:
        tick_now = time.monotonic() if now is None else now
        with self._lock:
            if not self._physics_needs_reset:
                return None
            reference_state = self._dataset_state_locked(tick_now)
            self._reference_state = _clone_state(reference_state)
            self._physics_needs_reset = False
            active_policy_id = self._active_policy_id
            sequence = self._get_active_sequence_locked()
            context = {
                "current_frame": self._current_frame,
                "trim_start": self._trim_start,
                "trim_end": self._trim_end,
                "timestamp": tick_now,
            }
            if sequence is not None:
                context.update(
                    {
                        "sequence_id": sequence.sequence_id,
                        "source_path": sequence.source_path,
                        "source_format": sequence.source_format,
                    }
                )

        if active_policy_id is not None:
            try:
                self._policy_manager.reset(active_policy_id, context)
            except Exception as exc:
                with self._lock:
                    self._last_error = str(exc)
                raise

        with self._lock:
            self._last_error = None
        return reference_state

    def reference_state(self, now: float | None = None) -> CanonicalRobotState:
        tick_now = time.monotonic() if now is None else now
        with self._lock:
            state = self._dataset_state_locked(tick_now)
            self._reference_state = _clone_state(state)
            return state

    def simulated_state(self) -> CanonicalRobotState | None:
        with self._lock:
            if self._simulated_state is None:
                return None
            return _clone_state(self._simulated_state)

    def physics_step(
        self,
        robot_state: CanonicalRobotState,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        tick_now = time.monotonic() if now is None else now
        with self._lock:
            sequence = self._require_active_sequence_locked()
            reference_state = self._dataset_state_locked(tick_now)
            self._reference_state = _clone_state(reference_state)
            self._simulated_state = _clone_state(robot_state)
            if self._active_policy_id is None:
                self.start_policy(
                    "mock_g1_policy",
                    _emit_lifecycle_log=False,
                    _started_by_physics_toggle=True,
                )
            self._physics_enabled = True

            dt = 0.0 if self._last_policy_step_time is None else max(0.0, tick_now - self._last_policy_step_time)
            policy_inputs = self._build_policy_inputs_locked(robot_state, reference_state, dt)
            self._last_observation_summary = policy_inputs
            snapshot = SimulationSnapshot(
                timestamp=tick_now,
                state=_clone_state(robot_state),
                metadata={
                    "sequence_id": sequence.sequence_id,
                    "frame_index": self._current_frame,
                    "policy_inputs": policy_inputs,
                },
            )

            try:
                result = self._policy_manager.step(self._active_policy_id, snapshot)
            except Exception as exc:
                self._last_error = str(exc)
                raise

            values = [float(value) for value in result.get("values", [])]
            self._last_policy_result = result
            self._last_policy_step_time = tick_now
            self._last_action_summary = {
                "mode": result.get("mode", "unknown"),
                "value_count": len(values),
                "first_values": values[:6],
            }
            self._last_error = None
            return {
                "mode": result.get("mode", "joint_position_target"),
                "values": values,
                "metadata": dict(result.get("metadata", {})),
            }

    def set_loop(self, enabled: bool) -> SessionSummary:
        with self._lock:
            self._loop_enabled = bool(enabled)
            return self._build_summary_locked()

    def set_trim_start(self, frame_index: int) -> SessionSummary:
        with self._lock:
            sequence = self._require_active_sequence_locked()
            bounded = min(max(frame_index, 0), sequence.frame_count - 1)
            self._trim_start = min(bounded, self._trim_end)
            return self._build_summary_locked()

    def set_trim_end(self, frame_index: int) -> SessionSummary:
        with self._lock:
            sequence = self._require_active_sequence_locked()
            bounded = min(max(frame_index, 0), sequence.frame_count - 1)
            self._trim_end = max(bounded, self._trim_start)
            return self._build_summary_locked()

    def export_trim(self, sequence_id: str, start_frame: int, end_frame: int) -> Path:
        sequence = self.get_sequence(sequence_id)
        return export_trimmed_sequence(sequence, start_frame, end_frame)

    def start_policy(
        self,
        policy_id: str,
        *,
        _emit_lifecycle_log: bool = True,
        _require_active_sequence: bool = True,
        _started_by_physics_toggle: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            if _require_active_sequence:
                self._require_active_sequence_locked()
        result = self._policy_manager.start(policy_id)
        with self._lock:
            self._clear_physics_state_locked(disable_physics=False, needs_reset=True)
            self._physics_enabled = True
            self._active_policy_id = policy_id
            self._policy_started_by_physics = _started_by_physics_toggle
            self._policy_state = None
            self._last_policy_result = result
            self._last_policy_step_time = None
            if self._playback_state != "empty":
                self._playback_state = "paused"
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            self._last_error = None
            if _emit_lifecycle_log:
                self._push_log_locked(f"policy started: {policy_id}")
            return result

    def stop_policy(self) -> SessionSummary:
        with self._lock:
            had_active_policy = self._active_policy_id is not None
            was_physics_enabled = self._physics_enabled
            needs_reset = self._physics_needs_reset or had_active_policy or was_physics_enabled
            self._stop_policy_locked()
            self._clear_physics_state_locked(
                disable_physics=True,
                needs_reset=needs_reset,
            )
            if had_active_policy:
                self._push_log_locked("policy stopped")
            return self._build_summary_locked()

    def step_policy(
        self,
        policy_id: str,
        snapshot: SimulationSnapshot | None = None,
        *,
        now: float | None = None,
    ) -> dict[str, Any]:
        tick_now = time.monotonic() if now is None else now
        with self._lock:
            if self._active_policy_id != policy_id:
                self.start_policy(policy_id, _require_active_sequence=snapshot is None)
            elif not self._physics_enabled:
                self._clear_physics_state_locked(disable_physics=False, needs_reset=True)
                self._physics_enabled = True
            base_state = snapshot.state if snapshot is not None else self._dataset_state_locked(tick_now)
            policy_snapshot = snapshot or self._build_snapshot_locked(base_state, tick_now)
            result = self._policy_manager.step(policy_id, policy_snapshot)
            self._last_policy_result = result
            self._last_policy_step_time = tick_now
            self._policy_state = self._apply_policy_result_locked(base_state, result, tick_now)
            self._last_error = None
            return result

    def next_clip(self) -> StateSequence | None:
        return self._select_relative_clip(1)

    def previous_clip(self) -> StateSequence | None:
        return self._select_relative_clip(-1)

    def toggle_play_pause(self) -> SessionSummary:
        with self._lock:
            if self._playback_state == "playing":
                return self.pause()
            return self.play()

    def toggle_loop(self) -> SessionSummary:
        with self._lock:
            self._loop_enabled = not self._loop_enabled
            return self._build_summary_locked()

    def set_trim_start_to_current(self) -> SessionSummary:
        return self.set_trim_start(self.get_session_summary().current_frame)

    def set_trim_end_to_current(self) -> SessionSummary:
        return self.set_trim_end(self.get_session_summary().current_frame)

    def tick(self, now: float | None = None) -> CanonicalRobotState:
        tick_now = time.monotonic() if now is None else now
        with self._lock:
            if self._playback_state == "playing":
                self._advance_playback_locked(tick_now)

            if self._physics_enabled:
                if self._simulated_state is not None:
                    state = _clone_state(self._simulated_state)
                    state.timestamp = tick_now
                    return state
                if self._policy_state is not None and self._get_active_sequence_locked() is None:
                    state = _clone_state(self._policy_state)
                    state.timestamp = tick_now
                    return state
                return self._dataset_state_locked(tick_now)

            base_state = self._base_state_for_tick_locked(tick_now)
            if self._active_policy_id is None:
                return base_state

            should_step = self._policy_state is None
            if self._last_policy_step_time is None:
                should_step = True
            elif tick_now - self._last_policy_step_time >= self._policy_step_interval:
                should_step = True

            if should_step:
                try:
                    snapshot = self._build_snapshot_locked(base_state, tick_now)
                    result = self._policy_manager.step(self._active_policy_id, snapshot)
                    self._last_policy_result = result
                    self._last_policy_step_time = tick_now
                    self._policy_state = self._apply_policy_result_locked(base_state, result, tick_now)
                    self._last_error = None
                except Exception as exc:
                    self._last_error = str(exc)

            return _clone_state(self._policy_state or base_state)

    def mark_viewer_connected(self, connected: bool) -> None:
        with self._lock:
            self._viewer_connected = connected

    def update_simulated_state(self, state: CanonicalRobotState) -> None:
        with self._lock:
            self._simulated_state = _clone_state(state)

    def update_camera(
        self,
        *,
        lookat: list[float],
        distance: float,
        azimuth: float,
        elevation: float,
    ) -> None:
        with self._lock:
            self._viewer_camera = ViewerCameraState(
                lookat=[float(value) for value in lookat[:3]],
                distance=float(distance),
                azimuth=float(azimuth),
                elevation=float(elevation),
            )

    def get_session_summary(self) -> SessionSummary:
        with self._lock:
            return self._build_summary_locked()

    def set_last_error(self, message: str | None) -> None:
        with self._lock:
            self._last_error = message

    def _build_summary_locked(self) -> SessionSummary:
        sequence = self._get_active_sequence_locked()
        return SessionSummary(
            catalog_root=self._catalog_root,
            items=list(self._items),
            active_item_path=self._active_item_path,
            active_sequence=summarize_sequence(sequence) if sequence is not None else None,
            current_frame=self._current_frame,
            trim_start=self._trim_start,
            trim_end=self._trim_end,
            playback_state=self._playback_state,  # type: ignore[arg-type]
            loop_enabled=self._loop_enabled,
            # Public lifecycle methods keep policy activity and physics mode aligned.
            view_mode="policy" if self._active_policy_id is not None else "dataset",
            active_policy_id=self._active_policy_id,
            viewer_connected=self._viewer_connected,
            viewer_camera=self._viewer_camera,
            last_policy_result=dict(self._last_policy_result),
            physics_enabled=self._physics_enabled,
            last_observation_summary=dict(self._last_observation_summary),
            last_action_summary=dict(self._last_action_summary),
            last_log_messages=list(self._log_messages),
            last_error=self._last_error,
        )

    def _push_log_locked(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self._log_messages.appendleft(f"[{stamp}] {message}")

    def _clear_physics_state_locked(self, *, disable_physics: bool, needs_reset: bool) -> None:
        if disable_physics:
            self._physics_enabled = False
        self._reference_state = None
        self._simulated_state = None
        self._policy_state = None
        self._last_policy_result = {}
        self._last_policy_step_time = None
        self._physics_needs_reset = needs_reset
        self._last_observation_summary = {}
        self._last_action_summary = {}

    def _require_active_sequence_locked(self) -> StateSequence:
        sequence = self._get_active_sequence_locked()
        if sequence is None:
            raise ValueError("Load a clip first")
        return sequence

    def _get_active_sequence_locked(self) -> StateSequence | None:
        if self._active_sequence_id is None:
            return None
        return self._sequences.get(self._active_sequence_id)

    def _base_state_for_tick_locked(self, now: float) -> CanonicalRobotState:
        if self._get_active_sequence_locked() is None and self._policy_state is not None:
            state = _clone_state(self._policy_state)
            state.timestamp = now
            return state
        return self._dataset_state_locked(now)

    def _advance_playback_locked(self, now: float) -> None:
        sequence = self._get_active_sequence_locked()
        if sequence is None or sequence.frame_count <= 0:
            self._playback_state = "empty"
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            return

        if self._last_playback_time is None:
            self._last_playback_time = now
            return

        delta = max(0.0, now - self._last_playback_time)
        self._last_playback_time = now
        self._frame_accumulator += delta * sequence.fps
        steps = int(self._frame_accumulator)
        if steps <= 0:
            return

        self._frame_accumulator -= steps
        next_frame = self._current_frame + steps
        max_frame = sequence.frame_count - 1

        if self._loop_enabled and sequence.frame_count > 0:
            self._current_frame = next_frame % sequence.frame_count
            return

        if next_frame >= max_frame:
            self._current_frame = max_frame
            self._playback_state = "stopped"
            self._last_playback_time = None
            self._frame_accumulator = 0.0
            return

        self._current_frame = next_frame

    def _dataset_state_locked(self, now: float) -> CanonicalRobotState:
        sequence = self._get_active_sequence_locked()
        if sequence is None or sequence.frame_count == 0:
            return CanonicalRobotState(timestamp=now, root_translation=[0.0, 0.0, 0.78])

        frame_index = min(max(self._current_frame, 0), sequence.frame_count - 1)
        frame = _clone_state(sequence.frames[frame_index])
        frame.timestamp = sequence.frames[frame_index].timestamp
        metadata = dict(frame.metadata)
        metadata.update(
            {
                "sequence_id": sequence.sequence_id,
                "frame_index": frame_index,
                "view_mode": "policy" if self._active_policy_id is not None else "dataset",
            }
        )
        frame.metadata = metadata
        return frame

    def _build_snapshot_locked(self, base_state: CanonicalRobotState, now: float) -> SimulationSnapshot:
        sequence = self._get_active_sequence_locked()
        metadata = {
            "current_frame": self._current_frame,
            "trim_start": self._trim_start,
            "trim_end": self._trim_end,
        }
        if sequence is not None:
            metadata.update(
                {
                    "sequence_id": sequence.sequence_id,
                    "source_path": sequence.source_path,
                    "source_format": sequence.source_format,
                }
            )
        return SimulationSnapshot(timestamp=now, state=_clone_state(base_state), metadata=metadata)

    def _build_policy_inputs_locked(
        self,
        robot_state: CanonicalRobotState,
        reference_state: CanonicalRobotState,
        dt: float,
    ) -> dict[str, Any]:
        return {
            "robot_state": {
                "root_position": list(robot_state.root_translation),
                "root_rotation_wxyz": list(robot_state.root_rotation_wxyz),
                "joint_positions": list(robot_state.joint_positions),
                "joint_velocities": list(robot_state.joint_velocities),
            },
            "reference_target": {
                "target_root_position": list(reference_state.root_translation),
                "target_root_rotation_wxyz": list(reference_state.root_rotation_wxyz),
                "target_joint_positions": list(reference_state.joint_positions),
                "target_joint_velocities": list(reference_state.joint_velocities),
            },
            "frame_index": self._current_frame,
            "dt": dt,
        }

    def _apply_policy_result_locked(
        self,
        base_state: CanonicalRobotState,
        result: dict[str, Any],
        now: float,
    ) -> CanonicalRobotState:
        state = _clone_state(base_state)
        mode = str(result.get("mode", "joint_position_target"))
        metadata = dict(state.metadata)
        metadata["policy_mode"] = mode
        metadata["policy_id"] = self._active_policy_id
        metadata["policy_result"] = result.get("metadata", {})
        state.metadata = metadata
        state.timestamp = now

        if mode == "state_override" and isinstance(result.get("state"), dict):
            return CanonicalRobotState(**result["state"])

        values = [float(value) for value in result.get("values", [])]
        if not values:
            return state

        if not state.joint_positions:
            state.joint_positions = values[:]
        else:
            updated = list(state.joint_positions)
            size = min(len(updated), len(values))
            updated[:size] = values[:size]
            state.joint_positions = updated

        if mode == "joint_velocity_target":
            velocities = list(state.joint_velocities) if state.joint_velocities else [0.0] * len(state.joint_positions)
            size = min(len(velocities), len(values))
            velocities[:size] = values[:size]
            state.joint_velocities = velocities

        return state

    def _stop_policy_locked(self) -> None:
        if self._active_policy_id is not None:
            self._policy_manager.stop(self._active_policy_id)
        self._active_policy_id = None
        self._policy_started_by_physics = False
        self._policy_state = None
        self._last_policy_result = {}
        self._last_policy_step_time = None

    def _select_relative_clip(self, offset: int) -> StateSequence | None:
        with self._lock:
            if not self._items:
                return None
            current_index = -1
            if self._active_item_path is not None:
                for index, item in enumerate(self._items):
                    if item.path == self._active_item_path:
                        current_index = index
                        break
            target_index = 0 if current_index < 0 else (current_index + offset) % len(self._items)
            target = self._items[target_index]
        return self.load_clip(target.path, target.format)
