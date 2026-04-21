from __future__ import annotations

import argparse
import threading
import time
from pathlib import Path

import uvicorn

from g1_viewer.api import create_app
from g1_viewer.importers import detect_format
from g1_viewer.session import SessionController
from g1_viewer.viewer_runtime import NativeViewerRuntime


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the G1 Unified Viewer with a MuJoCo native window and a web control panel."
    )
    parser.add_argument("--host", default="127.0.0.1", help="Control panel bind host. Default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Control panel bind port. Default: 8000")
    parser.add_argument("--path", help="Optional motion path or scan root to preload.")
    parser.add_argument("--format", choices=["sonic", "twist2"], help="Optional format hint for --path.")
    parser.add_argument("--loop", action="store_true", help="Enable loop playback on startup.")
    parser.add_argument("--start-paused", action="store_true", help="Load the clip but do not autoplay.")
    parser.add_argument("--hide-left-ui", action="store_true", help="Hide MuJoCo's left control panel.")
    parser.add_argument("--hide-right-ui", action="store_true", help="Hide MuJoCo's right profiler panel.")
    return parser.parse_args()


def preload_session(controller: SessionController, args: argparse.Namespace) -> None:
    if not args.path:
        if args.loop:
            controller.set_loop(True)
        return

    path = Path(args.path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Path does not exist: {path}")

    controller.scan_path(str(path))
    format_hint = args.format or detect_format(path)
    if format_hint is not None:
        controller.load_clip(str(path), format_hint)

    if args.loop:
        controller.set_loop(True)

    if controller.get_session_summary().active_sequence is not None and not args.start_paused:
        controller.play()


def start_server(app, host: str, port: int) -> tuple[uvicorn.Server, threading.Thread]:
    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="g1-control-panel", daemon=True)
    thread.start()

    deadline = time.time() + 10.0
    while not server.started and thread.is_alive() and time.time() < deadline:
        time.sleep(0.05)

    if not server.started:
        server.should_exit = True
        thread.join(timeout=2.0)
        raise RuntimeError(f"Failed to start control panel server on http://{host}:{port}")

    return server, thread


def main() -> int:
    args = parse_args()
    controller = SessionController()
    preload_session(controller, args)
    app = create_app(controller)

    server, server_thread = start_server(app, args.host, args.port)
    print(f"Control panel: http://{args.host}:{args.port}")

    try:
        viewer = NativeViewerRuntime(
            controller,
            show_left_ui=not args.hide_left_ui,
            show_right_ui=not args.hide_right_ui,
        )
        viewer.run()
    finally:
        server.should_exit = True
        server_thread.join(timeout=5.0)
        controller.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
