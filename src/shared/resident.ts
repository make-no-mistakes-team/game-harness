import { z } from "zod";
import type { Json, Sha256 } from "./contracts.ts";
import { identitySchema, safeCounterSchema, sha256Schema } from "./control.ts";
import { authoredControllerInputSchema, controllerInputSchema, inputAppliedAckSchema, nativeNanosecondsSchema, RevocationAck, type ControllerEffectUpdate, type ControllerInput,
  type ControllerInputChannel, type InputAppliedAck } from "./controller.ts";
import { jsonSchema } from "./primitives.ts";
import type { MinecraftControllerFrame } from "./minecraft.ts";
import { executiveChoiceSchema, executiveSnapshotSchema, type ExecutiveSnapshot } from "./control-session.ts";
import type { ExecutableModuleBundle } from "./programs.ts";

export const RESIDENT_PROTOCOL_VERSION = 1;
export const RESIDENT_INPUT_BYTES = 262144;
export const RESIDENT_OUTPUT_BYTES = 65536;
export const RESIDENT_STATE_BYTES = 16384;
export const RESIDENT_INTENT_BYTES = 16384;
export const RESIDENT_JSON_DEPTH = 32;
/** Host IPC/scheduling ceiling, not the isolated step computation allowance. */
export const RESIDENT_STEP_RESPONSE_MS = 500;

function jsonStringBytes(value: string, maximum: number): number {
  if (value.length + 2 > maximum) return maximum + 1;
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
    else if (unit < 32) bytes += 6;
    else if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += unit >= 0xd800 && unit <= 0xdfff ? 6 : 3;
    if (bytes > maximum) return bytes;
  }
  return bytes;
}

export type ResidentJsonConstraint =
  | Readonly<{ constraint: "utf8_bytes" | "depth"; maximum: number }>
  | Readonly<{ constraint: "plain_data" }>;
const trustedJsonConstraints = new WeakSet<object>();
/** Only metadata allocated by this boundary is trusted; matching actor params are not. */
export function residentJsonConstraint(issue: unknown): ResidentJsonConstraint | undefined {
  if (!issue || typeof issue !== "object") return undefined;
  const params = Object.getOwnPropertyDescriptor(issue, "params")?.value;
  return params && typeof params === "object" && trustedJsonConstraints.has(params) ? params : undefined;
}

/** Validate plain data before recursive Zod parsing or JSON serialization can invoke a getter. */
function boundedJsonIssue(value: unknown, maximum: number): ResidentJsonConstraint["constraint"] | null {
  const active = new Set<object>();
  const pending: ({ kind: "value"; value: unknown; depth: number } | { kind: "exit"; value: object })[] = [{ kind: "value", value, depth: 0 }];
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.kind === "exit") { active.delete(item.value); continue; }
    const current = item.value;
    if (current === null) bytes += 4;
    else if (typeof current === "boolean") bytes += current ? 4 : 5;
    else if (typeof current === "string") bytes += jsonStringBytes(current, maximum - bytes);
    else if (typeof current === "number" && Number.isFinite(current)) bytes += JSON.stringify(current).length;
    else if (typeof current === "object") {
      if (item.depth + 1 > RESIDENT_JSON_DEPTH) return "depth";
      if (active.has(current)) return "plain_data";
      const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
      if (!array && prototype !== Object.prototype && prototype !== null) return "plain_data";
      const descriptors = Object.getOwnPropertyDescriptors(current), keys = Reflect.ownKeys(descriptors);
      const length = array ? descriptors.length?.value : keys.length;
      if (!Number.isSafeInteger(length) || length < 0) return "plain_data";
      if (length > maximum) return "utf8_bytes";
      if (array && keys.length !== length + 1) return "plain_data";
      bytes += 2 + Math.max(0, length - 1);
      active.add(current); pending.push({ kind: "exit", value: current });
      for (const key of keys) {
        if (typeof key !== "string") return "plain_data";
        const descriptor = descriptors[key]!;
        if (array && key === "length") continue;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return "plain_data";
        if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) return "plain_data";
        if (!array) bytes += jsonStringBytes(key, maximum - bytes) + 1;
        if (bytes > maximum) return "utf8_bytes";
        pending.push({ kind: "value", value: descriptor.value, depth: item.depth + 1 });
      }
    } else return "plain_data";
    if (bytes > maximum) return "utf8_bytes";
  }
  return null;
}
function jsonBoundary(maximum: number) {
  const constraints = {
    utf8_bytes: Object.freeze({ constraint: "utf8_bytes", maximum }),
    depth: Object.freeze({ constraint: "depth", maximum: RESIDENT_JSON_DEPTH }),
    plain_data: Object.freeze({ constraint: "plain_data" }),
  } satisfies Record<ResidentJsonConstraint["constraint"], ResidentJsonConstraint>;
  for (const metadata of Object.values(constraints)) trustedJsonConstraints.add(metadata);
  return z.unknown().superRefine((value, context) => {
    let issue: ResidentJsonConstraint["constraint"] | null;
    try { issue = boundedJsonIssue(value, maximum); }
    catch { issue = "plain_data"; }
    if (issue) context.addIssue({ code: "custom", params: constraints[issue],
      message: issue === "utf8_bytes" ? "Resident JSON exceeds its UTF8 byte bound"
        : issue === "depth" ? "Resident JSON exceeds its nesting bound" : "Resident JSON requires finite plain JSON data" });
  });
}
export const residentStateSchema = jsonBoundary(RESIDENT_STATE_BYTES).pipe(jsonSchema);
export const residentIntentSchema = jsonBoundary(RESIDENT_INTENT_BYTES).pipe(jsonSchema);
export const residentAnalysisInputSchema = jsonBoundary(RESIDENT_INPUT_BYTES).pipe(jsonSchema);
export const residentAnalysisOutputSchema = jsonBoundary(RESIDENT_OUTPUT_BYTES).pipe(jsonSchema);
export const controllerEventSchema = z.object({ kind: z.enum(["diagnostic", "attention"]),
  urgency: z.enum(["ordinary", "urgent"]), summary: z.string().min(1).max(1000), details: jsonSchema }).strict();
export type ControllerEvent = z.infer<typeof controllerEventSchema>;
export type ControllerStatus = "running" | "blocked" | "yielded" | "completed";
// Omission belongs only to the actor result, never to the native channel.
// Explicit edges must still pass every native refinement without modification.
export const controllerStepResultSchema = jsonBoundary(RESIDENT_OUTPUT_BYTES).pipe(z.object({
  input: authoredControllerInputSchema, next_state: residentStateSchema,
  status: z.enum(["running", "blocked", "yielded", "completed"]), events: z.array(controllerEventSchema).max(16),
}).strict());
export type ControllerStepResult = z.infer<typeof controllerStepResultSchema>;
export const executiveStepResultSchema = jsonBoundary(RESIDENT_OUTPUT_BYTES).pipe(z.object({
  choice: executiveChoiceSchema, next_state: residentStateSchema,
  status: z.enum(["running", "blocked", "yielded", "completed"]), events: z.array(controllerEventSchema).max(16),
}).strict());
export type ExecutiveStepResult = z.infer<typeof executiveStepResultSchema>;
export const residentDecisionSchema = z.union([controllerStepResultSchema, executiveStepResultSchema]);
export type ResidentDecision = ControllerStepResult | ExecutiveStepResult;
export const residentActivationResultSchema = jsonBoundary(RESIDENT_OUTPUT_BYTES).pipe(z.union([residentDecisionSchema,
  z.object({ refused: z.literal(true), reason: z.string().min(1).max(1000) }).strict()]));
export type ResidentActivationResult = z.infer<typeof residentActivationResultSchema>;

export const residentLimitsSchema = z.object({
  duration_ms: z.number().int().min(1000).max(57600000), frequency_hz: z.union([z.literal(1), z.literal(5), z.literal(20)]),
  step_ms: z.number().int().min(1).max(500), max_steps: safeCounterSchema.min(1).max(1152000),
  max_frames: safeCounterSchema.min(1).max(1152000), max_edges: safeCounterSchema.max(14745600),
  max_edges_per_second: safeCounterSchema.min(1).max(256), max_events: safeCounterSchema.max(4096),
  max_analysis_jobs: safeCounterSchema.max(65536), analysis_job_ms: safeCounterSchema.min(1).max(5000),
  max_analysis_ms: safeCounterSchema.max(57600000),
}).strict();
export type ResidentLimits = z.infer<typeof residentLimitsSchema>;
export const DEFAULT_RESIDENT_LIMITS: Readonly<ResidentLimits> = Object.freeze({ duration_ms: 180000, frequency_hz: 20,
  step_ms: 25, max_steps: 3600, max_frames: 3600, max_edges: 46080, max_edges_per_second: 256,
  max_events: 256, max_analysis_jobs: 32, analysis_job_ms: 500, max_analysis_ms: 10000 });
export const residentActorLimitsSchema = residentLimitsSchema.extend({
  duration_ms: residentLimitsSchema.shape.duration_ms.default(DEFAULT_RESIDENT_LIMITS.duration_ms),
  frequency_hz: residentLimitsSchema.shape.frequency_hz.default(DEFAULT_RESIDENT_LIMITS.frequency_hz),
  step_ms: residentLimitsSchema.shape.step_ms.default(DEFAULT_RESIDENT_LIMITS.step_ms),
  max_steps: residentLimitsSchema.shape.max_steps.default(DEFAULT_RESIDENT_LIMITS.max_steps),
  max_frames: residentLimitsSchema.shape.max_frames.default(DEFAULT_RESIDENT_LIMITS.max_frames),
  max_edges: residentLimitsSchema.shape.max_edges.default(DEFAULT_RESIDENT_LIMITS.max_edges),
  max_edges_per_second: residentLimitsSchema.shape.max_edges_per_second.default(DEFAULT_RESIDENT_LIMITS.max_edges_per_second),
  max_events: residentLimitsSchema.shape.max_events.default(DEFAULT_RESIDENT_LIMITS.max_events),
  max_analysis_jobs: residentLimitsSchema.shape.max_analysis_jobs.default(DEFAULT_RESIDENT_LIMITS.max_analysis_jobs),
  analysis_job_ms: residentLimitsSchema.shape.analysis_job_ms.default(DEFAULT_RESIDENT_LIMITS.analysis_job_ms),
  max_analysis_ms: residentLimitsSchema.shape.max_analysis_ms.default(DEFAULT_RESIDENT_LIMITS.max_analysis_ms),
}).prefault({});

export interface ResidentWorker {
  step(frame: MinecraftControllerFrame, state: Json, intent: Json, signal?: AbortSignal): Promise<ResidentDecision>;
  /** First live call in the clean prepared invocation; never a replay of shadow output. */
  activate?(frame: MinecraftControllerFrame, state: Json, intent: Json, signal?: AbortSignal): Promise<ResidentActivationResult>;
  close(): Promise<void>;
}
export interface ResidentAnalysisWorker {
  /** Trusted host instrumentation, never supplied to the selected module. Before cleanup, once per dispatched evaluation. */
  analyze(input: Json, signal?: AbortSignal, onEvaluation?: (elapsedMs: number) => void): Promise<Json>;
  close(): Promise<void>;
}
/** Trusted worker-service signal, never selected from generated error text. */
export class ResidentCleanupError extends Error {
  constructor(readonly retirement: RevocationAck | null = null) {
    super("Resident computation or native retirement cleanup could not be confirmed.");
  }
}
export interface ResidentTimingSummary { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null; omitted_samples: number }
export interface ResidentSnapshot {
  execution_id: string; source_hash: Sha256; controller_generation: number; host_clock_id: string;
  status: "starting" | "running" | "blocked" | "yielded" | "completed" | "failed" | "stopping" | "stopped" | "unknown";
  reason: string | null; intent_version: number; state: Json;
  processed_frame_seq: number | null; processed_native_tick: number | null; processed_native_ns: string | null;
  counters: { frames: number; steps: number; submissions: number; applied_sequence: number; ordered_edge_prefix: number;
    missed_slots: number; stale_results: number; stale_frames: number; read_failures: number; no_input_decisions: number;
    expanded_edges: number; events: number; analysis_jobs: number; analysis_ms: number };
  pending: { frames: number; edges: number; analysis: boolean }; last_input: InputAppliedAck | null;
  timings: { step_ms: ResidentTimingSummary; input_age_ms: ResidentTimingSummary };
  events: { sequence: number; host_monotonic_ms: number; event: ControllerEvent }[];
  session?: ExecutiveSnapshot;
  cleanup: { worker: "open" | "closing" | "closed" | "unknown"; native: "open" | "revoking" | "retired" | "unknown" };
}
const residentTimingSchema = z.object({ count: safeCounterSchema, p50: z.number().finite().nonnegative().nullable(),
  p95: z.number().finite().nonnegative().nullable(), p99: z.number().finite().nonnegative().nullable(),
  max: z.number().finite().nonnegative().nullable(), omitted_samples: safeCounterSchema }).strict();
export const residentSnapshotSchema = z.object({
  execution_id: identitySchema, source_hash: sha256Schema, controller_generation: safeCounterSchema.min(1), host_clock_id: identitySchema,
  status: z.enum(["starting", "running", "blocked", "yielded", "completed", "failed", "stopping", "stopped", "unknown"]),
  reason: z.string().nullable(), intent_version: safeCounterSchema, state: residentStateSchema,
  processed_frame_seq: safeCounterSchema.nullable(), processed_native_tick: safeCounterSchema.nullable(), processed_native_ns: nativeNanosecondsSchema.nullable(),
  counters: z.object({ frames: safeCounterSchema, steps: safeCounterSchema, submissions: safeCounterSchema, applied_sequence: safeCounterSchema,
    ordered_edge_prefix: safeCounterSchema, missed_slots: safeCounterSchema, stale_results: safeCounterSchema, stale_frames: safeCounterSchema,
    read_failures: safeCounterSchema, no_input_decisions: safeCounterSchema, expanded_edges: safeCounterSchema, events: safeCounterSchema,
    analysis_jobs: safeCounterSchema, analysis_ms: z.number().finite().nonnegative() }).strict(),
  pending: z.object({ frames: safeCounterSchema, edges: safeCounterSchema, analysis: z.boolean() }).strict(),
  last_input: inputAppliedAckSchema.nullable(), timings: z.object({ step_ms: residentTimingSchema, input_age_ms: residentTimingSchema }).strict(),
  events: z.array(z.object({ sequence: safeCounterSchema.min(1), host_monotonic_ms: z.number().finite(), event: controllerEventSchema }).strict()).max(128),
  session: executiveSnapshotSchema.optional(),
  cleanup: z.object({ worker: z.enum(["open", "closing", "closed", "unknown"]), native: z.enum(["open", "revoking", "retired", "unknown"]) }).strict(),
}).strict() satisfies z.ZodType<ResidentSnapshot>;
export interface ResidentAnalysisSource { skill_id: string; version: number; hash: Sha256; bundle: ExecutableModuleBundle }
export interface ResidentAnalysisResult {
  job_id: string; source: { skill_id: string; version: number; hash: Sha256 };
  controller_execution_id: string; controller_source_hash: Sha256; controller_generation: number;
  input_hash: Sha256; input_version: number; status: "completed" | "stale" | "failed" | "cancelled";
  output: Json; elapsed_ms: number;
  /** Same-host observation from evaluation notification until service settlement, including delivery/cleanup/host delay; not CPU. */
  post_evaluation_ms: number | null; reason: string | null;
}
export interface ResidentClock { id: string; now(): number; setTimeout(callback: () => void, delay: number): unknown; clearTimeout(handle: unknown): void }
export interface ResidentLifecycle { fence(reason: string): void; drain(): Promise<void> }
/** Trusted host diagnostics only; never a resident observation, input capability, or native ACK. */
export type ResidentTraceStage =
  | { stage: "anchor"; anchor_host_ms: number; period_ms: number }
  | { stage: "schedule"; slot: number; intended_host_ms: number; missed_slots: number }
  | { stage: "wake"; slot: number; scheduled_slot: number; intended_host_ms: number; missed_slots: number }
  | { stage: "sample_request"; slot: number }
  | { stage: "sample_receipt"; slot: number; outcome: "received" | "error" }
  | { stage: "worker_start"; slot: number; frame_seq: number }
  | { stage: "worker_return"; slot: number; frame_seq: number; outcome: "returned" | "error" }
  | { stage: "result_validation"; slot: number; frame_seq: number; outcome: "accepted" | "discarded" | "error" }
  | { stage: "renewal_start"; slot: number; frame_seq: number }
  | { stage: "renewal_end"; slot: number; frame_seq: number; outcome: "returned" | "error" }
  | { stage: "submission_dispatch"; slot: number; frame_seq: number; sequence: number | null;
      outcome: "submitted" | "coalesced" | "rejected" | "error" };
export type ResidentTraceEvent = ResidentTraceStage & {
  execution_id: string; source_hash: Sha256; controller_generation: number;
  host_clock_id: string; host_monotonic_ms: number;
  native_boot_id: string; operation_id: string; owner_generation: number;
  /** Attempts, including callbacks which threw. Gaps and nonzero errors invalidate completeness. */
  trace_sequence: number; observer_errors: number;
};
export interface ResidentControllerOptions {
  execution_id: string; source_hash: Sha256; controller_generation: number; limits: ResidentLimits; deadline_host_ms: number;
  initial_state: Json; intent: Json; worker: ResidentWorker;
  first_activation?: boolean;
  open(deadlineHostMs: number, applied: (ack: InputAppliedAck) => void, effect: (event: ControllerEffectUpdate) => void,
    lifecycle: ResidentLifecycle, controllerGeneration?: number): Promise<ControllerInputChannel>;
  current(): boolean; event(event: ControllerEvent): void; effect(input: ControllerInput, event: ControllerEffectUpdate): void;
  changed(snapshot: ResidentSnapshot, terminal: boolean): void;
  analysis(source: ResidentAnalysisSource, input: Json, budgetMs: number, signal: AbortSignal,
    onEvaluation: (elapsedMs: number) => void): Promise<Json>;
  clock?: ResidentClock;
  /**
   * Optional synchronous, nonblocking trusted observer. Caller owns bounded collection and must
   * retain overflow/loss as incomplete evidence. Exceptions are swallowed, counted, and exposed
   * on the next delivery; a missing terminal endpoint is unknown, never proof of completeness.
   * No native acceptance/application can be inferred from a returned host stage.
   */
  trace?(event: ResidentTraceEvent): void;
}
export const residentSourceIdentitySchema = z.object({ skill_id: identitySchema, version: safeCounterSchema.min(1), hash: sha256Schema }).strict();
