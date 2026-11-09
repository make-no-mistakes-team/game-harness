import { createHash, randomUUID } from "node:crypto";
import type {
  GameAction,
  GameActionResult,
  Json,
  ObservationV3,
  AdapterBinding,
  RuntimeAdapter,
} from "../shared/contracts.ts";
import type {
  SkillCapabilityRequest,
  SkillExecutionView,
  SkillLimits,
  SkillRef,
  SkillResult,
  SkillStartRequest,
  SkillView,
} from "../shared/programs.ts";
import {
  skillCapabilitySchema,
  skillStartRequestSchema,
} from "../shared/validation.ts";
import { programFingerprint, validateSkill } from "./program-validation.ts";
import type { EffectContext, EffectInvocation, EffectScope } from "../shared/control.ts";
import { assertExecutableCompatible } from "./effect-contract.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import { MAX_SKILL_LIMITS, SKILL_API_VERSION } from "../shared/programs.ts";
import { SkillCleanupError, type SandboxService } from "./sandbox.ts";
import type { Store } from "./store.ts";
import type { LookaheadConfig } from "../shared/planning.ts";
import { ExecutionTrace } from "./execution-trace.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";
import { capabilityFailure, GeneratedResultValidationError, parseGeneratedSkillResult, programDiagnostic } from "./program-diagnostics.ts";
import type { ControllerEffectUpdate, ControllerInput, ControllerInputChannel, InputAppliedAck } from "../shared/controller.ts";
import type { ResidentAnalysisResult, ResidentLifecycle, ResidentSnapshot, ResidentControllerOptions } from "../shared/resident.ts";
import { ResidentCleanupError, controllerStepResultSchema, executiveStepResultSchema, residentActivationResultSchema } from "../shared/resident.ts";
import { ResidentController } from "./resident-controller.ts";
import { minecraftControllerFrameSchema } from "../shared/minecraft.ts";
import type { ResidentWorker } from "../shared/resident.ts";
import type { ResidentPreparedWorker } from "./sandbox.ts";
import { ControlSession } from "./control-session.ts";
import type { ExecutiveTaskRequest } from "../shared/control-session.ts";
import type { MinecraftControllerFrame } from "../shared/minecraft.ts";
interface PreparedHandoff {
  slot: string;
  key: string;
  predecessorId: string;
  revision: number;
  deadlineHostMs: number;
  intentVersion: number | null;
  controller: AbortController;
  workers: Set<ResidentWorker>;
  worker: ResidentPreparedWorker | null;
  task: Promise<void>;
  disposed: boolean;
  closing: Promise<void> | null;
  executionId: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  releaseSignal(): void;
  assertCurrent(): void;
  retired: (() => void) | null;
}
export interface PreparedResidentHandoff {
  assertCurrent(): void;
  close(): Promise<void>;
}
export interface SkillHost {
  authorize(scope: EffectContext): void;
  adapter(): RuntimeAdapter | null;
  binding(): AdapterBinding | null;
  observe(): Promise<ObservationV3>;
  action(
    execution: SkillExecutionView,
    action: GameAction,
    signal: AbortSignal,
    callId: string,
  ): Promise<GameActionResult>;
  queryCapability(id: string, version: number, args: Json): Promise<Json>;
  cancelActions(
    executionIds: ReadonlySet<string>,
    reason: string,
  ): Promise<void>;
  changed(outcome: boolean, execution?: SkillExecutionView): void;
  unsafe(): void;
  recover(execution: SkillExecutionView, result: GameActionResult): Promise<EffectScope>;
  prepareLookahead?(config: LookaheadConfig): (executionId: string) => void;
  openController?(execution: SkillExecutionView, generation: number, deadlineHostMs: number,
    applied: (ack: InputAppliedAck) => void, effect: (event: ControllerEffectUpdate) => void,
    lifecycle: ResidentLifecycle): Promise<ControllerInputChannel>;
  programEvent?(execution: SkillExecutionView, event: import("../shared/resident.ts").ControllerEvent): void;
  residentEffect?(execution: SkillExecutionView, input: ControllerInput, event: ControllerEffectUpdate, adapter: RuntimeAdapter): void;
  sessionTask?(execution: SkillExecutionView, request: ExecutiveTaskRequest, handle: number, deadlineHostMs: number,
    signal: AbortSignal, frame: MinecraftControllerFrame, behaviorGeneration: number): Promise<GameActionResult>;
  superviseSessionTask?(execution: SkillExecutionView, handle: number, frame: MinecraftControllerFrame, behaviorGeneration: number): Promise<void>;
  retireSessionTask?(execution: SkillExecutionView, handle: number, reason: string): Promise<void>;
}
interface Live {
  view: SkillExecutionView;
  root: Live;
  depth: number;
  controller: AbortController;
  done: Promise<void>;
  children: Set<Live>;
  timer: ReturnType<typeof setTimeout> | undefined;
  closing: Promise<void> | null;
  cleanupEffects: Promise<void> | null;
  abortStatus: "cancelled" | "failed" | "unknown";
  cleanupFailure: Error | null;
  pending: SkillCapabilityRequest["kind"] | null;
  handoff: boolean;
  handoffRetired: boolean;
  lifeId: number;
  scope: EffectScope;
  invocation: EffectInvocation;
  resident: ResidentController | ControlSession | null;
  deadlineHostMs: number;
}
const terminal = new Set<SkillExecutionView["status"]>([
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
  "unknown",
]);
/** Durable identities and host-authorized capabilities; no worker owns the avatar lease. */
export class SkillManager {
  private readonly registrations = new WeakMap<RuntimeAdapter, RegisteredAdapterContract>();
  private live = new Map<string, Live>();
  private cleanupFailures = new Set<Error>();
  private handoffRevision = 0;
  private handoffReservation: { predecessorId: string; revision: number } | null = null;
  private preparedHandoffs = new Map<string, PreparedHandoff>();
  private sessionChildren = new Map<string, Live>();
  private trace: ExecutionTrace;
  constructor(
    private store: Store,
    private sandbox: Pick<SandboxService, "runSkill"> & Partial<Pick<SandboxService, "createResidentWorker" | "createResidentAnalysisWorker">>,
    private host: SkillHost,
  ) { this.trace = new ExecutionTrace(store); }
  get pending(): boolean {
    return this.live.size > 0;
  }
  private context() {
    const adapter = this.host.adapter(), binding = this.host.binding();
    if (!adapter || !binding?.ready) throw new RuntimeFault("precondition_failed", "A negotiated adapter contract is required");
    let registration = this.registrations.get(adapter);
    if (!registration) { registration = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators); this.registrations.set(adapter, registration); }
    if (registration.compatibility.compatibility_hash !== binding.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Executable and native adapter profiles do not match");
    return { adapter, binding, registration, descriptor: adapter.descriptor, schemas: adapter.schemas };
  }
  private compatible(skill: SkillView): void {
    const context = this.context(), validation = assertExecutableCompatible(skill.validation, context.binding);
    if (!skill.entry || validation.fingerprint !== programFingerprint(skill.hash, skill.entry === "run" ? "skill" : skill.entry, context.binding.compatibility_hash))
      throw new RuntimeFault("precondition_failed", "Cached source validation is incompatible; retain history and create a fresh immutable revision");
  }
  effectScope(executionId: string): EffectScope | null {
    const live = this.live.get(executionId);
    return live && !live.controller.signal.aborted && !live.root.controller.signal.aborted && !terminal.has(live.view.status) &&
      (live.root.view.entry === "step" ? performance.now() < live.root.deadlineHostMs : Date.now() < Date.parse(live.root.view.deadline_at)) ? live.scope : null;
  }
  invocation(executionId: string): EffectInvocation | null {
    return this.effectScope(executionId) ? this.live.get(executionId)!.invocation : null;
  }
  async register(
    runId: string,
    spec: unknown,
    beforeCommit: () => void = () => {},
    registration?: { call_id: string; input: Json },
  ): Promise<SkillView> {
    if (registration) {
      const previous = this.store.completedToolCall(runId, registration.call_id, registration.input);
      if (previous !== null) return this.store.skill(runId, previous as unknown as SkillRef);
    }
    return this.timeSource(runId, registration?.call_id ?? null, async timing => {
      const validated = await validateSkill(spec, this.context());
      this.validateDependencies(runId, validated.dependencies);
      timing.validatedAt = performance.now();
      const published = await this.store.registerSkill(runId, validated, registration, beforeCommit);
      timing.published = published;
      timing.publishedAt = performance.now();
      this.host.changed(false);
      return published;
    });
  }
  private async timeSource(
    runId: string,
    toolCallId: string | null,
    perform: (timing: { validatedAt: number | null; publishedAt: number | null; published: SkillView | null }) => Promise<SkillView>,
  ): Promise<SkillView> {
    const started = performance.now(), validationId = randomUUID();
    const timing: { validatedAt: number | null; publishedAt: number | null; published: SkillView | null } = {
      validatedAt: null, publishedAt: null, published: null,
    };
    try {
      return await perform(timing);
    } finally {
      const ended = performance.now();
      this.store.event(runId, "program.source_timing", "Source validation and publication timing; no execution or efficacy claim", {
        validation_id: validationId, tool_call_id: toolCallId,
        clock_id: HOST_MONOTONIC_CLOCK_ID, clock: "same_process_monotonic",
        started_monotonic_ms: started, ended_monotonic_ms: ended,
        validation_finished_monotonic_ms: timing.validatedAt, published_monotonic_ms: timing.publishedAt,
        duration_ms: ended - started, validation_succeeded: timing.validatedAt !== null,
        source_published: timing.published !== null, source_hash: timing.published?.hash ?? null,
        skill_id: timing.published?.skill_id ?? null, version: timing.published?.version ?? null,
      });
    }
  }
  async importSnapshot(
    runId: string,
    snapshot: SkillView,
    beforeCommit: () => void = () => {},
  ): Promise<SkillView> {
    return this.timeSource(runId, null, async timing => {
      this.compatible(snapshot);
      const validated = await validateSkill({
        entry: snapshot.entry,
        name: snapshot.name,
        source: snapshot.source,
        card: snapshot.card,
        dependencies: snapshot.dependencies,
      }, this.context());
      if (
        validated.source !== snapshot.source ||
        createHash("sha256").update(snapshot.source).digest("hex") !==
          snapshot.hash
      )
        throw new Error(
          "Exact snapshot bytes do not match current canonical validation",
        );
      if (validated.validation.fingerprint !== snapshot.validation.fingerprint)
        throw new Error(
          "Snapshot validator configuration changed; fresh evidence requires a validated revision",
        );
      this.validateDependencies(runId, snapshot.dependencies);
      timing.validatedAt = performance.now();
      const view = await this.store.importSkill(runId, snapshot, beforeCommit);
      timing.published = view;
      timing.publishedAt = performance.now();
      this.store.event(
        runId,
        "skill.revalidated_import",
        "Exact portable snapshot freshly validated without rewriting dependency references",
        {
          skill_id: view.skill_id,
          version: view.version,
          hash: view.hash,
          validation: validated.validation as unknown as Json,
        },
      );
      this.host.changed(false);
      return view;
    });
  }
  private validateDependencies(runId: string, dependencies: SkillRef[]): void {
    const visited = new Map<string, number>();
    const visit = (ref: SkillRef, depth: number): void => {
      if (depth > 8) throw new Error("Dependency depth exceeds eight");
      const key = `${ref.skill_id}:${ref.version}`;
      if ((visited.get(key) ?? 0) >= depth) return;
      visited.set(key, depth);
      const dependency = this.store.skill(runId, ref);
      this.compatible(dependency);
      if (dependency.state !== "validated")
        throw new Error("Dependency is not validated");
      if (dependency.validation.runtime_version !== SKILL_API_VERSION)
        throw new RuntimeFault("precondition_failed", "Dependency uses an incompatible skill API; retained source is inspectable but cannot execute");
      for (const nested of dependency.dependencies) visit(nested, depth + 1);
    };
    for (const dependency of dependencies) visit(dependency, 2);
  }
  start(runId: string, request: SkillStartRequest): SkillExecutionView {
    const parsed = skillStartRequestSchema.parse(request);
    const existing = this.store.skillExecution(runId, {
      start_key: parsed.start_key,
    });
    if (existing) return this.store.admitSkill(runId, parsed).view;
    const { skill, armLookahead } = this.prepareStart(runId, parsed);
    for (const live of this.live.values()) {
      if (live.root !== live) continue;
      throw new RuntimeFault("busy", live.closing || live.controller.signal.aborted
        ? "Previous foreground work is retiring; new admission waits for confirmed worker/native drain"
        : "A foreground program is still live; start does not replace it. Inspect target:'current' for its exact reference and pass handoff:{name,version,execution_ordinal} on start/submit to replace it. Stop is for a deliberate stop, not an automatic replacement.");
    }
    const prepared = this.preparedHandoffs.get(`${runId}:${parsed.start_key}`);
    if (prepared) {
      try {
        prepared.assertCurrent();
        if (prepared.key !== this.preparationKey(runId, parsed) || !prepared.worker || prepared.executionId || !prepared.retired)
          throw new RuntimeFault("stale_context", "Prepared runtime does not match the retired successor request");
        prepared.retired();
      } catch (error) {
        void this.closePrepared(prepared).catch(() => this.host.unsafe()); throw error;
      }
    }
    const admitted = this.store.admitSkill(runId, parsed, undefined, prepared
      ? new Date(Date.now() + Math.max(0, prepared.deadlineHostMs - performance.now())).toISOString() : undefined);
    if (admitted.created) {
      if (prepared) {
        prepared.executionId = admitted.view.execution_id;
      }
      const live = this.dispatch(admitted.view, skill, null, prepared);
      try {
        armLookahead?.(admitted.view.execution_id);
      } catch (error) {
        // Still in the admission stack: revoke before the dispatch microtask can
        // execute any model-authored capability.
        void this.closeTree(live, "Startup lookahead authority could not be armed")
          .catch(() => this.host.unsafe());
        throw error;
      }
    }
    return structuredClone(admitted.view);
  }
  private preparationKey(runId: string, request: SkillStartRequest): string {
    const skill = this.store.skill(runId, request);
    return JSON.stringify([runId, skill.skill_id, skill.version, skill.hash, skill.source, request]);
  }
  private async closePrepared(record: PreparedHandoff): Promise<void> {
    if (record.closing) return record.closing;
    record.disposed = true;
    record.controller.abort("Prepared runtime discarded");
    clearTimeout(record.timer);
    record.releaseSignal();
    record.closing = (async () => {
      await record.task.catch(() => {});
      const results = await Promise.allSettled([...record.workers].map(worker => worker.close()));
      if (this.preparedHandoffs.get(record.slot) === record) this.preparedHandoffs.delete(record.slot);
      if (results.some(result => result.status === "rejected")) {
        const error = new ResidentCleanupError();
        this.cleanupFailures.add(error); this.host.unsafe(); throw error;
      }
    })();
    return record.closing;
  }
  /** Probe only disposable state, then hold a separate compiled, never-invoked live worker. */
  async prepareResidentHandoff(runId: string, request: SkillStartRequest, predecessorId: string,
    signal?: AbortSignal, current: () => void = () => {}): Promise<PreparedResidentHandoff> {
    const parsed = skillStartRequestSchema.parse(request), { skill } = this.prepareStart(runId, parsed);
    if (parsed.entry !== "step" || !this.sandbox.createResidentWorker)
      throw new RuntimeFault("precondition_failed", "Only resident successors have prepared runtimes");
    if (createHash("sha256").update(skill.source).digest("hex") !== skill.hash)
      throw new RuntimeFault("stale_context", "Published source bytes do not match the immutable canonical hash");
    const slot = `${runId}:${parsed.start_key}`, key = this.preparationKey(runId, parsed);
    const previous = this.preparedHandoffs.get(slot);
    if (previous) {
      if (previous.key !== key) { await this.closePrepared(previous); throw new RuntimeFault("conflict", "Prepared source identity changed"); }
      await previous.task; previous.assertCurrent();
      return { assertCurrent: previous.assertCurrent, close: () => this.closePrepared(previous) };
    }
    if (this.preparedHandoffs.size)
      throw new RuntimeFault("busy", "One bounded successor preparation is already owned");
    const predecessor = this.live.get(predecessorId), selected = this.store.skillExecution(runId, { execution_id: predecessorId });
    const predecessorScope = predecessor?.scope ?? selected;
    if (!selected || selected.parent_execution_id !== null || !["accepted", "running", "succeeded"].includes(selected.status) ||
        predecessor?.controller.signal.aborted || this.store.latestRootExecution(runId)?.execution_id !== predecessorId ||
        predecessorScope?.session_id !== parsed.session_id || predecessorScope?.epoch !== parsed.epoch ||
        predecessorScope?.life_id !== parsed.life_id || predecessorScope?.space_epoch !== parsed.space_epoch ||
        predecessorScope?.run_generation !== parsed.run_generation || predecessorScope?.native_boot_id !== parsed.native_boot_id ||
        selected.compatibility_hash !== parsed.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Preparation requires the exact latest predecessor");
    const deadlineHostMs = predecessor?.deadlineHostMs ??
      performance.now() + Math.max(0, Date.parse(selected.deadline_at) - Date.now());
    const intentVersion = predecessor?.resident?.snapshot().intent_version ?? (selected.entry === "step" ? selected.resident?.intent_version : null) ?? null;
    const record: PreparedHandoff = {
      slot, key, predecessorId, revision: this.handoffRevision, deadlineHostMs,
      intentVersion, controller: new AbortController(), workers: new Set(), worker: null, task: Promise.resolve(),
      disposed: false, closing: null, executionId: null, timer: undefined, releaseSignal: () => {}, assertCurrent: () => {}, retired: null,
    };
    record.assertCurrent = () => {
      // The caller's predecessor CAS is an admission permit. Once admission
      // installs our successor, rerunning it would reject that legitimate root
      // change (or an acknowledged tool delivery). The owned revision, signal,
      // exact root, source, intent, scope and deadline still fence activation.
      if (!record.executionId) current();
      const latest = this.store.latestRootExecution(runId);
      const oldView = this.store.skillExecution(runId, { execution_id: predecessorId });
      const old = this.live.get(predecessorId)?.resident?.snapshot() ??
        (oldView?.entry === "step" ? oldView.resident : null);
      if (record.disposed || record.controller.signal.aborted || signal?.aborted ||
          record.revision !== this.handoffRevision || this.cleanupFailures.size || performance.now() >= deadlineHostMs ||
          latest?.execution_id !== (record.executionId ?? predecessorId) ||
          (old?.intent_version ?? null) !== intentVersion ||
          (!record.executionId && !record.retired && !["accepted", "running", "succeeded"].includes(oldView?.status ?? "")) ||
          this.preparationKey(runId, parsed) !== key)
        throw new RuntimeFault("stale_context", "Prepared source, intent, scope or original deadline changed");
      this.prepareStart(runId, parsed);
    };
    const abort = () => { void this.closePrepared(record).catch(() => this.host.unsafe()); };
    signal?.addEventListener("abort", abort, { once: true });
    record.releaseSignal = () => signal?.removeEventListener("abort", abort);
    this.preparedHandoffs.set(slot, record);
    // One isolated candidate remains bounded by the predecessor's original
    // authority, including strategic delays longer than worker startup.
    record.timer = setTimeout(abort, Math.max(1, deadlineHostMs - performance.now()));
    record.task = Promise.resolve().then(async () => {
      record.assertCurrent();
      const shadow = await this.sandbox.createResidentWorker!(skill.source, parsed.limits.step_ms, record.controller.signal) as ResidentPreparedWorker;
      record.workers.add(shadow);
      try {
        record.assertCurrent();
        const frame = minecraftControllerFrameSchema.parse(await this.host.queryCapability("minecraft.controller_frame", 2, { audio_cursor: null }));
        record.assertCurrent();
        if (frame.life_id !== parsed.life_id || frame.space.space_epoch !== parsed.space_epoch)
          throw new RuntimeFault("stale_context", "Shadow frame does not match the prepared scope");
        const probeFrame = parsed.session ? { ...frame, executive: {
          schema_version: 1 as const, session_id: predecessorId, behavior_generation: 1, producer: "none" as const,
          task_high_water: 0, tasks: [], last_command_error: null, restarts: 0, deadline_host_ms: deadlineHostMs,
        } } : frame;
        const result = residentActivationResultSchema.parse(await (shadow.activate ?? shadow.step).call(shadow, probeFrame, structuredClone(parsed.initial_state),
          structuredClone(parsed.args), record.controller.signal));
        if ("refused" in result || result.status === "blocked")
          throw new RuntimeFault("precondition_failed", "Candidate refused shadow activation");
        // A valid result for another entry mode is still an invalid successor.
        (parsed.session ? executiveStepResultSchema : controllerStepResultSchema).parse(result);
        record.assertCurrent();
      } finally {
        try { await shadow.close(); record.workers.delete(shadow); }
        catch {
          const error = new ResidentCleanupError();
          this.cleanupFailures.add(error); this.host.unsafe(); throw error;
        }
      }
      record.assertCurrent();
      const clean = await this.sandbox.createResidentWorker!(skill.source, parsed.limits.step_ms, record.controller.signal) as ResidentPreparedWorker;
      record.workers.add(clean);
      record.assertCurrent();
      record.worker = clean;
    });
    try {
      await record.task;
      record.assertCurrent();
      return { assertCurrent: record.assertCurrent, close: () => this.closePrepared(record) };
    } catch (error) {
      await this.closePrepared(record);
      throw error;
    }
  }
  private prepareStart(runId: string, parsed: SkillStartRequest) {
    const selected = this.store.skill(runId, parsed);
    this.compatible(selected);
    if (selected.entry !== parsed.entry)
      throw new RuntimeFault("precondition_failed", "Playing entry does not match the immutable source");
    if (parsed.entry === "step" && (!this.sandbox.createResidentWorker || !this.sandbox.createResidentAnalysisWorker || !this.host.openController))
      throw new RuntimeFault("precondition_failed", "This host does not provide resident worker and native controller authority");
    if (parsed.entry === "step" && parsed.session &&
        (!this.host.sessionTask || !this.host.superviseSessionTask || !this.host.retireSessionTask))
      throw new RuntimeFault("precondition_failed", "Control sessions require supervised task and exact retirement authority");
    const run = this.store.getRun(runId);
    if (!run) throw new RuntimeFault("not_found", "Run not found");
    if (run.control_mode === "executive" && (parsed.entry !== "step" || !parsed.session))
      throw new RuntimeFault("precondition_failed", "Executive runs admit only life-scoped step sessions as roots; legacy programs must be supervised children");
    this.host.authorize({ session_id: parsed.session_id, world_id: run.world_id, epoch: parsed.epoch,
      native_boot_id: parsed.native_boot_id, run_id: runId, run_generation: parsed.run_generation,
      life_id: parsed.life_id, space_epoch: parsed.space_epoch });
    const armLookahead = parsed.lookahead
      ? this.host.prepareLookahead?.(parsed.lookahead) : undefined;
    if (parsed.lookahead && !armLookahead)
      throw new Error("This program host does not provide speculative planning");
    const skill = this.store.skill(runId, parsed);
    if (skill.state !== "validated") throw new Error("Skill is not validated");
    if (skill.validation.runtime_version !== SKILL_API_VERSION)
      throw new RuntimeFault("precondition_failed", "Program uses an incompatible skill API; retained source is inspectable but cannot execute");
    this.validateDependencies(runId, skill.dependencies);
    return { skill, armLookahead };
  }
  /** Fence new capabilities, settle the admitted leaf, then retain the admission guard. */
  async retireForHandoff(runId: string, request: SkillStartRequest, predecessorId: string, signal: AbortSignal | undefined): Promise<() => void> {
    const parsed = skillStartRequestSchema.parse(request);
    this.prepareStart(runId, parsed);
    if (parsed.entry === "step")
      await this.prepareResidentHandoff(runId, parsed, predecessorId, signal);
    const selected = this.store.skillExecution(runId, { execution_id: predecessorId });
    const live = this.live.get(predecessorId);
    const sameScope = (view: SkillExecutionView, scope: EffectScope | SkillExecutionView = view) =>
      view.run_id === runId && view.parent_execution_id === null &&
      view.world_id === this.store.getRun(runId)?.world_id && scope.world_id === view.world_id &&
      scope.epoch === parsed.epoch && scope.session_id === parsed.session_id &&
      scope.life_id === parsed.life_id && scope.native_boot_id === parsed.native_boot_id &&
      scope.run_generation === parsed.run_generation && scope.space_epoch === parsed.space_epoch &&
      view.compatibility_hash === parsed.compatibility_hash;
    const completed = (live?.view.status ?? selected?.status) === "succeeded";
    if (!selected || !sameScope(selected, live?.scope ?? selected) ||
        (live && (live.root !== live || live.controller.signal.aborted)) ||
        (!completed && (!live || !["accepted", "running"].includes(live.view.status))) ||
        this.store.latestRootExecution(runId)?.execution_id !== predecessorId)
      throw new RuntimeFault("precondition_failed", "Handoff requires the exact latest live or successfully completed predecessor in the current scope");
    const expectedStatus = completed ? "succeeded" : "cancelled";
    const revision = this.handoffRevision;
    if (this.handoffReservation?.predecessorId === predecessorId && this.handoffReservation.revision === revision)
      throw new RuntimeFault("busy", "The exact predecessor is already reserved for handoff");
    const reservation = { predecessorId, revision };
    this.handoffReservation = reservation;
    const assertRetired = () => {
      if (signal?.aborted || revision !== this.handoffRevision || this.handoffReservation !== reservation ||
          this.store.latestRootExecution(runId)?.execution_id !== predecessorId)
        throw new RuntimeFault("stale_context", "Handoff was stopped or superseded");
      const retired = this.store.skillExecution(runId, { execution_id: predecessorId });
      if (this.cleanupFailures.size || !retired || !sameScope(retired, live?.scope ?? retired) ||
          retired.status !== expectedStatus || (expectedStatus === "cancelled" && !live?.handoffRetired) ||
          !retired.ended_at || this.live.has(predecessorId) ||
          (retired.entry === "step" && (retired.resident?.cleanup.worker !== "closed" || retired.resident.cleanup.native !== "retired")))
        throw new RuntimeFault("precondition_failed", "Predecessor retirement was not safely confirmed");
      for (const candidate of this.live.values())
        if (candidate.view.run_id === runId && candidate.root === candidate)
          throw new RuntimeFault("precondition_failed", "Another foreground program owns current work");
      this.host.authorize({
        session_id: parsed.session_id, world_id: retired.world_id!, epoch: parsed.epoch,
        native_boot_id: parsed.native_boot_id, run_id: runId, run_generation: parsed.run_generation,
        life_id: parsed.life_id, space_epoch: parsed.space_epoch,
      });
    };
    const aborted = Promise.withResolvers<never>();
    const abort = () => {
      this.interruptHandoffs();
      if (live)
        void this.closeTree(live, "Authored handoff authority aborted").catch(() => this.host.changed(true));
      aborted.reject(new RuntimeFault("stale_context", "Handoff authority aborted"));
    };
    if (live) live.handoff = true;
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      // A parent waiting on game.call is not a leaf boundary. With no admitted
      // action/read anywhere in the tree, retirement must start immediately.
      const hasLeaf = (node: Live): boolean => {
        if (node.pending === "action" || node.pending === "respawn" ||
            node.pending === "observe" || node.pending === "adapter") return true;
        for (const child of node.children) if (hasLeaf(child)) return true;
        return false;
      };
      const settle = async () => {
        if (!live) return;
        if (!completed && (live.view.entry === "step" || !hasLeaf(live))) {
          live.handoffRetired = true;
          await this.closeTree(live, "Exact predecessor retired for authored handoff");
        } else {
          await live.done;
          await live.closing;
        }
      };
      await Promise.race([settle(), aborted.promise]);
      assertRetired();
      const prepared = this.preparedHandoffs.get(`${runId}:${parsed.start_key}`);
      if (prepared) prepared.retired = assertRetired;
      return assertRetired;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  /** A deliberate Stop also revokes a handoff waiting on observation, not just a live worker. */
  interruptHandoffs(): void {
    this.handoffRevision++;
    for (const record of this.preparedHandoffs.values())
      void this.closePrepared(record).catch(() => this.host.unsafe());
  }
  get(
    runId: string,
    lookup: { execution_id: string } | { start_key: string },
  ): SkillExecutionView | null {
    const view = this.store.skillExecution(runId, lookup);
    if (view?.entry === "step") {
      const resident = this.live.get(view.execution_id)?.resident;
      if (resident) view.resident = resident.snapshot();
    }
    return view;
  }
  cancel(
    runId: string,
    lookup: { execution_id: string } | { start_key: string },
    reason = "Skill cancellation requested",
  ): SkillExecutionView {
    this.interruptHandoffs();
    const view = this.get(runId, lookup);
    if (!view) throw new Error("Skill execution not found");
    const live = this.live.get(view.execution_id);
    if (live)
      void this.closeTree(live, reason).catch(() => this.host.changed(true));
    return this.get(runId, lookup)!;
  }
  fence(reason: string, uncertainExecutionId?: string): void {
    this.interruptHandoffs();
    let uncertain = uncertainExecutionId ? this.live.get(uncertainExecutionId) : undefined;
    while (uncertain) {
      uncertain.abortStatus = "unknown";
      uncertain = uncertain.view.parent_execution_id
        ? this.live.get(uncertain.view.parent_execution_id) : undefined;
    }
    for (const live of this.live.values())
      if (live.root === live)
        void this.closeTree(live, reason).catch(() => this.host.changed(true));
  }
  async closeAll(reason: string): Promise<void> {
    const preparations = [...this.preparedHandoffs.values()];
    this.interruptHandoffs();
    const roots = [...this.live.values()].filter((live) => live.root === live);
    for (const root of roots) this.revoke(root, reason);
    await Promise.all(roots.map((root) => this.closeTree(root, reason)));
    await Promise.all(preparations.map(record => this.closePrepared(record)));
    if (this.cleanupFailures.size)
      throw this.cleanupFailures.values().next().value;
  }
  private save(
    live: Live,
    type: string,
    summary: string,
    details: Json = null,
  ): void {
    this.store.updateSkillExecution(live.view, type, summary, details);
    this.host.changed(false);
  }
  private dispatch(
    view: SkillExecutionView,
    skill: SkillView,
    parent: Live | null,
    prepared?: PreparedHandoff,
  ): Live {
    const live: Live = {
      view,
      root: null as unknown as Live,
      depth: parent ? parent.depth + 1 : 1,
      controller: new AbortController(),
      done: Promise.resolve(),
      children: new Set(),
      timer: undefined,
      closing: null,
      cleanupEffects: null,
      abortStatus: "cancelled",
      cleanupFailure: null,
      pending: null,
      handoff: false,
      handoffRetired: false,
      lifeId: view.life_id!,
      scope: { session_id: view.session_id!, world_id: view.world_id!, epoch: view.epoch, native_boot_id: view.native_boot_id!,
        run_id: view.run_id, run_generation: view.run_generation!, life_id: view.life_id!, space_epoch: view.space_epoch!,
        execution_id: view.execution_id, source_hash: skill.hash },
      invocation: { kind: "skill", execution_id: view.execution_id, source_hash: skill.hash },
      resident: null,
      deadlineHostMs: Math.min(prepared?.deadlineHostMs ?? Infinity,
        performance.now() + Math.max(0, Date.parse(view.deadline_at) - Date.now())),
    };
    live.root = parent?.root ?? live;
    parent?.children.add(live);
    this.live.set(view.execution_id, live);
    live.timer = setTimeout(
      () => {
        const sessionChild = live !== live.root && live.root.view.entry === "step" && !!live.root.view.session;
        if (!sessionChild) this.interruptHandoffs();
        void this.closeTree(sessionChild ? live : live.root, sessionChild ? "Session child deadline reached" : "Root skill deadline reached").catch(
          () => this.host.changed(true),
        );
      },
      Math.max(1, live.deadlineHostMs - performance.now()),
    );
    live.done = Promise.resolve().then(async () => {
      let outcome: SkillResult | null = null;
      try {
        this.authorize(live);
        view.status = "running";
        view.started_at = new Date().toISOString();
        this.save(
          live,
          "skill.running",
          "Skill dispatched inside its isolated execution",
        );
        this.authorize(live);
        outcome = view.entry === "step" ? await this.runResident(live, skill, prepared) : parseGeneratedSkillResult(
          await this.sandbox.runSkill(
            skill.source,
            view.args,
            (request: SkillCapabilityRequest) =>
              this.capability(live, skill, request),
            this.remaining(live),
            live.controller.signal,
            {
              onCapabilityBudgetExceeded: request =>
                this.exhaustedBudget(live, request.kind === "action" || request.kind === "respawn"),
              onTiming: (event) => {
                this.trace.span(view, event.phase, event.started_monotonic_ms, event.ended_monotonic_ms,
                  { life_id: live.lifeId }, event.confirmed);
              },
              onInstrumentation: (metadata) => {
                this.trace.record(view, "branch", {
                  kind: "instrumentation",
                  ...metadata,
                } as unknown as Json);
              },
              onTrace: (trace) => {
                this.trace.record(view, "branch", trace as unknown as Json, { life_id: live.lifeId });
              },
              api: { api_version: 5, action_enabled: this.context().adapter.action_capability !== null,
                supports_respawn: this.context().adapter.supports_respawn,
                bindings: this.context().adapter.bindings.map(({ name, capability_id, version, parameters }) =>
                  ({ name, capability_id, version, parameters })) },
            },
          ), skill.hash,
        );
        await Promise.all([...live.children].map((child) => child.done));
        if (!live.controller.signal.aborted) {
          this.authorize(live);
          view.result = outcome;
          view.status =
            outcome.status === "completed" ? "succeeded" : outcome.status;
        }
      } catch (error) {
        if (error instanceof SkillCleanupError || error instanceof ResidentCleanupError) {
          live.cleanupFailure = error;
          live.abortStatus = "unknown";
          this.cleanupFailures.add(error);
          this.host.unsafe();
        }
        if (!live.controller.signal.aborted) {
          this.revoke(live, "Skill execution or capability failed");
          live.cleanupEffects = this.host.cancelActions(
            new Set([view.execution_id]),
            "Skill execution failed",
          );
          await live.cleanupEffects;
          await Promise.all(
            [...live.children].map((child) =>
              this.closeTree(child, "Parent skill failed"),
            ),
          );
          view.status = live.cleanupFailure ? "unknown" : "failed";
          view.diagnostic = programDiagnostic(error, skill.hash);
          view.error = view.diagnostic.message;
          if (!live.cleanupFailure)
            view.result = {
              status: "failed",
              summary: view.error,
              result: error instanceof GeneratedResultValidationError && error.rejectedResult !== null
                ? { rejected_result: error.rejectedResult } : null,
            };
        }
      } finally {
        if (prepared) {
          try { await this.closePrepared(prepared); }
          catch (error) {
            live.cleanupFailure = error instanceof Error ? error : new ResidentCleanupError();
            live.abortStatus = "unknown"; view.status = "unknown"; this.host.unsafe();
          }
        }
        try {
          await live.cleanupEffects;
          await Promise.all([...live.children].map((child) => child.done));
        } catch {
          live.abortStatus = "unknown";
        }
        if (live.controller.signal.aborted && !terminal.has(view.status))
          view.status = live.abortStatus;
        view.ended_at = new Date().toISOString();
        clearTimeout(live.timer);
        this.save(
          live,
          "skill.closed",
          view.diagnostic?.message ?? outcome?.summary ?? view.error ?? "Skill execution closed",
          view.diagnostic ? { diagnostic: view.diagnostic as unknown as Json } : {},
        );
        this.live.delete(view.execution_id);
        parent?.children.delete(live);
        if (live.cleanupFailure) throw live.cleanupFailure;
      }
    });
    void live.done.then(() => this.host.changed(live.root === live, view))
      .catch(() => this.host.unsafe());
    this.host.changed(false);
    return live;
  }
  private async runResident(live: Live, skill: SkillView, prepared?: PreparedHandoff): Promise<SkillResult> {
    const view = live.view;
    if (view.entry !== "step" || !this.sandbox.createResidentWorker || !this.host.openController)
      throw new Error("Resident execution is not supported by this host");
    const adapter = this.context().adapter;
    const ready = prepared?.worker;
    if (prepared && !ready) throw new RuntimeFault("stale_context", "Prepared live runtime is unavailable");
    const worker = ready ?? await this.sandbox.createResidentWorker(skill.source, view.limits.step_ms, live.controller.signal);
    let activated = !prepared;
    const liveWorker: ResidentPreparedWorker = {
      step: (...args) => worker.step(...args),
      activate: async (...args: Parameters<NonNullable<ResidentPreparedWorker["activate"]>>) => {
        if (!prepared) return await ((worker as ResidentPreparedWorker).activate ?? worker.step).apply(worker, args);
        if (activated) throw new RuntimeFault("stale_context", "Prepared activation cannot be replayed");
        prepared.assertCurrent();
        const result = await ((worker as ResidentPreparedWorker).activate ?? worker.step).apply(worker, args);
        prepared.assertCurrent();
        this.authorize(live);
        activated = true;
        clearTimeout(prepared.timer); prepared.releaseSignal();
        if (this.preparedHandoffs.get(prepared.slot) === prepared) this.preparedHandoffs.delete(prepared.slot);
        return result;
      },
      close: async () => {
        await worker.close();
        prepared?.workers.delete(worker);
      },
    };
    const completed = Promise.withResolvers<ResidentSnapshot>();
    let resident: ResidentController | ControlSession | null = null;
    const abort = () => { if (resident) void resident.stop(view.error ?? "Resident root authority revoked"); };
    try {
      this.authorize(live);
      const options: ResidentControllerOptions = {
        execution_id: view.execution_id, source_hash: skill.hash, controller_generation: 1,
        limits: view.limits, deadline_host_ms: live.deadlineHostMs, initial_state: view.initial_state, intent: view.args, worker: liveWorker,
        first_activation: !!prepared,
        open: (deadline, applied, effect, lifecycle, generation = 1) => this.host.openController!(view, generation, deadline, applied, effect, lifecycle),
        current: () => {
          try { this.authorize(live); return performance.now() < live.deadlineHostMs; } catch { return false; }
        },
        event: event => {
          this.store.event(view.run_id, "controller.event", event.summary, { execution_id: view.execution_id,
            source_hash: skill.hash, author: "model", event: event as unknown as Json, gameplay_success_proof: false });
          this.host.programEvent?.(view, event);
        },
        effect: (input, event) => this.host.residentEffect?.(view, input, event, adapter),
        changed: (snapshot, done) => {
          view.resident = snapshot;
          if (!done && !terminal.has(view.status))
            this.save(live, "controller.progress", "Resident aggregate state; processing is not input application");
          if (done) completed.resolve(snapshot);
        },
        analysis: async (source, input, budget, signal, report) => {
          const selected = this.store.skill(view.run_id, source);
          this.compatible(selected);
          if (selected.entry !== "analyze" || selected.hash !== source.hash || selected.source !== source.source)
            throw new RuntimeFault("stale_context", "Analysis source identity is no longer current");
          if (!this.sandbox.createResidentAnalysisWorker) throw new Error("Pure analysis worker is unavailable");
          const analysis = await this.sandbox.createResidentAnalysisWorker(source.source, Math.max(1, Math.floor(budget)), signal);
          try { return await analysis.analyze(input, signal, report); }
          finally {
            try { await analysis.close(); } catch { throw new ResidentCleanupError(); }
          }
        },
        clock: { id: HOST_MONOTONIC_CLOCK_ID, now: () => performance.now(), setTimeout: (callback, delay) => setTimeout(callback, delay),
          clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      };
      resident = view.session ? new ControlSession({
        ...options, config: view.session,
        sample: cursor => this.host.queryCapability("minecraft.controller_frame", 2, { audio_cursor: cursor }),
        task: (request, handle, deadline, signal, frame, generation) =>
          this.host.sessionTask!(view, request, handle, deadline, signal, frame, generation),
        supervise: (handle, frame, generation) => this.host.superviseSessionTask!(view, handle, frame, generation),
        retireTask: (handle, reason) => this.host.retireSessionTask!(view, handle, reason),
        record: (type, details) => this.store.event(view.run_id, type, "Control session lifecycle; no tactical or effect success claim", {
          execution_id: view.execution_id, source_hash: skill.hash, details,
        }),
        restartWorker: signal => this.sandbox.createResidentWorker!(skill.source, view.limits.step_ms, signal),
      }) : new ResidentController(options);
      live.resident = resident;
      live.controller.signal.addEventListener("abort", abort, { once: true });
      if (live.controller.signal.aborted) abort();
      await resident.start();
      const final = await completed.promise;
      if (final.status === "unknown") throw new ResidentCleanupError();
      if (final.status === "failed") throw resident.failure ?? new Error(final.reason ?? "Resident computation failed");
      return { status: final.status === "completed" ? "completed" : "blocked",
        summary: final.reason ?? `Resident ${final.status}`, result: { state: final.state,
          processed_frame_seq: final.processed_frame_seq, counters: final.counters } };
    } finally {
      live.controller.signal.removeEventListener("abort", abort);
      if (resident) await resident.stop("Resident execution closed");
      else {
        try { await worker.close(); } catch { throw new ResidentCleanupError(); }
      }
    }
  }
  updateResidentIntent(runId: string, executionId: string, intent: Json, expectedVersion: number): number {
    const live = this.live.get(executionId);
    if (!live || live.view.run_id !== runId || !live.resident) throw new RuntimeFault("not_found", "No current resident execution");
    this.authorize(live);
    return live.resident.updateIntent(intent, expectedVersion);
  }
  async analyzeResident(runId: string, executionId: string, source: SkillRef, input: Json, expectedVersion: number): Promise<ResidentAnalysisResult> {
    const live = this.live.get(executionId);
    if (!live || live.view.run_id !== runId || !live.resident) throw new RuntimeFault("not_found", "No current resident execution");
    this.authorize(live);
    const selected = this.store.skill(runId, source);
    this.compatible(selected);
    if (selected.entry !== "analyze") throw new RuntimeFault("precondition_failed", "Analysis requires an immutable pure analyze entry");
    const result = await live.resident.analyze({ skill_id: selected.skill_id, version: selected.version,
      hash: selected.hash, source: selected.source }, input, expectedVersion);
    this.store.event(runId, "controller.analysis", "Pure analysis result; no effect or automatic intent adoption", result as unknown as Json);
    return result;
  }
  async runSessionChild(execution: SkillExecutionView, exactNamedRef: { name: string; version: number }, args: Json,
    duration: number, handle: number, signal: AbortSignal): Promise<GameActionResult> {
    const root = this.live.get(execution.execution_id);
    if (!root || root.root !== root || root.view.entry !== "step" || !root.view.session)
      throw new RuntimeFault("precondition_failed", "A live control session must own the child");
    this.authorize(root);
    if (!Number.isSafeInteger(handle) || handle < 1 || !Number.isSafeInteger(duration) || duration < 1 || duration > 600000)
      throw new RuntimeFault("precondition_failed", "Session children require a finite handle and deadline");
    const rootSource = this.store.skill(root.view.run_id, root.view);
    const selected = rootSource.dependencies.map(ref => this.store.skill(root.view.run_id, ref))
      .find(skill => skill.name === exactNamedRef.name && skill.version === exactNamedRef.version);
    if (!selected || selected.entry !== "run")
      throw new RuntimeFault("precondition_failed", "Session child must name an exact declared run dependency");
    this.compatible(selected);
    const generation = root.resident?.snapshot().session?.behavior_generation ?? 1;
    const key = `${execution.execution_id}:${generation}:${handle}`;
    if (this.sessionChildren.has(key))
      throw new RuntimeFault("conflict", "An admitted session child handle cannot dispatch twice");
    if (signal.aborted) throw new RuntimeFault("stale_context", "Session child was cancelled before admission");
    this.consume(root, false);
    this.authorize(root);
    const limits = this.remaining(root), deadline = Math.min(root.deadlineHostMs, performance.now() + duration);
    const admitted = this.store.admitSkill(root.view.run_id, {
      entry: "run", skill_id: selected.skill_id, version: selected.version,
      start_key: `session_child_${createHash("sha256").update(key).digest("hex")}`,
      session_id: root.scope.session_id, epoch: root.scope.epoch, life_id: root.scope.life_id,
      native_boot_id: root.scope.native_boot_id, run_generation: root.scope.run_generation,
      space_epoch: root.scope.space_epoch, compatibility_hash: root.view.compatibility_hash!,
      args, limits: { ...limits, duration_ms: Math.max(1, Math.floor(deadline - performance.now())) },
    }, { parent_execution_id: root.view.execution_id, root_execution_id: root.view.execution_id });
    if (!admitted.created)
      throw new RuntimeFault("conflict", "A session child invocation is retained; it cannot replay");
    const child = this.dispatch(admitted.view, selected, root);
    child.deadlineHostMs = deadline;
    clearTimeout(child.timer);
    child.timer = setTimeout(() => { void this.closeTree(child, "Finite session child deadline reached").catch(() => this.host.unsafe()); },
      Math.max(0, deadline - performance.now()));
    this.sessionChildren.set(key, child);
    const abort = () => { void this.closeTree(child, "Executive interrupted exact finite child").catch(() => this.host.unsafe()); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      await child.done;
      if (child.closing) await child.closing;
      return { status: child.view.status === "succeeded" ? "succeeded" : child.view.status === "cancelled" ? "cancelled"
        : child.view.status === "unknown" ? "unknown" : "failed",
      summary: child.view.result?.summary ?? child.view.error ?? "Finite session child settled",
      evidence: { execution_id: child.view.execution_id, source_hash: selected.hash,
        result: child.view.result as unknown as Json } };
    } finally {
      signal.removeEventListener("abort", abort);
      this.sessionChildren.delete(key);
    }
  }
  consumeSessionAction(execution: SkillExecutionView): void {
    const root = this.live.get(execution.execution_id);
    if (!root || root.root !== root || root.view.run_id !== execution.run_id || root.view.entry !== "step" || !root.view.session)
      throw new RuntimeFault("precondition_failed", "A live control session must own the action");
    this.authorize(root);
    this.consume(root, true);
    // Budget publication can synchronously revoke the owning session.
    this.authorize(root);
  }
  async retireSessionChild(execution: SkillExecutionView, handle: number, reason: string): Promise<void> {
    const prefix = `${execution.execution_id}:`;
    const children = [...this.sessionChildren.entries()]
      .filter(([key]) => key.startsWith(prefix) && key.endsWith(`:${handle}`)).map(([, child]) => child);
    await Promise.all(children.map(child => this.closeTree(child, reason)));
  }
  private capabilityLimits(root: Live): SkillLimits {
    if (root.view.entry === "run") return root.view.limits;
    if (root.view.entry === "step" && root.view.session) return {
      duration_ms: root.view.limits.duration_ms, max_actions: root.view.session.max_actions,
      max_calls: root.view.session.max_calls, max_depth: root.view.session.max_depth,
    };
    throw new Error("Raw resident entries cannot acquire finite capability authority");
  }
  private remaining(live: Live): SkillLimits {
    const limits = this.capabilityLimits(live.root);
    return {
      ...limits,
      duration_ms: Math.max(
        1,
        Math.min(MAX_SKILL_LIMITS.duration_ms,
          Math.floor(Math.min(live.deadlineHostMs, live.root.deadlineHostMs) - performance.now())),
      ),
      max_actions: Math.max(
        1,
        Math.min(MAX_SKILL_LIMITS.max_actions, limits.max_actions - live.root.view.actions),
      ),
      max_calls: Math.max(
        1,
        Math.min(MAX_SKILL_LIMITS.max_calls, limits.max_calls - live.root.view.calls),
      ),
      max_depth: Math.max(1, Math.min(MAX_SKILL_LIMITS.max_depth, limits.max_depth - live.depth + 1)),
    };
  }
  private authorize(live: Live): void {
    if (
      live.controller.signal.aborted ||
      live.root.controller.signal.aborted ||
      terminal.has(live.view.status) ||
      performance.now() >= live.deadlineHostMs ||
      (live.root.view.entry === "step" ? performance.now() >= live.root.deadlineHostMs : Date.now() >= Date.parse(live.root.view.deadline_at))
    )
      throw new Error("Skill authority revoked");
    this.host.authorize(live.scope);
  }
  private exhaustedBudget(live: Live, action: boolean): RuntimeFault | null {
    const root = live.root;
    if (root.handoff)
      return new RuntimeFault("stale_context", "Program capability admission retired for authored handoff");
    const limits = this.capabilityLimits(root);
    if (
      root.view.calls >= limits.max_calls ||
      (action && root.view.actions >= limits.max_actions)
    ) {
      const exhausted = [
        ...(root.view.calls >= limits.max_calls ? ["max_calls"] : []),
        ...(action && root.view.actions >= limits.max_actions ? ["max_actions"] : []),
      ].join(" and ");
      const failure = new RuntimeFault("budget_exceeded",
        `Aggregate root skill budget exhausted: ${exhausted} (calls=${root.view.calls}/${limits.max_calls}, actions=${root.view.actions}/${limits.max_actions}). No additional capability admitted; execution authority revoked. Inspect execution evidence and adapt the bounded program flow before a new execution.`);
      // Abort wins the sandbox's failure race. Retain this trusted cause before
      // revocation so worker cancellation cannot replace it with a generic error.
      const retain = (node: Live): void => {
        if (!terminal.has(node.view.status)) {
          node.abortStatus = "failed";
          node.view.diagnostic = programDiagnostic(failure, node.scope.source_hash);
          node.view.error = failure.message;
          node.view.result = { status: "failed", summary: failure.message, result: null };
        }
        for (const child of node.children) retain(child);
      };
      retain(root);
      this.revoke(root, failure.message);
      void this.closeTree(root, failure.message).catch(
        () => this.host.changed(true),
      );
      return failure;
    }
    return null;
  }
  private consume(live: Live, action: boolean): void {
    const failure = this.exhaustedBudget(live, action);
    if (failure) throw failure;
    const root = live.root;
    root.view.calls++;
    if (action) root.view.actions++;
    this.save(root, "skill.budget", "Root shared capability budget consumed", {
      execution_id: live.view.execution_id,
      action,
    });
    if (live !== root) {
      live.view.calls++;
      if (action) live.view.actions++;
      this.save(live, "skill.capability", "Child capability budget consumed");
    }
  }
  private async capability(
    live: Live,
    skill: SkillView,
    raw: SkillCapabilityRequest,
  ): Promise<Json> {
    this.authorize(live);
    if (live.root.handoff)
      throw new RuntimeFault("stale_context", "Program capability admission retired for authored handoff");
    if (live.pending)
      throw new Error("Only one host capability may be outstanding");
    const request = skillCapabilitySchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024)
      throw new Error("Capability request exceeds byte bound");
    const callId = randomUUID();
    const started = performance.now();
    const context = { call_id: callId, capability: request.kind, life_id: live.lifeId };
    // Linearize admission before budget persistence synchronously notifies
    // observers. A handoff in that notification must see this exact leaf.
    live.pending = request.kind;
    let requestRecorded = false;
    let resultRecorded = false;
    try {
      this.consume(live, request.kind === "action" || request.kind === "respawn");
      this.trace.record(live.view, "capability_request", request as unknown as Json, context);
      requestRecorded = true;
      // Stop/death/deadline may have revoked authority in either publication.
      // The handoff latch alone intentionally preserves an admitted leaf scope.
      this.authorize(live);
      let result: Json;
      switch (request.kind) {
        case "observe":
          {
            const observation = await this.host.observe();
            result = observation as unknown as Json;
            this.trace.observe(live.view, observation, context);
          }
          break;
        case "adapter": {
          const context = this.context();
          if (!context.adapter.bindings.some(binding => binding.capability_id === request.capability_id && binding.version === request.version))
            throw new RuntimeFault("precondition_failed", "This adapter read capability is not registered");
          const args = context.registration.parseCapability(request.capability_id, request.version, request.args);
          this.authorize(live);
          result = await this.host.queryCapability(request.capability_id, request.version, args);
          break;
        }
        case "respawn":
        case "action": {
          const respawning = request.kind === "respawn" || request.action.kind === "respawn";
          if (respawning && !this.context().adapter.supports_respawn) throw new RuntimeFault("precondition_failed", "This adapter has no respawn capability");
          if (respawning && live !== live.root)
            throw new Error("Only an explicitly selected recovery root can respawn");
          this.authorize(live);
          const action = await this.host.action(
            live.view,
            request.kind === "respawn" ? { kind: "respawn" } : request.action,
            live.controller.signal,
            callId,
          );
          if (respawning && action.status === "succeeded") {
            if (live.controller.signal.aborted)
              throw new Error("Recovery authority revoked");
            live.scope = await this.host.recover(live.view, action);
            live.lifeId = live.scope.life_id;
          }
          result = action as unknown as Json;
          this.trace.record(live.view, "capability_result", { ok: true, result }, { ...context, life_id: live.lifeId });
          resultRecorded = true;
          if (
            action.status === "unknown" ||
            action.status === "cancelled" ||
            action.requires_reconnect
          ) {
            if (live !== live.root && live.root.view.entry === "step" && live.root.view.session && !action.requires_reconnect) {
              live.abortStatus = action.status === "unknown" ? "unknown" : "cancelled";
              live.view.result = { status: "failed", summary: action.summary, result: action as unknown as Json };
              this.revoke(live, "Session child interrupted; past effects retain original attribution");
              void this.closeTree(live, "Exact session child emitter retired").catch(() => this.host.unsafe());
              throw new Error("Session child interrupted");
            }
            live.root.abortStatus =
              action.status === "unknown" || action.requires_reconnect
                ? "unknown"
                : "cancelled";
            this.revoke(
              live.root,
              "Leaf action was interrupted or became uncertain",
            );
            void this.closeTree(
              live.root,
              "Leaf action lost effect authority",
            ).catch(() => this.host.changed(true));
            throw new Error("Leaf action lost effect authority");
          }
          break;
        }
        case "progress":
          this.save(live, "skill.progress", request.summary, request.details);
          this.trace.record(live.view, "intent", {
            author: "model",
            summary: request.summary,
            details: request.details,
            gameplay_success_proof: false,
          }, context);
          result = null;
          break;
        case "attention": {
          const root = live.root;
          // Budget persistence can synchronously notify observers that revoke
          // this tree. Recheck both producer and actual root before publication.
          const current = () => {
            this.authorize(live);
            this.authorize(root);
            if (this.live.get(live.view.execution_id) !== live || this.live.get(root.view.execution_id) !== root)
              throw new Error("Program attention authority is no longer live");
          };
          current();
          const event = { kind: "attention" as const, ...request.attention };
          this.store.event(root.view.run_id, "controller.event", event.summary, {
            execution_id: root.view.execution_id, source_hash: root.scope.source_hash, entry: root.view.entry,
            ...(live !== root ? { producer_execution_id: live.view.execution_id, producer_source_hash: skill.hash } : {}),
            author: "model", event: event as unknown as Json, gameplay_success_proof: false,
          });
          current();
          this.host.programEvent?.(root.view, event);
          result = null;
          break;
        }
        case "call": {
          if (live.root.view.entry !== "run" && !(live.root.view.entry === "step" && live.root.view.session))
            throw new Error("Only finite programs and control sessions can compose playing children");
          const declared = skill.dependencies.map((ref) => this.store.skill(live.view.run_id, ref))
            .filter((dependency) => dependency.name === request.skill.name &&
              (request.skill.version === undefined || dependency.version === request.skill.version));
          if (declared.length !== 1)
            throw new RuntimeFault("precondition_failed",
              "game.call requires exactly one matching named child in the parent's pinned program dependencies. Declare the child's exact reference and select its name/version. Native adapter bindings are direct game methods, not program dependencies.");
          if (live.depth >= this.capabilityLimits(live.root).max_depth)
            throw new Error("Root composition depth exhausted");
          const dependency = declared[0]!;
          this.compatible(dependency);
          if (dependency.entry !== "run") throw new Error("Playing child dependencies must select run");
          if (dependency.state !== "validated")
            throw new Error("Dependency no longer validated");
          if (dependency.validation.runtime_version !== SKILL_API_VERSION)
            throw new Error("Dependency skill API is incompatible");
          this.authorize(live);
          if (live.root.handoff)
            throw new RuntimeFault("stale_context", "Child admission retired for authored handoff");
          const admitted = this.store.admitSkill(
            live.view.run_id,
            {
              entry: "run",
              skill_id: dependency.skill_id,
              version: dependency.version,
              start_key: `child_${randomUUID()}`,
              epoch: live.view.epoch,
              session_id: live.view.session_id!,
              life_id: live.lifeId,
              native_boot_id: live.scope.native_boot_id,
              run_generation: live.scope.run_generation,
              space_epoch: live.scope.space_epoch,
              compatibility_hash: this.context().binding.compatibility_hash,
              args: request.args,
              limits: live.root.view.entry === "step" ? this.remaining(live) : this.capabilityLimits(live.root),
            },
            {
              parent_execution_id: live.view.execution_id,
              root_execution_id: live.root.view.execution_id,
            },
          );
          const child = this.dispatch(admitted.view, dependency, live);
          // Admission itself publishes synchronously. If its observers stopped
          // the tree, close the admitted identity before its dispatch microtask.
          if (live.root.handoff || live.root.controller.signal.aborted)
            void this.closeTree(child, "Parent authority retired during child admission").catch(() => this.host.changed(true));
          await child.done;
          this.authorize(live);
          result = child.view.result as unknown as Json;
          if (
            !result ||
            !["succeeded", "blocked", "failed"].includes(child.view.status)
          )
            throw new Error("Dependency did not settle safely");
          break;
        }
      }
      if (!resultRecorded) {
        this.trace.record(live.view, "capability_result", { ok: true, result }, { ...context, life_id: live.lifeId });
        resultRecorded = true;
      }
      this.authorize(live);
      if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024)
        throw new Error("Capability result exceeds byte bound");
      return result;
    } catch (error) {
      if (requestRecorded && !resultRecorded)
        this.trace.record(live.view, "capability_result", { ok: false, result: capabilityFailure(error) }, { ...context, life_id: live.lifeId });
      throw error;
    } finally {
      if (requestRecorded)
        this.trace.span(live.view, "capability_wait", started, performance.now(), { ...context, life_id: live.lifeId });
      const leaf = live.pending === "action" || live.pending === "respawn" ||
        live.pending === "observe" || live.pending === "adapter";
      live.pending = null;
      // Do this inside the broker completion path, before its promise can reply
      // to/resume generated code. Joining here would deadlock on live.done.
      if (leaf && live.root.handoff && !live.root.controller.signal.aborted) {
        live.root.handoffRetired = true;
        void this.closeTree(live.root, "Exact predecessor retired at capability boundary").catch(() => this.host.changed(true));
      }
    }
  }
  private revoke(live: Live, reason: string): void {
    if (!live.controller.signal.aborted && !terminal.has(live.view.status)) {
      live.view.status = "cancel_requested";
      live.view.error = reason;
      this.save(live, "skill.cancel_requested", reason);
      live.controller.abort();
    }
    for (const child of live.children) this.revoke(child, reason);
  }
  private closeTree(live: Live, reason: string): Promise<void> {
    if (live.closing) return live.closing;
    this.revoke(live, reason);
    const ids = new Set<string>();
    const collect = (node: Live): void => {
      ids.add(node.view.execution_id);
      for (const child of node.children) collect(child);
    };
    collect(live);
    live.cleanupEffects = this.host.cancelActions(ids, reason);
    live.closing = (async () => {
      const settlements = await Promise.allSettled([
        live.cleanupEffects,
        ...[...live.children].map((child) => this.closeTree(child, reason)),
        live.done,
      ]);
      for (const settlement of settlements)
        if (settlement.status === "rejected") throw settlement.reason;
    })();
    return live.closing;
  }
}
