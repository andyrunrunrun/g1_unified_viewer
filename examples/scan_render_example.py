from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from g1_viewer.importers import load_sequence, scan_path
from g1_viewer.sim import MujocoRenderer


def main() -> int:
    default_path = REPO_ROOT / "examples" / "sample_data" / "sonic_demo"
    default_output = REPO_ROOT / "examples" / "output" / "scan_render_frame0.png"

    parser = argparse.ArgumentParser(description="Load a motion path and render its first frame.")
    parser.add_argument("--path", type=Path, default=default_path)
    parser.add_argument("--output", type=Path, default=default_output)
    args = parser.parse_args()

    items = scan_path(str(args.path))
    print("scan items:", len(items))
    for item in items:
        print(f"  - {item.format}: {item.path}")

    sequence = load_sequence(str(args.path))
    print("loaded sequence:", sequence.name, sequence.source_format, sequence.frame_count, "frames")

    renderer = MujocoRenderer(width=640, height=480)
    png = renderer.render_state(sequence.frames[0], 640, 480)
    renderer.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(png)
    print("rendered png:", args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
