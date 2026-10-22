import type {
  ActivityEvent,
  Json,
  ProgramEvidenceView,
} from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import type { Store } from "./store.ts";
import type { ObjectiveMetrics } from "../shared/execution-evidence.ts";
import { confirmedRemoval, eligibleLog, objectiveMetrics, receiptedInventoryDelta } from "./objective-metrics.ts";
export type DetailedProgramEvidence = ProgramEvidenceView & {
  metrics: ObjectiveMetrics;
  goal_associations: { event_seq: number; relationship: "direct_receipt" | "block_removal_contributor" | "inventory_collector"; action_id: string; causal_item_origin: "unknown" }[];
};
const object = (value: Json): Record<string, Json> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
/** Measured counters, never a weighted efficiency score or source-length proxy. */
export function programEvidence(
  store: Store,
  runId: string,
): DetailedProgramEvidence[] {
  const executions = store.allSkillExecutions(runId);
  const projections = new Map<string, ProgramEvidenceView>();
  const owners = new Map<string, SkillExecutionView>();
  for (const execution of executions) {
    owners.set(execution.execution_id, execution);
    const start = execution.started_at
      ? Date.parse(execution.started_at)
      : null;
    projections.set(execution.execution_id, {
      execution_id: execution.execution_id,
      skill_id: execution.skill_id,
      version: execution.version,
      root_execution_id: execution.root_execution_id,
      status: execution.status,
      duration_ms:
        start === null
          ? null
          : Math.max(
              0,
              (execution.ended_at
                ? Date.parse(execution.ended_at)
                : Date.now()) - start,
            ),
      actions: execution.actions,
      calls: execution.calls,
      strategic_requests: 0,
      confirmed_effects: 0,
      evidence_status: execution.result ? "self_reported" : "unknown",
      verified_event_seqs: [],
      compactness: store.skill(runId, execution).validation,
    });
  }
  const inInterval = (
    execution: SkillExecutionView,
    event: ActivityEvent,
  ): boolean =>
    !!execution.started_at &&
    event.at >= execution.started_at &&
    (!execution.ended_at || event.at <= execution.ended_at);
  const confirmed = new Map<
    string,
    { owner: SkillExecutionView; item: string | null }
  >();
  const goals: ActivityEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = store.eventsAfter(runId, cursor, 500);
    for (const event of page) {
      const details = object(event.details);
      if (event.type === "model.call" && details?.backend !== "jev") {
        for (const execution of executions)
          if (inInterval(execution, event))
            projections.get(execution.execution_id)!.strategic_requests++;
      } else if (
        event.type === "action.succeeded" &&
        typeof details?.action_id === "string" &&
        !confirmed.has(details.action_id)
      ) {
        const action = store.getAction(runId, details.action_id);
        if (
          !action?.view.execution_id ||
          object(action.view.result?.evidence ?? null)?.effect_confirmed !==
            true
        )
          continue;
        let owner = owners.get(action.view.execution_id);
        if (!owner) {
          const loaded = store.skillExecution(runId, {
            execution_id: action.view.execution_id,
          });
          if (!loaded) continue;
          owners.set(loaded.execution_id, loaded);
          owner = loaded;
        }
        const evidence = object(action.view.result?.evidence ?? null);
        const item =
          action.request.kind === "craft"
            ? action.request.item
            : action.request.kind === "dig" &&
                typeof evidence?.target_name === "string"
              ? evidence.target_name
              : null;
        confirmed.set(details.action_id, { owner, item });
        for (const id of new Set([
          owner.execution_id,
          owner.root_execution_id,
        ])) {
          const projection = projections.get(id);
          if (projection) {
            projection.confirmed_effects++;
            if (
              projection.evidence_status === "self_reported" ||
              projection.evidence_status === "unknown"
            )
              projection.evidence_status = "confirmed_effects";
          }
        }
      } else if (event.type === "goal.verified") goals.push(event);
      else if (event.type === "experience.promoted" && details) {
        const evidence = object(details.evidence ?? null);
        if (typeof evidence?.execution_id !== "string") continue;
        const projection = projections.get(evidence.execution_id),
          predicate = object(evidence.predicate ?? null);
        if (projection && typeof predicate?.event_seq === "number") {
          projection.evidence_status =
            predicate.kind === "goal_verified"
              ? "verified_goal"
              : "verified_predicate";
          projection.verified_event_seqs.push(predicate.event_seq);
        }
      }
    }
    if (page.length < 500) break;
    cursor = page[page.length - 1]!.event_seq;
  }
  const associations = new Map<string, DetailedProgramEvidence["goal_associations"]>();
  for (const event of goals) {
    const details = object(event.details);
    for (const [actionId, { owner }] of confirmed) {
      const action = store.getAction(runId, actionId)!;
      const receipt = object(action.view.result?.evidence ?? null);
      const item = typeof details?.item === "string" ? details.item : null;
      const delta = receiptedInventoryDelta(action);
      const collector = item !== null && (delta?.[item] ?? 0) > 0;
      const removal = confirmedRemoval(action) && typeof receipt?.target_name === "string" && eligibleLog(receipt.target_name);
      const direct = details?.action_id === actionId && (details?.goal === "break_log" ? removal : collector || action.request.kind === "craft");
      if (!direct && !collector && !removal) continue;
      for (const id of new Set([owner.execution_id, owner.root_execution_id])) {
        const projection = projections.get(id);
        if (!projection || (action.view.ended_at && action.view.ended_at > event.at)) continue;
        const linked = associations.get(id) ?? [];
        linked.push({ event_seq: event.event_seq, relationship: direct ? "direct_receipt" : collector ? "inventory_collector" : "block_removal_contributor", action_id: actionId, causal_item_origin: "unknown" });
        associations.set(id, linked);
        if (direct) {
          projection.evidence_status = "verified_goal";
          projection.verified_event_seqs.push(event.event_seq);
        }
      }
    }
  }
  for (const projection of projections.values())
    projection.verified_event_seqs = [
      ...new Set(projection.verified_event_seqs),
    ];
  const metrics = new Map(objectiveMetrics(store, runId).map((metric) => [metric.execution_id, metric]));
  return [...projections.values()].map((projection) => ({ ...projection, metrics: metrics.get(projection.execution_id)!, goal_associations: associations.get(projection.execution_id) ?? [] }));
}
