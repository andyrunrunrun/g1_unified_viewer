from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading
import time

import numpy as np

from g1_viewer.holomotion_v13 import HoloMotionV13Backend


class _ConcurrentSession:
    def __init__(self) -> None:
        self._counter_lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def run(self, output_names, feeds):
        with self._counter_lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        time.sleep(0.03)
        with self._counter_lock:
            self.active -= 1
        return [
            np.asarray([[0.1, -0.2]], dtype=np.float32),
            np.asarray([[1.0, 2.0]], dtype=np.float32),
        ]


def test_same_cache_id_serializes_holomotion_inference() -> None:
    session = _ConcurrentSession()
    backend = HoloMotionV13Backend()
    backend._session = session
    backend._input_names = ["obs", "past_key_values"]
    backend._input_shapes = {"obs": [1, 2], "past_key_values": [1, 2]}
    backend._output_names = ["actions", "present_key_values"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(backend.infer, obs=[0.0, 1.0], cache_id="shared")
            for _ in range(2)
        ]
        for future in futures:
            future.result()

    assert session.max_active == 1


def test_dynamic_observation_shape_uses_runtime_vector_length() -> None:
    class DynamicSession:
        def run(self, output_names, feeds):
            assert feeds["obs"].shape == (1, 2)
            return [np.asarray([[0.1, -0.2]], dtype=np.float32)]

    backend = HoloMotionV13Backend()
    backend._session = DynamicSession()
    backend._input_names = ["obs"]
    backend._input_shapes = {"obs": [1, "obs_dim"]}
    backend._output_names = ["actions"]

    result = backend.infer(obs=[0.0, 1.0])

    assert len(result["actions"]) == 2
