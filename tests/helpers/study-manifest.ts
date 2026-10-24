import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { StudyManifest, StudySlot } from "../../src/evaluation/studies.ts";
import type { EvaluationOutcome } from "../../src/evaluation/results.ts";
import { minecraftProfileConfiguration } from "../../src/shared/minecraft.ts";
import { minecraftTestAdapter, sha256 } from "./adapter-contract.ts";
import { jsonSchema } from "../../src/shared/primitives.ts";

/** Actual registered contract shape; explicitly synthetic build identity, never a native-game proof. */
export function currentStudyProfile() {
  return minecraftTestAdapter().descriptor;
}

export function invalidStudyProfiles() {
  const current = currentStudyProfile();
  const configuration = minecraftProfileConfiguration("balanced");
  const changed = (value: unknown) => ({ ...current, observation: { ...current.observation, profile: { ...current.observation.profile,
    configuration: jsonSchema.parse(value), configuration_hash: sha256(value) } } });
  return [
    { name: "profile-labels-only", profile: { schema_version: 2, profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2" } },
    { name: "profile-radius", profile: changed({ ...configuration, sampler: { ...configuration.sampler, radius_blocks: 32 } }) },
    { name: "profile-assistance", profile: changed({ ...configuration, assistance: { semantic_helpers: false } }) },
    { name: "profile-missing-sampler", profile: changed({ actor_image: configuration.actor_image,
      motor_profile: configuration.motor_profile, assistance: configuration.assistance }) },
    { name: "profile-extra-setting", profile: changed({ ...configuration, undeclared_override: true }) },
  ];
}

export function writeStudyProfile(project: string, manifest: StudyManifest, profile: unknown): void {
  const path = manifest.identities.profile.path;
  const bytes = JSON.stringify(profile);
  writeFileSync(join(project, path), bytes);
  const identity = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  manifest.identities.profile = identity;
  for (const arm of manifest.arms) arm.profile = identity;
}

/** Local declaration fixture only: these bytes are never a game build or provider result. */
export function studyManifest(project: string, studyId = "local-admission-contract"): StudyManifest {
  mkdirSync(join(project, "src"), { recursive: true });
  const files = {
    "src/platform.ts": "export const protocol = 1;\n",
    "fixture-build.txt": "Local admission fixture; not an executable game artifact.\n",
    "bun.lock": "Local fixture dependency identity only.\n",
    "profile.json": `${JSON.stringify(currentStudyProfile())}\n`,
    "task.txt": "Exercise durable admission only; do not run an actor or game.\n",
    "verifier.txt": "Admission-only: goal must remain null.\n",
    "permission.txt": "Local zero-inference test permission; no provider, credentials or game.\n",
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(project, path), content);
  const identity = (path: string) => ({ path, sha256: createHash("sha256").update(readFileSync(join(project, path))).digest("hex") });
  const slots: StudySlot[] = [1, 2, 3, 4].map(repetition => ({ study_id: studyId, arm: "admission", initial_state_id: "no-game", repetition }));
  return {
    schema_version: 1, study_id: studyId, purpose: "Local transactional admission contract; not gameplay evidence",
    admission_mode: "admission_only", platform_evidence_revision: "local-fixture-r1",
    permission: { record: identity("permission.txt"), scope: "admission_only", granted_by: "local-test-fixture" },
    identities: {
      source: [identity("src/platform.ts")], build: identity("fixture-build.txt"), dependencies: identity("bun.lock"),
      adapter: null, game: null, observation_schema: 3, profile: identity("profile.json"),
      helpers: [], controller: null, preprocessing: [], model: null, library: { mode: "cold", snapshot: null },
    },
    task: { text: "Exercise durable admission only; do not run an actor or game.", identity: identity("task.txt"), verifier: identity("verifier.txt"),
      progress_predicates: [], safety_predicates: ["no_external_calls"], success: "durable admission and settlement only",
      failure: "admission contract violated", unknown: "interrupted or unresolved ownership", horizon_ms: 1000 },
    execution: { start_mode: "none", adaptation: "whole_agent_run_private", controller_mode: "whole_agent", sidecars: [], request_paths: [],
      isolation: { store: "slot_private", working_programs: "fresh", experience: "slot_private", publication: "after_cohort_closure" } },
    initial_states: [{ id: "no-game", mode: "none", seed: null, settings: null, save: null }],
    arms: [{ id: "admission", description: "No actor or game is run", model: null, helpers: [], profile: identity("profile.json") }],
    schedule: slots.map((slot, order) => ({ slot, order, group: "final", optional_block: null })),
    repetitions: 4, ordering: "declared", optional_blocks: [],
    allowances: { per_attempt: { host_requests: 2, wall_ms: 1000, concurrent_requests: 1, workers: 1 },
      cohort: { host_requests: 8, attempt_wall_ms: 4000, elapsed_ms: 60_000, concurrent_requests: 1, workers: 1 } },
    references: { public: [], evaluator_data: "withheld", actor_feedback: [] },
    interventions: { operator_setup: "none", resets: "none", takeover: "forbidden", perturbations: [] },
    analysis: { rule: "Retain every scheduled disposition; no gameplay or causal claim", feedback_release: "after_cohort_closure" },
    stop_rules: ["safety", "authority", "evaluation_leakage", "invalid_platform", "allowance_exhausted", "operator_interrupt"],
    retention: { private_evidence: "slot-private", reports: "private", events: "retain_all", media: "not_applicable",
      projection_version: "local-admission-v1", gaps: "explicit", inaccessible_initialization: "withheld" },
  };
}

export const failedStudyOutcome: EvaluationOutcome = {
  platform_status: "pass", agent_status: "goal_not_verified", provider_status: "ok", goal_verified: false,
  classification_reason: ["Synthetic local outcome for storage semantics only; no provider/game execution"],
};

export const admissionOnlyOutcome: EvaluationOutcome = {
  platform_status: "pass", agent_status: "not_run", provider_status: "not_called", goal_verified: null,
  classification_reason: ["Admission-only reservation and settlement; no provider/game execution"],
};

/** Frozen catalog selection, not an assertion that an account or live model was discovered. */
export function liveStudyManifest(project: string, studyId = "local-live-contract"): StudyManifest {
  const manifest = studyManifest(project, studyId);
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses" && model.input.includes("image"));
  if (!descriptor) throw new Error("Installed catalog lacks an image-capable Codex descriptor");
  const model = { provider: descriptor.provider, id: descriptor.id, api: descriptor.api, access: "oauth_subscription" };
  const profile = manifest.identities.profile;
  const nativeSource = "native/minecraft/src/main/Fixture.java";
  const nativeBuild = "native/minecraft/build/libs/gameharness-native-1.0.0.jar";
  const verifierSource = "src/server/minecraft-adapter.ts";
  mkdirSync(join(project, "native/minecraft/src/main"), { recursive: true });
  mkdirSync(join(project, "native/minecraft/build/libs"), { recursive: true });
  mkdirSync(join(project, "src/server"), { recursive: true });
  writeFileSync(join(project, nativeSource), "final class Fixture {} // never launched\n");
  writeFileSync(join(project, nativeBuild), "Synthetic local seam bytes; never launched as a game artifact.\n");
  writeFileSync(join(project, verifierSource), readFileSync(fileURLToPath(new URL("../../src/server/minecraft-adapter.ts", import.meta.url))));
  utimesSync(join(project, nativeSource), 100, 100);
  // All actual fixture build inputs, including the copied verifier and lock,
  // precede the synthetic artifact. Keep the real freshness gate enabled.
  const newestInput = Math.max(...[nativeSource, verifierSource, "bun.lock"].map(path => statSync(join(project, path)).mtimeMs));
  const artifactTime = new Date(Math.ceil(newestInput) + 1000);
  utimesSync(join(project, nativeBuild), artifactTime, artifactTime);
  const identity = (path: string) => ({ path, sha256: createHash("sha256").update(readFileSync(join(project, path))).digest("hex") });
  writeFileSync(join(project, "task.txt"), "Collect wood.");
  const taskIdentity = { path: "task.txt", sha256: createHash("sha256").update("Collect wood.").digest("hex") };
  return {
    ...manifest, admission_mode: "live", permission: { ...manifest.permission, scope: "live" },
    identities: { ...manifest.identities, source: [...manifest.identities.source, identity(nativeSource), identity(verifierSource)], build: identity(nativeBuild),
      adapter: "fabric-owned-client", game: { id: "minecraft", version: "1.21.4" }, model, profile },
    task: { ...manifest.task, text: "Collect wood.", identity: taskIdentity, verifier: identity(verifierSource),
      success: "Declared independent goal verifier", safety_predicates: ["authority_intact"] },
    execution: { ...manifest.execution, start_mode: "fresh_seeded_world", request_paths: ["strategic"] },
    initial_states: [{ id: "fresh-seed-17", mode: "fresh_seeded_world", seed: "17",
      settings: { difficulty: "normal", gamemode: "survival", cheats: false, level_type: "minecraft:normal",
        structures: true, hardcore: false, supplied_inventory: false, console_commands: false, fresh_world_per_slot: true }, save: null }],
    arms: [{ ...manifest.arms[0]!, id: "whole-agent", model, profile }],
    schedule: manifest.schedule.map(entry => ({ ...entry, slot: { ...entry.slot, arm: "whole-agent", initial_state_id: "fresh-seed-17" } })),
  };
}
