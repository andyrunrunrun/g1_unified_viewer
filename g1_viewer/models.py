from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, root_validator


SourceType = Literal["dataset", "policy"]
MotionFormat = Literal["sonic", "twist2", "kimodo_csv", "policy"]
ExportMotionFormat = Literal["sonic", "twist2"]
Twist2ExportExtension = Literal[".pkl", ".npz", ".json"]
PlaybackState = Literal["empty", "stopped", "paused", "playing"]
ViewMode = Literal["dataset", "policy"]
CommandMode = Literal[
    "joint_position_target",
    "joint_velocity_target",
    "joint_torque",
    "state_override",
]
ViewerImpulsePreset = Literal[
    "push_forward",
    "push_backward",
    "push_left",
    "push_right",
    "lift_up",
]


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()  # type: ignore[no-any-return]
    return model.dict()  # type: ignore[no-any-return]


class CanonicalRobotState(BaseModel):
    timestamp: float
    root_translation: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])
    root_rotation_wxyz: list[float] = Field(default_factory=lambda: [1.0, 0.0, 0.0, 0.0])
    joint_positions: list[float] = Field(default_factory=list)
    joint_velocities: list[float] = Field(default_factory=list)
    body_positions: list[list[float]] = Field(default_factory=list)
    body_rotations_wxyz: list[list[float]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class StateSequence(BaseModel):
    sequence_id: str
    name: str
    source_type: SourceType = "dataset"
    source_format: MotionFormat
    fps: float
    frame_count: int
    joint_names: list[str]
    body_names: list[str] = Field(default_factory=list)
    source_path: str
    frames: list[CanonicalRobotState]
    metadata: dict[str, Any] = Field(default_factory=dict)


class SequenceSummary(BaseModel):
    sequence_id: str
    name: str
    source_type: SourceType
    source_format: MotionFormat
    fps: float
    frame_count: int
    joint_count: int
    body_count: int
    source_path: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class ViewerCameraState(BaseModel):
    lookat: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.8])
    distance: float = 3.2
    azimuth: float = 140.0
    elevation: float = -20.0


class ScanItem(BaseModel):
    path: str
    name: str
    format: MotionFormat
    item_type: Literal["file", "directory"]


class ScanRequest(BaseModel):
    path: str


class ScanResponse(BaseModel):
    items: list[ScanItem]


class BrowserNode(BaseModel):
    path: str
    name: str
    node_type: Literal["directory", "motion"]
    format: MotionFormat | None = None
    has_children: bool = False
    relative_path: str | None = None
    children: list["BrowserNode"] = Field(default_factory=list)


class BrowserListRequest(BaseModel):
    path: str


class BrowserListResponse(BaseModel):
    root: str
    parent: str | None = None
    nodes: list[BrowserNode]


class LoadClipRequest(BaseModel):
    path: str
    format: MotionFormat | None = None


class SessionLoadRequest(BaseModel):
    path: str
    format: MotionFormat | None = None


class LoadClipResponse(BaseModel):
    sequence: SequenceSummary


class SeekRequest(BaseModel):
    frame_index: int


class SessionPlaybackRequest(BaseModel):
    action: Literal["play", "pause", "stop", "seek", "loop"]
    frame_index: int | None = None
    enabled: bool | None = None

    @root_validator(skip_on_failure=True)
    def validate_action_payload(cls, values: dict[str, Any]) -> dict[str, Any]:
        action = values.get("action")
        if action == "seek" and values.get("frame_index") is None:
            raise ValueError("frame_index is required for seek")
        if action == "loop" and values.get("enabled") is None:
            raise ValueError("enabled is required for loop")
        return values


class LoopRequest(BaseModel):
    enabled: bool


class TrimFrameRequest(BaseModel):
    frame_index: int


class SessionTrimRequest(BaseModel):
    action: Literal["set_start", "set_end", "mark_start", "mark_end"]
    frame_index: int | None = None

    @root_validator(skip_on_failure=True)
    def validate_action_payload(cls, values: dict[str, Any]) -> dict[str, Any]:
        action = values.get("action")
        if action in {"set_start", "set_end"} and values.get("frame_index") is None:
            raise ValueError(f"frame_index is required for {action}")
        return values


class SessionPhysicsRequest(BaseModel):
    enabled: bool


class GetFramesRequest(BaseModel):
    sequence_id: str
    start: int = 0
    end: int = 1
    stride: int = 1


class FrameSliceResponse(BaseModel):
    sequence_id: str
    joint_names: list[str] = Field(default_factory=list)
    body_names: list[str] = Field(default_factory=list)
    frames: list[CanonicalRobotState]


class TrimExportRequest(BaseModel):
    sequence_id: str
    start_frame: int
    end_frame: int
    export_format: ExportMotionFormat | None = None
    output_dir: str | None = None
    twist2_extension: Twist2ExportExtension | None = None


class TrimExportResponse(BaseModel):
    output_path: str
    export_format: ExportMotionFormat
    frame_count: int


class SimulationSnapshot(BaseModel):
    timestamp: float
    state: CanonicalRobotState
    metadata: dict[str, Any] = Field(default_factory=dict)


class ControlCommand(BaseModel):
    mode: CommandMode
    values: list[float] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class PolicyManifest(BaseModel):
    policy_id: str
    display_name: str
    robot_type: str
    runtime: Literal["browser", "python_subprocess"] = "python_subprocess"
    framework: Literal["mock", "onnx", "python"] | str | None = None
    env_python: str = "__CURRENT_PYTHON__"
    entrypoint: str | None = None
    weights_path: str | None = None
    config_path: str | None = None
    module_path: str | None = None
    control_mode: CommandMode = "joint_position_target"
    tags: list[str] = Field(default_factory=list)
    description: str = ""
    display_name_i18n: dict[str, str] = Field(default_factory=dict)
    description_i18n: dict[str, str] = Field(default_factory=dict)
    manifest_path: str | None = None
    plugin_path: str | None = None
    format_id: str | None = None
    model_file: str | None = None
    config_template: str | None = None


class PolicyOperationResponse(BaseModel):
    ok: bool
    message: str
    result: dict[str, Any] = Field(default_factory=dict)


class PolicyListResponse(BaseModel):
    policies: list[PolicyManifest]


class StartPolicyRequest(BaseModel):
    policy_id: str


class PolicyActivationRequest(BaseModel):
    policy_id: str | None


class StopPolicyRequest(BaseModel):
    policy_id: str


class PolicyStepRequest(BaseModel):
    policy_id: str
    snapshot: SimulationSnapshot | None = None


class MockStepRequest(BaseModel):
    policy_id: str
    snapshot: SimulationSnapshot | None = None


class ViewerInteractionSummary(BaseModel):
    drag_active: bool = False
    selected_body_id: int | None = None
    selected_body_name: str | None = None
    perturb_mode: str = "none"
    force_magnitude: float = 0.0
    last_drag_timestamp: float | None = None


class ViewerImpulseRequest(BaseModel):
    preset: ViewerImpulsePreset
    magnitude: float = Field(default=80.0, ge=1.0, le=500.0)
    duration: float = Field(default=0.15, ge=0.01, le=5.0)
    body_name: str | None = None


class ViewerImpulseCommand(BaseModel):
    preset: ViewerImpulsePreset
    magnitude: float
    duration: float
    body_name: str | None = None


class TestStateSummary(BaseModel):
    last_test_event: str = ""
    last_test_status: str = ""
    last_impulse_command: dict[str, Any] = Field(default_factory=dict)
    pending_impulse: bool = False


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
    viewer_interaction: ViewerInteractionSummary = Field(default_factory=ViewerInteractionSummary)
    test_state: TestStateSummary = Field(default_factory=TestStateSummary)
    last_log_messages: list[str] = Field(default_factory=list)
    last_error: str | None = None


def summarize_sequence(sequence: StateSequence) -> SequenceSummary:
    return SequenceSummary(
        sequence_id=sequence.sequence_id,
        name=sequence.name,
        source_type=sequence.source_type,
        source_format=sequence.source_format,
        fps=sequence.fps,
        frame_count=sequence.frame_count,
        joint_count=len(sequence.joint_names),
        body_count=len(sequence.body_names),
        source_path=sequence.source_path,
        metadata=sequence.metadata,
    )
