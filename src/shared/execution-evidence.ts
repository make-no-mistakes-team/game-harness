import type { Json, ObservationV3 } from "./contracts.ts";
import type { SkillRef, SkillView } from "./programs.ts";
import type { HistoricalObservationV2, MinecraftPlayer } from "./minecraft.ts";

export type TraceKind = "capability_request" | "capability_result" | "observation" | "branch" | "intent" | "span" | "omission";
export type PauseCategory = "native_action" | "dispatch" | "receipt" | "readiness" | "sandbox" | "capability_wait" | "strategic_request" | "scheduler_handoff" | "life_recovery" | "worker_start" | "worker_cleanup";
export interface TraceContext {
  call_id?: string | null;
  action_id?: string | null;
  observation_seq?: number | null;
  capability?: string | null;
  event_seq?: number | null;
}
export interface TraceInput extends TraceContext {
  run_id: string;
  execution_id: string | null;
  root_execution_id: string | null;
  parent_execution_id: string | null;
  skill_id: string | null;
  version: number | null;
  hash: string | null;
  session_id: string | null;
  life_id: number | null;
  kind: TraceKind;
  payload: Json;
}
export interface TraceRecord extends TraceInput {
  trace_seq: number;
  at: string;
  omission: { reason: "record_byte_budget"; original_bytes: number } | null;
}
export interface TracePage {
  records: TraceRecord[];
  next_after: number;
  has_more: boolean;
  budget: { max_records: number; max_bytes: number; recorded: number; bytes: number; omitted_records: number; omitted_bytes: number };
}
export interface DeathEpisode {
  death_id: string;
  session_id: string;
  life_id: number;
  last_observation: ObservationV3 | null;
  current_root_execution_id: string | null;
  action_id: string | null;
  event_seqs: number[];
}
export interface SavedDeathEpisode extends DeathEpisode {
  last_authorized_state: Json | null;
  state_omission: { reason: "snapshot_byte_budget"; original_bytes: number } | null;
  observation_omission: { reason: "snapshot_byte_budget"; original_bytes: number; observation_seq: number | undefined } | null;
  event_reference_omission: { reason: "event_reference_budget"; omitted: number } | null;
}
/** Original schema2 snapshots remain explicit read-only historical records. */
export type HistoricalSavedDeathEpisodeV2 = Omit<SavedDeathEpisode, "last_observation" | "last_authorized_state" | "state_omission"> & {
  last_observation: HistoricalObservationV2 | null;
  last_authorized_player: MinecraftPlayer | null;
};
export type ReadonlyDeathEpisode = SavedDeathEpisode | HistoricalSavedDeathEpisodeV2;
export interface ProgramVersionEvidence extends SkillRef {
  run_id: string;
  hash: string;
}
export interface ImprovementFeedbackCursor {
  opportunity_seq: number;
  execution_seq: number;
}
export const IMPROVEMENT_RESOLUTION_HELP =
  "Use program_review to record keep or insufficient_evidence for a named version's latest matching outcome. Link an actual direct-child code-change experiment through program_write with based_on and reason; the host captures exact source and evidence references. An internal revise assessment records that candidate experiment, not verified improvement, adoption or promotion. Candidates may be unmeasured and measured trials may remain inconclusive. Explain the evidence limits in reason.";
export interface ImprovementOpportunity {
  opportunity_id: string;
  run_id: string;
  kind: "death" | "failure" | "outcome";
  version: ProgramVersionEvidence;
  execution_id: string;
  event_seqs: number[];
  created_at: string;
  resolution: null | {
    /** Revise links a candidate experiment/code change, not proven efficacy or adoption. */
    decision: "revise" | "keep" | "insufficient_evidence";
    reason: string;
    /** Exact reference required for revise; null for keep or insufficient_evidence. */
    revision: ProgramVersionEvidence | null;
    event_seqs: number[];
    measured: boolean;
    at: string;
  };
}
export interface ObjectiveMetrics {
  execution_id: string;
  root_execution_id: string;
  outcome: string;
  confirmed_block_removals: number;
  removed_blocks: Record<string, number>;
  inventory_delta: Record<string, number>;
  inventory_receipts: number;
  target_switches: number;
  target_position_switches: number;
  sampled_travel_distance: number;
  sampled_rotation_degrees: number;
  receipted_travel_distance: number;
  receipted_rotation_degrees: number;
  motion_receipts: number;
  observation_samples: number;
  spans_ms: Partial<Record<PauseCategory, number>>;
  span_samples: Partial<Record<PauseCategory, number>>;
  evidence_event_seqs: number[];
  trace_complete: boolean;
  limitations: string[];
}
export interface WorkingProgram {
  session_id: string;
  model_id: string;
  source_run_id: string;
  root: SkillRef;
  hash: string;
  measured_execution_ids: string[];
  qualification: "working_candidate";
  skills: SkillView[];
}
export interface VersionComparison {
  before: ProgramVersionEvidence;
  after: ProgramVersionEvidence;
  source_diff: { common_prefix_lines: number; common_suffix_lines: number; removed: string[]; added: string[] };
  card_diff: Record<string, { before: string; after: string }>;
  samples: { before: ObjectiveMetrics[]; after: ObjectiveMetrics[] };
  sample_count: { before: number; after: number };
  controlled_conditions: Json | null;
  conclusion: "descriptive_only_no_causal_improvement_claim";
}
