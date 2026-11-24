import { expect, spyOn, test } from "bun:test";
import { readStrategy } from "../survival-agent/strategy-options.ts";
import { AuthManager } from "../src/server/auth.ts";

test("explicit model selection accepts distinct IDs without consulting credentials or the network", () => {
  const auth = spyOn(AuthManager, "create");
  const fetch = spyOn(globalThis, "fetch");
  try {
    for (const modelId of ["fixture-strategy-a", "fixture-strategy-b"]) {
      expect(readStrategy(["--strategy", "model", "--model", `openai-codex/${modelId}`, "diamond"]).model?.model)
        .toEqual({ provider: "openai-codex", modelId });
    }
    expect(readStrategy(["diamond"])).toEqual({ game: ["diamond"] });
    expect(auth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { auth.mockRestore(); fetch.mockRestore(); }
});

test("model strategy never substitutes for an absent or malformed selection", () => {
  expect(() => readStrategy(["--strategy", "model", "diamond"])).toThrow("requires --model");
  for (const model of ["", "missing-provider", "/missing", "openai-codex/", "openai-codex/a\nb"])
    expect(() => readStrategy(["--strategy", "model", "--model", model, "diamond"])).toThrow();
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/a",
    "--model", "openai-codex/b", "diamond"])).toThrow("Invalid or repeated --model");
});

test("ordinary Model uses local controls with the vanilla goal and no skill trials", () => {
  expect(readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "iron_pickaxe"])).toEqual({
    game: ["iron_pickaxe"],
    model: { strategy: "model", model: { provider: "openai-codex", modelId: "fixture-strategy-a" }, control: "local", maxRequests: 8, startup: "off", skillTrials: "off" },
  });
});

test("the canonical diamond task keeps a finite local Model continuation in the selected save", () => {
  const game = ["diamond", "7200", "--continue-from", "2026-11-20T12-00-00.000Z-diamond-abcdef"];
  expect(readStrategy([
    "--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--skill-trials", "off", "--macro-requests", "160",
    "--task", "Obtain a diamond in Survival.", ...game,
  ])).toEqual({
    game,
    model: { strategy: "model", model: { provider: "openai-codex", modelId: "fixture-strategy-a" }, control: "local", maxRequests: 160, startup: "off", skillTrials: "off",
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
    expect(readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--task", task, goal]).model?.control).toBe("local");
  }
});

test("extra instructions require explicit constrained control and remain intact", () => {
  const task = "Obtain a diamond in Survival. Do not break exposed ore under gravel.";
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--task", task, "diamond"]))
    .toThrow("--control constrained --task TEXT diamond");
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--skill-trials", "allow", "--task", task, "diamond"]))
    .toThrow("--control constrained --task TEXT diamond");
  expect(readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--control", "constrained", "--task", task, "diamond"]).model)
    .toMatchObject({ control: "constrained", startup: "allow", skillTrials: "off", task });
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--control", "constrained", "diamond"]))
    .toThrow("--control constrained requires --task TEXT");
});

test("neither an unknown goal nor a mismatched known goal becomes an advisory task", () => {
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "emerald"])).toThrow('Unknown Survival goal "emerald"');
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--task", "Enter the Nether.", "diamond"]))
    .toThrow("--task names nether_portal, but the selected goal is diamond");
});

test("explicit skill studies preserve preset and work-program control with their former startup policy", () => {
  expect(readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--skill-trials", "allow", "diamond"]).model)
    .toMatchObject({ control: "preset", startup: "allow", skillTrials: "allow" });
  expect(readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--skill-trials", "allow", "--startup", "off",
    "--task", "Obtain a diamond in Survival.", "diamond"]).model)
    .toMatchObject({ control: "constrained", startup: "off", skillTrials: "allow" });
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--control", "local", "--skill-trials", "allow", "diamond"]))
    .toThrow("--control local cannot be combined with --skill-trials allow");
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--startup", "allow", "diamond"]))
    .toThrow("Local Model waits for a live observation");
});

test("model-free and frozen diagnostic arguments pass through without selecting the ordinary advisor", () => {
  for (const game of [["diamond"], ["--diagnostic-urgent-creeper"], ["--diagnostic-terrain", "brake-model"]]) {
    expect(readStrategy(game)).toEqual({ game });
  }
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "diamond", "180", "--replay-incident", "a-save"]))
    .toThrow("not an incident replay");
});

test("a run cannot select a non-finite request budget or repeat its control flag", () => {
  for (const value of ["0", "Infinity", "9007199254740992"]) {
    expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--macro-requests", value, "diamond"]))
      .toThrow("Invalid or repeated --macro-requests");
  }
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--control", "local", "--control", "local", "diamond"]))
    .toThrow("Invalid or repeated --control");
});
