import type { GoalId, Observation } from "../shared/contracts.ts";
import { eligibleLog, receiptedInventoryDelta } from "../server/objective-metrics.ts";
import type { StoredAction } from "../server/store.ts";

export type ScenarioId = "collect_wood" | "craft_crafting_table" | "obtain_stone";
export interface NaturalScenario {
  readonly id: ScenarioId;
  readonly prompt: string;
  readonly runtimeGoal: GoalId;
  readonly verifier: {
    readonly revision: "natural_inventory_v1";
    readonly criterion: "eligible_wood_inventory_gain" | "receipted_craft_and_retained_table" | "stone_or_cobblestone_inventory_gain";
    readonly description: string;
  };
}

/** Declared before inference. These are goals, not evaluator-authored strategies. */
export const NATURAL_SCENARIOS: readonly NaturalScenario[] = Object.freeze([
  Object.freeze({ id: "collect_wood", prompt: "Collect wood.", runtimeGoal: "collect_wood",
    verifier: Object.freeze({ revision: "natural_inventory_v1", criterion: "eligible_wood_inventory_gain",
      description: "An alive fresh authorized observation in the original world/session/epoch contains more of at least one log, wood, stem or hyphae item than the run-start inventory." }) }),
  Object.freeze({ id: "craft_crafting_table", prompt: "Craft a crafting table.", runtimeGoal: "craft_crafting_table",
    verifier: Object.freeze({ revision: "natural_inventory_v1", criterion: "receipted_craft_and_retained_table",
      description: "A succeeded craft action for crafting_table in this run has a confirmed positive native inventory receipt, and an alive fresh authorized observation retains a crafting_table. Possession alone does not establish crafting." }) }),
  Object.freeze({ id: "obtain_stone", prompt: "Obtain a stone or cobblestone item.", runtimeGoal: "custom",
    verifier: Object.freeze({ revision: "natural_inventory_v1", criterion: "stone_or_cobblestone_inventory_gain",
      description: "An alive fresh authorized observation in the original world/session/epoch contains more stone OR cobblestone items than the run-start inventory. A visible stone block, block removal or pre-existing item alone is insufficient." }) }),
] satisfies NaturalScenario[]);

export interface WorldConditions {
  readonly preset: "natural_normal_survival";
  readonly seed: string;
  readonly gamemode: "survival";
  readonly difficulty: "normal";
  readonly levelType: "minecraft:normal";
  readonly structures: true;
  readonly hardcore: false;
  readonly suppliedInventory: false;
  readonly consoleCommands: false;
  readonly freshWorldPerCase: true;
}
/** Shared across models/cases; gameplay time/weather/spawn remain ordinary vanilla behavior. */
export const NATURAL_WORLD_CONDITIONS: WorldConditions = Object.freeze({
  preset: "natural_normal_survival", seed: "20261022", gamemode: "survival", difficulty: "normal",
  levelType: "minecraft:normal", structures: true, hardcore: false,
  suppliedInventory: false, consoleCommands: false, freshWorldPerCase: true,
});

export interface GoalBaseline {
  readonly run_id: string;
  readonly world_id: string;
  readonly session_id: string;
  readonly epoch: number;
  readonly observation_seq: number;
  readonly inventory: Readonly<Record<string, number>>;
}
export interface GoalAction extends StoredAction { run_id: string }
export interface GoalVerification {
  verified: boolean;
  evidence_status: "verified" | "not_verified" | "insufficient";
  reason: string;
  item: string | null;
  baseline_count: number | null;
  current_count: number | null;
  observation_seq: number | null;
  action_ids: string[];
}
export function inventoryCounts(observation: Observation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of observation.player.inventory) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}
export function captureGoalBaseline(runId: string, observation: Observation): GoalBaseline {
  if (observation.life.status !== "alive") throw new Error("Goal baseline requires an alive authorized observation");
  return Object.freeze({ run_id: runId, world_id: observation.world_id, session_id: observation.session_id,
    epoch: observation.epoch, observation_seq: observation.observation_seq,
    inventory: Object.freeze(inventoryCounts(observation)) });
}

export function verifyScenarioGoal(scenario: NaturalScenario, baseline: GoalBaseline, runId: string,
  observation: Observation | null, actions: readonly GoalAction[]): GoalVerification {
  const result = (reason: string, status: GoalVerification["evidence_status"] = "not_verified"): GoalVerification => ({
    verified: false, evidence_status: status, reason, item: null, baseline_count: null,
    current_count: null, observation_seq: observation?.observation_seq ?? null, action_ids: [],
  });
  if (!observation) return result("authorized_observation_unavailable", "insufficient");
  if (runId !== baseline.run_id || observation.world_id !== baseline.world_id || observation.session_id !== baseline.session_id || observation.epoch !== baseline.epoch)
    return result("goal_scope_changed", "insufficient");
  if (observation.observation_seq <= baseline.observation_seq) return result("observation_not_newer_than_baseline", "insufficient");
  if (observation.life.status !== "alive") return result("alive_inventory_not_observed");
  const current = inventoryCounts(observation);
  if (scenario.id === "craft_crafting_table") {
    if ((current.crafting_table ?? 0) <= 0) return result("crafting_table_not_retained");
    const crafts = actions.filter(action => action.run_id === baseline.run_id && action.view.session_id === baseline.session_id &&
      action.request.kind === "craft" && action.request.item === "crafting_table" && action.view.status === "succeeded" && action.view.result?.status === "succeeded");
    const confirmed = crafts.filter(action => (receiptedInventoryDelta(action)?.crafting_table ?? 0) > 0);
    if (!confirmed.length) return result(crafts.length ? "craft_receipt_unconfirmed" : "no_succeeded_craft_in_run", crafts.length ? "insufficient" : "not_verified");
    return { verified: true, evidence_status: "verified", reason: "receipted_craft_and_retained_table",
      item: "crafting_table", baseline_count: baseline.inventory.crafting_table ?? 0, current_count: current.crafting_table!,
      observation_seq: observation.observation_seq, action_ids: confirmed.map(action => action.view.action_id) };
  }
  const item = Object.keys(current).find(name => (scenario.id === "collect_wood" ? eligibleLog(name) : name === "stone" || name === "cobblestone") &&
    current[name]! > (baseline.inventory[name] ?? 0));
  if (!item) return result("eligible_inventory_gain_not_observed");
  return { verified: true, evidence_status: "verified", reason: scenario.verifier.criterion, item,
    baseline_count: baseline.inventory[item] ?? 0, current_count: current[item]!, observation_seq: observation.observation_seq, action_ids: [] };
}
