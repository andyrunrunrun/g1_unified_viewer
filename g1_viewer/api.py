from __future__ import annotations

import logging
import json
import mimetypes
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .exporters import _default_export_format, export_trimmed_sequence
from .holomotion_v13 import infer_holomotion_v13
from .humanoid_gpt import infer_humanoid_gpt
from .models import (
    BrowserListRequest,
    BrowserListResponse,
    FrameSliceResponse,
    GetFramesRequest,
    HoloMotionV13InferRequest,
    HumanoidGPTInferRequest,
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
    summarize_sequence,
)
from .policies import PolicyError
from .session import SessionController
from .sim import ThreadedMujocoRenderer, fallback_png


logger = logging.getLogger(__name__)
mimetypes.add_type("application/octet-stream", ".onnx")
mimetypes.add_type("text/javascript", ".mjs")
package_dir = Path(__file__).resolve().parent
repo_root = package_dir.parent
static_dir = package_dir / "static"
frontend_dir = repo_root / "frontend"
frontend_dist_dir = frontend_dir / "dist"
frontend_public_dir = frontend_dir / "public"
policy_plugins_dir = repo_root / "policy_plugins"
browser_scene_index_path = frontend_public_dir / "examples" / "scenes" / "files.json"
INFERENCE_BODY_LIMIT_BYTES = 256 * 1024
INFERENCE_PATHS = frozenset({"/api/holomotion-v13/infer", "/api/humanoid-gpt/infer"})

_default_controller = SessionController()
_renderer: ThreadedMujocoRenderer | None = None
_renderer_error: str | None = None


class _InferenceBodyTooLarge(Exception):
    pass


class InferenceBodyLimitMiddleware:
    def __init__(self, app: Any, max_body_bytes: int = INFERENCE_BODY_LIMIT_BYTES) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("path") not in INFERENCE_PATHS:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.max_body_bytes:
                    await self._reject(scope, receive, send)
                    return
            except ValueError:
                await self._reject(scope, receive, send)
                return

        received = 0

        async def limited_receive() -> dict[str, Any]:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body") or b"")
                if received > self.max_body_bytes:
                    raise _InferenceBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _InferenceBodyTooLarge:
            await self._reject(scope, receive, send)

    @staticmethod
    async def _reject(scope: dict[str, Any], receive: Any, send: Any) -> None:
        response = JSONResponse({"detail": "Inference request body is too large"}, status_code=413)
        await response(scope, receive, send)


def _init_renderer() -> None:
    global _renderer, _renderer_error
    if _renderer is not None or _renderer_error is not None:
        return
    try:
        _renderer = ThreadedMujocoRenderer()
    except Exception as exc:
        _renderer_error = str(exc)
        logger.exception("Failed to initialize MuJoCo renderer")


def _handle_session_load(controller: SessionController, request: SessionLoadRequest) -> LoadClipResponse:
    sequence = controller.load_clip(request.path, request.format)
    return LoadClipResponse(sequence=summarize_sequence(sequence))


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


def _handle_policy_active_request(
    controller: SessionController,
    request: PolicyActivationRequest,
    *,
    stop_message: str = "runner stopped",
) -> PolicyOperationResponse:
    if request.policy_id is None:
        controller.stop_policy()
        return PolicyOperationResponse(ok=True, message=stop_message, result={})
    result = controller.start_policy(request.policy_id)
    return PolicyOperationResponse(ok=True, message="runner started", result=result)


def _handle_policy_step_request(controller: SessionController, request: PolicyStepRequest) -> PolicyOperationResponse:
    result = controller.step_policy(request.policy_id, request.snapshot, now=time.monotonic())
    return PolicyOperationResponse(ok=True, message="policy step ok", result=result)


def _handle_viewer_test_impulse_request(
    controller: SessionController, request: ViewerImpulseRequest
) -> SessionSummary:
    return controller.queue_viewer_impulse(request)


def _frontend_index_path() -> Path:
    built_index = frontend_dist_dir / "index.html"
    if built_index.exists():
        return built_index
    source_index = frontend_dir / "index.html"
    if source_index.exists():
        return source_index
    return static_dir / "index.html"


def _frontend_public_file_path(relative_path: str) -> Path | None:
    built_file = frontend_dist_dir / relative_path
    if built_file.exists():
        return built_file
    public_file = frontend_public_dir / relative_path
    if public_file.exists():
        return public_file
    return None


def _browser_scene_files() -> list[str]:
    if not browser_scene_index_path.exists():
        return []
    payload = json.loads(browser_scene_index_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Browser scene files index must be a JSON list")
    return [str(item) for item in payload]


def create_app(controller: SessionController | None = None) -> FastAPI:
    session = controller or _default_controller
    app = FastAPI(title="G1 Unified Viewer", version="0.2.0")
    app.add_middleware(InferenceBodyLimitMiddleware)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    if (frontend_dist_dir / "assets").exists():
        app.mount("/assets", StaticFiles(directory=frontend_dist_dir / "assets"), name="frontend-assets")
    if (frontend_public_dir / "examples").exists():
        app.mount("/examples", StaticFiles(directory=frontend_public_dir / "examples"), name="examples")
    if policy_plugins_dir.exists():
        app.mount("/policy-plugins", StaticFiles(directory=policy_plugins_dir), name="policy-plugins")
    app.state.controller = session

    def get_controller() -> SessionController:
        return app.state.controller

    @app.get("/")
    def root() -> FileResponse:
        return FileResponse(_frontend_index_path())

    @app.get("/favicon.ico")
    def favicon() -> FileResponse:
        icon_path = _frontend_public_file_path("favicon.ico")
        if icon_path is None:
            raise HTTPException(status_code=404, detail="favicon not found")
        return FileResponse(icon_path, media_type="image/vnd.microsoft.icon")

    @app.get("/favicon.svg")
    def favicon_svg() -> FileResponse:
        icon_path = _frontend_public_file_path("favicon.svg")
        if icon_path is None:
            raise HTTPException(status_code=404, detail="favicon not found")
        return FileResponse(icon_path, media_type="image/svg+xml")

    @app.get("/api/assets/browser-scene")
    def api_browser_scene() -> dict[str, object]:
        try:
            files = _browser_scene_files()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return {
            "robot": "g1",
            "scene_path": "g1/g1.xml",
            "files_index_url": "/examples/scenes/files.json",
            "files": files,
        }

    @app.get("/api/session", response_model=SessionSummary)
    def api_session() -> SessionSummary:
        controller = get_controller()
        summary = controller.get_session_summary()
        if summary.playback_state == "playing":
            controller.tick()
            summary = controller.get_session_summary()
        return summary

    @app.get("/api/session/state")
    def api_session_state() -> dict[str, object]:
        controller = get_controller()
        summary = controller.get_session_summary()
        sequence_summary = summary.active_sequence
        if sequence_summary is None:
            raise HTTPException(status_code=404, detail="No active sequence")
        sequence = controller.get_sequence(sequence_summary.sequence_id)
        state = controller.tick()
        summary = controller.get_session_summary()
        return {
            "sequence_id": sequence.sequence_id,
            "frame_index": summary.current_frame,
            "joint_names": sequence.joint_names,
            "body_names": sequence.body_names,
            "state": state,
        }

    @app.post("/api/scan", response_model=ScanResponse)
    def api_scan(request: ScanRequest) -> ScanResponse:
        try:
            return ScanResponse(items=get_controller().scan_path(request.path))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/browser/list", response_model=BrowserListResponse)
    def api_browser_list(request: BrowserListRequest) -> BrowserListResponse:
        try:
            root, parent, nodes, total_count, offset, limit, has_more = get_controller().list_browser(
                request.path,
                limit=request.limit,
                offset=request.offset,
            )
            return BrowserListResponse(
                root=root,
                parent=parent,
                nodes=nodes,
                total_count=total_count,
                offset=offset,
                limit=limit,
                has_more=has_more,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/session/load", response_model=LoadClipResponse)
    def api_session_load(request: SessionLoadRequest) -> LoadClipResponse:
        try:
            return _handle_session_load(get_controller(), request)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/load_clip", response_model=LoadClipResponse)
    def api_load_clip(request: LoadClipRequest) -> LoadClipResponse:
        try:
            return _handle_session_load(
                get_controller(),
                SessionLoadRequest(path=request.path, format=request.format),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/get_frames", response_model=FrameSliceResponse)
    def api_get_frames(request: GetFramesRequest) -> FrameSliceResponse:
        try:
            sequence = get_controller().get_sequence(request.sequence_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown sequence_id: {request.sequence_id}") from exc

        start = max(0, request.start)
        end = min(sequence.frame_count, request.end)
        stride = max(1, request.stride)
        return FrameSliceResponse(
            sequence_id=sequence.sequence_id,
            joint_names=sequence.joint_names,
            body_names=sequence.body_names,
            frames=sequence.frames[start:end:stride],
        )

    @app.get("/api/render_frame/{sequence_id}/{frame_index}")
    def api_render_frame(
        sequence_id: str,
        frame_index: int,
        width: int = Query(default=640, ge=160, le=1920),
        height: int = Query(default=480, ge=120, le=1440),
        fmt: str = Query(default="jpeg"),
        quality: int = Query(default=80, ge=30, le=95),
    ) -> Response:
        try:
            sequence = get_controller().get_sequence(sequence_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown sequence_id: {sequence_id}") from exc
        if frame_index < 0 or frame_index >= sequence.frame_count:
            raise HTTPException(status_code=400, detail="frame_index out of range")

        frame = sequence.frames[frame_index]
        try:
            _init_renderer()
            if _renderer is None:
                image_bytes = fallback_png(frame, width=width, height=height, image_format=fmt, quality=quality)
                backend = "fallback"
            else:
                image_bytes = _renderer.render_state(
                    frame,
                    width=width,
                    height=height,
                    image_format=fmt,
                    quality=quality,
                )
                backend = _renderer.backend
        except Exception:
            logger.exception("Failed to render frame %s for sequence %s", frame_index, sequence_id)
            image_bytes = fallback_png(frame, width=width, height=height, image_format=fmt, quality=quality)
            backend = "fallback"
        media_type = "image/jpeg" if fmt.lower() in {"jpg", "jpeg"} else "image/png"
        return Response(content=image_bytes, media_type=media_type, headers={"X-Renderer-Backend": backend})

    @app.post("/api/session/playback", response_model=SessionSummary)
    def api_session_playback(request: SessionPlaybackRequest) -> SessionSummary:
        try:
            return _handle_playback_request(get_controller(), request)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/play", response_model=SessionSummary)
    def api_playback_play() -> SessionSummary:
        try:
            return _handle_playback_request(get_controller(), SessionPlaybackRequest(action="play"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/pause", response_model=SessionSummary)
    def api_playback_pause() -> SessionSummary:
        try:
            return _handle_playback_request(get_controller(), SessionPlaybackRequest(action="pause"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/stop", response_model=SessionSummary)
    def api_playback_stop() -> SessionSummary:
        try:
            return _handle_playback_request(get_controller(), SessionPlaybackRequest(action="stop"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/seek", response_model=SessionSummary)
    def api_playback_seek(request: SeekRequest) -> SessionSummary:
        try:
            return _handle_playback_request(
                get_controller(),
                SessionPlaybackRequest(action="seek", frame_index=request.frame_index),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/loop", response_model=SessionSummary)
    def api_playback_loop(request: LoopRequest) -> SessionSummary:
        try:
            return _handle_playback_request(
                get_controller(),
                SessionPlaybackRequest(action="loop", enabled=request.enabled),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/session/trim", response_model=SessionSummary)
    def api_session_trim(request: SessionTrimRequest) -> SessionSummary:
        try:
            return _handle_trim_request(get_controller(), request)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/trim_start", response_model=SessionSummary)
    def api_playback_trim_start(request: TrimFrameRequest) -> SessionSummary:
        try:
            return _handle_trim_request(
                get_controller(),
                SessionTrimRequest(action="set_start", frame_index=request.frame_index),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/trim_end", response_model=SessionSummary)
    def api_playback_trim_end(request: TrimFrameRequest) -> SessionSummary:
        try:
            return _handle_trim_request(
                get_controller(),
                SessionTrimRequest(action="set_end", frame_index=request.frame_index),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/session/physics", response_model=SessionSummary)
    def api_session_physics(request: SessionPhysicsRequest) -> SessionSummary:
        try:
            return get_controller().toggle_physics(request.enabled)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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

    @app.post("/api/trim_export", response_model=TrimExportResponse)
    def api_trim_export(request: TrimExportRequest) -> TrimExportResponse:
        try:
            sequence = get_controller().get_sequence(request.sequence_id)
            export_root = Path(request.output_dir).expanduser().resolve() if request.output_dir else None
            output_path = export_trimmed_sequence(
                sequence,
                request.start_frame,
                request.end_frame,
                export_root=export_root,
                export_format=request.export_format,
                twist2_extension=request.twist2_extension,
                use_format_subdir=request.output_dir is None,
                output_name=request.output_name,
            )
            frame_count = request.end_frame - request.start_frame + 1
            return TrimExportResponse(
                output_path=str(output_path),
                export_format=request.export_format or _default_export_format(sequence),
                frame_count=frame_count,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown sequence_id: {request.sequence_id}") from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/policies", response_model=PolicyListResponse)
    def api_policies() -> PolicyListResponse:
        return PolicyListResponse(policies=get_controller().list_policies())

    @app.get("/api/policy-plugins", response_model=PolicyListResponse)
    def api_policy_plugins() -> PolicyListResponse:
        return PolicyListResponse(policies=get_controller().list_policies())

    @app.get("/api/policy-plugins/{policy_id}/config")
    def api_policy_plugin_config(policy_id: str) -> dict[str, object]:
        try:
            return get_controller().policy_config(policy_id)
        except PolicyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/active", response_model=PolicyOperationResponse)
    def api_policy_active(request: PolicyActivationRequest) -> PolicyOperationResponse:
        try:
            return _handle_policy_active_request(get_controller(), request)
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/start", response_model=PolicyOperationResponse)
    def api_start_policy(request: StartPolicyRequest) -> PolicyOperationResponse:
        try:
            return _handle_policy_active_request(
                get_controller(),
                PolicyActivationRequest(policy_id=request.policy_id),
            )
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/stop", response_model=PolicyOperationResponse)
    def api_stop_policy(request: StopPolicyRequest) -> PolicyOperationResponse:
        try:
            return _handle_policy_active_request(
                get_controller(),
                PolicyActivationRequest(policy_id=None),
                stop_message=f"runner stopped: {request.policy_id}",
            )
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/step", response_model=PolicyOperationResponse)
    def api_policy_step(request: PolicyStepRequest) -> PolicyOperationResponse:
        try:
            return _handle_policy_step_request(get_controller(), request)
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/mock_step", response_model=PolicyOperationResponse)
    def api_mock_step(request: MockStepRequest) -> PolicyOperationResponse:
        try:
            return _handle_policy_step_request(
                get_controller(),
                PolicyStepRequest(policy_id=request.policy_id, snapshot=request.snapshot),
            )
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/holomotion-v13/infer")
    def api_holomotion_v13_infer(request: HoloMotionV13InferRequest) -> dict[str, object]:
        try:
            return infer_holomotion_v13(request.model_dump(exclude_unset=True, exclude_none=True))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/humanoid-gpt/infer")
    def api_humanoid_gpt_infer(request: HumanoidGPTInferRequest) -> dict[str, object]:
        try:
            return infer_humanoid_gpt(request.model_dump(exclude_unset=True, exclude_none=True))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return app


app = create_app(_default_controller)


def run(host: str = "127.0.0.1", port: int = 8000, controller: SessionController | None = None) -> None:
    import uvicorn

    target_app = create_app(controller) if controller is not None else app
    uvicorn.run(target_app, host=host, port=port, reload=False)
