export const SURVIVAL_PILOT_GOALS = [
  "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal",
] as const;

export type SurvivalPilotGoal = (typeof SURVIVAL_PILOT_GOALS)[number];

export interface SurvivalPilotSnapshot {
  phase: "idle" | "starting" | "playing" | "stopping" | "ended";
  goal: SurvivalPilotGoal | null;
  status: string;
  /** Null until the supervisor has finalized its outcome. */
  won: boolean | null;
  /** Opaque run identifier, never a filesystem path. */
  run: string | null;
  elapsedMs: number;
  health: number | null;
  food: number | null;
}
