import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/steve-reference-manifest.json";
import {
  controllerManifestHash,
  validateControllerManifest,
} from "../src/shared/controllers.ts";
import {
  admitReference,
  classifyReferenceResult,
} from "../src/evaluation/policy-reference.ts";

// All hashes/resources in this fixture are synthetic. Nothing here admits a model/game.
function raw(): Record<string, unknown> {
  return structuredClone(fixture);
}

function replace(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = path.split(".");
  let parent: Record<string, unknown> = value;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = next;
}

function measuredEvidence() {
  return {
    manifest_hash: controllerManifestHash(validateControllerManifest(raw())),
    artifacts: fixture.artifacts.map(artifact => ({
      id: artifact.id,
      downloaded_sha256: artifact.sha256,
      downloaded_bytes: artifact.bytes,
      measurement: "local-read" as const,
    })),
    sources: structuredClone(fixture.sources),
    runtime: structuredClone(fixture.runtime),
    device: structuredClone(fixture.device),
    simulator: structuredClone(fixture.simulator),
    preprocessing: structuredClone(fixture.preprocessing),
    action_mapping: structuredClone(fixture.action_mapping),
    isolation: { ...fixture.isolation, confirmed: true },
    runtime_probe: { id: "synthetic-runtime-probe", passed: true, model_kernels_exercised: true },
  };
}

describe("original reference manifest identity", () => {
  test("returns a detached deeply immutable declaration, not caller-owned aliases", () => {
    const input = raw();
    const parsed = validateControllerManifest(input);
    replace(input, "goal.cond_scale", 0);
    replace(input, "limits.max_inferences", 999);
    expect(parsed.goal.cond_scale).toBe(6);
    expect(parsed.limits.max_inferences).toBe(2);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.behaviors[0])).toBe(true);
    expect(Object.isFrozen(parsed.action_mapping.buttons)).toBe(true);
    expect(Object.isFrozen(parsed.artifacts[0])).toBe(true);
    expect(Reflect.set(parsed.limits, "max_steps", 999)).toBe(false);
    expect(parsed.limits.max_steps).toBe(2);
  });

  test("hash ignores object key order but retains array order and nested configuration", () => {
    const input = raw();
    const original = controllerManifestHash(validateControllerManifest(input));
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    const reversedKeys = Object.fromEntries(Object.entries(input).reverse());
    expect(controllerManifestHash(validateControllerManifest(reversedKeys))).toBe(original);
    const reordered = raw();
    reordered.behaviors = [...fixture.behaviors].reverse();
    expect(controllerManifestHash(validateControllerManifest(reordered))).not.toBe(original);
    const changed = raw();
    replace(changed, "limits.max_steps", 3);
    expect(controllerManifestHash(validateControllerManifest(changed))).not.toBe(original);
  });

  test.each([
    "sources", "artifacts", "components", "runtime", "simulator", "preprocessing",
    "action_mapping", "goal", "recurrent", "device", "isolation", "behaviors", "limits",
  ])("refuses missing %s instead of manufacturing defaults", field => {
    const input = raw();
    delete input[field];
    expect(() => validateControllerManifest(input)).toThrow();
  });

  test.each([
    ["candidate", "minestudio-steve-conversion"],
    ["sources.steve1", "main"],
    ["sources.steve1", "0000000000000000000000000000000000000000"],
    ["sources.minerl", "v1.0.1"],
    ["simulator.game_version", "1.21.4"],
    ["simulator.clock", "live"],
    ["simulator.frameskip", 4],
    ["preprocessing.color", "BGR"],
    ["preprocessing.resize", "nearest"],
    ["preprocessing.normalization", "external-divide-255"],
    ["action_mapping.camera_order", ["yaw", "pitch"]],
    ["recurrent.cfg_batch", 1],
    ["goal.sample_once_per_goal", false],
    ["isolation.network", "host"],
    ["isolation.host_auth", true],
    ["isolation.evaluator_hints", true],
    ["isolation.worker_count", 2],
    ["goal.secret_seed", "private verifier seed"],
  ] as const)("refuses incompatible or undeclared %s", (path, value) => {
    const input = raw();
    replace(input, path, value);
    expect(() => validateControllerManifest(input)).toThrow();
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "2", null])(
    "refuses a nonfinite/nonintegral inference cap: %s", value => {
      const input = raw();
      replace(input, "limits.max_inferences", value);
      expect(() => validateControllerManifest(input)).toThrow();
    },
  );

  test.each(["setup_wall_ms", "behavior_wall_ms", "total_wall_ms", "inference_wall_ms", "shutdown_wall_ms", "max_steps", "max_behaviors", "max_processes", "max_rss_bytes", "max_gpu_bytes", "max_recording_bytes", "max_download_bytes", "max_disk_bytes"])(
    "requires an explicit positive finite %s", field => {
      const input = raw();
      replace(input, `limits.${field}`, 0);
      expect(() => validateControllerManifest(input)).toThrow();
    },
  );

  test("requires two or three distinct supported behaviors and their verifiers", () => {
    for (const behaviors of [[], [fixture.behaviors[0]], [fixture.behaviors[0], fixture.behaviors[0]]]) {
      const input = raw();
      input.behaviors = behaviors;
      expect(() => validateControllerManifest(input)).toThrow();
    }
    const input = raw();
    replace(input, "behaviors.0.verifier_sha256", "");
    expect(() => validateControllerManifest(input)).toThrow();
  });

  test("rejects a missing tokenizer and artifact terms without rejecting the research-use basis", () => {
    expect(validateControllerManifest(raw()).candidate).toBe("steve-1-original");
    const missingTokenizer = raw();
    missingTokenizer.artifacts = fixture.artifacts.filter(value => value.id !== "tokenizer");
    expect(() => validateControllerManifest(missingTokenizer)).toThrow();
    const missingBasis = raw();
    replace(missingBasis, "components.0.use_basis", "");
    expect(() => validateControllerManifest(missingBasis)).toThrow();
  });

  test("rejects duplicate artifact identities and dangling component ownership", () => {
    const duplicate = raw();
    duplicate.artifacts = [...fixture.artifacts, fixture.artifacts[2]];
    expect(() => validateControllerManifest(duplicate)).toThrow();
    const dangling = raw();
    replace(dangling, "artifacts.2.component", "unrecorded-weight-owner");
    expect(() => validateControllerManifest(dangling)).toThrow();
  });

  test("a public policy RNG seed cannot also disclose the private fixture reset seed", () => {
    const input = raw();
    replace(input, "simulator.reset_seed", fixture.goal.seed);
    expect(() => validateControllerManifest(input)).toThrow(/seed/i);
  });
});

describe("trusted reference admission, not publisher metadata", () => {
  test("accepts the exact measured synthetic configuration without substitutions", () => {
    const admitted = admitReference(validateControllerManifest(raw()), measuredEvidence());
    expect(admitted.manifest_hash).toBe(measuredEvidence().manifest_hash);
    expect(admitted.candidate).toBe("steve-1-original");
    expect(admitted.clock).toBe("synchronous");
  });

  test("refuses unmeasured publisher hashes even when they equal the declared SHA-256", () => {
    const evidence = measuredEvidence();
    const unmeasured = { ...evidence, artifacts: evidence.artifacts.map(a => ({
      id: a.id, publisher_sha256: a.downloaded_sha256, publisher_bytes: a.downloaded_bytes,
      measurement: "publisher-metadata",
    })) };
    expect(() => admitReference(validateControllerManifest(raw()), unmeasured)).toThrow();
  });

  test.each(["policy", "architecture", "prior", "mineclip", "tokenizer", "engine", "source", "configuration", "dependencies"])(
    "refuses missing or corrupted %s before loading", id => {
      const missing = measuredEvidence();
      missing.artifacts = missing.artifacts.filter(a => a.id !== id);
      expect(() => admitReference(validateControllerManifest(raw()), missing)).toThrow();
      const corrupt = measuredEvidence();
      const artifact = corrupt.artifacts.find(a => a.id === id)!;
      artifact.downloaded_sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
      expect(() => admitReference(validateControllerManifest(raw()), corrupt)).toThrow();
      const truncated = measuredEvidence();
      truncated.artifacts.find(a => a.id === id)!.downloaded_bytes -= 1;
      expect(() => admitReference(validateControllerManifest(raw()), truncated)).toThrow();
    },
  );

  test.each([
    ["manifest_hash", "0".repeat(64)],
    ["sources.steve1", "0".repeat(40)],
    ["runtime.torch", "2.7.0+cu128"],
    ["runtime.dependency_lock_sha256", "0".repeat(64)],
    ["runtime.configuration_sha256", "0".repeat(64)],
    ["device.precision", "int8"],
    ["device.policy", "cpu"],
    ["simulator.engine_artifact", "downloaded-unpinned-engine"],
    ["preprocessing.gamma", 1],
    ["action_mapping.camera_mu", 5],
    ["isolation.confirmed", false],
    ["runtime_probe.passed", false],
    ["runtime_probe.model_kernels_exercised", false],
  ] as const)("refuses measured/configuration mismatch at %s", (path, value) => {
    const evidence = measuredEvidence();
    replace(evidence, path, value);
    expect(() => admitReference(validateControllerManifest(raw()), evidence)).toThrow();
  });

  test("a changed allocation cannot reuse an earlier manifest's admission", () => {
    const input = raw();
    replace(input, "limits.total_wall_ms", 600);
    expect(() => admitReference(validateControllerManifest(input), measuredEvidence())).toThrow();
  });
});

function outcome() {
  return {
    manifest_hash: "a".repeat(64),
    terminal: "completed",
    setup: "passed",
    scheduled_behavior_ids: ["dirt", "wood"],
    behaviors: [
      { id: "dirt", attempted: true, verifier: true },
      { id: "wood", attempted: true, verifier: true },
    ],
    cleanup: "confirmed",
    failures: [] as string[],
    actual: { inferences: 2, steps: 2, wall_ms: 50, peak_rss_bytes: 900, peak_gpu_bytes: 1900 },
  };
}

describe("reference result evidence separation", () => {
  test("synchronous verifier success does not claim live-clock or port success", () => {
    const result = classifyReferenceResult(outcome());
    expect(result.setup_status).toBe("passed");
    expect(result.reference_status).toBe("passed");
    expect(result.live_clock_status).toBe("not_run");
    expect(result.port_status).toBe("not_run");
    expect(result.actual.inferences).toBe(2);
    expect(result).not.toHaveProperty("provider_tokens");
  });

  test("setup failure is blocked reference evidence, not learned incompetence", () => {
    const result = classifyReferenceResult({ ...outcome(), terminal: "setup_error", setup: "failed", behaviors: [], failures: ["checkpoint keys mismatch"] });
    expect(result.setup_status).toBe("failed");
    expect(result.reference_status).toBe("blocked");
    expect(result.failures).toContain("checkpoint keys mismatch");
  });

  test("a completed negative verifier is a behavior failure", () => {
    const input = outcome();
    input.behaviors[1]!.verifier = false;
    expect(classifyReferenceResult(input).reference_status).toBe("failed");
  });

  test("unknown verifier cannot become success from completed steps or a video", () => {
    const input = { ...outcome(), behaviors: [{ id: "dirt", attempted: true, verifier: null }, { id: "wood", attempted: true, verifier: true }] };
    expect(classifyReferenceResult(input).reference_status).toBe("inconclusive");
  });

  test.each(["limit", "interrupted", "policy_error", "boundary_error"])(
    "retains %s instead of converting an earlier positive verifier into overall pass", terminal => {
      const input = { ...outcome(), terminal, failures: [terminal] };
      const result = classifyReferenceResult(input);
      expect(result.reference_status).toBe("inconclusive");
      expect(result.behaviors).toEqual(input.behaviors);
      expect(result.failures).toContain(terminal);
      expect(result.actual.steps).toBe(2);
    },
  );

  test("unknown drain cannot certify completion and does not erase measured usage", () => {
    const result = classifyReferenceResult({ ...outcome(), cleanup: "unconfirmed" });
    expect(result.reference_status).toBe("inconclusive");
    expect(result.cleanup).toBe("unconfirmed");
    expect(result.actual.peak_gpu_bytes).toBe(1900);
  });

  test("no attempted behaviors is not vacuous reference success", () => {
    expect(classifyReferenceResult({ ...outcome(), behaviors: [] }).reference_status).toBe("inconclusive");
  });

  test("a late resource failure prevents success even after positive verifiers", () => {
    const input = { ...outcome(), failures: ["GPU measurement became unavailable before shutdown"] };
    expect(classifyReferenceResult(input).reference_status).toBe("inconclusive");
  });

  test("an omitted or unattempted scheduled behavior cannot disappear from the outcome", () => {
    const omitted = outcome();
    omitted.behaviors.pop();
    expect(classifyReferenceResult(omitted).reference_status).toBe("inconclusive");
    const skipped = outcome();
    skipped.behaviors[1]!.attempted = false;
    expect(classifyReferenceResult(skipped).reference_status).toBe("inconclusive");
  });
});
