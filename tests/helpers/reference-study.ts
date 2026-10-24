import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import controllerFixture from "../fixtures/steve-reference-manifest.json";
import { controllerManifestHash, validateControllerManifest } from "../../src/shared/controllers.ts";
import { studyManifest } from "./study-manifest.ts";

/** Real local file/hash/ledger fixture; its tiny .zip bytes are NOT game saves. */
export function referenceStudyFixture(project: string, studyId = "reference-admission-local") {
  const manifest = studyManifest(project, studyId);
  const identity = (path: string) => ({ path, sha256: createHash("sha256").update(readFileSync(join(project, path))).digest("hex") });
  const write = (path: string, value: string) => { writeFileSync(join(project, path), value); return identity(path); };
  mkdirSync(join(project, "private")); mkdirSync(join(project, "policies", "gameharness_policy"), { recursive: true });
  const sourceFiles = ["manifest.py", "reference_runner.py", "artifacts.py", "steve_policy.py", "minerl_environment.py", "renderer.py"];
  for (const filename of sourceFiles) {
    const path = `policies/gameharness_policy/${filename}`;
    writeFileSync(join(project, path), readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url))));
    manifest.identities.source.push(identity(path));
  }
  writeFileSync(join(project, "policies/pyproject.toml"), readFileSync(fileURLToPath(new URL("../../policies/pyproject.toml", import.meta.url))));
  manifest.identities.source.push(identity("policies/pyproject.toml"), manifest.identities.dependencies);
  const verifier = identity("policies/gameharness_policy/minerl_environment.py");
  const fixtures = ["dirt", "wood"].map(id => {
    const path = `private/${id}.zip`, content = `Synthetic ${id} identity bytes, never opened as a game save.\n`;
    const pinned = write(path, content);
    return { id, ...pinned, bytes: Buffer.byteLength(content) };
  });
  const dependencies = write("private/dependencies.json", '{"synthetic-runtime":"not-installed"}');
  const base = structuredClone(controllerFixture);
  const controller = {
    ...base,
    runtime: { ...base.runtime, python: "3.10.22", torch: "2.7.1", cuda: "12.8", dependency_lock_sha256: dependencies.sha256,
      configuration_changes: ["Declared modernized runtime; synthetic admission fixture only"] },
    behaviors: base.behaviors.map(behavior => ({ ...behavior, fixture_sha256: fixtures.find(value => value.id === behavior.id)!.sha256, verifier_sha256: verifier.sha256 })),
    limits: { setup_wall_ms: 7200000, behavior_wall_ms: 600000, total_wall_ms: 8700000, inference_wall_ms: 5000,
      max_inferences: 2500, max_steps: 2500, max_behaviors: 2, max_processes: 32, max_rss_bytes: 8589934592,
      max_gpu_bytes: 12884901888, max_recording_bytes: 4294967296, max_download_bytes: 12884901888, max_disk_bytes: 42949672960,
      shutdown_wall_ms: 30000, setup_inferences: 16, load_wall_ms: 180000, steps_per_behavior: 1200, cgroup_tasks: 256, cpu_quota: 8 },
    execution: { image: `sha256:${"8".repeat(64)}`, prepared_tree_sha256: "9".repeat(64), runner_tree_sha256: "0".repeat(64),
      artifact_paths: Object.fromEntries(base.artifacts.map(value => [value.id, `artifacts/${value.id}`])),
      fixture_paths: { dirt: "dirt.zip", wood: "wood.zip" },
      renderer: { mode: "owned-in-environment-container", display: ":0", weston_version: "13.0.0",
        command: ["/usr/bin/weston", "--backend=headless-backend.so", "--renderer=gl", "--xwayland"], identity_sha256: "a".repeat(64) },
      resource_partition: { policy_memory_bytes: 5368709120, environment_memory_bytes: 2684354560, supervision_memory_bytes: 536870912,
        policy_tasks: 128, environment_tasks: 96, supervision_tasks: 32, policy_cpus: 5, environment_cpus: 2, supervision_cpus: 1,
        java_heap_bytes: 1610612736, host_headroom_bytes: 1073741824 },
      gpu_uuid: "GPU-synthetic", gpu_cdi_device: "nvidia.com/gpu=GPU-synthetic", gpu_total_bytes: 17179869184,
      dependency_inventory_path: "artifacts/dependencies", configuration_path: "artifacts/configuration", tokenizer_directory: "tokenizer-cache" },
  };
  const dependencyArtifact = controller.artifacts.find(value => value.id === "dependencies")!;
  dependencyArtifact.sha256 = dependencies.sha256;
  dependencyArtifact.bytes = readFileSync(join(project, dependencies.path)).length;
  const { configuration_sha256: ignored, ...runtimeConfiguration } = controller.runtime;
  const configuration = write("private/configuration.json", JSON.stringify({ sources: controller.sources, runtime: runtimeConfiguration,
    device: controller.device, simulator: controller.simulator, preprocessing: controller.preprocessing, action_mapping: controller.action_mapping }));
  controller.runtime.configuration_sha256 = configuration.sha256;
  const configurationArtifact = controller.artifacts.find(value => value.id === "configuration")!;
  configurationArtifact.sha256 = configuration.sha256;
  configurationArtifact.bytes = readFileSync(join(project, configuration.path)).length;
  const checked = validateControllerManifest(controller);
  const controllerIdentity = write("private/controller.json", JSON.stringify(checked));
  const profile = write("profile.json", JSON.stringify({ schema_version: 1, controller_manifest_sha256: controllerManifestHash(checked),
    observation: { schema_version: 1, kind: "rgb", permitted_keys: ["pov"] }, preprocessing: checked.preprocessing,
    action_mapping: checked.action_mapping, clock: "synchronous" }));
  const build = write("fixture-build.txt", JSON.stringify({ schema_version: 1, image: checked.execution!.image, runner_tree_sha256: checked.execution!.runner_tree_sha256 }));
  const bundle = write("private/fixtures.json", JSON.stringify({ schema_version: 1, kind: "declared_reference_fixture_bundle",
    reset: "seed_before_each_effective_reset", seed: 17, fixtures }));
  manifest.admission_mode = "live";
  manifest.permission.scope = "live";
  Object.assign(manifest.identities, { build, dependencies, adapter: "minerl-original-reference", game: { id: "minecraft", version: "1.16.5" },
    observation_schema: 1, profile, controller: controllerIdentity, preprocessing: [configuration], model: null });
  manifest.execution = { ...manifest.execution, controller_mode: "released_policy_reference", adaptation: "frozen_released_policy",
    start_mode: "declared_reference_fixture", request_paths: [] };
  manifest.task.verifier = verifier;
  manifest.task.horizon_ms = 8700000;
  manifest.initial_states = [{ id: "declared-fixtures", mode: "declared_reference_fixture", seed: "17", settings: null, save: bundle }];
  manifest.arms = [{ id: "original-steve", description: "Synthetic registration only, no game/model", model: null, helpers: [], profile }];
  manifest.schedule = [{ slot: { study_id: studyId, arm: "original-steve", initial_state_id: "declared-fixtures", repetition: 1 }, order: 0, group: "reference", optional_block: null }];
  manifest.repetitions = 1;
  manifest.allowances = { per_attempt: { host_requests: 0, wall_ms: 8700000, concurrent_requests: 0, workers: 1 },
    cohort: { host_requests: 0, attempt_wall_ms: 8700000, elapsed_ms: 9000000, concurrent_requests: 0, workers: 1 } };
  return { manifest, controller: checked, fixtures, identity };
}
