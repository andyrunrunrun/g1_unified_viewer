from __future__ import annotations

import io
import struct
import subprocess
import sys
from pathlib import Path

import msgpack

from .models import PolicyManifest, SimulationSnapshot, model_to_dict


class PolicyError(RuntimeError):
    pass


def _pack_message(payload: dict) -> bytes:
    body = msgpack.packb(payload, use_bin_type=True)
    return struct.pack(">I", len(body)) + body


def _read_exact(stream: io.BufferedReader, size: int) -> bytes:
    data = stream.read(size)
    if data is None or len(data) != size:
        raise PolicyError("Unexpected EOF while reading policy runner response")
    return data


def _read_message(stream: io.BufferedReader) -> dict:
    header = _read_exact(stream, 4)
    (length,) = struct.unpack(">I", header)
    body = _read_exact(stream, length)
    result = msgpack.unpackb(body, raw=False)
    if not isinstance(result, dict):
        raise PolicyError(f"Unexpected policy runner response type: {type(result)}")
    return result


def _resolve_runner_path(manifest: PolicyManifest) -> list[str]:
    python_executable = sys.executable if manifest.env_python == "__CURRENT_PYTHON__" else manifest.env_python
    entrypoint = Path(manifest.entrypoint)
    if not entrypoint.is_absolute():
        if manifest.manifest_path is None:
            raise PolicyError(f"Manifest path missing for policy: {manifest.policy_id}")
        entrypoint = (Path(manifest.manifest_path).resolve().parent.parent / entrypoint).resolve()
    return [python_executable, str(entrypoint)]


class PolicyRegistry:
    def __init__(self, manifest_dir: Path):
        self.manifest_dir = manifest_dir
        self._manifests: dict[str, PolicyManifest] = {}

    def discover(self) -> list[PolicyManifest]:
        manifests: dict[str, PolicyManifest] = {}
        if self.manifest_dir.exists():
            for path in sorted(self.manifest_dir.glob("*.json")):
                manifest = PolicyManifest(**__import__("json").loads(path.read_text()), manifest_path=str(path))
                manifests[manifest.policy_id] = manifest
        self._manifests = manifests
        return list(self._manifests.values())

    def list(self) -> list[PolicyManifest]:
        if not self._manifests:
            return self.discover()
        return list(self._manifests.values())

    def get(self, policy_id: str) -> PolicyManifest:
        if not self._manifests:
            self.discover()
        if policy_id not in self._manifests:
            raise PolicyError(f"Unknown policy: {policy_id}")
        return self._manifests[policy_id]


class SubprocessPolicyRunner:
    def __init__(self, manifest: PolicyManifest):
        self.manifest = manifest
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> dict:
        if self.process is None or self.process.poll() is not None:
            command = _resolve_runner_path(self.manifest)
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        return self.call("describe", {})

    def call(self, method: str, payload: dict) -> dict:
        if self.process is None or self.process.stdin is None or self.process.stdout is None:
            raise PolicyError(f"Policy runner not started for {self.manifest.policy_id}")
        self.process.stdin.write(_pack_message({"method": method, "payload": payload}))
        self.process.stdin.flush()
        result = _read_message(self.process.stdout)
        if not result.get("ok", False):
            raise PolicyError(result.get("error", f"Policy runner call failed: {method}"))
        return result.get("result", {})

    def reset(self, context: dict | None = None) -> dict:
        return self.call("reset", context or {})

    def step(self, snapshot: SimulationSnapshot) -> dict:
        return self.call("step", {"snapshot": model_to_dict(snapshot)})

    def stop(self) -> None:
        if self.process is None:
            return
        try:
            self.call("close", {})
        except Exception:
            pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if self.process.stdin is not None:
            self.process.stdin.close()
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()
        self.process = None


class PolicyRunnerManager:
    def __init__(self, registry: PolicyRegistry):
        self.registry = registry
        self._active: dict[str, SubprocessPolicyRunner] = {}

    def list_policies(self) -> list[PolicyManifest]:
        return self.registry.list()

    def start(self, policy_id: str) -> dict:
        if policy_id in self._active:
            return self._active[policy_id].call("describe", {})
        manifest = self.registry.get(policy_id)
        runner = SubprocessPolicyRunner(manifest)
        result = runner.start()
        self._active[policy_id] = runner
        return result

    def stop(self, policy_id: str) -> None:
        runner = self._active.pop(policy_id, None)
        if runner is not None:
            runner.stop()

    def step(self, policy_id: str, snapshot: SimulationSnapshot) -> dict:
        if policy_id not in self._active:
            self.start(policy_id)
        return self._active[policy_id].step(snapshot)

    def mock_step(self, policy_id: str, snapshot: SimulationSnapshot) -> dict:
        return self.step(policy_id, snapshot)

    def stop_all(self) -> None:
        active_ids = list(self._active.keys())
        for policy_id in active_ids:
            self.stop(policy_id)
