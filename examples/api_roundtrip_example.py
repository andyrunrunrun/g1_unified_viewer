from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient

from g1_viewer.api import app


def main() -> int:
    sample_path = REPO_ROOT / "examples" / "sample_data" / "sonic_demo"
    output_png = REPO_ROOT / "examples" / "output" / "api_roundtrip_frame0.png"

    client = TestClient(app)

    browser = client.post("/api/browser/list", json={"path": str(sample_path.parent)})
    print("browser:", browser.status_code, browser.json()["root"])

    load = client.post("/api/session/load", json={"path": str(sample_path), "format": "sonic"})
    sequence = load.json()["sequence"]
    print("load:", load.status_code, sequence)

    seek = client.post("/api/session/playback", json={"action": "seek", "frame_index": 1})
    print("seek:", seek.status_code, seek.json()["current_frame"])

    sequence_id = sequence["sequence_id"]
    render = client.get(f"/api/render_frame/{sequence_id}/0")
    output_png.parent.mkdir(parents=True, exist_ok=True)
    output_png.write_bytes(render.content)
    print("render:", render.status_code, render.headers.get("x-renderer-backend"), output_png)

    trim_session = client.post("/api/session/trim", json={"action": "set_start", "frame_index": 1})
    print("trim session:", trim_session.status_code, trim_session.json()["trim_start"])

    trim = client.post(
        "/api/trim_export",
        json={"sequence_id": sequence_id, "start_frame": 0, "end_frame": 2},
    )
    print("trim:", trim.status_code, trim.json())

    policies = client.get("/api/policies")
    print("policies:", policies.status_code, policies.json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
