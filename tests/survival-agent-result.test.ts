import { expect, test } from "bun:test";
import { projectSurvivalResult } from "../src/server/survival-agent.ts";
const MODEL_IDENTITY = "openai-codex/fixture-strategy-a";

const goal = { status: "won", verification: { verified: true } };
const local = { strategy: "model", model: MODEL_IDENTITY, control: "local" };

test("an independently verified local goal survives an unavailable Model account", () => {
  const run = { ...goal, strategy: { ...local, admission: "unavailable", outcome: "provider_unavailable" } };
  expect(projectSurvivalResult(run, "model", 0, MODEL_IDENTITY)).toMatchObject({ won: true, strategyOutcome: "provider_unavailable" });
  expect(projectSurvivalResult({ ...run, verification: null }, "model", 0, MODEL_IDENTITY).won).toBe(false);
  expect(projectSurvivalResult(run, "model", 0, "openai-codex/fixture-strategy-b"))
    .toEqual({ strategyOutcome: null, won: false, local: false });
});

test("an applied strategic decision is not an item pickup or victory", () => {
  const reported = { ...local, admission: "admitted", outcome: "strategy_applied" };
  const run = { status: "interrupted", strategy: { ...reported, status: { providerDispatches: 2, applied: 1 } } };
  expect(projectSurvivalResult(run, "model", 1, MODEL_IDENTITY)).toMatchObject({ won: false, strategyOutcome: "strategy_applied" });
  expect(projectSurvivalResult({ ...goal, strategy: { ...reported, status: { providerDispatches: 1, applied: 0 } } },
    "model", 0, MODEL_IDENTITY)).toMatchObject({ won: true, strategyOutcome: null });
  expect(projectSurvivalResult({ ...goal, strategy: { ...reported, control: "constrained", outcome: "no_completed_effect" } },
    "model", 0, MODEL_IDENTITY)).toMatchObject({ won: false, strategyOutcome: "no_completed_effect" });
});
