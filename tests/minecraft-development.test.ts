import { expect, test } from "bun:test";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";
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
