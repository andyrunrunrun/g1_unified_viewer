from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .exporters import export_trimmed_sequence
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
    summarize_sequence,
)
from .policies import PolicyError
from .session import SessionController
from .sim import ThreadedMujocoRenderer, fallback_png


logger = logging.getLogger(__name__)
static_dir = Path(__file__).resolve().parent / "static"

_default_controller = SessionController()
_renderer: ThreadedMujocoRenderer | None = None
_renderer_error: str | None = None


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


def create_app(controller: SessionController | None = None) -> FastAPI:
    session = controller or _default_controller
    app = FastAPI(title="G1 Unified Viewer", version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    app.state.controller = session

    def get_controller() -> SessionController:
        return app.state.controller

    @app.get("/")
    def root() -> FileResponse:
        return FileResponse(static_dir / "index.html")

    @app.get("/api/session", response_model=SessionSummary)
    def api_session() -> SessionSummary:
        return get_controller().get_session_summary()

    @app.post("/api/scan", response_model=ScanResponse)
    def api_scan(request: ScanRequest) -> ScanResponse:
        try:
            return ScanResponse(items=get_controller().scan_path(request.path))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/browser/list", response_model=BrowserListResponse)
    def api_browser_list(request: BrowserListRequest) -> BrowserListResponse:
        try:
            root, nodes = get_controller().list_browser(request.path)
            return BrowserListResponse(root=root, nodes=nodes)
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
        return FrameSliceResponse(sequence_id=sequence.sequence_id, frames=sequence.frames[start:end:stride])

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
            output_path = export_trimmed_sequence(sequence, request.start_frame, request.end_frame)
            frame_count = request.end_frame - request.start_frame + 1
            return TrimExportResponse(
                output_path=str(output_path),
                export_format=sequence.source_format,
                frame_count=frame_count,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Unknown sequence_id: {request.sequence_id}") from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/policies", response_model=PolicyListResponse)
    def api_policies() -> PolicyListResponse:
        return PolicyListResponse(policies=get_controller().list_policies())

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

    return app


app = create_app(_default_controller)


def run(host: str = "127.0.0.1", port: int = 8000, controller: SessionController | None = None) -> None:
    import uvicorn

    target_app = create_app(controller) if controller is not None else app
    uvicorn.run(target_app, host=host, port=port, reload=False)
