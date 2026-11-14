import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import type { HistoryExportPage } from "../src/server/history-protocol.ts";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { diagnosticAuthorityFixture, executionScopeFixture, minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter, skillAuthorityFixture } from "./helpers/adapter-contract.ts";
import { finishHistoryExecution, historyExecution, historySpec } from "./helpers/history-fixture.ts";

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

test("readonly archive chunks preserve historical oversized source bytes independently of compact export caps", async () => {
  const f = setup(30, { reportCaps: { reportJsonBytes: 4096, reportEventPages: 1, eventPageRecords: 2 } });
  const source = `/*${"immutable historical source 😀 ".repeat(2000)}*/return {status:"completed",summary:"Chunk archive fixture",result:null};`;
  // Storage-only HISTORICAL artifact: current admission rejects sources above 16 KiB.
  // This synthetic old-validator metadata is not a claim that any validator executed.
  const historical = historySpec(f.run, "historical oversized archive", source);
  historical.validation = { ...historical.validation, validator_version: 1 };
  historical.card = { ...historical.card, purpose: "Retained historical oversized artifact",
    limitations: "Storage-only historical metadata; not admissible by the current source validator or executed" };
  const authored = await f.store.registerSkill(f.run.run_id, historical);
  const artifact = readFileSync(path.join(f.store.readLocation().artifacts, `${authored.hash}.js`));
  expect(artifact).toEqual(Buffer.from(source));
  expect(createHash("sha256").update(artifact).digest("hex")).toBe(authored.hash);
  // No writer-side full-history method may participate in summary, save or finalization.
  const forbidden = () => { throw new Error("writer-side unbounded history read"); };
  f.store.skills = forbidden;
  f.store.policies = forbidden;
  f.store.allSkillExecutions = forbidden;
  f.store.tracePage = forbidden;
  const name = await f.observer.save(f.run.run_id);
  expect(statSync(path.join(f.root, name)).size).toBeLessThanOrEqual(4096);
  const compact = JSON.parse(readFileSync(path.join(f.root, name), "utf8"));
  expect(compact.omission).toBe("compact_evidence_exceeds_declared_json_bound");
  const finalized = await f.observer.finalize(f.run.run_id, { status: "finished", reason: "chunk_fixture" });
  expect(finalized.evidence_complete).toBe(true);
  const records = readFileSync(path.join(f.root, finalized.journal), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const chunks = records.filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "sources")
    .flatMap(record => record.value.payload.records).filter(record => record.kind === "json_record_chunk");
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk, index) => chunk.schema_version === 1 && chunk.record_index === 0 &&
    chunk.record_count === 1 && chunk.chunk_index === index && chunk.chunk_count === chunks.length)).toBe(true);
  const json = chunks.map(chunk => chunk.text).join("");
  expect(Buffer.byteLength(json)).toBe(chunks[0].original_bytes);
  expect(createHash("sha256").update(json).digest("hex")).toBe(chunks[0].sha256);
  expect(JSON.parse(json)).toMatchObject({ source, hash: authored.hash, validation: { validator_version: 1 } });
});

test("transport chunking cannot turn an already retained authorized event into incomplete evidence", async () => {
  const f = setup(30);
  f.emit("fixture.large_authorized_record", { content: "x".repeat(60000) });
  const finalized = await f.observer.finalize(f.run.run_id, { status: "finished", reason: "oversize_export_fixture" });
  expect(finalized.evidence_complete).toBe(true);
  expect(f.stops).not.toContain("private_history_export_incomplete");
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest.failures).toEqual([]);
  const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
  const chunks = journal.trim().split("\n").map(line => JSON.parse(line))
    .filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "events")
    .flatMap(record => record.value.payload.records).filter(record => record.kind === "json_record_chunk");
  expect(chunks.length).toBeGreaterThan(1);
  const json = chunks.map(chunk => chunk.text).join("");
  expect(createHash("sha256").update(json).digest("hex")).toBe(chunks[0].sha256);
  expect(JSON.parse(json)).toMatchObject({ type: "fixture.large_authorized_record", details: { content: "x".repeat(60000) } });
});

test("archive verifier hashes an astral character split between real retained event chunks", async () => {
  const f = setup(30);
  const content = "😀".repeat(15000);
  f.emit("fixture.astral_record", { content });
  const reader = (f.observer as unknown as { history: HistoryReader }).history;
  const query = reader.query.bind(reader);
  let split = false;
  reader.query = async (input, options) => {
    const value = await query(input, options);
    if (input.kind === "export_page" && input.collection === "events" && !split) {
      const page = value as HistoryExportPage;
      const chunks = page.records.filter((record): record is Record<string, Json> =>
        record !== null && typeof record === "object" && !Array.isArray(record) && record.kind === "json_record_chunk");
      if (chunks.length >= 2) {
        const first = chunks[0]!, second = chunks[1]!;
        expect(typeof first.text).toBe("string");
        expect(typeof second.text).toBe("string");
        const text = first.text as string, boundary = text.lastIndexOf("😀") + 1;
        expect(boundary).toBeGreaterThan(0);
        // Reframe actual readonly bytes only: record identity, chunk count, cursor,
        // original byte count and hash remain the child's; no record is fabricated.
        first.text = text.slice(0, boundary);
        second.text = text.slice(boundary) + second.text;
        expect(first.text.charCodeAt(first.text.length - 1)).toBe(0xd83d);
        expect(second.text.charCodeAt(0)).toBe(0xde00);
        split = true;
      }
    }
    return value;
  };
  const finalized = await f.observer.finalize(f.run.run_id, { status: "finished", reason: "astral_chunk_verifier_fixture" });
  expect(split).toBe(true);
  expect(finalized.evidence_complete).toBe(true);
  const chunks = readFileSync(path.join(f.root, finalized.journal), "utf8").trim().split("\n").map(line => JSON.parse(line))
    .filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "events")
    .flatMap(record => record.value.payload.records);
  const json = chunks.map(chunk => chunk.text).join("");
  expect(Buffer.byteLength(json)).toBe(chunks[0].original_bytes);
  expect(createHash("sha256").update(json).digest("hex")).toBe(chunks[0].sha256);
  expect(JSON.parse(json)).toMatchObject({ type: "fixture.astral_record", details: { content } });
});

test("compact event caps count original records rather than transport chunks", async () => {
  const f = setup(30, { reportCaps: { reportJsonBytes: 256000, reportEventPages: 1, eventPageRecords: 1 } });
  f.emit("fixture.first_large_record", { content: "x".repeat(60000) });
  f.emit("fixture.second_omitted_record", {});
  const name = await f.observer.save(f.run.run_id);
  const saved = JSON.parse(readFileSync(path.join(f.root, name), "utf8"));
  const chunks: Array<{ text: string; chunk_index: number; chunk_count: number }> = saved.events;
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.at(-1)!.chunk_index + 1).toBe(chunks.at(-1)!.chunk_count);
  expect(JSON.parse(chunks.map(chunk => chunk.text).join(""))).toMatchObject({ type: "fixture.first_large_record" });
  expect(saved.history_export.collections.events).toMatchObject({
    next_after: { record_index: 1, chunk_index: 0 }, logical_records: 1, total: 2, has_more: true,
  });
  expect(saved.history_export.collections.events.pages).toBe(chunks.length);
  expect(createHash("sha256").update(chunks.map(chunk => chunk.text).join("")).digest("hex"))
    .toBe(saved.events[0].sha256);
  expect(saved.summary.omissions.events).toBe(1);
});

async function publishMetrics(f: ReturnType<typeof setup>, reader = (f.observer as unknown as { history: HistoryReader }).history) {
  await new ImprovementLearning(f.store, reader).prepareFeedback(f.run.run_id, { deadlineHostMs: performance.now() + 60_000 });
}

test("unpublished derived metrics remain explicitly unknown while readonly exports retain raw evidence", async () => {
  const f = setup(30);
  const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "unpublished objective metrics"));
  const execution = historyExecution(f.store, f.run, skill);
  finishHistoryExecution(f.store, execution);
  f.emit("fixture.unpublished_raw", { marker: "retained-without-projection" });
  f.store.recordTrace({ run_id: f.run.run_id, execution_id: execution.execution_id, root_execution_id: execution.root_execution_id,
    parent_execution_id: null, skill_id: skill.skill_id, version: skill.version, hash: skill.hash,
    session_id: f.run.session_id, life_id: f.run.life_id, kind: "observation", payload: { marker: "unpublished-raw-trace" } });
  const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
  const source = f.store.historySourceHighwater(f.run.run_id);
  const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
  expect(saved.objective_metrics).toBeNull();
  expect(saved.history_export.collections.objective_metrics).toMatchObject({
    status: "unavailable", omission: "projection_pending_first_publication", projection: null,
    source_available: source, has_pending: true, total: null, logical_records: null, omitted_records: null, pages: 0,
  });
  expect(saved.events.some((event: { type: string }) => event.type === "fixture.unpublished_raw")).toBe(true);
  expect(saved.sources).toHaveLength(1);
  expect(saved.executions).toHaveLength(1);
  expect(saved.traces.some((trace: { payload: { marker?: string } }) => trace.payload.marker === "unpublished-raw-trace")).toBe(true);
  const finalized = await f.observer.finalize(f.run.run_id, { status: "finished", reason: "unpublished_fixture" });
  expect(finalized.evidence_complete).toBe(true);
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest.history_export.collections.objective_metrics).toMatchObject({
    status: "unavailable", projection: null, total: null, source_available: source, has_pending: true,
  });
  const records = readFileSync(path.join(f.root, finalized.journal), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(records.find(record => record.kind === "readonly_history_export_collection" && record.value.collection === "objective_metrics").value)
    .toMatchObject({ total: null, complete: false, omission: "projection_pending_first_publication" });
  expect(records.filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "events")
    .flatMap(record => record.value.payload.records).some(record => record.type === "fixture.unpublished_raw")).toBe(true);
  expect(records.filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "sources")
    .flatMap(record => record.value.payload.records).some(record => record.hash === skill.hash)).toBe(true);
  expect(records.filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "traces")
    .flatMap(record => record.value.payload.records).some(record => record.payload?.marker === "unpublished-raw-trace")).toBe(true);
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  expect(f.store.historySourceHighwater(f.run.run_id)).toBe(source);
});

test("a published empty objective metric population has a declared complete as-of scope", async () => {
  const f = setup(30);
  await publishMetrics(f);
  const published = f.store.historyProjectionGeneration(f.run.run_id)!;
  const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
  expect(saved.objective_metrics).toEqual([]);
  expect(saved.history_export.collections.objective_metrics).toMatchObject({
    next_after: { record_index: 0, chunk_index: 0 }, has_more: false, total: 0, pages: 1, logical_records: 0, omitted_records: 0,
    status: "published", projection: { generation: published.generation, source_through: published.source_through, has_pending: false },
  });
});

test("a missing completed projection generation is corruption, not an unavailable derived export", async () => {
  const f = setup(30);
  await publishMetrics(f);
  const published = f.store.historyProjectionGeneration(f.run.run_id)!;
  expect(published.generation).toBeGreaterThan(0);
  const database = new Database(f.store.readLocation().database);
  try {
    database.query("DELETE FROM history_projection_generations WHERE run_id=? AND generation=?")
      .run(f.run.run_id, published.generation);
  } finally {
    database.close();
  }
  await expect(f.observer.save(f.run.run_id)).rejects.toMatchObject({ code: "conflict" });
  const failed = JSON.parse(readFileSync(path.join(f.root, `run-${f.run.run_id}-evidence.json`), "utf8"));
  expect(failed.omission).toBe("history_query_failed");
  expect(failed.history_export.collections.objective_metrics.status).not.toBe("unavailable");
  const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "corrupt_publication" });
  expect(finalized.evidence_complete).toBe(false);
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest.failures).toContain("private_history_export_query_failed");
});

test("finalization after cancellation labels old running metrics pending and retains the closed raw execution", async () => {
  const f = setup(30);
  const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "cancelled after publication"));
  const execution = historyExecution(f.store, f.run, skill);
  await publishMetrics(f);
  const published = f.store.historyProjectionGeneration(f.run.run_id)!;
  execution.status = "cancelled";
  execution.ended_at = "2020-01-01T00:00:01.000Z";
  f.store.updateSkillExecution(execution, "skill.closed", "Storage-only cancellation; producer is not restarted");
  const source = f.store.historySourceHighwater(f.run.run_id);
  const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
  const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
  expect(saved.objective_metrics).toHaveLength(1);
  expect(saved.objective_metrics[0]).toMatchObject({ execution_id: execution.execution_id, outcome: "running" });
  expect(saved.executions[0]).toMatchObject({ execution_id: execution.execution_id, status: "cancelled" });
  expect(saved.history_export.collections.objective_metrics.projection).toEqual({
    generation: published.generation, source_through: published.source_through, source_available: source, has_pending: true,
  });
  const finalized = await f.observer.finalize(f.run.run_id, { status: "cancelled", reason: "closed_without_restarting_producer" });
  expect(finalized.evidence_complete).toBe(true);
  const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
  expect(manifest.history_export.collections.objective_metrics).toMatchObject({
    status: "published", total: 1, complete: true, projection: saved.history_export.collections.objective_metrics.projection,
  });
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  expect(f.store.historySourceHighwater(f.run.run_id)).toBe(source);
});

for (const target of ["compact", "journal"] as const) {
  test(`${target} export pins chunked metrics when a newer complete generation is published between chunks`, async () => {
    const f = setup(30);
    const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "metric generation during chunk export"));
    const execution = historyExecution(f.store, f.run, skill);
    const inventory = Object.fromEntries(Array.from({ length: 2500 }, (_, index) => [`generation_material_${index}`, index + 1]));
    const accepted = f.store.admitAction(f.run.run_id, "generation-chunk-receipt",
      { kind: "craft", item: "crafting_table", executions: 1 }, "skill", execution.execution_id,
      skillAuthorityFixture(f.run, execution)).action;
    f.store.saveAction(f.run.run_id, { ...accepted.view, status: "succeeded",
      result: { status: "succeeded", summary: "Storage-only retained receipt", evidence: {
        inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: inventory, effect_confirmed: true,
      } } });
    await publishMetrics(f);
    const expected = objectiveMetrics(f.store, f.run.run_id);
    const published = f.store.historyProjectionGeneration(f.run.run_id)!;
    const reader = (f.observer as unknown as { history: HistoryReader }).history;
    const publisher = new HistoryReader(f.store.readLocation());
    const query = reader.query.bind(reader);
    let advanced = false;
    const generations: Array<number | undefined> = [];
    reader.query = async (input, options) => {
      expect(input.kind).not.toBe("projection_batch");
      if (input.kind === "export_page" && input.collection !== "objective_metrics")
        expect(input.generation).toBeUndefined();
      const value = await query(input, options);
      if (input.kind === "export_page" && input.collection === "objective_metrics") {
        generations.push(input.generation);
        const page = value as HistoryExportPage;
        if (!advanced) {
          expect(page.has_more).toBe(true);
          expect(page.records.every(record => record !== null && typeof record === "object" &&
            !Array.isArray(record) && record.kind === "json_record_chunk")).toBe(true);
          advanced = true;
          finishHistoryExecution(f.store, execution);
          await publishMetrics(f, publisher);
          expect(f.store.historyProjectionGeneration(f.run.run_id)!.generation).toBeGreaterThan(published.generation);
        }
      }
      return value;
    };
    try {
      let chunks: Array<{ text: string; sha256: string }>, scope;
      if (target === "compact") {
        const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id,
          { deadlineHostMs: performance.now() + 60_000 })), "utf8"));
        chunks = saved.objective_metrics;
        scope = saved.history_export.collections.objective_metrics;
        expect(statSync(path.join(f.root, `run-${f.run.run_id}-evidence.json`)).size)
          .toBeLessThanOrEqual(DEFAULT_EVALUATION_CAPS.reportJsonBytes);
      } else {
        const finalized = await f.observer.finalize(f.run.run_id, { status: "finished", reason: "generation_pinning" },
          { deadlineHostMs: performance.now() + 60_000 });
        expect(finalized.evidence_complete).toBe(true);
        const records = readFileSync(path.join(f.root, finalized.journal), "utf8").trim().split("\n").map(line => JSON.parse(line));
        chunks = records.filter(record => record.kind === "readonly_history_export_page" && record.value.collection === "objective_metrics")
          .flatMap(record => record.value.payload.records);
        const manifest = JSON.parse(readFileSync(path.join(f.root, finalized.manifest), "utf8"));
        scope = manifest.history_export.collections.objective_metrics;
      }
      expect(advanced).toBe(true);
      expect(generations.length).toBeGreaterThan(1);
      expect(generations.every(generation => generation === published.generation)).toBe(true);
      const text = chunks.map(chunk => chunk.text).join("");
      expect(createHash("sha256").update(text).digest("hex")).toBe(chunks[0]!.sha256);
      expect(JSON.parse(text)).toEqual(expected[0]);
      expect(scope).toMatchObject({ status: "published", total: 1, complete: true, projection: {
        generation: published.generation, source_through: published.source_through,
        source_available: f.store.historySourceHighwater(f.run.run_id), has_pending: true,
      } });
    } finally {
      reader.query = query;
      await publisher.close();
    }
  }, 60_000);
}

test("compact objective metrics stream every retained execution across real readonly pages", async () => {
  const f = setup(30);
  const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "objective metric pagination"));
  const executions = Array.from({ length: 102 }, () => historyExecution(f.store, f.run, skill));
  for (const [index, execution] of executions.entries()) {
    if (index < 2) {
      const accepted = f.store.admitAction(f.run.run_id, `metric-receipt-${index}`,
        { kind: "craft", item: "crafting_table", executions: 1 }, "skill", execution.execution_id,
        skillAuthorityFixture(f.run, execution)).action;
      f.store.saveAction(f.run.run_id, { ...accepted.view, status: "succeeded",
        result: { status: "succeeded", summary: "Storage-only objective receipt fixture", evidence: {
          inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { crafting_table: index + 1 },
          effect_confirmed: true, travel_distance: index + 2, native_action_ms: index + 3,
        } } });
    }
    finishHistoryExecution(f.store, execution);
  }
  const expected = objectiveMetrics(f.store, f.run.run_id);
  await publishMetrics(f);
  const forbidden = () => { throw new Error("writer-side unbounded history read"); };
  f.store.allSkillExecutions = forbidden;
  f.store.eventsAfter = forbidden;
  f.store.tracePage = forbidden;
  const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
  expect(Array.isArray(saved.objective_metrics)).toBe(true);
  expect(saved.objective_metrics).toEqual(expected);
  for (const index of [0, 1]) {
    expect(saved.objective_metrics.find((metric: { execution_id: string }) => metric.execution_id === executions[index]!.execution_id))
      .toMatchObject({ outcome: "succeeded", inventory_receipts: 1, inventory_delta: { crafting_table: index + 1 },
        receipted_travel_distance: index + 2, motion_receipts: 1, spans_ms: { native_action: index + 3 } });
  }
  expect(saved.history_export.collections.objective_metrics).toMatchObject({
    next_after: { record_index: executions.length, chunk_index: 0 }, has_more: false, total: executions.length,
    logical_records: executions.length, omitted_records: 0,
  });
  expect(saved.history_export.collections.objective_metrics.pages).toBeGreaterThan(1);
  expect(statSync(path.join(f.root, `run-${f.run.run_id}-evidence.json`)).size)
    .toBeLessThanOrEqual(DEFAULT_EVALUATION_CAPS.reportJsonBytes);
});

test("compact objective metrics retain oversized logical records using the shared chunk transport", async () => {
  const f = setup(30);
  const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "chunked objective metric"));
  const executions = [historyExecution(f.store, f.run, skill), historyExecution(f.store, f.run, skill)];
  const inventory = Object.fromEntries(Array.from({ length: 2500 }, (_, index) => [`fixture_material_${index}`, index + 1]));
  const accepted = f.store.admitAction(f.run.run_id, "large-metric-receipt",
    { kind: "craft", item: "crafting_table", executions: 1 }, "skill", executions[0]!.execution_id,
    skillAuthorityFixture(f.run, executions[0]!)).action;
  f.store.saveAction(f.run.run_id, { ...accepted.view, status: "succeeded",
    result: { status: "succeeded", summary: "Storage-only large objective receipt", evidence: {
      inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: inventory, effect_confirmed: true,
    } } });
  for (const execution of executions) finishHistoryExecution(f.store, execution);
  const expected = objectiveMetrics(f.store, f.run.run_id);
  await publishMetrics(f);
  const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
  const decoded = [];
  let text = "";
  for (const record of saved.objective_metrics) {
    if (record.kind !== "json_record_chunk") { decoded.push(record); continue; }
    expect(record.collection).toBe("objective_metrics");
    text += record.text;
    if (record.chunk_index + 1 === record.chunk_count) {
      expect(Buffer.byteLength(text)).toBe(record.original_bytes);
      expect(createHash("sha256").update(text).digest("hex")).toBe(record.sha256);
      decoded.push(JSON.parse(text));
      text = "";
    }
  }
  expect(text).toBe("");
  expect(saved.objective_metrics.some((record: { kind?: string }) => record.kind === "json_record_chunk")).toBe(true);
  expect(decoded).toEqual(expected);
  expect(saved.history_export.collections.objective_metrics).toMatchObject({
    next_after: { record_index: executions.length, chunk_index: 0 }, has_more: false, total: executions.length,
    logical_records: executions.length, omitted_records: 0,
  });
});

for (const failedJournals of [1, 2]) {
  test(`observer close drains the real reader and every journal after ${failedJournals} cached finalization failures`, async () => {
    const f = setup(30);
    resources.splice(resources.findIndex(resource => resource.observer === f.observer), 1);
    const runs = [f.run, minecraftRunFixture(adapter), minecraftRunFixture(adapter)];
    const reader = (f.observer as unknown as { history: HistoryReader }).history;
    try {
      for (const run of runs) {
        f.store.saveRun(run);
        f.store.event(run.run_id, "fixture.journal_closure", "Storage-only closure fixture", {});
      }
      await f.observer.summary(f.run.run_id);
      expect(reader.snapshot().child?.pid).toBeNumber();
      const failures: unknown[] = [];
      for (const run of runs.slice(0, failedJournals)) {
        const key = createHash("sha256").update(run.run_id).digest("hex");
        mkdirSync(path.join(f.root, `run-${key}-manifest.json`));
        const failure = await f.observer.finalize(run.run_id, { status: "failed", reason: "manifest_path_is_directory" })
          .then(() => null, error => error);
        expect(failure).toBeInstanceOf(Error);
        failures.push(failure);
      }
      const failure = await f.observer.close().then(() => null, error => error);
      if (failedJournals === 1) expect(failure).toBe(failures[0]);
      else {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual(failures);
      }
      const lastKey = createHash("sha256").update(runs[2]!.run_id).digest("hex");
      expect(JSON.parse(readFileSync(path.join(f.root, `run-${lastKey}-manifest.json`), "utf8")))
        .toMatchObject({ evidence_complete: true, reason: "observer_closed_without_prior_finalization" });
      const closed = reader.snapshot();
      expect(closed).toMatchObject({ closed: true, active: false, queued: 0 });
      expect(closed.child?.exitObservedHostMs).toBeNumber();
      expect(closed.child?.stdoutDrainObservedHostMs).toBeNumber();
      expect(closed.child?.closedHostMs).toBeNumber();
    } finally {
      await f.observer.close().catch(() => {});
      f.store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("a late observer reads the original bounded durable prefix without reconstructing history in the writer", async () => {
  const f = setup(30);
  f.emit("model.call", { request_id: "before-observer" });
  f.emit("model.usage", { request_id: "before-observer", uncached_input_tokens: 7, output_tokens: 3 });
  f.emit("model.request_settled", { request_id: "before-observer", stop_reason: "stop" });
  f.emit("scheduler.turn_finished", {});
  const late = new ModelProgramEvidence(f.store, path.join(f.root, "late"), DEFAULT_EVALUATION_CAPS, "late-observer-host-clock", () => {});
  try {
    expect(await late.summary(f.run.run_id)).toMatchObject({
      provider_settled: true, usage: { admissions: 1, reported_messages: 1, event_coverage: "complete",
        reported_subtotal: { uncached_input: 7, output: 3 } },
    });
    expect(await late.eventCount(f.run.run_id, "scheduler.turn_finished")).toBe(1);
    f.emit("model.tool_started", { tool: "game_observe", tool_call_id: "after-observer" });
    expect((await late.summary(f.run.run_id)).tools).toEqual([{ name: "game_observe", count: 1 }]);
  } finally {
    await late.close();
  }
});

test("the observer uses the configured admission cap, not a private hardcoded limit", async () => {
  const { emit, observer, run, stops } = setup(1);
  emit("model.call", { request_id: "request-1" });
  expect(stops).toEqual(["host_request_admission_bound_reached"]);
  expect((await observer.summary(run.run_id)).usage).toMatchObject({ admissions: 1, reported_messages: 0, uncached_input: null, output: null, wire_attempts: null });
});

test("SDK-promoted interrupted tool responses retain provider failure classification", async () => {
  const f = setup();
  f.emit("model.call", {request_id:"recovered-failed-request"});
  f.emit("model.request_settled", {request_id:"recovered-failed-request",stop_reason:"toolUse",
    role:"authoring",obsolete:true,recovered_failure:{type:"stream_interrupted_after_content",explanation:"stream_read_error"}});
  expect(f.observer.hasProviderFailure(f.run.run_id)).toBe(true);
  expect((await f.observer.summary(f.run.run_id)).provider_error).toBe(true);
  expect(f.stops).toContain("provider_failure_or_unsettled_no_repeat");
});

const authoringCancellation = { kind: "ordinary_authoring", request_id: "cancelled-authoring",
  root_execution_id: "foreground-root", reason: "root_settled" };
const abortedAuthoring: Record<string, Json> = { request_id: "cancelled-authoring", role: "authoring",
  stop_reason: "aborted", usage_reported: false,
  recovered_failure: { type: "stream_interrupted_after_content", explanation: "stream_read_error" } };
const cancelledAuthoring: Record<string, Json> = { ...abortedAuthoring, obsolete: true, host_cancellation: authoringCancellation };
const strategicCancellation = { kind: "strategic_host", request_id: "cancelled-strategic", reason: "fenced" };
const cancelledRecovery: Record<string, Json> = { ...abortedAuthoring, request_id: "cancelled-strategic",
  role: "recovery", obsolete: true, host_cancellation: strategicCancellation };
const argumentBudget = { kind: "tool_argument_budget", request_id: "cancelled-strategic",
  tool: "program_run", path: ["reason"], limit: 300, observed: 301 };
const cancelledArgumentBudget: Record<string, Json> = { ...cancelledRecovery, role: "planning", obsolete: false,
  host_cancellation: { ...strategicCancellation, reason: "tool_argument_budget" }, resource_rejection: argumentBudget };
const cancellationCases: Array<{ name: string; type?: string; details: Record<string, Json>;
  providerError: boolean; providerSettled: boolean }> = [
  { name: "confirmed host cancellation", details: cancelledAuthoring, providerError: false, providerSettled: true },
  { name: "confirmed host containment fence", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, reason: "fenced" } }, providerError: false, providerSettled: true },
  { name: "urgent resident attention cancellation", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, reason: "resident_attention" } }, providerError: false, providerSettled: true },
  { name: "local reactive interrupt cancellation", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, reason: "policy_interrupt" } }, providerError: false, providerSettled: true },
  { name: "wrong request identity", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, request_id: "different-request" } }, providerError: true, providerSettled: false },
  { name: "wrong role", details: { ...cancelledAuthoring, role: "strategic" }, providerError: true, providerSettled: false },
  { name: "missing obsolete flag", details: { ...abortedAuthoring, host_cancellation: authoringCancellation }, providerError: true, providerSettled: false },
  { name: "provider error instead of abort", details: { ...cancelledAuthoring, stop_reason: "error" }, providerError: true, providerSettled: false },
  { name: "historical missing marker", details: { ...abortedAuthoring, obsolete: true }, providerError: true, providerSettled: false },
  { name: "spoofed cancellation kind", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, kind: "worker" } }, providerError: true, providerSettled: false },
  { name: "missing root identity", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, root_execution_id: "" } }, providerError: true, providerSettled: false },
  { name: "unapproved close reason", details: { ...cancelledAuthoring,
    host_cancellation: { ...authoringCancellation, reason: "provider_lost" } }, providerError: true, providerSettled: false },
  { name: "recovered provider failure despite marker", details: { ...cancelledAuthoring, stop_reason: "toolUse" },
    providerError: true, providerSettled: true },
  { name: "unsettled request despite marker", type: "model.request_unsettled", details: cancelledAuthoring,
    providerError: true, providerSettled: false },
  { name: "unsettled request without SDK failure metadata", type: "model.request_unsettled",
    details: { request_id: "cancelled-authoring", usage_reported: false }, providerError: true, providerSettled: false },
  { name: "recovery fenced after player death", details: cancelledRecovery, providerError: false, providerSettled: true },
  { name: "planning fenced by host", details: { ...cancelledRecovery, role: "planning" },
    providerError: false, providerSettled: true },
  { name: "review fenced by host", details: { ...cancelledRecovery, role: "review" },
    providerError: false, providerSettled: true },
  { name: "non-root authoring fenced by host", details: { ...cancelledRecovery, role: "authoring" },
    providerError: false, providerSettled: true },
  { name: "speculative request preempted by wake", details: { ...cancelledRecovery, role: "speculative",
    host_cancellation: { ...strategicCancellation, reason: "speculative_preempted" } }, providerError: false, providerSettled: true },
  { name: "current planning request cancelled at host turn deadline", details: { ...cancelledRecovery,
    role: "planning", obsolete: false, host_cancellation: { ...strategicCancellation, reason: "turn_deadline" } },
    providerError: false, providerSettled: true },
  { name: "current argument generation stopped at its declared field bound", details: cancelledArgumentBudget,
    providerError: false, providerSettled: true },
  { name: "argument budget cause without measured rejection", details: { ...cancelledArgumentBudget, resource_rejection: null },
    providerError: true, providerSettled: false },
  { name: "argument budget rejection for another request", details: { ...cancelledArgumentBudget,
    resource_rejection: { ...argumentBudget, request_id: "another-request" } }, providerError: true, providerSettled: false },
  { name: "argument budget cause without actual overrun", details: { ...cancelledArgumentBudget,
    resource_rejection: { ...argumentBudget, observed: 300 } }, providerError: true, providerSettled: false },
  { name: "clean completed response rejected at argument budget", details: { ...cancelledArgumentBudget,
    stop_reason: "toolUse", host_cancellation: null, recovered_failure: null }, providerError: false, providerSettled: true },
  { name: "argument budget marker alongside genuine provider error", details: { ...cancelledArgumentBudget,
    stop_reason: "error" }, providerError: true, providerSettled: false },
  { name: "argument budget marker alongside recovered tool response", details: { ...cancelledArgumentBudget,
    stop_reason: "toolUse" }, providerError: true, providerSettled: true },
  { name: "unsettled argument budget cancellation", type: "model.request_unsettled", details: cancelledArgumentBudget,
    providerError: true, providerSettled: false },
  { name: "generic cancellation with unknown host role", details: { ...cancelledRecovery, role: "worker" },
    providerError: true, providerSettled: false },
  { name: "generic cancellation without role", details: { ...cancelledRecovery, role: null },
    providerError: true, providerSettled: false },
  { name: "generic cancellation with root-only reason", details: { ...cancelledRecovery,
    host_cancellation: { ...strategicCancellation, reason: "root_settled" } }, providerError: true, providerSettled: false },
  { name: "generic cancellation with mismatched request", details: { ...cancelledRecovery,
    host_cancellation: { ...strategicCancellation, request_id: "another-request" } }, providerError: true, providerSettled: false },
  { name: "generic cancellation with empty request", details: { ...cancelledRecovery, request_id: "",
    host_cancellation: { ...strategicCancellation, request_id: "" } }, providerError: true, providerSettled: false },
  { name: "generic cancellation with blank request", details: { ...cancelledRecovery, request_id: " ",
    host_cancellation: { ...strategicCancellation, request_id: " " } }, providerError: true, providerSettled: false },
  { name: "generic cancellation with root marker fields", details: { ...cancelledRecovery,
    host_cancellation: { ...strategicCancellation, root_execution_id: "foreground-root" } }, providerError: true, providerSettled: false },
  { name: "generic fence without obsolete evidence", details: { ...cancelledRecovery, obsolete: false },
    providerError: true, providerSettled: false },
  { name: "generic preemption with non-speculative role", details: { ...cancelledRecovery,
    host_cancellation: { ...strategicCancellation, reason: "speculative_preempted" } }, providerError: true, providerSettled: false },
  { name: "generic marker alongside genuine provider error", details: { ...cancelledRecovery, stop_reason: "error" },
    providerError: true, providerSettled: false },
  { name: "generic marker alongside recovered partial tool response", details: { ...cancelledRecovery, stop_reason: "toolUse" },
    providerError: true, providerSettled: true },
  { name: "generic marker on unsettled recovery", type: "model.request_unsettled", details: cancelledRecovery,
    providerError: true, providerSettled: false },
  { name: "obsolete recovery without cancellation provenance", details: { ...cancelledRecovery, host_cancellation: null },
    providerError: true, providerSettled: false },
  { name: "worker-authored cancellation inside recovered failure", details: { ...cancelledRecovery, host_cancellation: null,
    recovered_failure: { type: "stream_interrupted_after_content", host_cancellation: strategicCancellation } },
    providerError: true, providerSettled: false },
];
for (const scenario of cancellationCases) {
  test(`live and readonly evaluation agree on ${scenario.name} without inventing usage`, async () => {
    const f = setup(30);
    f.emit("model.call", { request_id: scenario.details.request_id!, role: scenario.details.role ?? "authoring" });
    f.emit(scenario.type ?? "model.request_settled", scenario.details);
    expect(f.observer.hasProviderFailure(f.run.run_id)).toBe(scenario.providerError);
    expect(f.stops).toEqual(scenario.providerError ? ["provider_failure_or_unsettled_no_repeat"] : []);
    const forbidden = () => { throw new Error("writer-side unbounded history read"); };
    f.store.events = forbidden;
    expect(await f.observer.summary(f.run.run_id)).toMatchObject({
      provider_error: scenario.providerError, provider_settled: scenario.providerSettled,
      usage: { admissions: 1, reported_messages: 0, event_coverage: "incomplete", consumption_coverage: "unknown",
        uncached_input: null, cache_read: null, cache_write: null, output: null, wire_attempts: null },
    });
  });
}

async function observedAgent(f: ReturnType<typeof setup>) {
  const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses" && model.input.includes("image"));
  if (!descriptor) throw new Error("Installed catalog lacks offline Codex descriptor");
  const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
  const agent = new Agent({ initialState: { model }, getApiKey: async () => "DO_NOT_PERSIST_FIXTURE_CREDENTIAL" });
  const auth = { createAgent: async () => agent } as unknown as AuthManager;
  f.observer.observeAuthAgents(auth, () => f.run.run_id);
  await auth.createAgent({} as Parameters<AuthManager["createAgent"]>[0]);
  return agent;
}

test("invalid_program from an actual Agent tool rejection is authoring evidence, not a platform failure", async () => {
  const f = setup(), agent = await observedAgent(f);
  agent.emitExternalEvent({ type: "tool_execution_end", toolCallId: "rejected", toolName: "program_write",
    result: { content: [{ type: "text", text: "Invalid source" }], details: { error: { code: "invalid_program", issues: [{ code: "invalid_syntax", location: { line: 1, column: 8 } }] } } },
    isError: true } as AgentEvent);
  expect(await f.observer.summary(f.run.run_id)).toMatchObject({ unclassified_tool_failures: false, confirmed_harness_faults: [] });
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
  f.observer.observeAuthAgents(auth, () => f.run.run_id);
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

test("durable usage retains reported subtotals when the final admitted request is unreported", async () => {
  const { emit, observer, run } = setup();
  emit("model.call", { request_id: "request-1" });
  emit("model.usage", { request_id: "request-1", uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 });
  emit("model.request_settled", { request_id: "request-1", stop_reason: "toolUse", usage_reported: true });
  expect(await observer.summary(run.run_id)).toMatchObject({ provider_settled: true, usage: {
    event_coverage: "complete", consumption_coverage: "unknown", uncached_input: null, output: null } });
  emit("model.call", { request_id: "request-2" });
  emit("model.request_unsettled", { request_id: "request-2", usage_reported: false });
  expect(await observer.summary(run.run_id)).toMatchObject({ provider_settled: false, usage: { admissions: 2, reported_messages: 1,
    event_coverage: "incomplete", consumption_coverage: "unknown", output: null,
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 5 }, subscription_cost: null } });
});

test("SDK-only event capture is complete without inventing provider consumption from stop reason or response ID", async () => {
  const { emit, observer, run } = setup();
  emit("model.call", { request_id: "sdk-only" });
  emit("model.usage", { request_id: "sdk-only", provider_response_id: "not-proof",
    uncached_input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 });
  emit("model.request_settled", { request_id: "sdk-only", stop_reason: "stop", usage_reported: true });
  expect(await observer.summary(run.run_id)).toMatchObject({ provider_settled: true, usage: {
    schema_version: 2, event_coverage: "complete", consumption_coverage: "unknown",
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 } } });
});

test("a missing later category cannot erase a valid earlier SDK subtotal", async () => {
  const { emit, observer, run } = setup(30);
  for (const request of ["first", "partial"]) emit("model.call", { request_id: request });
  emit("model.usage", { request_id: "first", uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 });
  emit("model.usage", { request_id: "partial", output_tokens: 2 });
  expect((await observer.summary(run.run_id)).usage).toMatchObject({
    event_coverage: "complete", consumption_coverage: "unknown",
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 7 },
    uncached_input: null, output: null,
  });
});

test("duplicate and unmatched durable usage cannot double count or certify another host admission", async () => {
  const { emit, observer, run } = setup(30);
  emit("model.call", { request_id: "first" });
  emit("model.call", { request_id: "missing" });
  const counters = { uncached_input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 5 };
  emit("model.usage", { request_id: "first", ...counters });
  emit("model.usage", { request_id: "first", ...counters });
  emit("model.usage", { request_id: "not-admitted", ...counters });
  expect((await observer.summary(run.run_id)).usage).toMatchObject({ admissions: 2, reported_messages: 1,
    event_coverage: "incomplete", consumption_coverage: "unknown", uncached_input: null, output: null,
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 5 } });
});

test("durable event-page omission cannot certify consumption even when the visible admission has a usage event", async () => {
  const { emit, observer, run } = setup(30, {
    reportCaps: { reportJsonBytes: 4096, reportEventPages: 1, eventPageRecords: 2 },
  });
  emit("model.call", { request_id: "first" });
  emit("model.usage", { request_id: "first", uncached_input_tokens: 7, output_tokens: 5 });
  emit("model.call", { request_id: "omitted" });
  expect((await observer.summary(run.run_id)).usage).toMatchObject({ admissions: 2, event_coverage: "incomplete",
    consumption_coverage: "unknown", uncached_input: null, output: null,
    reported_subtotal: { uncached_input: 7, output: 5 } });
});

test("zero admissions establish logical zero without a fabricated provider event or subscription price", async () => {
  const { observer, run, store } = setup();
  expect((await observer.summary(run.run_id)).usage).toMatchObject({ schema_version: 2, admissions: 0, reported_messages: 0,
    event_coverage: "complete", consumption_coverage: "known", uncached_input: 0, cache_read: 0, cache_write: 0, output: 0,
    wire_attempts: null, subscription_cost: null });
  expect(store.eventsAfter(run.run_id, 0, 500).filter(event => event.type === "model.usage")).toEqual([]);
});

test("an unsettled request retains genuinely collected terminal counters without inventing an SDK usage message or settlement", async () => {
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
  const summary = await observer.summary(run.run_id);
  expect(summary).toMatchObject({ provider_settled: false, usage: {
    admissions: 1, reported_messages: 0, event_coverage: "incomplete", consumption_coverage: "known",
    uncached_input: 6, cache_read: 3, cache_write: 1, output: 4,
    reported_subtotal: { uncached_input: null, cache_read: null, cache_write: null, output: null },
    wire_attempts: null, subscription_cost: null } });
  expect(readUsageMetrics(summary.usage)).toEqual(summary.usage);
  const outcome = classifyEvaluation({ inferenceAdmitted: true, goalVerified: false,
    platformChecksComplete: true, providerError: summary.provider_error, providerSettled: summary.provider_settled });
  expect(costToResult([{ outcome, usage: summary.usage }])).toMatchObject({
    uncached_input: 6, cache_read: 3, cache_write: 1, output: 4,
    reported_subtotal: { uncached_input: null, cache_read: null, cache_write: null, output: null },
  });
});

test("cached action evidence follows actual durable receipt updates rather than initial admission views", async () => {
  const { store, observer, run } = setup();
  const accepted = store.admitAction(run.run_id, "craft-action", { kind: "craft", item: "crafting_table", executions: 1 },
    "diagnostic", "fixture-diagnostic", diagnosticAuthorityFixture(run)).action;
  expect(observer.actions(run.run_id)[0]?.view.status).toBe("accepted");
  store.saveAction(run.run_id, { ...accepted.view, status: "succeeded", result: { status: "succeeded", summary: "Synthetic native-receipt test data only", evidence: {
    inventory_receipt_confirmed: true, inventory_before: { crafting_table: 0 }, inventory_after: { crafting_table: 1 }, effect_confirmed: true,
  } } });
  expect(observer.actions(run.run_id)[0]?.view.status).toBe("succeeded");
  expect((await observer.summary(run.run_id)).actions).toMatchObject({ count: 1, inventory_receipts: 1, inventory_delta: { crafting_table: 1 }, uncertain_outcomes: 0 });
});

test("provider errors stop the sample and remain distinct from a confirmed harness fault", async () => {
  const { emit, observer, run, stops } = setup();
  emit("model.call", { request_id: "request-1" });
  emit("model.request_settled", { request_id: "request-1", stop_reason: "error", usage_reported: false });
  expect(observer.hasProviderFailure(run.run_id)).toBe(true);
  expect(stops).toEqual(["provider_failure_or_unsettled_no_repeat"]);
  expect(await observer.summary(run.run_id)).toMatchObject({ provider_error: true, provider_settled: false, confirmed_harness_faults: [] });
});

test("a rejected cognition protocol before admission remains a platform failure in live and readonly evidence", async () => {
  const f = setup(30);
  f.emit("cognition.rpc_rejected", { method: "metadata", reason: "host_operation_failed" });
  expect((await f.observer.summary(f.run.run_id)).confirmed_harness_faults).toEqual([]);
  f.emit("cognition.rpc_rejected", { method: "metadata", reason: "invalid_metadata", issue_codes: ["unrecognized_keys"] });
  const summary = await f.observer.summary(f.run.run_id);
  expect(summary.confirmed_harness_faults).toContain("cognition_protocol_rejected");
  expect(classifyEvaluation({ inferenceAdmitted: false, goalVerified: false, platformChecksComplete: true,
    confirmedHarnessFaults: summary.confirmed_harness_faults, providerError: summary.provider_error,
    providerSettled: summary.provider_settled })).toMatchObject({
    platform_status: "fail", provider_status: "not_called", agent_status: "not_run",
  });
  const reader = new HistoryReader(f.store.readLocation());
  try {
    const retrospective = await reader.query({ kind: "evaluation_prefix", run_id: f.run.run_id, event_limit: 100 },
      { deadlineHostMs: performance.now() + 5000 });
    expect(retrospective).toMatchObject({ admissions: 0, confirmed_harness_faults: ["cognition_protocol_rejected"],
      provider_error: false, provider_settled: false });
  } finally { await reader.close(); }
});

for (const settledRequests of [0, 1]) {
  for (const failedRoute of ["projection_batch", "review_context"] as const)
  test(`a real ${failedRoute} history failure after ${settledRequests} settled requests cannot classify a verified goal as platform pass`, async () => {
    const f = setup(30);
    if (settledRequests) {
      f.emit("model.call", { request_id: "before-history-fault" });
      f.emit("model.usage", { request_id: "before-history-fault", uncached_input_tokens: 7, output_tokens: 2 });
      f.emit("model.request_settled", { request_id: "before-history-fault", stop_reason: "stop", usage_reported: true });
    }
    f.run.status = "reviewing";
    f.store.saveRun(f.run);
    const history = new HistoryReader(f.store.readLocation());
    const learning = new ImprovementLearning(f.store, history);
    const query = history.query.bind(history), routes: string[] = [];
    history.query = (input, options) => {
      routes.push(input.kind);
      return query(input, options);
    };
    const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses");
    if (!descriptor) throw new Error("Installed catalog lacks offline Codex descriptor");
    const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
    let providerCalls = 0;
    const agent = new Agent({ initialState: { model }, getApiKey: () => {
      providerCalls++;
      throw new Error("History preparation failure must not request credentials");
    }, streamFn: () => {
      providerCalls++;
      throw new Error("History preparation failure must not call a provider");
    } });
    const auth = { createAgent: async () => agent,
      releaseAgent: async () => { agent.abort(); await agent.waitForIdle(); } } as unknown as AuthManager;
    const observation = minecraftObservationFixture(adapter, { world_id: f.run.world_id, session_id: f.run.session_id! });
    const paused = Promise.withResolvers<void>(), pauseCauses: unknown[] = [];
    const planner = new StrategicPlanner(f.store, auth, {
      run: () => f.run, generation: () => 1, assertCurrent: () => f.run, tools: () => [],
      rootPrompt: () => "Storage-only history failure fixture", observe: async () => observation,
      projectObservation: current => adapter.projectObservation(current), policies: () => [],
      action: () => null, programPending: () => false, busy: () => true,
      persist: summary => f.store.saveRun(f.run, summary),
      pause: (message, cause) => {
        pauseCauses.push(cause);
        f.run.status = "paused";
        f.store.saveRun(f.run, message);
        planner.fence();
        paused.resolve();
      },
      terminal: () => { throw new Error("History failure must pause, not finish the run"); },
      reviewContext: async options => {
        if (failedRoute === "projection_batch") await history.close();
        await learning.prepareFeedback(f.run.run_id, options);
        await history.close();
        return await history.query({ kind: "review_context", run_id: f.run.run_id,
          after: { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null }, limit: 12 }, options);
      },
    });
    try {
      await planner.start(1);
      planner.wake("goal_review");
      await paused.promise;
    } finally {
      await planner.close();
      await learning.close();
    }
    expect(routes).toContain(failedRoute);
    if (failedRoute === "review_context") {
      expect(routes).toContain("projection_batch");
      expect(f.store.historyProjectionGeneration(f.run.run_id)?.generation).toBeGreaterThan(0);
    } else expect(routes).not.toContain("review_context");
    expect(providerCalls).toBe(0);
    expect(pauseCauses).toEqual(["preparation_failed"]);
    expect(f.store.getRun(f.run.run_id)?.status).toBe("paused");
    const events = f.store.eventsAfter(f.run.run_id, 0, 500);
    expect(events.filter(event => event.type === "runtime.history_query_failed")).toHaveLength(1);
    expect(events.find(event => event.type === "runtime.history_query_failed")?.details)
      .toMatchObject({ provider_request_made: false });
    expect(events.some(event => event.type === "runtime.model_observation_failed" || event.type === "model.request_unsettled")).toBe(false);
    const summary = await f.observer.summary(f.run.run_id);
    expect(summary).toMatchObject({ confirmed_harness_faults: ["history_query_failed"], provider_error: false,
      provider_settled: settledRequests > 0, observer_error: null,
      usage: { admissions: settledRequests, reported_messages: settledRequests, event_coverage: "complete" } });
    expect(f.observer.hasProviderFailure(f.run.run_id)).toBe(false);
    expect(f.stops).not.toContain("provider_failure_or_unsettled_no_repeat");
    const outcome = classifyEvaluation({ inferenceAdmitted: summary.usage.admissions > 0, goalVerified: true,
      platformChecksComplete: true, confirmedHarnessFaults: summary.confirmed_harness_faults,
      providerError: summary.provider_error, providerSettled: summary.provider_settled });
    expect(outcome).toMatchObject({ platform_status: "fail", provider_status: settledRequests ? "ok" : "not_called",
      agent_status: settledRequests ? "goal_verified" : "not_run" });
    expect(outcome.classification_reason).toContain("history_query_failed");
    expect(outcome.classification_reason).not.toContain("model_observation_failed");
    const saved = JSON.parse(readFileSync(path.join(f.root, await f.observer.save(f.run.run_id)), "utf8"));
    expect(saved.summary.confirmed_harness_faults).toEqual(["history_query_failed"]);
    const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "review_history_preparation_failed" });
    expect(finalized.evidence_complete).toBe(true);
    const journal = readFileSync(path.join(f.root, finalized.journal), "utf8");
    expect(journal).toContain('"type":"runtime.history_query_failed"');
    expect(journal).toContain('"provider_request_made":false');
    expect(journal).not.toContain('"type":"runtime.model_observation_failed"');
  });

  test(`observation preparation failure after ${settledRequests} settled requests is a durable platform fault, not provider failure`, async () => {
    const f = setup(30);
    if (settledRequests) {
      f.emit("model.call", { request_id: "already-settled" });
      f.emit("model.usage", { request_id: "already-settled", uncached_input_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 2 });
      f.emit("model.request_settled", { request_id: "already-settled", stop_reason: "stop", usage_reported: true });
    }
    f.emit("runtime.model_observation_failed", { provider_request_made: false });
    const summary = await f.observer.summary(f.run.run_id);
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
