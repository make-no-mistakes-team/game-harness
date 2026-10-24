"""An owned Weston/Xwayland tree inside the environment's hard resource cgroup."""
from __future__ import annotations

import os
import hashlib
from pathlib import Path
import subprocess
import time

from .reference_runner import ReferenceBoundaryError


class ReferenceRenderer:
    def __init__(self, specification, timeout_ms):
        self.process = None
        self.log = None
        if specification["mode"] != "owned-in-environment-container":
            raise ReferenceBoundaryError("External/operator displays are not admitted")
        command = specification["command"]
        if (not isinstance(command, list) or not command or command[0] != "/usr/bin/weston"
                or "--xwayland" not in command or not any("headless" in argument for argument in command)
                or not any(argument in ("--renderer=gl", "--use-gl") for argument in command)):
            raise ReferenceBoundaryError("Renderer must be the declared accelerated headless Weston process")
        if hashlib.sha256(Path(command[0]).read_bytes()).hexdigest() != specification["identity_sha256"]:
            raise ReferenceBoundaryError("Actual Weston binary hash differs from the frozen renderer")
        version = subprocess.run(["/usr/bin/weston", "--version"], check=True, capture_output=True, text=True, timeout=5).stdout.strip()
        if specification["weston_version"] not in version:
            raise ReferenceBoundaryError("Actual Weston version differs from frozen renderer")
        runtime = Path("/scratch/xdg")
        runtime.mkdir(mode=0o700)
        os.environ["XDG_RUNTIME_DIR"] = str(runtime)
        os.environ["DISPLAY"] = specification["display"]
        self.log = Path("/evidence/renderer.log").open("xb")
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT,
                                        start_new_session=True, env=dict(os.environ))
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise ReferenceBoundaryError("Owned renderer exited before readiness")
            probe = subprocess.run(["xdpyinfo", "-display", specification["display"]], capture_output=True, timeout=5)
            if probe.returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise ReferenceBoundaryError("Owned Xwayland readiness deadline")
        gl = subprocess.run(["glxinfo", "-B"], check=True, capture_output=True, text=True, timeout=10).stdout
        if "direct rendering: Yes" not in gl or "NVIDIA" not in gl or any(name in gl.lower() for name in ("llvmpipe", "softpipe", "software rasterizer")):
            raise ReferenceBoundaryError("Owned reference rendering is not verified accelerated NVIDIA rendering")
        self.evidence = {"weston_version": version, "glxinfo": gl, "display": specification["display"],
                         "ownership": "environment-container-cgroup", "operator_display_access": False}

    def close(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None
        if self.log is not None:
            self.log.close()
            self.log = None
