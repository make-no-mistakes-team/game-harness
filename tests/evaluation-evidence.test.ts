import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type StoredRun } from "../src/server/store.ts";
import { DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { ModelProgramEvidence } from "../src/evaluation/model-evidence.ts";
import { classifyEvaluation, costToResult, readUsageMetrics } from "../src/evaluation/results.ts";
import { ProviderUsageCollector } from "../src/server/provider-usage.ts";
import type { Json } from "../src/shared/contracts.ts";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { AuthManager } from "../src/server/auth.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core/types";
import { validateSkill } from "../src/server/program-validation.ts";
import { StrategicPlanner } from "../src/server/strategic.ts";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { diagnosticAuthorityFixture, executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, skillAuthorityFixture } from "./helpers/adapter-contract.ts";

const adapter = minecraftTestAdapter();

const resources: Array<{ store: Store; observer: ModelProgramEvidence; root: string }> = [];
afterEach(async () => {
  for (const { store, observer, root } of resources.splice(0)) {
    await observer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function setup(maxAdmissions = 2, options?: { limits?: { maxTextBytes?: number; maxPendingBytes?: number };
  reportCaps?: { reportJsonBytes: number; reportEventPages: number; eventPageRecords: number } }) {
  const root = mkdtempSync(path.join(tmpdir(), "gameharness-evaluation-evidence-"));
  const store = new Store(root);
  const run = minecraftRunFixture(adapter, { world_id: crypto.randomUUID(), session_id: crypto.randomUUID(),
    task: "Test-only observer seam", model_id: "test-only-no-provider", started_at: null });
  const stops: string[] = [];
  const observer = new ModelProgramEvidence(store, root, { ...DEFAULT_EVALUATION_CAPS, hostRequestAdmissions: maxAdmissions,
    ...options?.reportCaps }, "test-host-clock", (_id, reason) => { stops.push(reason); }, options?.limits ? { limits: options.limits } : undefined);
  resources.push({ store, observer, root });
  store.saveRun(run);
  const emit = (type: string, details: Parameters<Store["event"]>[3]) => store.event(run.run_id, type, "Explicit synthetic test event; no provider", details);
  return { store, observer, run, emit, stops, root };
}

test("the observer uses the configured admission cap, not a private hardcoded limit", () => {
  const { emit, observer, run, stops } = setup(1);
  emit("model.call", { request_id: "request-1" });
  expect(stops).toEqual(["host_request_admission_bound_reached"]);
  expect(observer.summary(run.run_id).usage).toMatchObject({ admissions: 1, reported_messages: 0, uncached_input: null, output: null, wire_attempts: null });
});

test("SDK-promoted interrupted tool responses retain provider failure classification", () => {
  const f = setup();
  f.emit("model.call", {request_id:"recovered-failed-request"});
  f.emit("model.request_settled", {request_id:"recovered-failed-request",stop_reason:"toolUse",
    recovered_failure:{type:"stream_interrupted_after_content",explanation:"stream_read_error"}});
  expect(f.observer.summary(f.run.run_id).provider_error).toBe(true);
  expect(f.stops).toContain("provider_failure_or_unsettled_no_repeat");
});

async function observedAgent(f: ReturnType<typeof setup>) {
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses" && model.input.includes("image"));
  if (!descriptor) throw new Error("Installed catalog lacks offline Codex descriptor");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const agent = new Agent({ initialState: { model }, getApiKey: async () => "DO_NOT_PERSIST_FIXTURE_CREDENTIAL" });
  f.observer.bindRuntime({ snapshot: () => f.run, getRun: () => f.run } as unknown as Runtime);
  const auth = { createAgent: async () => agent } as unknown as AuthManager;
  f.observer.observeAuthAgents(auth);
  await auth.createAgent({} as Parameters<AuthManager["createAgent"]>[0]);
  return agent;
}

test("invalid_program from an actual Agent tool rejection is authoring evidence, not a platform failure", async () => {
  const f = setup(), agent = await observedAgent(f);
  agent.emitExternalEvent({ type: "tool_execution_end", toolCallId: "rejected", toolName: "program_write",
    result: { content: [{ type: "text", text: "Invalid source" }], details: { error: { code: "invalid_program", issues: [{ code: "invalid_syntax", location: { line: 1, column: 8 } }] } } },
    isError: true } as AgentEvent);
  expect(f.observer.summary(f.run.run_id)).toMatchObject({ unclassified_tool_failures: false, confirmed_harness_faults: [] });
});

test("private journal survives rejected source, visible partials, compact limits and failure finalization", async () => {
  const f = setup(2, { reportCaps: { reportJsonBytes: 4096, reportEventPages: 1, eventPageRecords: 2 } }), agent = await observedAgent(f);
  const rejectedSource = `const missing = ;${" ".repeat(9000)}`;
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "PRIVATE_REASONING_MUST_NOT_PERSIST" },
    { type: "redactedThinking", data: "OPAQUE_PRIVATE_REASONING_MUST_NOT_PERSIST" },
    { type: "text", text: "Visible explanation of the rejected authoring attempt." },
    { type: "toolCall", id: "rejected-source", name: "program_write", arguments: { name: "rejected", source: rejectedSource } },
  ], api: "openai-codex-responses", provider: "openai-codex", model: "offline-fixture",
    stopReason: "toolUse", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  agent.emitExternalEvent({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 1,
    delta: "VISIBLE_PARTIAL_BEFORE_FAILURE", partial: message } } as AgentEvent);
  agent.emitExternalEvent({ type: "message_end", message } as AgentEvent);
  agent.emitExternalEvent({ type: "tool_execution_end", toolCallId: "rejected-source", toolName: "program_write", isError: true,
    result: { content: [{ type: "text", text: "Rejected at line 1" }], details: { error: { code: "invalid_program", issues: [{ code: "invalid_syntax", location: { line: 1, column: 17 } }] } } } } as AgentEvent);
  const authored = await f.store.registerSkill(f.run.run_id, await validateSkill({ entry: "run", name: "immutable read-only source",
    source: 'return {status:"completed",summary:"Private fixture source",result:null};', dependencies: [],
    card: { purpose: "Read-only evidence fixture", applicability: "Test only", method: "No effects", reason: "Retain source identity", limitations: "Untested in gameplay" } }, adapter));
  const { session_id, life_id } = f.run;
  if (session_id === null || life_id === null) throw new Error("Evidence fixture requires a live session and life");
  const execution = f.store.admitSkill(f.run.run_id, { entry: "run", skill_id: authored.skill_id, version: authored.version,
    start_key: "private-evidence-execution", ...executionScopeFixture(f.run),
    args: {}, limits: { duration_ms: 10000, max_actions: 1, max_calls: 2, max_depth: 1 } }).view;
  const action = f.store.admitAction(f.run.run_id, "private-native-receipt", { kind: "craft", item: "crafting_table", executions: 1 }, "skill",
    execution.execution_id, skillAuthorityFixture(f.run, execution)).action;
  f.store.saveAction(f.run.run_id, { ...action.view, status: "succeeded", result: { status: "succeeded", summary: "Synthetic native receipt",
    evidence: { inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { crafting_table: 1 }, effect_confirmed: true } } });
  for (let index = 0; index < 8; index++) f.emit("fixture.retained", { marker: `native-event-${index}` });
  const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "synthetic_outer_failure" });
  const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
  const records = journal.trim().split("\n").map(line => JSON.parse(line));
  expect(journal).toContain(JSON.stringify(rejectedSource));
  for (const visible of ["VISIBLE_PARTIAL_BEFORE_FAILURE", "Visible explanation", "invalid_syntax", "native-event-7"]) expect(journal).toContain(visible);
  expect(journal).toContain(authored.hash);
  expect(journal).toContain("inventory_receipt_confirmed");
  expect(journal).not.toContain("PRIVATE_REASONING_MUST_NOT_PERSIST");
  expect(journal).not.toContain("OPAQUE_PRIVATE_REASONING_MUST_NOT_PERSIST");
  expect(journal).toMatch(/reasoning.*redacted|redacted.*reasoning/i);
  expect(records.every(record => Number.isFinite(record.monotonic_ms))).toBe(true);
  const times: number[] = records.map(record => record.monotonic_ms);
  expect(times.every((time, index) => index === 0 || time >= times[index - 1]!)).toBe(true);
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest).toMatchObject({ status: "failed", reason: "synthetic_outer_failure", evidence_complete: true });
  expect(statSync(path.join(f.root, finalized.journal)).mode & 0o077).toBe(0);
});

test("final SDK context is observed additively before a local gate stops all transport", async () => {
  const f = setup(), agent = await observedAgent(f);
  let authorityCalls = 0;
  agent.setBeforeModelCall(() => { authorityCalls++; });
  // The evidence observer must use addBeforeModelCall; this later additive gate
  // stops locally after its callback, without fake transport or a provider call.
  agent.addBeforeModelCall(() => ({ stop: true, reason: "offline_test_no_transport" }));
  await agent.prompt("FINAL_SDK_VISIBLE_CONTEXT");
  expect(authorityCalls).toBe(1);
  const finalized = await f.observer.finalize(f.run.run_id, { status: "interrupted", reason: "offline_gate" });
  const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
  expect(journal).toContain("FINAL_SDK_VISIBLE_CONTEXT");
  expect(journal).toMatch(/sdk.*context/i);
  expect(journal).not.toContain("DO_NOT_PERSIST_FIXTURE_CREDENTIAL");
  const manifest = readFileSync(path.join(f.root, finalized.manifest), "utf8");
  expect(manifest).toMatch(/sdk_visible|SDK.visible/i);
  expect(manifest).toMatch(/not.*wire|wire.*unknown/i);
});

test("private journal retains the supplemented context actually delivered to the SDK stream", async () => {
  const f = setup();
  const descriptor = getBundledModels("openai-codex").find(model=>model.api==="openai-codex-responses")!;
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  let delivered: unknown;
  const agent = new Agent({ initialState: { model }, getApiKey: () => "OFFLINE_EVIDENCE_ONLY",
    streamFn: (_model, context) => {
      delivered = JSON.parse(JSON.stringify(context));
      const message = { role:"assistant" as const, content:[], api:model.api, provider:model.provider, model:model.id,
        stopReason:"stop" as const, timestamp:0, usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
      const stream = new AssistantMessageEventStream();
      stream.push({type:"start",partial:message}); stream.push({type:"done",reason:"stop",message}); stream.end(); return stream;
    } });
  const auth = { createAgent: async () => agent, releaseAgent: async () => {agent.abort();await agent.waitForIdle();} } as unknown as AuthManager;
  f.observer.bindRuntime({snapshot:()=>f.run,getRun:()=>f.run} as unknown as Runtime);
  f.observer.observeAuthAgents(auth);
  const observation = minecraftObservationFixture(adapter,{world_id:f.run.world_id,session_id:f.run.session_id!});
  const planner = new StrategicPlanner(f.store,auth,{
    run:()=>f.run,generation:()=>1,assertCurrent:()=>f.run,tools:()=>[],rootPrompt:()=>"Evidence fixture",
    adapter:()=>adapter,observe:async()=>observation,projectObservation:o=>adapter.projectObservation(o),
    policies:()=>[],action:()=>null,programPending:()=>false,busy:()=>true,persist:()=>{},
    pause:message=>{throw new Error(message);},terminal:()=>{},
  });
  try {
    await planner.start(1);
    const done=Promise.withResolvers<void>();
    const off=f.store.subscribe(event=>{if(event.type==="scheduler.turn_finished"){off();done.resolve();}});
    planner.wake("policy_replan");await done.promise;
  } finally {await planner.close();}
  const final=await f.observer.finalize(f.run.run_id,{status:"interrupted",reason:"offline_context_proof"});
  const records=readFileSync(path.join(f.root,final.journal),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const recorded=records.filter(record=>record.kind==="final_sdk_visible_context_not_wire_payload");
  expect(recorded).toHaveLength(1);
  expect(recorded[0].value.systemPrompt).toEqual((delivered as {systemPrompt:string[]}).systemPrompt);
  const supplement=recorded[0].value.systemPrompt.map((text:string)=>{try{return JSON.parse(text);}catch{return null;}})
    .find((value:any)=>value?.strategic_context)?.strategic_context;
  expect(supplement.objective).toBe(f.run.task);
  expect(supplement.unresolved).toEqual([]);
});

test("typed image evidence is deduplicated as private artifacts, never base64 journal text", async () => {
  const f = setup(), agent = await observedAgent(f);
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
  for (const toolCallId of ["image-1", "image-2"]) agent.emitExternalEvent({ type: "tool_execution_end", toolCallId, toolName: "observe", isError: false,
    result: { content: [{ type: "text", text: "Authorized observation" }, { type: "image", data, mimeType: "image/png" }], details: { sequence: 1 } } } as AgentEvent);
  const finalized = await f.observer.finalize(f.run.run_id, { status: "interrupted", reason: "operator_stop" });
  const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
  expect(journal).not.toContain(data);
  expect(JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 500))).not.toContain(data);
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest.image_artifacts).toHaveLength(1);
  expect(readFileSync(path.join(f.root, manifest.image_artifacts[0].file))).toEqual(Buffer.from(data, "base64"));
  expect(journal).toContain(manifest.image_artifacts[0].sha256);
});

test("SDK execution args resembling provider content retain their actual gameplay meaning", async () => {
  const f = setup(), agent = await observedAgent(f);
  const gameData = [
    { type: "thinking", value: "AUTHORIZED_GAMEPLAY_RULE" },
    { type: "image", data: "YWJj", mimeType: "image/png" },
    { headers: { direction: "north" }, credentials: { item: "ordinary-key" } },
  ];
  for (const [index, args] of gameData.entries()) {
    agent.emitExternalEvent({ type: "tool_execution_start", toolCallId: `literal-args-${index}`,
      toolName: "program_run", args: { name: "literal-data", args } } as AgentEvent);
    agent.emitExternalEvent({ type: "tool_execution_update", toolCallId: `literal-args-${index}`,
      toolName: "program_run", args: { name: "literal-data", args },
      partialResult: { content: [{ type: "text", text: "Accepted ordinary arguments" }], details: {} } } as AgentEvent);
  }
  const finalized = await f.observer.finalize(f.run.run_id, { status: "interrupted", reason: "literal_gameplay_data" });
  const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
  for (const args of gameData) expect(journal).toContain(JSON.stringify(args));
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest.image_artifacts).toHaveLength(0);
  expect(manifest.evidence_complete).toBe(true);
});

test("private evidence capacity exhaustion stops visibly instead of dropping accepted arguments", async () => {
  for (const limits of [{ maxTextBytes: 1024, maxPendingBytes: 4096 }, { maxTextBytes: 4096, maxPendingBytes: 512 }]) {
    const f = setup(30, { limits });
    f.emit("model.tool_rejected", { tool: "program_write", original_arguments: { source: "x".repeat(2000) } });
    expect(f.stops.some(reason => /evidence|journal/.test(reason))).toBe(true);
    const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "capacity" });
    const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
    expect(manifest.evidence_complete).toBe(false);
    expect(JSON.stringify(manifest)).toMatch(/capacity|pending|bound|limit/i);
  }
});

test("private journal retains authorized capability evidence beyond ordinary trace payload and record caps", async () => {
  const f = setup(30);
  const input = { run_id: f.run.run_id, execution_id: "execution", root_execution_id: "execution",
    parent_execution_id: null, skill_id: null, version: null, hash: null,
    session_id: f.run.session_id, life_id: f.run.life_id, kind: "observation" as const, payload: { marker: "before-cap" } };
  const truncated = { marker: "ROOT_OBSERVATION_BEYOND_ORDINARY_PAYLOAD_CAP", inventory: "x".repeat(30000) };
  expect(f.store.recordTrace({ ...input, payload: truncated })).toMatchObject({
    payload: null, omission: { reason: "record_byte_budget" },
  });
  const seed = f.store.recordTrace(input)!;
  // Seed real retained rows in one SQLite transaction rather than issuing
  // thousands of synchronous FULL durability commits through recordTrace.
  // Only the historical fixture is seeded; the post-cap evidence still enters
  // through the actual Store subscription before its ordinary admission cap.
  const db = new Database(path.join(f.root, "runs.sqlite"));
  try {
    db.transaction(() => {
      db.query(`WITH RECURSIVE copies(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM copies WHERE n<8190)
        INSERT INTO execution_trace(run_id,payload,bytes)
        SELECT execution_trace.run_id,execution_trace.payload,execution_trace.bytes FROM execution_trace,copies WHERE trace_seq=?`).run(seed.trace_seq);
      db.query(`UPDATE trace_budgets SET
        recorded=(SELECT COUNT(*) FROM execution_trace WHERE run_id=?),
        bytes=(SELECT SUM(bytes) FROM execution_trace WHERE run_id=?)
        WHERE run_id=?`).run(f.run.run_id, f.run.run_id, f.run.run_id);
    })();
  } finally { db.close(); }
  expect(f.store.tracePage(f.run.run_id).budget).toMatchObject({ recorded: 8192, max_records: 8192 });
  const payload = { marker: "AUTHORIZED_REPLY_AFTER_ORDINARY_TRACE_CAP", inventory: "x".repeat(30000) };
  expect(f.store.recordTrace({ ...input, kind: "capability_result", payload })).toBeNull();
  const observation = { marker: "ROOT_OBSERVATION_AFTER_ORDINARY_TRACE_CAP", observation_seq: 2 };
  expect(f.store.recordTrace({ ...input, payload: observation })).toBeNull();
  expect(f.store.tracePage(f.run.run_id).budget.omitted_records).toBeGreaterThan(0);
  const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "trace_cap_fixture" });
  expect(finalized.evidence_complete).toBe(true);
  const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
  expect(journal).toContain(JSON.stringify(truncated));
  expect(journal).toContain(JSON.stringify(payload));
  expect(journal).toContain(JSON.stringify(observation));
  expect(journal).toContain("authorized_execution_evidence_before_trace_caps");
});

test("durable usage retains reported subtotals when the final admitted request is unreported", () => {
  const { emit, observer, run } = setup();
  emit("model.call", { request_id: "request-1" });
  emit("model.usage", { request_id: "request-1", uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 });
  emit("model.request_settled", { request_id: "request-1", stop_reason: "toolUse", usage_reported: true });
  expect(observer.summary(run.run_id)).toMatchObject({ provider_settled: true, usage: {
    event_coverage: "complete", consumption_coverage: "unknown", uncached_input: null, output: null } });
  emit("model.call", { request_id: "request-2" });
  emit("model.request_unsettled", { request_id: "request-2", usage_reported: false });
  expect(observer.summary(run.run_id)).toMatchObject({ provider_settled: false, usage: { admissions: 2, reported_messages: 1,
    event_coverage: "incomplete", consumption_coverage: "unknown", output: null,
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 5 }, subscription_cost: null } });
});

test("SDK-only event capture is complete without inventing provider consumption from stop reason or response ID", () => {
  const { emit, observer, run } = setup();
  emit("model.call", { request_id: "sdk-only" });
  emit("model.usage", { request_id: "sdk-only", provider_response_id: "not-proof",
    uncached_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 });
  emit("model.request_settled", { request_id: "sdk-only", stop_reason: "stop", usage_reported: true });
  expect(observer.summary(run.run_id)).toMatchObject({ provider_settled: true, usage: {
    schema_version: 2, event_coverage: "complete", consumption_coverage: "unknown",
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 } } });
});

test("a missing later category cannot erase a valid earlier SDK subtotal", () => {
  const { emit, observer, run } = setup(30);
  for (const request of ["first", "partial"]) emit("model.call", { request_id: request });
  emit("model.usage", { request_id: "first", uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 });
  emit("model.usage", { request_id: "partial", output_tokens: 2 });
  expect(observer.summary(run.run_id).usage).toMatchObject({
    event_coverage: "complete", consumption_coverage: "unknown",
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 7 },
    uncached_input: null, output: null,
  });
});

test("duplicate and unmatched durable usage cannot double count or certify another host admission", () => {
  const { emit, observer, run } = setup(30);
  emit("model.call", { request_id: "first" });
  emit("model.call", { request_id: "missing" });
  const counters = { uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 };
  emit("model.usage", { request_id: "first", ...counters });
  emit("model.usage", { request_id: "first", ...counters });
  emit("model.usage", { request_id: "not-admitted", ...counters });
  expect(observer.summary(run.run_id).usage).toMatchObject({ admissions: 2, reported_messages: 1,
    event_coverage: "incomplete", consumption_coverage: "unknown", uncached_input: null, output: null,
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 5 } });
});

test("durable event-page omission cannot certify consumption even when the visible admission has a usage event", () => {
  const { emit, observer, run } = setup(30, {
    reportCaps: { reportJsonBytes: 4096, reportEventPages: 1, eventPageRecords: 2 },
  });
  emit("model.call", { request_id: "first" });
  emit("model.usage", { request_id: "first", uncached_input_tokens: 7, output_tokens: 5 });
  emit("model.call", { request_id: "omitted" });
  expect(observer.summary(run.run_id).usage).toMatchObject({ admissions: 2, event_coverage: "incomplete",
    consumption_coverage: "unknown", uncached_input: null, output: null,
    reported_subtotal: { uncached_input: 7, output: 5 } });
});

test("zero admissions establish logical zero without a fabricated provider event or subscription price", () => {
  const { observer, run, store } = setup();
  expect(observer.summary(run.run_id).usage).toMatchObject({ schema_version: 2, admissions: 0, reported_messages: 0,
    event_coverage: "complete", consumption_coverage: "known", uncached_input: 0, cache_read: 0, cache_write: 0, output: 0,
    wire_attempts: null, subscription_cost: null });
  expect(store.eventsAfter(run.run_id, 0, 500).filter(event => event.type === "model.usage")).toEqual([]);
});

test("an unsettled request retains genuinely collected terminal counters without inventing an SDK usage message or settlement", () => {
  const { emit, observer, run, store } = setup(30);
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed catalogue lacks offline Codex descriptor");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const collector = new ProviderUsageCollector("unsettled-terminal");
  emit("model.call", { request_id: "unsettled-terminal" });
  const data = JSON.stringify({ type: "response.completed", response: { id: "real-terminal-no-sdk-message",
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 } } } });
  collector.observe({ event: "response.completed", data, raw: [`data: ${data}`] }, model);
  const evidence = collector.finish(null);
  emit("model.request_unsettled", { request_id: "unsettled-terminal", usage_reported: false,
    usage_evidence: evidence as unknown as Json });
  const events = store.eventsAfter(run.run_id, 0, 500);
  expect(events.filter(event => event.type === "model.usage")).toHaveLength(0);
  expect(events.filter(event => event.type === "model.request_settled")).toHaveLength(0);
  expect(evidence.sdk_reported).toBeNull();
  const summary = observer.summary(run.run_id);
  expect(summary).toMatchObject({ provider_settled: false, provider_error: false, usage: {
    admissions: 1, reported_messages: 0, event_coverage: "incomplete", consumption_coverage: "known",
    uncached_input: 6, cache_read: 3, cache_write: 1, output: 4,
    reported_subtotal: { uncached_input: null, cache_read: null, cache_write: null, output: null },
    wire_attempts: null, subscription_cost: null } });
  expect(readUsageMetrics(summary.usage)).toEqual(summary.usage);
  const outcome = classifyEvaluation({ inferenceAdmitted: true, goalVerified: false,
    platformChecksComplete: true, providerError: false, providerSettled: summary.provider_settled });
  expect(costToResult([{ outcome, usage: summary.usage }])).toMatchObject({
    uncached_input: 6, cache_read: 3, cache_write: 1, output: 4,
    reported_subtotal: { uncached_input: null, cache_read: null, cache_write: null, output: null },
  });
});

test("cached action evidence follows actual durable receipt updates rather than initial admission views", () => {
  const { store, observer, run } = setup();
  const accepted = store.admitAction(run.run_id, "craft-action", { kind: "craft", item: "crafting_table", executions: 1 },
    "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run)).action;
  expect(observer.actions(run.run_id)[0]?.view.status).toBe("accepted");
  store.saveAction(run.run_id, { ...accepted.view, status: "succeeded", result: { status: "succeeded", summary: "Synthetic native-receipt test data only", evidence: {
    inventory_receipt_confirmed: true, inventory_before: { crafting_table: 0 }, inventory_after: { crafting_table: 1 }, effect_confirmed: true,
  } } });
  expect(observer.actions(run.run_id)[0]?.view.status).toBe("succeeded");
  expect(observer.summary(run.run_id).actions).toMatchObject({ count: 1, inventory_receipts: 1, inventory_delta: { crafting_table: 1 }, uncertain_outcomes: 0 });
});

test("provider errors stop the sample and remain distinct from a confirmed harness fault", () => {
  const { emit, observer, run, stops } = setup();
  emit("model.call", { request_id: "request-1" });
  emit("model.request_settled", { request_id: "request-1", stop_reason: "error", usage_reported: false });
  expect(observer.hasProviderFailure(run.run_id)).toBe(true);
  expect(stops).toEqual(["provider_failure_or_unsettled_no_repeat"]);
  expect(observer.summary(run.run_id)).toMatchObject({ provider_error: true, provider_settled: false, confirmed_harness_faults: [] });
});

for (const settledRequests of [0, 1]) {
  test(`observation preparation failure after ${settledRequests} settled requests is a durable platform fault, not provider failure`, async () => {
    const f = setup(30);
    if (settledRequests) {
      f.emit("model.call", { request_id: "already-settled" });
      f.emit("model.usage", { request_id: "already-settled", uncached_input_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2 });
      f.emit("model.request_settled", { request_id: "already-settled", stop_reason: "stop", usage_reported: true });
    }
    f.emit("runtime.model_observation_failed", { provider_request_made: false });
    const summary = f.observer.summary(f.run.run_id);
    expect(summary.confirmed_harness_faults).toHaveLength(1);
    expect(summary).toMatchObject({ provider_error: false, provider_settled: settledRequests > 0,
      usage: { admissions: settledRequests, reported_messages: settledRequests, event_coverage: "complete",
        consumption_coverage: settledRequests ? "unknown" : "known" } });
    expect(f.observer.hasProviderFailure(f.run.run_id)).toBe(false);
    expect(f.stops).not.toContain("provider_failure_or_unsettled_no_repeat");
    expect(classifyEvaluation({ inferenceAdmitted: summary.usage.admissions > 0, goalVerified: false,
      platformChecksComplete: true, confirmedHarnessFaults: summary.confirmed_harness_faults,
      providerError: summary.provider_error, providerSettled: summary.provider_settled })).toMatchObject({
      platform_status: "fail", provider_status: settledRequests ? "ok" : "not_called",
      agent_status: settledRequests ? "goal_not_verified" : "not_run",
    });
    const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
    expect(saved.summary.confirmed_harness_faults).toEqual(summary.confirmed_harness_faults);
    const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "observation_preparation_failed" });
    expect(finalized.evidence_complete).toBe(true);
    const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
    expect(journal).toContain('"type":"runtime.model_observation_failed"');
    expect(journal).not.toContain('"type":"model.request_unsettled"');
    expect(f.observer.count(f.run.run_id)).toBe(settledRequests);
  });
}
