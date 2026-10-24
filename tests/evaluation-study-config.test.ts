import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
