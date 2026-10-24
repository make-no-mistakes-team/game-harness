"""Strict original STEVE-1 wire declaration. This module has no model dependencies."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from types import MappingProxyType

PINS = {
    "steve1": "903b244796322f4d0073a8f62c05f51eac3aed52",
    "mineclip": "e6c06a0245fac63dceb38bc9bd4fecd033dae735",
    "vpt": "095519fbd4ee0e9281d19f19601e45629de9ac3f",
    "minerl": "c0c9baa03b5306ffc3acddc849ec4141b6deb98e",
    "mcp_reborn": "1e71be5bd4c49bc4d6ab0ee559c31b298b7697a3",
}
BUTTONS = ("attack", "back", "forward", "jump", "left", "right", "sneak", "sprint", "use", "drop", "inventory",
           "hotbar.1", "hotbar.2", "hotbar.3", "hotbar.4", "hotbar.5", "hotbar.6", "hotbar.7", "hotbar.8", "hotbar.9")
LIMITS = frozenset(("setup_wall_ms", "behavior_wall_ms", "total_wall_ms", "inference_wall_ms", "max_inferences", "max_steps",
                    "max_behaviors", "max_processes", "max_rss_bytes", "max_gpu_bytes", "max_recording_bytes", "max_download_bytes",
                    "max_disk_bytes", "shutdown_wall_ms"))
OPTIONAL_LIMITS = frozenset(("setup_inferences", "load_wall_ms", "steps_per_behavior", "cgroup_tasks", "cpu_quota"))
ARTIFACTS = frozenset(("source", "architecture", "policy", "prior", "mineclip", "tokenizer", "engine", "dependencies", "configuration"))
COMPONENTS = frozenset(("steve1", "vpt", "mineclip", "clip-tokenizer", "minerl", "minecraft", "mcp_reborn", "runtime"))


def _object(value, fields, optional=()):
    if not isinstance(value, Mapping) or not set(fields) <= set(value) or set(value) - set(fields) - set(optional):
        raise ValueError("Missing or unknown manifest fields")


def _text(value):
    if not isinstance(value, str) or not value or value.strip() != value or any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("Expected nonempty concrete text")


def _hash(value):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("Expected SHA-256 identity")


def _count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value != int(value) or not 0 < value <= 2**53 - 1:
        raise ValueError("Expected a positive finite safe integer")

def _seed(value):
    if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
            or value != int(value) or not 0 <= value <= 4294967295):
        raise ValueError("Expected a finite uint32 seed")


def _literal_object(value, expected, extra=()):
    _object(value, expected.keys() | set(extra))
    for key, literal in expected.items():
        actual = value[key]
        if isinstance(literal, bool):
            valid = actual is literal
        elif isinstance(literal, (list, tuple)):
            valid = isinstance(actual, (list, tuple)) and list(actual) == list(literal)
        else:
            valid = not isinstance(actual, bool) and actual == literal
        if not valid:
            raise ValueError(f"Unsupported reference setting {key}")


def _plain(value):
    if isinstance(value, Mapping):
        return {key: _plain(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(child) for child in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Nonfinite reference identity")
        return int(value) if value.is_integer() else value
    return value


def canonical_json(value):
    return json.dumps(_plain(value), sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _freeze(value):
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(child) for key, child in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(child) for child in value)
    return value


def validate_manifest(value):
    required = ("schema_version", "candidate", "purpose", "sources", "artifacts", "components", "runtime", "simulator", "preprocessing",
                "action_mapping", "goal", "recurrent", "device", "isolation", "behaviors", "limits")
    _object(value, required, ("execution",))
    for key, expected in (("schema_version", 1), ("candidate", "steve-1-original"), ("purpose", "synchronous-reference")):
        if isinstance(value[key], bool) or value[key] != expected:
            raise ValueError("Unsupported reference candidate/schema/purpose")
    _literal_object(value["sources"], PINS)
    if not isinstance(value["artifacts"], (list, tuple)) or not isinstance(value["components"], (list, tuple)):
        raise ValueError("Expected artifact and component arrays")
    artifacts, components = {}, set()
    for item in value["artifacts"]:
        _object(item, ("id", "url", "sha256", "bytes", "component"))
        for key in ("id", "url", "component"):
            _text(item[key])
        _hash(item["sha256"])
        _count(item["bytes"])
        if item["id"] in artifacts:
            raise ValueError("Duplicate artifact identity")
        artifacts[item["id"]] = item
    for item in value["components"]:
        _object(item, ("id", "terms", "use_basis", "evidence_url"))
        for child in item.values():
            _text(child)
        if item["id"] in components:
            raise ValueError("Duplicate component identity")
        components.add(item["id"])
    if not ARTIFACTS <= artifacts.keys() or not COMPONENTS <= components:
        raise ValueError("Missing inference artifact or component terms")
    if any(item["component"] not in components for item in artifacts.values()):
        raise ValueError("Unresolved artifact ownership")
    runtime = value["runtime"]
    _object(runtime, ("python", "torch", "cuda", "gym", "java_major", "dependency_lock_sha256", "configuration_sha256", "configuration_changes"))
    for key in ("python", "torch", "cuda", "gym"):
        _text(runtime[key])
    if runtime["java_major"] != 8 or isinstance(runtime["java_major"], bool):
        raise ValueError("Reference Java must be version 8")
    for field, artifact_id in (("dependency_lock_sha256", "dependencies"), ("configuration_sha256", "configuration")):
        _hash(runtime[field])
        if runtime[field] != artifacts[artifact_id]["sha256"]:
            raise ValueError("Configuration/lock artifact mismatch")
    if not isinstance(runtime["configuration_changes"], (list, tuple)):
        raise ValueError("Configuration changes must be explicit")
    for change in runtime["configuration_changes"]:
        _text(change)
    _literal_object(value["simulator"], {"game": "minecraft", "game_version": "1.16.5", "environment": "MineRLHumanSurvival-v0",
        "engine_artifact": "engine", "build": "local-mcp-reborn-plus-minerl-patch", "clock": "synchronous", "frameskip": 1}, ("reset_seed",))
    reset_seed = value["simulator"]["reset_seed"]
    _seed(reset_seed)
    preprocessing = value["preprocessing"]
    _literal_object(preprocessing, {"render_width": 640, "render_height": 360, "input_width": 128, "input_height": 128,
        "color": "RGB", "dtype": "uint8", "resize": "opencv-inter-linear", "normalization": "policy-internal-divide-255", "fov": 70,
        "gamma": 2, "gui_scale": 1, "cursor_size": 16, "mouse_sensitivity": 0.5, "invert_mouse": False, "smooth_camera": False})
    _literal_object(value["action_mapping"], {"implementation": "steve1-vendored-vpt", "camera_order": ["pitch", "yaw"],
        "camera_unit": "degrees", "camera_bins": 11, "camera_binsize": 2, "camera_maxval": 10, "camera_mu": 10,
        "camera_quantization": "mu_law", "buttons": BUTTONS})
    goal = value["goal"]
    _literal_object(goal, {"kind": "text", "cond_scale": 6, "embedding_shape": [1, 512], "sample_once_per_goal": True,
        "prior_sampling": "stochastic", "tokenizer_revision": "57c216476eefef5ab752ec549e440a49ae4ae5f3"}, ("embedding_dtype", "seed"))
    if goal["embedding_dtype"] not in ("float16", "float32"):
        raise ValueError("Invalid goal dtype")
    _seed(goal["seed"])
    if goal["seed"] == reset_seed:
        raise ValueError("Private fixture reset seed cannot be the public policy RNG seed")
    _literal_object(value["recurrent"], {"kind": "transformer", "layout": "layer-list-of-mask-and-kv", "cfg_batch": 2,
        "architecture_artifact": "architecture", "reset_on_episode": True, "reset_on_goal": True})
    _literal_object(value["device"], {"policy": "cuda:0", "mineclip": "cuda:0", "prior": "cuda:0", "precision": "cuda-autocast-fp16"}, ("runtime_compatibility_evidence",))
    _text(value["device"]["runtime_compatibility_evidence"])
    _literal_object(value["isolation"], {"worker_count": 1, "network": "none", "host_home": False, "host_auth": False,
        "operator_display": False, "operator_input": False, "unrelated_worlds": False, "evaluator_hints": False, "artifacts_read_only": True})
    behaviors = value["behaviors"]
    if not isinstance(behaviors, (list, tuple)) or len(behaviors) != 2 or {case.get("id") for case in behaviors} != {"dirt", "wood"}:
        raise ValueError("Declare both distinct selected behaviors")
    for case in behaviors:
        _object(case, ("id", "text", "fixture_sha256", "verifier", "verifier_sha256"))
        _text(case["text"])
        _hash(case["fixture_sha256"])
        _hash(case["verifier_sha256"])
        expected = "positive-own-inventory-dirt-gain" if case["id"] == "dirt" else "positive-own-inventory-log-gain"
        prompt = ("get dirt, dig hole, dig dirt, gather a ton of dirt, collect dirt" if case["id"] == "dirt"
                  else "chop down the tree, gather wood, pick up wood, chop it down, break tree")
        if case["verifier"] != expected or case["text"] != prompt:
            raise ValueError("Frozen behavior prompt/verifier mismatch")
    limits = value["limits"]
    _object(limits, LIMITS, OPTIONAL_LIMITS)
    for cap in limits.values():
        _count(cap)
    if limits["max_behaviors"] < 2 or any(limits[key] > limits["total_wall_ms"] for key in ("setup_wall_ms", "behavior_wall_ms", "inference_wall_ms")):
        raise ValueError("Inconsistent phase/cohort limits")
    if "execution" in value:
        execution = value["execution"]
        _object(execution, ("image", "prepared_tree_sha256", "runner_tree_sha256", "artifact_paths", "fixture_paths", "renderer", "resource_partition", "gpu_uuid",
                            "gpu_cdi_device", "gpu_total_bytes", "dependency_inventory_path", "configuration_path", "tokenizer_directory"))
        if re.fullmatch(r"sha256:[0-9a-f]{64}", execution["image"]) is None:
            raise ValueError("Container image must be content-addressed")
        for field in ("prepared_tree_sha256", "runner_tree_sha256"):
            _hash(execution[field])
        _count(execution["gpu_total_bytes"])
        for field in ("gpu_uuid", "gpu_cdi_device"):
            _text(execution[field])
        for key in ("artifact_paths", "fixture_paths"):
            if not isinstance(execution[key], Mapping):
                raise ValueError("Expected prepared file mapping")
        if not artifacts.keys() <= execution["artifact_paths"].keys() or not {"dirt", "wood"} <= execution["fixture_paths"].keys():
            raise ValueError("Missing prepared paths")
        if (execution["configuration_path"] != execution["artifact_paths"]["configuration"]
                or execution["dependency_inventory_path"] != execution["artifact_paths"]["dependencies"]):
            raise ValueError("Configuration/dependency inventory must use pinned artifact paths")
        for path in [*execution["artifact_paths"].values(), *execution["fixture_paths"].values(), execution["dependency_inventory_path"],
                     execution["configuration_path"], execution["tokenizer_directory"]]:
            _text(path)
            if path.startswith("/") or any(part in ("", ".", "..") for part in re.split(r"[/\\]", path)):
                raise ValueError("Prepared paths must be relative without traversal")
        renderer = execution["renderer"]
        _object(renderer, ("mode", "display", "weston_version", "command", "identity_sha256"))
        if renderer["mode"] != "owned-in-environment-container":
            raise ValueError("External renderer is not admitted")
        if re.fullmatch(r":[0-9]+", renderer["display"]) is None:
            raise ValueError("Invalid owned renderer display")
        _text(renderer["weston_version"])
        if not isinstance(renderer["command"], (list, tuple)) or len(renderer["command"]) < 2:
            raise ValueError("Explicit renderer command required")
        for argument in renderer["command"]:
            _text(argument)
        _hash(renderer["identity_sha256"])
        partition = {"policy_memory_bytes": 5368709120, "environment_memory_bytes": 2684354560, "supervision_memory_bytes": 536870912,
                     "policy_tasks": 128, "environment_tasks": 96, "supervision_tasks": 32, "policy_cpus": 5, "environment_cpus": 2,
                     "supervision_cpus": 1, "java_heap_bytes": 1610612736, "host_headroom_bytes": 1073741824}
        _literal_object(execution["resource_partition"], partition)
        if limits["max_rss_bytes"] < 8589934592 or limits.get("cgroup_tasks", 0) < 256 or limits.get("cpu_quota", 0) < 8:
            raise ValueError("Declared aggregate cannot cover resource partitions")
        allocation = {"setup_wall_ms": 7200000, "behavior_wall_ms": 600000, "total_wall_ms": 8700000, "inference_wall_ms": 5000,
                      "max_inferences": 2500, "max_steps": 2500, "max_behaviors": 2, "max_processes": 32, "max_rss_bytes": 8589934592,
                      "max_gpu_bytes": 12884901888, "max_recording_bytes": 4294967296, "max_download_bytes": 12884901888,
                      "max_disk_bytes": 42949672960, "shutdown_wall_ms": 30000, "setup_inferences": 16, "load_wall_ms": 180000,
                      "steps_per_behavior": 1200, "cgroup_tasks": 256, "cpu_quota": 8}
        if any(limits.get(key) != expected for key, expected in allocation.items()):
            raise ValueError("Execution allocation differs from the approved finite screen")
        if (runtime["python"], runtime["torch"], runtime["cuda"]) != ("3.10.22", "2.7.1", "12.8") or not runtime["configuration_changes"]:
            raise ValueError("Execution requires the declared modernized runtime")
    return _freeze(_plain(value))


def manifest_hash(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
