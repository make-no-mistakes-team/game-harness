import type { Json } from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import { minecraftObservationV3Schema } from "../shared/minecraft.ts";
import type { PromotionDeclaration } from "./experience.ts";
import type { Store, StoredAction, StoredRun } from "./store.ts";
import { minecraftGoalBaselineSchema, minecraftInventoryCounts, eligibleMinecraftWood } from "./minecraft-adapter.ts";

function record(value: Json | undefined): Record<string, Json> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function inventoryGain(action: StoredAction, item: string): number {
  const evidence = record(action.view.result?.evidence);
  if (evidence?.inventory_receipt_confirmed !== true) return 0;
  const before = record(evidence.inventory_before), after = record(evidence.inventory_after);
  return before && after && typeof after[item] === "number" ? after[item] - (typeof before[item] === "number" ? before[item] : 0) : 0;
}

/** Current Minecraft qualification only; historical criteria/events never acquire new evidence identity. */
export function qualifyMinecraftExperience(store: Store, run: StoredRun, execution: SkillExecutionView, declaration: PromotionDeclaration): string[] {
  const selected = store.eventsAfter(run.run_id, declaration.predicate.event_seq - 1, 1)[0];
  if (!selected || selected.event_seq !== declaration.predicate.event_seq || !execution.started_at || !execution.ended_at ||
    selected.at < execution.started_at || selected.at > execution.ended_at || typeof run.goal === "string")
    throw new Error("Qualification requires current scoped evidence within the exact root execution interval");
  const baseline = minecraftGoalBaselineSchema.parse(run.baseline);
  if (baseline.world_id !== run.world_id || baseline.session_id !== run.session_id || baseline.epoch !== run.epoch ||
    baseline.native_boot_id !== run.native_boot_id) throw new Error("Qualification baseline does not match its actual run/session");
  const details = record(selected.details), baselineCounts = baseline.inventory;
  const removal = declaration.predicate.kind === "break_log" || declaration.predicate.kind === "goal_verified" && run.goal.goal_id === "break_log";
  let item = "", minGain = 1;
  if (declaration.predicate.kind === "goal_verified") {
    if (selected.type !== "goal.verified" || details?.status !== "verified" || details.adapter_id !== run.goal.adapter_id ||
      details.verifier_id !== run.goal.verifier?.id || details.verifier_version !== run.goal.verifier?.version || run.goal.verifier === null)
      throw new Error("Goal qualification requires its actual registered verifier result, never self-report");
    if (run.goal.goal_id === "craft_crafting_table" || run.goal.goal_id === "collect_and_craft_table") item = "crafting_table";
    else if (run.goal.goal_id === "craft_stone_pickaxe") item = "stone_pickaxe";
  } else if (declaration.predicate.kind === "inventory_gain") {
    const evidence = record(selected.details);
    const observation = evidence?.schema && record(evidence.schema)?.id === "observation_v3" ? minecraftObservationV3Schema.safeParse(evidence.data) : null;
    const scope = record(evidence?.scope);
    if (selected.type !== "adapter.evidence" || !observation?.success || observation.data.epoch !== execution.epoch ||
      observation.data.world_id !== run.world_id || observation.data.session_id !== run.session_id ||
      observation.data.compatibility_hash !== run.compatibility_hash || observation.data.native_boot_id !== execution.native_boot_id ||
      scope?.run_id !== run.run_id || scope.native_boot_id !== observation.data.native_boot_id || scope.session_id !== observation.data.session_id ||
      scope.life_id !== observation.data.life.life_id || scope.space_epoch !== observation.data.space.space_epoch || observation.data.life.status !== "alive")
      throw new Error("Inventory qualification requires a current own-player observation evidence record");
    item = declaration.predicate.item; minGain = declaration.predicate.min_gain;
    const count = minecraftInventoryCounts(observation.data.data)[item] ?? 0;
    const before = baselineCounts[item];
    if (count - (typeof before === "number" ? before : 0) < minGain) throw new Error("Declared own inventory gain is not established");
  } else if (selected.type !== "action.succeeded") throw new Error("Block qualification requires a real succeeded action record");

  const actionIds: string[] = [], seen = new Set<string>();
  let measured = 0, matched = false, cursor = 0;
  for (;;) {
    const page = store.eventsAfter(run.run_id, cursor, 500);
    for (const event of page) {
      if (event.type !== "action.succeeded" || event.at < execution.started_at || event.at > execution.ended_at) continue;
      const data = record(event.details), id = data?.action_id;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      const action = store.getAction(run.run_id, id);
      if (!action?.view.scope || action.view.origin !== "skill" || action.view.status !== "succeeded" ||
        action.view.scope.native_boot_id !== execution.native_boot_id || action.view.compatibility_hash !== run.compatibility_hash) continue;
      const owner = store.skillExecution(run.run_id, { execution_id: action.view.scope.execution_id });
      if (owner?.root_execution_id !== execution.execution_id) continue;
      const native = record(action.view.result?.evidence);
      if (native?.effect_confirmed !== true) continue;
      const removed = removal && action.request.kind === "dig" && native.block_removed === true && native.source === "server_block_update" &&
        typeof native.target_name === "string" && eligibleMinecraftWood(native.target_name) &&
        (declaration.predicate.kind !== "break_log" || id === details?.action_id);
      let gain = 0;
      if (item) gain = inventoryGain(action, item);
      else {
        const after = record(native.inventory_after);
        for (const name of Object.keys(after ?? {})) if (run.goal.goal_id === "obtain_stone" ? name === "stone" || name === "cobblestone" : eligibleMinecraftWood(name))
          gain = Math.max(gain, inventoryGain(action, name));
      }
      if (removed || gain > 0) { actionIds.push(id); measured += Math.max(0, gain); matched ||= removed || gain >= minGain; }
    }
    if (page.length < 500) break;
    cursor = page[page.length - 1]!.event_seq;
  }
  if (!actionIds.length || !matched && measured < minGain) throw new Error("Qualification requires attributable confirmed own effects, not generic success or prose");
  return actionIds;
}
