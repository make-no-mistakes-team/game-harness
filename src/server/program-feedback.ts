import { createHash } from "node:crypto";
import type { ActivityEvent, Json } from "../shared/contracts.ts";
import type { ImprovementFeedbackCursor, ImprovementOpportunity, ObjectiveMetricUpdate, ProgramVersionEvidence } from "../shared/execution-evidence.ts";
import { IMPROVEMENT_RESOLUTION_HELP } from "../shared/execution-evidence.ts";
import { evidenceObject } from "./objective-metrics.ts";
import { readProjectedObjectiveMetric } from "./history-objective.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { StoreReadQueries } from "./store-read.ts";

export type ImprovementFeedbackReadStore = StoreReadQueries;
export type ImprovementCandidateReadStore = Pick<StoreReadQueries, "skillExecution" | "skill">;
export interface ProjectionProgress {
  generation: number;
  source_through: number;
  source_available: number;
  has_pending: boolean;
}
export interface FeedbackOmission {
  kind: string;
  id: string;
  reason: string;
  original_bytes: number;
  reference: Json;
}
export interface ImprovementFeedbackPage {
  opportunities: ImprovementOpportunity[];
  metrics: ObjectiveMetricUpdate[];
  next_after: ImprovementFeedbackCursor;
  has_more: boolean;
  projection: ProjectionProgress;
  omitted: FeedbackOmission[];
  opportunity_budget: { max_records: number; reached: boolean; omission: string };
  decision_contract: typeof IMPROVEMENT_RESOLUTION_HELP;
  review: { effect_free: true; max_decisions: number };
}

export function exactVersion(store: Pick<StoreReadQueries, "skill">, ref: ProgramVersionEvidence) {
  const skill = store.skill(ref.run_id, ref);
  if (skill.hash !== ref.hash) throw new Error("Version reference does not match immutable source hash");
  return skill;
}

function fits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value }) + "\n") <= 65536;
}

/** Independent published update streams; selectors are applied by the indexed readers. */
export function readImprovementFeedback(
  store: ImprovementFeedbackReadStore,
  runId: string,
  after: ImprovementFeedbackCursor = { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null },
  limit = 32,
  selection: { skill_id?: string; version?: number } = {},
): ImprovementFeedbackPage {
  if (after.schema_version !== 2 || !Number.isSafeInteger(after.opportunity_change_seq) || after.opportunity_change_seq < 0 ||
    !Number.isSafeInteger(after.metric_change_seq) || after.metric_change_seq < 0 ||
    !Number.isSafeInteger(limit) || limit < 1 ||
    after.scope_hash !== null && !/^[a-f0-9]{64}$/.test(after.scope_hash) ||
    after.scope_hash === null && (after.opportunity_change_seq !== 0 || after.metric_change_seq !== 0))
    throw new RuntimeFault("invalid_request", "Invalid improvement feedback V2 cursor or limit");
  const scopeHash = createHash("sha256").update(JSON.stringify(["feedback-v2", runId, selection.skill_id ?? null, selection.version ?? null])).digest("hex");
  if (after.scope_hash !== null && after.scope_hash !== scopeHash)
    throw new RuntimeFault("conflict", "Feedback cursor belongs to a different run or program selection");
  const published = store.historyProjectionGeneration(runId);
  if (!published) throw new RuntimeFault("conflict", "History projection is pending its first complete publication");
  if (after.metric_change_seq > published.metric_change_seq || after.opportunity_change_seq > published.opportunity_change_seq)
    throw new RuntimeFault("conflict", "Feedback cursor is beyond the published update frontier");
  const cap = Math.min(limit, 100);
  const opportunities = store.opportunityUpdates(runId, after.opportunity_change_seq, cap, selection.skill_id, selection.version);
  const updates = store.historyProjectionRows(runId, published.revision, {
    collection: "metric_update", after_order: after.metric_change_seq,
    ...(selection.skill_id ? { source_id: selection.skill_id } : {}),
    ...(selection.skill_id && selection.version !== undefined ? { tag: JSON.stringify([selection.skill_id, selection.version]) } : {}),
    limit: cap + 1,
  });
  const page: ImprovementFeedbackPage = {
    opportunities: [], metrics: [], next_after: { ...after, scope_hash: scopeHash }, has_more: false,
    projection: { generation: published.generation, source_through: published.source_through, source_available: published.source_available, has_pending: published.has_pending },
    omitted: [], opportunity_budget: { max_records: cap, reached: false, omission: "One shared per-page logical-record budget covers opportunities, metric replacements/retractions, and explicit record omissions. Independent cursors cover only published updates; pending source work is reported separately." },
    decision_contract: IMPROVEMENT_RESOLUTION_HELP, review: { effect_free: true, max_decisions: 4 },
  };
  for (const row of opportunities.records) {
    const next = { ...page.next_after, opportunity_change_seq: row.change_seq };
    const size = Buffer.byteLength(JSON.stringify(row.value));
    if (size > 48000) {
      const omission: FeedbackOmission = { kind: "opportunity", id: row.value.opportunity_id, reason: "record_byte_budget", original_bytes: size,
        reference: { run_id: runId, opportunity_id: row.value.opportunity_id, opportunity_change_seq: row.change_seq } };
      if (!fits({ ...page, omitted: [...page.omitted, omission], next_after: next, has_more: true })) break;
      page.omitted.push(omission);
    } else {
      if (!fits({ ...page, opportunities: [...page.opportunities, row.value], next_after: next, has_more: true })) break;
      page.opportunities.push(row.value);
    }
    page.next_after = next;
  }
  const opportunityRemainder = opportunities.records.some(row => row.change_seq > page.next_after.opportunity_change_seq);
  if (!opportunityRemainder) page.next_after.opportunity_change_seq = opportunities.next_after;
  page.opportunity_budget.reached = opportunityRemainder || opportunities.has_more;
  const metricLimit = cap - page.opportunities.length - page.omitted.length;
  for (const row of updates.slice(0, metricLimit)) {
    const value = evidenceObject(row.value);
    const executionId = row.owner_id;
    const generation = value?.generation;
    const program = evidenceObject(value?.program);
    const ordinal = value?.execution_ordinal;
    if (!executionId || value?.execution_id !== executionId || typeof generation !== "number" ||
      !Number.isSafeInteger(generation) || generation < 1 ||
      (value.kind !== "replace" && value.kind !== "retract") ||
      !row.source_id || !program || typeof program.name !== "string" || !program.name ||
      typeof program.version !== "number" || !Number.isSafeInteger(program.version) || program.version < 1 ||
      typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
      row.tag !== JSON.stringify([row.source_id, program.version]) ||
      value.kind === "retract" && value.reason !== "execution_removed")
      throw new RuntimeFault("conflict", "Published metric update metadata is corrupt");
    const snapshot = store.historyProjectionGeneration(runId, generation);
    if (!snapshot || generation > published.generation) throw new RuntimeFault("conflict", "Published metric update generation is unavailable");
    const indexed = store.historyProjectionRow(runId, snapshot.revision, "execution", executionId);
    const identity = { execution_id: executionId, program: { name: program.name, version: program.version },
      execution_ordinal: ordinal, revision: snapshot.revision, generation };
    let update: ObjectiveMetricUpdate;
    if (value.kind === "retract") {
      if (indexed && indexed.source_id === row.source_id && indexed.tag === row.tag)
        throw new RuntimeFault("conflict", "Published metric retraction still has an objective execution in its scope");
      update = { ...identity, kind: "retract", reason: "execution_removed" };
    } else {
      const retained = evidenceObject(indexed?.value);
      if (!indexed || indexed.source_id !== row.source_id || indexed.tag !== row.tag ||
        indexed.order_seq !== ordinal || retained?.execution_ordinal !== ordinal || retained.program_name !== program.name)
        throw new RuntimeFault("conflict", "Published metric replacement execution identity is corrupt");
      const metric = readProjectedObjectiveMetric(store, runId, executionId, generation);
      if (!metric) throw new RuntimeFault("conflict", "Published metric replacement is missing its objective metric");
      update = { ...identity, kind: "replace", metric };
    }
    const next = { ...page.next_after, metric_change_seq: row.order_seq };
    const size = Buffer.byteLength(JSON.stringify(update));
    if (size > 48000) {
      const omission: FeedbackOmission = { kind: "metric", id: executionId, reason: "record_byte_budget", original_bytes: size,
        reference: { url: `/v1/runs/${encodeURIComponent(runId)}/objective-metrics/${encodeURIComponent(executionId)}?generation=${generation}&record_index=0&chunk_index=0&limit=25`,
          run_id: runId, execution_id: executionId, generation, revision: snapshot.revision,
          program: identity.program, execution_ordinal: ordinal } };
      if (!fits({ ...page, omitted: [...page.omitted, omission], next_after: next, has_more: true })) break;
      page.omitted.push(omission);
    } else {
      if (!fits({ ...page, metrics: [...page.metrics, update], next_after: next, has_more: true })) break;
      page.metrics.push(update);
    }
    page.next_after = next;
  }
  const metricRemainder = updates.some(row => row.order_seq > page.next_after.metric_change_seq);
  if (!metricRemainder) page.next_after.metric_change_seq = published.metric_change_seq;
  page.has_more = page.opportunity_budget.reached || metricRemainder;
  return page;
}

/** Interprets one outcome against current retained rows; only the writer may persist the candidate. */
export function improvementOpportunityCandidate(store: ImprovementCandidateReadStore, runId: string, event: ActivityEvent): ImprovementOpportunity | null {
  if (!["skill.closed", "skill.failed", "skill.blocked", "skill.unknown", "skill.succeeded", "learning.death_episode"].includes(event.type)) return null;
  const details = evidenceObject(event.details);
  const id = details?.execution_id ?? details?.root_execution_id;
  if (typeof id !== "string") return null;
  const execution = store.skillExecution(runId, { execution_id: id });
  if (!execution) return null;
  const kind = event.type === "learning.death_episode" ? "death" : execution.status === "succeeded" ? "outcome" : "failure";
  const key = createHash("sha256").update(`${runId}:${id}:${kind}:${kind === "death" ? details?.death_id : execution.status}`).digest("hex");
  const skill = store.skill(runId, execution);
  return { opportunity_id: key, run_id: runId, kind, version: { run_id: runId, skill_id: skill.skill_id, version: skill.version, hash: skill.hash }, execution_id: id, event_seqs: [event.event_seq], created_at: event.at, resolution: null };
}
