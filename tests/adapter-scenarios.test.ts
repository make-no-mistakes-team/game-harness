import { expect, test } from "bun:test";
import { captureScenarioVerification, NATURAL_SCENARIOS, scenarioGoal, selectNaturalScenarios, verifyScenarioCompletion } from "../src/evaluation/adapter-scenarios.ts";
import { observationEvidence } from "../src/server/adapter-evidence.ts";
import type { GameAction, GameActionResult } from "../src/shared/contracts.ts";
import type { StoredAction } from "../src/server/store.ts";
import { effectScope, minecraftObservationFixture, minecraftTestAdapter, sha256 } from "./helpers/adapter-contract.ts";

const now = Date.parse("2026-10-25T00:00:02Z");
function fixture(id: "craft_crafting_table" | "collect_and_craft_table" | "collect_wood" = "craft_crafting_table") {
  const adapter = minecraftTestAdapter("balanced", { now: () => now });
  const initial = minecraftObservationFixture(adapter, { captured_at: new Date(now - 1000).toISOString() });
  const scenario = NATURAL_SCENARIOS.find(value => value.id === id)!;
  const context = captureScenarioVerification(adapter, scenario, "run", initial, 7);
  const current = minecraftObservationFixture(adapter, { captured_at: new Date(now).toISOString(), observation_seq: 5 });
  current.data.player.inventory = [{ name: id === "collect_wood" ? "oak_log" : "crafting_table", display_name: "Explicit test inventory", count: 1, slot: 0 }];
  const scope = { ...effectScope(), world_id: "world", session_id: "session", epoch: 1, native_boot_id: initial.native_boot_id,
    run_id: "run", run_generation: 7, life_id: 1, space_epoch: 1 };
  function produced(operation: string, item: string, before: Record<string, number>, after: Record<string, number>): StoredAction & { run_id: string } {
    const request: GameAction = { kind: "craft", item, executions: 1 };
    const result: GameActionResult = { status: "succeeded", summary: "Synthetic current native-helper receipt; not a live gameplay claim",
      evidence: { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: before, inventory_after: after } };
    return { run_id: "run", request, fingerprint: operation, view: { action_id: operation, kind: "craft", origin: "skill", execution_id: scope.execution_id,
      session_id: scope.session_id, life_id: scope.life_id, scope: { ...scope }, invocation: { kind: "skill", execution_id: scope.execution_id, source_hash: scope.source_hash },
      compatibility_hash: sha256(adapter.descriptor), status: "succeeded", summary: result.summary, result,
      started_at: new Date(now - 800).toISOString(), ended_at: new Date(now - (operation === "wood-before-consumption" ? 700 : 300)).toISOString() } };
  }
  return { adapter, scenario, context, current, scope, initial, produced };
}

test("active scenario declarations name actual registered version2 goals while defaults preserve the finite cohort", () => {
  for (const selector of [undefined, "all"] as const)
    expect(selectNaturalScenarios(selector).map(value => value.id)).toEqual(["collect_wood", "craft_crafting_table", "obtain_stone"]);
  expect(selectNaturalScenarios("collect_and_craft_table").map(value => value.id)).toEqual(["collect_and_craft_table"]);
  const f = fixture();
  expect(scenarioGoal(f.adapter, f.scenario).verifier).toEqual({ id: "minecraft_possession_v2", version: 2 });
  expect(() => scenarioGoal({ ...f.adapter, goals: [] }, f.scenario)).toThrow("register");
});

test("independent acceptance uses a separate manifest and progress, never Runtime's completed verdict", () => {
  const f = fixture("collect_and_craft_table"), runtimeManifest = { ...f.context.manifest };
  expect(runtimeManifest).not.toBe(f.context.manifest);
  const wood = f.produced("wood-before-consumption", "oak_planks", { oak_log: 1 }, { oak_planks: 4 });
  const table = f.produced("table", "crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  const facts = f.adapter.effectEvidence!(wood.view.scope!, wood.view.action_id, wood.request, wood.view.result!, wood.view.ended_at!);
  const products = f.adapter.effectEvidence!(table.view.scope!, table.view.action_id, table.request, table.view.result!, table.view.ended_at!);
  const observed = observationEvidence(f.adapter, f.scope, f.current);
  expect(f.adapter.verifyCompletion(runtimeManifest, [...facts, ...products, observed]).status).toBe("verified");
  expect(verifyScenarioCompletion(f.context, f.current, [table]).status).toBe("incomplete");
  const result = verifyScenarioCompletion(f.context, f.current, [wood, table]);
  expect(result.status).toBe("verified"); expect(result.evidence_refs).toContain("wood-before-consumption:production");
  expect(result.evidence_refs).toContain("table:production");
});

test("acceptance normalizes actual helper receipts, not arbitrary action-label or injected fact claims", () => {
  const f = fixture(), produced = f.produced("table", "crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  const injected = structuredClone(produced); injected.view.action_id = "injected"; injected.request = { kind: "look", yaw: 0, pitch: 0 };
  expect(verifyScenarioCompletion(f.context, f.current, [injected]).status).toBe("incomplete");
  expect(verifyScenarioCompletion(f.context, f.current, [produced]).status).toBe("verified");
  const unknown = fixture(), unconfirmed = unknown.produced("unknown-table", "crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
  unconfirmed.view.status = "unknown"; unconfirmed.view.result!.status = "unknown";
  expect(verifyScenarioCompletion(unknown.context, unknown.current, [unconfirmed]).status).toBe("unknown");
});

test("acceptance refuses privileged diagnostic facts and profile/run authority substitution", () => {
  for (const mutation of ["diagnostic", "profile", "run", "missing scope"] as const) {
    const f = fixture(), action = f.produced("table", "crafting_table", { oak_planks: 4 }, { crafting_table: 1 });
    if (mutation === "diagnostic") action.view.invocation = { kind: "diagnostic", execution_id: f.scope.execution_id, source_hash: f.scope.source_hash };
    if (mutation === "profile") action.view.compatibility_hash = "0".repeat(64);
    if (mutation === "run") action.run_id = "foreign-run";
    if (mutation === "missing scope") action.view.scope = null;
    expect(() => verifyScenarioCompletion(f.context, f.current, [action])).toThrow();
  }
});

test("separate own baselines and current alive freshness remain required", () => {
  const f = fixture("collect_wood");
  expect(verifyScenarioCompletion(f.context, f.current, []).status).toBe("verified");
  const stale = fixture("collect_wood"); stale.current.captured_at = new Date(now - 1001).toISOString();
  expect(verifyScenarioCompletion(stale.context, stale.current, []).status).not.toBe("verified");
  const dead = fixture("collect_wood"); dead.current.life.status = "dead";
  expect(verifyScenarioCompletion(dead.context, dead.current, []).status).not.toBe("verified");
});
