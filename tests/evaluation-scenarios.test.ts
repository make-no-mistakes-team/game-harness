import { expect, test } from "bun:test";
import type { HistoricalObservationV2 } from "../src/shared/minecraft.ts";
import { HISTORICAL_NATURAL_SCENARIOS_V1, NATURAL_WORLD_CONDITIONS, captureHistoricalGoalBaselineV1, createHistoricalScenarioProgressV1, verifyHistoricalScenarioGoalV1, type GoalAction, type ScenarioId } from "../src/evaluation/scenarios.ts";
import * as scenarios from "../src/evaluation/scenarios.ts";
import { parseAgentAcceptanceArguments } from "../scripts/agent-acceptance.ts";

function observation(inventory: Record<string, number> = {}, seq = 1): HistoricalObservationV2 {
  return { schema_version: 2, world_id: "world", session_id: "session", epoch: 1, observation_seq: seq,
    captured_at: new Date(Date.parse("2026-10-22T00:00:00Z") + (seq - 1) * 1000).toISOString(), profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2",
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false,
      inventory: Object.entries(inventory).map(([name, count], slot) => ({ name, display_name: name, count, slot })) },
    blocks: [{ id: "visible-stone", name: "stone", position: { x: 1, y: 63, z: 1 }, current: true, observed_at: "2026-10-22T00:00:00Z" }],
    entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 },
  };
}
const scenario = (id: ScenarioId) => HISTORICAL_NATURAL_SCENARIOS_V1.find(value => value.id === id)!;
function craft(confirmed: boolean, runId = "run"): GoalAction {
  return { run_id: runId, fingerprint: "fixture", request: { kind: "craft", item: "crafting_table", executions: 1 }, view: {
    action_id: "craft", kind: "craft", session_id: "session", life_id: 1, status: "succeeded", origin: "skill", execution_id: "execution",
    scope: null, invocation: null, compatibility_hash: null,
    summary: "Craft receipt", started_at: "2026-10-22T00:00:01Z", ended_at: "2026-10-22T00:00:02Z",
    result: { status: "succeeded", summary: "Craft result", evidence: {
      inventory_receipt_confirmed: confirmed, inventory_before: { crafting_table: 1 }, inventory_after: { crafting_table: 2 }, effect_confirmed: true,
    } },
  } };
}

test("the finite scenario catalog declares plain goals and ordinary fixed world conditions", () => {
  expect(NATURAL_WORLD_CONDITIONS).toMatchObject({ gamemode: "survival", difficulty: "normal", freshWorldPerCase: true,
    suppliedInventory: false, consoleCommands: false, levelType: "minecraft:normal" });
});

test("wood requires inventory gain, not visible blocks, an old item, planks or a block removal", () => {
  const baseline = captureHistoricalGoalBaselineV1("run", observation({ oak_log: 1 }));
  expect(verifyHistoricalScenarioGoalV1(scenario("collect_wood"), baseline, "run", observation({ oak_log: 1 }, 2), []).verified).toBe(false);
  expect(verifyHistoricalScenarioGoalV1(scenario("collect_wood"), baseline, "run", observation({ oak_planks: 4 }, 2), []).verified).toBe(false);
  for (const item of ["oak_log", "stripped_oak_wood", "warped_stem", "crimson_hyphae"]) {
    expect(verifyHistoricalScenarioGoalV1(scenario("collect_wood"), baseline, "run", observation({ [item]: 2 }, 2), []).verified).toBe(true);
  }
});

test("stone explicitly accepts either stone or cobblestone inventory gain, not a visible stone block", () => {
  const baseline = captureHistoricalGoalBaselineV1("run", observation({ stone: 1, cobblestone: 1 }));
  expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", observation({ stone: 1, cobblestone: 1 }, 2), []).verified).toBe(false);
  for (const item of ["stone", "cobblestone"]) {
    expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", observation({ [item]: 2 }, 2), []).verified).toBe(true);
  }
  expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", observation({ stone_pickaxe: 1, mossy_cobblestone: 2 }, 2), []).verified).toBe(false);
});

test("crafting an existing inventory item is different from mere possession or pickup", () => {
  const baseline = captureHistoricalGoalBaselineV1("run", observation({ crafting_table: 1 }));
  expect(verifyHistoricalScenarioGoalV1(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 2 }, 2), []).verified).toBe(false);
  expect(verifyHistoricalScenarioGoalV1(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 2 }, 2), [craft(true)])).toMatchObject({
    verified: true, action_ids: ["craft"], baseline_count: 1, current_count: 2,
  });
  expect(verifyHistoricalScenarioGoalV1(scenario("craft_crafting_table"), baseline, "run", observation({}, 2), [craft(true)]).verified).toBe(false);
  expect(verifyHistoricalScenarioGoalV1(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 2 }, 2), [craft(false)])).toMatchObject({
    verified: false, evidence_status: "insufficient", reason: "craft_receipt_unconfirmed",
  });
});

test("craft receipts from another run or session never establish this run's craft", () => {
  const baseline = captureHistoricalGoalBaselineV1("run", observation());
  const foreignSession = craft(true);
  foreignSession.view.session_id = "other-session";
  for (const action of [craft(true, "other-run"), foreignSession])
    expect(verifyHistoricalScenarioGoalV1(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 1 }, 2), [action]).verified).toBe(false);
  const uncertain = craft(true);
  uncertain.view.status = "unknown";
  expect(verifyHistoricalScenarioGoalV1(scenario("craft_crafting_table"), baseline, "run", observation({ crafting_table: 1 }, 2), [uncertain]).verified).toBe(false);
});

test("goal scope rejects changed world, session, epoch, run and stale observations", () => {
  const baseline = captureHistoricalGoalBaselineV1("run", observation());
  for (const patch of [{ world_id: "other" }, { session_id: "other" }, { epoch: 2 }, { observation_seq: 1 }]) {
    const result = verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", { ...observation({ cobblestone: 1 }, 2), ...patch }, []);
    expect(result.verified).toBe(false);
    expect(result.evidence_status).toBe("insufficient");
  }
  expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "different-run", observation({ stone: 1 }, 2), []).verified).toBe(false);
  expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", null, []).evidence_status).toBe("insufficient");
});

test("ordinary explicit respawn does not replace the baseline and dead inventory never verifies", () => {
  const initial = observation({ stone: 2 });
  const baseline = captureHistoricalGoalBaselineV1("run", initial);
  initial.player.inventory[0]!.count = 99;
  expect(baseline.inventory.stone).toBe(2);
  const freshLife = observation({ stone: 3 }, 4);
  freshLife.life.life_id = 2;
  expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", freshLife, []).verified).toBe(true);
  freshLife.life.status = "dead";
  expect(verifyHistoricalScenarioGoalV1(scenario("obtain_stone"), baseline, "run", freshLife, []).verified).toBe(false);
});

function combinedScenario() {
  const selected = HISTORICAL_NATURAL_SCENARIOS_V1.find(value => String(value.id) === "collect_and_craft_table");
  expect(selected).toBeDefined();
  return selected!;
}
function woodReceipt(): GoalAction {
  const action = craft(true);
  action.view.action_id = "own-wood";
  action.request = { kind: "dig", target_id: "observed-wood" };
  action.view.kind = "dig";
  action.view.started_at = "2026-10-22T00:00:00.100Z";
  action.view.ended_at = "2026-10-22T00:00:00.500Z";
  action.view.result = { status: "succeeded", summary: "Synthetic confirmed own acquisition receipt", evidence: {
    inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { oak_log: 1 }, effect_confirmed: true,
  } };
  return action;
}
function nativePlanksReceipt(): GoalAction {
  const action = woodReceipt();
  action.view.action_id = "own-planks";
  action.request = { kind: "craft", item: "oak_planks", executions: 1 };
  action.view.kind = "craft";
  action.view.result = { status: "succeeded", summary: "Native-shaped confirmed log consumption receipt", evidence: {
    inventory_receipt_confirmed: true, inventory_before: { oak_log: 1 }, inventory_after: { oak_planks: 4 }, effect_confirmed: true,
  } };
  return action;
}

test("combined natural goal waits for crafting rather than stopping at wood", () => {
  const selected = combinedScenario();
  expect(selected.prompt).toBe("Collect wood and craft a crafting table.");
  expect(selected.runtimeGoal).toBe("craft_crafting_table");
  const baseline = captureHistoricalGoalBaselineV1("run", observation());
  expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ oak_log: 1 }, 2), [woodReceipt()]).verified).toBe(false);
});

test("prior confirmed own wood receipt survives consumption between independent verifier polls", () => {
  const selected = combinedScenario(), baseline = captureHistoricalGoalBaselineV1("run", observation());
  const crafted = craft(true);
  crafted.view.result!.evidence = { inventory_receipt_confirmed: true, inventory_before: { oak_planks: 4 },
    inventory_after: { crafting_table: 1 }, effect_confirmed: true };
  const result = verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 4), [woodReceipt(), crafted]);
  expect(result.verified).toBe(true);
  expect(result.action_ids).toContain("own-wood");
  expect(result.action_ids).toContain("craft");
  expect(result.observation_seq).toBe(4);
});

test("native pre-consumption inventory proves collected wood without a dig inventory receipt, intermediate poll or spare logs", () => {
  const selected = combinedScenario(), baseline = captureHistoricalGoalBaselineV1("run", observation());
  const crafted = craft(true);
  crafted.view.result!.evidence = { inventory_receipt_confirmed: true, inventory_before: { oak_planks: 4 },
    inventory_after: { crafting_table: 1 }, effect_confirmed: true };
  const result = verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 4),
    [nativePlanksReceipt(), crafted], createHistoricalScenarioProgressV1(baseline));
  expect(result).toMatchObject({ verified: true, evidence_status: "verified", current_count: 1, observation_seq: 4 });
  expect(result.action_ids).toEqual(["own-planks", "craft"]);
});

test("pre-consumption inventory cannot borrow baseline wood or bypass native receipt authority", () => {
  const selected = combinedScenario();
  const crafted = craft(true);
  crafted.view.result!.evidence = { inventory_receipt_confirmed: true, inventory_before: { oak_planks: 4 },
    inventory_after: { crafting_table: 1 }, effect_confirmed: true };
  const unchangedBaseline = captureHistoricalGoalBaselineV1("run", observation({ oak_log: 1 }));
  expect(verifyHistoricalScenarioGoalV1(selected, unchangedBaseline, "run", observation({ crafting_table: 1 }, 4),
    [nativePlanksReceipt(), crafted]).verified).toBe(false);
  for (const mutate of [
    (action: GoalAction) => { action.run_id = "other-run"; },
    (action: GoalAction) => { action.view.session_id = "other-session"; },
    (action: GoalAction) => { action.view.life_id = 2; },
    (action: GoalAction) => { action.view.status = "unknown"; },
    (action: GoalAction) => { action.view.result!.status = "failed"; },
    (action: GoalAction) => { (action.view.result!.evidence as Record<string, unknown>).effect_confirmed = false; },
    (action: GoalAction) => { (action.view.result!.evidence as Record<string, unknown>).inventory_receipt_confirmed = false; },
    (action: GoalAction) => { (action.view.result!.evidence as Record<string, unknown>).inventory_before = { oak_planks: 4 }; },
    (action: GoalAction) => { action.view.started_at = "2026-10-21T23:59:58Z"; action.view.ended_at = "2026-10-21T23:59:59Z"; },
    (action: GoalAction) => { action.view.started_at = "2026-10-22T00:00:03Z"; action.view.ended_at = "2026-10-22T00:00:04Z"; },
  ]) {
    const baseline = captureHistoricalGoalBaselineV1("run", observation()), receipt = nativePlanksReceipt();
    mutate(receipt);
    expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 4),
      [receipt, crafted]).verified).toBe(false);
  }
});

test("combined goal latches observed wood acquisition even after it is consumed", () => {
  const selected = combinedScenario(), baseline = captureHistoricalGoalBaselineV1("run", observation());
  const progress = createHistoricalScenarioProgressV1(baseline);
  expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ oak_log: 1 }, 2), [], progress).verified).toBe(false);
  const result = verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 3), [craft(true)], progress);
  expect(result.verified).toBe(true);
  expect(result.action_ids).toContain("craft");
  expect(result.evidence_observation_seqs).toContain(2);
  expect(progress.wood).toMatchObject({ seq: 2, item: "oak_log", count: 1, source: "authorized_alive_observation" });
  const separate = createHistoricalScenarioProgressV1(baseline);
  expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 3), [craft(true)], separate).verified).toBe(false);
});

test("combined goal rejects unrelated, stale, foreign and unknown acquisition receipts", () => {
  const selected = combinedScenario();
  for (const mutate of [
    (action: GoalAction) => { action.run_id = "other-run"; },
    (action: GoalAction) => { action.view.session_id = "other-session"; },
    (action: GoalAction) => { action.view.life_id = 2; },
    (action: GoalAction) => { action.view.status = "unknown"; },
    (action: GoalAction) => { action.view.result!.status = "failed"; },
    (action: GoalAction) => { (action.view.result!.evidence as Record<string, unknown>).effect_confirmed = false; },
    (action: GoalAction) => { action.view.result!.evidence = { inventory_receipt_confirmed: false, inventory_before: {}, inventory_after: { oak_log: 1 } }; },
    (action: GoalAction) => { action.view.result!.evidence = { inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { oak_planks: 4 } }; },
    (action: GoalAction) => { action.view.ended_at = "2026-10-21T23:59:59Z"; },
    (action: GoalAction) => { action.view.started_at = "2026-10-22T00:00:03Z"; action.view.ended_at = "2026-10-22T00:00:04Z"; },
  ]) {
    const baseline = captureHistoricalGoalBaselineV1("run", observation()), acquired = woodReceipt();
    mutate(acquired);
    expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 4), [acquired, craft(true)]).verified).toBe(false);
  }
  const baseline = captureHistoricalGoalBaselineV1("run", observation());
  expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 4), [craft(true)]).verified).toBe(false);
});

test("combined goal requires this run's confirmed craft and fresh alive retained table", () => {
  const selected = combinedScenario();
  for (const receipt of [craft(false), craft(true, "other-run"), { ...craft(true), view: { ...craft(true).view, status: "unknown" as const } }]) {
    const baseline = captureHistoricalGoalBaselineV1("run", observation());
    expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", observation({ crafting_table: 1 }, 4), [woodReceipt(), receipt]).verified).toBe(false);
  }
  for (const current of [observation({}, 4), { ...observation({ crafting_table: 1 }, 4), life: { ...observation().life, status: "dead" as const } },
    observation({ crafting_table: 1 }, 1), { ...observation({ crafting_table: 1 }, 4), session_id: "foreign" }]) {
    const baseline = captureHistoricalGoalBaselineV1("run", observation());
    expect(verifyHistoricalScenarioGoalV1(selected, baseline, "run", current, [woodReceipt(), craft(true)]).verified).toBe(false);
  }
});

test("default and all acceptance selectors preserve the old finite inference cohort", () => {
  // Same exported selector must be consumed by the acceptance runner; no live native/inference setup here.
  expect(typeof scenarios.selectHistoricalNaturalScenariosV1).toBe("function");
  for (const selector of [undefined, "all"] as const) {
    expect(scenarios.selectHistoricalNaturalScenariosV1(selector).map(value => value.id)).toEqual(["collect_wood", "craft_crafting_table", "obtain_stone"]);
  }
  expect(scenarios.selectHistoricalNaturalScenariosV1("collect_and_craft_table").map(value => value.id)).toEqual(["collect_and_craft_table"]);
  expect(parseAgentAcceptanceArguments(["--scenario", "collect_and_craft_table", "--hypothesis", "test-only-combined",
    "--evidence-revision", "test-only-no-inference"]).scenario).toBe("collect_and_craft_table");
});
