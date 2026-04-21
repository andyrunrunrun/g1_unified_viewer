from __future__ import annotations

import io
import os
import queue
import threading
from typing import Literal
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .config import resolve_g1_model_path
from .models import CanonicalRobotState

os.environ.setdefault("MUJOCO_GL", "egl")

import mujoco  # noqa: E402

ImageFormat = Literal["png", "jpeg"]


def _normalize_image_format(image_format: str | None) -> ImageFormat:
    if image_format is None:
        return "jpeg"
    lowered = image_format.lower()
    if lowered in {"jpg", "jpeg"}:
        return "jpeg"
    return "png"


def _encode_image(image: Image.Image, image_format: ImageFormat = "jpeg", quality: int = 80) -> bytes:
    buffer = io.BytesIO()
    if image_format == "jpeg":
        image.convert("RGB").save(buffer, format="JPEG", quality=max(30, min(95, quality)), optimize=False)
    else:
        image.save(buffer, format="PNG")
    return buffer.getvalue()


class MujocoRenderer:
    def __init__(self, model_path: Path | None = None, width: int = 640, height: int = 480):
        self.model_path = model_path or resolve_g1_model_path()
        self._lock = threading.Lock()
        self.backend = os.environ.get("MUJOCO_GL", "egl")
        self.model = mujoco.MjModel.from_xml_path(str(self.model_path))
        self.data = mujoco.MjData(self.model)
        self.max_width = int(self.model.vis.global_.offwidth)
        self.max_height = int(self.model.vis.global_.offheight)
        self.width = min(width, self.max_width)
        self.height = min(height, self.max_height)
        self.camera = mujoco.MjvCamera()
        self.camera.type = mujoco.mjtCamera.mjCAMERA_FREE
        self.camera.distance = 3.2
        self.camera.azimuth = 140
        self.camera.elevation = -20
        self.camera.lookat[:] = np.array([0.0, 0.0, 0.8])
        self.renderer = mujoco.Renderer(self.model, self.height, self.width)

    def render_state(
        self,
        state: CanonicalRobotState,
        width: int | None = None,
        height: int | None = None,
        image_format: str = "jpeg",
        quality: int = 80,
    ) -> bytes:
        with self._lock:
            target_width = min(width or self.width, self.max_width)
            target_height = min(height or self.height, self.max_height)
            if target_width != self.width or target_height != self.height:
                self.width = target_width
                self.height = target_height
                self.renderer.close()
                self.renderer = mujoco.Renderer(self.model, self.height, self.width)

            self._apply_state(state)
            mujoco.mj_forward(self.model, self.data)
            root = np.asarray(state.root_translation, dtype=float)
            self.camera.lookat[:] = np.array([root[0], root[1], max(0.4, root[2])])
            self.renderer.update_scene(self.data, camera=self.camera)
            pixels = self.renderer.render()
        image = Image.fromarray(np.asarray(pixels))
        return _encode_image(image, _normalize_image_format(image_format), quality)

    def _apply_state(self, state: CanonicalRobotState) -> None:
        self.data.qpos[:] = 0.0
        self.data.qvel[:] = 0.0
        root_translation = np.asarray(state.root_translation, dtype=float)
        root_rotation = np.asarray(state.root_rotation_wxyz, dtype=float)
        joint_positions = np.asarray(state.joint_positions, dtype=float)
        joint_velocities = np.asarray(state.joint_velocities, dtype=float) if state.joint_velocities else np.zeros_like(joint_positions)

        self.data.qpos[:3] = root_translation[:3]
        self.data.qpos[3:7] = root_rotation[:4]
        joint_qpos_len = min(len(joint_positions), self.model.nq - 7)
        joint_qvel_len = min(len(joint_velocities), self.model.nv - 6)
        self.data.qpos[7 : 7 + joint_qpos_len] = joint_positions[:joint_qpos_len]
        self.data.qvel[6 : 6 + joint_qvel_len] = joint_velocities[:joint_qvel_len]

    def close(self) -> None:
        self.renderer.close()


class _RenderJob:
    def __init__(
        self,
        state: CanonicalRobotState,
        width: int | None,
        height: int | None,
        image_format: str,
        quality: int,
    ):
        self.state = state
        self.width = width
        self.height = height
        self.image_format = image_format
        self.quality = quality
        self.done = threading.Event()
        self.image_bytes: bytes | None = None
        self.error: Exception | None = None


class ThreadedMujocoRenderer:
    def __init__(self, model_path: Path | None = None, width: int = 640, height: int = 480):
        self.model_path = model_path
        self.width = width
        self.height = height
        self.backend = os.environ.get("MUJOCO_GL", "egl")
        self._jobs: queue.Queue[_RenderJob | None] = queue.Queue()
        self._ready = threading.Event()
        self._init_error: Exception | None = None
        self._renderer: MujocoRenderer | None = None
        self._thread = threading.Thread(target=self._worker_main, name="mujoco-renderer", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=15.0)
        if not self._ready.is_set():
            raise RuntimeError("Timed out while starting the MuJoCo render worker")
        if self._init_error is not None:
            raise RuntimeError(str(self._init_error))

    def _worker_main(self) -> None:
        try:
            self._renderer = MujocoRenderer(self.model_path, self.width, self.height)
            self.backend = self._renderer.backend
        except Exception as exc:
            self._init_error = exc
            self._ready.set()
            return

        self._ready.set()
        while True:
            job = self._jobs.get()
            if job is None:
                break
            try:
                assert self._renderer is not None
                job.image_bytes = self._renderer.render_state(
                    job.state,
                    job.width,
                    job.height,
                    job.image_format,
                    job.quality,
                )
            except Exception as exc:
                job.error = exc
            finally:
                job.done.set()

        if self._renderer is not None:
            self._renderer.close()

    def render_state(
        self,
        state: CanonicalRobotState,
        width: int | None = None,
        height: int | None = None,
        image_format: str = "jpeg",
        quality: int = 80,
    ) -> bytes:
        job = _RenderJob(state, width, height, image_format, quality)
        self._jobs.put(job)
        job.done.wait()
        if job.error is not None:
            raise job.error
        if job.image_bytes is None:
            raise RuntimeError("MuJoCo render worker returned no image")
        return job.image_bytes

    def close(self) -> None:
        self._jobs.put(None)
        self._thread.join(timeout=3.0)


def fallback_png(
    state: CanonicalRobotState,
    width: int = 960,
    height: int = 720,
    image_format: str = "jpeg",
    quality: int = 80,
) -> bytes:
    image = Image.new("RGB", (width, height), (246, 238, 228))
    draw = ImageDraw.Draw(image)
    draw.rectangle((40, 40, width - 40, height - 40), outline=(32, 39, 61), width=4)
    draw.text((64, 60), "MuJoCo render unavailable", fill=(32, 39, 61))
    draw.text((64, 102), f"root: {np.round(np.asarray(state.root_translation, dtype=float), 3).tolist()}", fill=(32, 39, 61))
    draw.text((64, 138), f"joints: {len(state.joint_positions)}", fill=(32, 39, 61))

    values = np.asarray(state.joint_positions[:24], dtype=float)
    if values.size:
        values = np.clip(values, -2.5, 2.5)
        left = 80
        bottom = height - 80
        span = max(1, values.size)
        for idx, value in enumerate(values):
            x = left + int(idx * (width - 160) / span)
            y = int(bottom - ((value + 2.5) / 5.0) * (height - 220))
            draw.line((x, bottom, x, y), fill=(225, 115, 71), width=8)
    return _encode_image(image, _normalize_image_format(image_format), quality)
