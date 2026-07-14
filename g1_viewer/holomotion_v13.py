from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
import threading
from typing import Any

import numpy as np

from .config import POLICY_PLUGIN_DIR


MODEL_PATH = POLICY_PLUGIN_DIR / "holomotion_v13" / "model.onnx"
DEFAULT_MAX_CACHED_SESSIONS = 8


class HoloMotionV13Backend:
    def __init__(self, model_path: Path = MODEL_PATH, max_cached_sessions: int = DEFAULT_MAX_CACHED_SESSIONS) -> None:
        self.model_path = model_path
        self.max_cached_sessions = max(1, int(max_cached_sessions))
        self._lock = threading.Lock()
        self._session: Any | None = None
        self._input_names: list[str] = []
        self._output_names: list[str] = []
        self._kv_cache: OrderedDict[str, np.ndarray] = OrderedDict()

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
            self._input_names = [node.name for node in session.get_inputs()]
            self._output_names = [node.name for node in session.get_outputs()]
            self._session = session
            return session

    def infer(
        self,
        *,
        obs: list[float],
        past_key_values: list[float] | None = None,
        past_key_values_shape: list[int] | None = None,
        cache_id: str | None = None,
        reset_cache: bool = False,
        step_idx: int = 0,
    ) -> dict[str, Any]:
        session = self._ensure_session()
        obs_array = np.asarray(obs, dtype=np.float32).reshape(1, -1)
        feeds: dict[str, np.ndarray] = {"obs": obs_array}
        if "past_key_values" in self._input_names:
            if cache_id and not reset_cache and cache_id in self._kv_cache:
                feeds["past_key_values"] = self._kv_cache[cache_id]
                self._kv_cache.move_to_end(cache_id)
            elif past_key_values is None:
                shape = past_key_values_shape or [1, 2, 1, 32, 4, 64]
                feeds["past_key_values"] = np.zeros(shape, dtype=np.float32)
            else:
                shape = past_key_values_shape or [1, len(past_key_values)]
                feeds["past_key_values"] = np.asarray(past_key_values, dtype=np.float32).reshape(shape)
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
                self._kv_cache[cache_id] = present
                self._kv_cache.move_to_end(cache_id)
                while len(self._kv_cache) > self.max_cached_sessions:
                    self._kv_cache.popitem(last=False)
            else:
                response["present_key_values"] = present.reshape(-1).tolist()
            response["present_key_values_shape"] = list(present.shape)
        return response


_backend = HoloMotionV13Backend()


def infer_holomotion_v13(payload: dict[str, Any]) -> dict[str, Any]:
    return _backend.infer(
        obs=list(payload.get("obs") or []),
        past_key_values=payload.get("past_key_values"),
        past_key_values_shape=payload.get("past_key_values_shape"),
        cache_id=str(payload.get("cache_id") or "") or None,
        reset_cache=bool(payload.get("reset_cache")),
        step_idx=int(payload.get("step_idx") or 0),
    )
