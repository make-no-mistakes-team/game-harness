import { expect, test } from "bun:test";
import { effectScope, minecraftObservationFixture, minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import type { AdapterEvidence } from "../src/shared/contracts.ts";
import { developmentTask } from "../src/evaluation/minecraft-development.ts";
import { parseMinecraftDevelopmentArguments } from "../scripts/minecraft-development.ts";
import { scenarioGoal } from "../src/evaluation/adapter-scenarios.ts";

const base = ["--allow-native", "--allow-inference", "--auth-dir", "/existing/app", "--jar", "native.jar", "--hypothesis", "existing-hypothesis", "--evidence-revision", "current-evidence", "--model", "gpt-6.1-sol", "--purpose", "justified_acceptance", "--justification", "Bounded Minecraft development", "--seed", "20261026", "--start-description", "Curated dry fresh seed; no supplied inventory or commands.", "--task", "Make a stone pickaxe from the resources around you."];

test("development text and whole-request stone criterion never inherit a table stop", () => {
  const options = parseMinecraftDevelopmentArguments([...base, "--criterion", "craft_stone_pickaxe", "--max-requests", "12", "--run-ms", "180000", "--total-ms", "600000"]);
  const adapter = minecraftTestAdapter();
  const task = developmentTask(options.development!, adapter);
  expect(task.prompt).toBe("Make a stone pickaxe from the resources around you.");
  expect(scenarioGoal(adapter, task)).toEqual(adapter.goals.find(goal => goal.goal_id === "craft_stone_pickaxe")!);
  expect(options.caps).toEqual({ hostRequestAdmissions: 12, runMs: 180000, totalMs: 600000 });
});

test("a plain iron development request selects independent production and possession without prescribing a route", () => {
  const options = parseMinecraftDevelopmentArguments([...base.slice(0, -1), "Make an iron pickaxe.", "--criterion", "craft_iron_pickaxe"]);
  const now = Date.parse("2026-11-06T12:00:00Z"), adapter = minecraftTestAdapter("balanced", { now: () => now });
  const task = developmentTask(options.development!, adapter);
  expect(task.prompt).toBe("Make an iron pickaxe.");
  const goal = scenarioGoal(adapter, task);
  const initial = minecraftObservationFixture(adapter, { captured_at: new Date(now - 1000).toISOString() });
  const current = minecraftObservationFixture(adapter, { observation_seq: 2, captured_at: new Date(now).toISOString() });
  current.data.player.inventory = [{ name: "iron_pickaxe", count: 1, slot: 0, display_name: "Iron Pickaxe" }];
  const scope = { ...effectScope(), world_id: current.world_id, session_id: current.session_id, epoch: current.epoch,
    native_boot_id: current.native_boot_id, life_id: current.life.life_id, space_epoch: current.space.space_epoch };
  const manifest = { ...scope, goal, baseline: adapter.captureBaseline(goal, initial) };
  const possession: AdapterEvidence = { evidence_id: "development-possession", adapter_id: adapter.descriptor.adapter.id,
    schema: { id: "observation_v3", version: 3, hash: adapter.descriptor.observation.schema_hash },
    scope, observed_at: current.captured_at, data: JSON.parse(JSON.stringify(current)) };
  expect(adapter.verifyCompletion(manifest, [possession])).toMatchObject({
    status: "incomplete", reason: "authoritative_own_production_not_observed" });
  const production = adapter.effectEvidence!(scope, "development-production", { kind: "craft", item: "iron_pickaxe", executions: 1 },
    { status: "succeeded", summary: "Contract-only confirmed iron craft", evidence: { effect_confirmed: true, inventory_receipt_confirmed: true,
      inventory_before: {}, inventory_after: { iron_pickaxe: 1 } } }, new Date(now - 500).toISOString());
  expect(adapter.verifyCompletion(manifest, [...production, possession])).toMatchObject({
    status: "verified", evidence_refs: ["development-production:production", "development-possession"] });
  expect(adapter.verifyCompletion({ ...manifest }, [possession]).status).toBe("incomplete");
});

test("arbitrary natural-language task defaults to custom and has no independent verifier", () => {
  const options = parseMinecraftDevelopmentArguments([...base.slice(0,-1), "Collect wood, make a table, and keep four planks."]);
  const adapter = minecraftTestAdapter(), task = developmentTask(options.development!, adapter);
  expect(task.verifier).toBeNull();
  expect(scenarioGoal(adapter, task).verifier).toBeNull();
  expect(options.development!.seed).toBe("20261026");
});

test("development refuses unsupported restored starts, mixed studies/scenarios and missing declarations", () => {
  for (const extra of [["--scenario", "collect_and_craft_table"], ["--study", "new-allowance"], ["--restore", "world"], ["--criterion", "invented_goal"]])
    expect(() => parseMinecraftDevelopmentArguments([...base, ...extra])).toThrow();
  expect(() => parseMinecraftDevelopmentArguments(base.filter((_, i) => i !== base.indexOf("--seed") && i !== base.indexOf("--seed")+1))).toThrow();
  expect(() => parseMinecraftDevelopmentArguments(base.filter((_, i) => i !== base.indexOf("--start-description") && i !== base.indexOf("--start-description")+1))).toThrow();
});

test("single-dispatch SSE is an explicit development condition, not an ordinary default", () => {
  expect(parseMinecraftDevelopmentArguments(base).singleInferenceDispatch).toBeUndefined();
  const options = parseMinecraftDevelopmentArguments([...base, "--single-inference-dispatch"]);
  expect(options.singleInferenceDispatch).toBe(true);
  expect(options.modelId).toBe("gpt-6.1-sol");
  expect(options.authDirectory).toBe("/existing/app");
});

test("explicit low reasoning is retained in the development declaration without changing model or account", () => {
  const ordinary = parseMinecraftDevelopmentArguments(base);
  expect(ordinary.development).not.toHaveProperty("reasoning");
  const options = parseMinecraftDevelopmentArguments([...base, "--reasoning", "low", "--single-inference-dispatch"]);
  expect(options.development).toMatchObject({ reasoning: "low" });
  expect(options.modelId).toBe("gpt-6.1-sol");
  expect(options.authDirectory).toBe("/existing/app");
  expect(options.singleInferenceDispatch).toBe(true);
});

test("development rejects unsupported reasoning conditions instead of substituting an effort", () => {
  for (const effort of ["balanced", "high", "off", "invented"])
    expect(() => parseMinecraftDevelopmentArguments([...base, "--reasoning", effort])).toThrow();
  expect(() => parseMinecraftDevelopmentArguments([...base, "--reasoning"])).toThrow();
});
