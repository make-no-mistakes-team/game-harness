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
import type { programInspectSchema, programReviewSchema, programRunSchema, programSubmitSchema, programWriteSchema, memorySchema, prepareNextSchema, reflexSchema } from "./program-interface.ts";
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

  async write(input: z.infer<typeof programWriteSchema>, callId: string, commit: () => void, signal?: AbortSignal) {
    const registration = this.registration(input, callId);
    const pinned = this.registered(input, callId);
    const previous = pinned ? pinned.parent_version === null ? null : this.store.namedSkill(this.run.run_id, input.name, pinned.parent_version)
      : this.store.namedSkill(this.run.run_id, input.name);
    const assertParent = () => {
      const latest = this.store.namedSkill(this.run.run_id, input.name);
      if ((latest?.version ?? undefined) !== input.based_on) throw Object.assign(new RuntimeFault("conflict", "Existing names require based_on equal to the latest version; new names must omit based_on. Source is never silently rebased."), {
        issues: [{ code: "stale_parent", path: "based_on", latest_parent: latest ? { name: latest.name, version: latest.version } : null }],
      });
    };
    if (!pinned) assertParent();
    const dependencies = pinned?.dependencies ?? z.array(skillRefSchema).parse(this.store.bindToolCall(this.run.run_id, callId,
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
      const feedbackKey = this.phaseKey(callId, "feedback"), identity = { tool: "program_write", input } as unknown as Json;
      const bound = this.store.lookupToolCallBinding(this.run.run_id, feedbackKey, identity);
      if (!bound.found) {
        await this.host.learning().prepareFeedback(this.run.run_id, { signal, deadlineHostMs: performance.now() + 10_000 });
        commit();
        if (!pinned) assertParent();
      }
      opportunity = (bound.found ? bound.value : this.store.bindToolCall(this.run.run_id, feedbackKey, identity, () => {
        commit();
        if (!pinned) assertParent();
        try {
          return this.workspace.latestOpportunity(previous) as unknown as Json;
        } catch (error) {
          if (!(error instanceof RuntimeFault) || error.code !== "not_found") throw error;
          throw Object.assign(new RuntimeFault("precondition_failed",
            "Top-level reason requires outcome feedback for the exact based_on version. For an ordinary revision, omit top-level reason and retain based_on; describe motivation in card.reason."), {
            issues: [{ code: "missing_parent_outcome", path: "reason" }],
          });
        }
      })) as unknown as ImprovementOpportunity;
    }
    const program = pinned ?? await this.skills.register(this.run.run_id, { entry: input.entry, name: input.name, source: input.source, card: input.card, dependencies },
      () => { commit(); assertParent(); }, registration);
    commit();
    let experiment: { decision: "revise"; measured: boolean; reason: string } | null = null;
    if (opportunity && input.reason) {
      const selected = opportunity, reason = input.reason;
      const revision = { run_id: this.run.run_id, skill_id: program.skill_id, version: program.version, hash: program.hash };
      // Bind the linkage and its event/resolution in the same transaction.
      // Replaying a persisted write cannot reselect a newer outcome, convert
      // our own prior resolution to a candidate event, or append that event twice.
      experiment = this.store.bindToolCall(this.run.run_id, this.phaseKey(callId, "feedback_link"),
        { tool: "program_write", input, revision } as unknown as Json, () => {
          const decision = { decision: "revise" as const, measured: false, reason };
          if (selected.resolution === null) {
            decision.measured = this.host.learning().resolve(this.run.run_id, selected.opportunity_id, {
              decision: decision.decision, reason, revision, event_seqs: selected.event_seqs,
            }).resolution!.measured;
          } else {
            this.store.event(this.run.run_id, "learning.candidate_written", "Recorded candidate revision without changing the prior outcome assessment", {
              opportunity_id: selected.opportunity_id, execution_id: selected.execution_id,
              parent: selected.version as unknown as Json, revision, event_seqs: selected.event_seqs,
              ...decision, qualification: "candidate_not_proven_improvement",
            });
          }
          return decision;
        }) as unknown as { decision: "revise"; measured: boolean; reason: string };
    }
    return { name: program.name, version: program.version, entry: program.entry, state: program.state, purpose: program.card.purpose,
      dependencies: input.dependencies.map((selector, index) => ({ name: selector.name, version: dependencies[index]!.version })),
      experiment: experiment ? { ...experiment, qualification: "candidate_not_proven_improvement" } : null };
  }

  private phaseKey(callId: string, phase: string): string {
    return `program_phase_${createHash("sha256").update(JSON.stringify([callId, phase])).digest("hex")}`;
  }

  private registration(input: z.infer<typeof programWriteSchema>, callId: string) {
    return { call_id: this.phaseKey(callId, "registration"), input: { tool: "program_write", input } as unknown as Json };
  }

  private registered(input: z.infer<typeof programWriteSchema>, callId: string) {
    const registration = this.registration(input, callId);
    const ref = this.store.completedToolCall(this.run.run_id, registration.call_id, registration.input);
    return ref === null ? null : this.store.skill(this.run.run_id, skillRefSchema.parse(ref));
  }

  submissionReceipt(callId: string, identity: Json): Json | null {
    return this.store.completedToolCall(this.run.run_id, this.phaseKey(callId, "outcome"), identity);
  }

  async submit(input: z.infer<typeof programSubmitSchema>, callId: string, commit: () => void, signal?: AbortSignal) {
    const identity = { tool: "program_submit", input } as unknown as Json;
    const outcomeKey = this.phaseKey(callId, "outcome");
    const completed = this.submissionReceipt(callId, identity);
    if (completed !== null) return completed;
    const writeInput = { name: input.name, entry: input.entry, source: input.source, card: input.card,
      dependencies: input.dependencies, ...(input.based_on === undefined ? {} : { based_on: input.based_on }),
      ...(input.reason === undefined ? {} : { reason: input.reason }) };
    const writeId = this.phaseKey(callId, "write"), startId = this.phaseKey(callId, "start");
    let first = false;
    this.store.bindToolCall(this.run.run_id, callId, identity, () => {
      commit();
      first = true;
      return { write_call_id: writeId, start_call_id: startId };
    });
    const failure = (error: unknown) => error instanceof RuntimeFault
      ? { code: error.code, message: error.message, retryable: false }
      : { code: "backend_unavailable", message: "The operation could not be acknowledged safely; inspect the persisted source and execution before making a new decision", retryable: false };
    const finish = (program: { name: string; version: number }, start: Json) => {
      const previous = this.store.completedToolCall(this.run.run_id, outcomeKey, identity);
      if (previous !== null) return previous;
      const outcome = { source: { status: "persisted", name: program.name, version: program.version }, start };
      this.store.completeToolCall(this.run.run_id, outcomeKey, identity, outcome);
      return outcome;
    };
    // A redelivered interrupted operation is evidence lookup, never another
    // write/start attempt. The atomic registration receipt is the only source
    // selector; a newer catalog revision cannot substitute for it.
    if (!first) {
      const program = this.registered(writeInput, writeId);
      if (!program) throw new RuntimeFault("conflict", "The original submission did not acknowledge source persistence; it cannot be retried automatically");
      const execution = this.skills.get(this.run.run_id, { start_key: this.startKey(startId) });
      return finish(program, execution ? { status: "started", execution: this.workspace.executionSummary(execution) }
        : { status: "unknown", error: failure(null) });
    }
    let program: { name: string; version: number };
    try {
      program = await this.write(writeInput, writeId, commit, signal);
    } catch (error) {
      const persisted = this.registered(writeInput, writeId);
      if (!persisted) throw error;
      return finish(persisted, { status: "refused", error: failure(error) });
    }
    try {
      const interrupted = this.store.completedToolCall(this.run.run_id, outcomeKey, identity);
      if (interrupted !== null) return interrupted;
      commit();
      const selection = { operation: "start" as const, name: program.name, version: program.version };
      const handoff = input.handoff ? { handoff: input.handoff } : {};
      const startCommit = () => {
        commit();
        if (input.handoff && this.store.completedToolCall(this.run.run_id, outcomeKey, identity) !== null)
          throw new RuntimeFault("stale_context", "Submission delivery was interrupted before handoff admission");
      };
      const execution = await this.runProgram(input.entry === "step"
        ? { ...selection, ...handoff, entry: "step", args: input.args, limits: input.limits, initial_state: input.initial_state,
          ...(input.next ? { next: input.next } : {}) }
        : { ...selection, ...handoff, entry: "run", args: input.args, limits: input.limits, ...(input.next ? { next: input.next } : {}) }, startId, startCommit);
      return finish(program, { status: "started", execution: execution as unknown as Json });
    } catch (error) {
      const existing = this.skills.get(this.run.run_id, { start_key: this.startKey(startId) });
      return finish(program, { status: error instanceof RuntimeFault && !existing ? "refused" : "unknown", error: failure(error) });
    }
  }

  startKey(callId: string): string { return `tool_${createHash("sha256").update(callId).digest("hex")}`; }

  async runProgram(input: z.infer<typeof programRunSchema>, callId: string, commit: () => void) {
    if (input.operation === "start") {
      const startKey = this.startKey(callId);
      const identity = { tool: "program_run", input } as unknown as Json;
      let first = false;
      const bound = this.store.bindToolCall(this.run.run_id, callId, identity, () => {
        commit();
        this.host.planning().assertOrdinaryAdmission();
        const program = this.workspace.select(input, true);
        if (program.entry !== input.entry) throw new RuntimeFault("precondition_failed", "Playing entry does not match the selected immutable source");
        const predecessor = input.handoff ? this.store.latestRootExecution(this.run.run_id) : null;
        const reference = predecessor ? this.workspace.executionReference(predecessor.execution_id) : null;
        if (input.handoff && (!predecessor || !["accepted", "running", "succeeded"].includes(predecessor.status) ||
            !reference || reference.name !== input.handoff.name || reference.version !== input.handoff.version ||
            reference.execution_ordinal !== input.handoff.execution_ordinal))
          throw new RuntimeFault("precondition_failed", "Handoff must name the exact latest live or successfully completed predecessor");
        first = true;
        return { entry: input.entry, skill_id: program.skill_id, version: program.version, start_key: startKey,
          epoch: this.run.epoch, session_id: this.run.session_id!, life_id: this.run.life_id!,
          native_boot_id: this.run.native_boot_id!, run_generation: this.host.generation(), space_epoch: this.run.space_epoch!,
          compatibility_hash: this.run.compatibility_hash!,
          args: input.args, limits: input.limits, ...(input.entry === "step" ? { initial_state: input.initial_state } : {}),
          ...(predecessor ? { handoff_predecessor_id: predecessor.execution_id } : {}),
          ...(input.next ? { lookahead: input.next } : {}) } as unknown as Json;
      }) as unknown as SkillStartRequest & { handoff_predecessor_id?: string };
      const { handoff_predecessor_id: predecessorId, ...request } = bound;
      const existing = this.skills.get(this.run.run_id, { start_key: startKey });
      if (input.handoff && !existing) {
        if (!predecessorId) throw new RuntimeFault("conflict", "Original handoff selection is unavailable");
        const outcomeKey = this.phaseKey(callId, "handoff_outcome");
        const interrupted = () => this.store.completedToolCall(this.run.run_id, outcomeKey, identity) !== null;
        const refuseReplay = () => new RuntimeFault("precondition_failed",
          "Original handoff did not acknowledge a successor; inspect source and execution. It is never dispatched again.");
        if (!first || interrupted()) {
          if (!interrupted()) this.store.completeToolCall(this.run.run_id, outcomeKey, identity, { status: "unknown" });
          throw refuseReplay();
        }
        const scope = () => JSON.stringify([this.host.generation(), this.run.task, this.run.goal, this.run.world_id,
          this.run.epoch, this.run.session_id, this.run.life_id, this.run.native_boot_id, this.run.space_epoch, this.run.compatibility_hash]);
        const selectedScope = scope();
        const current = () => {
          commit();
          if (scope() !== selectedScope || interrupted())
            throw new RuntimeFault("stale_context", "Handoff authority changed before successor admission");
          this.host.planning().assertOrdinaryAdmission();
        };
        const observe = async () => {
          const observation = await this.host.observe();
          current();
          if (observation.world_id !== this.run.world_id || observation.epoch !== request.epoch ||
              observation.session_id !== request.session_id || observation.native_boot_id !== request.native_boot_id ||
              observation.life.life_id !== request.life_id || observation.life.status !== "alive" ||
              observation.space.space_epoch !== request.space_epoch || observation.compatibility_hash !== request.compatibility_hash)
            throw new RuntimeFault("stale_context", "Handoff observation no longer matches the selected authority");
          return observation;
        };
        try {
          const before = await observe();
          current();
          // This method validates without effects, then synchronously revokes
          // only the pinned predecessor before its first retirement await.
          const retired = await this.skills.retireForHandoff(this.run.run_id, request, predecessorId);
          current();
          const after = await observe();
          retired();
          if (JSON.stringify(before.screen) !== JSON.stringify(after.screen) ||
              JSON.stringify(before.space) !== JSON.stringify(after.space))
            throw new RuntimeFault("stale_context", "Handoff screen or space changed during retirement");
          current();
        } catch (error) {
          if (!interrupted()) this.store.completeToolCall(this.run.run_id, outcomeKey, identity, {
            status: error instanceof RuntimeFault ? "refused" : "unknown",
          });
          throw error;
        }
      }
      if (!existing) { commit(); this.host.planning().assertOrdinaryAdmission(); }
      const result = this.skills.start(this.run.run_id, request);
      if (!existing) this.host.admitted();
      return this.workspace.executionSummary(result);
    }
    commit();
    if (input.operation === "update_intent") {
      return this.store.bindToolCall(this.run.run_id, callId, { tool: "program_run", input } as unknown as Json, () => {
        const execution = this.workspace.execution("current");
        if (!execution || execution.entry !== "step") throw new RuntimeFault("not_found", "No current resident execution");
        const version = this.skills.updateResidentIntent(this.run.run_id, execution.execution_id, input.intent, input.expected_version);
        this.store.event(this.run.run_id, "controller.intent", "Authored intent updated without changing source, root deadline or budgets", {
          execution_id: execution.execution_id, source_hash: execution.source_hash, previous_version: input.expected_version, intent_version: version,
        });
        return { ...this.workspace.executionSummary(execution), intent_version: version };
      });
    }
    if (input.operation === "analyze") {
      const identity = { tool: "program_run", input } as unknown as Json, resultKey = this.phaseKey(callId, "analysis_result");
      const previous = this.store.completedToolCall(this.run.run_id, resultKey, identity);
      if (previous !== null) return previous;
      let first = false;
      const selected = z.object({ execution_id: z.string(), source: skillRefSchema }).strict().parse(
        this.store.bindToolCall(this.run.run_id, callId, identity, () => {
          const execution = this.workspace.execution("current"), source = this.workspace.select(input, true);
          if (!execution || execution.entry !== "step" || source.entry !== "analyze")
            throw new RuntimeFault("precondition_failed", "Pure analysis requires a current resident and selected analyze source");
          first = true;
          return { execution_id: execution.execution_id, source: { skill_id: source.skill_id, version: source.version } };
        }));
      if (!first) return { status: "unknown", reason: "Original pure analysis result was not acknowledged; inspect retained analysis events. It is never dispatched again." };
      const result = await this.skills.analyzeResident(this.run.run_id, selected.execution_id, selected.source, input.input, input.expected_intent_version);
      this.store.completeToolCall(this.run.run_id, resultKey, identity, result as unknown as Json);
      return result;
    }
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
      let first = false;
      const selected = executionControlSchema.parse(this.store.bindToolCall(this.run.run_id, callId,
        { tool: "program_run", input } as unknown as Json, () => {
          first = true;
          return {
            execution_id: this.workspace.execution(input.target)?.execution_id ?? null,
            plan_id: this.host.planning().projection()?.plan_id ?? null,
          };
        }));
      if (first) this.skills.interruptHandoffs();
      const invalidated = selected.plan_id !== null && this.host.planning().projection()?.plan_id === selected.plan_id;
      if (invalidated) this.host.planning().invalidate("cancelled");
      const execution = selected.execution_id ? this.skills.get(this.run.run_id, { execution_id: selected.execution_id }) : null;
      return execution ? this.workspace.executionSummary(this.skills.cancel(this.run.run_id, { execution_id: execution.execution_id }))
        : { status: "idle", prepared_next: invalidated ? "invalidated" : "unchanged" };
    }
    const execution = this.workspace.execution(input.target);
    if (!execution) throw new RuntimeFault("not_found", "No matching execution is available");
    return this.workspace.executionView(this.skills.get(this.run.run_id, { execution_id: execution.execution_id }));
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
    if (program.entry !== input.entry)
      throw new RuntimeFault("precondition_failed", "Prepared entry does not match the selected immutable source");
    const staged = await this.host.planning().stage({ plan_id: selected.plan_id,
      skill: selected.skill, args: input.args,
      ...(input.entry === "step"
        ? { entry: "step" as const, initial_state: input.initial_state, limits: input.limits }
        : { entry: "run" as const, limits: input.limits }),
      ...(input.guard_source === undefined ? {} : { guard_source: input.guard_source }) });
    return { state: staged.state, candidate: { name: program.name, version: program.version },
      guard_status: staged.guard_status, activation: staged.activation, deadline_at: staged.deadline_at };
  }

  async inspect(input: z.infer<typeof programInspectSchema>, signal?: AbortSignal, commit?: () => void) {
    const workspace = this.workspace;
    switch (input.view) {
      case "catalog": return workspace.catalog(input.after, input.limit);
      case "source": return workspace.source(workspace.select(input));
      case "execution": {
        const selected = workspace.execution(input.target, input.program);
        return workspace.executionView(selected ? this.skills.get(this.run.run_id, { execution_id: selected.execution_id }) : null);
      }
      case "history":
      case "trace":
      case "feedback":
      case "events":
      case "metric":
      case "evidence":
      case "comparison": {
        const result = await this.host.history().query({ kind: "model_inspect", run_id: this.run.run_id, input },
          { signal, deadlineHostMs: performance.now() + 10_000 });
        commit?.();
        return result;
      }
      case "planning": return workspace.planningView(this.host.planning().projection());
      case "action": {
        const execution = input.program ? workspace.execution(input.target, input.program) : null;
        if (input.program && !execution) throw new RuntimeFault("not_found", "No matching execution is available");
        return workspace.actionView(this.store.selectedAction(this.run.run_id, input.target, execution?.execution_id));
      }
    }
  }

  async review(input: z.infer<typeof programReviewSchema>, callId: string, commit: () => void, signal?: AbortSignal) {
    const identity = { tool: "program_review", input } as unknown as Json;
    const bound = this.store.lookupToolCallBinding(this.run.run_id, callId, identity);
    if (!bound.found) {
      await this.host.learning().prepareFeedback(this.run.run_id, { signal, deadlineHostMs: performance.now() + 10_000 });
      commit();
    }
    const opportunityId = z.string().parse(bound.found ? bound.value : this.store.bindToolCall(this.run.run_id, callId, identity, () => {
      commit();
      const selected = this.workspace.select(input);
      const outcome = input.version === undefined ? this.store.latestOpportunityForFamily(this.run.run_id, selected.skill_id)
        : this.store.latestOpportunityForVersion({ run_id: this.run.run_id, skill_id: selected.skill_id, version: selected.version, hash: selected.hash });
      if (!outcome) throw new RuntimeFault("not_found", "No matching outcome feedback is available for this named version");
      return outcome.opportunity_id;
    }));
    commit();
    const opportunity = this.store.opportunity(this.run.run_id, opportunityId);
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
      max_ms: input.max_ms, max_actions: input.max_actions, max_evaluations: input.max_evaluations,
      ...(input.watch ? { watch: input.watch } : {}) }, generation, signal));
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
