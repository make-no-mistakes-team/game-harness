import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillSpec, SkillView } from "../src/shared/programs.ts";
import { SourcePrograms } from "../src/server/source-programs.ts";
import { validateSourceInWorker } from "../src/server/source-validation-client.ts";
import { ProgramValidationError, validateSkill } from "../src/server/program-validation.ts";
import { SourceValidationFrames, SOURCE_VALIDATION_LIMITS, encodeSourceValidationSpec, sourceValidationLine,
  sourceValidationMessageSchema, sourceValidationReadSchema, sourceValidationWorkerRequestSchema } from "../src/server/source-validation-protocol.ts";
import { Store } from "../src/server/store.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const resources: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of resources.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "source-validation-worker-"));
  const store = new Store(directory), adapter = minecraftTestAdapter(), binding = minecraftTestBinding(adapter);
  const run = minecraftRunFixture(adapter);
  store.saveRun(run);
  resources.push({ store, directory });
  const sources = new SourcePrograms(store, { adapter: () => adapter, binding: () => binding });
  return { store, adapter, binding, run, sources };
}
function spec(name = "source-fixture", source = "export const value=41;"): SkillSpec {
  return { entry: "library", name, source, dependencies: [], card: {
    purpose: "Source infrastructure fixture", applicability: "Temporary source catalog", method: "Static arithmetic only",
    reason: "Immutable publication regression", limitations: "No gameplay or execution claim",
  } };
}
async function issues(perform: () => Promise<unknown>) {
  try { await perform(); }
  catch (error) {
    if (error instanceof ProgramValidationError) return error.issues;
    throw error;
  }
  throw new Error("Expected source validation rejection");
}
function validationChildren(): number[] {
  const children = new Set<number>();
  // Bun may spawn from an event-loop thread rather than the thread-group leader.
  for (const task of readdirSync(`/proc/${process.pid}/task`)) {
    let listed: string;
    try { listed = readFileSync(`/proc/${process.pid}/task/${task}/children`, "utf8"); }
    catch { continue; }
    for (const text of listed.trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(text);
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").some(arg => arg.endsWith("/source-validation-worker.ts")))
          children.add(pid);
      } catch { /* An exited child is not live custody. */ }
    }
  }
  return [...children];
}

test("ordinary worker authoring allows Pause to fence publication and the tool receipt while validation is pending", async () => {
  const { store, run, sources } = fixture();
  const source = Array.from({ length: 650 }, (_, index) => `const v${index}=${index};`).join("\n") + "\nexport const value=v649;";
  const registration = { call_id: "paused-validation", input: { fixture: "paused-validation" } };
  let hostProgress = 0;
  const pending = sources.register(run.run_id, spec("paused", source), () => {
    if (store.getRun(run.run_id)?.status !== "running") throw new Error("Authoring scope paused");
  }, registration);
  // Deliberately use a real host turn: fake time would not exercise off-loop worker admission.
  const pause = setTimeout(() => {
    hostProgress++;
    store.saveRun({ ...run, status: "paused" });
  }, 0);
  try { await expect(pending).rejects.toThrow("Authoring scope paused"); }
  finally { clearTimeout(pause); }
  expect(hostProgress).toBe(1);
  expect(store.skills(run.run_id)).toEqual([]);
  expect(store.completedToolCall(run.run_id, registration.call_id, registration.input)).toBeNull();
  expect(store.events(run.run_id).filter(event => event.type === "skill.authored")).toEqual([]);
  expect(store.events(run.run_id).find(event => event.type === "program.source_timing")?.details)
    .toMatchObject({ source_published: false });
  // A subsequent real job succeeds only after the fenced job's owned worker has drained.
  const next = await sources.register(run.run_id, spec("after-pause"));
  expect(next.source).toBe("export const value = 41;\n");
}, 15000);

test("worker validation preserves exact canonical source, fingerprints, source diagnostics and metadata paths", async () => {
  const { store, adapter, run, sources } = fixture();
  const definition = spec();
  const expected = await validateSkill(definition, adapter);
  const published = await sources.register(run.run_id, definition);
  expect(published.source).toBe(expected.source);
  expect(published.validation).toEqual(expected.validation);
  expect(store.skill(run.run_id, published)).toEqual(published);
  for (const invalid of [{ ...definition, name: 42 }, { ...definition, name: NaN }, { ...definition, name: undefined },
    { ...definition, dependencies: [undefined] }, { ...definition, source: "export const value=process.pid;" },
    { ...definition, source: "export const value=(;" }]) {
    const direct = await issues(() => validateSkill(invalid, adapter));
    const offloaded = await issues(() => sources.register(run.run_id, invalid));
    expect(offloaded).toEqual(direct);
  }
  const importedRun = minecraftRunFixture(adapter);
  store.saveRun(importedRun);
  const imported = await sources.importSnapshot(importedRun.run_id, published);
  expect(imported).toEqual(published);
  expect(store.events(importedRun.run_id).some(event => event.type === "skill.revalidated_import")).toBe(true);
}, 20000);

test("worker executes the real module export graph validator rather than validating root syntax alone", async () => {
  const { run, sources } = fixture();
  const leaf = await sources.register(run.run_id, spec("leaf"));
  const root = { ...spec("root", 'import {missing} from "./leaf.js"; export const value=missing;'),
    dependencies: [{ skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" }] };
  expect(await issues(() => sources.register(run.run_id, root))).toMatchObject([{ code: "invalid_module_export" }]);
  const valid = await sources.register(run.run_id, { ...root, source: 'import {value} from "./leaf.js"; export const result=value+1;' });
  expect(valid.dependencies).toEqual(root.dependencies);
}, 15000);

test("joined worker admission pins exact dependency bytes and metadata, not a stale readonly graph", async () => {
  const { adapter, binding, run, sources } = fixture();
  const leaf = await sources.register(run.run_id, spec("pinned-leaf"));
  let current: SkillView = structuredClone(leaf);
  const root = { ...spec("pin-root", 'import {value} from "./leaf.js"; export const result=value+1;'),
    dependencies: [{ skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" }] };
  const admission = await validateSourceInWorker({ spec: root, context: adapter, binding,
    runCompatibilityHash: run.compatibility_hash }, () => structuredClone(current), () => {});
  admission.assertCurrent();
  current = { ...current, state: "quarantined" };
  expect(() => admission.assertCurrent()).toThrow("Validated immutable source dependency changed before publication");
  current = { ...leaf, source: leaf.source + "\n" };
  expect(() => admission.assertCurrent()).toThrow("Validated immutable source dependency changed before publication");
}, 15000);

test("source process pumps nested graph RPCs and reads each exact immutable identity only once", async () => {
  const { adapter, binding, run, sources } = fixture();
  const leaf = await sources.register(run.run_id, spec("nested-leaf"));
  const leafRef = { skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" };
  const middle = await sources.register(run.run_id, { ...spec("nested-middle",
    'import {value} from "./leaf.js"; export const middle=value+1;'), dependencies: [leafRef] });
  const reads: string[] = [];
  const admission = await validateSourceInWorker({ spec: { ...spec("nested-root",
    'import {middle} from "./middle.js"; import {value} from "./leaf.js"; export const result=middle+value;'),
    dependencies: [{ skill_id: middle.skill_id, version: middle.version, import_path: "./middle.js" }, leafRef] },
    context: adapter, binding, runCompatibilityHash: run.compatibility_hash }, ref => {
    reads.push(ref.skill_id);
    if (ref.skill_id === leaf.skill_id) return structuredClone(leaf);
    if (ref.skill_id === middle.skill_id) return structuredClone(middle);
    throw new Error("Unexpected source-only reference");
  }, () => {});
  expect(reads).toEqual([middle.skill_id, leaf.skill_id]);
  expect(admission.validated.name).toBe("nested-root");
  expect(validationChildren()).toEqual([]);
}, 15000);

test("cancellation joins startup workers before returning and releases the finite job slots", async () => {
  const { store, run, sources } = fixture();
  const controller = new AbortController();
  const pending = Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    sources.register(run.run_id, spec(`cancelled-${index}`), () => {}, undefined, { signal: controller.signal })));
  // All four real processes have been constructed; no fake backend or timer gate stands in for their closure.
  controller.abort();
  const outcomes = await pending;
  expect(outcomes.every(outcome => outcome.status === "rejected" &&
    outcome.reason instanceof RuntimeFault && outcome.reason.code === "stale_context" &&
    outcome.reason.message === "Source validation cancelled; no source was published")).toBe(true);
  expect(store.skills(run.run_id)).toEqual([]);
  expect(validationChildren()).toEqual([]);
  await sources.register(run.run_id, spec("after-cancellation"));
  expect(store.skills(run.run_id)).toHaveLength(1);
}, 15000);

test("cancelled joined validation admission remains stale before publication without renewing or exposing the abort reason", async () => {
  const { store, adapter, binding, run, sources } = fixture();
  const controller = new AbortController();
  const admission = await validateSourceInWorker({ spec: spec("cancel-after-join"), context: adapter,
    binding, runCompatibilityHash: run.compatibility_hash }, () => {
    throw new Error("The source has no dependencies");
  }, () => {}, { signal: controller.signal });
  expect(validationChildren()).toEqual([]);
  admission.assertCurrent();
  controller.abort(new Error("PRIVATE_ABORT_REASON"));
  let refused: unknown;
  try { admission.assertCurrent(); }
  catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(RuntimeFault);
  expect(refused).toMatchObject({ code: "stale_context", message: "Source validation cancelled; no source was published" });
  await expect(sources.register(run.run_id, spec("already-cancelled"), () => {}, undefined,
    { signal: controller.signal })).rejects.toMatchObject({
    code: "stale_context", message: "Source validation cancelled; no source was published",
  });
  expect(store.skills(run.run_id)).toEqual([]);
  expect(validationChildren()).toEqual([]);
}, 15000);

test("expired original caller deadlines cannot receive a renewed worker allowance", async () => {
  const { store, run, sources } = fixture();
  await expect(sources.register(run.run_id, spec("expired"), () => {}, undefined,
    { deadlineHostMs: performance.now() - 1 })).rejects.toThrow("Source validation deadline exceeded");
  expect(store.skills(run.run_id)).toEqual([]);
}, 10000);

test("caller mutation after submission cannot rewrite the detached source admitted by the worker", async () => {
  const { run, sources } = fixture();
  const definition = spec("detached");
  const pending = sources.register(run.run_id, definition);
  definition.source = "export const value=999;";
  definition.name = "mutated";
  const published = await pending;
  expect(published.name).toBe("detached");
  expect(published.source).toBe("export const value = 41;\n");
}, 10000);

test("source RPC runs in a credential-free process and joins its actual exit before admission", async () => {
  const { adapter, binding, run, sources } = fixture();
  const leaf = await sources.register(run.run_id, spec("process-leaf"));
  const previous = process.env.SOURCE_VALIDATION_TEST_SECRET;
  process.env.SOURCE_VALIDATION_TEST_SECRET = "must-not-cross-source-pipe";
  let reads = 0, childPid: number | null = null;
  try {
    const admission = await validateSourceInWorker({ spec: { ...spec("process-root",
      'import {value} from "./leaf.js"; export const result=value+1;'),
      dependencies: [{ skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" }] },
      context: adapter, binding, runCompatibilityHash: run.compatibility_hash }, () => {
      reads++;
      const children = validationChildren();
      expect(children).toHaveLength(1);
      childPid = children[0]!;
      expect(childPid).not.toBe(process.pid);
      const environment = readFileSync(`/proc/${childPid}/environ`, "utf8").split("\0").filter(Boolean);
      expect(environment).toContain("LANG=C.UTF-8");
      expect(environment.some(item => /^(SOURCE_VALIDATION_TEST_SECRET|HOME|HTTP_PROXY|HTTPS_PROXY|NODE_OPTIONS|BUN_OPTIONS)=/.test(item))).toBe(false);
      expect(readFileSync(`/proc/${childPid}/cmdline`, "utf8").split("\0")).toContain("--no-env-file");
      return structuredClone(leaf);
    }, () => {});
    expect(reads).toBe(1);
    expect(childPid).not.toBeNull();
    expect(validationChildren()).toEqual([]);
    expect(() => process.kill(childPid!, 0)).toThrow();
    expect(admission.validated.name).toBe("process-root");
  } finally {
    if (previous === undefined) delete process.env.SOURCE_VALIDATION_TEST_SECRET;
    else process.env.SOURCE_VALIDATION_TEST_SECRET = previous;
  }
}, 15000);

test("crashed source processes cannot kill the coordinator or leak a job slot or publication", async () => {
  const { adapter, binding, run, sources, store } = fixture();
  const leaf = await sources.register(run.run_id, spec("crash-leaf"));
  for (const signal of ["SIGKILL", "SIGSEGV"] as const) {
    const pending = validateSourceInWorker({ spec: { ...spec(`crash-${signal}`,
      'import {value} from "./leaf.js"; export const result=value+1;'),
      dependencies: [{ skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" }] },
      context: adapter, binding, runCompatibilityHash: run.compatibility_hash }, () => {
      const children = validationChildren();
      expect(children).toHaveLength(1);
      process.kill(children[0]!, signal);
      return structuredClone(leaf);
    }, () => {});
    const failure = await pending.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProgramValidationError);
    expect(validationChildren()).toEqual([]);
    expect(store.skills(run.run_id)).toHaveLength(1);
  }
  const published = await sources.register(run.run_id, spec("after-child-crash"));
  expect(published.name).toBe("after-child-crash");
}, 20000);

test("source RPC validates detached metadata and preserves known source failure branding", async () => {
  const { adapter, binding, run, sources } = fixture();
  const leaf = await sources.register(run.run_id, spec("schema-leaf"));
  const request = { spec: { ...spec("schema-root", 'import {value} from "./leaf.js"; export const result=value+1;'),
    dependencies: [{ skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" }] },
    context: adapter, binding, runCompatibilityHash: run.compatibility_hash };
  await expect(validateSourceInWorker(request, () => ({ ...leaf, validation: { ...leaf.validation, nesting: -1 } }), () => {}))
    .rejects.toThrow("Source validation backend failed; no source was published");
  await expect(validateSourceInWorker(request, () => ({ ...leaf, state: "quarantined" }), () => {}))
    .rejects.toThrow("Dependency is not validated");
  await expect(validateSourceInWorker({ ...request, context: { descriptor: adapter.descriptor,
    schemas: { ...adapter.schemas, payload: null } } }, () => structuredClone(leaf), () => {}))
    .rejects.toThrow("Source validation backend failed; no source was published");
  expect(validationChildren()).toEqual([]);
}, 15000);

test("cancellation during an actual source read joins the child and cannot admit a late graph result", async () => {
  const { adapter, binding, run, sources } = fixture();
  const leaf = await sources.register(run.run_id, spec("cancel-rpc-leaf"));
  const controller = new AbortController();
  let read = false;
  await expect(validateSourceInWorker({ spec: { ...spec("cancel-rpc-root",
    'import {value} from "./leaf.js"; export const result=value+1;'),
    dependencies: [{ skill_id: leaf.skill_id, version: leaf.version, import_path: "./leaf.js" }] },
    context: adapter, binding, runCompatibilityHash: run.compatibility_hash }, () => {
    read = true;
    controller.abort();
    return structuredClone(leaf);
  }, () => {}, { signal: controller.signal })).rejects.toMatchObject({
    code: "stale_context", message: "Source validation cancelled; no source was published",
  });
  expect(read).toBe(true);
  expect(validationChildren()).toEqual([]);
  await sources.register(run.run_id, spec("after-rpc-cancellation"));
}, 15000);

test("source framing bounds fragments, rejects corrupt UTF-8 and incomplete frames, and validates requests/replies", () => {
  const framed = new SourceValidationFrames(), received: unknown[] = [];
  const encoded = Buffer.from(sourceValidationLine({ kind: "fixture", text: "source \u03bb" }));
  for (const byte of encoded) framed.push(Buffer.from([byte]), value => received.push(value));
  framed.finish();
  expect(received).toEqual([{ kind: "fixture", text: "source \u03bb" }]);
  const partial = new SourceValidationFrames();
  partial.push(Buffer.from("{"), () => {});
  expect(() => partial.finish()).toThrow("Incomplete source validation frame");
  expect(() => new SourceValidationFrames().push(Buffer.from([0xff, 10]), () => {})).toThrow();
  expect(() => new SourceValidationFrames().push(Buffer.alloc(SOURCE_VALIDATION_LIMITS.message_bytes + 1, 32), () => {}))
    .toThrow("Source validation frame exceeds limit");
  expect(sourceValidationReadSchema.safeParse({ kind: "artifact", id: 1, artifact: {} }).success).toBe(false);
  expect(sourceValidationMessageSchema.safeParse({ kind: "known_error", code: "native_fault" }).success).toBe(false);
  expect(sourceValidationMessageSchema.safeParse({ kind: "source_error", issues: [{
    code: "native_fault", message: "untrusted worker detail", location: null, limit: null,
  }] }).success).toBe(false);
  expect(sourceValidationWorkerRequestSchema.safeParse({ kind: "validate", spec: encodeSourceValidationSpec(spec()) }).success).toBe(false);
});
