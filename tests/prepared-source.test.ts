import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { AuthState, Json } from "../src/shared/contracts.ts";
import type { ResidentAnalysisWorker, ResidentWorker } from "../src/shared/resident.ts";
import type { PreparedStartRequest, PreparedStartView } from "../src/shared/prepared-start.ts";
import { PreparedSource, type PreparedSourceOptions } from "../src/server/prepared-source.ts";
import { PreparedSourcebook } from "../src/server/prepared-sourcebook.ts";
import { adapterCompatibility } from "../src/server/adapter-contract.ts";
import type { ApprovedSourceReference } from "../src/server/source-authoring.ts";
import { PREPARED_START_LIMITS } from "../src/shared/prepared-start.ts";
import type { PreparedSourceCandidate } from "../src/server/prepared-source-contract.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import { residentAnalysisProcess } from "./helpers/resident-analysis-process.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
type Call = { name: string; args: unknown; id?: string };
const rootSource = "export function activate(frame,state,intent) { return {refused:true,reason:'software fixture only'}; } export function step(frame,state,intent) { return {choice:{kind:'observe'},next_state:state,status:'running',events:[]}; }";
const rootCalls = (): Call[] => [{ name: "program_write", args: { name: "executive", source: rootSource } },
  { name: "prepare_finish", args: { name: "executive", version: 1, args: null, initial_state: null, limits: {}, session: { schema_version: 1 } } }];
function approvedReference(source = rootSource, entry: ApprovedSourceReference["entry"] = "step"): ApprovedSourceReference {
  return { hash: createHash("sha256").update(source, "utf8").digest("hex"), source, entry,
    card: { purpose: "Synthetic source-copy protocol", applicability: "Software tests only",
      method: "Explicit selected-model copy", reason: "Operator-approved fixture",
      limitations: "No gameplay evidence" }, provenance: "operator-approved synthetic authored-source fixture" };
}
const sourceAuthState = (): AuthState => ({ authenticated: true, status: "ready", provider: "openai-codex",
  account_label: null, login: null, error: null,
  models: [{ id: "selected-model", name: "Selected fixture model", provider: "openai-codex",
    context_window: null, input_modalities: ["image"] }] });

/** Local protocol double only: no provider, native observation, gameplay outcome or Docker claim. */
class ScriptedSourceAgent {
  state = { model: { id: "selected-model", api: "openai-codex-responses", provider: "openai-codex" } };
  listeners = new Set<(event: AgentEvent) => void>();
  gate: ((context: unknown, signal?: AbortSignal) => unknown) | null = null;
  beforeToolCall: ((context: unknown, signal?: AbortSignal) => unknown) | null = null;
  results: AgentToolResult[] = [];
  prompts = 0;
  aborted = false;
  streamFn: StreamFn = (() => ({ async *[Symbol.asyncIterator]() { /* naturally exhausted synthetic stream */ } })) as unknown as StreamFn;
  constructor(readonly tools: AgentTool[], readonly calls: Call[]) {}
  setBeforeModelCall(gate: ScriptedSourceAgent["gate"]) { this.gate = gate; }
  subscribe(listener: (event: AgentEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  abort() { this.aborted = true; }
  async waitForIdle() {}
  async prompt() {
    this.prompts++;
    if (this.gate?.({})) return;
    const stream = await this.streamFn(this.state.model as never, { messages: [], tools: this.tools } as never, {});
    for await (const _event of stream) { /* consume actual iterator ownership in the double */ }
    const content = this.calls.map((call, index) => ({ type: "toolCall" as const, id: call.id ?? `source-call-${index}`, name: call.name, arguments: call.args }));
    const assistant = { role: "assistant", content, stopReason: "toolUse", usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 },
      api: this.state.model.api, provider: this.state.model.provider, model: this.state.model.id } as AssistantMessage;
    for (const listener of this.listeners) listener({ type: "message_end", message: assistant });
    for (const call of content) {
      const tool = this.tools.find(tool => tool.name === call.name)!;
      const context = { tool, toolCall: call, args: call.arguments, assistantMessage: assistant };
      if (this.beforeToolCall?.(context)) continue;
      this.results.push(await tool.execute(call.id, call.arguments));
    }
    // Real Agent asks the supported gate again after tool results. Sealing must stop here.
    const stopped = this.gate?.({});
    if (!stopped) throw new Error(`Fixture requires a terminal host gate: ${JSON.stringify(this.results.filter(result => result.isError).map(result => result.details))}`);
  }
}

function fixture(calls = rootCalls(), overrides: Partial<PreparedSourceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "prepared-source-")); directories.push(directory);
  const adapter = minecraftTestAdapter();
  let agent: ScriptedSourceAgent | null = null, releases = 0, compiled = 0, closed = 0, activated = 0;
  let promptFailure: unknown = null;
  let owner: PreparedSource;
  const terminal = Promise.withResolvers<PreparedStartView>();
  const ready = Promise.withResolvers<PreparedSourceCandidate>();
  const worker: ResidentWorker = { async step() { throw new Error("No step is authorized in source preparation"); },
    async activate() { activated++; throw new Error("No activation is authorized in source preparation"); }, async close() { closed++; } };
  const options: PreparedSourceOptions = { directory,
    auth: { snapshot: sourceAuthState,
      createAgent: async input => {
        agent = new ScriptedSourceAgent(input.tools, calls);
        const prompt = agent.prompt.bind(agent);
        agent.prompt = async () => { try { await prompt(); } catch (error) { promptFailure = error; throw error; } };
        return agent as unknown as Agent;
      },
      releaseAgent: async () => { releases++; } },
    sandbox: { createResidentWorker: async () => { compiled++; return worker; },
      createResidentAnalysisWorker: async () => { throw new Error("No analysis configured"); } },
    getContract: async () => ({ adapter, artifact_sha256: "a".repeat(64) }), assertCanStart() {},
    onReady: async candidate => { ready.resolve(candidate); candidate.takeWorker("actual-admitted-run"); return { run_id: "actual-admitted-run" }; },
    onCancel: async () => {}, record() {}, changed: () => {
      const view = owner.snapshot();
      if (view && ["started", "failed", "cancelled"].includes(view.phase)) terminal.resolve(view);
    }, ...overrides };
  owner = new PreparedSource(options);
  const request: PreparedStartRequest = { request_id: crypto.randomUUID(), task: "Test source-only admission",
    goal: structuredClone(adapter.goals[0]!), model_id: "selected-model" };
  return { owner, options, request, directory, ready: ready.promise, terminal: terminal.promise,
    counters: () => ({ releases, compiled, closed, activated }), agent: () => agent!, worker, promptFailure: () => promptFailure };
}

test("omitted-entry executive source is selected explicitly, compiles without frames and transfers once to the actual admitted run", async () => {
  const f = fixture(); await f.owner.initialize();
  const accepted = await f.owner.start(f.request);
  expect(accepted.phase).toBe("authoring");
  const candidate = await f.ready;
  expect(f.agent().results[0]!.isError).not.toBe(true);
  expect(f.counters()).toEqual({ releases: 1, compiled: 1, closed: 0, activated: 0 });
  expect(() => candidate.takeWorker("second-run")).toThrow();
  expect(f.owner.snapshot()?.run_id).toBe("actual-admitted-run");
  expect(f.owner.snapshot()?.closure).toBe("transferred");
  expect(f.owner.snapshot()?.usage.known_cost).toBeNull();
  await expect(f.owner.cancel(accepted.preparation_id)).rejects.toThrow();
  await f.owner.close();
  expect(f.counters().closed).toBe(0);
});

test("actual SDK dispatch owns terminal tool JSON before queued message observers and seals without another request", async () => {
  const descriptor = getBundledModels("openai-codex").find(value => value.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed offline SDK model descriptor unavailable");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  let calls = 0;
  const f = fixture(rootCalls(), { auth: {
    snapshot: sourceAuthState,
    createAgent: async options => new Agent({
      initialState: { model, systemPrompt: options.systemPrompt, tools: options.tools },
      getApiKey: () => "OFFLINE_PROTOCOL_FIXTURE_NO_NETWORK",
      streamFn: () => {
        const index = calls++;
        if (index > 1) throw new Error("Sealed source must not request another response");
        const call = rootCalls()[index]!;
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "toolCall", id: `call_${index}|provider_${index}`, name: call.name, arguments: call.args as Record<string, unknown> }],
          stopReason: "toolUse", timestamp: 0,
          usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end();
        return stream;
      },
    }),
    releaseAgent: async agent => { agent.abort(); await agent.waitForIdle(); },
  } });
  try {
    await f.owner.initialize(); await f.owner.start(f.request);
    const view = await f.terminal;
    expect(view).toMatchObject({ phase: "started", closure: "transferred", tools_used: 2, source_versions: 1 });
    expect(calls).toBe(2);
    expect(f.counters().compiled).toBe(1);
  } finally { await f.owner.close(); }
});

test("live remaining budgets let the selected model seal on its last request without renewing failed work", async () => {
  const descriptor = getBundledModels("openai-codex").find(value => value.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed offline SDK model descriptor unavailable");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  type Budget = { requests_remaining_after_this_request: number; tools_remaining: number;
    source_versions_remaining: number; source_bytes_remaining: number; time_remaining_ms: number; deadline_at: string };
  const budgets: Budget[] = [];
  const f = fixture([], { auth: {
    snapshot: sourceAuthState,
    createAgent: async options => new Agent({
      initialState: { model, systemPrompt: options.systemPrompt, tools: options.tools },
      getApiKey: () => "OFFLINE_PROTOCOL_FIXTURE_NO_NETWORK",
      streamFn: (_model, context) => {
        const last = context.messages.at(-1);
        const text = last?.role === "user" && Array.isArray(last.content)
          ? last.content.find(part => part.type === "text") : null;
        const budget = text?.type === "text" ? JSON.parse(text.text).preparation_budget as Budget | undefined : undefined;
        if (!budget) throw new Error("Selected model cannot see its current preparation allowance");
        budgets.push(budget);
        const index = budgets.length - 1;
        const call: Call = budget.requests_remaining_after_this_request === 0 ? rootCalls()[1]!
          : index === 0 ? rootCalls()[0]!
          : index === 1 ? { name: "program_edit", args: { name: "missing", based_on: 1,
            edits: [{ old_text: "absent", new_text: "unused" }] } }
          : { name: "program_inspect", args: { view: "catalog" } };
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "toolCall", id: `budget_${index}|provider_${index}`, name: call.name, arguments: call.args as Record<string, unknown> }],
          stopReason: "toolUse", timestamp: 0,
          usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message }); stream.end(); return stream;
      },
    }),
    releaseAgent: async agent => { agent.abort(); await agent.waitForIdle(); },
  } });
  try {
    await f.owner.initialize(); await f.owner.start(f.request);
    const view = await f.terminal;
    expect(view).toMatchObject({ phase: "started", closure: "transferred",
      requests_admitted: PREPARED_START_LIMITS.max_requests, source_versions: 1 });
    expect(budgets.map(value => value.requests_remaining_after_this_request))
      .toEqual(Array.from({ length: PREPARED_START_LIMITS.max_requests }, (_, index) => PREPARED_START_LIMITS.max_requests - index - 1));
    expect(budgets[0]).toMatchObject({ tools_remaining: PREPARED_START_LIMITS.max_tools,
      source_versions_remaining: PREPARED_START_LIMITS.max_source_versions, source_bytes_remaining: PREPARED_START_LIMITS.max_source_bytes });
    expect(budgets[2]).toMatchObject({ tools_remaining: PREPARED_START_LIMITS.max_tools - 2,
      source_versions_remaining: PREPARED_START_LIMITS.max_source_versions - 1 });
    expect(budgets[2]!.source_bytes_remaining).toBe(budgets[1]!.source_bytes_remaining);
    expect(budgets[1]!.source_bytes_remaining).toBeLessThan(budgets[0]!.source_bytes_remaining);
    for (let index = 1; index < budgets.length; index++) {
      expect(budgets[index]!.deadline_at).toBe(budgets[0]!.deadline_at);
      expect(budgets[index]!.time_remaining_ms).toBeLessThanOrEqual(budgets[index - 1]!.time_remaining_ms);
    }
    expect(f.counters()).toMatchObject({ compiled: 1, activated: 0 });
  } finally { await f.owner.close(); }
});

test("exact request retries never infer or mutate source again, including after restart", async () => {
  const f = fixture(); await f.owner.initialize(); await f.owner.start(f.request); await f.ready; await f.owner.close();
  const first = await f.owner.start(f.request).catch(() => null); // A closed owner rejects new access; reopen durable receipts below.
  expect(first).toBeNull();
  const reopened = new PreparedSource({ ...f.options, auth: { ...f.options.auth,
    createAgent: async () => { throw new Error("Durable request retry must not create an Agent"); } } });
  await reopened.initialize();
  const replay = await reopened.start(f.request);
  expect(replay.phase).toBe("started");
  expect(replay.preparation_id).toBe(f.owner.snapshot()!.preparation_id);
  await expect(reopened.start({ ...f.request, task: "Changed immutable task" })).rejects.toThrow();
  await reopened.close();
});

test("missing activate is rejected before compiling or launch and late tools cannot alter a sealed root", async () => {
  const missing = fixture([{ name: "program_write", args: { name: "executive",
    source: "export function step(frame,state,intent) { return null; }" } }, rootCalls()[1]!]);
  await missing.owner.initialize(); await missing.owner.start(missing.request); const failure = await missing.terminal;
  expect(failure.phase).toBe("failed"); expect(missing.counters().compiled).toBe(0);
  await missing.owner.close();
  const sealed = fixture([...rootCalls(), { name: "program_write", args: { name: "executive", entry: "step", based_on: 1, source: rootSource } }]);
  await sealed.owner.initialize(); await sealed.owner.start(sealed.request); const candidate = await sealed.ready;
  expect(candidate.sources).toHaveLength(1); expect(candidate.root.version).toBe(1);
  expect(sealed.agent().results).toHaveLength(2);
  await sealed.owner.close();
});

test("an explicit run entry rejects a step module until the model submits its complete root with the matching entry", async () => {
  const f = fixture([
    { name: "program_write", args: { name: "executive", entry: "run", source: rootSource } },
    { name: "program_write", args: { name: "executive", entry: "step",
      source: "export function step(frame,state) {} export function activate() {}" } },
    { name: "program_write", args: { name: "probe", entry: "analyze",
      source: "export async function analyze(input) {}" } },
    ...rootCalls(),
  ]);
  await f.owner.initialize(); await f.owner.start(f.request); const candidate = await f.ready;
  expect(f.agent().results[0]!.isError).toBe(true);
  expect(f.agent().results[0]!.details).toMatchObject({ failed: true, code: "invalid_source",
    issues: expect.arrayContaining([expect.objectContaining({ code: "forbidden_syntax", entry_contract: {
      selected_entry: "run", source_format: "async_body", required_exports: [], optional_exports: [],
      parameter_count: null, detected_exports: ["activate", "step"], omitted_exports: 0,
      detected_signatures: [
        { name: "activate", parameter_count: 3, plain_parameters: true, async: false, generator: false },
        { name: "step", parameter_count: 3, plain_parameters: true, async: false, generator: false },
      ],
    } })]) });
  expect(f.agent().results[1]!.isError).toBe(true);
  expect(f.agent().results[1]!.details).toMatchObject({ failed: true, code: "invalid_source", issues: [{ entry_contract: {
    selected_entry: "step", source_format: "module", required_exports: ["step"], optional_exports: ["activate"],
    parameter_count: 3, detected_exports: ["step", "activate"], omitted_exports: 0,
    detected_signatures: [
      { name: "step", parameter_count: 2, plain_parameters: true, async: false, generator: false },
      { name: "activate", parameter_count: 0, plain_parameters: true, async: false, generator: false },
    ],
  } }] });
  expect(f.agent().results[2]!.isError).toBe(true);
  expect(f.agent().results[2]!.details).toMatchObject({ failed: true, code: "invalid_source", issues: [{ entry_contract: {
    selected_entry: "analyze", source_format: "module", required_exports: ["analyze"], optional_exports: [],
    parameter_count: 1, detected_exports: ["analyze"], omitted_exports: 0,
    detected_signatures: [{ name: "analyze", parameter_count: 1, plain_parameters: true, async: true, generator: false }],
  } }] });
  expect(f.agent().results[3]!.isError).not.toBe(true);
  expect(candidate.sources).toHaveLength(1);
  expect(f.owner.snapshot()?.source_versions).toBe(1);
  expect(f.counters()).toMatchObject({ compiled: 1, activated: 0 });
  await f.owner.close();
});

test("async bodies require explicit run entry and cannot be selected as the executive root", async () => {
  const source = "return {status:'blocked',summary:'software fixture',result:null};";
  const f = fixture([
    { name: "program_write", args: { name: "child", source } },
    { name: "program_write", args: { name: "child", entry: "run", source } },
    { name: "program_write", args: { name: "executive", source: rootSource,
      dependencies: [{ name: "child", version: 1 }] } },
    { name: "prepare_finish", args: { name: "child", version: 1, args: null, initial_state: null,
      limits: {}, session: { schema_version: 1 } } },
    rootCalls()[1]!,
  ]);
  await f.owner.initialize(); await f.owner.start(f.request); const candidate = await f.ready;
  expect(f.agent().results[0]!.isError).toBe(true);
  expect(f.agent().results[1]!.isError).not.toBe(true);
  expect(f.agent().results[2]!.isError).not.toBe(true);
  expect(f.agent().results[3]!.isError).toBe(true);
  expect(candidate.sources.map(value => [value.name, value.entry, value.version])).toEqual([
    ["child", "run", 1], ["executive", "step", 1],
  ]);
  expect(f.owner.snapshot()?.source_versions).toBe(2);
  expect(f.counters()).toMatchObject({ compiled: 1, activated: 0 });
  await f.owner.close();
});

test("cancel fences a late authentic Agent allocation and joins its exact release", async () => {
  const allocation = Promise.withResolvers<Agent>();
  const entered = Promise.withResolvers<void>();
  let releases = 0;
  const f = fixture([], { auth: { snapshot: sourceAuthState,
    createAgent: async () => { entered.resolve(); return allocation.promise; }, releaseAgent: async () => { releases++; } } });
  await f.owner.initialize(); const start = await f.owner.start(f.request); await entered.promise;
  const cancelling = f.owner.cancel(start.preparation_id);
  expect(f.owner.snapshot()?.phase).toBe("cancelling");
  allocation.resolve(new ScriptedSourceAgent([], []) as unknown as Agent);
  const result = await cancelling;
  expect(result.closure).toBe("closed"); expect(result.phase).toBe("cancelled"); expect(releases).toBe(1);
  expect(f.counters().compiled).toBe(0); await f.owner.close();
});

test("cancel during clean compile readiness closes the late worker without invoking activate", async () => {
  const compilation = Promise.withResolvers<ResidentWorker>();
  const entered = Promise.withResolvers<AbortSignal>();
  let closed = 0, activated = 0;
  const f = fixture(rootCalls(), { sandbox: { createResidentWorker: async (_bundle, _budget, signal) => {
    entered.resolve(signal); return compilation.promise;
  }, createResidentAnalysisWorker: async () => { throw new Error("No analysis"); } } });
  await f.owner.initialize(); const start = await f.owner.start(f.request); const signal = await entered.promise;
  const cancellation = f.owner.cancel(start.preparation_id); expect(signal.aborted).toBe(true);
  compilation.resolve({ async close() { closed++; }, async activate() { activated++; return { refused: true, reason: "test" }; },
    async step() { throw new Error("No frame"); } });
  expect((await cancellation).closure).toBe("closed"); expect(closed).toBe(1); expect(activated).toBe(0);
  await f.owner.close();
});

test("source call receipts replay exactly while stale CAS parents cannot rebase immutable history", async () => {
  const write = { ...rootCalls()[0]!, id: "stable-source-call" };
  const revisedSource = rootSource + "\n";
  const f = fixture([write,
    { name: "program_write", args: { name: "executive", entry: "step", based_on: 2, source: revisedSource } },
    { name: "program_write", args: { name: "executive", entry: "step", based_on: 1, source: revisedSource } },
    { name: "prepare_finish", args: { name: "executive", version: 2, args: null, initial_state: null, limits: {}, session: { schema_version: 1 } } }]);
  await f.owner.initialize(); const accepted = await f.owner.start(f.request);
  const retry = await f.owner.start(structuredClone(f.request));
  expect(retry.preparation_id).toBe(accepted.preparation_id); expect(retry.deadline_at).toBe(accepted.deadline_at);
  const candidate = await Promise.race([f.ready, f.terminal.then(view => {
    if (view.phase !== "started") throw f.promptFailure() ?? new Error(view.error ?? "Source receipt fixture failed before readiness");
    return f.ready;
  })]);
  expect(candidate.root.version).toBe(2); expect(f.owner.snapshot()?.source_versions).toBe(2);
  const writeTool = f.agent().tools.find(tool => tool.name === "program_write")!;
  // Transport redelivery retains the original call, rather than asking a
  // provider response to issue the same tool-call identity twice.
  expect((await writeTool.execute(write.id, write.args)).details).toEqual(f.agent().results[0]!.details);
  expect(f.agent().results[1]!.isError).toBe(true);
  expect(f.owner.snapshot()?.tools_used).toBe(4); // The identical durable receipt did not spend a second tool.
  await f.owner.close();
});

test("approved references stay outside the empty catalog until the selected model explicitly copies their hash", async () => {
  const reference = approvedReference();
  const copy = { name: "executive", reference_hash: reference.hash, entry: "step" };
  const f = fixture([
    { name: "program_inspect", args: { view: "catalog" } },
    { name: "help", args: { topic: "overview" } },
    { name: "program_inspect", args: { view: "reference_source", reference_hash: "0".repeat(64) } },
    { name: "program_inspect", args: { view: "reference_source", reference_hash: reference.hash } },
    { name: "program_inspect", args: { view: "catalog" } },
    { name: "program_copy", args: { ...copy, reference_hash: "0".repeat(64) } },
    { name: "program_copy", args: { name: copy.name, reference_hash: copy.reference_hash } },
    { name: "program_copy", args: { ...copy, entry: "run" } },
    { name: "program_copy", args: copy, id: "selected-copy" },
    { name: "program_edit", args: { name: "executive", based_on: 1,
      edits: [{ old_text: "software fixture only", new_text: "software fixture revised" }] } },
    { ...rootCalls()[1]!, args: { ...rootCalls()[1]!.args as object, version: 2 } },
  ], { sourceReferences: [reference] });
  // Mutating constructor task material later must not change the detached registry.
  reference.card.purpose = "MUTATED_AFTER_CONSTRUCTION";
  await f.owner.initialize(); await f.owner.start(f.request); const candidate = await f.ready;
  const results = f.agent().results;
  expect(results[0]!.details).toEqual([]);
  expect(results[1]!.details).toMatchObject({ source_references: [{
    reference_hash: reference.hash, entry: "step", provenance: reference.provenance }] });
  expect(JSON.stringify(results[1]!.details)).not.toContain(rootSource);
  expect(results[2]!.isError).toBe(true);
  expect(JSON.stringify(results[2]!.details)).not.toContain(rootSource);
  expect(results[3]!.details).toMatchObject({ source: rootSource, reference_hash: reference.hash });
  expect(results[4]!.details).toEqual([]);
  for (const index of [5, 6, 7]) expect(results[index]!.isError).toBe(true);
  expect(results[8]!.details).toMatchObject({ name: "executive", version: 1,
    card: { purpose: "Synthetic source-copy protocol" },
    operation: { tool: "program_copy", provenance: { reference_hash: reference.hash,
      operator_provenance: reference.provenance } } });
  const copied = (results[8]!.details as { source: string; hash: string });
  expect(copied.hash).toBe(createHash("sha256").update(copied.source, "utf8").digest("hex"));
  expect(candidate.root.version).toBe(2);
  expect(f.counters().activated).toBe(0);
  const copyTool = f.agent().tools.find(tool => tool.name === "program_copy")!;
  expect((await copyTool.execute("selected-copy", copy)).details).toEqual(results[8]!.details);
  expect((await copyTool.execute("selected-copy", { ...copy, name: "other" })).isError).toBe(true);
  expect((await copyTool.execute("late-copy", { ...copy, name: "other" })).isError).toBe(true);
  const rows: { type: string; details: Record<string, Json> }[] =
    readFileSync(join(f.directory, "prepared-source", readdirSync(join(f.directory, "prepared-source"))[0]!), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
  const mutations = rows.filter(row => row.type === "source.written");
  expect(mutations).toHaveLength(2);
  expect(mutations[0]!.details).toMatchObject({ tool: "program_copy", tool_call_id: "selected-copy",
    provenance: { reference_hash: reference.hash, operator_provenance: reference.provenance },
    receipt: results[8]!.details });
  expect(mutations[0]!.details.identity).toContain('"tool":"program_copy"');
  expect(rows.filter(row => row.type === "tool.receipt" && row.details.call_id === "selected-copy")).toHaveLength(0);
  const prompt = rows.find(row => row.type === "model.prompt")!;
  expect(JSON.stringify(prompt.details)).not.toContain(rootSource);
  await f.owner.close();
});

test("invalid approved registries fail before auth, inference or admission without exposing source", async () => {
  const reference = approvedReference();
  let consulted = 0;
  const f = fixture();
  const invalid: unknown[] = [
    [{ ...reference, hash: "f".repeat(64) }],
    [{ ...reference, entry: "guessed" }],
    [{ ...reference, provenance: "" }],
    [{ ...reference, card: { ...reference.card, purpose: "" } }],
    [{ ...reference, source: "é".repeat(9000) }],
    [approvedReference("a".repeat(16380) + "XX\ude00", "library")],
    [reference, { ...reference, provenance: "conflicting provenance" }],
    Array.from({ length: 33 }, () => reference),
  ];
  for (const sourceReferences of invalid) {
    let failure: unknown;
    try {
      new PreparedSource({ ...f.options, sourceReferences: sourceReferences as readonly ApprovedSourceReference[],
        auth: { ...f.options.auth, snapshot() { consulted++; return sourceAuthState(); },
          async createAgent() { consulted++; throw new Error("Unexpected inference"); } },
        assertCanStart() { consulted++; }, async getContract() { consulted++; throw new Error("Unexpected contract"); } });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(rootSource);
  }
  expect(consulted).toBe(0);
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  expect(f.agent().tools.some(tool => tool.name === "program_copy")).toBe(false);
  await f.owner.close();
});

test("exact source edits preserve the canonical entry card and pinned imports with atomic failures and immutable replay", async () => {
  const card = approvedReference().card;
  const source = "import {value} from './helper.js'; export function analyze(input) { return {value:value(input),label:'unchanged'}; }";
  const edits = [{ old_text: '"unchanged"', new_text: '"changed"' }];
  const edit: Call = { name: "program_edit", id: "exact-edit",
    args: { name: "probe", based_on: 1, edits } };
  const f = fixture([
    { name: "program_write", args: { name: "helper", entry: "library",
      source: "export function value(input) { return input; }" } },
    { name: "program_write", args: { name: "probe", entry: "analyze", source, card,
      dependencies: [{ name: "helper", version: 1, import_path: "./helper.js" }] } },
    { name: "program_edit", args: { name: "probe", based_on: 1, edits: [
      { old_text: '"unchanged"', new_text: '"would partially change"' },
      { old_text: "ABSENT_EXACT_TEXT", new_text: "" }] } },
    { name: "program_edit", args: { name: "probe", based_on: 1, edits: [{ old_text: "input", new_text: "ambiguous" }] } },
    edit,
    { name: "program_edit", args: { name: "probe", based_on: 1, edits } },
    { name: "program_edit", args: { name: "probe", based_on: 2,
      edits: [{ old_text: '"changed"', new_text: '"third version"' }] } },
    ...rootCalls(),
  ]);
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  const results = f.agent().results;
  for (const index of [2, 3, 5]) expect(results[index]!.isError).toBe(true);
  expect(results[4]!.details).toMatchObject({ entry: "analyze", version: 2, based_on: 1, card,
    dependencies: [{ name: "helper", version: 1, import_path: "./helper.js" }],
    operation: { tool: "program_edit", provenance: { based_on: 1, edits } } });
  expect((results[4]!.details as { source: string }).source).toContain('import { value } from "./helper.js"');
  expect((results[4]!.details as { source: string }).source).not.toContain("would partially change");
  const editTool = f.agent().tools.find(tool => tool.name === "program_edit")!;
  expect((await editTool.execute(edit.id!, edit.args)).details).toEqual(results[4]!.details);
  expect((await editTool.execute(edit.id!, { name: "probe", based_on: 2, edits })).isError).toBe(true);
  expect((await editTool.execute("late-edit", { name: "probe", based_on: 3, edits })).isError).toBe(true);
  expect(f.counters().activated).toBe(0);
  expect(f.owner.snapshot()?.analysis_jobs).toBe(0);
  expect(f.owner.snapshot()?.source_versions).toBe(5);
  const rows: { type: string; details: Record<string, Json> }[] =
    readFileSync(join(f.directory, "prepared-source", readdirSync(join(f.directory, "prepared-source"))[0]!), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === "source.written" && row.details.tool === "program_edit")).toHaveLength(2);
  const mutation = rows.find(row => row.type === "source.written" && row.details.tool_call_id === edit.id)!;
  expect(mutation.details).toMatchObject({ provenance: { based_on: 1, edits }, receipt: results[4]!.details });
  expect(mutation.details.identity).toContain('"tool":"program_edit"');
  expect(rows.filter(row => row.type === "tool.receipt" && row.details.call_id === edit.id)).toHaveLength(0);
  await f.owner.close();
});

test("an exact prepared edit can extract a helper with explicit pins while rejected graphs leave the parent intact", async () => {
  const adapter = minecraftTestAdapter(), compatibility = adapterCompatibility(adapter.descriptor, adapter.schemas);
  const book = new PreparedSourcebook(compatibility.compatibility_hash, adapter, () => {}, () => {});
  await book.write({ name: "probe", entry: "analyze",
    source: "function value(input) { return input + 1; } export function analyze(input) { return value(input); }" }, "root", "request");
  await book.write({ name: "helper", entry: "library",
    source: "export function value(input) { return input + 2; }" }, "helper", "request");
  const parent = structuredClone(book.select({ name: "probe" }));
  const prefix = parent.source.slice(0, parent.source.indexOf("export function analyze"));
  const edits = [{ old_text: prefix, new_text: 'import { value } from "./helper.js";\n' }];
  await expect(book.edit({ name: "probe", based_on: 1, edits,
    dependencies: [{ name: "missing", version: 1, import_path: "./helper.js" }] }, "bad-pin", "request")).rejects.toThrow();
  expect(book.select({ name: "probe" })).toEqual(parent);
  const input = { name: "probe", based_on: 1, edits,
    dependencies: [{ name: "helper", version: 1, import_path: "./helper.js" }] };
  const receipt = await book.edit(input, "extract", "request");
  await book.write({ name: "helper", entry: "library", based_on: 1,
    source: "export function value(input) { return input + 3; }" }, "newer-helper", "request");
  expect(await book.edit(input, "extract", "request")).toEqual(receipt);
  const controller = new AbortController();
  const worker = await residentAnalysisProcess(book.bundle(book.select({ name: "probe", version: 2 })), 500, controller.signal);
  try { expect(await worker.analyze(40, controller.signal)).toBe(42); }
  finally { await worker.close(); }
  expect(book.select({ name: "probe", version: 1 })).toEqual(parent);
});

test("copy never hydrates dependencies and exact revisions retain post-validation CAS and lifecycle fences", async () => {
  const reference = approvedReference("import {value} from './helper.js'; export function analyze(input) { return value(input); }", "analyze");
  const rows: string[] = [];
  let revoked = false, failAppend = false;
  const adapter = minecraftTestAdapter();
  const compatibility = adapterCompatibility(adapter.descriptor, adapter.schemas);
  const book = new PreparedSourcebook(compatibility.compatibility_hash, adapter, type => {
    if (failAppend) throw new Error("Simulated durable append failure");
    rows.push(type);
  }, () => { if (revoked) throw new Error("Revoked authority"); }, [reference]);
  const copy = { name: "probe", entry: "analyze", reference_hash: reference.hash };
  expect(book.catalog()).toEqual([]);
  await expect(book.copy(copy, "missing-pin", "request")).rejects.toThrow();
  expect(book.versions).toBe(0); expect(rows).toHaveLength(0);
  await book.write({ name: "helper", entry: "library", source: "export function value(input) { return input; }" }, "helper", "request");
  await expect(book.copy(copy, "still-missing-pin", "request")).rejects.toThrow();
  const pinned = { ...copy, dependencies: [{ name: "helper", version: 1, import_path: "./helper.js" }] };
  failAppend = true;
  await expect(book.copy(pinned, "durable-copy", "request")).rejects.toThrow();
  expect(book.versions).toBe(1); expect(rows).toHaveLength(1);
  failAppend = false;
  const receipt = await book.copy(pinned, "durable-copy", "request");
  const edits = [{ old_text: "return value(input)", new_text: "return value(null)" }];
  const concurrent = await Promise.allSettled([
    book.edit({ name: "probe", based_on: 1, edits }, "edit-a", "request"),
    book.edit({ name: "probe", based_on: 1, edits }, "edit-b", "request"),
  ]);
  expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(concurrent.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(book.select({ name: "probe" }).version).toBe(2);
  expect(await book.copy(pinned, "durable-copy", "request")).toEqual(receipt);
  const cancelled = book.edit({ name: "probe", based_on: 2,
    edits: [{ old_text: "return value(null)", new_text: "return value(input)" }] }, "cancelled-edit", "request");
  revoked = true;
  await expect(cancelled).rejects.toThrow();
  expect(book.select({ name: "probe" }).version).toBe(2);
  revoked = false; book.seal();
  await expect(book.copy({ ...pinned, name: "late" }, "late-copy", "request")).rejects.toThrow();
  await expect(book.edit({ name: "probe", based_on: 2, edits }, "late-edit", "request")).rejects.toThrow();
  expect(rows.filter(type => type === "source.written")).toHaveLength(3);
});

test("copy and edit share immutable all-history version and source-byte budgets", async () => {
  const reference = approvedReference("export const value = 1;", "library");
  const adapter = minecraftTestAdapter();
  const compatibility = adapterCompatibility(adapter.descriptor, adapter.schemas);
  const book = new PreparedSourcebook(compatibility.compatibility_hash, adapter, () => {}, () => {}, [reference]);
  await book.copy({ name: "helper", entry: "library", reference_hash: reference.hash }, "copy", "request");
  for (let version = 1; version < PREPARED_START_LIMITS.max_source_versions; version++)
    await book.edit({ name: "helper", based_on: version, edits: [{
      old_text: `value = ${version}`, new_text: `value = ${version + 1}`,
    }] }, `edit-${version}`, "request");
  expect(book.versions).toBe(PREPARED_START_LIMITS.max_source_versions);
  expect(book.sourceBytes).toBeGreaterThan(Buffer.byteLength(book.select({ name: "helper" }).source));
  await expect(book.copy({ name: "another", entry: "library", reference_hash: reference.hash }, "overflow-copy", "request")).rejects.toThrow();
  await expect(book.edit({ name: "helper", based_on: PREPARED_START_LIMITS.max_source_versions,
    edits: [{ old_text: "value = 64", new_text: "value = 65" }] }, "overflow-edit", "request")).rejects.toThrow();
  expect(book.versions).toBe(PREPARED_START_LIMITS.max_source_versions);
  const largeReference = approvedReference(`/*${"x".repeat(15500)}*/\nexport const value = 1;`, "library");
  const largeBook = new PreparedSourcebook(compatibility.compatibility_hash, adapter, () => {}, () => {}, [largeReference]);
  const largeCopy = { entry: "library", reference_hash: largeReference.hash };
  await largeBook.copy({ ...largeCopy, name: "large-0" }, "large-copy-0", "request");
  const size = largeBook.sourceBytes;
  const maximumVersions = Math.floor(PREPARED_START_LIMITS.max_source_bytes / size);
  for (let index = 1; index < maximumVersions; index++)
    await largeBook.copy({ ...largeCopy, name: `large-${index}` }, `large-copy-${index}`, "request");
  const before = largeBook.sourceBytes;
  await expect(largeBook.copy({ ...largeCopy, name: "overflow" }, "bytes-overflow-copy", "request")).rejects.toThrow();
  await expect(largeBook.edit({ name: "large-0", based_on: 1,
    edits: [{ old_text: "value = 1", new_text: "value = 2" }] }, "bytes-overflow-edit", "request")).rejects.toThrow();
  expect(largeBook.sourceBytes).toBe(before);
  expect(largeBook.versions).toBe(maximumVersions);
});

test("source edits do not renew the original forty-eight-tool allowance", async () => {
  const calls: Call[] = [rootCalls()[0]!];
  for (let version = 1; version <= PREPARED_START_LIMITS.max_tools; version++)
    calls.push({ name: "program_edit", args: { name: "executive", based_on: version,
      edits: [{ old_text: version === 1 ? "software fixture only" : `software fixture revision ${version}`,
        new_text: `software fixture revision ${version + 1}` }] } });
  calls.push({ ...rootCalls()[1]!, args: { ...rootCalls()[1]!.args as object, version: PREPARED_START_LIMITS.max_tools } });
  const f = fixture(calls);
  await f.owner.initialize(); await f.owner.start(f.request); const terminal = await f.terminal;
  expect(terminal.tools_used).toBe(PREPARED_START_LIMITS.max_tools);
  expect(terminal.source_versions).toBe(PREPARED_START_LIMITS.max_tools);
  expect(terminal.phase).toBe("failed");
  expect(f.counters()).toMatchObject({ compiled: 0, activated: 0 });
  await f.owner.close();
});

test("pretransfer launch cancellation joins its launch owner and refuses a late worker claim", async () => {
  const entered = Promise.withResolvers<PreparedSourceCandidate>(), release = Promise.withResolvers<void>();
  let cancelled = 0;
  const f = fixture(rootCalls(), { onReady: async candidate => {
    entered.resolve(candidate); await release.promise;
    candidate.takeWorker("too-late-run"); return { run_id: "too-late-run" };
  }, onCancel: async () => { cancelled++; release.resolve(); } });
  await f.owner.initialize(); const start = await f.owner.start(f.request); const candidate = await entered.promise;
  const result = await f.owner.cancel(start.preparation_id);
  expect(result.phase).toBe("cancelled"); expect(result.closure).toBe("closed"); expect(cancelled).toBe(1);
  expect(() => candidate.takeWorker("another-late-run")).toThrow();
  expect(f.counters().closed).toBe(1); await f.owner.close();
});

test("transfer ends preparation abort authority even while launch callback completion is outstanding", async () => {
  const transferred = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let signal: AbortSignal | null = null, closed = 0;
  const f = fixture(rootCalls(), { sandbox: {
    createResidentWorker: async (_bundle, _budget, received) => {
      signal = received;
      return { async close() { closed++; }, async activate() { throw new Error("No frame"); }, async step() { throw new Error("No frame"); } };
    }, createResidentAnalysisWorker: async () => { throw new Error("No analysis"); },
  }, onReady: async candidate => {
    candidate.takeWorker("admitted-before-strategy-open"); transferred.resolve(); await release.promise;
    return { run_id: "admitted-before-strategy-open" };
  } });
  await f.owner.initialize(); const start = await f.owner.start(f.request); await transferred.promise;
  expect(f.owner.snapshot()?.phase).toBe("started");
  await expect(f.owner.start({ ...f.request, request_id: crypto.randomUUID() })).rejects.toThrow();
  expect((await f.owner.start(f.request)).preparation_id).toBe(start.preparation_id);
  await expect(f.owner.cancel(start.preparation_id)).rejects.toThrow();
  const closing = f.owner.close();
  expect(signal!.aborted).toBe(false); expect(closed).toBe(0);
  release.resolve(); await closing;
  expect(signal!.aborted).toBe(false); expect(closed).toBe(0);
});

test("finite pure analysis budget admits at most eight software jobs and keeps failed calls replayable", async () => {
  const calls: Call[] = [{ name: "program_write", args: { name: "check", entry: "analyze", source: "export function analyze(input) { return input; }" } },
    ...Array.from({ length: 9 }, () => ({ name: "program_analyze", args: { name: "check", version: 1, input: null } })), ...rootCalls()];
  let jobs = 0;
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async () => ({ async analyze(_input, _signal, report) {
    jobs++; report?.(500); return null;
  }, async close() {} });
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  expect(jobs).toBe(8); expect(f.owner.snapshot()?.analysis_jobs).toBe(8);
  expect(f.owner.snapshot()?.analysis_ms).toBe(4000); expect(f.agent().results[9]!.isError).toBe(true);
  await f.owner.close();
});

test("an imported source assertion reaches preparation as untrusted advice with its exact executable bundle identity", async () => {
  const calls: Call[] = [
    { name: "program_write", args: { name: "assertions", entry: "library",
      source: "export function assert(value) { if (!value) throw new TypeError('probe assertion: expected explicit state'); }" } },
    { name: "program_write", args: { name: "probe", entry: "analyze",
      source: "import {assert} from './assertions.js'; export function analyze(input) { assert(input); return null; }",
      dependencies: [{ name: "assertions", version: 1, import_path: "./assertions.js" }] } },
    { name: "program_analyze", id: "source-assertion", args: { name: "probe", version: 1, input: false } },
    ...rootCalls(),
  ];
  let bundleHash = "", rootHash = "", closed = 0;
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async (bundle, budget, signal) => {
    bundleHash = bundle.source_hash; rootHash = bundle.modules.find(module => module.id === bundle.root)!.source_hash;
    const worker = await residentAnalysisProcess(bundle, budget, signal);
    return { analyze: worker.analyze, async close() { await worker.close(); closed++; } };
  };
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  const failure = f.agent().results[2]!;
  expect(failure.isError).toBe(true);
  expect(failure.details).toMatchObject({ failed: true, code: "source_throw",
    source_diagnostic: { advisory: true, trusted_origin: false, origin: "source_throw", diagnostic: {
      type: "TypeError", message: "probe assertion: expected explicit state",
      source_hash: bundleHash, location: { mapping: "unmapped" },
    } } });
  expect(bundleHash).not.toBe(rootHash);
  expect(JSON.stringify(failure.content)).toContain("probe assertion: expected explicit state");
  expect(closed).toBe(1); expect(f.owner.snapshot()?.analysis_jobs).toBe(1);
  expect(f.owner.snapshot()?.analysis_ms).toBeGreaterThan(0);
  const tool = f.agent().tools.find(tool => tool.name === "program_analyze")!;
  expect((await tool.execute("source-assertion", calls[2]!.args)).details).toEqual(failure.details);
  await f.owner.close();
});

test("source analysis validates the exact imported activation return after accounting and joins its original disposable owner", async () => {
  const selectedSource = `export function activate(frame,state,intent) { return step(frame,state,intent); }
    export function step(frame,state,intent) { return {choice:{kind:'observe'},
      next_state:{memory:'é'.repeat(8192)},status:'running',events:[]}; }`;
  const analyze = { name: "probe", version: 1, input: { frame: { synthetic: true }, state: null, intent: null }, validate_as: "activation" };
  const calls: Call[] = [
    { name: "program_write", args: { name: "executive", entry: "step", source: selectedSource } },
    { name: "program_write", args: { name: "probe", entry: "analyze",
      source: "import {activate} from './candidate.js'; export function analyze(input) { return activate(input.frame,input.state,input.intent); }",
      dependencies: [{ name: "executive", version: 1, import_path: "./candidate.js" }] } },
    { name: "program_analyze", id: "exact-return", args: analyze },
    { name: "program_analyze", args: { ...analyze, validate_as: "not-a-shape" } },
    rootCalls()[1]!,
  ];
  const closing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const budgets: number[] = [];
  let closed = 0;
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async (bundle, budget, signal) => {
    budgets.push(budget);
    const worker = await residentAnalysisProcess(bundle, budget, signal);
    return { analyze: worker.analyze, async close() {
      closing.resolve(); await release.promise; await worker.close(); closed++;
    } };
  };
  await f.owner.initialize(); await f.owner.start(f.request);
  try {
    await closing.promise;
    expect(f.agent().results).toHaveLength(2);
    expect(f.counters()).toMatchObject({ compiled: 0, activated: 0 });
    expect(f.owner.snapshot()?.analysis_jobs).toBe(1);
    expect(f.owner.snapshot()?.analysis_ms).toBeGreaterThan(0);
    expect(budgets).toHaveLength(1); expect(budgets[0]).toBeGreaterThan(0); expect(budgets[0]).toBeLessThanOrEqual(500);
  } finally { release.resolve(); }
  await f.ready;
  const failure = f.agent().results[2]!;
  expect(failure.isError).toBe(true);
  expect(failure.details).toMatchObject({ failed: true, code: "invalid_program_result",
    issues: [{ code: "custom", path: "next_state", constraint: "utf8_bytes", maximum: 16384 }] });
  const retained = failure.details as { output: { next_state: Json }; issues: { maximum: number }[] };
  expect(Buffer.byteLength(JSON.stringify(retained.output.next_state))).toBeGreaterThan(retained.issues[0]!.maximum);
  const analysisTool = f.agent().tools.find(tool => tool.name === "program_analyze")!;
  // Transport redelivery is not a contradictory duplicate call inside one
  // provider response. Replay the actual retained tool receipt after sealing.
  expect((await analysisTool.execute("exact-return", analyze)).details).toEqual(failure.details);
  expect((await analysisTool.execute("exact-return", { ...analyze, validate_as: "decision" })).isError).toBe(true);
  expect(f.agent().results[3]!.isError).toBe(true);
  expect(budgets).toHaveLength(1); expect(closed).toBe(1);
  expect(f.owner.snapshot()?.analysis_jobs).toBe(1);
  expect(f.owner.snapshot()?.analysis_ms).toBeLessThanOrEqual(budgets[0]!);
  expect(f.counters().activated).toBe(0);
  await f.owner.close();
});

test("source activation refusal validates only software return shape and retains its unmodified output", async () => {
  const calls: Call[] = [rootCalls()[0]!,
    { name: "program_write", args: { name: "probe", entry: "analyze",
      source: "import {activate} from './candidate.js'; export function analyze(input) { return activate(input.frame,input.state,input.intent); }",
      dependencies: [{ name: "executive", version: 1, import_path: "./candidate.js" }] } },
    { name: "program_analyze", args: { name: "probe", version: 1, input: { frame: { synthetic: true }, state: null, intent: null },
      validate_as: "activation" } }, rootCalls()[1]!,
  ];
  let closed = 0;
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async (bundle, budget, signal) => {
    const worker = await residentAnalysisProcess(bundle, budget, signal);
    return { analyze: worker.analyze, async close() { await worker.close(); closed++; } };
  };
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  expect(f.agent().results[2]!.isError).not.toBe(true);
  expect(f.agent().results[2]!.details).toMatchObject({ qualification: "synthetic_software_test_only",
    output: { refused: true, reason: "software fixture only" },
    validation: { validate_as: "activation", qualification: "software_return_shape_only" } });
  expect(f.owner.snapshot()?.analysis_jobs).toBe(1);
  expect(f.owner.snapshot()?.analysis_ms).toBeGreaterThan(0);
  expect(closed).toBe(1); expect(f.counters().activated).toBe(0);
  await f.owner.close();
});

test("all-history canonical source budget includes unselected library versions", async () => {
  const source = "export const value = 1; /*" + "x".repeat(16000) + "*/";
  const calls: Call[] = [...Array.from({ length: 35 }, (_, index) => ({ name: "program_write",
    args: { name: `unused-library-${index}`, entry: "library", source } })), ...rootCalls()];
  const f = fixture(calls); await f.owner.initialize(); await f.owner.start(f.request); const candidate = await f.ready;
  expect(candidate.sources).toHaveLength(1); // Runtime closure is distinct from the bounded complete authoring history.
  expect(f.owner.snapshot()?.source_versions).toBe(33);
  expect(f.agent().results[32]!.isError).toBe(true);
  await f.owner.close();
});

test("the original owner refuses a thirteenth selected-model request rather than renewing its allowance", async () => {
  const f = fixture([]);
  f.options.auth.createAgent = async input => {
    const agent = new ScriptedSourceAgent(input.tools, []);
    agent.prompt = async () => {
      for (let index = 0; index < 13; index++) {
        if (agent.gate?.({})) return;
        const stream = await agent.streamFn(agent.state.model as never, { messages: [], tools: input.tools } as never, {});
        for await (const _event of stream) {}
        const response = { role: "assistant", content: [], stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } as unknown as AssistantMessage;
        for (const listener of agent.listeners) listener({ type: "message_end", message: response });
      }
      throw new Error("A thirteenth request must never be admitted");
    };
    return agent as unknown as Agent;
  };
  await f.owner.initialize(); await f.owner.start(f.request); const terminal = await f.terminal;
  expect(terminal.phase).toBe("failed"); expect(terminal.requests_admitted).toBe(12);
  expect(terminal.usage.calls).toBe(12); expect(f.counters().compiled).toBe(0);
  await f.owner.close();
});

test("pure library and analyze software tests retain all runtime child source without qualifying gameplay", async () => {
  const calls: Call[] = [
    { name: "program_write", args: { entry: "library", name: "numbers", source: "export function plus(a,b) { return a+b; }" } },
    { name: "program_write", args: { entry: "analyze", name: "software check", source: "import {plus} from './n.js'; export function analyze(input) { return plus(input.a,input.b); }",
      dependencies: [{ name: "numbers", version: 1, import_path: "./n.js" }] } },
    { name: "program_analyze", args: { name: "software check", version: 1, input: { a: 2, b: 3 } } },
    { name: "program_write", args: { entry: "run", name: "child", source: "return {status:'blocked',summary:'software fixture',result:null};" } },
    { name: "program_write", args: { entry: "step", name: "executive", source: rootSource,
      dependencies: [{ name: "child", version: 1 }] } }, rootCalls()[1]!,
  ];
  let analyses = 0, analysisClosed = 0;
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async (_bundle, budget) => {
    expect(budget).toBeLessThanOrEqual(500);
    const worker: ResidentAnalysisWorker = { async analyze(_input, _signal, report) { analyses++; report?.(2); return 5; },
      async close() { analysisClosed++; } }; return worker;
  };
  await f.owner.initialize(); await f.owner.start(f.request); const candidate = await f.ready;
  expect(candidate.sources.map(source => source.name).sort()).toEqual(["child", "executive"]);
  expect(analyses).toBe(1); expect(analysisClosed).toBe(1);
  const result = f.agent().results[2]!.details as { qualification: string };
  expect(result.qualification).toBe("synthetic_software_test_only");
  expect(f.owner.snapshot()?.analysis_ms).toBe(2);
  await f.owner.close();
});

test("cancellation joins a late pure analysis result and original worker cleanup", async () => {
  const result = Promise.withResolvers<Json>(), entered = Promise.withResolvers<void>(); let closed = 0;
  const calls: Call[] = [{ name: "program_write", args: { name: "check", entry: "analyze", source: "export function analyze(input) { return input; }" } },
    { name: "program_analyze", args: { name: "check", version: 1, input: null } }, ...rootCalls()];
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async () => ({ async analyze(_input, _signal, report) {
    entered.resolve(); const value = await result.promise; report?.(1); return value;
  }, async close() { closed++; } });
  await f.owner.initialize(); const start = await f.owner.start(f.request); await entered.promise;
  const cancellation = f.owner.cancel(start.preparation_id); result.resolve(null);
  expect((await cancellation).closure).toBe("closed"); expect(closed).toBe(1); expect(f.counters().compiled).toBe(0);
  await f.owner.close();
});

test("a semantic dependency chain cannot exceed the same depth bound before world launch", async () => {
  const calls: Call[] = Array.from({ length: 9 }, (_, index) => ({ name: "program_write", args: {
    entry: "run", name: `procedure-${index}`, source: "return {status:'blocked',summary:'software boundary',result:null};",
    dependencies: index ? [{ name: `procedure-${index - 1}`, version: 1 }] : [],
  } }));
  const f = fixture([...calls, ...rootCalls()]);
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  expect(f.agent().results[7]!.isError).not.toBe(true);
  expect(f.agent().results[8]!.isError).toBe(true);
  expect(f.owner.snapshot()?.source_versions).toBe(9);
  await f.owner.close();
});

test("a private service exception is not exposed through model-facing analysis errors", async () => {
  const calls: Call[] = [{ name: "program_write", args: { entry: "analyze", name: "check",
    source: "export function analyze(input) { return input; }" } },
    { name: "program_analyze", args: { name: "check", version: 1, input: null } }, ...rootCalls()];
  const f = fixture(calls);
  f.options.sandbox.createResidentAnalysisWorker = async () => { throw new Error("PRIVATE_PREPARATION_SECRET /private/host/path"); };
  await f.owner.initialize(); await f.owner.start(f.request); await f.ready;
  expect(f.agent().results[1]).toMatchObject({ isError: true, details: { code: "service_failure" } });
  expect(JSON.stringify(f.agent().results[1])).not.toContain("PRIVATE_PREPARATION_SECRET");
  expect(JSON.stringify(f.agent().results[1])).not.toContain("/private/host/path");
  await f.owner.close();
});

test("an oversized streamed response is fenced and its original iterator closes before any source executes", async () => {
  let iteratorClosed = false, agent: ScriptedSourceAgent | null = null;
  const f = fixture();
  f.options.auth.createAgent = async input => {
    agent = new ScriptedSourceAgent(input.tools, rootCalls());
    agent.streamFn = (() => ({ async *[Symbol.asyncIterator]() {
      try {
        for (let index = 0; index < 2; index++)
          yield { type: "text_delta", contentIndex: 0, delta: "x".repeat(600 * 1024), partial: { content: [] } };
      } finally { iteratorClosed = true; }
    } })) as unknown as StreamFn;
    return agent as unknown as Agent;
  };
  await f.owner.initialize(); await f.owner.start(f.request);
  const result = await f.terminal;
  expect(result).toMatchObject({ phase: "failed", closure: "closed", requests_admitted: 1, source_versions: 0 });
  expect(iteratorClosed).toBe(true); expect(f.counters().compiled).toBe(0);
  await f.owner.close();
});

test("unknown cleanup blocks replacement and interrupted journals never resume old source work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prepared-interruption-")); directories.push(directory);
  const f = fixture(); await f.owner.initialize(); await f.owner.start(f.request); await f.ready; await f.owner.close();
  const name = readdirSync(join(f.directory, "prepared-source"))[0]!;
  const rows = readFileSync(join(f.directory, "prepared-source", name), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const header = rows.find(row => row.type === "attempt.created");
  const location = join(directory, "prepared-source");
  mkdirSync(location);
  writeFileSync(join(location, name), `${JSON.stringify(header)}\n`);
  const interrupted = new PreparedSource({ ...f.options, directory, auth: { ...f.options.auth,
    createAgent: async () => { throw new Error("Interrupted source inference must not resume"); } } });
  await interrupted.initialize();
  expect(interrupted.snapshot()?.closure).toBe("unknown"); expect(interrupted.snapshot()?.phase).toBe("failed");
  expect((await interrupted.start(f.request)).preparation_id).toBe(header.details.view.preparation_id);
  await expect(interrupted.start({ ...f.request, request_id: crypto.randomUUID() })).rejects.toThrow();
  await expect(interrupted.close()).rejects.toThrow();
});
