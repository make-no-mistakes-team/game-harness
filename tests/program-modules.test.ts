import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDependency, SkillSpec, SkillView } from "../src/shared/programs.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { executableModuleBundleHash } from "../src/shared/program-modules.ts";
import { buildExecutableModuleBundle, programExecutionHash, resolveProgramModuleClosure } from "../src/server/program-modules.ts";
import { programFingerprint, validateSkill, validateProgramSource } from "../src/server/program-validation.ts";
import { Store } from "../src/server/store.ts";
import { executionScopeFixture, minecraftRunFixture, minecraftTestAdapter } from "./helpers/adapter-contract.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const card = { purpose: "Pure module boundary fixture", applicability: "Offline tests only", method: "Resolve immutable definitions",
  reason: "Exercise isolated code reuse", limitations: "No gameplay or effect claim" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "program-modules-")), store = new Store(directory), adapter = minecraftTestAdapter();
  const run = minecraftRunFixture(adapter); store.saveRun(run);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const save = async (name: string, entry: SkillSpec["entry"], source: string, dependencies: SkillDependency[] = []) =>
    store.registerSkill(run.run_id, await validateSkill({ name, entry, source, dependencies, card }, adapter));
  return { store, run, adapter, save };
}
function imported(value: SkillView, import_path = "./helper.js"): SkillDependency {
  return { skill_id: value.skill_id, version: value.version, import_path };
}

test("retiring pure source blocks new admission without erasing its historical execution identity", async () => {
  const f = fixture();
  const library = await f.save("historical helper", "library", "export function step(frame,state,intent) { return null; }");
  const root = await f.save("historical consumer", "step", 'export {step} from "./helper.js";', [imported(library)]);
  const hash = buildExecutableModuleBundle(f.store, f.run.run_id, root).source_hash;
  const historical = {
    getRun: (runId: string) => f.store.getRun(runId),
    skill: (runId: string, ref: { skill_id: string; version: number }) => ({ ...f.store.skill(runId, ref), state: "quarantined" as const }),
  };
  expect(() => buildExecutableModuleBundle(historical, f.run.run_id, historical.skill(f.run.run_id, root))).toThrow();
  expect(programExecutionHash(historical, f.run.run_id, root)).toBe(hash);
});

test("module realms pin exact library bytes and keep source identity separate from realm identity", async () => {
  const f = fixture(), first = await f.save("helper", "library", "export const value = 1;");
  const root = await f.save("root", "step", 'import {value} from "./helper.js"; export function step(frame,state,intent) { return value; }', [imported(first)]);
  const initial = buildExecutableModuleBundle(f.store, f.run.run_id, root);
  const latest = await f.save("helper", "library", "export const value = 2;");
  expect(latest.version).toBe(first.version + 1);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, f.store.skill(f.run.run_id, root))).toEqual(initial);
  expect(initial.source_hash).not.toBe(root.hash);
  expect(initial.modules.find(module => module.id === 'module:["helper",1]')?.source).toBe(first.source);
  expect(root.hash).toBe(createHash("sha256").update(root.source).digest("hex"));
  expect(initial.source_hash).toBe(executableModuleBundleHash("step", initial.modules));
  const second = await f.save("other root", "step", root.source, [imported(latest)]);
  expect(second.hash).toBe(root.hash);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, second).source_hash).not.toBe(initial.source_hash);
  const admitted = f.store.admitSkill(f.run.run_id, { entry: "step", skill_id: root.skill_id, version: root.version,
    start_key: "pinned-realm", ...executionScopeFixture(f.run), args: null, initial_state: null, limits: { ...DEFAULT_RESIDENT_LIMITS } });
  expect(admitted.view.source_hash).toBe(initial.source_hash);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: admitted.view.execution_id })?.source_hash).toBe(initial.source_hash);
});

test("library IDs and realm hashes depend on named versions rather than Store UUIDs", async () => {
  const a = fixture(), b = fixture();
  const build = async (f: { store: Store; run: typeof a.run; save: typeof a.save }) => {
    const library = await f.save("shared", "library", "export default function value(input) { return input; }");
    const root = await f.save("analysis", "analyze", 'export {default as analyze} from "./helper.js";', [imported(library)]);
    return { root, bundle: buildExecutableModuleBundle(f.store, f.run.run_id, root) };
  };
  const left = await build(a), right = await build(b);
  expect(left.root.skill_id).not.toBe(right.root.skill_id);
  expect(left.bundle).toEqual(right.bundle);
});

test("pure closures support default, namespace, named bindings and reexports without admitting malformed entries", async () => {
  const f = fixture(), library = await f.save("functions", "library", "const value = 3; export {value}; export default function(input) { return input; }");
  const middle = await f.save("reexports", "library", 'export {default as analyze, value} from "./helper.js";', [imported(library)]);
  const root = await f.save("binding root", "analyze", 'import {analyze as selected} from "./helper.js"; import * as helpers from "./helper.js"; const forwarded = selected; export {forwarded as analyze};', [imported(middle)]);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, root).modules).toHaveLength(3);
  const invalid = await f.save("invalid binding", "analyze", 'export {value as analyze} from "./helper.js";', [imported(library)]);
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, invalid)).toThrow();
  const asyncLibrary = await f.save("async entry", "library", "export async function analyze(input) { return input; }");
  const asyncRoot = await f.save("async root", "analyze", 'export {analyze} from "./helper.js";', [imported(asyncLibrary)]);
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, asyncRoot)).toThrow();
});

test("missing aliases, dependency substitution and source tampering fail before admission", async () => {
  const f = fixture(), library = await f.save("exact", "library", "export const value = 1;");
  const root = await f.save("consumer", "analyze", 'import {value} from "./helper.js"; export function analyze(input) { return value; }', [imported(library)]);
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, { ...root, dependencies: [] })).toThrow();
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, { ...root,
    dependencies: [imported(library), { ...imported(library), version: library.version + 1 }] })).toThrow();
  const alteredStore = { getRun: f.store.getRun.bind(f.store), skill: (_runId: string, ref: { skill_id: string; version: number }) =>
    ref.skill_id === root.skill_id ? root : { ...library, source: library.source + "\n" } };
  expect(() => buildExecutableModuleBundle(alteredStore, f.run.run_id, root)).toThrow();
  const substitution = { getRun: f.store.getRun.bind(f.store), skill: (_runId: string, ref: { skill_id: string; version: number }) =>
    ref.skill_id === root.skill_id ? root : { ...library, version: library.version + 1 } };
  expect(() => buildExecutableModuleBundle(substitution, f.run.run_id, root)).toThrow();
  const foreign = fixture();
  expect(() => buildExecutableModuleBundle(foreign.store, foreign.run.run_id, root)).toThrow();
});

test("closure limits apply to the complete declared library graph before any worker starts", async () => {
  const f = fixture();
  const libraries = await Promise.all(Array.from({ length: 32 }, (_, index) => f.save(`helper ${index}`, "library", `export const value = ${index};`)));
  const root = await f.save("wide", "analyze", libraries.map((_, index) => `import "./h${index}.js";`).join("\n") +
    "\nexport function analyze(input) { return input; }",
    libraries.map((value, index) => imported(value, `./h${index}.js`)));
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, root)).toThrow();
  const bounded = await f.save("bounded", "analyze", libraries.slice(0, 31).map((_, index) => `import "./h${index}.js";`).join("\n") +
    "\nexport function analyze(input) { return input; }", root.dependencies.slice(0, 31));
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, bounded).modules).toHaveLength(32);
  const large = await Promise.all(Array.from({ length: 5 }, (_, index) => f.save(`large ${index}`, "library", `export const value = "${"x".repeat(15000)}";`)));
  const oversized = await f.save("oversized", "analyze", large.map((_, index) => `import "./large${index}.js";`).join("\n") +
    "\nexport function analyze(input) { return input; }", large.map((value, index) => imported(value, `./large${index}.js`)));
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, oversized)).toThrow();
  let next = await f.save("depth 0", "library", "export const value = 0;");
  for (let index = 1; index < 8; index++) {
    const parent = await f.save(`depth ${index}`, "library", 'export {value} from "./helper.js";', [imported(next)]);
    if (index === 6) {
      const depthRoot = await f.save("bounded depth", "analyze", 'import "./helper.js"; export function analyze(input) { return input; }', [imported(parent)]);
      expect(buildExecutableModuleBundle(f.store, f.run.run_id, depthRoot).modules).toHaveLength(8);
    }
    next = parent;
  }
  const deepRoot = await f.save("excess depth", "analyze", 'import "./helper.js"; export function analyze(input) { return input; }', [imported(next)]);
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, deepRoot)).toThrow();
});

test("cycles cannot hide behind reused immutable module identities", async () => {
  const f = fixture(), base = await f.save("cycle a", "library", "export const value = 0;");
  const other = await f.save("cycle b", "library", 'export {value} from "./helper.js";', [imported(base)]);
  const cycleSource = await validateProgramSource('export {value} from "./helper.js";', "library", f.adapter);
  const cycle = { ...base, ...cycleSource, dependencies: [imported(other)] };
  const store = { getRun: f.store.getRun.bind(f.store), skill: (runId: string, ref: { skill_id: string; version: number }) =>
    ref.skill_id === cycle.skill_id ? cycle : f.store.skill(runId, ref) };
  expect(() => resolveProgramModuleClosure(store, f.run.run_id, cycle)).toThrow();
});

test("a shared subtree is bounded at its deepest importing path rather than its first visit", async () => {
  const f = fixture(), leaf = await f.save("shared leaf", "library", "export const value = 0;");
  const shared = await f.save("shared subtree", "library", 'export {value} from "./helper.js";', [imported(leaf)]);
  let next = shared;
  for (let index = 0; index < 6; index++)
    next = await f.save(`deep shared ${index}`, "library", 'export {value} from "./helper.js";', [imported(next)]);
  const root = await f.save("shared depth root", "analyze",
    'import "./shallow.js"; import "./deep.js"; export function analyze(input) { return input; }',
    [imported(shared, "./shallow.js"), imported(next, "./deep.js")]);
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, root)).toThrow();
});

test("unused declarations do not manufacture inline module bytes or change an import-free root byte hash", async () => {
  const f = fixture(), helper = await f.save("unused helper", "library", "export const value = 1;");
  const root = await f.save("no imports", "analyze", "export function analyze(input) { return input; }", [imported(helper)]);
  const bundle = buildExecutableModuleBundle(f.store, f.run.run_id, root);
  expect(bundle.modules).toHaveLength(1);
  expect(bundle.modules[0]?.imports).toEqual([]);
  expect(bundle.source_hash).toBe(root.hash);
});

test("module syntax stays local and plain legacy fingerprints remain untagged", async () => {
  const f = fixture();
  for (const specifier of ["node:fs", "package", "../helper.js", "/helper.js", "./nested/../helper.js", "./helper.js?version=1"]) {
    await expect(validateProgramSource(`import value from ${JSON.stringify(specifier)}; export function analyze(input) { return value; }`, "analyze", f.adapter)).rejects.toThrow();
  }
  for (const body of ['return import("./helper.js");', "return import.meta;", "return process;"])
    await expect(validateProgramSource(`export function analyze(input) { ${body} }`, "analyze", f.adapter)).rejects.toThrow();
  for (const [entry, source] of [["run", "return null;"], ["step", "export function step(frame,state,intent) { return state; }"],
    ["analyze", "export function analyze(input) { return input; }"]] as const) {
    const validated = await validateSkill({ name: entry, entry, source, dependencies: [], card }, f.adapter);
    const hash = createHash("sha256").update(validated.source).digest("hex");
    expect(validated.validation.runtime_features).toBeUndefined();
    expect(validated.validation.fingerprint).toBe(programFingerprint(hash, entry === "run" ? "skill" : entry, f.run.compatibility_hash!));
    if (entry !== "run") {
      const root = await f.store.registerSkill(f.run.run_id, validated);
      expect(buildExecutableModuleBundle(f.store, f.run.run_id, root).source_hash).toBe(hash);
    }
  }
  const binding = await validateProgramSource("const selected = (frame,state,intent) => state; export {selected as step};", "step", f.adapter);
  expect(binding.validation.runtime_features).toEqual(["pure_modules_v1"]);
  expect(binding.validation.fingerprint).not.toBe(programFingerprint(binding.hash, "step", f.run.compatibility_hash!));
});
