import type { ActionView, ActivityEvent, Json, ObservationV3, PolicyView, ProgramEvidenceView } from "../shared/contracts.ts";
import type { SkillExecutionView, SkillRef, SkillView } from "../shared/programs.ts";
import type { AdapterActorProjection } from "../shared/observations.ts";
import { SKILL_API_VERSION } from "../shared/programs.ts";
import type { ImprovementOpportunity, ObjectiveMetrics, TracePage, VersionComparison } from "../shared/execution-evidence.ts";
import type { PlanProjection } from "../shared/planning.ts";
import type { DetailedProgramEvidence } from "./program-evidence.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { Store } from "./store.ts";

export interface ProgramSelector { name: string; version?: number }
export interface NamedExecutionReference { name: string; version: number; execution_ordinal: number }
interface EvidenceOmission { kind: string; id: string; reason: string; original_bytes: number }
export interface ModelReviewContext {
  opportunities: ImprovementOpportunity[];
  metrics?: ObjectiveMetrics[];
  omitted?: EvidenceOmission[];
  [field: string]: unknown;
}
interface ComparisonPage {
  comparison: VersionComparison;
  next_after: number;
  has_more: boolean;
  omissions: { field: string; reason: string; original_bytes: number; reference: Json }[];
}
const unfinished: Record<string, true> = { accepted: true, running: true, cancel_requested: true };

export class ProgramWorkspace {
  constructor(private readonly store: Store, readonly runId: string) {}

  select(selector: ProgramSelector, validated = false): SkillView {
    const selected = this.store.namedSkill(this.runId, selector.name, selector.version, validated);
    if (!selected) throw new RuntimeFault("not_found", validated ? "No validated version of this named program is available" : "Named program version not found");
    return selected;
  }

  catalog(after: number, limit: number) {
    return this.store.programCatalog(this.runId, after, limit);
  }

  execution(target: "current" | "latest", selector?: ProgramSelector): SkillExecutionView | null {
    const program = selector ? this.select(selector) : null;
    return this.store.selectedSkillExecution(this.runId, target, program?.skill_id, selector?.version);
  }

  executionReference(id: string): NamedExecutionReference | null {
    const row = this.store.executionReferences(this.runId, id)[0];
    if (!row) return null;
    return { name: row.name, version: row.version, execution_ordinal: row.execution_ordinal };
  }

  private executionReferences() {
    return new Map(this.store.executionReferences(this.runId).map(({ execution_id, ...reference }) => [execution_id, reference]));
  }

  programReference(ref: SkillRef) {
    try { return { name: this.store.skill(this.runId, ref).name, version: ref.version }; }
    catch { return { name: null, version: ref.version, reference_omission: "Program is outside the current named workspace" }; }
  }

  latestOpportunity(program: SkillView): ImprovementOpportunity {
    const value = this.store.evidenceObjects<ImprovementOpportunity>(this.runId, "opportunity")
      .filter((opportunity) => opportunity.version.run_id === this.runId && opportunity.version.skill_id === program.skill_id &&
        opportunity.version.version === program.version && opportunity.version.hash === program.hash)
      .at(-1);
    if (!value) throw new RuntimeFault("not_found", "No matching outcome feedback is available for this exact named version");
    return value;
  }

  source(program: SkillView) {
    const compatible = program.validation.runtime_version === 4 && program.validation.api_version === 4 && program.validation.validator_version === 4 &&
      program.validation.compatibility_hash === this.store.getRun(this.runId)?.compatibility_hash;
    return { name: program.name, version: program.version, source: program.source, card: program.card,
      dependencies: program.dependencies.map((ref) => this.programReference(ref)),
      parent_version: program.parent_version, state: program.state, execution_compatible: compatible,
      validation: { runtime_version: program.validation.runtime_version ?? null, api_version: program.validation.api_version ?? null,
        validator_version: program.validation.validator_version ?? null, compatibility_hash: program.validation.compatibility_hash ?? null,
        fingerprint: program.validation.fingerprint, formatted_lines: program.validation.formatted_lines, complexity: program.validation.complexity,
        nesting: program.validation.nesting }, created_at: program.created_at };
  }

  observationView(observation: ObservationV3, projection?: AdapterActorProjection) {
    const { life } = observation;
    const { life_id: _life, death, ...status } = life;
    const publicDeath = death ? { at: death.at, message: death.message } : null;
    return { schema_version: 3, profile_id: observation.profile_id, observation_seq: observation.observation_seq,
      captured_at: observation.captured_at, space: observation.space, screen: observation.screen,
      data: projection?.state ?? observation.data, metadata: projection?.metadata ?? {}, summary: projection?.summary ?? "",
      freshness: observation.freshness, life: { ...status, death: publicDeath } };
  }

  executionView(execution: SkillExecutionView | null) {
    if (!execution) return null;
    const omissions: { field: string; reason: string; original_bytes: number }[] = [];
    const field = (name: "args" | "result") => {
      const size = Buffer.byteLength(JSON.stringify(execution[name]));
      if (size <= 24000) return execution[name];
      omissions.push({ field: name, reason: "execution_view_byte_budget", original_bytes: size });
      return null;
    };
    return { ...this.executionSummary(execution), parent: execution.parent_execution_id ? this.executionReference(execution.parent_execution_id) : null,
      root: this.executionReference(execution.root_execution_id), limits: execution.limits, started_at: execution.started_at,
      ended_at: execution.ended_at, deadline_at: execution.deadline_at, args: field("args"), result: field("result"), error: execution.error, diagnostic: execution.diagnostic ?? null, omissions };
  }

  executionSummary(execution: SkillExecutionView) {
    const program = this.store.skill(this.runId, execution);
    return { name: program.name, version: execution.version, execution_ordinal: this.executionReference(execution.execution_id)?.execution_ordinal ?? null,
      status: execution.status, target: Object.hasOwn(unfinished, execution.status) ? "current" : "latest",
      actions: execution.actions, calls: execution.calls,
      summary: (execution.result?.summary ?? execution.error)?.slice(0, 1000) ?? null };
  }

  metricView(metric: ObjectiveMetrics, references: ReadonlyMap<string, NamedExecutionReference> = this.executionReferences()) {
    const { execution_id, root_execution_id, ...measurements } = metric;
    const reference = references.get(execution_id);
    if (!reference) throw new RuntimeFault("not_found", "Metric execution is not retained in this workspace");
    return { ...measurements, ...reference, root_execution_ordinal: references.get(root_execution_id)?.execution_ordinal ?? null };
  }

  private opportunityView(opportunity: ImprovementOpportunity, references: ReadonlyMap<string, NamedExecutionReference>) {
    const { kind, version, execution_id, event_seqs, created_at, resolution } = opportunity;
    return { kind, version: this.programReference(version), execution_ordinal: references.get(execution_id)?.execution_ordinal ?? null,
      event_seqs, created_at, resolution: resolution ? { ...resolution, revision: resolution.revision ? this.programReference(resolution.revision) : null } : null };
  }

  feedbackView<T extends ModelReviewContext>(page: T) {
    const references = this.executionReferences();
    const opportunities = this.store.evidenceObjects<ImprovementOpportunity>(this.runId, "opportunity");
    return { ...page, opportunities: page.opportunities.map((opportunity) => this.opportunityView(opportunity, references)),
      ...(page.metrics ? { metrics: page.metrics.map((metric) => this.metricView(metric, references)) } : {}),
      ...(page.omitted ? { omitted: page.omitted.map(({ id, ...omission }) => {
        const opportunity = omission.kind === "opportunity" ? opportunities.find((entry) => entry.opportunity_id === id) : null;
        return { ...omission, reference: opportunity ? this.opportunityView(opportunity, references) : references.get(id) ?? null };
      }) } : {}) };
  }

  traceView(page: TracePage) {
    const references = this.executionReferences();
    return { ...page, records: page.records.map((record) => ({ trace_seq: record.trace_seq, at: record.at, kind: record.kind,
      ...(record.skill_id && record.version ? this.programReference({ skill_id: record.skill_id, version: record.version }) : {}),
      execution_ordinal: record.execution_id ? references.get(record.execution_id)?.execution_ordinal ?? null : null,
      root_execution_ordinal: record.root_execution_id ? references.get(record.root_execution_id)?.execution_ordinal ?? null : null,
      parent_execution_ordinal: record.parent_execution_id ? references.get(record.parent_execution_id)?.execution_ordinal ?? null : null,
      observation_seq: record.observation_seq, capability: record.capability, event_seq: record.event_seq,
      payload: record.payload, omission: record.omission })) };
  }

  eventView(event: ActivityEvent) {
    return { event_seq: event.event_seq, at: event.at, type: event.type, summary: event.summary, details: event.details };
  }

  historyView(record: ProgramEvidenceView & Partial<DetailedProgramEvidence>) {
    const { execution_id, root_execution_id, skill_id, compactness, metrics, goal_associations, ...evidence } = record;
    const { fingerprint: _fingerprint, ...validation } = compactness;
    return { ...evidence, ...this.programReference({ skill_id, version: record.version }),
      execution_ordinal: this.executionReference(execution_id)?.execution_ordinal ?? null,
      root_execution_ordinal: this.executionReference(root_execution_id)?.execution_ordinal ?? null,
      compactness: validation, ...(metrics ? { metrics: this.metricView(metrics) } : {}),
      ...(goal_associations ? { goal_associations: goal_associations.map(({ action_id: _action, ...association }) => association) } : {}) };
  }

  comparisonView(page: ComparisonPage) {
    const references = this.executionReferences();
    const { before, after, samples, ...comparison } = page.comparison;
    return { ...page, comparison: { ...comparison, before: this.programReference(before), after: this.programReference(after),
      samples: { before: samples.before.map((metric) => this.metricView(metric, references)), after: samples.after.map((metric) => this.metricView(metric, references)) } },
      omissions: page.omissions.map(({ reference, ...omission }) => ({ ...omission,
        reference: omission.field === "source_diff" || omission.field === "card_diff"
          ? { before: this.programReference(before), after: this.programReference(after) }
          : reference && typeof reference === "object" && !Array.isArray(reference) && typeof reference.execution_id === "string"
            ? references.get(reference.execution_id) ?? null : null })) };
  }

  planningView(plan: PlanProjection | null) {
    if (!plan) return null;
    return { state: plan.state, planning_active: plan.planning_active, reason: plan.reason, intent: plan.intent,
      basis: { task: plan.basis.task, goal: plan.basis.goal, life_status: plan.basis.life_status,
        root: { ...this.programReference(plan.basis.root), status: plan.basis.root.status,
          execution_ordinal: this.executionReference(plan.basis.root.execution_id)?.execution_ordinal ?? null } },
      candidate: plan.candidate ? this.programReference(plan.candidate) : null, guard_status: plan.guard_status,
      activation: plan.activation, activation_permit: plan.activation_permit, activation_trigger: plan.activation_trigger,
      predecessor_closed: plan.predecessor_closed, deadline_at: plan.deadline_at, budget: plan.budget, calls: plan.calls, tools: plan.tools,
      observation_seq: plan.observation_seq,
      activation_execution: plan.activation_execution_id ? this.executionReference(plan.activation_execution_id) : null, overlap_ms: plan.overlap_ms };
  }

  actionView(action: ActionView | null) {
    if (!action) return null;
    return { kind: action.kind, status: action.status, origin: action.origin, summary: action.summary,
      execution: action.execution_id ? this.executionReference(action.execution_id) : null,
      started_at: action.started_at, ended_at: action.ended_at, result: action.result };
  }

  policyView(policy: PolicyView) {
    const { policy_id: _id, hash: _hash, ...definition } = policy;
    return definition;
  }

  page<T>(values: readonly T[], after: number, limit: number) {
    const records: T[] = [];
    const omissions: { index: number; reason: string; original_bytes: number }[] = [];
    let cursor = after;
    let bytes = 0;
    for (const value of values.slice(after, after + limit)) {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > 48000) {
        omissions.push({ index: cursor, reason: "record_byte_budget", original_bytes: size });
        cursor++;
        continue;
      }
      if (bytes + size > 60000) break;
      records.push(value); bytes += size; cursor++;
    }
    return { records, next_after: cursor, has_more: cursor < values.length, total: values.length, omissions };
  }
}
