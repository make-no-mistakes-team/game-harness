import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { z } from "zod";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Json, ObservationV3 } from "../src/shared/contracts.ts";
import type { PlanningContext } from "../src/shared/planning.ts";
import { TOOL_POLICY } from "../src/shared/tool-policy.ts";
import { DEFAULT_RESIDENT_LIMITS, type ResidentSnapshot } from "../src/shared/resident.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { SkillManager } from "../src/server/skills.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { StrategicPlanner, type StrategicRequestAdmission } from "../src/server/strategic.ts";
import { programRunSchema, programWriteSchema } from "../src/server/program-interface.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
import { finishHistoryExecution, historyExecution, historySpec } from "./helpers/history-fixture.ts";

type Gate = Parameters<Agent["setBeforeModelCall"]>[0];
type ToolGate = NonNullable<Agent["beforeToolCall"]>;
type DeclaredCall = { name: string; arguments?: Record<string, unknown> };
interface HarnessAgent {
  call(tools?: DeclaredCall[]): Promise<boolean>;
  tool(name: string): Promise<boolean>;
  wait(promise: Promise<void>): Promise<void>;
  catalog(): string[];
}
const resources: { planner: StrategicPlanner; store: Store; directory: string }[] = [];
const managers: SkillManager[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  const failures: unknown[] = [];
  for (const manager of managers.splice(0)) {
    try { await manager.closeAll("Test complete"); } catch (error) { failures.push(error); }
  }
  for (const { planner, store, directory } of resources.splice(0)) {
    try { await planner.close(); } catch (error) { failures.push(error); }
    finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture owners did not drain cleanly");
});
function object(value: Json): { [key: string]: Json } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
async function setup(onPrompt: (context: Record<string, unknown>, agent: HarnessAgent) => Promise<void>, streamFn?: StreamFn,
  requestAdmission?: StrategicRequestAdmission) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-overlap-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const goal = adapter.goals.find(goal => goal.goal_id === "custom")!;
  const run = minecraftRunFixture(adapter, { session_id: "session", life_id: 1,
    task: "Observe", model_id: "fixture-model", world_id: "world", epoch: 1,
    status: "running", started_at: null, ended_at: null, turns: 0, model_status: "idle", error: null,
  });
  store.saveRun(run);
  const source = await store.registerSkill(run.run_id, historySpec(run, "Continuing stored foreground"));
  const root = historyExecution(store, run, source);
  const observation = minecraftObservationFixture(adapter);
  const basis: PlanningContext = { run_id: run.run_id, generation: 1, session_id: "session", world_id: "world", epoch: 1,
    life_id: 1, life_status: "alive", task: run.task, goal,
    native_boot_id: run.native_boot_id!, space_epoch: run.space_epoch!, compatibility_hash: run.compatibility_hash!, screen: null,
    root: { execution_id: root.execution_id, skill_id: source.skill_id, version: source.version, hash: source.hash, status: "running" } };
  const state = { pending: true, reviews: 0, aborts: 0, pauses: [] as string[], contexts: [] as Record<string, unknown>[], catalogs: [] as string[][] };
  const tools: AgentTool[] = Object.keys(TOOL_POLICY).map((name) => ({ name, label: name,
    description: "Injected model tool seam", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: null }) }));
  let planner: StrategicPlanner;
  const speculation = new SpeculativePlanning({
    contract: () => adapter,
    admissionContext: () => basis, context: () => basis, skill: () => null, observe: async () => observation,
    evaluateGuard: async () => { throw new Error("No game guard evaluated by scheduler fixture"); },
    admit: async () => { throw new Error("Scheduler fixture has no prepared successor"); },
    evidence: (type, details) => { store.event(run.run_id, type, type, details); },
    wake: (reason) => planner.wake(reason === "lookahead" ? "speculative_lookahead" : "planning_continuation"),
  });
  const auth = {
    createAgent: async (configuration: { tools: AgentTool[] }) => {
      if (streamFn) {
        const descriptor = getBundledModels("openai-codex").find(value => value.api === "openai-codex-responses");
        if (!descriptor) throw new Error("No installed offline SDK model descriptor");
        return new Agent({ initialState: { tools: configuration.tools,
          model: getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id) },
          streamFn, getApiKey: () => "OFFLINE_FIXTURE_NO_NETWORK" });
      }
      let activeTools = configuration.tools, gate: Gate | undefined, listener: ((event: AgentEvent) => void) | undefined;
      let phaseHook: Parameters<Agent["addBeforeModelCallHook"]>[0] | undefined;
      let controller: AbortController | null = null, pending: Promise<void> | null = null;
      const agent = {
        beforeToolCall: undefined as Agent["beforeToolCall"],
        setBeforeModelCall: (value: Gate) => { gate = value; },
        addBeforeModelCallHook: (hook: Parameters<Agent["addBeforeModelCallHook"]>[0]) => {
          phaseHook = hook; return () => { phaseHook = undefined; };
        },
        subscribe: (value: (event: AgentEvent) => void) => { listener = value; return () => { listener = undefined; }; },
        abort: () => { state.aborts++; controller?.abort(); },
        waitForIdle: async () => { if (pending) await pending; }, replaceMessages: () => {},
        setTools: (selected: AgentTool[]) => { activeTools = selected; state.catalogs.push(selected.map((entry) => entry.name)); },
        prompt: async (text: string) => {
          const signal = new AbortController(); controller = signal;
          const context = JSON.parse(text) as Record<string, unknown>; state.contexts.push(context);
          const work = onPrompt(context, {
            call: async (declared = []) => {
              if (signal.signal.aborted) return false;
              await phaseHook?.(signal.signal, { systemPrompt: [], messages: [], tools: activeTools });
              const admitted = await gate?.({ systemPrompt: [], messages: [], tools: activeTools });
              listener?.({ type: "message_end", message: {
                role: "assistant", content: admitted?.stop ? [] : declared.map((entry, index): ToolCall => ({ type: "toolCall", id: `${entry.name}-${index}`, name: entry.name, arguments: entry.arguments ?? {} })),
                api: "openai-responses", provider: "openai", model: "fixture-model", timestamp: Date.now(),
                stopReason: admitted?.stop ? "aborted" : "stop", errorMessage: admitted?.reason,
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              } });
              return !admitted?.stop;
            },
            tool: async (name) => !signal.signal.aborted && !(await agent.beforeToolCall?.({ tool: { name } } as Parameters<ToolGate>[0]))?.block,
            wait: async (promise) => {
              const revoked = Promise.withResolvers<void>();
              const onAbort = () => revoked.resolve(); signal.signal.addEventListener("abort", onAbort, { once: true });
              try { await Promise.race([promise, revoked.promise]); } finally { signal.signal.removeEventListener("abort", onAbort); }
            },
            catalog: () => activeTools.map((entry) => entry.name),
          });
          pending = work;
          try { await work; } finally { if (pending === work) pending = null; if (controller === signal) controller = null; }
        },
      };
      return agent as unknown as Agent;
    }, releaseAgent: async () => {},
  } as unknown as AuthManager;
  planner = new StrategicPlanner(store, auth, {
    run: () => run, generation: () => 1, requestAdmission,
    assertCurrent: (generation, epoch) => {
      if (generation !== 1 || epoch !== undefined && epoch !== run.epoch || !["running", "reviewing"].includes(run.status))
        throw new RuntimeFault("stale_context", "Fixture authority revoked");
      return run;
    },
    tools: () => tools, rootPrompt: () => "Neutral scheduler fixture", observe: async () => observation,
    projectObservation: current => adapter.projectObservation(current),
    policies: () => [], action: () => null, programPending: () => state.pending, busy: () => state.pending,
    persist: () => store.saveRun(run), pause: (reason) => { state.pauses.push(reason); },
    terminal: () => { throw new Error("Unexpected terminal transition"); }, speculation: () => speculation,
    reviewContext: async () => ({ opportunities: [], uncertainty: "unmeasured" }),
    reviewComplete: () => { state.reviews++; run.status = "completed"; planner.fence(); },
  });
  resources.push({ planner, store, directory });
  const event = (type: string) => {
    const done = Promise.withResolvers<void>();
    const off = store.subscribe((entry) => { if (entry.type === type && entry.run_id === run.run_id) { off(); done.resolve(); } });
    return done.promise;
  };
  const optIn = () => speculation.optIn({ root_execution_id: basis.root.execution_id, after_ms: 0, reason: "Independent follow-up", budget: { calls: 3, tools: 6, duration_ms: 5000 } });
  return { planner, speculation, run, state, event, optIn, store, basis, adapter, root, tools };
}

for (const selectedKind of ["lookahead", "attention"] as const) {
  test(`${selectedKind} survives the current root's next real capability admission`, async () => {
    const f = await setup(async (context, agent) => {
      expect(await agent.call()).toBe(true);
      if (selectedKind === "lookahead") expect(context.speculative_plan).not.toBeNull();
      else { expect(context.speculative_plan).toBeNull(); expect(await agent.call()).toBe(true); }
    });
    await f.planner.start(1);
    finishHistoryExecution(f.store, f.root);
    const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<void>(); let leaves = 0, rootId = "";
    const wake = f.planner.wake.bind(f.planner);
    vi.spyOn(f.planner, "wake").mockImplementation((reason) => { wake(reason); if (reason === (selectedKind === "lookahead" ? "speculative_lookahead" : "selected_attention")) selected.resolve(); });
    const finished = f.event(selectedKind === "lookahead" ? "scheduler.lookahead_finished" : "scheduler.turn_finished");
    const runner: SandboxService["runSkill"] = async (_source, _args, handle, _limits, signal) => {
      const revoked = Promise.withResolvers<void>(), onAbort = () => revoked.resolve(); signal.addEventListener("abort", onAbort, { once: true });
      try {
        await handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } }); first.resolve();
        await Promise.race([proceed.promise, revoked.promise]);
        if (!signal.aborted) { await handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } }); second.resolve(); }
        await Promise.race([finish.promise, revoked.promise]);
        return { status: "completed", summary: "Neutral root continued", result: null };
      } finally { signal.removeEventListener("abort", onAbort); }
    };
    const manager = new SkillManager(f.store, { runSkill: runner }, {
      authorize: scope => { if (scope.run_id !== f.run.run_id || scope.epoch !== 1 || scope.session_id !== "session" || scope.life_id !== 1 ||
        scope.native_boot_id !== f.run.native_boot_id || scope.space_epoch !== f.run.space_epoch) throw new Error("Revoked root"); },
      adapter: () => f.adapter, binding: () => minecraftTestBinding(f.adapter),
      observe: async () => { throw new Error("No observation requested"); }, queryCapability: async () => [],
      action: async () => { leaves++; f.planner.admitted(); return { status: "succeeded", summary: "Confirmed neutral capability", evidence: { effect_confirmed: true } }; },
      recover: async () => { throw new Error("No recovery requested"); }, cancelActions: async () => {},
      prepareLookahead: (configuration) => f.speculation.prepareOptIn(configuration),
      changed: (outcome, execution) => {
        f.state.pending = manager.pending;
        const root = f.store.latestRootExecution(f.run.run_id);
        if (root) f.basis.root = { execution_id: root.execution_id, skill_id: root.skill_id, version: root.version, hash: f.store.skill(f.run.run_id, root).hash, status: root.status };
        if (outcome && execution?.execution_id === rootId) closed.resolve();
      }, unsafe: () => { f.state.pauses.push("Unconfirmed cleanup"); },
    });
    managers.push(manager);
    const program = await manager.register(f.run.run_id, { entry: "run", name: "Neutral continued program", source: 'await game.action({kind:"look",yaw:0,pitch:0}); await game.action({kind:"look",yaw:1,pitch:0}); return {status:"completed",summary:"Neutral flow settled",result:null};',
      card: { purpose: "Measure selected attention", applicability: "Neutral fixture", method: "Two authorized capabilities", reason: "Prove root handoff", limitations: "No gameplay claim" }, dependencies: [] });
    const root = manager.start(f.run.run_id, { entry: "run", skill_id: program.skill_id, version: program.version, start_key: "continued", ...executionScopeFixture(f.run), args: null,
      limits: { duration_ms: 10000, max_actions: 2, max_calls: 2, max_depth: 1 },
      ...(selectedKind === "lookahead" ? { lookahead: { after_ms: 0, reason: "Independent selected follow-up", budget: { calls: 1, tools: 2, duration_ms: 5000 } } } : {}) });
    rootId = root.execution_id; f.planner.admitted(); await first.promise;
    if (selectedKind === "attention") f.planner.attentionAfter(1000, "Independent selected attention");
    await selected.promise; proceed.resolve(); await second.promise;
    expect(leaves).toBe(2); expect(manager.get(f.run.run_id, { execution_id: rootId })?.status).toBe("running");
    await finished; expect(f.state.contexts).toHaveLength(1); expect(f.run.usage.calls).toBe(selectedKind === "lookahead" ? 1 : 2); expect(manager.pending).toBe(true);
    finish.resolve(); await closed.promise;
    expect(manager.get(f.run.run_id, { execution_id: rootId })).toMatchObject({ status: "succeeded", actions: 2 });
    expect(f.state.pauses).toEqual([]);
  });
}

test("restricted planning has a finite request budget and cannot dispatch ordinary execution controls", async () => {
  const f = await setup(async (_context, agent) => {
    expect(agent.catalog()).toContain("prepare_next"); expect(agent.catalog()).not.toContain("program_run");
    expect(agent.catalog()).toContain("program_write");
    expect(await agent.call([{ name: "prepare_next" }])).toBe(true);
    expect(await agent.tool("program_run")).toBe(false); expect(await agent.tool("program_write")).toBe(true);
    expect(await agent.tool("program_inspect")).toBe(true);
    expect(await agent.call()).toBe(true); expect(await agent.call()).toBe(true); expect(await agent.call()).toBe(false);
  });
  await f.planner.start(1); const done = f.event("scheduler.lookahead_finished"); f.optIn(); await done;
  expect(f.run.usage.calls).toBe(3); expect(f.run.usage.by_purpose.planning.calls).toBe(3);
  expect(f.state.contexts).toHaveLength(1); expect(f.state.catalogs.at(-1)).toContain("program_run"); expect(f.state.pauses).toEqual([]);
});

for (const sample of [
  { wake: "preflight_ready", calls: [{ name: "program_write", arguments: {} }], purpose: "authoring" },
  { wake: "preflight_ready", calls: [{ name: "program_write", arguments: { based_on: 1 } }], purpose: "improvement" },
  { wake: "preflight_ready", calls: [{ name: "program_inspect", arguments: { view: "comparison" } }], purpose: "improvement" },
  { wake: "uncertainty", calls: [{ name: "program_write", arguments: { based_on: 1 } }], purpose: "replanning" },
  { wake: "skill_outcome", calls: [{ name: "program_write", arguments: {} }], purpose: "replanning", failure: true },
] as const) {
  test(`host accounts ${sample.wake}/${sample.purpose} without a separate accounting request`, async () => {
    const f = await setup(async (_context, agent) => { expect(await agent.call([...sample.calls])).toBe(true); });
    f.state.pending = false;
    if ("failure" in sample) f.store.event(f.run.run_id, "action.unknown", "Past effects remain uncertain", { action_id: "unknown", status: "unknown" });
    await f.planner.start(1); const done = f.event("scheduler.turn_finished"); f.planner.wake(sample.wake); await done;
    expect(f.run.usage).toMatchObject({ calls: 1, uncached_input: 1, output: 1, known_cost: null });
    expect(f.run.usage.by_purpose[sample.purpose].calls).toBe(1);
    const count = Object.values(f.run.usage.by_purpose).reduce((sum, usage) => sum + (usage.calls ?? 0), 0); expect(count).toBe(1);
    const usage = f.store.eventsAfter(f.run.run_id, 0, 500).find((event) => event.type === "model.usage");
    expect(object(usage?.details ?? null)?.purpose).toBe(sample.purpose);
    expect(f.state.contexts).toHaveLength(1);
  });
}

for (const sample of [
  { root: "succeeded", failure: "owned_action", role: "planning" },
  { root: "blocked", failure: "owned_action", role: "recovery" },
  { root: "succeeded", failure: "unowned_action", role: "recovery" },
  { root: "succeeded", failure: "child", role: "planning" },
] as const) {
  test(`outcome role keeps ${sample.failure} evidence after root ${sample.root} without forcing unrelated repair`, async () => {
    const f = await setup(async (context, agent) => {
      expect(context.role).toBe(sample.role);
      expect(context.feedback).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: sample.failure === "child" ? "skill.closed" : "action.unknown" }),
      ]));
      expect(await agent.tool("task_finish")).toBe(true);
      expect(await agent.call()).toBe(true);
    });
    if (sample.failure === "child") {
      const child = historyExecution(f.store, f.run, f.root, f.root);
      child.status = "failed";
      child.ended_at = "2020-01-01T00:00:01.000Z";
      f.store.updateSkillExecution(child, "skill.closed", "Child failed before the root selected other work");
    } else f.store.event(f.run.run_id, "action.unknown", "Retired child effect remains unknown", {
      action_id: "unknown",
      ...(sample.failure === "owned_action" ? { execution_id: f.root.execution_id } : {}),
      status: "unknown",
    });
    if (sample.root === "succeeded") finishHistoryExecution(f.store, f.root);
    else {
      f.root.status = "blocked";
      f.root.ended_at = "2020-01-01T00:00:01.000Z";
      f.store.updateSkillExecution(f.root, "skill.closed", "Root could not continue");
    }
    f.state.pending = false;
    await f.planner.start(1);
    const done = f.event("scheduler.turn_finished");
    f.planner.wake("skill_outcome");
    await done;
    expect(f.state.pauses).toEqual([]);
  });
}

test("pending-root uncertainty keeps a bounded decision turn while raw context stays out of compact feedback", async () => {
  const f = await setup(async (context, agent) => {
    expect(context.reason).toEqual(["uncertainty"]);
    expect(context.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ type: "runtime.uncertainty_reconciled", details: expect.objectContaining({ neutralized: true, workers_closed: true, no_replay: true }) })]));
    expect(JSON.stringify(context.feedback)).not.toContain("private-context-marker");
    expect(await agent.call()).toBe(true);
    expect(await agent.tool("program_run")).toBe(true);
    for (let index = 1; index < 12; index++) {
      expect(await agent.call()).toBe(true);
      expect(await agent.tool("program_run")).toBe(true);
    }
    expect(await agent.call()).toBe(false);
  });
  f.store.event(f.run.run_id, "runtime.uncertainty", "Unconfirmed effect fenced", { action_id: "unknown", execution_id: "root", session_id: "session", life_id: 1, status: "unknown", no_replay: true, raw_context: { observation: "private-context-marker" } });
  f.store.event(f.run.run_id, "runtime.uncertainty_reconciled", "Fresh same-life authority", { action_id: "unknown", session_id: "session", life_id: 1, observation_seq: 1, neutralized: true, workers_closed: true, no_replay: true });
  await f.planner.start(1); const done = f.event("scheduler.turn_finished"); f.planner.wake("uncertainty"); await done;
  expect(f.run.usage.calls).toBe(12); expect(f.state.pending).toBe(true); expect(f.state.pauses).toEqual([]);
});

test("an ordinary replan cancels optional overlap without consuming the new wake", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await setup(async (context, agent) => {
    expect(await agent.call()).toBe(true);
    if (context.speculative_plan) { entered.resolve(); await agent.wait(release.promise); }
    else {
      for (let index = 1; index < 12; index++) expect(await agent.call()).toBe(true);
      expect(await agent.call()).toBe(false);
    }
  });
  await f.planner.start(1); const done = f.event("scheduler.turn_finished"); f.optIn(); await entered.promise;
  const receipt = f.store.event(f.run.run_id, "action.failed", "Measured failed action", { action_id: "failure" });
  f.planner.wake("policy_replan"); expect(f.state.aborts).toBe(1); expect(f.speculation.projection()?.state).toBe("invalidated");
  release.resolve(); await done;
  expect(f.state.contexts).toHaveLength(2); expect(f.state.contexts[1]?.speculative_plan).toBeNull();
  expect(f.state.contexts[1]?.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ event_seq: receipt.event_seq })]));
  expect(f.run.usage.calls).toBe(13); expect(f.state.pauses).toEqual([]);
});

test("post-goal review remains finite and effect-free while permitting source and assessment artifacts", async () => {
  const f = await setup(async (context, agent) => {
    expect(context.phase).toBe("reviewing");
    expect(await agent.tool("program_run")).toBe(false); expect(await agent.tool("prepare_next")).toBe(false); expect(await agent.tool("reflex")).toBe(false);
    expect(await agent.tool("program_write")).toBe(true); expect(await agent.tool("program_review")).toBe(true);
    for (let index = 0; index < 3; index++) expect(await agent.call(index === 0 ? [{ name: "program_write" }] : [])).toBe(true);
    expect(await agent.call()).toBe(false);
  });
  f.run.status = "reviewing"; f.state.pending = false;
  await f.planner.start(1); const done = f.event("scheduler.review_finished"); f.planner.wake("goal_review"); await done;
  expect(f.state.reviews).toBe(1); expect(String(f.run.status)).toBe("completed");
  expect(f.run.usage.by_purpose.improvement.calls).toBe(3); expect(f.state.pauses).toEqual([]);
});

test("ordinary authoring shares one root budget across wakes, leaf admissions and inactive revisions", async () => {
  let prompts = 0;
  const f = await setup(async (_context, agent) => {
    prompts++;
    expect(await agent.call()).toBe(true);
    expect(agent.catalog().sort()).toEqual(["help", "observe", "program_inspect", "program_write"]);
    expect(await agent.tool("program_write")).toBe(true);
    for (const forbidden of ["program_submit", "program_run", "prepare_next", "task_finish", "reflex", "memory", "program_review"])
      expect(await agent.tool(forbidden)).toBe(false);
  });
  await f.planner.start(1);
  for (let index = 0; index < 3; index++) {
    f.planner.admitted();
    const child = historyExecution(f.store, f.run, f.root, f.root);
    finishHistoryExecution(f.store, child);
    await f.store.registerSkill(f.run.run_id, historySpec(f.run, `Inactive candidate ${index}`));
    const finished = f.event("scheduler.turn_finished");
    f.planner.wake("planning_continuation");
    await finished;
  }
  expect(prompts).toBe(3); expect(f.run.usage.calls).toBe(3);
  const exited = f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "scheduler.authoring_exited");
  expect(exited).toHaveLength(1); expect(exited[0]?.details).toMatchObject({ reason: "calls", calls: 3, tools: 3 });
  for (const event of f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "model.request_settled"))
    expect(event.details).not.toHaveProperty("host_cancellation");
  vi.useFakeTimers();
  f.planner.admitted(); f.planner.wake("planning_continuation");
  vi.advanceTimersByTime(1000);
  expect(prompts).toBe(3);
  vi.useRealTimers();
  const source = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Genuinely new foreground"));
  const next = historyExecution(f.store, f.run, source);
  f.planner.admitted();
  const finished = f.event("scheduler.turn_finished"); f.planner.wake("planning_continuation"); await finished;
  expect(prompts).toBe(4); expect(f.run.usage.calls).toBe(4);
  expect(f.store.latestRootExecution(f.run.run_id)?.execution_id).toBe(next.execution_id);
  expect(f.state.pauses).toEqual([]);
});

test("ordinary authoring admits exactly twelve tools and fences captured commits on exhaustion", async () => {
  let permit: (() => void) | undefined;
  const f = await setup(async (_context, agent) => {
    expect(await agent.call()).toBe(true);
    permit = f.planner.speculativeToolAuthority();
    for (let index = 0; index < 12; index++) expect(await agent.tool(index % 2 ? "help" : "program_write")).toBe(true);
    permit();
    expect(await agent.tool("program_write")).toBe(false);
    expect(() => permit!()).toThrow("Root-bound authoring authority was revoked");
    expect(await agent.call()).toBe(false);
  });
  await f.planner.start(1);
  const finished = f.event("scheduler.turn_finished"); f.planner.wake("planning_continuation"); await finished;
  expect(f.run.usage.calls).toBe(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).find(event => event.type === "scheduler.authoring_exited")?.details)
    .toMatchObject({ reason: "tools", calls: 1, tools: 12 });
  for (const event of f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "model.request_settled"))
    expect(event.details).not.toHaveProperty("host_cancellation");
  expect(f.state.pauses).toEqual([]);
});

for (const predecessor of ["running", "settled"] as const)
test(`the finite authoring timer cancels only authoring while its real Store root is ${predecessor}`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let permit: (() => void) | undefined;
  const f = await setup(async (_context, agent) => {
    expect(await agent.call()).toBe(true);
    permit = f.planner.speculativeToolAuthority();
    entered.resolve(); await agent.wait(release.promise);
  });
  vi.useFakeTimers();
  await f.planner.start(1);
  const expired = f.event("scheduler.authoring_exited"), finished = f.event("scheduler.turn_finished");
  f.planner.wake("planning_continuation"); vi.advanceTimersByTime(100); await entered.promise;
  if (predecessor === "settled") { finishHistoryExecution(f.store, f.root); f.state.pending = false; }
  vi.advanceTimersByTime(60_000);
  await expired; await finished; release.resolve();
  expect(() => permit!()).toThrow();
  expect(f.store.skillExecution(f.run.run_id, { execution_id: f.root.execution_id })?.status).toBe(predecessor === "running" ? "running" : "succeeded");
  expect(f.state.pauses).toEqual([]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).find(event => event.type === "scheduler.authoring_exited")?.details)
    .toMatchObject({ reason: "deadline", calls: 1, tools: 0 });
  vi.useRealTimers();
});

test("exhausted ordinary authoring does not borrow or suppress the separate explicit speculative allowance", async () => {
  const f = await setup(async (context, agent) => {
    for (let index = 0; index < 3; index++) expect(await agent.call()).toBe(true);
    expect(await agent.call()).toBe(false);
    if (context.speculative_plan) {
      expect(agent.catalog()).toContain("prepare_next");
      expect(agent.catalog()).toContain("program_write");
    }
  });
  await f.planner.start(1);
  const ordinary = f.event("scheduler.turn_finished"); f.planner.wake("planning_continuation"); await ordinary;
  const cursor = Reflect.get(f.planner, "contextCursor");
  f.planner.wake("planning_continuation");
  const speculative = f.event("scheduler.lookahead_finished"); f.optIn(); await speculative;
  expect(f.run.usage.calls).toBe(6);
  expect(f.run.usage.by_purpose.authoring.calls).toBe(3);
  expect(f.run.usage.by_purpose.planning.calls).toBe(3);
  expect(Reflect.get(f.planner, "contextCursor")).toBe(cursor);
  expect(f.state.contexts).toHaveLength(2);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "scheduler.authoring_entered")).toHaveLength(1);
  expect(f.state.pauses).toEqual([]);
});

test("explicit resident and selected attention retain ordinary intent/stop authority after inactive authoring is exhausted", async () => {
  const contexts: Record<string, unknown>[] = [];
  let continued = false, canControl = false;
  const f = await setup(async (context, agent) => {
    contexts.push(context);
    if (contexts.length === 1) {
      for (let index = 0; index < 3; index++) expect(await agent.call()).toBe(true);
      expect(await agent.call()).toBe(false);
    } else {
      expect(context.pending_decision).toBe(true);
      expect(await agent.call()).toBe(true);
      expect(f.planner.toolRole()).toBe("ordinary");
      expect(agent.catalog()).toContain("program_run");
      expect(await agent.tool("program_run")).toBe(true);
      const authority = f.planner.speculativeToolAuthority();
      authority();
      // Reading current state must not consume the whole decision. The model
      // still needs to interpret that result and select an intent or Stop.
      continued = await agent.call();
      canControl = await agent.tool("program_run");
    }
  });
  await f.planner.start(1);
  let finished = f.event("scheduler.turn_finished"); f.planner.wake("planning_continuation"); await finished;
  f.store.event(f.run.run_id, "controller.event", "Resident asks for an intent decision", {
    event: { kind: "attention", urgency: "urgent", summary: "Inspect current obstruction", details: null },
  });
  finished = f.event("scheduler.turn_finished");
  f.planner.wake("resident_attention"); f.planner.wake("selected_attention"); await finished;
  expect(contexts).toHaveLength(2);
  expect(continued).toBe(true);
  expect(canControl).toBe(true);
  expect(contexts[1]?.reason).toEqual(["resident_attention", "selected_attention"]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "scheduler.authoring_entered")).toHaveLength(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).find(event => event.type === "scheduler.authoring_exited")?.details)
    .toMatchObject({ calls: 3, reason: "calls" });
  expect(f.store.skillExecution(f.run.run_id, { execution_id: f.root.execution_id })?.status).toBe("running");
  expect(f.state.pauses).toEqual([]);
});

test("real SDK attention can inspect, load mechanics and observe before stopping the current root", async () => {
  let requests = 0, stopped = false, ungroundedStarts = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns the decision loop"); }, async (model) => {
    const index = requests++;
    const operation = index === 0 ? "inspect" : index === 3 ? "stop" : "start";
    const name = index === 1 ? "help" : index === 2 ? "observe" : "program_run";
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index < 5 ? "toolUse" : "stop",
      content: index < 5 ? [{ type: "toolCall", id: `attention-${index}`, name,
        arguments: name === "program_run" ? { operation, target: "current" } : name === "help" ? { topic: "controller" } : {} }] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }); stream.end();
    return stream;
  });
  const control = f.tools.find(tool => tool.name === "program_run")!;
  control.execute = async (_id, input) => {
    if (input !== null && typeof input === "object" && "operation" in input && input.operation === "start")
      ungroundedStarts++;
    if (input !== null && typeof input === "object" && "operation" in input && input.operation === "stop") {
      stopped = true; f.root.status = "cancelled"; f.root.ended_at = new Date().toISOString(); f.state.pending = false;
      f.store.updateSkillExecution(f.root, "skill.closed", "Selected decision stopped the current root");
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: stopped ? "cancelled" : "running" }) }], details: null };
  };
  await f.planner.start(1);
  const finished = f.event("scheduler.turn_finished");
  f.planner.wake("selected_attention"); await finished;
  expect(requests).toBe(4);
  expect(ungroundedStarts).toBe(0);
  expect(stopped).toBe(true);
  expect(f.state.pending).toBe(false);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: f.root.execution_id })?.status).toBe("cancelled");
  expect(f.run.usage.by_purpose.authoring.calls).toBe(0);
  expect(f.state.pauses).toEqual([]);
});

for (const decision of ["start", "handoff", "intent"] as const)
for (const budget of ["fresh", "exhausted"] as const)
test(`real SDK ${decision} consumes one attention decision after reads and leaf admissions with ${budget} authoring`, async () => {
  let requests = 0, decisions = 0, inactiveWrites = 0, inspections = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns the decision loop"); }, async (model, context) => {
    const index = requests++ - (budget === "exhausted" ? 3 : 0);
    if (index >= 0 && index <= 4) expect(context.tools?.some(tool => tool.name === "program_run")).toBe(true);
    else {
      expect(context.tools?.map(tool => tool.name).sort()).toEqual(["help", "observe", "program_inspect", "program_write"]);
      expect(f.planner.toolRole()).toBe("authoring");
    }
    const name = index < 0 ? "program_inspect" : index === 0 || index === 4 ? "program_run" : index === 1 ? "help"
      : index === 2 ? "observe" : index === 3 ? "program_write" : "program_inspect";
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: `decision-${index}`, name,
        arguments: name === "program_run" ? { operation: index === 0 ? "inspect" : decision === "intent" ? "update_intent" : decision, target: "current" } : {} }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: "toolUse", message }); stream.end();
    return stream;
  });
  finishHistoryExecution(f.store, f.root);
  const spec = await f.store.registerSkill(f.run.run_id, { ...historySpec(f.run, "Selected resident"), entry: "step" });
  const root = f.store.admitSkill(f.run.run_id, { entry: "step", skill_id: spec.skill_id, version: spec.version,
    start_key: "selected-resident", ...executionScopeFixture(f.run), args: null, initial_state: null,
    limits: { ...DEFAULT_RESIDENT_LIMITS } }).view;
  if (root.entry !== "step") throw new Error("Resident fixture admission lost its selected entry");
  const snapshot = (version: number): ResidentSnapshot => ({
    execution_id: root.execution_id, source_hash: root.source_hash!, controller_generation: 1, host_clock_id: "fixture-clock",
    status: "running", reason: null, intent_version: version, state: null,
    processed_frame_seq: null, processed_native_tick: null, processed_native_ns: null,
    counters: { frames: 0, steps: 0, submissions: 0, applied_sequence: 0, ordered_edge_prefix: 0, missed_slots: 0,
      stale_results: 0, stale_frames: 0, read_failures: 0, no_input_decisions: 0, expanded_edges: 0, events: 0,
      analysis_jobs: 0, analysis_ms: 0 },
    pending: { frames: 0, edges: 0, analysis: false }, last_input: null,
    timings: { step_ms: { count: 0, p50: null, p95: null, p99: null, max: null, omitted_samples: 0 },
      input_age_ms: { count: 0, p50: null, p95: null, p99: null, max: null, omitted_samples: 0 } },
    events: [], cleanup: { worker: "open", native: "open" },
  });
  // Readiness is not a decision: an admitted resident has initial intent zero
  // even before the worker publishes its first snapshot.
  f.tools.find(tool => tool.name === "observe")!.execute = async () => {
    root.status = "running"; root.started_at = new Date().toISOString(); root.resident = snapshot(0);
    f.store.updateSkillExecution(root, "controller.ready", "Resident became ready without an intent decision");
    f.planner.admitted();
    return { content: [], details: null };
  };
  f.tools.find(tool => tool.name === "help")!.execute = async () => {
    // The same admission callback reports foreground leaf effects, not just
    // primary program starts. It cannot consume a control decision.
    f.planner.admitted();
    return { content: [], details: null };
  };
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => {
    await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Pure inactive decision draft"));
    inactiveWrites++;
    return { content: [], details: null };
  };
  f.tools.find(tool => tool.name === "program_run")!.execute = async (_id, input) => {
    if (input !== null && typeof input === "object" && "operation" in input && input.operation === "inspect")
      return { content: [], details: { status: root.status } };
    decisions++;
    if (decision === "intent") {
      root.resident = snapshot(1);
      f.store.updateSkillExecution(root, "controller.intent", "Primary same-root intent selected");
    } else {
      root.status = "cancelled"; root.ended_at = new Date().toISOString();
      f.store.updateSkillExecution(root, "skill.closed", "Primary root replacement selected");
      const replacement = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "New selected foreground"));
      historyExecution(f.store, f.run, replacement);
    }
    f.planner.admitted();
    return { content: [], details: null };
  };
  f.tools.find(tool => tool.name === "program_inspect")!.execute = async () => {
    inspections++; return { content: [], details: null };
  };
  await f.planner.start(1);
  if (budget === "exhausted") {
    const exhausted = f.event("scheduler.turn_finished");
    f.planner.wake("planning_continuation"); await exhausted;
  }
  const finished = f.event("scheduler.turn_finished");
  f.planner.wake("selected_attention"); await finished;
  const replaced = decision !== "intent";
  const postDecisionCalls = budget === "fresh" || replaced ? 3 : 0;
  expect(requests).toBe((budget === "exhausted" ? 3 : 0) + 5 + postDecisionCalls);
  expect(decisions).toBe(1); expect(inactiveWrites).toBe(1);
  expect(inspections).toBe((budget === "exhausted" ? 3 : 0) + postDecisionCalls);
  expect(f.state.pending).toBe(true);
  expect(f.state.pauses).toEqual([]);
  const entered = f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "scheduler.authoring_entered");
  expect(entered).toHaveLength(decision === "intent" ? 1 : 2);
});

for (const settlement of ["stop", "outcome"] as const)
test(`real SDK ${settlement} retires the old decision without consuming its queued outcome wake`, async () => {
  const projections: Record<string, unknown>[] = [];
  let outcomeSequence = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns the decision loop"); }, async (model, context) => {
    const user = context.messages.find(message => message.role === "user")!;
    if (user.role !== "user") throw new Error("Missing decision projection");
    const text = typeof user.content === "string" ? user.content :
      user.content.filter(part => part.type === "text").map(part => part.text).join("");
    const index = projections.push(JSON.parse(text)) - 1;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index === 0 ? "toolUse" : "stop",
      content: index === 0 ? [{ type: "toolCall", id: "settle-decision",
        name: settlement === "stop" ? "program_run" : "observe", arguments: { operation: "stop", target: "current" } }] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: index === 0 ? "toolUse" : "stop", message }); stream.end();
    return stream;
  });
  f.tools.find(tool => tool.name === (settlement === "stop" ? "program_run" : "observe"))!.execute = async () => {
    f.root.status = settlement === "stop" ? "cancelled" : "succeeded";
    f.root.ended_at = new Date().toISOString(); f.state.pending = false;
    f.store.updateSkillExecution(f.root, "skill.closed", "Selected predecessor retired");
    outcomeSequence = f.store.latestEvent(f.run.run_id, "skill.closed")!.event_seq;
    f.planner.wake("skill_outcome");
    return { content: [], details: null };
  };
  await f.planner.start(1);
  const finished = new Promise<void>(resolve => {
    let turns = 0;
    const off = f.store.subscribe(event => {
      if (event.run_id === f.run.run_id && event.type === "scheduler.turn_finished" && ++turns === 2) { off(); resolve(); }
    });
  });
  f.planner.wake("selected_attention"); await finished;
  expect(projections).toHaveLength(2);
  expect(projections[0]?.pending_decision).toBe(true);
  expect(projections[1]?.reason).toEqual(["skill_outcome"]);
  expect(projections[1]?.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ event_seq: outcomeSequence })]));
  expect(f.state.pauses).toEqual([]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "scheduler.turn_finished")
    .map(event => object(event.details)?.calls)).toEqual([1, 1]);
});

for (const ending of ["root_replaced", "deadline", "scope_lost", "stop"] as const)
  test(`captured authoring authority cannot commit after ${ending} in the same serialized owner`, async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let permit: (() => void) | undefined;
    const f = await setup(async (_context, agent) => {
      expect(await agent.call()).toBe(true);
      permit = f.planner.speculativeToolAuthority(); permit();
      entered.resolve(); await agent.wait(release.promise);
    });
    await f.planner.start(1);
    const finished = f.event("scheduler.turn_finished"); f.planner.wake("planning_continuation"); await entered.promise;
    if (ending === "root_replaced") {
      finishHistoryExecution(f.store, f.root);
      const source = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Replacement foreground"));
      historyExecution(f.store, f.run, source);
    }
    else if (ending === "deadline") vi.spyOn(Date, "now").mockReturnValue(Date.parse(f.root.deadline_at) + 1);
    else if (ending === "scope_lost") f.run.space_epoch = f.run.space_epoch! + 1;
    else f.planner.fence();
    expect(() => permit!()).toThrow();
    release.resolve();
    if (ending === "stop") await f.planner.close();
    else await finished;
    expect(f.state.pauses).toEqual([]);
    expect(f.run.usage.calls).toBe(1);
    if (ending !== "root_replaced")
      expect(f.store.skillExecution(f.run.run_id, { execution_id: f.root.execution_id })?.status).toBe("running");
  });

test("root settlement queues ordinary outcome work behind bounded inactive authoring without granting effects", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let prompts = 0;
  const f = await setup(async (_context, agent) => {
    prompts++;
    expect(await agent.call()).toBe(true);
    if (prompts === 1) {
      const permit = f.planner.speculativeToolAuthority();
      entered.resolve(); await agent.wait(release.promise);
      permit();
      expect(f.state.aborts).toBe(0);
      expect(f.planner.toolRole()).toBe("authoring");
      expect(await agent.tool("program_write")).toBe(true);
      for (const forbidden of ["program_run", "program_submit", "prepare_next", "task_finish", "reflex"])
        expect(await agent.tool(forbidden)).toBe(false);
      const candidate = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Post-root inactive candidate"));
      permit();
      expect(f.store.skillExecutions(f.run.run_id).some(execution => execution.skill_id === candidate.skill_id)).toBe(false);
      expect(await agent.call()).toBe(true);
      expect(await agent.call()).toBe(true);
      expect(await agent.call()).toBe(false);
    }
    else expect(f.planner.toolRole()).toBe("ordinary");
  });
  await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
  finishHistoryExecution(f.store, f.root); f.state.pending = false;
  const next = f.event("scheduler.turn_started");
  f.planner.wake("skill_outcome");
  expect(prompts).toBe(1); expect(f.state.aborts).toBe(0);
  release.resolve(); await next;
  await f.event("scheduler.turn_finished");
  expect(prompts).toBe(2); expect(f.run.usage.calls).toBe(4); expect(f.state.pauses).toEqual([]);
});

for (const status of ["blocked", "failed"] as const)
test(`unsuccessful ${status} root preempts inactive authoring before fresh outcome handling`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), decided = Promise.withResolvers<void>();
  let prompts = 0, permit: (() => void) | undefined;
  const f = await setup(async (_context, agent) => {
    if (++prompts === 1) {
      expect(await agent.call()).toBe(true);
      permit = f.planner.speculativeToolAuthority();
      entered.resolve();
      await agent.wait(release.promise);
      expect(() => permit!()).toThrow();
    } else {
      expect(f.planner.toolRole()).toBe("ordinary");
      expect(await agent.call()).toBe(true);
      decided.resolve();
    }
  });
  await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
  f.root.status = status; f.root.ended_at = new Date().toISOString();
  f.root.result = { status, summary: "Current work could not continue", result: null };
  f.store.updateSkillExecution(f.root, "skill.closed", f.root.result.summary);
  f.state.pending = false;
  f.planner.wake("skill_outcome");
  try {
    expect(f.state.aborts).toBe(1);
    await decided.promise;
    expect(prompts).toBe(2);
    expect(f.state.pauses).toEqual([]);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: f.root.execution_id })?.status).toBe(status);
  } finally { release.resolve(); }
});

for (const ending of ["fenced", "scope_lost"] as const)
test(`real SDK ${ending} cancellation retains exact host provenance without stale writes`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, writes = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns this response"); }, async model => {
    const index = requests++;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index === 0 ? "toolUse" : "stop",
      content: index === 0 ? [{ type: "toolCall", id: "late-authoring-write", name: "program_write", arguments: {} }] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      if (index === 0) { entered.resolve(); await release.promise; }
      stream.end(message);
      yield { type: "done", reason: index === 0 ? "toolUse" : "stop", message };
    };
    return stream;
  });
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => { writes++; return { content: [], details: null }; };
  await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
  finishHistoryExecution(f.store, f.root); f.state.pending = false;
  const completed = ending === "fenced" ? null : new Promise<void>(resolve => {
    const off = f.store.subscribe(event => {
      if (event.run_id === f.run.run_id && event.type === "scheduler.turn_finished") { off(); resolve(); }
    });
  });
  if (ending === "fenced") f.planner.fence();
  else { f.run.space_epoch = f.run.space_epoch! + 1; f.planner.toolRole(); }
  release.resolve();
  if (ending === "fenced") await f.planner.close();
  else await completed;
  expect(requests).toBe(1);
  expect(writes).toBe(0); expect(f.state.pauses).toEqual([]);
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const first = events.find(event => event.type === "model.call");
  const requestId = object(first?.details ?? null)?.request_id;
  expect(events.find(event => event.type === "model.request_settled" && object(event.details)?.request_id === requestId)?.details)
    .toMatchObject({ role: "authoring", obsolete: true, stop_reason: "aborted", provider_failure: false,
      recovered_failure: { type: "stream_interrupted_after_content" },
      host_cancellation: { kind: "ordinary_authoring", request_id: requestId,
        root_execution_id: f.root.execution_id, reason: ending } });
  expect(events.some(event => event.type === "scheduler.turn_failed")).toBe(false);
  const usage = events.find(event => event.type === "model.usage" && object(event.details)?.request_id === requestId);
  expect(usage?.details).toHaveProperty("usage_evidence.provider_terminal", null);
});

for (const role of ["planning", "recovery"] as const)
test(`real SDK lifecycle fence retains trusted ${role} cancellation without stale tools`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, writes = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns this response"); }, async model => {
    requests++;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: "late-ordinary-write", name: "program_write", arguments: {} }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      entered.resolve(); await release.promise;
      stream.end(message);
      yield { type: "done", reason: "toolUse", message };
    };
    return stream;
  });
  f.state.pending = false;
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => { writes++; return { content: [], details: null }; };
  await f.planner.start(1); f.planner.wake(role === "recovery" ? "death" : "planning_continuation"); await entered.promise;
  f.planner.fence(); f.planner.fence();
  const closing = f.planner.close(); release.resolve(); await closing;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const requestId = object(events.find(event => event.type === "model.call")?.details ?? null)?.request_id;
  expect(events.find(event => event.type === "model.request_settled")?.details)
    .toMatchObject({ request_id: requestId, role, obsolete: true, stop_reason: "aborted", provider_failure: false,
      recovered_failure: { type: "stream_interrupted_after_content" },
      host_cancellation: { kind: "strategic_host", request_id: requestId, reason: "fenced" } });
  expect(object(events.find(event => event.type === "model.request_settled")?.details ?? null)?.host_cancellation)
    .not.toHaveProperty("root_execution_id");
  expect(events.find(event => event.type === "model.usage")?.details)
    .toHaveProperty("usage_evidence.provider_terminal", null);
  expect(requests).toBe(1); expect(writes).toBe(0); expect(f.state.pauses).toEqual([]);
  expect(events.some(event => event.type === "model.tool_started" || event.type === "scheduler.turn_failed")).toBe(false);
});

test("real SDK speculative preemption preserves its first cancellation cause through a later fence", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, tools = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns this response"); }, async model => {
    requests++;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: "late-speculative-observe", name: "observe", arguments: {} }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      entered.resolve(); await release.promise;
      stream.end(message);
      yield { type: "done", reason: "toolUse", message };
    };
    return stream;
  });
  f.tools.find(tool => tool.name === "observe")!.execute = async () => { tools++; return { content: [], details: null }; };
  await f.planner.start(1); f.optIn(); await entered.promise;
  f.planner.wake("death");
  expect(f.speculation.projection()?.state).toBe("invalidated");
  f.planner.fence();
  const closing = f.planner.close(); release.resolve(); await closing;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const requestId = object(events.find(event => event.type === "model.call")?.details ?? null)?.request_id;
  expect(events.find(event => event.type === "model.request_settled")?.details)
    .toMatchObject({ request_id: requestId, role: "speculative", obsolete: true, stop_reason: "aborted", provider_failure: false,
      recovered_failure: { type: "stream_interrupted_after_content" },
      host_cancellation: { kind: "strategic_host", request_id: requestId, reason: "speculative_preempted" } });
  expect(requests).toBe(1); expect(tools).toBe(0); expect(f.state.pauses).toEqual([]);
  expect(events.some(event => event.type === "model.tool_started")).toBe(false);
});

test("real SDK ordinary deadline is trusted host cancellation but still fails the current turn", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let writes = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns this response"); }, async model => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: "late-deadline-write", name: "program_write", arguments: {} }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      entered.resolve(); await release.promise;
      stream.end(message);
      yield { type: "done", reason: "toolUse", message };
    };
    return stream;
  });
  f.state.pending = false;
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => { writes++; return { content: [], details: null }; };
  await f.planner.start(1);
  const schedule = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const captureDeadline = (...[callback, delay, ...args]: Parameters<typeof setTimeout>) => {
    if (delay !== undefined && delay > 119_000 && delay <= 120_000)
      expire = () => callback(...args);
    return schedule(callback, delay, ...args);
  };
  vi.spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(captureDeadline, schedule));
  const failed = f.event("scheduler.turn_failed");
  f.planner.wake("uncertainty"); await entered.promise;
  const deadline = Date.now() + 120_001;
  vi.spyOn(Date, "now").mockReturnValue(deadline);
  expect(expire).toBeDefined(); expire!();
  release.resolve(); await failed;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const requestId = object(events.find(event => event.type === "model.call")?.details ?? null)?.request_id;
  expect(events.find(event => event.type === "model.request_settled")?.details)
    .toMatchObject({ request_id: requestId, role: "recovery", obsolete: false, stop_reason: "aborted", provider_failure: false,
      recovered_failure: { type: "stream_interrupted_after_content" },
      host_cancellation: { kind: "strategic_host", request_id: requestId, reason: "turn_deadline" } });
  expect(events.find(event => event.type === "scheduler.turn_failed")?.details)
    .toMatchObject({ deadline_reached: true, provider_failed: false, provider_aborted: false, pause_cause: "deadline" });
  expect(events.some(event => event.type === "scheduler.turn_finished" || event.type === "model.tool_started")).toBe(false);
  expect(f.run.usage.calls).toBe(1); expect(writes).toBe(0); expect(f.state.pauses).toHaveLength(1);
});

for (const role of ["planning", "recovery"] as const)
test(`real SDK provider abort received before a ${role} host fence cannot acquire cancellation provenance`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await setup(async () => { throw new Error("Installed SDK owns this response"); }, async model => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "aborted", errorMessage: "Provider aborted before host intent",
      content: [{ type: "toolCall", id: "provider-aborted-write", name: "program_write", arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      entered.resolve(); await release.promise;
      stream.end(message);
      yield { type: "error", reason: "aborted", error: message };
    };
    return stream;
  });
  f.state.pending = false;
  await f.planner.start(1); f.planner.wake(role === "recovery" ? "death" : "planning_continuation"); await entered.promise;
  const off = f.store.subscribe(event => {
    if (event.run_id === f.run.run_id && event.type === "model.purpose_classified") f.planner.fence();
  });
  const settled = f.event("model.request_settled"); release.resolve(); await settled; off();
  await f.planner.close();
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const result = events.find(event => event.type === "model.request_settled");
  expect(result?.details).toMatchObject({ role, stop_reason: "aborted", provider_failure: true,
    recovered_failure: { type: "stream_interrupted_after_content" } });
  expect(result?.details).not.toHaveProperty("host_cancellation");
  expect(events.some(event => event.type === "model.tool_started")).toBe(false);
});

for (const stopReason of ["error", "aborted"] as const)
test(`real SDK provider ${stopReason} remains a failure after root settlement during inactive authoring`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = await setup(async () => { throw new Error("Installed SDK owns this response"); }, async model => {
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason, errorMessage: "Unrecoverable provider failure",
      content: [{ type: "toolCall", id: "failed-authoring-write", name: "program_write", arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      entered.resolve(); await release.promise;
      stream.end(message);
      yield { type: "error", reason: stopReason, error: message };
    };
    return stream;
  });
  await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
  finishHistoryExecution(f.store, f.root); f.state.pending = false;
  const finished = new Promise<void>(resolve => {
    const off = f.store.subscribe(event => {
      if (event.run_id === f.run.run_id && ["scheduler.turn_failed", "scheduler.turn_finished"].includes(event.type)) {
        off(); resolve();
      }
    });
  });
  release.resolve(); await finished;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const settled = events.find(event => event.type === "model.request_settled");
  expect(settled?.details).toMatchObject({ role: "authoring", stop_reason: stopReason, obsolete: false, provider_failure: true,
    recovered_failure: { type: "stream_interrupted_after_content" } });
  expect(settled?.details).not.toHaveProperty("host_cancellation");
  expect(f.state.pauses).toHaveLength(1);
  expect(events.some(event => event.type === "model.tool_started")).toBe(false);
});

test("urgent repeated attention cancels optional speculative authoring only once", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let prompts = 0;
  const f = await setup(async (context, agent) => {
    expect(await agent.call()).toBe(true);
    if (++prompts === 1) { entered.resolve(); await agent.wait(release.promise); }
    else expect(context.pending_decision).toBe(true);
  });
  try {
    await f.planner.start(1); f.optIn(); await entered.promise;
    f.store.event(f.run.run_id, "controller.event", "Urgent optional preemption", {
      event: { kind: "attention", urgency: "urgent", summary: "Urgent optional preemption", details: null },
    });
    const finished = f.event("scheduler.turn_finished");
    f.planner.wake("resident_attention"); f.planner.wake("resident_attention"); f.planner.wake("policy_interrupt");
    expect(f.state.aborts).toBe(1);
    await finished;
    expect(prompts).toBe(2); expect(f.speculation.projection()?.state).toBe("invalidated");
    expect(f.state.pauses).toEqual([]);
  } finally { release.resolve(); }
});

for (const predecessor of ["running", "settled"] as const)
for (const trigger of ["resident_attention", "policy_interrupt"] as const)
test(`real SDK ${trigger} urgently drains held ${predecessor} authoring before fresh decision`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const reserved: string[] = [], transported: string[] = [], drained: string[] = [];
  let requests = 0, writes = 0, starts = 0, aborted = 0, heldSignal: AbortSignal | undefined;
  const f = await setup(async () => { throw new Error("Installed SDK owns the tool loop"); }, async (model, context, options) => {
    const index = requests++;
    if (index === 2) {
      expect(transported).toEqual(reserved.slice(0, 2));
      const user = context.messages.find(message => message.role === "user")!;
      if (user.role !== "user") throw new Error("Missing fresh decision projection");
      const text = typeof user.content === "string" ? user.content :
        user.content.filter(part => part.type === "text").map(part => part.text).join("");
      const projection = JSON.parse(text);
      expect(projection.role).toBe(trigger === "policy_interrupt" ? "recovery" : "planning");
      expect(projection.pending_decision).toBe(predecessor === "running");
      if (trigger === "resident_attention") expect(JSON.stringify(projection)).toContain("Fresh urgent evidence");
      expect(context.tools?.some(tool => tool.name === "program_run")).toBe(true);
    }
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index < 2 ? "toolUse" : "stop",
      content: index < 2 ? [{ type: "toolCall", id: `urgent-write-${index}`, name: "program_write", arguments: {} },
        ...(index === 1 ? [{ type: "toolCall" as const, id: "late-urgent-start", name: "program_run", arguments: {} }] : [])] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      if (index === 1) {
        heldSignal = options?.signal;
        const cancelled = Promise.withResolvers<void>();
        const onAbort = () => { aborted++; cancelled.resolve(); };
        heldSignal?.addEventListener("abort", onAbort, { once: true });
        entered.resolve();
        try { await Promise.race([release.promise, cancelled.promise]); }
        finally { heldSignal?.removeEventListener("abort", onAbort); }
      }
      stream.end(message); yield { type: "done", reason: index < 2 ? "toolUse" : "stop", message };
    };
    return stream;
  }, { reserve: id => { reserved.push(id); }, transportEnded: id => { transported.push(id); },
    drained: ids => { drained.push(...ids); } });
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => {
    const authority = f.planner.speculativeToolAuthority();
    const source = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Completed urgent draft"));
    authority(); writes++;
    return { content: [], details: { name: source.name, version: source.version } };
  };
  f.tools.find(tool => tool.name === "program_run")!.execute = async () => { starts++; return { content: [], details: null }; };
  try {
    await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
    expect(writes).toBe(1);
    if (predecessor === "settled") { finishHistoryExecution(f.store, f.root); f.state.pending = false; f.planner.wake("skill_outcome"); }
    if (trigger === "resident_attention") f.store.event(f.run.run_id, "controller.event", "Fresh urgent evidence", {
      event: { kind: "attention", urgency: "urgent", summary: "Fresh urgent evidence", details: null },
    });
    const freshFinished = new Promise<void>(resolve => {
      let finished = 0;
      const off = f.store.subscribe(event => {
        if (event.run_id === f.run.run_id && event.type === "scheduler.turn_finished" && ++finished === 2) { off(); resolve(); }
      });
    });
    f.planner.wake(trigger); f.planner.wake(trigger); f.planner.wake(trigger);
    expect(heldSignal?.aborted).toBe(true);
    expect(aborted).toBe(1);
    await freshFinished;
    expect(requests).toBe(3); expect(writes).toBe(1); expect(starts).toBe(0);
    expect(f.store.namedSkill(f.run.run_id, "Completed urgent draft")?.version).toBe(1);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: f.root.execution_id })?.status)
      .toBe(predecessor === "running" ? "running" : "succeeded");
    const events = f.store.eventsAfter(f.run.run_id, 0, 500);
    expect(events.find(event => event.type === "model.request_settled" && object(event.details)?.request_id === reserved[1])?.details)
      .toMatchObject({ role: "authoring", obsolete: true, stop_reason: "aborted", provider_failure: false,
        host_cancellation: { kind: "ordinary_authoring", request_id: reserved[1],
          root_execution_id: f.root.execution_id, reason: trigger } });
    expect(events.filter(event => event.type === "scheduler.authoring_entered")).toHaveLength(1);
    expect(events.some(event => event.type === "scheduler.turn_failed")).toBe(false);
    expect(f.run.usage.calls).toBe(3); expect(f.state.pauses).toEqual([]);
  } finally {
    release.resolve(); await f.planner.close();
  }
  expect(transported).toEqual(reserved); expect(drained).toEqual(reserved);
});

test("real SDK urgent attention revokes request-free inactive publication without discarding saved source", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, writes = 0, revoked = false;
  const f = await setup(async () => { throw new Error("Installed SDK owns the tool loop"); }, async model => {
    const index = requests++;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index < 2 ? "toolUse" : "stop",
      content: index < 2 ? [{ type: "toolCall", id: `seam-write-${index}`, name: "program_write", arguments: {} }] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: index < 2 ? "toolUse" : "stop", message }); stream.end();
    return stream;
  });
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => {
    const authority = f.planner.speculativeToolAuthority();
    if (writes === 1) {
      entered.resolve(); await release.promise;
      try { authority(); } catch { revoked = true; return { content: [], details: null }; }
    }
    authority();
    const source = await f.store.registerSkill(f.run.run_id, historySpec(f.run, writes ? "Revoked seam draft" : "Saved seam draft"));
    writes++;
    return { content: [], details: { name: source.name, version: source.version } };
  };
  try {
    await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
    finishHistoryExecution(f.store, f.root); f.state.pending = false;
    f.store.event(f.run.run_id, "controller.event", "Urgent publication seam", {
      event: { kind: "attention", urgency: "urgent", summary: "Urgent publication seam", details: null },
    });
    f.planner.wake("resident_attention"); f.planner.wake("resident_attention");
    const finished = new Promise<void>(resolve => {
      let count = 0;
      const off = f.store.subscribe(event => {
        if (event.run_id === f.run.run_id && event.type === "scheduler.turn_finished" && ++count === 2) { off(); resolve(); }
      });
    });
    release.resolve(); await finished;
    expect(revoked).toBe(true); expect(writes).toBe(1); expect(requests).toBe(3);
    expect(f.store.namedSkill(f.run.run_id, "Saved seam draft")?.version).toBe(1);
    expect(f.store.namedSkill(f.run.run_id, "Revoked seam draft")).toBeNull();
    expect(f.state.pauses).toEqual([]);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "model.request_settled")
      .every(event => !object(event.details)?.host_cancellation)).toBe(true);
  } finally { release.resolve(); }
});

for (const event of [
  { kind: "attention", urgency: "ordinary" },
  { kind: "diagnostic", urgency: "urgent" },
] as const)
test(`real SDK ${event.urgency} ${event.kind} retains useful settlement grace`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, writes = 0, signal: AbortSignal | undefined;
  const f = await setup(async () => { throw new Error("Installed SDK owns the response"); }, async (model, _context, options) => {
    const index = requests++;
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index === 0 ? "toolUse" : "stop",
      content: index === 0 ? [{ type: "toolCall", id: "nonurgent-write", name: "program_write", arguments: {} }] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      if (index === 0) { signal = options?.signal; entered.resolve(); await release.promise; }
      stream.end(message); yield { type: "done", reason: index === 0 ? "toolUse" : "stop", message };
    };
    return stream;
  });
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => {
    f.planner.speculativeToolAuthority()(); writes++; return { content: [], details: null };
  };
  try {
    await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
    finishHistoryExecution(f.store, f.root); f.state.pending = false;
    f.store.event(f.run.run_id, "controller.event", "Non-attention urgency is not urgent demand", {
      event: { ...event, summary: "Non-preempting evidence", details: null },
    });
    f.planner.wake("resident_attention");
    expect(signal?.aborted).toBe(false); expect(requests).toBe(1);
    const finished = f.event("scheduler.turn_finished"); release.resolve(); await finished;
    expect(writes).toBe(1); expect(f.state.pauses).toEqual([]);
  } finally { release.resolve(); }
});

test("the real SDK continues after submit through evidence and inactive validated source while the foreground body advances", async () => {
  let requests = 0, effects = 0, wrote = false;
  const continueBody = Promise.withResolvers<void>(), finishBody = Promise.withResolvers<void>();
  const firstEffect = Promise.withResolvers<void>(), secondEffect = Promise.withResolvers<void>();
  const f = await setup(async () => { throw new Error("Installed SDK owns the tool loop"); }, async (model, context) => {
    const index = requests++;
    if (index > 0) {
      expect(context.tools?.map(tool => tool.name).sort()).toEqual(["help", "observe", "program_inspect", "program_write"]);
      const supplement = context.systemPrompt?.at(-1)!;
      expect(Buffer.byteLength(supplement)).toBeLessThanOrEqual(32768);
      const retained = JSON.parse(supplement).strategic_context;
      const projection = context.messages.find(message => message.role === "user")!;
      expect(projection.role).toBe("user");
      if (projection.role !== "user") throw new Error("Missing actual request projection");
      const text = typeof projection.content === "string" ? projection.content :
        projection.content.filter(part => part.type === "text").map(part => part.text).join("");
      expect(JSON.parse(text)).toMatchObject({ role: "authoring", phase: "running", pending_decision: false,
        pending_authoring: { phase: "authoring" } });
      expect(JSON.parse(text).instruction).toContain("inactive source");
      if (index > 1) expect(JSON.stringify(retained.requested_help)).toContain("Pure inactive source may be saved");
      expect(retained.pending_authoring).toMatchObject({ phase: "authoring", root: { name: "SDK foreground", version: 1 },
        remaining_calls: 3 - index, remaining_tools: index === 1 ? 12 : index === 2 ? 10 : 9 });
      expect(JSON.stringify(retained.pending_authoring)).not.toContain(f.store.latestRootExecution(f.run.run_id)!.execution_id);
      expect(manager.pending).toBe(true);
    }
    const names = index === 0 ? ["program_submit"] : index === 1 ? ["help", "program_inspect"] : index === 2 ? ["program_write"] : ["observe"];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: "toolUse",
      content: names.map((name, ordinal) => ({ type: "toolCall", id: `${index}-${ordinal}`, name, arguments: {} })),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "toolUse", message }); stream.end();
    return stream;
  });
  finishHistoryExecution(f.store, f.root); f.state.pending = false;
  const manager = new SkillManager(f.store, { runSkill: async (_source, _args, handle) => {
    await handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } }); firstEffect.resolve();
    await continueBody.promise;
    await handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } }); secondEffect.resolve();
    await finishBody.promise;
    return { status: "completed", summary: "Foreground fixture finished", result: null };
  } }, {
    authorize: () => {}, adapter: () => f.adapter, binding: () => minecraftTestBinding(f.adapter),
    observe: async () => minecraftObservationFixture(f.adapter), queryCapability: async () => [],
    action: async () => { effects++; f.planner.admitted(); return { status: "succeeded", summary: "Fixture effect settled", evidence: { effect_confirmed: true } }; },
    recover: async () => { throw new Error("No recovery requested"); }, cancelActions: async () => {},
    changed: () => { f.state.pending = manager.pending; }, unsafe: () => { throw new Error("Unexpected cleanup uncertainty"); },
  });
  managers.push(manager);
  const foreground = 'await game.action({kind:"look",yaw:0,pitch:0}); await game.action({kind:"look",yaw:1,pitch:0}); return {status:"completed",summary:"Foreground fixture finished",result:null};';
  const card = { purpose: "SDK overlap regression", applicability: "Offline fixture", method: "Two bounded effects",
    reason: "Keep foreground work independent of authoring", limitations: "No native or model adoption claim" };
  const install = (name: string, execute: AgentTool["execute"]) => { f.tools.find(tool => tool.name === name)!.execute = execute; };
  install("program_submit", async () => {
    const program = await manager.register(f.run.run_id, { entry: "run", name: "SDK foreground", source: foreground, card, dependencies: [] });
    manager.start(f.run.run_id, { entry: "run", skill_id: program.skill_id, version: program.version,
      start_key: "sdk-foreground", ...executionScopeFixture(f.run), args: null,
      limits: { duration_ms: 10000, max_actions: 2, max_calls: 2, max_depth: 1 } });
    f.planner.admitted(); await firstEffect.promise;
    expect(f.planner.toolRole()).toBe("ordinary");
    return { content: [], details: { name: program.name, version: program.version } };
  });
  install("help", async () => {
    continueBody.resolve(); await secondEffect.promise;
    return { content: [], details: { programs: "Pure inactive source may be saved" } };
  });
  install("program_inspect", async () => ({ content: [], details: { status: "running" } }));
  install("program_write", async () => {
    const permit = f.planner.speculativeToolAuthority();
    const program = await manager.register(f.run.run_id, { entry: "run", name: "SDK inactive candidate",
      source: 'const current = await game.observe(); return {status:"blocked",summary:"Inactive authored candidate",result:{observed:current.observation_seq}};',
      dependencies: [], card }, () => permit());
    wrote = true;
    expect(manager.pending).toBe(true); expect(effects).toBe(2);
    return { content: [], details: { name: program.name, version: program.version } };
  });
  install("observe", async () => ({ content: [], details: { foreground_effects: effects } }));
  try {
    await f.planner.start(1); const finished = f.event("scheduler.turn_finished"); f.planner.wake("preflight_ready"); await finished;
    expect(requests).toBe(4); expect(wrote).toBe(true); expect(effects).toBe(2);
    expect(f.run.usage.calls).toBe(4); expect(f.run.usage.by_purpose.authoring.calls).toBe(4);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event =>
      event.type === "model.call" && object(event.details)?.role === "authoring")).toHaveLength(3);
    expect(manager.pending).toBe(true);
    const draft = f.store.namedSkill(f.run.run_id, "SDK inactive candidate")!;
    expect(draft.state).toBe("validated");
    expect(f.store.skillExecutions(f.run.run_id).filter(execution => execution.skill_id === draft.skill_id)).toEqual([]);
    expect(f.store.latestRootExecution(f.run.run_id)?.status).toBe("running");
    expect(f.state.pauses).toEqual([]);
  } finally { continueBody.resolve(); finishBody.resolve(); }
});

test("real SDK publishes inactive source after root settlement without acquiring activation authority", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, writes = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns this tool loop"); }, async (model, context) => {
    const index = requests++;
    if (index === 3) {
      const user = context.messages.find(message => message.role === "user")!;
      if (user.role !== "user") throw new Error("Missing ordinary outcome projection");
      const text = typeof user.content === "string" ? user.content :
        user.content.filter(part => part.type === "text").map(part => part.text).join("");
      expect(JSON.parse(text)).toMatchObject({ role: "planning", pending_decision: false, pending_authoring: null });
      expect(context.tools?.some(tool => tool.name === "program_run")).toBe(true);
    }
    if (index > 0 && index < 3) {
      expect(context.tools?.map(tool => tool.name).sort()).toEqual(["help", "observe", "program_inspect", "program_write"]);
      const user = context.messages.find(message => message.role === "user")!;
      if (user.role !== "user") throw new Error("Missing actual request projection");
      const text = typeof user.content === "string" ? user.content :
        user.content.filter(part => part.type === "text").map(part => part.text).join("");
      expect(JSON.parse(text)).toMatchObject({ role: "authoring", pending_decision: false,
        pending_authoring: { phase: "authoring" } });
    }
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: index < 2 ? "toolUse" : "stop",
      content: index < 2 ? [{ type: "toolCall", id: `retained-help-${index}`, name: index === 0 ? "help" : "program_write",
        arguments: index === 0 ? { topic: "game" } : {} }] : [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      yield { type: "start", partial: message };
      if (index === 1) { entered.resolve(); await release.promise; }
      stream.end(message); yield { type: "done", reason: index < 2 ? "toolUse" : "stop", message };
    };
    return stream;
  });
  f.tools.find(tool => tool.name === "help")!.execute = async () => ({
    content: [], details: { mechanics: "Compatible read-only game mechanics" },
  });
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => {
    const permit = f.planner.speculativeToolAuthority();
    const candidate = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Settled-root SDK candidate"));
    permit(); writes++;
    return { content: [], details: { name: candidate.name, version: candidate.version } };
  };
  await f.planner.start(1); f.planner.wake("planning_continuation"); await entered.promise;
  finishHistoryExecution(f.store, f.root); f.state.pending = false;
  const finished = new Promise<void>(resolve => {
    let turns = 0;
    const off = f.store.subscribe(event => {
      if (event.type === "scheduler.turn_finished" && event.run_id === f.run.run_id && ++turns === 2) { off(); resolve(); }
    });
  });
  f.planner.wake("skill_outcome");
  expect(requests).toBe(2); expect(writes).toBe(0);
  release.resolve(); await finished;
  expect(requests).toBe(4); expect(writes).toBe(1);
  const candidate = f.store.namedSkill(f.run.run_id, "Settled-root SDK candidate")!;
  expect(candidate.state).toBe("validated");
  expect(f.store.skillExecutions(f.run.run_id).filter(execution => execution.skill_id === candidate.skill_id)).toEqual([]);
  expect(f.state.pauses).toEqual([]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "model.request_settled")
    .every(event => !object(event.details)?.host_cancellation)).toBe(true);
});

function budgetMessage(model: Parameters<StreamFn>[0], content: ToolCall[] = []): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: content.length ? "toolUse" : "stop", content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

for (const terminal of ["held_until_abort", "queued_done"] as const)
test(`real SDK rejects an oversized attention prefix and its completed sibling before ${terminal}, then corrects in the original turn`, async () => {
  let requests = 0, writes = 0, attentions = 0, closed = false;
  const correctionContexts: unknown[] = [], admitted: string[] = [];
  const f = await setup(async () => { throw new Error("Installed SDK owns budget response"); }, async (model, context, options) => {
    const index = requests++;
    if (index > 0) {
      expect(closed).toBe(true);
      const first = context.messages[0];
      const text = first?.role === "user" && Array.isArray(first.content)
        ? first.content.find(part => part.type === "text")?.text : "";
      correctionContexts.push(JSON.parse(text ?? ""));
      expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_ARGUMENT");
      const message = budgetMessage(model, index === 1
        ? [{ type: "toolCall", id: "fresh-attention", name: "program_run",
          arguments: { operation: "attention", after_ms: 1000, reason: "Fresh bounded correction" } }] : []);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "toolUse", message }); stream.end();
      return stream;
    }
    const message = budgetMessage(model);
    const sibling: ToolCall = { type: "toolCall", id: "completed-but-rejected-write", name: "program_write",
      arguments: { name: "Rejected sibling", source: "return null;" } };
    const poison: ToolCall = { type: "toolCall", id: "oversized-attention", name: "program_run",
      arguments: { operation: "attention", after_ms: 1000, reason: "" } };
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      try {
        yield { type: "start", partial: message };
        message.content.push(sibling);
        yield { type: "toolcall_start", contentIndex: 0, partial: message };
        yield { type: "toolcall_end", contentIndex: 0, toolCall: sibling, partial: message };
        message.content.push(poison);
        yield { type: "toolcall_start", contentIndex: 1, partial: message };
        poison.arguments = { operation: "attention", after_ms: 1000, reason: "PRIVATE_ARGUMENT".padEnd(301, "x") };
        yield { type: "toolcall_delta", contentIndex: 1, delta: "not host diagnostic content", partial: message };
        if (terminal === "held_until_abort" && !options?.signal?.aborted)
          await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        message.stopReason = "toolUse";
        stream.end(message);
        yield { type: "done", reason: "toolUse", message };
      } finally { closed = true; }
    };
    return stream;
  }, { reserve: id => { admitted.push(id); }, transportEnded: () => {}, drained: () => {} });
  f.tools.find(tool => tool.name === "program_run")!.parameters = z.toJSONSchema(programRunSchema, { unrepresentable: "any", io: "input" });
  f.tools.find(tool => tool.name === "program_write")!.parameters = z.toJSONSchema(programWriteSchema, { unrepresentable: "any", io: "input" });
  f.tools.find(tool => tool.name === "program_run")!.execute = async () => { attentions++; return { content: [], details: null }; };
  f.tools.find(tool => tool.name === "program_write")!.execute = async () => { writes++; return { content: [], details: null }; };
  const schedule = globalThis.setTimeout;
  let turnTimers = 0;
  const captureDeadline = (...[callback, delay, ...args]: Parameters<typeof setTimeout>) => {
    if (delay !== undefined && delay > 119_000 && delay <= 120_000) turnTimers++;
    return schedule(callback, delay, ...args);
  };
  vi.spyOn(globalThis, "setTimeout").mockImplementation(Object.assign(captureDeadline, schedule));
  await f.planner.start(1);
  const finished = f.event("scheduler.turn_finished");
  f.planner.wake("selected_attention"); await finished;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(requests).toBe(3); expect(admitted).toHaveLength(3); expect(turnTimers).toBe(1);
  expect(writes).toBe(0); expect(attentions).toBe(1);
  expect(f.run.usage.calls).toBe(3); expect(f.state.pauses).toEqual([]);
  expect(f.root.status).toBe("running");
  expect(events.filter(event => event.type === "scheduler.turn_started")).toHaveLength(1);
  expect(events.find(event => event.type === "scheduler.turn_finished")?.details).toMatchObject({ calls: 3, tools: 1 });
  const rejection = events.find(event => event.type === "model.response_budget_exceeded");
  expect(rejection?.details).toMatchObject({ kind: "tool_argument_budget", request_id: admitted[0],
    tool: "program_run", path: ["reason"], limit: 300, observed: 301 });
  expect(JSON.stringify(rejection)).not.toContain("PRIVATE_ARGUMENT");
  expect(correctionContexts[0]).toMatchObject({ response_budget_feedback: {
    request_id: admitted[0], tool: "program_run", path: ["reason"], limit: 300, observed: 301,
  } });
  expect(events.find(event => event.type === "model.request_settled")?.details).toMatchObject({
    request_id: admitted[0], stop_reason: "aborted", provider_failure: false,
    host_cancellation: { kind: "strategic_host", request_id: admitted[0], reason: "tool_argument_budget" },
    resource_rejection: { kind: "tool_argument_budget", request_id: admitted[0] },
  });
}, 5000);

test("real SDK budget correction cannot reset the original twelve-call allowance or revive a stopped owner", async () => {
  for (const stop of [false, true]) {
    let requests = 0;
    const f = await setup(async () => { throw new Error("Installed SDK owns repeated resource rejection"); }, async model => {
      requests++;
      const message = budgetMessage(model, [{ type: "toolCall", id: `overrun-${requests}`, name: "program_run",
        arguments: { operation: "attention", after_ms: 1000, reason: "x".repeat(301) } }]);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial: message });
      stream.push({ type: "done", reason: "toolUse", message }); stream.end();
      return stream;
    });
    f.tools.find(tool => tool.name === "program_run")!.parameters = z.toJSONSchema(programRunSchema, { unrepresentable: "any", io: "input" });
    await f.planner.start(1);
    const off = f.store.subscribe(event => {
      if (stop && event.run_id === f.run.run_id && event.type === "model.response_budget_exceeded") f.planner.fence();
    });
    const settled = f.event(stop ? "model.request_settled" : "scheduler.turn_finished");
    f.planner.wake("selected_attention"); await settled;
    await f.planner.close(); off();
    const events = f.store.eventsAfter(f.run.run_id, 0, 500);
    expect(requests).toBe(stop ? 1 : 12);
    expect(f.run.usage.calls).toBe(stop ? 1 : 12);
    expect(f.state.pauses).toEqual([]);
    expect(events.some(event => event.type === "model.tool_started" || event.type === "scheduler.planning_stalled" ||
      event.type === "scheduler.backoff")).toBe(false);
    expect(f.root.status).toBe("running");
    if (!stop) expect(events.find(event => event.type === "scheduler.turn_finished")?.details)
      .toMatchObject({ calls: 12, tools: 0, resource_rejection: { kind: "tool_argument_budget" } });
  }
}, 5000);

test("real SDK argument budget admits a 16KiB source, free JSON execution arguments and a bounded intentional wait", async () => {
  let requests = 0, executed = 0;
  const calls: ToolCall[] = [
    { type: "toolCall", id: "legal-source", name: "program_write", arguments: { name: "Legal source", source: `/*${"x".repeat(16380)}*/` } },
    { type: "toolCall", id: "free-json", name: "program_run", arguments: { operation: "start", entry: "run",
      name: "Legal", version: 1, args: { ["nested free key ".repeat(100)]: "j".repeat(40000) } } },
    { type: "toolCall", id: "intentional-wait", name: "program_run",
      arguments: { operation: "attention", after_ms: 600000, reason: "w".repeat(300) } },
  ];
  const f = await setup(async () => { throw new Error("Installed SDK owns legal arguments"); }, async model => {
    const message = budgetMessage(model, requests++ === 0 ? calls : []);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const call = message.content[contentIndex];
      if (call?.type === "toolCall")
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: message });
    }
    stream.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "toolUse", message }); stream.end();
    return stream;
  });
  for (const [name, schema] of [["program_run", programRunSchema], ["program_write", programWriteSchema]] as const) {
    const tool = f.tools.find(tool => tool.name === name)!;
    tool.parameters = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
    tool.execute = async () => { executed++; return { content: [], details: null }; };
  }
  await f.planner.start(1);
  const finished = f.event("scheduler.turn_finished");
  f.planner.wake("selected_attention"); await finished;
  expect(executed).toBe(3); expect(requests).toBe(2); expect(f.state.pauses).toEqual([]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event => event.type === "model.response_budget_exceeded")).toBe(false);
}, 5000);

test("real SDK resource corrections retain the three-call inactive authoring window and never retire its live root", async () => {
  let requests = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns inactive resource corrections"); }, async (model, context) => {
    requests++;
    expect(context.tools?.map(tool => tool.name).sort()).toEqual(["help", "observe", "program_inspect", "program_write"]);
    const message = budgetMessage(model, [{ type: "toolCall", id: `oversized-source-${requests}`, name: "program_write",
      arguments: { name: "Overlong inactive source", source: "x".repeat(16385) } }]);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial: message });
    stream.push({ type: "done", reason: "toolUse", message }); stream.end();
    return stream;
  });
  f.tools.find(tool => tool.name === "program_write")!.parameters = z.toJSONSchema(programWriteSchema, { unrepresentable: "any", io: "input" });
  await f.planner.start(1);
  const finished = f.event("scheduler.turn_finished");
  f.planner.wake("planning_continuation"); await finished;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(requests).toBe(3); expect(f.run.usage.calls).toBe(3);
  expect(f.root.status).toBe("running"); expect(f.state.pauses).toEqual([]);
  expect(events.find(event => event.type === "scheduler.authoring_exited")?.details).toMatchObject({ reason: "calls", calls: 3, tools: 0 });
  expect(events.filter(event => event.type === "model.request_settled")).toHaveLength(3);
  expect(events.filter(event => event.type === "model.request_settled").every(event =>
    object(object(event.details)?.host_cancellation ?? null)?.kind === "strategic_host")).toBe(true);
}, 5000);

test("real SDK actual provider failure on a fresh budget correction still pauses instead of receiving another correction", async () => {
  let requests = 0;
  const f = await setup(async () => { throw new Error("Installed SDK owns correction failure"); }, async model => {
    const first = requests++ === 0;
    const message = budgetMessage(model, first ? [{ type: "toolCall", id: "resource-rejected", name: "program_run",
      arguments: { operation: "attention", after_ms: 1000, reason: "x".repeat(301) } }] : []);
    const stream = new AssistantMessageEventStream();
    if (first) {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
    } else {
      message.stopReason = "error"; message.errorMessage = "Actual fixture provider failure";
      stream.push({ type: "error", reason: "error", error: message });
    }
    stream.end();
    return stream;
  });
  f.tools.find(tool => tool.name === "program_run")!.parameters = z.toJSONSchema(programRunSchema, { unrepresentable: "any", io: "input" });
  await f.planner.start(1);
  const failed = f.event("scheduler.turn_failed");
  f.planner.wake("selected_attention"); await failed;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(requests).toBe(2); expect(f.state.pauses).toHaveLength(1);
  expect(events.find(event => event.type === "scheduler.turn_failed")?.details)
    .toMatchObject({ provider_failed: true, provider_aborted: false, pause_cause: "provider_failure" });
  expect(events.filter(event => event.type === "model.request_settled").at(-1)?.details)
    .toMatchObject({ stop_reason: "error", provider_failure: true });
  expect(events.some(event => event.type === "model.tool_started")).toBe(false);
}, 5000);

test("real SDK rejects a growing unterminated root key that the parsed attention arguments omit", async () => {
  let requests = 0, effects = 0, keyChunks = 0, closed = false;
  let correction: Record<string, unknown> | undefined;
  const partialArguments = { operation: "attention", after_ms: 30000, reason: "r".repeat(127) };
  const rawPrefix = `${JSON.stringify(partialArguments).slice(0, -1)},"`;
  // Match the observed failed shape: the unclosed extra key begins at
  // offset 181 while the decoded reason remains only 127 characters.
  expect(rawPrefix.lastIndexOf('"')).toBe(181);
  const f = await setup(async () => { throw new Error("Installed SDK owns unfinished-key response"); }, async (model, context) => {
    if (requests++ > 0) {
      expect(closed).toBe(true);
      const first = context.messages[0];
      const text = first?.role === "user" && Array.isArray(first.content)
        ? first.content.find(part => part.type === "text")?.text : "";
      correction = JSON.parse(text ?? "");
      expect(JSON.stringify(context.messages)).not.toContain("PRIVATE_UNFINISHED_KEY");
      const message = budgetMessage(model);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message }); stream.end();
      return stream;
    }
    const sibling: ToolCall = { type: "toolCall", id: "unfinished-key-sibling", name: "program_write",
      arguments: { name: "No sibling publication", source: "return null;" } };
    const call: ToolCall = { type: "toolCall", id: "unfinished-key-attention", name: "program_run", arguments: partialArguments };
    const message = budgetMessage(model, [sibling, call]);
    const stream = new AssistantMessageEventStream();
    stream[Symbol.asyncIterator] = async function* () {
      try {
        yield { type: "start", partial: message };
        yield { type: "toolcall_start", contentIndex: 0, partial: message };
        yield { type: "toolcall_end", contentIndex: 0, toolCall: sibling, partial: message };
        yield { type: "toolcall_start", contentIndex: 1, partial: message };
        yield { type: "toolcall_delta", contentIndex: 1, delta: rawPrefix, partial: message };
        const unfinishedKey = "PRIVATE_UNFINISHED_KEY".padEnd(32509 - rawPrefix.length, "k");
        for (let offset = 0; offset < unfinishedKey.length; offset += 8) {
          keyChunks++;
          // The SDK's incremental JSON projection keeps this same valid
          // dictionary while the unterminated raw property name grows.
          yield { type: "toolcall_delta", contentIndex: 1, delta: unfinishedKey.slice(offset, offset + 8), partial: message };
        }
        yield { type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message };
        stream.end(message);
        yield { type: "done", reason: "toolUse", message };
      } finally { closed = true; }
    };
    return stream;
  });
  f.tools.find(tool => tool.name === "program_run")!.parameters = z.toJSONSchema(programRunSchema, { unrepresentable: "any", io: "input" });
  for (const name of ["program_run", "program_write"])
    f.tools.find(tool => tool.name === name)!.execute = async () => { effects++; return { content: [], details: null }; };
  await f.planner.start(1);
  const finished = f.event("scheduler.turn_finished");
  f.planner.wake("selected_attention"); await finished;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(requests).toBe(2); expect(effects).toBe(0); expect(keyChunks).toBeGreaterThan(0); expect(keyChunks).toBeLessThan(30);
  expect(partialArguments).toEqual({ operation: "attention", after_ms: 30000, reason: "r".repeat(127) });
  const rejection = events.find(event => event.type === "model.response_budget_exceeded");
  expect(rejection?.details).toMatchObject({ kind: "tool_argument_budget", tool: "program_run", path: ["<argument_key>"] });
  const details = object(rejection?.details ?? null)!;
  expect(Number(details.observed)).toBeGreaterThan(Number(details.limit));
  expect(Number(details.observed)).toBeLessThanOrEqual(Number(details.limit) + 8);
  expect(JSON.stringify(rejection)).not.toContain("PRIVATE_UNFINISHED_KEY");
  expect(correction).toMatchObject({ response_budget_feedback: { tool: "program_run", path: ["<argument_key>"] } });
  expect(f.run.usage.calls).toBe(2); expect(f.state.pauses).toEqual([]); expect(f.root.status).toBe("running");
  expect(events.filter(event => event.type === "scheduler.turn_started")).toHaveLength(1);
}, 5000);
