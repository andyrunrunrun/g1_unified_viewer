# G1 Viewer File Tree, Physics Toggle, and Mock Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat motion list with a lazy-loaded file tree, add explicit `Physics OFF / ON` runtime modes, and upgrade `mock_g1_policy` so it consumes robot state plus reference targets and emits joint position targets that the MuJoCo runtime tracks.

**Architecture:** Add a focused browser layer for directory-tree traversal, extend session state so UI, API, and MuJoCo runtime share explicit physics and diagnostics state, and keep MuJoCo native viewer as the only renderer. `Physics OFF` continues direct state playback; `Physics ON` builds policy observations from simulated state and reference targets, then uses a small PD/servo torque mapper to drive the existing motor actuators in the bundled G1 MJCF.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic, MuJoCo, GLFW, vanilla HTML/CSS/JS, `unittest`, `uv`

---

## File Map

- Create: `g1_viewer/browser.py`
  - Directory tree listing and motion-node detection for lazy-loaded file browsing.
- Create: `g1_viewer/physics.py`
  - Runtime helpers for reading robot state from `MjData`, resetting simulation state, and mapping joint targets to torque controls.
- Modify: `g1_viewer/models.py`
  - Browser node request/response models, `physics_enabled`, observation/action/log summaries in `SessionSummary`.
- Modify: `g1_viewer/session.py`
  - Physics mode state, browser listing entrypoint, reset flow, observation/action summaries, compact log buffer.
- Modify: `g1_viewer/api.py`
  - `/api/browser/list`, `/api/physics/toggle`, expanded `/api/session`, updated policy-step wiring.
- Modify: `g1_viewer/viewer_runtime.py`
  - Branch between playback mode and physics mode, policy-driven stepping, runtime reset on seek/clip/mode switches.
- Modify: `g1_viewer/mock_policy_runner.py`
  - New observation contract and target-position passthrough behavior.
- Modify: `g1_viewer/static/index.html`
  - Replace card-heavy layout with practical IDE-style toolbar + file tree + inspector + bottom diagnostics.
- Modify: `tests/test_session_api.py`
  - Cover browser listing, physics toggle, reset behavior, session summaries, and root-page smoke labels.
- Modify: `README.md`
  - Document the new file tree, `Physics OFF / ON`, and mock policy behavior.

## Task 1: Add Browser Models and Lazy File Tree Listing

**Files:**
- Create: `g1_viewer/browser.py`
- Modify: `g1_viewer/models.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing tests for browser listing**

```python
class BrowserApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_browser_list_returns_motion_nodes_for_example_data(self) -> None:
        sample_root = REPO_ROOT / "examples" / "sample_data"
        response = self.client.post("/api/browser/list", json={"path": str(sample_root)})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        names = {node["name"]: node for node in payload["nodes"]}

        self.assertIn("sonic_demo", names)
        self.assertIn("twist2_demo.pkl", names)
        self.assertEqual(names["sonic_demo"]["node_type"], "motion")
        self.assertEqual(names["sonic_demo"]["format"], "sonic")
        self.assertFalse(names["sonic_demo"]["has_children"])
        self.assertEqual(names["twist2_demo.pkl"]["node_type"], "motion")
        self.assertEqual(names["twist2_demo.pkl"]["format"], "twist2")

    def test_browser_list_rejects_missing_path(self) -> None:
        response = self.client.post("/api/browser/list", json={"path": "/tmp/definitely_missing_motion_root"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Path does not exist", response.text)
```

- [ ] **Step 2: Run the browser tests to verify they fail**

Run: `uv run python -m unittest tests.test_session_api.BrowserApiTest -v`

Expected: FAIL with `404 Not Found` for `/api/browser/list` or import/model errors for missing browser response types.

- [ ] **Step 3: Add browser request/response models in `g1_viewer/models.py`**

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

- [ ] **Step 4: Implement `g1_viewer/browser.py` with motion-aware directory listing**

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
            has_children = any(grandchild.is_dir() or detect_format(grandchild) is not None for grandchild in child.iterdir())
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

- [ ] **Step 5: Add `/api/browser/list` in `g1_viewer/api.py`**

```python
from .browser import list_browser_nodes
from .models import BrowserListRequest, BrowserListResponse


@app.post("/api/browser/list", response_model=BrowserListResponse)
def api_browser_list(request: BrowserListRequest) -> BrowserListResponse:
    try:
        root, nodes = list_browser_nodes(request.path)
        return BrowserListResponse(root=root, nodes=nodes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
```

- [ ] **Step 6: Run the browser tests again to verify they pass**

Run: `uv run python -m unittest tests.test_session_api.BrowserApiTest -v`

Expected:

```text
test_browser_list_returns_motion_nodes_for_example_data ... ok
test_browser_list_rejects_missing_path ... ok
```

- [ ] **Step 7: Commit the browser foundation**

```bash
git add g1_viewer/browser.py g1_viewer/models.py g1_viewer/api.py tests/test_session_api.py
git commit -m "feat: add lazy browser api for motion tree"
```

## Task 2: Extend Session State for Physics Mode, Logs, and Diagnostics

**Files:**
- Modify: `g1_viewer/models.py`
- Modify: `g1_viewer/session.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing session tests for physics state and logs**

```python
class SessionPhysicsStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(SONIC_SAMPLE), "sonic")

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_physics_toggle_updates_summary_and_logs(self) -> None:
        summary = self.controller.toggle_physics(True)
        self.assertTrue(summary.physics_enabled)
        self.assertIn("physics enabled", " ".join(summary.last_log_messages).lower())

        summary = self.controller.toggle_physics(False)
        self.assertFalse(summary.physics_enabled)
        self.assertIn("physics disabled", " ".join(summary.last_log_messages).lower())

    def test_seek_resets_physics_diagnostics(self) -> None:
        self.controller.toggle_physics(True)
        self.controller.seek(2)
        summary = self.controller.get_session_summary()
        self.assertTrue(summary.physics_enabled)
        self.assertEqual(summary.current_frame, 2)
        self.assertIn("seek", " ".join(summary.last_log_messages).lower())
```

- [ ] **Step 2: Run the session physics tests to verify they fail**

Run: `uv run python -m unittest tests.test_session_api.SessionPhysicsStateTest -v`

Expected: FAIL with `AttributeError: 'SessionController' object has no attribute 'toggle_physics'` and missing `physics_enabled` / `last_log_messages`.

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

- [ ] **Step 4: Add logging, physics toggle, and reset hooks in `g1_viewer/session.py`**

```python
from collections import deque


self._physics_enabled = False
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
        self._policy_state = None
        self._last_observation_summary = {}
        self._last_action_summary = {}
        if self._physics_enabled and self._active_policy_id is None:
            self.start_policy("mock_g1_policy")
        self._push_log_locked("physics enabled" if self._physics_enabled else "physics disabled")
        return self._build_summary_locked()


def _record_seek_locked(self, frame_index: int) -> None:
    self._push_log_locked(f"seek to frame {frame_index}")
    if self._physics_enabled:
        self._policy_state = None
        self._last_observation_summary = {}
        self._last_action_summary = {}
```

- [ ] **Step 5: Update `_build_summary_locked()` and call sites in `g1_viewer/session.py`**

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

- [ ] **Step 6: Run the session physics tests to verify they pass**

Run: `uv run python -m unittest tests.test_session_api.SessionPhysicsStateTest -v`

Expected:

```text
test_physics_toggle_updates_summary_and_logs ... ok
test_seek_resets_physics_diagnostics ... ok
```

- [ ] **Step 7: Commit the session-state changes**

```bash
git add g1_viewer/models.py g1_viewer/session.py tests/test_session_api.py
git commit -m "feat: add physics session state and diagnostics"
```

## Task 3: Redefine Mock Policy Observation and Action Contract

**Files:**
- Modify: `g1_viewer/session.py`
- Modify: `g1_viewer/mock_policy_runner.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing policy observation test**

```python
class MockPolicyContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.toggle_physics(True)

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_mock_policy_uses_robot_state_and_reference_target(self) -> None:
        result = self.controller.step_policy("mock_g1_policy")
        summary = self.controller.get_session_summary()

        self.assertEqual(result["mode"], "joint_position_target")
        self.assertIn("robot_state", summary.last_observation_summary)
        self.assertIn("reference_target", summary.last_observation_summary)
        self.assertIn("target_joint_positions", summary.last_observation_summary["reference_target"])
        self.assertEqual(
            len(result["values"]),
            len(summary.last_observation_summary["reference_target"]["target_joint_positions"]),
        )
```

- [ ] **Step 2: Run the policy contract test to verify it fails**

Run: `uv run python -m unittest tests.test_session_api.MockPolicyContractTest -v`

Expected: FAIL because `last_observation_summary` is empty and the runner still uses the old sinusoid placeholder behavior.

- [ ] **Step 3: Build the policy observation in `g1_viewer/session.py`**

```python
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
```

- [ ] **Step 4: Attach observation summaries to the snapshot and session**

```python
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
self._last_action_summary = {
    "mode": result.get("mode", "unknown"),
    "value_count": len(result.get("values", [])),
    "first_values": [float(value) for value in result.get("values", [])[:6]],
}
```

- [ ] **Step 5: Replace sinusoid behavior in `g1_viewer/mock_policy_runner.py`**

```python
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

- [ ] **Step 6: Run the policy contract test again to verify it passes**

Run: `uv run python -m unittest tests.test_session_api.MockPolicyContractTest -v`

Expected:

```text
test_mock_policy_uses_robot_state_and_reference_target ... ok
```

- [ ] **Step 7: Commit the mock policy contract changes**

```bash
git add g1_viewer/session.py g1_viewer/mock_policy_runner.py tests/test_session_api.py
git commit -m "feat: redefine mock policy observation and action contract"
```

## Task 4: Implement Physics ON Runtime with PD Torque Mapping

**Files:**
- Create: `g1_viewer/physics.py`
- Modify: `g1_viewer/session.py`
- Modify: `g1_viewer/viewer_runtime.py`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing runtime-physics tests**

```python
class PhysicsRuntimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.controller.load_clip(str(TWIST2_SAMPLE), "twist2")
        self.controller.toggle_physics(True)

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_tick_in_physics_mode_populates_action_and_observation_summaries(self) -> None:
        state = self.controller.tick(now=time.monotonic())
        summary = self.controller.get_session_summary()

        self.assertTrue(summary.physics_enabled)
        self.assertGreater(len(state.joint_positions), 0)
        self.assertIn("robot_state", summary.last_observation_summary)
        self.assertEqual(summary.last_action_summary["mode"], "joint_position_target")
        self.assertGreater(summary.last_action_summary["value_count"], 0)
```

- [ ] **Step 2: Run the runtime-physics test to verify it fails**

Run: `uv run python -m unittest tests.test_session_api.PhysicsRuntimeTest -v`

Expected: FAIL because `tick()` still returns the old direct policy-state override path without a simulator/torque-control branch.

- [ ] **Step 3: Implement MuJoCo helpers in `g1_viewer/physics.py`**

```python
import numpy as np

from .models import CanonicalRobotState


def reset_data_to_state(model, data, state: CanonicalRobotState) -> None:
    data.qpos[:] = 0.0
    data.qvel[:] = 0.0
    data.qpos[:3] = np.asarray(state.root_translation[:3], dtype=float)
    data.qpos[3:7] = np.asarray(state.root_rotation_wxyz[:4], dtype=float)
    joint_count = min(len(state.joint_positions), model.nq - 7)
    vel_count = min(len(state.joint_velocities), model.nv - 6)
    data.qpos[7 : 7 + joint_count] = np.asarray(state.joint_positions[:joint_count], dtype=float)
    data.qvel[6 : 6 + vel_count] = np.asarray(state.joint_velocities[:vel_count], dtype=float)


def compute_pd_torque_targets(data, target_positions: list[float], kp: float = 30.0, kd: float = 1.5) -> np.ndarray:
    target = np.asarray(target_positions, dtype=float)
    current = np.asarray(data.qpos[7 : 7 + len(target)], dtype=float)
    current_vel = np.asarray(data.qvel[6 : 6 + len(target)], dtype=float)
    torque = kp * (target - current) - kd * current_vel
    return np.clip(torque, -80.0, 80.0)


def state_from_data(data, joint_count: int) -> CanonicalRobotState:
    return CanonicalRobotState(
        timestamp=0.0,
        root_translation=np.asarray(data.qpos[:3], dtype=float).tolist(),
        root_rotation_wxyz=np.asarray(data.qpos[3:7], dtype=float).tolist(),
        joint_positions=np.asarray(data.qpos[7 : 7 + joint_count], dtype=float).tolist(),
        joint_velocities=np.asarray(data.qvel[6 : 6 + joint_count], dtype=float).tolist(),
    )
```

- [ ] **Step 4: Add physics-reset markers and simulator state slots in `g1_viewer/session.py`**

```python
self._simulated_state: CanonicalRobotState | None = None
self._physics_needs_reset = False


def mark_physics_reset_needed(self, reason: str) -> None:
    with self._lock:
        self._physics_needs_reset = True
        self._push_log_locked(reason)


def consume_physics_reset_flag(self) -> bool:
    with self._lock:
        flag = self._physics_needs_reset
        self._physics_needs_reset = False
        return flag
```

- [ ] **Step 5: Branch the runtime loop in `g1_viewer/viewer_runtime.py`**

```python
from .physics import compute_pd_torque_targets, reset_data_to_state, state_from_data


if self.controller.get_session_summary().physics_enabled:
    if self.controller.consume_physics_reset_flag():
        reference_state = self.controller.reference_state()
        reset_data_to_state(self.model, self.data, reference_state)
        mujoco.mj_forward(self.model, self.data)

    robot_state = state_from_data(self.data, joint_count=self.model.nu)
    action = self.controller.physics_step(robot_state, now=time.monotonic())
    ctrl = compute_pd_torque_targets(self.data, action["values"])
    self.data.ctrl[: len(ctrl)] = ctrl
    mujoco.mj_step(self.model, self.data)
    simulated_state = state_from_data(self.data, joint_count=self.model.nu)
    self.controller.update_simulated_state(simulated_state)
else:
    state = self.controller.tick()
    self._apply_state(state)
    mujoco.mj_forward(self.model, self.data)
```

- [ ] **Step 6: Run the runtime-physics test to verify it passes**

Run: `uv run python -m unittest tests.test_session_api.PhysicsRuntimeTest -v`

Expected:

```text
test_tick_in_physics_mode_populates_action_and_observation_summaries ... ok
```

- [ ] **Step 7: Commit the runtime physics path**

```bash
git add g1_viewer/physics.py g1_viewer/session.py g1_viewer/viewer_runtime.py tests/test_session_api.py
git commit -m "feat: add physics mode runtime stepping"
```

## Task 5: Rebuild the Control Panel as a Practical IDE-Style Tool

**Files:**
- Modify: `g1_viewer/api.py`
- Modify: `g1_viewer/static/index.html`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing UI smoke test**

```python
class RootPageSmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = SessionController()
        self.client = TestClient(create_app(self.controller))

    def tearDown(self) -> None:
        self.client.close()
        self.controller.shutdown()

    def test_root_page_contains_tree_physics_and_log_sections(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        body = response.text
        self.assertIn("动作文件树", body)
        self.assertIn("Physics OFF", body)
        self.assertIn("日志", body)
        self.assertIn("Observation", body)
```

- [ ] **Step 2: Run the UI smoke test to verify it fails**

Run: `uv run python -m unittest tests.test_session_api.RootPageSmokeTest -v`

Expected: FAIL because the current page still uses the older three-column control panel labels and no file-tree/log sections.

- [ ] **Step 3: Add the physics toggle endpoint in `g1_viewer/api.py`**

```python
class PhysicsToggleRequest(BaseModel):
    enabled: bool


@app.post("/api/physics/toggle", response_model=SessionSummary)
def api_physics_toggle(request: PhysicsToggleRequest) -> SessionSummary:
    try:
        return get_controller().toggle_physics(request.enabled)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
```

- [ ] **Step 4: Replace `g1_viewer/static/index.html` with the practical layout**

```html
<header class="toolbar">
  <input id="pathInput" type="text" placeholder="输入数据根目录">
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
    <input id="timeline" type="range">
    <div id="trimControls"></div>
  </section>
  <aside class="inspector-panel">
    <h2>策略与检查器</h2>
    <pre id="policyPane"></pre>
    <pre id="cameraPane"></pre>
  </aside>
</div>

<section class="bottom-grid">
  <pre id="logPane"></pre>
  <pre id="observationPane"></pre>
  <pre id="actionPane"></pre>
</section>
```

- [ ] **Step 5: Add lazy tree client logic and diagnostics panes in the page script**

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
          row.nextSibling.classList.toggle("hidden");
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
        await postJson("/api/load_clip", { path: node.path, format: node.format });
        await refreshSession();
      });
    }
    container.appendChild(row);
  }
}

function renderDiagnostics(session) {
  physicsToggleButton.textContent = session.physics_enabled ? "Physics ON" : "Physics OFF";
  logPane.textContent = session.last_log_messages.join("\n");
  observationPane.textContent = JSON.stringify(session.last_observation_summary, null, 2);
  actionPane.textContent = JSON.stringify(session.last_action_summary, null, 2);
}
```

- [ ] **Step 6: Run the UI smoke test again to verify it passes**

Run: `uv run python -m unittest tests.test_session_api.RootPageSmokeTest -v`

Expected:

```text
test_root_page_contains_tree_physics_and_log_sections ... ok
```

- [ ] **Step 7: Commit the control-panel rebuild**

```bash
git add g1_viewer/api.py g1_viewer/static/index.html tests/test_session_api.py
git commit -m "feat: rebuild control panel with tree and physics toggle"
```

## Task 6: Update Documentation and Run Full Validation

**Files:**
- Modify: `README.md`
- Test: `tests/test_session_api.py`

- [ ] **Step 1: Write the failing documentation smoke check**

```python
class ReadmeSmokeTest(unittest.TestCase):
    def test_readme_mentions_file_tree_and_physics_modes(self) -> None:
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("动作文件树", readme)
        self.assertIn("Physics OFF", readme)
        self.assertIn("Physics ON", readme)
        self.assertIn("mock_g1_policy", readme)
```

- [ ] **Step 2: Run the README smoke test to verify it fails**

Run: `uv run python -m unittest tests.test_session_api.ReadmeSmokeTest -v`

Expected: FAIL because the current README does not yet describe the tree browser, physics modes, or the new mock policy behavior in one place.

- [ ] **Step 3: Update `README.md` with the new user-facing workflow**

```markdown
## 控制面板结构

- 左侧：动作文件树（懒加载）
- 中间：当前动作、时间轴、trim、MuJoCo viewer 状态
- 右侧：策略与检查器
- 底部：日志、Observation、Action 摘要

## Physics OFF / ON

- `Physics OFF`
  - 直接回放参考动作状态
- `Physics ON`
  - 使用 `mock_g1_policy` 或其他策略跟踪参考动作
  - policy observation = `robot_state + reference_target`
  - policy action = `joint_position_target`
```

- [ ] **Step 4: Run the focused unittest module**

Run: `uv run python -m unittest tests.test_session_api -v`

Expected: all tests PASS, including browser, physics state, mock policy contract, runtime physics, root-page smoke, and README smoke.

- [ ] **Step 5: Run syntax and example validations**

Run: `uv run python -m py_compile main.py g1_viewer/*.py g1_viewer/importers.py`

Expected: no output.

Run: `uv run python examples/api_roundtrip_example.py`

Expected:

```text
scan: 200 ...
load: 200 ...
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

- [ ] **Step 6: Commit docs and validation-ready state**

```bash
git add README.md tests/test_session_api.py
git commit -m "docs: describe file tree and physics workflow"
```

## Self-Review

- Spec coverage:
  - 文件树懒加载: Task 1, Task 5
  - `Physics OFF / ON`: Task 2, Task 4, Task 5, Task 6
  - mock policy 新 observation/action: Task 3
  - 实用型 IDE 风格 UI: Task 5
  - 日志 / observation / action 摘要: Task 2, Task 3, Task 5
- Placeholder scan:
  - No `TODO`, `TBD`, or “similar to” references remain.
- Type consistency:
  - Plan consistently uses `physics_enabled`, `last_observation_summary`, `last_action_summary`, `last_log_messages`, `BrowserNode`, and `joint_position_target`.

