"""Read-only, streaming verification of staged reference inputs."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
from pathlib import Path


def contained_file(root, relative):
    base = Path(root).resolve(strict=True)
    path = base / relative
    if Path(relative).is_absolute() or any(part in ("", ".", "..") for part in Path(relative).parts):
        raise ValueError("Prepared path traversal")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(base) or resolved != path or not path.is_file():
        raise ValueError("Prepared artifact must be a regular file without symlinks")
    return path


def verify_file(root, item):
    path = contained_file(root, item["path"])
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
            size += len(block)
    if digest.hexdigest() != item["sha256"] or size != item["bytes"]:
        raise ValueError(f"Prepared artifact mismatch: {item['id']}")
    return path


def verify_runtime(runtime, inventory_path):
    import platform
    actual = {distribution.metadata["Name"].lower().replace("_", "-"): distribution.version
              for distribution in importlib.metadata.distributions()}
    expected = json.loads(Path(inventory_path).read_text())
    if actual != expected:
        raise ValueError("Installed dependency inventory differs from frozen preparation")
    if platform.python_version() != runtime["python"]:
        raise ValueError("Python runtime mismatch")
    return actual
