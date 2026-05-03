# SONIC-Style Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the web control panel into a SONIC-style unified console while preserving current motion/policy tooling and adding native viewer drag and perturbation testing.

**Architecture:** Keep `SessionController` as the single state source, add typed viewer/test summaries to `SessionSummary`, bridge MuJoCo passive viewer perturbation into that state, and rebuild the single-file web panel around the existing grouped session APIs plus two new viewer-test endpoints.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, MuJoCo Python viewer, NumPy, static HTML/CSS/JS, `unittest` with `fastapi.testclient`.

---

## File Map

- Modify: `g1_viewer/models.py`
  - Add typed models for viewer interaction and test state.
  - Add request models for viewer-test impulse commands.
- Modify: `g1_viewer/session.py`
  - Store viewer interaction state, queue/reset test commands, serialize them into `SessionSummary`, and clear stale state on lifecycle transitions.
- Modify: `g1_viewer/api.py`
  - Add `/api/viewer/test/impulse` and `/api/viewer/test/reset`.
- Create: `g1_viewer/viewer_testing.py`
  - Small helper module for perturbation summary extraction and preset impulse application.
- Modify: `g1_viewer/viewer_runtime.py`
  - Consume pending impulse commands, summarize live drag state, and surface test status to session/overlay.
- Modify: `g1_viewer/static/index.html`
  - Replace the current diagnostics-first layout with the integrated SONIC-style console.
- Modify: `tests/test_session_api.py`
  - Add controller, API, and root-page smoke coverage for the new summaries and endpoints.
- Create: `tests/test_viewer_testing.py`
  - Unit-test viewer interaction helper logic without requiring a real GUI session.

### Task 1: Add Typed Viewer/Test State To Models And Session

**Files:**
- Modify: `g1_viewer/models.py`
- Modify: `g1_viewer/session.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing controller tests**

Add these tests to `tests/test_session_api.py` near the existing `SessionStateSourceTest` class:

```python
from g1_viewer.models import ViewerImpulseRequest, ViewerInteractionSummary


class ViewerTestStateControllerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_session_summary_exposes_default_viewer_and_test_state(self) -> None:
        summary = self.controller.get_session_summary()

        self.assertFalse(summary.viewer_interaction.drag_active)
        self.assertEqual(summary.viewer_interaction.perturb_mode, "none")
        self.assertFalse(summary.test_state.pending_impulse)
        self.assertEqual(summary.test_state.last_impulse_command, {})

    def test_queue_viewer_impulse_updates_summary(self) -> None:
        self.controller.mark_viewer_connected(True)
        self.controller.toggle_physics(True)

        summary = self.controller.queue_viewer_impulse(
            ViewerImpulseRequest(preset="push_forward", magnitude=90.0, duration=0.25)
        )

        self.assertTrue(summary.test_state.pending_impulse)
        self.assertEqual(summary.test_state.last_test_event, "impulse queued")
        self.assertEqual(summary.test_state.last_impulse_command["preset"], "push_forward")

    def test_loading_new_clip_clears_stale_viewer_and_test_state(self) -> None:
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
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
pytest tests/test_session_api.py::ViewerTestStateControllerTest -v
```

Expected:

- `ImportError` or `AttributeError` for `ViewerImpulseRequest`, `ViewerInteractionSummary`, `queue_viewer_impulse`, or `set_viewer_interaction`
- no accidental passes

- [ ] **Step 3: Add the minimal models and session plumbing**

In `g1_viewer/models.py`, add the new typed models and wire them into `SessionSummary`:

```python
class ViewerInteractionSummary(BaseModel):
    drag_active: bool = False
    selected_body_id: int | None = None
    selected_body_name: str | None = None
    perturb_mode: str = "none"
    force_magnitude: float | None = None
    last_drag_timestamp: float | None = None


class ViewerImpulseRequest(BaseModel):
    preset: Literal["push_forward", "push_backward", "push_left", "push_right", "lift_up"]
    magnitude: float = Field(default=80.0, ge=1.0, le=500.0)
    duration: float = Field(default=0.15, ge=0.01, le=5.0)
    body_name: str | None = None


class ViewerImpulseCommand(BaseModel):
    preset: Literal["push_forward", "push_backward", "push_left", "push_right", "lift_up"]
    magnitude: float
    duration: float
    body_name: str | None = None


class TestStateSummary(BaseModel):
    last_test_event: str | None = None
    last_test_status: str | None = None
    last_impulse_command: dict[str, Any] = Field(default_factory=dict)
    pending_impulse: bool = False
```

Update `SessionSummary`:

```python
class SessionSummary(BaseModel):
    catalog_root: str | None = None
    items: list[ScanItem] = Field(default_factory=list)
    active_item_path: str | None = None
    active_sequence: SequenceSummary | None = None
    current_frame: int = 0
    trim_start: int = 0
    trim_end: int = 0
    playback_state: PlaybackState = "empty"
    loop_enabled: bool = False
    view_mode: ViewMode = "dataset"
    active_policy_id: str | None = None
    viewer_connected: bool = False
    viewer_camera: ViewerCameraState | None = None
    last_policy_result: dict[str, Any] = Field(default_factory=dict)
    physics_enabled: bool = False
    last_observation_summary: dict[str, Any] = Field(default_factory=dict)
    last_action_summary: dict[str, Any] = Field(default_factory=dict)
    last_log_messages: list[str] = Field(default_factory=list)
    viewer_interaction: ViewerInteractionSummary = Field(default_factory=ViewerInteractionSummary)
    test_state: TestStateSummary = Field(default_factory=TestStateSummary)
    last_error: str | None = None
```

In `g1_viewer/session.py`, add state holders and lifecycle-aware methods:

```python
from .models import (
    BrowserNode,
    CanonicalRobotState,
    ScanItem,
    SessionSummary,
    SimulationSnapshot,
    StateSequence,
    TestStateSummary,
    ViewerCameraState,
    ViewerImpulseCommand,
    ViewerImpulseRequest,
    ViewerInteractionSummary,
    model_to_dict,
    summarize_sequence,
)


Inside `SessionController.__init__`, add:

```python
        self._viewer_interaction = ViewerInteractionSummary()
        self._test_state = TestStateSummary()
        self._pending_impulse: ViewerImpulseCommand | None = None
```

Add these methods to `SessionController`:

```python
    def set_viewer_interaction(self, interaction: ViewerInteractionSummary) -> None:
        with self._lock:
            self._viewer_interaction = ViewerInteractionSummary(**model_to_dict(interaction))

    def queue_viewer_impulse(self, request: ViewerImpulseRequest) -> SessionSummary:
        with self._lock:
            self._require_active_sequence_locked()
            if not self._viewer_connected:
                raise ValueError("Viewer must be connected before running test impulses")
            if not self._physics_enabled:
                raise ValueError("Physics must be enabled before running test impulses")

            self._pending_impulse = ViewerImpulseCommand(**model_to_dict(request))
            self._test_state = TestStateSummary(
                last_test_event="impulse queued",
                last_test_status="pending",
                last_impulse_command=model_to_dict(self._pending_impulse),
                pending_impulse=True,
            )
            self._push_log_locked(f"viewer impulse queued: {request.preset}")
            return self._build_summary_locked()

    def consume_viewer_impulse(self) -> ViewerImpulseCommand | None:
        with self._lock:
            command = self._pending_impulse
            self._pending_impulse = None
            if command is not None:
                self._test_state.pending_impulse = False
                self._test_state.last_test_status = "running"
            return command

    def mark_viewer_test_result(self, *, event: str, status: str) -> None:
        with self._lock:
            self._test_state.last_test_event = event
            self._test_state.last_test_status = status

    def reset_viewer_test_state(self) -> SessionSummary:
        with self._lock:
            self._reset_viewer_test_state_locked()
            self._push_log_locked("viewer test state reset")
            return self._build_summary_locked()

    def _reset_viewer_test_state_locked(self) -> None:
        self._viewer_interaction = ViewerInteractionSummary()
        self._test_state = TestStateSummary()
        self._pending_impulse = None
```

Call `_reset_viewer_test_state_locked()` from:

- `load_clip`
- `stop`
- `toggle_physics(False)`
- `stop_policy`
- `mark_viewer_connected(False)`

Serialize the new fields in `_build_summary_locked()`:

```python
return SessionSummary(
    catalog_root=self._catalog_root,
    items=list(self._items),
    active_item_path=self._active_item_path,
    active_sequence=summarize_sequence(sequence) if sequence is not None else None,
    current_frame=self._current_frame,
    trim_start=self._trim_start,
    trim_end=self._trim_end,
    playback_state=self._playback_state,
    loop_enabled=self._loop_enabled,
    view_mode="policy" if self._active_policy_id is not None else "dataset",
    active_policy_id=self._active_policy_id,
    viewer_connected=self._viewer_connected,
    viewer_camera=self._viewer_camera,
    last_policy_result=dict(self._last_policy_result),
    physics_enabled=self._physics_enabled,
    last_observation_summary=dict(self._last_observation_summary),
    last_action_summary=dict(self._last_action_summary),
    last_log_messages=list(self._log_messages),
    viewer_interaction=ViewerInteractionSummary(**model_to_dict(self._viewer_interaction)),
    test_state=TestStateSummary(**model_to_dict(self._test_state)),
    last_error=self._last_error,
)
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run:

```bash
pytest tests/test_session_api.py::ViewerTestStateControllerTest -v
```

Expected:

- all tests in `ViewerTestStateControllerTest` pass

- [ ] **Step 5: Commit**

```bash
git add g1_viewer/models.py g1_viewer/session.py tests/test_session_api.py
git commit -m "feat: track viewer interaction and test state"
```

### Task 2: Add Viewer-Test API Endpoints And Validation

**Files:**
- Modify: `g1_viewer/api.py`
- Modify: `tests/test_session_api.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing API tests**

Add these tests to `tests/test_session_api.py` near `GroupedApiTest`:

```python
class ViewerTestApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_impulse_endpoint_requires_viewer_and_physics(self) -> None:
        self.client.post("/api/session/load", json={"path": str(TWIST2_SAMPLE), "format": "twist2"})

        response = self.client.post(
            "/api/viewer/test/impulse",
            json={"preset": "push_forward", "magnitude": 80.0, "duration": 0.15},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Viewer must be connected", response.text)

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
        self.client.post(
            "/api/viewer/test/impulse",
            json={"preset": "lift_up", "magnitude": 70.0, "duration": 0.1},
        )

        response = self.client.post("/api/viewer/test/reset")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["test_state"]["pending_impulse"])
        self.assertFalse(payload["viewer_interaction"]["drag_active"])
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
pytest tests/test_session_api.py::ViewerTestApiTest -v
```

Expected:

- `404 Not Found` for the new endpoints

- [ ] **Step 3: Add the new endpoints**

In `g1_viewer/api.py`, import the new request model:

```python
from .models import (
    BrowserListRequest,
    BrowserListResponse,
    FrameSliceResponse,
    GetFramesRequest,
    LoadClipRequest,
    LoadClipResponse,
    LoopRequest,
    MockStepRequest,
    PolicyActivationRequest,
    PolicyListResponse,
    PolicyOperationResponse,
    PolicyStepRequest,
    ScanRequest,
    ScanResponse,
    SeekRequest,
    SessionLoadRequest,
    SessionPhysicsRequest,
    SessionPlaybackRequest,
    SessionSummary,
    SessionTrimRequest,
    StartPolicyRequest,
    StopPolicyRequest,
    TrimExportRequest,
    TrimExportResponse,
    TrimFrameRequest,
    ViewerImpulseRequest,
)
```

Add a small helper and two routes after the grouped physics route:

```python
def _handle_viewer_test_impulse_request(
    controller: SessionController,
    request: ViewerImpulseRequest,
) -> SessionSummary:
    return controller.queue_viewer_impulse(request)
```

```python
    @app.post("/api/viewer/test/impulse", response_model=SessionSummary)
    def api_viewer_test_impulse(request: ViewerImpulseRequest) -> SessionSummary:
        try:
            return _handle_viewer_test_impulse_request(get_controller(), request)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/viewer/test/reset", response_model=SessionSummary)
    def api_viewer_test_reset() -> SessionSummary:
        try:
            return get_controller().reset_viewer_test_state()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
```

Do not remove or rename any existing endpoints.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run:

```bash
pytest tests/test_session_api.py::ViewerTestApiTest -v
```

Expected:

- all `ViewerTestApiTest` tests pass

- [ ] **Step 5: Commit**

```bash
git add g1_viewer/api.py tests/test_session_api.py
git commit -m "feat: add viewer test api endpoints"
```

### Task 3: Bridge MuJoCo Viewer Perturbation Into Session State

**Files:**
- Create: `g1_viewer/viewer_testing.py`
- Modify: `g1_viewer/viewer_runtime.py`
- Test: `tests/test_viewer_testing.py`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/test_viewer_testing.py`:

```python
from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

import mujoco
import numpy as np

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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
pytest tests/test_viewer_testing.py -v
```

Expected:

- `ModuleNotFoundError: No module named 'g1_viewer.viewer_testing'`

- [ ] **Step 3: Create the helper module and wire it into the runtime**

Create `g1_viewer/viewer_testing.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

import mujoco
import numpy as np

from .models import ViewerImpulseCommand, ViewerInteractionSummary


PRESET_FORCE_VECTORS = {
    "push_forward": np.array([1.0, 0.0, 0.0], dtype=float),
    "push_backward": np.array([-1.0, 0.0, 0.0], dtype=float),
    "push_left": np.array([0.0, 1.0, 0.0], dtype=float),
    "push_right": np.array([0.0, -1.0, 0.0], dtype=float),
    "lift_up": np.array([0.0, 0.0, 1.0], dtype=float),
}


@dataclass
class ActiveImpulse:
    body_id: int
    force: np.ndarray
    expires_at: float


def summarize_perturbation(model, data, perturb, now: float) -> ViewerInteractionSummary:
    body_id = int(getattr(perturb, "select", 0) or 0)
    active_bits = int(getattr(perturb, "active", 0) or 0)
    drag_active = body_id > 0 and active_bits != 0

    mode = "none"
    if active_bits & int(mujoco.mjtPertBit.mjPERT_TRANSLATE):
        mode = "translate"
    elif active_bits & int(mujoco.mjtPertBit.mjPERT_ROTATE):
        mode = "rotate"

    body_name = None
    force_magnitude = None
    if body_id > 0:
        body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id)
        if getattr(data, "xfrc_applied", None) is not None and data.xfrc_applied.size >= (body_id + 1) * 6:
            force = np.asarray(data.xfrc_applied[body_id * 6 : body_id * 6 + 3], dtype=float)
            force_magnitude = float(np.linalg.norm(force))

    return ViewerInteractionSummary(
        drag_active=drag_active,
        selected_body_id=body_id if body_id > 0 else None,
        selected_body_name=body_name,
        perturb_mode=mode,
        force_magnitude=force_magnitude if drag_active else None,
        last_drag_timestamp=now if drag_active else None,
    )


def resolve_impulse_body_id(model, body_name: str | None) -> int:
    if body_name:
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, body_name)
        if body_id >= 0:
            return int(body_id)

    for candidate in ("pelvis", "torso_link", "trunk", "base"):
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, candidate)
        if body_id >= 0:
            return int(body_id)

    return 1


def build_active_impulse(model, command: ViewerImpulseCommand, now: float) -> ActiveImpulse:
    body_id = resolve_impulse_body_id(model, command.body_name)
    direction = PRESET_FORCE_VECTORS[command.preset]
    force = direction * float(command.magnitude)
    return ActiveImpulse(body_id=body_id, force=force, expires_at=now + float(command.duration))


def apply_impulse_wrench(data, body_id: int, force: np.ndarray) -> None:
    base = int(body_id) * 6
    data.xfrc_applied[base : base + 6] = 0.0
    data.xfrc_applied[base : base + 3] = force[:3]
```

Update `g1_viewer/viewer_runtime.py` imports and runtime loop:

```python
from .viewer_testing import apply_impulse_wrench, build_active_impulse, summarize_perturbation
```

Inside `NativeViewerRuntime.__init__`, add:

```python
        self._active_impulse = None
```

Update `_right_overlay()` with:

```python
    def _right_overlay(self, summary) -> str:
        interaction = summary.viewer_interaction
        test_state = summary.test_state
        return "\n".join(
            [
                "Keys",
                "Space play/pause",
                "Left/Right seek",
                "R reset",
                "[ / ] trim start/end",
                "N / P next/prev clip",
                "L toggle loop",
                f"Drag: {interaction.selected_body_name or '-'} | {interaction.perturb_mode}",
                f"Test: {'pending' if test_state.pending_impulse else (test_state.last_test_status or '-')}",
            ]
        )
```

Inside the main runtime loop, add:

```python
                    pending_impulse = self.controller.consume_viewer_impulse()
                    if pending_impulse is not None:
                        self._active_impulse = build_active_impulse(self.model, pending_impulse, tick_now)
                        self.controller.mark_viewer_test_result(event="impulse applied", status="running")

                    if getattr(self.data, "xfrc_applied", None) is not None and self.data.xfrc_applied.size > 0:
                        self.data.xfrc_applied[:] = 0.0
                        if self._active_impulse is not None:
                            if tick_now <= self._active_impulse.expires_at:
                                apply_impulse_wrench(
                                    self.data,
                                    body_id=self._active_impulse.body_id,
                                    force=self._active_impulse.force,
                                )
                            else:
                                self._active_impulse = None
                                self.controller.mark_viewer_test_result(
                                    event="impulse completed",
                                    status="idle",
                                )
```

After `handle.sync()`, add:

```python
                    interaction = summarize_perturbation(self.model, self.data, handle.perturb, now=tick_now)
                    self.controller.set_viewer_interaction(interaction)
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run:

```bash
pytest tests/test_viewer_testing.py -v
```

Expected:

- both helper tests pass

- [ ] **Step 5: Commit**

```bash
git add g1_viewer/viewer_testing.py g1_viewer/viewer_runtime.py tests/test_viewer_testing.py
git commit -m "feat: bridge viewer perturbation into session state"
```

### Task 4: Rebuild The Static Control Panel Around The New Console Layout

**Files:**
- Modify: `g1_viewer/static/index.html`
- Modify: `tests/test_session_api.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing root-page smoke expectations**

Update `RootPageSmokeTest` in `tests/test_session_api.py`:

```python
class RootPageSmokeTest(unittest.TestCase):
    def test_root_page_contains_data_policy_and_test_sections(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("Data", body)
        self.assertIn("Motion", body)
        self.assertIn("Trim & Export", body)
        self.assertIn("Policy", body)
        self.assertIn("Test", body)
        self.assertIn("Physics OFF", body)
```

- [ ] **Step 2: Run the root-page smoke test to verify it fails**

Run:

```bash
pytest tests/test_session_api.py::RootPageSmokeTest -v
```

Expected:

- failure because the current page does not contain the new section labels

- [ ] **Step 3: Replace the HTML layout and wire the new test UI**

In `g1_viewer/static/index.html`, replace the current style token block with a darker SONIC-style palette:

```html
<style>
  :root {
    --bg: #09110f;
    --bg-soft: #0f1917;
    --panel: rgba(13, 22, 20, 0.78);
    --panel-strong: rgba(10, 18, 17, 0.9);
    --line: rgba(210, 234, 223, 0.1);
    --text: #edf5f1;
    --muted: rgba(237, 245, 241, 0.58);
    --accent: #55b88a;
    --accent-strong: #2e8c63;
    --warn: #d5a14d;
    --danger: #dc6356;
    --radius: 18px;
  }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--text);
    font-family: "IBM Plex Sans", "PingFang SC", "Noto Sans SC", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(85, 184, 138, 0.12), transparent 28%),
      radial-gradient(circle at bottom right, rgba(52, 108, 132, 0.12), transparent 24%),
      linear-gradient(180deg, #08100f 0%, #0d1513 100%);
  }
  .app-shell {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr) 320px;
    gap: 16px;
    padding: 16px;
  }
  .glass {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    backdrop-filter: blur(18px);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
  }
  .rail,
  .status-column,
  .workspace {
    min-height: 0;
  }
  .section-title {
    margin: 0 0 10px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .panel-block {
    padding: 16px;
    display: grid;
    gap: 12px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 7px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
    color: var(--muted);
    font-size: 12px;
  }
  .badge.ok { color: var(--accent); }
  .badge.warn { color: var(--warn); }
  button {
    border: 1px solid rgba(85, 184, 138, 0.35);
    border-radius: 12px;
    padding: 10px 12px;
    color: var(--text);
    background: rgba(85, 184, 138, 0.15);
  }
  button.secondary {
    border-color: var(--line);
    background: rgba(255, 255, 255, 0.04);
  }
  input, pre {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text);
  }
  @media (max-width: 1320px) {
    .app-shell {
      grid-template-columns: 1fr;
    }
  }
</style>
```

Replace the `<body>` content with a three-column console:

```html
<body>
  <div class="app-shell">
    <aside class="rail">
      <section class="glass panel-block">
        <div class="section-title">Data</div>
        <input id="pathInput" type="text" placeholder="输入数据根目录" />
        <div class="grid-2">
          <button id="scanButton">扫描</button>
          <button class="secondary" id="exportButton">导出裁剪</button>
        </div>
        <div class="status" id="treeStatus">输入数据根目录后扫描。</div>
        <div class="tree" id="treeRoot"></div>
      </section>

      <section class="glass panel-block">
        <div class="section-title">Motion</div>
        <div class="hero-bar">
          <span class="badge" id="modeBadge">模式: dataset</span>
          <span class="badge" id="playbackBadge">播放: empty</span>
        </div>
        <div class="stat-grid" id="clipSummary"></div>
        <input id="timeline" type="range" min="0" max="0" value="0" disabled />
        <div class="grid-2">
          <button id="playButton">播放</button>
          <button class="secondary" id="pauseButton">暂停</button>
          <button class="secondary" id="stopButton">停止</button>
          <button class="secondary" id="seekButton">跳到帧</button>
        </div>
        <input id="frameInput" type="number" min="0" value="0" disabled />
      </section>

      <section class="glass panel-block">
        <div class="section-title">Trim &amp; Export</div>
        <div class="grid-2">
          <input id="trimStartInput" type="number" min="0" value="0" disabled />
          <input id="trimEndInput" type="number" min="0" value="0" disabled />
        </div>
        <div class="grid-2">
          <button class="secondary" id="markTrimStartButton">设为起点</button>
          <button class="secondary" id="markTrimEndButton">设为终点</button>
        </div>
        <div class="note" id="trimSummary">裁剪区间: 0 至 0</div>
      </section>

      <section class="glass panel-block">
        <div class="section-title">Policy</div>
        <div class="grid-2">
          <button id="startPolicyButton">启动策略</button>
          <button class="secondary" id="stopPolicyButton">停止策略</button>
        </div>
        <button class="secondary" id="stepPolicyButton">单步测试</button>
        <div class="status" id="policyStatus">策略清单加载中。</div>
        <div class="policy-list" id="policyList"></div>
      </section>
    </aside>

    <main class="workspace">
      <section class="glass panel-block">
        <div class="section-title">Viewer Runtime</div>
        <div class="hero-bar">
          <span class="badge" id="viewerBadge">Viewer 未连接</span>
          <span class="badge" id="policyBadge">策略: -</span>
          <span class="badge" id="physicsBadge">Physics OFF</span>
        </div>
        <p class="hint">主可视化仍在 MuJoCo native viewer 中。这里显示运行态摘要、测试提示和渲染预览入口。</p>
        <div class="status" id="commandStatus">等待操作。</div>
      </section>

      <section class="glass panel-block">
        <div class="section-title">Diagnostics</div>
        <div class="bottom-grid">
          <pre id="logPane">暂无日志。</pre>
          <pre id="observationPane">{}</pre>
          <pre id="actionPane">{}</pre>
        </div>
      </section>
    </main>

    <aside class="status-column">
      <section class="glass panel-block">
        <div class="section-title">Status</div>
        <pre id="policyPane">等待会话状态...</pre>
        <pre id="cameraPane">等待 MuJoCo viewer 连接...</pre>
      </section>

      <section class="glass panel-block">
        <div class="section-title">Test</div>
        <div class="grid-2">
          <button class="secondary" id="physicsToggleButton">Physics OFF</button>
          <button class="secondary" id="resetTestButton">重置测试</button>
        </div>
        <div class="grid-2">
          <button data-preset="push_forward" class="impulseButton">前推</button>
          <button data-preset="push_backward" class="impulseButton">后推</button>
          <button data-preset="push_left" class="impulseButton">左推</button>
          <button data-preset="push_right" class="impulseButton">右推</button>
          <button data-preset="lift_up" class="impulseButton">上提</button>
        </div>
        <div class="grid-2">
          <input id="impulseMagnitudeInput" type="number" min="1" step="5" value="80" />
          <input id="impulseDurationInput" type="number" min="0.01" step="0.05" value="0.15" />
        </div>
        <pre id="dragPane">{}</pre>
      </section>
    </aside>
  </div>
```

In the `<script>` block, add new DOM refs and test commands:

```javascript
const resetTestButton = document.getElementById("resetTestButton");
const impulseMagnitudeInput = document.getElementById("impulseMagnitudeInput");
const impulseDurationInput = document.getElementById("impulseDurationInput");
const dragPane = document.getElementById("dragPane");
const impulseButtons = [...document.querySelectorAll(".impulseButton")];

function renderDiagnostics(session) {
  physicsToggleButton.textContent = session.physics_enabled ? "Physics ON" : "Physics OFF";
  logPane.textContent = session.last_log_messages.length > 0 ? session.last_log_messages.join("\n") : "暂无日志。";
  observationPane.textContent = formatJson(session.last_observation_summary);
  actionPane.textContent = formatJson(session.last_action_summary);
  policyPane.textContent = formatJson({
    active_policy_id: session.active_policy_id,
    physics_enabled: session.physics_enabled,
    last_policy_result: session.last_policy_result,
    last_error: session.last_error,
  });
  cameraPane.textContent = session.viewer_camera
    ? formatJson({ connected: session.viewer_connected, camera: session.viewer_camera })
    : "等待 MuJoCo viewer 连接...";
  dragPane.textContent = formatJson({
    viewer_interaction: session.viewer_interaction,
    test_state: session.test_state,
  });
}

async function queueImpulse(preset) {
  await postJson("/api/viewer/test/impulse", {
    preset,
    magnitude: Number(impulseMagnitudeInput.value),
    duration: Number(impulseDurationInput.value),
  });
}

resetTestButton.addEventListener("click", () =>
  runCommand(
    () => postJson("/api/viewer/test/reset"),
    "测试状态已重置。",
  ),
);

for (const button of impulseButtons) {
  button.addEventListener("click", () =>
    runCommand(
      () => queueImpulse(button.dataset.preset),
      `已发送扰动命令: ${button.dataset.preset}`,
    ),
  );
}
```

Do not remove:

- tree browsing
- motion loading
- trim/export
- policy selection
- diagnostics panes

- [ ] **Step 4: Run the root-page smoke test to verify it passes**

Run:

```bash
pytest tests/test_session_api.py::RootPageSmokeTest -v
```

Expected:

- the updated root-page smoke test passes

- [ ] **Step 5: Commit**

```bash
git add g1_viewer/static/index.html tests/test_session_api.py
git commit -m "feat: redesign control panel for integrated testing"
```

### Task 5: Run Verification And Close Gaps

**Files:**
- Modify: `tests/test_session_api.py` (only if verification reveals a missing test)
- Modify: `tests/test_viewer_testing.py` (only if verification reveals a missing helper test)

- [ ] **Step 1: Run the backend and UI-focused automated test suite**

Run:

```bash
pytest tests/test_session_api.py tests/test_viewer_testing.py -v
```

Expected:

- all controller, API, root-page, and viewer-helper tests pass

- [ ] **Step 2: Run a focused manual smoke test for the native viewer**

Run:

```bash
uv run python main.py --path examples/sample_data/twist2_demo.pkl
```

Verify manually:

- the native viewer opens
- the web panel loads at `http://127.0.0.1:8000`
- enabling `Physics` allows impulse buttons to work
- dragging the robot in the native viewer updates the web `Test` panel
- loading a new clip clears stale drag/test state

- [ ] **Step 3: If a gap appears during verification, add the missing test before fixing code**

Examples:

```python
def test_mark_viewer_connected_false_clears_drag_state(self) -> None:
    self.controller.set_viewer_interaction(
        ViewerInteractionSummary(
            drag_active=True,
            selected_body_id=1,
            selected_body_name="pelvis",
            perturb_mode="translate",
            force_magnitude=12.0,
            last_drag_timestamp=1.0,
        )
    )

    self.controller.mark_viewer_connected(False)
    summary = self.controller.get_session_summary()

    self.assertFalse(summary.viewer_interaction.drag_active)
```

Then rerun the targeted test first:

```bash
pytest tests/test_session_api.py::ViewerTestStateControllerTest -v
```

- [ ] **Step 4: Rerun the full targeted suite after any verification fixes**

Run:

```bash
pytest tests/test_session_api.py tests/test_viewer_testing.py -v
```

Expected:

- clean pass after any verification-driven fixes

- [ ] **Step 5: Commit**

```bash
git add tests/test_session_api.py tests/test_viewer_testing.py g1_viewer/models.py g1_viewer/session.py g1_viewer/api.py g1_viewer/viewer_testing.py g1_viewer/viewer_runtime.py g1_viewer/static/index.html
git commit -m "test: verify SONIC-style control panel integration"
```
