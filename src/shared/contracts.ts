import type { SkillView, SkillExecutionView } from "./programs.ts";
import type { PreparedStartView } from "./prepared-start.ts";
import type { EffectOwnerRef, EffectScope, EffectEnvelope, EffectInvocation, EffectScreenPrecondition, SpaceRef, ScreenRef } from "./control.ts";
import type { AdapterActorProjection, ObservationV3 } from "./observations.ts";
export type { ObservationV3 } from "./observations.ts";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Vec3Data = { x: number; y: number; z: number };

export type Sha256 = string;
export interface SchemaIdentity {
  id: string;
  version: number;
  hash: Sha256;
}
export interface AdapterDescriptor {
  descriptor_schema: 1;
  game: { id: string; version: string };
  adapter: { id: string; version: string; build_hash: Sha256 };
  observation: {
    schema_version: 3;
    schema_hash: Sha256;
    payload_schema: SchemaIdentity;
    profile: {
      id: string;
      version: number;
      configuration: Json;
      configuration_hash: Sha256;
    };
  };
  capabilities: { id: string; version: number; schema_hash: Sha256 }[];
  actuator: "native" | "desktop";
  executable: { api_version: 5; validator_version: 5; runtime_version: 5 };
}
export interface AdapterBinding {
  ready: boolean;
  descriptor: AdapterDescriptor;
  compatibility_hash: Sha256;
  native_boot_id: string;
}
export type ProgramCompatibility = Pick<AdapterBinding, "descriptor" | "compatibility_hash">;
/** Inspect-only pre-cutover cache metadata; never accepted by executable admission. */
export interface HistoricalExecutableValidation {
  runtime_version: 1 | 2 | 3 | 4;
  fingerprint: string;
  api_version?: number;
  validator_version?: number;
  compatibility_hash?: string;
  formatted_lines?: number;
  complexity?: number;
  nesting?: number;
}
export interface ActiveExecutableValidation {
  api_version: 5;
  validator_version: 5;
  runtime_version: 5;
  compatibility_hash: Sha256;
  fingerprint: Sha256;
  formatted_lines: number;
  complexity: number;
  nesting: number;
  runtime_features?: ("pure_modules_v1" | "motion_track_v1")[];
}
/** Registered by trusted composition; never populated from a native hello or program arguments. */
export interface AdapterSchemaCatalog {
  observation: Json;
  payload: Json;
  capabilities: Record<string, Json>;
  evidence?: Record<string, Json>;
}
export type AdapterGoal = {
  adapter_id: string;
  goal_id: string;
  verifier: { id: string; version: number } | null;
  parameters: Json;
};
export interface VerificationManifest {
  goal: AdapterGoal;
  run_id: string;
  world_id: string;
  session_id: string;
  epoch: number;
  native_boot_id: string;
  baseline: Json;
}
export interface AdapterEvidence {
  evidence_id: string;
  adapter_id: string;
  schema: SchemaIdentity;
  scope: EffectScope;
  observed_at: string;
  data: Json;
}
export interface VerificationResult {
  adapter_id: string;
  verifier_id: string;
  verifier_version: number;
  status: "verified" | "failed" | "incomplete" | "unknown";
  reason: string;
  evidence_refs: string[];
}
export interface RuntimeAdapter {
  readonly descriptor: AdapterDescriptor;
  readonly schemas: AdapterSchemaCatalog;
  /** Trusted in-process predicates after JSON Schema validation; never serialized into the descriptor/catalog. */
  readonly capabilityValidators?: Readonly<Record<string, (args: Json) => boolean>>;
  readonly goals: readonly AdapterGoal[];
  readonly goalChoices?: readonly GoalChoice[];
  readonly action_capability: { id: string; version: number } | null;
  readonly supports_respawn: boolean;
  readonly bindings: readonly { name: string; capability_id: string; version: number; parameters: readonly string[];
    result?: { type: string; schema: Json } }[];
  effectDeadlineMs(action: Json): number;
  /** Adapter-owned admission selection; application-time layout/local predicates remain native. */
  screenPrecondition?(action: Json, screen: ScreenRef | null): EffectScreenPrecondition;
  projectObservation(observation: ObservationV3, previous?: ObservationV3 | null): AdapterActorProjection;
  captureBaseline(goal: AdapterGoal, observation: ObservationV3): Json;
  verifyCompletion(manifest: VerificationManifest, events: readonly AdapterEvidence[]): VerificationResult;
  effectEvidence?(scope: EffectScope, operationId: string, action: Json, result: GameActionResult, at: string): readonly AdapterEvidence[];
}

export interface ActivityEvent {
  event_seq: number;
  run_id: string | null;
  at: string;
  type: string;
  summary: string;
  details: Json;
}

export interface ModelChoice {
  id: string;
  name: string;
  provider: string;
  context_window: number | null;
  input_modalities?: readonly string[];
  capability_provenance?: "discovered_sdk_descriptor_not_live_vision";
}

export interface AuthState {
  status:
    | "signed_out"
    | "authorizing"
    | "discovering"
    | "ready"
    | "unavailable"
    | "error";
  authenticated: boolean;
  provider: "openai-codex";
  account_label: string | null;
  models: ModelChoice[];
  login: null | {
    id: string;
    mode: "browser" | "device";
    url: string | null;
    instructions: string | null;
    prompt: null | { label: string; secret: boolean; allow_empty: boolean };
  };
  error: string | null;
}

export interface GameServerState {
  status:
    | "not_installed"
    | "eula_required"
    | "preparing"
    | "stopped"
    | "starting"
    | "running"
    | "error";
  version: "1.21.4";
  host: "127.0.0.1";
  port: number;
  world_id: string | null;
  eula_accepted: boolean;
  error: string | null;
}

export interface PlayerLife {
  /** Native-confirmed incarnation within the session; death retains this ID. */
  life_id: number;
  status: "loading" | "alive" | "dead" | "respawning";
  can_respawn: boolean;
  death: {
    death_id: string;
    at: string;
    message: string | null;
  } | null;
}

export type MotorProfile = "precise" | "balanced" | "fast";

/** Payload is validated by the selected adapter's registered capability schema. */
export type GameAction = { kind: string; [key: string]: Json };

export interface GameActionResult {
  status: "succeeded" | "failed" | "cancelled" | "unknown";
  summary: string;
  evidence: Json;
  requires_reconnect?: boolean;
}

export interface GameState {
  status: "disconnected" | "connecting" | "connected" | "error";
  username: string;
  version: string;
  world_id: string | null;
  epoch: number;
  session_id: string | null;
  life: PlayerLife | null;
  binding: AdapterBinding | null;
  space: SpaceRef | null;
  screen: ScreenRef | null;
  video: {
    status: "idle" | "starting" | "streaming" | "stale" | "error";
    width: number;
    height: number;
    fps: number | null;
    frames: number;
    last_frame_at: string | null;
    error: string | null;
  };
  last_observation_at: string | null;
  presentation: AdapterActorProjection | null;
  error: string | null;
}

export interface BridgeConnection {
  host: "127.0.0.1";
  port: number;
  version: string;
  world_id: string;
  epoch: number;
  motor_profile?: MotorProfile;
}

/** Life changes do not close or replace the authenticated game session. */
export interface PlayerLifeEvent {
  type: "death" | "life";
  session_id: string;
  world_id: string;
  epoch: number;
  life: PlayerLife;
  summary: string;
  neutralized: true;
  native_boot_id: string;
  space: SpaceRef | null;
  screen: ScreenRef | null;
}

export interface BridgeNotice {
  type: "state" | "observation" | "game_event" | "viewer";
  data: unknown;
}

export interface GameBridge {
  connect(config: BridgeConnection): Promise<void>;
  disconnect(): Promise<void>;
  snapshot(): GameState;
  observe(): Promise<ObservationV3>;
  execute(effect: EffectEnvelope, signal: AbortSignal): Promise<GameActionResult>;
  /** Resolves only after the native input barrier; uncertain outcomes stay unknown. */
  neutralize(owner: EffectOwnerRef): Promise<void>;
  cancel(reason: string, owner: EffectOwnerRef): Promise<void>;
  emergencyStop(reason: string): Promise<void>;
  adapter(): RuntimeAdapter | null;
  queryCapability?(id: string, version: number, args: Json): Promise<Json>;
  /** Renews only an exact current semantic producer from a fresh executive capture. */
  superviseProducer?(executionId: string, supervision: import("./control.ts").ProducerSupervision): Promise<boolean>;
  openController?(
    reservation: import("./controller.ts").ControllerReservation,
    controllerGeneration: number,
    deadlineHostMs: number,
    applied: (ack: import("./controller.ts").InputAppliedAck) => void,
    effect: (update: import("./controller.ts").ControllerEffectUpdate) => void,
  ): Promise<import("./controller.ts").ControllerInputChannel>;
  subscribe(listener: (notice: BridgeNotice) => void): () => void;
}

export interface StrategyCard {
  purpose: string;
  applicability: string;
  method: string;
  reason: string;
  limitations: string;
}

export interface PolicySpec {
  backend: "javascript" | "jev";
  choices: { id: string; decision: PolicyDecision }[] | null;
  name: string;
  source: string;
  card: StrategyCard;
  priority: number;
  interval_ms: number;
}

export interface PolicyView {
  backend: "javascript" | "jev";
  choices: { id: string; decision: PolicyDecision }[] | null;
  policy_id: string;
  version: number;
  name: string;
  hash: string;
  state: "draft" | "validated" | "trial" | "active" | "quarantined" | "retired";
  source: string;
  validation?: ActiveExecutableValidation | HistoricalExecutableValidation;
  card: StrategyCard;
  priority: number;
  interval_ms: number;
  evaluations: number;
  effects: number;
  last_error: string | null;
}

export type PolicyDecision =
  | { kind: "continue"; reason?: string }
  | { kind: "replan"; reason: string }
  | { kind: "interrupt"; reason: string }
  | { kind: "replace"; action: GameAction; reason: string };

export interface PolicyContext {
  observation: ObservationV3;
  action: ActionView | null;
  /** Own foreground software, not proof of an applied input or useful behavior.
   * Resident input has no legacy ActionView; action:null alone is not idle. */
  program: { name: string; version: number; entry: "run" | "step"; status: SkillExecutionView["status"]; executive?: boolean } | null;
  task: string;
}

export interface ActionView {
  action_id: string;
  /** Null only for historical records predating life attribution. */
  session_id: string | null;
  life_id: number | null;
  scope: EffectScope | null;
  invocation: EffectInvocation | null;
  compatibility_hash: string | null;
  kind: GameAction["kind"];
  status:
    | "accepted"
    | "running"
    | "cancel_requested"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";
  origin: "strategist" | "policy" | "skill" | "diagnostic";
  execution_id: string | null;
  summary: string;
  started_at: string | null;
  ended_at: string | null;
  result: GameActionResult | null;
}

export type HistoricalGoalId =
  "break_log" | "collect_wood" | "craft_crafting_table" | "craft_stone_pickaxe" | "custom";
export interface GoalChoice {
  id: string;
  goal: AdapterGoal;
  label: string;
  prompt: string;
}

export type UsagePurpose =
  "authoring" | "planning" | "replanning" | "improvement" | "other";
export interface ReportedUsage {
  uncached_input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
}
/** Request-bound, allowlisted accounting evidence; never a raw provider payload. */
export interface RequestUsageEvidence {
  schema_version: 1;
  request_id: string;
  sdk_reported: ReportedUsage | null;
  provider_terminal: {
    source: "openai_responses_terminal" | "openai_codex_responses_terminal" | "jev_response_usage";
    response_id: string | null;
    terminal_type: string;
    counters: ReportedUsage;
  } | null;
  unaccounted_response_ids: string[];
}
export interface TokenUsage extends ReportedUsage {
  calls: number | null;
  known_cost: number | null;
  legacy_input: number | null;
}
export interface RunUsage extends TokenUsage {
  /** These accumulators are observations, not qualified consumption totals. */
  accounting_basis: "sdk_reported_subtotal";
  by_purpose: Record<UsagePurpose, TokenUsage>;
}

export interface ProgramEvidenceView {
  execution_id: string;
  skill_id: string;
  version: number;
  root_execution_id: string;
  status: SkillExecutionView["status"];
  duration_ms: number | null;
  actions: number;
  calls: number;
  strategic_requests: number;
  confirmed_effects: number;
  evidence_status:
    | "verified_goal"
    | "verified_predicate"
    | "confirmed_effects"
    | "self_reported"
    | "unknown";
  verified_event_seqs: number[];
  compactness: SkillView["validation"];
}

export type RunPauseCause = "operator" | "provider_failure" | "provider_aborted" | "deadline" |
  "observation_unavailable" | "preparation_failed" | "safety";
export interface RunControlState {
  pause_cause: RunPauseCause | null;
  cleanup_error: string | null;
}
export interface RunOperatorView extends RunControlState {
  state: RunView["status"] | "acting" | "executing" | "thinking" | "waiting" | "recovering" | "blocked" | "provider_unavailable";
  completion: "verified" | "model_reported_unverified" | null;
  progress: {
    event_seq: number;
    at: string;
    summary: string;
    execution_id: string | null;
    source: "model_program";
    verification: "unverified";
  } | null;
}

export interface RunView {
  run_id: string;
  /** Omission is historical/embedded legacy mode, never an implicit session migration. */
  control_mode?: "executive" | "legacy";
  world_id: string;
  epoch: number;
  /** Null only for historical records predating life attribution. */
  session_id: string | null;
  life_id: number | null;
  task: string;
  goal: AdapterGoal | HistoricalGoalId;
  native_boot_id: string | null;
  space_epoch: number | null;
  compatibility_hash: string | null;
  model_id: string;
  status:
    | "created"
    | "bootstrapping"
    | "running"
    | "reviewing"
    | "pausing"
    | "paused"
    | "stopping"
    | "stopped"
    | "completed"
    | "failed";
  started_at: string | null;
  ended_at: string | null;
  turns: number;
  model_status: "idle" | "thinking" | "waiting" | "error";
  action: ActionView | null;
  policies: PolicyView[];
  skills: SkillView[];
  executions: SkillExecutionView[];
  error: string | null;
  operator: RunOperatorView;
  usage: RunUsage;
}

export interface SandboxState {
  status: "checking" | "ready" | "unavailable";
  image: string;
  error: string | null;
}

export interface AppSnapshot {
  auth: AuthState;
  server: GameServerState;
  game: GameState;
  sandbox: SandboxState;
  prepared_start: PreparedStartView | null;
  run: RunView | null;
  goals: GoalChoice[];
  events: ActivityEvent[];
}
