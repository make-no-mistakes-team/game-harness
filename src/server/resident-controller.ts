import { createHash, randomUUID } from "node:crypto";
import type { Json } from "../shared/contracts.ts";
import { sameEffectScope, type WorldHeld } from "../shared/control.ts";
import { controllerEffectUpdateSchema, inputAppliedAckSchema, revocationAckSchema,
  type ControllerEffectUpdate, type ControllerInput, type ControllerInputChannel, type InputAppliedAck } from "../shared/controller.ts";
import { minecraftControllerFrameSchema } from "../shared/minecraft.ts";
import { controllerStepResultSchema, ResidentCleanupError, RESIDENT_STEP_RESPONSE_MS, residentAnalysisInputSchema, residentAnalysisOutputSchema, residentIntentSchema, residentLimitsSchema, residentSourceIdentitySchema, residentStateSchema,
  type ResidentAnalysisResult, type ResidentAnalysisSource, type ResidentClock, type ResidentControllerOptions,
  type ResidentSnapshot, type ResidentTimingSummary, type ResidentTraceStage } from "../shared/resident.ts";

const heldKeys: (keyof WorldHeld)[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use"];
const neutral: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false };
const defaultClock: ResidentClock = { id: `host-${randomUUID()}`, now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sameHeld = (a: WorldHeld, b: WorldHeld) => heldKeys.every(key => a[key] === b[key]);

class TimingWindow {
  private samples: number[] = [];
  private count = 0;
  private maximum: number | null = null;
  private cursor = 0;
  add(value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    this.count++; this.maximum = Math.max(this.maximum ?? value, value);
    if (this.samples.length < 512) this.samples.push(value);
    else { this.samples[this.cursor] = value; this.cursor = (this.cursor + 1) % 512; }
  }
  snapshot(): ResidentTimingSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
    return { count: this.count, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: this.maximum,
      omitted_samples: this.count - sorted.length };
  }
}
interface SubmittedCapture { input: ControllerInput; native_ns: string; age_recorded: boolean; effect_recorded: boolean }

/** One resident's authored computation and lifecycle; native I/O remains solely in the admitted channel. */
export class ResidentController {
  private readonly options: ResidentControllerOptions;
  private readonly clock: ResidentClock;
  private readonly abort = new AbortController();
  private readonly stepTiming = new TimingWindow();
  private readonly ageTiming = new TimingWindow();
  private readonly submitted = new Map<number, SubmittedCapture>();
  private readonly edges: { at: number; count: number }[] = [];
  private readonly data: ResidentSnapshot;
  private intent: Json;
  private channel: ControllerInputChannel | null = null;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private drainTask: Promise<void> | null = null;
  private flight: Promise<void> | null = null;
  private analysisTask: Promise<ResidentAnalysisResult> | null = null;
  private analysisAbort: AbortController | null = null;
  private analysisCleanupFailure: ResidentCleanupError | null = null;
  private timer: unknown = null;
  private deadlineTimer: unknown = null;
  private fenced = false;
  private anchor = 0;
  private nextSlot = 0;
  private lastRead = 0;
  private lastNativeTick: number | null = null;
  private lastNativeNs: bigint | null = null;
  private cursor: Json = null;
  private submittedHeld: WorldHeld = neutral;
  private runningViewRate = false;
  private lastChanged = -Infinity;
  private finalStatus: ResidentSnapshot["status"] = "stopped";
  private traceSequence = 0;
  private observerErrors = 0;

  constructor(options: ResidentControllerOptions) {
    this.options = { ...options, limits: residentLimitsSchema.parse(options.limits) };
    this.clock = options.clock ?? defaultClock;
    if (!Number.isFinite(options.deadline_host_ms)) throw new Error("Resident deadline must be finite");
    if (!Number.isSafeInteger(options.controller_generation) || options.controller_generation < 1) throw new Error("Invalid controller generation");
    this.intent = structuredClone(residentIntentSchema.parse(options.intent));
    this.data = { execution_id: options.execution_id, source_hash: options.source_hash, controller_generation: options.controller_generation,
      host_clock_id: this.clock.id, status: "starting", reason: null, intent_version: 0, state: structuredClone(residentStateSchema.parse(options.initial_state)),
      processed_frame_seq: null, processed_native_tick: null, processed_native_ns: null,
      counters: { frames: 0, steps: 0, submissions: 0, applied_sequence: 0, ordered_edge_prefix: 0, missed_slots: 0, stale_results: 0,
        stale_frames: 0, read_failures: 0, no_input_decisions: 0, expanded_edges: 0, events: 0, analysis_jobs: 0, analysis_ms: 0 },
      pending: { frames: 0, edges: 0, analysis: false }, last_input: null,
      timings: { step_ms: this.stepTiming.snapshot(), input_age_ms: this.ageTiming.snapshot() }, events: [], cleanup: { worker: "open", native: "open" } };
  }

  start(): Promise<void> {
    this.startTask ??= this.open();
    return this.startTask;
  }

  private async open(): Promise<void> {
    if (!this.active()) { this.finish("stopped", "resident_not_current_or_expired"); return; }
    this.deadlineTimer = this.clock.setTimeout(() => this.finish("stopped", "resident_deadline"), Math.max(0, this.options.deadline_host_ms - this.clock.now()));
    try {
      this.channel = await this.options.open(this.options.deadline_host_ms, ack => this.applied(ack), event => this.effect(event), {
        fence: reason => { this.fence(reason); void this.stop(reason); }, drain: () => this.drain(),
      });
      const owner = this.channel.owner.scope;
      if (this.channel.controllerGeneration !== this.options.controller_generation || owner.execution_id !== this.options.execution_id || owner.source_hash !== this.options.source_hash)
        throw new Error("Resident channel identity mismatch");
      if (!this.active()) { this.finish("stopped", "resident_not_current_or_expired"); return; }
      this.data.status = "running"; this.anchor = this.clock.now();
      if (this.options.trace) this.trace({ stage: "anchor", anchor_host_ms: this.anchor, period_ms: 1000 / this.options.limits.frequency_hz });
      this.notify(true, false); this.schedule();
    } catch (error) {
      if (!this.channel) this.data.cleanup.native = "unknown";
      this.finish("failed", `resident_open: ${message(error)}`);
    }
  }

  snapshot(): ResidentSnapshot {
    this.refreshNative();
    this.data.timings = { step_ms: this.stepTiming.snapshot(), input_age_ms: this.ageTiming.snapshot() };
    return structuredClone(this.data);
  }

  updateIntent(intent: Json, expectedVersion: number): number {
    if (!this.active() || this.data.status !== "running") throw new Error("Resident is not running");
    if (expectedVersion !== this.data.intent_version) throw new Error("Stale resident intent version");
    if (this.data.intent_version === Number.MAX_SAFE_INTEGER) throw new Error("Resident intent version exhausted");
    this.intent = structuredClone(residentIntentSchema.parse(intent)); this.data.intent_version++;
    this.notify(true, false); return this.data.intent_version;
  }

  analyze(source: ResidentAnalysisSource, input: Json, expectedIntentVersion: number): Promise<ResidentAnalysisResult> {
    if (!this.active() || this.data.status !== "running") return Promise.reject(new Error("Resident is not running"));
    if (expectedIntentVersion !== this.data.intent_version) return Promise.reject(new Error("Stale resident analysis intent version"));
    if (this.analysisTask) return Promise.reject(new Error("Resident analysis already running"));
    if (this.data.counters.analysis_jobs >= this.options.limits.max_analysis_jobs) return Promise.reject(new Error("Resident analysis job budget exhausted"));
    const remaining = this.options.limits.max_analysis_ms - this.data.counters.analysis_ms;
    if (remaining <= 0) return Promise.reject(new Error("Resident analysis time budget exhausted"));
    const identity = residentSourceIdentitySchema.parse({ skill_id: source.skill_id, version: source.version, hash: source.hash });
    const selectedSource = { ...source };
    const detached = structuredClone(residentAnalysisInputSchema.parse(input));
    const budget = Math.min(remaining, this.options.limits.analysis_job_ms, Math.max(0, this.options.deadline_host_ms - this.clock.now()));
    if (budget <= 0) return Promise.reject(new Error("Resident deadline reached"));
    const abort = new AbortController(); this.analysisAbort = abort;
    const job = ++this.data.counters.analysis_jobs;
    const result: ResidentAnalysisResult = { job_id: `${this.options.execution_id}:analysis:${job}`, source: identity,
      controller_execution_id: this.options.execution_id, controller_source_hash: this.options.source_hash,
      controller_generation: this.options.controller_generation, input_hash: createHash("sha256").update(JSON.stringify(detached)).digest("hex"),
      input_version: expectedIntentVersion, status: "failed", output: null, elapsed_ms: 0, post_evaluation_ms: null, reason: null };
    this.data.pending.analysis = true;
    // Install the task before invoking the service: synchronous rejection must still participate in drain.
    const task = Promise.resolve().then(async () => {
      let reported = false, invalidReport = false, evaluationOpen = true;
      let evaluatedAt: number | null = null;
      try {
        if (!this.active() || abort.signal.aborted) {
          result.status = "cancelled"; result.reason = this.data.reason ?? "resident_not_current_or_expired";
          if (!this.fenced) this.finish("stopped", result.reason);
          return result;
        }
        const output = await this.options.analysis(selectedSource, detached, budget, abort.signal, elapsed => {
          if (!evaluationOpen) { this.finish("failed", "resident_analysis_accounting"); return; }
          if (reported || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER ||
            this.data.counters.analysis_ms + elapsed > Number.MAX_SAFE_INTEGER) { invalidReport = true; return; }
          reported = true; evaluatedAt = this.clock.now(); result.elapsed_ms = elapsed; this.data.counters.analysis_ms += elapsed;
        });
        if (!reported || invalidReport) { invalidReport = true; throw new Error("Invalid resident analysis evaluation report"); }
        result.output = structuredClone(residentAnalysisOutputSchema.parse(output));
        if (this.fenced || this.abort.signal.aborted) { result.status = "cancelled"; result.reason = this.data.reason ?? "resident_stopped"; }
        else if (result.elapsed_ms > budget) { result.status = "failed"; result.reason = "analysis_budget"; result.output = null; }
        else if (!this.options.current() || this.data.intent_version !== expectedIntentVersion) { result.status = "stale"; result.reason = "resident_analysis_version_changed"; }
        else result.status = "completed";
      } catch (error) {
        result.status = this.fenced ? "cancelled" : "failed"; result.reason = message(error); result.output = null;
        if (error instanceof ResidentCleanupError) {
          this.analysisCleanupFailure = error;
          this.finish("unknown", error.message);
        }
      } finally {
        evaluationOpen = false;
        // Both endpoints use this host clock; guardian-relative elapsed is never
        // subtracted from a host timestamp. Compilation-only failure stays null.
        if (evaluatedAt !== null) result.post_evaluation_ms = Math.max(0, this.clock.now() - evaluatedAt);
        if (invalidReport) this.finish("failed", "resident_analysis_accounting");
        this.data.pending.analysis = false; this.analysisAbort = null; this.analysisTask = null; this.notify(false, false);
      }
      return result;
    });
    this.analysisTask = task; return task;
  }

  stop(reason: string): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.fence(reason);
    this.stopTask = this.retire(); return this.stopTask;
  }

  private fence(reason: string): void {
    if (this.fenced) return;
    this.fenced = true; this.data.reason ??= reason; this.data.status = "stopping";
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    if (this.deadlineTimer !== null) this.clock.clearTimeout(this.deadlineTimer);
    this.abort.abort(reason); this.analysisAbort?.abort(reason);
    this.notify(true, false);
  }

  /** Arbiter drain excludes native revoke, since revoke itself calls this barrier. */
  private drain(): Promise<void> {
    if (this.drainTask) return this.drainTask;
    this.data.cleanup.worker = "closing";
    const worker = Promise.resolve().then(() => this.options.worker.close()).then(() => { this.data.cleanup.worker = "closed"; }, error => {
      this.data.cleanup.worker = "unknown"; throw error;
    });
    this.drainTask = Promise.allSettled([worker, this.flight, this.analysisTask]).then(results => {
      if (this.analysisCleanupFailure) { this.data.cleanup.worker = "unknown"; throw this.analysisCleanupFailure; }
      const workerResult = results[0]!;
      if (workerResult.status === "rejected") throw workerResult.reason;
    });
    return this.drainTask;
  }

  private async retire(): Promise<void> {
    const worker = this.drain();
    // Attach immediately: native open can still be pending while worker close fails.
    const guardedWorker = worker.then(() => true, () => false);
    if (this.startTask) await this.startTask;
    let nativeKnown = this.data.cleanup.native !== "unknown";
    let combinedCleanupKnown = true;
    if (this.channel) {
      this.data.cleanup.native = "revoking";
      const accept = (value: unknown) => {
        const ack = revocationAckSchema.parse(value), channel = this.channel!;
        if (ack.controller_generation !== this.options.controller_generation || ack.owner.operation_id !== channel.owner.operation_id ||
          ack.owner.generation !== channel.owner.generation || !sameEffectScope(ack.owner.scope, channel.owner.scope)) throw new Error("Mismatched resident retirement");
        this.data.counters.applied_sequence = Math.max(this.data.counters.applied_sequence, ack.last_applied_sequence);
        this.data.counters.ordered_edge_prefix = Math.max(this.data.counters.ordered_edge_prefix, ack.ordered_edge_prefix);
        this.data.cleanup.native = "retired";
      };
      try {
        accept(await this.channel.revoke());
      } catch (error) {
        nativeKnown = false; this.data.cleanup.native = "unknown"; this.data.reason ??= message(error);
        if (error instanceof ResidentCleanupError) {
          combinedCleanupKnown = false;
          if (error.retirement)
            try { accept(error.retirement); nativeKnown = true; } catch { /* A mismatched acknowledgment remains unknown. */ }
        }
      }
    } else if (nativeKnown) this.data.cleanup.native = "retired";
    const workerKnown = await guardedWorker && combinedCleanupKnown;
    if (!workerKnown) this.data.cleanup.worker = "unknown";
    this.data.status = nativeKnown && workerKnown ? this.finalStatus : "unknown";
    this.refreshNative(); this.notify(true, true);
  }

  private finish(status: ResidentSnapshot["status"], reason: string): void {
    if (!this.fenced) this.finalStatus = status;
    void this.stop(reason);
  }

  private active(): boolean { return !this.fenced && this.options.current() && this.clock.now() < this.options.deadline_host_ms; }

  private trace(stage: ResidentTraceStage): void {
    const sequence = ++this.traceSequence;
    try {
      const owner = this.channel!.owner;
      this.options.trace!({ ...stage, execution_id: this.options.execution_id, source_hash: this.options.source_hash,
        controller_generation: this.options.controller_generation, host_clock_id: this.clock.id,
        host_monotonic_ms: this.clock.now(), native_boot_id: owner.scope.native_boot_id,
        operation_id: owner.operation_id, owner_generation: owner.generation,
        trace_sequence: sequence, observer_errors: this.observerErrors });
    } catch { this.observerErrors++; }
  }

  private schedule(): void {
    if (!this.active()) { this.finish("stopped", "resident_not_current_or_expired"); return; }
    const period = 1000 / this.options.limits.frequency_hz;
    const next = Math.max(this.nextSlot, Math.ceil((this.clock.now() - this.anchor) / period));
    // Preserve an exact available boundary; skip only slots strictly before now.
    if (this.nextSlot > 0 && next > this.nextSlot) { this.data.counters.missed_slots += next - this.nextSlot; this.nextSlot = next; }
    const at = this.anchor + this.nextSlot * period;
    if (this.options.trace) this.trace({ stage: "schedule", slot: this.nextSlot, intended_host_ms: at, missed_slots: this.data.counters.missed_slots });
    this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, at - this.clock.now()));
  }

  private tick(): void {
    this.timer = null;
    if (!this.active()) { this.finish("stopped", "resident_not_current_or_expired"); return; }
    const period = 1000 / this.options.limits.frequency_hz;
    const scheduledSlot = this.nextSlot, at = this.anchor + scheduledSlot * period;
    const now = this.clock.now();
    if (now < at) {
      if (this.options.trace) this.trace({ stage: "wake", slot: scheduledSlot, scheduled_slot: scheduledSlot,
        intended_host_ms: at, missed_slots: this.data.counters.missed_slots });
      // Handling this notification can cross the deadline. Re-arm its original
      // slot directly; recomputing the next slot would discard already scheduled work.
      if (this.options.trace) this.trace({ stage: "schedule", slot: scheduledSlot,
        intended_host_ms: at, missed_slots: this.data.counters.missed_slots });
      this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, at - this.clock.now()));
      return;
    }
    const slot = Math.max(this.nextSlot, Math.floor((now - this.anchor) / period));
    this.data.counters.missed_slots += slot - this.nextSlot; this.nextSlot = slot + 1;
    if (this.options.trace) this.trace({ stage: "wake", slot, scheduled_slot: scheduledSlot,
      intended_host_ms: at, missed_slots: this.data.counters.missed_slots });
    if (this.flight) throw new Error("Resident scheduler overlapped a step");
    const flight = this.process(slot); this.flight = flight;
    void flight.catch(error => this.finish("failed", `resident_step: ${message(error)}`)).finally(() => {
      this.flight = null; if (!this.fenced) { this.notify(false, false); this.schedule(); }
    });
  }

  private async process(slot: number): Promise<void> {
    const channel = this.channel!;
    if (channel.snapshot().fenced) { this.finish("stopped", channel.snapshot().reason ?? "native_admission_fenced"); return; }
    const limits = this.options.limits;
    if (this.data.counters.steps >= limits.max_steps || this.data.counters.frames >= limits.max_frames) { this.finish("stopped", "resident_frame_budget"); return; }
    let wire: Json;
    if (this.options.trace) this.trace({ stage: "sample_request", slot });
    try {
      wire = await channel.sample(this.cursor);
      if (this.options.trace) this.trace({ stage: "sample_receipt", slot, outcome: "received" });
    }
    catch {
      if (this.options.trace) this.trace({ stage: "sample_receipt", slot, outcome: "error" });
      this.data.counters.read_failures++;
      if (!this.active()) this.finish("stopped", "resident_not_current_or_expired");
      return;
    }
    if (!this.active()) { this.finish("stopped", "resident_not_current_or_expired"); return; }
    const parsed = minecraftControllerFrameSchema.safeParse(wire);
    if (!parsed.success) { this.data.counters.read_failures++; return; }
    this.data.counters.frames++;
    const frame = parsed.data;
    if (frame.life_id !== channel.owner.scope.life_id || frame.space.space_epoch !== channel.owner.scope.space_epoch) { this.finish("stopped", "resident_frame_scope_changed"); return; }
    const nativeNs = BigInt(frame.captured_native_ns);
    if (frame.frame_seq <= this.lastRead || (this.lastNativeTick !== null && frame.native_tick < this.lastNativeTick) ||
      (this.lastNativeNs !== null && nativeNs < this.lastNativeNs)) { this.data.counters.stale_frames++; return; }
    this.lastRead = frame.frame_seq; this.lastNativeTick = frame.native_tick; this.lastNativeNs = nativeNs; this.cursor = frame.audible.next_cursor;
    const version = this.data.intent_version, started = this.clock.now();
    this.data.counters.steps++;
    let timedOut = false;
    const timer = this.clock.setTimeout(() => { timedOut = true; this.finish("failed", "resident_step_response_deadline"); }, RESIDENT_STEP_RESPONSE_MS);
    let raw: unknown;
    if (this.options.trace) this.trace({ stage: "worker_start", slot, frame_seq: frame.frame_seq });
    try {
      raw = await this.options.worker.step(frame, structuredClone(this.data.state), structuredClone(this.intent), this.abort.signal);
      if (this.options.trace) this.trace({ stage: "worker_return", slot, frame_seq: frame.frame_seq, outcome: "returned" });
    }
    catch (error) {
      if (this.options.trace) this.trace({ stage: "worker_return", slot, frame_seq: frame.frame_seq, outcome: "error" });
      if (!this.active() || version !== this.data.intent_version) {
        this.data.counters.stale_results++;
        if (!this.fenced && !this.options.current()) this.finish("stopped", "resident_source_changed");
        return;
      }
      throw error;
    }
    finally { this.clock.clearTimeout(timer); this.stepTiming.add(Math.max(0, this.clock.now() - started)); }
    if (!this.fenced && this.clock.now() - started > RESIDENT_STEP_RESPONSE_MS) { timedOut = true; this.finish("failed", "resident_step_response_deadline"); }
    if (!this.active() || version !== this.data.intent_version || timedOut) {
      if (this.options.trace) this.trace({ stage: "result_validation", slot, frame_seq: frame.frame_seq, outcome: "discarded" });
      this.data.counters.stale_results++; if (!this.fenced && !this.options.current()) this.finish("stopped", "resident_source_changed"); return;
    }
    let result: ReturnType<typeof controllerStepResultSchema.parse>;
    let expanded: number;
    try {
      result = controllerStepResultSchema.parse(raw);
      const input = result.input;
      expanded = input.kind === "screen" ? input.operations.length : input.edges.reduce((sum, edge) => sum + (edge.kind === "button" ? edge.count : 1), 0);
      while (this.edges.length && this.edges[0]!.at <= this.clock.now() - 1000) this.edges.shift();
      if (expanded > limits.max_edges - this.data.counters.expanded_edges || expanded + this.edges.reduce((sum, entry) => sum + entry.count, 0) > limits.max_edges_per_second ||
          result.events.length > limits.max_events - this.data.counters.events) throw new Error("Resident cumulative edge/event budget exceeded");
      if (input.kind === "world") {
        const transitioned = { ...this.submittedHeld };
        for (const edge of input.edges) if (edge.kind === "button" && edge.button !== "inventory") transitioned[edge.button] = edge.phase === "press";
        if (!sameHeld(transitioned, input.held)) throw new Error("Invalid resident held transition");
      } else if (!sameHeld(this.submittedHeld, neutral)) throw new Error("Resident screen requires neutral world input");
    } catch (error) {
      if (this.options.trace) this.trace({ stage: "result_validation", slot, frame_seq: frame.frame_seq, outcome: "error" });
      throw error;
    }
    if (this.options.trace) this.trace({ stage: "result_validation", slot, frame_seq: frame.frame_seq, outcome: "accepted" });
    const input = result.input;
    if (result.status === "running") {
      if (this.options.trace) this.trace({ stage: "renewal_start", slot, frame_seq: frame.frame_seq });
      try {
        await channel.renew(wire);
        if (this.options.trace) this.trace({ stage: "renewal_end", slot, frame_seq: frame.frame_seq, outcome: "returned" });
      } catch (error) {
        if (this.options.trace) this.trace({ stage: "renewal_end", slot, frame_seq: frame.frame_seq, outcome: "error" });
        throw error;
      }
      if (!this.active() || version !== this.data.intent_version) { this.data.counters.stale_results++; if (!this.fenced && !this.options.current()) this.finish("stopped", "resident_source_changed"); return; }
    }
    this.data.state = structuredClone(result.next_state); this.data.processed_frame_seq = frame.frame_seq;
    this.data.processed_native_tick = frame.native_tick; this.data.processed_native_ns = frame.captured_native_ns;
    this.data.counters.expanded_edges += expanded;
    if (expanded) this.edges.push({ at: this.clock.now(), count: expanded });
    for (const event of result.events) {
      this.data.counters.events++;
      this.data.events.push({ sequence: this.data.counters.events, host_monotonic_ms: this.clock.now(), event: structuredClone(event) });
      if (this.data.events.length > 128) this.data.events.shift();
      this.options.event(structuredClone(event));
    }
    if (result.status !== "running") { this.finish(result.status, `resident_${result.status}`); return; }
    const noInput = input.kind === "screen" ? input.operations.length === 0 && !this.runningViewRate : input.edges.length === 0 && input.selected_hotbar === null &&
      input.view.kind === "unchanged" && !this.runningViewRate && sameHeld(input.held, neutral) && sameHeld(this.submittedHeld, neutral);
    if (noInput) { this.data.counters.no_input_decisions++; return; }
    this.pruneCaptures();
    if (this.submitted.size >= 512) throw new Error("Resident attribution capacity exhausted");
    let submission: ReturnType<ControllerInputChannel["submit"]>;
    try { submission = channel.submit(wire, input); }
    catch (error) {
      if (this.options.trace) this.trace({ stage: "submission_dispatch", slot, frame_seq: frame.frame_seq, sequence: null, outcome: "error" });
      throw error;
    }
    if (this.options.trace) this.trace({ stage: "submission_dispatch", slot, frame_seq: frame.frame_seq,
      sequence: submission.sequence, outcome: submission.status });
    if (submission.status === "rejected") throw new Error(`Resident native submission rejected: ${submission.reason}`);
    if (submission.status === "coalesced") {
      const previous = this.submitted.get(submission.sequence - 1);
      if (previous?.input.kind === "world" && !previous.age_recorded) this.submitted.delete(submission.sequence - 1);
    }
    this.data.counters.submissions++;
    this.submitted.set(submission.sequence, { input: structuredClone(input), native_ns: frame.captured_native_ns, age_recorded: false, effect_recorded: false });
    if (input.kind === "world") { this.submittedHeld = { ...input.held }; this.runningViewRate = input.view.kind === "rate"; }
    else this.runningViewRate = false;
    this.refreshNative();
  }

  private applied(raw: InputAppliedAck): void {
    const parsed = inputAppliedAckSchema.safeParse(raw);
    if (!parsed.success || parsed.data.controller_generation !== this.options.controller_generation) return;
    const ack = parsed.data, capture = this.submitted.get(ack.sequence);
    if (!capture || ack.sequence < this.data.counters.applied_sequence || ack.ordered_edge_prefix < this.data.counters.ordered_edge_prefix) return;
    this.data.last_input = structuredClone(ack);
    this.data.counters.applied_sequence = ack.sequence; this.data.counters.ordered_edge_prefix = ack.ordered_edge_prefix;
    if (!capture.age_recorded && ack.input_application === "confirmed") {
      const age = BigInt(ack.applied_native_ns) - BigInt(capture.native_ns);
      if (age >= 0n) { this.ageTiming.add(Number(age) / 1e6); capture.age_recorded = true; }
    }
    this.pruneCaptures(); this.notify(false, false);
  }

  private effect(raw: ControllerEffectUpdate): void {
    const parsed = controllerEffectUpdateSchema.safeParse(raw);
    if (!parsed.success || parsed.data.controller_generation !== this.options.controller_generation) return;
    const event = parsed.data, capture = this.submitted.get(event.sequence);
    // Retirement receipts are deliberately accepted after fence; they cannot renew or submit.
    if (!capture || capture.effect_recorded) return;
    capture.effect_recorded = true; this.options.effect(structuredClone(capture.input), structuredClone(event));
    this.pruneCaptures(); this.notify(false, false);
  }

  private pruneCaptures(): void {
    for (const [sequence, capture] of this.submitted) if (sequence < this.data.counters.applied_sequence &&
      (capture.input.kind === "world" || capture.effect_recorded)) this.submitted.delete(sequence);
  }

  private refreshNative(): void {
    if (!this.channel) return;
    const native = this.channel.snapshot();
    this.data.pending.frames = native.pending_frames; this.data.pending.edges = native.pending_edges;
    // Native retirement may retain confirmed prefix progress without an ordinary pose ACK.
    this.data.counters.applied_sequence = Math.max(this.data.counters.applied_sequence, native.applied_sequence);
    this.data.counters.ordered_edge_prefix = Math.max(this.data.counters.ordered_edge_prefix, native.ordered_edge_prefix);
  }

  private notify(force: boolean, terminal: boolean): void {
    if (!force && this.clock.now() - this.lastChanged < 1000) return;
    this.lastChanged = this.clock.now(); this.options.changed(this.snapshot(), terminal);
  }
}
