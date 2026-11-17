import { z } from "zod";
import type { ActionView, GoalChoice, Json } from "../shared/contracts.ts";
import type { PlanProjection } from "../shared/planning.ts";
import type { ToolModule } from "../shared/tool-policy.ts";
import type { StoredRun } from "./store.ts";
import type { StrategicContextAdapter } from "./strategic-context.ts";
import type { StoreReadLocation } from "./store-read.ts";
import type { CognitionSessionGrant } from "./cognition-inference.ts";
import { COGNITION_LIMITS } from "./cognition-wire.ts";
import { cognitionJsonSchema } from "./cognition-json.ts";
import type { StrategicPolicy } from "./cognition-ports.ts";
import type { PassiveContextState } from "./cognition-context-custody.ts";
import type { MainDecisionWindowOptions } from "./main-decision-window.ts";
import { mainDecisionWindowBudgetSchema } from "./main-decision-window.ts";
import { playingAuthorityEnvelopeSchema, type EffectivePlayingCeilings } from "./playing-authority.ts";

const identity = z.string().min(1).max(512);
const purpose = z.enum(["authoring", "planning", "replanning", "improvement", "other"]);
const role = z.enum(["ordinary", "authoring", "speculative", "review"]);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reportedCounter = counter.nullable();
/** Host-owned bounded authority disclosure, not observations or inclusive usage. */
export const cognitionAuthorityContextSchema = z.object({
  playing_authority: playingAuthorityEnvelopeSchema.optional(),
  main_decision_window: mainDecisionWindowBudgetSchema.optional(),
}).strict();
export type CognitionAuthorityContext = z.infer<typeof cognitionAuthorityContextSchema>;
export const cognitionRequestSchema = z.object({ turn_id: identity, request_id: identity, generation: counter,
  role, deadline_os_ns: z.string().regex(/^\d{1,24}$/), phase: z.enum(["created", "running", "pausing", "paused", "stopping", "stopped", "reviewing", "completed", "failed"]),
  root_execution_id: identity.nullable(), source_hash: identity.nullable(), authoring_deadline_at: z.number().finite().nullable(),
  pending_decision: z.boolean(), plan_id: identity.nullable(),
}).strict();
export const cognitionResponseSchema = z.object({ request_id: identity, successful: z.boolean(),
  calls: z.array(z.object({ id: identity, name: identity, arguments: cognitionJsonSchema }).strict()).max(48),
}).strict();
/** Private fetch admission only: transport data cannot enter this envelope. */
export const cognitionSdkFetchSchema = z.object({ id: identity, identity: cognitionRequestSchema,
  model: z.object({ id: identity, provider: identity, api: identity }).strict(),
}).strict();
export const cognitionMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), run_id: identity.nullable(), type: z.string().min(1).max(128), summary: z.string().max(8192), details: z.json() }).strict(),
  z.object({ kind: z.literal("progress"), model_status: z.enum(["idle", "thinking", "waiting", "error"]), summary: z.string().max(8192).optional() }).strict(),
  z.object({ kind: z.literal("call"), request_id: identity, purpose }).strict(),
  z.object({ kind: z.literal("request_reserve"), request_id: identity,
    model: z.object({ id: identity, provider: identity, api: identity }).strict() }).strict(),
  z.object({ kind: z.literal("classify"), request_id: identity, previous: purpose, purpose }).strict(),
  z.object({ kind: z.literal("usage"), request_id: identity, purpose, usage: z.object({ input: reportedCounter, cacheRead: reportedCounter, cacheWrite: reportedCounter, output: reportedCounter }).strict() }).strict(),
  z.object({ kind: z.literal("response"), response: cognitionResponseSchema }).strict(),
  z.object({ kind: z.literal("sdk_evidence"),
    evidence_kind: z.enum(["sdk_context_before_request_assembly_not_wire_payload", "visible_agent_event"]),
    body: cognitionJsonSchema }).strict(),
  z.object({ kind: z.literal("speculation_finish"), id: identity }).strict(),
  z.object({ kind: z.literal("speculation_invalidate"), reason: z.enum(["session_changed", "life_changed", "space_changed", "profile_changed", "screen_changed", "task_changed", "predecessor_changed", "predecessor_unsuccessful", "predecessor_pending", "predecessor_already_settled", "source_changed", "guard_failed", "guard_error", "budget_exhausted", "deadline", "cancelled", "already_activated", "not_staged", "admission_failed"]) }).strict(),
  z.object({ kind: z.literal("transport_ended"), request_id: identity, closed: z.boolean() }).strict(),
  z.object({ kind: z.literal("requests_drained"), request_ids: z.array(identity).max(256) }).strict(),
]);
export const cognitionMetadataBatchSchema = z.object({ sequence: counter.min(1), operations: z.array(cognitionMetadataSchema).max(COGNITION_LIMITS.metadata) }).strict();
export type CognitionMetadata = z.infer<typeof cognitionMetadataSchema>;
export interface CognitionSnapshot {
  run: StoredRun;
  generation: number;
  adapter: StrategicContextAdapter;
  policies: StrategicPolicy[];
  action: ActionView | null;
  programPending: boolean;
  busy: boolean;
  planning: PlanProjection | null;
  planning_remaining_ms: number;
  modules: ToolModule[];
}
export interface CognitionStart {
  location: StoreReadLocation;
  retained_context: PassiveContextState;
  snapshot: CognitionSnapshot;
  goal: GoalChoice;
  grant: CognitionSessionGrant;
  timing: { clock_id: string; os_origin_ns: string; host_origin_ms: number };
  observeSdk: boolean;
  observeDispatch: boolean;
  admitSdkFetch: boolean;
  mainDecisionWindow?: MainDecisionWindowOptions;
  playingAuthorityCeilings?: EffectivePlayingCeilings;
}
export interface CognitionToolCall { request_id: string; call_id: string; name: string; arguments: Json }
export const cognitionToolCallSchema = z.object({ request_id: identity, call_id: identity, name: identity, arguments: cognitionJsonSchema }).strict();
