import type { HistoricalGoalId } from "../shared/contracts.ts";
import type { HistoricalObservationV2 } from "../shared/minecraft.ts";
import { eligibleLog, evidenceObject, receiptedInventoryDelta } from "../server/objective-metrics.ts";
import type { StoredAction } from "../server/store.ts";

export type ScenarioId = "collect_wood" | "craft_crafting_table" | "obtain_stone" | "collect_and_craft_table";
export interface HistoricalNaturalScenarioV1 {
  readonly id: ScenarioId;
  readonly prompt: string;
  readonly runtimeGoal: HistoricalGoalId;
  readonly verifier: {
    readonly revision: "natural_inventory_v1" | "natural_collection_craft_v1";
    readonly criterion: "eligible_wood_inventory_gain" | "receipted_craft_and_retained_table" | "stone_or_cobblestone_inventory_gain" | "prior_own_wood_then_receipted_retained_table";
    readonly description: string;
  };
}

/** Declared before inference. These are goals, not evaluator-authored strategies. */
export const HISTORICAL_NATURAL_SCENARIOS_V1: readonly HistoricalNaturalScenarioV1[] = Object.freeze([
  Object.freeze({ id: "collect_wood", prompt: "Collect wood.", runtimeGoal: "collect_wood",
    verifier: Object.freeze({ revision: "natural_inventory_v1", criterion: "eligible_wood_inventory_gain",
      description: "An alive fresh authorized observation in the original world/session/epoch contains more of at least one log, wood, stem or hyphae item than the run-start inventory." }) }),
  Object.freeze({ id: "craft_crafting_table", prompt: "Craft a crafting table.", runtimeGoal: "craft_crafting_table",
    verifier: Object.freeze({ revision: "natural_inventory_v1", criterion: "receipted_craft_and_retained_table",
      description: "A succeeded craft action for crafting_table in this run has a confirmed positive native inventory receipt, and an alive fresh authorized observation retains a crafting_table. Possession alone does not establish crafting." }) }),
  Object.freeze({ id: "obtain_stone", prompt: "Obtain a stone or cobblestone item.", runtimeGoal: "custom",
    verifier: Object.freeze({ revision: "natural_inventory_v1", criterion: "stone_or_cobblestone_inventory_gain",
      description: "An alive fresh authorized observation in the original world/session/epoch contains more stone OR cobblestone items than the run-start inventory. A visible stone block, block removal or pre-existing item alone is insufficient." }) }),
  Object.freeze({ id: "collect_and_craft_table", prompt: "Collect wood and craft a crafting table.", runtimeGoal: "craft_crafting_table",
    verifier: Object.freeze({ revision: "natural_collection_craft_v1", criterion: "prior_own_wood_then_receipted_retained_table",
      description: "This run's eligible own wood acquisition is observed or confirmed by a prior scoped native inventory receipt before this run's confirmed positive crafting-table craft; fresh alive inventory retains the table. Logs may have been consumed." }) }),
] satisfies HistoricalNaturalScenarioV1[]);

/** The research case is explicit-only: default/all preserve the old paid cohort. */
export function selectHistoricalNaturalScenariosV1(selector?: ScenarioId | "all"): readonly HistoricalNaturalScenarioV1[] {
  return HISTORICAL_NATURAL_SCENARIOS_V1.filter(scenario => !selector || selector === "all" ? scenario.id !== "collect_and_craft_table" : scenario.id === selector);
}

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

export interface HistoricalGoalBaselineV1 {
  readonly run_id: string;
  readonly world_id: string;
  readonly session_id: string;
  readonly epoch: number;
  readonly observation_seq: number;
  readonly inventory: Readonly<Record<string, number>>;
  readonly captured_at: string;
  readonly life_id: number;
}
export interface GoalAction extends StoredAction { run_id: string }
export interface HistoricalGoalVerificationV1 {
  verified: boolean;
  evidence_status: "verified" | "not_verified" | "insufficient";
  reason: string;
  item: string | null;
  baseline_count: number | null;
  current_count: number | null;
  observation_seq: number | null;
  action_ids: string[];
  evidence_observation_seqs?: number[];
}
export interface HistoricalScenarioProgressV1 {
  run_id: string; world_id: string; session_id: string; epoch: number;
  wood: { seq: number; capturedAt: number; life: number; item: string; count: number; source: "authorized_alive_observation" } | null;
}
export function createHistoricalScenarioProgressV1(baseline: HistoricalGoalBaselineV1): HistoricalScenarioProgressV1 {
  return { run_id: baseline.run_id, world_id: baseline.world_id, session_id: baseline.session_id, epoch: baseline.epoch, wood: null };
}
export function historicalInventoryCountsV2(observation: HistoricalObservationV2): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of observation.player.inventory) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}
export function captureHistoricalGoalBaselineV1(runId: string, observation: HistoricalObservationV2): HistoricalGoalBaselineV1 {
  if (observation.life.status !== "alive") throw new Error("Goal baseline requires an alive authorized observation");
  return Object.freeze({ run_id: runId, world_id: observation.world_id, session_id: observation.session_id,
    epoch: observation.epoch, observation_seq: observation.observation_seq,
    captured_at: observation.captured_at, life_id: observation.life.life_id,
    inventory: Object.freeze(historicalInventoryCountsV2(observation)) });
}

export function verifyHistoricalScenarioGoalV1(scenario: HistoricalNaturalScenarioV1, baseline: HistoricalGoalBaselineV1, runId: string,
  observation: HistoricalObservationV2 | null, actions: readonly GoalAction[], progress?: HistoricalScenarioProgressV1): HistoricalGoalVerificationV1 {
  const result = (reason: string, status: HistoricalGoalVerificationV1["evidence_status"] = "not_verified"): HistoricalGoalVerificationV1 => ({
    verified: false, evidence_status: status, reason, item: null, baseline_count: null,
    current_count: null, observation_seq: observation?.observation_seq ?? null, action_ids: [],
  });
  if (!observation) return result("authorized_observation_unavailable", "insufficient");
  if (runId !== baseline.run_id || observation.world_id !== baseline.world_id || observation.session_id !== baseline.session_id || observation.epoch !== baseline.epoch)
    return result("goal_scope_changed", "insufficient");
  if (observation.observation_seq <= baseline.observation_seq) return result("observation_not_newer_than_baseline", "insufficient");
  if (observation.life.status !== "alive") return result("alive_inventory_not_observed");
  if (progress && (progress.run_id !== runId || progress.world_id !== baseline.world_id ||
    progress.session_id !== baseline.session_id || progress.epoch !== baseline.epoch)) return result("verifier_progress_scope_changed", "insufficient");
  const current = historicalInventoryCountsV2(observation);
  if (scenario.id === "craft_crafting_table" || scenario.id === "collect_and_craft_table") {
    const combined = scenario.id === "collect_and_craft_table";
    const acquiredItem = Object.keys(current).find(name => eligibleLog(name) && current[name]! > (baseline.inventory[name] ?? 0));
    if (combined && progress && acquiredItem) {
      const prior = progress.wood;
      if (!prior || prior.life !== observation.life.life_id)
        progress.wood = { seq: observation.observation_seq, capturedAt: Date.parse(observation.captured_at), life: observation.life.life_id,
          item: acquiredItem, count: current[acquiredItem]!, source: "authorized_alive_observation" };
    }
    if ((current.crafting_table ?? 0) <= 0) return result("crafting_table_not_retained");
    const crafts = actions.filter(action => action.run_id === baseline.run_id && action.view.session_id === baseline.session_id &&
      (!combined || action.view.life_id === observation.life.life_id && Date.parse(action.view.started_at ?? "") >= Date.parse(baseline.captured_at) &&
        Date.parse(action.view.ended_at ?? "") >= Date.parse(action.view.started_at ?? "") &&
        Date.parse(action.view.ended_at ?? "") <= Date.parse(observation.captured_at) &&
        evidenceObject(action.view.result?.evidence)?.effect_confirmed === true) &&
      action.request.kind === "craft" && action.request.item === "crafting_table" && action.view.status === "succeeded" && action.view.result?.status === "succeeded");
    const confirmed = crafts.filter(action => (receiptedInventoryDelta(action)?.crafting_table ?? 0) > 0);
    if (!confirmed.length) return result(crafts.length ? "craft_receipt_unconfirmed" : "no_succeeded_craft_in_run", crafts.length ? "insufficient" : "not_verified");
    const milestone = progress?.wood;
    const acquisition = combined ? actions.filter(action => {
      const receipt = evidenceObject(action.view.result?.evidence);
      if (action.run_id !== runId || action.view.session_id !== baseline.session_id ||
        action.view.life_id !== observation.life.life_id || action.view.status !== "succeeded" || action.view.result?.status !== "succeeded" ||
        receipt?.effect_confirmed !== true || receipt.inventory_receipt_confirmed !== true ||
        !(Date.parse(action.view.started_at ?? "") >= Date.parse(baseline.captured_at)) ||
        !(Date.parse(action.view.ended_at ?? "") >= Date.parse(action.view.started_at ?? "")) ||
        !confirmed.some(craft => Date.parse(action.view.ended_at ?? "") <= Date.parse(craft.view.started_at ?? ""))) return false;
      // A consuming native craft receipt proves wood held before the craft,
      // even when no acquisition observation or dig inventory receipt exists.
      return Object.entries(evidenceObject(receipt.inventory_before) ?? {}).some(([name, count]) =>
        eligibleLog(name) && typeof count === "number" && Number.isFinite(count) && count > (baseline.inventory[name] ?? 0)) ||
        Object.entries(receiptedInventoryDelta(action) ?? {}).some(([name, delta]) => eligibleLog(name) && delta > 0);
    }) : [];
    const observedBeforeCraft = milestone && milestone.life === observation.life.life_id &&
      confirmed.some(craft => milestone.capturedAt <= Date.parse(craft.view.started_at ?? ""));
    if (combined && !acquisition.length && !observedBeforeCraft) return result("prior_own_wood_acquisition_not_proven");
    return { verified: true, evidence_status: "verified", reason: "receipted_craft_and_retained_table",
      item: "crafting_table", baseline_count: baseline.inventory.crafting_table ?? 0, current_count: current.crafting_table!,
      observation_seq: observation.observation_seq, action_ids: [...acquisition, ...confirmed].map(action => action.view.action_id),
      evidence_observation_seqs: observedBeforeCraft ? [milestone!.seq, observation.observation_seq] : [observation.observation_seq] };
  }
  const item = Object.keys(current).find(name => (scenario.id === "collect_wood" ? eligibleLog(name) : name === "stone" || name === "cobblestone") &&
    current[name]! > (baseline.inventory[name] ?? 0));
  if (!item) return result("eligible_inventory_gain_not_observed");
  return { verified: true, evidence_status: "verified", reason: scenario.verifier.criterion, item,
    baseline_count: baseline.inventory[item] ?? 0, current_count: current[item]!, observation_seq: observation.observation_seq, action_ids: [] };
}
