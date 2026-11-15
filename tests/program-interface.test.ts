import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { adaptSchemaForStrict, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type { ObservationV3 } from "../src/shared/contracts.ts";
import type { ImprovementOpportunity } from "../src/shared/execution-evidence.ts";
import type { MinecraftGameAPI, MinecraftObservation } from "../src/shared/minecraft.ts";
import { minecraftControllerFrameSchema } from "../src/shared/minecraft.ts";
import { visibleScreenSnapshotSchema } from "../src/shared/control.ts";
import { observationSchema, skillResultSchema } from "../src/shared/validation.ts";
import { gameActionResultSchema } from "../src/shared/primitives.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { SkillManager, type SkillHost } from "../src/server/skills.ts";
import { SourcePrograms } from "../src/server/source-programs.ts";
import { preserveRuntimeToolArguments, RuntimeTools, type RuntimeToolHost } from "../src/server/runtime-tools.ts";
import { SpeculativePlanning } from "../src/server/speculative-planning.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { HistoryReader, HistoryReaderError } from "../src/server/history-reader.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { ProgramValidationError, validateProgramSource } from "../src/server/program-validation.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { DiagnosticAgent, DIAGNOSTIC_PROGRAMS } from "../src/evaluation/diagnostic-agent.ts";
import type { ReactiveRuntime } from "../src/server/reactive.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
import { historySpec } from "./helpers/history-fixture.ts";

const card = { purpose: "Exercise named program lifecycle", applicability: "Authorized neutral fixture", method: "Read and compose bounded results", reason: "Verify the consumer contract", limitations: "No gameplay efficacy claim" };
const source = 'return {status:"completed",summary:"Neutral result",result:args};';
const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });

function aborted(signal: AbortSignal) {
  const ready = Promise.withResolvers<void>();
  if (signal.aborted) ready.resolve();
  else signal.addEventListener("abort", () => ready.resolve(), { once: true });
  return ready.promise;
}

function fixture(runner?: SandboxService["runSkill"], hooks: { action?: SkillHost["action"]; cancelActions?: SkillHost["cancelActions"] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-interface-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const run = minecraftRunFixture(adapter, { world_id: crypto.randomUUID(), session_id: "fixture-session", task: "Inspect neutral authorized state" });
  const goal = adapter.goals.find(goal => goal.goal_id === "custom")!;
  store.saveRun(run);
  let generation = 1, actions = 0, dispatches = 0;
  let life: ObservationV3["life"] = { life_id: 1, status: "alive", can_respawn: false, death: null };
  const observation = (): MinecraftObservation => minecraftObservationFixture(adapter, { session_id: run.session_id!, world_id: run.world_id, epoch: run.epoch,
    life: { ...life, life_id: run.life_id! }, observation_seq: 1,
    captured_at: new Date().toISOString(),
    data: { player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false,
      inventory: [{ name: "stone", display_name: "Stone", count: 2, slot: 0 }] },
    blocks: [{ target: { target_id: "authorized-block", incarnation: 1, life_id: run.life_id!, space: { dimension_id: "minecraft:overworld", space_epoch: 1 } },
      name: "stone", position: { x: .5, y: 63.5, z: .5 }, observed_at: "2026-10-22T00:00:00Z", current: true }],
    entities: [{ target: { target_id: "authorized-item", incarnation: 1, life_id: run.life_id!, space: { dimension_id: "minecraft:overworld", space_epoch: 1 } },
      name: "item", item_name: "stone", position: { x: 1, y: 64, z: 0 }, observed_at: "2026-10-22T00:00:00Z", current: true }],
    sounds: [{ category: "movement", cue: null, direction: "here", distance: "near", observed_at: "2026-10-22T00:00:00Z" }],
    } });
  const history = new HistoryReader(store.readLocation());
  const learning = new ImprovementLearning(store, history);
  const prepareFeedback = () => learning.prepareFeedback(run.run_id, { deadlineHostMs: performance.now() + 10_000 });
  let planning: SpeculativePlanning;
  const manager = new SkillManager(store, { runSkill: async (...args) => {
    dispatches++;
    if (runner) return await runner(...args);
    const [body, input, handle] = args;
    const game: MinecraftGameAPI = { observe: async () => observationSchema.parse(await handle({ kind: "observe" })),
      action: async (action) => gameActionResultSchema.parse(await handle({ kind: "action", action })),
      actionAndObserve: async action => {
        const result = await game.action(action);
        const evidence = result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence)
          ? result.evidence : null;
        const safe = !result.requires_reconnect && (result.status === "succeeded" ||
          result.status === "failed" && evidence?.neutralized === true &&
            (evidence.world_effect_emitted === false || evidence.failure_outcome_confirmed === true));
        return { action: result, observation: safe ? await game.observe() : null };
      },
      respawn: async () => gameActionResultSchema.parse(await handle({ kind: "respawn" })),
      recipes: async (item) => await handle({ kind: "adapter", capability_id: "minecraft.recipes", version: 1, args: { item } }),
      screen: async () => visibleScreenSnapshotSchema.nullable().parse(await handle({ kind: "adapter", capability_id: "minecraft.visible_screen", version: 1, args: {} })),
      frame: async audio_cursor => minecraftControllerFrameSchema.parse(await handle({
        kind: "adapter", capability_id: "minecraft.controller_frame", version: 2, args: { audio_cursor } })),
      call: async (skill, args) => skillResultSchema.parse(await handle({ kind: "call", skill, args })),
      attention: async attention => { await handle({ kind: "attention", attention }); },
      progress: async (summary, details) => await handle({ kind: "progress", summary, details }) as null };
    const execute = new Function("game", "args", `return (async () => {${body}\n})();`);
    return skillResultSchema.parse(await execute(game, input));
  } }, {
    authorize: scope => { if (scope.run_id !== run.run_id || run.status !== "running" || scope.epoch !== run.epoch || scope.session_id !== run.session_id ||
      scope.life_id !== run.life_id || scope.native_boot_id !== run.native_boot_id || scope.space_epoch !== run.space_epoch || scope.run_generation !== generation)
      throw new RuntimeFault("stale_context", "Fixture authority revoked"); },
    adapter: () => adapter, binding: () => minecraftTestBinding(adapter),
    observe: async () => observation(), action: async (...args) => {
      actions++;
      return hooks.action ? await hooks.action(...args)
        : { status: "succeeded", summary: "Neutral receipt", evidence: { effect_confirmed: true } };
    },
    queryCapability: async id => id === "minecraft.visible_screen" ? null : [], cancelActions: hooks.cancelActions ?? (async () => {}), recover: async () => { throw new Error("Fixture has no respawn"); },
    changed: (outcome, execution) => { if (outcome && execution) planning.predecessorSettled(execution.execution_id); },
    unsafe: () => {}, prepareLookahead: (config) => planning.prepareOptIn(config),
  });
  const scope = () => ({ run_id: run.run_id, world_id: run.world_id, generation, session_id: run.session_id!, epoch: run.epoch,
    life_id: run.life_id!, life_status: life.status, task: run.task, goal,
    native_boot_id: run.native_boot_id!, space_epoch: run.space_epoch!, compatibility_hash: run.compatibility_hash!, screen: null });
  planning = new SpeculativePlanning({ contract: () => adapter, admissionContext: () => run.status === "running" ? scope() : null,
    context: () => { const root = store.latestRootExecution(run.run_id); if (!root || run.status !== "running") return null;
      return { ...scope(), root: { ...root, hash: store.skill(run.run_id, root).hash } }; },
    skill: (ref) => store.skill(run.run_id, ref), observe: async () => observation(),
    evaluateGuard: async (body, observation, args) => await new Function("observation", "args", `return (async () => {${body}\n})();`)(observation, args),
    admit: async (request, permit) => { permit.assertCurrent(); return manager.start(run.run_id, request); },
    evidence: (type, details) => { store.event(run.run_id, type, "Planning evidence", details); }, wake: () => {},
  });
  const toolHost: RuntimeToolHost = {
    run: () => run, assertCurrent: (expected) => { if (expected !== generation || !["running", "reviewing"].includes(run.status)) throw new RuntimeFault("stale_context", "Fixture tool authority revoked"); return run; },
    observe: async () => observation(), adapter: () => adapter, generation: () => generation, attentionAfter: () => {}, admitted: () => {},
    history: () => history, planning: () => planning, learning: () => learning,
    toolAuthority: () => { const revision = generation; const permit = planning.projection()?.planning_active ? planning.authority() : null;
      return () => { if (generation !== revision || !["running", "reviewing"].includes(run.status)) throw new RuntimeFault("stale_context", "Fixture turn fenced"); permit?.(); }; },
    finishTask: () => { run.status = "stopping"; generation++; planning.invalidate("cancelled"); manager.fence("Custom completion fenced"); store.saveRun(run); },
  };
  const sources = new SourcePrograms(store, { adapter: () => adapter, binding: () => minecraftTestBinding(adapter) });
  const catalog = new RuntimeTools(store, manager, sources, {} as ReactiveRuntime, null, toolHost);
  const tools = () => catalog.build(generation);
  const call = async (name: string, input: unknown, callId: string = crypto.randomUUID(), selected = tools()) => {
    const tool = selected.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Tool not in actual catalog: ${name}`);
    return await tool.execute(callId, input);
  };
  const close = async () => { planning.invalidate("cancelled"); await manager.closeAll("Fixture complete"); await history.close(); store.close(); rmSync(directory, { recursive: true, force: true }); };
  resources.push(close);
  return { directory, store, run, manager, sources, planning, learning, history, prepareFeedback, catalog, tools, call, toolHost, actions: () => actions, dispatches: () => dispatches,
    observation, setLife: (value: ObservationV3["life"]) => { life = value; },
    fence: () => { generation++; manager.fence("Fixture fenced"); planning.invalidate("cancelled"); },
    write: (name: string, body = source, options: Record<string, unknown> = {}, id?: string) => call("program_write", { entry: "run", name, source: body, card, dependencies: [], ...options }, id),
  };
}

async function waitClosed(store: Store, runId: string, executionId: string) {
  const terminal = () => !["accepted", "running", "cancel_requested"].includes(store.skillExecution(runId, { execution_id: executionId })!.status);
  if (terminal()) return;
  const ready = Promise.withResolvers<void>();
  const unsubscribe = store.subscribe((event) => {
    if (event.run_id === runId && event.type === "skill.closed" && terminal()) { unsubscribe(); ready.resolve(); }
  });
  await ready.promise;
}

function data(reply: AgentToolResult) {
  return JSON.parse(reply.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join(""));
}

async function agentCalls(tools: AgentTool[], calls: ToolCall[], beforeToolCall?: Agent["beforeToolCall"], started?: (agent: Agent) => void) {
  const descriptor = getBundledModels("openai-codex").find((model) => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed catalog lacks an offline Codex descriptor");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  let replied = false;
  const streamFn: StreamFn = () => {
    const content: AssistantMessage["content"] = replied ? [{ type: "text", text: "Offline invocation complete." }] : calls;
    replied = true;
    const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      stopReason: content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const events = new AssistantMessageEventStream();
    events.push({ type: "start", partial: message });
    content.forEach((entry, contentIndex) => {
      if (entry.type !== "toolCall") return;
      events.push({ type: "toolcall_start", contentIndex, partial: message });
      events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(entry.arguments), partial: message });
      events.push({ type: "toolcall_end", contentIndex, toolCall: entry, partial: message });
    });
    events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    events.end();
    return events;
  };
  const agent = new Agent({ initialState: { model, tools }, streamFn,
    beforeToolCall: (context, signal) => { preserveRuntimeToolArguments(context); return beforeToolCall?.(context, signal); },
    getApiKey: () => "OFFLINE_SYNTHETIC_STREAM_ONLY" });
  started?.(agent);
  try {
    await agent.prompt("Exercise the supplied local tool invocations without a provider.");
    return agent.state.messages.filter((message) => message.role === "toolResult");
  } finally {
    agent.abort();
    await agent.waitForIdle();
  }
}

test("native diagnostic starts a real named program through the guarded SDK argument boundary", async () => {
  const f = fixture();
  const diagnostic = new DiagnosticAgent(f.store, { choiceTimeoutMs: 1000 });
  diagnostic.preparePlanning(f.run.run_id, undefined, true);
  const auth = diagnostic.auth();
  const agent = await auth.createAgent({
    modelId: diagnostic.model_id,
    systemPrompt: [],
    tools: f.tools(),
  });
  agent.beforeToolCall = context => { preserveRuntimeToolArguments(context); };
  try {
    const admitted = diagnostic.choose(f.run.run_id, "planning_root");
    await Promise.all([
      agent.prompt(JSON.stringify({ phase: "running", role: "planning" })),
      admitted,
    ]);
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    expect(f.store.skill(f.run.run_id, execution).name).toBe(DIAGNOSTIC_PROGRAMS.predecessor);
    await waitClosed(f.store, f.run.run_id, execution.execution_id);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: execution.execution_id })?.status).toBe("succeeded");
    expect(f.actions()).toBe(2);
    expect(f.store.skills(f.run.run_id).map(skill => skill.name).sort()).toEqual([
      DIAGNOSTIC_PROGRAMS.followup,
      DIAGNOSTIC_PROGRAMS.predecessor,
    ].sort());
  } finally {
    await auth.releaseAgent(agent);
  }
});

test("failed source validation remains timed without fabricating a published revision", async () => {
  const f = fixture();
  const result = await f.write("Invalid candidate", "const broken = ;");
  expect(result.isError).toBe(true);
  expect(f.store.skills(f.run.run_id)).toEqual([]);
  const event = f.store.eventsAfter(f.run.run_id, 0, 500)
    .find(event => event.type === "program.source_timing");
  expect(event?.details).toMatchObject({
    validation_succeeded: false, source_published: false, source_hash: null,
    skill_id: null, version: null, clock: "same_process_monotonic",
  });
  const details = event!.details as Record<string, number>;
  expect(details.ended_monotonic_ms).toBeGreaterThanOrEqual(details.started_monotonic_ms!);
});

for (const outcome of ["imported", "invalid_source", "revoked_before_commit"] as const) {
  test(`snapshot source readiness remains timed when ${outcome}`, async () => {
    const origin = fixture(), recipient = fixture();
    const snapshot = await origin.sources.register(origin.run.run_id, { entry: "run",
      name: "Portable neutral source", source, card, dependencies: [],
    });
    const input = outcome === "invalid_source" ? { ...snapshot, source: "const broken = ;" } : snapshot;
    const importing = recipient.sources.importSnapshot(recipient.run.run_id, input, () => {
      if (outcome === "revoked_before_commit") throw new Error("Import authority revoked");
    });
    if (outcome === "imported") {
      const imported = await importing;
      expect(imported.hash).toBe(snapshot.hash);
      expect(imported.source).toBe(snapshot.source);
    } else {
      await expect(importing).rejects.toThrow();
      expect(recipient.store.skills(recipient.run.run_id)).toEqual([]);
    }
    const timings = recipient.store.eventsAfter(recipient.run.run_id, 0, 500)
      .filter(event => event.type === "program.source_timing");
    expect(timings).toHaveLength(1);
    expect(timings[0]!.details).toMatchObject({
      source_published: outcome === "imported",
      source_hash: outcome === "imported" ? snapshot.hash : null,
      skill_id: outcome === "imported" ? snapshot.skill_id : null,
      version: outcome === "imported" ? snapshot.version : null,
      clock: "same_process_monotonic",
    });
    if (outcome !== "revoked_before_commit")
      expect(timings[0]!.details).toMatchObject({ validation_succeeded: outcome === "imported" });
    const timing = timings[0]!.details as Record<string, number>;
    expect(timing.ended_monotonic_ms).toBeGreaterThanOrEqual(timing.started_monotonic_ms!);
  });
}

for (const toolName of ["program_submit", "program_run"] as const) {
  for (const [form, limits, expected] of [
    ["omitted", undefined, { duration_ms: 120000, max_actions: 64, max_calls: 256, max_depth: 8 }],
    ["empty", {}, { duration_ms: 120000, max_actions: 64, max_calls: 256, max_depth: 8 }],
    ["partial", { max_actions: 2 }, { duration_ms: 120000, max_actions: 2, max_calls: 256, max_depth: 8 }],
  ] as const) {
    test(`installed Agent ${toolName} ${form} limits normalize before admission and enforce the actual action budget`, async () => {
      const f = fixture();
      const body = 'for(let n=0;n<65;n++) await game.action({kind:"look",yaw:0,pitch:0}); return {status:"completed",summary:"Must exhaust the finite budget",result:null};';
      const name = `${toolName} ${form}`;
      if (toolName === "program_run") await f.write(name, body);
      const input = { name, args: null, ...(limits === undefined ? {} : { limits }),
        ...(toolName === "program_submit" ? { source: body } : { operation: "start" }) };
      const declaration = f.tools().find(tool => tool.name === toolName)!;
      expect(validateJsonSchemaValue(declaration.parameters, input).success).toBe(true);
      const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: `${toolName}-${form}`, name: toolName, arguments: input }]);
      expect(replies[0]!.isError).toBe(false);
      const execution = f.store.latestRootExecution(f.run.run_id)!;
      expect(execution.limits).toEqual(expected);
      expect(Date.parse(execution.deadline_at) - Date.parse(execution.started_at ?? execution.deadline_at)).toBeLessThanOrEqual(expected.duration_ms);
      await waitClosed(f.store, f.run.run_id, execution.execution_id);
      const closed = f.store.skillExecution(f.run.run_id, { execution_id: execution.execution_id })!;
      expect(closed).toMatchObject({ status: "failed", diagnostic: { code: "budget_exceeded" } });
      expect(closed.actions).toBe(expected.max_actions);
      expect(f.actions()).toBe(expected.max_actions);
      expect(f.dispatches()).toBe(1);
      const replay = await f.call(toolName, input, `${toolName}-${form}`);
      expect(replay.isError).not.toBe(true);
      expect(f.dispatches()).toBe(1);
    });
  }
}

for (const [form, limits, expectedActions] of [
  ["omitted", undefined, 64], ["empty", {}, 64], ["partial", { max_actions: 2 }, 2],
] as const) {
  test(`installed Agent prepare_next ${form} limits retain defaults and bound the activated successor`, async () => {
    const release = Promise.withResolvers<void>();
    const f = fixture(async (_body, args, handle, _limits, signal) => {
      if (args === "predecessor") {
        await Promise.race([release.promise, aborted(signal)]);
        return { status: "completed", summary: "Predecessor settled", result: null };
      }
      for (let index = 0; index < 65; index++)
        await handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } });
      return { status: "completed", summary: "Must exhaust successor budget", result: null };
    });
    await f.write("limit predecessor"); await f.write("limit successor");
    await f.call("program_run", { operation: "start", name: "limit predecessor", args: "predecessor",
      next: { after_ms: 0, reason: "Exercise successor limits", budget: { calls: 1, tools: 8, duration_ms: 30000 } } });
    const predecessor = f.store.latestRootExecution(f.run.run_id)!;
    const flight = f.planning.begin()!;
    const input = { name: "limit successor", args: null, ...(limits === undefined ? {} : { limits }) };
    const tool = f.tools().find(tool => tool.name === "prepare_next")!;
    expect(validateJsonSchemaValue(tool.parameters, input).success).toBe(true);
    const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: `prepare-${form}`, name: "prepare_next", arguments: input }]);
    expect(replies[0]!.isError).toBe(false);
    f.planning.finish(flight.plan_id);
    const settled = Promise.withResolvers<void>();
    const unsubscribe = f.store.subscribe(event => {
      if (event.run_id === f.run.run_id && event.type === "planning.predecessor_settled") {
        unsubscribe(); settled.resolve();
      }
    });
    release.resolve();
    await waitClosed(f.store, f.run.run_id, predecessor.execution_id);
    await settled.promise;
    const activated = await f.call("program_run", { operation: "activate_next" });
    expect({ isError: activated.isError ?? false, result: data(activated) }).toMatchObject({ isError: false, result: { state: "activated" } });
    const successor = f.store.latestRootExecution(f.run.run_id)!;
    expect(successor.execution_id).not.toBe(predecessor.execution_id);
    expect(successor.limits).toEqual({ duration_ms: 120000, max_actions: expectedActions, max_calls: 256, max_depth: 8 });
    await waitClosed(f.store, f.run.run_id, successor.execution_id);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: successor.execution_id })).toMatchObject({
      status: "failed", actions: expectedActions, diagnostic: { code: "budget_exceeded" },
    });
    expect(f.actions()).toBe(expectedActions);
  });
}

test("installed Agent rejects explicit invalid actor limits without source persistence or execution", async () => {
  const f = fixture();
  const limitsCases = [null, [], 2, { duration_ms: 99 }, { max_actions: 0 }, { max_calls: 2049 },
    { max_depth: 9 }, { duration_ms: 600001 }, { max_actions: "2" }, { max_actions: 1.5 }, { unknown: 1 }];
  for (const [index, limits] of limitsCases.entries()) {
    const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: `bad-limits-${index}`, name: "program_submit",
      arguments: { name: `bad ${index}`, source, args: null, limits } }]);
    expect(replies[0]!.isError).toBe(true);
    expect(data(replies[0]!).error).toMatchObject({ code: "invalid_request", retryable: false });
    expect(JSON.stringify(data(replies[0]!)).length).toBeLessThan(5000);
  }
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("unknown tool fields are named without their values and permit an explicit corrected non-admitted write", async () => {
  const f = fixture(), id = "unknown-field-correction";
  const rejected = await f.call("program_write", {
    entry: "run", name: "field correction", source, budget: { private_value: "NOT_AN_ERROR_DIAGNOSTIC_VALUE" },
  }, id);
  expect(rejected.isError).toBe(true);
  expect(data(rejected).error).toMatchObject({
    code: "invalid_request", issues: [{ code: "unrecognized_keys", path: "", keys: ["budget"] }],
  });
  expect(JSON.stringify(data(rejected))).not.toContain("NOT_AN_ERROR_DIAGNOSTIC_VALUE");
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  const corrected = await f.write("field correction", source, {}, id);
  expect(corrected.isError).not.toBe(true);
  expect(f.store.skills(f.run.run_id)).toHaveLength(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("unknown nested tool fields retain their path and cap names with explicit omissions", async () => {
  const f = fixture();
  const extras = Object.fromEntries(Array.from({ length: 20 }, (_, index) =>
    [`unknown_${index}_${"界".repeat(100)}`, "NOT_AN_ERROR_DIAGNOSTIC_VALUE"]));
  const rejected = await f.call("program_submit", { name: "bounded hints", source, args: null, limits: extras });
  const issue = data(rejected).error.issues.find((value: { code: string }) => value.code === "unrecognized_keys");
  expect(issue.path).toBe("limits");
  expect(issue.keys.length).toBeLessThanOrEqual(8);
  expect(issue.keys.every((name: string) => name.length <= 80)).toBe(true);
  expect(issue.omitted_keys).toBeGreaterThan(0);
  expect(issue.key_names_truncated).toBe(true);
  expect(JSON.stringify(data(rejected))).not.toContain("NOT_AN_ERROR_DIAGNOSTIC_VALUE");
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("installed Agent rejects invalid start and successor limits before durable admission or staging", async () => {
  const f = fixture(async (_body, _args, _handle, _limits, signal) => {
    await aborted(signal); return { status: "completed", summary: "Released", result: null };
  });
  await f.write("invalid limit candidate");
  const limitsCases = [null, { max_actions: "2" }, { max_calls: false }, { max_depth: 9 }, { duration_ms: 0 }, { unknown: 1 }];
  for (const [index, limits] of limitsCases.entries()) {
    const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: `invalid-start-${index}`, name: "program_run",
      arguments: { operation: "start", name: "invalid limit candidate", args: null, limits } }]);
    expect(data(replies[0]!).error.code).toBe("invalid_request");
  }
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  await f.call("program_run", { operation: "start", name: "invalid limit candidate", args: null,
    next: { after_ms: 0, reason: "Invalid successor requests must not stage", budget: { calls: 1, tools: 8, duration_ms: 30000 } } });
  const flight = f.planning.begin()!;
  for (const [index, limits] of limitsCases.entries()) {
    const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: `invalid-prepare-${index}`, name: "prepare_next",
      arguments: { name: "invalid limit candidate", args: null, limits } }]);
    expect(data(replies[0]!).error.code).toBe("invalid_request");
    expect(f.planning.projection()).toMatchObject({ state: "planning", candidate: null });
  }
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  f.planning.finish(flight.plan_id);
});

test("SDK raw invalid limits cannot replay a prior valid normalized submission identity", async () => {
  const f = fixture();
  const input = { name: "raw identity", source, args: null, limits: { max_actions: 2 } };
  expect((await agentCalls(f.tools(), [{ type: "toolCall", id: "raw-identity", name: "program_submit", arguments: input }]))[0]!.isError).toBe(false);
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: "raw-identity", name: "program_submit",
    arguments: { ...input, limits: { max_actions: "2" } } }]);
  expect(data(replies[0]!).error.code).toBe("invalid_request");
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
});

test("SDK raw prototype keys cannot supply inherited start arguments", async () => {
  const f = fixture();
  const saved = await agentCalls(f.tools(), [{ type: "toolCall", id: "prototype-write", name: "program_write",
    arguments: { entry: "run", name: "prototype target", source } }]);
  expect(saved[0]!.isError).toBe(false);
  const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: "prototype-start", name: "program_run",
    arguments: JSON.parse('{"__proto__":{"operation":"start","name":"prototype target","args":null}}') }]);
  expect(replies[0]!.isError).toBe(true);
  expect(replies[0]!.details).toMatchObject({ error: { code: "invalid_request" } });
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("malformed SDK argument JSON remains SDK-owned rather than a fabricated harmless host rejection", async () => {
  const f = fixture();
  const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: "malformed-sdk-json", name: "program_submit",
    arguments: { __parseError: "Fixture truncated JSON", __rawJson: '{"name":' } }]);
  expect(replies[0]!.isError).toBe(true);
  expect(typeof (replies[0]!.details as { error?: unknown })?.error).toBe("string");
  expect(replies[0]!.details).not.toMatchObject({ error: { code: "invalid_request" } });
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "model.tool_rejected")).toBe(false);
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("installed Agent rejects malformed program input and host-forbidden writes without creating artifacts", async () => {
  const f = fixture();
  const tools = f.tools();
  const malformed = await agentCalls(tools, [
    { type: "toolCall", id: "sdk-missing-source", name: "program_write", arguments: { entry: "run", name: "missing source" } },
    { type: "toolCall", id: "sdk-invalid-body", name: "program_write", arguments: { entry: "run", name: "invalid body", source: "return {", card, dependencies: [] } },
  ]);
  expect(malformed).toHaveLength(2);
  expect(malformed.every((reply) => reply.isError)).toBe(true);
  expect(data(malformed[1]!).error.code).toBe("invalid_program");
  const missingEntry = await f.call("program_write", { name: "unselected module format",
    source: "export function step(frame,state,intent) { return null; }" });
  expect(data(missingEntry).error.code).toBe("invalid_request");
  const forged = await f.call("program_write", { entry: "run", name: "forged authority", source, run_id: "caller-owned-run" });
  expect(forged.isError).toBe(true);
  expect(data(forged).error.code).toBe("invalid_request");
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  // Captured ordinary tools must still enforce current host authority.
  f.run.status = "stopped";
  const forbidden = await agentCalls(tools, [
    { type: "toolCall", id: "sdk-forbidden-write", name: "program_write", arguments: { entry: "run", name: "forbidden write", source, card, dependencies: [] } },
  ]);
  expect(forbidden).toHaveLength(1);
  expect(forbidden[0]!.isError).toBe(true);
  expect(data(forbidden[0]!).error.code).toBe("stale_context");
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  expect(f.actions()).toBe(0);
});

test("named writes use optimistic revisions and catalog pagination counts families, not alphabetical tails", async () => {
  const f = fixture();
  const first = data(await f.write("zebra"));
  expect(first).toMatchObject({ name: "zebra", version: 1, state: "validated" });
  expect(first.source).toBeUndefined();
  const revised = data(await f.write("zebra", source, { based_on: 1 }, "revision-call"));
  expect(revised.version).toBe(2);
  expect(data(await f.write("zebra", source, { based_on: 1 }, "revision-call"))).toEqual(revised);
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  const stale = data(await f.write("zebra", source, { based_on: 1 }));
  expect(stale.error).toMatchObject({ code: "conflict", issues: [{ code: "stale_parent", latest_parent: { name: "zebra", version: 2 } }] });
  await f.write("alpha");
  const page = data(await f.call("program_inspect", { view: "catalog", limit: 1 }));
  expect(page.records).toMatchObject([{ name: "alpha", version: 1 }]);
  expect(page.has_more).toBe(true);
  const next = data(await f.call("program_inspect", { view: "catalog", limit: 1, after: page.next_after }));
  expect(next.records).toMatchObject([{ name: "zebra", version: 2 }]);
  expect(next.has_more).toBe(false);
  expect(data(await f.call("program_inspect", { view: "source", name: "zebra", version: 1 })).version).toBe(1);
});

test("program_submit persists and starts its exact version once and reports pending work to the host", async () => {
  const entered = Promise.withResolvers<void>();
  const f = fixture(async (_body, args, _handle, _limits, signal) => {
    entered.resolve();
    await aborted(signal);
    return { status: "completed", summary: "Released", result: args };
  });
  let admissions = 0;
  f.toolHost.admitted = () => { admissions++; };
  const input = { name: "submitted", source, args: { chosen: true }, limits: { duration_ms: 10000, max_actions: 2, max_calls: 8, max_depth: 2 } };
  const first = await f.call("program_submit", input, "submit-once");
  expect(first.isError).not.toBe(true);
  const outcome = data(first);
  expect(outcome).toMatchObject({ source: { status: "persisted", name: "submitted", version: 1 }, start: { status: "started", execution: { name: "submitted", version: 1 } } });
  await entered.promise;
  const original = f.store.latestRootExecution(f.run.run_id)!;
  expect(original.args).toEqual({ chosen: true });
  expect(original.limits).toEqual(input.limits);
  expect(f.manager.pending).toBe(true);
  expect(admissions).toBe(1);
  await f.write("submitted", source, { based_on: 1 });
  expect(data(await f.call("program_submit", input, "submit-once"))).toEqual(outcome);
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
  expect(admissions).toBe(1);
  expect(data(await f.call("program_submit", { ...input, args: null }, "submit-once")).error.code).toBe("conflict");
});

test("program_submit rejects invalid source, lineage, dependencies and limits before starting", async () => {
  const f = fixture();
  await f.write("existing");
  const cases = [
    { input: { name: "bad syntax", source: "return {", args: null }, code: "invalid_program" },
    { input: { name: "oversized", source: " ".repeat(16385), args: null }, code: "invalid_request" },
    { input: { name: "existing", based_on: 2, source, args: null }, code: "conflict" },
    { input: { name: "missing dependency", source, args: null, dependencies: [{ name: "absent" }] }, code: "not_found" },
    { input: { name: "bad limit", source, args: null, limits: { duration_ms: 0, max_actions: 1, max_calls: 1, max_depth: 1 } }, code: "invalid_request" },
  ];
  for (const { input, code } of cases) {
    expect(data(await f.call("program_submit", input)).error.code).toBe(code);
  }
  expect(f.store.skills(f.run.run_id)).toHaveLength(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

for (const toolName of ["program_write", "program_submit", "program_edit"] as const) {
  test(`${toolName} distinguishes missing parent outcome from missing source and permits an ordinary revision`, async () => {
    const f = fixture();
    const name = "unexecuted revision";
    await f.write(name);
    await f.call("program_run", { operation: "start", name, version: 1, args: null });
    await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
    await f.prepareFeedback();
    expect(data(await f.write(name, source, { based_on: 1 }))).toMatchObject({ version: 2, experiment: null });
    const parent = f.store.namedSkill(f.run.run_id, name, 2)!;
    const feedback = f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity");
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.version.version).toBe(1);
    const revisionCard = { ...card, reason: "Repair the stored source before its first execution" };
    const input = toolName === "program_edit"
      ? { name, based_on: 2, edits: [{ old_text: "Neutral result", new_text: "Stored revision" }] }
      : { entry: "run", name, source, card: revisionCard, based_on: 2,
        ...(toolName === "program_submit" ? { args: null } : {}) };
    const refused = await f.call(toolName, { ...input, reason: "Link a candidate to this exact parent's outcome" });
    expect(refused.isError).toBe(true);
    expect(data(refused).error).toMatchObject({
      code: "precondition_failed", retryable: false,
      issues: [{ code: "missing_parent_outcome", path: "reason" }],
    });
    expect(f.store.namedSkill(f.run.run_id, name)).toMatchObject({ version: 2, hash: parent.hash });
    expect(f.store.skills(f.run.run_id)).toHaveLength(2);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(0);
    expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual(feedback);

    const ordinary = await f.call(toolName, input);
    expect(ordinary.isError).not.toBe(true);
    if (toolName === "program_submit") {
      expect(data(ordinary)).toMatchObject({
        source: { status: "persisted", name, version: 3 },
        start: { status: "started", execution: { name, version: 3 } },
      });
      const execution = f.store.latestRootExecution(f.run.run_id)!;
      expect(execution).toMatchObject({ version: 3, args: null });
      await waitClosed(f.store, f.run.run_id, execution.execution_id);
    } else expect(data(ordinary)).toMatchObject({ name, version: 3, experiment: null });
    expect(f.store.namedSkill(f.run.run_id, name, 3)).toMatchObject({
      skill_id: parent.skill_id, parent_version: 2, card: toolName === "program_edit" ? parent.card : revisionCard,
    });
    expect(f.actions()).toBe(0);
    expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual(feedback);
  });
}

test("program_submit requires explicit JSON args at the installed Agent boundary and accepts unused null", async () => {
  const f = fixture();
  const input = { name: "explicit unused arguments", source };
  const missing = await agentCalls(f.tools(), [
    { type: "toolCall", id: "missing-submit-args", name: "program_submit", arguments: input },
  ]);
  expect(missing[0]!.isError).toBe(true);
  expect(data(missing[0]!).error).toMatchObject({
    code: "invalid_request", issues: [{ path: "args" }],
  });
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  const submitted = await agentCalls(f.tools(), [
    { type: "toolCall", id: "null-submit-args", name: "program_submit", arguments: { ...input, args: null } },
  ]);
  expect(submitted[0]!.isError).not.toBe(true);
  expect(data(submitted[0]!)).toMatchObject({
    source: { status: "persisted", version: 1 }, start: { status: "started" },
  });
  const execution = f.store.latestRootExecution(f.run.run_id)!;
  expect(execution.args).toBeNull();
  await waitClosed(f.store, f.run.run_id, execution.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: execution.execution_id })!.result).toMatchObject({ result: null });
});

for (const toolName of ["program_submit", "program_run"] as const) {
  test(`${toolName} settles only the current emitted semantic capability before successor effects`, async () => {
    const emitting = Promise.withResolvers<void>(), receipt = Promise.withResolvers<void>(), settling = Promise.withResolvers<void>();
    const effects: string[] = [];
    let oldSignal: AbortSignal | undefined, cancelled = 0;
    const f = fixture(undefined, {
      action: async (execution, _action, signal) => {
        if (execution.args === "old") {
          oldSignal = signal;
          effects.push("old-emitted");
          emitting.resolve();
          await receipt.promise;
          expect(signal.aborted).toBe(false);
          expect(f.manager.effectScope(execution.execution_id)).not.toBeNull();
          effects.push("old-confirmed");
        } else {
          expect(cancelled).toBe(1);
          effects.push("successor-emitted");
        }
        return { status: "succeeded", summary: "Bounded emitted action confirmed", evidence: { effect_confirmed: true } };
      },
      cancelActions: async () => { cancelled++; effects.push("old-retired"); },
    });
    resources.unshift(async () => { receipt.resolve(); });
    const movement = 'await game.action({kind:"move",controls:{forward:true},duration_ms:100});';
    await f.write("emitting predecessor", `${movement}${movement}${source}`);
    const old = data(await f.call("program_run", { operation: "start", name: "emitting predecessor", args: "old" }));
    await emitting.promise;
    const predecessor = f.store.latestRootExecution(f.run.run_id)!;
    const deadline = predecessor.deadline_at;
    const successorSource = `await game.action({kind:"look",yaw:0.1,pitch:0});${source}`;
    if (toolName === "program_run") await f.write("bounded successor", successorSource);
    const controller = new AbortController();
    const retire = f.manager.retireForHandoff.bind(f.manager);
    f.manager.retireForHandoff = (...args) => {
      expect(args[3]).toBe(controller.signal);
      const pending = retire(...args);
      settling.resolve();
      return pending;
    };
    const input = { name: "bounded successor", args: "new",
      handoff: { name: old.name, version: old.version, execution_ordinal: old.execution_ordinal },
      ...(toolName === "program_submit" ? { source: successorSource } : { operation: "start" }) };
    const tool = f.tools().find(tool => tool.name === toolName)!;
    const pending = tool.execute(`emitting-handoff-${toolName}`, input, controller.signal);
    await settling.promise;
    expect(oldSignal!.aborted).toBe(false);
    expect(f.manager.effectScope(predecessor.execution_id)).not.toBeNull();
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(1);
    expect(cancelled).toBe(0);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })).toMatchObject({
      status: "running", actions: 1, calls: 1, deadline_at: deadline,
    });
    receipt.resolve();
    const result = data(await pending);
    expect(toolName === "program_submit" ? result.start.status : result.name).toBe(
      toolName === "program_submit" ? "started" : "bounded successor");
    const successor = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, successor.execution_id);
    expect(effects).toEqual(["old-emitted", "old-confirmed", "old-retired", "successor-emitted"]);
    expect(oldSignal!.aborted).toBe(true);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })).toMatchObject({
      status: "cancelled", actions: 1, calls: 1, deadline_at: deadline,
    });
    expect(f.actions()).toBe(2);
    expect(f.dispatches()).toBe(2);
    expect(data(await tool.execute(`emitting-handoff-${toolName}`, input, controller.signal))).toEqual(result);
    expect(f.actions()).toBe(2);
    expect(f.dispatches()).toBe(2);
  });
}

for (const toolName of ["program_submit", "program_run"] as const) for (const boundary of ["abort", "stop"] as const) {
  test(`${toolName} ${boundary} immediately revokes held semantic settling and refuses successor effects`, async () => {
    const emitting = Promise.withResolvers<void>(), receipt = Promise.withResolvers<void>(), settling = Promise.withResolvers<void>();
    const capabilitySettled = Promise.withResolvers<void>();
    let oldSignal: AbortSignal | undefined, cancellations = 0;
    const f = fixture(async (_body, args, handle, _limits, signal) => {
      const capability = handle({ kind: "action", action: { kind: "move", controls: { forward: true }, duration_ms: 100 } });
      void capability.then(() => capabilitySettled.resolve(), () => capabilitySettled.resolve());
      await Promise.race([capability, aborted(signal)]);
      return { status: "completed", summary: "Worker relinquished on immediate abort", result: args };
    }, {
      action: async (_execution, _action, signal) => {
        oldSignal = signal;
        emitting.resolve();
        await receipt.promise;
        return { status: "succeeded", summary: "Late receipt cannot restore revoked authority", evidence: { effect_confirmed: true } };
      },
      cancelActions: async () => { cancellations++; },
    });
    resources.unshift(async () => { receipt.resolve(); });
    await f.write("preempted predecessor");
    const old = data(await f.call("program_run", { operation: "start", name: "preempted predecessor", args: "old" }));
    await emitting.promise;
    const predecessor = f.store.latestRootExecution(f.run.run_id)!;
    if (toolName === "program_run") await f.write("refused successor");
    const controller = new AbortController();
    let sdkAgent: Agent | undefined, toolSignal: AbortSignal | undefined = controller.signal;
    const retire = f.manager.retireForHandoff.bind(f.manager);
    f.manager.retireForHandoff = (...args) => {
      expect(args[3]).toBe(toolSignal);
      const pending = retire(...args);
      settling.resolve();
      return pending;
    };
    const input = { name: "refused successor", args: null,
      handoff: { name: old.name, version: old.version, execution_ordinal: old.execution_ordinal },
      ...(toolName === "program_submit" ? { source } : { operation: "start" }) };
    const id = `preempt-held-${toolName}-${boundary}`;
    const tools = f.tools(), tool = tools.find(tool => tool.name === toolName)!;
    const execute = tool.execute.bind(tool);
    tool.execute = async (...args) => { toolSignal = args[2]; return await execute(...args); };
    const pending = boundary === "abort"
      ? agentCalls(tools, [{ type: "toolCall", id, name: toolName, arguments: input }], undefined,
        agent => { sdkAgent = agent; }).then(() => tool.execute(id, input))
      : tool.execute(id, input, controller.signal);
    await settling.promise;
    expect(oldSignal!.aborted).toBe(false);
    expect(cancellations).toBe(0);
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolSignal!.aborted).toBe(false);
    if (boundary === "abort") sdkAgent!.abort();
    else await f.call("program_run", { operation: "stop", target: "current" });
    expect(oldSignal!.aborted).toBe(true);
    expect(f.manager.effectScope(predecessor.execution_id)).toBeNull();
    expect(cancellations).toBe(1);
    await waitClosed(f.store, f.run.run_id, predecessor.execution_id);
    const result = data(await pending);
    if (toolName === "program_submit") expect(result).toMatchObject({
      source: { status: "persisted", version: 1 }, start: { status: "refused" },
    });
    else expect(result.error.code).toBe(boundary === "abort" ? "precondition_failed" : "stale_context");
    expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })).toMatchObject({
      status: "cancelled", calls: 1, actions: 1,
    });
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(1);
    receipt.resolve();
    await capabilitySettled.promise;
    const replay = data(await tool.execute(id, input));
    if (toolName === "program_submit") expect(replay).toEqual(result);
    else expect(replay.error.code).toBe("precondition_failed");
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(1);
  });
}

for (const toolName of ["program_submit", "program_run"] as const) {
  test(`${toolName} cannot introduce a second run controller before the first fully drains`, async () => {
    const entered = Promise.withResolvers<void>(), retiring = Promise.withResolvers<void>(), retired = Promise.withResolvers<void>();
    let oldSignal: AbortSignal | undefined;
    const f = fixture(async (_body, args, handle, _limits, signal) => {
      await handle({ kind: "action", action: { kind: "look", yaw: args === "old" ? 0.01 : 0.02, pitch: 0 } });
      if (args === "old") { oldSignal = signal; entered.resolve(); await aborted(signal); }
      return { status: "completed", summary: "Bounded controller settled", result: args };
    }, { cancelActions: async () => { retiring.resolve(); await retired.promise; } });
    resources.unshift(async () => { retired.resolve(); });
    await f.write("single playing root");
    expect((await f.call("program_run", { operation: "start", name: "single playing root", args: "old" })).isError).not.toBe(true);
    await entered.promise;
    const predecessor = f.store.latestRootExecution(f.run.run_id)!;
    if (toolName === "program_run") await f.write("competing controller");
    const input = { name: "competing controller", args: "new",
      ...(toolName === "program_submit" ? { source } : { operation: "start" }) };
    const refused = data(await f.call(toolName, input));
    expect(toolName === "program_submit" ? refused.start.error.code : refused.error.code).toBe("busy");
    expect(oldSignal!.aborted).toBe(false);
    expect(f.store.latestRootExecution(f.run.run_id)!.execution_id).toBe(predecessor.execution_id);
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(1);
    expect(f.manager.effectScope(predecessor.execution_id)).not.toBeNull();
    expect((await f.call("program_run", { operation: "stop", target: "current" })).isError).not.toBe(true);
    await retiring.promise;
    expect(data(await f.call("program_run", { operation: "start", name: "competing controller", args: "new" })).error.code).toBe("busy");
    expect(f.dispatches()).toBe(1);
    retired.resolve();
    await waitClosed(f.store, f.run.run_id, predecessor.execution_id);
    const next = data(await f.call("program_run", { operation: "start", name: "competing controller", args: "new" }));
    await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
    expect(next.name).toBe("competing controller");
    expect(f.dispatches()).toBe(2);
    expect(f.actions()).toBe(2);
  });
}

test("one submission keeps old control through validation and waits actual retirement before the exact successor", async () => {
  const entered = Promise.withResolvers<void>(), validating = Promise.withResolvers<void>(), publish = Promise.withResolvers<void>();
  const retiring = Promise.withResolvers<void>(), retired = Promise.withResolvers<void>(), successorEntered = Promise.withResolvers<void>();
  let oldSignal: AbortSignal | undefined, nativeRetired = false;
  const f = fixture(async (_body, args, _handle, _limits, signal) => {
    if (args === "old") { oldSignal = signal; entered.resolve(); }
    else { expect(nativeRetired).toBe(true); successorEntered.resolve(); }
    await aborted(signal);
    return { status: "completed", summary: "Owned worker drained", result: args };
  }, { cancelActions: async () => { retiring.resolve(); await retired.promise; nativeRetired = true; } });
  resources.unshift(async () => { publish.resolve(); retired.resolve(); });
  await f.write("old controller");
  const predecessor = data(await f.call("program_run", { operation: "start", name: "old controller", args: "old" }));
  await entered.promise;
  const originalRegister = f.sources.register.bind(f.sources);
  f.sources.register = async (...args) => { validating.resolve(); await publish.promise; return await originalRegister(...args); };
  const input = { name: "authored successor", source, args: { selected: "original" }, handoff: {
    name: predecessor.name, version: predecessor.version, execution_ordinal: predecessor.execution_ordinal,
  }, limits: { duration_ms: 9000, max_actions: 3, max_calls: 4, max_depth: 2 } };
  const pending = f.call("program_submit", input, "single-handoff");
  await validating.promise;
  expect(oldSignal!.aborted).toBe(false);
  expect(f.dispatches()).toBe(1);
  publish.resolve();
  await retiring.promise;
  expect(oldSignal!.aborted).toBe(true);
  expect(f.dispatches()).toBe(1);
  expect(f.store.latestRootExecution(f.run.run_id)!.status).toBe("cancel_requested");
  retired.resolve();
  const result = data(await pending);
  await successorEntered.promise;
  expect(result).toMatchObject({ source: { status: "persisted", name: input.name, version: 1 },
    start: { status: "started", execution: { name: input.name, version: 1 } } });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  expect(root.args).toEqual(input.args);
  expect(root.limits).toEqual(input.limits);
  expect(Date.parse(root.deadline_at) - Date.parse(root.started_at!)).toBeLessThanOrEqual(9000);
  expect(Date.parse(root.deadline_at)).toBeGreaterThan(Date.parse(root.started_at!));
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(2);
  await f.write(input.name, source, { based_on: 1 });
  expect(data(await f.call("program_submit", input, "single-handoff"))).toEqual(result);
  expect(f.manager.effectScope(root.execution_id)).not.toBeNull();
  expect(f.dispatches()).toBe(2);
});

test("handoff rejects a mismatched predecessor or invalid successor without cancelling useful work", async () => {
  const entered = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined, cancellations = 0;
  const f = fixture(async (_body, _args, _handle, _limits, current) => {
    signal = current; entered.resolve(); await aborted(current);
    return { status: "completed", summary: "Closed", result: null };
  }, { cancelActions: async () => { cancellations++; } });
  await f.write("useful predecessor");
  const old = data(await f.call("program_run", { operation: "start", name: "useful predecessor", args: null }));
  await entered.promise;
  const handoff = { name: old.name, version: old.version, execution_ordinal: old.execution_ordinal };
  await f.write("valid successor");
  for (const mismatch of [{ ...handoff, name: "another root" }, { ...handoff, version: 2 }, { ...handoff, execution_ordinal: 2 }]) {
    expect(data(await f.call("program_run", { operation: "start", name: "valid successor", args: null, handoff: mismatch })).error.code).toBe("precondition_failed");
  }
  expect(data(await f.call("program_submit", { name: "invalid successor", source: "const =", args: null, handoff })).error.code).toBe("invalid_program");
  expect(data(await f.call("program_submit", { name: "invalid limits", source, args: null, limits: { duration_ms: 0 }, handoff })).error.code).toBe("invalid_request");
  expect(data(await f.call("program_run", { operation: "start", entry: "step", name: "valid successor", args: null, handoff })).error.code).toBe("precondition_failed");
  const unsupported = data(await f.call("program_submit", { entry: "step", name: "unsupported successor",
    source: "export function step(frame,state,intent){return {input:null,next_state:state,status:'completed',events:[]};}",
    args: null, handoff }));
  expect(unsupported).toMatchObject({ source: { status: "persisted" }, start: { status: "refused", error: { code: "precondition_failed" } } });
  expect(signal!.aborted).toBe(false);
  expect(cancellations).toBe(0);
  expect(f.dispatches()).toBe(1);
});

for (const boundary of ["task", "generation", "life", "boot", "space", "screen", "stop", "abort", "unknown"] as const) {
  test(`handoff never starts after ${boundary} changes during held retirement`, async () => {
    const entered = Promise.withResolvers<void>(), retiring = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = fixture(async (_body, _args, _handle, _limits, signal) => {
      entered.resolve(); await aborted(signal); return { status: "completed", summary: "Drained", result: null };
    }, { cancelActions: async () => { retiring.resolve(); await release.promise; if (boundary === "unknown") throw new Error("Unacknowledged native retirement"); } });
    resources.unshift(async () => { release.resolve(); });
    await f.write("held predecessor");
    const old = data(await f.call("program_run", { operation: "start", name: "held predecessor", args: null }));
    await entered.promise;
    const controller = new AbortController();
    const tool = f.tools().find(tool => tool.name === "program_submit")!;
    const input = { name: "blocked successor", source, args: null,
      handoff: { name: old.name, version: old.version, execution_ordinal: old.execution_ordinal } };
    const pending = tool.execute(`held-handoff-${boundary}`, input, controller.signal);
    await retiring.promise;
    if (boundary === "task") f.run.task = "Different task";
    if (boundary === "generation") f.fence();
    if (boundary === "life") f.run.life_id!++;
    if (boundary === "boot") f.run.native_boot_id = "new-native-boot";
    if (boundary === "space") f.run.space_epoch!++;
    if (boundary === "screen") f.toolHost.observe = async () => ({ ...f.observation(),
      screen: { screen_id: "different-screen", incarnation: 1, revision: 1 } });
    if (boundary === "stop") await f.call("program_run", { operation: "stop" });
    if (boundary === "abort") controller.abort();
    release.resolve();
    const result = data(await pending);
    expect(result.source).toMatchObject({ status: "persisted", name: input.name, version: 1 });
    expect(["refused", "unknown"]).toContain(result.start.status);
    expect(f.dispatches()).toBe(1);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    expect(data(await tool.execute(`held-handoff-${boundary}`, input))).toEqual(result);
  });
}

for (const toolName of ["program_submit", "program_run"] as const) {
  test(`${toolName} interrupted handoff is evidence-only and cannot resume or select a newer candidate`, async () => {
    const entered = Promise.withResolvers<void>(), retiring = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = fixture(async (_body, _args, _handle, _limits, signal) => {
      entered.resolve(); await aborted(signal); return { status: "completed", summary: "Drained", result: null };
    }, { cancelActions: async () => { retiring.resolve(); await release.promise; } });
    resources.unshift(async () => { release.resolve(); });
    await f.write("original owner");
    const old = data(await f.call("program_run", { operation: "start", name: "original owner", args: null }));
    await entered.promise;
    if (toolName === "program_run") await f.write("pinned candidate");
    const input = { name: "pinned candidate", args: null, handoff: {
      name: old.name, version: old.version, execution_ordinal: old.execution_ordinal,
    }, ...(toolName === "program_submit" ? { source } : { operation: "start" }) };
    const pending = f.call(toolName, input, `interrupted-${toolName}`);
    await retiring.promise;
    const duplicate = data(await f.call(toolName, input, `interrupted-${toolName}`));
    if (toolName === "program_submit") expect(duplicate.start.status).toBe("unknown");
    else expect(duplicate.error.code).toBe("precondition_failed");
    await f.write("pinned candidate", 'return {status:"completed",summary:"New candidate",result:2};', { based_on: 1 });
    release.resolve();
    const original = data(await pending);
    if (toolName === "program_submit") expect(original).toEqual(duplicate);
    else expect(original.error.code).toBe("stale_context");
    expect(f.store.namedSkill(f.run.run_id, "pinned candidate")!.version).toBe(2);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    expect(f.dispatches()).toBe(1);
    const replay = data(await f.call(toolName, input, `interrupted-${toolName}`));
    if (toolName === "program_submit") expect(replay).toEqual(duplicate);
    else expect(replay.error.code).toBe("precondition_failed");
  });
}

for (const toolName of ["program_submit", "program_run"] as const) {
  test(`${toolName} lost handoff acknowledgement reuses its successor without cancelling or dispatching again`, async () => {
    const entered = Promise.withResolvers<void>(), successorEntered = Promise.withResolvers<void>();
    let cancellations = 0;
    const f = fixture(async (_body, args, _handle, _limits, signal) => {
      (args === "old" ? entered : successorEntered).resolve();
      await aborted(signal); return { status: "completed", summary: "Drained", result: args };
    }, { cancelActions: async () => { cancellations++; } });
    await f.write("ack predecessor");
    const old = data(await f.call("program_run", { operation: "start", name: "ack predecessor", args: "old" }));
    await entered.promise;
    if (toolName === "program_run") await f.write("ack successor");
    const input = { name: "ack successor", args: "successor", handoff: {
      name: old.name, version: old.version, execution_ordinal: old.execution_ordinal,
    }, ...(toolName === "program_submit" ? { source } : { operation: "start" }) };
    const id = `lost-handoff-${toolName}`, db = new Database(join(f.directory, "runs.sqlite"));
    db.exec(`CREATE TRIGGER lose_handoff_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND NEW.object_key='${id}' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END;`);
    expect((await f.call(toolName, input, id)).isError).toBe(true);
    await successorEntered.promise;
    const selected = f.store.latestRootExecution(f.run.run_id)!;
    expect(selected.version).toBe(1);
    db.exec("DROP TRIGGER lose_handoff_ack;");
    await f.write("ack successor", source, { based_on: 1 });
    const replay = data(await f.call(toolName, input, id));
    expect(toolName === "program_submit" ? replay.start.execution : replay).toMatchObject({
      name: "ack successor", version: 1,
    });
    expect(f.manager.effectScope(selected.execution_id)).not.toBeNull();
    expect(f.store.latestRootExecution(f.run.run_id)!.execution_id).toBe(selected.execution_id);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(2);
    expect(f.dispatches()).toBe(2);
    expect(cancellations).toBe(1);
    db.close();
  });
}

for (const initial of ["live", "completed"] as const) for (const boundary of ["newer_root", "stop_after_drain"] as const) {
  test(`handoff from ${initial} predecessor cannot replace ${boundary} during post-retirement observation`, async () => {
    const entered = Promise.withResolvers<void>(), observing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = fixture(async (_body, args, _handle, _limits, signal) => {
      entered.resolve();
      if (initial !== "completed" || args !== "old") await aborted(signal);
      return { status: "completed", summary: "Closed", result: null };
    });
    resources.unshift(async () => { release.resolve(); });
    await f.write("observation predecessor");
    const old = data(await f.call("program_run", { operation: "start", name: "observation predecessor", args: "old" }));
    await entered.promise;
    if (initial === "completed")
      await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
    let observations = 0;
    f.toolHost.observe = async () => {
      if (++observations === 2) { observing.resolve(); await release.promise; }
      return f.observation();
    };
    const input = { name: "observation successor", source, args: null, handoff: {
      name: old.name, version: old.version, execution_ordinal: old.execution_ordinal,
    } };
    const pending = f.call("program_submit", input);
    await observing.promise;
    expect(f.manager.pending).toBe(false);
    if (boundary === "newer_root") {
      await f.write("independently selected root");
      await f.call("program_run", { operation: "start", name: "independently selected root", args: null });
    } else {
      expect(data(await f.call("program_run", { operation: "stop" })).status).toBe("idle");
    }
    const current = f.store.latestRootExecution(f.run.run_id)!;
    release.resolve();
    expect(data(await pending)).toMatchObject({ source: { status: "persisted", version: 1 }, start: { status: "refused" } });
    expect(f.store.latestRootExecution(f.run.run_id)!.execution_id).toBe(current.execution_id);
    expect(f.dispatches()).toBe(boundary === "newer_root" ? 2 : 1);
    if (boundary === "newer_root") expect(f.manager.effectScope(current.execution_id)).not.toBeNull();
  });
}

for (const toolName of ["program_submit", "program_run"] as const) test(`${toolName} hands off a successfully completed latest predecessor without replay`, async () => {
  const f = fixture();
  await f.write("already finished");
  const old = data(await f.call("program_run", { operation: "start", name: "already finished", args: null }));
  const predecessor = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, predecessor.execution_id);
  const closed = f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })!;
  if (toolName === "program_run") await f.write("authored continuation");
  const handoff = { name: old.name, version: old.version, execution_ordinal: old.execution_ordinal };
  const input = { ...(toolName === "program_run" ? { operation: "start" } : { source }),
    name: "authored continuation", args: null, handoff };
  const result = data(await f.call(toolName, input, "completed-handoff"));
  expect(toolName === "program_submit" ? result.start.status : result.name).toBe(
    toolName === "program_submit" ? "started" : "authored continuation");
  expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })).toMatchObject({
    status: "succeeded", ended_at: closed.ended_at, actions: closed.actions, calls: closed.calls,
  });
  expect(f.dispatches()).toBe(2);
  const duplicate = data(await f.call(toolName, input, "completed-handoff"));
  const originalSelection = toolName === "program_submit" ? result.start.execution : result;
  const duplicateSelection = toolName === "program_submit" ? duplicate.start.execution : duplicate;
  expect(duplicateSelection).toMatchObject({
    name: originalSelection.name, version: originalSelection.version,
    execution_ordinal: originalSelection.execution_ordinal,
  });
  const successor = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, successor.execution_id);
  expect(data(await f.call("program_run", { operation: "start", name: "authored continuation", args: null, handoff })).error.code)
    .toBe("precondition_failed");
  expect(f.dispatches()).toBe(2);
});

test("natural completion while fresh handoff observation is pending remains a confirmed retirement", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const observing = Promise.withResolvers<void>(), fresh = Promise.withResolvers<void>();
  let cancellations = 0;
  const f = fixture(async (_body, args) => {
    if (args === "old") { entered.resolve(); await finish.promise; }
    return { status: "completed", summary: "Naturally completed", result: null };
  }, { cancelActions: async () => { cancellations++; } });
  resources.unshift(async () => { finish.resolve(); fresh.resolve(); });
  await f.write("finishing during authoring");
  const old = data(await f.call("program_run", { operation: "start", name: "finishing during authoring", args: "old" }));
  const predecessor = f.store.latestRootExecution(f.run.run_id)!;
  await entered.promise;
  let reads = 0;
  f.toolHost.observe = async () => {
    if (++reads === 1) { observing.resolve(); await fresh.promise; }
    return f.observation();
  };
  const pending = f.call("program_submit", { name: "next authored work", source, args: null, handoff: {
    name: old.name, version: old.version, execution_ordinal: old.execution_ordinal,
  } });
  await observing.promise;
  finish.resolve();
  await waitClosed(f.store, f.run.run_id, predecessor.execution_id);
  fresh.resolve();
  expect(data(await pending)).toMatchObject({ start: { status: "started" } });
  expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })!.status).toBe("succeeded");
  expect(cancellations).toBe(0);
  expect(f.dispatches()).toBe(2);
});

for (const status of ["blocked", "failed", "cancelled", "unknown"] as const) {
  test(`completed handoff never reinterprets ${status} as natural success`, async () => {
    const f = fixture(async (_body, _args, handle) => {
      if (status === "failed") throw new Error("Actual source failure");
      if (status === "cancelled" || status === "unknown") {
        f.manager.fence("Explicitly revoked source", status === "unknown" ? f.store.latestRootExecution(f.run.run_id)!.execution_id : undefined);
        // A revoked producer must not be allowed to publish further calls.
        await handle({ kind: "observe" });
      }
      return { status: "blocked", summary: "Locally blocked", result: null };
    });
    await f.write("non-success predecessor");
    const old = data(await f.call("program_run", { operation: "start", name: "non-success predecessor", args: null }));
    const predecessor = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, predecessor.execution_id);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })!.status).toBe(status);
    if (status === "unknown") {
      const retained = f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })!;
      const inspected = data(await f.call("program_inspect", { view: "execution", program: { name: "non-success predecessor" } }));
      expect(inspected).toMatchObject({ status: "unknown", native_life_relation: "same_native_life",
        error: retained.error, result: retained.result });
      expect(f.store.skillExecution(f.run.run_id, { execution_id: predecessor.execution_id })).toEqual(retained);
      expect(f.actions()).toBe(0);
    }
    const result = data(await f.call("program_submit", { name: "must not implicitly recover", source, args: null, handoff: {
      name: old.name, version: old.version, execution_ordinal: old.execution_ordinal,
    } }));
    expect(result).toMatchObject({ source: { status: "persisted" }, start: { status: "refused" } });
    expect(f.dispatches()).toBe(1);
  });
}

for (const boundary of ["world", "session", "epoch", "life", "boot", "space", "compatibility", "generation"] as const) {
  test(`completed predecessor handoff cannot cross ${boundary} authority`, async () => {
    const f = fixture();
    await f.write("completed old scope");
    const old = data(await f.call("program_run", { operation: "start", name: "completed old scope", args: null }));
    await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
    await f.write("new scoped continuation");
    if (boundary === "world") f.run.world_id = crypto.randomUUID();
    if (boundary === "session") f.run.session_id = "new-fixture-session";
    if (boundary === "epoch") f.run.epoch++;
    if (boundary === "life") f.run.life_id!++;
    if (boundary === "boot") f.run.native_boot_id = "different-native-boot";
    if (boundary === "space") f.run.space_epoch!++;
    if (boundary === "compatibility") f.run.compatibility_hash = "a".repeat(64);
    if (boundary === "generation") f.fence();
    f.store.saveRun(f.run);
    const result = await f.call("program_run", { operation: "start", name: "new scoped continuation", args: null, handoff: {
      name: old.name, version: old.version, execution_ordinal: old.execution_ordinal,
    } });
    expect(result.isError).toBe(true);
    expect(f.dispatches()).toBe(1);
  });
}

test("program_submit pins source and dependencies even when a newer revision appears between phases", async () => {
  const f = fixture();
  await f.write("child", 'return {status:"completed",summary:"Original child",result:1};');
  const input = { name: "submitted parent", source: 'return await game.call({name:"child"},args);', args: null, dependencies: [{ name: "child" }] };
  const originalRegister = f.sources.register.bind(f.sources);
  let interleave = true;
  f.sources.register = async (...args) => {
    const written = await originalRegister(...args);
    if (interleave && written.name === input.name) {
      interleave = false;
      await f.write(input.name, 'return {status:"completed",summary:"Newer parent",result:99};', { based_on: 1 });
      await f.write("child", 'return {status:"completed",summary:"Newer child",result:2};', { based_on: 1 });
    }
    return written;
  };
  expect(data(await f.call("program_submit", input)).start).toMatchObject({ status: "started", execution: { name: input.name, version: 1 } });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.result).toMatchObject({ result: 1 });
  expect(f.store.allSkillExecutions(f.run.run_id).map(execution => execution.version)).toEqual([1, 1]);
});

for (const boundary of ["stop", "pause", "generation", "task", "owner"] as const) {
  test(`program_submit preserves source but blocks ${boundary} authority changes between phases`, async () => {
    const f = fixture();
    const originalRegister = f.sources.register.bind(f.sources);
    f.sources.register = async (...args) => {
      const written = await originalRegister(...args);
      if (boundary === "stop") f.run.status = "stopped";
      if (boundary === "pause") f.run.status = "paused";
      if (boundary === "generation") f.fence();
      if (boundary === "task") f.run.task = "A different task must not inherit this decision";
      if (boundary === "owner") f.toolHost.run = () => ({ ...f.run, run_id: "different-owner" });
      f.store.saveRun(f.run);
      return written;
    };
    const outcome = data(await f.call("program_submit", { name: "interrupted", source, args: null }, `submit-${boundary}`));
    expect(outcome).toMatchObject({ source: { status: "persisted", name: "interrupted", version: 1 }, start: { status: "refused", error: { code: "stale_context", retryable: false } } });
    expect(f.store.skills(f.run.run_id)).toHaveLength(1);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
    expect(f.dispatches()).toBe(0);
  });
}

test("program_submit returns and durably replays a refused start without retrying admission", async () => {
  const f = fixture();
  let attempts = 0;
  f.manager.start = () => { attempts++; throw new RuntimeFault("conflict", "Another owner holds effect admission"); };
  const input = { name: "saved but refused", source, args: null };
  const first = data(await f.call("program_submit", input, "refused-submit"));
  expect(first).toMatchObject({ source: { status: "persisted", version: 1 }, start: { status: "refused", error: { code: "conflict", retryable: false } } });
  expect(data(await f.call("program_submit", input, "refused-submit"))).toEqual(first);
  expect(attempts).toBe(1);
  expect(f.store.skills(f.run.run_id)).toHaveLength(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("program_submit lost final acknowledgement replays its original execution and never latest", async () => {
  const f = fixture();
  const db = new Database(join(f.directory, "runs.sqlite"));
  const id = "lost-submit-final";
  db.exec(`CREATE TRIGGER lose_submit_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND NEW.object_key='${id}' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END;`);
  const input = { name: "lost final", source, args: { original: true } };
  expect((await f.call("program_submit", input, id)).isError).toBe(true);
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  db.exec("DROP TRIGGER lose_submit_ack;");
  await f.write(input.name, source, { based_on: 1 });
  f.run.epoch++; f.run.life_id!++; f.store.saveRun(f.run);
  expect(data(await f.call("program_submit", input, id))).toMatchObject({
    source: { status: "persisted", version: 1 }, start: { status: "started", execution: { version: 1 } },
  });
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  db.close();
});

for (const boundary of ["pause", "generation", "abort"] as const) {
  for (const outcome of ["started", "refused"] as const) {
    test(`program_submit recovers its ${outcome} inner receipt after lost outer acknowledgement and ${boundary}`, async () => {
      const f = fixture();
      const tool = f.tools().find(tool => tool.name === "program_submit")!;
      const controller = new AbortController();
      let starts = 0;
      const originalStart = f.manager.start.bind(f.manager);
      f.manager.start = (...args) => {
        starts++;
        if (outcome === "refused") throw new RuntimeFault("conflict", "Controlled admission refusal");
        return originalStart(...args);
      };
      const db = new Database(join(f.directory, "runs.sqlite"));
      const id = "recover-submit-receipt";
      db.exec(`CREATE TRIGGER lose_submit_outer_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND NEW.object_key='${id}' BEGIN SELECT RAISE(ABORT,'lost outer acknowledgement'); END;`);
      const input = { name: "recover receipt", source, args: { original: true } };
      expect((await tool.execute(id, input, controller.signal)).isError).toBe(true);
      const receipt = JSON.parse(db.query<{ payload: string }, [string, string]>(
        "SELECT payload FROM evidence_objects WHERE run_id=? AND kind='tool_result' AND json_extract(payload,'$.source.name')=?",
      ).get(f.run.run_id, input.name)!.payload);
      expect(receipt.start.status).toBe(outcome);
      if (outcome === "started") {
        const root = f.store.latestRootExecution(f.run.run_id)!;
        await waitClosed(f.store, f.run.run_id, root.execution_id);
      }
      db.exec("DROP TRIGGER lose_submit_outer_ack;");
      if (boundary === "pause") { f.run.status = "paused"; f.store.saveRun(f.run); }
      if (boundary === "generation") f.fence();
      if (boundary === "abort") controller.abort();
      const replay = await tool.execute(id, input, controller.signal);
      expect(replay.isError).not.toBe(true);
      expect(data(replay)).toEqual(receipt);
      expect(data(await tool.execute(id, { ...input, args: null }, controller.signal)).error.code).toBe("conflict");
      expect((await tool.execute("a-new-submission", { name: "new decision", source, args: null }, controller.signal)).isError).toBe(true);
      expect(starts).toBe(1);
      expect(f.store.skills(f.run.run_id)).toHaveLength(1);
      expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(outcome === "started" ? 1 : 0);
      expect(f.dispatches()).toBe(outcome === "started" ? 1 : 0);
      db.close();
    });
  }
}

test("program_submit persisted-source interruption cannot create another revision or silently start on duplicate", async () => {
  const f = fixture();
  const originalRegister = f.sources.register.bind(f.sources);
  f.sources.register = async (...args) => {
    await originalRegister(...args);
    throw new Error("Lost acknowledgement immediately after immutable source commit");
  };
  const input = { name: "lost source acknowledgement", source, args: null };
  const first = data(await f.call("program_submit", input, "lost-source-submit"));
  expect(first).toMatchObject({ source: { status: "persisted", version: 1 }, start: { status: "refused", error: { retryable: false } } });
  f.sources.register = originalRegister;
  await f.write(input.name, source, { based_on: 1 });
  expect(data(await f.call("program_submit", input, "lost-source-submit"))).toEqual(first);
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("program_write lost source acknowledgement reuses the registered version rather than rechecking latest", async () => {
  const f = fixture();
  const originalRegister = f.sources.register.bind(f.sources);
  f.sources.register = async (...args) => {
    await originalRegister(...args);
    throw new Error("Source committed but acknowledgement lost");
  };
  expect((await f.write("write replay", source, {}, "write-lost-source")).isError).toBe(true);
  f.sources.register = originalRegister;
  await f.write("write replay", source, { based_on: 1 });
  expect(data(await f.write("write replay", source, {}, "write-lost-source"))).toMatchObject({ name: "write replay", version: 1 });
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("program_edit preserves the inspected entry, card and exact dependency aliases without execution", async () => {
  const f = fixture();
  await f.write("edit library", "export const value = 1;", { entry: "library" });
  await f.write("edit consumer", 'import {value} from "./helper.js"; export function analyze(input) { return value; }',
    { entry: "analyze", dependencies: [{ name: "edit library", version: 1, import_path: "./helper.js" }] });
  const before = data(await f.call("program_inspect", { view: "source", name: "edit consumer", version: 1 }));
  await f.write("edit library", "export const value = 2;", { entry: "library", based_on: 1 });
  const input = { name: "edit consumer", based_on: 1, edits: [
    { old_text: "return value;", new_text: "return value + 1;" },
    { old_text: "value + 1", new_text: "value + 2" },
  ] };
  const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: "exact-consumer-edit", name: "program_edit", arguments: input }]);
  expect(replies[0]!.isError).not.toBe(true);
  expect(data(replies[0]!)).toMatchObject({
    name: "edit consumer", version: 2, entry: "analyze", experiment: null,
    dependencies: [{ name: "edit library", version: 1, import_path: "./helper.js" }],
  });
  const after = data(await f.call("program_inspect", { view: "source", name: "edit consumer", version: 2 }));
  expect(after).toMatchObject({
    entry: before.entry, card: before.card, dependencies: before.dependencies, parent_version: 1,
    source: before.source.replace("return value;", "return value + 2;"),
  });
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  expect(f.actions()).toBe(0);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "program.edited")).toMatchObject([{
    details: { tool: "program_edit", input, base: { version: 1 }, revision: { name: "edit consumer", version: 2 } },
  }]);
});

test("program_edit changes dependency pins only when explicitly supplied and keeps graph failures atomic", async () => {
  const f = fixture();
  await f.write("extracted helper", "export const value = 42;", { entry: "library" });
  await f.write("inline consumer", "const value = 41; export function analyze(input) { return value; }", { entry: "analyze" });
  const parent = f.store.namedSkill(f.run.run_id, "inline consumer")!;
  const input = { name: "inline consumer", based_on: 1,
    edits: [{ old_text: "const value = 41;", new_text: 'import { value } from "./helper.js";' }],
    dependencies: [{ name: "extracted helper", version: 1, import_path: "./helper.js" }] };
  const invalid = await f.call("program_edit", { ...input,
    dependencies: [{ name: "missing helper", version: 1, import_path: "./helper.js" }] }, "bad-graph");
  expect(invalid.isError).toBe(true);
  expect(f.store.namedSkill(f.run.run_id, "inline consumer")).toEqual(parent);
  const edited = await f.call("program_edit", input, "extract-helper");
  expect(edited.isError).not.toBe(true);
  expect(data(edited)).toMatchObject({ name: "inline consumer", version: 2,
    dependencies: [{ name: "extracted helper", version: 1, import_path: "./helper.js" }] });
  await f.write("extracted helper", "export const value = 43;", { entry: "library", based_on: 1 });
  expect(data(await f.call("program_edit", input, "extract-helper"))).toEqual(data(edited));
  expect(data(await f.call("program_edit", { ...input,
    dependencies: [{ name: "extracted helper", version: 2, import_path: "./helper.js" }] }, "extract-helper")).error.code).toBe("conflict");
  expect(f.store.namedSkill(f.run.run_id, "inline consumer", 1)).toEqual(parent);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("program_edit refuses missing or stale bases and failed, ambiguous or invalid replacements without revisions", async () => {
  const f = fixture();
  await f.write("edit base", 'const first = "same"; const second = "same"; return {status:"completed",summary:first,result:second};');
  await f.write("edit base", undefined, { based_on: 1 });
  const parent = f.store.namedSkill(f.run.run_id, "edit base")!;
  for (const [name, based_on, edits, code] of [
    ["missing edit", 1, [{ old_text: "Neutral result", new_text: "Changed" }], "not_found"],
    ["edit base", 99, [{ old_text: "Neutral result", new_text: "Changed" }], "not_found"],
    ["edit base", 1, [{ old_text: "same", new_text: "Changed" }], "conflict"],
    ["edit base", 2, [{ old_text: "absent", new_text: "Changed" }], "invalid_program"],
    ["edit base", 2, [{ old_text: "Neutral", new_text: "Changed" }, { old_text: "absent", new_text: "" }], "invalid_program"],
    ["edit base", 2, [{ old_text: "return", new_text: "return (" }], "invalid_program"],
  ] as const) {
    expect(data(await f.call("program_edit", { name, based_on, edits })).error.code).toBe(code);
    expect(f.store.namedSkill(f.run.run_id, "edit base")).toEqual(parent);
    expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  }
  await f.write("ambiguous edit", 'const first = "same"; const second = "same"; return {status:"completed",summary:first,result:second};');
  expect(data(await f.call("program_edit", { name: "ambiguous edit", based_on: 1,
    edits: [{ old_text: "same", new_text: "Changed" }] })).error.code).toBe("invalid_program");
  expect(f.store.namedSkill(f.run.run_id, "ambiguous edit")!.version).toBe(1);
  const rejected = await agentCalls(f.tools(), [{
    type: "toolCall", id: "edit-cannot-replace-source", name: "program_edit",
    arguments: { name: "edit base", based_on: 2, source,
      edits: [{ old_text: "Neutral result", new_text: "Changed" }] },
  }]);
  expect(data(rejected[0]!).error.code).toBe("invalid_request");
  expect(f.store.namedSkill(f.run.run_id, "edit base")).toEqual(parent);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

for (const interruption of ["registration", "final_ack"] as const) {
  test(`program_edit replays its original mutation after ${interruption} and newer source, rejecting equivalent conflicting edits`, async () => {
    const f = fixture();
    await f.write("edit replay");
    const id = `edit-replay-${interruption}`;
    const input = { name: "edit replay", based_on: 1, edits: [{ old_text: "Neutral result", new_text: "Edited result" }] };
    const register = f.sources.register.bind(f.sources);
    const db = new Database(join(f.directory, "runs.sqlite"));
    if (interruption === "registration") f.sources.register = async (...args) => {
      await register(...args);
      throw new Error("Edit registration acknowledgement lost");
    };
    else db.exec(`CREATE TRIGGER lose_edit_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND NEW.object_key='${id}' BEGIN SELECT RAISE(ABORT,'edit acknowledgement lost'); END;`);
    expect((await f.call("program_edit", input, id)).isError).toBe(true);
    f.sources.register = register;
    if (interruption === "final_ack") db.exec("DROP TRIGGER lose_edit_ack;");
    db.close();
    expect(f.store.namedSkill(f.run.run_id, "edit replay")!.version).toBe(2);
    await f.write("edit replay", source, { based_on: 2 });
    const replay = await f.call("program_edit", input, id);
    expect(replay.isError).not.toBe(true);
    expect(data(replay)).toMatchObject({ name: "edit replay", version: 2, experiment: null });
    expect(data(await f.call("program_edit", { ...input,
      edits: [{ old_text: '"Neutral result"', new_text: '"Edited result"' }] }, id)).error.code).toBe("conflict");
    expect(data(await f.call("program_edit", input, id))).toEqual(data(replay));
    expect(f.store.skills(f.run.run_id)).toHaveLength(3);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "program.edited")).toHaveLength(1);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  });
}

for (const boundary of ["abort", "generation", "role", "newer_parent"] as const) {
  test(`program_edit rechecks ${boundary} after asynchronous validation before publication`, async () => {
    const f = fixture(), controller = new AbortController();
    await f.write("guarded edit");
    const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const register = f.store.registerSkill.bind(f.store);
    f.store.registerSkill = async (...args) => {
      ready.resolve();
      await release.promise;
      return register(...args);
    };
    const pending = f.tools().find(tool => tool.name === "program_edit")!.execute(`guarded-edit-${boundary}`, {
      name: "guarded edit", based_on: 1, edits: [{ old_text: "Neutral result", new_text: "Candidate result" }],
    }, controller.signal);
    await ready.promise;
    f.store.registerSkill = register;
    if (boundary === "abort") controller.abort();
    else if (boundary === "generation") f.fence();
    else if (boundary === "role") f.toolHost.toolRole = () => "authoring";
    else await f.write("guarded edit", source, { based_on: 1 });
    release.resolve();
    expect(data(await pending).error.code).toBe(boundary === "newer_parent" ? "conflict" : "stale_context");
    expect(f.store.namedSkill(f.run.run_id, "guarded edit")!.version).toBe(boundary === "newer_parent" ? 2 : 1);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "program.edited")).toHaveLength(0);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  });
}

test("program_edit cannot publish a revision without its atomic registration receipt", async () => {
  const f = fixture();
  await f.write("atomic edit");
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.exec("CREATE TRIGGER lose_edit_registration BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND json_extract(NEW.payload,'$.skill_id') IS NOT NULL BEGIN SELECT RAISE(ABORT,'edit registration unavailable'); END;");
  const input = { name: "atomic edit", based_on: 1, edits: [{ old_text: "Neutral result", new_text: "Edited result" }] };
  const failed = await f.call("program_edit", input, "atomic-edit");
  expect(failed.isError).toBe(true);
  expect(f.store.namedSkill(f.run.run_id, "atomic edit")!.version).toBe(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "skill.authored")).toHaveLength(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "program.edited")).toHaveLength(0);
  db.exec("DROP TRIGGER lose_edit_registration;");
  db.close();
  expect(data(await f.call("program_edit", input, "atomic-edit"))).toMatchObject({ name: "atomic edit", version: 2 });
  expect(f.store.skills(f.run.run_id)).toHaveLength(2);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("program_write durably pins local library aliases even when registration is interrupted before publication", async () => {
  const f = fixture();
  expect((await f.write("pure helper", "export const value = 1;", { entry: "library" })).isError).not.toBe(true);
  const library = f.store.namedSkill(f.run.run_id, "pure helper", 1)!;
  const input = { entry: "analyze", name: "pure consumer",
    source: 'import {value} from "./helper.js"; export function analyze(input) { return value; }',
    dependencies: [{ name: "pure helper", import_path: "./helper.js" }] };
  const register = f.sources.register.bind(f.sources);
  f.sources.register = async () => { throw new Error("Interrupted after exact dependency binding"); };
  expect((await f.call("program_write", input, "module-binding-replay")).isError).toBe(true);
  f.sources.register = register;
  expect((await f.write("pure helper", "export const value = 2;", { entry: "library", based_on: 1 })).isError).not.toBe(true);
  expect(data(await f.call("program_write", input, "module-binding-replay"))).toMatchObject({
    name: "pure consumer", version: 1, dependencies: [{ name: "pure helper", version: 1, import_path: "./helper.js" }],
  });
  const root = f.store.namedSkill(f.run.run_id, "pure consumer", 1)!;
  expect(root.dependencies).toEqual([{ skill_id: library.skill_id, version: 1, import_path: "./helper.js" }]);
  expect(root.validation.runtime_features).toEqual(["pure_modules_v1"]);
  expect(data(await f.call("program_write", input, "module-binding-replay"))).toMatchObject({ name: "pure consumer", version: 1 });
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("ambiguous aliases and playing library substitutions cannot publish a pure consumer", async () => {
  const f = fixture();
  await f.write("first library", "export const value = 1;", { entry: "library" });
  await f.write("second library", "export const value = 2;", { entry: "library" });
  await f.write("semantic child");
  const source = 'import {value} from "./helper.js"; export function analyze(input) { return value; }';
  expect((await f.write("ambiguous aliases", source, { entry: "analyze", dependencies: [
    { name: "first library", version: 1, import_path: "./helper.js" },
    { name: "second library", version: 1, import_path: "./helper.js" },
  ] })).isError).toBe(true);
  expect((await f.write("playing substitution", source, { entry: "analyze", dependencies: [
    { name: "semantic child", version: 1, import_path: "./helper.js" },
  ] })).isError).toBe(true);
  expect(f.store.namedSkill(f.run.run_id, "ambiguous aliases")).toBeNull();
  expect(f.store.namedSkill(f.run.run_id, "playing substitution")).toBeNull();
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("program_submit never retries an ambiguous start without a durable execution receipt", async () => {
  const f = fixture();
  let attempts = 0;
  f.manager.start = () => { attempts++; throw new Error("Admission acknowledgement unavailable"); };
  const input = { name: "ambiguous", source, args: null };
  const first = data(await f.call("program_submit", input, "ambiguous-submit"));
  expect(first).toMatchObject({ source: { status: "persisted", version: 1 }, start: { status: "unknown", error: { retryable: false } } });
  expect(data(await f.call("program_submit", input, "ambiguous-submit"))).toEqual(first);
  expect(attempts).toBe(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
});

test("program_submit duplicate during validation cannot create a second version or execution", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const originalRegister = f.sources.register.bind(f.sources);
  f.sources.register = async (...args) => {
    entered.resolve();
    await release.promise;
    return await originalRegister(...args);
  };
  const input = { name: "concurrent validation", source, args: null };
  const first = f.call("program_submit", input, "concurrent-before-persist");
  await entered.promise;
  expect(data(await f.call("program_submit", input, "concurrent-before-persist")).error.code).toBe("conflict");
  release.resolve();
  expect(data(await first).start.status).toBe("started");
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skills(f.run.run_id)).toHaveLength(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
});

test("program_submit duplicate after persistence fences the still-pending original start attempt", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const originalRegister = f.sources.register.bind(f.sources);
  f.sources.register = async (...args) => {
    const program = await originalRegister(...args);
    entered.resolve();
    await release.promise;
    return program;
  };
  const input = { name: "concurrent persisted", source, args: null };
  const first = f.call("program_submit", input, "concurrent-after-persist");
  await entered.promise;
  const replay = data(await f.call("program_submit", input, "concurrent-after-persist"));
  expect(replay).toMatchObject({ source: { status: "persisted", version: 1 }, start: { status: "unknown", error: { retryable: false } } });
  release.resolve();
  expect(data(await first)).toEqual(replay);
  expect(f.store.skills(f.run.run_id)).toHaveLength(1);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("program_submit rolls back version creation if its exact registration identity cannot persist", async () => {
  const f = fixture();
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.exec("CREATE TRIGGER lose_registration BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND json_extract(NEW.payload,'$.skill_id') IS NOT NULL BEGIN SELECT RAISE(ABORT,'registration receipt unavailable'); END;");
  const reply = await f.call("program_submit", { name: "atomic source", source, args: null });
  expect(reply.isError).toBe(true);
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  db.close();
});

test("ordinary selected-entry rejections expose source-format facts without source or execution admission", async () => {
  const f = fixture();
  const executive = "export function step(frame,state,intent) { return 'PRIVATE_SOURCE_VALUE'; } export function activate(frame,state,intent) { return null; }";
  const cases = [
    { entry: "run", source: executive, contract: {
      selected_entry: "run", source_format: "async_body", required_exports: [], optional_exports: [],
      parameter_count: null, detected_exports: ["step", "activate"], omitted_exports: 0,
      detected_signatures: ["step", "activate"].map(name => ({ name, parameter_count: 3, plain_parameters: true, async: false, generator: false })),
    } },
    { entry: "step", source: "export async function step(frame,state,intent) { return null; }", contract: {
      selected_entry: "step", source_format: "module", required_exports: ["step"], optional_exports: ["activate"],
      parameter_count: 3, detected_exports: ["step"], omitted_exports: 0,
      detected_signatures: [{ name: "step", parameter_count: 3, plain_parameters: true, async: true, generator: false }],
    } },
    { entry: "analyze", source: "export function analyze(input,extra) { return null; }", contract: {
      selected_entry: "analyze", source_format: "module", required_exports: ["analyze"], optional_exports: [],
      parameter_count: 1, detected_exports: ["analyze"], omitted_exports: 0,
      detected_signatures: [{ name: "analyze", parameter_count: 2, plain_parameters: true, async: false, generator: false }],
    } },
  ];
  for (const entry of cases) {
    const reply = await f.write(`wrong ${entry.entry}`, entry.source, { entry: entry.entry });
    expect(reply.isError).toBe(true);
    expect(data(reply).error).toMatchObject({ code: "invalid_program",
      issues: expect.arrayContaining([expect.objectContaining({ entry_contract: entry.contract })]) });
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_SOURCE_VALUE");
  }
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("tool rejections preserve bounded trusted issues without exposing arbitrary host error fields", async () => {
  const f = fixture();
  const issues = [{ code: "invalid_syntax", message: "Invalid body", location: { line: 3, column: 7 }, limit: null,
    host_secret: "PRIVATE_HOST_FIELD" }];
  f.toolHost.observe = async () => { throw Object.assign(new RuntimeFault("invalid_program", "Invalid body"), {
    issues, stack_detail: "PRIVATE_HOST_STACK",
  }); };
  expect(data(await f.call("observe", {})).error).toMatchObject({
    code: "invalid_program", issues: [{ code: "invalid_syntax", location: { line: 3, column: 7 }, limit: null }],
  });
  f.toolHost.observe = async () => { throw Object.assign(new Error("PRIVATE_HOST_MESSAGE"), {
    issues, stage_correction: { error: "PRIVATE_HOST_CORRECTION" },
  }); };
  const rejected = await f.call("observe", {});
  expect(rejected.isError).toBe(true);
  expect(data(rejected).error).toEqual({
    code: "backend_unavailable", message: "The requested operation could not complete safely", retryable: false,
  });
  f.toolHost.observe = async () => { throw new z.ZodError([{ code: "custom", path: ["PRIVATE_HOST_PATH"], message: "PRIVATE_HOST_ZOD" }]); };
  expect(data(await f.call("observe", {})).error).toEqual({
    code: "backend_unavailable", message: "The requested operation could not complete safely", retryable: false,
  });
  f.toolHost.observe = async () => { throw null; };
  expect(data(await f.call("observe", {})).error.code).toBe("backend_unavailable");
  expect(JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 500))).not.toContain("PRIVATE_HOST");
});

test("both ordinary validation fault paths preserve bounded entry facts and strip nested arbitrary metadata", async () => {
  const f = fixture();
  const names = Array.from({ length: 12 }, (_, index) => `exported${index}${"x".repeat(90)}`);
  let validation: ProgramValidationError | null = null;
  try {
    await validateProgramSource(names.map(name => `export function ${name}() { return 'PRIVATE_SOURCE_VALUE'; }`).join("\n"), "step", minecraftTestAdapter());
  } catch (error) {
    if (!(error instanceof ProgramValidationError)) throw error;
    validation = error;
  }
  if (!validation) throw new Error("Expected invalid selected-entry source");
  const contract = validation.issues[0]!.entry_contract!;
  expect(contract.detected_exports).toHaveLength(8);
  expect(contract.detected_exports.every(name => name.length === 80)).toBe(true);
  expect(contract.omitted_exports).toBe(4);
  const issues = validation.issues.map(issue => ({ ...issue, host_secret: "PRIVATE_HOST_FIELD",
    entry_contract: { ...issue.entry_contract!, host_secret: "PRIVATE_HOST_CONTRACT",
      detected_signatures: issue.entry_contract!.detected_signatures!.map(signature => ({
        ...signature, host_secret: "PRIVATE_HOST_SIGNATURE",
      })) } }));
  for (const error of [
    new ProgramValidationError(issues),
    Object.assign(new RuntimeFault("invalid_program", "Program failed validation"), { issues }),
  ]) {
    f.toolHost.observe = async () => { throw error; };
    const reply = await f.call("observe", {});
    expect(reply.isError).toBe(true);
    expect(data(reply).error.issues).toEqual(validation.issues);
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_");
  }
  expect(JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 500))).not.toContain("PRIVATE_");
  expect(f.store.skills(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
});

test("actual history inspection preserves named-domain fault codes at the model boundary", async () => {
  const f = fixture();
  const missing = { name: "not retained" };
  const cases = [
    { input: { view: "source", ...missing }, code: "not_found" },
    { input: { view: "history", program: missing }, code: "not_found" },
    { input: { view: "trace", program: missing }, code: "not_found" },
    { input: { view: "feedback", program: missing }, code: "not_found" },
    { input: { view: "comparison", before: missing, after: missing }, code: "not_found" },
    { input: { view: "trace" }, code: "not_found" },
    { input: { view: "trace", after: 1 }, code: "invalid_request" },
  ];
  for (const { input, code } of cases) {
    const reply = await f.call("program_inspect", input);
    expect(reply.isError).toBe(true);
    expect(data(reply)).toMatchObject({ error: { code, retryable: false } });
    if (input.view !== "source") {
      const snapshot = f.history.snapshot(), child = snapshot.child!;
      expect(snapshot).toMatchObject({ active: false, queued: 0 });
      expect(child.exitObservedHostMs).toBeNumber();
      expect(child.stdoutDrainObservedHostMs).toBeNumber();
      expect(child.closedHostMs).toBeNumber();
      expect(child.closedHostMs!).toBeGreaterThanOrEqual(child.exitObservedHostMs!);
      expect(child.closedHostMs!).toBeGreaterThanOrEqual(child.stdoutDrainObservedHostMs!);
    }
  }
  const rejected = f.store.eventsAfter(f.run.run_id, 0, 100).filter(event => event.type === "model.tool_rejected");
  expect(rejected.map(event => (event.details as { error: { code: string } }).error.code)).toEqual(cases.map(entry => entry.code));
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "model.tool_result")).toBe(false);
});

test("an active domain fault does not attribute its result to undispatched queued model inspection", async () => {
  const f = fixture();
  const missing = f.call("program_inspect", { view: "history", program: { name: "not retained" } });
  const queued = f.call("program_inspect", { view: "events" });
  expect(f.history.snapshot()).toMatchObject({ active: true, queued: 1 });
  const [missingReply, queuedReply] = await Promise.all([missing, queued]);
  expect(missingReply.isError).toBe(true);
  expect(data(missingReply).error).toEqual({ code: "not_found", message: "Named program version not found", retryable: false });
  expect(queuedReply.isError).toBe(true);
  expect(data(queuedReply).error).toEqual({
    code: "backend_unavailable", message: "The requested operation could not complete safely", retryable: false,
  });
  const child = f.history.snapshot().child!;
  expect(child.exitObservedHostMs).toBeNumber();
  expect(child.stdoutDrainObservedHostMs).toBeNumber();
  expect(child.closedHostMs).toBeNumber();
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "model.tool_result")).toBe(false);
});

test("actual oversized history workload retains its domain budget fault after the owned worker drains", async () => {
  const f = fixture();
  // Store-only metadata deliberately bypasses authoring limits to reproduce a
  // retained oversized workload, not a sandbox execution or a fake IPC reply.
  await f.store.registerSkill(f.run.run_id, historySpec(f.run, "oversized retained source", `/*${"x".repeat(70000)}*/ return null;`));
  f.store.event(f.run.run_id, "fixture.record", "Actual retained history record");
  const failure = await f.history.query({ kind: "benchmark_history", run_id: f.run.run_id, minimum_records: 1 },
    { deadlineHostMs: performance.now() + 10_000 }).then(() => null, error => error);
  expect(failure).toBeInstanceOf(RuntimeFault);
  expect(failure).not.toBeInstanceOf(HistoryReaderError);
  expect(failure).toMatchObject({ code: "budget_exceeded", message: "History result cannot fit the complete response frame byte budget" });
  const child = f.history.snapshot().child!;
  expect(child.exitObservedHostMs).toBeNumber();
  expect(child.stdoutDrainObservedHostMs).toBeNumber();
  expect(child.closedHostMs).toBeNumber();
  expect(child.closedHostMs!).toBeGreaterThanOrEqual(child.exitObservedHostMs!);
  expect(child.closedHostMs!).toBeGreaterThanOrEqual(child.stdoutDrainObservedHostMs!);
});

test("actual worker artifact and readonly-schema faults stay infrastructure failures without private paths", async () => {
  const artifact = fixture();
  await artifact.write("private artifact");
  const program = artifact.store.namedSkill(artifact.run.run_id, "private artifact")!;
  rmSync(join(artifact.store.readLocation().artifacts, `${program.hash}.js`));
  const artifactFailure = await artifact.history.query({ kind: "model_inspect", run_id: artifact.run.run_id,
    input: { view: "history", program: { name: "private artifact" }, after: 0, limit: 25 } },
    { deadlineHostMs: performance.now() + 10_000 }).then(() => null, error => error);
  expect(artifactFailure).toBeInstanceOf(HistoryReaderError);
  expect(artifactFailure).not.toBeInstanceOf(RuntimeFault);
  expect(artifactFailure).toMatchObject({ code: "ENOENT", message: "History worker query failed" });
  expect(String(artifactFailure)).not.toContain(artifact.directory);
  const schema = fixture();
  const db = new Database(schema.store.readLocation().database);
  try { db.exec("PRAGMA user_version=0"); } finally { db.close(); }
  for (const [f, input] of [
    [artifact, { view: "history", program: { name: "private artifact" } }],
    [schema, { view: "events" }],
  ] as const) {
    const reply = await f.call("program_inspect", input);
    expect(reply.isError).toBe(true);
    expect(data(reply).error).toEqual({
      code: "backend_unavailable", message: "The requested operation could not complete safely", retryable: false,
    });
    expect(JSON.stringify(reply)).not.toContain(f.directory);
    expect(JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 100))).not.toContain(f.directory);
    expect(f.history.snapshot().child!.exitObservedHostMs).toBeNumber();
    expect(f.history.snapshot().child!.stdoutDrainObservedHostMs).toBeNumber();
    expect(f.history.snapshot().child!.closedHostMs).toBeNumber();
  }
});

test("latest validated selection pins once and never follows newer catalog revisions", async () => {
  const f = fixture();
  await f.write("reader"); await f.write("reader", source, { based_on: 1 });
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.query("UPDATE skills SET metadata=json_set(metadata,'$.state','quarantined') WHERE run_id=? AND name='reader' AND version=2").run(f.run.run_id);
  const started = data(await f.call("program_run", { operation: "start", name: "reader", args: "selected-once" }));
  expect(started.version).toBe(1);
  const admitted = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, admitted.execution_id);
  await f.write("reader", source, { based_on: 2 });
  const outcome = data(await f.call("program_inspect", { view: "execution", program: { name: "reader" }, target: "latest" }));
  expect(outcome).toMatchObject({ name: "reader", version: 1, result: { result: "selected-once" } });
  const denied = await f.call("program_run", { operation: "start", name: "reader", version: 2, args: null });
  expect(denied.isError).toBe(true);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  db.close();
});

test("source game.call resolves only parent-pinned named children after newer child writes", async () => {
  const f = fixture();
  await f.write("child", 'return {status:"completed",summary:"Pinned child",result:1};');
  await f.write("parent", 'return await game.call({name:"child"},args);', { dependencies: [{ name: "child" }] });
  await f.write("child", 'return {status:"completed",summary:"New child",result:2};', { based_on: 1 });
  await f.call("program_run", { operation: "start", name: "parent", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.result).toMatchObject({ result: 1 });
  expect(f.store.allSkillExecutions(f.run.run_id).filter((execution) => execution.parent_execution_id === root.execution_id).map((execution) => execution.version)).toEqual([1]);
  await f.write("mismatch", 'return await game.call({name:"child",version:2},args);', { dependencies: [{ name: "child", version: 1 }] });
  await f.call("program_run", { operation: "start", name: "mismatch", args: null });
  const invalid = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, invalid.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: invalid.execution_id })!.status).toBe("failed");
  expect(f.store.allSkillExecutions(f.run.run_id).filter((execution) => execution.parent_execution_id === invalid.execution_id)).toHaveLength(0);
});

test("lost acknowledgement retries compound trusted call identity with original scope and version", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => { entered.resolve(); await Promise.race([release.promise, aborted(signal)]); return { status: "completed", summary: "Released", result: null }; });
  await f.write("durable");
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.exec("CREATE TRIGGER lose_tool_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END;");
  const id = "call_abcdef0123456789|fc_123456789abcdef0";
  const input = { operation: "start", name: "durable", args: { original: true } };
  expect((await f.call("program_run", input, id)).isError).toBe(true);
  await entered.promise;
  const original = f.store.latestRootExecution(f.run.run_id)!;
  db.exec("DROP TRIGGER lose_tool_ack;");
  f.run.epoch = 2; f.run.life_id = 2; f.store.saveRun(f.run);
  await f.write("durable", source, { based_on: 1 });
  expect(data(await f.call("program_run", input, id)).version).toBe(1);
  expect(f.dispatches()).toBe(1);
  expect(f.store.latestRootExecution(f.run.run_id)).toMatchObject({ execution_id: original.execution_id, epoch: 1, life_id: 1, version: 1 });
  expect(data(await f.call("program_run", { ...input, args: { changed: true } }, id)).error.code).toBe("conflict");
  expect(data(await f.call("program_run", input, `${id}-before-drain`)).error.code).toBe("busy");
  f.fence();
  await f.manager.closeAll("Old-scope owner drained before a fresh decision");
  await f.call("program_run", input, `${id}0`);
  expect(f.store.latestRootExecution(f.run.run_id)).toMatchObject({ epoch: 2, life_id: 2, version: 2 });
  expect(new Set(f.store.allSkillExecutions(f.run.run_id).map((execution) => execution.start_key)).size).toBe(2);
  f.fence(); release.resolve(); await f.manager.closeAll("Fenced after lost acknowledgement"); db.close();
});

test("actual catalogs and dispatch share ordinary, speculative, advanced-module and review permissions", async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await Promise.race([release.promise, aborted(signal)]);
    return { status: "completed", summary: "Neutral predecessor drained", result: null };
  });
  const ordinary = f.tools();
  expect(ordinary.some((tool) => tool.name === "program_run")).toBe(true);
  expect(ordinary.some((tool) => tool.name === "program_submit")).toBe(true);
  expect(ordinary.some((tool) => tool.name === "task_finish")).toBe(true);
  expect(ordinary.some((tool) => tool.name === "prepare_next" || tool.name === "memory")).toBe(false);
  await f.write("predecessor"); await f.write("candidate");
  await f.call("program_run", { operation: "start", name: "predecessor", args: null, next: { after_ms: 0, reason: "Bounded neutral flight", budget: { calls: 1, tools: 8, duration_ms: 30000 } } });
  const plan = f.planning.begin()!;
  expect(plan).not.toBeNull();
  const speculative = f.tools();
  expect(speculative.some((tool) => tool.name === "prepare_next")).toBe(true);
  expect(speculative.some((tool) => tool.name === "program_run" || tool.name === "program_submit" || tool.name === "task_finish")).toBe(false);
  const saved = await f.call("program_write", { entry: "run", name: "prepared during execution", source, card, dependencies: [] }, "inactive-spec-write", ordinary);
  expect(saved.isError).not.toBe(true);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  const assessment = await f.call("program_write", { entry: "run", name: "candidate", based_on: 1, source,
    reason: "Speculation cannot resolve an outcome" }, "forbidden-spec-assessment", ordinary);
  expect(data(assessment).error.code).toBe("forbidden");
  expect(f.store.namedSkill(f.run.run_id, "candidate")!.version).toBe(1);
  expect(data(await f.call("program_submit", { name: "forbidden submit", source, args: null }, "forbidden-spec-submit", ordinary)).error.code).toBe("forbidden");
  expect(data(await f.call("task_finish", { all_requested_work_complete: true, summary: "Not authorized during speculation" }, "forbidden-spec-finish", ordinary)).error.code).toBe("forbidden");
  expect(data(await f.call("prepare_next", { name: "prepared during execution", args: null })).guard_status).toBe("omitted");
  expect(f.planning.projection()?.candidate?.skill_id).toBe(f.store.namedSkill(f.run.run_id, "prepared during execution")!.skill_id);
  f.planning.finish(plan.plan_id); release.resolve();
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  f.run.status = "reviewing";
  expect(f.tools().some((tool) => tool.name === "program_review")).toBe(true);
  expect(f.tools().some((tool) => tool.name === "program_run" || tool.name === "program_submit" || tool.name === "prepare_next" || tool.name === "task_finish")).toBe(false);
  expect((await f.call("program_run", { operation: "start", name: "candidate", args: null }, "forbidden-review-run", ordinary)).isError).toBe(true);
  expect(data(await f.call("program_submit", { name: "forbidden submit", source, args: null }, "forbidden-review-submit", ordinary)).error.code).toBe("forbidden");
  expect(data(await f.call("task_finish", { all_requested_work_complete: true, summary: "Not authorized during review" }, "forbidden-review-finish", ordinary)).error.code).toBe("forbidden");
  await f.call("help", { topic: "memory" });
  expect(f.tools().some((tool) => tool.name === "memory")).toBe(false);
  expect(f.actions()).toBe(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

test("installed Agent cannot use captured playing tools during authoring and saves exact inactive revisions", async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await Promise.race([release.promise, aborted(signal)]);
    return { status: "completed", summary: "Original foreground settled", result: null };
  });
  await f.write("foreground");
  const original = f.store.namedSkill(f.run.run_id, "foreground")!;
  await f.call("help", { topic: "reflex" });
  await f.call("help", { topic: "memory" });
  const ordinary = f.tools();
  f.toolHost.toolRole = () => "speculative";
  const prepared = f.tools().find(tool => tool.name === "prepare_next")!;
  delete f.toolHost.toolRole;
  const started = await agentCalls(ordinary, [
    { type: "toolCall", id: "authoring-root", name: "program_run", arguments: { operation: "start", name: "foreground", version: 1, args: { original: true } } },
  ]);
  expect(started[0]!.isError).not.toBe(true);
  const root = f.store.latestRootExecution(f.run.run_id)!;
  f.toolHost.toolRole = () => "authoring";
  expect(f.tools().map(tool => tool.name).sort()).toEqual(["help", "observe", "program_edit", "program_inspect", "program_write"]);
  expect(f.tools().find(tool => tool.name === "program_write")!.parameters).not.toHaveProperty("properties.reason");
  expect(f.tools().find(tool => tool.name === "program_write")!.parameters).toHaveProperty("properties.based_on");
  expect(f.tools().find(tool => tool.name === "program_edit")!.parameters).not.toHaveProperty("properties.reason");
  const forbidden: ToolCall[] = [
    ...["start", "stop", "update_intent", "analyze", "activate_next", "attention"].map((operation, index) => ({
      type: "toolCall" as const, id: `blocked-control-${index}`, name: "program_run", arguments: { operation, name: "foreground", args: null },
    })),
    { type: "toolCall", id: "blocked-submit", name: "program_submit", arguments: { name: "unexpected playing source", source, args: null } },
    { type: "toolCall", id: "blocked-finish", name: "task_finish", arguments: { all_requested_work_complete: true, summary: "Unauthorized completion" } },
    { type: "toolCall", id: "blocked-reflex", name: "reflex", arguments: { operation: "activate", name: "unexpected" } },
    { type: "toolCall", id: "blocked-memory", name: "memory", arguments: { operation: "load", name: "unexpected" } },
    { type: "toolCall", id: "blocked-review", name: "program_review", arguments: { name: "foreground", decision: "keep", reason: "Unauthorized assessment" } },
    { type: "toolCall", id: "blocked-prepare", name: "prepare_next", arguments: { name: "foreground", args: null } },
    { type: "toolCall", id: "blocked-experiment", name: "program_write", arguments: { entry: "run", name: "foreground", based_on: 1, source, reason: "Unauthorized outcome linkage" } },
    { type: "toolCall", id: "blocked-edit-experiment", name: "program_edit", arguments: {
      name: "foreground", based_on: 1, edits: [{ old_text: "Neutral result", new_text: "Changed" }], reason: "Unauthorized outcome linkage",
    } },
  ];
  const rejected = await agentCalls([...ordinary, prepared], forbidden);
  expect(rejected).toHaveLength(forbidden.length);
  for (const reply of rejected) {
    expect(reply.isError).toBe(true);
    expect(data(reply).error.code).toBe("forbidden");
  }
  const revised = 'return {status:"completed",summary:"Inactive candidate",result:2};';
  const drafts = await agentCalls(f.tools(), [
    { type: "toolCall", id: "inactive-revision", name: "program_write", arguments: { entry: "run", name: "foreground", based_on: 1, source: revised, card: { ...card, reason: "Inert candidate motivation" } } },
    { type: "toolCall", id: "inactive-helper", name: "program_write", arguments: { entry: "run", name: "future helper", source } },
    { type: "toolCall", id: "read-original", name: "program_inspect", arguments: { view: "source", name: "foreground", version: 1 } },
    { type: "toolCall", id: "authoring-observe", name: "observe", arguments: {} },
  ]);
  expect(drafts.every(reply => !reply.isError)).toBe(true);
  expect(data(drafts[0]!)).toMatchObject({ name: "foreground", version: 2, state: "validated", experiment: null });
  expect(data(drafts[1]!)).toMatchObject({ name: "future helper", version: 1, state: "validated", experiment: null });
  expect(data(drafts[2]!).source).toBe(original.source);
  expect(f.store.namedSkill(f.run.run_id, "foreground", 1)).toEqual(original);
  expect(f.store.namedSkill(f.run.run_id, "foreground", 2)).toMatchObject({ parent_version: 1, state: "validated" });
  expect(f.store.namedSkill(f.run.run_id, "foreground", 2)!.source).toContain("Inactive candidate");
  expect(f.store.namedSkill(f.run.run_id, "foreground", 2)!.card.reason).toBe("Inert candidate motivation");
  expect(f.store.namedSkill(f.run.run_id, "foreground", 2)!.hash).not.toBe(original.hash);
  expect(f.store.latestRootExecution(f.run.run_id)).toEqual(root);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
  expect(f.actions()).toBe(0);
  expect(f.run.status).toBe("running");
  expect(f.store.policies(f.run.run_id)).toEqual([]);
  expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual([]);
  const edited = await agentCalls(f.tools(), [{
    type: "toolCall", id: "inactive-exact-edit", name: "program_edit", arguments: {
      name: "foreground", based_on: 2, edits: [{ old_text: "Inactive candidate", new_text: "Edited inactive candidate" }],
    },
  }]);
  expect(data(edited[0]!)).toMatchObject({ name: "foreground", version: 3, experiment: null });
  expect(f.store.latestRootExecution(f.run.run_id)).toEqual(root);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
  expect(f.dispatches()).toBe(1);
  f.run.status = "reviewing";
  expect(f.tools().some(tool => tool.name === "program_review")).toBe(true);
  expect(f.tools().find(tool => tool.name === "program_write")!.parameters).toHaveProperty("properties.reason");
  const review = await agentCalls(f.tools(), [
    { type: "toolCall", id: "review-precedence", name: "program_write", arguments: { entry: "run", name: "foreground", based_on: 3, source, reason: "Use review rather than authoring authority" } },
  ]);
  expect(data(review[0]!).error.code).toBe("precondition_failed");
  release.resolve();
  await waitClosed(f.store, f.run.run_id, root.execution_id);
});

test("reading reaction contracts during authoring grants no playing authority", async () => {
  const f = fixture();
  const ordinary = f.tools();
  f.toolHost.toolRole = () => "authoring";
  const replies = await agentCalls(f.tools(), [
    { type: "toolCall", id: "authoring-reflex-help", name: "help", arguments: { topic: "reflex" } },
    { type: "toolCall", id: "authoring-memory-help", name: "help", arguments: { topic: "memory" } },
    { type: "toolCall", id: "authoring-program-help", name: "help", arguments: { topic: "programs" } },
  ]);
  expect(replies[0]!.isError).not.toBe(true);
  expect(data(replies[1]!).error.code).toBe("forbidden");
  expect(replies[2]!.isError).not.toBe(true);
  const activation = await agentCalls(ordinary, [
    { type: "toolCall", id: "authoring-reflex-activation", name: "reflex", arguments: { operation: "activate", name: "unwritten" } },
  ]);
  expect(data(activation[0]!).error.code).toBe("forbidden");
  delete f.toolHost.toolRole;
  expect(f.tools().some(tool => tool.name === "memory")).toBe(false);
  expect(f.store.policies(f.run.run_id)).toEqual([]);
  expect(f.store.skills(f.run.run_id)).toEqual([]);
  expect(f.store.allSkillExecutions(f.run.run_id)).toEqual([]);
});

for (const boundary of ["root_settlement", "stop", "role_change"] as const) {
  test(`installed Agent cannot publish an async authoring draft after ${boundary}`, async () => {
    const releaseRoot = Promise.withResolvers<void>();
    const f = fixture(async (_source, _args, _handle, _limits, signal) => {
      await Promise.race([releaseRoot.promise, aborted(signal)]);
      return { status: "completed", summary: "Foreground settled", result: null };
    });
    await f.write("original owner");
    await f.call("program_run", { operation: "start", name: "original owner", args: null });
    const root = f.store.latestRootExecution(f.run.run_id)!;
    f.toolHost.toolRole = () => "authoring";
    const ordinaryAuthority = f.toolHost.toolAuthority.bind(f.toolHost);
    f.toolHost.toolAuthority = () => {
      const current = ordinaryAuthority();
      // The planner supplies this captured authority in Runtime. Keep the
      // role unchanged on settlement to exercise the async commit boundary.
      return () => {
        current();
        const latest = f.store.latestRootExecution(f.run.run_id);
        if (latest?.execution_id !== root.execution_id || !["accepted", "running"].includes(latest.status))
          throw new RuntimeFault("stale_context", "Captured foreground authoring authority expired");
      };
    };
    const validationReady = Promise.withResolvers<void>(), releasePublication = Promise.withResolvers<void>();
    const register = f.store.registerSkill.bind(f.store);
    f.store.registerSkill = async (...args) => {
      validationReady.resolve();
      await releasePublication.promise;
      return await register(...args);
    };
    const pending = agentCalls(f.tools(), [
      { type: "toolCall", id: `late-draft-${boundary}`, name: "program_write", arguments: { entry: "run", name: "late draft", source } },
    ]);
    await validationReady.promise;
    if (boundary === "root_settlement") {
      releaseRoot.resolve();
      await waitClosed(f.store, f.run.run_id, root.execution_id);
    } else if (boundary === "stop") {
      f.run.status = "stopping";
      f.fence();
      await waitClosed(f.store, f.run.run_id, root.execution_id);
    } else {
      f.toolHost.toolRole = () => "ordinary";
    }
    releasePublication.resolve();
    const replies = await pending;
    expect(replies[0]!.isError).toBe(true);
    expect(data(replies[0]!).error.code).toBe("stale_context");
    expect(f.store.namedSkill(f.run.run_id, "late draft")).toBeNull();
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(0);
    if (boundary === "role_change") {
      expect(f.store.latestRootExecution(f.run.run_id)).toEqual(root);
      releaseRoot.resolve();
      await waitClosed(f.store, f.run.run_id, root.execution_id);
    }
  });
}

test.each(["missing", false, "true"] as const)(
  "unaffirmed task_finish preserves the live root and its next authorized effect through the SDK: %s", async affirmation => {
    const entered = Promise.withResolvers<void>(), continueWork = Promise.withResolvers<void>(), progressed = Promise.withResolvers<void>();
    const f = fixture(async (_source, _args, handle, _limits, signal) => {
      entered.resolve();
      await Promise.race([continueWork.promise, aborted(signal)]);
      if (!signal.aborted) {
        await handle({ kind: "action", action: { kind: "look", yaw: 0.1, pitch: 0 } });
        progressed.resolve();
        await aborted(signal);
      }
      return { status: "completed", summary: "Fenced fixture settled", result: null };
    });
    await f.write("pending");
    await f.call("program_run", { operation: "start", name: "pending", args: null });
    await entered.promise;
    const root = f.store.latestRootExecution(f.run.run_id)!;
    const arguments_ = { summary: "Not complete; preserve the useful local controller",
      ...(affirmation === "missing" ? {} : { all_requested_work_complete: affirmation }) };
    const replies = await agentCalls(f.tools(), [{ type: "toolCall", id: "unaffirmed-finish",
      name: "task_finish", arguments: arguments_ }]);
    if (affirmation === false) {
      expect(replies[0]!.isError).not.toBe(true);
      expect(data(replies[0]!)).toEqual({ status: "continuing", all_requested_work_complete: false });
      expect(data(await f.call("task_finish", arguments_, "unaffirmed-finish")))
        .toEqual({ status: "continuing", all_requested_work_complete: false });
      expect(data(await f.call("task_finish", { all_requested_work_complete: true, summary: arguments_.summary }, "unaffirmed-finish"))
        .error.code).toBe("conflict");
    } else {
      expect(replies[0]).toMatchObject({ isError: true });
    }
    expect(f.run.status).toBe("running");
    expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.status).toBe("running");
    expect(f.manager.effectScope(root.execution_id)).not.toBeNull();
    continueWork.resolve(); await progressed.promise;
    expect(f.actions()).toBe(1);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event => event.type === "task.completion_reported")).toBe(false);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "task.progress_reported"))
      .toHaveLength(affirmation === false ? 1 : 0);
  });

test("task_finish persists an immutable acknowledgement despite consuming its own authority", async () => {
  const entered = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    entered.resolve();
    await aborted(signal);
    return { status: "completed", summary: "Fenced worker settled", result: null };
  });
  await f.write("pending");
  const ordinary = f.tools();
  await f.call("program_run", { operation: "start", name: "pending", args: null });
  await entered.promise;
  const root = f.store.latestRootExecution(f.run.run_id)!;
  const id = "finish-once";
  const input = { all_requested_work_complete: true, summary: "  Whole task done from authorized evidence  " };
  const first = await f.call("task_finish", input, id, ordinary);
  expect(first.isError).not.toBe(true);
  expect(data(first)).toEqual({ status: "stopping", verification: "unverified" });
  expect(f.run.status).toBe("stopping");
  expect(f.store.completedToolCall(f.run.run_id, id, {
    tool: "task_finish", input: { all_requested_work_complete: true, summary: "Whole task done from authorized evidence" },
  })).toEqual({ status: "stopping", verification: "unverified" });
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.status).toBe("cancelled");
  f.run.status = "stopped";
  expect(data(await f.call("task_finish", input, id, ordinary))).toEqual({ status: "stopping", verification: "unverified" });
  expect(f.run.status).toBe("stopped");
  expect(data(await f.call("task_finish", { all_requested_work_complete: true, summary: "Changed claim" }, id, ordinary)).error.code).toBe("conflict");
  expect(data(await f.call("task_finish", input, "new-finish", ordinary)).error.code).toBe("stale_context");
  expect(data(await f.call("program_run", { operation: "start", name: "pending", args: null }, "after-finish", ordinary)).error.code).toBe("stale_context");
  expect((await f.write("after-finish")).isError).toBe(true);
  expect(f.store.skills(f.run.run_id).map((program) => program.name)).toEqual(["pending"]);
  expect(f.dispatches()).toBe(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter((event) =>
    event.type === "model.tool_result" && event.details !== null && typeof event.details === "object" &&
    !Array.isArray(event.details) && event.details.tool === "task_finish")).toHaveLength(1);
});

test("task_finish validates bounded summaries and preserves cancellation, generation and built-in authority checks", async () => {
  const f = fixture();
  const ordinary = f.tools();
  for (const input of [{ all_requested_work_complete: true }, { all_requested_work_complete: true, summary: "" },
    { all_requested_work_complete: true, summary: "   " }, { all_requested_work_complete: true, summary: "x".repeat(2001) },
    { all_requested_work_complete: true, summary: 1 }, { all_requested_work_complete: true, summary: "Done", extra: true }]) {
    expect(data(await f.call("task_finish", input)).error.code).toBe("invalid_request");
    expect(f.run.status).toBe("running");
  }
  const cancelled = new AbortController();
  cancelled.abort();
  expect(data(await ordinary.find((tool) => tool.name === "task_finish")!.execute(
    "cancelled-finish", { all_requested_work_complete: true, summary: "Not admitted" }, cancelled.signal,
  )).error.code).toBe("stale_context");
  f.run.goal = "collect_wood";
  expect(data(await f.call("task_finish", { all_requested_work_complete: true, summary: "Not trusted proof" }, "built-in-finish", ordinary)).error.code).toBe("forbidden");
  expect(f.run.status).toBe("running");
  f.run.goal = "custom";
  f.fence();
  expect(data(await f.call("task_finish", { all_requested_work_complete: true, summary: "Stale claim" }, "stale-finish", ordinary)).error.code).toBe("stale_context");
  expect(f.run.status).toBe("running");
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some((event) => event.type === "model.tool_result")).toBe(false);
});

test("effect-free review links actual revisions to exact matching feedback and inspection stays read-only", async () => {
  const f = fixture();
  await f.write("reviewed");
  await f.call("program_run", { operation: "start", name: "reviewed", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  await f.prepareFeedback();
  f.run.status = "reviewing";
  const before = JSON.stringify(f.store.evidenceObjects(f.run.run_id, "opportunity"));
  await f.call("program_inspect", { view: "feedback", program: { name: "reviewed", version: 1 } });
  expect(JSON.stringify(f.store.evidenceObjects(f.run.run_id, "opportunity"))).toBe(before);
  const written = data(await f.write("reviewed", 'return {status:"blocked",summary:"Candidate needs future measurement",result:null};', { based_on: 1, reason: "Test a changed code path; efficacy remains unproven" }));
  expect(written).toMatchObject({ name: "reviewed", version: 2, experiment: { decision: "revise", measured: false, qualification: "candidate_not_proven_improvement" } });
  const opportunities = f.store.evidenceObjects<{ resolution: { revision: { version: number }; measured: boolean } }>(f.run.run_id, "opportunity");
  expect(opportunities[0]!.resolution).toMatchObject({ revision: { version: 2 }, measured: false });
  expect(data(await f.call("program_review", { name: "reviewed", version: 2, decision: "keep", reason: "No outcome exists" })).error.code).toBe("not_found");
  expect(f.actions()).toBe(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

for (const toolName of ["program_write", "program_edit"] as const) for (const assessed of [false, true]) {
  for (const newerOutcome of [false, true]) {
    test(`${toolName} reason replay pins original feedback and does not duplicate linkage (assessed=${assessed}, newer=${newerOutcome})`, async () => {
      const f = fixture();
      const name = "feedback identity";
      await f.write(name, 'throw new Error("Controlled original sample");');
      await f.call("program_run", { operation: "start", name, version: 1, args: "outcome A" });
      const firstRoot = f.store.latestRootExecution(f.run.run_id)!;
      await waitClosed(f.store, f.run.run_id, firstRoot.execution_id);
      await f.prepareFeedback();
      const original = f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")[0]!;
      if (assessed) await f.call("program_review", { name, version: 1, decision: "keep", reason: "Retain immutable assessment A" });
      const db = new Database(join(f.directory, "runs.sqlite"));
      const id = "lost-feedback-write-ack";
      db.exec(`CREATE TRIGGER lose_feedback_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND NEW.object_key='${id}' BEGIN SELECT RAISE(ABORT,'lost feedback acknowledgement'); END;`);
      const options = { based_on: 1, reason: "A candidate specifically addressing outcome A" };
      const revise = () => toolName === "program_edit"
        ? f.call(toolName, { name, ...options, edits: [{ old_text: "Controlled original sample", new_text: "Changed candidate sample" }] }, id)
        : f.write(name, source, options, id);
      expect((await revise()).isError).toBe(true);
      const child = f.store.namedSkill(f.run.run_id, name, 2)!;
      expect(child.parent_version).toBe(1);
      db.exec("DROP TRIGGER lose_feedback_ack;");
      if (newerOutcome) {
        await f.call("program_run", { operation: "start", name, version: 1, args: "outcome B" });
        const secondRoot = f.store.latestRootExecution(f.run.run_id)!;
        await waitClosed(f.store, f.run.run_id, secondRoot.execution_id);
        await f.prepareFeedback();
        expect(secondRoot.execution_id).not.toBe(firstRoot.execution_id);
      }
      const opportunities = f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity");
      const links = f.store.eventsAfter(f.run.run_id, 0, 500)
        .filter(event => event.type === "learning.candidate_written" || event.type === "learning.resolved");
      expect(links.some(event => event.details !== null && typeof event.details === "object" && !Array.isArray(event.details) &&
        event.details.opportunity_id === original.opportunity_id)).toBe(true);
      f.learning.prepareFeedback = async () => { throw new Error("Pinned feedback retry must not prepare or reselect outcomes"); };
      const replay = await revise();
      expect(replay.isError).not.toBe(true);
      expect(data(replay)).toMatchObject({ name, version: 2, experiment: { decision: "revise", reason: options.reason } });
      expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual(opportunities);
      expect(f.store.eventsAfter(f.run.run_id, 0, 500)
        .filter(event => event.type === "learning.candidate_written" || event.type === "learning.resolved")).toEqual(links);
      expect(f.store.skills(f.run.run_id)).toHaveLength(2);
      expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(newerOutcome ? 2 : 1);
      db.close();
    });
  }
}

for (const view of ["events", "metric", "evidence"] as const) {
 for (const boundary of ["abort", "generation", "role"] as const) {
  test(`${view} inspection preserves delivery authority across a ${boundary} change after the actual readonly result`, async () => {
    const f = fixture(), controller = new AbortController();
    const callId = `history-${view}-${boundary}`;
    let input: Record<string, unknown> = { view };
    if (view !== "events") {
      const program = { name: "delivery authority", version: 1 };
      await f.write(program.name);
      await f.call("program_run", { operation: "start", ...program, args: null });
      await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
      await f.prepareFeedback();
      const feedback = data(await f.call("program_inspect", { view: "feedback", program, limit: 100 }));
      const update = feedback.metrics[0];
      expect(update).toBeDefined();
      input = { view, program, execution_ordinal: update.execution_ordinal, generation: update.generation };
    }
    const query = f.history.query.bind(f.history);
    f.history.query = async (input, options) => {
      expect(options.signal).toBe(controller.signal);
      expect(options.deadlineHostMs).toBeGreaterThan(performance.now());
      expect(options.deadlineHostMs).toBeLessThanOrEqual(performance.now() + 10_000);
      const result = await query(input, options);
      if (boundary === "abort") controller.abort();
      else if (boundary === "generation") f.fence();
      else { f.run.status = "reviewing"; }
      return result;
    };
    const tool = f.tools().find(entry => entry.name === "program_inspect")!;
    // Inspect remains admitted during review, so a role change alone is not
    // revocation; generation/cancellation still fence actual read delivery.
    const reply = await tool.execute(callId, input, controller.signal);
    if (boundary === "role") expect(reply.isError).not.toBe(true);
    else {
      expect(data(reply).error.code).toBe("stale_context");
      expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "model.tool_result" &&
        event.details !== null && typeof event.details === "object" && !Array.isArray(event.details) && event.details.tool_call_id === callId)).toBe(false);
    }
  });
 }
}

for (const name of ["program_write", "program_submit", "program_edit", "program_review"] as const) {
  for (const boundary of ["abort", "generation"] as const) {
    test(`${name} cannot bind feedback or persist a decision after ${boundary} during preparation`, async () => {
      const f = fixture(), controller = new AbortController();
      await f.write("preparation parent");
      await f.call("program_run", { operation: "start", name: "preparation parent", args: null });
      await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
      const prepare = f.learning.prepareFeedback.bind(f.learning);
      f.learning.prepareFeedback = async (runId, options) => {
        expect(options.signal).toBe(controller.signal);
        await prepare(runId, options);
        if (boundary === "abort") controller.abort();
        else f.fence();
      };
      const input = name === "program_review"
        ? { name: "preparation parent", version: 1, decision: "keep", reason: "Assess the exact original outcome" }
        : name === "program_edit"
        ? { name: "preparation parent", based_on: 1, edits: [{ old_text: "Neutral result", new_text: "Candidate result" }], reason: "A changed candidate needs fresh authority" }
        : { entry: "run", name: "preparation parent", based_on: 1, source, reason: "A changed candidate needs fresh authority", ...(name === "program_submit" ? { args: null } : {}) };
      const tool = f.tools().find(entry => entry.name === name)!;
      const reply = await tool.execute(`cancel-${name}-${boundary}`, input, controller.signal);
      expect(data(reply).error.code).toBe("stale_context");
      expect(f.store.namedSkill(f.run.run_id, "preparation parent")!.version).toBe(1);
      expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity").every(entry => entry.resolution === null)).toBe(true);
      if (name === "program_review") expect(f.store.lookupToolCallBinding(f.run.run_id, `cancel-${name}-${boundary}`,
        { tool: name, input: { name: "preparation parent", version: 1, decision: "keep", reason: "Assess the exact original outcome" } })).toEqual({ found: false });
      expect(f.dispatches()).toBe(1);
      expect(f.actions()).toBe(0);
    });
  }
}

for (const toolName of ["program_write", "program_edit"] as const) test(`${toolName} feedback preparation rechecks the original source parent before binding or registration`, async () => {
  const f = fixture();
  await f.write("racing parent");
  await f.call("program_run", { operation: "start", name: "racing parent", args: null });
  await waitClosed(f.store, f.run.run_id, f.store.latestRootExecution(f.run.run_id)!.execution_id);
  const prepare = f.learning.prepareFeedback.bind(f.learning);
  f.learning.prepareFeedback = async (runId, options) => {
    await prepare(runId, options);
    expect((await f.write("racing parent", source, { based_on: 1 })).isError).not.toBe(true);
  };
  const reply = toolName === "program_edit"
    ? await f.call(toolName, { name: "racing parent", based_on: 1, reason: "Do not rebase the original parent",
      edits: [{ old_text: "Neutral result", new_text: "Candidate result" }] }, "racing-feedback")
    : await f.write("racing parent", source, { based_on: 1, reason: "Do not rebase the original parent" }, "racing-feedback");
  expect(data(reply).error).toMatchObject({ code: "conflict", issues: [{ code: "stale_parent", latest_parent: { name: "racing parent", version: 2 } }] });
  expect(f.store.namedSkill(f.run.run_id, "racing parent")!.version).toBe(2);
  expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity").every(entry => entry.resolution === null)).toBe(true);
});

test("review lost acknowledgement retries its exact outcome without preparation after newer source and outcome", async () => {
  const f = fixture();
  await f.write("review retry");
  const execute = async () => {
    await f.call("program_run", { operation: "start", name: "review retry", version: 1, args: null });
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, execution.execution_id);
    return execution;
  };
  const original = await execute();
  const input = { name: "review retry", decision: "keep", reason: "Keep only the original exact outcome assessment" };
  const db = new Database(join(f.directory, "runs.sqlite"));
  try {
    db.exec("CREATE TRIGGER lose_review_ack BEFORE INSERT ON evidence_objects WHEN NEW.kind='tool_result' AND NEW.object_key='review-lost-ack' BEGIN SELECT RAISE(ABORT,'lost review acknowledgement'); END;");
    expect((await f.call("program_review", input, "review-lost-ack")).isError).toBe(true);
    db.exec("DROP TRIGGER lose_review_ack;");
    await execute();
    await f.write("review retry", source, { based_on: 1 });
    await f.prepareFeedback();
    const opportunities = f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity");
    expect(opportunities.find(entry => entry.execution_id === original.execution_id)!.resolution).toMatchObject({ decision: "keep" });
    expect(opportunities.filter(entry => entry.resolution === null)).toHaveLength(1);
    f.learning.prepareFeedback = async () => { throw new Error("Pinned review retry must not prepare feedback"); };
    const retried = await f.call("program_review", input, "review-lost-ack");
    expect(retried.isError).not.toBe(true);
    expect(data(retried)).toMatchObject({ name: "review retry", version: 1, decision: "keep", reason: input.reason });
    expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual(opportunities);
    expect(data(await f.call("program_review", { ...input, reason: "Changed retry identity" }, "review-lost-ack")).error.code).toBe("conflict");
  } finally { db.close(); }
});

test("reasoned revision finds its exact outcome beyond 256 prepared opportunities", async () => {
  const f = fixture();
  await f.write("many outcomes");
  await f.write("exact late parent");
  const execute = async (name: string) => {
    expect((await f.call("program_run", { operation: "start", name, version: 1, args: null })).isError).not.toBe(true);
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, execution.execution_id);
    return execution;
  };
  for (let index = 0; index < 256; index++) await execute("many outcomes");
  const exact = await execute("exact late parent");
  const written = await f.write("exact late parent", source, { based_on: 1, reason: "Change this exact parent, not a presentation-capped outcome" });
  expect(written.isError).not.toBe(true);
  expect(data(written)).toMatchObject({ name: "exact late parent", version: 2, experiment: { decision: "revise" } });
  expect(f.store.opportunityCount(f.run.run_id)).toBe(257);
  const parent = f.store.namedSkill(f.run.run_id, "exact late parent", 1)!;
  expect(f.store.latestOpportunityForVersion({ run_id: f.run.run_id, skill_id: parent.skill_id, version: parent.version, hash: parent.hash }))
    .toMatchObject({ execution_id: exact.execution_id, resolution: { revision: { version: 2 } } });
  expect(f.actions()).toBe(0);
}, 30_000);

for (const decision of ["insufficient_evidence", "keep"] as const) {
  test(`a failed outcome assessed ${decision} still permits an immutable direct-child repair with stable retries`, async () => {
    const f = fixture();
    const name = "assessed repair";
    await f.write(name);
    const failedSource = 'throw new Error("Controlled neutral execution failure");';
    expect(data(await f.write(name, failedSource, { based_on: 1 }))).toMatchObject({ name, version: 2 });
    const parent = f.store.namedSkill(f.run.run_id, name, 2)!;
    expect((await f.call("program_run", { operation: "start", name, version: 2, args: null })).isError).not.toBe(true);
    const root = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, root.execution_id);
    expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.status).toBe("failed");

    const reviewInput = { name, version: 2, decision, reason: "This failed sample does not establish a better procedure" };
    const reviewed = await f.call("program_review", reviewInput, "assess-parent");
    expect(reviewed.isError).not.toBe(true);
    expect(data(reviewed)).toMatchObject({ name, version: 2, decision });
    const opportunities = f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity");
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      execution_id: root.execution_id,
      version: { skill_id: parent.skill_id, version: 2, hash: parent.hash },
      resolution: { decision, reason: reviewInput.reason, revision: null, measured: false },
    });
    const assessmentHistory = f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "learning.resolved");
    expect(assessmentHistory).toHaveLength(1);

    const repairSource = 'return {status:"completed",summary:"Changed neutral procedure awaits measurement",result:null};';
    const repairOptions = { based_on: 2, reason: "Replace the failing code path with a changed bounded candidate; no improvement claim" };
    const repaired = await f.write(name, repairSource, repairOptions, "repair-reviewed-parent");
    expect(repaired.isError).not.toBe(true);
    expect(data(repaired)).toMatchObject({
      name, version: 3, state: "validated",
      experiment: { decision: "revise", measured: false, reason: repairOptions.reason, qualification: "candidate_not_proven_improvement" },
    });
    const child = f.store.namedSkill(f.run.run_id, name, 3)!;
    expect(child).toMatchObject({ skill_id: parent.skill_id, parent_version: 2, version: 3 });
    expect(child.hash).not.toBe(parent.hash);
    expect(f.store.namedSkill(f.run.run_id, name, 2)).toEqual(parent);
    expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual(opportunities);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "learning.resolved")).toEqual(assessmentHistory);
    const candidates = f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "learning.candidate_written");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.details).toEqual({
      opportunity_id: opportunities[0]!.opportunity_id, execution_id: root.execution_id,
      parent: { run_id: f.run.run_id, skill_id: parent.skill_id, version: 2, hash: parent.hash },
      revision: { run_id: f.run.run_id, skill_id: parent.skill_id, version: 3, hash: child.hash },
      event_seqs: opportunities[0]!.event_seqs,
      decision: "revise", measured: false, reason: repairOptions.reason, qualification: "candidate_not_proven_improvement",
    });

    const retried = await f.write(name, repairSource, repairOptions, "repair-reviewed-parent");
    expect(retried.isError).not.toBe(true);
    expect(data(retried)).toEqual(data(repaired));
    const reviewRetry = await f.call("program_review", reviewInput, "assess-parent");
    expect(reviewRetry.isError).not.toBe(true);
    expect(data(reviewRetry)).toEqual(data(reviewed));
    const changedRetry = await f.write(name, source, repairOptions, "repair-reviewed-parent");
    expect(changedRetry.isError).toBe(true);
    expect(data(changedRetry).error.code).toBe("conflict");

    const stale = await f.write(name, repairSource, repairOptions, "stale-reviewed-parent");
    expect(stale.isError).toBe(true);
    expect(data(stale).error).toMatchObject({
      code: "conflict", issues: [{ code: "stale_parent", latest_parent: { name, version: 3 } }],
    });
    const reassessed = await f.call("program_review", {
      ...reviewInput, decision: decision === "keep" ? "insufficient_evidence" : "keep",
    }, "conflicting-parent-assessment");
    expect(reassessed.isError).toBe(true);
    expect(data(reassessed).error.code).toBe("conflict");
    expect(f.store.skills(f.run.run_id)).toHaveLength(3);
    expect(f.store.namedSkill(f.run.run_id, name, 3)).toEqual(child);
    expect(f.store.evidenceObjects<ImprovementOpportunity>(f.run.run_id, "opportunity")).toEqual(opportunities);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "learning.candidate_written")).toEqual(candidates);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(0);
  });
}

test("stop fences the actual named execution and stale tool closures cannot write", async () => {
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await aborted(signal);
    return { status: "completed", summary: "Worker neutralized", result: null };
  });
  await f.write("stoppable");
  await f.call("program_run", { operation: "start", name: "stoppable", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  expect(data(await f.call("program_run", { operation: "stop" })).status).toBe("cancel_requested");
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.status).toBe("cancelled");
  const old = f.tools(); f.fence();
  expect((await f.call("program_write", { entry: "run", name: "stale", source, card, dependencies: [] }, "stale-call", old)).isError).toBe(true);
  expect(f.store.namedSkill(f.run.run_id, "stale")).toBeNull();
  expect(f.actions()).toBe(0);
});

test("retained incompatible source remains readable but cannot be admitted", async () => {
  const f = fixture();
  await f.write("legacy");
  const original = f.store.namedSkill(f.run.run_id, "legacy")!;
  const db = new Database(join(f.directory, "runs.sqlite"));
  db.query("UPDATE skills SET metadata=json_remove(metadata,'$.validation.runtime_version') WHERE run_id=? AND name='legacy'").run(f.run.run_id);
  const inspected = data(await f.call("program_inspect", { view: "source", name: "legacy", version: 1 }));
  expect(inspected.source).toBe(original.source);
  expect(inspected.validation.runtime_version).toBeNull();
  const rejected = data(await f.call("program_run", { operation: "start", name: "legacy", version: 1, args: null }));
  expect(rejected.error.code).toBe("precondition_failed");
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(0);
  expect(f.dispatches()).toBe(0);
  db.close();
});

test("oversized evidence omissions advance the actual event cursor without hiding the next record", async () => {
  const f = fixture();
  const large = f.store.event(f.run.run_id, "fixture.large", "Oversized retained evidence", { value: "x".repeat(52000) });
  const next = f.store.event(f.run.run_id, "fixture.next", "Next retained evidence", { value: "bounded" });
  const omitted = data(await f.call("program_inspect", { view: "events", after: large.event_seq - 1, limit: 1 }));
  expect(omitted.records).toEqual([]);
  expect(omitted.omissions).toMatchObject([{ reason: "record_byte_budget" }]);
  expect(omitted.next_after).toBe(large.event_seq);
  expect(omitted.has_more).toBe(true);
  const resumed = data(await f.call("program_inspect", { view: "events", after: omitted.next_after, limit: 1 }));
  expect(resumed.records[0]).toMatchObject({ event_seq: next.event_seq, type: "fixture.next" });
});

test("named keep assessment is exact, immutable and never authorizes effects", async () => {
  const f = fixture();
  await f.write("kept");
  await f.call("program_run", { operation: "start", name: "kept", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  await f.write("kept", source, { based_on: 1 });
  await f.prepareFeedback(); f.run.status = "reviewing";
  const choice = { name: "kept", decision: "keep", reason: "Retain this version without an efficacy claim" };
  expect(data(await f.call("program_review", choice, "keep-call"))).toMatchObject({ name: "kept", version: 1, decision: "keep" });
  expect(data(await f.call("program_review", choice, "keep-call"))).toMatchObject({ decision: "keep" });
  expect(data(await f.call("program_review", { ...choice, decision: "insufficient_evidence" })).error.code).toBe("conflict");
  expect(f.store.evidenceObjects<{ resolution: { revision: unknown } }>(f.run.run_id, "opportunity")[0]!.resolution.revision).toBeNull();
  expect(f.actions()).toBe(0);
  expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
});

test("a trace continuation cursor stays pinned when a newer execution becomes latest", async () => {
  const f = fixture();
  await f.write("traced", 'await game.progress("Run marker",args); return {status:"completed",summary:"Marker retained",result:null};');
  await f.call("program_run", { operation: "start", name: "traced", args: "original-execution" });
  const original = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, original.execution_id);
  const originalTrace = f.store.tracePage(f.run.run_id, 0, 100, original.execution_id);
  const first = data(await f.call("program_inspect", { view: "trace", program: { name: "traced" }, limit: 1 }));
  expect(first.has_more).toBe(true);
  await f.call("program_run", { operation: "start", name: "traced", args: "newer-execution" });
  const newer = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, newer.execution_id);
  const continued = data(await f.call("program_inspect", { view: "trace", program: { name: "traced" }, after: first.next_after, limit: 100 }));
  expect(continued.records.length).toBeGreaterThan(0);
  expect(continued.records.every((record: { trace_seq: number }) => originalTrace.records.some((original) => original.trace_seq === record.trace_seq))).toBe(true);
  expect(JSON.stringify(continued)).not.toContain("newer-execution");
});

test("actual execution and trace inspection preserve opaque model JSON keys and SDK observations", async () => {
  const f = fixture();
  const opaque = { hash: "sample", session_id: "model-session", life_id: 42, epoch: 17, run_id: "model-run",
    nested: [{ action_id: "model-action", plan_id: "model-plan", source_hash: "model-source", value: { hash: "nested" } }],
    skill_id: "model-data-not-a-reference", version: 99 };
  await f.write("opaque echo");
  await f.write("opaque parent", 'const child = await game.call({name:"opaque echo"},args); await game.progress("Opaque diagnostic",args); const observed = await game.observe(); return {status:"completed",summary:"Opaque values retained",result:{payload:child.result,sdk:observed}};', {
    dependencies: [{ name: "opaque echo" }],
  });
  await f.call("program_run", { operation: "start", name: "opaque parent", args: opaque });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const inspected = data(await f.call("program_inspect", { view: "execution", program: { name: "opaque parent" } }));
  expect(inspected.args).toEqual(opaque);
  expect(inspected.result.result.payload).toEqual(opaque);
  expect(inspected.result.result.sdk).toMatchObject({ schema_version: 3, session_id: f.run.session_id, world_id: f.run.world_id,
    epoch: f.run.epoch, life: { life_id: f.run.life_id }, data: { blocks: [{ target: { target_id: "authorized-block" } }],
      entities: [{ target: { target_id: "authorized-item" }, item_name: "stone" }] } });
  expect(inspected.execution_id).toBeUndefined();
  expect(inspected.session_id).toBeUndefined();
  const trace = data(await f.call("program_inspect", { view: "trace", program: { name: "opaque parent" }, limit: 100 }));
  expect(trace.records.find((record: { kind: string }) => record.kind === "intent").payload.details).toEqual(opaque);
  const childResult = trace.records.find((record: { kind: string; capability: string }) => record.kind === "capability_result" && record.capability === "call");
  expect(childResult.payload.result.result).toEqual(opaque);
  expect(trace.records.find((record: { kind: string }) => record.kind === "observation").payload.data.blocks[0].target.target_id).toBe("authorized-block");
});

for (const boundary of ["same", "world", "session", "epoch", "life", "boot", "space"] as const) {
  test(`named execution native-life relation follows ${boundary} identity, not authored death state`, async () => {
    const f = fixture();
    const input = { name: "authored death state",
      source: 'return {status:"completed",summary:"Authored diagnostic only",result:{state:{dead:true,life_id:99,session_id:"authored-session",epoch:99,native_boot_id:"authored-boot"}}};',
      args: null };
    const admitted = data(await f.call("program_submit", input));
    expect(admitted.start).toMatchObject({ status: "started", execution: { name: input.name, native_life_relation: "same_native_life" } });
    const original = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, original.execution_id);
    const inspect = async () => data(await f.call("program_inspect", { view: "execution", program: { name: input.name } }));
    const before = await inspect();
    expect(before).toMatchObject({ status: "succeeded", native_life_relation: "same_native_life",
      result: { result: { state: { dead: true } } } });
    const current = { ...f.run };
    if (boundary === "world") f.run.world_id = crypto.randomUUID();
    if (boundary === "session") f.run.session_id = "next-session";
    if (boundary === "epoch") f.run.epoch++;
    if (boundary === "life") f.run.life_id!++;
    if (boundary === "boot") f.run.native_boot_id = "next-boot";
    if (boundary === "space") f.run.space_epoch!++;
    f.store.saveRun(f.run);
    const after = await inspect();
    expect(after).toEqual({ ...before, native_life_relation:
      boundary === "same" || boundary === "space" ? "same_native_life" : "different_native_scope" });
    for (const key of ["world_id", "session_id", "epoch", "native_boot_id", "life_id", "space_epoch", "current_authority", "alive", "dead"])
      expect(after).not.toHaveProperty(key);
    expect(f.dispatches()).toBe(1);
    expect(f.actions()).toBe(0);
    expect(f.store.allSkillExecutions(f.run.run_id)).toHaveLength(1);
    Object.assign(f.run, current);
    f.store.saveRun(f.run);
    expect((await inspect()).native_life_relation).toBe("same_native_life");
    f.setLife({ life_id: f.run.life_id!, status: "dead", can_respawn: true,
      death: { death_id: "observed-death", at: "2026-10-22T00:00:00Z", message: "Native status is separate from identity" } });
    expect((await inspect()).native_life_relation).toBe("same_native_life");
  });
}

test("named execution native-life relation is unknown when original or current attribution is missing", async () => {
  const f = fixture();
  await f.write("missing native attribution");
  await f.call("program_run", { operation: "start", name: "missing native attribution", args: null });
  const original = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, original.execution_id);
  const completed = f.store.skillExecution(f.run.run_id, { execution_id: original.execution_id })!;
  const current = { ...f.run };
  const workspace = new ProgramWorkspace(f.store, f.run.run_id);
  const inspect = async () => data(await f.call("program_inspect", { view: "execution", program: { name: "missing native attribution" } }));
  const before = await inspect();
  for (const key of ["world_id", "session_id", "native_boot_id", "life_id"] as const) {
    expect(workspace.executionSummary({ ...completed, [key]: undefined }, f.run).native_life_relation).toBe("unknown");
    Object.assign(f.run, { [key]: null });
    f.store.saveRun(f.run);
    expect(await inspect()).toEqual({ ...before, native_life_relation: "unknown" });
    Object.assign(f.run, current);
    f.store.saveRun(f.run);
    expect(await inspect()).toEqual(before);
  }
  expect(workspace.executionSummary(completed, { ...f.run, epoch: undefined }).native_life_relation).toBe("unknown");
  expect(workspace.executionSummary(completed, null).native_life_relation).toBe("unknown");
  expect(workspace.executionSummary(completed).native_life_relation).toBe("same_native_life");
  expect(workspace.executionView(completed)?.native_life_relation).toBe("same_native_life");
  expect(f.dispatches()).toBe(1);
  expect(f.actions()).toBe(0);
});

test("feedback names every exact version and distinguishes neutral executions without objective event sequences", async () => {
  const f = fixture();
  await f.write("measured A");
  const execute = async (name: string) => {
    await f.call("program_run", { operation: "start", name, args: null });
    const execution = f.store.latestRootExecution(f.run.run_id)!;
    await waitClosed(f.store, f.run.run_id, execution.execution_id);
  };
  await execute("measured A"); await execute("measured A");
  await f.write("measured A", source, { based_on: 1 });
  await execute("measured A");
  await f.write("measured B"); await execute("measured B");
  await f.prepareFeedback();
  const feedback = data(await f.call("program_inspect", { view: "feedback", limit: 100 }));
  expect(feedback.metrics.map((update: { metric: { name: string; version: number } }) =>
    `${update.metric.name}@${update.metric.version}`).sort()).toEqual([
    "measured A@1", "measured A@1", "measured A@2", "measured B@1",
  ]);
  const ordinals = feedback.metrics.map((update: { execution_ordinal: number }) => update.execution_ordinal);
  expect(ordinals.every((ordinal: unknown) => typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0)).toBe(true);
  expect(new Set(ordinals).size).toBe(4);
  expect(feedback.metrics.every((update: { metric: { evidence_event_seqs: number[] } }) => update.metric.evidence_event_seqs.length === 0)).toBe(true);
  expect(feedback.metrics.every((update: { execution_id?: string; revision: number; generation: number; metric: { execution_id?: string; root_execution_id?: string } }) =>
    update.execution_id === undefined && update.metric.execution_id === undefined && update.metric.root_execution_id === undefined &&
    Number.isSafeInteger(update.revision) && update.revision > 0 && Number.isSafeInteger(update.generation) && update.generation > 0)).toBe(true);
  expect(feedback.next_after).toMatchObject({ schema_version: 2, opportunity_change_seq: expect.any(Number), metric_change_seq: expect.any(Number) });
  expect(feedback.next_after.scope_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(feedback.projection).toMatchObject({ generation: expect.any(Number), source_through: expect.any(Number),
    source_available: expect.any(Number), has_pending: expect.any(Boolean) });
  const again = data(await f.call("program_inspect", { view: "feedback", limit: 100 }));
  expect(again.metrics.map((update: { execution_ordinal: number }) => update.execution_ordinal)).toEqual(ordinals);
});

test("ordinary and speculative observe project housekeeping only and retain authorized gameplay data", async () => {
  const release = Promise.withResolvers<void>();
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await Promise.race([release.promise, aborted(signal)]);
    return { status: "completed", summary: "Neutral predecessor ended", result: null };
  });
  const assertGameplay = (observed: Record<string, any>) => {
    expect(observed.schema_version).toBe(3);
    expect(observed.session_id).toBeUndefined(); expect(observed.world_id).toBeUndefined(); expect(observed.epoch).toBeUndefined();
    expect(observed.life.life_id).toBeUndefined();
    expect(observed.data).toEqual(f.observation().data);
    expect(observed.data.blocks[0].target).toEqual(f.observation().data.blocks[0]!.target);
    expect(observed.freshness).toEqual(f.observation().freshness);
    expect(observed).not.toHaveProperty("player");
    expect(observed.observation_seq).toBe(1);
    expect(typeof observed.captured_at).toBe("string");
  };
  assertGameplay(data(await f.call("observe", {})));
  await f.write("observe predecessor");
  await f.call("program_run", { operation: "start", name: "observe predecessor", args: null,
    next: { after_ms: 0, reason: "Inspect authorized observation projection", budget: { calls: 1, tools: 4, duration_ms: 30000 } } });
  const flight = f.planning.begin()!;
  assertGameplay(data(await f.call("observe", {})));
  f.planning.finish(flight.plan_id); release.resolve();
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  f.setLife({ life_id: 1, status: "dead", can_respawn: true, death: { death_id: "private-death", at: "2026-10-22T00:00:00Z", message: "Observed ordinary death" } });
  const dead = data(await f.call("observe", {}));
  assertGameplay(dead);
  expect(dead.life).toEqual({ status: "dead", can_respawn: true, death: { at: "2026-10-22T00:00:00Z", message: "Observed ordinary death" } });
  expect(f.observation().life.death?.death_id).toBe("private-death");
});

test("Codex wire preserves optional program arguments and discriminants through actual dispatch", async () => {
  const f = fixture();
  const descriptor = getBundledModels("openai-codex").find((model) => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("The installed static catalog has no Codex descriptor for offline schema translation");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const tools = f.tools();
  // The real pure SDK request builder never opens a transport or resolves credentials.
  const request = await buildTransformedCodexRequestBody(model, {
    systemPrompt: ["Offline tool-schema regression"],
    messages: [{ role: "user", content: "Inspect the tool contract without inference.", timestamp: 0 }],
    tools,
  }, { responsesLite: false });
  const wireTools = z.array(z.object({ type: z.literal("function"), name: z.string(),
    parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).loose()).parse(request.tools);
  const wireSchema = (name: string) => {
    const declaration = wireTools.find((tool) => tool.name === name);
    if (!declaration) throw new Error(`The actual Codex payload omitted ${name}`);
    // Model the documented Responses omission default, not an observed remote grammar:
    // https://developers.openai.com/api/docs/guides/function-calling#strict-mode
    return adaptSchemaForStrict(declaration.parameters, declaration.strict ?? true).schema;
  };
  const creation = { entry: "run", name: "wire neutral", source, card, dependencies: [] };
  expect(validateJsonSchemaValue(wireSchema("program_write"), creation)).toEqual({ success: true, issues: [] });
  const admitted = data(await f.call("program_write", creation, "wire-create", tools));
  expect(admitted).toMatchObject({ name: "wire neutral", version: 1, state: "validated" });
  const stored = data(await f.call("program_inspect", { view: "source", name: "wire neutral", version: 1 }));
  expect(stored).toMatchObject({ name: "wire neutral", version: 1, state: "validated" });
  expect(typeof stored.source).toBe("string");
  expect(validateJsonSchemaValue(wireSchema("program_run"), { operation: "inspect", target: "current" })).toEqual({ success: true, issues: [] });
  const mixed = { operation: "inspect", target: "current", name: "wire neutral" };
  expect(validateJsonSchemaValue(wireSchema("program_run"), mixed).success).toBe(false);
  expect(data(await f.call("program_run", mixed)).error.code).toBe("invalid_request");
  await f.call("program_run", { operation: "start", name: "wire neutral", args: { preserved: true } });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  expect(data(await f.call("program_inspect", { view: "execution", program: { name: "wire neutral" } })).result.result).toEqual({ preserved: true });
  const revision = { ...creation, based_on: 1 };
  expect(validateJsonSchemaValue(wireSchema("program_write"), revision)).toEqual({ success: true, issues: [] });
  expect(data(await f.call("program_write", revision, "wire-revision"))).toMatchObject({ version: 2, state: "validated" });
  expect(data(await f.call("program_write", revision, "wire-stale-revision")).error.code).toBe("conflict");
  expect(data(await f.call("program_inspect", { view: "catalog" })).records).toMatchObject([{ name: "wire neutral", version: 2 }]);
  await f.prepareFeedback();
  const selected = { name: "wire neutral", version: 1 };
  const inspectSchema = wireSchema("program_inspect");
  const firstFeedback = { view: "feedback", program: selected, limit: 1 };
  expect(validateJsonSchemaValue(inspectSchema, firstFeedback).success).toBe(true);
  const opportunityPage = data(await f.call("program_inspect", firstFeedback));
  expect(opportunityPage.next_after.schema_version).toBe(2);
  expect(opportunityPage.opportunities).toHaveLength(1);
  expect(opportunityPage.metrics).toEqual([]);
  expect(opportunityPage.has_more).toBe(true);
  expect(opportunityPage.next_after.opportunity_change_seq).toBeGreaterThan(0);
  expect(opportunityPage.next_after.metric_change_seq).toBe(0);
  const metricPageInput = { ...firstFeedback, after: opportunityPage.next_after };
  expect(validateJsonSchemaValue(inspectSchema, metricPageInput).success).toBe(true);
  const feedback = data(await f.call("program_inspect", metricPageInput));
  for (const page of [opportunityPage, feedback])
    expect(page.opportunities.length + page.metrics.length + page.omitted.length).toBeLessThanOrEqual(1);
  expect(feedback.opportunities).toEqual([]);
  expect(feedback.metrics).toHaveLength(1);
  expect(feedback.next_after.opportunity_change_seq).toBe(opportunityPage.next_after.opportunity_change_seq);
  expect(feedback.next_after.metric_change_seq).toBeGreaterThan(opportunityPage.next_after.metric_change_seq);
  expect(feedback.next_after.scope_hash).toBe(opportunityPage.next_after.scope_hash);
  // Keep the actual continuation values intact: Bun's asymmetric object matcher
  // can replace matched properties with matcher objects.
  for (const value of [feedback.metrics[0].execution_ordinal, feedback.metrics[0].revision, feedback.metrics[0].generation]) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(feedback.metrics[0].execution_ordinal).toBeGreaterThan(0);
  expect(feedback.metrics[0].metric.name).toBe(selected.name);
  expect(feedback.metrics[0].metric.version).toBe(selected.version);
  const feedbackContinuation = { ...firstFeedback, after: feedback.next_after };
  expect(validateJsonSchemaValue(inspectSchema, feedbackContinuation).success).toBe(true);
  const continuedFeedback = await f.call("program_inspect", feedbackContinuation);
  expect(continuedFeedback.isError).not.toBe(true);
  expect(data(continuedFeedback).next_after.scope_hash).toBe(feedback.next_after.scope_hash);
  expect(data(await f.call("program_inspect", { ...feedbackContinuation, program: { ...selected, version: 2 } })).error.code).toBe("conflict");
  const firstComparison = { view: "comparison", before: selected, after: selected, limit: 1 };
  expect(validateJsonSchemaValue(inspectSchema, firstComparison).success).toBe(true);
  const comparison = data(await f.call("program_inspect", firstComparison));
  expect(comparison.has_more).toBe(true);
  expect(comparison.next_after.schema_version).toBe(2);
  expect(comparison.next_after.offset).toBe(1);
  for (const generation of [comparison.next_after.before_generation, comparison.next_after.after_generation]) {
    expect(Number.isSafeInteger(generation)).toBe(true);
    expect(generation).toBeGreaterThanOrEqual(0);
  }
  expect(comparison.next_after.scope_hash).toMatch(/^[a-f0-9]{64}$/);
  const comparisonContinuation = { ...firstComparison, after_sample: comparison.next_after };
  expect(validateJsonSchemaValue(inspectSchema, comparisonContinuation)).toEqual({ success: true, issues: [] });
  const programHelp = data(await f.call("help", { topic: "programs" }));
  expect(validateJsonSchemaValue(programHelp.inspect, feedbackContinuation).success).toBe(true);
  expect(validateJsonSchemaValue(programHelp.inspect, comparisonContinuation).success).toBe(true);
  const nullComparisonCursor = { ...firstComparison, after_sample: null };
  expect(validateJsonSchemaValue(inspectSchema, nullComparisonCursor).success).toBe(true);
  expect(validateJsonSchemaValue(programHelp.inspect, nullComparisonCursor).success).toBe(true);
  expect(data(await f.call("program_inspect", nullComparisonCursor)).next_after).toEqual(comparison.next_after);
  const pinnedMetricInput = { view: "metric", program: selected,
    execution_ordinal: feedback.metrics[0].execution_ordinal, generation: feedback.metrics[0].generation };
  expect(validateJsonSchemaValue(inspectSchema, pinnedMetricInput).success).toBe(true);
  expect(validateJsonSchemaValue(programHelp.inspect, pinnedMetricInput).success).toBe(true);
  const pinnedMetric = data(await f.call("program_inspect", pinnedMetricInput));
  expect(pinnedMetric.records).toEqual([feedback.metrics[0].metric]);
  expect(pinnedMetric.has_more).toBe(false);
  expect(JSON.stringify(pinnedMetric.records)).not.toContain(root.execution_id);
  const metricContinuation = { ...pinnedMetricInput, after: pinnedMetric.next_after };
  expect(validateJsonSchemaValue(inspectSchema, metricContinuation).success).toBe(true);
  expect(data(await f.call("program_inspect", metricContinuation)).records).toEqual([]);
  const mismatchedMetric = await f.call("program_inspect", { ...pinnedMetricInput, program: { ...selected, version: 2 } });
  expect(mismatchedMetric.isError).toBe(true);
  for (const input of [
    { ...pinnedMetricInput, program: { name: selected.name } },
    { ...pinnedMetricInput, execution_id: root.execution_id },
    { ...pinnedMetricInput, generation: -1 },
    { ...pinnedMetricInput, after: { record_index: 0, chunk_index: -1 } },
  ]) {
    expect(validateJsonSchemaValue(inspectSchema, input).success).toBe(false);
    expect(data(await f.call("program_inspect", input)).error.code).toBe("invalid_request");
  }
  const pinnedEvidenceInput = { ...pinnedMetricInput, view: "evidence" };
  expect(validateJsonSchemaValue(inspectSchema, pinnedEvidenceInput).success).toBe(true);
  expect(validateJsonSchemaValue(programHelp.inspect, pinnedEvidenceInput).success).toBe(true);
  const pinnedEvidence = data(await f.call("program_inspect", pinnedEvidenceInput));
  expect(pinnedEvidence.records).toHaveLength(1);
  expect(pinnedEvidence.records[0]).toMatchObject({ name: selected.name, version: selected.version,
    execution_ordinal: pinnedEvidenceInput.execution_ordinal });
  expect(pinnedEvidence.has_more).toBe(false);
  expect(JSON.stringify(pinnedEvidence.records)).not.toContain(root.execution_id);
  const evidenceContinuation = { ...pinnedEvidenceInput, after: pinnedEvidence.next_after };
  expect(validateJsonSchemaValue(inspectSchema, evidenceContinuation).success).toBe(true);
  expect(data(await f.call("program_inspect", evidenceContinuation)).records).toEqual([]);
  expect((await f.call("program_inspect", { ...pinnedEvidenceInput, program: { ...selected, version: 2 } })).isError).toBe(true);
  for (const input of [
    { ...pinnedEvidenceInput, program: { name: selected.name } },
    { ...pinnedEvidenceInput, execution_id: root.execution_id },
    { ...pinnedEvidenceInput, generation: -1 },
    { ...pinnedEvidenceInput, after: { record_index: 0, chunk_index: -1 } },
  ]) {
    expect(validateJsonSchemaValue(inspectSchema, input).success).toBe(false);
    expect(data(await f.call("program_inspect", input)).error.code).toBe("invalid_request");
  }
  f.store.event(f.run.run_id, "fixture.next_generation", "New retained evidence after the first comparison page");
  await f.prepareFeedback();
  expect(data(await f.call("program_inspect", pinnedMetricInput)).records).toEqual(pinnedMetric.records);
  expect(data(await f.call("program_inspect", pinnedEvidenceInput)).records).toEqual(pinnedEvidence.records);
  const continuedReply = await f.call("program_inspect", comparisonContinuation);
  const continued = data(continuedReply);
  expect(continued.error).toBeUndefined();
  expect(continuedReply.isError).not.toBe(true);
  expect(continued.comparison.samples.before).toEqual([]);
  expect(continued.comparison.samples.after).toHaveLength(1);
  expect(continued.next_after.before_generation).toBe(comparison.next_after.before_generation);
  expect(continued.next_after.after_generation).toBe(comparison.next_after.after_generation);
  expect(continued.next_after.scope_hash).toBe(comparison.next_after.scope_hash);
  expect(data(await f.call("program_inspect", { ...comparisonContinuation, after: { ...selected, version: 2 } })).error.code).toBe("conflict");
  for (const cursor of [
    { ...comparison.next_after, scope_hash: comparison.next_after.scope_hash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) },
    { ...comparison.next_after, before_generation: Number.MAX_SAFE_INTEGER },
    { ...comparison.next_after, after_generation: Number.MAX_SAFE_INTEGER },
  ]) {
    const input = { ...firstComparison, after_sample: cursor };
    expect(validateJsonSchemaValue(inspectSchema, input).success).toBe(true);
    expect(validateJsonSchemaValue(programHelp.inspect, input).success).toBe(true);
    expect(data(await f.call("program_inspect", input)).error.code).toBe("conflict");
  }
  const retiredCursors = [
    { ...firstFeedback, after: { opportunity_seq: 0, execution_seq: 0 } },
    { ...firstFeedback, after: { schema_version: 1, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null } },
    { ...firstComparison, after_sample: 1 },
    { ...firstComparison, after_sample: { ...comparison.next_after, unexpected: true } },
    { ...firstComparison, after_sample: { ...comparison.next_after, before_generation: -1 } },
    { ...firstComparison, after_sample: { ...comparison.next_after, after_generation: -1 } },
    { ...firstComparison, after_sample: { ...comparison.next_after, scope_hash: "invalid" } },
  ];
  for (const input of retiredCursors) {
    expect(validateJsonSchemaValue(inspectSchema, input).success).toBe(false);
    expect(validateJsonSchemaValue(programHelp.inspect, input).success).toBe(false);
    expect(data(await f.call("program_inspect", input)).error.code).toBe("invalid_request");
  }
  expect(data(await f.call("program_inspect", { ...firstFeedback,
    after: { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 1, scope_hash: null } })).error.code).toBe("invalid_request");
});

test("all default-bearing tool declarations accept omitted inputs without weakening closed shapes", async () => {
  const f = fixture(async (_source, _args, _handle, _limits, signal) => {
    await aborted(signal);
    return { status: "completed", summary: "Default-schema fixture drained", result: null };
  });
  await f.call("help", { topic: "reflex" });
  await f.call("help", { topic: "memory" });
  const ordinary = f.tools();
  const next = { after_ms: 0, reason: "Exercise omitted nested activation", budget: { calls: 1, tools: 4, duration_ms: 30000 } };
  await f.write("default predecessor");
  await f.call("program_run", { operation: "start", name: "default predecessor", args: null, next });
  expect(f.planning.begin()).not.toBeNull();
  const declarations = [...ordinary, ...f.tools()];
  const cases: { name: string; input: Record<string, unknown> }[] = [
    { name: "program_write", input: { entry: "run", name: "default candidate", source } },
    { name: "program_submit", input: { name: "default submitted candidate", source, args: null } },
    { name: "program_submit", input: { name: "default submitted candidate", source, args: null, next } },
    { name: "program_run", input: { operation: "start", name: "default predecessor", args: null } },
    { name: "program_run", input: { operation: "start", name: "default predecessor", args: null, next } },
    { name: "program_run", input: { operation: "inspect" } },
    { name: "program_run", input: { operation: "stop" } },
    { name: "program_inspect", input: { view: "catalog" } },
    { name: "program_inspect", input: { view: "execution" } },
    { name: "program_inspect", input: { view: "history" } },
    { name: "program_inspect", input: { view: "trace" } },
    { name: "program_inspect", input: { view: "feedback" } },
    { name: "program_inspect", input: { view: "events" } },
    { name: "program_inspect", input: { view: "comparison", before: { name: "default predecessor", version: 1 }, after: { name: "default predecessor", version: 1 } } },
    { name: "program_inspect", input: { view: "action" } },
    { name: "help", input: {} },
    { name: "prepare_next", input: { name: "default predecessor", args: null } },
    { name: "reflex", input: { operation: "activate", name: "default reaction" } },
    { name: "memory", input: { operation: "catalog" } },
    { name: "memory", input: { operation: "qualify", name: "default snapshot",
      declaration: { portability: "portable", retained_world_data: false, predicate: { kind: "goal_verified", event_seq: 1 } } } },
  ];
  for (const { name, input } of cases) {
    const declaration = declarations.find((tool) => tool.name === name);
    if (!declaration) throw new Error(`Actual role catalogs omitted ${name}`);
    expect(declaration.strict).toBe(false);
    expect({ name, input, ...validateJsonSchemaValue(declaration.parameters, input) }).toEqual({
      name, input, success: true, issues: [],
    });
    expect(validateJsonSchemaValue(declaration.parameters, { ...input, caller_authority: "forged" }).success).toBe(false);
  }
});

test("retired generic recipe inspection rejects at the schema boundary without losing the registered executable read", async () => {
  const f = fixture();
  const inspect = f.tools().find(tool => tool.name === "program_inspect")!;
  expect(validateJsonSchemaValue(inspect.parameters, { view: "recipes", item: "crafting_table" }).success).toBe(false);
  const retired = await f.call("program_inspect", { view: "recipes", item: "crafting_table" });
  expect(retired.isError).toBe(true);
  expect(data(retired).error.code).toBe("invalid_request");
  const unknown = await f.call("program_inspect", { view: "not_a_registered_view" });
  expect(data(unknown).error.code).toBe("invalid_request");
  const programs = data(await f.call("help", { topic: "programs" }));
  expect(validateJsonSchemaValue(programs.inspect, { view: "recipes", item: "crafting_table" }).success).toBe(false);
  const game = data(await f.call("help", { topic: "game" }));
  expect(JSON.stringify(game)).toContain("minecraft.recipes");
  const written = await f.write("registered recipe reader",
    'const recipes = await game.recipes("crafting_table"); return {status:"completed",summary:"Inspected registered adapter recipes",result:{available:recipes.length}};');
  expect(written.isError).not.toBe(true);
  await f.call("program_run", { operation: "start", name: "registered recipe reader", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const inspected = data(await f.call("program_inspect", { view: "execution", program: { name: "registered recipe reader" } }));
  expect(inspected).toMatchObject({ status: "succeeded", result: { result: { available: 0 } } });
  expect(f.actions()).toBe(0);
});

test("registered visible-screen read is available to actual program bodies without opening a view or granting effects", async () => {
  const f = fixture();
  const written = await f.write("visible screen reader",
    'const screen = await game.screen(); return {status:"completed",summary:"Read current visible screen",result:{open:screen !== null}};');
  expect(written.isError).not.toBe(true);
  await f.call("program_run", { operation: "start", name: "visible screen reader", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const inspected = data(await f.call("program_inspect", { view: "execution", program: { name: "visible screen reader" } }));
  expect(inspected).toMatchObject({ status: "succeeded", result: { result: { open: false } } });
  expect(f.actions()).toBe(0);
});

test("documented helper body registers and executes through ordinary named tools", async () => {
  const f = fixture();
  const body = `// Ordinary documented procedure, not an evaluator-authored gameplay strategy.
async function read() { return await game.observe(); }
function count(value) {
  let total = 0;
  ${Array.from({ length: 18 }, (_, index) => `if (value > ${index}) total++;`).join("\n")}
  return total;
}
const observed = await read();
let total = count(17);
${"total += 1;\n".repeat(85)}
return {status:"completed",summary:"Read-only fixture completed",result:{total,schema:observed.schema_version}};`;
  const written = await f.write("documented reader", body);
  expect(written.isError).not.toBe(true);
  await f.call("program_run", { operation: "start", name: "documented reader", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const outcome = data(await f.call("program_inspect", { view: "execution", program: { name: "documented reader" } }));
  expect(outcome).toMatchObject({ status: "succeeded", result: { result: { total: 102, schema: 3 } } });
  expect(f.actions()).toBe(0);
});

test("ordinary writes without cards still enforce immutable version lineage", async () => {
  const f = fixture();
  const written = await f.call("program_write", { entry: "run", name: "ordinary reader", source, dependencies: [] });
  expect(written.isError).not.toBe(true);
  const inspected = data(await f.call("program_inspect", { view: "source", name: "ordinary reader", version: 1 }));
  expect(inspected.state).toBe("validated");
  expect(data(await f.call("program_write", { entry: "run", name: "ordinary reader", source, dependencies: [] })).error.code).toBe("conflict");
});

test("strategic observe supplies typed PNG through actual offline Codex transformation, never JSON evidence", async () => {
  const f = fixture();
  const image = { type: "image" as const, mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==" };
  const metadata = { sequence: 17, capturedAt: Date.now(), width: 1, height: 1, encoded_bytes: 70,
    sha256: "b".repeat(64), alignment: "unsynchronized" };
  Object.assign(f.toolHost, { modelObservation: async () => ({ observation: f.observation(), images: [image], image_metadata: metadata }) });
  const reply = await f.call("observe", {}, "image-observation");
  expect(reply.content.filter(content => content.type === "image")).toEqual([image]);
  expect(JSON.stringify(reply.details)).not.toContain(image.data);
  expect(JSON.stringify(data(reply))).not.toContain(image.data);
  expect(JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 500))).not.toContain(image.data);
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses" && model.input.includes("image"));
  if (!descriptor) throw new Error("Installed Codex catalog lacks an image-capable descriptor for the offline test");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const request = await buildTransformedCodexRequestBody(model, {
    systemPrompt: ["Offline typed observation regression; no provider"],
    messages: [
      { role: "user", content: "Observe current authorized state", timestamp: 0 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_observe", name: "observe", arguments: {} }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 },
      { role: "toolResult", toolCallId: "call_observe", toolName: "observe", ...reply, isError: false, timestamp: 0 },
    ], tools: f.tools(),
  }, { responsesLite: false });
  const wire = JSON.stringify(request.input);
  expect(wire).toContain('"type":"input_image"');
  expect(wire).toContain(`data:image/png;base64,${image.data}`);
  // Worker program observation remains the existing JSON-only capability.
  await f.write("json observer", 'const value=await game.observe();return {status:"completed",summary:"Observed",result:value};');
  await f.call("program_run", { operation: "start", name: "json observer", args: null });
  const root = f.store.latestRootExecution(f.run.run_id)!;
  await waitClosed(f.store, f.run.run_id, root.execution_id);
  const observed = f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })!.result?.result;
  expect(observed).toMatchObject({ schema_version: 3, session_id: f.run.session_id, data: { player: f.observation().data.player } });
  expect(JSON.stringify(observed)).not.toContain(image.data);
});

test("observe scope revoked during image encoding cannot return an actionable typed image", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  Object.assign(f.toolHost, { modelObservation: async () => {
    entered.resolve(); await release.promise;
    return { observation: f.observation(), images: [{ type: "image", data: "PRIVATE_STALE_IMAGE", mimeType: "image/png" }], image_metadata: {} };
  } });
  const pending = f.call("observe", {});
  await Promise.race([entered.promise, pending]);
  f.fence(); release.resolve();
  const reply = await pending;
  expect(reply.isError).toBe(true);
  expect(reply.content.some(content => content.type === "image")).toBe(false);
  expect(f.actions()).toBe(0);
});
