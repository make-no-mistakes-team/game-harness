import type { GameActionResult, Json } from "../shared/contracts.ts";
import type { ControllerChannelFault, ControllerEffectUpdate, ControllerInput, ControllerInputChannel, InputAppliedAck, RevocationAck } from "../shared/controller.ts";
import { controllerInputSchema, revocationAckSchema } from "../shared/controller.ts";
import { sameEffectScope, type EffectScope, type WorldHeld, type WorldInputEdge } from "../shared/control.ts";
import { minecraftControllerFrameSchema, type MinecraftControllerFrame } from "../shared/minecraft.ts";
import { executiveStepResultSchema, residentActivationResultSchema, ResidentCleanupError,
  type ResidentAnalysisResult, type ResidentAnalysisSource, type ResidentControllerOptions,
  type ResidentSnapshot, type ResidentWorker } from "../shared/resident.ts";
import { type ControlSessionConfig, type ExecutiveChoice, type ExecutiveSnapshot, type ExecutiveTaskRequest,
  type ExecutiveTaskSnapshot } from "../shared/control-session.ts";
import { GeneratedControllerResultValidationError } from "./program-diagnostics.ts";
import { ControllerChannelFaultError, ControllerScreenReadSupersededError } from "./controller-channel.ts";
import { ExecutiveRawMonitor, ExecutiveStationaryViewMonitor } from "./executive-incidents.ts";
import { ResidentAnalysisLane } from "./resident-analysis.ts";

interface Task {
  snapshot: ExecutiveTaskSnapshot;
  fingerprint: string;
  abort: AbortController;
  work: Promise<void> | null;
  retirement: Promise<void> | null;
  frameRequest: ExecutiveTaskRequest | null;
  frameResult: GameActionResult | null;
  detailOmitted: boolean;
}
export interface ControlSessionOptions extends ResidentControllerOptions {
  config: ControlSessionConfig;
  /** Read-only sampling is independent of physical ownership. */
  sample(cursor: Json): Promise<Json>;
  task(request: ExecutiveTaskRequest, handle: number, deadlineHostMs: number, signal: AbortSignal,
    frame: MinecraftControllerFrame, behaviorGeneration: number): Promise<GameActionResult>;
  supervise(handle: number, frame: MinecraftControllerFrame, behaviorGeneration: number): Promise<void>;
  retireTask(handle: number, reason: string): Promise<void>;
  record(type: string, details: Json): void;
  restartWorker?(signal: AbortSignal): Promise<ResidentWorker>;
}
const emptyTiming = () => ({ count: 0, p50: null, p95: null, p99: null, max: null, omitted_samples: 0 });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const settled = (task: Task) => !["starting", "running", "retiring"].includes(task.snapshot.status);
class RecoveryAdmissionRefused extends Error {}

/** The executive survives finite children; only one selected producer can emit. No tactics live here. */
export class ControlSession {
  private readonly abort = new AbortController();
  private readonly tasks = new Map<number, Task>();
  private readonly data: ResidentSnapshot;
  private readonly clock;
  private worker: ResidentWorker;
  private intent: Json;
  private cursor: Json = null;
  private timer: unknown = null;
  private timerAt = Infinity;
  private nextDecisionAt = 0;
  private lastDecisionStarted: number | null = null;
  private sampleTimer: unknown = null;
  private sampleFlight: Promise<void> | null = null;
  private sampleSlot = 0;
  private lastSampleFrame = 0;
  private captureGeneration = 0;
  private capture: { frame: MinecraftControllerFrame; channel: ControllerInputChannel | null; transitioning: boolean; generation: number; receivedHostMs: number } | null = null;
  private deadlineTimer: unknown = null;
  private flight: Promise<void> | null = null;
  private transition: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private raw: ControllerInputChannel | null = null;
  private activeTask: Task | null = null;
  private activated = false;
  private lastFrame = 0;
  private anchor = 0;
  private rawGeneration = 0;
  private rawLeaseDeadline = -Infinity;
  private rawWorldOnly = false;
  private decisionEpoch = 0;
  private recoveryWorkerUnknown = false;
  private lastNotify = -Infinity;
  private events = 0;
  private totalEdges = 0;
  private readonly edgeWindow: { at: number; count: number }[] = [];
  private submittedHeld: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false,
    sprint: false, sneak: false, attack: false, use: false };
  private readonly inputCaptures = new Map<string, {
    generation: number; sequence: number; intentVersion: number; frame: MinecraftControllerFrame; input: ControllerInput;
  }>();
  private readonly session: ExecutiveSnapshot;
  private resultFailure: GeneratedControllerResultValidationError | null = null;
  private controllerFaultRecorded = false;
  private readonly rawMonitor = new ExecutiveRawMonitor();
  private readonly stationaryViewMonitor = new ExecutiveStationaryViewMonitor();
  private stationaryViewScope: EffectScope | null = null;
  private readonly analysisLane: ResidentAnalysisLane;
  get failure(): GeneratedControllerResultValidationError | null { return this.resultFailure; }

  constructor(private readonly options: ControlSessionOptions) {
    this.clock = options.clock ?? { id: "control-session-host", now: () => performance.now(),
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.worker = options.worker;
    this.intent = structuredClone(options.intent);
    this.session = { schema_version: 1, session_id: options.execution_id, behavior_generation: 1,
      producer: "none", task_high_water: 0, tasks: [], last_submission: null, last_command_error: null, restarts: 0,
      deadline_host_ms: options.deadline_host_ms };
    this.data = { execution_id: options.execution_id, source_hash: options.source_hash,
      controller_generation: options.controller_generation, host_clock_id: this.clock.id, status: "starting",
      reason: null, intent_version: 0, state: structuredClone(options.initial_state), processed_frame_seq: null,
      processed_native_tick: null, processed_native_ns: null,
      counters: { frames: 0, steps: 0, submissions: 0, applied_sequence: 0, ordered_edge_prefix: 0,
        missed_slots: 0, stale_results: 0, stale_frames: 0, read_failures: 0, no_input_decisions: 0,
        expanded_edges: 0, events: 0, analysis_jobs: 0, analysis_ms: 0 },
      pending: { frames: 0, edges: 0, analysis: false }, last_input: null,
      timings: { step_ms: emptyTiming(), input_age_ms: emptyTiming() }, events: [],
      cleanup: { worker: "open", native: "open" }, session: this.session };
    this.analysisLane = new ResidentAnalysisLane(options, this.data, this.clock, () => this.current(),
      () => this.abort.signal.aborted, (status, reason) => {
        if (!this.abort.signal.aborted) { this.data.status = status; this.data.reason = reason; }
        void this.stop(reason);
      }, () => this.notify());
  }
  snapshot(): ResidentSnapshot {
    // Bulk receipts stay in durable history, not in every 20Hz worker message.
    // Include active and recent software detail under a separate byte budget.
    const ordered = [...this.tasks.values()].reverse();
    if (this.activeTask) ordered.unshift(this.activeTask);
    const rows: ExecutiveTaskSnapshot[] = [];
    const retained = new Set<number>();
    let bytes = 0;
    for (const task of ordered) {
      if (retained.has(task.snapshot.handle)) continue;
      const row = { ...task.snapshot, request: task.frameRequest, result: task.frameResult, detail_omitted: task.detailOmitted };
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > 24 * 1024) continue;
      rows.push(row); retained.add(row.handle); bytes += size;
    }
    this.session.tasks = rows.sort((left, right) => left.handle - right.handle);
    this.session.tasks_omitted = this.tasks.size - rows.length;
    const native = this.raw?.snapshot();
    this.data.pending.frames = native?.pending_frames ?? 0;
    this.data.pending.edges = native?.pending_edges ?? 0;
    return structuredClone(this.data);
  }
  async start(): Promise<void> {
    if (this.data.status !== "starting") return;
    if (!this.options.current() || this.clock.now() >= this.options.deadline_host_ms) {
      await this.stop("session_not_current"); return;
    }
    if (!this.worker.activate) { await this.fail("session_requires_model_authored_activate"); return; }
    this.anchor = this.clock.now(); this.nextDecisionAt = this.anchor; this.data.status = "running";
    this.deadlineTimer = this.clock.setTimeout(() => { void this.stop("session_deadline"); }, this.options.deadline_host_ms - this.clock.now());
    this.notify(true); this.scheduleSample(); this.schedule();
  }
  updateIntent(intent: Json, expectedVersion: number): number {
    if (!this.current() || this.data.status !== "running" || expectedVersion !== this.data.intent_version)
      throw new Error("Stale executive intent update");
    this.rawMonitor.clear();
    this.stationaryViewMonitor.clear();
    this.intent = structuredClone(intent); return ++this.data.intent_version;
  }
  analyze(source: ResidentAnalysisSource, input: Json, version: number): Promise<ResidentAnalysisResult> {
    return this.analysisLane.analyze(source, input, version);
  }
  private current(): boolean { return !this.abort.signal.aborted && this.options.current() && this.clock.now() < this.options.deadline_host_ms; }
  private notify(force = false, terminal = false): void {
    if (!force && this.clock.now() - this.lastNotify < 1000) return;
    this.lastNotify = this.clock.now(); this.options.changed(this.snapshot(), terminal);
  }
  private schedule(waitForNextPeriod = false): void {
    if (!this.current()) { void this.stop("session_scope_or_deadline_closed"); return; }
    if (this.flight) return;
    const period = 1000 / this.options.limits.frequency_hz;
    const now = this.clock.now();
    const due = Math.max(now, this.nextDecisionAt, waitForNextPeriod ? now + period : now);
    if (this.timer !== null) {
      if (this.timerAt <= due) return;
      this.clock.clearTimeout(this.timer);
    }
    this.timerAt = due;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null; this.timerAt = Infinity;
      const previousSteps = this.data.counters.steps;
      const epoch = this.decisionEpoch, channel = this.raw;
      const work = this.tick(); this.flight = work;
      void work.catch(error => {
        if (epoch !== this.decisionEpoch) return;
        if (channel && this.recoverNativeFault(channel, error)) return;
        if (error instanceof ControllerChannelFaultError) this.recordControllerFault(this.raw, error.fault);
        else if (error instanceof GeneratedControllerResultValidationError) this.resultFailure = error;
        return this.fail(errorText(error));
      }).finally(() => {
        this.flight = null;
        if (this.current()) {
          const unread = this.capture !== null && this.capture.frame.frame_seq > this.lastFrame;
          this.schedule(this.data.counters.steps === previousSteps && !unread);
        }
      });
    }, Math.max(0, Math.ceil(due - now)));
  }
  private scheduleSample(): void {
    if (!this.current() || this.data.counters.frames >= this.options.limits.max_frames) return;
    const period = 1000 / this.options.limits.frequency_hz;
    const slot = Math.max(this.sampleSlot, Math.ceil((this.clock.now() - this.anchor) / period));
    this.sampleTimer = this.clock.setTimeout(() => {
      this.sampleTimer = null; this.sampleSlot = slot + 1;
      const work = this.sample(); this.sampleFlight = work;
      void work.catch(error => this.fail(errorText(error))).finally(() => {
        this.sampleFlight = null;
        if (this.current()) this.scheduleSample();
      });
    }, Math.max(0, this.anchor + slot * period - this.clock.now()));
  }
  private async sample(): Promise<void> {
    if (!this.current()) return;
    const transitioning = this.transition !== null, channel = transitioning ? null : this.raw, generation = this.captureGeneration;
    let frame: MinecraftControllerFrame;
    try {
      frame = minecraftControllerFrameSchema.parse(await (channel ? channel.sample(this.cursor) : this.options.sample(this.cursor)));
    } catch (error) {
      if (!this.current()) return;
      // A read pinned before a deliberate producer switch cannot be consumed
      // by its successor. Exact retirement still joins that old native owner.
      if (error instanceof ControllerScreenReadSupersededError || transitioning || this.transition || channel !== this.raw) {
        this.data.counters.stale_frames++; return;
      }
      if (channel) {
        if (this.recoverNativeFault(channel, error)) return;
        throw this.channelFailure(channel, error);
      }
      throw error;
    }
    if (!this.current()) return;
    if (channel === this.raw && frame.screen !== null) this.rawWorldOnly = false;
    if (frame.frame_seq <= this.lastSampleFrame) { this.data.counters.stale_frames++; return; }
    this.lastSampleFrame = frame.frame_seq; this.data.counters.frames++;
    // One latest-capture mailbox: no unbounded frame queue or parallel VM calls.
    this.capture = { frame, channel, transitioning, generation, receivedHostMs: this.clock.now() };
    this.schedule();
  }
  private async tick(): Promise<void> {
    const limits = this.options.limits;
    if (!this.current()) return;
    if (this.data.counters.steps >= limits.max_steps ||
      this.data.counters.frames >= limits.max_frames && (!this.capture || this.capture.frame.frame_seq <= this.lastFrame)) {
      void this.stop("session_frame_budget"); return;
    }
    if (!this.transition && this.raw && this.clock.now() >= this.rawLeaseDeadline) {
      await this.recover("known_expired_raw_lease"); return;
    }
    const capture = this.capture;
    if (!capture || capture.frame.frame_seq <= this.lastFrame) return;
    const { frame, channel: samplingChannel, transitioning: samplingTransition } = capture;
    this.lastFrame = frame.frame_seq;
    // Opening/retiring may finish while the independent read is in flight.
    // That capture was never retained by the new channel: compute again from
    // its own next sample rather than relabeling or replaying this one.
    if (samplingTransition || this.transition || samplingChannel !== this.raw || capture.generation !== this.captureGeneration) return;
    if (this.raw && frame.screen !== null) this.rawWorldOnly = false;
    // After a coordinator stall, the latest buffered capture may already have
    // spent most of its native application window waiting here. No VM has run
    // on it yet: discard it, not its eventual input or mutated source globals.
    const mailboxAge = this.clock.now() - capture.receivedHostMs;
    if (mailboxAge < 0 || mailboxAge > Math.min(150, 1000 / limits.frequency_hz)) {
      this.data.counters.stale_frames++;
      return;
    }
    const applied = this.raw?.snapshot().last_input;
    if (applied?.input_application === "confirmed" &&
      BigInt(frame.captured_native_ns) < BigInt(applied.applied_native_ns)) {
      // The read may have completed recently but still precede the previous
      // input's application. Wait for actual post-application feedback.
      this.data.counters.stale_frames++;
      return;
    }
    // The host decorates only its own software state, never native or evaluator observations.
    const decorated = { ...frame, executive: this.snapshot().session } as MinecraftControllerFrame;
    const version = this.data.intent_version, epoch = this.decisionEpoch, started = this.clock.now();
    const period = 1000 / limits.frequency_hz;
    if (this.lastDecisionStarted !== null)
      this.data.counters.missed_slots += Math.max(0, Math.floor((started - this.lastDecisionStarted) / period) - 1);
    this.lastDecisionStarted = started; this.nextDecisionAt = started + period;
    this.data.counters.steps++;
    const activating = !this.activated;
    this.activated = true;
    let raw: unknown;
    try {
      raw = activating
        ? await this.worker.activate!(decorated, structuredClone(this.data.state), structuredClone(this.intent), this.abort.signal)
        : await this.worker.step(decorated, structuredClone(this.data.state), structuredClone(this.intent), this.abort.signal);
    } catch (error) {
      if (epoch !== this.decisionEpoch) { this.data.counters.stale_results++; return; }
      throw error;
    }
    if (epoch !== this.decisionEpoch) { this.data.counters.stale_results++; return; }
    if (!this.current() || version !== this.data.intent_version) {
      this.data.counters.stale_results++;
      // Globals may already have changed: never reuse an uncommitted first activation.
      throw new Error("session_decision_superseded");
    }
    const activation = residentActivationResultSchema.parse(raw);
    if ("refused" in activation) { void this.stop(`session_activation_refused: ${activation.reason}`); return; }
    const result = executiveStepResultSchema.parse(activation);
    if (this.clock.now() - started > Math.min(150, limits.step_ms + 100)) {
      await this.recover("known_unsent_stale_decision"); return;
    }
    if (result.events.length > limits.max_events - this.events) throw new Error("session_event_budget");
    const terminal = result.status !== "running";
    const choice = result.choice;
    // A live lease at sample time may expire while the worker computes.
    // Do not try to renew that retired owner or submit this computed input.
    // Only an explicitly selected recovery contract may start a fresh invocation.
    if (!terminal && choice.kind === "raw" && this.raw && this.clock.now() >= this.rawLeaseDeadline) {
      await this.recover("known_expired_raw_lease"); return;
    }
    let implicitEdges = false;
    // A terminal software return is publishable, but its choice admits no effects.
    if (!terminal) {
      implicitEdges = choice.kind === "raw" && choice.input?.kind === "world" && !("edges" in choice.input) &&
        (Object.keys(this.submittedHeld) as (keyof WorldHeld)[]).some(button =>
          choice.input?.kind === "world" && choice.input.held[button] !== this.submittedHeld[button]);
      const adopted = await this.choose(choice, frame, version, epoch);
      if (!adopted || !this.current() || version !== this.data.intent_version || epoch !== this.decisionEpoch) return;
    }
    this.data.state = structuredClone(result.next_state); this.cursor = frame.audible.next_cursor;
    this.data.processed_frame_seq = frame.frame_seq; this.data.processed_native_tick = frame.native_tick;
    this.data.processed_native_ns = frame.captured_native_ns;
    const elapsed = this.clock.now() - started;
    this.data.timings.step_ms.count++; this.data.timings.step_ms.max = Math.max(this.data.timings.step_ms.max ?? 0, elapsed);
    // This survives harmless raw/observe producer turnover, not semantic work or
    // authority changes. It certifies samples and accepted choices, never ACKs.
    if (!terminal && (implicitEdges || this.activeTask || elapsed > 150)) this.stationaryViewMonitor.clear();
    else if (!terminal) {
      const incident = this.stationaryViewMonitor.update(
        `${this.options.execution_id}:${this.session.behavior_generation}:${version}`, frame, choice, this.clock.now(),
        choice.kind !== "raw" || this.raw !== null);
      if (incident) this.options.record("session.continuity_incident", { ...incident,
        intent_version: version, behavior_generation: this.session.behavior_generation });
    }
    if (terminal) this.data.status = result.status;
    for (const event of result.events) {
      this.events++; this.data.counters.events = this.events;
      this.data.events.push({ sequence: this.events, host_monotonic_ms: this.clock.now(), event });
      if (this.data.events.length > 128) this.data.events.shift();
      this.options.event(event);
    }
    if (terminal) {
      // stop joins this tick; awaiting it here would deadlock its own drain.
      void this.stop(`session_${result.status}`); return;
    }
    this.notify();
  }
  private change(operation: () => Promise<void>): void {
    if (this.transition) return;
    this.captureGeneration++;
    this.session.producer = "retiring";
    const work = Promise.resolve().then(operation);
    this.transition = work;
    void work.catch(error => this.fail(errorText(error))).finally(() => {
      if (this.transition === work) this.transition = null;
      this.notify(true);
    });
  }
  private async retireRaw(): Promise<RevocationAck | null> {
    this.rawMonitor.clear();
    const raw = this.raw;
    if (!raw) return null;
    this.recordControllerFault(raw);
    const ack = revocationAckSchema.parse(await raw.revoke());
    if (ack.controller_generation !== raw.controllerGeneration || ack.owner.operation_id !== raw.owner.operation_id ||
      ack.owner.generation !== raw.owner.generation || !sameEffectScope(ack.owner.scope, raw.owner.scope)) throw new ResidentCleanupError();
    const snapshot = raw.snapshot();
    if (snapshot.fault) this.recordControllerFault(raw, snapshot.fault, snapshot);
    if (this.controllerFaultRecorded) this.options.record("session.controller_cleanup", { owner: raw.owner, controller_generation: raw.controllerGeneration,
      native: "retired", retirement: ack, fault: snapshot.fault } as unknown as Json);
    if (this.raw === raw) this.raw = null;
    for (const button of Object.keys(this.submittedHeld) as (keyof WorldHeld)[]) this.submittedHeld[button] = false;
    this.inputCaptures.clear(); this.session.producer = "none"; this.session.last_submission = null;
    return ack;
  }
  private async retire(task: Task, reason: string): Promise<void> {
    if (task.retirement) return task.retirement;
    const unstarted = task.work === null;
    if (!settled(task)) task.snapshot.status = "retiring";
    task.abort.abort(reason);
    task.retirement = (async () => {
      await this.options.retireTask(task.snapshot.handle, reason);
      await task.work;
      if (task.snapshot.status === "retiring") task.snapshot.status = "interrupted";
      if (unstarted) {
        task.snapshot.result = { status: "cancelled", summary: "Reserved child cancelled before dispatch",
          evidence: { world_effect_emitted: false } };
        task.frameResult = task.snapshot.result;
      }
      if (this.activeTask === task) this.activeTask = null;
      this.options.record("session.child_retired", task.snapshot as unknown as Json);
      this.session.producer = "none";
    })();
    return task.retirement;
  }
  private reject(reason: string): boolean { this.session.last_command_error = reason.slice(0, 1000); return true; }
  private async choose(choice: ExecutiveChoice, frame: MinecraftControllerFrame, expectedIntentVersion: number, epoch: number): Promise<boolean> {
    this.session.last_command_error = null;
    if (choice.kind !== "raw") this.rawMonitor.clear();
    if (choice.kind === "raw") {
      if (this.activeTask) { const task = this.activeTask; this.change(() => this.retire(task, "Executive selected raw control")); return true; }
      if (!this.raw) {
        this.change(async () => {
          const generation = ++this.rawGeneration;
          const openedAt = this.clock.now();
          const channel = await this.options.open(this.options.deadline_host_ms,
            ack => this.applied(generation, ack), event => this.effect(generation, event),
            { fence: () => {}, drain: async () => {} }, generation);
          if (this.stationaryViewScope && !sameEffectScope(this.stationaryViewScope, channel.owner.scope))
            this.stationaryViewMonitor.clear();
          this.stationaryViewScope = channel.owner.scope;
          this.raw = channel;
          this.rawWorldOnly = frame.screen === null;
          this.rawLeaseDeadline = openedAt + 250;
          this.session.last_submission = null;
          this.data.controller_generation = channel.controllerGeneration;
          this.data.counters.applied_sequence = 0; this.data.counters.ordered_edge_prefix = 0; this.data.last_input = null;
          if (!this.current()) await this.retireRaw(); else this.session.producer = "raw";
        });
        return true;
      }
      const snapshot = this.raw.snapshot();
      if (snapshot.fenced) {
        this.recordControllerFault(this.raw, snapshot.fault, snapshot);
        throw new ControllerChannelFaultError(snapshot.fault, snapshot.fault
          ? `session_controller_fault: ${snapshot.fault.stage}:${snapshot.fault.cause}` : "session_controller_fault_unavailable");
      }
      // tick sampled through this exact channel, so its capture is retained for admission.
      const admittedFrame = frame;
      let desired = choice.input;
      if (desired?.kind === "world" && !("edges" in desired)) {
        const edges: WorldInputEdge[] = [];
        for (const button of Object.keys(this.submittedHeld) as (keyof WorldHeld)[])
          if (desired.held[button] !== this.submittedHeld[button])
            edges.push({ kind: "button", button, phase: desired.held[button] ? "press" : "release", count: 1 });
        desired = { ...desired, edges };
      }
      const input = desired === null ? null : controllerInputSchema.parse(desired);
      if (input?.kind === "screen" || input?.kind === "world" && (input.held.use ||
        input.edges.some(edge => edge.kind === "button" && edge.phase === "press" &&
          (edge.button === "inventory" || edge.button === "use")))) this.rawWorldOnly = false;
      const expanded = input === null ? 0 : input.kind === "screen" ? input.operations.length : input.edges.reduce((sum, edge) => sum + (edge.kind === "button" ? edge.count : 1), 0);
      while (this.edgeWindow.length && this.edgeWindow[0]!.at <= this.clock.now() - 1000) this.edgeWindow.shift();
      if (expanded > this.options.limits.max_edges - this.totalEdges ||
        expanded + this.edgeWindow.reduce((sum, entry) => sum + entry.count, 0) > this.options.limits.max_edges_per_second)
        throw new Error("session_edge_budget");
      const renewalStarted = this.clock.now();
      try { await this.raw.renew(admittedFrame as unknown as Json); } catch (error) {
        const failure = this.channelFailure(this.raw, error), fault = failure.fault;
        // The channel can reject capture age after otherwise timely VM work.
        // Only this trusted exact-owner, known-unsent admission is reset-safe;
        // an asynchronous response or unrelated fault remains fail-closed.
        if (error instanceof ControllerChannelFaultError && fault?.stage === "heartbeat_admission" &&
          fault.cause === "stale_native_frame" && fault.decision_dispatch === "not_dispatched" &&
          fault.request_id === null && fault.sequence === null &&
          fault.owner.operation_id === this.raw.owner.operation_id && fault.owner.generation === this.raw.owner.generation &&
          sameEffectScope(fault.owner.scope, this.raw.owner.scope) &&
          fault.controller_generation === this.raw.controllerGeneration &&
          fault.frame_seq === admittedFrame.frame_seq && fault.captured_native_ns === admittedFrame.captured_native_ns &&
          fault.original_deadline_host_ms === this.options.deadline_host_ms) {
          this.data.counters.stale_results++;
          await this.recover("known_unsent_stale_native_frame");
          return false;
        }
        throw failure;
      }
      this.rawLeaseDeadline = renewalStarted + 250;
      if (!this.current() || epoch !== this.decisionEpoch) return false;
      if (this.data.intent_version !== expectedIntentVersion) {
        this.data.counters.stale_results++;
        throw new Error("session_decision_superseded_before_input_admission");
      }
      if (input === null) {
        this.data.counters.no_input_decisions++;
        return true;
      }
      let submitted: ReturnType<ControllerInputChannel["submit"]>;
      try { submitted = this.raw.submit(admittedFrame as unknown as Json, input); } catch (error) {
        throw this.channelFailure(this.raw, error);
      }
      if (submitted.status === "rejected") {
        const snapshot = this.raw.snapshot();
        this.recordControllerFault(this.raw, snapshot.fault, snapshot, submitted.reason);
        throw new ControllerChannelFaultError(snapshot.fault, `session_input_rejected: ${submitted.reason}`);
      }
      if (this.inputCaptures.size >= 512) throw new Error("session_input_attribution_capacity");
      this.inputCaptures.set(`${this.rawGeneration}:${submitted.sequence}`, {
        generation: this.rawGeneration, sequence: submitted.sequence, intentVersion: expectedIntentVersion, frame, input,
      });
      this.session.last_submission = { frame_seq: frame.frame_seq,
        controller_generation: this.raw.controllerGeneration, sequence: submitted.sequence,
        intent_version: expectedIntentVersion, behavior_generation: this.session.behavior_generation,
        status: submitted.status };
      if (input.kind === "world") this.submittedHeld = { ...input.held };
      this.totalEdges += expanded; this.data.counters.expanded_edges = this.totalEdges;
      if (expanded) this.edgeWindow.push({ at: this.clock.now(), count: expanded });
      this.data.counters.submissions++;
      return true;
    }
    if (choice.kind === "observe") {
      if (this.raw) { this.change(async () => { await this.retireRaw(); }); return true; }
      // Observing deliberately does not renew a semantic producer's supervision lease.
      this.data.counters.no_input_decisions++; return true;
    }
    const handle = choice.kind === "ensure_task" ? choice.key : choice.handle;
    const existing = this.tasks.get(handle);
    if (choice.kind === "cancel") {
      if (existing && !settled(existing)) { this.change(() => this.retire(existing, "Executive cancelled exact child")); return true; }
      if (existing) this.data.counters.no_input_decisions++;
      return existing ? true : this.reject(`Task ${handle} detail expired or was never admitted; no replay (high-water ${this.session.task_high_water})`);
    }
    if (choice.kind === "continue") {
      if (!existing) return this.reject(`Task ${handle} detail not retained; history ${this.options.execution_id}:task:${handle}; no replay`);
      if (settled(existing)) { this.data.counters.no_input_decisions++; return true; }
      if (existing !== this.activeTask || existing.snapshot.status === "retiring") return this.reject("Retiring or inactive child cannot renew");
      if (existing.snapshot.status === "starting") { this.startTask(existing, frame); return true; }
      await this.options.supervise(handle, frame, this.session.behavior_generation); return true;
    }
    const fingerprint = JSON.stringify(choice.request);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return this.reject("Task key conflict: changed content cannot execute under an existing key");
      if (settled(existing)) this.data.counters.no_input_decisions++;
      if (existing === this.activeTask) {
        if (existing.snapshot.status === "starting") this.startTask(existing, frame);
        else if (existing.snapshot.status === "running") await this.options.supervise(handle, frame, this.session.behavior_generation);
      }
      return true;
    }
    if (handle <= this.session.task_high_water) return this.reject(`Task ${handle} expired; no replay; history ${this.options.execution_id}:task:${handle}`);
    if (handle !== this.session.task_high_water + 1) return this.reject("Task keys must advance by one");
    if (this.session.task_high_water >= this.options.config.max_tasks) return this.reject("Session task budget exhausted");
    this.pruneTasks();
    if (this.tasks.size >= this.options.config.retained_tasks) return this.reject("Unresolved task detail quota exhausted; no effects admitted");
    const deadline = Math.min(this.options.deadline_host_ms, this.clock.now() + choice.request.duration_ms);
    const task: Task = { snapshot: { handle, status: "starting", request: choice.request, result: null,
      deadline_host_ms: deadline, history_ref: `${this.options.execution_id}:task:${handle}` }, fingerprint,
      abort: new AbortController(), work: null, retirement: null,
      frameRequest: Buffer.byteLength(fingerprint) <= 1024 ? choice.request : null, frameResult: null,
      detailOmitted: Buffer.byteLength(fingerprint) > 1024 };
    const previous = this.activeTask;
    this.tasks.set(handle, task); this.session.task_high_water = handle; this.activeTask = task;
    this.options.record("session.child_reserved", task.snapshot as unknown as Json);
    // Adoption reserves an idempotent logical child immediately. Otherwise a
    // policy that records its requested strike/task would lose that request
    // when retirement finishes and its next decision chooses something else.
    if (this.raw) { this.change(async () => { await this.retireRaw(); }); return true; }
    if (previous) { this.change(() => this.retire(previous, "Executive selected another child")); return true; }
    this.startTask(task, frame);
    return true;
  }

  private startTask(task: Task, frame: MinecraftControllerFrame): void {
    if (task.work || task !== this.activeTask || task.snapshot.status !== "starting") return;
    if (this.raw || this.transition) throw new Error("Semantic child cannot start before exact producer retirement");
    if (!this.current() || task.abort.signal.aborted || this.clock.now() >= task.snapshot.deadline_host_ms) {
      task.snapshot.status = task.abort.signal.aborted ? "interrupted" : "failed";
      task.snapshot.result = { status: "cancelled", summary: "Reserved child deadline or authority ended before dispatch",
        evidence: { world_effect_emitted: false } };
      task.frameResult = task.snapshot.result; this.activeTask = null;
      this.options.record("session.child_settled", task.snapshot as unknown as Json);
      return;
    }
    const request = task.snapshot.request;
    if (!request) throw new Error("Reserved child lost its immutable request");
    const handle = task.snapshot.handle, deadline = task.snapshot.deadline_host_ms;
    this.session.producer = "task";
    task.snapshot.status = "running";
    task.work = Promise.resolve().then(async () => {
      try {
        if (!this.current() || task.abort.signal.aborted) {
          task.snapshot.status = "interrupted";
          task.snapshot.result = { status: "cancelled", summary: "Child authority ended before dispatch",
            evidence: { world_effect_emitted: false } };
          task.frameResult = task.snapshot.result; return;
        }
        const result = await this.options.task(request, handle, deadline, task.abort.signal, frame, this.session.behavior_generation);
        task.snapshot.result = result;
        const completeResult = Buffer.byteLength(JSON.stringify(result)) <= 1024;
        task.frameResult = completeResult ? result : { ...result, summary: result.summary.slice(0, 256), evidence: null };
        task.detailOmitted ||= !completeResult;
        task.snapshot.status = result.status === "succeeded" ? "succeeded" : result.status === "cancelled" ? "interrupted" : result.status;
        if (result.requires_reconnect) throw new ResidentCleanupError();
      } catch (error) {
        if (error instanceof ResidentCleanupError) { void this.fail(error.message); throw error; }
        task.snapshot.status = task.abort.signal.aborted ? "interrupted" : "failed";
        task.snapshot.result = { status: "failed", summary: errorText(error).slice(0, 2000), evidence: null };
        task.frameResult = { ...task.snapshot.result, summary: task.snapshot.result.summary.slice(0, 256) };
        task.detailOmitted = true;
      } finally {
        await this.options.retireTask(handle, "Finite child settled");
        if (this.activeTask === task) { this.activeTask = null; this.session.producer = "none"; }
        this.options.record("session.child_settled", task.snapshot as unknown as Json); this.notify(true);
      }
    });
    void task.work.catch(error => this.fail(errorText(error)));
  }
  private pruneTasks(): void {
    for (const [key, task] of this.tasks) {
      if (this.tasks.size < this.options.config.retained_tasks) break;
      if (settled(task) && task.snapshot.status !== "unknown" && task !== this.activeTask) this.tasks.delete(key);
    }
  }
  private applied(generation: number, ack: InputAppliedAck): void {
    const capture = this.inputCaptures.get(`${generation}:${ack.sequence}`);
    if (!capture) return;
    this.data.last_input = ack; this.data.counters.applied_sequence = ack.sequence;
    this.data.counters.ordered_edge_prefix = ack.ordered_edge_prefix;
    if (ack.input_application === "confirmed") {
      const age = Number(BigInt(ack.applied_native_ns) - BigInt(capture.frame.captured_native_ns)) / 1e6;
      this.data.timings.input_age_ms.count++; this.data.timings.input_age_ms.max = Math.max(this.data.timings.input_age_ms.max ?? 0, age);
    }
    if (this.current() && !this.transition && this.raw && generation === this.rawGeneration &&
      capture.intentVersion === this.data.intent_version && this.session.producer === "raw") {
      const incident = this.rawMonitor.update(`${generation}:${this.session.behavior_generation}:${this.data.intent_version}`,
        capture.frame, capture.input, ack, this.clock.now());
      if (incident) this.options.record("session.continuity_incident", { ...incident, usefulness_inferred: false,
        intent_version: this.data.intent_version, behavior_generation: this.session.behavior_generation });
    }
    for (const [key, value] of this.inputCaptures)
      if (value.generation === generation && value.sequence < ack.sequence && value.input.kind === "world")
        this.inputCaptures.delete(key);
  }
  private effect(generation: number, event: ControllerEffectUpdate): void {
    const key = `${generation}:${event.sequence}`, capture = this.inputCaptures.get(key);
    if (!capture) return;
    this.options.effect(capture.input, event); this.inputCaptures.delete(key);
  }
  private exactFault(channel: ControllerInputChannel, fault: ControllerChannelFault): boolean {
    return fault.owner.operation_id === channel.owner.operation_id && fault.owner.generation === channel.owner.generation &&
      sameEffectScope(fault.owner.scope, channel.owner.scope) && fault.controller_generation === channel.controllerGeneration &&
      fault.original_deadline_host_ms === this.options.deadline_host_ms;
  }
  private recoverNativeFault(channel: ControllerInputChannel, error: unknown): boolean {
    if (!this.current() || channel !== this.raw || this.transition || !this.rawWorldOnly ||
      this.options.config.recovery !== "checkpoint_safe" || !this.options.restartWorker ||
      this.session.restarts >= this.options.config.max_restarts ||
      !(error instanceof ControllerChannelFaultError) || !error.fault || !this.exactFault(channel, error.fault) ||
      !["sample", "heartbeat_response", "submit_response"].includes(error.fault.stage) ||
      !["native_rejected", "native_lease_expired", "native_frame_expired"].includes(error.fault.cause)) return false;
    this.recordControllerFault(channel, error.fault);
    // A candidate is not permission to retry. Exact retirement must supply the
    // native first-fence cause before a new realm can be created.
    void this.recover("confirmed_native_world_fence", channel);
    return true;
  }
  private async recover(reason: string, nativeCandidate?: ControllerInputChannel): Promise<void> {
    const checkpoint = this.options.config.recovery === "checkpoint_safe";
    // Only committed JSON crosses realms. Globals, pending results and effects do not.
    if (this.options.config.recovery === "none" || !this.options.restartWorker ||
      this.session.restarts >= this.options.config.max_restarts || this.transition) throw new Error(`session_recovery_refused: ${reason}`);
    if (checkpoint && this.raw && !this.rawWorldOnly) throw new Error(`session_recovery_refused_gui: ${reason}`);
    const state = structuredClone(checkpoint ? this.data.state : this.options.initial_state);
    this.decisionEpoch++;
    this.change(async () => {
      if (this.activeTask) await this.retire(this.activeTask, reason);
      const retirement = await this.retireRaw();
      if (checkpoint && retirement && retirement.unresolved_operation_refs.length)
        throw new RecoveryAdmissionRefused("session_recovery_refused_unresolved_raw_effects");
      if (nativeCandidate) {
        const retired = nativeCandidate.snapshot(), fault = retired.fault;
        if (!retired.retired || !fault || !this.exactFault(nativeCandidate, fault) ||
          !["native_input_lease_expired", "queued_frame_expired_before_application"].includes(fault.native_first_fence?.reason ?? ""))
          throw new RecoveryAdmissionRefused("session_recovery_refused_native_fence");
      }
      try { await this.worker.close(); } catch (error) { this.recoveryWorkerUnknown = true; throw error; }
      if (!this.current()) return;
      this.session.restarts++; this.session.behavior_generation++;
      let candidate: ResidentWorker;
      try { candidate = await this.options.restartWorker!(this.abort.signal); }
      catch (error) { if (error instanceof ResidentCleanupError) this.recoveryWorkerUnknown = true; throw error; }
      if (!this.current() || !candidate.activate) {
        try { await candidate.close(); } catch (error) { this.recoveryWorkerUnknown = true; throw error; }
        if (!this.current()) return;
        throw new RecoveryAdmissionRefused("Recovery worker lacks clean activation");
      }
      this.worker = candidate;
      // The child may have settled before recovery started, leaving no retire()
      // call to clear the transition marker. All previous emitters are drained.
      this.session.producer = "none";
      this.data.state = state; this.activated = false;
      this.options.record(checkpoint ? "session.checkpoint_safe_restart" : "session.reset_safe_restart", { reason, generation: this.session.behavior_generation,
        original_deadline_host_ms: this.options.deadline_host_ms, replayed_effects: false });
    });
  }
  private channelFailure(channel: ControllerInputChannel, error: unknown): ControllerChannelFaultError {
    const snapshot = channel.snapshot();
    const fault = snapshot.fault ?? (error instanceof ControllerChannelFaultError ? error.fault : null);
    this.recordControllerFault(channel, fault, snapshot, errorText(error));
    return new ControllerChannelFaultError(fault, errorText(error));
  }
  private recordControllerFault(channel: ControllerInputChannel | null, fault: ControllerChannelFault | null = null,
    snapshot = channel?.snapshot(), unavailableDetail: string | null = null): void {
    if (this.controllerFaultRecorded) return;
    fault ??= snapshot?.fault ?? null;
    if (!fault && !snapshot?.fenced && unavailableDetail === null) return;
    this.controllerFaultRecorded = true;
    this.options.record("session.controller_fault", {
      schema_version: 1, fault: fault === null ? null : structuredClone(fault), cause_available: fault !== null,
      unavailable_detail: fault ? null : (unavailableDetail ?? snapshot?.reason ?? "Channel fenced without retained typed cause").slice(0, 2000),
      owner: channel?.owner ?? fault?.owner ?? null,
      controller_generation: channel?.controllerGeneration ?? fault?.controller_generation ?? this.rawGeneration,
      host_detected_ms: this.clock.now(), host_lease_deadline_ms: Number.isFinite(this.rawLeaseDeadline) ? this.rawLeaseDeadline : null,
      original_deadline_host_ms: this.options.deadline_host_ms,
      channel: snapshot ?? null, counters: { ...this.data.counters }, cleanup: { ...this.data.cleanup },
    } as unknown as Json);
  }
  private async fail(reason: string): Promise<void> {
    this.recordControllerFault(this.raw);
    if (!this.abort.signal.aborted) { this.data.status = "failed"; this.data.reason = reason; }
    void this.stop(reason);
  }
  stop(reason: string): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stationaryViewMonitor.clear();
    this.abort.abort(reason);
    this.analysisLane.fence(reason);
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.sampleTimer !== null) this.clock.clearTimeout(this.sampleTimer);
    if (this.deadlineTimer !== null) this.clock.clearTimeout(this.deadlineTimer);
    this.data.reason ??= reason;
    const done = Promise.withResolvers<void>(); this.stopTask = done.promise;
    void (async () => {
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(async () => {
          await this.transition?.catch(error => {
            if (!this.recoveryWorkerUnknown && !(error instanceof RecoveryAdmissionRefused)) throw error;
          });
          if (this.activeTask) await this.retire(this.activeTask, reason);
          await this.retireRaw(); this.data.cleanup.native = "retired";
        }),
        Promise.resolve().then(async () => {
          await this.worker.close();
          // Recovery may still own a factory result after Stop closes the old worker.
          await this.transition?.catch(error => {
            if (!this.recoveryWorkerUnknown && !(error instanceof RecoveryAdmissionRefused)) throw error;
          });
          if (this.recoveryWorkerUnknown) throw new ResidentCleanupError();
          this.data.cleanup.worker = "closed";
        }),
        Promise.resolve().then(async () => { await this.analysisLane.drain(); }),
        // A source/result failure is the reason for stopping, not failed cleanup.
        // Join the attempt; worker.close and exact native retirement prove drain.
        Promise.resolve().then(async () => { await this.flight?.catch(() => {}); }),
        Promise.resolve().then(async () => { await this.sampleFlight?.catch(() => {}); }),
      ]);
      const failure = cleanup.find(result => result.status === "rejected");
      this.recordControllerFault(this.raw);
      if (failure) {
        this.data.status = "unknown";
        if (cleanup[0]!.status === "rejected") this.data.cleanup.native = "unknown";
        if (cleanup[1]!.status === "rejected" || cleanup[2]!.status === "rejected") this.data.cleanup.worker = "unknown";
      } else if (!["failed", "completed", "blocked", "yielded"].includes(this.data.status)) this.data.status = "stopped";
      if (this.controllerFaultRecorded) this.options.record("session.controller_cleanup", {
        cleanup: { ...this.data.cleanup }, original_deadline_host_ms: this.options.deadline_host_ms,
        host_completed_ms: this.clock.now(),
      });
      this.notify(true, true);
      if (failure) throw new ResidentCleanupError();
    })().then(done.resolve, done.reject);
    return this.stopTask;
  }
}
