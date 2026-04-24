from __future__ import annotations

from dataclasses import dataclass

import mujoco
import numpy as np

from .models import ViewerImpulseCommand, ViewerInteractionSummary


PRESET_FORCE_VECTORS: dict[str, np.ndarray] = {
    "push_forward": np.array([1.0, 0.0, 0.0], dtype=float),
    "push_backward": np.array([-1.0, 0.0, 0.0], dtype=float),
    "push_left": np.array([0.0, 1.0, 0.0], dtype=float),
    "push_right": np.array([0.0, -1.0, 0.0], dtype=float),
    "lift_up": np.array([0.0, 0.0, 1.0], dtype=float),
}


@dataclass(slots=True)
class ActiveImpulse:
    body_id: int
    force: np.ndarray
    expires_at: float
    applied: bool = False


def summarize_perturbation(model, data, perturb, now: float) -> ViewerInteractionSummary:
    body_id = int(getattr(perturb, "select", 0))
    active_bits = int(getattr(perturb, "active", 0))
    translate_bit = int(mujoco.mjtPertBit.mjPERT_TRANSLATE)
    rotate_bit = int(mujoco.mjtPertBit.mjPERT_ROTATE)

    if active_bits & translate_bit:
        perturb_mode = "translate"
    elif active_bits & rotate_bit:
        perturb_mode = "rotate"
    else:
        perturb_mode = "none"

    drag_active = perturb_mode != "none"
    body_name = None
    if body_id > 0:
        body_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id)

    force_magnitude = 0.0
    xfrc_applied = getattr(data, "xfrc_applied", None)
    if xfrc_applied is not None and body_id >= 0:
        force = _force_slice(xfrc_applied, body_id)
        if force is not None:
            force_magnitude = float(np.linalg.norm(force))

    return ViewerInteractionSummary(
        drag_active=drag_active,
        selected_body_id=body_id,
        selected_body_name=body_name,
        perturb_mode=perturb_mode,
        force_magnitude=force_magnitude,
        last_drag_timestamp=now if drag_active else None,
    )


def resolve_impulse_body_id(model, body_name: str | None) -> int:
    if body_name:
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, body_name)
        if body_id >= 0:
            return int(body_id)

    for candidate in ("pelvis", "torso_link", "trunk", "base"):
        body_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, candidate)
        if body_id >= 0:
            return int(body_id)

    return 1


def build_active_impulse(model, command: ViewerImpulseCommand, now: float) -> ActiveImpulse:
    body_id = resolve_impulse_body_id(model, command.body_name)
    preset_vector = PRESET_FORCE_VECTORS[str(command.preset)]
    force = np.asarray(preset_vector, dtype=float) * float(command.magnitude)
    return ActiveImpulse(
        body_id=body_id,
        force=force,
        expires_at=float(now) + float(command.duration),
    )


def apply_impulse_wrench(data, body_id: int, force: np.ndarray) -> None:
    _adjust_impulse_wrench(data, body_id, np.asarray(force, dtype=float)[:3])


def remove_impulse_wrench(data, body_id: int, force: np.ndarray) -> None:
    _adjust_impulse_wrench(data, body_id, -np.asarray(force, dtype=float)[:3])


def _adjust_impulse_wrench(data, body_id: int, force_delta: np.ndarray) -> None:
    xfrc_applied = getattr(data, "xfrc_applied", None)
    if xfrc_applied is None:
        return

    if np.ndim(xfrc_applied) == 2:
        if body_id < 0 or body_id >= int(xfrc_applied.shape[0]):
            return
        xfrc_applied[body_id, :3] = np.asarray(xfrc_applied[body_id, :3], dtype=float) + force_delta
        return

    start = body_id * 6
    stop = start + 3
    if body_id < 0 or stop > int(np.size(xfrc_applied)):
        return
    xfrc_applied[start:stop] = np.asarray(xfrc_applied[start:stop], dtype=float) + force_delta


def _force_slice(xfrc_applied, body_id: int) -> np.ndarray | None:
    if np.ndim(xfrc_applied) == 2:
        if body_id < 0 or body_id >= int(xfrc_applied.shape[0]):
            return None
        return np.asarray(xfrc_applied[body_id, :3], dtype=float)

    start = body_id * 6
    stop = start + 3
    if body_id < 0 or stop > int(np.size(xfrc_applied)):
        return None
    return np.asarray(xfrc_applied[start:stop], dtype=float)
