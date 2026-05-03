from __future__ import annotations

from pathlib import Path

from .importers import SUPPORTED_TWIST2_EXTENSIONS
from .models import BrowserNode


def _is_sonic_directory(path: Path) -> bool:
    return path.is_dir() and (path / "joint_pos.csv").exists()


def _fast_motion_format(path: Path) -> str | None:
    if path.is_file() and path.suffix.lower() in SUPPORTED_TWIST2_EXTENSIONS:
        return "twist2"
    return None


def _relative_label(root: Path, path: Path) -> str:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return path.name
    label = relative.as_posix()
    return label if label != "." else path.name


def _motion_node(root: Path, path: Path, motion_format: str) -> BrowserNode:
    label = _relative_label(root, path)
    return BrowserNode(
        path=str(path),
        name=label,
        node_type="motion",
        format=motion_format,  # type: ignore[arg-type]
        has_children=False,
        relative_path=label,
    )


def _has_visible_child(path: Path) -> bool:
    try:
        for child in path.iterdir():
            if child.is_dir() or _fast_motion_format(child) is not None:
                return True
    except OSError:
        return False
    return False


def _child_directory_node(root: Path, path: Path) -> BrowserNode:
    label = _relative_label(root, path)
    return BrowserNode(
        path=str(path),
        name=label,
        node_type="directory",
        format=None,
        has_children=_has_visible_child(path),
        relative_path=label,
        children=[],
    )


def _directory_children(root: Path, path: Path) -> list[BrowserNode]:
    children: list[BrowserNode] = []
    for child in sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
        if child.is_dir():
            if _is_sonic_directory(child):
                children.append(_motion_node(root, child, "sonic"))
                continue
            children.append(_child_directory_node(root, child))
            continue

        motion_format = _fast_motion_format(child)
        if motion_format is not None:
            children.append(_motion_node(root, child, motion_format))

    return children


def list_browser_nodes(path_str: str) -> tuple[str, str | None, list[BrowserNode]]:
    root = Path(path_str).expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Path does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Browser root must be a directory: {root}")

    parent = str(root.parent) if root.parent != root else None
    if _is_sonic_directory(root):
        return str(root), parent, [_motion_node(root, root, "sonic")]

    return str(root), parent, _directory_children(root, root)
