import type {
  ActionView,
  PolicyView,
  RunView,
  TokenUsage,
} from "../../src/shared/contracts.ts";

export interface RunReport {
  run_id: string;
  status: RunView["status"];
  turns: number;
  uncached_input: number | null;
  cache_read: number | null;
  cache_write: number | null;
  output: number;
  calls: number | null;
  /** Null means the cost is unknown; zero means a known zero cost. */
  known_cost: number | null;
  legacy_input: number | null;
  elapsed_ms: number | null;
  elapsed_basis: "ended" | "as_of" | "unavailable";
  latest_action: null | {
    action_id: string;
    kind: ActionView["kind"];
    status: ActionView["status"];
    duration_ms: number | null;
  };
  policies: Array<
    Pick<
      PolicyView,
      "policy_id" | "version" | "state" | "evaluations" | "effects"
    >
  >;
  /** Observation latency is measured separately as observation_read_ms; model
   * latency and goal success rate are still not available from one snapshot. */
  unavailable_metrics: readonly ["model_latency", "goal_success_rate"];
}

export const UNAVAILABLE_METRICS: RunReport["unavailable_metrics"] = [
  "model_latency",
  "goal_success_rate",
];

/** Parse a timestamp through Date.parse; NaN and non-finite results are invalid. */
function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function runElapsed(
  run: RunView,
  asOf: number | null,
): Pick<RunReport, "elapsed_ms" | "elapsed_basis"> {
  const startedAt =
    run.started_at === null ? null : parseTimestamp(run.started_at);
  // A missing or invalid start leaves the duration unavailable; the clock of the
  // caller never repairs it.
  if (startedAt === null)
    return { elapsed_ms: null, elapsed_basis: "unavailable" };
  if (run.ended_at !== null) {
    // A present end bounds the run even when invalid: no fallback to as_of.
    const endedAt = parseTimestamp(run.ended_at);
    if (endedAt === null || endedAt - startedAt < 0)
      return { elapsed_ms: null, elapsed_basis: "unavailable" };
    return { elapsed_ms: endedAt - startedAt, elapsed_basis: "ended" };
  }
  if (asOf === null || asOf - startedAt < 0)
    return { elapsed_ms: null, elapsed_basis: "unavailable" };
  return { elapsed_ms: asOf - startedAt, elapsed_basis: "as_of" };
}

/** The action duration uses only its own recorded dates; an unfinished action
 * gets null rather than a substitute from the run clock, and both dates present
 * never prove success or change the recorded status. */
function actionDuration(action: ActionView): number | null {
  if (action.started_at === null || action.ended_at === null) return null;
  const startedAt = parseTimestamp(action.started_at);
  const endedAt = parseTimestamp(action.ended_at);
  if (startedAt === null || endedAt === null || endedAt - startedAt < 0)
    return null;
  return endedAt - startedAt;
}

/** Build a pure summary of one run snapshot. The elapsed time is calendar
 * milliseconds including pauses; turns counts admitted model calls, not
 * completed thoughts, planner turns, or actions. */
export function buildRunReport(run: RunView, as_of: string): RunReport {
  const usage: TokenUsage = run.usage;
  const policies = run.policies
    .map((policy) => ({
      policy_id: policy.policy_id,
      version: policy.version,
      state: policy.state,
      evaluations: policy.evaluations,
      effects: policy.effects,
    }))
    .sort(
      (left, right) =>
        (left.policy_id < right.policy_id
          ? -1
          : left.policy_id > right.policy_id
            ? 1
            : 0) || left.version - right.version,
    );
  return {
    run_id: run.run_id,
    status: run.status,
    turns: run.turns,
    uncached_input: usage.uncached_input,
    cache_read: usage.cache_read,
    cache_write: usage.cache_write,
    output: usage.output,
    calls: usage.calls,
    known_cost: usage.known_cost,
    legacy_input: usage.legacy_input,
    ...runElapsed(run, parseTimestamp(as_of)),
    latest_action:
      run.action === null
        ? null
        : {
            action_id: run.action.action_id,
            kind: run.action.kind,
            status: run.action.status,
            duration_ms: actionDuration(run.action),
          },
    policies,
    unavailable_metrics: UNAVAILABLE_METRICS,
  };
}
