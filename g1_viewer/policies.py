from __future__ import annotations

import io
import json
import struct
import subprocess
import sys
from pathlib import Path

import msgpack

from .models import PolicyManifest, SimulationSnapshot, model_to_dict


class PolicyError(RuntimeError):
    pass


def _slugify(value: str) -> str:
    normalized = "".join(char.lower() if char.isalnum() else "_" for char in value)
    parts = [part for part in normalized.split("_") if part]
    return "_".join(parts) or "policy"


def _policy_asset_url(plugin_dir: Path, model_path: Path) -> str:
    return f"/policy-plugins/{plugin_dir.name}/{model_path.name}"


def _dynamic_config_url(policy_id: str) -> str:
    return f"/api/policy-plugins/{policy_id}/config"


def _localized_payload(
    payload: dict,
    key: str,
    *,
    fallback: str,
    suffix: str | None = None,
) -> dict[str, str]:
    value = payload.get(key)
    if not isinstance(value, dict):
        value = {}
    localized: dict[str, str] = {}
    for language, text in value.items():
        if isinstance(text, str):
            localized[language] = f"{text} / {suffix}" if suffix else text
    if "en" not in localized:
        localized["en"] = fallback
    if "zh" not in localized:
        localized["zh"] = fallback
    return localized


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
    if manifest.entrypoint is None:
        raise PolicyError(f"Policy runner entrypoint missing for policy: {manifest.policy_id}")
    python_executable = sys.executable if manifest.env_python == "__CURRENT_PYTHON__" else manifest.env_python
    entrypoint = Path(manifest.entrypoint)
    if not entrypoint.is_absolute():
        if manifest.manifest_path is None:
            raise PolicyError(f"Manifest path missing for policy: {manifest.policy_id}")
        manifest_dir = Path(manifest.manifest_path).resolve().parent
        plugin_relative = (manifest_dir / entrypoint).resolve()
        legacy_relative = (manifest_dir.parent / entrypoint).resolve()
        entrypoint = plugin_relative if plugin_relative.exists() else legacy_relative
    return [python_executable, str(entrypoint)]


class PolicyRegistry:
    def __init__(self, manifest_dir: Path):
        self.manifest_dir = manifest_dir
        self._manifests: dict[str, PolicyManifest] = {}

    def discover(self) -> list[PolicyManifest]:
        manifests: dict[str, PolicyManifest] = {}
        if self.manifest_dir.exists():
            manifest_paths = [
                *sorted(self.manifest_dir.glob("*/policy.json")),
                *sorted(self.manifest_dir.glob("*.json")),
            ]
            for path in manifest_paths:
                manifest = PolicyManifest(
                    **json.loads(path.read_text(encoding="utf-8")),
                    manifest_path=str(path),
                    plugin_path=str(path.parent),
                )
                manifests[manifest.policy_id] = manifest
            for path in sorted(self.manifest_dir.glob("*/policy_format.json")):
                for manifest in self._discover_format_folder(path):
                    manifests[manifest.policy_id] = manifest
        self._manifests = manifests
        return list(self._manifests.values())

    def _discover_format_folder(self, path: Path) -> list[PolicyManifest]:
        payload = json.loads(path.read_text(encoding="utf-8"))
        plugin_dir = path.parent
        format_id = payload.get("format_id") or plugin_dir.name
        policy_id_prefix = payload.get("policy_id_prefix") or format_id
        base_display_name = payload.get("display_name") or format_id
        config_template = payload.get("config_template") or "tracking_policy_latest.json"
        model_overrides = payload.get("model_overrides", {})
        if not isinstance(model_overrides, dict):
            model_overrides = {}

        manifests: list[PolicyManifest] = []
        for model_path in sorted(plugin_dir.glob("*.onnx")):
            model_stem = _slugify(model_path.stem)
            slugified_prefix = _slugify(policy_id_prefix)
            default_policy_id = model_stem if model_stem.startswith(f"{slugified_prefix}_") else f"{slugified_prefix}_{model_stem}"
            override = model_overrides.get(model_path.name, {})
            if not isinstance(override, dict):
                override = {}
            policy_id = override.get("policy_id") or default_policy_id
            display_name = override.get("display_name") or f"{base_display_name} / {model_path.stem}"
            override_display_i18n = override.get("display_name_i18n")
            if isinstance(override_display_i18n, dict):
                display_name_i18n = _localized_payload(
                    override,
                    "display_name_i18n",
                    fallback=display_name,
                )
            else:
                display_name_i18n = _localized_payload(
                    payload,
                    "display_name_i18n",
                    fallback=display_name,
                    suffix=model_path.stem,
                )
            description = override.get("description") or payload.get("description", "")
            tags = list(payload.get("tags", []))
            for tag in override.get("tags", []):
                if tag not in tags:
                    tags.append(tag)
            manifests.append(
                PolicyManifest(
                    policy_id=policy_id,
                    display_name=display_name,
                    robot_type=override.get("robot_type") or payload.get("robot_type", "g1"),
                    runtime=override.get("runtime") or payload.get("runtime", "browser"),
                    framework=override.get("framework") or payload.get("framework", "onnx"),
                    env_python=override.get("env_python") or payload.get("env_python", "__CURRENT_PYTHON__"),
                    entrypoint=override.get("entrypoint") or payload.get("entrypoint"),
                    weights_path=override.get("weights_path") or payload.get("weights_path"),
                    config_path=override.get("config_path") or _dynamic_config_url(policy_id),
                    module_path=override.get("module_path") or payload.get("module_path"),
                    config_template=override.get("config_template") or config_template,
                    control_mode=override.get("control_mode") or payload.get("control_mode", "joint_position_target"),
                    tags=tags,
                    description=description,
                    display_name_i18n=display_name_i18n,
                    description_i18n=_localized_payload(
                        override if isinstance(override.get("description_i18n"), dict) else payload,
                        "description_i18n",
                        fallback=description,
                    ),
                    manifest_path=str(path),
                    plugin_path=str(plugin_dir),
                    format_id=format_id,
                    model_file=model_path.name,
                )
            )
        return manifests

    def list(self) -> list[PolicyManifest]:
        return self.discover()

    def get(self, policy_id: str) -> PolicyManifest:
        self.discover()
        if policy_id not in self._manifests:
            raise PolicyError(f"Unknown policy: {policy_id}")
        return self._manifests[policy_id]

    def policy_config(self, policy_id: str) -> dict:
        manifest = self.get(policy_id)
        if manifest.plugin_path is None or manifest.config_template is None:
            raise PolicyError(f"Policy has no dynamic config template: {policy_id}")
        config_path = Path(manifest.plugin_path) / manifest.config_template
        if not config_path.exists():
            raise PolicyError(f"Policy config template missing: {config_path}")
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        if manifest.model_file:
            onnx = payload.get("onnx")
            if not isinstance(onnx, dict):
                onnx = {}
            onnx["path"] = _policy_asset_url(Path(manifest.plugin_path), Path(manifest.model_file))
            payload["onnx"] = onnx
        return payload


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

    def reset(self, policy_id: str, context: dict | None = None) -> dict:
        if policy_id not in self._active:
            self.start(policy_id)
        return self._active[policy_id].reset(context)

    def mock_step(self, policy_id: str, snapshot: SimulationSnapshot) -> dict:
        return self.step(policy_id, snapshot)

    def stop_all(self) -> None:
        active_ids = list(self._active.keys())
        for policy_id in active_ids:
            self.stop(policy_id)
