from __future__ import annotations

import math
import struct
import sys

import msgpack


def _read_exact(size: int) -> bytes:
    data = sys.stdin.buffer.read(size)
    if len(data) != size:
        raise EOFError
    return data


def _read_message() -> dict:
    header = _read_exact(4)
    (length,) = struct.unpack(">I", header)
    body = _read_exact(length)
    payload = msgpack.unpackb(body, raw=False)
    if not isinstance(payload, dict):
        raise TypeError(f"Unexpected payload type: {type(payload)}")
    return payload


def _write_message(payload: dict) -> None:
    body = msgpack.packb(payload, use_bin_type=True)
    sys.stdout.buffer.write(struct.pack(">I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def _describe() -> dict:
    return {
        "policy_id": "mock_g1_policy",
        "display_name": "Mock G1 Policy",
        "robot_type": "g1",
        "observation_spec": {
            "robot_state": ["root_position", "root_rotation_wxyz", "joint_positions", "joint_velocities"],
            "reference_target": [
                "target_root_position",
                "target_root_rotation_wxyz",
                "target_joint_positions",
                "target_joint_velocities",
            ],
            "extras": ["frame_index", "dt"],
        },
        "action_spec": {"mode": "joint_position_target"},
    }


def _step(payload: dict) -> dict:
    snapshot = payload.get("snapshot", {})
    metadata = snapshot.get("metadata", {})
    policy_inputs = metadata.get("policy_inputs", {})
    reference_target = policy_inputs.get("reference_target", {})
    if reference_target:
        values = [float(value) for value in reference_target.get("target_joint_positions", [])]
        return {
            "mode": "joint_position_target",
            "values": values,
            "metadata": {
                "runner": "mock",
                "frame_index": policy_inputs.get("frame_index", 0),
                "dt": policy_inputs.get("dt", 0.0),
            },
        }

    state = snapshot.get("state", {})
    joint_positions = state.get("joint_positions", [])
    timestamp = float(snapshot.get("timestamp", 0.0))
    values = [
        float(position) + 0.05 * math.sin(timestamp * 2.0 + index * 0.3)
        for index, position in enumerate(joint_positions)
    ]
    return {
        "mode": "joint_position_target",
        "values": values,
        "metadata": {
            "runner": "mock",
            "timestamp": timestamp,
        },
    }


def main() -> int:
    while True:
        try:
            request = _read_message()
        except EOFError:
            return 0

        method = request.get("method")
        payload = request.get("payload", {})
        try:
            if method == "describe":
                result = _describe()
            elif method == "reset":
                result = {"status": "reset"}
            elif method == "step":
                result = _step(payload)
            elif method == "close":
                _write_message({"ok": True, "result": {"status": "closing"}})
                return 0
            else:
                raise ValueError(f"Unknown method: {method}")
            _write_message({"ok": True, "result": result})
        except Exception as exc:
            _write_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    raise SystemExit(main())
