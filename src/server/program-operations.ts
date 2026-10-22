import { createHash } from "node:crypto";
import { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import type { SkillStartRequest } from "../shared/programs.ts";
import type { ImprovementOpportunity } from "../shared/execution-evidence.ts";
import type { RuntimeToolHost } from "./runtime-tools.ts";
import type { Store, StoredRun } from "./store.ts";
import type { SkillManager } from "./skills.ts";
import type { ReactiveRuntime } from "./reactive.ts";
import type { ExperienceLibrary } from "./experience.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { ProgramWorkspace } from "./program-workspace.ts";
import { compareProgramVersionsPage } from "./program-comparison.ts";
import type { programInspectSchema, programReviewSchema, programRunSchema, programWriteSchema, memorySchema, prepareNextSchema, reflexSchema } from "./program-interface.ts";
import { programSelectorSchema } from "./program-interface.ts";
import { skillRefSchema } from "../shared/validation.ts";
import { policyRefSchema } from "./reactive.ts";

const exactNamedProgramSchema = programSelectorSchema.required({ version: true });
const executionControlSchema = z.object({ execution_id: z.string().nullable(), plan_id: z.string().nullable() }).strict();
const preparedSelectionSchema = z.object({ plan_id: z.string(), skill: skillRefSchema }).strict();

export class ProgramOperations {
  readonly workspace: ProgramWorkspace;
  constructor(private store: Store, private skills: SkillManager, private reactions: ReactiveRuntime,
    private experience: ExperienceLibrary | null, private host: RuntimeToolHost, private run: StoredRun) {
    this.workspace = new ProgramWorkspace(store, run.run_id);
  }

  async write(input: z.infer<typeof programWriteSchema>, callId: string, commit: () => void) {
    const previous = this.store.namedSkill(this.run.run_id, input.name);
    const assertParent = () => {
      const latest = this.store.namedSkill(this.run.run_id, input.name);
      if ((latest?.version ?? undefined) !== input.based_on) throw Object.assign(new RuntimeFault("conflict", "Existing names require based_on equal to the latest version; new names must omit based_on. Source is never silently rebased."), {
        issues: [{ code: "stale_parent", path: "based_on", latest_parent: latest ? { name: latest.name, version: latest.version } : null }],
      });
    };
    assertParent();
    const dependencies = z.array(skillRefSchema).parse(this.store.bindToolCall(this.run.run_id, callId,
      { tool: "program_write", input } as unknown as Json, () => {
        commit();
        return input.dependencies.map((selector) => {
          const dependency = this.workspace.select(selector, true);
          return { skill_id: dependency.skill_id, version: dependency.version };
        });
      }));
    if (input.reason && !previous) throw new RuntimeFault("invalid_request", "A candidate experiment reason requires an actual revision of an existing program");
    let opportunity: ImprovementOpportunity | null = null;
    if (input.reason && previous) {
      this.host.learning().feedback(this.run.run_id);
      opportunity = this.workspace.latestOpportunity(previous, true);
    }
    const program = await this.skills.register(this.run.run_id, { name: input.name, source: input.source, card: input.card, dependencies }, () => { commit(); assertParent(); });
    const experiment = opportunity && input.reason ? this.host.learning().resolve(this.run.run_id, opportunity.opportunity_id, {
      decision: "revise", reason: input.reason,
      revision: { run_id: this.run.run_id, skill_id: program.skill_id, version: program.version, hash: program.hash }, event_seqs: opportunity.event_seqs,
    }) : null;
    return { name: program.name, version: program.version, state: program.state, purpose: program.card.purpose,
      dependencies: input.dependencies.map((selector, index) => ({ name: selector.name, version: dependencies[index]!.version })),
      experiment: experiment?.resolution ? { decision: experiment.resolution.decision, measured: experiment.resolution.measured,
        qualification: "candidate_not_proven_improvement", reason: experiment.resolution.reason } : null };
  }

  startKey(callId: string): string { return `tool_${createHash("sha256").update(callId).digest("hex")}`; }

  async runProgram(input: z.infer<typeof programRunSchema>, callId: string, commit: () => void) {
    if (input.operation === "start") {
      const startKey = this.startKey(callId);
      const request = this.store.bindToolCall(this.run.run_id, callId, { tool: "program_run", input } as unknown as Json, () => {
        commit();
        this.host.planning().assertOrdinaryAdmission();
        const program = this.workspace.select(input, true);
        return { skill_id: program.skill_id, version: program.version, start_key: startKey,
          epoch: this.run.epoch, session_id: this.run.session_id!, life_id: this.run.life_id!,
          args: input.args, limits: input.limits, ...(input.next ? { lookahead: input.next } : {}) } as unknown as Json;
      }) as unknown as SkillStartRequest;
      const existing = this.skills.get(this.run.run_id, { start_key: startKey });
      if (!existing) { commit(); this.host.planning().assertOrdinaryAdmission(); }
      const result = this.skills.start(this.run.run_id, request);
      if (!existing) this.host.admitted();
      return this.workspace.executionSummary(result);
    }
    commit();
    if (input.operation === "activate_next") {
      const planId = z.string().parse(this.store.bindToolCall(this.run.run_id, callId,
        { tool: "program_run", input } as unknown as Json, () => {
          const plan = this.host.planning().projection();
          if (!plan) throw new RuntimeFault("not_found", "No prepared next program is available");
          return plan.plan_id;
        }));
      const activated = await this.host.planning().activate(planId);
      const candidate = activated.candidate ? this.store.skill(this.run.run_id, activated.candidate) : null;
      return { state: activated.state, candidate: candidate ? { name: candidate.name, version: candidate.version } : null,
        guard_status: activated.guard_status, activation: activated.activation };
    }
    if (input.operation === "attention") {
      let first = false;
      this.store.bindToolCall(this.run.run_id, callId, { tool: "program_run", input } as unknown as Json, () => {
        first = true;
        return { after_ms: input.after_ms, reason: input.reason };
      });
      if (first) this.host.attentionAfter(input.after_ms, input.reason);
      return input;
    }
    if (input.operation === "stop") {
      const selected = executionControlSchema.parse(this.store.bindToolCall(this.run.run_id, callId,
        { tool: "program_run", input } as unknown as Json, () => ({
          execution_id: this.workspace.execution(input.target)?.execution_id ?? null,
          plan_id: this.host.planning().projection()?.plan_id ?? null,
        })));
      const invalidated = selected.plan_id !== null && this.host.planning().projection()?.plan_id === selected.plan_id;
      if (invalidated) this.host.planning().invalidate("cancelled");
      const execution = selected.execution_id ? this.skills.get(this.run.run_id, { execution_id: selected.execution_id }) : null;
      return execution ? this.workspace.executionSummary(this.skills.cancel(this.run.run_id, { execution_id: execution.execution_id }))
        : { status: "idle", prepared_next: invalidated ? "invalidated" : "unchanged" };
    }
    const execution = this.workspace.execution(input.target);
    if (!execution) throw new RuntimeFault("not_found", "No matching execution is available");
    return this.workspace.executionSummary(execution);
  }

  async prepare(input: z.infer<typeof prepareNextSchema>, callId: string) {
    const selected = preparedSelectionSchema.parse(this.store.bindToolCall(this.run.run_id, callId,
      { tool: "prepare_next", input } as unknown as Json, () => {
        const plan = this.host.planning().projection();
        if (!plan) throw new RuntimeFault("not_found", "No current planning flight is available");
        const program = this.workspace.select(input, true);
        return { plan_id: plan.plan_id, skill: { skill_id: program.skill_id, version: program.version } };
      }));
    const program = this.store.skill(this.run.run_id, selected.skill);
    const staged = await this.host.planning().stage({ plan_id: selected.plan_id,
      skill: selected.skill, args: input.args, limits: input.limits,
      ...(input.guard_source === undefined ? {} : { guard_source: input.guard_source }) });
    return { state: staged.state, candidate: { name: program.name, version: program.version },
      guard_status: staged.guard_status, activation: staged.activation, deadline_at: staged.deadline_at };
  }

  async inspect(input: z.infer<typeof programInspectSchema>) {
    const workspace = this.workspace;
    switch (input.view) {
      case "catalog": return workspace.catalog(input.after, input.limit);
      case "source": return workspace.source(workspace.select(input));
      case "execution": return workspace.executionView(workspace.execution(input.target, input.program));
      case "history": {
        const program = input.program ? workspace.select(input.program) : null;
        return workspace.page(this.host.evidence().filter((entry) => !program || entry.skill_id === program.skill_id && (input.program?.version === undefined || entry.version === program.version))
          .map((entry) => workspace.historyView(entry)), input.after, input.limit);
      }
      case "trace": {
        let execution = workspace.execution(input.target, input.program);
        if (input.after > 0) {
          const cursor = this.store.traceRecord(this.run.run_id, input.after);
          if (!cursor) throw new RuntimeFault("invalid_request", "Trace cursor is not retained in this run");
          const selected = input.program ? workspace.select(input.program) : null;
          const id = selected ? cursor.execution_id ?? cursor.root_execution_id : cursor.root_execution_id ?? cursor.execution_id;
          execution = id ? this.store.skillExecution(this.run.run_id, { execution_id: id }) : null;
          if (selected) {
            while (execution && (execution.skill_id !== selected.skill_id ||
              input.program?.version !== undefined && execution.version !== input.program.version))
              execution = execution.parent_execution_id ? this.store.skillExecution(this.run.run_id, { execution_id: execution.parent_execution_id }) : null;
          }
          if (!execution) throw new RuntimeFault("conflict", "Trace cursor belongs to a different named execution scope");
        }
        if (!execution) throw new RuntimeFault("not_found", "No matching execution is available");
        const program = this.store.skill(this.run.run_id, execution);
        return { ...workspace.traceView(this.store.tracePage(this.run.run_id, input.after, input.limit, execution.execution_id)),
          program: { name: program.name, version: program.version } };
      }
      case "feedback": {
        const selected = input.program ? workspace.select(input.program) : null;
        const page = this.host.learning().readFeedback(this.run.run_id, input.after, input.limit);
        const executions = new Set(this.store.allSkillExecutions(this.run.run_id).filter((execution) => !selected ||
          execution.skill_id === selected.skill_id && (input.program?.version === undefined || execution.version === selected.version))
          .map((execution) => execution.execution_id));
        return workspace.feedbackView({ ...page,
          opportunities: page.opportunities.filter((entry) => !selected || entry.version.skill_id === selected.skill_id &&
            (input.program?.version === undefined || entry.version.version === selected.version)),
          metrics: page.metrics.filter((entry) => executions.has(entry.execution_id)),
        });
      }
      case "events": {
        const candidates = this.store.eventsAfter(this.run.run_id, input.after, input.limit + 1);
        const page = workspace.page(candidates.slice(0, input.limit), 0, input.limit);
        const through = candidates[page.next_after - 1]?.event_seq ?? input.after;
        return { records: page.records.map((event) => workspace.eventView(event)), next_after: through,
          has_more: page.has_more || candidates.length > input.limit, omissions: page.omissions };
      }
      case "comparison": {
        if (input.after_sample > 0 && (input.before.version === undefined || input.after.version === undefined))
          throw new RuntimeFault("conflict", "Continue comparison pages with the exact named versions returned on the first page");
        const before = workspace.select(input.before), after = workspace.select(input.after);
        const ref = (program: typeof before) => ({ run_id: this.run.run_id, skill_id: program.skill_id, version: program.version, hash: program.hash });
        return workspace.comparisonView(compareProgramVersionsPage(this.store, ref(before), ref(after), { kind: "model", run_id: this.run.run_id, model_id: this.run.model_id }, input.after_sample, input.limit));
      }
      case "planning": return workspace.planningView(this.host.planning().projection());
      case "action": {
        const execution = input.program ? workspace.execution(input.target, input.program) : null;
        if (input.program && !execution) throw new RuntimeFault("not_found", "No matching execution is available");
        return workspace.actionView(this.store.selectedAction(this.run.run_id, input.target, execution?.execution_id));
      }
      case "recipes": return await this.host.recipes(input.item);
    }
  }

  review(input: z.infer<typeof programReviewSchema>, callId: string) {
    this.host.learning().feedback(this.run.run_id);
    const opportunityId = z.string().parse(this.store.bindToolCall(this.run.run_id, callId,
      { tool: "program_review", input } as unknown as Json, () => {
        const selected = this.workspace.select(input);
        const outcome = input.version === undefined ? this.store.evidenceObjects<ImprovementOpportunity>(this.run.run_id, "opportunity")
          .filter((entry) => entry.version.skill_id === selected.skill_id).at(-1) : null;
        return this.workspace.latestOpportunity(outcome ? this.store.skill(this.run.run_id, outcome.version) : selected).opportunity_id;
      }));
    const opportunity = this.store.evidenceObjects<ImprovementOpportunity>(this.run.run_id, "opportunity")
      .find((entry) => entry.opportunity_id === opportunityId);
    if (!opportunity) throw new RuntimeFault("not_found", "Pinned outcome feedback is not retained");
    const program = this.store.skill(this.run.run_id, opportunity.version);
    const assessment = this.host.learning().resolve(this.run.run_id, opportunity.opportunity_id,
      { decision: input.decision, reason: input.reason, revision: null, event_seqs: opportunity.event_seqs });
    return { name: program.name, version: program.version, decision: assessment.resolution!.decision,
      reason: assessment.resolution!.reason, measured: assessment.resolution!.measured,
      qualification: "assessment_not_promotion_or_causal_improvement" };
  }

  async reflex(input: z.infer<typeof reflexSchema>, callId: string, generation: number, signal?: AbortSignal) {
    const identity = { tool: "reflex", input } as unknown as Json;
    if (input.operation === "write") {
      const epoch = z.number().int().nonnegative().parse(this.store.bindToolCall(this.run.run_id, callId, identity, () => this.run.epoch));
      const policy = await this.reactions.register(input.spec, epoch, generation);
      return { name: policy.name, version: policy.version, state: policy.state, backend: policy.backend };
    }
    const select = () => {
      const policy = this.store.policies(this.run.run_id).filter((policy) => policy.name === input.name && (input.version === undefined || policy.version === input.version)).sort((a, b) => b.version - a.version)[0];
      if (!policy) throw new RuntimeFault("not_found", "Named reflex version not found");
      return policy;
    };
    if (input.operation === "inspect") return this.workspace.policyView(select());
    const ref = policyRefSchema.parse(this.store.bindToolCall(this.run.run_id, callId, identity, () => {
      const policy = select();
      return { epoch: this.run.epoch, policy_id: policy.policy_id, version: policy.version };
    }));
    if (input.operation === "validate") return this.workspace.policyView(await this.reactions.validate(ref, generation, signal));
    if (input.operation === "retire") return this.workspace.policyView(await this.reactions.retire(ref, generation));
    return this.workspace.policyView(await this.reactions.activate({ ...ref, mode: input.mode,
      max_ms: input.max_ms, max_actions: input.max_actions, max_evaluations: input.max_evaluations }, generation, signal));
  }

  async memory(input: z.infer<typeof memorySchema>, callId: string, commit: () => void) {
    if (!this.experience) throw new RuntimeFault("backend_unavailable", "Experience library is not configured");
    if (input.operation === "catalog") {
      const page = this.experience.catalog(this.run.model_id, this.run.world_id, input.after, input.limit);
      return { ...page, records: page.records.map(({ name, version, portability, retained_world_data, created_at }) =>
        ({ name, version, portability, retained_world_data, created_at })) };
    }
    if (input.operation === "load") {
      const reference = exactNamedProgramSchema.parse(this.store.bindToolCall(this.run.run_id, callId,
        { tool: "memory", input } as unknown as Json, () => {
          const selected = this.experience!.named(this.run.model_id, this.run.world_id, input.name, input.version);
          if (!selected) throw new RuntimeFault("not_found", "Named compatible memory revision not found");
          return { name: selected.name, version: selected.version };
        }));
      const selected = this.experience.named(this.run.model_id, this.run.world_id, reference.name, reference.version);
      if (!selected) throw new RuntimeFault("not_found", "Named compatible memory revision not found");
      const program = await this.experience.hydrate(selected.experience_id, this.run.model_id, this.run.world_id, this.run.run_id, this.skills, commit);
      return { name: program.name, version: program.version, state: program.state,
        memory: { name: selected.name, version: selected.version } };
    }
    const executionId = z.string().parse(this.store.bindToolCall(this.run.run_id, callId,
      { tool: "memory", input } as unknown as Json, () => {
        const execution = this.workspace.execution(input.target, input.program);
        if (!execution) throw new RuntimeFault("not_found", "No matching execution is available");
        return execution.execution_id;
      }));
    const execution = this.store.skillExecution(this.run.run_id, { execution_id: executionId });
    if (!execution) throw new RuntimeFault("not_found", "No matching execution is available");
    const result = this.experience.promote(this.store, this.run.run_id, execution, input.name, input.declaration);
    this.store.event(this.run.run_id, "experience.promoted", "Explicit predicate-evidence-linked snapshot promoted", result as unknown as Json);
    return { name: result.name, version: this.experience.snapshotVersion(result.experience_id, this.run.model_id), portability: result.portability,
      qualification: "explicit_predicate_evidence_snapshot_not_causal_improvement" };
  }
}
