import type { Json, PlayerLife } from "./contracts.ts";
import type { SkillExecutionView, SkillLimits, SkillRef } from "./programs.ts";

export interface PlanningSource extends SkillRef { hash: string }
export interface PlanningScope {
  run_id: string;
  generation: number;
  session_id: string;
  world_id: string;
  epoch: number;
  life_id: number;
  life_status: PlayerLife["status"];
  task: string;
  goal: string;
}
export interface PlanningContext extends PlanningScope {
  root: PlanningSource & {
    execution_id: string;
    /** Execution lifecycle: success is "succeeded", never SkillResult's "completed"; not goal proof. */
    status: SkillExecutionView["status"];
  };
}
export interface LookaheadConfig {
  after_ms: number;
  reason: string;
  budget: {
    calls: number;
    tools: number;
    /** One total lifetime after after_ms, including predecessor wait and fresh activation. */
    duration_ms: number;
  };
}
export interface LookaheadRequest extends LookaheadConfig {
  root_execution_id: string;
}
export interface StagePlanRequest {
  plan_id: string;
  skill: SkillRef;
  args: Json;
  limits: SkillLimits;
  /** Original model-authored async(context,state) body; must return boolean. */
  precondition_source: string;
}
export interface StageCorrection {
  plan_id: string;
  correction_allowed: boolean;
  remaining_calls: number;
  remaining_tools: number;
  remaining_ms: number;
  deadline_at: string;
}
export type PlanState = "armed" | "planning" | "staged" | "validating" | "activated" | "rejected" | "invalidated" | "expired" | "empty";
export type PlanRejectReason = "session_changed" | "life_changed" | "task_changed" | "predecessor_changed" | "predecessor_unsuccessful" | "predecessor_pending" | "predecessor_already_settled" | "source_changed" | "precondition_failed" | "precondition_error" | "budget_exhausted" | "deadline" | "cancelled" | "already_activated" | "not_staged" | "admission_failed";
export interface PlanProjection {
  plan_id: string;
  state: PlanState;
  planning_active: boolean;
  reason: PlanRejectReason | null;
  intent: string;
  basis: PlanningContext;
  candidate: PlanningSource | null;
  precondition_hash: string | null;
  deadline_at: string;
  budget: LookaheadRequest["budget"];
  calls: number;
  tools: number;
  observation_seq: number | null;
  activation_execution_id: string | null;
  /** Measured overlap only; never a causal speedup estimate. */
  overlap_ms: number;
}
