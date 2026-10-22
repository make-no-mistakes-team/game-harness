import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameActionResult, Json, Observation } from "../src/shared/contracts.ts";
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
import { emptyRunUsage } from "../src/server/usage.ts";

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
function authorizedObservation(): Observation {
  return {
    schema_version: 2, session_id: "fixture-session", world_id: "fixture-world",
    epoch: 1, life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    observation_seq: 1, captured_at: new Date().toISOString(),
    profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false, inventory: [] },
    blocks: [], entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
  };
}
function fixture(runner: Runner, overrides: Partial<SkillHost> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-skills-"));
  const store = new Store(directory);
  const run: StoredRun = {
    run_id: crypto.randomUUID(),
    world_id: crypto.randomUUID(),
    epoch: 1,
    session_id: "fixture-session",
    life_id: 1,
    task: "Measure bounded neutral capabilities",
    goal: "custom",
    model_id: "fixture-model",
    status: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
    usage: emptyRunUsage(),
    baseline: {},
  };
  store.saveRun(run);
  let unsafe = 0;
  const host: SkillHost = {
    authorize: (runId, epoch) => {
      if (
        runId !== run.run_id ||
        epoch !== run.epoch ||
        run.status !== "running"
      )
        throw new Error("Authority revoked");
    },
    observe: async () => authorizedObservation(),
    action: async () => success,
    recipes: async () => [],
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
    epoch: run.epoch,
    session_id: run.session_id!,
    life_id: run.life_id!,
    args,
    limits,
  };
}

describe("durable program execution through host capabilities", () => {
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
