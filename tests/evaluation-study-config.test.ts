import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStudyManifest, type StudyManifest } from "../src/evaluation/studies.ts";
import { invalidStudyProfiles, liveStudyManifest, studyManifest, writeStudyProfile } from "./helpers/study-manifest.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gameharness-study-config-")); roots.push(root);
  return { root, manifest: liveStudyManifest(root) };
}

function residentPlatformFixture() {
  const { root, manifest } = fixture();
  const checkedText = (path: string, bytes: string) => {
    writeFileSync(join(root, path), bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  manifest.purpose = "Zero-provider native-platform declaration fixture; not agent competence or native execution evidence";
  manifest.permission.record = checkedText("permission.txt", "Local fixture permission for evaluator-prepared native-platform study; no providers.");
  manifest.task.text = "Measure resident continuity in one evaluator-prepared technical arena.";
  manifest.task.identity = checkedText("task.txt", manifest.task.text);
  manifest.task.success = "Technical native continuity only; never an agent completion";
  manifest.identities.model = null;
  manifest.identities.controller = manifest.identities.source[0]!;
  manifest.execution.controller_mode = "resident_platform";
  manifest.execution.adaptation = "none";
  manifest.execution.start_mode = "evaluator_prepared_world";
  manifest.execution.request_paths = [];
  for (const arm of manifest.arms) arm.model = null;
  for (const state of manifest.initial_states) {
    state.mode = "evaluator_prepared_world"; state.seed = null;
    state.settings = { difficulty: "normal", gamemode: "survival", cheats: true, level_type: "minecraft:flat",
      structures: false, hardcore: false, supplied_inventory: true, console_commands: true, fresh_world_per_slot: false };
  }
  manifest.allowances.per_attempt.host_requests = 0;
  manifest.allowances.per_attempt.concurrent_requests = 0;
  manifest.allowances.cohort.host_requests = 0;
  manifest.allowances.cohort.concurrent_requests = 0;
  manifest.interventions.operator_setup = "Evaluator-owned technical arena with supplied inventory";
  manifest.interventions.resets = "Reset the same owned arena between cells; not fresh seeded trials";
  return { root, manifest };
}

test("resident platform admits checked materialized zero-provider declarations without relabelling the prepared arena as principal survival", () => {
  const { root, manifest } = residentPlatformFixture();
  const checked = validateStudyManifest(manifest, { projectRoot: root });
  expect(checked.admission_mode).toBe("live");
  expect(checked.execution).toMatchObject({ controller_mode: "resident_platform", adaptation: "none",
    start_mode: "evaluator_prepared_world", sidecars: [], request_paths: [] });
  expect(checked.identities.model).toBeNull();
  expect(checked.arms.every(arm => arm.model === null)).toBe(true);
  expect(checked.initial_states[0]).toMatchObject({ mode: "evaluator_prepared_world", seed: null, save: null,
    settings: { cheats: true, supplied_inventory: true, console_commands: true, fresh_world_per_slot: false } });
  expect(checked.allowances.per_attempt).toEqual({ host_requests: 0, concurrent_requests: 0, workers: 1, wall_ms: 1000 });
  expect(Object.isFrozen(checked.initial_states[0]!.settings)).toBe(true);
  expect(Object.isFrozen(checked.schedule[0]!.slot)).toBe(true);
});

const invalidResidentPlatform: { name: string; change: (manifest: StudyManifest) => void }[] = [
  { name: "provider identity", change: manifest => { manifest.identities.model = { provider: "openai-codex", id: "exact", api: "openai-codex-responses", access: "oauth_subscription" }; } },
  { name: "arm provider identity", change: manifest => { manifest.arms[0]!.model = { provider: "openai-codex", id: "exact", api: "openai-codex-responses", access: "oauth_subscription" }; } },
  { name: "sidecar", change: manifest => { manifest.execution.sidecars = ["jev"]; } },
  { name: "strategic request", change: manifest => { manifest.execution.request_paths = ["strategic"]; } },
  { name: "multiple cloud request paths", change: manifest => { manifest.execution.request_paths = ["strategic", "jev"]; } },
  { name: "per-attempt request allowance", change: manifest => { manifest.allowances.per_attempt.host_requests = 1; manifest.allowances.cohort.host_requests = 4; } },
  { name: "cohort request allowance", change: manifest => { manifest.allowances.cohort.host_requests = 1; } },
  { name: "per-attempt request concurrency", change: manifest => { manifest.allowances.per_attempt.concurrent_requests = 1; } },
  { name: "cohort request concurrency", change: manifest => { manifest.allowances.cohort.concurrent_requests = 1; } },
  { name: "missing controller", change: manifest => { manifest.identities.controller = null; } },
  { name: "adaptation", change: manifest => { manifest.execution.adaptation = "whole_agent_run_private"; } },
  { name: "admission-only native resources", change: manifest => { manifest.admission_mode = "admission_only"; manifest.permission.scope = "admission_only"; } },
  { name: "principal fresh-world start", change: manifest => { manifest.execution.start_mode = "fresh_seeded_world"; } },
  { name: "principal state mode", change: manifest => { manifest.initial_states[0]!.mode = "fresh_seeded_world"; } },
  { name: "seed trial claim", change: manifest => { manifest.initial_states[0]!.seed = "17"; } },
  { name: "restored-save claim", change: manifest => { manifest.initial_states[0]!.save = manifest.identities.source[0]!; } },
  { name: "missing settings", change: manifest => { manifest.initial_states[0]!.settings = null; } },
  { name: "cheats mislabelling", change: manifest => { manifest.initial_states[0]!.settings!.cheats = false; } },
  { name: "inventory mislabelling", change: manifest => { manifest.initial_states[0]!.settings!.supplied_inventory = false; } },
  { name: "console mislabelling", change: manifest => { manifest.initial_states[0]!.settings!.console_commands = false; } },
  { name: "creative mode", change: manifest => { manifest.initial_states[0]!.settings!.gamemode = "creative"; } },
  { name: "peaceful difficulty", change: manifest => { manifest.initial_states[0]!.settings!.difficulty = "peaceful"; } },
  { name: "hardcore", change: manifest => { manifest.initial_states[0]!.settings!.hardcore = true; } },
  { name: "historical observation schema", change: manifest => { manifest.identities.observation_schema = 2; } },
  { name: "wrong adapter", change: manifest => { manifest.identities.adapter = "other"; } },
  { name: "wrong game version", change: manifest => { manifest.identities.game!.version = "1.21.5"; } },
  { name: "nonprivate store", change: manifest => { manifest.execution.isolation.store = "shared"; } },
  { name: "inherited library", change: manifest => { manifest.identities.library.mode = "inherited"; } },
  { name: "early feedback", change: manifest => { manifest.analysis.feedback_release = "immediate"; } },
  { name: "early publication", change: manifest => { manifest.execution.isolation.publication = "immediate"; } },
  { name: "multiple attempt owners", change: manifest => { manifest.allowances.per_attempt.workers = 2; manifest.allowances.cohort.workers = 2; } },
];
for (const { name, change } of invalidResidentPlatform) {
  test(`resident platform rejects ${name} instead of broadening zero-provider authority`, () => {
    const { root, manifest } = residentPlatformFixture(); change(manifest);
    expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow();
  });
}

test("resident platform checks controller bytes and current complete profile, not merely declared labels", () => {
  const { root, manifest } = residentPlatformFixture();
  writeFileSync(join(root, manifest.identities.controller!.path), "changed controller bytes");
  expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow(/identity|hash/i);
  for (const { profile } of invalidStudyProfiles()) {
    const owned = residentPlatformFixture();
    writeStudyProfile(owned.root, owned.manifest, profile);
    expect(() => validateStudyManifest(owned.manifest, { projectRoot: owned.root })).toThrow();
  }
});

test("resident zero-provider omissions do not exempt whole-agent or released-reference declarations", () => {
  for (const controller_mode of ["whole_agent", "released_policy_reference", "resident_platform_typo"]) {
    const { root, manifest } = residentPlatformFixture();
    manifest.execution.controller_mode = controller_mode;
    expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow();
  }
});

test("fresh seed/settings remain exact fresh-world identities, never a restored-save claim", () => {
  const { root, manifest } = fixture();
  const checked = validateStudyManifest(manifest, { projectRoot: root });
  expect(checked.initial_states[0]).toEqual({ id: "fresh-seed-17", mode: "fresh_seeded_world", seed: "17",
    settings: { difficulty: "normal", gamemode: "survival", cheats: false, level_type: "minecraft:normal",
      structures: true, hardcore: false, supplied_inventory: false, console_commands: false, fresh_world_per_slot: true }, save: null });
  expect(checked.execution.start_mode).toBe("fresh_seeded_world");
  expect(Object.isFrozen(checked)).toBe(true);
  expect(Object.isFrozen(checked.execution.isolation)).toBe(true);
  expect(Object.isFrozen(checked.schedule[0]!.slot)).toBe(true);
});

const unsupported: { name: string; change: (manifest: StudyManifest) => void }[] = [
  { name: "restored save", change: manifest => { manifest.execution.start_mode = "restored_save"; manifest.initial_states[0]!.mode = "restored_save"; } },
  { name: "prepared save", change: manifest => { manifest.execution.start_mode = "prepared_save"; } },
  { name: "inherited library", change: manifest => { manifest.identities.library.mode = "inherited"; manifest.identities.library.snapshot = "undeployed-snapshot"; } },
  { name: "frozen controller", change: manifest => { manifest.execution.controller_mode = "frozen_controller"; manifest.execution.adaptation = "forbidden"; manifest.identities.controller = manifest.identities.source[0]!; } },
  { name: "policy controller", change: manifest => { manifest.execution.controller_mode = "policy_reference"; } },
  { name: "Jev sidecar", change: manifest => { manifest.execution.sidecars = ["jev"]; manifest.execution.request_paths = ["strategic", "jev"]; } },
  { name: "prepared development task", change: manifest => { manifest.execution.start_mode = "prepared_development_task"; } },
];
for (const { name, change } of unsupported) {
  test(`${name} is explicitly refused, not silently represented as supported execution`, () => {
    const { root, manifest } = fixture(); change(manifest);
    expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow(/unsupported|not implemented|not supported/i);
  });
}

test("declared whole-agent run-private repair is admissible but global retrieval or early publication is not", () => {
  const { root, manifest } = fixture();
  expect(validateStudyManifest(manifest, { projectRoot: root }).execution.adaptation).toBe("whole_agent_run_private");
  for (const change of [
    (value: StudyManifest) => { value.execution.isolation.experience = "global_latest_compatible"; },
    (value: StudyManifest) => { value.execution.isolation.publication = "immediate"; },
    (value: StudyManifest) => { value.execution.isolation.store = "shared"; },
    (value: StudyManifest) => { value.execution.isolation.working_programs = "inherited"; },
  ]) {
    const altered = structuredClone(manifest); change(altered);
    expect(() => validateStudyManifest(altered, { projectRoot: root })).toThrow(/isolation|private|unsupported|publication|fresh/i);
  }
});

test("strict declarations reject unknown keys, duplicate slots and incomplete arm/state references", () => {
  const { root, manifest } = fixture();
  expect(() => validateStudyManifest({ ...manifest, undeclared_override: true }, { projectRoot: root })).toThrow(/unknown|unexpected|strict/i);
  const duplicate = structuredClone(manifest); duplicate.schedule[1]!.slot = { ...duplicate.schedule[0]!.slot };
  expect(() => validateStudyManifest(duplicate, { projectRoot: root })).toThrow(/duplicate|unique/i);
  const unknownArm = structuredClone(manifest); unknownArm.schedule[0]!.slot.arm = "not-declared";
  expect(() => validateStudyManifest(unknownArm, { projectRoot: root })).toThrow(/arm|declared/i);
  const unknownStart = structuredClone(manifest); unknownStart.schedule[0]!.slot.initial_state_id = "not-declared";
  expect(() => validateStudyManifest(unknownStart, { projectRoot: root })).toThrow(/state|declared/i);
});

test("live selection requires an exact model/access declaration and cannot invent an account identity", () => {
  const { root, manifest } = fixture();
  expect(() => validateStudyManifest({ ...manifest, identities: { ...manifest.identities, model: null } }, { projectRoot: root })).toThrow(/model|identity/i);
  const fallback = structuredClone(manifest); fallback.identities.model!.id = "latest";
  expect(() => validateStudyManifest(fallback, { projectRoot: root })).toThrow(/exact|model|catalog|fallback/i);
  const missingAccess = structuredClone(manifest); missingAccess.identities.model!.access = "";
  expect(() => validateStudyManifest(missingAccess, { projectRoot: root })).toThrow(/access|auth|selection/i);
});

test("admission-only declarations cannot enable requests, sidecars or native initial states", () => {
  const root = mkdtempSync(join(tmpdir(), "gameharness-study-admission-config-")); roots.push(root);
  const manifest = studyManifest(root);
  for (const change of [
    (value: StudyManifest) => { value.execution.request_paths = ["strategic"]; },
    (value: StudyManifest) => { value.execution.start_mode = "fresh_seeded_world"; },
    (value: StudyManifest) => { value.execution.sidecars = ["jev"]; },
  ]) {
    const altered = structuredClone(manifest); change(altered);
    expect(() => validateStudyManifest(altered, { projectRoot: root })).toThrow(/admission.only|unsupported|external|inference|native/i);
  }
});

for (const { name, profile } of invalidStudyProfiles()) {
  test(`${name}: valid profile labels and updated file hash cannot replace the exact complete current configuration`, () => {
    const { root, manifest } = fixture();
    writeStudyProfile(root, manifest, profile);
    expect(() => validateStudyManifest(manifest, { projectRoot: root })).toThrow();
  });
}
