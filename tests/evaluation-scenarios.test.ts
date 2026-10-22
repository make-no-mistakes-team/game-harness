import { expect, test } from "bun:test";
import type { Observation } from "../src/shared/contracts.ts";
import { NATURAL_SCENARIOS, NATURAL_WORLD_CONDITIONS, captureGoalBaseline, verifyScenarioGoal, type GoalAction, type ScenarioId } from "../src/evaluation/scenarios.ts";

function observation(inventory: Record<string, number> = {}, seq = 1): Observation {
  return { schema_version: 2, world_id: "world", session_id: "session", epoch: 1, observation_seq: seq,
    captured_at: "2026-10-22T00:00:00Z", profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false,
      inventory: Object.entries(inventory).map(([name, count], slot) => ({ name, display_name: name, count, slot })) },
    blocks: [{ id: "visible-stone", name: "stone", position: { x: 1, y: 63, z: 1 }, current: true, observed_at: "2026-10-22T00:00:00Z" }],
    entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
  };
}
const scenario = (id: ScenarioId) => NATURAL_SCENARIOS.find(value => value.id === id)!;
function craft(confirmed: boolean, runId = "run"): GoalAction {
  return { run_id: runId, fingerprint: "fixture", request: { kind: "craft", item: "crafting_table", executions: 1 }, view: {
    action_id: "craft", kind: "craft", session_id: "session", life_id: 1, status: "succeeded", origin: "skill", execution_id: "execution",
    summary: "Craft receipt", started_at: "2026-10-22T00:00:01Z", ended_at: "2026-10-22T00:00:02Z",
    result: { status: "succeeded", summary: "Craft result", evidence: {
      inventory_receipt_confirmed: confirmed, inventory_before: { crafting_table: 1 }, inventory_after: { crafting_table: 2 }, effect_confirmed: true,
    } },
  } };
}

test("the finite scenario catalog declares plain goals and ordinary fixed world conditions", () => {
  expect(NATURAL_SCENARIOS.map(value => value.prompt)).toEqual(["Collect wood.", "Craft a crafting table.", "Obtain a stone or cobblestone item."]);
  expect(NATURAL_SCENARIOS.every(value => value.verifier.description.length > 0)).toBe(true);
  expect(NATURAL_WORLD_CONDITIONS).toMatchObject({ gamemode: "survival", difficulty: "normal", freshWorldPerCase: true,
    suppliedInventory: false, consoleCommands: false, levelType: "minecraft:normal" });
});

test("wood requires inventory gain, not visible blocks, an old item, planks or a block removal", () => {
  const baseline = captureGoalBaseline("run", observation({ oak_log: 1 }));
  expect(verifyScenarioGoal(scenario("collect_wood"), baseline, "run", observation({ oak_log: 1 }, 2), []).verified).toBe(false);
  expect(verifyScenarioGoal(scenario("collect_wood"), baseline, "run", observation({ oak_planks: 4 }, 2), []).verified).toBe(false);
  for (const item of ["oak_log", "stripped_oak_wood", "warped_stem", "crimson_hyphae"]) {
    expect(verifyScenarioGoal(scenario("collect_wood"), baseline, "run", observation({ [item]: 2 }, 2), []).verified).toBe(true);
  }
});

test("stone explicitly accepts either stone or cobblestone inventory gain, not a visible stone block", () => {
  const baseline = captureGoalBaseline("run", observation({ stone: 1, cobblestone: 1 }));
  expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", observation({ stone: 1, cobblestone: 1 }, 2), []).verified).toBe(false);
  for (const item of ["stone", "cobblestone"]) {
    expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", observation({ [item]: 2 }, 2), []).verified).toBe(true);
  }
  expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", observation({ stone_pickaxe: 1, mossy_cobblestone: 2 }, 2), []).verified).toBe(false);
});

test("crafting an existing inventory item is different from mere possession or pickup", () => {
  const baseline = captureGoalBaseline("run", observation({ crafting_table: 1 }));
  expect(verifyScenarioGoal(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 2 }, 2), []).verified).toBe(false);
  expect(verifyScenarioGoal(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 2 }, 2), [craft(true)])).toMatchObject({
    verified: true, action_ids: ["craft"], baseline_count: 1, current_count: 2,
  });
  expect(verifyScenarioGoal(scenario("craft_crafting_table"), baseline, "run", observation({}, 2), [craft(true)]).verified).toBe(false);
  expect(verifyScenarioGoal(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 2 }, 2), [craft(false)])).toMatchObject({
    verified: false, evidence_status: "insufficient", reason: "craft_receipt_unconfirmed",
  });
});

test("craft receipts from another run or session never establish this run's craft", () => {
  const baseline = captureGoalBaseline("run", observation());
  const foreignSession = craft(true);
  foreignSession.view.session_id = "other-session";
  for (const action of [craft(true, "other-run"), foreignSession])
    expect(verifyScenarioGoal(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 1 }, 2), [action]).verified).toBe(false);
  const uncertain = craft(true);
  uncertain.view.status = "unknown";
  expect(verifyScenarioGoal(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 1 }, 2), [uncertain]).verified).toBe(false);
});

test("goal scope rejects changed world, session, epoch, run and stale observations", () => {
  const baseline = captureGoalBaseline("run", observation());
  for (const patch of [{ world_id: "other" }, { session_id: "other" }, { epoch: 2 }, { observation_seq: 1 }]) {
    const result = verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", { ...observation({ cobblestone: 1 }, 2), ...patch }, []);
    expect(result.verified).toBe(false);
    expect(result.evidence_status).toBe("insufficient");
  }
  expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "different-run", observation({ stone: 1 }, 2), []).verified).toBe(false);
  expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", null, []).evidence_status).toBe("insufficient");
});

test("ordinary explicit respawn does not replace the baseline and dead inventory never verifies", () => {
  const initial = observation({ stone: 2 });
  const baseline = captureGoalBaseline("run", initial);
  initial.player.inventory[0]!.count = 99;
  expect(baseline.inventory.stone).toBe(2);
  const freshLife = observation({ stone: 3 }, 4);
  freshLife.life.life_id = 2;
  expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", freshLife, []).verified).toBe(true);
  freshLife.life.status = "dead";
  expect(verifyScenarioGoal(scenario("obtain_stone"), baseline, "run", freshLife, []).verified).toBe(false);
});
