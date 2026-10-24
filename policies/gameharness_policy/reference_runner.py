"""Finite protocol boundary and isolated process entry for the STEVE reference.

No model or simulator is imported until an explicitly selected process role starts.
The host supervisor owns containers, durable admission, resources and termination.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import secrets
import sys
import time
from collections.abc import Mapping

from .manifest import BUTTONS, LIMITS, OPTIONAL_LIMITS, _count


class ReferenceBoundaryError(RuntimeError):
    pass


def policy_observation(raw):
    if not isinstance(raw, Mapping) or raw.get("error") is not None:
        raise ReferenceBoundaryError("Environment observation error")
    frame = raw.get("pov")
    if not isinstance(frame, Mapping) or set(frame) != {"width", "height", "color", "dtype", "data"}:
        raise ReferenceBoundaryError("Missing or malformed RGB frame")
    if (frame["width"], frame["height"], frame["color"], frame["dtype"]) != (640, 360, "RGB", "uint8"):
        raise ReferenceBoundaryError("Reference frame configuration mismatch")
    data = frame["data"]
    if not isinstance(data, bytes) or len(data) != 691200:
        raise ReferenceBoundaryError("Truncated or nonbyte RGB frame")
    return {"pov": dict(frame)}


def validate_action(raw):
    if not isinstance(raw, Mapping) or set(raw) != set(BUTTONS) | {"camera"}:
        raise ReferenceBoundaryError("Unsupported or missing learned action channel")
    for button in BUTTONS:
        if type(raw[button]) is not int or raw[button] not in (0, 1):
            raise ReferenceBoundaryError("Nonbinary learned button")
    camera = raw["camera"]
    if not isinstance(camera, (list, tuple)) or len(camera) != 2:
        raise ReferenceBoundaryError("Camera must be a flat pitch/yaw vector")
    if any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or abs(value) > 10 for value in camera):
        raise ReferenceBoundaryError("Invalid decoded camera action")
    return {**{button: raw[button] for button in BUTTONS}, "camera": list(camera)}


class ReferenceBoundary:
    def __init__(self, limits, started_ms):
        if not isinstance(limits, Mapping) or not LIMITS <= limits.keys() or set(limits) - LIMITS - OPTIONAL_LIMITS:
            raise ValueError("Missing or unknown reference limits")
        for value in limits.values():
            _count(value)
        if not isinstance(started_ms, (float, int)) or not math.isfinite(started_ms):
            raise ValueError("Expected a monotonic start timestamp")
        self.limits = dict(limits)
        self.started_ms = self.last_ms = started_ms
        self.phase = "setup"
        self.case_started_ms = None
        self.case_id = None
        self.case_steps = 0
        self.seen_cases = set()
        self.inferences = self.steps = 0
        self.ticket = None
        self.inference_started_ms = None
        self.action_accepted = False
        self.terminal = False
        self.reason = None
        self.peaks = {"rss_bytes": 0, "gpu_bytes": 0, "processes": 0, "recording_bytes": 0, "download_bytes": 0, "disk_bytes": 0}

    def _fail(self, reason):
        self.stop(reason)
        raise ReferenceBoundaryError(reason)

    def stop(self, reason):
        if not self.terminal:
            self.reason = str(reason)
            self.terminal = True
        self.ticket = None

    def check(self, *, now_ms, resources):
        if self.terminal:
            raise ReferenceBoundaryError(f"Reference stopped: {self.reason}")
        if isinstance(now_ms, bool) or not isinstance(now_ms, (float, int)) or not math.isfinite(now_ms) or now_ms < self.last_ms:
            self._fail("Invalid or backwards monotonic clock")
        self.last_ms = now_ms
        if now_ms - self.started_ms >= self.limits["total_wall_ms"]:
            self._fail("Total reference wall deadline")
        if self.phase == "setup" and now_ms - self.started_ms >= self.limits["setup_wall_ms"]:
            self._fail("Reference setup wall deadline")
        if self.phase == "behavior" and now_ms - self.case_started_ms >= self.limits["behavior_wall_ms"]:
            self._fail("Behavior wall deadline")
        if self.inference_started_ms is not None and now_ms - self.inference_started_ms >= self.limits["inference_wall_ms"]:
            self._fail("Inference wall deadline")
        if not isinstance(resources, Mapping):
            self._fail("Unknown reference resources")
        caps = {"rss_bytes": "max_rss_bytes", "gpu_bytes": "max_gpu_bytes", "processes": "max_processes",
                "recording_bytes": "max_recording_bytes", "download_bytes": "max_download_bytes", "disk_bytes": "max_disk_bytes"}
        for key, cap in caps.items():
            value = resources.get(key)
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
                self._fail(f"Unknown reference resource {key}")
            self.peaks[key] = max(self.peaks[key], value)
            if value > self.limits[cap]:
                self._fail(f"Reference resource ceiling {key}")

    def finish_setup(self, *, now_ms, resources):
        self.check(now_ms=now_ms, resources=resources)
        if self.phase != "setup":
            self._fail("Setup already completed")
        self.phase = "idle"

    def start_behavior(self, case_id, *, now_ms, resources):
        self.check(now_ms=now_ms, resources=resources)
        if self.phase != "idle" or case_id in self.seen_cases or len(self.seen_cases) >= self.limits["max_behaviors"]:
            self._fail("Behavior phase/count/duplicate refusal")
        self.seen_cases.add(case_id)
        self.case_id, self.case_started_ms, self.case_steps = case_id, now_ms, 0
        self.phase = "behavior"

    def finish_behavior(self, case_id, *, now_ms, resources):
        if self.phase != "behavior" or case_id != self.case_id or self.ticket is not None:
            self._fail("Cannot finish behavior with unresolved action ownership")
        # Finalizing an idle finite case does not admit new work past its horizon.
        # Total/resource deadlines still apply, and unresolved inference cannot close.
        self.phase = "idle"
        self.check(now_ms=now_ms, resources=resources)
        self.phase, self.case_id, self.case_started_ms = "idle", None, None

    def reserve_inference(self, *, now_ms, resources):
        self.check(now_ms=now_ms, resources=resources)
        if self.phase != "behavior" or self.ticket is not None:
            self._fail("Inference requires an active single-flight behavior")
        if self.inferences >= self.limits["max_inferences"] or self.steps >= self.limits["max_steps"]:
            self._fail("Reference inference/step allocation exhausted")
        if self.case_steps >= self.limits.get("steps_per_behavior", self.limits["max_steps"]):
            self._fail("Per-behavior step allocation exhausted")
        self.inferences += 1
        self.ticket = secrets.token_hex(24)
        self.inference_started_ms = now_ms
        self.action_accepted = False
        return self.ticket

    def accept_action(self, ticket, action, *, now_ms, resources):
        self.check(now_ms=now_ms, resources=resources)
        if ticket != self.ticket or self.ticket is None or self.action_accepted:
            self._fail("Late/foreign/duplicate action output")
        try:
            checked = validate_action(action)
        except ReferenceBoundaryError as error:
            self._fail(str(error))
        self.action_accepted = True
        self.inference_started_ms = None
        return checked

    def record_step(self, ticket, *, now_ms, resources):
        self.check(now_ms=now_ms, resources=resources)
        if self.ticket is None or ticket != self.ticket or not self.action_accepted:
            self._fail("Step acknowledgement has no accepted action")
        self.steps += 1
        self.case_steps += 1
        self.ticket = None
        self.action_accepted = False

    def snapshot(self):
        return {"inferences": self.inferences, "steps": self.steps, "behaviors": len(self.seen_cases),
                "terminal": self.terminal, "reason": self.reason, "cleanup": "unconfirmed", "peaks": dict(self.peaks)}


def _receive():
    line = sys.stdin.buffer.readline(2_000_001)
    if not line:
        return None
    if len(line) > 2_000_000 or not line.endswith(b"\n"):
        raise ReferenceBoundaryError("Oversized/truncated process message")
    value = json.loads(line)
    if not isinstance(value, dict) or not isinstance(value.get("request_id"), str):
        raise ReferenceBoundaryError("Process message requires request identity")
    return value


def main():
    parser = argparse.ArgumentParser(description="Original STEVE-1 isolated reference process")
    parser.add_argument("--role", choices=("policy", "environment"), required=True)
    arguments = parser.parse_args()
    protocol = sys.stdout
    engine = None
    try:
        boot = _receive()
        if boot is None or boot.get("kind") != "initialize":
            raise ReferenceBoundaryError("Explicit initialization required")
        from pathlib import Path
        import os
        Path(os.environ["HOME"]).mkdir(mode=0o700, exist_ok=True)
        with contextlib.redirect_stdout(sys.stderr):
            if arguments.role == "policy":
                from .steve_policy import StevePolicy
                engine = StevePolicy(boot["spec"])
            else:
                from .minerl_environment import MineRLEnvironment
                engine = MineRLEnvironment(boot["spec"])
        protocol.write(json.dumps({"request_id": boot["request_id"], "kind": "ready", "evidence": engine.evidence}, allow_nan=False) + "\n")
        protocol.flush()
        while True:
            message = _receive()
            if message is None:
                raise ReferenceBoundaryError("Host transport closed before explicit shutdown")
            request_id = message.pop("request_id")
            kind = message.pop("kind", None)
            if kind == "close":
                with contextlib.redirect_stdout(sys.stderr):
                    engine.close()
                engine = None
                protocol.write(json.dumps({"request_id": request_id, "kind": "closed"}) + "\n")
                protocol.flush()
                return
            with contextlib.redirect_stdout(sys.stderr):
                response = engine.handle(kind, message)
            protocol.write(json.dumps({"request_id": request_id, **response}, allow_nan=False, separators=(",", ":")) + "\n")
            protocol.flush()
    except BaseException as error:
        protocol.write(json.dumps({"kind": "error", "error": f"{type(error).__name__}: {error}", "at_monotonic_ns": time.monotonic_ns()}) + "\n")
        protocol.flush()
        raise
    finally:
        if engine is not None:
            with contextlib.redirect_stdout(sys.stderr):
                engine.close()


if __name__ == "__main__":
    main()
