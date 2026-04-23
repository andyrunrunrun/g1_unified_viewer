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
    PolicyListResponse,
    PolicyOperationResponse,
    ScanRequest,
    ScanResponse,
    SeekRequest,
    SessionSummary,
    StartPolicyRequest,
    StopPolicyRequest,
    TrimExportRequest,
    TrimExportResponse,
    TrimFrameRequest,
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

    @app.post("/api/load_clip", response_model=LoadClipResponse)
    def api_load_clip(request: LoadClipRequest) -> LoadClipResponse:
        try:
            sequence = get_controller().load_clip(request.path, request.format)
            return LoadClipResponse(sequence=summarize_sequence(sequence))
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

    @app.post("/api/playback/play", response_model=SessionSummary)
    def api_playback_play() -> SessionSummary:
        try:
            return get_controller().play()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/pause", response_model=SessionSummary)
    def api_playback_pause() -> SessionSummary:
        return get_controller().pause()

    @app.post("/api/playback/stop", response_model=SessionSummary)
    def api_playback_stop() -> SessionSummary:
        return get_controller().stop()

    @app.post("/api/playback/seek", response_model=SessionSummary)
    def api_playback_seek(request: SeekRequest) -> SessionSummary:
        try:
            return get_controller().seek(request.frame_index)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/loop", response_model=SessionSummary)
    def api_playback_loop(request: LoopRequest) -> SessionSummary:
        return get_controller().set_loop(request.enabled)

    @app.post("/api/playback/trim_start", response_model=SessionSummary)
    def api_playback_trim_start(request: TrimFrameRequest) -> SessionSummary:
        try:
            return get_controller().set_trim_start(request.frame_index)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/playback/trim_end", response_model=SessionSummary)
    def api_playback_trim_end(request: TrimFrameRequest) -> SessionSummary:
        try:
            return get_controller().set_trim_end(request.frame_index)
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

    @app.post("/api/policies/start", response_model=PolicyOperationResponse)
    def api_start_policy(request: StartPolicyRequest) -> PolicyOperationResponse:
        try:
            result = get_controller().start_policy(request.policy_id)
            return PolicyOperationResponse(ok=True, message="runner started", result=result)
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/stop", response_model=PolicyOperationResponse)
    def api_stop_policy(request: StopPolicyRequest) -> PolicyOperationResponse:
        try:
            get_controller().stop_policy()
            return PolicyOperationResponse(ok=True, message=f"runner stopped: {request.policy_id}", result={})
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/policies/mock_step", response_model=PolicyOperationResponse)
    def api_mock_step(request: MockStepRequest) -> PolicyOperationResponse:
        try:
            result = get_controller().step_policy(
                request.policy_id,
                request.snapshot,
                now=time.monotonic(),
            )
            return PolicyOperationResponse(ok=True, message="policy step ok", result=result)
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
