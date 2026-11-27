export const SURVIVAL_AGENT_GOALS = [
  "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "diamond_pickaxe", "nether_portal",
] as const;

export type SurvivalAgentGoal = (typeof SURVIVAL_AGENT_GOALS)[number];

export const SURVIVAL_AGENT_STRATEGIES = ["deterministic", "model"] as const;
export type SurvivalAgentStrategy = (typeof SURVIVAL_AGENT_STRATEGIES)[number];
export interface SurvivalModelSelection {
  provider: string;
  modelId: string;
}

/** Identity is explicit; validation does not open credentials or contact a provider. */
export function survivalModelIdentity(selection: SurvivalModelSelection): string {
  if (!selection || typeof selection.provider !== "string" || typeof selection.modelId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(selection.provider) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(selection.modelId))
    throw new Error("Select an explicit model as PROVIDER/MODEL.");
  return `${selection.provider}/${selection.modelId}`;
}
export const SURVIVAL_AGENT_STRATEGY_OUTCOMES = [
  "strategy_applied", "no_advice_applied", "provider_unavailable",
] as const;

export interface SurvivalAgentStart {
  goal: SurvivalAgentGoal;
  strategy: SurvivalAgentStrategy;
  model?: SurvivalModelSelection;
}

export interface SurvivalAgentSnapshot {
  phase: "idle" | "starting" | "playing" | "stopping" | "ended";
  goal: SurvivalAgentGoal | null;
  strategy: SurvivalAgentStrategy | null;
  model: string | null;
  /** Projected only from the finalized model-strategy outcome. */
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
