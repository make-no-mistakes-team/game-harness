import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { GameActionResult, Json, ObservationV3 } from "../src/shared/contracts.ts";
import type {
  SkillLimits,
  SkillRef,
  SkillResult,
} from "../src/shared/programs.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { SkillManager, type SkillHost } from "../src/server/skills.ts";
import {
  SkillCleanupError,
  type SandboxService,
} from "../src/server/sandbox.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { instrumentProgram, ProgramTraceReceiver } from "../src/server/program-instrumentation.ts";
import { DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { ModelProgramEvidence } from "../src/evaluation/model-evidence.ts";
import { capabilityFailure } from "../src/server/program-diagnostics.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const adapter = minecraftTestAdapter();

const resources: { directory: string; store: Store; manager: SkillManager }[] =
  [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.manager.closeAll("Test complete").catch(() => {});
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});
function deferred<T>() {
  return Promise.withResolvers<T>();
}
const completed: SkillResult = {
  status: "completed",
  summary: "Measured fixture finished",
  result: null,
};
const success: GameActionResult = {
  status: "succeeded",
  summary: "Confirmed bounded fixture action",
  evidence: { effect_confirmed: true },
};
type Runner = SandboxService["runSkill"];
// Real generated-worker protocol, without claiming Docker isolation or starting
// an external service. Only the transport below SkillManager is substituted.
const generatedWorker: Runner = async (source, args, handle, _limits, signal, hooks) => {
  const program = instrumentProgram(source);
  const receiver = new ProgramTraceReceiver(program);
  hooks?.onInstrumentation?.(program);
  const worker = new Worker(new URL("../sandbox/worker.mjs", import.meta.url), {
    workerData: { mode: "skill", source: program.execution_source, source_hash: program.source_hash, args,
      api: hooks!.api,
      instrumentation: { hook_name: program.hook_name, scope: program.scope,
        kinds: program.points.map(point => point.kind) } },
    stdout: true, stderr: true,
  });
  const done = Promise.withResolvers<SkillResult>();
  const watchdog = AbortSignal.timeout(3000);
  const expired = () => done.reject(new Error("Generated worker did not complete its protocol"));
  watchdog.addEventListener("abort", expired, { once: true });
  signal?.addEventListener("abort", expired, { once: true });
  worker.on("error", done.reject);
  worker.on("exit", code => done.reject(new Error(`Generated worker exited before completion: ${code}`)));
  worker.on("message", (encoded: string) => {
    void (async () => {
      const frame = JSON.parse(encoded);
      hooks?.onTrace?.(receiver.accept(frame.trace));
      if (frame.type === "skill_call") {
        try {
          const value = await handle(frame.request);
          worker.postMessage({ v: 1, type: "skill_reply", id: frame.id, ok: true, value });
        } catch (error) {
          // Match the existing bounded public sandbox reply; never forward the
          // host exception or its stack to generated code.
          const failure = capabilityFailure(error);
          worker.postMessage({ v: 1, type: "skill_reply", id: frame.id, ok: false, error: failure });
        }
      } else if (frame.type === "skill_result") {
        receiver.finish(null);
        done.resolve(frame.result);
      } else done.reject(new Error("Generated worker failed instead of handling capability rejection"));
    })().catch(done.reject);
  });
  try {
    return await done.promise;
  } finally {
    watchdog.removeEventListener("abort", expired);
    signal?.removeEventListener("abort", expired);
    await worker.terminate();
  }
};
function authorizedObservation(): ObservationV3 {
  return minecraftObservationFixture(adapter, { session_id: "fixture-session", world_id: "fixture-world" });
}
function fixture(runner: Runner, overrides: Partial<SkillHost> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-skills-"));
  const store = new Store(directory);
  const run = minecraftRunFixture(adapter, { world_id: "fixture-world", session_id: "fixture-session", task: "Measure bounded neutral capabilities" });
  store.saveRun(run);
  let unsafe = 0;
  const host: SkillHost = {
    authorize: context => {
      if (
        context.run_id !== run.run_id || context.world_id !== run.world_id ||
        context.epoch !== run.epoch || context.session_id !== run.session_id ||
        context.native_boot_id !== run.native_boot_id || context.life_id !== run.life_id ||
        context.space_epoch !== run.space_epoch || context.run_generation !== 1 ||
        run.status !== "running"
      )
        throw new Error("Authority revoked");
    },
    adapter: () => adapter,
    binding: () => minecraftTestBinding(adapter),
    observe: async () => authorizedObservation(),
    action: async () => success,
    queryCapability: async () => [],
    recover: async () => { throw new Error("No respawn in this fixture"); },
    cancelActions: async () => {},
    changed: () => {},
    unsafe: () => {
      unsafe++;
    },
    ...overrides,
  };
  const manager = new SkillManager(store, { runSkill: runner }, host);
  resources.push({ directory, store, manager });
  return { directory, store, run, manager, unsafe: () => unsafe };
}
const card = {
  purpose: "Exercise the public program lifecycle",
  applicability: "Deterministic isolated test",
  method: "Use bounded neutral capabilities",
  reason: "Prove lifecycle contracts",
  limitations: "No gameplay effectiveness claim",
};
async function register(
  manager: SkillManager,
  runId: string,
  name = "fixture",
  dependencies: SkillRef[] = [],
) {
  const view = await manager.register(runId, {
    name,
    source:
      'return {status:"completed",summary:"Fixture complete",result:null};',
    card,
    dependencies,
  });
  return { skill_id: view.skill_id, version: view.version };
}
function closed(
  store: Store,
  runId: string,
  executionId: string,
): Promise<void> {
  const isClosed = () =>
    ["succeeded", "blocked", "failed", "cancelled", "unknown"].includes(
      store.skillExecution(runId, { execution_id: executionId })!.status,
    );
  if (isClosed()) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe((event) => {
    if (event.run_id === runId && event.type === "skill.closed" && isClosed()) {
      unsubscribe();
      resolve();
    }
  });
  return promise;
}
function start(
  run: StoredRun,
  skill: SkillRef,
  start_key: string,
  args: Json = null,
  limits: SkillLimits = { ...DEFAULT_SKILL_LIMITS },
) {
  return {
    skill_id: skill.skill_id,
    version: skill.version,
    start_key,
    ...executionScopeFixture(run),
    args,
    limits,
  };
}

describe("durable program execution through host capabilities", () => {
  test("caught trusted capability failures survive successful real-worker execution in the finalized correlated private journal", async () => {
    const trusted = new RuntimeFault("precondition_failed", "Observation is not available in the current life");
    trusted.stack = "HOST_STACK_SECRET at /private/host/trusted-capability.ts:42";
    const arbitrary = new Error("HOST_MESSAGE_SECRET /private/host/credentials.json");
    arbitrary.stack = "HOST_STACK_SECRET at /private/host/backend.ts:99";
    const { directory, store, run, manager } = fixture(generatedWorker, {
      observe: async () => { throw trusted; },
      queryCapability: async () => { throw arbitrary; },
    });
    const stops: string[] = [];
    const observer = new ModelProgramEvidence(store, directory, DEFAULT_EVALUATION_CAPS,
      "test-host-clock", (_runId, reason) => { stops.push(reason); });
    try {
      const skill = await manager.register(run.run_id, {
        name: "caught capability failures", card, dependencies: [],
        source: `
let handled = 0;
try { await game.observe(); }
catch (error) {
  if (error.code !== "precondition_failed" || error.message !== "Observation is not available in the current life") throw error;
  handled++;
}
try { await game.recipes("crafting_table"); }
catch (error) {
  if (error.code !== "backend_unavailable" || error.message !== "Trusted capability could not complete safely") throw error;
  handled++;
}
return {status:"completed", summary:"Continued after two safely handled rejections", result:{handled}};
`,
      });
      const accepted = manager.start(run.run_id, start(run, skill, "caught-private-evidence"));
      await closed(store, run.run_id, accepted.execution_id);
      const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
      expect(outcome).toMatchObject({ status: "succeeded", result: {
        status: "completed", result: { handled: 2 },
      } });
      expect(outcome).not.toHaveProperty("diagnostic");
      const finalized = await observer.finalize(run.run_id, { status: "completed", reason: "caught_rejections" });
      expect(finalized.evidence_complete).toBe(true);
      expect(stops).toEqual([]);
      const journal = readFileSync(join(directory, finalized.journal), "utf8");
      const traces = journal.trim().split("\n").map(line => JSON.parse(line))
        .filter(record => record.kind === "authorized_execution_evidence_before_trace_caps")
        .map(record => record.value);
      const requests = traces.filter(trace => trace.kind === "capability_request");
      const failures = traces.filter(trace => trace.kind === "capability_result" && trace.payload.ok === false);
      expect(requests).toHaveLength(2);
      expect(failures).toHaveLength(2);
      for (const [index, expected] of [
        { code: "precondition_failed", message: "Observation is not available in the current life" },
        { code: "backend_unavailable", message: "Trusted capability could not complete safely" },
      ].entries()) {
        expect(failures[index]).toMatchObject({
          run_id: run.run_id, execution_id: accepted.execution_id, root_execution_id: accepted.execution_id,
          hash: skill.hash, session_id: run.session_id, life_id: run.life_id,
          call_id: requests[index].call_id, capability: requests[index].capability,
          payload: { ok: false, result: expected },
        });
        expect(typeof failures[index].call_id).toBe("string");
        expect(failures[index].call_id.length).toBeGreaterThan(0);
      }
      expect(failures[0].call_id).not.toBe(failures[1].call_id);
      for (const secret of ["HOST_STACK_SECRET", "HOST_MESSAGE_SECRET", "/private/host/", "node:internal"])
        expect(journal).not.toContain(secret);
    } finally {
      await observer.close();
    }
  });

  test("trusted capability diagnostics survive failure cleanup, durable inspection and skill outcome evidence", async () => {
    const { store, run, manager } = fixture(async (_source, _args, handle) => {
      await handle({ kind: "observe" });
      return completed;
    }, { observe: async () => { throw new RuntimeFault("precondition_failed", "Observation is not available in the current life"); } });
    const skill = await register(manager, run.run_id, "diagnostic reader");
    const accepted = manager.start(run.run_id, start(run, skill, "diagnostic-reader"));
    await closed(store, run.run_id, accepted.execution_id);
    const outcome = manager.get(run.run_id, { execution_id: accepted.execution_id })!;
    expect(outcome.status).toBe("failed");
    const inspected = new ProgramWorkspace(store, run.run_id).executionView(outcome);
    expect(inspected).toMatchObject({ diagnostic: {
      code: "precondition_failed", message: "Observation is not available in the current life",
      source_hash: store.skill(run.run_id, skill).hash,
    } });
    const event = store.eventsAfter(run.run_id, 0, 500).find(event => event.type === "skill.closed");
    expect(JSON.stringify(event?.details)).toContain("Observation is not available in the current life");
    expect(JSON.stringify(inspected)).not.toContain("skills.ts");
    expect(JSON.stringify(inspected)).not.toContain("node:internal");
  });

  test("safely failed leaf actions and blocked children remain structured results the parent can handle", async () => {
    let child: SkillRef,
      actions = 0,
      observations = 0;
    const runner: Runner = async (
      _source,
      args,
      handle,
    ): Promise<SkillResult> => {
      if (args === "blocked-child")
        return {
          status: "blocked",
          summary: "A real precondition is absent",
          result: { missing: "fixture-condition" },
        };
      const failed = await handle({
        kind: "action",
        action: { kind: "look", yaw: 0, pitch: 0 },
      });
      await handle({ kind: "observe" });
      const corrected = await handle({
        kind: "action",
        action: { kind: "look", yaw: 0.1, pitch: 0 },
      });
      const blocked = await handle({
        kind: "call",
        skill: { name: "blocked-child", version: child.version },
        args: "blocked-child",
      });
      return {
        status: "completed",
        summary: "Handled actual outcomes in program",
        result: { failed, corrected, blocked },
      };
    };
    const { store, run, manager } = fixture(runner, {
      action: async () =>
        ++actions === 1
          ? {
              status: "failed",
              summary: "Safely settled fixture refusal",
              evidence: { effect_confirmed: false },
            }
          : success,
      observe: async () => {
        observations++;
        return authorizedObservation();
      },
    });
    child = await register(manager, run.run_id, "blocked-child");
    const root = await register(manager, run.run_id, "handles-results", [
      child,
    ]);
    const accepted = manager.start(run.run_id, start(run, root, "recoverable"));
    await closed(store, run.run_id, accepted.execution_id);
    const outcome = manager.get(run.run_id, {
      execution_id: accepted.execution_id,
    })!;
    expect(outcome.status).toBe("succeeded");
    expect(actions).toBe(2);
    expect(observations).toBe(1);
    expect(outcome.result?.result).toEqual({
      failed: {
        status: "failed",
        summary: "Safely settled fixture refusal",
        evidence: { effect_confirmed: false },
      },
      corrected: {
        status: "succeeded",
        summary: "Confirmed bounded fixture action",
        evidence: { effect_confirmed: true },
      },
      blocked: {
        status: "blocked",
        summary: "A real precondition is absent",
        result: { missing: "fixture-condition" },
      },
    });
  });

  test("unknown leaf effects fence the root before another action can be issued", async () => {
    let actions = 0;
    const { store, run, manager } = fixture(
      async (_source, _args, handle) => {
        try {
          await handle({
            kind: "action",
            action: { kind: "look", yaw: 0, pitch: 0 },
          });
        } catch {}
        await handle({
          kind: "action",
          action: { kind: "look", yaw: 0.1, pitch: 0 },
        });
        return completed;
      },
      {
        action: async () => {
          actions++;
          return {
            status: "unknown",
            summary: "Actual effect is uncertain",
            evidence: null,
            requires_reconnect: true,
          };
        },
      },
    );
    const skill = await register(manager, run.run_id);
    const accepted = manager.start(
      run.run_id,
      start(run, skill, "unknown-effect"),
    );
    await closed(store, run.run_id, accepted.execution_id);
    expect(actions).toBe(1);
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("unknown");
  });

  test("lost acknowledgement returns the original identity before renewed authority and never dispatches twice", async () => {
    let invocations = 0;
    const entered = deferred<void>(),
      release = deferred<void>();
    const { store, run, manager } = fixture(async () => {
      invocations++;
      entered.resolve();
      await release.promise;
      return completed;
    });
    const skill = await register(manager, run.run_id);
    const request = start(run, skill, "stable-start");
    const accepted = manager.start(run.run_id, request);
    await entered.promise;
    run.status = "paused";
    run.epoch = 2;
    store.saveRun(run);
    const retry = manager.start(run.run_id, request);
    expect(retry.execution_id).toBe(accepted.execution_id);
    expect(invocations).toBe(1);
    expect(() =>
      manager.start(run.run_id, { ...request, args: { changed: true } }),
    ).toThrow();
    manager.fence("Paused");
    release.resolve();
    await manager.closeAll("Paused");
    expect(
      store.skillExecution(run.run_id, { start_key: "stable-start" })?.status,
    ).toBe("cancelled");
  });

  test("composition shares root action and host-call budgets rather than resetting at each child", async () => {
    let child: SkillRef;
    let observed = 0,
      actions = 0;
    const runner: Runner = async (_source, args, handle) => {
      if (args === "child") {
        await handle({
          kind: "action",
          action: { kind: "look", yaw: 0, pitch: 0 },
        });
        await handle({ kind: "observe" });
      } else {
        await handle({ kind: "call", skill: { name: "child", version: child.version }, args: "child" });
        await handle({ kind: "call", skill: { name: "child", version: child.version }, args: "child" });
      }
      return completed;
    };
    const { store, run, manager } = fixture(runner, {
      observe: async () => {
        observed++;
        return authorizedObservation();
      },
      action: async () => {
        actions++;
        return success;
      },
    });
    child = await register(manager, run.run_id, "child");
    const root = await register(manager, run.run_id, "root", [child]);
    const accepted = manager.start(
      run.run_id,
      start(run, root, "aggregate", null, {
        duration_ms: 10000,
        max_actions: 10,
        max_calls: 5,
        max_depth: 3,
      }),
    );
    await closed(store, run.run_id, accepted.execution_id);
    const result = manager.get(run.run_id, {
      execution_id: accepted.execution_id,
    })!;
    expect(result.calls).toBe(5);
    expect(result.actions).toBe(2);
    expect(actions).toBe(2);
    expect(observed).toBe(1);
    expect(result.status).not.toBe("succeeded");
    for (const execution of store.skillExecutions(run.run_id)) {
      expect(execution.deadline_at).toBe(result.deadline_at);
      expect(execution.root_execution_id).toBe(result.execution_id);
    }
  });

  test("an undeclared named dependency cannot acquire a child execution", async () => {
    let dependency: SkillRef;
    const { store, run, manager } = fixture(async (_source, _args, handle) => {
      await handle({ kind: "call", skill: { name: "not-declared", version: dependency.version }, args: null });
      return completed;
    });
    dependency = await register(manager, run.run_id, "not-declared");
    const root = await register(manager, run.run_id, "root");
    const accepted = manager.start(run.run_id, start(run, root, "undeclared"));
    await closed(store, run.run_id, accepted.execution_id);
    expect(store.skillExecutions(run.run_id)).toHaveLength(1);
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("failed");
  });

  test("cancellation fences immediately but terminal acknowledgement waits for confirmed leaf shutdown", async () => {
    const entered = deferred<void>(),
      leaf = deferred<GameActionResult>(),
      cleanup = deferred<void>();
    let actions = 0;
    const runner: Runner = async (_source, _args, handle, _limits, signal) => {
      const abort = Promise.withResolvers<never>();
      signal.addEventListener(
        "abort",
        () => abort.reject(new Error("Confirmed fixture worker closed")),
        { once: true },
      );
      return await Promise.race([
        (async () => {
          await handle({
            kind: "action",
            action: { kind: "look", yaw: 0, pitch: 0 },
          });
          return completed;
        })(),
        abort.promise,
      ]);
    };
    const { store, run, manager } = fixture(runner, {
      action: async () => {
        actions++;
        entered.resolve();
        return await leaf.promise;
      },
      cancelActions: async () => {
        await cleanup.promise;
      },
    });
    const skill = await register(manager, run.run_id);
    const accepted = manager.start(
      run.run_id,
      start(run, skill, "cancel-tree"),
    );
    await entered.promise;
    const response = manager.cancel(run.run_id, {
      execution_id: accepted.execution_id,
    });
    expect(response.status).toBe("cancel_requested");
    await Promise.resolve();
    await Promise.resolve();
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("cancel_requested");
    leaf.resolve({
      status: "cancelled",
      summary: "Emitter closed",
      evidence: { neutralized_effect: true },
    });
    cleanup.resolve();
    await manager.closeAll("Cancel settled");
    expect(
      manager.get(run.run_id, { execution_id: accepted.execution_id })?.status,
    ).toBe("cancelled");
    expect(actions).toBe(1);
    expect(manager.pending).toBe(false);
  });

  test("unconfirmed isolated cleanup remains unknown rather than a false cancelled success", async () => {
    const entered = deferred<void>();
    const { store, run, manager, unsafe } = fixture(
      async (_source, _args, _handle, _limits, signal) => {
        const abort = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => abort.resolve(), { once: true });
        entered.resolve();
        await abort.promise;
        throw new SkillCleanupError();
      },
    );
    const skill = await register(manager, run.run_id);
    const accepted = manager.start(
      run.run_id,
      start(run, skill, "unknown-cleanup"),
    );
    await entered.promise;
    manager.cancel(run.run_id, { execution_id: accepted.execution_id });
    await expect(manager.closeAll("Stop")).rejects.toBeInstanceOf(
      SkillCleanupError,
    );
    expect(
      store.skillExecution(run.run_id, { execution_id: accepted.execution_id })
        ?.status,
    ).toBe("unknown");
    expect(unsafe()).toBeGreaterThan(0);
  });
});
