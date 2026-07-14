from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import numpy as np

from .importers import (
    HOLOMOTION_NPZ_PREFIXES,
    MOTION_TRACKING_NPZ_DATASET_METADATA_FILES,
    MOTION_TRACKING_NPZ_REQUIRED_KEYS,
    SUPPORTED_TWIST2_EXTENSIONS,
    is_motion_tracking_npz_dataset_file,
)
from .models import BrowserNode


def _is_sonic_directory(path: Path) -> bool:
    return path.is_dir() and (path / "joint_pos.csv").exists()


def _is_motion_tracking_npz_sidecar_file(path: Path) -> bool:
    return (
        path.name in MOTION_TRACKING_NPZ_DATASET_METADATA_FILES
        and all((path.parent / file_name).is_file() for file_name in MOTION_TRACKING_NPZ_DATASET_METADATA_FILES)
    )


def _file_can_be_browser_motion(path: Path) -> bool:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return True
    if suffix in SUPPORTED_TWIST2_EXTENSIONS:
        return not _is_motion_tracking_npz_sidecar_file(path)
    return False


def _file_motion_format(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if not _file_can_be_browser_motion(path):
        return None
    if suffix == ".csv":
        return "kimodo_csv"
    if suffix == ".npz":
        if _is_holomotion_npz(path):
            return "holomotion_npz"
        if is_motion_tracking_npz_dataset_file(path) or _is_motion_tracking_npz(path):
            return "motion_tracking_npz"
        return None
    if suffix in SUPPORTED_TWIST2_EXTENSIONS:
        return "twist2"
    return None


def _fast_motion_format(path: Path) -> str | None:
    if not path.is_file():
        return None
    return _file_motion_format(path)


def _is_motion_tracking_npz(path: Path) -> bool:
    try:
        with np.load(path, allow_pickle=True) as npz_file:
            return MOTION_TRACKING_NPZ_REQUIRED_KEYS.issubset(npz_file.files)
    except Exception:
        return False


def _is_holomotion_npz(path: Path) -> bool:
    try:
        with np.load(path, allow_pickle=True) as npz_file:
            keys = set(npz_file.files)
    except Exception:
        return False

    for prefix in HOLOMOTION_NPZ_PREFIXES:
        key = f"{prefix}_" if prefix else ""
        if {
            f"{key}dof_pos",
            f"{key}global_translation",
            f"{key}global_rotation_quat",
        }.issubset(keys):
            return True
    return False


def _is_motion_tracking_npz_sidecar(path: Path) -> bool:
    return path.is_file() and _is_motion_tracking_npz_sidecar_file(path)


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


@lru_cache(maxsize=128)
def _directory_index(path_str: str, directory_mtime_ns: int) -> tuple[tuple[bool, str, str | None], ...]:
    del directory_mtime_ns
    entries: list[tuple[bool, str, str, str | None]] = []
    with os.scandir(path_str) as scan:
        for entry in scan:
            try:
                is_directory = entry.is_dir()
            except OSError:
                continue
            motion_format = None if is_directory else _file_motion_format(Path(entry.path))
            if is_directory or motion_format is not None:
                entries.append((not is_directory, entry.name.lower(), entry.path, motion_format))
    entries.sort()
    return tuple((not file_first, child_path, motion_format) for file_first, _, child_path, motion_format in entries)


def _directory_children(root: Path, path: Path, *, limit: int, offset: int) -> tuple[list[BrowserNode], int, bool]:
    try:
        directory_mtime_ns = path.stat().st_mtime_ns
    except OSError:
        directory_mtime_ns = 0
    entries = _directory_index(str(path), directory_mtime_ns)
    total_count = len(entries)
    end_index = offset + limit
    children: list[BrowserNode] = []
    for is_directory, child_path, motion_format in entries[offset:end_index]:
        child = Path(child_path)
        if is_directory:
            if _is_sonic_directory(child):
                children.append(_motion_node(root, child, "sonic"))
            else:
                children.append(_child_directory_node(root, child))
        elif motion_format is not None:
            children.append(_motion_node(root, child, motion_format))
    return children, total_count, end_index < total_count


def list_browser_nodes(
    path_str: str,
    *,
    limit: int = 1000,
    offset: int = 0,
) -> tuple[str, str | None, list[BrowserNode], int, int, int, bool]:
    root = Path(path_str).expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"Path does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Browser root must be a directory: {root}")

    safe_limit = max(1, limit)
    safe_offset = max(0, offset)
    parent = str(root.parent) if root.parent != root else None
    if _is_sonic_directory(root):
        nodes = [_motion_node(root, root, "sonic")]
        page_nodes = nodes[safe_offset : safe_offset + safe_limit]
        return str(root), parent, page_nodes, len(nodes), safe_offset, safe_limit, safe_offset + safe_limit < len(nodes)

    nodes, total_count, has_more = _directory_children(root, root, limit=safe_limit, offset=safe_offset)
    return str(root), parent, nodes, total_count, safe_offset, safe_limit, has_more
