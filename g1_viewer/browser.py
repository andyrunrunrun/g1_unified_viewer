from __future__ import annotations

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
        if child.is_file() and motion_format is not None:
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
            if motion_format == "sonic":
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
