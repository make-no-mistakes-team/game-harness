import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InlineCognitionContext, type ContextOwner } from "../src/server/cognition-context.ts";
import { CognitionContextCustody, parseContextCheckpoint, parsePassiveContextState,
  type PassiveContextState } from "../src/server/cognition-context-custody.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { StrategicContext } from "../src/server/strategic-context.ts";
import { StrategicContextClient } from "../src/server/strategic-context-client.ts";
import { CONTEXT_WORKER_LIMITS, strategicContextScope, type ContextAssemblyInput } from "../src/server/strategic-context-protocol.ts";
import { emptyRunUsage } from "../src/server/usage.ts";
import { CognitionWire } from "../src/server/cognition-wire.ts";
import { osMonotonicNs } from "../src/server/os-monotonic.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cognition-context-"));
  const store = new Store(directory);
  const run: StoredRun = { run_id: "context-fixture", world_id: "fixture-world", epoch: 1,
    session_id: "fixture-session", life_id: 1, native_boot_id: "fixture-boot", space_epoch: 1,
    compatibility_hash: "a".repeat(64), task: "Retain passive infrastructure references",
    goal: { adapter_id: "fixture-adapter", goal_id: "custom", verifier: null, parameters: {} },
    model_id: "fixture-model", status: "running", started_at: "2026-01-01T00:00:00.000Z", ended_at: null,
    turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {} };
  store.saveRun(run);
  const clock = { value: 1_000_000_000n };
  const owner = new InlineCognitionContext(store.readLocation(), () => clock.value);
  const input: ContextAssemblyInput = { scope: strategicContextScope(run),
    model: { api: "fixture-api", provider: "fixture-provider" }, observation: null };
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  cleanup.push(() => owner.close());
  return { store, run, owner, input, clock, options: () => ({ deadlineOsNs: clock.value + 5_000_000_000n }) };
}

async function source(store: Store, run: StoredRun, name = "Passive source reference") {
  // Passive stored source, never compiled, executed or offered effect authority.
  return await store.registerSkill(run.run_id, { entry: "run", name,
    source: `return {status:"completed",summary:${JSON.stringify(`PASSIVE_SOURCE_MARKER:${name}`)},result:null};`, dependencies: [],
    card: { purpose: "Infrastructure context fixture", applicability: "Offline only", method: "No effects",
      reason: "Source knowledge custody", limitations: "Not gameplay evidence" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5, compatibility_hash: run.compatibility_hash!,
      fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 } });
}

test("existing process client and inline reducer satisfy the same context owner interface", async () => {
  const f = fixture();
  const inline: ContextOwner = f.owner;
  const embedded: ContextOwner = new StrategicContextClient(f.store.readLocation());
  await inline.close(); await embedded.close();
  inline.reset(); inline.open();
  expect(await inline.assemble(f.input, f.options())).toContain("strategic_context");
});

test("inline context exactly matches the shared readonly reducer, including scoped unknown evidence and source", async () => {
  const f = fixture(), program = await source(f.store, f.run);
  const unknown = f.store.event(f.run.run_id, "runtime.uncertainty", "UNCONFIRMED_REFERENCE", {
    action_id: "fixture-unconfirmed", world_id: f.run.world_id, session_id: f.run.session_id,
    life_id: f.run.life_id, native_boot_id: f.run.native_boot_id, space_epoch: f.run.space_epoch,
  });
  const readonly = new ReadonlyStore(f.store.readLocation());
  cleanup.push(() => readonly.close());
  const retained = new StrategicContext(readonly);
  const expected = readonly.snapshot(() => {
    retained.synchronize(f.run, f.input.model, { messages: [] }, null);
    return retained.assemble(f.run);
  });
  expect(await f.owner.assemble(f.input, f.options())).toBe(expected);
  f.owner.rememberHelp("programs", { contract: "RETAINED_HELP_MARKER" });
  f.owner.selectProgram(program.name, program.version);
  const expectedNext = readonly.snapshot(() => {
    retained.rememberHelp("programs", { contract: "RETAINED_HELP_MARKER" });
    retained.selectProgram(program.name, program.version);
    retained.synchronize(f.run, f.input.model, { messages: [] }, null);
    return retained.assemble(f.run);
  });
  const result = await f.owner.assemble(f.input, f.options());
  expect(result).toBe(expectedNext);
  const context = JSON.parse(result).strategic_context;
  expect(context.programs).toContainEqual(expect.objectContaining({ name: program.name, version: program.version,
    hash: program.hash, source: program.source }));
  expect(context.unresolved).toContainEqual(expect.objectContaining({ event_seq: unknown.event_seq,
    no_replay: true, historical: true, current_authority: false,
    original_scope: expect.objectContaining({ life_id: f.run.life_id }) }));
  await f.owner.close(); f.owner.open();
  expect(await f.owner.assemble(f.input, f.options())).toBe(result);
  const changed = JSON.parse(await f.owner.assemble({ ...f.input,
    model: { ...f.input.model, provider: "replacement-provider" } }, f.options())).strategic_context;
  expect(changed.programs).toEqual(context.programs);
  expect(changed.unresolved).toEqual(context.unresolved);
  expect(changed.requested_help).toEqual([]);
});

test("task replacement preserves the reducer's source floor across close and reopen", async () => {
  const f = fixture(), program = await source(f.store, f.run);
  expect(await f.owner.assemble(f.input, f.options())).toContain(program.hash);
  const changed = { ...f.input, scope: { ...f.input.scope, task: "Replacement reference task" } };
  expect(JSON.parse(await f.owner.assemble(changed, f.options())).strategic_context.programs).toEqual([]);
  await f.owner.close(); f.owner.open();
  expect(JSON.parse(await f.owner.assemble(changed, f.options())).strategic_context.programs).toEqual([]);
  expect(f.store.getRun(f.run.run_id)?.task).toBe(f.run.task);
});

test("queued scope, pending authoring and help are detached from mutable caller data", async () => {
  const f = fixture();
  await f.owner.assemble(f.input, f.options());
  const help = { contract: "ORIGINAL_HELP" };
  const pending = { summary: "ORIGINAL_PENDING" };
  const input = { ...f.input, scope: { ...f.input.scope }, pendingAuthoring: pending };
  f.owner.rememberHelp("programs", help);
  const result = f.owner.assemble(input, f.options());
  help.contract = "MUTATED_HELP"; pending.summary = "MUTATED_PENDING"; input.scope.task = "MUTATED_TASK";
  const context = await result;
  expect(context).toContain("ORIGINAL_HELP"); expect(context).toContain("ORIGINAL_PENDING");
  expect(context).not.toContain("MUTATED_");
  expect(context).toContain(f.run.task);
});

test("cancellation restores ordered unacknowledged operations and rejects every queued assembly", async () => {
  const f = fixture();
  await f.owner.assemble(f.input, f.options());
  const controller = new AbortController();
  f.owner.rememberHelp("programs", { contract: "FIRST_HELP" });
  const first = f.owner.assemble(f.input, { ...f.options(), signal: controller.signal });
  f.owner.rememberHelp("programs", { contract: "SECOND_HELP" });
  const second = f.owner.assemble(f.input, f.options());
  const results = Promise.allSettled([first, second]);
  controller.abort();
  expect((await results).map(value => value.status)).toEqual(["rejected", "rejected"]);
  await f.owner.close(); f.owner.open();
  const recovered = await f.owner.assemble(f.input, f.options());
  expect(recovered).toContain("SECOND_HELP"); expect(recovered).not.toContain("FIRST_HELP");
});

for (const deadline of ["original", "five-second ceiling"] as const) {
  test(`postcompute ${deadline} expiry does not commit a changed scope or acknowledge help`, async () => {
    const f = fixture(), program = await source(f.store, f.run);
    await f.owner.assemble(f.input, f.options());
    f.owner.rememberHelp("programs", { contract: "UNACKNOWLEDGED_HELP" });
    const original = StrategicContext.prototype.assemble;
    const assembly = spyOn(StrategicContext.prototype, "assemble").mockImplementation(function (this: StrategicContext, run, adapter, pending) {
      const result = original.call(this, run, adapter, pending);
      f.clock.value += deadline === "original" ? 100n : 5_000_000_000n;
      return result;
    });
    cleanup.push(() => { assembly.mockRestore(); });
    const changed = { ...f.input, scope: { ...f.input.scope, task: "Must not commit this scope" } };
    await expect(f.owner.assemble(changed, { deadlineOsNs: f.clock.value +
      (deadline === "original" ? 100n : 60_000_000_000n) })).rejects.toMatchObject({ code: "backend_unavailable" });
    assembly.mockRestore();
    await f.owner.close(); f.owner.open();
    const recovered = await f.owner.assemble(f.input, f.options());
    expect(recovered).toContain(program.hash); expect(recovered).toContain("UNACKNOWLEDGED_HELP");
    expect(recovered).not.toContain("Must not commit this scope");
  });
}

test("queue wait uses the admitted original deadline and does not invoke an expired reducer", async () => {
  const f = fixture();
  const assembly = spyOn(StrategicContext.prototype, "assemble");
  cleanup.push(() => { assembly.mockRestore(); });
  const pending = f.owner.assemble(f.input, { deadlineOsNs: f.clock.value + 100n });
  const results = Promise.allSettled([pending]);
  f.clock.value += 100n;
  expect((await results)[0]?.status).toBe("rejected");
  expect(assembly).not.toHaveBeenCalled();
});

test("cancellation during synchronous computation cannot publish its result or lose help", async () => {
  const f = fixture();
  await f.owner.assemble(f.input, f.options());
  f.owner.rememberHelp("programs", { contract: "POSTCOMPUTE_ABORT_HELP" });
  const controller = new AbortController(), original = StrategicContext.prototype.assemble;
  const assembly = spyOn(StrategicContext.prototype, "assemble").mockImplementation(function (this: StrategicContext, run, adapter, pending) {
    const result = original.call(this, run, adapter, pending);
    controller.abort(); return result;
  });
  cleanup.push(() => { assembly.mockRestore(); });
  await expect(f.owner.assemble(f.input, { ...f.options(), signal: controller.signal }))
    .rejects.toMatchObject({ code: "backend_unavailable" });
  assembly.mockRestore();
  await f.owner.close(); f.owner.open();
  expect(await f.owner.assemble(f.input, f.options())).toContain("POSTCOMPUTE_ABORT_HELP");
});

test("only reducer reads are snapshot-pinned; reentrant close joins the snapshot before closing the store", async () => {
  const f = fixture();
  let depth = 0, close: Promise<void> | undefined;
  const snapshot = ReadonlyStore.prototype.snapshot, checkpoint = StrategicContext.prototype.checkpoint;
  const originalAssembly = StrategicContext.prototype.assemble;
  const pinned = spyOn(ReadonlyStore.prototype, "snapshot").mockImplementation(function <T>(this: ReadonlyStore, operation: () => T): T {
    depth++;
    try { return snapshot.call(this, operation) as T; }
    finally { depth--; }
  });
  const originalClose = ReadonlyStore.prototype.close;
  const storeClose = spyOn(ReadonlyStore.prototype, "close").mockImplementation(function (this: ReadonlyStore) {
    expect(depth).toBe(0);
    return originalClose.call(this);
  });
  const savedCheckpoint = spyOn(StrategicContext.prototype, "checkpoint").mockImplementation(function (this: StrategicContext) {
    expect(depth).toBe(0); return checkpoint.call(this);
  });
  cleanup.push(() => { pinned.mockRestore(); storeClose.mockRestore(); savedCheckpoint.mockRestore(); });
  await f.owner.assemble(f.input, f.options());
  const assembly = spyOn(StrategicContext.prototype, "assemble").mockImplementation(function (this: StrategicContext, run, adapter, pending) {
    expect(depth).toBe(1);
    close = f.owner.close();
    expect(storeClose).not.toHaveBeenCalled();
    return originalAssembly.call(this, run, adapter, pending);
  });
  cleanup.push(() => { assembly.mockRestore(); });
  await expect(f.owner.assemble(f.input, f.options())).rejects.toMatchObject({ code: "backend_unavailable" });
  await close;
  expect(storeClose).toHaveBeenCalledTimes(1); expect(depth).toBe(0);
});

test("close before scheduled work settles all queued callers and permits explicit reset/reopen", async () => {
  const f = fixture();
  const first = f.owner.assemble(f.input, f.options()), second = f.owner.assemble(f.input, f.options());
  const results = Promise.allSettled([first, second]);
  await f.owner.close();
  expect((await results).map(value => value.status)).toEqual(["rejected", "rejected"]);
  f.owner.reset(); f.owner.open();
  await f.owner.assemble(f.input, f.options());
  f.owner.rememberHelp("programs", { contract: "RESET_ME" });
  await f.owner.assemble(f.input, f.options());
  await f.owner.close(); f.owner.reset(); f.owner.open();
  expect(await f.owner.assemble(f.input, f.options())).not.toContain("RESET_ME");
});

test("operation count and byte budgets fail closed without dropping eligible retained operations", async () => {
  const f = fixture();
  for (let index = 0; index < CONTEXT_WORKER_LIMITS.operations; index++)
    f.owner.rememberHelp("programs", { index });
  expect(() => f.owner.rememberHelp("programs", { overflow: true })).toThrow();
  await expect(f.owner.assemble(f.input, f.options())).rejects.toMatchObject({ code: "backend_unavailable" });
  await f.owner.close(); f.owner.open();
  await f.owner.assemble(f.input, f.options());
  expect(() => f.owner.rememberHelp("programs", { contract: "é".repeat(CONTEXT_WORKER_LIMITS.requestBytes / 4 + 1) })).toThrow();
});

test("request UTF-8 bytes and queued requests stay bounded", async () => {
  const f = fixture();
  await expect(f.owner.assemble({ ...f.input,
    pendingAuthoring: "é".repeat(CONTEXT_WORKER_LIMITS.requestBytes / 2) }, f.options()))
    .rejects.toMatchObject({ code: "backend_unavailable" });
  const pending: Promise<string>[] = [];
  for (let index = 0; index <= CONTEXT_WORKER_LIMITS.queued; index++) pending.push(f.owner.assemble(f.input, f.options()));
  const results = Promise.allSettled(pending);
  await expect(f.owner.assemble(f.input, f.options())).rejects.toMatchObject({ code: "backend_unavailable" });
  expect((await results).every(value => value.status === "fulfilled")).toBe(true);
});

for (const budget of ["context", "checkpoint"] as const) {
  test(`oversized ${budget} is rejected without acknowledging operations`, async () => {
    const f = fixture();
    await f.owner.assemble(f.input, f.options());
    f.owner.rememberHelp("programs", { contract: "BUDGET_FAILURE_HELP" });
    const checkpoint = StrategicContext.prototype.checkpoint;
    const restore = budget === "context"
      ? spyOn(StrategicContext.prototype, "assemble").mockImplementation(() => "é".repeat(CONTEXT_WORKER_LIMITS.contextBytes / 2 + 1))
      : spyOn(StrategicContext.prototype, "checkpoint").mockImplementation(function (this: StrategicContext) {
        return { ...checkpoint.call(this), knowledgeScope: "x".repeat(CONTEXT_WORKER_LIMITS.checkpointBytes + 1) };
      });
    cleanup.push(() => { restore.mockRestore(); });
    await expect(f.owner.assemble(f.input, f.options())).rejects.toMatchObject({ code: "backend_unavailable" });
    restore.mockRestore();
    await f.owner.close(); f.owner.open();
    expect(await f.owner.assemble(f.input, f.options())).toContain("BUDGET_FAILURE_HELP");
  });
}

test("invalid readonly bindings and expired Linux deadlines fail without a fallback", async () => {
  const f = fixture();
  const owner = new InlineCognitionContext({ ...f.store.readLocation(), projection: join(tmpdir(), "absent-context-fixture", "history.sqlite") });
  cleanup.push(() => owner.close());
  await expect(owner.assemble(f.input, { deadlineOsNs: -1n })).rejects.toMatchObject({ code: "backend_unavailable" });
  await expect(owner.assemble(f.input, { deadlineOsNs: 10n ** 24n - 1n })).rejects.toMatchObject({ code: "backend_unavailable" });
});

function custodyFixture() {
  const f = fixture(), custody = new CognitionContextCustody();
  let nextAssembly = 0;
  function replacement(run = f.run) {
    const lease = {};
    let sequence = 0, active: string | null = null, current = true;
    const transfer = (kind: "journal" | "assembled" | "closed", state: PassiveContextState) => {
      // Exercise the actual bounded transport shape, not shared object identity.
      const body: unknown = JSON.parse(JSON.stringify({ sequence: ++sequence, kind,
        context_id: kind === "assembled" ? active : null, state }));
      custody.accept(lease, body, active, current);
    };
    const owner = new InlineCognitionContext(f.store.readLocation(), () => f.clock.value, async (state, deadline, signal) => {
      if (signal?.aborted || f.clock.value >= deadline) throw new Error("Original deadline expired");
      transfer("assembled", state);
    });
    owner.restore(JSON.parse(JSON.stringify(custody.acquire(lease, run.run_id))));
    owner.open();
    cleanup.push(() => owner.close());
    return {
      owner,
      async assemble(input = { ...f.input, scope: strategicContextScope(run) }, options = f.options()) {
        active = `custody-assembly-${++nextAssembly}`;
        transfer("journal", owner.capture());
        let successful = false;
        try {
          const result = await owner.assemble(input, options);
          successful = true; return result;
        } finally {
          custody.settle(lease, active, successful, current && f.clock.value < options.deadlineOsNs);
          active = null; transfer("journal", owner.capture());
        }
      },
      async close() {
        current = false;
        await owner.close();
        transfer("closed", owner.capture());
        custody.release(lease);
      },
      async die() {
        current = false; custody.release(lease);
        await owner.close();
      },
    };
  }
  return { ...f, custody, replacement };
}

test("host custody preserves requested help and explicit non-catalog source through serialized owner replacement", async () => {
  const f = custodyFixture(), program = await source(f.store, f.run);
  for (let index = 0; index < 4; index++) await source(f.store, f.run, `Recent passive reference ${index}`);
  const first = f.replacement();
  expect(await first.assemble()).not.toContain(program.hash);
  first.owner.rememberHelp("programs", { contract: "HOST_COMMITTED_HELP" });
  first.owner.selectProgram(program.name, program.version);
  const before = await first.assemble();
  expect(before).toContain("HOST_COMMITTED_HELP"); expect(before).toContain(program.hash);
  await first.close();
  const second = f.replacement();
  expect(second.owner).not.toBe(first.owner);
  expect(await second.assemble()).toBe(before);
  await second.close();
  expect(f.custody.status()).toEqual({ uncommitted_custody: "none" });
});

test("failed real reducer assembly transfers ordered queued knowledge without acknowledging changed scope", async () => {
  const f = custodyFixture(), program = await source(f.store, f.run), first = f.replacement();
  await first.assemble();
  first.owner.rememberHelp("programs", { contract: "FIRST_QUEUED_HELP" });
  first.owner.rememberHelp("programs", { contract: "LAST_QUEUED_HELP" });
  first.owner.selectProgram(program.name, program.version);
  const before = first.owner.capture().checkpoint;
  const original = StrategicContext.prototype.assemble;
  const assembly = spyOn(StrategicContext.prototype, "assemble").mockImplementation(function (this: StrategicContext, run, adapter, pending) {
    const result = original.call(this, run, adapter, pending);
    f.clock.value += 5_000_000_000n; return result;
  });
  cleanup.push(() => { assembly.mockRestore(); });
  await expect(first.assemble({ ...f.input, scope: { ...f.input.scope, task: "UNCOMMITTED_SCOPE" } }))
    .rejects.toMatchObject({ code: "backend_unavailable" });
  assembly.mockRestore();
  expect(first.owner.capture().checkpoint).toBe(before);
  expect(first.owner.capture().operations.map(operation => operation.kind)).toEqual(["help", "help", "select"]);
  await first.close();
  const second = f.replacement(), result = await second.assemble();
  expect(result).toContain("LAST_QUEUED_HELP"); expect(result).not.toContain("FIRST_QUEUED_HELP");
  expect(result).toContain(program.hash); expect(result).not.toContain("UNCOMMITTED_SCOPE");
  expect(second.owner.capture().operations).toEqual([]);
  await second.close();
});

test("new-run custody and explicit reset discard retained help and unacknowledged selections", async () => {
  const f = custodyFixture(), first = f.replacement();
  await first.assemble();
  first.owner.rememberHelp("programs", { contract: "PREVIOUS_RUN_HELP" });
  await first.assemble();
  first.owner.rememberHelp("programs", { contract: "PREVIOUS_RUN_QUEUED_HELP" });
  await first.close();
  f.custody.reset();
  const second = f.replacement();
  expect(second.owner.capture()).toEqual({ v: 1, checkpoint: null, operations: [] });
  expect(await second.assemble()).not.toContain("PREVIOUS_RUN");
  second.owner.rememberHelp("programs", { contract: "REPLACED_RUN_HELP" });
  await second.close();
  const nextRun = { ...f.run, run_id: "different-context-run" };
  f.store.saveRun(nextRun);
  const third = f.replacement(nextRun);
  expect(third.owner.capture()).toEqual({ v: 1, checkpoint: null, operations: [] });
  expect(await third.assemble()).not.toContain("REPLACED_RUN_HELP");
  await third.close();
});

test("replacement synchronizes actual model, profile and task compatibility before restoring knowledge", async () => {
  const f = custodyFixture(), program = await source(f.store, f.run), first = f.replacement();
  await first.assemble();
  first.owner.rememberHelp("programs", { contract: "COMPATIBILITY_HELP" });
  first.owner.selectProgram(program.name, program.version);
  await first.assemble(); await first.close();
  const second = f.replacement();
  const model = { api: "different-api", provider: "different-provider" };
  const modelChanged = await second.assemble({ ...f.input, model });
  expect(modelChanged).not.toContain("COMPATIBILITY_HELP");
  expect(modelChanged).toContain(program.hash); // Transport changes do not invalidate source.
  second.owner.rememberHelp("programs", { contract: "PROFILE_BOUND_HELP" });
  await second.assemble({ ...f.input, model }); await second.close();
  const third = f.replacement();
  const profiled = { ...f.input, model, observation: { profile_id: "new-profile", profile_configuration_hash: "new-profile-hash" } };
  const profileChanged = await third.assemble(profiled);
  expect(profileChanged).not.toContain("PROFILE_BOUND_HELP"); expect(profileChanged).not.toContain(program.hash);
  await third.close();
  const fourth = f.replacement();
  const taskChanged = await fourth.assemble({ ...profiled, scope: { ...f.input.scope, task: "Fresh passive reference task" } });
  expect(taskChanged).not.toContain(program.hash);
  await fourth.close();
});

test("dead owner preserves last host commit and exposes unknown uncommitted custody without accepting late transfer", async () => {
  const f = custodyFixture(), first = f.replacement();
  await first.assemble();
  first.owner.rememberHelp("programs", { contract: "COMMITTED_BEFORE_DEATH" });
  await first.assemble();
  first.owner.rememberHelp("programs", { contract: "UNTRANSFERRED_BEFORE_DEATH" });
  await first.die();
  expect(f.custody.status()).toEqual({ uncommitted_custody: "unknown" });
  const second = f.replacement(), recovered = await second.assemble();
  expect(recovered).toContain("COMMITTED_BEFORE_DEATH"); expect(recovered).not.toContain("UNTRANSFERRED_BEFORE_DEATH");
  await second.close();
  expect(f.custody.status()).toEqual({ uncommitted_custody: "unknown" });
});

test("custody refuses stale owners, reordered journals and non-current assembly commits atomically", async () => {
  const f = fixture(), custody = new CognitionContextCustody(), first = {}, second = {};
  await f.owner.assemble(f.input, f.options());
  custody.acquire(first, f.run.run_id);
  const state = f.owner.capture();
  const commit = { sequence: 1, kind: "assembled", context_id: "original-assembly", state };
  expect(() => custody.accept(first, commit, "original-assembly", false)).toThrow();
  expect(() => custody.accept(first, commit, "replacement-assembly", true)).toThrow();
  expect(() => custody.accept(first, { ...commit, sequence: 2 }, "original-assembly", true)).toThrow();
  custody.accept(first, commit, "original-assembly", true);
  custody.settle(first, "original-assembly", true, true);
  const operation = { kind: "help" as const, topic: "programs", value: { contract: "UNACKNOWLEDGED" } };
  custody.accept(first, { sequence: 2, kind: "journal", context_id: null, state: { ...state, operations: [operation] } }, null, false);
  expect(() => custody.accept(first, { sequence: 3, kind: "journal", context_id: null, state }, null, false)).toThrow();
  expect(() => custody.reset()).toThrow();
  custody.release(first);
  const restored = custody.acquire(second, f.run.run_id);
  expect(restored.operations).toEqual([operation]); expect(restored.checkpoint).toBe(state.checkpoint);
  expect(() => custody.accept(first, { sequence: 3, kind: "assembled", context_id: "late", state }, "late", true)).toThrow();
  expect(() => custody.accept(second, { sequence: 1, kind: "closed", context_id: null,
    state: { ...restored, checkpoint: null } }, null, false)).toThrow();
  custody.accept(second, { sequence: 1, kind: "closed", context_id: null, state: restored }, null, false);
  custody.release(second);
});

test("bounded corrupt custody is refused atomically and cannot restore an observation, effect permit or old PASS", async () => {
  const f = fixture();
  await f.owner.assemble(f.input, f.options());
  const valid = f.owner.capture(), checkpoint = parseContextCheckpoint(valid.checkpoint!);
  const replacement = new InlineCognitionContext(f.store.readLocation(), () => f.clock.value);
  cleanup.push(() => replacement.close());
  for (const corrupt of [
    { ...valid, checkpoint: "é".repeat(CONTEXT_WORKER_LIMITS.checkpointBytes / 2 + 1) },
    { ...valid, checkpoint: JSON.stringify({ ...checkpoint, selected: [{ name: "broken", version: -1 }] }) },
    { ...valid, checkpoint: JSON.stringify({ ...checkpoint, helpSchemas: [0] }) },
    { ...valid, checkpoint: JSON.stringify({ ...checkpoint, authoredState: { author: "model", gameplay_success_proof: true } }) },
    { ...valid, checkpoint: JSON.stringify({ ...checkpoint, observation: { authoritative: true } }) },
    { ...valid, checkpoint: JSON.stringify({ ...checkpoint, native_permit: "OLD_PASS" }) },
    { ...valid, operations: Array.from({ length: CONTEXT_WORKER_LIMITS.operations + 1 }, () => ({ kind: "select", name: "too-many", version: 1 })) },
    { ...valid, operations: [{ kind: "help", topic: "programs", value: "é".repeat(CONTEXT_WORKER_LIMITS.requestBytes / 4 + 1) }] },
  ]) {
    expect(() => replacement.restore(corrupt)).toThrow();
    expect(replacement.capture()).toEqual({ v: 1, checkpoint: null, operations: [] });
  }
  checkpoint.authoredState.latest_root_result = { event_seq: checkpoint.cursor, status: "completed", summary: "HISTORICAL_PASS_ONLY", result: null };
  replacement.restore(parsePassiveContextState({ ...valid, checkpoint: JSON.stringify(checkpoint) }));
  replacement.open();
  const context = JSON.parse(await replacement.assemble(f.input, f.options())).strategic_context;
  expect(context.authored_state.latest_root_result.summary).toBe("HISTORICAL_PASS_ONLY");
  expect(context.authored_state.gameplay_success_proof).toBe(false);
  expect(context.authored_controller_events.current_authority).toBe(false);
  expect(context.historical_authored_state.current_authority).toBe(false);
  expect(context).not.toHaveProperty("observation"); expect(context).not.toHaveProperty("native_permit");
  expect(context).not.toHaveProperty("pass"); expect(context).not.toHaveProperty("effect_authority");
});

test("custody transfer wait consumes the original deadline and rejects uncommitted operations without renewing it", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>();
  const custody = new CognitionContextCustody(), lease = {};
  const restored = custody.acquire(lease, f.run.run_id);
  let entered = false;
  const owner = new InlineCognitionContext(f.store.readLocation(), () => f.clock.value, async state => {
    custody.accept(lease, { sequence: 2, kind: "assembled", context_id: "transfer-deadline", state }, "transfer-deadline", true);
    entered = true; await gate.promise;
  });
  cleanup.push(() => owner.close());
  owner.restore(restored); owner.open();
  owner.rememberHelp("programs", { contract: "TRANSFER_DEADLINE_HELP" });
  custody.accept(lease, { sequence: 1, kind: "journal", context_id: null, state: owner.capture() }, null, false);
  const result = owner.assemble(f.input, { deadlineOsNs: f.clock.value + 100n });
  const settled = Promise.allSettled([result]);
  await Promise.resolve();
  expect(entered).toBe(true);
  f.clock.value += 100n;
  const closing = owner.close();
  let drained = false;
  void closing.then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  gate.resolve();
  expect((await settled)[0]?.status).toBe("rejected");
  await closing;
  expect(owner.capture().checkpoint).toBe(null);
  expect(owner.capture().operations).toEqual([{ kind: "help", topic: "programs", value: { contract: "TRANSFER_DEADLINE_HELP" } }]);
  custody.settle(lease, "transfer-deadline", false, false);
  custody.accept(lease, { sequence: 3, kind: "closed", context_id: null, state: owner.capture() }, null, false);
  custody.release(lease);
  const replacement = {};
  expect(custody.acquire(replacement, f.run.run_id)).toEqual(owner.capture());
  custody.release(replacement);
});

test("actual joined context processes retain committed help, explicit source and queued knowledge across replacement", async () => {
  const f = fixture(), custody = new CognitionContextCustody(), program = await source(f.store, f.run);
  for (let index = 0; index < 4; index++) await source(f.store, f.run, `Process catalog reference ${index}`);
  let nextId = 0;
  async function open() {
    const lease = {}, drained = Promise.withResolvers<number | null>();
    const child = spawn(process.execPath, ["--no-env-file",
      fileURLToPath(new URL("./helpers/cognition-context-custody.fixture.ts", import.meta.url))],
    { stdio: ["pipe", "pipe", "ignore"] });
    child.once("close", code => drained.resolve(code));
    let active: string | null = null, deadline = 0n, stopped = false;
    const wire = new CognitionWire(child.stdout!, child.stdin!, (method, body) => {
      if (method === "context_end") {
        const input = body as { id: string; successful: boolean };
        if (input.id !== active) throw new Error("Different passive assembly");
        custody.settle(lease, input.id, input.successful, !stopped && osMonotonicNs() < deadline);
        return null;
      }
      if (method !== "context_custody") throw new Error("Only passive custody is available");
      custody.accept(lease, body, active, !stopped && active !== null && osMonotonicNs() < deadline);
      return null;
    }, () => {});
    child.once("error", () => wire.fail());
    cleanup.push(async () => {
      stopped = true; child.kill("SIGKILL"); wire.fail();
      await drained.promise; custody.release(lease);
    });
    const result = await wire.call<{ pid: number }>("start", {
      location: f.store.readLocation(), state: custody.acquire(lease, f.run.run_id),
    });
    expect(child.pid).toBe(result.pid); expect(result.pid).not.toBe(process.pid);
    return {
      pid: result.pid,
      async assemble() {
        active = `process-context-${++nextId}`; deadline = osMonotonicNs() + 5_000_000_000n;
        try { return await wire.call<string>("assemble", { input: f.input, id: active, deadline_os_ns: deadline.toString() }); }
        finally { active = null; }
      },
      async remember(topic: string, marker: string) {
        await wire.call("remember", { topic, value: { contract: marker }, source: { name: program.name, version: program.version } });
      },
      async close() {
        stopped = true;
        await wire.call("close", null); wire.end();
        expect(await drained.promise).toBe(0);
        custody.release(lease);
      },
    };
  }
  const first = await open();
  expect(await first.assemble()).not.toContain(program.hash);
  await first.remember("programs", "REAL_PROCESS_COMMITTED_HELP");
  const before = await first.assemble();
  expect(before).toContain("REAL_PROCESS_COMMITTED_HELP"); expect(before).toContain(program.hash);
  await first.remember("controller", "REAL_PROCESS_QUEUED_HELP");
  await first.close();
  const second = await open();
  expect(second.pid).not.toBe(first.pid);
  const after = await second.assemble();
  expect(after).toContain("REAL_PROCESS_COMMITTED_HELP"); expect(after).toContain("REAL_PROCESS_QUEUED_HELP");
  expect(after).toContain(program.hash);
  await second.close();
  expect(custody.status()).toEqual({ uncommitted_custody: "none" });
});
