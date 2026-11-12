import type { ActionView, ActivityEvent, Json, ObservationV3, PolicyView, ProgramEvidenceView } from "../shared/contracts.ts";
import type { SkillExecutionView, SkillRef, SkillView } from "../shared/programs.ts";
import type { AdapterActorProjection } from "../shared/observations.ts";
import { SKILL_API_VERSION } from "../shared/programs.ts";
import type { ImprovementOpportunity, ObjectiveMetrics, ObjectiveMetricUpdate, TracePage } from "../shared/execution-evidence.ts";
import type { PlanProjection } from "../shared/planning.ts";
import type { DetailedProgramEvidence } from "./program-evidence.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { StoreReadQueries } from "./store-read.ts";
import type { VersionComparisonPage } from "./program-comparison.ts";
import { evidenceObject } from "./objective-metrics.ts";

export type ProgramWorkspaceReadStore = Pick<StoreReadQueries, "namedSkill" | "programCatalog" | "selectedSkillExecution" | "executionReferences" | "skill" | "latestOpportunityForVersion" | "getRun" | "opportunity" | "historyProjectionGeneration" | "historyProjectionRow" | "historyProjectionRows">;
export interface ProgramSelector { name: string; version?: number }
export interface NamedExecutionReference { name: string; version: number; execution_ordinal: number }
type NativeLifeScope = Partial<Pick<SkillExecutionView,
  "world_id" | "session_id" | "epoch" | "native_boot_id" | "life_id">>;
const NATIVE_LIFE_SCOPE_KEYS = ["world_id", "session_id", "epoch", "native_boot_id", "life_id"] as const;
/** Identity relation only: neither liveness, effect authority nor a goal verdict. */
export function executionNativeLifeRelation(original: NativeLifeScope, current: NativeLifeScope | null) {
  if (!current) return "unknown" as const;
  let missing = false;
  for (const key of NATIVE_LIFE_SCOPE_KEYS) {
    if (original[key] == null || current[key] == null) missing = true;
    else if (original[key] !== current[key]) return "different_native_scope" as const;
  }
  return missing ? "unknown" as const : "same_native_life" as const;
}
interface EvidenceOmission { kind: string; id: string; reason: string; original_bytes: number; reference?: Json }
export interface ModelReviewContext {
  opportunities: ImprovementOpportunity[];
  metrics?: ObjectiveMetricUpdate[];
  omitted?: EvidenceOmission[];
}
const unfinished: Record<string, true> = { accepted: true, running: true, cancel_requested: true };

export class ProgramWorkspace {
  constructor(private readonly store: ProgramWorkspaceReadStore, readonly runId: string) {}

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
    if (row) return { name: row.name, version: row.version, execution_ordinal: row.execution_ordinal };
    const published = this.store.historyProjectionGeneration(this.runId);
    if (!published) return null;
    const update = this.store.historyProjectionRows(this.runId, published.revision, {
      collection: "metric_update", owner_id: id, descending: true, limit: 1,
    })[0];
    if (!update) return null;
    const value = evidenceObject(update.value), program = evidenceObject(value?.program);
    if (value?.execution_id !== id || !program || typeof program.name !== "string" || !program.name || typeof program.version !== "number" ||
      !Number.isSafeInteger(program.version) || program.version < 1 ||
      typeof value?.execution_ordinal !== "number" || !Number.isSafeInteger(value.execution_ordinal) || value.execution_ordinal < 1)
      throw new RuntimeFault("conflict", "Published named execution reference is corrupt");
    return { name: program.name, version: program.version, execution_ordinal: value.execution_ordinal };
  }

  private executionReferences(ids: Iterable<string | null | undefined>, generation?: number) {
    const references = new Map<string, NamedExecutionReference>();
    const snapshot = generation === undefined ? undefined : this.store.historyProjectionGeneration(this.runId, generation);
    if (generation !== undefined && !snapshot) throw new RuntimeFault("conflict", "Named history generation is unavailable");
    for (const id of new Set(ids)) {
      if (id === null || id === undefined) continue;
      const value = snapshot ? evidenceObject(this.store.historyProjectionRow(this.runId, snapshot.revision, "execution", id)?.value) : null;
      const reference = snapshot ? value && typeof value.program_name === "string" && typeof value.version === "number" &&
        typeof value.execution_ordinal === "number"
        ? { name: value.program_name, version: value.version, execution_ordinal: value.execution_ordinal } : null : this.executionReference(id);
      if (reference) references.set(id, reference);
    }
    return references;
  }

  programReference(ref: SkillRef) {
    try { return { name: this.store.skill(this.runId, ref).name, version: ref.version }; }
    catch { return { name: null, version: ref.version, reference_omission: "Program is outside the current named workspace" }; }
  }

  latestOpportunity(program: SkillView): ImprovementOpportunity {
    const value = this.store.latestOpportunityForVersion({ run_id: this.runId, skill_id: program.skill_id, version: program.version, hash: program.hash });
    if (!value) throw new RuntimeFault("not_found", "No matching outcome feedback is available for this exact named version");
    return value;
  }

  source(program: SkillView) {
    const compatible = !!program.entry && program.validation.runtime_version === 5 && program.validation.api_version === 5 && program.validation.validator_version === 5 &&
      program.validation.compatibility_hash === this.store.getRun(this.runId)?.compatibility_hash;
    return { name: program.name, version: program.version, entry: program.entry ?? null, source: program.source, card: program.card,
      dependencies: program.dependencies.map((ref) => ({ ...this.programReference(ref),
        ...(ref.import_path === undefined ? {} : { import_path: ref.import_path }) })),
      parent_version: program.parent_version, state: program.state, execution_compatible: compatible,
      validation: { runtime_version: program.validation.runtime_version ?? null, api_version: program.validation.api_version ?? null,
        validator_version: program.validation.validator_version ?? null, compatibility_hash: program.validation.compatibility_hash ?? null,
        fingerprint: program.validation.fingerprint, formatted_lines: program.validation.formatted_lines, complexity: program.validation.complexity,
        nesting: program.validation.nesting,
        ...(program.validation.runtime_features ? { runtime_features: program.validation.runtime_features } : {}) }, created_at: program.created_at };
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
      root: this.executionReference(execution.root_execution_id), limits: execution.limits,
      resident: execution.entry === "step" ? execution.resident : null, started_at: execution.started_at,
      ended_at: execution.ended_at, deadline_at: execution.deadline_at, args: field("args"), result: field("result"), error: execution.error, diagnostic: execution.diagnostic ?? null, omissions };
  }

  executionSummary(execution: SkillExecutionView, currentRun: NativeLifeScope | null = this.store.getRun(this.runId)) {
    const program = this.store.skill(this.runId, execution);
    const resident = execution.entry === "step" &&
      (execution.status === "failed" || execution.status === "blocked" || execution.status === "unknown") &&
      execution.resident && ["failed", "blocked", "stopped", "unknown"].includes(execution.resident.status)
      ? { status: execution.resident.status, reason: execution.resident.reason?.slice(0, 300) ?? null } : null;
    return { name: program.name, version: execution.version, execution_ordinal: this.executionReference(execution.execution_id)?.execution_ordinal ?? null,
      entry: execution.entry, status: execution.status, target: Object.hasOwn(unfinished, execution.status) ? "current" : "latest",
      native_life_relation: executionNativeLifeRelation(execution, currentRun),
      actions: execution.actions, calls: execution.calls, resident,
      summary: (execution.result?.summary ?? execution.error)?.slice(0, 1000) ?? null };
  }

  metricView(metric: ObjectiveMetrics, references?: ReadonlyMap<string, NamedExecutionReference>, generation?: number) {
    references ??= this.executionReferences([metric.execution_id, metric.root_execution_id], generation);
    const { execution_id, root_execution_id, ...measurements } = metric;
    const reference = references.get(execution_id);
    if (!reference) throw new RuntimeFault("not_found", "Metric execution is not retained in this workspace");
    return { ...measurements, ...reference, root_execution_ordinal: references.get(root_execution_id)?.execution_ordinal ?? null };
  }

  metricReadReference(id: string, generation: number, references: ReadonlyMap<string, NamedExecutionReference> = this.executionReferences([id], generation)) {
    const reference = references.get(id);
    return reference ? { view: "metric" as const, program: { name: reference.name, version: reference.version },
      execution_ordinal: reference.execution_ordinal, generation, after: { record_index: 0, chunk_index: 0 }, limit: 25 } : null;
  }

  evidenceReadReference(id: string, generation: number) {
    const reference = this.executionReferences([id], generation).get(id);
    return reference ? { view: "evidence" as const, program: { name: reference.name, version: reference.version },
      execution_ordinal: reference.execution_ordinal, generation, after: { record_index: 0, chunk_index: 0 }, limit: 25 } : null;
  }

  private opportunityView(opportunity: ImprovementOpportunity, references: ReadonlyMap<string, NamedExecutionReference>) {
    const { kind, version, execution_id, event_seqs, created_at, resolution } = opportunity;
    return { kind, version: this.programReference(version), execution_ordinal: references.get(execution_id)?.execution_ordinal ?? null,
      event_seqs, created_at, resolution: resolution ? { ...resolution, revision: resolution.revision ? this.programReference(resolution.revision) : null } : null };
  }

  feedbackView<T extends ModelReviewContext>(page: T) {
    const ids = new Set(page.opportunities.map((opportunity) => opportunity.execution_id));
    const omittedOpportunities = new Map<string, ImprovementOpportunity | null>();
    for (const omission of page.omitted ?? []) {
      if (omission.kind === "opportunity" && !omittedOpportunities.has(omission.id))
        omittedOpportunities.set(omission.id, this.store.opportunity(this.runId, omission.id));
      const opportunity = omission.kind === "opportunity" ? omittedOpportunities.get(omission.id) : null;
      ids.add(opportunity ? opportunity.execution_id : omission.id);
    }
    const references = this.executionReferences(ids);
    return { ...page, opportunities: page.opportunities.map((opportunity) => this.opportunityView(opportunity, references)),
      ...(page.metrics ? { metrics: page.metrics.map(update => {
        const { program, execution_ordinal, revision, generation } = update;
        const identity = { program, execution_ordinal, revision, generation };
        if (update.kind === "retract") return { ...identity, kind: "retract" as const, reason: update.reason };
        return { ...identity, kind: "replace" as const,
          metric: this.metricView(update.metric, undefined, generation) };
      }) } : {}),
      ...(page.omitted ? { omitted: page.omitted.map(({ id, ...omission }) => {
        const opportunity = omission.kind === "opportunity" ? omittedOpportunities.get(id) : null;
        const retained = omission.reference;
        const metadata = retained && typeof retained === "object" && !Array.isArray(retained) ? {
          ...(typeof retained.generation === "number" ? { generation: retained.generation } : {}),
          ...(typeof retained.revision === "number" ? { revision: retained.revision } : {}),
          ...(typeof retained.opportunity_change_seq === "number" ? { opportunity_change_seq: retained.opportunity_change_seq } : {}),
        } : {};
        if (omission.kind === "metric") return { ...omission, reference: typeof metadata.generation === "number"
          ? this.metricReadReference(id, metadata.generation, this.executionReferences([id], metadata.generation)) : null };
        return { ...omission, reference: opportunity ? { ...this.opportunityView(opportunity, references), ...metadata } :
          { ...(references.get(id) ?? { reference_omission: "Execution is not retained in the named workspace" }), ...metadata } };
      }) } : {}) };
  }

  traceView(page: TracePage) {
    const references = this.executionReferences(page.records.flatMap((record) => [record.execution_id, record.root_execution_id, record.parent_execution_id]));
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

  historyView(record: ProgramEvidenceView & Partial<DetailedProgramEvidence>, generation?: number) {
    const { execution_id, root_execution_id, skill_id, compactness, metrics, goal_associations, ...evidence } = record;
    const references = this.executionReferences([execution_id, root_execution_id, metrics?.execution_id, metrics?.root_execution_id], generation);
    const { fingerprint: _fingerprint, ...validation } = compactness;
    return { ...evidence, ...this.programReference({ skill_id, version: record.version }),
      execution_ordinal: references.get(execution_id)?.execution_ordinal ?? null,
      root_execution_ordinal: references.get(root_execution_id)?.execution_ordinal ?? null,
      compactness: validation, ...(metrics ? { metrics: this.metricView(metrics, references) } : {}),
      ...(goal_associations ? { goal_associations: goal_associations.map(({ action_id: _action, controller_input, ...association }) =>
        ({ ...association, ...(controller_input ? { controller_input: { generation: controller_input.generation, sequence: controller_input.sequence } } : {}) })) } : {}) };
  }

  comparisonView(page: VersionComparisonPage) {
    const { before, after, samples, ...comparison } = page.comparison;
    return { ...page, comparison: { ...comparison, before: this.programReference(before), after: this.programReference(after),
      samples: {
        before: samples.before.map((metric) => this.metricView(metric, undefined, page.projection.before.generation)),
        after: samples.after.map((metric) => this.metricView(metric, undefined, page.projection.after.generation)),
      } },
      omissions: page.omissions.map(({ reference, ...omission }) => ({ ...omission,
        reference: omission.field === "source_diff" || omission.field === "card_diff"
          ? { before: this.programReference(before), after: this.programReference(after) }
          : reference && typeof reference === "object" && !Array.isArray(reference) && typeof reference.execution_id === "string"
            ? typeof reference.generation === "number" ? this.metricReadReference(reference.execution_id, reference.generation,
              this.executionReferences([reference.execution_id], reference.generation)) : null : null })) };
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
