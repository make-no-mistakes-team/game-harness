import { expect, test } from "bun:test";
import { actionMetrics, catalogEstimate, classifyEvaluation, costToResult, usageMetrics, waitCoverage, type ActionReceiptSample } from "../src/evaluation/results.ts";

const outcome = (verified: boolean) => classifyEvaluation({ inferenceAdmitted: true, goalVerified: verified,
  platformChecksComplete: true, providerError: false, providerSettled: true });

test("model false guards, invalid arguments and expired deadlines do not imply a platform failure", () => {
  for (const reason of ["game_guard_false", "model_arguments_rejected", "model_program_deadline_expired"]) {
    const result = classifyEvaluation({ inferenceAdmitted: true, goalVerified: false, platformChecksComplete: true,
      providerError: false, providerSettled: true, reasons: [reason] });
    expect(result.platform_status).toBe("pass");
    expect(result.agent_status).toBe("goal_not_verified");
    expect(result.provider_status).toBe("ok");
    expect(result.classification_reason).toContain(reason);
  }
});

test("mishandling a valid command is a harness failure, even if the goal was achieved", () => {
  const result = classifyEvaluation({ inferenceAdmitted: true, goalVerified: true, platformChecksComplete: true,
    confirmedHarnessFaults: ["valid_command_misprocessed"], providerError: false, providerSettled: true });
  expect(result.platform_status).toBe("fail");
  expect(result.agent_status).toBe("goal_verified");
  expect(result.classification_reason).toContain("valid_command_misprocessed");
});

test("provider failure, platform evidence and absent inference remain independent", () => {
  expect(classifyEvaluation({ inferenceAdmitted: true, goalVerified: false, platformChecksComplete: true,
    providerError: true, providerSettled: true })).toMatchObject({ platform_status: "pass", provider_status: "error", agent_status: "goal_not_verified" });
  expect(classifyEvaluation({ inferenceAdmitted: false, goalVerified: null, platformChecksComplete: false,
    providerError: false, providerSettled: false })).toMatchObject({ platform_status: "unknown", provider_status: "not_called", agent_status: "not_run", goal_verified: null });
  expect(classifyEvaluation({ inferenceAdmitted: true, goalVerified: null, platformChecksComplete: false,
    providerError: false, providerSettled: false })).toMatchObject({ platform_status: "unknown", provider_status: "unknown", agent_status: "unknown" });
});

test("actual token subtotals do not turn missing settlements into zero usage or wire counts", () => {
  const report = usageMetrics(2, [{ uncached_input: 5, cache_read: 10, cache_write: 0, output: 4 }], false);
  expect(report.uncached_input).toBeNull();
  expect(report.output).toBeNull();
  expect(report.reported_subtotal).toEqual({ uncached_input: 5, cache_read: 10, cache_write: 0, output: 4 });
  expect(report.coverage).toBe("incomplete");
  expect(report.wire_attempts).toBeNull();
  expect(report.subscription_cost).toBeNull();
  expect(usageMetrics(1, [{ uncached_input: null, cache_read: 0, cache_write: 0, output: 4 }], true).uncached_input).toBeNull();
});

test("cost to first result includes unsuccessful attempts and propagates missing usage", () => {
  const usage = usageMetrics(1, [{ uncached_input: 5, cache_read: 2, cache_write: 0, output: 4 }], true);
  const result = costToResult([{ outcome: outcome(false), usage }, { outcome: outcome(true), usage }, { outcome: outcome(false), usage }]);
  expect(result.attempts_to_result).toBe(2);
  expect(result.unsuccessful_attempts_included).toBe(1);
  expect(result.uncached_input).toBe(10);
  expect(result.admissions).toBe(2);
  expect(costToResult([{ outcome: outcome(false), usage: usageMetrics(1, [], false) }])).toMatchObject({
    result_observed: false, attempts_to_result: null, attempts_included: 1, output: null, subscription_cost: null,
  });
  expect(costToResult([{ outcome: outcome(false), usage: null }, { outcome: outcome(true), usage }])).toMatchObject({
    attempts_to_result: 2, admissions: null, uncached_input: null,
  });
  expect(catalogEstimate(usage, { uncached_input: 1, cache_read: 0.1, cache_write: 1, output: 2 })).toMatchObject({
    kind: "catalog_token_price_estimate", actual_subscription_cost: null,
  });
});

test("action receipts count uncertain results without inventing confirmed inventory gains", () => {
  const uncertain: ActionReceiptSample = { request: { kind: "dig", target_id: "observed" }, view: {
    action_id: "a", status: "unknown", result: { status: "unknown", summary: "Uncertain", evidence: {
      inventory_before: { cobblestone: 0 }, inventory_after: { cobblestone: 1 }, effect_confirmed: false,
    } },
  } };
  const report = actionMetrics([uncertain, uncertain]);
  expect(report.count).toBe(1);
  expect(report.uncertain_outcomes).toBe(1);
  expect(report.inventory_receipts).toBe(0);
  expect(report.inventory_delta).toEqual({});
  const confirmed: ActionReceiptSample = { ...uncertain, view: { ...uncertain.view, action_id: "b", status: "succeeded",
    result: { status: "succeeded", summary: "Receipt", evidence: { inventory_receipt_confirmed: true,
      inventory_before: { cobblestone: 0 }, inventory_after: { cobblestone: 1 }, effect_confirmed: true } } } };
  expect(actionMetrics([uncertain, confirmed])).toMatchObject({ count: 2, confirmed_effects: 1, inventory_receipts: 1, inventory_delta: { cobblestone: 1 } });
});

test("wait coverage unions nested spans and partitions overlap without labeling unknown time idle", () => {
  const report = waitCoverage({ start_ms: 0, end_ms: 120, clock_id: "host" }, [
    { start_ms: 0, end_ms: 60, category: "provider_request", clock_id: "host" },
    { start_ms: 40, end_ms: 100, category: "provider_request", clock_id: "host" },
    { start_ms: 20, end_ms: 80, category: "game_action", clock_id: "host" },
    { start_ms: 1, end_ms: 119, category: "tool", clock_id: "native" },
  ]);
  expect(report.exclusive_ms).toEqual({ overlapping: 60, unknown_unattributed: 20, provider_request: 40 });
  expect(report.category_union_ms).toEqual({ provider_request: 100, game_action: 60 });
  expect(Object.values(report.exclusive_ms).reduce((sum, duration) => sum + duration!, 0)).toBe(120);
  expect(report.idle_ms).toBeNull();
  expect(report.rejected_intervals).toBe(1);
});

test("wait coverage clips same-clock spans and rejects invalid intervals", () => {
  const report = waitCoverage({ start_ms: 10, end_ms: 20, clock_id: "host" }, [
    { start_ms: -10, end_ms: 15, category: "observation", clock_id: "host" },
    { start_ms: 17, end_ms: 16, category: "tool", clock_id: "host" },
  ]);
  expect(report.exclusive_ms).toEqual({ overlapping: 0, unknown_unattributed: 5, observation: 5 });
  expect(report.rejected_intervals).toBe(1);
});
