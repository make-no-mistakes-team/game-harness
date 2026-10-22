import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core/types";
import type { Observation } from "../src/shared/contracts.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import {
  StrategicPlanner,
  type StrategicHost,
} from "../src/server/strategic.ts";
import { emptyRunUsage } from "../src/server/usage.ts";

type Gate = Parameters<Agent["setBeforeModelCall"]>[0];
type Assistant = Extract<AgentEvent, { type: "message_end" }>["message"];
interface FakeAgent {
  gate: Gate;
  emit(message: Partial<Assistant>): void;
}
const resources: {
  planner: StrategicPlanner;
  store: Store;
  directory: string;
}[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    await resource.planner.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

function setup(onPrompt: (text: string, agent: FakeAgent) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-strategic-"));
  const store = new Store(directory);
  const sessionId = crypto.randomUUID();
  const lifeId = 1;
  const run: StoredRun = {
    run_id: crypto.randomUUID(),
    session_id: sessionId,
    life_id: lifeId,
    task: "Observe authorized state",
    goal: "custom",
    model_id: "fixture-model",
    world_id: crypto.randomUUID(),
    epoch: 1,
    status: "running",
    started_at: null,
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
    usage: emptyRunUsage(),
    baseline: {},
  };
  store.saveRun(run);
  const observation: Observation = {
    schema_version: 2,
    session_id: sessionId,
    life: {
      life_id: lifeId,
      status: "alive",
      can_respawn: false,
      death: null,
    },
    world_id: run.world_id,
    epoch: run.epoch,
    observation_seq: 1,
    captured_at: new Date().toISOString(),
    profile_id: "player-observable-structured",
    preset_id: "minecraft-observable-initial-r2",
    player: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      on_ground: true,
      in_water: false,
      inventory: [],
    },
    blocks: [
      {
        id: "detail-only-block",
        name: "stone",
        position: { x: 0, y: 63, z: 0 },
        observed_at: new Date().toISOString(),
        current: true,
      },
    ],
    entities: [],
    sounds: [],
    coverage: { partial: true, max_age_ms: 1000 },
  };
  const state = {
    pending: false,
    busy: true,
    generation: 1,
    prompts: 0,
    creates: 0,
    releases: 0,
    pauses: [] as string[],
    replacements: [] as unknown[],
    contexts: [] as Record<string, unknown>[],
  };
  let planner: StrategicPlanner;
  const host: StrategicHost = {
    run: () => run,
    generation: () => state.generation,
    assertCurrent: (generation, epoch) => {
      if (
        generation !== state.generation ||
        (epoch !== undefined && epoch !== run.epoch) ||
        !["running", "bootstrapping"].includes(run.status)
      )
        throw new RuntimeFault("stale_context", "Fixture authority revoked");
      return run;
    },
    tools: () => [],
    rootPrompt: () => "Fixture instruction",
    observe: async () => observation,
    policies: () => [],
    action: () => null,
    programPending: () => state.pending,
    busy: () => state.busy,
    persist: (summary) => store.saveRun(run, summary),
    pause: (message) => {
      state.pauses.push(message);
      run.status = "paused";
      state.generation++;
      planner.fence();
    },
    terminal: (status, message) => {
      run.status = status;
      run.error = message;
      planner.fence();
    },
    finishBootstrap: () => {
      run.status = "running";
      store.saveRun(run);
    },
  };
  const auth = {
    createAgent: async () => {
      state.creates++;
      let listener: ((event: AgentEvent) => void) | null = null;
      const fake: FakeAgent = {
        gate: undefined,
        emit: (message) =>
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "stop",
              usage: { input: 2, cacheRead: 3, cacheWrite: 4, output: 5 },
              ...message,
            },
          } as AgentEvent),
      };
      return {
        setBeforeModelCall: (gate: Gate) => {
          fake.gate = gate;
        },
        subscribe: (callback: (event: AgentEvent) => void) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
        replaceMessages: (messages: unknown) => {
          state.replacements.push(messages);
        },
        abort: () => {},
        waitForIdle: async () => {},
        prompt: async (text: string) => {
          state.prompts++;
          state.contexts.push(JSON.parse(text));
          await onPrompt(text, fake);
        },
      } as unknown as Agent;
    },
    releaseAgent: async () => {
      state.releases++;
    },
  } as unknown as AuthManager;
  planner = new StrategicPlanner(store, auth, host);
  resources.push({ planner, store, directory });
  const event = (type: string) => {
    const ready = Promise.withResolvers<void>();
    const unsubscribe = store.subscribe((value) => {
      if (value.run_id === run.run_id && value.type === type) {
        unsubscribe();
        ready.resolve();
      }
    });
    return ready.promise;
  };
  return { planner, store, run, state, event };
}

async function callGate(agent: FakeAgent) {
  return await agent.gate?.({ systemPrompt: [], messages: [], tools: [] });
}

function gated(agent: FakeAgent, reason?: string) {
  agent.emit({
    stopReason: "aborted",
    errorMessage: reason,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  } as Partial<Assistant>);
}

test("pending work admits one explicit meaningful request, never observation or after-tool polling", async () => {
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({
      responseId: "actual-provider-response",
    } as Partial<Assistant>);
    const stopped = await callGate(agent);
    expect(stopped?.stop).toBe(true);
    expect(stopped?.reason).toBe(
      "A program is meaningful pending work; strategy waits for its outcome",
    );
    gated(agent, stopped?.reason);
  });
  fixture.state.pending = true;
  await fixture.planner.start(1);
  expect(fixture.state.prompts).toBe(0);
  const done = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("policy_replan");
  fixture.planner.wake("policy_replan");
  await done;
  vi.useFakeTimers();
  for (const reason of [
    "observation",
    "tick",
    "no_runnable_work",
    "work_decision_needed",
    "coalesced_pending_work",
  ])
    fixture.planner.wake(reason);
  vi.advanceTimersByTime(160);
  vi.useRealTimers();
  expect(fixture.state.prompts).toBe(1);
  expect(fixture.state.pauses).toEqual([]);
  expect(fixture.run.usage.calls).toBe(1);
  expect(fixture.run.usage.by_purpose.replanning).toMatchObject({
    calls: 1,
    uncached_input: 2,
    cache_read: 3,
    cache_write: 4,
    output: 5,
  });
  expect(fixture.run.usage.known_cost).toBeNull();
  expect(JSON.stringify(fixture.state.contexts)).not.toContain(
    "detail-only-block",
  );
  expect(
    fixture.store
      .eventsAfter(fixture.run.run_id, 0, 500)
      .find((event) => event.type === "model.request_settled")?.details,
  ).toMatchObject({
    provider_response_id: "actual-provider-response",
    purpose: "replanning",
  });
});

test("a skill admission immediately revokes the rest of the current request allowance", async () => {
  let admit = () => {};
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({});
    admit();
    const stopped = await callGate(agent);
    expect(stopped?.stop).toBe(true);
    gated(agent, stopped?.reason);
  });
  admit = () => {
    fixture.state.pending = true;
    fixture.planner.admitted();
  };
  await fixture.planner.start(1);
  const done = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("recovery_completed");
  await done;
  expect(fixture.state.pauses).toEqual([]);
  expect(fixture.run.usage.calls).toBe(1);
  expect(fixture.run.model_status).toBe("idle");
  expect(
    fixture.store
      .eventsAfter(fixture.run.run_id, 0, 500)
      .filter((event) => event.type === "scheduler.backoff"),
  ).toEqual([]);
});

test("failed requests retain the feedback cursor, account actual usage, and retry with compact evidence", async () => {
  let fail = true;
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({ stopReason: fail ? "error" : "stop" } as Partial<Assistant>);
    fail = false;
  });
  const evidence = fixture.store.event(
    fixture.run.run_id,
    "action.failed",
    "Action safely failed",
    {
      action_id: "failed-action",
      source: "private-program-source",
      observation: { blocks: ["never-echo-detail"] },
    },
  );
  await fixture.planner.start(1);
  let done = fixture.event("scheduler.turn_failed");
  fixture.planner.wake("recovery_completed");
  await done;
  expect(fixture.state.pauses).toHaveLength(1);
  fixture.run.status = "running";
  await fixture.planner.start(fixture.state.generation);
  done = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("recovery_completed");
  await done;
  const feedback = fixture.state.contexts.map(
    (context) => context.feedback as { event_seq: number }[],
  );
  expect(
    feedback[0]?.some((event) => event.event_seq === evidence.event_seq),
  ).toBe(true);
  expect(
    feedback[1]?.some((event) => event.event_seq === evidence.event_seq),
  ).toBe(true);
  expect(JSON.stringify(fixture.state.contexts)).not.toContain(
    "private-program-source",
  );
  expect(JSON.stringify(fixture.state.contexts)).not.toContain(
    "never-echo-detail",
  );
  expect(fixture.run.usage).toMatchObject({
    calls: 2,
    uncached_input: 4,
    cache_read: 6,
    cache_write: 8,
    output: 10,
  });
  expect(fixture.state.replacements).toEqual([[], []]);
  expect(fixture.state.releases).toBe(1);
});

test("replacement waits for the old request to settle and its auth scope to release", async () => {
  const requestStarted = Promise.withResolvers<void>();
  const requestFinished = Promise.withResolvers<void>();
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    requestStarted.resolve();
    await requestFinished.promise;
    agent.emit({ stopReason: "aborted" } as Partial<Assistant>);
  });
  await fixture.planner.start(1);
  fixture.planner.wake("recovery_completed");
  await requestStarted.promise;
  const replacement = fixture.planner.start(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.state.creates).toBe(1);
  expect(fixture.state.releases).toBe(0);
  requestFinished.resolve();
  await replacement;
  expect(fixture.state.releases).toBe(1);
  expect(fixture.state.creates).toBe(2);
  expect(fixture.state.prompts).toBe(1);
  expect(fixture.state.pauses).toEqual([]);
});

test("bootstrap's finite call gate is a normal host stop and opens gameplay once", async () => {
  const fixture = setup(async (text, agent) => {
    const context: unknown = JSON.parse(text);
    const bootstrap =
      context !== null &&
      typeof context === "object" &&
      "phase" in context &&
      context.phase === "bootstrapping";
    for (let index = 0; index < (bootstrap ? 3 : 1); index++) {
      expect(await callGate(agent)).toBeUndefined();
      agent.emit({});
    }
    if (!bootstrap) {
      fixture.state.pending = true;
      fixture.planner.admitted();
    }
    const stopped = await callGate(agent);
    expect(stopped?.stop).toBe(true);
    gated(agent, stopped?.reason);
  });
  fixture.run.status = "bootstrapping";
  await fixture.planner.start(1);
  const runningTurn = Promise.withResolvers<void>();
  const unsubscribe = fixture.store.subscribe((event) => {
    if (
      event.type === "scheduler.turn_finished" &&
      fixture.state.prompts === 2
    ) {
      unsubscribe();
      runningTurn.resolve();
    }
  });
  fixture.planner.wake("bootstrap");
  await runningTurn.promise;
  expect(fixture.run).toMatchObject({ status: "running" });
  expect(fixture.run.usage.calls).toBe(4);
  expect(fixture.run.usage.by_purpose.authoring.calls).toBe(3);
  expect(fixture.run.usage.by_purpose.planning.calls).toBe(1);
  expect(fixture.state.pauses).toEqual([]);
});
