"""Trusted game/recording/verifier side. Never imported by the learned worker."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from .artifacts import verify_file
from .reference_runner import ReferenceBoundary, ReferenceBoundaryError, validate_action
from .renderer import ReferenceRenderer


def verify_camera_calibration(initial, turned, restored):
    """Check observed own-camera deltas, not requested-action echoes."""
    import numpy as np
    normalized = []
    for sample in (initial, turned, restored):
        if not isinstance(sample, dict) or not all(key in sample for key in ("pitch", "yaw")):
            raise ReferenceBoundaryError("Own-camera calibration observations are unavailable")
        values = {}
        for key in ("pitch", "yaw"):
            scalar = np.asarray(sample[key])
            if scalar.shape != () or scalar.dtype.kind not in "iuf" or not np.isfinite(scalar):
                raise ReferenceBoundaryError("Own-camera calibration requires finite scalar numeric observations")
            values[key] = float(scalar.item())
            if not math.isfinite(values[key]):
                raise ReferenceBoundaryError("Own-camera observation is outside the finite Python-number range")
        normalized.append(values)
    initial, turned, restored = normalized
    pitch = turned["pitch"] - initial["pitch"]
    yaw = (turned["yaw"] - initial["yaw"] + 180) % 360 - 180
    reset_pitch = restored["pitch"] - initial["pitch"]
    reset_yaw = (restored["yaw"] - initial["yaw"] + 180) % 360 - 180
    if abs(pitch - 2) > 0.25 or abs(yaw - 4) > 0.25 or abs(reset_pitch) > 0.25 or abs(reset_yaw) > 0.25:
        raise ReferenceBoundaryError("Native camera gain/sign/order does not match the reference")
    return {"observed_delta_pitch": pitch, "observed_delta_yaw": yaw, "restored_pitch_error": reset_pitch, "restored_yaw_error": reset_yaw}


class MineRLEnvironment:
    def __init__(self, spec):
        if set(spec) != {"engine", "preprocessing", "seed", "fixtures", "recording_bytes", "shutdown_ms", "renderer", "java_heap_bytes", "limits"}:
            raise ReferenceBoundaryError("Environment bootstrap fields mismatch")
        self.boundary = ReferenceBoundary(spec["limits"], started_ms=time.monotonic() * 1000)
        self.root = Path("/reference")
        engine = verify_file(self.root, spec["engine"])
        if engine.relative_to(self.root).as_posix() != "engine/build/libs/mcprec-6.13.jar":
            raise ReferenceBoundaryError("Expected the locally built original engine layout")
        self.scratch = Path("/scratch")
        if spec["java_heap_bytes"] != 1610612736:
            raise ReferenceBoundaryError("Java heap differs from the frozen environment allocation")
        os.environ["_JAVA_OPTIONS"] = "-Xmx1536m"
        java = subprocess.run(["java", "-version"], check=True, capture_output=True, text=True, timeout=5)
        if 'version "1.8.' not in java.stderr:
            raise ReferenceBoundaryError("The reference engine requires the pinned Java-8 runtime")
        self.renderer = ReferenceRenderer(spec["renderer"], 120_000)
        runtime = self.scratch / "engine"
        shutil.copytree(self.root / "engine", runtime, symlinks=False)
        self.preprocessing = spec["preprocessing"]
        p = self.preprocessing
        if p["mouse_sensitivity"] != 0.5 or p["invert_mouse"] or p["smooth_camera"]:
            raise ReferenceBoundaryError("Selected reference requires default noninverted unsmoothed mouse sensitivity")
        # MineRL v1.0.1 launches in its engine directory rather than a temporary copy.
        # Set only this private copy; gamma/FOV/GUI/cursor are mission settings.
        (runtime / "options.txt").write_text("mouseSensitivity:0.5\ninvertYMouse:false\nsmoothCamera:false\n")
        self.fixtures = {}
        for case in spec["fixtures"]:
            if set(case) != {"id", "path", "sha256", "bytes"} or case["id"] not in ("dirt", "wood"):
                raise ReferenceBoundaryError("Unknown prepared fixture")
            path = verify_file("/fixtures", case)
            if path.suffix != ".zip":
                raise ReferenceBoundaryError("Declared reference fixture must be a pinned world ZIP")
            self.fixtures[case["id"]] = path
        if set(self.fixtures) != {"dirt", "wood"}:
            raise ReferenceBoundaryError("Both declared fixtures are required")
        for name in ("minerl", "steve1"):
            sys.path.insert(0, str(self.root / "sources" / name))
        import numpy as np
        from minerl.env.malmo import InstanceManager
        from minerl.herobraine.env_specs.human_survival_specs import HumanSurvival
        InstanceManager.MINECRAFT_DIR = str(runtime)
        InstanceManager.STATUS_DIR = str(self.scratch / "performance")
        InstanceManager.MAXINSTANCES = 1
        os.environ["MALMO_MINECRAFT_OUTPUT_LOGDIR"] = str(self.scratch)
        # Environment process does not import the STEVE agent/Torch to obtain settings.
        kwargs = dict(fov_range=[70, 70], frameskip=1, gamma_range=[2, 2], guiscale_range=[1, 1],
                      resolution=[640, 360], cursor_size_range=[16.0, 16.0])
        self.env = HumanSurvival(load_filename=str(self.fixtures["dirt"]), **kwargs).make()
        self.np = np
        self.seed = spec["seed"]
        self.shutdown_ms = spec["shutdown_ms"]
        self.max_recording_bytes = spec["recording_bytes"]
        self.recorded_bytes = 0
        self.case = None
        self.frames = []
        self.observation = None
        self.baseline = None
        self.case_steps = 0
        self.calibration = False
        self.done = False
        self.evidence = {"environment": "MineRLHumanSurvival-v0", "game": "1.16.5", "engine_sha256": spec["engine"]["sha256"],
                         "start_mode": "declared_reference_fixture", "restore_verified": None,
                         "recording": "timestamped-native-RGB-PNG-and-variable-frame-rate-video", "clock": "synchronous",
                         "renderer": self.renderer.evidence, "java": java.stderr}

    def _inventory(self, observation):
        inventory = observation.get("inventory")
        if not isinstance(inventory, dict):
            raise ReferenceBoundaryError("Verifier inventory is unavailable")
        output = {}
        for item, count in inventory.items():
            value = self.np.asarray(count)
            if value.shape != () or not self.np.isfinite(value) or int(value) != value or value < 0:
                raise ReferenceBoundaryError("Verifier inventory has invalid counts")
            output[item] = int(value)
        return output

    def _verification(self):
        inventory = self._inventory(self.observation)
        keys = ["dirt"] if self.case == "dirt" else [f"{wood}_log" for wood in ("oak", "spruce", "birch", "jungle", "acacia", "dark_oak")]
        gain = sum(inventory.get(key, 0) - self.baseline.get(key, 0) for key in keys)
        return {"verified": gain > 0, "gain": gain, "item_keys": keys, "baseline": self.baseline, "inventory": inventory}

    def _record(self, action):
        from PIL import Image
        pov = self.observation.get("pov")
        if not isinstance(pov, self.np.ndarray) or pov.shape != (360, 640, 3) or pov.dtype != self.np.uint8:
            raise ReferenceBoundaryError("Native observation shape/dtype mismatch")
        captured_ns = time.monotonic_ns()
        filename = f"{len(self.frames):06d}.png"
        path = self.case_directory / filename
        Image.fromarray(pov, "RGB").save(path)
        size = path.stat().st_size
        self.recorded_bytes += size
        if self.recorded_bytes > self.max_recording_bytes:
            raise ReferenceBoundaryError("Recording byte allocation exhausted")
        entry = {"file": filename, "monotonic_ns": captured_ns, "wall_time_ns": time.time_ns(),
                 "step": self.case_steps, "action": action, "done": self.done, "verification": self._verification()}
        serialized = json.dumps(entry, allow_nan=False, separators=(",", ":")) + "\n"
        self.recorded_bytes += len(serialized.encode())
        if self.recorded_bytes > self.max_recording_bytes:
            raise ReferenceBoundaryError("Recording byte allocation exhausted")
        with (self.case_directory / "frames.jsonl").open("a") as stream:
            stream.write(serialized)
        self.frames.append((filename, captured_ns))
        return {"width": 640, "height": 360, "color": "RGB", "dtype": "uint8",
                "data_base64": base64.b64encode(pov.tobytes(order="C")).decode("ascii")}

    def handle(self, kind, message):
        if kind == "finish_setup" and set(message) == {"resources"}:
            self.boundary.finish_setup(now_ms=time.monotonic() * 1000, resources=message["resources"])
            return {"kind": "setup_finished", "boundary": self.boundary.snapshot()}
        if kind == "start_behavior" and set(message) == {"case_id", "resources"} and message["case_id"] in ("dirt", "wood"):
            self.boundary.start_behavior(message["case_id"], now_ms=time.monotonic() * 1000, resources=message["resources"])
            return {"kind": "behavior_started"}
        if kind == "reserve_inference" and set(message) == {"resources"}:
            ticket = self.boundary.reserve_inference(now_ms=time.monotonic() * 1000, resources=message["resources"])
            return {"kind": "inference_reserved", "ticket": ticket}
        if kind == "reset":
            if set(message) != {"case_id", "fixture_id"} or message["case_id"] not in ("calibration", "dirt", "wood") or message["fixture_id"] not in self.fixtures:
                raise ReferenceBoundaryError("Undeclared reference case")
            if self.case is not None:
                raise ReferenceBoundaryError("Previous reference recording not finalized")
            self.calibration = message["case_id"] == "calibration"
            if not self.calibration and self.boundary.case_id != message["case_id"]:
                raise ReferenceBoundaryError("Fixture reset has no active behavior admission")
            self.case = message["fixture_id"]
            self.case_directory = Path("/evidence") / message["case_id"]
            self.case_directory.mkdir(mode=0o700)
            self.env.task.load_filename = str(self.fixtures[self.case])
            self.env.seed(self.seed)
            self.observation = self.env.reset()
            self.case_steps, self.done = 0, False
            self.baseline = self._inventory(self.observation)
            self.frames = []
            frame = self._record(None)
            return {"kind": "observation", "pov": frame, "done": False, "verification": self._verification(),
                    "fixture_id": self.case, "seed_before_reset": self.seed, "restore_verified": None}
        if kind == "step":
            expected = {"action"} if self.calibration else {"action", "ticket", "resources"}
            if set(message) != expected or self.case is None or self.done:
                raise ReferenceBoundaryError("No active live reference case")
            action = validate_action(message["action"])
            if self.calibration:
                if self.case_steps >= 3:
                    raise ReferenceBoundaryError("Declared calibration step allocation exhausted")
            else:
                action = self.boundary.accept_action(message["ticket"], action, now_ms=time.monotonic() * 1000, resources=message["resources"])
            result = self.env.step(action)
            if not isinstance(result, tuple) or len(result) != 4:
                raise ReferenceBoundaryError("Unexpected MineRL step API")
            observation, _, done, info = result
            if not isinstance(info, dict) or info.get("error") is not None:
                raise ReferenceBoundaryError(f"MineRL environment error: {info}")
            self.observation = observation
            self.done = bool(done)
            self.case_steps += 1
            if not self.calibration:
                self.boundary.record_step(message["ticket"], now_ms=time.monotonic() * 1000, resources=message["resources"])
            frame = self._record(action)
            return {"kind": "observation", "pov": frame, "done": self.done, "verification": self._verification(), "step": self.case_steps}
        if kind == "control_probe" and not message and self.calibration and self.case is not None and self.case_steps == 0:
            initial = dict(self.observation.get("location_stats", {}))
            from .manifest import BUTTONS
            probe = {**dict.fromkeys(BUTTONS, 0), "camera": [2, 4]}
            first = self.handle("step", {"action": probe})
            if first["done"]:
                raise ReferenceBoundaryError("Environment ended during native camera calibration")
            turned = dict(self.observation.get("location_stats", {}))
            probe["camera"] = [-2, -4]
            final = self.handle("step", {"action": probe})
            if final["done"]:
                raise ReferenceBoundaryError("Environment ended during native camera restoration")
            evidence = verify_camera_calibration(initial, turned, dict(self.observation.get("location_stats", {})))
            return {**final, "steps": 2, "control_verified": True, "control_evidence": evidence}
        if kind == "finish_case" and self.case is not None and set(message) == (set() if self.calibration else {"resources"}):
            if not self.calibration:
                self.boundary.finish_behavior(self.case, now_ms=time.monotonic() * 1000, resources=message["resources"])
            self._encode_video()
            verification = self._verification()
            self.case = None
            return {"kind": "case_finished", "verification": verification, "steps": self.case_steps, "recording_bytes": self.recorded_bytes}
        raise ReferenceBoundaryError("Unsupported environment command")

    def _encode_video(self):
        if not self.frames:
            raise ReferenceBoundaryError("Recording contains no genuine frames")
        lines = []
        for index, (filename, captured_ns) in enumerate(self.frames):
            lines.append(f"file '{filename}'")
            if index + 1 < len(self.frames):
                duration = (self.frames[index + 1][1] - captured_ns) / 1_000_000_000
                if duration <= 0:
                    raise ReferenceBoundaryError("Recording timestamps are not monotonic")
                lines.append(f"duration {duration:.9f}")
        lines.append(f"file '{self.frames[-1][0]}'")
        (self.case_directory / "timeline.ffconcat").write_text("ffconcat version 1.0\n" + "\n".join(lines) + "\n")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-n", "-f", "concat", "-safe", "1", "-i", "timeline.ffconcat",
                        "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "native-speed.mp4"],
                       cwd=self.case_directory, check=True, timeout=self.shutdown_ms / 1000)
        self.recorded_bytes += (self.case_directory / "native-speed.mp4").stat().st_size
        if self.recorded_bytes > self.max_recording_bytes:
            raise ReferenceBoundaryError("Recording byte allocation exhausted during encoding")

    def close(self):
        # A partial recording remains auditable if the outer owner interrupts encoding.
        if getattr(self, "boundary", None) is not None:
            self.boundary.stop("owned_process_shutdown")
        if getattr(self, "env", None) is not None:
            self.env.close()
            self.env = None
        if getattr(self, "renderer", None) is not None:
            self.renderer.close()
            self.renderer = None
