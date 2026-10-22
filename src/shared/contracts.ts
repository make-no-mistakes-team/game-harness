import type { SkillView, SkillExecutionView } from "./programs.ts";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Vec3Data = { x: number; y: number; z: number };

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

export interface InventoryItem {
  name: string;
  display_name: string;
  count: number;
  slot: number;
}

export interface ObservedBlock {
  id: string;
  name: string;
  position: Vec3Data;
  observed_at: string;
  current: boolean;
}

export interface ObservedEntity {
  id: string;
  name: string;
  /** Visible nonempty ItemEntity stack registry identity only, never stack data. */
  item_name?: string;
  position: Vec3Data;
  observed_at: string;
  current: boolean;
}

export interface SoundObservation {
  category: "movement" | "interaction" | "combat" | "creature" | "weather";
  direction: "here" | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  distance: "near" | "mid" | "far";
  observed_at: string;
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

export interface Observation {
  schema_version: 2;
  world_id: string;
  epoch: number;
  session_id: string;
  life: PlayerLife;
  observation_seq: number;
  captured_at: string;
  profile_id: "player-observable-structured";
  preset_id: "minecraft-observable-initial-r2";
  player: {
    position: Vec3Data;
    yaw: number;
    pitch: number;
    health: number;
    food: number;
    on_ground: boolean;
    in_water: boolean;
    inventory: InventoryItem[];
  };
  blocks: ObservedBlock[];
  entities: ObservedEntity[];
  sounds: SoundObservation[];
  coverage: { partial: true; max_age_ms: number };
}

export type ControlName =
  "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";
export type Face = "up" | "down" | "north" | "south" | "east" | "west";
export type NavigationGaze =
  | { kind: "navigation" }
  | { kind: "target"; target_id: string }
  | { kind: "free"; yaw: number; pitch: number };

export type GameAction =
  | {
      kind: "move";
      controls: Partial<Record<ControlName, boolean>>;
      duration_ms: number;
      look?: { yaw: number; pitch: number };
      interaction?: { kind: "attack" | "use"; target_id?: string };
    }
  | { kind: "look"; yaw: number; pitch: number }
  | { kind: "dig"; target_id: string }
  | { kind: "place"; target_id: string; face: Face; item: string }
  | { kind: "craft"; item: string; executions: number; table_id?: string }
  | {
      kind: "equip";
      item: string;
      destination: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";
    }
  | { kind: "interact"; target_id: string }
  | { kind: "attack"; target_id: string }
  | {
      kind: "navigate";
      target_id: string;
      range: number;
      duration_ms: number;
      gaze?: NavigationGaze;
    }
  | { kind: "respawn" };

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
  motor_profile: MotorProfile;
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
  player: Observation["player"] | null;
  error: string | null;
}

export interface BridgeConnection {
  host: "127.0.0.1";
  port: number;
  version: "1.21.4";
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
}

export interface BridgeNotice {
  type: "state" | "observation" | "game_event" | "viewer";
  data: unknown;
}

export interface GameBridge {
  connect(config: BridgeConnection): Promise<void>;
  disconnect(): Promise<void>;
  snapshot(): GameState;
  observe(): Promise<Observation>;
  execute(action: GameAction, signal: AbortSignal): Promise<GameActionResult>;
  /** Resolves only after the native input barrier; uncertain outcomes stay unknown. */
  neutralize(): Promise<void>;
  cancel(reason: string): Promise<void>;
  setMotorProfile(profile: MotorProfile): Promise<void>;
  recipes(item: string): Promise<Json>;
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
  observation: Observation;
  action: ActionView | null;
  task: string;
}

export interface ActionView {
  action_id: string;
  /** Null only for historical records predating life attribution. */
  session_id: string | null;
  life_id: number | null;
  kind: GameAction["kind"];
  status:
    | "accepted"
    | "running"
    | "cancel_requested"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";
  origin: "strategist" | "policy" | "skill";
  execution_id: string | null;
  summary: string;
  started_at: string | null;
  ended_at: string | null;
  result: GameActionResult | null;
}

export type GoalId =
  "break_log" | "collect_wood" | "craft_crafting_table" | "craft_stone_pickaxe" | "custom";
export interface GoalChoice {
  id: GoalId;
  label: string;
  prompt: string;
}

export type UsagePurpose =
  "authoring" | "planning" | "replanning" | "improvement" | "other";
export interface TokenUsage {
  uncached_input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number;
  calls: number | null;
  known_cost: number | null;
  legacy_input: number | null;
}
export interface RunUsage extends TokenUsage {
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

export interface RunView {
  run_id: string;
  world_id: string;
  epoch: number;
  /** Null only for historical records predating life attribution. */
  session_id: string | null;
  life_id: number | null;
  task: string;
  goal: GoalId;
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
  run: RunView | null;
  goals: GoalChoice[];
  events: ActivityEvent[];
}
