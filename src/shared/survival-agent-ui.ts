export const SURVIVAL_AGENT_GOALS = [
  "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal",
] as const;

export type SurvivalAgentGoal = (typeof SURVIVAL_AGENT_GOALS)[number];

export const SURVIVAL_AGENT_STRATEGIES = ["deterministic", "terra"] as const;
export type SurvivalAgentStrategy = (typeof SURVIVAL_AGENT_STRATEGIES)[number];
export const TERRA_MODEL_ID = "gpt-6.1-terra";
export const SURVIVAL_AGENT_STRATEGY_OUTCOMES = [
  "native_effect_completed", "no_completed_effect", "provider_unavailable", "refused", "provider_error",
  "budget_limited", "display_lost", "protocol_fault", "cleanup_failed",
] as const;

/** Host-selected preset work can reach the vanilla goal without a single Terra decision. */
export function hasConfirmedTerraEffect(status: unknown): boolean {
  if (status === null || typeof status !== "object") return false;
  const value = status as Record<string, unknown>;
  return positiveCount(value.completedReceipts) || positiveCount(value.completedModelWorkOrders);
}

function positiveCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export interface SurvivalAgentStart {
  goal: SurvivalAgentGoal;
  strategy: SurvivalAgentStrategy;
}

export interface SurvivalAgentSnapshot {
  phase: "idle" | "starting" | "playing" | "stopping" | "ended";
  goal: SurvivalAgentGoal | null;
  strategy: SurvivalAgentStrategy | null;
  model: typeof TERRA_MODEL_ID | null;
  /** Projected only from the finalized Terra outcome. */
  strategyOutcome: (typeof SURVIVAL_AGENT_STRATEGY_OUTCOMES)[number] | null;
  status: string;
  /** Null until the supervisor has finalized its outcome. */
  won: boolean | null;
  /** Opaque run identifier, never a filesystem path. */
  run: string | null;
  elapsedMs: number;
  health: number | null;
  food: number | null;
  /** Deaths observed in this attempt, not the starting world's lifetime count. */
  deaths: number | null;
}
