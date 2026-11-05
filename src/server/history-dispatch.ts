import { createHash } from "node:crypto";
import type { ActivityEvent, Json } from "../shared/contracts.ts";
import { reduceEvaluationPrefix } from "../evaluation/evidence-prefix.ts";
import type { ImprovementFeedbackCursor, TracePage } from "../shared/execution-evidence.ts";
import { HISTORY_LIMITS } from "./history-limits.ts";
import type { HistoryExportCursor, HistoryExportPage, HistoryPage, HistoryQuery, HistoryResult } from "./history-protocol.ts";
import { readProjectedObjectiveMetric, readProjectedObjectiveMetricsPage } from "./history-objective.ts";
import { readProjectedProgramEvidence, readProjectedProgramEvidencePage } from "./history-evidence.ts";
import { prepareHistoryProjectionBatch } from "./history-projection.ts";
import { compareProgramVersionsPage } from "./program-comparison.ts";
import { programEvidence } from "./program-evidence.ts";
import { readImprovementFeedback, type ImprovementFeedbackPage, type ProjectionProgress } from "./program-feedback.ts";
import { ProgramWorkspace } from "./program-workspace.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { StoreReadQueries } from "./store-read.ts";

// Include the complete line envelope, reserving the largest supported numeric request identity.
function frameBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value }) + "\n");
}
function fits(value: unknown): boolean { return frameBytes(value) <= HISTORY_LIMITS.responseBytes; }
function tooLarge(): never {
  throw new RuntimeFault("budget_exceeded", "History result cannot fit the complete response frame byte budget");
}
function bounded<T>(value: T): T { if (!fits(value)) tooLarge(); return value; }

/** Re-page in the child, retaining the source query's own cursors and omission semantics. */
function refit<T>(limit: number, read: (limit: number) => T): T {
  for (let cap = limit; cap >= 1; cap--) {
    const value = read(cap);
    if (fits(value)) return value;
  }
  return tooLarge();
}
function requireProgress(hasMore: boolean, before: number, after: number): void {
  if (hasMore && after <= before)
    throw new RuntimeFault("budget_exceeded", "History record exceeds its page budget; continuation cannot make progress");
}
function requireFeedbackProgress(page: ImprovementFeedbackPage, after: ImprovementFeedbackCursor): void {
  if (page.has_more && page.next_after.opportunity_change_seq <= after.opportunity_change_seq && page.next_after.metric_change_seq <= after.metric_change_seq)
    throw new RuntimeFault("budget_exceeded", "Feedback record exceeds its page budget; continuation cannot make progress");
}

/** Only the selected SQL page is hydrated; offsets remain relative to the selected population. */
function evidencePage(store: StoreReadQueries, runId: string, after: number, limit: number,
  selection: { skill_id?: string; version?: number } = {}, workspace?: ProgramWorkspace) {
  const published = store.historyProjectionGeneration(runId);
  if (!published) throw new RuntimeFault("conflict", "History projection is pending its first complete publication");
  const selected = readProjectedProgramEvidencePage(store, runId, { ...selection, generation: published.generation, offset: after, limit });
  if (!selected) throw new RuntimeFault("conflict", "Published program evidence is unavailable");
  if (after > selected.total) throw new RuntimeFault("invalid_request", "History cursor is outside the selected population");
  const projection: ProjectionProgress = { generation: published.generation, source_through: published.source_through,
    source_available: published.source_available, has_pending: published.has_pending };
  const values = selected.evidence;
  const page: HistoryPage<(typeof values)[number]> & { projection: ProjectionProgress } = {
    records: [], next_after: after, has_more: after < selected.total, total: selected.total, omissions: [], projection,
  };
  let bytes = 0;
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value));
    const next = page.next_after + 1;
    const hasMore = next < selected.total;
    const view = (candidate: typeof page) => workspace ? {
      ...candidate, records: candidate.records.map(record => workspace.historyView(record, candidate.projection.generation)),
      omissions: candidate.omissions.map(({ reference, ...omission }) => {
        const retained = reference && typeof reference === "object" && !Array.isArray(reference) ? reference : null;
        return { ...omission, reference: typeof retained?.execution_id === "string"
          ? workspace.evidenceReadReference(retained.execution_id, candidate.projection.generation) : null };
      }),
    } : candidate;
    if (size > 48000) {
      const omission = { index: page.next_after, reason: "record_byte_budget", original_bytes: size,
        reference: { run_id: runId, execution_id: value.execution_id, generation: published.generation,
          program_evidence: { url: `/v1/runs/${encodeURIComponent(runId)}/skill-evidence/${encodeURIComponent(value.execution_id)}?generation=${published.generation}&record_index=0&chunk_index=0&limit=25` } } };
      if (!fits(view({ ...page, omissions: [...page.omissions, omission], next_after: next, has_more: hasMore }))) break;
      page.omissions.push(omission);
    } else {
      if (bytes + size > 60000 || !fits(view({ ...page, records: [...page.records, value], next_after: next, has_more: hasMore }))) break;
      page.records.push(value);
      bytes += size;
    }
    page.next_after = next;
    page.has_more = hasMore;
  }
  requireProgress(page.has_more, after, page.next_after);
  return page;
}

/** Only the requested logical rows are serialized; continuation identifies one chunk, not a flattened archive. */
function archivePage(
  query: Extract<HistoryQuery, { kind: "export_page" }>,
  values: { records: readonly unknown[]; total: number },
  projection?: ProjectionProgress,
): HistoryExportPage {
  const { after, collection, limit } = query;
  if (after.record_index > values.total || after.record_index === values.total && after.chunk_index !== 0)
    throw new RuntimeFault("invalid_request", "Archive cursor is outside the logical collection");
  const page: HistoryExportPage = { records: [], next_after: { ...after }, has_more: after.record_index < values.total,
    total: values.total, omissions: [], ...(projection ? { projection } : {}) };
  let recordBytes = 0;
  const append = (record: Json, next: HistoryExportCursor, size: number): boolean => {
    if (page.records.length === limit) return false;
    const hasMore = next.record_index < values.total;
    const envelope = frameBytes({ ...page, records: [], next_after: next, has_more: hasMore });
    if (envelope + recordBytes + size + page.records.length > HISTORY_LIMITS.responseBytes) return false;
    page.records.push(record);
    recordBytes += size;
    page.next_after = next;
    page.has_more = hasMore;
    return true;
  };
  outer: for (let offset = 0; offset < values.records.length; offset++) {
    if (page.records.length === limit) break;
    const index = after.record_index + offset;
    const encoded = JSON.stringify(values.records[offset]);
    const originalBytes = Buffer.byteLength(encoded);
    const firstChunk = offset === 0 ? after.chunk_index : 0;
    if (originalBytes <= 48000) {
      if (firstChunk !== 0)
        throw new RuntimeFault("invalid_request", "Archive chunk cursor does not identify a chunked record");
      if (!append(values.records[offset] as Json, { record_index: index + 1, chunk_index: 0 }, originalBytes)) break;
      continue;
    }
    // At most six JSON bytes per UTF-16 code unit, leaving ample chunk-envelope headroom.
    // Never split an astral character: each transported text remains independently valid UTF-8.
    const boundaries = [0];
    while (boundaries.at(-1)! < encoded.length) {
      let end = Math.min(boundaries.at(-1)! + 6000, encoded.length);
      if (end < encoded.length && encoded.charCodeAt(end - 1) >= 0xd800 && encoded.charCodeAt(end - 1) <= 0xdbff &&
        encoded.charCodeAt(end) >= 0xdc00 && encoded.charCodeAt(end) <= 0xdfff) end--;
      boundaries.push(end);
    }
    const count = boundaries.length - 1;
    if (firstChunk >= count)
      throw new RuntimeFault("invalid_request", "Archive chunk cursor is outside the retained record");
    const hash = createHash("sha256").update(encoded).digest("hex");
    for (let chunk = firstChunk; chunk < count; chunk++) {
      const record = { schema_version: 1, kind: "json_record_chunk", collection,
        record_index: index, record_count: values.total, chunk_index: chunk, chunk_count: count,
        encoding: "json_text", original_bytes: originalBytes,
        text: encoded.slice(boundaries[chunk], boundaries[chunk + 1]), sha256: hash };
      const next = chunk + 1 < count ? { record_index: index, chunk_index: chunk + 1 } : { record_index: index + 1, chunk_index: 0 };
      if (!append(record, next, Buffer.byteLength(JSON.stringify(record)))) break outer;
      if (page.records.length === limit) break outer;
    }
  }
  if (page.has_more && (page.next_after.record_index < after.record_index ||
    page.next_after.record_index === after.record_index && page.next_after.chunk_index <= after.chunk_index))
    throw new RuntimeFault("budget_exceeded", "Archive continuation cannot make progress");
  return bounded(page);
}

function tracePage(store: StoreReadQueries, runId: string, after: number, limit: number, executionId?: string): TracePage {
  const page = refit(limit, cap => store.tracePage(runId, after, cap, executionId));
  requireProgress(page.has_more, after, page.next_after);
  return page;
}

function modelInspect(store: StoreReadQueries, query: Extract<HistoryQuery, { kind: "model_inspect" }>): Json {
  const { run_id: runId, input } = query;
  const workspace = new ProgramWorkspace(store, runId);
  switch (input.view) {
    case "metric":
    case "evidence": {
      const program = workspace.select(input.program);
      const published = store.historyProjectionGeneration(runId, input.generation);
      if (!published) throw new RuntimeFault("conflict", `Requested complete ${input.view === "evidence" ? "evidence" : "metric"} generation is not retained`);
      const indexed = store.historyProjectionRows(runId, published.revision, {
        collection: "execution", after_order: input.execution_ordinal - 1, limit: 1,
      })[0];
      if (!indexed || indexed.order_seq !== input.execution_ordinal)
        throw new RuntimeFault("not_found", "Named execution ordinal is not retained in this generation");
      if (indexed.source_id !== program.skill_id || indexed.tag !== JSON.stringify([program.skill_id, program.version]))
        throw new RuntimeFault("conflict", "Execution ordinal does not belong to this exact program in the pinned generation");
      const records: unknown[] = [];
      if (input.after.record_index === 0) {
        // Strip opaque identities before hashing and chunking the named model record.
        if (input.view === "evidence") {
          const evidence = readProjectedProgramEvidence(store, runId, indexed.key, input.generation);
          if (!evidence) throw new RuntimeFault("conflict", "Pinned execution evidence is missing");
          records.push(workspace.historyView(evidence, published.generation));
        } else {
          const metric = readProjectedObjectiveMetric(store, runId, indexed.key, input.generation);
          if (!metric) throw new RuntimeFault("conflict", "Pinned objective metric is missing");
          records.push(workspace.metricView(metric, undefined, published.generation));
        }
      }
      const projection: ProjectionProgress = { generation: published.generation, source_through: published.source_through,
        source_available: published.source_available, has_pending: published.has_pending };
      return archivePage({ kind: "export_page", run_id: runId, collection: input.view === "evidence" ? "program_evidence" : "objective_metrics", after: input.after, limit: input.limit,
        generation: input.generation, execution_id: indexed.key },
      { total: 1, records }, projection) as unknown as Json;
    }
    case "history": {
      const program = input.program ? workspace.select(input.program) : null;
      const page = evidencePage(store, runId, input.after, input.limit, program ? {
        skill_id: program.skill_id, ...(input.program?.version !== undefined ? { version: program.version } : {}),
      } : {}, workspace);
      return { ...page, records: page.records.map(entry => workspace.historyView(entry, page.projection.generation)),
        omissions: page.omissions.map(({ reference, ...omission }) => {
          const retained = reference && typeof reference === "object" && !Array.isArray(reference) ? reference : null;
          return { ...omission, reference: typeof retained?.execution_id === "string"
            ? workspace.evidenceReadReference(retained.execution_id, page.projection.generation) : null };
        }) } as unknown as Json;
    }
    case "trace": {
      let execution = workspace.execution(input.target, input.program);
      if (input.after > 0) {
        const cursor = store.traceRecord(runId, input.after);
        if (!cursor) throw new RuntimeFault("invalid_request", "Trace cursor is not retained in this run");
        const selected = input.program ? workspace.select(input.program) : null;
        const id = selected ? cursor.execution_id ?? cursor.root_execution_id : cursor.root_execution_id ?? cursor.execution_id;
        execution = id ? store.skillExecution(runId, { execution_id: id }) : null;
        if (selected) {
          while (execution && (execution.skill_id !== selected.skill_id ||
            input.program?.version !== undefined && execution.version !== input.program.version))
            execution = execution.parent_execution_id ? store.skillExecution(runId, { execution_id: execution.parent_execution_id }) : null;
        }
        if (!execution) throw new RuntimeFault("conflict", "Trace cursor belongs to a different named execution scope");
      }
      if (!execution) throw new RuntimeFault("not_found", "No matching execution is available");
      const program = store.skill(runId, execution);
      const executionId = execution.execution_id;
      return refit(input.limit, cap => {
        const page = tracePage(store, runId, input.after, cap, executionId);
        return { ...workspace.traceView(page), program: { name: program.name, version: program.version } };
      }) as unknown as Json;
    }
    case "feedback": {
      const selected = input.program ? workspace.select(input.program) : null;
      return refit(input.limit, cap => {
        const page = readImprovementFeedback(store, runId, input.after, cap, selected ? {
          skill_id: selected.skill_id, ...(input.program?.version !== undefined ? { version: selected.version } : {}),
        } : {});
        requireFeedbackProgress(page, input.after);
        return workspace.feedbackView(page);
      }) as unknown as Json;
    }
    case "events": {
      return refit(input.limit, cap => {
        const candidates = store.eventsAfter(runId, input.after, cap + 1);
        const page = workspace.page(candidates.slice(0, cap), 0, cap);
        const through = candidates[page.next_after - 1]?.event_seq ?? input.after;
        const hasMore = page.has_more || candidates.length > cap;
        requireProgress(hasMore, input.after, through);
        return { records: page.records.map(event => workspace.eventView(event)), next_after: through,
          has_more: hasMore, omissions: page.omissions };
      }) as unknown as Json;
    }
    case "comparison": {
      if (input.after_sample !== null && (input.before.version === undefined || input.after.version === undefined))
        throw new RuntimeFault("conflict", "Continue comparison pages with the exact named versions returned on the first page");
      // Both selectors are confined to this already-authorized run before any source hydration.
      const run = store.getRun(runId)!;
      const before = workspace.select(input.before), after = workspace.select(input.after);
      const ref = (program: typeof before) => ({ run_id: runId, skill_id: program.skill_id, version: program.version, hash: program.hash });
      return refit(input.limit, cap => {
        const page = compareProgramVersionsPage(store, ref(before), ref(after), { kind: "model", run_id: runId, model_id: run.model_id }, input.after_sample, cap);
        requireProgress(page.has_more, input.after_sample?.offset ?? 0, page.next_after.offset);
        return workspace.comparisonView(page);
      }) as unknown as Json;
    }
  }
}

/** Trusted synchronous child dispatch. The owner supplies the short deferred read snapshot. */
export function dispatchHistoryQuery<Q extends HistoryQuery>(store: StoreReadQueries, query: Q): HistoryResult<Q>;
export function dispatchHistoryQuery(store: StoreReadQueries, query: HistoryQuery): HistoryResult<HistoryQuery> {
  if (!store.getRun(query.run_id)) throw new RuntimeFault("not_found", "Run not found");
  switch (query.kind) {
    case "projection_status": {
      const published = store.historyProjectionGeneration(query.run_id);
      if (!published && (store.historyProjectionCheckpoint(query.run_id)?.generation ?? 0) > 0)
        throw new RuntimeFault("conflict", "Published history projection generation is missing");
      const source_available = published?.source_available ?? store.historySourceHighwater(query.run_id);
      return bounded({ published: published ? { generation: published.generation, source_through: published.source_through,
        source_available, has_pending: published.has_pending } : null, source_available });
    }
    case "model_inspect": return bounded(modelInspect(store, query));
    case "review_context":
      return refit(query.limit, cap => {
        const page = readImprovementFeedback(store, query.run_id, query.after, cap);
        requireFeedbackProgress(page, query.after);
        return new ProgramWorkspace(store, query.run_id).feedbackView(page);
      }) as unknown as Json;
    case "operator_evidence": return bounded(evidencePage(store, query.run_id, query.after, query.limit));
    case "operator_feedback":
      return refit(query.limit, cap => {
        const page = readImprovementFeedback(store, query.run_id, query.after, cap);
        requireFeedbackProgress(page, query.after);
        return page;
      });
    case "operator_trace": return tracePage(store, query.run_id, query.after, query.limit, query.execution_id);
    case "operator_deaths":
      return refit(query.limit, cap => {
        const page = store.deathEpisodesPage(query.run_id, query.after, cap);
        requireProgress(page.has_more, query.after, page.next_after);
        return page;
      });
    case "operator_comparison":
      return refit(query.limit, cap => {
        const page = compareProgramVersionsPage(store, query.before, query.after, { kind: "operator" }, query.after_sample, cap);
        requireProgress(page.has_more, query.after_sample?.offset ?? 0, page.next_after.offset);
        return page;
      });
    case "benchmark_history": {
      let count = 0, cursor = 0;
      for (let page = 0; page < 10; page++) {
        const rows = store.eventsAfter(query.run_id, cursor, 500);
        count += rows.length;
        if (rows.length < 500) break;
        cursor = rows.at(-1)!.event_seq;
        if (page === 9) throw new RuntimeFault("budget_exceeded", "Real inactive Store history exceeded finite load page capacity");
      }
      if (count < query.minimum_records)
        throw new RuntimeFault("conflict", "History load read fewer than the required original evaluator records");
      // This compound workload is deliberately indivisible: never shrink the frozen diagnostic.
      return bounded({ events: count, program_evidence: programEvidence(store, query.run_id), programs: store.skills(query.run_id) });
    }
    case "projection_batch": return bounded(prepareHistoryProjectionBatch(store, query.run_id, query.checkpoint, query.work_limit));
    case "evaluation_prefix": {
      const prefix: ActivityEvent[] = [];
      let admissions = 0, cursor = 0, eventsOmitted = false;
      while (true) {
        const events = store.eventsAfter(query.run_id, cursor, 500);
        for (const event of events) {
          // Historical observer admission counts cover the run, even beyond its retained prefix.
          if (event.type === "model.call") admissions++;
          if (prefix.length < query.event_limit) prefix.push(event);
          else eventsOmitted = true;
        }
        if (events.length < 500) break;
        cursor = events.at(-1)!.event_seq;
      }
      return bounded(reduceEvaluationPrefix(prefix, admissions, eventsOmitted));
    }
    case "export_page": {
      if ((query.generation !== undefined || query.execution_id !== undefined) &&
        query.collection !== "objective_metrics" && query.collection !== "program_evidence")
        throw new RuntimeFault("invalid_request", "Pinned projection selectors apply only to execution evidence exports");
      switch (query.collection) {
        case "sources":
        case "policies":
        case "executions":
        case "events":
        case "traces": {
          const values = store.collectionRowsPage(query.run_id, query.collection, query.after.record_index, query.limit);
          return archivePage(query, values);
        }
        case "program_evidence": {
          if (query.execution_id === undefined || query.generation === undefined)
            throw new RuntimeFault("invalid_request", "Whole program evidence requires an exact execution and generation");
          const published = store.historyProjectionGeneration(query.run_id, query.generation);
          if (!published) throw new RuntimeFault("conflict", "Requested complete evidence generation is not retained");
          if (!store.historyProjectionRow(query.run_id, published.revision, "execution", query.execution_id))
            throw new RuntimeFault("not_found", "Execution is not present in the pinned projection");
          const record = query.after.record_index === 0
            ? readProjectedProgramEvidence(store, query.run_id, query.execution_id, published.generation) : null;
          if (query.after.record_index === 0 && !record)
            throw new RuntimeFault("conflict", "Pinned execution evidence is missing");
          const projection: ProjectionProgress = { generation: published.generation, source_through: published.source_through,
            source_available: published.source_available, has_pending: published.has_pending };
          return archivePage(query, { total: 1, records: record ? [record] : [] }, projection);
        }
        case "objective_metrics": {
          const published = store.historyProjectionGeneration(query.run_id, query.generation);
          if (!published) throw new RuntimeFault("conflict", "History projection is pending its first complete publication");
          const projection: ProjectionProgress = { generation: published.generation, source_through: published.source_through,
            source_available: published.source_available, has_pending: published.has_pending };
          if (query.execution_id !== undefined) {
            if (query.after.record_index > 1) throw new RuntimeFault("invalid_request", "Archive cursor is outside the selected metric");
            const metric = query.after.record_index === 0 ? readProjectedObjectiveMetric(store, query.run_id, query.execution_id, published.generation) : null;
            if (query.after.record_index === 0 && !metric) throw new RuntimeFault("not_found", "Execution metric is not present in the pinned projection");
            return archivePage(query, { total: 1, records: metric ? [metric] : [] }, projection);
          }
          const values = readProjectedObjectiveMetricsPage(store, query.run_id, {
            generation: published.generation, offset: query.after.record_index, limit: query.limit,
          });
          return archivePage(query, { total: values.total, records: values.metrics }, projection);
        }
        default: {
          const values = query.collection === "run" ? [store.getRun(query.run_id)!] :
            [store.tracePage(query.run_id, 0, 1).budget];
          return archivePage(query, { total: values.length,
            records: values.slice(query.after.record_index, query.after.record_index + query.limit) });
        }
      }
    }
  }
}
