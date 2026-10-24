"""T24a contracts with pinned lightweight NumPy; no Torch/MineRL/game imports.

Fixture digests and numerical allocations are synthetic, never admission evidence.
ReferenceBoundary is the real guard under test, not a fake policy/environment.
Its tickets authorize one inference and at most one acknowledged simulator step.
"""

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np

from gameharness_policy.manifest import manifest_hash, validate_manifest
from gameharness_policy.reference_runner import (
    ReferenceBoundary,
    ReferenceBoundaryError,
    policy_observation,
    validate_action,
)
from gameharness_policy.minerl_environment import verify_camera_calibration


FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/steve-reference-manifest.json"
BUTTONS = (
    "attack", "back", "forward", "jump", "left", "right", "sneak", "sprint",
    "use", "drop", "inventory", "hotbar.1", "hotbar.2", "hotbar.3", "hotbar.4",
    "hotbar.5", "hotbar.6", "hotbar.7", "hotbar.8", "hotbar.9",
)


def manifest():
    return json.loads(FIXTURE.read_text())


def action():
    return {**dict.fromkeys(BUTTONS, 0), "camera": [0.0, 0.0]}


def resources(**overrides):
    return {"rss_bytes": 900, "gpu_bytes": 1900, "processes": 3,
            "recording_bytes": 2900, "download_bytes": 3900,
            "disk_bytes": 4900, **overrides}


def active_boundary():
    boundary = ReferenceBoundary(manifest()["limits"], started_ms=0)
    boundary.finish_setup(now_ms=10, resources=resources())
    boundary.start_behavior("dirt", now_ms=10, resources=resources())
    return boundary


class ManifestAdmissionTests(unittest.TestCase):
    def test_canonical_hash_matches_independent_json_sha256(self):
        raw = manifest()
        expected = hashlib.sha256(json.dumps(
            raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")).hexdigest()
        self.assertEqual(manifest_hash(validate_manifest(raw)), expected)

    def test_parsed_manifest_is_detached_and_deeply_immutable(self):
        raw = manifest()
        parsed = validate_manifest(raw)
        raw["goal"]["cond_scale"] = 0
        raw["artifacts"][0]["sha256"] = "0" * 64
        self.assertEqual(parsed["goal"]["cond_scale"], 6)
        self.assertEqual(parsed["artifacts"][0]["sha256"], "a" * 64)
        with self.assertRaises(TypeError):
            parsed["limits"]["max_inferences"] = 999
        with self.assertRaises(TypeError):
            parsed["behaviors"][0]["text"] = "hidden hint"

    def test_integral_json_numbers_share_the_javascript_manifest_identity(self):
        raw = manifest()
        expected = manifest_hash(validate_manifest(raw))
        raw["goal"]["cond_scale"] = 6.0
        raw["preprocessing"]["gamma"] = 2.0
        raw["goal"]["seed"] = 7.0
        raw["simulator"]["reset_seed"] = 17.0
        self.assertEqual(manifest_hash(validate_manifest(raw)), expected)

    def test_private_reset_seed_is_not_the_policy_rng_seed(self):
        raw = manifest()
        raw["simulator"]["reset_seed"] = raw["goal"]["seed"]
        with self.assertRaises(ValueError):
            validate_manifest(raw)

    def test_missing_pins_and_unknown_fields_are_not_defaulted(self):
        for field in ("sources", "artifacts", "components", "runtime", "simulator",
                      "preprocessing", "action_mapping", "goal", "recurrent",
                      "device", "isolation", "behaviors", "limits"):
            with self.subTest(field=field):
                raw = manifest()
                del raw[field]
                with self.assertRaises(ValueError):
                    validate_manifest(raw)
        raw = manifest()
        raw["isolation"]["private_world_path"] = "/host/unrelated-world"
        with self.assertRaises(ValueError):
            validate_manifest(raw)

    def test_caps_reject_bool_fractional_zero_missing_and_nonfinite(self):
        for cap in manifest()["limits"]:
            for invalid in (True, False, 0, -1, 0.5, 2**53, math.nan, math.inf, None, "2"):
                with self.subTest(cap=cap, invalid=invalid):
                    raw = manifest()
                    raw["limits"][cap] = invalid
                    with self.assertRaises(ValueError):
                        validate_manifest(raw)
            raw = manifest()
            del raw["limits"][cap]
            with self.subTest(cap=cap, invalid="missing"):
                with self.assertRaises(ValueError):
                    validate_manifest(raw)

    def test_undeclared_device_clock_and_preprocessing_changes_refuse(self):
        mutations = (
            ("candidate", None, "rocket-2"),
            ("sources", "steve1", "main"),
            ("runtime", "java_major", 21),
            ("simulator", "game_version", "1.21.4"),
            ("simulator", "clock", "live"),
            ("preprocessing", "color", "BGR"),
            ("preprocessing", "resize", "nearest"),
            ("action_mapping", "camera_order", ["yaw", "pitch"]),
            ("recurrent", "cfg_batch", 1),
            ("goal", "sample_once_per_goal", False),
            ("isolation", "network", "host"),
            ("isolation", "host_auth", True),
            ("isolation", "evaluator_hints", True),
            ("isolation", "worker_count", 2),
        )
        for parent, key, value in mutations:
            with self.subTest(parent=parent, key=key):
                raw = manifest()
                if key is None:
                    raw[parent] = value
                else:
                    raw[parent][key] = value
                with self.assertRaises(ValueError):
                    validate_manifest(raw)

    def test_artifact_hash_is_required_and_each_component_retains_use_basis(self):
        for artifact_id in ("source", "architecture", "policy", "prior", "mineclip",
                            "tokenizer", "engine", "dependencies", "configuration"):
            raw = manifest()
            raw["artifacts"] = [a for a in raw["artifacts"] if a["id"] != artifact_id]
            with self.subTest(missing=artifact_id):
                with self.assertRaises(ValueError):
                    validate_manifest(raw)
        raw = manifest()
        raw["artifacts"][2]["sha256"] = "publisher says it exists"
        with self.assertRaises(ValueError):
            validate_manifest(raw)
        raw = manifest()
        raw["components"][0]["use_basis"] = ""
        with self.assertRaises(ValueError):
            validate_manifest(raw)


class PermittedObservationTests(unittest.TestCase):
    # The process wire frame is decoded to ndarray only inside the admitted adapter.
    # A sentinel RGB pixel distinguishes color preservation from all-zero fixtures.
    def frame(self):
        return {"width": 640, "height": 360, "color": "RGB", "dtype": "uint8",
                "data": bytes((239, 17, 41)) + bytes(640 * 360 * 3 - 3)}

    def test_private_stats_and_hints_do_not_cross_policy_projection(self):
        raw = {
            "pov": self.frame(),
            "inventory": {"dirt": 64},
            "location_stats": {"xpos": 123, "zpos": 456},
            "seed": "evaluator-only",
            "verifier": {"target": [1, 2, 3]},
            "reward": 999,
            "auth": "must-not-cross",
        }
        projected = policy_observation(raw)
        self.assertEqual(set(projected), {"pov"})
        self.assertEqual(projected["pov"]["data"][:3], bytes((239, 17, 41)))
        self.assertEqual(len(projected["pov"]["data"]), 691200)
        raw["pov"]["color"] = "BGR"
        self.assertEqual(projected["pov"]["color"], "RGB")

    def test_missing_error_or_malformed_pov_never_becomes_a_black_frame(self):
        cases = ({}, {"pov": None}, {"pov": self.frame(), "error": "Connection timed out!"})
        for raw in cases:
            with self.subTest(raw_keys=list(raw)):
                with self.assertRaises(ReferenceBoundaryError):
                    policy_observation(raw)
        for field, value in (("width", 128), ("height", 128), ("color", "BGR"),
                             ("dtype", "float32"), ("data", b"truncated")):
            raw = {"pov": self.frame()}
            raw["pov"][field] = value
            with self.subTest(field=field):
                with self.assertRaises(ReferenceBoundaryError):
                    policy_observation(raw)


class PermittedActionTests(unittest.TestCase):
    def test_decoded_camera_order_sign_and_buttons_are_preserved(self):
        raw = action()
        raw.update({"attack": 1, "forward": 1, "camera": [-10.0, 2.0]})
        checked = validate_action(raw)
        self.assertEqual(checked["camera"], [-10.0, 2.0])
        self.assertEqual(checked["attack"], 1)
        self.assertEqual(checked["forward"], 1)
        self.assertEqual(checked["use"], 0)
        raw["camera"][0] = 999
        self.assertEqual(checked["camera"], [-10.0, 2.0])

    def test_rejects_unknown_and_missing_channels_instead_of_silent_clipping(self):
        for field in ("chat", "command", "craft", "teleport", "ESC", "pickItem", "swapHands"):
            raw = action()
            raw[field] = 1
            with self.subTest(extra=field):
                with self.assertRaises(ReferenceBoundaryError):
                    validate_action(raw)
        raw = action()
        del raw["attack"]
        with self.assertRaises(ReferenceBoundaryError):
            validate_action(raw)

    def test_only_finite_flat_decoded_camera_and_binary_buttons_are_legal(self):
        for value in ([math.nan, 0], [0, math.inf], [10.001, 0], [0, -10.001],
                      [0], [[0, 0]], "0 0", [True, 0]):
            raw = action()
            raw["camera"] = value
            with self.subTest(camera=value):
                with self.assertRaises(ReferenceBoundaryError):
                    validate_action(raw)
        for value in (-1, 2, 0.5, "1", None, [1]):
            raw = action()
            raw["attack"] = value
            with self.subTest(button=value):
                with self.assertRaises(ReferenceBoundaryError):
                    validate_action(raw)


class NativeCalibrationContractTests(unittest.TestCase):
    def test_original_minerl_zero_dimensional_camera_arrays_are_normalized(self):
        evidence = verify_camera_calibration(
            {"pitch": np.array(10.0, dtype=np.float32), "yaw": np.array(179.0, dtype=np.float64)},
            {"pitch": np.array(12.0, dtype=np.float32), "yaw": np.array(-177.0, dtype=np.float64)},
            {"pitch": np.array(10.0, dtype=np.float32), "yaw": np.array(179.0, dtype=np.float64)})
        self.assertEqual(evidence["observed_delta_pitch"], 2)
        self.assertEqual(evidence["observed_delta_yaw"], 4)
        self.assertTrue(all(type(value) in (int, float) for value in evidence.values()))
        json.dumps(evidence, allow_nan=False)

    def test_numpy_numeric_scalars_preserve_gain_sign_and_yaw_wrap(self):
        for dtype in (np.float32, np.float64, np.int32, np.int64):
            with self.subTest(dtype=dtype):
                evidence = verify_camera_calibration(
                    {"pitch": dtype(10), "yaw": dtype(179)},
                    {"pitch": dtype(12), "yaw": dtype(-177)},
                    {"pitch": dtype(10), "yaw": dtype(179)})
                self.assertEqual(evidence["observed_delta_yaw"], 4)
                self.assertTrue(all(type(value) in (int, float) for value in evidence.values()))

    def test_camera_array_normalization_rejects_bool_nonfinite_and_nonscalar(self):
        invalid = (True, np.bool_(True), np.array(True), np.array([12.0]), np.array([[12.0]]),
                   np.array([12.0, 13.0]), np.array(np.nan), np.float32(np.inf), np.array("12"),
                   np.array(12.0 + 1j), np.array(None))
        for value in invalid:
            with self.subTest(value=repr(value)):
                with self.assertRaises(ReferenceBoundaryError):
                    verify_camera_calibration(
                        {"pitch": np.array(10.0), "yaw": np.array(20.0)},
                        {"pitch": value, "yaw": np.array(24.0)},
                        {"pitch": np.array(10.0), "yaw": np.array(20.0)})

    def test_scalar_array_camera_gain_and_order_mismatches_are_still_rejected(self):
        with self.assertRaises(ReferenceBoundaryError):
            verify_camera_calibration(
                {"pitch": np.array(10.0), "yaw": np.array(20.0)},
                {"pitch": np.array(14.0), "yaw": np.array(22.0)},
                {"pitch": np.array(10.0), "yaw": np.array(20.0)})

    def test_observed_camera_gain_sign_and_order_including_yaw_wrap(self):
        evidence = verify_camera_calibration(
            {"pitch": 10, "yaw": 179}, {"pitch": 12, "yaw": -177}, {"pitch": 10, "yaw": 179})
        self.assertEqual(evidence["observed_delta_pitch"], 2)
        self.assertEqual(evidence["observed_delta_yaw"], 4)

    def test_requested_action_is_not_proof_of_observed_rotation(self):
        for turned in ({"pitch": 10, "yaw": 20}, {"pitch": 14, "yaw": 22},
                       {"pitch": 8, "yaw": 16}, {"pitch": math.nan, "yaw": 24}):
            with self.subTest(turned=turned):
                with self.assertRaises(ReferenceBoundaryError):
                    verify_camera_calibration({"pitch": 10, "yaw": 20}, turned, {"pitch": 10, "yaw": 20})

    def test_invalid_first_process_message_fails_before_loading_a_model(self):
        with tempfile.TemporaryDirectory(prefix="gh-reference-protocol-") as temporary:
            marker = Path(temporary) / "torch-imported"
            (Path(temporary) / "torch.py").write_text(
                f"from pathlib import Path\nPath({str(marker)!r}).write_text('unexpected model import')\n")
            policies = str(Path(__file__).resolve().parents[1])
            result = subprocess.run(
                [sys.executable, "-m", "gameharness_policy.reference_runner", "--role", "policy"],
                input=json.dumps({"request_id": "bad-first-message", "kind": "action"}) + "\n",
                text=True, capture_output=True, timeout=5,
                env={**os.environ, "PYTHONPATH": os.pathsep.join((temporary, policies)),
                     "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertNotEqual(result.returncode, 0)
            output = json.loads(result.stdout.splitlines()[0])
            self.assertEqual(output["kind"], "error")
            self.assertIn("initialization", output["error"])
            self.assertFalse(marker.exists())


class FiniteReferenceBoundaryTests(unittest.TestCase):
    """Count at admission, acknowledge actual steps, and fence every terminal path.

    finish_setup transitions once; start/finish_behavior tracks distinct cases.
    reserve_inference creates one single-flight opaque ticket and increments calls.
    accept_action checks that ticket/deadline/resources/action but not step success.
    record_step acknowledges one actual environment round trip for that ticket.
    stop is terminal; check is called by the outer supervisor even without output.
    All expiry checks use >= for wall deadlines and > for observed resource peaks.
    """

    def test_counts_before_compute_and_never_invents_an_applied_step(self):
        boundary = active_boundary()
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        self.assertEqual(boundary.snapshot()["inferences"], 1)
        self.assertEqual(boundary.snapshot()["steps"], 0)
        boundary.accept_action(ticket, action(), now_ms=12, resources=resources())
        self.assertEqual(boundary.snapshot()["steps"], 0)
        boundary.record_step(ticket, now_ms=13, resources=resources())
        self.assertEqual(boundary.snapshot()["steps"], 1)
        with self.assertRaises(ReferenceBoundaryError):
            boundary.record_step(ticket, now_ms=14, resources=resources())
        self.assertEqual(boundary.snapshot()["steps"], 1)

    def test_setup_or_idle_phase_cannot_admit_policy_compute(self):
        setup = ReferenceBoundary(manifest()["limits"], started_ms=0)
        with self.assertRaises(ReferenceBoundaryError):
            setup.reserve_inference(now_ms=1, resources=resources())
        self.assertEqual(setup.snapshot()["inferences"], 0)
        idle = ReferenceBoundary(manifest()["limits"], started_ms=0)
        idle.finish_setup(now_ms=10, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            idle.reserve_inference(now_ms=11, resources=resources())
        self.assertEqual(idle.snapshot()["inferences"], 0)

    def test_step_acknowledgement_requires_a_validated_action(self):
        boundary = active_boundary()
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.record_step(ticket, now_ms=12, resources=resources())
        self.assertEqual(boundary.snapshot()["steps"], 0)

    def test_n_reservations_allowed_but_not_n_plus_one(self):
        boundary = active_boundary()
        for now in (11, 15):
            ticket = boundary.reserve_inference(now_ms=now, resources=resources())
            boundary.accept_action(ticket, action(), now_ms=now + 1, resources=resources())
            boundary.record_step(ticket, now_ms=now + 2, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.reserve_inference(now_ms=19, resources=resources())
        self.assertEqual(boundary.snapshot()["inferences"], 2)
        self.assertEqual(boundary.snapshot()["steps"], 2)

    def test_step_ceiling_is_independent_from_inference_ceiling(self):
        limits = manifest()["limits"]
        limits["max_steps"] = 1
        boundary = ReferenceBoundary(limits, started_ms=0)
        boundary.finish_setup(now_ms=10, resources=resources())
        boundary.start_behavior("dirt", now_ms=10, resources=resources())
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        boundary.accept_action(ticket, action(), now_ms=12, resources=resources())
        boundary.record_step(ticket, now_ms=13, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.reserve_inference(now_ms=14, resources=resources())
        self.assertEqual(boundary.snapshot()["inferences"], 1)

    def test_concurrent_reservation_cannot_create_an_extra_model_call(self):
        boundary = active_boundary()
        boundary.reserve_inference(now_ms=11, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.reserve_inference(now_ms=12, resources=resources())
        self.assertEqual(boundary.snapshot()["inferences"], 1)

    def test_inference_exact_deadline_and_later_output_are_fenced(self):
        boundary = active_boundary()
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.accept_action(ticket, action(), now_ms=31, resources=resources())
        self.assertEqual(boundary.snapshot()["steps"], 0)
        self.assertTrue(boundary.snapshot()["terminal"])
        with self.assertRaises(ReferenceBoundaryError):
            boundary.accept_action(ticket, action(), now_ms=32, resources=resources())

    def test_duplicate_or_foreign_action_output_is_never_reapplied(self):
        boundary = active_boundary()
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        boundary.accept_action(ticket, action(), now_ms=12, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.accept_action(ticket, action(), now_ms=13, resources=resources())
        other = active_boundary()
        foreign = other.reserve_inference(now_ms=11, resources=resources())
        fresh = active_boundary()
        fresh.reserve_inference(now_ms=11, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            fresh.accept_action(foreign, action(), now_ms=12, resources=resources())

    def test_stop_fences_inflight_output_and_preserves_first_terminal_reason(self):
        boundary = active_boundary()
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        boundary.stop("operator_stop")
        boundary.stop("later_success_message")
        with self.assertRaises(ReferenceBoundaryError):
            boundary.accept_action(ticket, action(), now_ms=12, resources=resources())
        self.assertEqual(boundary.snapshot()["reason"], "operator_stop")
        self.assertEqual(boundary.snapshot()["steps"], 0)
        self.assertEqual(boundary.snapshot()["inferences"], 1)
        self.assertEqual(boundary.snapshot()["cleanup"], "unconfirmed")

    def test_supervisor_can_expire_a_silent_inference_without_waiting_for_output(self):
        boundary = active_boundary()
        boundary.reserve_inference(now_ms=11, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.check(now_ms=31, resources=resources())
        self.assertTrue(boundary.snapshot()["terminal"])
        self.assertEqual(boundary.snapshot()["cleanup"], "unconfirmed")

    def test_setup_and_behavior_have_their_own_exact_wall_deadlines(self):
        boundary = ReferenceBoundary(manifest()["limits"], started_ms=0)
        with self.assertRaises(ReferenceBoundaryError):
            boundary.finish_setup(now_ms=100, resources=resources())
        self.assertEqual(boundary.snapshot()["inferences"], 0)
        boundary = active_boundary()
        boundary.check(now_ms=209, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.check(now_ms=210, resources=resources())

    def test_total_deadline_is_not_reset_by_switching_behaviors(self):
        limits = manifest()["limits"]
        limits["total_wall_ms"] = 250
        boundary = ReferenceBoundary(limits, started_ms=0)
        boundary.finish_setup(now_ms=10, resources=resources())
        boundary.start_behavior("dirt", now_ms=10, resources=resources())
        boundary.finish_behavior("dirt", now_ms=190, resources=resources())
        boundary.start_behavior("wood", now_ms=190, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.check(now_ms=250, resources=resources())
        self.assertEqual(boundary.snapshot()["behaviors"], 2)

    def test_idle_case_horizon_can_finalize_without_admitting_more_work(self):
        boundary = active_boundary()
        boundary.finish_behavior("dirt", now_ms=210, resources=resources())
        boundary.start_behavior("wood", now_ms=211, resources=resources())
        ticket = boundary.reserve_inference(now_ms=212, resources=resources())
        self.assertIsNotNone(ticket)
        self.assertEqual(boundary.snapshot()["behaviors"], 2)
        self.assertEqual(boundary.snapshot()["inferences"], 1)

    def test_behavior_count_and_attempt_history_do_not_reset_between_cases(self):
        boundary = active_boundary()
        boundary.finish_behavior("dirt", now_ms=20, resources=resources())
        boundary.start_behavior("wood", now_ms=21, resources=resources())
        boundary.finish_behavior("wood", now_ms=30, resources=resources())
        with self.assertRaises(ReferenceBoundaryError):
            boundary.start_behavior("dirt-retry", now_ms=31, resources=resources())
        self.assertEqual(boundary.snapshot()["behaviors"], 2)

    def test_each_resource_peak_is_enforced_even_when_no_action_arrives(self):
        for field, at_cap in (("rss_bytes", 1000), ("gpu_bytes", 2000),
                              ("processes", 3), ("recording_bytes", 3000),
                              ("download_bytes", 4000), ("disk_bytes", 5000)):
            with self.subTest(resource=field):
                boundary = active_boundary()
                boundary.check(now_ms=11, resources=resources(**{field: at_cap}))
                with self.assertRaises(ReferenceBoundaryError):
                    boundary.check(now_ms=12, resources=resources(**{field: at_cap + 1}))
                self.assertTrue(boundary.snapshot()["terminal"])
                self.assertEqual(boundary.snapshot()["inferences"], 0)

    def test_setup_resource_limit_precedes_model_loading(self):
        boundary = ReferenceBoundary(manifest()["limits"], started_ms=0)
        with self.assertRaises(ReferenceBoundaryError):
            boundary.check(now_ms=1, resources=resources(download_bytes=4001))
        self.assertEqual(boundary.snapshot()["inferences"], 0)
        self.assertTrue(boundary.snapshot()["terminal"])

    def test_unknown_resources_and_backwards_clock_do_not_authorize_work(self):
        for field in resources():
            boundary = active_boundary()
            with self.subTest(resource=field):
                with self.assertRaises(ReferenceBoundaryError):
                    boundary.reserve_inference(now_ms=11, resources=resources(**{field: None}))
                self.assertEqual(boundary.snapshot()["inferences"], 0)
        boundary = active_boundary()
        with self.assertRaises(ReferenceBoundaryError):
            boundary.reserve_inference(now_ms=9, resources=resources())
        self.assertEqual(boundary.snapshot()["inferences"], 0)

    def test_malformed_action_stops_the_boundary_without_a_noop_fallback(self):
        boundary = active_boundary()
        ticket = boundary.reserve_inference(now_ms=11, resources=resources())
        illegal = action()
        illegal["camera"] = [math.nan, 0]
        with self.assertRaises(ReferenceBoundaryError):
            boundary.accept_action(ticket, illegal, now_ms=12, resources=resources())
        self.assertEqual(boundary.snapshot()["steps"], 0)
        self.assertTrue(boundary.snapshot()["terminal"])


if __name__ == "__main__":
    unittest.main()
