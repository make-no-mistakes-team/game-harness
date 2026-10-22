import { createHash, randomUUID } from "node:crypto";
import type { Json, Observation } from "../shared/contracts.ts";
import type { LookaheadConfig, LookaheadRequest, PlanningContext, PlanningScope, PlanningSource, PlanProjection, PlanRejectReason, StageCorrection, StagePlanRequest } from "../shared/planning.ts";
import type { SkillExecutionView, SkillRef, SkillStartRequest, SkillView } from "../shared/programs.ts";
import { lookaheadConfigSchema, skillLimitsSchema, skillRefSchema } from "../shared/validation.ts";
import { ProgramValidationError, validateProgramSource } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";

export interface SpeculativeHost {
  admissionContext(): PlanningScope | null;
  context(): PlanningContext | null;
  skill(ref: SkillRef): SkillView | null;
  observe(): Promise<Observation>;
  evaluatePrecondition(source: string, context: Json, signal: AbortSignal): Promise<boolean>;
  /** Recheck permit immediately before durable admission, including after awaits. */
  admit(request: SkillStartRequest, permit: { signal: AbortSignal; assertCurrent(): void }): Promise<SkillExecutionView>;
  evidence(type: string, details: Json): void;
  wake(): void;
}
interface Draft {
  view: PlanProjection;
  controller: AbortController;
  request: StagePlanRequest | null;
  sources: PlanningSource[];
  deadline: number;
  overlapStarted: number | null;
  timer: NodeJS.Timeout | undefined;
}
const LIVE: Record<string, true> = { armed: true, planning: true, staged: true, validating: true };
const TERMINAL_ROOT: Record<string, true> = { succeeded: true, blocked: true, failed: true, cancelled: true, unknown: true };
const ALLOWED_TOOLS: Record<string, true> = {
  capabilities_read: true, observation_read: true, skill_read: true,
  skill_history: true, skill_get: true,
  feedback_read: true, recipes_read: true,
  action_get: true, planning_stage: true, planning_read: true,
  improvement_feedback: true, version_compare: true, trace_read: true,
};
const CORRECTABLE_SOURCE_ISSUES: Record<string, true> = {
  invalid_syntax: true, invalid_source: true, source_bytes_limit: true,
  formatted_lines_limit: true, complexity_limit: true, nesting_limit: true,
};

/** Provider catalog and dispatch authority use this same read-only selection. */
export function isSpeculativeTool(name: string): boolean {
  return Object.hasOwn(ALLOWED_TOOLS, name);
}

/** A draft grants no effect authority. Only fresh guarded admission can start it. */
export class SpeculativePlanning {
  private draft: Draft | null = null;
  private readonly usedRoots = new Set<string>();
  private runId: string | null = null;
  private authorityRevision = 0;
  constructor(private readonly host: SpeculativeHost) {}

  projection(): PlanProjection | null {
    return this.draft ? structuredClone(this.draft.view) : null;
  }

  remainingMs(): number {
    return this.draft ? Math.max(0, this.draft.deadline - performance.now()) : 0;
  }

  /** Validate before durable root admission; arm synchronously before handoff. */
  prepareOptIn(config: LookaheadConfig): (executionId: string) => PlanProjection {
    const configuration = lookaheadConfigSchema.parse(config);
    const scope = this.host.admissionContext();
    if (!scope || scope.life_status !== "alive")
      throw new RuntimeFault("stale_context", "Lookahead admission requires a ready alive player");
    if (this.draft && Object.hasOwn(LIVE, this.draft.view.state))
      throw new RuntimeFault("conflict", "Only one lookahead flight or draft is permitted");
    if (scope.run_id === this.runId && this.usedRoots.size >= 256)
      throw new RuntimeFault("conflict", "This run has no unused lookahead allowance");
    const basis = structuredClone(scope);
    const revision = this.authorityRevision;
    let consumed = false;
    return (executionId) => {
      if (consumed)
        throw new RuntimeFault("conflict", "Prepared lookahead admission was already consumed");
      consumed = true;
      const current = this.host.admissionContext();
      if (revision !== this.authorityRevision || !current ||
          current.life_status !== "alive")
        throw new RuntimeFault("stale_context", "Prepared lookahead admission was revoked");
      for (const key of ["run_id", "generation", "session_id", "world_id", "epoch", "life_id", "task", "goal"] as const)
        if (current[key] !== basis[key])
          throw new RuntimeFault("stale_context", "Prepared lookahead admission belongs to another scope");
      return this.optIn({ ...configuration, root_execution_id: executionId });
    };
  }

  optIn(request: LookaheadRequest): PlanProjection {
    const context = this.host.context();
    if (!context || context.life_status !== "alive" || !["accepted", "running"].includes(context.root.status) || context.root.execution_id !== request.root_execution_id)
      throw new RuntimeFault("stale_context", "Lookahead requires the current live root");
    if (context.run_id !== this.runId) {
      this.invalidate("session_changed");
      this.usedRoots.clear();
      this.runId = context.run_id;
    }
    if (this.draft && Object.hasOwn(LIVE, this.draft.view.state))
      throw new RuntimeFault("conflict", "Only one lookahead flight or draft is permitted");
    if (this.usedRoots.has(request.root_execution_id) || this.usedRoots.size >= 256)
      throw new RuntimeFault("conflict", "This run has no unused lookahead allowance for this root");
    const configuration = lookaheadConfigSchema.parse({
      after_ms: request.after_ms, reason: request.reason, budget: request.budget,
    });
    const { duration_ms } = configuration.budget;
    this.usedRoots.add(request.root_execution_id);
    const draft: Draft = {
      view: {
        plan_id: randomUUID(), state: "armed", planning_active: false, reason: null, intent: request.reason,
        basis: structuredClone(context), candidate: null, precondition_hash: null,
        deadline_at: new Date(Date.now() + request.after_ms + duration_ms).toISOString(),
        budget: { ...request.budget }, calls: 0, tools: 0, observation_seq: null,
        activation_execution_id: null, overlap_ms: 0,
      },
      controller: new AbortController(), request: null, sources: [],
      deadline: performance.now() + request.after_ms + duration_ms,
      overlapStarted: null, timer: undefined,
    };
    this.draft = draft;
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      if (this.draft !== draft || draft.view.state !== "armed") return;
      try { this.assertIdentity(draft); } catch { return; }
      draft.timer = setTimeout(() => this.reject(draft, "deadline"), Math.max(1, draft.deadline - performance.now()));
      this.host.wake();
    }, request.after_ms);
    this.record(draft, "requested");
    return this.projection()!;
  }

  /** Called by the serialized strategist only, never by observation polling. */
  begin(): PlanProjection | null {
    const draft = this.draft;
    if (!draft || draft.view.state !== "armed") return null;
    try { this.assertIdentity(draft); } catch { return null; }
    if (Object.hasOwn(TERMINAL_ROOT, this.host.context()!.root.status)) {
      this.reject(draft, "predecessor_already_settled");
      return null;
    }
    clearTimeout(draft.timer);
    draft.view.state = "planning";
    draft.view.planning_active = true;
    draft.overlapStarted = performance.now();
    draft.timer = setTimeout(() => this.reject(draft, "deadline"), Math.max(1, draft.deadline - performance.now()));
    this.record(draft, "started");
    return this.projection();
  }

  requestCall(): boolean {
    const draft = this.draft;
    if (!draft || !draft.view.planning_active || !["planning", "staged"].includes(draft.view.state)) return false;
    try { this.assertIdentity(draft); } catch { return false; }
    if (draft.view.calls >= draft.view.budget.calls) return false;
    draft.view.calls++;
    this.record(draft, "request");
    return true;
  }

  /** Captured once by tool preparation; a later flight cannot inherit it. */
  authority(): () => void {
    const draft = this.draft;
    if (!draft) throw new RuntimeFault("stale_context", "No lookahead authority");
    this.assertToolAuthority();
    return () => {
      this.assertIdentity(draft);
      if (!draft.view.planning_active || !["planning", "staged"].includes(draft.view.state))
        throw new RuntimeFault("stale_context", "Lookahead tool authority is closed");
    };
  }

  assertToolAuthority(tool?: string): void {
    const draft = this.draft;
    if (!draft || !draft.view.planning_active || !["planning", "staged"].includes(draft.view.state))
      throw new RuntimeFault("stale_context", "Lookahead tool authority is closed");
    this.assertIdentity(draft);
    if (tool !== undefined) {
      if (draft.view.tools >= draft.view.budget.tools) {
        this.reject(draft, "budget_exhausted");
        throw new RuntimeFault("stale_context", "Lookahead tool budget exhausted");
      }
      draft.view.tools++;
      if (!isSpeculativeTool(tool)) throw new RuntimeFault("invalid_request", "Lookahead only permits read-only evidence and staging");
    }
  }

  async stage(request: StagePlanRequest): Promise<PlanProjection> {
    this.assertToolAuthority();
    const draft = this.draft!;
    const authority = this.authority();
    if (request.plan_id !== draft.view.plan_id || draft.request)
      throw new RuntimeFault("conflict", "A flight permits exactly one exact staged candidate");
    skillRefSchema.parse(request.skill);
    skillLimitsSchema.parse(request.limits);
    if (Buffer.byteLength(JSON.stringify(request.args)) > 16_384)
      throw new RuntimeFault("invalid_request", "Staged arguments exceed 16KiB");
    if (request.precondition_source.length > 16_384)
      throw new RuntimeFault("invalid_request", "Precondition source exceeds 16384 characters");
    // Reserve staging across async static validation to prevent double staging.
    const stagedRequest = structuredClone(request);
    draft.request = stagedRequest;
    const attemptId = randomUUID();
    let rejection: PlanRejectReason = "precondition_error";
    try {
      const validated = await validateProgramSource(stagedRequest.precondition_source, "policy");
      authority();
      rejection = "source_changed";
      const sources = this.captureSources(stagedRequest.skill);
      const candidate = sources[0];
      if (!candidate)
        throw new RuntimeFault("not_found", "Selected exact program version is unavailable in the current scope");
      draft.sources = sources;
      draft.view.candidate = { ...candidate };
      draft.view.precondition_hash = validated.hash;
      draft.view.state = "staged";
      draft.view.reason = null;
      this.record(draft, "staged");
      return structuredClone(draft.view);
    } catch (error) {
      let correctable = error instanceof ProgramValidationError &&
        error.issues.length > 0 && error.issues.every((issue) => Object.hasOwn(CORRECTABLE_SOURCE_ISSUES, issue.code));
      let effectiveError = error;
      if (correctable) {
        try { authority(); }
        catch (stale) { correctable = false; effectiveError = stale; }
      }
      if (correctable) {
        draft.request = null;
        draft.view.state = "planning";
        draft.view.reason = "precondition_error";
      } else if (Object.hasOwn(LIVE, draft.view.state)) this.reject(draft, rejection);
      const correction: StageCorrection = {
        plan_id: draft.view.plan_id,
        correction_allowed: false,
        remaining_calls: Math.max(0, draft.view.budget.calls - draft.view.calls),
        remaining_tools: Math.max(0, draft.view.budget.tools - draft.view.tools),
        remaining_ms: Math.max(0, draft.deadline - performance.now()),
        deadline_at: draft.view.deadline_at,
      };
      correction.correction_allowed = correctable && correction.remaining_calls > 0 &&
        correction.remaining_tools > 0 && correction.remaining_ms > 0;
      this.recordStageFailure(draft, stagedRequest, attemptId, error, correction);
      if (effectiveError instanceof ProgramValidationError)
        throw Object.assign(effectiveError, { stage_correction: correction });
      throw effectiveError;
    }
  }

  finish(planId: string): void {
    const draft = this.draft;
    if (!draft || draft.view.plan_id !== planId) return;
    draft.view.planning_active = false;
    this.closeOverlap(draft);
    if (draft.view.state === "planning") {
      draft.view.state = "empty";
      clearTimeout(draft.timer);
      draft.controller.abort();
      this.record(draft, "empty");
    } else if (draft.view.state === "staged") this.record(draft, "settled");
  }

  /** Runtime calls at actual root closure, before waking ordinary replanning. */
  predecessorSettled(executionId: string): void {
    const draft = this.draft;
    if (!draft || draft.view.basis.root.execution_id !== executionId) return;
    this.closeOverlap(draft);
    const context = this.host.context();
    if (context?.root.execution_id === executionId && context.root.status !== "succeeded")
      this.reject(draft, "predecessor_unsuccessful");
    else this.record(draft, "predecessor_settled");
  }

  async activate(planId: string): Promise<PlanProjection> {
    const draft = this.draft;
    if (!draft || draft.view.plan_id !== planId) throw new RuntimeFault("stale_context", "Unknown staged plan");
    if (draft.view.state !== "staged")
      throw new RuntimeFault("conflict", draft.view.state === "activated" ? "Plan already activated" : "Plan is not staged");
    if (draft.view.planning_active)
      throw new RuntimeFault("conflict", "Lookahead is still planning");
    this.assertIdentity(draft);
    const predecessor = this.host.context()!.root;
    if (!Object.hasOwn(TERMINAL_ROOT, predecessor.status)) throw new RuntimeFault("conflict", "Predecessor is still pending");
    if (predecessor.status !== "succeeded") {
      this.reject(draft, "predecessor_unsuccessful");
      return structuredClone(draft.view);
    }
    // Reserve synchronously before obtaining observation or invoking isolation.
    draft.view.state = "validating";
    this.record(draft, "validation_started");
    let phase: PlanRejectReason = "precondition_error";
    try {
      const observation = await this.host.observe();
      this.assertActivation(draft);
      const basis = draft.view.basis;
      if (observation.session_id !== basis.session_id || observation.epoch !== basis.epoch || observation.world_id !== basis.world_id) throw new Error("session_changed");
      if (observation.life.life_id !== basis.life_id || observation.life.status !== "alive") throw new Error("life_changed");
      draft.view.observation_seq = observation.observation_seq;
      const request = draft.request!;
      const allowed = await this.host.evaluatePrecondition(request.precondition_source, JSON.parse(JSON.stringify({ observation, task: basis.task, goal: basis.goal, predecessor: this.host.context()!.root, candidate: draft.view.candidate, args: request.args })), draft.controller.signal);
      this.assertActivation(draft);
      if (allowed !== true) {
        this.reject(draft, "precondition_failed");
        return structuredClone(draft.view);
      }
      phase = "admission_failed";
      const execution = await this.host.admit({
        skill_id: request.skill.skill_id, version: request.skill.version,
        start_key: `plan_${draft.view.plan_id}`, epoch: basis.epoch,
        session_id: basis.session_id, life_id: basis.life_id,
        args: structuredClone(request.args), limits: { ...request.limits },
      }, { signal: draft.controller.signal, assertCurrent: () => this.assertActivation(draft) });
      // Admission changes current root; the permit, not a post-admission old-root
      // comparison, is the atomic source of authority.
      if (draft.controller.signal.aborted) throw new Error("cancelled");
      draft.view.state = "activated";
      draft.view.activation_execution_id = execution.execution_id;
      clearTimeout(draft.timer);
      this.record(draft, "activated");
    } catch (error) {
      if (Object.hasOwn(LIVE, draft.view.state)) {
        const message = error instanceof Error ? error.message : "";
        this.reject(draft, ["session_changed", "life_changed", "source_changed"].includes(message) ? message as PlanRejectReason : phase);
      }
    }
    return structuredClone(draft.view);
  }

  invalidate(reason: PlanRejectReason = "cancelled"): void {
    this.authorityRevision++;
    const draft = this.draft;
    if (draft && Object.hasOwn(LIVE, draft.view.state)) this.reject(draft, reason, true);
  }

  private assertActivation(draft: Draft): void {
    this.assertIdentity(draft);
    if (draft.view.state !== "validating") throw new Error("cancelled");
    if (this.host.context()!.root.status !== "succeeded") {
      this.reject(draft, "predecessor_unsuccessful");
      throw new Error("predecessor_unsuccessful");
    }
    let currentSources: PlanningSource[];
    try { currentSources = this.captureSources(draft.request!.skill); }
    catch (error) {
      this.reject(draft, "source_changed");
      throw error;
    }
    if (JSON.stringify(currentSources) !== JSON.stringify(draft.sources)) {
      this.reject(draft, "source_changed");
      throw new RuntimeFault("stale_context", "Captured exact program source or dependency closure changed after staging");
    }
  }

  private assertIdentity(draft: Draft): void {
    if (draft !== this.draft || draft.controller.signal.aborted || !Object.hasOwn(LIVE, draft.view.state)) throw new RuntimeFault("stale_context", "cancelled");
    const now = this.host.context();
    const basis = draft.view.basis;
    let reason: PlanRejectReason | null = null;
    if (!now || now.run_id !== basis.run_id || now.generation !== basis.generation || now.session_id !== basis.session_id || now.world_id !== basis.world_id || now.epoch !== basis.epoch) reason = "session_changed";
    else if (now.life_id !== basis.life_id || now.life_status !== "alive") reason = "life_changed";
    else if (now.task !== basis.task || now.goal !== basis.goal) reason = "task_changed";
    else if (now.root.execution_id !== basis.root.execution_id || now.root.skill_id !== basis.root.skill_id || now.root.version !== basis.root.version || now.root.hash !== basis.root.hash) reason = "predecessor_changed";
    else if (now.root.status === "cancel_requested" || (Object.hasOwn(TERMINAL_ROOT, now.root.status) && now.root.status !== "succeeded")) reason = "predecessor_unsuccessful";
    else if (performance.now() >= draft.deadline) reason = "deadline";
    if (reason) { this.reject(draft, reason); throw new RuntimeFault("stale_context", reason); }
  }

  private captureSources(ref: SkillRef, captured = new Map<string, PlanningSource>()): PlanningSource[] {
    const key = `${ref.skill_id}:${ref.version}`;
    if (captured.has(key)) return [...captured.values()];
    const skill = this.host.skill(ref);
    if (!skill)
      throw new RuntimeFault("not_found", "Selected exact program version is unavailable in the current run/model scope");
    if (skill.skill_id !== ref.skill_id || skill.version !== ref.version)
      throw new RuntimeFault("stale_context", "Resolved program identity does not match the model-selected exact version");
    if (skill.state !== "validated")
      throw new RuntimeFault("precondition_failed", "Selected exact program version is not validated");
    if (createHash("sha256").update(skill.source).digest("hex") !== skill.hash)
      throw new RuntimeFault("stale_context", "Selected program source does not match its immutable hash");
    if (captured.size >= 64)
      throw new RuntimeFault("precondition_failed", "Selected dependency closure exceeds the bounded snapshot allowance");
    captured.set(key, { skill_id: skill.skill_id, version: skill.version, hash: skill.hash });
    for (const dependency of skill.dependencies) this.captureSources(dependency, captured);
    return [...captured.values()];
  }

  private closeOverlap(draft: Draft): void {
    if (draft.overlapStarted === null) return;
    draft.view.overlap_ms += Math.max(0, performance.now() - draft.overlapStarted);
    draft.overlapStarted = null;
  }
  private reject(draft: Draft, reason: PlanRejectReason, invalidated = false): void {
    if (!Object.hasOwn(LIVE, draft.view.state)) return;
    this.closeOverlap(draft);
    draft.view.state = invalidated ? "invalidated" : reason === "deadline" ? "expired" : "rejected";
    draft.view.planning_active = false;
    draft.view.reason = reason;
    clearTimeout(draft.timer);
    draft.controller.abort();
    this.record(draft, "rejected");
  }
  private record(draft: Draft, event: string): void {
    this.host.evidence(`planning.${event}`, JSON.parse(JSON.stringify(draft.view)));
  }

  private recordStageFailure(draft: Draft, request: StagePlanRequest, attemptId: string, error: unknown, correction: StageCorrection): void {
    const source = request.precondition_source;
    const hash = createHash("sha256").update(source).digest("hex");
    const bytes = Buffer.byteLength(source);
    const count = Math.ceil(source.length / 2048);
    for (let index = 0; index < count; index++) this.host.evidence("planning.precondition_source", {
      run_id: draft.view.basis.run_id, plan_id: draft.view.plan_id, attempt_id: attemptId,
      source_hash: hash, source_bytes: bytes,
      chunk_index: index, chunk_count: count, chunk_unit: "utf16_code_units",
      source_chunk: source.slice(index * 2048, (index + 1) * 2048),
    });
    this.host.evidence("planning.stage_rejected", {
      run_id: draft.view.basis.run_id, plan_id: draft.view.plan_id, attempt_id: attemptId,
      root_execution_id: draft.view.basis.root.execution_id,
      candidate: { skill_id: request.skill.skill_id, version: request.skill.version },
      state: draft.view.state, source_hash: hash, source_chunk_count: count,
      error: {
        code: error instanceof ProgramValidationError ? "invalid_program" : error instanceof RuntimeFault ? error.code : draft.view.reason ?? "precondition_error",
        message: error instanceof Error ? error.message.slice(0, 300) : "Precondition staging failed",
      },
      issues: error instanceof ProgramValidationError ? JSON.parse(JSON.stringify(error.issues.slice(0, 32))) : [],
      omitted_issue_count: error instanceof ProgramValidationError ? Math.max(0, error.issues.length - 32) : 0,
      stage_correction: JSON.parse(JSON.stringify(correction)),
    });
  }
}
