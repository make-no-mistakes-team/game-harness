import { createHash } from "node:crypto";
import type { Json } from "../shared/contracts.ts";
import type { ImprovementFeedbackCursor, ImprovementOpportunity, ProgramVersionEvidence } from "../shared/execution-evidence.ts";
import { IMPROVEMENT_RESOLUTION_HELP } from "../shared/execution-evidence.ts";
import type { Store } from "./store.ts";
import { evidenceObject, objectiveMetrics } from "./objective-metrics.ts";
import { RuntimeFault } from "./runtime-fault.ts";

export interface ImprovementResolution {
  /** Candidate-experiment decision, not an efficacy, adoption, or promotion claim. */
  decision: "revise" | "keep" | "insufficient_evidence";
  reason: string;
  /** Required exact reference only for revise; otherwise null. */
  revision: ProgramVersionEvidence | null;
  event_seqs: number[];
}
export function exactVersion(store: Store, ref: ProgramVersionEvidence) {
  const skill = store.skill(ref.run_id, ref);
  if (skill.hash !== ref.hash) throw new Error("Version reference does not match immutable source hash");
  return skill;
}
/** Reports actual failures/outcomes; the model alone supplies the change and rationale. */
export class ImprovementLearning {
  constructor(private readonly store: Store) {}
  feedback(runId: string, after: ImprovementFeedbackCursor = { opportunity_seq: 0, execution_seq: 0 }, limit = 32) {
    if (!Number.isSafeInteger(after.opportunity_seq) || after.opportunity_seq < 0 ||
      !Number.isSafeInteger(after.execution_seq) || after.execution_seq < 0 ||
      !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid improvement feedback cursor or limit");
    this.detect(runId);
    const opportunities = this.store.evidenceObjects<ImprovementOpportunity>(runId, "opportunity");
    const metrics = objectiveMetrics(this.store, runId);
    const cap = Math.min(limit, 100);
    const opportunityRows = this.store.evidenceObjectRows<ImprovementOpportunity>(runId, "opportunity", after.opportunity_seq, cap + 1);
    const executionRows = this.store.skillExecutionRows(runId, after.execution_seq, cap + 1);
    const all = [
      ...opportunityRows.map((row) => ({ kind: "opportunity" as const, seq: row.seq, value: row.value })),
      ...executionRows.map((row) => ({ kind: "metric" as const, seq: row.seq, value: metrics.find((metric) => metric.execution_id === row.value.execution_id)! })),
    ];
    const page = {
      opportunities: [] as ImprovementOpportunity[],
      metrics: [] as typeof metrics,
      next_after: { ...after }, has_more: false,
      omitted: [] as { kind: string; id: string; reason: string; original_bytes: number }[],
      opportunity_budget: { max_records: 256, reached: opportunities.length >= 256, omission: "Further outcome events remain in the permanent event ledger when this budget is reached." },
      decision_contract: IMPROVEMENT_RESOLUTION_HELP,
      review: { effect_free: true as const, max_decisions: 4 },
    };
    for (const entry of all.slice(0, cap)) {
      const next = { ...page.next_after, [entry.kind === "opportunity" ? "opportunity_seq" : "execution_seq"]: entry.seq };
      const size = Buffer.byteLength(JSON.stringify(entry.value));
      if (size > 48000) {
        const omission = { kind: entry.kind, id: "opportunity_id" in entry.value ? entry.value.opportunity_id : entry.value.execution_id, reason: "record_byte_budget", original_bytes: size };
        if (Buffer.byteLength(JSON.stringify({ ...page, omitted: [...page.omitted, omission], next_after: next, has_more: false })) > 65536) break;
        page.omitted.push(omission);
        page.next_after = next;
        continue;
      }
      const field = entry.kind === "opportunity" ? "opportunities" : "metrics";
      const candidate = { ...page, [field]: [...page[field], entry.value], next_after: next, has_more: false };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 65536) break;
      if (entry.kind === "opportunity") page.opportunities.push(entry.value);
      else page.metrics.push(entry.value);
      page.next_after = next;
    }
    page.has_more = opportunityRows.some((row) => row.seq > page.next_after.opportunity_seq) ||
      executionRows.some((row) => row.seq > page.next_after.execution_seq);
    return page;
  }
  private detect(runId: string): void {
    const executions = this.store.allSkillExecutions(runId);
    const existing = this.store.evidenceObjects<ImprovementOpportunity>(runId, "opportunity");
    let count = existing.length;
    let cursor = 0;
    while (true) {
      const events = this.store.eventsAfter(runId, cursor, 500);
      for (const event of events) {
        if (!["skill.closed", "skill.failed", "skill.blocked", "skill.unknown", "skill.succeeded", "learning.death_episode"].includes(event.type)) continue;
        const details = evidenceObject(event.details);
        const id = details?.execution_id ?? details?.root_execution_id;
        if (typeof id !== "string") continue;
        const execution = executions.find((value) => value.execution_id === id);
        if (!execution) continue;
        const kind = event.type === "learning.death_episode" ? "death" : execution.status === "succeeded" ? "outcome" : "failure";
        const key = createHash("sha256").update(`${runId}:${id}:${kind}:${kind === "death" ? details?.death_id : execution.status}`).digest("hex");
        if (existing.some((value) => value.opportunity_id === key)) continue;
        if (count >= 256) return;
        const skill = this.store.skill(runId, execution);
        const opportunity = this.store.saveOpportunity({ opportunity_id: key, run_id: runId, kind, version: { run_id: runId, skill_id: skill.skill_id, version: skill.version, hash: skill.hash }, execution_id: id, event_seqs: [event.event_seq], created_at: event.at, resolution: null });
        existing.push(opportunity); count++;
      }
      if (events.length < 500) break;
      cursor = events[events.length - 1]!.event_seq;
    }
  }
  resolve(runId: string, id: string, input: ImprovementResolution): ImprovementOpportunity {
    if (!["revise", "keep", "insufficient_evidence"].includes(input.decision) || !input.reason.trim() || input.reason.length > 4000 || input.event_seqs.length > 64) throw new Error("Invalid bounded improvement resolution");
    if (input.decision === "revise" && input.revision === null)
      throw new RuntimeFault("invalid_request", `Revise requires an exact revision reference. ${IMPROVEMENT_RESOLUTION_HELP}`);
    if (input.decision !== "revise" && input.revision !== null)
      throw new RuntimeFault("invalid_request", `Keep and insufficient_evidence require revision:null. To link the exact revision of a chosen or performed candidate experiment, choose revise. ${IMPROVEMENT_RESOLUTION_HELP}`);
    const opportunity = this.store.evidenceObjects<ImprovementOpportunity>(runId, "opportunity").find((value) => value.opportunity_id === id);
    if (!opportunity) throw new Error("Improvement opportunity not found");
    if (opportunity.resolution) {
      const previous = opportunity.resolution;
      const sameRevision = previous.revision === null ? input.revision === null : input.revision !== null &&
        previous.revision.run_id === input.revision.run_id && previous.revision.skill_id === input.revision.skill_id &&
        previous.revision.version === input.revision.version && previous.revision.hash === input.revision.hash;
      if (previous.decision !== input.decision || previous.reason !== input.reason ||
        !sameRevision ||
        JSON.stringify(previous.event_seqs) !== JSON.stringify([...new Set(input.event_seqs)]))
        throw new RuntimeFault("conflict", "This improvement opportunity already has an immutable resolution; identical retries return that resolution.");
      return opportunity;
    }
    exactVersion(this.store, opportunity.version);
    for (const seq of input.event_seqs) {
      if (!Number.isSafeInteger(seq) || seq < 1 || this.store.eventsAfter(runId, seq - 1, 1)[0]?.event_seq !== seq) throw new Error("Resolution evidence must reference exact events in this run");
    }
    let measured = false;
    if (input.revision !== null) {
      const revision = exactVersion(this.store, input.revision);
      const parent = exactVersion(this.store, opportunity.version);
      const sourceRun = this.store.getRun(opportunity.version.run_id), revisionRun = this.store.getRun(input.revision.run_id);
      if (!sourceRun || !revisionRun || sourceRun.model_id !== revisionRun.model_id || revision.skill_id !== parent.skill_id || revision.parent_version !== parent.version) throw new Error("Revision must name a same-model direct child version");
      measured = this.store.allSkillExecutions(input.revision.run_id).some((execution) => execution.skill_id === revision.skill_id && execution.version === revision.version && execution.started_at !== null && ["succeeded", "blocked", "failed", "unknown", "cancelled"].includes(execution.status));
    }
    const value = this.store.resolveOpportunity(runId, id, { ...input, event_seqs: [...new Set(input.event_seqs)], measured, at: new Date().toISOString() });
    if (!opportunity.resolution) this.store.event(runId, "learning.resolved", "Recorded model-selected improvement decision", { opportunity_id: id, decision: input.decision, revision: input.revision as unknown as Json, measured, qualification: measured ? "measured_not_causally_proven" : "unmeasured_candidate" });
    return value;
  }
}
