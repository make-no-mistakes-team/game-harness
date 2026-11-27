import { expect, spyOn, test } from "bun:test";
import { readStrategy } from "../src/agent/strategy-options.ts";
import { AuthManager } from "../src/auth/manager.ts";

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
    model: { strategy: "model", model: { provider: "openai-codex", modelId: "fixture-strategy-a" }, maxRequests: 8 },
  });
});

test("the canonical diamond task keeps a finite local Model continuation in the selected save", () => {
  const game = ["diamond", "7200", "--continue-from", "2026-11-20T12-00-00.000Z-diamond-abcdef"];
  expect(readStrategy([
    "--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--macro-requests", "160",
    "--task", "Obtain a diamond in Survival.", ...game,
  ])).toEqual({
    game,
    model: { strategy: "model", model: { provider: "openai-codex", modelId: "fixture-strategy-a" }, maxRequests: 160,
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
    expect(readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--task", task, goal]).model?.strategy).toBe("model");
  }
});

test("neither an unknown goal nor a mismatched known goal becomes an advisory task", () => {
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "emerald"])).toThrow('Unknown Survival goal "emerald"');
  expect(() => readStrategy(["--strategy", "model", "--model", "openai-codex/fixture-strategy-a", "--task", "Enter the Nether.", "diamond"]))
    .toThrow("--task names nether_portal, but the selected goal is diamond");
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

});

test("retired work-program and skill-study controls are rejected rather than routed to another driver", () => {
  for (const option of ["--control", "--skill-trials", "--startup"])
    expect(() => readStrategy(["--strategy", "model", "--model", "fixture/model", option, "allow", "diamond"]))
      .toThrow("supported strategy options");
});
