import { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import type { SkillView } from "../shared/programs.ts";
import type { TracePage } from "../shared/execution-evidence.ts";
import { improvementFeedbackCursorSchema, versionComparisonCursorSchema } from "./program-interface.ts";
import type { DetailedProgramEvidence } from "./program-evidence.ts";
import type { ImprovementFeedbackPage, ProjectionProgress } from "./program-feedback.ts";
import type { VersionComparisonPage } from "./program-comparison.ts";
import type { StoreReadQueries } from "./store-read.ts";
import type { UsageMetrics } from "../evaluation/results.ts";
import type { HistoryProjectionBatch, ProjectionCheckpoint } from "./history-projection.ts";
import { PROJECTION_COLLECTIONS } from "./history-projection.ts";

const run = z.string().min(1).max(200);
const sequence = z.int().nonnegative();
const limit = z.int().min(1).max(100);
const selector = z.object({ name: z.string().min(1).max(80), version: z.int().positive().optional() }).strict();
const version = z.object({ run_id: run, skill_id: run, version: z.int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const json: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]));
export const projectionCheckpointSchema: z.ZodType<ProjectionCheckpoint> = z.object({
  schema_version: z.literal(1), revision: sequence, generation: sequence, published_revision: sequence,
  source_through: sequence, target_through: sequence,
  phase: z.enum(["bootstrap", "index", "expand", "detect", "objective", "evidence", "publish", "idle"]),
  job: z.record(z.string(), json).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 8192),
  metric_change_seq: sequence, published_metric_change_seq: sequence,
}).strict();
const collection = z.enum(PROJECTION_COLLECTIONS);
export const improvementOpportunitySchema = z.object({
  opportunity_id: z.string().min(1), run_id: run, kind: z.enum(["death", "failure", "outcome"]), version,
  execution_id: z.string().min(1), event_seqs: z.array(z.int().positive()), created_at: z.string().min(1),
  resolution: z.object({ decision: z.enum(["revise", "keep", "insufficient_evidence"]), reason: z.string(), revision: version.nullable(),
    event_seqs: z.array(z.int().positive()), measured: z.boolean(), at: z.string() }).strict().nullable(),
}).strict();
export const projectionBatchSchema: z.ZodType<HistoryProjectionBatch> = z.object({
  before: projectionCheckpointSchema, after: projectionCheckpointSchema,
  patches: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("put"), row: z.object({ collection, key: z.string().min(1), owner_id: z.string().nullable(), source_id: z.string().nullable(),
      order_seq: sequence, tag: z.string().nullable(), value: json }).strict() }).strict(),
    z.object({ type: z.literal("delete"), collection, key: z.string().min(1) }).strict(),
  ])).max(64),
  candidates: z.array(improvementOpportunitySchema.extend({ resolution: z.null(), event_seqs: z.array(z.int().positive()).length(1) })).max(16),
  opportunity_bootstrap: z.array(z.object({ seq: sequence, value: improvementOpportunitySchema }).strict()).max(128),
  has_more: z.boolean(),
}).strict();
const cursor = improvementFeedbackCursorSchema;
const comparisonCursor = versionComparisonCursorSchema.nullable();
const exportCursor = z.object({ record_index: sequence, chunk_index: sequence }).strict();
const modelInspect = z.discriminatedUnion("view", [
  z.object({ view: z.literal("history"), program: selector.optional(), after: sequence, limit }).strict(),
  z.object({ view: z.literal("metric"), program: selector.extend({ version: z.int().positive() }),
    execution_ordinal: z.int().positive(), generation: sequence, after: exportCursor, limit }).strict(),
  z.object({ view: z.literal("evidence"), program: selector.extend({ version: z.int().positive() }),
    execution_ordinal: z.int().positive(), generation: sequence, after: exportCursor, limit }).strict(),
  z.object({ view: z.literal("trace"), program: selector.optional(), target: z.enum(["current", "latest"]), after: sequence, limit }).strict(),
  z.object({ view: z.literal("feedback"), program: selector.optional(), after: cursor, limit }).strict(),
  z.object({ view: z.literal("events"), after: sequence, limit }).strict(),
  z.object({ view: z.literal("comparison"), before: selector, after: selector, after_sample: comparisonCursor, limit }).strict(),
]);
export const historyQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model_inspect"), run_id: run, input: modelInspect }).strict(),
  z.object({ kind: z.literal("review_context"), run_id: run, after: cursor, limit }).strict(),
  z.object({ kind: z.literal("operator_evidence"), run_id: run, after: sequence, limit }).strict(),
  z.object({ kind: z.literal("operator_feedback"), run_id: run, after: cursor, limit }).strict(),
  z.object({ kind: z.literal("operator_trace"), run_id: run, after: sequence, limit, execution_id: run.optional() }).strict(),
  z.object({ kind: z.literal("operator_deaths"), run_id: run, after: sequence, limit }).strict(),
  z.object({ kind: z.literal("operator_comparison"), run_id: run, before: version, after: version, after_sample: comparisonCursor, limit }).strict(),
  z.object({ kind: z.literal("benchmark_history"), run_id: run, minimum_records: z.int().min(1).max(5000) }).strict(),
  z.object({ kind: z.literal("projection_status"), run_id: run }).strict(),
  z.object({ kind: z.literal("projection_batch"), run_id: run, checkpoint: projectionCheckpointSchema, work_limit: z.int().min(1).max(128).optional() }).strict(),
  z.object({ kind: z.literal("export_page"), run_id: run, collection: z.enum(["run", "sources", "policies", "executions", "trace_budget", "objective_metrics", "program_evidence", "events", "traces"]), after: exportCursor, limit, generation: sequence.optional(), execution_id: run.optional() }).strict()
    .refine(query => query.collection !== "program_evidence" || query.generation !== undefined && query.execution_id !== undefined,
      "Whole program evidence requires an exact execution and generation"),
  z.object({ kind: z.literal("evaluation_prefix"), run_id: run, event_limit: z.int().positive() }).strict(),
]);
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export interface HistoryPage<T> {
  records: T[];
  next_after: number;
  has_more: boolean;
  total: number;
  omissions: { index: number; reason: string; original_bytes: number; reference?: Json }[];
}
export interface HistoryExportCursor { record_index: number; chunk_index: number }
export interface HistoryExportPage extends Omit<HistoryPage<Json>, "next_after"> {
  next_after: HistoryExportCursor;
  projection?: ProjectionProgress;
}
export interface HistoryQueryResults {
  model_inspect: Json;
  review_context: Json;
  operator_evidence: HistoryPage<DetailedProgramEvidence> & { projection: ProjectionProgress };
  operator_feedback: ImprovementFeedbackPage;
  operator_trace: TracePage;
  operator_deaths: ReturnType<StoreReadQueries["deathEpisodesPage"]>;
  operator_comparison: VersionComparisonPage;
  benchmark_history: { events: number; program_evidence: DetailedProgramEvidence[]; programs: SkillView[] };
  projection_status: { published: ProjectionProgress | null; source_available: number };
  projection_batch: HistoryProjectionBatch;
  export_page: HistoryExportPage;
  evaluation_prefix: EvaluationPrefixSummary;
}
export interface EvaluationPrefixSummary {
  admissions: number;
  usage: UsageMetrics;
  tools: { name: string; count: number }[];
  confirmed_harness_faults: string[];
  provider_error: boolean;
  provider_settled: boolean;
  event_counts: { type: string; count: number; failed_verifications: number }[];
  events_omitted: boolean;
}
export type HistoryResult<Q extends HistoryQuery> = HistoryQueryResults[Q["kind"]];
export interface HistoryQueryOptions { signal?: AbortSignal; deadlineHostMs: number }
export interface HistoryQueryClient {
  query<Q extends HistoryQuery>(query: Q, options: HistoryQueryOptions): Promise<HistoryResult<Q>>;
  cancelRun(runId: string): Promise<void>;
  close(): Promise<void>;
}
// Every wire frame is one UTF-8 JSON line, including its newline in the byte budget.
export type HistoryRequestFrame = { id: number; query: HistoryQuery };
export type HistoryResponseFrame = { id: number; ok: true; value: Json } | { id: number; ok: false; error: { code: string; message: string } };
