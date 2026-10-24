import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Json, ObservationV3 } from "../src/shared/contracts.ts";
import type { PlanningContext } from "../src/shared/planning.ts";
import { TOOL_POLICY } from "../src/shared/tool-policy.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { SkillManager } from "../src/server/skills.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { StrategicPlanner } from "../src/server/strategic.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

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
function setup(onPrompt: (context: Record<string, unknown>, agent: HarnessAgent) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-overlap-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const goal = adapter.goals.find(goal => goal.goal_id === "custom")!;
  const run = minecraftRunFixture(adapter, { session_id: "session", life_id: 1,
    task: "Observe", model_id: "fixture-model", world_id: "world", epoch: 1,
    status: "running", started_at: null, ended_at: null, turns: 0, model_status: "idle", error: null,
  });
  store.saveRun(run);
  const observation = minecraftObservationFixture(adapter);
  const basis: PlanningContext = { run_id: run.run_id, generation: 1, session_id: "session", world_id: "world", epoch: 1,
    life_id: 1, life_status: "alive", task: run.task, goal,
    native_boot_id: run.native_boot_id!, space_epoch: run.space_epoch!, compatibility_hash: run.compatibility_hash!, screen: null,
    root: { execution_id: "root", skill_id: "skill", version: 1, hash: "exact", status: "running" } };
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
      let activeTools = configuration.tools, gate: Gate | undefined, listener: ((event: AgentEvent) => void) | undefined;
      let controller: AbortController | null = null, pending: Promise<void> | null = null;
      const agent = {
        beforeToolCall: undefined as Agent["beforeToolCall"],
        setBeforeModelCall: (value: Gate) => { gate = value; },
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
    run: () => run, generation: () => 1,
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
    reviewContext: () => ({ opportunities: [], uncertainty: "unmeasured" }),
    reviewComplete: () => { state.reviews++; run.status = "completed"; planner.fence(); },
  });
  resources.push({ planner, store, directory });
  const event = (type: string) => {
    const done = Promise.withResolvers<void>();
    const off = store.subscribe((entry) => { if (entry.type === type && entry.run_id === run.run_id) { off(); done.resolve(); } });
    return done.promise;
  };
  const optIn = () => speculation.optIn({ root_execution_id: basis.root.execution_id, after_ms: 0, reason: "Independent follow-up", budget: { calls: 3, tools: 6, duration_ms: 5000 } });
  return { planner, speculation, run, state, event, optIn, store, basis, adapter };
}

for (const selectedKind of ["lookahead", "attention"] as const) {
  test(`${selectedKind} survives the current root's next real capability admission`, async () => {
    const f = setup(async (context, agent) => {
      expect(await agent.call()).toBe(true);
      if (selectedKind === "lookahead") expect(context.speculative_plan).not.toBeNull();
      else { expect(context.speculative_plan).toBeNull(); expect(await agent.call()).toBe(false); }
    });
    await f.planner.start(1);
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
    const program = await manager.register(f.run.run_id, { name: "Neutral continued program", source: 'await game.action({kind:"look",yaw:0,pitch:0}); await game.action({kind:"look",yaw:1,pitch:0}); return {status:"completed",summary:"Neutral flow settled",result:null};',
      card: { purpose: "Measure selected attention", applicability: "Neutral fixture", method: "Two authorized capabilities", reason: "Prove root handoff", limitations: "No gameplay claim" }, dependencies: [] });
    const root = manager.start(f.run.run_id, { skill_id: program.skill_id, version: program.version, start_key: "continued", ...executionScopeFixture(f.run), args: null,
      limits: { duration_ms: 10000, max_actions: 2, max_calls: 2, max_depth: 1 },
      ...(selectedKind === "lookahead" ? { lookahead: { after_ms: 0, reason: "Independent selected follow-up", budget: { calls: 1, tools: 2, duration_ms: 5000 } } } : {}) });
    rootId = root.execution_id; f.planner.admitted(); await first.promise;
    if (selectedKind === "attention") f.planner.attentionAfter(1000, "Independent selected attention");
    await selected.promise; proceed.resolve(); await second.promise;
    expect(leaves).toBe(2); expect(manager.get(f.run.run_id, { execution_id: rootId })?.status).toBe("running");
    await finished; expect(f.state.contexts).toHaveLength(1); expect(f.run.usage.calls).toBe(1); expect(manager.pending).toBe(true);
    finish.resolve(); await closed.promise;
    expect(manager.get(f.run.run_id, { execution_id: rootId })).toMatchObject({ status: "succeeded", actions: 2 });
    expect(f.state.pauses).toEqual([]);
  });
}

test("restricted planning has a finite request budget and cannot dispatch ordinary execution controls", async () => {
  const f = setup(async (_context, agent) => {
    expect(agent.catalog()).toContain("prepare_next"); expect(agent.catalog()).not.toContain("program_run");
    expect(agent.catalog()).not.toContain("program_write");
    expect(await agent.call([{ name: "prepare_next" }])).toBe(true);
    expect(await agent.tool("program_run")).toBe(false); expect(await agent.tool("program_write")).toBe(false);
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
    const f = setup(async (_context, agent) => { expect(await agent.call([...sample.calls])).toBe(true); });
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

test("uncertainty recovery admits one fresh request while private raw context stays out of compact feedback", async () => {
  const f = setup(async (context, agent) => {
    expect(context.reason).toEqual(["uncertainty"]);
    expect(context.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ type: "runtime.uncertainty_reconciled", details: expect.objectContaining({ neutralized: true, workers_closed: true, no_replay: true }) })]));
    expect(JSON.stringify(context.feedback)).not.toContain("private-context-marker");
    expect(await agent.call()).toBe(true); expect(await agent.call()).toBe(false);
  });
  f.store.event(f.run.run_id, "runtime.uncertainty", "Unconfirmed effect fenced", { action_id: "unknown", execution_id: "root", session_id: "session", life_id: 1, status: "unknown", no_replay: true, raw_context: { observation: "private-context-marker" } });
  f.store.event(f.run.run_id, "runtime.uncertainty_reconciled", "Fresh same-life authority", { action_id: "unknown", session_id: "session", life_id: 1, observation_seq: 1, neutralized: true, workers_closed: true, no_replay: true });
  await f.planner.start(1); const done = f.event("scheduler.turn_finished"); f.planner.wake("uncertainty"); await done;
  expect(f.run.usage.calls).toBe(1); expect(f.state.pending).toBe(true); expect(f.state.pauses).toEqual([]);
});

test("an ordinary replan cancels optional overlap without consuming the new wake", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = setup(async (context, agent) => {
    expect(await agent.call()).toBe(true);
    if (context.speculative_plan) { entered.resolve(); await agent.wait(release.promise); }
    else expect(await agent.call()).toBe(false);
  });
  await f.planner.start(1); const done = f.event("scheduler.turn_finished"); f.optIn(); await entered.promise;
  const receipt = f.store.event(f.run.run_id, "action.failed", "Measured failed action", { action_id: "failure" });
  f.planner.wake("policy_replan"); expect(f.state.aborts).toBe(1); expect(f.speculation.projection()?.state).toBe("invalidated");
  release.resolve(); await done;
  expect(f.state.contexts).toHaveLength(2); expect(f.state.contexts[1]?.speculative_plan).toBeNull();
  expect(f.state.contexts[1]?.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ event_seq: receipt.event_seq })]));
  expect(f.run.usage.calls).toBe(2); expect(f.state.pauses).toEqual([]);
});

test("post-goal review remains finite and effect-free while permitting source and assessment artifacts", async () => {
  const f = setup(async (context, agent) => {
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
