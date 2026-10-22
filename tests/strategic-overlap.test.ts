import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Observation } from "../src/shared/contracts.ts";
import type { PlanningContext } from "../src/shared/planning.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { SkillManager } from "../src/server/skills.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { StrategicPlanner } from "../src/server/strategic.ts";
import { emptyRunUsage } from "../src/server/usage.ts";

type Gate = Parameters<Agent["setBeforeModelCall"]>[0];
type ToolGate = NonNullable<Agent["beforeToolCall"]>;
interface HarnessAgent {
  call(toolNames?: string[]): Promise<boolean>;
  tool(name: string): Promise<boolean>;
  wait(promise: Promise<void>): Promise<void>;
  catalog(): string[];
}
const resources: { planner: StrategicPlanner; store: Store; directory: string }[] = [];
const managers: SkillManager[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const failures: unknown[] = [];
  for (const manager of managers.splice(0)) {
    try { await manager.closeAll("Test complete"); }
    catch (error) { failures.push(error); }
  }
  for (const { planner, store, directory } of resources.splice(0)) {
    try { await planner.close(); }
    catch (error) { failures.push(error); }
    finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture owners did not drain cleanly");
});
function setup(onPrompt: (context: Record<string, unknown>, agent: HarnessAgent) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-overlap-"));
  const store = new Store(directory);
  const run: StoredRun = {
    run_id: crypto.randomUUID(), session_id: "session", life_id: 1,
    task: "Observe", goal: "custom", model_id: "fixture-model", world_id: "world", epoch: 1,
    status: "running", started_at: null, ended_at: null, turns: 0, model_status: "idle", error: null,
    usage: emptyRunUsage(), baseline: {},
  };
  store.saveRun(run);
  const observation: Observation = {
    schema_version: 2, session_id: "session", world_id: "world", epoch: 1,
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    observation_seq: 1, captured_at: new Date().toISOString(), profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false, inventory: [] },
    blocks: [], entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
  };
  const basis: PlanningContext = {
    run_id: run.run_id, generation: 1, session_id: "session", world_id: "world", epoch: 1,
    life_id: 1, life_status: "alive", task: run.task, goal: run.goal,
    root: { execution_id: "root", skill_id: "skill", version: 1, hash: "exact", status: "running" },
  };
  const state = { pending: true, bootstrapFinishes: 0, reviews: 0, aborts: 0, pauses: [] as string[], contexts: [] as Record<string, unknown>[], catalogs: [] as string[][] };
  const tools: AgentTool[] = [
    "capabilities_read", "observation_read", "skill_read", "skill_history",
    "planning_stage", "planning_read", "skill_start", "skill_register", "skill_revise",
    "planning_activate", "policy_activate", "skill_cancel", "improvement_feedback",
    "improvement_resolve", "version_compare", "trace_read",
  ].map((name) => ({
    name, label: name, description: "Fixture tool boundary", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: null }),
  }));
  let planner: StrategicPlanner;
  const speculation = new SpeculativePlanning({
    admissionContext: () => basis,
    context: () => basis, skill: () => null, observe: async () => observation,
    evaluatePrecondition: async () => { throw new Error("Not used in scheduler regression"); },
    admit: async () => { throw new Error("Scheduler cannot admit a draft"); },
    evidence: (type, details) => { store.event(run.run_id, type, type, details); },
    wake: () => planner.wake("speculative_lookahead"),
  });
  const auth = {
    createAgent: async (options: { tools: AgentTool[] }) => {
      let activeTools = options.tools;
      let gate: Gate | undefined;
      let listener: ((event: AgentEvent) => void) | undefined;
      let promptController: AbortController | null = null;
      let activePrompt: Promise<void> | null = null;
      const agent = {
        beforeToolCall: undefined as Agent["beforeToolCall"],
        setBeforeModelCall: (value: Gate) => { gate = value; },
        subscribe: (value: (event: AgentEvent) => void) => { listener = value; return () => { listener = undefined; }; },
        abort: () => { state.aborts++; promptController?.abort(); },
        waitForIdle: async () => { await activePrompt; },
        replaceMessages: () => {},
        setTools: (selected: AgentTool[]) => {
          activeTools = selected;
          state.catalogs.push(selected.map((tool) => tool.name));
        },
        prompt: async (text: string) => {
          const controller = new AbortController();
          promptController = controller;
          const context = JSON.parse(text);
          state.contexts.push(context);
          const prompt = onPrompt(context, {
            call: async (toolNames = []) => {
              if (controller.signal.aborted) return false;
              const result = await gate?.({ systemPrompt: [], messages: [], tools: activeTools });
              listener?.({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: result?.stop ? [] : toolNames.map((name, index): ToolCall => ({
                    type: "toolCall", id: `${name}-${index}`, name, arguments: {},
                  })),
                  api: "openai-responses",
                  provider: "openai", model: "fixture-model", timestamp: Date.now(),
                  stopReason: result?.stop ? "aborted" : "stop", errorMessage: result?.reason,
                  usage: {
                    input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                },
              });
              return !result?.stop;
            },
            tool: async (name) => !controller.signal.aborted && !(await agent.beforeToolCall?.({ tool: { name } } as Parameters<ToolGate>[0]))?.block,
            wait: async (pending) => {
              if (controller.signal.aborted) return;
              const cancelled = Promise.withResolvers<void>();
              const onAbort = () => cancelled.resolve();
              controller.signal.addEventListener("abort", onAbort, { once: true });
              try { await Promise.race([pending, cancelled.promise]); }
              finally { controller.signal.removeEventListener("abort", onAbort); }
            },
            catalog: () => activeTools.map((tool) => tool.name),
          });
          activePrompt = prompt;
          try { await prompt; }
          finally {
            if (activePrompt === prompt) activePrompt = null;
            if (promptController === controller) promptController = null;
          }
        },
      };
      return agent as unknown as Agent;
    },
    releaseAgent: async () => {},
  } as unknown as AuthManager;
  planner = new StrategicPlanner(store, auth, {
    run: () => run, generation: () => 1,
    assertCurrent: (generation, epoch) => {
      if (generation !== 1 || (epoch !== undefined && epoch !== 1) || !["running", "bootstrapping", "reviewing"].includes(run.status)) throw new RuntimeFault("stale_context", "revoked");
      return run;
    },
    tools: () => tools, rootPrompt: () => "Fixture", observe: async () => observation,
    policies: () => [], action: () => null, programPending: () => state.pending, busy: () => true,
    persist: () => store.saveRun(run),
    pause: (reason) => { state.pauses.push(reason); }, terminal: () => { throw new Error("Unexpected terminal transition"); },
    finishBootstrap: () => { state.bootstrapFinishes++; run.status = "running"; },
    speculation: () => speculation,
    reviewContext: () => ({ opportunities: [], uncertainty: "unmeasured" }),
    reviewComplete: () => { state.reviews++; run.status = "completed"; planner.fence(); },
  });
  resources.push({ planner, store, directory });
  const event = (type: string) => {
    const done = Promise.withResolvers<void>();
    const unsubscribe = store.subscribe((entry) => { if (entry.type === type && entry.run_id === run.run_id) { unsubscribe(); done.resolve(); } });
    return done.promise;
  };
  const optIn = () => speculation.optIn({ root_execution_id: "root", after_ms: 0, reason: "Independent follow-up", budget: { calls: 3, tools: 6, duration_ms: 5000 } });
  return { planner, speculation, run, state, event, optIn, store, basis };
}

for (const selectedKind of ["lookahead", "attention"] as const) {
  test(`${selectedKind} timer survives a real root's next leaf admission before scheduler coalescing`, async () => {
    const fixture = setup(async (context, agent) => {
      expect(await agent.call()).toBe(true);
      if (selectedKind === "lookahead") expect(context.speculative_plan).not.toBeNull();
      else {
        expect(context.speculative_plan).toBeNull();
        expect(context.attention).toBe("Independent selected attention");
        expect(await agent.call()).toBe(false);
      }
    });
    await fixture.planner.start(1);
    const firstLeaf = Promise.withResolvers<void>();
    const secondLeaf = Promise.withResolvers<void>();
    const continueRoot = Promise.withResolvers<void>();
    const finishRoot = Promise.withResolvers<void>();
    const rootClosed = Promise.withResolvers<void>();
    let leaves = 0;
    let rootId = "";
    const selected = Promise.withResolvers<void>();
    const selectedReason = selectedKind === "lookahead" ? "speculative_lookahead" : "selected_attention";
    const wake = fixture.planner.wake.bind(fixture.planner);
    vi.spyOn(fixture.planner, "wake").mockImplementation((reason) => {
      wake(reason);
      if (reason === selectedReason) selected.resolve();
    });
    const finished = fixture.event(selectedKind === "lookahead" ? "scheduler.lookahead_finished" : "scheduler.turn_finished");
    const runner: SandboxService["runSkill"] = async (_source, _args, handle, _limits, signal) => {
      const revoked = Promise.withResolvers<void>();
      const onAbort = () => revoked.resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } });
        firstLeaf.resolve();
        await Promise.race([continueRoot.promise, revoked.promise]);
        if (!signal?.aborted) {
          await handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } });
          secondLeaf.resolve();
        }
        await Promise.race([finishRoot.promise, revoked.promise]);
        return { status: "completed", summary: "Neutral root continued", result: null };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const manager = new SkillManager(fixture.store, { runSkill: runner }, {
      authorize: (runId, epoch, sessionId, lifeId) => {
        if (runId !== fixture.run.run_id || epoch !== 1 || sessionId !== "session" || lifeId !== 1)
          throw new Error("Root authority revoked");
      },
      observe: async () => { throw new Error("No observation requested by neutral root"); },
      action: async () => {
        leaves++;
        fixture.planner.admitted();
        return { status: "succeeded", summary: "Neutral fixture leaf acknowledged", evidence: { effect_confirmed: true } };
      },
      recipes: async () => [],
      recover: async () => { throw new Error("No recovery requested"); },
      cancelActions: async () => {},
      prepareLookahead: (config) => fixture.speculation.prepareOptIn(config),
      changed: (_wake, execution) => {
        fixture.state.pending = manager.pending;
        const current = fixture.store.latestRootExecution(fixture.run.run_id);
        if (current) fixture.basis.root = {
          execution_id: current.execution_id, skill_id: current.skill_id,
          version: current.version, hash: fixture.store.skill(fixture.run.run_id, current).hash,
          status: current.status,
        };
        if (execution?.execution_id === rootId && execution.ended_at !== null) rootClosed.resolve();
      },
      unsafe: () => { fixture.state.pauses.push("Unconfirmed fixture cleanup"); },
    });
    managers.push(manager);
    const source = await manager.register(fixture.run.run_id, {
      name: "continued-neutral-root",
      source: 'await game.action({kind:"look",yaw:0,pitch:0}); await game.action({kind:"look",yaw:1,pitch:0}); return {status:"completed",summary:"Neutral root continued",result:null};',
      card: { purpose: "Exercise continued root admission", applicability: "Neutral regression", method: "Two acknowledged leaf calls", reason: "Selected wake survives continuation", limitations: "No gameplay effectiveness claim" },
      dependencies: [],
    });
    const root = manager.start(fixture.run.run_id, {
      skill_id: source.skill_id, version: source.version, start_key: "continued_root",
      epoch: 1, session_id: "session", life_id: 1, args: null,
      limits: { duration_ms: 10_000, max_actions: 2, max_calls: 2, max_depth: 1 },
      ...(selectedKind === "lookahead" ? {
        lookahead: { after_ms: 0, reason: "Independent selected lookahead", budget: { calls: 1, tools: 2, duration_ms: 5000 } },
      } : {}),
    });
    rootId = root.execution_id;
    fixture.planner.admitted();
    await firstLeaf.promise;
    if (selectedKind === "attention") fixture.planner.attentionAfter(1000, "Independent selected attention");
    await selected.promise;
    continueRoot.resolve();
    await secondLeaf.promise;
    expect(leaves).toBe(2);
    expect(manager.get(fixture.run.run_id, { execution_id: rootId })?.status).toBe("running");
    await finished;
    expect(fixture.state.contexts).toHaveLength(1);
    expect(fixture.run.usage.calls).toBe(1);
    expect(manager.pending).toBe(true);
    finishRoot.resolve();
    await rootClosed.promise;
    expect(manager.get(fixture.run.run_id, { execution_id: rootId })).toMatchObject({ status: "succeeded", actions: 2 });
    expect(fixture.state.pauses).toEqual([]);
  });
}

test("intentional lookahead advertises bounded read-only planning while pending program continues", async () => {
  const fixture = setup(async (context, agent) => {
    expect(context.speculative_plan).not.toBeNull();
    expect(agent.catalog()).toContain("planning_stage");
    expect(agent.catalog()).toContain("skill_read");
    for (const forbidden of ["skill_start", "skill_register", "skill_revise", "planning_activate", "policy_activate", "skill_cancel"])
      expect(agent.catalog()).not.toContain(forbidden);
    expect(await agent.call(["skill_register"])).toBe(true);
    expect(await agent.tool("skill_register")).toBe(false);
    expect(await agent.tool("skill_read")).toBe(true);
    expect(await agent.call()).toBe(true);
    expect(await agent.call()).toBe(true);
    expect(await agent.call()).toBe(false);
    expect(await agent.tool("skill_start")).toBe(false);
  });
  await fixture.planner.start(1);
  const finished = fixture.event("scheduler.lookahead_finished"); fixture.optIn(); await finished;
  expect(fixture.state.pending).toBe(true);
  expect(fixture.run.usage.calls).toBe(3);
  expect(fixture.run.usage.by_purpose.planning.calls).toBe(3);
  expect(fixture.run.usage.by_purpose.authoring.calls).toBe(0);
  expect(fixture.state.contexts).toHaveLength(1);
  expect(fixture.state.catalogs.at(-1)).toContain("skill_start");
  expect(fixture.state.catalogs.at(-1)).toContain("skill_register");
  expect(fixture.state.bootstrapFinishes).toBe(0);
  expect(fixture.state.pauses).toEqual([]);
});

for (const sample of [
  { wake: "recovery_completed", tools: ["skill_register"], purpose: "authoring" },
  { wake: "recovery_completed", tools: ["policy_register"], purpose: "authoring" },
  { wake: "recovery_completed", tools: ["skill_register", "skill_revise"], purpose: "improvement" },
  { wake: "recovery_completed", tools: ["version_compare"], purpose: "improvement" },
  { wake: "uncertainty", tools: ["skill_register", "skill_revise"], purpose: "replanning" },
  { wake: "skill_outcome", tools: ["skill_register"], purpose: "replanning", failure: true },
] as const) {
  test(`host classifies ${sample.wake}/${sample.tools.join("+")} without an extra telemetry request`, async () => {
    const fixture = setup(async (_context, agent) => {
      expect(await agent.call([...sample.tools])).toBe(true);
    });
    fixture.state.pending = false;
    if ("failure" in sample) fixture.store.event(fixture.run.run_id, "action.unknown", "Fixture effect remains unconfirmed", {
      action_id: "unconfirmed-effect", status: "unknown",
    });
    await fixture.planner.start(1);
    const finished = fixture.event("scheduler.turn_finished");
    fixture.planner.wake(sample.wake);
    await finished;
    expect(fixture.run.usage).toMatchObject({ calls: 1, uncached_input: 1, output: 1, known_cost: null });
    expect(fixture.run.usage.by_purpose[sample.purpose].calls).toBe(1);
    const callsByPurpose = Object.values(fixture.run.usage.by_purpose).map((usage) => usage.calls);
    expect(callsByPurpose).not.toContain(null);
    expect(callsByPurpose.reduce<number>((sum, calls) => sum + (calls ?? 0), 0)).toBe(1);
    const events = fixture.store.eventsAfter(fixture.run.run_id, 0, 500);
    expect(events.find((event) => event.type === "model.call")?.details)
      .toMatchObject({ purpose_source: "host_turn_role_v1", purpose_final: false });
    expect(events.find((event) => event.type === "model.purpose_classified")?.details)
      .toMatchObject({ purpose: sample.purpose, purpose_source: "host_role_and_tools_v1", purpose_final: true });
    expect(events.find((event) => event.type === "model.usage")?.details)
      .toMatchObject({ purpose: sample.purpose, purpose_final: true });
    expect(fixture.state.contexts).toHaveLength(1);
  });
}

test("uncertainty recovery admits one fresh strategic request without relaxing pending-work quota", async () => {
  const fixture = setup(async (context, agent) => {
    expect(context.reason).toEqual(["uncertainty"]);
    expect(context.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.uncertainty",
        details: expect.objectContaining({
          action_id: "unknown-action", execution_id: "root", root_execution_id: "root",
          session_id: "session", life_id: 1, status: "unknown", no_replay: true,
        }),
      }),
      expect.objectContaining({
        type: "runtime.uncertainty_reconciled",
        details: expect.objectContaining({
          session_id: "session", life_id: 1, observation_seq: 1,
          neutralized: true, workers_closed: true, no_replay: true,
        }),
      }),
    ]));
    expect(JSON.stringify(context.feedback)).not.toContain("private-context-marker");
    expect(await agent.call()).toBe(true);
    expect(await agent.call()).toBe(false);
  });
  fixture.store.event(fixture.run.run_id, "runtime.uncertainty", "Unconfirmed effect fenced", {
    action_id: "unknown-action", execution_id: "root", root_execution_id: "root",
    session_id: "session", life_id: 1, status: "unknown", summary: "Effect remains unconfirmed", no_replay: true,
    raw_context: { observation: "private-context-marker" },
  });
  fixture.store.event(fixture.run.run_id, "runtime.uncertainty_reconciled", "Fresh same-life authority restored", {
    action_id: "unknown-action", session_id: "session", life_id: 1, observation_seq: 1,
    neutralized: true, workers_closed: true, no_replay: true,
  });
  await fixture.planner.start(1);
  const finished = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("uncertainty");
  await finished;
  expect(fixture.run.usage.calls).toBe(1);
  expect(fixture.state.contexts).toHaveLength(1);
  expect(fixture.state.pending).toBe(true);
  expect(fixture.state.pauses).toEqual([]);
});

test("normal replan queued during overlap is not consumed, blocked, or granted extra pending-work quota", async () => {
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const fixture = setup(async (context, agent) => {
    expect(await agent.call()).toBe(true);
    if (context.speculative_plan) { started.resolve(); await agent.wait(release.promise); }
    else expect(await agent.call()).toBe(false);
  });
  await fixture.planner.start(1);
  const done = fixture.event("scheduler.turn_finished"); fixture.optIn(); await started.promise;
  const evidence = fixture.store.event(fixture.run.run_id, "action.failed", "Measured failed action", { action_id: "failure" });
  fixture.planner.wake("policy_replan");
  expect(fixture.state.aborts).toBe(1);
  expect(fixture.speculation.projection()?.state).toBe("invalidated");
  release.resolve(); await done;
  expect(fixture.state.contexts).toHaveLength(2);
  expect(fixture.state.contexts[1]?.speculative_plan).toBeNull();
  expect(fixture.state.contexts[1]?.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ event_seq: evidence.event_seq })]));
  expect(fixture.run.usage.calls).toBe(2);
  expect(fixture.state.pauses).toEqual([]);
});

test("speculative wake cannot spend or finish bootstrap; ordinary bootstrap still runs its original allowance", async () => {
  const fixture = setup(async (context, agent) => {
    expect(context.speculative_plan).toBeNull();
    if (context.phase === "bootstrapping") {
      for (let index = 0; index < 3; index++) expect(await agent.call()).toBe(true);
      expect(await agent.call()).toBe(false);
    } else expect(await agent.call()).toBe(true);
  });
  fixture.state.pending = false;
  fixture.run.status = "bootstrapping";
  await fixture.planner.start(1);
  const skipped = fixture.event("scheduler.lookahead_skipped");
  fixture.planner.wake("speculative_lookahead");
  await skipped;
  expect(fixture.store.eventsAfter(fixture.run.run_id, 0, 500)
    .find((entry) => entry.type === "scheduler.lookahead_skipped")?.details)
    .toMatchObject({ phase: "bootstrapping", reason: "bootstrap" });
  expect(fixture.state.contexts).toEqual([]);
  expect(fixture.speculation.projection()).toBeNull();
  expect(fixture.run.usage.calls).toBe(0);
  expect(fixture.state.bootstrapFinishes).toBe(0);
  expect(fixture.run.status).toBe("bootstrapping");
  const finished = fixture.event("scheduler.turn_finished"); fixture.planner.wake("bootstrap"); await finished;
  expect(fixture.state.bootstrapFinishes).toBe(1);
  expect(fixture.run.usage.by_purpose.authoring.calls).toBe(3);
});

test("post-goal review is finite, improvement-attributed, effect-free, and completes once", async () => {
  const fixture = setup(async (context, agent) => {
    expect(context.phase).toBe("reviewing");
    expect(await agent.tool("skill_start")).toBe(false);
    expect(await agent.tool("policy_activate")).toBe(false);
    expect(await agent.tool("planning_activate")).toBe(false);
    expect(await agent.tool("skill_revise")).toBe(true);
    expect(await agent.tool("improvement_resolve")).toBe(true);
    for (let index = 0; index < 3; index++) expect(await agent.call(index === 0 ? ["skill_register"] : [])).toBe(true);
    expect(await agent.call()).toBe(false);
  });
  fixture.run.status = "reviewing"; fixture.state.pending = false;
  await fixture.planner.start(1);
  const finished = fixture.event("scheduler.review_finished"); fixture.planner.wake("goal_review"); await finished;
  expect(fixture.state.reviews).toBe(1);
  expect(String(fixture.run.status)).toBe("completed");
  expect(fixture.run.usage.by_purpose.improvement.calls).toBe(3);
  expect(fixture.state.bootstrapFinishes).toBe(0);
  expect(fixture.state.pauses).toEqual([]);
});
