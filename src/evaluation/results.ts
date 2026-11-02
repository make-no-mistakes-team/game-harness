import type { GameAction, GameActionResult, ReportedUsage, RequestUsageEvidence } from "../shared/contracts.ts";
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

export interface UsageMetrics extends ReportedUsage {
  schema_version: 2;
  admissions: number;
  reported_messages: number;
  /** Actual reported subtotals remain useful even when the complete total is unknown. */
  reported_subtotal: ReportedUsage;
  event_coverage: "complete" | "incomplete";
  consumption_coverage: "known" | "partial" | "unknown";
  consumption_scope: "observed_logical_admissions";
  wire_attempts: null;
  subscription_cost: null;
}
const tokenKeys = ["uncached_input", "cache_read", "cache_write", "output"] as const;
const validCounter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function usageMetrics(input: { admissions: number; admitted_request_ids: readonly string[];
  messages: readonly RequestUsageEvidence[]; events_omitted: boolean;
  /** Finalized terminal facts without an SDK usage-message event. */
  additional_terminal_evidence?: readonly RequestUsageEvidence[] }): UsageMetrics {
  const { admissions } = input;
  if (!validCounter(admissions)) throw new Error("Usage admissions must be a nonnegative safe integer");
  const ids = new Set(input.admitted_request_ids);
  const messages = new Map<string, RequestUsageEvidence>();
  for (const message of input.messages) {
    if (ids.has(message.request_id) && !messages.has(message.request_id)) messages.set(message.request_id, message);
  }
  const eventComplete = !input.events_omitted && ids.size === admissions && messages.size === admissions;
  const consumption = input.additional_terminal_evidence?.length ? new Map(messages) : messages;
  for (const evidence of input.additional_terminal_evidence ?? []) {
    if (!ids.has(evidence.request_id)) continue;
    const prior = consumption.get(evidence.request_id);
    consumption.set(evidence.request_id, prior === undefined ? evidence : {
      ...prior, provider_terminal: prior.provider_terminal ?? evidence.provider_terminal,
      unaccounted_response_ids: prior.unaccounted_response_ids.length ? prior.unaccounted_response_ids : evidence.unaccounted_response_ids,
    });
  }
  const consumptionObserved = !input.events_omitted && ids.size === admissions && consumption.size === admissions;
  const subtotal: ReportedUsage = { uncached_input: null, cache_read: null, cache_write: null, output: null };
  const totals: ReportedUsage = { uncached_input: null, cache_read: null, cache_write: null, output: null };
  for (const key of tokenKeys) {
    for (const message of messages.values()) {
      const value = message.sdk_reported?.[key];
      if (validCounter(value)) subtotal[key] = (subtotal[key] ?? 0) + value;
    }
    if (admissions === 0) subtotal[key] = 0;
    if (subtotal[key] !== null && !validCounter(subtotal[key])) subtotal[key] = null;
    if (consumptionObserved) {
      let sum = 0, known = true;
      for (const message of consumption.values()) {
        const value = message.provider_terminal?.counters[key];
        if (message.unaccounted_response_ids.length || !validCounter(value)) { known = false; break; }
        sum += value;
      }
      if (known && validCounter(sum)) totals[key] = sum;
    }
  }
  return {
    schema_version: 2, admissions, reported_messages: messages.size, ...totals,
    reported_subtotal: subtotal,
    event_coverage: eventComplete ? "complete" : "incomplete",
    consumption_coverage: tokenKeys.every(key => totals[key] !== null) ? "known"
      : tokenKeys.some(key => totals[key] !== null) ? "partial" : "unknown",
    consumption_scope: "observed_logical_admissions",
    wire_attempts: null, subscription_cost: null,
  };
}

/** Pure qualification; old event coverage never establishes terminal provenance.
 * Historical objects and their original labels/bytes are not mutated.
 */
export function readUsageMetrics(value: unknown): UsageMetrics | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const counters = (input: unknown): ReportedUsage | null => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const object = input as Record<string, unknown>;
    if (!tokenKeys.every(key => object[key] === null || validCounter(object[key]))) return null;
    return { uncached_input: object.uncached_input as number | null, cache_read: object.cache_read as number | null,
      cache_write: object.cache_write as number | null, output: object.output as number | null };
  };
  const subtotal = counters(data.reported_subtotal), totals = counters(data);
  if (!validCounter(data.admissions) || !validCounter(data.reported_messages) || subtotal === null || totals === null ||
    data.wire_attempts !== null || data.subscription_cost !== null) return null;
  if (data.schema_version === undefined) {
    if (data.coverage !== "complete" && data.coverage !== "incomplete") return null;
    const zero = data.admissions === 0 && data.reported_messages === 0;
    return { schema_version: 2, admissions: data.admissions, reported_messages: data.reported_messages,
      uncached_input: zero ? 0 : null, cache_read: zero ? 0 : null, cache_write: zero ? 0 : null, output: zero ? 0 : null,
      reported_subtotal: subtotal, event_coverage: data.coverage, consumption_coverage: zero ? "known" : "unknown",
      consumption_scope: "observed_logical_admissions", wire_attempts: null, subscription_cost: null };
  }
  if (data.schema_version !== 2 || Object.hasOwn(data, "coverage") ||
    data.consumption_scope !== "observed_logical_admissions" ||
    !["complete", "incomplete"].includes(String(data.event_coverage)) ||
    !["known", "partial", "unknown"].includes(String(data.consumption_coverage)) ||
    data.reported_messages > data.admissions ||
    data.event_coverage === "complete" && data.reported_messages !== data.admissions) return null;
  const derived = tokenKeys.every(key => totals[key] !== null) ? "known" : tokenKeys.some(key => totals[key] !== null) ? "partial" : "unknown";
  if (derived !== data.consumption_coverage) return null;
  return { schema_version: 2, admissions: data.admissions, reported_messages: data.reported_messages, ...totals,
    reported_subtotal: subtotal, event_coverage: data.event_coverage as UsageMetrics["event_coverage"],
    consumption_coverage: derived, consumption_scope: "observed_logical_admissions", wire_attempts: null, subscription_cost: null };
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

export type WaitCategory = "provider_request" | "game_action" | "tool" | "observation" | "cleanup" |
  "source_validation" | "worker_start" | "worker_cleanup" | "game_required_wait" | "deliberate_wait" |
  "observation_unavailable" | "infrastructure_stall";
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
  const subtotal: ReportedUsage = { uncached_input: null, cache_read: null, cache_write: null, output: null };
  for (const key of tokenKeys) {
    for (const attempt of included) {
      const value = attempt.usage?.reported_subtotal[key];
      if (validCounter(value)) subtotal[key] = (subtotal[key] ?? 0) + value;
    }
    if (!included.length) subtotal[key] = 0;
    if (totals[key] !== null && !validCounter(totals[key])) totals[key] = null;
    if (subtotal[key] !== null && !validCounter(subtotal[key])) subtotal[key] = null;
  }
  return { result_observed: first >= 0, attempts_to_result: first >= 0 ? included.length : null,
    attempts_included: included.length, unsuccessful_attempts_included: included.filter(attempt => attempt.outcome.goal_verified !== true).length,
    admissions: included.every(attempt => attempt.usage !== null)
      ? included.reduce((sum, attempt) => sum + attempt.usage!.admissions, 0) : null, ...totals,
    reported_subtotal: subtotal, consumption_scope: "observed_logical_admissions" as const,
    wire_attempts: null, subscription_cost: null,
    limitations: ["Includes all recorded attempts through the first verified result; no success means a censored sample, not zero cost.",
      "Actual subscription monetary cost and provider wire retries are unknown."] };
}

export function catalogEstimate(usage: UsageMetrics, prices: { uncached_input: number; cache_read: number; cache_write: number; output: number } | null) {
  const known = usage.schema_version === 2 && usage.consumption_coverage === "known" && prices !== null &&
    tokenKeys.every(key => validCounter(usage[key]) && Number.isFinite(prices[key]) && prices[key] >= 0);
  const estimate = known ? tokenKeys.reduce((sum, key) => sum + usage[key]! * prices![key] / 1_000_000, 0) : null;
  return { kind: "catalog_token_price_estimate" as const,
    estimate: estimate !== null && Number.isFinite(estimate) ? estimate : null,
    actual_subscription_cost: null,
    limitations: ["Catalog per-million-token arithmetic is an estimate, not an invoice or subscription allowance measurement."] };
}

export function receiptEvidence(result: GameActionResult | null): Record<string, unknown> | null {
  const evidence = result?.evidence;
  return evidence !== null && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : null;
}
