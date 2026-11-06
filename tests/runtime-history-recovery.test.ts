import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type {
  GameActionResult,
  GameBridge,
  GameState,
  Json,
} from "../src/shared/contracts.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { ExecutionTrace } from "../src/server/execution-trace.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store } from "../src/server/store.ts";
import {
  minecraftObservationFixture,
  minecraftTestAdapter,
  minecraftTestBinding,
} from "./helpers/adapter-contract.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const name = "Uncertain history root";
const card = {
  purpose: "Retain an uncertain outcome",
  applicability: "Controlled lifecycle fixture",
  method: "Await one bounded action",
  reason: "History admission recovery",
  limitations: "No gameplay claim",
};
async function fixture(unconfirmedBarrier = false) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-history-resume-")),
    store = new Store(directory);
  const adapter = minecraftTestAdapter();
  let sequence = 0,
    failObservation = false,
    failBarrier = unconfirmedBarrier,
    effects = 0,
    agents = 0;
  const observation = () =>
    minecraftObservationFixture(adapter, { observation_seq: ++sequence });
  const initial = observation();
  const state: GameState = {
    status: "connected",
    username: "Fixture",
    version: "1.21.4",
    world_id: initial.world_id,
    epoch: initial.epoch,
    session_id: initial.session_id,
    life: initial.life,
    binding: minecraftTestBinding(adapter),
    space: initial.space,
    screen: null,
    presentation: adapter.projectObservation(initial),
    last_observation_at: initial.captured_at,
    error: null,
    video: {
      status: "idle",
      width: 0,
      height: 0,
      fps: null,
      frames: 0,
      last_frame_at: null,
      error: null,
    },
  };
  const firstEffect = Promise.withResolvers<GameActionResult>(),
    effectEntered = Promise.withResolvers<void>();
  const barrierEntered = Promise.withResolvers<void>(),
    nativeBarrier = Promise.withResolvers<void>();
  const workerExit = Promise.withResolvers<void>(),
    workerDrained = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>(),
    review = Promise.withResolvers<AgentToolResult>();
  const failure = Promise.withResolvers<never>();
  let oldEffect: (() => Promise<Json>) | null = null;
  const game: GameBridge = {
    connect: async () => {},
    disconnect: async () => {},
    snapshot: () => state,
    observe: async () => {
      if (failObservation)
        throw new Error("Fresh fixture observation unavailable");
      return observation();
    },
    execute: async () => {
      effects++;
      effectEntered.resolve();
      return await firstEffect.promise;
    },
    cancel: async () => {},
    neutralize: async () => {},
    emergencyStop: async () => {
      barrierEntered.resolve();
      await nativeBarrier.promise;
      if (failBarrier)
        throw new Error("Native fixture drain remains unconfirmed");
    },
    adapter: () => adapter,
    subscribe: () => () => {},
  };
  let firstTools: AgentTool[] = [],
    freshTools: AgentTool[] = [];
  const auth = {
    snapshot: () => ({
      status: "ready",
      authenticated: true,
      provider: "openai-codex",
      account_label: null,
      models: [
        {
          id: "fixture-model",
          name: "Fixture",
          provider: "fixture",
          context_window: null,
        },
      ],
      login: null,
      error: null,
    }),
    createAgent: async (configuration: { tools: AgentTool[] }) => {
      const ordinal = ++agents;
      const revoked = Promise.withResolvers<void>();
      let tools = configuration.tools,
        pending: Promise<void> | null = null,
        prompted = false;
      const hooks = new DiagnosticModelHooks();
      const select = (value: AgentTool[]) => {
        tools = value;
        if (ordinal === 1) firstTools = value;
        else freshTools = value;
      };
      select(tools);
      const invoke = async (tool: string, input: unknown) => {
        const selected = tools.find((entry) => entry.name === tool);
        if (!selected)
          throw new Error(`Fixture requested unavailable tool ${tool}`);
        return await selected.execute(crypto.randomUUID(), input);
      };
      return {
        addBeforeModelCallHook: hooks.add,
        setBeforeModelCall: () => {},
        setTools: select,
        subscribe: () => () => {},
        replaceMessages: () => {},
        abort: () => revoked.resolve(),
        waitForIdle: async () => {
          await pending;
        },
        prompt: async () => {
          if (prompted) return;
          prompted = true;
          const work = (async () => {
            await hooks.run(undefined, { systemPrompt: [], messages: [], tools });
            if (ordinal === 1) {
              const written = await invoke("program_write", {
                name,
                source:
                  'const result = await game.action({kind:"look",yaw:0,pitch:0}); return {status:"blocked",summary:"Uncertain effect retained",result};',
                card,
                dependencies: [],
              });
              if (written.isError)
                throw new Error(JSON.stringify(written.details));
              const started = await invoke("program_run", {
                operation: "start",
                name,
                args: null,
                limits: DEFAULT_SKILL_LIMITS,
              });
              if (started.isError)
                throw new Error(JSON.stringify(started.details));
            } else {
              review.resolve(
                await invoke("program_review", {
                  name,
                  version: 1,
                  decision: "insufficient_evidence",
                  reason:
                    "The past effect remains unknown; this assessment does not authorize replay",
                }),
              );
              // Keep this external provider request owned until its real abort
              // boundary, rather than racing autonomous idle-turn scheduling.
              await revoked.promise;
            }
          })();
          pending = work;
          try {
            await work;
          } catch (error) {
            failure.reject(error);
            throw error;
          } finally {
            if (pending === work) pending = null;
          }
        },
      } as unknown as Agent;
    },
    releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = {
    snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    runSkill: async (_source, _args, handle) => {
      oldEffect = () =>
        handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } });
      try {
        await handle({
          kind: "action",
          action: { kind: "look", yaw: 0, pitch: 0 },
        });
        return {
          status: "blocked",
          summary: "Uncertain effect retained",
          result: null,
        };
      } finally {
        await workerExit.promise;
        workerDrained.resolve();
      }
    },
  } satisfies Pick<
    SandboxService,
    "snapshot" | "runSkill"
  > as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, {
    adapter,
  });
  cleanups.push(async () => {
    failBarrier = false;
    failObservation = false;
    nativeBarrier.resolve();
    workerExit.resolve();
    firstEffect.resolve({
      status: "cancelled",
      summary: "Fixture cleanup",
      evidence: null,
    });
    await runtime.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.initialize();
  const run = await runtime.createRun({
    task: "Recover effect-free history after uncertain work",
    model_id: "fixture-model",
    goal: adapter.goals.find((goal) => goal.goal_id === "custom")!,
  });
  store.subscribe((event) => {
    if (
      event.run_id === run.run_id &&
      event.type === "run.state" &&
      store.getRun(run.run_id)?.status === "paused"
    )
      paused.resolve();
  });
  const reached = async <T>(promise: Promise<T>) =>
    await Promise.race([promise, failure.promise]);
  await runtime.control(run.run_id, "start");
  await reached(effectEntered.promise);
  return {
    runtime,
    store,
    run,
    adapter,
    observation,
    review,
    reached,
    paused,
    barrierEntered,
    nativeBarrier,
    workerExit,
    workerDrained,
    counters: () => ({ agents, effects }),
    restoreObservation: () => {
      failObservation = false;
    },
    unknown: () => {
      failObservation = true;
      firstEffect.resolve({
        status: "unknown",
        summary: "Past effect remains uncertain",
        evidence: null,
      });
    },
    staleEffect: () => oldEffect!(),
    oldTools: () => firstTools,
    freshTools: () => freshTools,
  };
}

test("explicit Resume after drained uncertainty and failed observation restores real review preparation and eventless metric publication", async () => {
  const f = await fixture();
  const cancelledQuery = f.runtime.skillEvidence(f.run.run_id).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  f.unknown();
  await f.reached(f.barrierEntered.promise);
  expect(f.counters()).toEqual({ agents: 1, effects: 1 });
  f.nativeBarrier.resolve();
  f.workerExit.resolve();
  await f.reached(f.workerDrained.promise);
  await f.reached(f.paused.promise);
  expect(await cancelledQuery).toMatchObject({ error: { code: "cancelled" } });
  expect(f.runtime.snapshot()).toMatchObject({
    status: "paused",
    operator: { pause_cause: "safety" },
  });
  expect(f.store.allSkillExecutions(f.run.run_id)).toMatchObject([
    { status: "unknown" },
  ]);
  await expect(f.staleEffect()).rejects.toThrow();
  const oldReview = f
    .oldTools()
    .find((tool) => tool.name === "program_review")!;
  expect(
    (
      await oldReview.execute("old-review-after-pause", {
        name,
        version: 1,
        decision: "keep",
        reason: "Stale turn",
      })
    ).isError,
  ).toBe(true);

  f.restoreObservation();
  await f.runtime.control(f.run.run_id, "resume");
  const reviewed = await f.reached(f.review.promise);
  expect(reviewed.isError).not.toBe(true);
  expect(reviewed.details).toMatchObject({
    name,
    version: 1,
    decision: "insufficient_evidence",
  });
  expect(f.runtime.snapshot()).toMatchObject({
    status: "running",
    error: null,
  });
  expect(f.counters()).toEqual({ agents: 2, effects: 1 });
  expect(
    (
      await oldReview.execute("old-review-after-resume", {
        name,
        version: 1,
        decision: "keep",
        reason: "Still stale",
      })
    ).isError,
  ).toBe(true);

  const before = await f.runtime.historyQueries.query(
    {
      kind: "operator_feedback",
      run_id: f.run.run_id,
      after: {
        schema_version: 2,
        opportunity_change_seq: 0,
        metric_change_seq: 0,
        scope_hash: null,
      },
      limit: 100,
    },
    { deadlineHostMs: performance.now() + 10_000 },
  );
  const execution = f.store.allSkillExecutions(f.run.run_id)[0]!;
  const baselineUpdate = before.metrics
    .filter((item) => item.execution_id === execution.execution_id)
    .at(-1);
  if (baselineUpdate?.kind !== "replace")
    throw new Error("The retained execution must have a baseline replacement");
  const baseline = baselineUpdate.metric;
  const published = Promise.withResolvers<void>(),
    commit = f.store.commitHistoryProjectionBatch.bind(f.store);
  let through = Number.POSITIVE_INFINITY;
  const spy = vi
    .spyOn(f.store, "commitHistoryProjectionBatch")
    .mockImplementation((runId, batch) => {
      commit(runId, batch);
      if (
        runId === f.run.run_id &&
        batch.after.phase === "idle" &&
        batch.after.source_through >= through
      )
        published.resolve();
    });
  try {
    const eventsBefore = f.store.lastEventSeq();
    const trace = new ExecutionTrace(f.store);
    trace.span(execution, "sandbox", 100, 107);
    through = f.store.historySourceHighwater(f.run.run_id);
    expect(f.store.lastEventSeq()).toBe(eventsBefore);
    await f.reached(published.promise);
    expect(
      f.store.historyProjectionGeneration(f.run.run_id)!.source_through,
    ).toBeGreaterThanOrEqual(through);
    const after = await f.runtime.historyQueries.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: before.next_after,
        limit: 100,
      },
      { deadlineHostMs: performance.now() + 10_000 },
    );
    const replacement = after.metrics
      .filter((item) => item.execution_id === execution.execution_id)
      .at(-1);
    if (replacement?.kind !== "replace")
      throw new Error("The retained execution must receive a span replacement");
    expect(replacement.metric.spans_ms.sandbox).toBe(
      (baseline.spans_ms.sandbox ?? 0) + 7,
    );
    expect(f.store.lastEventSeq()).toBe(eventsBefore);
  } finally {
    spy.mockRestore();
  }
  const freshRun = f.freshTools().find((tool) => tool.name === "program_run")!;
  await f.runtime.control(f.run.run_id, "stop");
  expect(
    (
      await freshRun.execute("post-stop-start", {
        operation: "start",
        name,
        args: null,
        limits: DEFAULT_SKILL_LIMITS,
      })
    ).isError,
  ).toBe(true);
  expect(f.counters()).toEqual({ agents: 2, effects: 1 });
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

test("unconfirmed uncertainty native drain cannot be bypassed by same-session Resume or reopen metadata admission", async () => {
  const f = await fixture(true);
  // Establish the old complete snapshot before deliberately fencing publication.
  const through = f.store.historySourceHighwater(f.run.run_id);
  const published = Promise.withResolvers<void>();
  const commit = f.store.commitHistoryProjectionBatch.bind(f.store);
  const publication = vi
    .spyOn(f.store, "commitHistoryProjectionBatch")
    .mockImplementation((runId, batch) => {
      commit(runId, batch);
      if (
        runId === f.run.run_id &&
        batch.after.phase === "idle" &&
        batch.after.source_through >= through
      )
        published.resolve();
    });
  try {
    if (
      (f.store.historyProjectionGeneration(f.run.run_id)?.source_through ??
        -1) >= through
    )
      published.resolve();
    await f.reached(published.promise);
  } finally {
    publication.mockRestore();
  }
  f.unknown();
  await f.reached(f.barrierEntered.promise);
  f.nativeBarrier.resolve();
  f.workerExit.resolve();
  await f.reached(f.workerDrained.promise);
  await f.reached(f.paused.promise);
  f.restoreObservation();
  await expect(f.runtime.control(f.run.run_id, "resume")).rejects.toMatchObject(
    { code: "unknown_effect" },
  );
  expect(f.runtime.snapshot()?.status).toBe("paused");
  expect(f.counters()).toEqual({ agents: 1, effects: 1 });
  const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
  const events = f.store.lastEventSeq();
  new ExecutionTrace(f.store).span(
    f.store.allSkillExecutions(f.run.run_id)[0]!,
    "sandbox",
    100,
    107,
  );
  expect(f.store.lastEventSeq()).toBe(events);
  // A readonly consumer must report lag; it may not secretly prepare the new source.
  const page = await f.runtime.skillEvidence(f.run.run_id);
  expect(page.projection.has_pending).toBe(true);
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  await expect(f.staleEffect()).rejects.toThrow();
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});
