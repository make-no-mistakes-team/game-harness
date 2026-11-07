import { createHash, randomUUID } from "node:crypto";
import type { Json, ObservationV3 } from "../shared/contracts.ts";
import type { LookaheadConfig, LookaheadRequest, PlanningContext, PlanningScope, PlanningSource, PlanProjection, PlanRejectReason, StageCorrection, StagePlanRequest } from "../shared/planning.ts";
import type { SkillExecutionView, SkillRef, SkillStartRequest, SkillView } from "../shared/programs.ts";
import { lookaheadConfigSchema, skillLimitsSchema, skillRefSchema } from "../shared/validation.ts";
import { isSpeculativeTool } from "../shared/tool-policy.ts";
import { residentIntentSchema, residentLimitsSchema, residentStateSchema } from "../shared/resident.ts";
import { ProgramValidationError, programFingerprint, validateProgramSource, type ExecutableValidationContext } from "./program-validation.ts";
import { canonicalContractJson } from "./adapter-contract.ts";
import { sameScreen } from "../shared/control.ts";
import { RuntimeFault } from "./runtime-fault.ts";

export interface SpeculativeHost {
  contract(): ExecutableValidationContext;
  admissionContext(): PlanningScope | null;
  context(): PlanningContext | null;
  skill(ref: SkillRef): SkillView | null;
  observe(): Promise<ObservationV3>;
  evaluateGuard(source: string, observation: ObservationV3, args: Json, signal: AbortSignal): Promise<boolean>;
  /** Recheck permit immediately before durable admission, including after awaits. */
  admit(request: SkillStartRequest, permit: { signal: AbortSignal; assertCurrent(): void }): Promise<SkillExecutionView>;
  evidence(type: string, details: Json): void;
  wake(reason: "lookahead" | "continuation"): void;
}
interface Draft {
  view: PlanProjection;
  controller: AbortController;
  request: StagePlanRequest | null;
  sources: PlanningSource[];
  deadline: number;
  overlapStarted: number | null;
  timer: NodeJS.Timeout | undefined;
  automaticAttempt: Promise<PlanProjection> | null;
  continuationWoken: boolean;
}
const LIVE: Record<string, true> = { armed: true, planning: true, staged: true, validating: true };
const TERMINAL_ROOT: Record<string, true> = { succeeded: true, blocked: true, failed: true, cancelled: true, unknown: true };
const CORRECTABLE_SOURCE_ISSUES: Record<string, true> = {
  invalid_syntax: true, invalid_source: true, source_bytes_limit: true,

};

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
      for (const key of ["run_id", "generation", "session_id", "world_id", "epoch", "life_id", "task", "native_boot_id", "space_epoch", "compatibility_hash"] as const)
        if (current[key] !== basis[key])
          throw new RuntimeFault("stale_context", "Prepared lookahead admission belongs to another scope");
      if (canonicalContractJson(current.goal) !== canonicalContractJson(basis.goal) || !sameScreen(current.screen, basis.screen))
        throw new RuntimeFault("stale_context", "Prepared lookahead goal or screen precondition changed");
      return this.arm({ ...configuration, root_execution_id: executionId });
    };
  }

  optIn(request: LookaheadRequest): PlanProjection {
    if (request.activation === "on_predecessor_success")
      throw new RuntimeFault("invalid_request", "Automatic continuation requires Main authorization at root start");
    return this.arm(request);
  }

  private arm(request: LookaheadRequest): PlanProjection {
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
      ...(request.activation === undefined ? {} : { activation: request.activation }),
    });
    const { duration_ms } = configuration.budget;
    this.usedRoots.add(request.root_execution_id);
    const draft: Draft = {
      view: {
        plan_id: randomUUID(), state: "armed", planning_active: false, reason: null, intent: request.reason,
        basis: structuredClone(context), candidate: null, guard_hash: null, guard_status: "omitted",
        activation: configuration.activation ?? "manual",
        activation_permit: configuration.activation === "on_predecessor_success" ? "available" : "not_authorized",
        activation_trigger: null, predecessor_closed: false,
        deadline_at: new Date(Date.now() + request.after_ms + duration_ms).toISOString(),
        budget: { ...request.budget }, calls: 0, tools: 0, observation_seq: null,
        activation_execution_id: null, overlap_ms: 0,
      },
      controller: new AbortController(), request: null, sources: [],
      deadline: performance.now() + request.after_ms + duration_ms,
      overlapStarted: null, timer: undefined, automaticAttempt: null, continuationWoken: false,
    };
    this.draft = draft;
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      if (this.draft !== draft || draft.view.state !== "armed") return;
      try { this.assertIdentity(draft); } catch { return; }
      draft.timer = setTimeout(() => this.reject(draft, "deadline"), Math.max(1, draft.deadline - performance.now()));
      this.host.wake("lookahead");
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
      if (!isSpeculativeTool(tool)) throw new RuntimeFault("invalid_request", "Lookahead only permits evidence, inactive source preparation and staging");
    }
  }

  async stage(request: StagePlanRequest): Promise<PlanProjection> {
    this.assertToolAuthority();
    const draft = this.draft!;
    const authority = this.authority();
    if (request.plan_id !== draft.view.plan_id || draft.request)
      throw new RuntimeFault("conflict", "A flight permits exactly one exact staged candidate");
    if (Object.keys(request).some((key) => !["plan_id", "skill", "entry", "initial_state", "args", "limits", "guard_source"].includes(key)))
      throw new RuntimeFault("invalid_request", "Staging accepts only an exact candidate, arguments, limits and optional game guard");
    skillRefSchema.parse(request.skill);
    if (request.entry === "step") {
      residentLimitsSchema.parse(request.limits);
      residentIntentSchema.parse(request.args);
      residentStateSchema.parse(request.initial_state);
    } else {
      if (request.entry !== undefined && request.entry !== "run" || "initial_state" in request)
        throw new RuntimeFault("invalid_request", "Prepared entry and state must match its playing contract");
      skillLimitsSchema.parse(request.limits);
    }
    if (Buffer.byteLength(JSON.stringify(request.args)) > 16_384)
      throw new RuntimeFault("invalid_request", "Staged arguments exceed 16KiB");
    // Reserve staging across async static validation to prevent double staging.
    const stagedRequest = structuredClone(request);
    draft.request = stagedRequest;
    draft.view.guard_status = stagedRequest.guard_source === undefined ? "omitted" : "pending";
    const attemptId = randomUUID();
    let rejection: PlanRejectReason = "guard_error";
    try {
      const validated = stagedRequest.guard_source === undefined
        ? null : await validateProgramSource(stagedRequest.guard_source, "guard", this.host.contract());
      authority();
      rejection = "source_changed";
      const sources = this.captureSources(stagedRequest.skill);
      if (this.host.skill(stagedRequest.skill)?.entry !== (stagedRequest.entry ?? "run"))
        throw new RuntimeFault("precondition_failed", "Prepared entry does not match the selected immutable source");
      const candidate = sources[0];
      if (!candidate)
        throw new RuntimeFault("not_found", "Selected exact program version is unavailable in the current scope");
      draft.sources = sources;
      draft.view.candidate = { ...candidate };
      draft.view.guard_hash = validated?.hash ?? null;
      draft.view.guard_status = validated ? "pending" : "omitted";
      draft.view.state = "staged";
      draft.view.reason = null;
      this.record(draft, "staged");
      return structuredClone(draft.view);
    } catch (error) {
      if (rejection === "guard_error") draft.view.guard_status = "error";
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
        draft.view.reason = "guard_error";
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
      if (draft.view.activation_permit === "available") draft.view.activation_permit = "revoked";
      clearTimeout(draft.timer);
      draft.controller.abort();
      this.record(draft, "empty");
      this.wakeContinuation(draft);
    } else if (draft.view.state === "staged") {
      this.record(draft, "settled");
      this.tryAutomaticActivation(draft);
    }
  }

  /** Runtime calls at actual root closure, before waking ordinary replanning. */
  predecessorSettled(executionId: string): boolean {
    const draft = this.draft;
    if (!draft || !Object.hasOwn(LIVE, draft.view.state) || draft.view.basis.root.execution_id !== executionId) return false;
    this.closeOverlap(draft);
    try { this.assertIdentity(draft); } catch { return false; }
    if (this.host.context()!.root.status !== "succeeded")
      this.reject(draft, "predecessor_unsuccessful");
    else {
      draft.view.predecessor_closed = true;
      this.record(draft, "predecessor_settled");
      if (draft.view.state === "armed") {
        this.reject(draft, "predecessor_already_settled");
        return false;
      }
      this.tryAutomaticActivation(draft);
      return draft.view.activation === "on_predecessor_success" &&
        (draft.view.planning_active || ["staged", "validating"].includes(draft.view.state));
    }
    return false;
  }

  /** Scheduler joins this task before considering obsolete predecessor outcomes. */
  async pendingActivation(predecessorId?: string): Promise<PlanProjection | null> {
    const draft = this.draft;
    if (!draft || (predecessorId !== undefined && predecessorId !== draft.view.basis.root.execution_id)) return null;
    return await (draft.automaticAttempt ?? Promise.resolve(null));
  }

  /** Ordinary facade admission cannot race a reserved continuation. */
  assertOrdinaryAdmission(): void {
    const view = this.draft?.view;
    if (view && (view.state === "validating" || (view.predecessor_closed &&
        view.activation === "on_predecessor_success" && Object.hasOwn(LIVE, view.state))))
      throw new RuntimeFault("conflict", "Prepared continuation owns admission");
  }

  async activate(planId: string): Promise<PlanProjection> {
    return await this.activateDraft(planId, "manual");
  }

  private tryAutomaticActivation(draft: Draft): void {
    if (draft !== this.draft || draft.view.state !== "staged" || draft.view.planning_active ||
        !draft.view.predecessor_closed || draft.view.activation_permit !== "available" || draft.automaticAttempt) return;
    // activateDraft reserves and consumes synchronously before its first await.
    draft.automaticAttempt = this.activateDraft(draft.view.plan_id, "automatic").catch(() => {
      if (Object.hasOwn(LIVE, draft.view.state)) this.reject(draft, "admission_failed");
      return structuredClone(draft.view);
    }).finally(() => this.wakeContinuation(draft));
  }

  private async activateDraft(planId: string, trigger: "manual" | "automatic"): Promise<PlanProjection> {
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
    if (!draft.view.predecessor_closed)
      throw new RuntimeFault("conflict", "Predecessor cleanup is still pending");
    if (trigger === "automatic" && draft.view.activation_permit !== "available")
      throw new RuntimeFault("conflict", "Automatic continuation permit is unavailable");
    // Reserve synchronously before obtaining observation or invoking isolation.
    draft.view.state = "validating";
    draft.view.activation_trigger = trigger;
    if (draft.view.activation_permit === "available") draft.view.activation_permit = "consumed";
    this.record(draft, "validation_started");
    let phase: PlanRejectReason = "guard_error";
    try {
      const observation = await this.host.observe();
      this.assertActivation(draft);
      const basis = draft.view.basis;
      if (observation.session_id !== basis.session_id || observation.epoch !== basis.epoch || observation.world_id !== basis.world_id) throw new Error("session_changed");
      if (observation.life.life_id !== basis.life_id || observation.life.status !== "alive") throw new Error("life_changed");
      draft.view.observation_seq = observation.observation_seq;
      const request = draft.request!;
      if (request.guard_source !== undefined) {
        const allowed = await this.host.evaluateGuard(request.guard_source, structuredClone(observation), structuredClone(request.args), draft.controller.signal);
        this.assertActivation(draft);
        if (allowed !== true) {
          draft.view.guard_status = "failed";
          this.reject(draft, "guard_failed");
          return structuredClone(draft.view);
        }
        draft.view.guard_status = "passed";
      }
      this.record(draft, "guard_checked");
      this.assertActivation(draft);
      phase = "admission_failed";
      const execution = await this.host.admit({
        ...(request.entry === "step"
          ? { entry: "step" as const, initial_state: structuredClone(request.initial_state), limits: { ...request.limits } }
          : { entry: "run" as const, limits: { ...request.limits } }),
        skill_id: request.skill.skill_id, version: request.skill.version,
        start_key: `plan_${draft.view.plan_id}`, epoch: basis.epoch,
        session_id: basis.session_id, life_id: basis.life_id,
        native_boot_id: basis.native_boot_id, run_generation: basis.generation, space_epoch: basis.space_epoch,
        compatibility_hash: basis.compatibility_hash,
        args: structuredClone(request.args),
      }, { signal: draft.controller.signal, assertCurrent: () => this.assertActivation(draft) });
      // Admission changes current root; the permit, not a post-admission old-root
      // comparison, is the atomic source of authority.
      draft.view.activation_execution_id = execution.execution_id;
      this.assertAdmitted(draft, execution);
      draft.view.state = "activated";
      clearTimeout(draft.timer);
      this.record(draft, "activated");
    } catch (error) {
      if (phase === "guard_error" && draft.view.guard_status === "pending") draft.view.guard_status = "error";
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
    if (!draft.view.predecessor_closed) throw new RuntimeFault("stale_context", "Predecessor cleanup is still pending");
    this.assertSources(draft);
  }

  private assertSources(draft: Draft): void {
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

  private assertAdmitted(draft: Draft, execution: SkillExecutionView): void {
    if (draft !== this.draft || draft.controller.signal.aborted || draft.view.state !== "validating")
      throw new RuntimeFault("stale_context", "cancelled");
    this.assertScope(draft, this.host.admissionContext());
    const root = this.host.context()?.root;
    if (!root || root.execution_id !== execution.execution_id || root.skill_id !== draft.request!.skill.skill_id ||
        root.version !== draft.request!.skill.version || root.hash !== draft.view.candidate!.hash ||
        !["accepted", "running", "succeeded"].includes(root.status) ||
        !["accepted", "running", "succeeded"].includes(execution.status))
      throw new RuntimeFault("stale_context", "Admitted continuation identity or outcome is uncertain");
    this.assertSources(draft);
  }

  private assertScope(draft: Draft, now: PlanningScope | null): void {
    const basis = draft.view.basis;
    let reason: PlanRejectReason | null = null;
    if (!now || now.run_id !== basis.run_id || now.generation !== basis.generation || now.session_id !== basis.session_id || now.world_id !== basis.world_id || now.epoch !== basis.epoch) reason = "session_changed";
    else if (now.life_id !== basis.life_id || now.life_status !== "alive") reason = "life_changed";
    else if (now.native_boot_id !== basis.native_boot_id || now.space_epoch !== basis.space_epoch) reason = "space_changed";
    else if (now.compatibility_hash !== basis.compatibility_hash) reason = "profile_changed";
    else if (!sameScreen(now.screen, basis.screen)) reason = "screen_changed";
    else if (now.task !== basis.task || canonicalContractJson(now.goal) !== canonicalContractJson(basis.goal)) reason = "task_changed";
    else if (performance.now() >= draft.deadline) reason = "deadline";
    if (reason) { this.reject(draft, reason); throw new RuntimeFault("stale_context", reason); }
  }

  private assertIdentity(draft: Draft): void {
    if (draft !== this.draft || draft.controller.signal.aborted || !Object.hasOwn(LIVE, draft.view.state)) throw new RuntimeFault("stale_context", "cancelled");
    this.assertScope(draft, this.host.admissionContext());
    const now = this.host.context();
    this.assertScope(draft, now);
    const basis = draft.view.basis;
    let reason: PlanRejectReason | null = null;
    if (!now || now.root.execution_id !== basis.root.execution_id || now.root.skill_id !== basis.root.skill_id ||
        now.root.version !== basis.root.version || now.root.hash !== basis.root.hash ||
        now.root.intent_version !== basis.root.intent_version) reason = "predecessor_changed";
    else if (now.root.status === "cancel_requested" || (Object.hasOwn(TERMINAL_ROOT, now.root.status) && now.root.status !== "succeeded")) reason = "predecessor_unsuccessful";
    if (reason) { this.reject(draft, reason); throw new RuntimeFault("stale_context", reason); }
  }

  private wakeContinuation(draft: Draft): void {
    if (!draft.view.predecessor_closed || draft.view.activation !== "on_predecessor_success" || draft.continuationWoken) return;
    draft.continuationWoken = true;
    this.host.wake("continuation");
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
    const scope = this.host.admissionContext();
    if (!scope || !skill.entry || skill.validation.runtime_version !== 5 || skill.validation.api_version !== 5 || skill.validation.validator_version !== 5 ||
      skill.validation.compatibility_hash !== scope.compatibility_hash ||
      skill.validation.fingerprint !== programFingerprint(skill.hash, skill.entry === "run" ? "skill" : skill.entry, scope.compatibility_hash))
      throw new RuntimeFault("precondition_failed", "Selected cached executable contract is incompatible");
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
    if (draft.view.activation_permit === "available" || draft.view.activation_permit === "consumed")
      draft.view.activation_permit = "revoked";
    clearTimeout(draft.timer);
    draft.controller.abort();
    this.record(draft, "rejected");
    this.wakeContinuation(draft);
  }
  private record(draft: Draft, event: string): void {
    this.host.evidence(`planning.${event}`, JSON.parse(JSON.stringify(draft.view)));
  }

  private recordStageFailure(draft: Draft, request: StagePlanRequest, attemptId: string, error: unknown, correction: StageCorrection): void {
    const source = request.guard_source ?? "";
    const hash = createHash("sha256").update(source).digest("hex");
    const bytes = Buffer.byteLength(source);
    const count = Math.ceil(source.length / 2048);
    for (let index = 0; index < count; index++) this.host.evidence("planning.guard_source", {
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
        code: error instanceof ProgramValidationError ? "invalid_program" : error instanceof RuntimeFault ? error.code : draft.view.reason ?? "guard_error",
        message: error instanceof Error ? error.message.slice(0, 300) : "Game guard staging failed",
      },
      issues: error instanceof ProgramValidationError ? JSON.parse(JSON.stringify(error.issues.slice(0, 32))) : [],
      omitted_issue_count: error instanceof ProgramValidationError ? Math.max(0, error.issues.length - 32) : 0,
      stage_correction: JSON.parse(JSON.stringify(correction)),
    });
  }
}
