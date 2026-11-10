import type {
  GameAction,
  GameActionResult,
  Json,
  ObservationV3,
  StrategyCard,
} from "./contracts.ts";
import type { LookaheadConfig } from "./planning.ts";
import type { ControllerEvent, ResidentLimits, ResidentSnapshot } from "./resident.ts";
import type { ControlSessionConfig } from "./control-session.ts";

export type ProgramEntry = "run" | "step" | "analyze" | "library";

export interface SkillRef {
  skill_id: string;
  version: number;
}

/** A local ESM import is pinned to this exact immutable definition. */
export interface SkillDependency extends SkillRef {
  import_path?: string;
}

/** Pure modules share one watched realm; they never acquire playing capabilities. */
export interface ExecutableModuleBundle {
  schema_version: 1;
  entry: "step" | "analyze";
  root: "root";
  source_hash: string;
  modules: {
    id: string;
    source: string;
    source_hash: string;
    imports: { specifier: string; module_id: string }[];
  }[];
}

export const SKILL_API_VERSION = 5;

export const PROGRAM_RESULT_GUIDANCE = "Return a 1–2000-character summary and compact result: counts, task facts, failures and authored notes. The whole JSON frame, including envelope and newline, must fit 65536 UTF-8 bytes and depth 32. Inspect raw host evidence through program_inspect execution/action/trace/events with returned named/ordinal references and cursors; never return receipt/observation arrays, invent evidence IDs or stringify records into summary. Serialization failure does not undo effects: inspect retained evidence and fresh state. Program/resident termination retires controls, not world time. Connected Minecraft keeps ticking during inference, authoring, validation, Pause and Stop run, without automatic survival or implied world pause.";

export interface NamedProgramRef {
  name: string;
  version?: number;
}
export interface SkillAPIManifest {
  api_version: 5;
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
  entry: ProgramEntry;
  name: string;
  source: string;
  card: StrategyCard;
  dependencies: SkillDependency[];
}

export interface SkillView extends SkillRef {
  /** Missing only on historical immutable rows; never inferred for execution. */
  entry?: ProgramEntry;
  name: string;
  source: string;
  hash: string;
  card: StrategyCard;
  dependencies: SkillDependency[];
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
    runtime_features?: ("pure_modules_v1")[];
  };
  created_at: string;
}

export interface SkillResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  result: Json;
}

export interface ProgramOutputFailure {
  phase: "terminal_result";
  reason: "utf8_bytes" | "json_depth" | "json_serialization";
  maximum_bytes: number;
  actual_bytes: number | null;
  completed_capability_calls: number;
}

export type ProgramAttention = Omit<ControllerEvent, "kind">;

/** Host-bound API supplied to skill bodies; await one call at a time. */
export interface GameAPI {
  observe(): Promise<ObservationV3>;
  action(action: GameAction): Promise<GameActionResult>;
  /** One ordinary action, then fresh state only when continuation is safe. Never retries or relabels the action. */
  actionAndObserve(action: GameAction): Promise<{ action: GameActionResult; observation: ObservationV3 | null }>;
  /** Explicit vanilla request through the same exclusive action arbiter. */
  respawn(): Promise<GameActionResult>;
  call(skill: NamedProgramRef, args: Json): Promise<SkillResult>;
  progress(summary: string, details: Json): Promise<null>;
  /** Requests cognition without stopping the foreground program or adding effect authority. */
  attention(request: ProgramAttention): Promise<void>;
}

interface SkillStartBase extends SkillRef {
  start_key: string;
  epoch: number;
  session_id: string;
  life_id: number;
  native_boot_id: string;
  run_generation: number;
  space_epoch: number;
  compatibility_hash: string;
  args: Json;
}
export interface RunSkillStartRequest extends SkillStartBase {
  entry: "run";
  limits: SkillLimits;
  /** Explicit one-shot lookahead opt-in; omission creates no planning request. */
  lookahead?: LookaheadConfig;
}
export interface ResidentSkillStartRequest extends SkillStartBase {
  entry: "step";
  limits: ResidentLimits;
  initial_state: Json;
  session?: ControlSessionConfig;
  /** One explicitly authorized prepared continuation after actual resident retirement. */
  lookahead?: LookaheadConfig;
}
export type SkillStartRequest = RunSkillStartRequest | ResidentSkillStartRequest;

interface SkillExecutionBase extends SkillRef {
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
  diagnostic?: { type: string; message: string; source_hash: string; location: { mapping: "unmapped" }; code?: string;
    output?: ProgramOutputFailure };
}
export type SkillExecutionView = SkillExecutionBase & (
  | { entry: "run"; limits: SkillLimits }
  | { entry: "step"; limits: ResidentLimits; initial_state: Json; resident: ResidentSnapshot | null; session?: ControlSessionConfig }
  | { entry: null; limits: SkillLimits }
);

export type SkillCapabilityRequest =
  | { kind: "observe" }
  | { kind: "respawn" }
  | { kind: "action"; action: GameAction }
  | { kind: "adapter"; capability_id: string; version: number; args: Json }
  | { kind: "call"; skill: NamedProgramRef; args: Json }
  | { kind: "progress"; summary: string; details: Json }
  | { kind: "attention"; attention: ProgramAttention };
