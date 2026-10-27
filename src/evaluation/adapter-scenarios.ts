import type { AdapterEvidence, AdapterGoal, ObservationV3, RuntimeAdapter, VerificationManifest, VerificationResult } from "../shared/contracts.ts";
import type { StoredAction } from "../server/store.ts";
import { observationEvidence } from "../server/adapter-evidence.ts";
import { verificationResultSchema } from "../shared/validation.ts";
import { contractHash } from "../server/adapter-contract.ts";
import type { ScenarioId } from "./scenarios.ts";

export interface MinecraftAcceptanceTask {
  readonly id: string;
  readonly prompt: string;
  readonly adapter_goal_id: string;
  readonly verifier: { readonly revision: string; readonly version: number; readonly description: string } | null;
}
export interface NaturalScenario extends MinecraftAcceptanceTask {
  readonly id: ScenarioId;
  readonly prompt: string;
  readonly adapter_goal_id: string;
  readonly verifier: { readonly revision: "minecraft_possession_v2" | "minecraft_collection_craft_v2"; readonly version: 2; readonly description: string };
}
/** Only task/criterion declarations: no evaluator-authored gameplay strategy. */
export const NATURAL_SCENARIOS: readonly NaturalScenario[] = Object.freeze([
  Object.freeze({ id: "collect_wood", prompt: "Collect wood.", adapter_goal_id: "collect_wood", verifier: Object.freeze({ revision: "minecraft_possession_v2", version: 2,
    description: "Fresh alive own inventory gains eligible wood relative to this independent run-start baseline." }) }),
  Object.freeze({ id: "craft_crafting_table", prompt: "Craft a crafting table.", adapter_goal_id: "craft_crafting_table", verifier: Object.freeze({ revision: "minecraft_possession_v2", version: 2,
    description: "Confirmed adapter-owned own item-production evidence plus a table retained in fresh alive inventory; possession alone is insufficient. The current native helper is one producer, not a GUI-production claim." }) }),
  Object.freeze({ id: "obtain_stone", prompt: "Obtain a stone or cobblestone item.", adapter_goal_id: "obtain_stone", verifier: Object.freeze({ revision: "minecraft_possession_v2", version: 2,
    description: "Fresh alive own inventory gains stone OR cobblestone relative to this independent run-start baseline." }) }),
  Object.freeze({ id: "collect_and_craft_table", prompt: "Collect wood and craft a crafting table.", adapter_goal_id: "collect_and_craft_table", verifier: Object.freeze({ revision: "minecraft_collection_craft_v2", version: 2,
    description: "Prior own eligible wood acquisition, including authoritative pre-consumption inventory, precedes confirmed own table production; fresh alive inventory retains a table. No spare log or intermediate poll is required." }) }),
] satisfies NaturalScenario[]);
export function selectNaturalScenarios(selector?: ScenarioId | "all"): readonly NaturalScenario[] {
  return NATURAL_SCENARIOS.filter(scenario => !selector || selector === "all" ? scenario.id !== "collect_and_craft_table" : scenario.id === selector);
}
export function scenarioGoal(adapter: RuntimeAdapter, scenario: MinecraftAcceptanceTask): AdapterGoal {
  const goal = adapter.goals.find(value => value.goal_id === scenario.adapter_goal_id);
  if (!goal || goal.adapter_id !== adapter.descriptor.adapter.id ||
    (goal.verifier?.id ?? null) !== (scenario.verifier?.revision ?? null) ||
    (goal.verifier?.version ?? null) !== (scenario.verifier?.version ?? null))
    throw new Error("Actual adapter does not register the predeclared scenario goal/verifier version");
  return structuredClone(goal);
}
export interface ScenarioVerification {
  readonly adapter: RuntimeAdapter;
  readonly manifest: VerificationManifest;
  /** The independent evaluator's read-invocation generation, not a Runtime execution. */
  readonly generation: number;
  readonly compatibility_hash: string;
  readonly consumed_actions: Set<string>;
}
export function captureScenarioVerification(adapter: RuntimeAdapter, scenario: MinecraftAcceptanceTask, runId: string, observation: ObservationV3, generation: number): ScenarioVerification {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Evaluator generation must be a safe counter");
  const goal = scenarioGoal(adapter, scenario);
  return { adapter, generation, compatibility_hash: contractHash(adapter.descriptor), consumed_actions: new Set(), manifest: Object.freeze({ goal,
    run_id: runId, world_id: observation.world_id, session_id: observation.session_id, epoch: observation.epoch,
    native_boot_id: observation.native_boot_id, baseline: adapter.captureBaseline(goal, observation) }) };
}
/** Same registered interpreter, separate manifest object/progress/authority; never reads Runtime's verdict. */
export function verifyScenarioCompletion(context: ScenarioVerification, observation: ObservationV3 | null,
  actions: readonly (StoredAction & { run_id: string })[]): VerificationResult {
  const { adapter, manifest } = context;
  const events: AdapterEvidence[] = [];
  for (const action of actions) {
    const view = action.view;
    if (!view.result || !["succeeded", "failed", "cancelled", "unknown"].includes(view.status) || context.consumed_actions.has(view.action_id)) continue;
    if (action.run_id !== manifest.run_id || !view.scope || !view.invocation || view.compatibility_hash !== context.compatibility_hash)
      throw new Error("Active evaluator action lacks matching sealed run/profile authority");
    if (view.invocation.kind === "diagnostic") throw new Error("Ordinary acceptance cannot consume privileged diagnostic effects");
    const at = view.ended_at ?? view.started_at;
    if (!at) throw new Error("Terminal evaluator action has no actual outcome timestamp");
    if (adapter.effectEvidence) events.push(...adapter.effectEvidence(view.scope, view.action_id, action.request, view.result, at));
    context.consumed_actions.add(view.action_id);
  }
  if (observation) events.push(observationEvidence(adapter, { run_id: manifest.run_id, world_id: manifest.world_id,
    session_id: manifest.session_id, epoch: manifest.epoch, native_boot_id: manifest.native_boot_id,
    run_generation: context.generation, life_id: observation.life.life_id, space_epoch: observation.space.space_epoch }, observation));
  const result = verificationResultSchema.parse(adapter.verifyCompletion(manifest, events));
  if (!manifest.goal.verifier || result.adapter_id !== manifest.goal.adapter_id || result.verifier_id !== manifest.goal.verifier.id || result.verifier_version !== manifest.goal.verifier.version)
    throw new Error("Independent adapter verdict mismatches the declared verifier tuple");
  return result;
}
