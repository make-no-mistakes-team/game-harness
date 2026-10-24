import type {
  GameAction,
  GameActionResult,
  Json,
  ObservationV3,
  StrategyCard,
} from "./contracts.ts";
import type { LookaheadConfig } from "./planning.ts";

export interface SkillRef {
  skill_id: string;
  version: number;
}

export const SKILL_API_VERSION = 4;

export interface NamedProgramRef {
  name: string;
  version?: number;
}
export interface SkillAPIManifest {
  api_version: 4;
  action_enabled: boolean;
  supports_respawn: boolean;
  bindings: readonly { name: string; capability_id: string; version: number; parameters: readonly string[] }[];
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
    runtime_version?: number;
    formatted_lines: number;
    complexity: number;
    nesting: number;
    api_version?: number;
    validator_version?: number;
    compatibility_hash?: string;
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
  observe(): Promise<ObservationV3>;
  action(action: GameAction): Promise<GameActionResult>;
  /** Explicit vanilla request through the same exclusive action arbiter. */
  respawn(): Promise<GameActionResult>;
  call(skill: NamedProgramRef, args: Json): Promise<SkillResult>;
  progress(summary: string, details: Json): Promise<null>;
}

export interface SkillStartRequest extends SkillRef {
  start_key: string;
  epoch: number;
  session_id: string;
  life_id: number;
  native_boot_id: string;
  run_generation: number;
  space_epoch: number;
  compatibility_hash: string;
  args: Json;
  limits: SkillLimits;
  /** Explicit one-shot lookahead opt-in; omission creates no planning request. */
  lookahead?: LookaheadConfig;
}

export interface SkillExecutionView extends SkillRef {
  execution_id: string;
  run_id: string;
  world_id: string | null;
  start_key: string;
  parent_execution_id: string | null;
  root_execution_id: string;
  epoch: number;
  /** Null only for historical records predating life attribution. */
  session_id: string | null;
  life_id: number | null;
  native_boot_id: string | null;
  run_generation: number | null;
  space_epoch: number | null;
  source_hash: string | null;
  compatibility_hash: string | null;
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
  diagnostic?: { type: string; message: string; source_hash: string; location: { mapping: "unmapped" }; code?: string };
}

export type SkillCapabilityRequest =
  | { kind: "observe" }
  | { kind: "respawn" }
  | { kind: "action"; action: GameAction }
  | { kind: "adapter"; capability_id: string; version: number; args: Json }
  | { kind: "call"; skill: NamedProgramRef; args: Json }
  | { kind: "progress"; summary: string; details: Json };
