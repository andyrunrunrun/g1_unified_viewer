# G1 Viewer Dual-Interface Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `HTTP API + native viewer` as the product shape while converging all business state into `SessionController`, adding the browser tree, physics mode, diagnostics, and session-centric API endpoints.

**Architecture:** Add focused `browser.py` and `physics.py` helper modules so the session layer stays authoritative but not bloated. `SessionController` owns browser, playback, trim, physics, policy, and diagnostics state; `NativeViewerRuntime` consumes controller state and performs rendering/physics stepping; FastAPI becomes a thin command adapter with grouped session endpoints plus compatibility shims for the current routes.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic, MuJoCo, GLFW, vanilla HTML/CSS/JS, `unittest`, `uv`

---

## File Map

- Create: `g1_viewer/browser.py`
  - Motion-aware lazy directory listing for the control panel file tree.
- Create: `g1_viewer/physics.py`
  - MuJoCo helper functions for reset, state extraction, and PD torque mapping.
- Modify: `g1_viewer/models.py`
  - Browser models, grouped session request models, `physics_enabled`, diagnostics fields.
- Modify: `g1_viewer/session.py`
  - Single source of truth for browser, playback, trim, physics, policy summaries, and logs.
- Modify: `g1_viewer/api.py`
  - Thin grouped session endpoints plus compatibility aliases for existing routes.
- Modify: `g1_viewer/viewer_runtime.py`
  - Runtime branch between direct playback and physics stepping while reporting viewer state back to the controller.
- Modify: `g1_viewer/mock_policy_runner.py`
  - Stable observation/action contract: `robot_state + reference_target -> joint_position_target`.
- Modify: `g1_viewer/static/index.html`
  - File tree + diagnostics layout using only controller-backed API state.
- Modify: `examples/api_roundtrip_example.py`
  - Demonstrate the grouped session endpoints.
- Modify: `examples/policy_mock_example.py`
  - Demonstrate the updated mock policy contract.
- Modify: `tests/test_session_api.py`
  - End-to-end controller/API smoke tests for browser, physics, policy, compatibility, and root page.
- Modify: `README.md`
  - Explain the dual-interface architecture, grouped APIs, physics modes, and diagnostics workflow.

## Task 1: Add Browser Models and Lazy Tree Listing

**Files:**
- Create: `g1_viewer/browser.py`
- Modify: `g1_viewer/models.py`
- Modify: `g1_viewer/session.py`
- Modify: `g1_viewer/api.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing browser API tests**

```python
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
        response = self.client.post("/api/browser/list", json={"path": "/tmp/definitely-missing-root"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Path does not exist", response.text)
```

- [ ] **Step 2: Run the browser tests to verify they fail**

Run: `uv run python -m unittest tests.test_session_api.BrowserApiTest -v`

Expected:

```text
test_browser_list_returns_directory_and_motion_nodes ... FAIL
test_browser_list_rejects_missing_root ... FAIL
```

Expected failure reason: `404 Not Found` for `/api/browser/list` or missing browser request/response models.

- [ ] **Step 3: Add browser models in `g1_viewer/models.py`**

```python
class BrowserNode(BaseModel):
    path: str
    name: str
    node_type: Literal["directory", "motion"]
    format: MotionFormat | None = None
    has_children: bool = False


class BrowserListRequest(BaseModel):
    path: str


class BrowserListResponse(BaseModel):
    root: str
    nodes: list[BrowserNode]
```

- [ ] **Step 4: Implement motion-aware listing in `g1_viewer/browser.py`**

```python
from pathlib import Path

from .importers import detect_format
from .models import BrowserNode


def list_browser_nodes(path_str: str) -> tuple[str, list[BrowserNode]]:
    root = Path(path_str).expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Path does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Browser root must be a directory: {root}")

    nodes: list[BrowserNode] = []
    for child in sorted(root.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
        motion_format = detect_format(child)
        if motion_format is not None:
            nodes.append(
                BrowserNode(
                    path=str(child),
                    name=child.name,
                    node_type="motion",
                    format=motion_format,
                    has_children=False,
                )
            )
            continue
        if child.is_dir():
            has_children = any(
                grandchild.is_dir() or detect_format(grandchild) is not None
                for grandchild in child.iterdir()
            )
            nodes.append(
                BrowserNode(
                    path=str(child),
                    name=child.name,
                    node_type="directory",
                    format=None,
                    has_children=has_children,
                )
            )
    return str(root), nodes
```

- [ ] **Step 5: Thread the browser API through the controller and FastAPI**

```python
# g1_viewer/session.py
from .browser import list_browser_nodes


def list_browser(self, path_str: str) -> tuple[str, list[BrowserNode]]:
    root, nodes = list_browser_nodes(path_str)
    with self._lock:
        self._catalog_root = root
        self._last_error = None
    return root, nodes
```

```python
# g1_viewer/api.py
from .models import BrowserListRequest, BrowserListResponse


@app.post("/api/browser/list", response_model=BrowserListResponse)
def api_browser_list(request: BrowserListRequest) -> BrowserListResponse:
    try:
        root, nodes = get_controller().list_browser(request.path)
        return BrowserListResponse(root=root, nodes=nodes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
```

- [ ] **Step 6: Run the browser tests again to verify they pass**

Run: `uv run python -m unittest tests.test_session_api.BrowserApiTest -v`

Expected:

```text
test_browser_list_returns_directory_and_motion_nodes ... ok
test_browser_list_rejects_missing_root ... ok
```

- [ ] **Step 7: Commit the browser foundation**

```bash
git add g1_viewer/browser.py g1_viewer/models.py g1_viewer/session.py g1_viewer/api.py tests/test_session_api.py
git commit -m "feat: add lazy browser api for motion tree"
```

## Task 2: Extend Session State Into the Single Source of Truth

**Files:**
- Modify: `g1_viewer/models.py`
- Modify: `g1_viewer/session.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing session-state tests**

```python
class SessionStateSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(SONIC_SAMPLE), "sonic")

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_toggle_physics_updates_summary_and_logs(self) -> None:
        summary = self.controller.toggle_physics(True)
        self.assertTrue(summary.physics_enabled)
        self.assertIn("physics enabled", " ".join(summary.last_log_messages).lower())

        summary = self.controller.toggle_physics(False)
        self.assertFalse(summary.physics_enabled)
        self.assertIn("physics disabled", " ".join(summary.last_log_messages).lower())

    def test_seek_while_physics_on_keeps_session_state_consistent(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.seek(2)
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.current_frame, 2)
        self.assertIn("seek", " ".join(summary.last_log_messages).lower())
        self.assertEqual(summary.last_observation_summary, {})
        self.assertEqual(summary.last_action_summary, {})
```

- [ ] **Step 2: Run the session-state tests to verify they fail**

Run: `uv run python -m unittest tests.test_session_api.SessionStateSourceTest -v`

Expected:

```text
test_toggle_physics_updates_summary_and_logs ... FAIL
test_seek_while_physics_on_keeps_session_state_consistent ... FAIL
```

Expected failure reason: missing `toggle_physics`, `physics_enabled`, `last_log_messages`, `last_observation_summary`, or `last_action_summary`.

- [ ] **Step 3: Extend `SessionSummary` in `g1_viewer/models.py`**

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
    physics_enabled: bool = False
    view_mode: ViewMode = "dataset"
    active_policy_id: str | None = None
    viewer_connected: bool = False
    viewer_camera: ViewerCameraState | None = None
    last_policy_result: dict[str, Any] = Field(default_factory=dict)
    last_observation_summary: dict[str, Any] = Field(default_factory=dict)
    last_action_summary: dict[str, Any] = Field(default_factory=dict)
    last_log_messages: list[str] = Field(default_factory=list)
    last_error: str | None = None
```

- [ ] **Step 4: Add physics, diagnostics, and logging fields in `g1_viewer/session.py`**

```python
from collections import deque


self._physics_enabled = False
self._reference_state: CanonicalRobotState | None = None
self._simulated_state: CanonicalRobotState | None = None
self._physics_needs_reset = False
self._last_observation_summary: dict[str, Any] = {}
self._last_action_summary: dict[str, Any] = {}
self._log_messages: deque[str] = deque(maxlen=12)


def _push_log_locked(self, message: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    self._log_messages.appendleft(f"[{stamp}] {message}")


def toggle_physics(self, enabled: bool) -> SessionSummary:
    with self._lock:
        self._require_active_sequence_locked()
        self._physics_enabled = bool(enabled)
        self._physics_needs_reset = True
        self._simulated_state = None
        self._last_observation_summary = {}
        self._last_action_summary = {}
        if self._physics_enabled and self._active_policy_id is None:
            self.start_policy("mock_g1_policy")
        self._push_log_locked("physics enabled" if self._physics_enabled else "physics disabled")
        return self._build_summary_locked()
```

- [ ] **Step 5: Reset diagnostics from every state-changing controller path**

```python
def seek(self, frame_index: int) -> SessionSummary:
    with self._lock:
        sequence = self._require_active_sequence_locked()
        self._current_frame = min(max(frame_index, 0), sequence.frame_count - 1)
        self._last_playback_time = None
        self._frame_accumulator = 0.0
        if self._physics_enabled:
            self._physics_needs_reset = True
            self._simulated_state = None
            self._last_observation_summary = {}
            self._last_action_summary = {}
        self._push_log_locked(f"seek to frame {self._current_frame}")
        return self._build_summary_locked()
```

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
    physics_enabled=self._physics_enabled,
    view_mode="policy" if self._active_policy_id is not None else "dataset",
    active_policy_id=self._active_policy_id,
    viewer_connected=self._viewer_connected,
    viewer_camera=self._viewer_camera,
    last_policy_result=dict(self._last_policy_result),
    last_observation_summary=dict(self._last_observation_summary),
    last_action_summary=dict(self._last_action_summary),
    last_log_messages=list(self._log_messages),
    last_error=self._last_error,
)
```

- [ ] **Step 6: Run the session-state tests again to verify they pass**

Run: `uv run python -m unittest tests.test_session_api.SessionStateSourceTest -v`

Expected:

```text
test_toggle_physics_updates_summary_and_logs ... ok
test_seek_while_physics_on_keeps_session_state_consistent ... ok
```

- [ ] **Step 7: Commit the single-source-of-truth session changes**

```bash
git add g1_viewer/models.py g1_viewer/session.py tests/test_session_api.py
git commit -m "feat: add physics session state and diagnostics"
```

## Task 3: Implement the Physics Runtime and Mock Policy Contract

**Files:**
- Create: `g1_viewer/physics.py`
- Modify: `g1_viewer/session.py`
- Modify: `g1_viewer/viewer_runtime.py`
- Modify: `g1_viewer/mock_policy_runner.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing policy-contract and physics-runtime tests**

```python
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
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run: `uv run python -m unittest tests.test_session_api.MockPolicyContractTest tests.test_session_api.PhysicsRuntimeTest -v`

Expected:

```text
test_mock_policy_uses_robot_state_and_reference_target ... FAIL
test_physics_step_populates_action_and_observation_summaries ... FAIL
```

Expected failure reason: `physics_step()` and the new observation/action summaries do not exist yet, and the runner still uses the sinusoid placeholder behavior.

- [ ] **Step 3: Add MuJoCo helper functions in `g1_viewer/physics.py`**

```python
import numpy as np

from .models import CanonicalRobotState


def reset_data_to_state(model, data, state: CanonicalRobotState) -> None:
    data.qpos[:] = 0.0
    data.qvel[:] = 0.0
    data.ctrl[:] = 0.0
    data.qpos[:3] = np.asarray(state.root_translation[:3], dtype=float)
    data.qpos[3:7] = np.asarray(state.root_rotation_wxyz[:4], dtype=float)
    qpos_count = min(len(state.joint_positions), model.nq - 7)
    qvel_count = min(len(state.joint_velocities), model.nv - 6)
    data.qpos[7 : 7 + qpos_count] = np.asarray(state.joint_positions[:qpos_count], dtype=float)
    data.qvel[6 : 6 + qvel_count] = np.asarray(state.joint_velocities[:qvel_count], dtype=float)


def state_from_data(data, joint_count: int) -> CanonicalRobotState:
    return CanonicalRobotState(
        timestamp=0.0,
        root_translation=np.asarray(data.qpos[:3], dtype=float).tolist(),
        root_rotation_wxyz=np.asarray(data.qpos[3:7], dtype=float).tolist(),
        joint_positions=np.asarray(data.qpos[7 : 7 + joint_count], dtype=float).tolist(),
        joint_velocities=np.asarray(data.qvel[6 : 6 + joint_count], dtype=float).tolist(),
    )


def compute_pd_torque_targets(data, target_positions: list[float], kp: float = 30.0, kd: float = 1.5) -> np.ndarray:
    target = np.asarray(target_positions, dtype=float)
    current = np.asarray(data.qpos[7 : 7 + len(target)], dtype=float)
    current_vel = np.asarray(data.qvel[6 : 6 + len(target)], dtype=float)
    torque = kp * (target - current) - kd * current_vel
    return np.clip(torque, -80.0, 80.0)
```

- [ ] **Step 4: Build the policy inputs and summaries in `g1_viewer/session.py`**

```python
def reference_state(self, now: float | None = None) -> CanonicalRobotState:
    tick_now = time.monotonic() if now is None else now
    with self._lock:
        state = self._dataset_state_locked(tick_now)
        self._reference_state = _clone_state(state)
        return state


def _build_policy_inputs_locked(
    self,
    robot_state: CanonicalRobotState,
    reference_state: CanonicalRobotState,
    dt: float,
) -> dict[str, Any]:
    return {
        "robot_state": {
            "root_position": robot_state.root_translation,
            "root_rotation_wxyz": robot_state.root_rotation_wxyz,
            "joint_positions": robot_state.joint_positions,
            "joint_velocities": robot_state.joint_velocities,
        },
        "reference_target": {
            "target_root_position": reference_state.root_translation,
            "target_root_rotation_wxyz": reference_state.root_rotation_wxyz,
            "target_joint_positions": reference_state.joint_positions,
            "target_joint_velocities": reference_state.joint_velocities,
        },
        "frame_index": self._current_frame,
        "dt": dt,
    }


def physics_step(self, robot_state: CanonicalRobotState, *, now: float | None = None) -> dict[str, Any]:
    tick_now = time.monotonic() if now is None else now
    with self._lock:
        sequence = self._require_active_sequence_locked()
        reference_state = self._dataset_state_locked(tick_now)
        self._reference_state = _clone_state(reference_state)
        if self._active_policy_id is None:
            self.start_policy("mock_g1_policy")

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
        result = self._policy_manager.step(self._active_policy_id, snapshot)
        values = [float(value) for value in result.get("values", [])]
        self._last_policy_result = result
        self._last_policy_step_time = tick_now
        self._last_action_summary = {
            "mode": result.get("mode", "unknown"),
            "value_count": len(values),
            "first_values": values[:6],
        }
        return {
            "mode": result.get("mode", "joint_position_target"),
            "values": values,
            "metadata": result.get("metadata", {}),
        }


def consume_physics_reset_flag(self) -> bool:
    with self._lock:
        flag = self._physics_needs_reset
        self._physics_needs_reset = False
        return flag


def update_simulated_state(self, state: CanonicalRobotState) -> None:
    with self._lock:
        self._simulated_state = _clone_state(state)
```

- [ ] **Step 5: Replace the mock runner placeholder and branch the native runtime**

```python
# g1_viewer/mock_policy_runner.py
def _describe() -> dict:
    return {
        "policy_id": "mock_g1_policy",
        "display_name": "Mock G1 Policy",
        "robot_type": "g1",
        "observation_spec": {
            "robot_state": ["root_position", "root_rotation_wxyz", "joint_positions", "joint_velocities"],
            "reference_target": [
                "target_root_position",
                "target_root_rotation_wxyz",
                "target_joint_positions",
                "target_joint_velocities",
            ],
            "extras": ["frame_index", "dt"],
        },
        "action_spec": {"mode": "joint_position_target"},
    }


def _step(payload: dict) -> dict:
    snapshot = payload.get("snapshot", {})
    metadata = snapshot.get("metadata", {})
    policy_inputs = metadata.get("policy_inputs", {})
    reference_target = policy_inputs.get("reference_target", {})
    values = [float(value) for value in reference_target.get("target_joint_positions", [])]
    return {
        "mode": "joint_position_target",
        "values": values,
        "metadata": {
            "runner": "mock",
            "frame_index": policy_inputs.get("frame_index", 0),
            "dt": policy_inputs.get("dt", 0.0),
        },
    }
```

```python
# g1_viewer/viewer_runtime.py
from .physics import compute_pd_torque_targets, reset_data_to_state, state_from_data


if summary.physics_enabled:
    if self.controller.consume_physics_reset_flag():
        reference_state = self.controller.reference_state()
        reset_data_to_state(self.model, self.data, reference_state)
        mujoco.mj_forward(self.model, self.data)

    robot_state = state_from_data(self.data, joint_count=min(self.model.nu, self.model.nq - 7))
    action = self.controller.physics_step(robot_state, now=time.monotonic())
    ctrl = compute_pd_torque_targets(self.data, action["values"])
    self.data.ctrl[: len(ctrl)] = ctrl
    mujoco.mj_step(self.model, self.data)
    simulated_state = state_from_data(self.data, joint_count=min(self.model.nu, self.model.nq - 7))
    self.controller.update_simulated_state(simulated_state)
else:
    state = self.controller.tick()
    self._apply_state(state)
    mujoco.mj_forward(self.model, self.data)
```

- [ ] **Step 6: Run the contract tests again to verify they pass**

Run: `uv run python -m unittest tests.test_session_api.MockPolicyContractTest tests.test_session_api.PhysicsRuntimeTest -v`

Expected:

```text
test_mock_policy_uses_robot_state_and_reference_target ... ok
test_physics_step_populates_action_and_observation_summaries ... ok
```

- [ ] **Step 7: Commit the physics-runtime and policy-contract changes**

```bash
git add g1_viewer/physics.py g1_viewer/session.py g1_viewer/viewer_runtime.py g1_viewer/mock_policy_runner.py tests/test_session_api.py
git commit -m "feat: add physics runtime and mock policy contract"
```

## Task 4: Add Grouped Session Endpoints While Keeping Compatibility

**Files:**
- Modify: `g1_viewer/models.py`
- Modify: `g1_viewer/api.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing grouped-endpoint tests**

```python
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

    def test_legacy_playback_seek_alias_still_works(self) -> None:
        self.client.post("/api/session/load", json={"path": str(SONIC_SAMPLE), "format": "sonic"})
        response = self.client.post("/api/playback/seek", json={"frame_index": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["current_frame"], 2)
```

- [ ] **Step 2: Run the grouped-endpoint tests to verify they fail**

Run: `uv run python -m unittest tests.test_session_api.GroupedApiTest -v`

Expected:

```text
test_grouped_session_and_policy_endpoints_share_state ... FAIL
test_legacy_playback_seek_alias_still_works ... ok
```

Expected failure reason: the new grouped routes do not exist yet.

- [ ] **Step 3: Add grouped request models in `g1_viewer/models.py`**

```python
class SessionLoadRequest(BaseModel):
    path: str
    format: MotionFormat | None = None


class SessionPlaybackRequest(BaseModel):
    action: Literal["play", "pause", "stop", "seek", "loop"]
    frame_index: int | None = None
    enabled: bool | None = None


class SessionTrimRequest(BaseModel):
    action: Literal["set_start", "set_end", "mark_start", "mark_end"]
    frame_index: int | None = None


class SessionPhysicsRequest(BaseModel):
    enabled: bool


class PolicyActivationRequest(BaseModel):
    policy_id: str | None = None


class PolicyStepRequest(BaseModel):
    policy_id: str | None = None
    snapshot: SimulationSnapshot | None = None
```

- [ ] **Step 4: Implement grouped session and policy routes in `g1_viewer/api.py`**

```python
def _handle_playback_request(controller: SessionController, request: SessionPlaybackRequest) -> SessionSummary:
    match request.action:
        case "play":
            return controller.play()
        case "pause":
            return controller.pause()
        case "stop":
            return controller.stop()
        case "seek":
            if request.frame_index is None:
                raise ValueError("frame_index is required for seek")
            return controller.seek(request.frame_index)
        case "loop":
            if request.enabled is None:
                raise ValueError("enabled is required for loop")
            return controller.set_loop(request.enabled)
    raise ValueError(f"Unsupported playback action: {request.action}")


def _handle_trim_request(controller: SessionController, request: SessionTrimRequest) -> SessionSummary:
    match request.action:
        case "set_start":
            if request.frame_index is None:
                raise ValueError("frame_index is required for set_start")
            return controller.set_trim_start(request.frame_index)
        case "set_end":
            if request.frame_index is None:
                raise ValueError("frame_index is required for set_end")
            return controller.set_trim_end(request.frame_index)
        case "mark_start":
            return controller.set_trim_start_to_current()
        case "mark_end":
            return controller.set_trim_end_to_current()
    raise ValueError(f"Unsupported trim action: {request.action}")


@app.post("/api/session/load", response_model=LoadClipResponse)
def api_session_load(request: SessionLoadRequest) -> LoadClipResponse:
    try:
        sequence = get_controller().load_clip(request.path, request.format)
        return LoadClipResponse(sequence=summarize_sequence(sequence))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/playback", response_model=SessionSummary)
def api_session_playback(request: SessionPlaybackRequest) -> SessionSummary:
    try:
        return _handle_playback_request(get_controller(), request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/trim", response_model=SessionSummary)
def api_session_trim(request: SessionTrimRequest) -> SessionSummary:
    try:
        return _handle_trim_request(get_controller(), request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/physics", response_model=SessionSummary)
def api_session_physics(request: SessionPhysicsRequest) -> SessionSummary:
    try:
        return get_controller().toggle_physics(request.enabled)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/policies/active", response_model=PolicyOperationResponse)
def api_policy_active(request: PolicyActivationRequest) -> PolicyOperationResponse:
    if request.policy_id is None:
        get_controller().stop_policy()
        return PolicyOperationResponse(ok=True, message="runner stopped", result={})
    result = get_controller().start_policy(request.policy_id)
    return PolicyOperationResponse(ok=True, message="runner started", result=result)


@app.post("/api/policies/step", response_model=PolicyOperationResponse)
def api_policy_step(request: PolicyStepRequest) -> PolicyOperationResponse:
    policy_id = request.policy_id or get_controller().get_session_summary().active_policy_id
    if policy_id is None:
        raise HTTPException(status_code=400, detail="No active policy")
    result = get_controller().step_policy(policy_id, request.snapshot, now=time.monotonic())
    return PolicyOperationResponse(ok=True, message="policy step ok", result=result)
```

- [ ] **Step 5: Keep the legacy routes as compatibility aliases**

```python
@app.post("/api/playback/seek", response_model=SessionSummary)
def api_playback_seek(request: SeekRequest) -> SessionSummary:
    try:
        grouped_request = SessionPlaybackRequest(action="seek", frame_index=request.frame_index)
        return _handle_playback_request(get_controller(), grouped_request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/load_clip", response_model=LoadClipResponse)
def api_load_clip(request: LoadClipRequest) -> LoadClipResponse:
    grouped_request = SessionLoadRequest(path=request.path, format=request.format)
    return api_session_load(grouped_request)


@app.post("/api/playback/play", response_model=SessionSummary)
def api_playback_play() -> SessionSummary:
    return _handle_playback_request(get_controller(), SessionPlaybackRequest(action="play"))


@app.post("/api/playback/pause", response_model=SessionSummary)
def api_playback_pause() -> SessionSummary:
    return _handle_playback_request(get_controller(), SessionPlaybackRequest(action="pause"))


@app.post("/api/playback/stop", response_model=SessionSummary)
def api_playback_stop() -> SessionSummary:
    return _handle_playback_request(get_controller(), SessionPlaybackRequest(action="stop"))


@app.post("/api/playback/loop", response_model=SessionSummary)
def api_playback_loop(request: LoopRequest) -> SessionSummary:
    return _handle_playback_request(
        get_controller(),
        SessionPlaybackRequest(action="loop", enabled=request.enabled),
    )


@app.post("/api/playback/trim_start", response_model=SessionSummary)
def api_playback_trim_start(request: TrimFrameRequest) -> SessionSummary:
    return _handle_trim_request(
        get_controller(),
        SessionTrimRequest(action="set_start", frame_index=request.frame_index),
    )


@app.post("/api/playback/trim_end", response_model=SessionSummary)
def api_playback_trim_end(request: TrimFrameRequest) -> SessionSummary:
    return _handle_trim_request(
        get_controller(),
        SessionTrimRequest(action="set_end", frame_index=request.frame_index),
    )
```

- [ ] **Step 6: Run the grouped-endpoint tests again to verify they pass**

Run: `uv run python -m unittest tests.test_session_api.GroupedApiTest -v`

Expected:

```text
test_grouped_session_and_policy_endpoints_share_state ... ok
test_legacy_playback_seek_alias_still_works ... ok
```

- [ ] **Step 7: Commit the grouped API convergence**

```bash
git add g1_viewer/models.py g1_viewer/api.py tests/test_session_api.py
git commit -m "feat: add grouped session api endpoints"
```

## Task 5: Refresh the Web Control Panel as a Thin Diagnostics Client

**Files:**
- Modify: `g1_viewer/static/index.html`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing root-page smoke test**

```python
class RootPageSmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_root_page_contains_tree_physics_and_diagnostics_sections(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("动作文件树", body)
        self.assertIn("Physics OFF", body)
        self.assertIn("日志", body)
        self.assertIn("Observation", body)
        self.assertIn("Action", body)
```

- [ ] **Step 2: Run the root-page smoke test to verify it fails**

Run: `uv run python -m unittest tests.test_session_api.RootPageSmokeTest -v`

Expected:

```text
test_root_page_contains_tree_physics_and_diagnostics_sections ... FAIL
```

Expected failure reason: the current page still uses the earlier scan list layout and does not expose the tree/physics/diagnostics sections.

- [ ] **Step 3: Replace the page structure in `g1_viewer/static/index.html`**

```html
<header class="toolbar">
  <input id="pathInput" type="text" placeholder="输入数据根目录" />
  <button id="scanButton">扫描</button>
  <button id="playButton">播放</button>
  <button id="pauseButton">暂停</button>
  <button id="stopButton">停止</button>
  <button id="physicsToggleButton">Physics OFF</button>
  <button id="startPolicyButton">启动策略</button>
  <button id="stopPolicyButton">停止策略</button>
  <button id="exportButton">导出裁剪</button>
</header>

<div class="main-grid">
  <aside class="tree-panel">
    <h2>动作文件树</h2>
    <div id="treeRoot"></div>
  </aside>
  <section class="center-panel">
    <h2>当前动作</h2>
    <div id="clipSummary"></div>
    <input id="timeline" type="range" min="0" max="0" value="0" />
    <div id="trimSummary"></div>
  </section>
  <aside class="inspector-panel">
    <h2>策略与检查器</h2>
    <pre id="policyPane"></pre>
    <pre id="cameraPane"></pre>
  </aside>
</div>

<section class="bottom-grid">
  <div>
    <h3>日志</h3>
    <pre id="logPane"></pre>
  </div>
  <div>
    <h3>Observation</h3>
    <pre id="observationPane"></pre>
  </div>
  <div>
    <h3>Action</h3>
    <pre id="actionPane"></pre>
  </div>
</section>
```

- [ ] **Step 4: Switch the page script to the grouped session endpoints**

```javascript
async function loadTree(path, container, depth = 0) {
  const payload = await postJson("/api/browser/list", { path });
  for (const node of payload.nodes) {
    const row = document.createElement("div");
    row.className = `tree-node depth-${depth}`;
    row.textContent = node.name;
    if (node.node_type === "directory" && node.has_children) {
      row.addEventListener("click", async () => {
        if (row.dataset.loaded === "true") {
          row.nextElementSibling?.classList.toggle("hidden");
          return;
        }
        const childContainer = document.createElement("div");
        childContainer.className = "tree-children";
        row.after(childContainer);
        await loadTree(node.path, childContainer, depth + 1);
        row.dataset.loaded = "true";
      });
    } else {
      row.addEventListener("click", async () => {
        await postJson("/api/session/load", { path: node.path, format: node.format });
        await refreshSession();
      });
    }
    container.appendChild(row);
  }
}

async function togglePhysics() {
  const enabled = !(state.session?.physics_enabled ?? false);
  await postJson("/api/session/physics", { enabled });
  await refreshSession();
}

function renderDiagnostics(session) {
  physicsToggleButton.textContent = session.physics_enabled ? "Physics ON" : "Physics OFF";
  logPane.textContent = session.last_log_messages.join("\n");
  observationPane.textContent = JSON.stringify(session.last_observation_summary, null, 2);
  actionPane.textContent = JSON.stringify(session.last_action_summary, null, 2);
  policyPane.textContent = JSON.stringify(
    {
      active_policy_id: session.active_policy_id,
      last_policy_result: session.last_policy_result,
      last_error: session.last_error,
    },
    null,
    2,
  );
}
```

- [ ] **Step 5: Make the playback buttons thin clients of `/api/session/playback`**

```javascript
playButton.addEventListener("click", async () => {
  await postJson("/api/session/playback", { action: "play" });
  await refreshSession();
});

pauseButton.addEventListener("click", async () => {
  await postJson("/api/session/playback", { action: "pause" });
  await refreshSession();
});

stopButton.addEventListener("click", async () => {
  await postJson("/api/session/playback", { action: "stop" });
  await refreshSession();
});

timeline.addEventListener("input", async () => {
  await postJson("/api/session/playback", { action: "seek", frame_index: Number(timeline.value) });
  await refreshSession();
});
```

- [ ] **Step 6: Run the root-page smoke test again to verify it passes**

Run: `uv run python -m unittest tests.test_session_api.RootPageSmokeTest -v`

Expected:

```text
test_root_page_contains_tree_physics_and_diagnostics_sections ... ok
```

- [ ] **Step 7: Commit the control-panel refresh**

```bash
git add g1_viewer/static/index.html tests/test_session_api.py
git commit -m "feat: refresh web control panel as diagnostics client"
```

## Task 6: Update Docs, Examples, and Run Full Validation

**Files:**
- Modify: `README.md`
- Modify: `examples/api_roundtrip_example.py`
- Modify: `examples/policy_mock_example.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing README smoke test**

```python
class ReadmeSmokeTest(unittest.TestCase):
    def test_readme_mentions_dual_interface_and_physics_modes(self) -> None:
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("HTTP API + native viewer", readme)
        self.assertIn("SessionController", readme)
        self.assertIn("Physics OFF", readme)
        self.assertIn("Physics ON", readme)
```

- [ ] **Step 2: Run the README smoke test to verify it fails**

Run: `uv run python -m unittest tests.test_session_api.ReadmeSmokeTest -v`

Expected:

```text
test_readme_mentions_dual_interface_and_physics_modes ... FAIL
```

Expected failure reason: the current README describes the product shape but not the new single-source-of-truth architecture or grouped APIs.

- [ ] **Step 3: Update `README.md` with the dual-interface architecture**

```markdown
## 架构边界

- `SessionController`
  - 单一状态源，负责浏览、播放、trim、physics、policy、viewer 摘要
- `HTTP API + native viewer`
  - HTTP API 负责控制和自动化入口
  - native viewer 负责 MuJoCo 渲染和本地高频交互

## Physics OFF / ON

- `Physics OFF`
  - 直接回放 reference state
- `Physics ON`
  - 读取 robot state + reference target
  - 通过 `mock_g1_policy` 输出 `joint_position_target`
  - 由 runtime 执行 MuJoCo step
```

- [ ] **Step 4: Update the examples to use the grouped API and policy contract**

```python
# examples/api_roundtrip_example.py
browser = client.post("/api/browser/list", json={"path": str(sample_path.parent)})
print("browser:", browser.status_code, browser.json()["root"])

load = client.post("/api/session/load", json={"path": str(sample_path), "format": "sonic"})
sequence = load.json()["sequence"]
print("load:", load.status_code, sequence)

seek = client.post("/api/session/playback", json={"action": "seek", "frame_index": 1})
print("seek:", seek.status_code, seek.json()["current_frame"])
```

```python
# examples/policy_mock_example.py
policy_inputs = {
    "robot_state": {
        "root_position": sequence.frames[0].root_translation,
        "root_rotation_wxyz": sequence.frames[0].root_rotation_wxyz,
        "joint_positions": sequence.frames[0].joint_positions,
        "joint_velocities": sequence.frames[0].joint_velocities,
    },
    "reference_target": {
        "target_root_position": sequence.frames[0].root_translation,
        "target_root_rotation_wxyz": sequence.frames[0].root_rotation_wxyz,
        "target_joint_positions": sequence.frames[0].joint_positions,
        "target_joint_velocities": sequence.frames[0].joint_velocities,
    },
    "frame_index": 0,
    "dt": 0.0,
}
snapshot = SimulationSnapshot(
    timestamp=sequence.frames[0].timestamp,
    state=sequence.frames[0],
    metadata={"policy_inputs": policy_inputs},
)
```

- [ ] **Step 5: Run the full validation suite**

Run: `uv run python -m unittest tests.test_session_api -v`

Expected:

```text
...
Ran ... tests in ...
OK
```

Run: `uv run python -m py_compile main.py g1_viewer/*.py examples/*.py`

Expected: no output.

Run: `uv run python examples/api_roundtrip_example.py`

Expected:

```text
browser: 200 ...
load: 200 ...
seek: 200 1
render: 200 ...
trim: 200 ...
policies: 200 ...
```

Run: `uv run python examples/policy_mock_example.py`

Expected:

```text
available policies: ['mock_g1_policy']
start: ...
step: {'mode': 'joint_position_target', ...}
stopped mock_g1_policy
```

- [ ] **Step 6: Commit the docs and example alignment**

```bash
git add README.md examples/api_roundtrip_example.py examples/policy_mock_example.py tests/test_session_api.py
git commit -m "docs: align readme and examples with dual interface architecture"
```

## Self-Review

- Spec coverage:
  - 单状态源 `SessionController`: Task 2, Task 3, Task 4
  - 双界面边界: Task 4, Task 5, Task 6
  - `Physics OFF / ON`: Task 2, Task 3, Task 5, Task 6
  - 浏览器文件树: Task 1, Task 5
  - grouped API + compatibility: Task 4
  - 日志 / observation / action 摘要: Task 2, Task 3, Task 5
- Placeholder scan:
  - No `TODO`, `TBD`, or “similar to Task N” references remain.
- Type consistency:
  - Plan consistently uses `BrowserNode`, `BrowserListRequest`, `physics_enabled`, `last_observation_summary`, `last_action_summary`, `SessionPlaybackRequest`, `PolicyActivationRequest`, and `joint_position_target`.
