import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDependency, SkillRef, SkillSpec, SkillView } from "../src/shared/programs.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { executableModuleBundleHash } from "../src/shared/program-modules.ts";
import { buildArtifactModuleBundle, buildExecutableModuleBundle, programExecutionHash, resolveArtifactModuleClosure,
  resolveProgramModuleClosure } from "../src/server/program-modules.ts";
import { ProgramValidationError, programFingerprint, validateSkill, validateProgramSource } from "../src/server/program-validation.ts";
import { PreparedSourcebook } from "../src/server/prepared-sourcebook.ts";
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
function validationCodes(operation: () => unknown): string[] {
  try { operation(); } catch (error) {
    if (error instanceof ProgramValidationError) return error.issues.map(issue => issue.code);
    throw error;
  }
  return [];
}

test("trusted artifact catalogs resolve the same inline realm without inventing a run", async () => {
  const f = fixture();
  const library = await f.save("offline library", "library", "export function value(input) { return input; }");
  const root = await f.save("offline root", "analyze",
    "import {value} from './helper.js'; export function analyze(input) { return value(input); }", [imported(library)]);
  const catalog = { compatibility_hash: root.validation.compatibility_hash!, read: (ref: SkillRef) => f.store.skill(f.run.run_id, ref) };
  expect(buildArtifactModuleBundle(catalog, root)).toEqual(buildExecutableModuleBundle(f.store, f.run.run_id, root));
  expect(resolveArtifactModuleClosure(catalog, root)).toEqual(resolveProgramModuleClosure(f.store, f.run.run_id, root));
});

test("scope admission resolves import aliases and reexports without treating property names as free reads", async () => {
  const f = fixture();
  const helper = await f.save("scope helper", "library",
    "const value = 3; export {value, value as process}; export default function(value) { return value; }");
  const middle = await f.save("scope aliases", "library", `
    import identity, {value as local, process as safe} from "./helper.js";
    import * as namespace from "./helper.js";
    const result = identity(local) + namespace.value + safe;
    export {result as process};
    export {value as missing} from "./helper.js";
    export * as forwarded from "./helper.js";
  `, [imported(helper)]);
  const root = await f.save("scope consumer", "analyze", `
    import * as values from "./helper.js";
    export function analyze(input) {
      const key = "process";
      return {process: values.process, motion: input.motion, [key]: values[key], tick: values.missing};
    }
  `, [imported(middle)]);
  expect(root.validation.runtime_features).toEqual(["pure_modules_v1"]);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, root).modules).toHaveLength(3);
});

test("prepared activate admission checks resolved reexports without calling any frame function", async () => {
  const f = fixture();
  const library = await f.save("executive exports", "library",
    "export function step(frame,state,intent) { return null; } export function activate(frame,state,intent) { return null; }");
  const root = await f.save("prepared executive", "step", "export {step,activate} from './helper.js';", [imported(library)]);
  const catalog = { compatibility_hash: root.validation.compatibility_hash!, read: (ref: SkillRef) => f.store.skill(f.run.run_id, ref) };
  expect(buildArtifactModuleBundle(catalog, root, undefined, true).modules).toHaveLength(2);
  const missing = await f.save("missing activation", "step", "export function step(frame,state,intent) { return null; }");
  expect(() => buildArtifactModuleBundle(catalog, missing, undefined, true)).toThrow();
});

test("artifact source/header substitutions are rejected before acquiring a worker", async () => {
  const f = fixture();
  const root = await f.save("sealed artifact", "step",
    "export function step(frame,state,intent) { return null; } export function activate(frame,state,intent) { return null; }");
  const catalog = { compatibility_hash: root.validation.compatibility_hash!, read: () => root };
  expect(() => buildArtifactModuleBundle(catalog, { ...root, validation: { ...root.validation, api_version: 4 } }, undefined, true)).toThrow();
  expect(() => buildArtifactModuleBundle(catalog, { ...root, source: root.source + "\\n" }, undefined, true)).toThrow();
  expect(() => buildArtifactModuleBundle({ ...catalog, read: () => ({ ...root, hash: "a".repeat(64) }) },
    { ...root, hash: "a".repeat(64) }, undefined, true)).toThrow();
  expect(() => buildArtifactModuleBundle({ ...catalog, compatibility_hash: "b".repeat(64) }, root, undefined, true)).toThrow();
});

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

test("analysis pins the actual step role and its nested library versions without compiling semantic run children", async () => {
  const f = fixture(), library = await f.save("candidate helper", "library", "export const value = 1;");
  const child = await f.save("semantic procedure", "run", "throw new Error('Semantic source must remain inert');");
  const candidate = await f.save("candidate", "step",
    'import {value} from "./helper.js"; export function activate(frame,state,intent) { return value; } export function step(frame,state,intent) { return value; }',
    [imported(library), { skill_id: child.skill_id, version: child.version }]);
  const root = await f.save("candidate check", "analyze",
    'import * as candidate from "./candidate.js"; export {} from "./candidate.js"; export function analyze(input) { return candidate.step(input.frame,input.state,input.intent); }',
    [imported(candidate, "./candidate.js")]);
  const initial = buildExecutableModuleBundle(f.store, f.run.run_id, root);
  const newerLibrary = await f.save(library.name, "library", "export const value = 2;");
  const newerCandidate = await f.save(candidate.name, "step", candidate.source, [imported(newerLibrary)]);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, root)).toEqual(initial);
  expect(initial.entry).toBe("analyze");
  expect(initial.modules.map(module => module.id)).toEqual(['module:["candidate helper",1]', 'module:["candidate",1]', "root"]);
  expect(initial.modules.find(module => module.id === 'module:["candidate",1]')).toMatchObject({
    source: candidate.source, source_hash: candidate.hash,
    imports: [{ specifier: "./helper.js", module_id: 'module:["candidate helper",1]' }],
  });
  expect(initial.source_hash).toBe(executableModuleBundleHash("analyze", initial.modules));
  const revised = await f.save(root.name, "analyze", root.source, [imported(newerCandidate, "./candidate.js")]);
  expect(revised.hash).toBe(root.hash);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, revised).source_hash).not.toBe(initial.source_hash);
  const catalog = { compatibility_hash: f.run.compatibility_hash!, read: (ref: SkillRef) => f.store.skill(f.run.run_id, ref) };
  expect(buildArtifactModuleBundle(catalog, root)).toEqual(initial);
  const relabeled = { ...candidate, validation: { ...candidate.validation,
    fingerprint: programFingerprint(candidate.hash, "library", f.run.compatibility_hash!, undefined, candidate.validation.runtime_features) } };
  expect(validationCodes(() => buildArtifactModuleBundle({ ...catalog, read: ref =>
    ref.skill_id === candidate.skill_id && ref.version === candidate.version ? relabeled : catalog.read(ref) }, root))).toEqual(["invalid_modules"]);
  const malformed = await validateProgramSource("export const step = 7;", "library", f.adapter);
  const invalidCandidate = { ...candidate, ...malformed, dependencies: [], validation: { ...malformed.validation,
    fingerprint: programFingerprint(malformed.hash, "step", f.run.compatibility_hash!, undefined, malformed.validation.runtime_features) } };
  expect(validationCodes(() => buildArtifactModuleBundle({ ...catalog, read: ref =>
    ref.skill_id === candidate.skill_id && ref.version === candidate.version ? invalidCandidate : catalog.read(ref) }, root))).toEqual(["invalid_entry"]);
});

test("prepared catalogs and store resolution admit only analyze-to-step and existing library imports", async () => {
  const f = fixture(), book = new PreparedSourcebook(f.run.compatibility_hash!, f.adapter, () => {}, () => {});
  let call = 0;
  const write = (name: string, entry: SkillSpec["entry"], source: string,
    dependencies: { name: string; version: number; import_path?: string }[] = [], based_on?: number) =>
    book.write({ name, entry, source, dependencies, card, ...(based_on === undefined ? {} : { based_on }) }, `call-${++call}`, "request");
  await write("pure helper", "library", "export const value = 1;");
  await write("procedure", "run", "return null;");
  await write("executive", "step",
    'import {value} from "./helper.js"; export function step(frame,state,intent) { return value; }',
    [{ name: "pure helper", version: 1, import_path: "./helper.js" }, { name: "procedure", version: 1 }]);
  await write("check", "analyze",
    'import {step} from "./candidate.js"; export function analyze(input) { return step(input.frame,input.state,input.intent); }',
    [{ name: "executive", version: 1, import_path: "./candidate.js" }]);
  const root = book.select({ name: "check", version: 1 }), initial = book.bundle(root);
  await write("pure helper", "library", "export const value = 2;", [], 1);
  await write("executive", "step", "export function step(frame,state,intent) { return 2; }", [], 1);
  expect(book.bundle(root)).toEqual(initial);
  expect(book.sources(root).map(value => [value.name, value.version])).toEqual([
    ["pure helper", 1], ["procedure", 1], ["executive", 1], ["check", 1],
  ]);
  const targets = ["procedure", "executive", "check"] as const;
  for (const entry of ["step", "library", "analyze"] as const) for (const target of targets) {
    if (entry === "analyze" && target === "executive") continue;
    const source = `import "./target.js"; export function ${entry === "library" ? "value" : entry}(${entry === "step" ? "frame,state,intent" : "input"}) { return null; }`;
    await expect(write(`invalid ${entry} ${target}`, entry, source,
      [{ name: target, version: 1, import_path: "./target.js" }])).rejects.toThrow();
    const stored = await f.save(`invalid ${entry} ${target}`, entry, source, [imported(
      await f.save(`target ${entry} ${target}`, book.select({ name: target, version: 1 }).entry!,
        target === "procedure" ? "return null;" : target === "executive" ?
          "export function step(frame,state,intent) { return null; }" : "export function analyze(input) { return input; }"), "./target.js")]);
    expect(validationCodes(() => resolveProgramModuleClosure(f.store, f.run.run_id, stored))).toEqual(["invalid_dependencies"]);
  }
});

test("an imported step cannot bypass pure closure count, bytes, depth or cycle bounds", async () => {
  const f = fixture();
  const wrap = async (candidate: SkillView, name: string) => f.save(name, "analyze",
    'import {step} from "./candidate.js"; export function analyze(input) { return step(input,null,null); }',
    [imported(candidate, "./candidate.js")]);
  const libraries = await Promise.all(Array.from({ length: 31 }, (_, index) =>
    f.save(`step helper ${index}`, "library", `export const value = ${index};`)));
  const candidateSource = (count: number) => Array.from({ length: count }, (_, index) => `import "./h${index}.js";`).join("\n") +
    "\nexport function step(frame,state,intent) { return state; }";
  const candidate = await f.save("wide step", "step", candidateSource(31), libraries.map((value, index) => imported(value, `./h${index}.js`)));
  expect(() => buildExecutableModuleBundle(f.store, f.run.run_id, candidate)).not.toThrow();
  const excessive = await wrap(candidate, "wide check");
  expect(validationCodes(() => buildExecutableModuleBundle(f.store, f.run.run_id, excessive))).toEqual(["module_count_limit"]);
  const bounded = await f.save("bounded step", "step", candidateSource(30), candidate.dependencies.slice(0, 30));
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, await wrap(bounded, "bounded check")).modules).toHaveLength(32);
  const large = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    f.save(`step large ${index}`, "library", `export const value = "${"x".repeat(15000)}";`)));
  const oversized = await f.save("large step", "step", candidateSource(5), large.map((value, index) => imported(value, `./h${index}.js`)));
  const oversizedRoot = await wrap(oversized, "large check");
  expect(validationCodes(() => buildExecutableModuleBundle(f.store, f.run.run_id, oversizedRoot))).toEqual(["module_bytes_limit"]);
  let next = libraries[0]!;
  for (let index = 1; index <= 6; index++)
    next = await f.save(`step depth ${index}`, "library", 'export {value} from "./helper.js";', [imported(next)]);
  const deep = await f.save("deep step", "step", 'import "./helper.js"; export function step(frame,state,intent) { return state; }', [imported(next)]);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, deep).modules).toHaveLength(8);
  const deepRoot = await wrap(deep, "deep check");
  expect(validationCodes(() => buildExecutableModuleBundle(f.store, f.run.run_id, deepRoot))).toEqual(["module_depth_limit"]);
  const cycleOther = await f.save("step cycle peer", "library", 'export {value} from "./helper.js";', [imported(libraries[0]!)]);
  const cyclicSource = await validateProgramSource('export {value} from "./helper.js";', "library", f.adapter);
  const cycle = { ...libraries[0]!, ...cyclicSource, dependencies: [imported(cycleOther)] };
  const cyclicStep = await f.save("cyclic step", "step",
    'import "./helper.js"; export function step(frame,state,intent) { return state; }', [imported(cycleOther)]);
  const cyclicRoot = await wrap(cyclicStep, "cyclic check");
  const cyclic = { getRun: f.store.getRun.bind(f.store), skill: (runId: string, ref: SkillRef) =>
    ref.skill_id === cycle.skill_id ? cycle : f.store.skill(runId, ref) };
  expect(validationCodes(() => buildExecutableModuleBundle(cyclic, f.run.run_id, cyclicRoot))).toEqual(["module_cycle"]);
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

test("tracking math admission composes with declared pure dependencies without dropping either requirement", async () => {
  const f = fixture();
  const helper = await f.save("tracking library", "library", "export const track = motion.track;");
  const root = await f.save("tracking root", "analyze",
    "export function analyze(input) { return motion.track(input.options,input.state); }", [imported(helper)]);
  expect(root.validation.runtime_features).toEqual(["pure_modules_v1", "motion_track_v1"]);
  expect(buildExecutableModuleBundle(f.store, f.run.run_id, root).source_hash).toBe(root.hash);
  const stripped: SkillView = { ...root, validation: { ...root.validation, runtime_features: ["pure_modules_v1"] } };
  expect(validationCodes(() => resolveArtifactModuleClosure({
    compatibility_hash: root.validation.compatibility_hash!, read: ref => f.store.skill(f.run.run_id, ref),
  }, stripped))).toEqual(["invalid_modules"]);
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
