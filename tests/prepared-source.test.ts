import { afterEach, expect, test } from "bun:test";
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
import type { PreparedSourceCandidate } from "../src/server/prepared-source-contract.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
type Call = { name: string; args: unknown; id?: string };
const rootSource = "export function activate(frame,state,intent) { return {refused:true,reason:'software fixture only'}; } export function step(frame,state,intent) { return {choice:{kind:'observe'},next_state:state,status:'running',events:[]}; }";
const rootCalls = (): Call[] => [{ name: "program_write", args: { name: "executive", entry: "step", source: rootSource } },
  { name: "prepare_finish", args: { name: "executive", version: 1, args: null, initial_state: null, limits: {}, session: { schema_version: 1 } } }];
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
    if (!stopped) throw new Error("Fixture requires a terminal host gate");
  }
}

function fixture(calls = rootCalls(), overrides: Partial<PreparedSourceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "prepared-source-")); directories.push(directory);
  const adapter = minecraftTestAdapter();
  let agent: ScriptedSourceAgent | null = null, releases = 0, compiled = 0, closed = 0, activated = 0;
  let owner: PreparedSource;
  const terminal = Promise.withResolvers<PreparedStartView>();
  const ready = Promise.withResolvers<PreparedSourceCandidate>();
  const worker: ResidentWorker = { async step() { throw new Error("No step is authorized in source preparation"); },
    async activate() { activated++; throw new Error("No activation is authorized in source preparation"); }, async close() { closed++; } };
  const options: PreparedSourceOptions = { directory,
    auth: { snapshot: sourceAuthState,
      createAgent: async input => { agent = new ScriptedSourceAgent(input.tools, calls); return agent as unknown as Agent; },
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
    counters: () => ({ releases, compiled, closed, activated }), agent: () => agent!, worker };
}

test("selected-model inactive source compiles without frames and transfers once to the actual admitted run", async () => {
  const f = fixture(); await f.owner.initialize();
  const accepted = await f.owner.start(f.request);
  expect(accepted.phase).toBe("authoring");
  const candidate = await f.ready;
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
  const missing = fixture([{ name: "program_write", args: { entry: "step", name: "executive",
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
  const f = fixture([write, write,
    { name: "program_write", args: { name: "executive", entry: "step", based_on: 2, source: revisedSource } },
    { name: "program_write", args: { name: "executive", entry: "step", based_on: 1, source: revisedSource } },
    { name: "prepare_finish", args: { name: "executive", version: 2, args: null, initial_state: null, limits: {}, session: { schema_version: 1 } } }]);
  await f.owner.initialize(); const accepted = await f.owner.start(f.request);
  const retry = await f.owner.start(structuredClone(f.request));
  expect(retry.preparation_id).toBe(accepted.preparation_id); expect(retry.deadline_at).toBe(accepted.deadline_at);
  const candidate = await f.ready;
  expect(candidate.root.version).toBe(2); expect(f.owner.snapshot()?.source_versions).toBe(2);
  expect(f.agent().results[0]!.details).toEqual(f.agent().results[1]!.details);
  expect(f.agent().results[2]!.isError).toBe(true);
  expect(f.owner.snapshot()?.tools_used).toBe(4); // The identical durable receipt did not spend a second tool.
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
