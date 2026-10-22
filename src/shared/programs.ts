import type {
  GameAction,
  GameActionResult,
  Json,
  Observation,
  StrategyCard,
} from "./contracts.ts";
import type { LookaheadConfig } from "./planning.ts";

export interface SkillRef {
  skill_id: string;
  version: number;
}

/** Selects same-session, same-model definitions only, never prior execution state. */
export type WorkingProgramMode = "continue" | "fresh";

export interface SkillLimits {
  duration_ms: number;
  max_actions: number;
  max_calls: number;
  max_depth: number;
}

export const DEFAULT_SKILL_LIMITS: Readonly<SkillLimits> = Object.freeze({
  duration_ms: 120000,
  max_actions: 64,
  max_calls: 256,
  max_depth: 8,
});

export const MAX_SKILL_LIMITS: Readonly<SkillLimits> = Object.freeze({
  duration_ms: 600000,
  max_actions: 512,
  max_calls: 2048,
  max_depth: 8,
});

export interface SkillSpec {
  name: string;
  source: string;
  card: StrategyCard;
  dependencies: SkillRef[];
}

export interface SkillView extends SkillRef {
  name: string;
  source: string;
  hash: string;
  card: StrategyCard;
  dependencies: SkillRef[];
  parent_version: number | null;
  state: "validated" | "quarantined" | "retired";
  validation: {
    fingerprint: string;
    formatted_lines: number;
    complexity: number;
    nesting: number;
  };
  created_at: string;
}

export interface SkillResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  result: Json;
}

/** Host-bound API supplied to skill bodies; await one call at a time. */
export interface GameAPI {
  observe(): Promise<Observation>;
  action(action: GameAction): Promise<GameActionResult>;
  /** Explicit vanilla request through the same exclusive action arbiter. */
  respawn(): Promise<GameActionResult>;
  recipes(item: string): Promise<Json>;
  call(skill: SkillRef, args: Json): Promise<SkillResult>;
  progress(summary: string, details: Json): Promise<null>;
}

export interface SkillStartRequest extends SkillRef {
  start_key: string;
  epoch: number;
  session_id: string;
  life_id: number;
  args: Json;
  limits: SkillLimits;
  /** Explicit one-shot lookahead opt-in; omission creates no planning request. */
  lookahead?: LookaheadConfig;
}

export interface SkillExecutionView extends SkillRef {
  execution_id: string;
  run_id: string;
  start_key: string;
  parent_execution_id: string | null;
  root_execution_id: string;
  epoch: number;
  /** Null only for historical records predating life attribution. */
  session_id: string | null;
  life_id: number | null;
  args: Json;
  limits: SkillLimits;
  status:
    | "accepted"
    | "running"
    | "cancel_requested"
    | "succeeded"
    | "blocked"
    | "failed"
    | "cancelled"
    | "unknown";
  started_at: string | null;
  ended_at: string | null;
  deadline_at: string;
  actions: number;
  calls: number;
  result: SkillResult | null;
  error: string | null;
}

export type SkillCapabilityRequest =
  | { kind: "observe" }
  | { kind: "respawn" }
  | { kind: "action"; action: GameAction }
  | { kind: "recipes"; item: string }
  | { kind: "call"; skill: SkillRef; args: Json }
  | { kind: "progress"; summary: string; details: Json };
