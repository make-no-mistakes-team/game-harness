import { expect, test } from "bun:test";
import { projectSurvivalResult } from "../src/server/survival-agent.ts";
import { TERRA_MODEL_ID } from "../src/shared/survival-agent-ui.ts";

const goal = { status: "won", verification: { verified: true } };
const local = { strategy: "terra", model: TERRA_MODEL_ID, control: "local" };

test("an independently verified local goal survives an unavailable Terra account", () => {
  const run = { ...goal, strategy: { ...local, admission: "unavailable", outcome: "provider_unavailable" } };
  expect(projectSurvivalResult(run, "terra", 0)).toMatchObject({ won: true, strategyOutcome: "provider_unavailable" });
  expect(projectSurvivalResult({ ...run, verification: null }, "terra", 0).won).toBe(false);
});

test("an applied strategic decision is not an item pickup or victory", () => {
  const reported = { ...local, admission: "admitted", outcome: "strategy_applied" };
  const run = { status: "interrupted", strategy: { ...reported, status: { providerDispatches: 2, applied: 1 } } };
  expect(projectSurvivalResult(run, "terra", 1)).toMatchObject({ won: false, strategyOutcome: "strategy_applied" });
  expect(projectSurvivalResult({ ...goal, strategy: { ...reported, status: { providerDispatches: 1, applied: 0 } } },
    "terra", 0)).toMatchObject({ won: true, strategyOutcome: null });
  expect(projectSurvivalResult({ ...goal, strategy: { ...reported, control: "constrained", outcome: "no_completed_effect" } },
    "terra", 0)).toMatchObject({ won: false, strategyOutcome: "no_completed_effect" });
});
