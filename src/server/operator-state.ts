import type { ActionView, RunOperatorView } from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import type { Store, StoredRun } from "./store.ts";

export function projectRunOperator(
  store: Store, run: StoredRun, action: ActionView | null,
  executions: SkillExecutionView[], recovering = false,
): RunOperatorView {
  const control = run.control ?? { pause_cause: null, cleanup_error: null };
  const progress = store.latestEvent(run.run_id, "skill.progress");
  const details = progress?.details;
  const reported = store.latestEvent(run.run_id, "task.completion_reported");
  const verified = store.latestEvent(run.run_id, "goal.verified");
  let state: RunOperatorView["state"] = run.status;
  if (run.status === "paused" && control.pause_cause === "provider_failure") state = "provider_unavailable";
  if (run.status === "running") {
    const root = store.latestRootExecution(run.run_id);
    const pending = !!root && ["accepted", "running", "cancel_requested"].includes(root.status) ||
      executions.some(item => ["accepted", "running", "cancel_requested"].includes(item.status));
    state = recovering ? "recovering"
      : action && ["accepted", "running", "cancel_requested"].includes(action.status) ? "acting"
        : run.model_status === "thinking" ? "thinking"
          : pending ? "executing"
            : root && ["blocked", "failed", "unknown"].includes(root.status) ? "blocked"
              : "waiting";
  }
  return {
    ...control, state,
    completion: verified ? "verified" : reported ? "model_reported_unverified" : null,
    progress: progress ? {
      event_seq: progress.event_seq, at: progress.at, summary: progress.summary,
      execution_id: details && typeof details === "object" && !Array.isArray(details) &&
        typeof details.execution_id === "string" ? details.execution_id : null,
      source: "model_program", verification: "unverified",
    } : null,
  };
}
