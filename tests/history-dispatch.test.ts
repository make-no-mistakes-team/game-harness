import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { usageMetrics } from "../src/evaluation/results.ts";
import type { Json } from "../src/shared/contracts.ts";
import type { ImprovementOpportunity } from "../src/shared/execution-evidence.ts";
import { dispatchHistoryQuery } from "../src/server/history-dispatch.ts";
import { HISTORY_LIMITS } from "../src/server/history-limits.ts";
import type { HistoryExportCursor } from "../src/server/history-protocol.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
import { readImprovementFeedback } from "../src/server/program-feedback.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { finishHistoryExecution, historyExecution, historyFixture, historySpec, type HistoryFixture } from "./helpers/history-fixture.ts";

const fixtures: HistoryFixture[] = [];
const readers: ReadonlyStore[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture() {
  const value = historyFixture();
  fixtures.push(value);
  const reader = new ReadonlyStore(value.store.readLocation());
  readers.push(reader);
  return { ...value, reader };
}
function object(value: Json): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value;
}

function publish(store: ReturnType<typeof historyFixture>["store"], reader: ReadonlyStore, runId: string) {
  while (!store.advanceHistorySourceBootstrap(128).complete) { /* Bootstrap retained source keys. */ }
  const through = store.historySourceHighwater(runId);
  let checkpoint = store.beginHistoryProjection(runId, through);
  for (let pages = 0; pages < 10_000; pages++) {
    const batch = dispatchHistoryQuery(reader, { kind: "projection_batch", run_id: runId, checkpoint });
    store.commitHistoryProjectionBatch(runId, batch);
    checkpoint = batch.after;
    if (!batch.has_more && checkpoint.source_through >= through) return;
    if (!batch.has_more) checkpoint = store.beginHistoryProjection(runId, through);
  }
  throw new Error("Finite projection fixture did not publish");
}

test("bounded detection drains missing owners and retains every outcome within one fixed work boundary", async () => {
  const { store, run, reader } = fixture();
  const skill = await store.registerSkill(run.run_id, historySpec(run));
  publish(store, reader, run.run_id);
  store.appendEvents(run.run_id, Array.from({ length: 130 }, (_, index) => ({
    type: "skill.closed", summary: "Missing historical owner", details: { execution_id: `missing-${index}` },
  })));
  const expected = new Set<string>();
  for (let index = 0; index < 23; index++) {
    const execution = historyExecution(store, run, skill);
    finishHistoryExecution(store, execution);
    expected.add(execution.execution_id);
  }
  const through = store.historySourceHighwater(run.run_id);
  let checkpoint = store.beginHistoryProjection(run.run_id, through);
  let page = dispatchHistoryQuery(reader, { kind: "projection_batch", run_id: run.run_id, checkpoint });
  const late = historyExecution(store, run, skill);
  finishHistoryExecution(store, late);
  const discovered = new Set<string>();
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(10_000);
    expect(page.candidates.length).toBeLessThanOrEqual(16);
    for (const candidate of page.candidates) discovered.add(candidate.execution_id);
    store.commitHistoryProjectionBatch(run.run_id, page);
    if (!page.has_more) break;
    checkpoint = page.after;
    page = dispatchHistoryQuery(reader, { kind: "projection_batch", run_id: run.run_id, checkpoint });
  }
  expect(discovered).toEqual(expected);
  expect(discovered.has(late.execution_id)).toBe(false);
  expect(store.opportunityCount(run.run_id)).toBe(23);
  expect(store.historyProjectionGeneration(run.run_id)).toMatchObject({ source_through: through, has_pending: true });
  expect(store.evidenceObjectRows<{ execution_id: string }>(run.run_id, "opportunity", 0, 100)
    .map(row => row.value.execution_id).sort()).toEqual([...expected].sort());
});

test("named feedback selects before independent V2 paging and review context is effect-free and already projected", async () => {
  const { store, run, reader } = fixture();
  const selected = await store.registerSkill(run.run_id, historySpec(run, "selected"));
  const other = await store.registerSkill(run.run_id, historySpec(run, "other"));
  const execution = historyExecution(store, run, selected);
  finishHistoryExecution(store, execution);
  for (const [index, skill] of [other, selected].entries()) {
    const opportunity: ImprovementOpportunity = { opportunity_id: `opportunity-${index}`, run_id: run.run_id, kind: "outcome",
      version: { run_id: run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash },
      execution_id: execution.execution_id, event_seqs: [], created_at: "2020-01-01T00:00:01.000Z", resolution: null };
    store.saveOpportunity(opportunity);
  }
  publish(store, reader, run.run_id);
  const checkpoint = store.historyProjectionCheckpoint(run.run_id);
  const source = store.historySourceHighwater(run.run_id), events = store.lastEventSeq();
  const after = { schema_version: 2 as const, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null };
  const firstRaw = readImprovementFeedback(reader, run.run_id, after, 1);
  const selectedRaw = readImprovementFeedback(reader, run.run_id, after, 1, { skill_id: selected.skill_id });
  const first = object(dispatchHistoryQuery(reader, { kind: "model_inspect", run_id: run.run_id,
    input: { view: "feedback", program: { name: selected.name }, after, limit: 1 } }));
  expect(firstRaw.opportunities[0]?.version.skill_id).toBe(other.skill_id);
  expect(first.opportunities).toMatchObject([{ version: { name: selected.name, version: selected.version } }]);
  expect<unknown>(first.next_after).toEqual(selectedRaw.next_after);
  expect(selectedRaw.next_after.opportunity_change_seq).toBeGreaterThan(firstRaw.next_after.opportunity_change_seq);
  expect(selectedRaw.metrics).toEqual([]);
  expect(selectedRaw.next_after.metric_change_seq).toBe(0);
  expect(selectedRaw.has_more).toBe(true);
  let next = selectedRaw;
  const selectedMetrics = [];
  const selectedOpportunities = [...selectedRaw.opportunities];
  for (let pages = 0; next.has_more; pages++) {
    expect(pages).toBeLessThan(10);
    next = readImprovementFeedback(reader, run.run_id, next.next_after, 1, { skill_id: selected.skill_id });
    expect(next.opportunities.length + next.metrics.length + next.omitted.length).toBeLessThanOrEqual(1);
    selectedMetrics.push(...next.metrics);
    selectedOpportunities.push(...next.opportunities);
  }
  expect(selectedOpportunities.every(value => value.version.skill_id === selected.skill_id)).toBe(true);
  expect(selectedMetrics.map(value => {
    if (value.kind !== "replace") throw new Error("Expected the selected retained metric replacement");
    return value.metric.execution_id;
  })).toEqual([execution.execution_id]);
  expect(() => dispatchHistoryQuery(reader, { kind: "model_inspect", run_id: run.run_id,
    input: { view: "feedback", program: { name: selected.name }, after: firstRaw.next_after, limit: 1 } }))
    .toThrow("different run or program selection");
  const review = dispatchHistoryQuery(reader, { kind: "review_context", run_id: run.run_id, after, limit: 3 });
  expect<unknown>(review).toEqual(new ProgramWorkspace(reader, run.run_id).feedbackView(readImprovementFeedback(reader, run.run_id, after, 3)));
  expect(JSON.stringify(review)).not.toContain(execution.execution_id);
  expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(checkpoint);
  expect(store.historySourceHighwater(run.run_id)).toBe(source);
  expect(store.lastEventSeq()).toBe(events);
});

test("trace continuations recover their original root and named child instead of following latest execution", async () => {
  const { store, run, reader } = fixture();
  const rootSkill = await store.registerSkill(run.run_id, historySpec(run, "root"));
  const childSkill = await store.registerSkill(run.run_id, historySpec(run, "child"));
  const unrelated = await store.registerSkill(run.run_id, historySpec(run, "unrelated"));
  const root = historyExecution(store, run, rootSkill);
  const child = historyExecution(store, run, childSkill, root);
  const trace = (payload: string) => store.recordTrace({ run_id: run.run_id, execution_id: child.execution_id, root_execution_id: root.execution_id,
    parent_execution_id: root.execution_id, skill_id: childSkill.skill_id, version: childSkill.version, hash: childSkill.hash,
    session_id: run.session_id, life_id: run.life_id, kind: "branch", payload })!;
  const first = trace("first");
  const second = trace("second");
  finishHistoryExecution(store, child);
  finishHistoryExecution(store, root);
  const latest = historyExecution(store, run, rootSkill);
  const rootPage = object(dispatchHistoryQuery(reader, { kind: "model_inspect", run_id: run.run_id,
    input: { view: "trace", target: "latest", after: first.trace_seq, limit: 10 } }));
  expect(rootPage.records).toMatchObject([{ trace_seq: second.trace_seq, payload: "second" }]);
  expect(rootPage.program).toEqual({ name: rootSkill.name, version: rootSkill.version });
  const childPage = object(dispatchHistoryQuery(reader, { kind: "model_inspect", run_id: run.run_id,
    input: { view: "trace", program: { name: childSkill.name }, target: "latest", after: first.trace_seq, limit: 10 } }));
  expect(childPage.program).toEqual({ name: childSkill.name, version: childSkill.version });
  expect(() => dispatchHistoryQuery(reader, { kind: "model_inspect", run_id: run.run_id,
    input: { view: "trace", program: { name: unrelated.name }, target: "latest", after: first.trace_seq, limit: 10 } })).toThrow("different named execution scope");
  finishHistoryExecution(store, latest);
});

test("comparison scope checks reject cross-model records before attempting source hydration", () => {
  const { store, run, reader } = fixture();
  const other = { ...run, run_id: crypto.randomUUID(), model_id: `${run.model_id}-other` };
  store.saveRun(other);
  // Neither source exists: a hydration-first implementation would report a missing skill instead.
  const before = { run_id: run.run_id, skill_id: "missing-left", version: 1, hash: "a".repeat(64) };
  const after = { run_id: other.run_id, skill_id: "missing-right", version: 1, hash: "b".repeat(64) };
  expect(() => dispatchHistoryQuery(reader, { kind: "operator_comparison", run_id: run.run_id,
    before, after, after_sample: null, limit: 10 })).toThrow("actual same-model version records");
});

test("archive pages reconstruct oversized UTF8 sources and events while model pages keep descriptive omissions", async () => {
  const { store, run, reader } = fixture();
  // Valid source bytes can exceed the transport record budget after JSON escaping.
  const source = `/* ${"\0".repeat(8000)}${"界😀".repeat(1000)} */ return null;`;
  expect(Buffer.byteLength(source)).toBeLessThanOrEqual(16384);
  const skill = await store.registerSkill(run.run_id, historySpec(run, "large source", source));
  let after: HistoryExportCursor = { record_index: 0, chunk_index: 0 };
  const chunks: Record<string, Json>[] = [];
  do {
    const page = dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id, collection: "sources", after, limit: 1 });
    expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: page }) + "\n")).toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
    expect(page.omissions).toEqual([]);
    expect(page.total).toBe(1);
    expect(page.records).toHaveLength(1);
    chunks.push(...page.records.map(object));
    expect(page.next_after.record_index > after.record_index ||
      page.next_after.record_index === after.record_index && page.next_after.chunk_index > after.chunk_index).toBe(true);
    after = page.next_after;
    if (!page.has_more) break;
  } while (true);
  expect(after).toEqual({ record_index: 1, chunk_index: 0 });
  expect(chunks.length).toBeGreaterThan(1);
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.chunk_index).toBe(index);
    expect(chunk.text).toBeTypeOf("string");
    const text = chunk.text as string;
    expect(Buffer.from(text).toString("utf8")).toBe(text);
  }
  const encoded = chunks.map(chunk => chunk.text).join("");
  expect<unknown>(createHash("sha256").update(encoded).digest("hex")).toBe(chunks[0]!.sha256);
  expect(JSON.parse(encoded)).toEqual(skill);
  expect(chunks[0]).toMatchObject({ kind: "json_record_chunk", record_count: 1, chunk_count: chunks.length,
    original_bytes: Buffer.byteLength(JSON.stringify(skill)) });
  const beforeEvent = store.lastEventSeq();
  const huge = store.event(run.run_id, "fixture.large", "Large retained event", "x".repeat(70000));
  store.event(run.run_id, "fixture.small", "Small retained event");
  const all = store.eventsAfter(run.run_id, 0, 500);
  const index = all.findIndex(event => event.event_seq === huge.event_seq);
  expect(huge.event_seq).toBeGreaterThan(beforeEvent);
  const eventRecords: Json[] = [];
  let eventAfter: HistoryExportCursor = { record_index: 0, chunk_index: 0 };
  let logicalTotal = 0;
  do {
    const page = dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id, collection: "events", after: eventAfter, limit: 2 });
    expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: page }) + "\n"))
      .toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
    expect(page.omissions).toEqual([]);
    expect(page.records.length).toBeLessThanOrEqual(2);
    expect(page.total).toBe(all.length);
    expect(page.next_after.record_index > eventAfter.record_index ||
      page.next_after.record_index === eventAfter.record_index && page.next_after.chunk_index > eventAfter.chunk_index).toBe(true);
    eventRecords.push(...page.records);
    logicalTotal = page.total;
    eventAfter = page.next_after;
    if (!page.has_more) break;
  } while (true);
  const eventChunks = eventRecords.map(object).filter(record => record.kind === "json_record_chunk");
  expect(eventChunks.length).toBeGreaterThan(1);
  expect(eventChunks[0]).toMatchObject({ collection: "events", record_index: index, record_count: all.length,
    chunk_index: 0, chunk_count: eventChunks.length, encoding: "json_text",
    original_bytes: Buffer.byteLength(JSON.stringify(huge)) });
  const encodedEvent = eventChunks.map(chunk => chunk.text).join("");
  expect<unknown>(createHash("sha256").update(encodedEvent).digest("hex")).toBe(eventChunks[0]!.sha256);
  expect(JSON.parse(encodedEvent)).toEqual(huge);
  expect<unknown[]>(eventRecords).toContainEqual(all.at(-1));
  expect(logicalTotal).toBe(all.length);
  expect(eventAfter).toEqual({ record_index: all.length, chunk_index: 0 });
  expect(() => dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id, collection: "events",
    after: { record_index: index, chunk_index: eventChunks.length }, limit: 1 })).toThrow("outside the retained record");
  expect(() => dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id, collection: "events",
    after: { record_index: all.length - 1, chunk_index: 1 }, limit: 1 })).toThrow("does not identify a chunked record");
  expect(() => dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id, collection: "events",
    after: { record_index: all.length, chunk_index: 1 }, limit: 1 })).toThrow("outside the logical collection");
  const model = object(dispatchHistoryQuery(reader, { kind: "model_inspect", run_id: run.run_id,
    input: { view: "events", after: beforeEvent, limit: 2 } }));
  expect(model).toMatchObject({ next_after: all.at(-1)!.event_seq, has_more: false,
    omissions: [{ index: 0, reason: "record_byte_budget" }] });
  expect(model.records).toMatchObject([{ type: "fixture.small" }]);
});

test("8192 raw traces use bounded SQL logical pages without trace presentation or metric reductions", async () => {
  const { store, run, reader } = fixture();
  const skill = await store.registerSkill(run.run_id, historySpec(run));
  const execution = historyExecution(store, run, skill);
  const expected = [];
  for (let index = 0; index < 8192; index++) {
    const record = store.recordTrace({ run_id: run.run_id, execution_id: execution.execution_id,
      root_execution_id: execution.root_execution_id, parent_execution_id: null,
      skill_id: skill.skill_id, version: skill.version, hash: skill.hash, session_id: run.session_id,
      life_id: run.life_id, kind: "branch", payload: `original-${index}` });
    expect(record).not.toBeNull();
    expected.push(record!);
  }
  const rows = spyOn(reader, "collectionRowsPage");
  const presentation = spyOn(reader, "tracePage").mockImplementation(() => { throw new Error("No presentation trace traversal"); });
  const executions = spyOn(reader, "allSkillExecutions").mockImplementation(() => { throw new Error("No metric reduction"); });
  let after: HistoryExportCursor = { record_index: 0, chunk_index: 0 };
  let decodedRows = 0, emitted = 0;
  do {
    const page = reader.snapshot(() => dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id,
      collection: "traces", after, limit: 100 }));
    expect(rows).toHaveBeenLastCalledWith(run.run_id, "traces", after.record_index, 100);
    const selected = rows.mock.results.at(-1)!;
    if (selected.type !== "return") throw new Error("Expected bounded collection rows");
    expect(selected.value.records.length).toBeLessThanOrEqual(100);
    decodedRows += selected.value.records.length;
    expect(page.total).toBe(8192);
    expect(page.records.length).toBeLessThanOrEqual(100);
    expect<unknown>(page.records).toEqual(expected.slice(emitted, emitted + page.records.length));
    expect(page.omissions).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: page }) + "\n"))
      .toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
    emitted += page.records.length;
    expect(page.next_after).toEqual({ record_index: emitted, chunk_index: 0 });
    after = page.next_after;
    if (!page.has_more) break;
  } while (true);
  expect(emitted).toBe(8192);
  expect(decodedRows).toBeLessThanOrEqual(2 * 8192);
  expect(presentation).not.toHaveBeenCalled();
  expect(executions).not.toHaveBeenCalled();
});

test("the benchmark retains the full original event and projection workload and rejects rather than shrinking oversize payloads", async () => {
  const { store, run, reader } = fixture();
  for (let index = 0; index < 501; index++) store.event(run.run_id, "fixture.record", "Actual retained record");
  expect(dispatchHistoryQuery(reader, { kind: "benchmark_history", run_id: run.run_id, minimum_records: 501 }))
    .toEqual({ events: 501, program_evidence: [], programs: [] });
  expect(() => dispatchHistoryQuery(reader, { kind: "benchmark_history", run_id: run.run_id, minimum_records: 502 }))
    .toThrow("fewer than the required original evaluator records");
  for (let index = 0; index < 5; index++)
    await store.registerSkill(run.run_id, historySpec(run, `large workload ${index}`, `/*${"x".repeat(15000)}*/ return null;`));
  expect(() => dispatchHistoryQuery(reader, { kind: "benchmark_history", run_id: run.run_id, minimum_records: 501 }))
    .toThrow("complete response frame byte budget");
});

test("readonly prefix only settles host cancellation inside its declared event boundary", () => {
  const { store, run, reader } = fixture();
  store.event(run.run_id, "model.call", "Authoring admission", { request_id: "cancelled-authoring", role: "authoring" });
  store.event(run.run_id, "model.request_settled", "Host closed root-bound authoring", {
    request_id: "cancelled-authoring", role: "authoring", stop_reason: "aborted", obsolete: true,
    recovered_failure: { type: "stream_interrupted_after_content", explanation: "stream_read_error" },
    host_cancellation: { kind: "ordinary_authoring", request_id: "cancelled-authoring",
      root_execution_id: "foreground-root", reason: "root_settled" },
  });
  expect(dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 1 }))
    .toMatchObject({ admissions: 1, provider_error: false, provider_settled: false, events_omitted: true });
  const complete = dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 2 });
  expect(complete).toMatchObject({ admissions: 1, provider_error: false, provider_settled: true, events_omitted: false,
    usage: { reported_messages: 0, event_coverage: "incomplete", consumption_coverage: "unknown", output: null } });
  expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: complete }) + "\n"))
    .toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
});

test("readonly prefix preserves strategic recovery cancellation and cannot close an unseen planning request", () => {
  const { store, run, reader } = fixture();
  store.event(run.run_id, "model.call", "Recovery admission", { request_id: "recovery", role: "recovery" });
  const details = { request_id: "recovery", role: "recovery", stop_reason: "aborted", obsolete: true,
    usage_reported: false, recovered_failure: { type: "stream_interrupted_after_content", explanation: "stream_read_error" },
    host_cancellation: { kind: "strategic_host", request_id: "recovery", reason: "fenced" } };
  const terminal = store.event(run.run_id, "model.request_settled", "Host fenced recovery", details);
  store.event(run.run_id, "model.call", "Planning admission", { request_id: "planning", role: "planning" });
  store.event(run.run_id, "model.request_settled", "Host turn deadline", {
    request_id: "planning", role: "planning", stop_reason: "aborted", obsolete: false, usage_reported: false,
    recovered_failure: { type: "stream_interrupted_after_content", explanation: "stream_read_error" },
    host_cancellation: { kind: "strategic_host", request_id: "planning", reason: "turn_deadline" },
  });
  expect(dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 1 }))
    .toMatchObject({ admissions: 2, provider_error: false, provider_settled: false, events_omitted: true });
  expect(dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 3 }))
    .toMatchObject({ admissions: 2, provider_error: false, provider_settled: false, events_omitted: true });
  expect(dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 4 }))
    .toMatchObject({ admissions: 2, provider_error: false, provider_settled: true, events_omitted: false,
      usage: { reported_messages: 0, event_coverage: "incomplete", consumption_coverage: "unknown",
        uncached_input: null, cache_read: null, cache_write: null, output: null, wire_attempts: null } });
  const exported = dispatchHistoryQuery(reader, { kind: "export_page", run_id: run.run_id,
    collection: "events", after: { record_index: 0, chunk_index: 0 }, limit: 10 });
  expect(exported.records.find(record => object(record).event_seq === terminal.event_seq)).toMatchObject({ details });
});

test("late evaluation summaries retain the actual original prefix while counting admissions beyond its cap", () => {
  const { store, run, reader } = fixture();
  store.event(run.run_id, "model.call", "First request", { request_id: "first" });
  store.event(run.run_id, "model.usage", "First SDK subtotal", { request_id: "first",
    uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 });
  store.event(run.run_id, "model.request_settled", "First settled", { request_id: "first", stop_reason: "toolUse" });
  for (let index = 0; index < 2; index++)
    store.event(run.run_id, "model.tool_started", "Original tools", { tool: "observe" });
  for (let index = 0; index < 495; index++)
    store.event(run.run_id, "fixture.prefix", "Original retained prefix");
  store.event(run.run_id, "model.call", "Admission beyond original prefix", { request_id: "later" });
  store.event(run.run_id, "model.usage", "Later SDK subtotal", { request_id: "later",
    uncached_input_tokens: 11, cache_read_tokens: 2, cache_write_tokens: 0, output_tokens: 9 });
  store.event(run.run_id, "model.request_settled", "Later settled", { request_id: "later", stop_reason: "toolUse" });
  store.event(run.run_id, "model.tool_started", "Tool beyond original prefix", { tool: "late_tool" });
  const firstMessage = { schema_version: 1 as const, request_id: "first",
    sdk_reported: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 5 },
    provider_terminal: null, unaccounted_response_ids: [] };
  const prefix = dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 500 });
  expect(prefix.admissions).toBe(2);
  expect(prefix.events_omitted).toBe(true);
  expect(prefix.provider_settled).toBe(false);
  expect(prefix.tools).toEqual([{ name: "observe", count: 2 }]);
  expect(prefix.event_counts.find(entry => entry.type === "model.call")?.count).toBe(1);
  expect(prefix.event_counts.find(entry => entry.type === "fixture.prefix")?.count).toBe(495);
  expect(prefix.usage).toEqual(usageMetrics({ admissions: 2, admitted_request_ids: ["first"],
    messages: [firstMessage], events_omitted: true }));
  const full = dispatchHistoryQuery(reader, { kind: "evaluation_prefix", run_id: run.run_id, event_limit: 504 });
  expect(full.events_omitted).toBe(false);
  expect(full.provider_settled).toBe(true);
  expect(full.tools).toHaveLength(2);
  expect(full.tools).toContainEqual({ name: "observe", count: 2 });
  expect(full.tools).toContainEqual({ name: "late_tool", count: 1 });
  expect(full.event_counts.find(entry => entry.type === "model.call")?.count).toBe(2);
  expect(full.usage).toEqual(usageMetrics({ admissions: 2, admitted_request_ids: ["first", "later"],
    messages: [firstMessage, { ...firstMessage, request_id: "later",
      sdk_reported: { uncached_input: 11, cache_read: 2, cache_write: 0, output: 9 } }], events_omitted: false }));
  expect(full.usage).toMatchObject({ event_coverage: "complete", consumption_coverage: "unknown",
    reported_subtotal: { uncached_input: 18, cache_read: 5, cache_write: 0, output: 14 } });
  expect(Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: full }) + "\n"))
    .toBeLessThanOrEqual(HISTORY_LIMITS.responseBytes);
});
