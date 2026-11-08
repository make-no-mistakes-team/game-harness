import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Model, ToolCall } from "@oh-my-pi/pi-ai";
import type { Json } from "../src/shared/contracts.ts";
import type { SkillView } from "../src/shared/programs.ts";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { AuthManager } from "../src/server/auth.ts";
import { StrategicPlanner } from "../src/server/strategic.ts";
import { StrategicContext } from "../src/server/strategic-context.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { programHelp } from "../src/server/program-help.ts";
import { Store } from "../src/server/store.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { ResidentController } from "../src/server/resident-controller.ts";
import { retainResidentReceipt } from "../src/server/resident-evidence.ts";
import { DEFAULT_RESIDENT_LIMITS, type ControllerStepResult, type ResidentSnapshot } from "../src/shared/resident.ts";
import type { ControllerInput, ControllerEffectUpdate, ControllerInputChannel } from "../src/shared/controller.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";

const resources: { planner: StrategicPlanner; store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const { planner, store, directory } of resources.splice(0)) {
    await planner.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
function model() {
  const descriptor = getBundledModels("openai-codex").find(value => value.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed catalog lacks offline model descriptor");
  return getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
}
function settlement(calls: ToolCall[] = [], failed = false): AssistantMessage {
  const selected = model();
  return { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
    content: calls, stopReason: failed ? "error" : calls.length ? "toolUse" : "stop", timestamp: 0,
    ...(failed ? { errorMessage: "Deterministic failed response" } : {}),
    usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-context-")), store = new Store(directory);
  const adapter = minecraftTestAdapter();
  const state = { adapter, run: minecraftRunFixture(adapter, { model_id: model().id, task: "Observe neutral fixture state" }),
    observation: minecraftObservationFixture(adapter), generation: 1, creates: 0, root: "Neutral context fixture",
    requests: [] as Context[], responses: [] as AssistantMessage[], toolEffects: 0, helpEffects: 0, toolSchema: "original",
    helpPadding: "", helpResults: {} as Record<string, Json>,
    selectedModel: model() as Model, submitResult: null as Json, completedToolEvents: false };
  store.saveRun(state.run);
  const help: AgentTool = { name: "help", label: "help", description: "Load a requested contract section",
    parameters: { type: "object", properties: { topic: { type: "string" }, kind: { type: "string" } } },
    execute: async (_id, input) => {
      state.helpEffects++;
      const topic = input && typeof input === "object" && "topic" in input ? input.topic : "overview";
      const kind = input && typeof input === "object" && "kind" in input ? input.kind : undefined;
      const reference = kind === undefined ? String(topic) : `${topic}:${kind}`;
      const value = state.helpResults[reference] ?? state.helpResults[String(topic)] ?? { bindings: { fixture_read: { parameters: ["query"], result: "NeutralValue" } },
        section: `requested-${topic}`, body: `Useful exact requested contract${state.helpPadding}` };
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    } };
  const effect = (name: string): AgentTool => ({ name, label: name, description: "Count unauthorized effect attempts",
    parameters: { type: "object", properties: {} }, execute: async callId => {
      state.toolEffects++;
      // Match RuntimeTools' durable service-result boundary. The installed
      // Agent still owns complete-response eligibility and tool dispatch.
      store.event(state.run.run_id, "model.tool_result", `Strategic tool ${name} returned service evidence`,
        { tool_call_id: callId, tool: name, result: state.submitResult });
      return { content: [{ type: "text", text: JSON.stringify(state.submitResult) }], details: state.submitResult };
    } });
  const streamFn: StreamFn = (_model, context) => {
    // The SDK context may carry executable tool properties; capture only the
    // serialized provider input rather than cloning in-process functions.
    state.requests.push(JSON.parse(JSON.stringify(context)));
    const message = state.responses.shift() ?? settlement();
    const stream = new AssistantMessageEventStream(); stream.push({ type: "start", partial: message });
    if (state.completedToolEvents) message.content.forEach((entry, contentIndex) => {
      if (entry.type !== "toolCall") return;
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(entry.arguments), partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: entry, partial: message });
    });
    if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    stream.end(); return stream;
  };
  const auth = { createAgent: async (options: Parameters<AuthManager["createAgent"]>[0]) => {
    state.creates++;
    return new Agent({ initialState: { model: state.selectedModel, systemPrompt: options.systemPrompt, tools: options.tools },
      streamFn, getApiKey: () => "OFFLINE_CONTEXT_FIXTURE" });
  }, releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); } } as unknown as AuthManager;
  let planner: StrategicPlanner;
  planner = new StrategicPlanner(store, auth, {
    run: () => state.run, generation: () => state.generation,
    assertCurrent: (generation, epoch) => {
      if (generation !== state.generation || epoch !== undefined && epoch !== state.run.epoch || state.run.status !== "running")
        throw new RuntimeFault("stale_context", "Fixture authority revoked");
      return state.run;
    },
    tools: () => [{ ...help, parameters: { ...help.parameters, description: state.toolSchema } },
      effect("program_submit"), effect("program_write"), effect("program_run")],
    rootPrompt: () => state.root, adapter: () => state.adapter,
    observe: async () => state.observation, projectObservation: observation => state.adapter.projectObservation(observation),
    policies: () => [], action: () => null, programPending: () => false, busy: () => true,
    persist: () => store.saveRun(state.run), pause: () => { state.run.status = "paused"; planner.fence(); },
    terminal: () => { throw new Error("Unexpected fixture termination"); },
  });
  resources.push({ planner, store, directory });
  const turn = async (responses: AssistantMessage[] = []) => {
    state.responses.push(...responses);
    const done = Promise.withResolvers<void>();
    const off = store.subscribe(event => {
      if (event.run_id !== state.run.run_id) return;
      if (event.type === "runtime.model_observation_failed") {
        off(); done.reject(new Error("Fixture observation did not satisfy its negotiated adapter contract"));
      } else if (["scheduler.turn_finished", "scheduler.turn_failed"].includes(event.type)) {
        off(); done.resolve();
      }
    });
    planner.wake("policy_replan"); await done.promise;
  };
  const program = (source = 'return {status:"completed",summary:"neutral-source-marker",result:null};', name = "Neutral procedure") => store.registerSkill(state.run.run_id, { entry: "run",
    name, source, dependencies: [], card: { purpose: "Read neutral current state", applicability: "Fixture",
      method: "No game effects", reason: "Context retention", limitations: "Not gameplay evidence" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5, compatibility_hash: state.run.compatibility_hash!,
      fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 },
  });
  const requestHelp = (topic = "game", kind?: string) => settlement([{ type: "toolCall", id: `help-${topic}${kind ? `-${kind}` : ""}`, name: "help",
    arguments: { topic, ...(kind ? { kind } : {}) } }]);
  let starts = 0;
  const execution = (skill: SkillView, args: Json = { target_id: "ROOT_ARGUMENT_NOT_CONTEXT" }) => store.admitSkill(state.run.run_id, { entry: "run",
    skill_id: skill.skill_id, version: skill.version, start_key: `context-root-${++starts}`,
    ...executionScopeFixture(state.run), args,
    limits: { duration_ms: 10000, max_actions: 4, max_calls: 8, max_depth: 1 },
  }).view;
  const reopen = async () => {
    await planner.close();
    store.close();
    const reopened = new Store(directory);
    resources.find(resource => resource.directory === directory)!.store = reopened;
    return reopened;
  };
  return { state, store, planner, adapter, turn, program, execution, requestHelp, reopen };
}
function retained(request: Context | undefined): Record<string, any> | undefined {
  for (const text of request?.systemPrompt ?? []) {
    try { const value = JSON.parse(text); if (value.strategic_context) return value.strategic_context; } catch {}
  }
  return undefined;
}

async function failedResident(f: ReturnType<typeof fixture>, failure: "held_transition" | "frame_scope" = "held_transition") {
  const decision: ControllerStepResult = { input: { kind: "world", held: {
    forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false,
  }, edges: [], view: { kind: "unchanged" }, selected_hotbar: null }, next_state: null, status: "running", events: [] };
  const skill = await f.store.registerSkill(f.state.run.run_id, { entry: "step", name: "Failing resident",
    source: `export function step(frame,state,intent) { return ${JSON.stringify(decision)}; }`, dependencies: [],
    card: { purpose: "Exercise resident failure feedback", applicability: "Fixture", method: "Invalid explicit transition",
      reason: "Surface the actual terminal diagnostic", limitations: "Not gameplay evidence" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5,
      compatibility_hash: f.state.run.compatibility_hash!, fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 } });
  const execution = f.store.admitSkill(f.state.run.run_id, { entry: "step", skill_id: skill.skill_id, version: skill.version,
    start_key: "failing-resident", ...executionScopeFixture(f.state.run), args: { target_id: "PRIVATE_RESIDENT_INTENT" },
    initial_state: { private_state: "PRIVATE_RESIDENT_STATE" }, limits: { ...DEFAULT_RESIDENT_LIMITS } }).view;
  if (execution.entry !== "step") throw new Error("Fixture did not admit its resident entry");
  const owner = { operation_id: "PRIVATE_CONTROLLER_OWNER", generation: 1, scope: {
    run_id: execution.run_id, world_id: execution.world_id!, session_id: execution.session_id!, epoch: execution.epoch,
    native_boot_id: execution.native_boot_id!, run_generation: execution.run_generation!, life_id: execution.life_id!,
    space_epoch: execution.space_epoch!, execution_id: execution.execution_id, source_hash: skill.hash,
  } };
  let retired = false, timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const done = Promise.withResolvers<ResidentSnapshot>();
  const channel: ControllerInputChannel = {
    owner, controllerGeneration: 1,
    sample: async () => controllerFrameFixture(execution.life_id! + (failure === "frame_scope" ? 1 : 0), execution.space_epoch!) as unknown as Json,
    submit: () => { throw new Error("Invalid fixture input must not be submitted"); },
    renew: async () => { throw new Error("Invalid fixture input must not renew authority"); },
    revoke: async () => {
      retired = true;
      return { owner, controller_generation: 1, admission_revoked: true, last_applied_sequence: 0,
        ordered_edge_prefix: 0, retirement_applied_native_tick: 1, retirement_applied_native_ns: "1",
        input_application: "confirmed", unresolved_operation_refs: [] };
    },
    snapshot: () => ({ fenced: retired, retired, submitted_sequence: 0, applied_sequence: 0,
      ordered_edge_prefix: 0, pending_frames: 0, pending_edges: 0, last_input: null, reason: null }),
  };
  const controller = new ResidentController({
    execution_id: execution.execution_id, source_hash: skill.hash, controller_generation: 1,
    limits: execution.limits, deadline_host_ms: 10000, initial_state: execution.initial_state, intent: execution.args,
    clock: { id: "PRIVATE_RESIDENT_HOST_CLOCK", now: () => 0,
      setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
      clearTimeout: handle => { timers.delete(handle as number); } },
    worker: { step: async () => structuredClone(decision), close: async () => {} },
    open: async () => channel, current: () => true, event: () => {}, effect: () => {},
    changed: (snapshot, terminal) => { if (terminal) done.resolve(snapshot); },
    analysis: async () => { throw new Error("Fixture does not request analysis"); },
  });
  await controller.start();
  const wake = [...timers].find(([, timer]) => timer.delay === 0);
  if (!wake) throw new Error("Resident did not schedule its first decision");
  timers.delete(wake[0]); wake[1].callback();
  execution.resident = await done.promise;
  execution.status = execution.resident.status === "failed" ? "failed" : "blocked";
  execution.ended_at = new Date().toISOString();
  execution.error = "Generated program or trusted capability failed";
  execution.diagnostic = { type: "PRIVATE_RAW_EXCEPTION", message: "PRIVATE_RAW_EXCEPTION_MESSAGE",
    source_hash: skill.hash, location: { mapping: "unmapped" } };
  f.store.updateSkillExecution(execution, "skill.closed", execution.error, { status: execution.status });
  return { skill, execution };
}

for (const [failure, status, reason] of [
  ["held_transition", "failed", "resident_step: Invalid resident held transition"],
  ["frame_scope", "stopped", "resident_frame_scope_changed"],
] as const) {
  test(`next ordinary SDK context exposes ${failure} without inspection or restored resident authority`, async () => {
    const f = fixture();
    await f.planner.start(1); await f.turn();
    const { skill, execution } = await failedResident(f, failure);
    await f.turn();
    const request = f.state.requests.at(-1), context = retained(request)!;
    const diagnostic = { status, reason };
    expect(context.latest_failure).toMatchObject({ type: "skill.closed", resident: diagnostic });
    expect(context.programs).toContainEqual(expect.objectContaining({
      name: skill.name, version: skill.version, source: skill.source,
      last_execution: expect.objectContaining({ historical: true, current_authority: false,
        gameplay_success_proof: false, resident: diagnostic }),
    }));
    const turnInput = [...request!.messages].reverse().find(message => message.role === "user");
    if (turnInput?.role !== "user") throw new Error("SDK context lacks its ordinary turn input");
    const inputText = typeof turnInput.content === "string" ? turnInput.content
      : turnInput.content.filter(part => part.type === "text").map(part => part.text).join("");
    expect(JSON.parse(inputText).executions).toContainEqual(expect.objectContaining({
      name: skill.name, resident: diagnostic,
    }));
    const serialized = JSON.stringify(request);
    for (const marker of ["PRIVATE_RESIDENT_INTENT", "PRIVATE_RESIDENT_STATE", "PRIVATE_RESIDENT_HOST_CLOCK",
      "PRIVATE_CONTROLLER_OWNER", "PRIVATE_RAW_EXCEPTION", execution.execution_id])
      expect(serialized).not.toContain(marker);
    expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
    expect(f.state.toolEffects).toBe(0);
    expect(f.state.helpEffects).toBe(0);

    await f.planner.close();
    f.state.run.task = "Replacement task must not restore prior source";
    f.store.saveRun(f.state.run); f.state.generation++;
    await f.planner.start(f.state.generation); await f.turn();
    const replaced = retained(f.state.requests.at(-1))!;
    expect(replaced.programs).toEqual([]);
    expect(replaced.latest_failure).toBeNull();
    expect(JSON.stringify(replaced)).not.toContain(reason);
    expect(f.store.skillExecution(f.state.run.run_id, { execution_id: execution.execution_id })?.status).toBe(execution.status);
    expect(f.state.toolEffects).toBe(0);
  });
}

test("compact resident diagnostics are bounded and omitted for successful or non-failure residents", async () => {
  const f = fixture(), { execution } = await failedResident(f);
  const workspace = new ProgramWorkspace(f.store, f.state.run.run_id);
  const resident = { ...execution.resident!, reason: "界".repeat(1000) };
  const summary = workspace.executionSummary({ ...execution, resident });
  expect(summary.resident).toEqual({ status: "failed", reason: "界".repeat(300) });
  expect(Object.keys(summary.resident!)).toEqual(["status", "reason"]);
  expect(workspace.executionView({ ...execution, resident })?.resident).toEqual(resident);
  for (const status of ["accepted", "running", "cancel_requested", "succeeded", "cancelled"] as const)
    expect(workspace.executionSummary({ ...execution, status, resident }).resident).toBeNull();
  for (const status of ["starting", "running", "yielded", "completed", "stopping"] as const)
    expect(workspace.executionSummary({ ...execution, resident: { ...resident, status } }).resident).toBeNull();
  for (const status of ["failed", "blocked", "unknown"] as const)
    expect(workspace.executionSummary({ ...execution, status, resident: { ...resident, reason: null } }).resident)
      .toEqual({ status: "failed", reason: null });
  expect(workspace.executionSummary({ ...execution, resident: null }).resident).toBeNull();
  expect(workspace.executionSummary({ ...f.execution(await f.program()), status: "failed" }).resident).toBeNull();
});

async function residentUncertainty(f: ReturnType<typeof fixture>, sequence = 7, summaryPadding = "") {
  const skill = await f.store.registerSkill(f.state.run.run_id, { entry: "step", name: `Resident ${sequence}`,
    source: "export function step(frame,state,intent) { return null; }", dependencies: [],
    card: { purpose: "Bounded receipt retention", applicability: "Fixture", method: "No replay",
      reason: "Historical uncertainty", limitations: "Not native proof" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5,
      compatibility_hash: f.state.run.compatibility_hash!, fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 } });
  const owner = f.store.admitSkill(f.state.run.run_id, { entry: "step", skill_id: skill.skill_id, version: 1,
    start_key: `resident-${sequence}`, ...executionScopeFixture(f.state.run), args: null, initial_state: null,
    limits: { ...DEFAULT_RESIDENT_LIMITS } }).view;
  const input: ControllerInput = { kind: "screen", screen: { screen_id: "OLD_SCREEN_HANDLE", incarnation: 1, layout_revision: 1 },
    operations: [{ kind: "key", key: "enter", phase: "press" }, { kind: "close" }] };
  const update: ControllerEffectUpdate = { controller_generation: 3, sequence, recorded_native_ns: "123456",
    result: { status: "unknown", summary: `Confirmed prefix with unknown suffix${summaryPadding}`, evidence: { effect_confirmed: false,
      transaction_status: "unknown", gui_transactions: [{ kind: "gui_transaction", mechanism: "visible_gui",
        operation_index: 0, receipt_ref: "server:prefix", input_application: "confirmed", effect_status: "confirmed",
        inventory_before: {}, inventory_after: {}, productions: [] }] } } };
  const scope = { run_id: owner.run_id, world_id: owner.world_id!, session_id: owner.session_id!,
    epoch: owner.epoch, native_boot_id: owner.native_boot_id!, run_generation: owner.run_generation!,
    life_id: owner.life_id!, space_epoch: owner.space_epoch!, execution_id: owner.execution_id, source_hash: owner.source_hash! };
  f.store.event(f.state.run.run_id, "controller.admitted", "Retained original controller grant", {
    operation_id: `controller-owner-${sequence}`, scope, invocation: { kind: "skill", execution_id: owner.execution_id,
      source_hash: owner.source_hash! }, controller_generation: 3, deadline_host_monotonic_ms: 10000 });
  retainResidentReceipt(f.store, f.adapter, owner, input, update);
  const receipt = f.store.eventsAfter(f.state.run.run_id, 0, 500).filter(event => event.type === "controller.receipted").at(-1)!;
  return { owner, receipt, scope, retire: () => f.store.event(f.state.run.run_id, "controller.retired",
    `Actual native retirement; old effects are not reversed${summaryPadding}`, jsonSchema.parse({ operation_id: `controller-owner-${sequence}`,
      ack: { owner: { operation_id: `controller-owner-${sequence}`, generation: 1, scope }, controller_generation: 3,
        admission_revoked: true, last_applied_sequence: sequence, ordered_edge_prefix: 1,
        retirement_applied_native_tick: 10, retirement_applied_native_ns: "123999",
        input_application: "confirmed", unresolved_operation_refs: [] } })) };
}

test("resident unknown receipt retains no-replay input and separate known retirement across generation, life and Store reopen", async () => {
  const f = fixture(), resident = await residentUncertainty(f);
  resident.retire();
  resident.owner.status = "cancelled"; resident.owner.ended_at = new Date().toISOString();
  f.store.updateSkillExecution(resident.owner, "skill.closed", "Stop drained known emitters", { status: "cancelled" });
  await f.planner.start(1); await f.turn();
  const first = retained(f.state.requests.at(-1))!;
  expect(first.unresolved).toHaveLength(1);
  expect(first.unresolved[0]).toMatchObject({ type: "controller.receipted", status: "unknown", no_replay: true,
    historical: true, current_authority: false, input_id: `controller:${resident.owner.execution_id}:3:7`,
    controller_generation: 3, sequence: 7, original_scope: resident.scope,
    input: { kind: "screen", operation_kinds: ["key", "close"], confirmed_operation_indexes: [0],
      unconfirmed_operation_indexes: [1] },
    containment: { type: "controller.retired", input_application: "confirmed", emitter_closed: true,
      world_effects_resolved: false } });
  expect(first.unresolved[0]).not.toHaveProperty("action_id");
  expect(JSON.stringify(first.unresolved)).not.toContain("OLD_SCREEN_HANDLE");
  await f.planner.close(); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  expect(retained(f.state.requests.at(-1))!.unresolved).toEqual(first.unresolved);
  const store = await f.reopen();
  f.state.run.life_id = 2; f.state.run.native_boot_id = "replacement-boot"; f.state.run.space_epoch = 2;
  store.saveRun(f.state.run);
  const reconstructed = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
  expect(reconstructed.unresolved).toEqual(first.unresolved);
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: reconstructed }))).toBeLessThanOrEqual(32768);
});

for (const invalid of ["source", "identity", "scope", "extra field"] as const) {
  test(`resident uncertainty rejects forged ${invalid} without borrowing execution authority`, async () => {
    const f = fixture(), resident = await residentUncertainty(f);
    const forged = structuredClone(resident.receipt.details) as any;
    // Isolate the invalid receipt: delete only this fixture's original durable row.
    const database = Reflect.get(f.store, "db") as import("bun:sqlite").Database;
    database.query("DELETE FROM events WHERE event_seq=?").run(resident.receipt.event_seq);
    if (invalid === "source") forged.scope.source_hash = "b".repeat(64);
    if (invalid === "identity") forged.input_id = "controller:foreign:3:7";
    if (invalid === "scope") forged.scope.run_generation++;
    if (invalid === "extra field") forged.update.forged = true;
    f.store.event(f.state.run.run_id, "controller.receipted", "Forged unknown receipt", forged);
    resident.retire();
    expect(JSON.parse(new StrategicContext(f.store).assemble(f.state.run)).strategic_context.unresolved).toEqual([]);
  });
}

test("resident unknown overflow stays explicitly omitted rather than resolved after known retirements and reopen", async () => {
  const f = fixture();
  for (let sequence = 1; sequence <= 11; sequence++) {
    const resident = await residentUncertainty(f, sequence); resident.retire();
    resident.owner.status = "cancelled"; resident.owner.ended_at = new Date().toISOString();
    f.store.updateSkillExecution(resident.owner, "skill.closed", "Cancelled after known retirement", { status: "cancelled" });
  }
  const store = await f.reopen(), context = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
  expect(context.unresolved).toHaveLength(8);
  expect(context.omitted_unknown_operations).toBe(3);
  expect(context.unresolved.map((entry: any) => entry.sequence)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  expect(context.unresolved.every((entry: any) => entry.no_replay && entry.containment.emitter_closed &&
    !entry.containment.world_effects_resolved)).toBe(true);
  expect(context.omissions).toContainEqual(expect.objectContaining({
    kind: "unresolved", reason: "reference_count_budget_not_resolution_no_replay" }));
});

test("resident actual containment closes only its original emitter without resolving an unknown effect", async () => {
  const f = fixture(), resident = await residentUncertainty(f);
  f.store.event(f.state.run.run_id, "controller.contained", "Actual emitter stop confirmed, world effect still unknown",
    { operation_id: "foreign-controller", input_application: "unknown" });
  const reducer = new StrategicContext(f.store);
  expect(JSON.parse(reducer.assemble(f.state.run)).strategic_context.unresolved[0]?.containment).toBeNull();
  f.store.event(f.state.run.run_id, "controller.contained", "Actual emitter stop confirmed, world effect still unknown",
    { operation_id: "controller-owner-7", input_application: "unknown" });
  expect(JSON.parse(reducer.assemble(f.state.run)).strategic_context.unresolved[0]).toMatchObject({
    no_replay: true, status: "unknown", original_scope: resident.scope,
    containment: { type: "controller.contained", emitter_closed: true, world_effects_resolved: false,
      input_application: "unknown" },
  });
});

test("resident retirement cannot annotate another generation or forged owner scope as containment", async () => {
  const f = fixture(), resident = await residentUncertainty(f), retirement = resident.retire();
  const database = Reflect.get(f.store, "db") as import("bun:sqlite").Database;
  database.query("DELETE FROM events WHERE event_seq=?").run(retirement.event_seq);
  for (const mutation of ["controller_generation", "source", "operation"] as const) {
    const details = structuredClone(retirement.details) as any;
    if (mutation === "controller_generation") details.ack.controller_generation++;
    if (mutation === "source") details.ack.owner.scope.source_hash = "c".repeat(64);
    if (mutation === "operation") details.ack.owner.operation_id = "foreign-owner";
    f.store.event(f.state.run.run_id, "controller.retired", "Foreign retirement cannot settle original emitter", details);
  }
  const context = JSON.parse(new StrategicContext(f.store).assemble(f.state.run)).strategic_context;
  expect(context.unresolved).toHaveLength(1);
  expect(context.unresolved[0]).toMatchObject({ status: "unknown", containment: null, no_replay: true });
});

test("actual next ordinary SDK request retains requested contracts and immutable source without stale observations", async () => {
  const f = fixture(), program = await f.program();
  await f.planner.start(1); await f.turn([f.requestHelp(), settlement()]);
  f.state.observation.observation_seq = 2; f.state.observation.data.player.health = 7;
  await f.turn();
  const request = f.state.requests.at(-1), context = retained(request);
  expect(context).toEqual(expect.objectContaining({ objective: "Observe neutral fixture state", current_subgoal: null }));
  expect(JSON.stringify(context?.requested_help)).toContain("Useful exact requested contract");
  expect(context?.programs).toEqual(expect.arrayContaining([expect.objectContaining({ name: program.name, version: 1, hash: program.hash, source: program.source })]));
  expect(request?.messages).toHaveLength(1);
  const message = request?.messages[0];
  if (message?.role !== "user") throw new Error("Expected the fresh strategic user request");
  const content = typeof message.content === "string" ? message.content : message.content.find(entry => entry.type === "text");
  const text = typeof content === "string" ? content : content?.type === "text" ? content.text : null;
  if (text === null) throw new Error("Fresh strategic request has no text projection");
  const projection = JSON.parse(text);
  expect(projection.adapter_state.player.health).toBe(7);
  expect(projection.observation_seq).toBe(2);
  expect(JSON.stringify(context)).not.toContain('"health":20');
});

test("actual requests retain authored intent and obstruction receipts across turns and safe Agent recreation", async () => {
  const f = fixture(), execution = f.execution(await f.program());
  f.store.updateSkillExecution(execution, "skill.progress", "Use a different approach to the observed worksite", {
    current_subgoal: "Return to the observed worksite",
    worksite: { name: "fixture workstation", position: { x: 4, y: 7, z: -2 },
      target: { target_id: "OLD_WORKSITE_HANDLE" } },
    resource_requirements: [{ name: "fixture material", count: 2 }],
    recovery_reason: "The previous approach made no sustained progress",
  });
  const obstruction = f.store.event(f.state.run.run_id, "action.failed", "Navigation exceeded the bounded geometry", {
    execution_id: execution.execution_id, action_id: "fixture-refusal",
    result: { status: "failed", summary: "Navigation exceeded the bounded geometry", evidence: {
      navigation_start_distance: 6.2, navigation_start_limit: 6, navigation_current_distance: 6.2,
      navigation_current_limit: 6, navigation_stop_reason: "start_distance_limit",
      net_displacement: 0, horizontal_displacement: 0, height_change: 0, travel_distance: 1.4,
      movement_start_on_ground: false,
      movement_end: { on_ground: true, support_within_0_15: true, headroom_1m_clear: false,
        horizontal_collision: true, vertical_collision: false },
      world_effect_emitted: false, effect_confirmed: false, neutralized: true,
      target: { target_id: "OLD_REFUSED_HANDLE" }, player: { inventory: [{ name: "STALE_INVENTORY", count: 99 }] },
    } },
  });
  execution.status = "blocked"; execution.ended_at = new Date().toISOString();
  execution.result = { status: "blocked", summary: "Procedure bound reached", result: {
    worksite: { name: "fixture workstation", position: { x: 4, y: 7, z: -2 } },
    history: [{ target: "OLD_HISTORY_HANDLE" }], inventory: [{ name: "STALE_INVENTORY", count: 99 }],
  } };
  f.store.updateSkillExecution(execution, "skill.closed", "Procedure bound reached", {});
  await f.planner.start(1); await f.turn();
  const assertContinuity = () => {
    const request = f.state.requests.at(-1)!, context = retained(request)!;
    expect(context.current_subgoal).toBe("Return to the observed worksite");
    expect(context.authored_state).toMatchObject({
      author: "model", gameplay_success_proof: false,
      worksite: { name: "fixture workstation", position: { x: 4, y: 7, z: -2 } },
      resource_requirements: [{ name: "fixture material", count: 2 }],
      recovery_reason: "The previous approach made no sustained progress",
      latest_root_result: { status: "blocked", summary: "Procedure bound reached" },
    });
    expect(context.latest_failure).toMatchObject({ event_seq: obstruction.event_seq, type: "action.failed",
      summary: "Navigation exceeded the bounded geometry", status: "failed", evidence: {
        navigation_start_distance: 6.2, navigation_start_limit: 6,
        navigation_stop_reason: "start_distance_limit", net_displacement: 0, travel_distance: 1.4,
        world_effect_emitted: false, movement_start_on_ground: false,
        movement_end: { on_ground: true, horizontal_collision: true },
      } });
    const serialized = JSON.stringify(context);
    for (const stale of ["OLD_WORKSITE_HANDLE", "OLD_REFUSED_HANDLE", "OLD_HISTORY_HANDLE", "STALE_INVENTORY", "ROOT_ARGUMENT_NOT_CONTEXT"])
      expect(serialized).not.toContain(stale);
    expect(serialized).not.toContain(execution.execution_id);
    expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
    const message = request.messages[0]!;
    if (message.role !== "user") throw new Error("Expected projected request");
    const text = typeof message.content === "string" ? message.content : message.content.find(part => part.type === "text");
    const projection = typeof text === "string" ? text : text?.type === "text" ? text.text : null;
    if (projection === null) throw new Error("Expected current projection");
    expect(JSON.parse(projection).adapter_state.player.inventory).toEqual([]);
  };
  assertContinuity();
  await f.turn(); assertContinuity();
  await f.planner.close(); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn(); assertContinuity();
  const later = f.execution(await f.program(undefined, "Changed fixture approach"));
  const move = f.store.admitAction(f.state.run.run_id, "fixture-no-net-move", {
    kind: "move", controls: { forward: true, jump: true }, duration_ms: 300,
  }, "skill", later.execution_id, skillAuthorityFixture(f.state.run, later)).action.view;
  move.status = "succeeded"; move.ended_at = new Date().toISOString(); move.summary = "Movement interval completed";
  move.result = { status: "succeeded", summary: move.summary, evidence: {
    net_displacement: 0, horizontal_displacement: 0, height_change: 0, travel_distance: 1.4,
    movement_end: { on_ground: true, horizontal_collision: true },
  } };
  f.store.saveAction(f.state.run.run_id, move);
  later.status = "blocked"; later.ended_at = new Date().toISOString();
  later.result = { status: "blocked", summary: "Different bounded approach exhausted", result: null };
  f.store.updateSkillExecution(later, "skill.closed", later.result.summary, {});
  await f.turn();
  expect(retained(f.state.requests.at(-1))?.latest_failure).toMatchObject({
    type: "skill.closed", summary: "Different bounded approach exhausted",
    action_kind: "move", action_status: "succeeded",
    evidence: { net_displacement: 0, travel_distance: 1.4, movement_end: { on_ground: true } },
  });
});

test("default purpose and arbitrary catalog source are not an authored current subgoal", async () => {
  const f = fixture();
  const skill = await f.store.registerSkill(f.state.run.run_id, { entry: "run",
    name: "Unspecified procedure", source: 'return {status:"completed",summary:"Result without intent",result:null};',
    dependencies: [], card: { purpose: "Unspecified by author", applicability: "Unspecified by author",
      method: "See immutable source", reason: "Unspecified by author", limitations: "Untested" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5, compatibility_hash: f.state.run.compatibility_hash!,
      fingerprint: "fixture", formatted_lines: 1, complexity: 1, nesting: 0 },
  });
  f.execution(skill);
  await f.planner.start(1); await f.turn();
  expect(retained(f.state.requests.at(-1))?.current_subgoal).toBeNull();
  expect(retained(f.state.requests.at(-1))?.programs).toEqual(expect.arrayContaining([expect.objectContaining({ name: skill.name })]));
});

test("actual root result preserves authored local position notes without recovering targets or deriving intent", async () => {
  const f = fixture(), execution = f.execution(await f.program());
  execution.status = "succeeded"; execution.ended_at = new Date().toISOString();
  execution.result = { status: "completed", summary: "Observed a local fixture landmark", result: {
    landmark: { position: { x: -3, y: 11, z: 2 }, target: { target_id: "STALE_LANDMARK" } },
    fixture_site: { x: 8, y: 5, z: -1 },
    inventory: [{ name: "OLD_RESOURCE_STATE", count: 12 }],
  } };
  f.store.updateSkillExecution(execution, "skill.closed", execution.result.summary, {});
  await f.planner.start(1); await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(context.authored_state.latest_root_result).toMatchObject({
    status: "completed", summary: "Observed a local fixture landmark",
    result: { landmark: { position: { x: -3, y: 11, z: 2 } } },
  });
  expect(context.authored_state.worksite).toBeUndefined();
  expect(context.authored_state.resource_requirements).toBeUndefined();
  expect(context.authored_state.returned_position_notes).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "landmark", position: { x: -3, y: 11, z: 2 } }),
    expect.objectContaining({ field: "fixture_site", position: { x: 8, y: 5, z: -1 } }),
  ]));
  expect(JSON.stringify(context)).not.toContain("STALE_LANDMARK");
  expect(JSON.stringify(context)).not.toContain("OLD_RESOURCE_STATE");
  const later = f.execution(await f.program(undefined, "Later fixture procedure"));
  later.status = "blocked"; later.ended_at = new Date().toISOString();
  later.result = { status: "blocked", summary: "A different local obstruction", result: { reason: "Fresh observation needed" } };
  f.store.updateSkillExecution(later, "skill.closed", later.result.summary, {});
  await f.turn();
  await f.planner.close(); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  expect(retained(f.state.requests.at(-1))?.authored_state.returned_position_notes).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "landmark", position: { x: -3, y: 11, z: 2 } }),
    expect.objectContaining({ field: "fixture_site", position: { x: 8, y: 5, z: -1 } }),
  ]));
});

test("authored continuity stays bounded and field omissions do not erase earlier explicit worksite notes", async () => {
  const f = fixture(), execution = f.execution(await f.program());
  f.store.updateSkillExecution(execution, "skill.progress", "Keep the observed worksite note", {
    current_subgoal: "Reach fixture worksite", worksite: { position: { x: 2, y: 3, z: 4 } },
    resource_requirements: [{ name: "fixture material", count: 2 }],
  });
  await f.planner.start(1); await f.turn();
  f.store.updateSkillExecution(execution, "skill.progress", "Changed bounded recovery", {
    current_subgoal: "Reobserve the obstruction", recovery_reason: "Changed after no net progress",
    resource_requirements: Array.from({ length: 80 }, () => ({ name: "界".repeat(1000), count: 2 })),
  });
  await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(context.current_subgoal).toBe("Reobserve the obstruction");
  expect(context.authored_state.worksite).toEqual({ position: { x: 2, y: 3, z: 4 } });
  expect(context.authored_state.recovery_reason).toBe("Changed after no net progress");
  expect(context.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "authored_state" })]));
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
  f.store.updateSkillExecution(execution, "skill.progress", "Clear superseded intent notes", {
    current_subgoal: null, worksite: null, resource_requirements: null, recovery_reason: null,
  });
  await f.turn();
  expect(retained(f.state.requests.at(-1))).toMatchObject({
    current_subgoal: null, authored_state: { worksite: null, resource_requirements: null, recovery_reason: null },
  });
});

test("actual continuation after help receives newly requested useful context in the same turn", async () => {
  const f = fixture(); await f.planner.start(1); await f.turn([f.requestHelp(), settlement()]);
  expect(f.state.requests).toHaveLength(2);
  expect(JSON.stringify(retained(f.state.requests[1])?.requested_help)).toContain("fixture_read");
});

test("distinct selected action contracts remain usable after later help and Agent recreation", async () => {
  const f = fixture();
  await f.program(`/*${"s".repeat(9000)}*/return {status:"completed",summary:"Retained candidate",result:null};`);
  for (const kind of ["craft", "attack"])
    f.state.helpResults[`actions:${kind}`] = JSON.parse(JSON.stringify(programHelp("actions", f.adapter, kind)));
  f.state.helpResults.actions = JSON.parse(JSON.stringify(programHelp("actions", f.adapter)));
  await f.planner.start(1);
  await f.turn([f.requestHelp("actions"), f.requestHelp("actions", "craft"), f.requestHelp("actions", "attack"), settlement()]);
  const check = () => {
    const context = retained(f.state.requests.at(-1))!;
    const craft = context.requested_help.find((entry: any) => entry.topic === "actions:craft" && entry.section === "schema")?.content;
    const attack = context.requested_help.find((entry: any) => entry.topic === "actions:attack" && entry.section === "schema")?.content;
    expect(validateJsonSchemaValue(craft, { kind: "craft", item: "stick", executions: 1 }).success).toBe(true);
    expect(validateJsonSchemaValue(craft, { kind: "craft", sequence: [{ item: "stick", executions: 1 }] }).success).toBe(true);
    expect(validateJsonSchemaValue(craft, { kind: "craft", item: "stick", executions: 17 }).success).toBe(false);
    const target = { target_id: "schema-only-not-issued-authority", incarnation: 1,
      space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, life_id: 1 };
    expect(validateJsonSchemaValue(attack, { kind: "attack", target }).success).toBe(true);
    expect(validateJsonSchemaValue(attack, { kind: "attack", target: { target_id: target.target_id } }).success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
  };
  check();
  await f.planner.close(); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  check();
  expect(f.state.toolEffects).toBe(0);
});

for (const topics of [["programs", "game"], ["game", "programs"]]) test(`actual requested mechanics survive source pressure after help ${topics.join(" then ")}`, async () => {
  const f = fixture(), program = await f.program(`/*${"s".repeat(9000)}*/return {status:"completed",summary:"reference",result:null};`);
  const programs = JSON.parse(JSON.stringify(programHelp("programs", f.adapter)));
  const game = JSON.parse(JSON.stringify(programHelp("game", f.adapter)));
  f.state.helpResults.programs = programs;
  f.state.helpResults.game = game;
  await f.planner.start(1);
  await f.turn([...topics.map(topic => f.requestHelp(topic)), settlement()]);
  await f.turn();
  const assertRequestedReferences = () => {
    const request = f.state.requests.at(-1)!, context = retained(request)!;
    expect(request.messages).toHaveLength(1);
    for (const [section, content] of [
      ["resident.contract", programs.resident.contract],
      ["resident.operations", programs.resident.operations],
      ["resident.input_transitions", programs.resident.input_transitions],
      ["resident.gui_completion", programs.resident.gui_completion],
      ["resident.sensing", programs.resident.sensing],
    ]) {
      expect(context.requested_help).toContainEqual({ topic: "programs", section, content });
    }
    expect(context.requested_help).toContainEqual({ topic: "game", section: "methods.observe", content: game.methods.observe });
    const capability = f.adapter.action_capability!;
    const actionSchema = game.schemas.capabilities[`${capability.id}@${capability.version}`];
    const union = Array.isArray(actionSchema.oneOf) ? "oneOf" : "anyOf";
    const alternatives = actionSchema[union];
    expect(Array.isArray(alternatives)).toBe(true);
    const mechanics = alternatives.map((branch: any, index: number) => ({ branch, index }))
      .filter(({ branch }: any) => ["move", "craft"].includes(branch.properties?.kind?.const));
    expect(mechanics.filter(({ branch }: any) => branch.properties.kind.const === "move")).toHaveLength(1);
    expect(mechanics.filter(({ branch }: any) => branch.properties.kind.const === "craft")).toHaveLength(2);
    for (const { index: actionIndex } of mechanics) {
      // Accept an enclosing schema, never detached properties with missing bounds.
      const path = ["schemas", "capabilities", `${capability.id}@${capability.version}`, union, actionIndex];
      let reference = "", retainedAction: unknown;
      for (let index = 0; index < path.length; index++) {
        const key = path[index]!;
        reference += typeof key === "number" ? `[${key}]` : `${index ? "." : ""}${key}`;
        const section = context.requested_help.find((entry: any) => entry.topic === "game" && entry.section === reference);
        if (!section) continue;
        retainedAction = path.slice(index + 1).reduce((value: any, child) => value?.[child], section.content);
        if (retainedAction !== undefined) break;
      }
      expect(retainedAction).toEqual(alternatives[actionIndex]);
    }
    expect(context.requested_help).toContainEqual({
      topic: "programs", section: "temporal_turn", content: programs.temporal_turn,
    });
    for (const [name, method] of Object.entries(game.methods) as [string, any][]) {
      if (!method.result_schema) continue;
      expect(context.requested_help).toContainEqual({
        topic: "game", section: `methods.${name}.invocation`, content: method.invocation,
      });
      expect(context.requested_help).toContainEqual({
        topic: "game", section: `methods.${name}.parameters`, content: method.parameters,
      });
    }
    expect(context.programs).toContainEqual(expect.objectContaining({ name: program.name, source: program.source }));
    expect(context.omissions).toContainEqual(expect.objectContaining({ kind: "help", reason: "retained_help_byte_budget" }));
    expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
    expect(context.requested_help.reduce((sum: number, section: unknown) => sum + Buffer.byteLength(JSON.stringify(section)), 0)).toBeLessThanOrEqual(24576);
  };
  assertRequestedReferences();
  await f.planner.close(); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  assertRequestedReferences();
});

test("action alternatives retain exact constraints under schema pressure and omit oversized alternatives atomically", async () => {
  const f = fixture();
  const source = `/*${"s".repeat(12000)}*/return {status:"completed",summary:"reference",result:null};`;
  const program = await f.program(source);
  const capability = f.adapter.action_capability!;
  const actionSection = `schemas.capabilities.${capability.id}@${capability.version}`;
  const branch = { type: "object", properties: {
    kind: { const: "fixture_action" }, mode: { enum: ["first", "second"] },
    duration_ms: { type: "integer", minimum: 50, maximum: 2000 },
  }, required: ["kind", "mode", "duration_ms"], additionalProperties: false };
  const oversized = { ...branch, description: "x".repeat(7000) };
  f.state.helpResults.game = { schemas: {
    ObservationV3: { $schema: "https://json-schema.org/draft/2020-12/schema",
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) =>
        [`reference_${index}`, { type: "string", description: "o".repeat(5000) }])) },
    capabilities: { [`${capability.id}@${capability.version}`]: {
      $schema: "https://json-schema.org/draft/2020-12/schema", anyOf: [branch, oversized],
    } },
  } };
  await f.planner.start(1); await f.turn([f.requestHelp("game"), settlement()]);
  await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(f.state.requests.at(-1)!.messages).toHaveLength(1);
  expect(context.requested_help).toContainEqual({ topic: "game", section: `${actionSection}.anyOf[0]`, content: branch });
  expect(context.requested_help.some((entry: any) => entry.section.startsWith(`${actionSection}.anyOf[1]`))).toBe(false);
  expect(context.omissions).toContainEqual({ kind: "help", reference: `game.${actionSection}.anyOf[1]`,
    reason: "section_byte_budget", original_bytes: Buffer.byteLength(JSON.stringify(oversized)) });
  expect(context.omissions).toContainEqual(expect.objectContaining({
    kind: "help", reference: expect.stringContaining("game.schemas.ObservationV3."), reason: "retained_help_byte_budget",
  }));
  expect(context.omissions).toContainEqual(expect.objectContaining({
    kind: "help", reference: expect.stringContaining("game.schemas.ObservationV3."), reason: "request_byte_budget",
  }));
  expect(context.programs).toContainEqual(expect.objectContaining({ name: program.name, source }));
  expect(context.objective).toBe(f.state.run.task);
  expect(context.requested_help.reduce((sum: number, entry: unknown) => sum + Buffer.byteLength(JSON.stringify(entry)), 0))
    .toBeLessThanOrEqual(24576);
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
});

test("final SDK context allocates action contracts before historical unknown receipt detail", async () => {
  const f = fixture();
  const historical = [];
  for (let sequence = 1; sequence <= 8; sequence++) {
    const resident = await residentUncertainty(f, sequence, " historical-receipt-detail".repeat(20));
    const retirement = resident.retire();
    resident.owner.status = "cancelled"; resident.owner.ended_at = new Date().toISOString();
    f.store.updateSkillExecution(resident.owner, "skill.closed", "Old owner terminal after retirement", { status: "cancelled" });
    historical.push({ ...resident, retirement });
  }
  const program = await f.program(`/*${"s".repeat(2500)}*/return {status:"completed",summary:"retained-source",result:null};`);
  const capability = f.adapter.action_capability!;
  const branches = ["move", "craft"].map(kind => ({
    type: "object", properties: { kind: { const: kind }, duration_ms: { type: "integer", minimum: 50, maximum: 2000 },
      mode: { enum: ["first", "second"] } }, required: ["kind", "duration_ms", "mode"],
    additionalProperties: false, description: `${kind} exact bounded contract ${"a".repeat(1700)}`,
  }));
  const programs = JSON.parse(JSON.stringify(programHelp("programs", f.adapter)));
  f.state.helpResults.programs = programs;
  f.state.helpResults.game = {
    methods: { observe: { invocation: "await game.observe()", authority: "Fresh authorized observation only" } },
    schemas: { capabilities: { [`${capability.id}@${capability.version}`]: {
      $schema: "https://json-schema.org/draft/2020-12/schema", anyOf: branches,
    } }, ObservationV3: { $schema: "https://json-schema.org/draft/2020-12/schema",
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`reference_${index}`, {
        type: "string", description: "d".repeat(5000),
      }])) } },
  };
  await f.planner.start(1);
  await f.turn([f.requestHelp("programs"), f.requestHelp("game"), settlement()]);
  await f.turn();
  const request = f.state.requests.at(-1)!, context = retained(request)!;
  expect(request.messages).toHaveLength(1);
  expect(context.unresolved).toHaveLength(8);
  expect(context.omitted_unknown_operations).toBe(0);
  for (const [index, resident] of historical.entries()) {
    expect(context.unresolved[index]).toMatchObject({
      event_seq: resident.receipt.event_seq, status: "unknown", no_replay: true, historical: true, current_authority: false,
      original_scope: resident.scope, input_id: `controller:${resident.owner.execution_id}:3:${index + 1}`,
      input: { kind: "screen", operation_kinds: ["key", "close"],
        confirmed_operation_indexes: [0], unconfirmed_operation_indexes: [1] },
      containment: { event_seq: resident.retirement.event_seq, type: "controller.retired", emitter_closed: true,
        world_effects_resolved: false, input_application: "confirmed" },
    });
  }
  const omittedDetails = context.unresolved.flatMap((entry: any) => [entry, entry.containment])
    .filter((entry: any) => entry.detail_omitted);
  expect(omittedDetails.length).toBeGreaterThan(0);
  expect(omittedDetails.every((entry: any) => !("summary" in entry) && !("result_summary" in entry))).toBe(true);
  expect(context.omitted_records).toBeGreaterThanOrEqual(omittedDetails.length);
  expect(JSON.stringify(context)).not.toContain("OLD_SCREEN_HANDLE");
  expect(context.programs).toContainEqual(expect.objectContaining({ name: program.name, hash: program.hash, source: program.source }));
  expect(context.programs).toContainEqual(expect.objectContaining({
    name: "Resident 8", last_execution: expect.objectContaining({
      historical: true, current_authority: false, status: "cancelled",
      original_scope: expect.objectContaining({ world_id: historical[7]!.scope.world_id,
        session_id: historical[7]!.scope.session_id, life_id: historical[7]!.scope.life_id }),
    }),
  }));
  for (const [index, content] of branches.entries()) {
    const path = ["schemas", "capabilities", `${capability.id}@${capability.version}`, "anyOf", index];
    let reference = "", retainedAction: unknown;
    for (let depth = 0; depth < path.length; depth++) {
      const key = path[depth]!;
      reference += typeof key === "number" ? `[${key}]` : `${depth ? "." : ""}${key}`;
      const section = context.requested_help.find((entry: any) => entry.topic === "game" && entry.section === reference);
      if (!section) continue;
      retainedAction = path.slice(depth + 1).reduce((value: any, child) => value?.[child], section.content);
      if (retainedAction !== undefined) break;
    }
    expect(retainedAction).toEqual(content);
  }
  for (const section of ["contract", "input_transitions", "gui_completion"])
    expect(context.requested_help).toContainEqual({ topic: "programs", section: `resident.${section}`, content: programs.resident[section] });
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32 * 1024);
  expect(context.programs.reduce((sum: number, entry: unknown) => sum + Buffer.byteLength(JSON.stringify(entry)), 0))
    .toBeLessThanOrEqual(18 * 1024);
  expect(context.requested_help.reduce((sum: number, entry: unknown) => sum + Buffer.byteLength(JSON.stringify(entry)), 0))
    .toBeLessThanOrEqual(24 * 1024);
  const stored = f.store.eventsAfter(f.state.run.run_id, historical[0]!.receipt.event_seq - 1, 1)[0]!;
  expect((stored.details as any).update.result.summary).toContain("historical-receipt-detail");
});

test("low-pressure unknown evidence restoration retains original partial flags and known zero displacement", () => {
  const f = fixture(), evidence = { navigation_stop_reason: "partial-reason".repeat(50), net_displacement: 0 };
  const unknown = f.store.event(f.state.run.run_id, "runtime.uncertainty", "Historical operation with partial evidence", {
    action_id: "partial-evidence-operation", result: { status: "unknown", evidence },
  });
  const containment = f.store.event(f.state.run.run_id, "runtime.uncertainty_blocked", "Emitter closed, effect unresolved", {
    action_id: "partial-evidence-operation", result: { status: "unknown", evidence },
  });
  const context = JSON.parse(new StrategicContext(f.store).assemble(f.state.run)).strategic_context;
  expect(context.unresolved[0]).toMatchObject({
    event_seq: unknown.event_seq, no_replay: true, status: "unknown", evidence_omitted: true,
    evidence: { navigation_stop_reason: evidence.navigation_stop_reason.slice(0, 400), net_displacement: 0 },
    containment: { event_seq: containment.event_seq, evidence_omitted: true,
      evidence: { navigation_stop_reason: evidence.navigation_stop_reason.slice(0, 400), net_displacement: 0 } },
  });
  expect(context.unresolved[0]).not.toHaveProperty("detail_omitted");
  expect(context.unresolved[0].containment).not.toHaveProperty("detail_omitted");
  expect(context.omitted_records).toBe(0);
  expect((f.store.eventsAfter(f.state.run.run_id, unknown.event_seq - 1, 1)[0]!.details as any).result.evidence).toEqual(evidence);
});

for (const status of ["unknown", "refused"] as const) {
  test(`actual requests preserve persisted-but-${status} submission after clearing and Agent recreation`, async () => {
    const f = fixture(), program = await f.program();
    const outcome = { source: { status: "persisted", name: program.name, version: program.version },
      start: { status, error: { code: "backend_unavailable", message: `Submission start ${status}`, retryable: false } } };
    f.state.submitResult = outcome;
    await f.planner.start(1);
    await f.turn([settlement([{ type: "toolCall", id: "stable-submission-identity", name: "program_submit",
      arguments: { args: { target_id: "DO_NOT_RETAIN_SUBMISSION_ARGUMENTS" } } }]), settlement()]);
    expect(f.store.latestRootExecution(f.state.run.run_id)).toBeNull();
    const assertOutcome = () => {
      const context = retained(f.state.requests.at(-1));
      const expected = expect.objectContaining({ tool: "program_submit", source: outcome.source, start: outcome.start });
      expect(context?.latest_failure).toEqual(expected);
      if (status === "unknown") {
        expect(context?.unresolved).toHaveLength(1);
        expect(context?.unresolved).toEqual(expect.arrayContaining([
          expect.objectContaining({ tool: "program_submit", source: outcome.source, start: outcome.start, status: "unknown", no_replay: true }),
        ]));
      }
      else expect(context?.unresolved).toEqual([]);
      expect(JSON.stringify(context)).not.toContain("DO_NOT_RETAIN_SUBMISSION_ARGUMENTS");
      expect(JSON.stringify(context)).not.toContain("stable-submission-identity");
      expect(context?.programs).toEqual(expect.arrayContaining([expect.objectContaining({ hash: program.hash, source: program.source })]));
    };
    await f.turn(); assertOutcome();
    await f.planner.close(); f.state.generation++;
    await f.planner.start(f.state.generation); await f.turn(); assertOutcome();
    expect(f.state.toolEffects).toBe(1);
  });
}

test("safe Agent recreation retains compatible help/source and consequential unknown after feedback was consumed", async () => {
  const f = fixture(), program = await f.program();
  const execution = f.store.admitSkill(f.state.run.run_id, { entry: "run", skill_id: program.skill_id, version: 1,
    start_key: "unknown-fixture", ...executionScopeFixture(f.state.run), args: { target_id: "STALE_TARGET_MUST_NOT_SURVIVE" },
    limits: { duration_ms: 10000, max_actions: 1, max_calls: 2, max_depth: 1 } }).view;
  execution.status = "unknown"; execution.error = "Effect application remains unknown";
  execution.ended_at = new Date().toISOString();
  f.store.updateSkillExecution(execution, "skill.closed", "Uncertain neutral operation", { status: "unknown", execution_id: execution.execution_id });
  f.store.event(f.state.run.run_id, "runtime.uncertainty", "Application was not confirmed", { action_id: "unknown-operation", status: "unknown", life_id: 1 });
  f.store.event(f.state.run.run_id, "runtime.uncertainty_reconciled", "Emitters closed, outcome still unknown", { action_id: "unknown-operation", life_id: 1, no_replay: true });
  await f.planner.start(1); await f.turn([f.requestHelp(), settlement()]);
  await f.planner.close(); f.state.generation++; await f.planner.start(f.state.generation); await f.turn();
  const request = f.state.requests.at(-1), context = retained(request);
  expect(f.state.creates).toBe(2);
  expect(JSON.stringify(context?.requested_help)).toContain("Useful exact requested contract");
  expect(context?.programs).toEqual(expect.arrayContaining([expect.objectContaining({ hash: program.hash, source: program.source })]));
  expect(context?.latest_failure).toEqual(expect.objectContaining({ summary: "Application was not confirmed" }));
  expect(JSON.stringify(context?.unresolved)).toContain("unknown");
  expect(JSON.stringify(context)).not.toContain("STALE_TARGET_MUST_NOT_SURVIVE");
  expect(JSON.stringify(context)).not.toContain(execution.execution_id);
});

for (const presentation of ["root", "tools"] as const) {
  test(`actual recreated request retains bounded read-only help after changing ${presentation}`, async () => {
    const f = fixture(); await f.planner.start(1); await f.turn([f.requestHelp(), settlement()]);
    await f.planner.close();
    if (presentation === "root") f.state.root = "Changed role and root prose";
    else f.state.toolSchema = "Changed dispatch catalog";
    f.state.generation++; await f.planner.start(f.state.generation); await f.turn();
    const context = retained(f.state.requests.at(-1))!;
    expect(JSON.stringify(context.requested_help)).toContain("Useful exact requested contract");
    expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
    expect(f.state.toolEffects).toBe(0);
  });
}

for (const incompatible of ["adapter", "profile", "api", "provider"] as const) {
  test(`actual recreated request drops help incompatible with changed ${incompatible}`, async () => {
    const f = fixture(), program = await f.program(); await f.planner.start(1); await f.turn([f.requestHelp(), settlement()]);
    await f.planner.close();
    if (incompatible === "adapter") f.state.run.compatibility_hash = "b".repeat(64);
    if (incompatible === "profile") {
      // Change the actual negotiated profile, not just one envelope hash:
      // the real adapter rightly rejects mismatched observations before inference.
      f.state.adapter = minecraftTestAdapter("precise");
      f.state.observation = minecraftObservationFixture(f.state.adapter);
      f.state.run.compatibility_hash = f.state.observation.compatibility_hash;
    }
    if (incompatible === "api") f.state.selectedModel = { ...f.state.selectedModel, api: "openai-responses" };
    if (incompatible === "provider") f.state.selectedModel = { ...f.state.selectedModel, provider: "openai" };
    f.state.generation++; await f.planner.start(f.state.generation); await f.turn();
    expect(retained(f.state.requests.at(-1))).toBeDefined();
    expect(JSON.stringify(retained(f.state.requests.at(-1))?.requested_help)).not.toContain("Useful exact requested contract");
    if (incompatible === "adapter" || incompatible === "profile") expect(retained(f.state.requests.at(-1))?.programs).toEqual([]);
    else expect(retained(f.state.requests.at(-1))?.programs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: program.name, hash: program.hash, source: program.source }),
    ]));
  });
}

test("program execution samples clear with executable compatibility but survive provider-only request changes", async () => {
  const f = fixture(), skill = await f.program(), execution = f.execution(skill, { count: 2, mode: "read" });
  execution.status = "blocked"; execution.ended_at = new Date().toISOString();
  execution.result = { status: "blocked", summary: "A local author-defined bound", result: { remaining: 1 } };
  f.store.updateSkillExecution(execution, "skill.closed", execution.result.summary);
  const reducer = new StrategicContext(f.store), context: Context = { systemPrompt: [], messages: [] };
  reducer.synchronize(f.state.run, model(), context, f.state.observation, f.adapter);
  const first = JSON.parse(reducer.assemble(f.state.run)).strategic_context;
  expect(first.programs[0].last_execution.argument_sample).toEqual({ count: 2, mode: "read" });
  reducer.synchronize(f.state.run, { api: "openai-responses", provider: "openai" }, context, f.state.observation, f.adapter);
  expect(JSON.parse(reducer.assemble(f.state.run)).strategic_context.programs[0].last_execution).toEqual(first.programs[0].last_execution);
  reducer.synchronize(f.state.run, model(), context, { ...f.state.observation, profile_configuration_hash: "replaced-profile" }, f.adapter);
  expect(JSON.parse(reducer.assemble(f.state.run)).strategic_context.programs).toEqual([]);
});

test("fresh cold run and changed task/world/life cannot inherit prior source or dynamic failures", async () => {
  const f = fixture(), execution = f.execution(await f.program());
  f.store.updateSkillExecution(execution, "skill.progress", "Private prior-episode intent", {
    current_subgoal: "OLD_EPISODE_SUBGOAL", worksite: { name: "OLD_EPISODE_WORKSITE" },
  });
  f.store.event(f.state.run.run_id, "action.failed", "OLD_FAILURE_MUST_NOT_SURVIVE", { life_id: 1 });
  await f.planner.start(1); await f.turn([f.requestHelp(), settlement()]); await f.planner.close();
  f.planner.reset();
  f.state.run = minecraftRunFixture(f.adapter, { task: "New neutral task", model_id: model().id, world_id: "new-world", life_id: 2 });
  f.state.observation = minecraftObservationFixture(f.adapter, { world_id: "new-world", life: { life_id: 2, status: "alive", can_respawn: false, death: null } });
  f.store.saveRun(f.state.run); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  const context = retained(f.state.requests.at(-1));
  expect(context).toEqual(expect.objectContaining({ objective: "New neutral task", programs: [], latest_failure: null, unresolved: [] }));
  expect(JSON.stringify(context)).not.toContain("neutral-source-marker");
  expect(JSON.stringify(context)).not.toContain("OLD_FAILURE_MUST_NOT_SURVIVE");
  expect(JSON.stringify(context)).not.toContain("OLD_EPISODE_SUBGOAL");
  expect(JSON.stringify(context)).not.toContain("OLD_EPISODE_WORKSITE");
});

test("request context stays bounded with explicit source/help omissions without truncating immutable source", async () => {
  const f = fixture();
  const source = `/*${"x".repeat(16000)}*/return {status:"completed",summary:"large",result:null};`;
  await f.program(source.replace("large", "other"), "Other procedure");
  const program = await f.program(source);
  f.state.helpPadding = "p".repeat(12000);
  await f.planner.start(1); await f.turn([f.requestHelp(), f.requestHelp("programs"), settlement()]);
  const context = retained(f.state.requests.at(-1));
  expect(context).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
  expect(context?.programs).toEqual(expect.arrayContaining([expect.objectContaining({ hash: program.hash, source })]));
  expect(context?.contracts).toBeDefined(); expect(context?.omissions.length).toBeGreaterThan(0);
});

test("life changes fence current notes and failures but preserve historical no-replay and explicit worksite notes", async () => {
  const f = fixture();
  const execution = f.execution(await f.program());
  f.store.updateSkillExecution(execution, "skill.progress", "Old life intent", {
    current_subgoal: "OLD_LIFE_SUBGOAL", worksite: { name: "OLD_LIFE_WORKSITE", position: { x: 1, y: 2, z: 3 } },
    resource_requirements: [{ name: "OLD_LIFE_REQUIREMENT", count: 2 }],
  });
  f.store.event(f.state.run.run_id, "runtime.uncertainty", "OLD_LIFE_UNKNOWN", {
    action_id: "old-life-operation", status: "unknown", life_id: 1,
  });
  await f.planner.start(1); await f.turn(); await f.planner.close();
  f.state.run.life_id = 2;
  f.state.observation.life.life_id = 2; f.state.observation.observation_seq = 3;
  f.store.saveRun(f.state.run); f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(context.latest_failure).toBeNull();
  expect(context.unresolved).toEqual([expect.objectContaining({
    summary: "OLD_LIFE_UNKNOWN", no_replay: true, historical: true, current_authority: false,
    original_scope: expect.objectContaining({ life_id: 1 }),
  })]);
  expect(context.historical_authored_state.notes).toContainEqual(expect.objectContaining({
    field: "worksite", value: { name: "OLD_LIFE_WORKSITE", position: { x: 1, y: 2, z: 3 } },
    original_scope: expect.objectContaining({ life_id: 1 }),
  }));
  for (const marker of ["OLD_LIFE_SUBGOAL", "OLD_LIFE_WORKSITE", "OLD_LIFE_REQUIREMENT"])
    expect(JSON.stringify(retained(f.state.requests.at(-1))?.authored_state)).not.toContain(marker);
});

for (const changed of ["task", "world"] as const) {
  test(`same-run ${changed} replacement drops prior source and dynamic experience`, async () => {
    const f = fixture(), execution = f.execution(await f.program());
    f.store.updateSkillExecution(execution, "skill.progress", "Old task intent", {
      current_subgoal: "OLD_TASK_SUBGOAL", worksite: { name: "OLD_TASK_WORKSITE" },
    });
    f.store.event(f.state.run.run_id, "runtime.uncertainty", "OLD_TASK_UNKNOWN", {
      action_id: "old-task-operation", status: "unknown", life_id: 1,
    });
    await f.planner.start(1); await f.turn(); await f.planner.close();
    if (changed === "task") f.state.run.task = "Replacement neutral objective";
    else {
      f.state.run.world_id = "replacement-world";
      f.state.observation.world_id = "replacement-world";
    }
    f.store.saveRun(f.state.run); f.state.generation++;
    await f.planner.start(f.state.generation); await f.turn();
    expect(retained(f.state.requests.at(-1))).toEqual(expect.objectContaining({ programs: [], latest_failure: null, unresolved: [] }));
    expect(JSON.stringify(retained(f.state.requests.at(-1)))).not.toContain("neutral-source-marker");
    expect(JSON.stringify(retained(f.state.requests.at(-1)))).not.toContain("OLD_TASK_SUBGOAL");
    expect(JSON.stringify(retained(f.state.requests.at(-1)))).not.toContain("OLD_TASK_WORKSITE");
  });
}

for (const changed of ["session", "boot", "space"] as const) {
  test(`changed ${changed} clears authored dynamic notes without declaring old unknown effects resolved`, async () => {
    const f = fixture(), execution = f.execution(await f.program());
    f.store.updateSkillExecution(execution, "skill.progress", "Prior authority's authored state", {
      current_subgoal: "OLD_SCOPE_INTENT", worksite: { position: { x: 1, y: 2, z: 3 } },
    });
    f.store.event(f.state.run.run_id, "runtime.uncertainty", "PRIOR_UNKNOWN_EFFECT", {
      action_id: "scope-unknown-operation", life_id: 1, session_id: f.state.run.session_id,
    });
    await f.planner.start(1); await f.turn(); await f.planner.close();
    if (changed === "session") {
      f.state.run.session_id = "replacement-session"; f.state.observation.session_id = "replacement-session";
    } else if (changed === "boot") {
      f.state.run.native_boot_id = "replacement-boot"; f.state.observation.native_boot_id = "replacement-boot";
    } else {
      f.state.run.space_epoch = 2; f.state.observation.space.space_epoch = 2;
    }
    f.store.saveRun(f.state.run); f.state.generation++;
    await f.planner.start(f.state.generation); await f.turn();
    const context = retained(f.state.requests.at(-1))!;
    expect(context.authored_state.current_subgoal).toBeUndefined();
    expect(context.authored_state.worksite).toBeUndefined();
    expect(JSON.stringify(context.authored_state)).not.toContain("OLD_SCOPE_INTENT");
    expect(context.unresolved).toEqual([
      expect.objectContaining({ summary: "PRIOR_UNKNOWN_EFFECT", status: "unknown", no_replay: true }),
    ]);
    expect(context.historical_authored_state.notes).toContainEqual(expect.objectContaining({
      field: "worksite", value: { position: { x: 1, y: 2, z: 3 } }, current_authority: false,
    }));
  });
}

test("fresh scoped authored progress before the next post-life-change request is not discarded", async () => {
  const f = fixture(), skill = await f.program();
  await f.planner.start(1); await f.turn(); await f.planner.close();
  f.state.run.life_id = 2; f.state.observation.life.life_id = 2; f.store.saveRun(f.state.run);
  const execution = f.execution(skill);
  f.store.updateSkillExecution(execution, "skill.progress", "Intent explicitly authored in the new life", {
    current_subgoal: "Reacquire the fixture worksite", resource_requirements: null,
  });
  f.state.generation++; await f.planner.start(f.state.generation); await f.turn();
  expect(retained(f.state.requests.at(-1))?.current_subgoal).toBe("Reacquire the fixture worksite");
});

test("confirmed continuing recovery root retains only notes authored after new-life adoption", async () => {
  const f = fixture(), execution = f.execution(await f.program());
  await f.planner.start(1); await f.turn(); await f.planner.close();
  f.store.updateSkillExecution(execution, "skill.progress", "Before adoption", {
    current_subgoal: "OLD_RECOVERY_INTENT", worksite: { position: { x: 1, y: 2, z: 3 } },
  });
  f.state.run.life_id = 2; f.state.run.space_epoch = 2;
  f.state.observation.life.life_id = 2; f.state.observation.space.space_epoch = 2;
  f.store.saveRun(f.state.run);
  f.store.event(f.state.run.run_id, "skill.life_adopted", "Confirmed chosen root adopted new life", {
    execution_id: execution.execution_id, root_execution_id: execution.root_execution_id,
    session_id: f.state.run.session_id, previous_life_id: 1, life_id: 2,
    native_boot_id: f.state.run.native_boot_id, space_epoch: 2,
  });
  f.store.updateSkillExecution(execution, "skill.progress", "Freshly observed after adoption", {
    current_subgoal: "Reacquire the new-life worksite", worksite: { position: { x: 8, y: 4, z: 2 } },
  });
  execution.status = "succeeded"; execution.ended_at = new Date().toISOString();
  execution.result = { status: "completed", summary: "Fresh recovery notes", result: {
    fresh_landmark: { x: 8, y: 4, z: 2 },
  } };
  f.store.updateSkillExecution(execution, "skill.closed", execution.result.summary, {});
  f.state.generation++; await f.planner.start(f.state.generation); await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(context.current_subgoal).toBe("Reacquire the new-life worksite");
  expect(context.authored_state.worksite).toEqual({ position: { x: 8, y: 4, z: 2 } });
  expect(context.authored_state.returned_position_notes).toContainEqual(
    expect.objectContaining({ field: "fresh_landmark", position: { x: 8, y: 4, z: 2 } }));
  expect(JSON.stringify(context.authored_state)).not.toContain("OLD_RECOVERY_INTENT");
  expect(f.store.skillExecution(f.state.run.run_id, { execution_id: execution.execution_id })?.life_id).toBe(1);
});

test("reopened Store reconstructs dispatched skill.unknown without an action and never reopens Stop", async () => {
  const f = fixture(), execution = f.execution(await f.program());
  execution.status = "running"; execution.started_at = new Date().toISOString();
  f.store.updateSkillExecution(execution, "skill.started", "Dispatched before process loss");
  f.state.run.status = "stopped";
  f.store.saveRun(f.state.run);
  const store = await f.reopen();
  store.reconcileSkillExecutions(f.state.run.run_id);
  const context = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
  expect(context.latest_failure).toMatchObject({ type: "skill.unknown", status: "unknown" });
  expect(context.unresolved).toEqual([expect.objectContaining({
    type: "skill.unknown", status: "unknown", no_replay: true, historical: true, current_authority: false,
    original_scope: expect.objectContaining({ life_id: 1, world_id: f.state.run.world_id }),
  })]);
  expect(store.selectedAction(f.state.run.run_id, "latest")).toBeNull();
  store.reconcileSkillExecutions(f.state.run.run_id);
  expect(store.getRun(f.state.run.run_id)?.status).toBe("stopped");
  expect(store.skillExecution(f.state.run.run_id, { execution_id: execution.execution_id })?.status).toBe("unknown");
  expect(JSON.stringify(context)).not.toContain(execution.execution_id);
  expect(JSON.stringify(context)).not.toContain("ROOT_ARGUMENT_NOT_CONTEXT");
});

test("reopened reduction retains newest consequential failure behind routine pages and independent bounded unknowns", async () => {
  const f = fixture();
  for (let index = 0; index < 11; index++) {
    f.store.event(f.state.run.run_id, "runtime.uncertainty", `Unconfirmed operation ${index}`, {
      action_id: `private-operation-${index}`, status: "unknown", session_id: f.state.run.session_id,
      life_id: 1, world_id: f.state.run.world_id, native_boot_id: f.state.run.native_boot_id, space_epoch: 1,
    });
  }
  f.store.event(f.state.run.run_id, "runtime.uncertainty_reconciled", "Closed emitters, not resolved", {
    action_id: "private-operation-3", life_id: 1, no_replay: true,
  });
  const failure = f.store.event(f.state.run.run_id, "action.failed", "Newest independent settled failure", {
    life_id: 1, result: { status: "failed", evidence: { world_effect_emitted: false } },
  });
  f.store.appendEvents(f.state.run.run_id, Array.from({ length: 610 }, () => ({
    type: "scheduler.tick", summary: "Routine bookkeeping", details: {},
  })));
  const store = await f.reopen(), reducer = new StrategicContext(store);
  let context = JSON.parse(reducer.assemble(f.state.run)).strategic_context;
  expect(context.latest_failure).toMatchObject({ event_seq: failure.event_seq, summary: "Newest independent settled failure" });
  expect(context.unresolved).toHaveLength(8);
  expect(context.omitted_unknown_operations).toBe(3);
  expect(context.omissions).toContainEqual(expect.objectContaining({
    kind: "unresolved", reason: "reference_count_budget_not_resolution_no_replay",
  }));
  expect(context.unresolved[0]).toMatchObject({ summary: "Unconfirmed operation 3", no_replay: true,
    containment: { summary: "Closed emitters, not resolved" } });
  f.state.run.life_id = 2; f.state.run.session_id = "recovered-session";
  f.state.run.native_boot_id = "recovered-boot"; f.state.run.space_epoch = 2;
  store.saveRun(f.state.run);
  context = JSON.parse(reducer.assemble(f.state.run)).strategic_context;
  expect(context.latest_failure).toBeNull();
  expect(context.unresolved).toHaveLength(8);
  expect(context.unresolved.every((entry: any) => entry.no_replay && !entry.current_authority &&
    entry.original_scope.life_id === 1 && entry.original_scope.space_epoch === 1)).toBe(true);
  const reconstructed = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
  expect(reconstructed.unresolved).toEqual(context.unresolved);
  expect(reconstructed.omitted_unknown_operations).toBe(3);
  expect(JSON.stringify(reconstructed)).not.toContain("private-operation");
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: reconstructed }))).toBeLessThanOrEqual(32768);
});

test("reopened recovery retains explicit historical worksite but not temporary positions, inventory or old authority", async () => {
  const f = fixture(), skill = await f.program(), original = f.execution(skill);
  f.store.updateSkillExecution(original, "skill.progress", "Explicit world-local objective", {
    current_subgoal: "Return to the authored worksite",
    worksite: { label: "Authored workshop", position: { x: 14, y: 65, z: -8 },
      target_id: "OLD_SITE_HANDLE", inventory: [{ name: "OLD_SITE_INVENTORY", count: 6 }] },
    resource_requirements: [{ name: "OLD_REQUIREMENT", count: 6 }],
  });
  f.state.run.life_id = 2; f.state.run.space_epoch = 2; f.state.run.native_boot_id = "fresh-native-boot";
  f.store.saveRun(f.state.run);
  const recovery = f.execution(skill);
  recovery.status = "succeeded"; recovery.ended_at = new Date().toISOString();
  recovery.result = { status: "completed", summary: "Temporary recovery landing", result: {
    landing: { x: -40, y: 63, z: 20 },
  } };
  f.store.updateSkillExecution(recovery, "skill.closed", recovery.result.summary);
  const store = await f.reopen();
  const context = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
  expect(context.authored_state.worksite).toBeUndefined();
  expect(context.authored_state.current_subgoal).toBeUndefined();
  expect(context.authored_state.returned_position_notes).toContainEqual(expect.objectContaining({
    field: "landing", position: { x: -40, y: 63, z: 20 },
  }));
  expect(context.historical_authored_state.notes).toContainEqual(expect.objectContaining({
    field: "worksite", event_seq: expect.any(Number), historical: true, current_authority: false,
    value: { label: "Authored workshop", position: { x: 14, y: 65, z: -8 } },
    original_scope: expect.objectContaining({ life_id: 1, space_epoch: 1 }),
  }));
  for (const marker of ["OLD_SITE_HANDLE", "OLD_SITE_INVENTORY", "OLD_REQUIREMENT", original.execution_id])
    expect(JSON.stringify(context)).not.toContain(marker);
  const replaced = { ...f.state.run, run_id: "fresh-objective-run", task: "Replacement objective" };
  store.saveRun(replaced);
  const fresh = JSON.parse(new StrategicContext(store).assemble(replaced)).strategic_context;
  expect(fresh.historical_authored_state.notes).toEqual([]);
  expect(fresh.programs).toEqual([]);
  expect(fresh.unresolved).toEqual([]);
});

test("program reuse carries sanitized arguments and last outcome through named ordinal references after reopening", async () => {
  const f = fixture(), skill = await f.program('return {status:"blocked",summary:"Needs a fresh route",result:{reason:"local bound"}};');
  const execution = f.execution(skill, {
    count: 3, mode: "nearby", options: { material: "oak_log", target_id: "OLD_ARGUMENT_HANDLE" },
    inventory: [{ name: "OLD_ARGUMENT_INVENTORY", count: 9 }], execution_id: "OLD_ARGUMENT_ROOT",
    padding: "界".repeat(5000),
  });
  execution.status = "blocked"; execution.ended_at = new Date().toISOString();
  execution.result = { status: "blocked", summary: "Local route bound; choose different observed geometry", result: {
    reason: "start_distance_limit", remaining: 2, target: { target_id: "OLD_OUTCOME_HANDLE" },
  } };
  f.store.updateSkillExecution(execution, "skill.closed", execution.result.summary);
  const store = await f.reopen();
  const context = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
  expect(context.programs).toContainEqual(expect.objectContaining({
    name: skill.name, version: 1, source: skill.source,
    last_execution: expect.objectContaining({
      name: skill.name, version: 1, execution_ordinal: expect.any(Number), status: "blocked",
      historical: true, current_authority: false, argument_sample: expect.objectContaining({
        count: 3, mode: "nearby", options: { material: "oak_log" },
      }),
      outcome: { status: "blocked", summary: execution.result.summary,
        result: { reason: "start_distance_limit", remaining: 2 }, result_omitted: true },
      argument_sample_omitted: true,
    }),
  }));
  for (const marker of ["OLD_ARGUMENT_HANDLE", "OLD_ARGUMENT_INVENTORY", "OLD_ARGUMENT_ROOT", "OLD_OUTCOME_HANDLE", execution.execution_id])
    expect(JSON.stringify(context)).not.toContain(marker);
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
});

function residentReferenceSource(revision: number) {
  const modes = Array.from({ length: 80 }, (_, index) => ({
    name: `bounded-observation-mode-${revision}-${index}`, max_frames: 40 + index,
    minimum_health: index % 20, minimum_food: index % 21, forward: index % 2 === 0,
  }));
  return `const modes = ${JSON.stringify(modes)};
export function step(frame,state,intent) {
  const mode = modes.find(value => value.name === intent.mode) || modes[0];
  const frames = (state?.frames || 0) + 1;
  const permitted = frame.player.health >= mode.minimum_health && frame.player.food >= mode.minimum_food;
  return {input:{kind:"world",held:{forward:permitted && mode.forward,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},
    edges:[],view:{kind:"unchanged"},selected_hotbar:null},next_state:{frames},
    status:frames >= mode.max_frames ? "completed" : "running",events:[]};
}`;
}

async function residentReference(f: ReturnType<typeof fixture>, revision = 1) {
  return f.store.registerSkill(f.state.run.run_id, { entry: "step", name: "Reusable resident",
    source: residentReferenceSource(revision), dependencies: [],
    card: { purpose: "Use an explicitly selected bounded observation mode", applicability: "Fixture",
      method: "Apply the selected mode until its frame bound", reason: "Historical source retention",
      limitations: "No gameplay efficacy established" },
    validation: { runtime_version: 5, api_version: 5, validator_version: 5,
      compatibility_hash: f.state.run.compatibility_hash!, fingerprint: "fixture", formatted_lines: 10, complexity: 4, nesting: 1 } });
}

function executeResidentReference(f: ReturnType<typeof fixture>, skill: SkillView,
  status: "cancelled" | "succeeded" | "failed" | "unknown" = "cancelled") {
  const execution = f.store.admitSkill(f.state.run.run_id, { entry: "step",
    skill_id: skill.skill_id, version: skill.version, start_key: `resident-reference-${f.store.lastEventSeq()}`,
    ...executionScopeFixture(f.state.run),
    args: { mode: "bounded-observation-mode-1-3", count: 4, options: { distance: 3, target_id: "OLD_RESIDENT_TARGET" },
      worker: "OLD_RESIDENT_WORKER", state: { secret: "OLD_RESIDENT_STATE" },
      intent: { secret: "OLD_RESIDENT_INTENT" }, authority: "OLD_RESIDENT_AUTHORITY",
      target: { id: "OLD_RESIDENT_TARGET" }, inventory: ["OLD_RESIDENT_INVENTORY"], padding: "界".repeat(1000) },
    initial_state: { private: "OLD_RESIDENT_INITIAL_STATE" }, limits: { ...DEFAULT_RESIDENT_LIMITS },
  }).view;
  if (execution.entry !== "step") throw new Error("Expected a resident reference");
  execution.status = "running"; execution.started_at = new Date().toISOString();
  f.store.updateSkillExecution(execution, "skill.running", "Reference resident dispatched");
  const timing = { count: 1, p50: 1, p95: 1, p99: 1, max: 1, omitted_samples: 0 };
  execution.resident = {
    execution_id: execution.execution_id, source_hash: skill.hash, controller_generation: 1,
    host_clock_id: "OLD_RESIDENT_CLOCK", status: status === "succeeded" ? "completed" : status === "cancelled" ? "stopped" : status,
    reason: status === "cancelled" ? "explicit_handoff" : `resident_${status}`, intent_version: 7,
    state: { private: "OLD_RESIDENT_RUNTIME_STATE" }, processed_frame_seq: 4, processed_native_tick: 4, processed_native_ns: "4",
    counters: { frames: 4, steps: 4, submissions: 4, applied_sequence: 4, ordered_edge_prefix: 0,
      missed_slots: 0, stale_results: 0, stale_frames: 0, read_failures: 0, no_input_decisions: 0,
      expanded_edges: 0, events: 0, analysis_jobs: 0, analysis_ms: 0 },
    pending: { frames: 0, edges: 0, analysis: false }, last_input: null,
    timings: { step_ms: timing, input_age_ms: timing }, events: [],
    cleanup: { worker: "closed", native: "retired" },
  };
  execution.status = status; execution.ended_at = new Date().toISOString();
  if (status === "succeeded") execution.result = { status: "completed", summary: "Authored frame bound reached", result: null };
  f.store.updateSkillExecution(execution, "skill.closed", `Reference resident ${status}`, { status });
  return execution;
}

function finishReferenceProcedure(f: ReturnType<typeof fixture>, skill: SkillView) {
  const execution = f.execution(skill, { count: 1 });
  execution.status = "running"; execution.started_at = new Date().toISOString();
  f.store.updateSkillExecution(execution, "skill.running", "Finite reference procedure dispatched");
  execution.status = "succeeded"; execution.ended_at = new Date().toISOString();
  execution.result = { status: "completed", summary: "Finite procedure ended", result: null };
  f.store.updateSkillExecution(execution, "skill.closed", execution.result.summary, { status: execution.status });
}

for (const status of ["cancelled", "succeeded"] as const)
  test(`next SDK request retains exact ${status} resident source and historical arguments behind a finite procedure and inactive draft`, async () => {
    const f = fixture();
    await f.planner.start(1); await f.turn();
    const skill = await residentReference(f), execution = executeResidentReference(f, skill, status);
    finishReferenceProcedure(f, await f.program());
    const draft = await residentReference(f, 2);
    await f.program(undefined, "Other inactive procedure");
    await f.program(undefined, "Newest inactive procedure");
    await f.turn();
    const request = f.state.requests.at(-1), context = retained(request)!;
    const reference = context.programs.find((program: any) => program.name === skill.name && program.version === skill.version);
    expect(reference).toMatchObject({ name: skill.name, version: skill.version, hash: skill.hash, source: skill.source,
      last_execution: {
        status, historical: true, current_authority: false, gameplay_success_proof: false,
        original_scope: { world_id: execution.world_id, session_id: execution.session_id, life_id: execution.life_id,
          native_boot_id: execution.native_boot_id, space_epoch: execution.space_epoch },
        resident: { status: execution.resident!.status, reason: execution.resident!.reason },
        argument_sample: { mode: "bounded-observation-mode-1-3", count: 4, options: { distance: 3 } },
        argument_sample_omitted: true,
      } });
    expect(reference.last_execution.argument_sample).toEqual({ mode: "bounded-observation-mode-1-3", count: 4, options: { distance: 3 } });
    expect(Buffer.byteLength(JSON.stringify(reference.last_execution.argument_sample))).toBeLessThanOrEqual(1024);
    expect(context.programs.find((program: any) => program.name === draft.name && program.version === draft.version)?.source).toBeUndefined();
    expect(context.omissions).toContainEqual(expect.objectContaining({ kind: "source", reference: `${draft.name}@${draft.version}` }));
    expect(context.authored_state).not.toHaveProperty("state");
    expect(context.authored_state).not.toHaveProperty("intent");
    expect(Buffer.byteLength(context.programs.map((program: unknown) => JSON.stringify(program)).join(""))).toBeLessThanOrEqual(18432);
    expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
    for (const program of context.programs) if (program.source !== undefined)
      expect(program.source).toBe(f.store.namedSkill(f.state.run.run_id, program.name, program.version)!.source);
    for (const marker of ["OLD_RESIDENT_TARGET", "OLD_RESIDENT_WORKER", "OLD_RESIDENT_STATE", "OLD_RESIDENT_INTENT",
      "OLD_RESIDENT_AUTHORITY", "OLD_RESIDENT_INVENTORY", "OLD_RESIDENT_INITIAL_STATE", "OLD_RESIDENT_RUNTIME_STATE",
      "OLD_RESIDENT_CLOCK", execution.execution_id])
      expect(JSON.stringify(request)).not.toContain(marker);
    expect(f.state.toolEffects).toBe(0);
    expect(f.state.helpEffects).toBe(0);
    const store = await f.reopen();
    const reopened = JSON.parse(new StrategicContext(store).assemble(f.state.run)).strategic_context;
    expect(reopened.programs.find((program: any) => program.name === skill.name && program.version === skill.version)).toEqual(reference);
    expect(store.skillExecution(f.state.run.run_id, { execution_id: execution.execution_id })?.status).toBe(status);
  });

for (const status of ["failed", "unknown"] as const)
  test(`newer ${status} resident source cannot displace the previous non-failed executed version`, async () => {
    const f = fixture(), previous = await residentReference(f);
    executeResidentReference(f, previous);
    const newer = await residentReference(f, 2);
    executeResidentReference(f, newer, status);
    finishReferenceProcedure(f, await f.program());
    await f.planner.start(1); await f.turn();
    const context = retained(f.state.requests.at(-1))!;
    expect(context.programs[0]).toMatchObject({ name: previous.name, version: previous.version, source: previous.source,
      last_execution: { status: "cancelled", current_authority: false, gameplay_success_proof: false } });
    expect(context.programs.find((program: any) => program.name === newer.name && program.version === newer.version)?.source).toBeUndefined();
    expect(context.omissions).toContainEqual(expect.objectContaining({ kind: "source", reference: `${newer.name}@${newer.version}` }));
    expect(f.state.toolEffects).toBe(0);
  });

test("an undispatched resident admission retains the actual previous execution sample instead of its new inputs", async () => {
  const f = fixture(), skill = await residentReference(f), executed = executeResidentReference(f, skill);
  finishReferenceProcedure(f, await f.program());
  const admitted = f.store.admitSkill(f.state.run.run_id, { entry: "step",
    skill_id: skill.skill_id, version: skill.version, start_key: "not-dispatched-reference",
    ...executionScopeFixture(f.state.run), args: { mode: "UNEXECUTED_ARGUMENT_SAMPLE" },
    initial_state: { private: "UNEXECUTED_INITIAL_STATE" }, limits: { ...DEFAULT_RESIDENT_LIMITS },
  }).view;
  await residentReference(f, 2);
  await f.planner.start(1); await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(context.programs[0]).toMatchObject({ name: skill.name, version: skill.version, source: skill.source,
    last_execution: { status: "cancelled", historical: true, current_authority: false, gameplay_success_proof: false,
      argument_sample: { mode: "bounded-observation-mode-1-3", count: 4, options: { distance: 3 } } } });
  const reference = new ProgramWorkspace(f.store, f.state.run.run_id).executionReference(executed.execution_id);
  expect(context.programs[0].last_execution.execution_ordinal).toBe(reference!.execution_ordinal);
  expect(JSON.stringify(context.programs[0])).not.toContain("UNEXECUTED");
  expect(f.store.skillExecution(f.state.run.run_id, { execution_id: admitted.execution_id })).toMatchObject({
    status: "accepted", started_at: null,
  });
  expect(f.state.toolEffects).toBe(0);
});

test("a newer failed execution of the same resident version prevents preferring its older non-failed execution", async () => {
  const f = fixture(), skill = await residentReference(f);
  executeResidentReference(f, skill);
  executeResidentReference(f, skill, "failed");
  const finite = await f.program(); finishReferenceProcedure(f, finite);
  const draft = await residentReference(f, 2);
  await f.planner.start(1); await f.turn();
  const context = retained(f.state.requests.at(-1))!;
  expect(context.programs[0]).toMatchObject({ name: finite.name, version: finite.version, source: finite.source });
  expect(context.programs).not.toContainEqual(expect.objectContaining({ name: skill.name, version: skill.version }));
  expect(context.programs).toContainEqual(expect.objectContaining({ name: draft.name, version: draft.version, source: draft.source }));
  expect(f.state.toolEffects).toBe(0);
});

for (const changed of ["task", "world", "profile", "life", "session", "boot", "space"] as const)
  test(`executed resident knowledge crosses ${changed} only under the existing historical source rules`, async () => {
    const f = fixture(), skill = await residentReference(f), execution = executeResidentReference(f, skill);
    finishReferenceProcedure(f, await f.program());
    await residentReference(f, 2);
    await f.planner.start(1); await f.turn(); await f.planner.close();
    if (changed === "task") f.state.run.task = "Replacement resident reference task";
    if (changed === "world") { f.state.run.world_id = "replacement-world"; f.state.observation.world_id = "replacement-world"; }
    if (changed === "profile") {
      f.state.adapter = minecraftTestAdapter("precise");
      f.state.observation = minecraftObservationFixture(f.state.adapter);
      f.state.run.compatibility_hash = f.state.observation.compatibility_hash;
    }
    if (changed === "life") { f.state.run.life_id = 2; f.state.observation.life.life_id = 2; }
    if (changed === "session") { f.state.run.session_id = "replacement-session"; f.state.observation.session_id = "replacement-session"; }
    if (changed === "boot") { f.state.run.native_boot_id = "replacement-boot"; f.state.observation.native_boot_id = "replacement-boot"; }
    if (changed === "space") { f.state.run.space_epoch = 2; f.state.observation.space.space_epoch = 2; }
    f.store.saveRun(f.state.run); f.state.generation++;
    await f.planner.start(f.state.generation); await f.turn();
    const context = retained(f.state.requests.at(-1))!;
    if (changed === "task" || changed === "world" || changed === "profile") expect(context.programs).toEqual([]);
    else {
      expect(context.programs[0]).toMatchObject({ name: skill.name, version: skill.version, source: skill.source,
        last_execution: { historical: true, current_authority: false, gameplay_success_proof: false,
          original_scope: { world_id: execution.world_id, session_id: execution.session_id,
            life_id: execution.life_id, native_boot_id: execution.native_boot_id, space_epoch: execution.space_epoch } } });
      expect(context.authored_state).not.toHaveProperty("latest_root_result");
      expect(context.latest_failure).toBeNull();
    }
    expect(f.state.toolEffects).toBe(0);
    expect(f.store.skillExecution(f.state.run.run_id, { execution_id: execution.execution_id })?.status).toBe("cancelled");
  });

test("source and reuse metadata share their allowance without displacing bounded no-replay history", async () => {
  const f = fixture(), source = `/*${"s".repeat(15800)}*/return {status:"blocked",summary:"Bound",result:null};`;
  const first = await f.program(source, "First large reference"), second = await f.program(source, "Second large reference");
  for (const skill of [first, second]) {
    const execution = f.execution(skill, { label: "界".repeat(3000), count: 4 });
    execution.status = "blocked"; execution.ended_at = new Date().toISOString();
    execution.result = { status: "blocked", summary: "A bounded previous outcome", result: { reason: "界".repeat(3000) } };
    f.store.updateSkillExecution(execution, "skill.closed", execution.result.summary);
  }
  for (let index = 0; index < 10; index++)
    f.store.event(f.state.run.run_id, "runtime.uncertainty", `Unconfirmed ${index}: ${"界".repeat(400)}`, {
      action_id: `budget-operation-${index}`, life_id: 1,
    });
  const reducer = new StrategicContext(f.store);
  reducer.rememberHelp("game", { bindings: Array.from({ length: 30 }, () => "Useful help ".repeat(200)) });
  const context = JSON.parse(reducer.assemble(f.state.run)).strategic_context;
  expect(Buffer.byteLength(JSON.stringify({ strategic_context: context }))).toBeLessThanOrEqual(32768);
  expect(Buffer.byteLength(context.programs.map((program: unknown) => JSON.stringify(program)).join(""))).toBeLessThanOrEqual(18432);
  expect(context.unresolved).toHaveLength(8);
  expect(context.omitted_unknown_operations).toBe(2);
  expect(context.unresolved.every((entry: any) => entry.status === "unknown" && entry.no_replay)).toBe(true);
  expect(context.omissions.length).toBeLessThanOrEqual(16);
  for (const program of context.programs)
    if (program.source !== undefined) expect(program.source).toBe(source);
  expect(context.programs.some((program: any) => program.source_omission)).toBe(true);
});

test("failed provider output cannot run tools or load retained help", async () => {
  const f = fixture(); await f.planner.start(1);
  await f.turn([settlement([{ type: "toolCall", id: "failed-submit", name: "program_submit", arguments: {} },
    { type: "toolCall", id: "failed-help", name: "help", arguments: { topic: "game" } }], true)]);
  expect(f.state.toolEffects).toBe(0);
  await f.planner.close(); f.state.run.status = "running"; f.state.generation++;
  await f.planner.start(f.state.generation); await f.turn();
  expect(retained(f.state.requests.at(-1))).toBeDefined();
  expect(JSON.stringify(retained(f.state.requests.at(-1))?.requested_help)).not.toContain("Useful exact requested contract");
});

for (const tool of ["program_submit", "program_write", "program_run", "help"]) {
  test(`SDK recovered transient failed ${tool} output never becomes eligible or retained`, async () => {
    const f = fixture();
    f.state.completedToolEvents = true;
    const failed = settlement([{ type: "toolCall", id: `transient-${tool}`, name: tool,
      arguments: tool === "help" ? { topic: "game" } : {} }], true);
    failed.errorMessage = "stream_read_error: transport ended after completed arguments";
    await f.planner.start(1); await f.turn([failed]);
    expect(f.state.toolEffects).toBe(0);
    expect(f.state.helpEffects).toBe(0);
    expect(f.state.requests).toHaveLength(1);
    expect(f.state.run.status).toBe("paused");
    const terminal = f.store.eventsAfter(f.state.run.run_id, 0, 500).find(event => event.type === "model.request_settled");
    expect(terminal?.details).toMatchObject({ stop_reason: "toolUse", provider_failure: true,
      recovered_failure: { type: "stream_interrupted_after_content", explanation: failed.errorMessage } });
    await f.planner.close(); f.state.run.status = "running"; f.state.generation++;
    await f.planner.start(f.state.generation); await f.turn();
    expect(JSON.stringify(retained(f.state.requests.at(-1))?.requested_help)).not.toContain("Useful exact requested contract");
    expect(f.state.toolEffects).toBe(0);
    expect(f.state.helpEffects).toBe(0);
  });
}
