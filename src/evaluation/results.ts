import type { GameAction, GameActionResult } from "../shared/contracts.ts";
import { receiptedInventoryDelta } from "../server/objective-metrics.ts";
import type { StoredAction } from "../server/store.ts";

export interface EvaluationOutcome {
  platform_status: "pass" | "fail" | "unknown";
  agent_status: "goal_verified" | "goal_not_verified" | "not_run" | "unknown";
  provider_status: "ok" | "error" | "not_called" | "unknown";
  goal_verified: boolean | null;
  classification_reason: string[];
}

export interface OutcomeEvidence {
  inferenceAdmitted: boolean;
  goalVerified: boolean | null;
  /** Positive evidence of readiness, correct command handling and safe drain, not run.status. */
  platformChecksComplete: boolean;
  confirmedHarnessFaults?: readonly string[];
  providerError: boolean;
  providerSettled: boolean;
  reasons?: readonly string[];
}

/** A rejected model decision is not a harness defect; a mishandled valid command is. */
export function classifyEvaluation(evidence: OutcomeEvidence): EvaluationOutcome {
  const faults = evidence.confirmedHarnessFaults ?? [];
  const platform = faults.length ? "fail" : evidence.platformChecksComplete ? "pass" : "unknown";
  return {
    platform_status: platform,
    agent_status: !evidence.inferenceAdmitted ? "not_run" : evidence.goalVerified === true
      ? "goal_verified" : evidence.goalVerified === false ? "goal_not_verified" : "unknown",
    provider_status: !evidence.inferenceAdmitted ? "not_called" : evidence.providerError
      ? "error" : evidence.providerSettled ? "ok" : "unknown",
    goal_verified: evidence.inferenceAdmitted ? evidence.goalVerified : null,
    classification_reason: [
      ...faults,
      ...(platform === "unknown" ? ["platform_evidence_incomplete"] : []),
      ...(!evidence.inferenceAdmitted ? ["inference_not_admitted"] : []),
      ...(evidence.inferenceAdmitted && evidence.goalVerified === false ? ["declared_goal_not_verified"] : []),
      ...(evidence.inferenceAdmitted && evidence.goalVerified === null ? ["goal_evidence_unavailable"] : []),
      ...(evidence.providerError ? ["provider_reported_error"] : []),
      ...(evidence.reasons ?? []),
    ],
  };
}

export interface ReportedUsage {
  uncached_input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number | null;
}
export interface UsageMetrics extends ReportedUsage {
  admissions: number;
  reported_messages: number;
  /** Actual reported subtotals remain useful even when the complete total is unknown. */
  reported_subtotal: ReportedUsage;
  coverage: "complete" | "incomplete";
  wire_attempts: null;
  subscription_cost: null;
}
const tokenKeys = ["uncached_input", "cache_read", "cache_write", "output"] as const;
const validCounter = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;

export function usageMetrics(admissions: number, messages: readonly ReportedUsage[], allAdmissionsReported: boolean): UsageMetrics {
  if (!validCounter(admissions)) throw new Error("Usage admissions must be a nonnegative safe integer");
  const subtotal: ReportedUsage = { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 };
  for (const key of tokenKeys) {
    subtotal[key] = messages.every(message => validCounter(message[key]))
      ? messages.reduce((sum, message) => sum + message[key]!, 0) : null;
  }
  const complete = allAdmissionsReported && (admissions === 0 || messages.length > 0);
  return {
    admissions, reported_messages: messages.length,
    uncached_input: complete ? subtotal.uncached_input : null,
    cache_read: complete ? subtotal.cache_read : null,
    cache_write: complete ? subtotal.cache_write : null,
    output: complete ? subtotal.output : null,
    reported_subtotal: subtotal,
    coverage: complete && tokenKeys.every(key => subtotal[key] !== null) ? "complete" : "incomplete",
    wire_attempts: null, subscription_cost: null,
  };
}

export interface ActionReceiptSample {
  request: GameAction;
  view: Pick<StoredAction["view"], "action_id" | "status" | "result">;
}
export interface ActionMetrics {
  count: number;
  by_status: Record<string, number>;
  confirmed_effects: number;
  inventory_receipts: number;
  inventory_delta: Record<string, number>;
  uncertain_outcomes: number;
  limitations: string[];
}
/** Ordinary compact private report, not a review archive or privacy-sanitized export. */
export interface EvaluationCaseReport {
  schema_version: 1;
  scenario_id: string;
  hypothesis_id: string;
  platform_evidence_revision: string;
  model_id: string;
  purpose: string;
  verifier_revision: string;
  outcome: EvaluationOutcome;
  usage: UsageMetrics;
  actions: ActionMetrics;
  tools: Array<{ name: string; count: number }>;
  provenance: {
    tier: "agent-acceptance";
    source_author: "actual_provider";
    native_artifact_sha256: string | null;
    declaration_artifact: string;
    full_evidence_artifact: string;
  };
  omissions: string[];
}
export function actionMetrics(actions: readonly ActionReceiptSample[]): ActionMetrics {
  const byStatus: Record<string, number> = {};
  let confirmedEffects = 0, inventoryReceipts = 0, uncertain = 0;
  const inventoryDelta: Record<string, number> = {};
  const unique = new Map(actions.map(action => [action.view.action_id, action]));
  for (const action of unique.values()) {
    byStatus[action.view.status] = (byStatus[action.view.status] ?? 0) + 1;
    const receipt = action.view.result?.evidence;
    const object = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : null;
    if (action.view.status === "succeeded" && action.view.result?.status === "succeeded" && object?.effect_confirmed === true) confirmedEffects++;
    if (["unknown", "accepted", "running", "cancel_requested"].includes(action.view.status) || !action.view.result) uncertain++;
    const delta = receiptedInventoryDelta(action as StoredAction);
    if (delta) {
      inventoryReceipts++;
      for (const [item, count] of Object.entries(delta)) inventoryDelta[item] = (inventoryDelta[item] ?? 0) + count;
    }
  }
  return { count: unique.size, by_status: byStatus, confirmed_effects: confirmedEffects,
    inventory_receipts: inventoryReceipts, inventory_delta: inventoryDelta, uncertain_outcomes: uncertain,
    limitations: ["Inventory deltas require confirmed native receipts; absent receipts are not zero effects.",
      "Action counts are durable admitted actions, not packets, ticks, successful goals or necessary work."] };
}

export type WaitCategory = "provider_request" | "game_action" | "tool" | "observation" | "cleanup";
export interface MeasuredInterval {
  start_ms: number;
  end_ms: number;
  category: WaitCategory;
  clock_id: string;
}
export interface MeasurementWindow { start_ms: number; end_ms: number; clock_id: string }

/** Sweep same-process monotonic endpoints. Overlaps are reported, never summed as idle time. */
export function waitCoverage(window: MeasurementWindow, intervals: readonly MeasuredInterval[]) {
  if (!Number.isFinite(window.start_ms) || !Number.isFinite(window.end_ms) || window.end_ms < window.start_ms)
    throw new Error("Invalid monotonic measurement window");
  const accepted: MeasuredInterval[] = [];
  let rejected = 0;
  for (const interval of intervals) {
    if (interval.clock_id !== window.clock_id || !Number.isFinite(interval.start_ms) || !Number.isFinite(interval.end_ms) || interval.end_ms < interval.start_ms) {
      rejected++;
      continue;
    }
    const start = Math.max(interval.start_ms, window.start_ms), end = Math.min(interval.end_ms, window.end_ms);
    if (end > start) accepted.push({ ...interval, start_ms: start, end_ms: end });
  }
  const endpoints = [...new Set([window.start_ms, window.end_ms, ...accepted.flatMap(interval => [interval.start_ms, interval.end_ms])])].sort((a, b) => a - b);
  const exclusive: Partial<Record<WaitCategory | "overlapping" | "unknown_unattributed", number>> = { overlapping: 0, unknown_unattributed: 0 };
  const categoryUnion: Partial<Record<WaitCategory, number>> = {};
  for (let index = 1; index < endpoints.length; index++) {
    const left = endpoints[index - 1]!, right = endpoints[index]!, duration = right - left;
    const categories = [...new Set(accepted.filter(interval => interval.start_ms <= left && interval.end_ms >= right).map(interval => interval.category))];
    const key = categories.length === 0 ? "unknown_unattributed" : categories.length === 1 ? categories[0]! : "overlapping";
    exclusive[key] = (exclusive[key] ?? 0) + duration;
    for (const category of categories) categoryUnion[category] = (categoryUnion[category] ?? 0) + duration;
  }
  return { window: { ...window }, clock_id: window.clock_id, elapsed_ms: window.end_ms - window.start_ms,
    exclusive_ms: exclusive, category_union_ms: categoryUnion, rejected_intervals: rejected,
    idle_ms: null,
    limitations: ["Intervals use one process's performance.now clock; cross-process timestamps are not subtracted.",
      "Observed provider intervals include host admission and settlement, not isolated network latency.",
      "Unattributed time may contain useful work, unmeasured waiting or scheduler delay; it is not proven idle.",
      "Category unions overlap and must not be added; exclusive categories partition the window."] };
}

export interface CostAttempt { outcome: EvaluationOutcome; usage: UsageMetrics | null }
/** Include every preceding failure; no token-price estimate is represented as an invoice. */
export function costToResult(attempts: readonly CostAttempt[]) {
  const first = attempts.findIndex(attempt => attempt.outcome.goal_verified === true);
  const included = first < 0 ? attempts : attempts.slice(0, first + 1);
  const totals: ReportedUsage = { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 };
  for (const key of tokenKeys) totals[key] = included.every(attempt => attempt.usage !== null && attempt.usage[key] !== null)
    ? included.reduce((sum, attempt) => sum + attempt.usage![key]!, 0) : null;
  return { result_observed: first >= 0, attempts_to_result: first >= 0 ? included.length : null,
    attempts_included: included.length, unsuccessful_attempts_included: included.filter(attempt => attempt.outcome.goal_verified !== true).length,
    admissions: included.every(attempt => attempt.usage !== null)
      ? included.reduce((sum, attempt) => sum + attempt.usage!.admissions, 0) : null, ...totals,
    wire_attempts: null, subscription_cost: null,
    limitations: ["Includes all recorded attempts through the first verified result; no success means a censored sample, not zero cost.",
      "Actual subscription monetary cost and provider wire retries are unknown."] };
}

export function catalogEstimate(usage: ReportedUsage, prices: { uncached_input: number; cache_read: number; cache_write: number; output: number } | null) {
  const known = prices !== null && tokenKeys.every(key => usage[key] !== null && Number.isFinite(prices[key]) && prices[key] >= 0);
  return { kind: "catalog_token_price_estimate" as const,
    estimate: known ? tokenKeys.reduce((sum, key) => sum + usage[key]! * prices![key] / 1_000_000, 0) : null,
    actual_subscription_cost: null,
    limitations: ["Catalog per-million-token arithmetic is an estimate, not an invoice or subscription allowance measurement."] };
}

export function receiptEvidence(result: GameActionResult | null): Record<string, unknown> | null {
  const evidence = result?.evidence;
  return evidence !== null && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : null;
}
