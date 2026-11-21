import { expect, test } from "bun:test";
import { readStrategy } from "../survival-agent/strategy-options.ts";

test("ordinary Terra uses local controls with the vanilla goal and no skill trials", () => {
  expect(readStrategy(["--strategy", "terra", "iron_pickaxe"])).toEqual({
    game: ["iron_pickaxe"],
    terra: { strategy: "terra", control: "local", maxRequests: 8, startup: "off", skillTrials: "off" },
  });
});

test("the canonical diamond task keeps a finite local Terra continuation in the selected save", () => {
  const game = ["diamond", "7200", "--continue-from", "2026-11-20T12-00-00.000Z-diamond-abcdef"];
  expect(readStrategy([
    "--strategy", "terra", "--skill-trials", "off", "--macro-requests", "160",
    "--task", "Obtain a diamond in Survival.", ...game,
  ])).toEqual({
    game,
    terra: { strategy: "terra", control: "local", maxRequests: 160, startup: "off", skillTrials: "off",
      task: "Obtain a diamond in Survival." },
  });
});

test("goal labels and unrestricted canonical instructions stay local", () => {
  for (const [goal, task] of [
    ["wooden_pickaxe", "Wooden pickaxe"],
    ["stone_pickaxe", "stone_pickaxe"],
    ["stone_pickaxe", "Craft a stone pickaxe in Survival."],
    ["iron_pickaxe", " Obtain an iron pickaxe in Survival. "],
    ["diamond", "Mine a diamond."],
    ["nether_portal", "Enter the Nether in Survival."],
  ] as const) {
    expect(readStrategy(["--strategy", "terra", "--task", task, goal]).terra?.control).toBe("local");
  }
});

test("extra instructions require explicit constrained control and remain intact", () => {
  const task = "Obtain a diamond in Survival. Do not break exposed ore under gravel.";
  expect(() => readStrategy(["--strategy", "terra", "--task", task, "diamond"]))
    .toThrow("--control constrained --task TEXT diamond");
  expect(() => readStrategy(["--strategy", "terra", "--skill-trials", "allow", "--task", task, "diamond"]))
    .toThrow("--control constrained --task TEXT diamond");
  expect(readStrategy(["--strategy", "terra", "--control", "constrained", "--task", task, "diamond"]).terra)
    .toMatchObject({ control: "constrained", startup: "allow", skillTrials: "off", task });
  expect(() => readStrategy(["--strategy", "terra", "--control", "constrained", "diamond"]))
    .toThrow("--control constrained requires --task TEXT");
});

test("neither an unknown goal nor a mismatched known goal becomes an advisory task", () => {
  expect(() => readStrategy(["--strategy", "terra", "emerald"])).toThrow('Unknown Survival goal "emerald"');
  expect(() => readStrategy(["--strategy", "terra", "--task", "Enter the Nether.", "diamond"]))
    .toThrow("--task names nether_portal, but the selected goal is diamond");
});

test("explicit skill studies preserve preset and work-program control with their former startup policy", () => {
  expect(readStrategy(["--strategy", "terra", "--skill-trials", "allow", "diamond"]).terra)
    .toMatchObject({ control: "preset", startup: "allow", skillTrials: "allow" });
  expect(readStrategy(["--strategy", "terra", "--skill-trials", "allow", "--startup", "off",
    "--task", "Obtain a diamond in Survival.", "diamond"]).terra)
    .toMatchObject({ control: "constrained", startup: "off", skillTrials: "allow" });
  expect(() => readStrategy(["--strategy", "terra", "--control", "local", "--skill-trials", "allow", "diamond"]))
    .toThrow("--control local cannot be combined with --skill-trials allow");
  expect(() => readStrategy(["--strategy", "terra", "--startup", "allow", "diamond"]))
    .toThrow("Local Terra waits for a live observation");
});

test("model-free and frozen diagnostic arguments pass through without selecting the ordinary advisor", () => {
  for (const game of [["diamond"], ["--diagnostic-urgent-creeper"], ["--diagnostic-terrain", "brake-terra"]]) {
    expect(readStrategy(game)).toEqual({ game });
  }
  expect(() => readStrategy(["--strategy", "terra", "diamond", "180", "--replay-incident", "a-save"]))
    .toThrow("not an incident replay");
});

test("a run cannot select a non-finite request budget or repeat its control flag", () => {
  for (const value of ["0", "Infinity", "9007199254740992"]) {
    expect(() => readStrategy(["--strategy", "terra", "--macro-requests", value, "diamond"]))
      .toThrow("Invalid or repeated --macro-requests");
  }
  expect(() => readStrategy(["--strategy", "terra", "--control", "local", "--control", "local", "diamond"]))
    .toThrow("Invalid or repeated --control");
});
