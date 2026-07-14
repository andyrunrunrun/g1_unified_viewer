from __future__ import annotations

from collections import OrderedDict
from contextlib import nullcontext
from math import prod
from pathlib import Path
import threading
from typing import Any

import numpy as np

from .config import POLICY_PLUGIN_DIR


MODEL_PATH = POLICY_PLUGIN_DIR / "holomotion_v13" / "model.onnx"
DEFAULT_MAX_CACHED_SESSIONS = 8
MAX_OBSERVATION_ELEMENTS = 4096
MAX_KV_CACHE_ELEMENTS = 2_000_000
CACHE_LOCK_STRIPES = 16


class HoloMotionV13Backend:
    def __init__(self, model_path: Path = MODEL_PATH, max_cached_sessions: int = DEFAULT_MAX_CACHED_SESSIONS) -> None:
        self.model_path = model_path
        self.max_cached_sessions = max(1, int(max_cached_sessions))
        self._lock = threading.Lock()
        self._session: Any | None = None
        self._input_names: list[str] = []
        self._input_shapes: dict[str, list[Any]] = {}
        self._output_names: list[str] = []
        self._kv_cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._cache_stripes = tuple(threading.Lock() for _ in range(CACHE_LOCK_STRIPES))

    def _ensure_session(self) -> Any:
        if self._session is not None:
            return self._session
        with self._lock:
            if self._session is not None:
                return self._session
            if not self.model_path.exists():
                raise RuntimeError(f"HoloMotion v1.3 model is missing: {self.model_path}")
            try:
                import onnxruntime as ort
            except Exception as exc:
                raise RuntimeError(
                    "onnxruntime is required for HoloMotion v1.3 backend inference. "
                    "Install it into the backend Python environment."
                ) from exc
            session = ort.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
            inputs = session.get_inputs()
            self._input_names = [node.name for node in inputs]
            self._input_shapes = {node.name: list(getattr(node, "shape", []) or []) for node in inputs}
            self._output_names = [node.name for node in session.get_outputs()]
            self._session = session
            return session

    def infer(
        self,
        *,
        obs: list[float],
        cache_id: str | None = None,
        reset_cache: bool = False,
        step_idx: int = 0,
    ) -> dict[str, Any]:
        guard = self._cache_stripes[hash(cache_id) % len(self._cache_stripes)] if cache_id else nullcontext()
        with guard:
            return self._infer(obs=obs, cache_id=cache_id, reset_cache=reset_cache, step_idx=step_idx)

    def _infer(
        self,
        *,
        obs: list[float],
        cache_id: str | None,
        reset_cache: bool,
        step_idx: int,
    ) -> dict[str, Any]:
        session = self._ensure_session()
        if not 0 < len(obs) <= MAX_OBSERVATION_ELEMENTS:
            raise ValueError(f"obs must contain between 1 and {MAX_OBSERVATION_ELEMENTS} values")
        raw_obs_shape = self._input_shapes.get("obs") or []
        expected_obs_size = raw_obs_shape[-1] if raw_obs_shape and isinstance(raw_obs_shape[-1], int) else None
        if expected_obs_size and expected_obs_size > 0 and expected_obs_size != len(obs):
            raise ValueError(f"obs has {len(obs)} values, expected {expected_obs_size}")
        obs_array = np.asarray(obs, dtype=np.float32).reshape(1, -1)
        feeds: dict[str, np.ndarray] = {"obs": obs_array}
        if "past_key_values" in self._input_names:
            cached: np.ndarray | None = None
            if cache_id and not reset_cache:
                with self._cache_lock:
                    if cache_id in self._kv_cache:
                        cached = self._kv_cache[cache_id]
                        self._kv_cache.move_to_end(cache_id)
            if cached is not None:
                feeds["past_key_values"] = cached
            else:
                shape = self._static_input_shape("past_key_values", [1, 2, 1, 32, 4, 64])
                if prod(shape) > MAX_KV_CACHE_ELEMENTS:
                    raise RuntimeError(f"Model KV cache shape is too large: {shape}")
                feeds["past_key_values"] = np.zeros(shape, dtype=np.float32)
        if "step_idx" in self._input_names:
            feeds["step_idx"] = np.asarray([step_idx], dtype=np.int64)

        outputs = session.run(self._output_names, feeds)
        output_map = dict(zip(self._output_names, outputs, strict=False))
        actions = np.asarray(output_map.get("actions", outputs[0]), dtype=np.float32).reshape(-1)
        present_key_values = output_map.get("present_key_values")
        response: dict[str, Any] = {
            "actions": actions.tolist(),
            "input_names": self._input_names,
            "output_names": self._output_names,
        }
        if cache_id:
            response["cache_id"] = cache_id
        if present_key_values is not None:
            present = np.asarray(present_key_values, dtype=np.float32)
            if cache_id:
                with self._cache_lock:
                    self._kv_cache[cache_id] = present
                    self._kv_cache.move_to_end(cache_id)
                    while len(self._kv_cache) > self.max_cached_sessions:
                        self._kv_cache.popitem(last=False)
            else:
                response["present_key_values"] = present.reshape(-1).tolist()
            response["present_key_values_shape"] = list(present.shape)
        return response

    def _static_input_shape(self, name: str, fallback: list[int] | None = None) -> list[int]:
        raw_shape = self._input_shapes.get(name) or fallback or []
        return [int(value) if isinstance(value, int) and value > 0 else 1 for value in raw_shape]


_backend = HoloMotionV13Backend()


def infer_holomotion_v13(payload: dict[str, Any]) -> dict[str, Any]:
    return _backend.infer(
        obs=list(payload.get("obs") or []),
        cache_id=str(payload.get("cache_id") or "") or None,
        reset_cache=bool(payload.get("reset_cache")),
        step_idx=int(payload.get("step_idx") or 0),
    )
