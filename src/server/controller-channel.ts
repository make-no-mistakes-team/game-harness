import { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import { expectedEffectOwnerSchema, safeCounterSchema, sameEffectScope, type ExpectedEffectOwner } from "../shared/control.ts";
import { controllerEffectUpdateSchema, inputAppliedAckSchema, nativeNanosecondsSchema, revocationAckSchema,
  type ControllerChannelFault, type ControllerEffectUpdate, type ControllerInput, type ControllerInputChannel, type InputAppliedAck,
  type InputSubmission, type RevocationAck } from "../shared/controller.ts";
import { minecraftControllerFrameRequestSchema, minecraftControllerFrameSchema, type MinecraftControllerFrame } from "../shared/minecraft.ts";
import { ControllerInputs } from "./controller-inputs.ts";
import type { NativeClockCorrespondence, NativeControlTiming } from "./performance.ts";

export type NativeRequestStatus = "not_dispatched" | "native_rejected" | "write_failed" |
  "request_timeout" | "transport_closed" | "protocol_invalid";
/** Constructed only at the trusted transport boundary, never from serialized source errors. */
export class NativeRequestFault extends Error {
  constructor(readonly status: NativeRequestStatus, readonly method: string, readonly requestId: number | null,
    readonly dispatch: "not_dispatched" | "dispatched", detail: string,
    readonly nativeTiming: NativeControlTiming | null = null, readonly initiatingRequestId: number | null = requestId,
    readonly initiatingMethod: string | null = method) {
    super(detail.slice(0, 1000));
    this.name = "NativeRequestFault";
  }
}
export class ControllerChannelFaultError extends Error {
  constructor(readonly fault: ControllerChannelFault | null, detail: string) {
    super(detail);
    this.name = "ControllerChannelFaultError";
  }
}
/** Trusted read-only screen mismatch after the other owner/scope checks passed. */
export class ControllerScreenReadSupersededError extends Error {
  constructor() {
    super("Controller feedback has stale or unavailable screen authority.");
    this.name = "ControllerScreenReadSupersededError";
  }
}

export interface ControllerChannelTransport {
  /** Dispatches in call order, before returning; native heartbeat and submit share an ordered receiver. */
  request(method: string, params: unknown, timeout: number): Promise<unknown>;
  sample(params: unknown): Promise<MinecraftControllerFrame>;
  clock(): NativeClockCorrespondence | null;
  /** Read only on a faulted retirement; success replies keep their ordinary shape. */
  retirementTiming?(): NativeControlTiming | null;
  /** Consulted only for a failed application response with exact native sequence evidence. */
  applicationEvidence?(sequence: number): { request_id: number; timing: NativeControlTiming } | null;
  assertCurrent(): void;
  retired(ack: RevocationAck, generation: number): void;
  failed(): Promise<void>;
}

function correlation(value: NativeClockCorrespondence | null, now: number): NativeClockCorrespondence {
  if (!value || !Number.isFinite(now) || now < value.host_received_ms || now - value.host_received_ms > 10000 ||
    !Number.isFinite(value.uncertainty_ms) || value.uncertainty_ms < 0 || value.uncertainty_ms > 150)
    throw new Error("Controller native-clock correspondence is unavailable or too uncertain.");
  return value;
}
function roundingNs(mapping: NativeClockCorrespondence, host: number): number {
  return Math.ceil(4 * Number.EPSILON * Math.max(1, Math.abs(host), Math.abs(mapping.host_sent_ms), Math.abs(mapping.host_received_ms)) * 1e6) + 1;
}
/** Exact native anchor plus local host-clock interval; never round the arbitrary native origin into Number. */
export function controllerNativeDeadline(value: NativeClockCorrespondence | null, deadline: number, now = performance.now()): string {
  const mapping = correlation(value, now), delta = Math.floor((deadline - mapping.host_received_ms) * 1e6) - roundingNs(mapping, deadline);
  if (!Number.isSafeInteger(delta) || deadline <= now) throw new Error("Controller deadline is not finite future authority.");
  return nativeNanosecondsSchema.parse(String(BigInt(mapping.native_replied_ns) + BigInt(delta)));
}
function nativeNowUpper(value: NativeClockCorrespondence | null, now: number): string {
  const mapping = correlation(value, now), delta = Math.ceil((now - mapping.host_sent_ms) * 1e6) + roundingNs(mapping, now);
  if (!Number.isSafeInteger(delta)) throw new Error("Controller native age cannot be bounded.");
  return nativeNanosecondsSchema.parse(String(BigInt(mapping.native_received_ns) + BigInt(delta)));
}
const retirementResponseSchema = z.object({ ack: revocationAckSchema, generation: safeCounterSchema.min(1) }).strict();

/** One admitted owner; admission, actual application and physical retirement remain distinct. */
export class NativeControllerChannel implements ControllerInputChannel {
  private readonly expectedOwner: ExpectedEffectOwner;
  private readonly deadlineNativeNs: bigint;
  private readonly inputs: ControllerInputs;
  private readonly captures = new Map<number, { tick: number; nanos: string }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly heartbeats = new Set<Promise<void>>();
  private latestHeartbeat: { work: Promise<void>; deadlineHostMs: number } | null = null;
  private retirement: Promise<RevocationAck> | null = null;
  private lastEffectSequence = 0;
  private failureReason: string | null = null;
  private firstFault: ControllerChannelFault | null = null;
  private admissionFault: ControllerChannelFault | null = null;

  constructor(owner: ExpectedEffectOwner, readonly controllerGeneration: number, private readonly deadlineHostMs: number,
    acceptedDeadlineNativeNs: string, private readonly transport: ControllerChannelTransport, private readonly applied: (ack: InputAppliedAck) => void,
    private readonly effect: (update: ControllerEffectUpdate) => void) {
    this.expectedOwner = expectedEffectOwnerSchema.parse(owner);
    this.deadlineNativeNs = BigInt(nativeNanosecondsSchema.parse(acceptedDeadlineNativeNs));
    this.inputs = new ControllerInputs(this.expectedOwner, controllerGeneration);
  }
  get owner(): ExpectedEffectOwner { return structuredClone(this.expectedOwner); }
  snapshot() {
    const snapshot = this.inputs.snapshot();
    return { ...snapshot, reason: this.failureReason ?? snapshot.reason,
      fault: this.firstFault === null ? this.admissionFault === null ? null : structuredClone(this.admissionFault) : structuredClone(this.firstFault) };
  }
  private identity() { return { owner: this.expectedOwner, controller_generation: this.controllerGeneration }; }
  private decisionDiagnostic(stage: string, frame: MinecraftControllerFrame | null, now: number, nativeUpper: string | null): string {
    return `${stage} operation_id=${this.expectedOwner.operation_id} owner_generation=${this.expectedOwner.generation}` +
      ` controller_generation=${this.controllerGeneration} native_boot_id=${this.expectedOwner.scope.native_boot_id} host_monotonic_ms=${now}` +
      (frame === null ? "" : ` frame_seq=${frame.frame_seq} native_tick=${frame.native_tick} captured_native_ns=${frame.captured_native_ns}`) +
      (nativeUpper === null ? "" : ` native_now_upper_ns=${nativeUpper}` +
        (frame === null ? "" : ` native_age_upper_ns=${BigInt(nativeUpper) - BigInt(frame.captured_native_ns)}`));
  }
  private fault(stage: ControllerChannelFault["stage"], cause: ControllerChannelFault["cause"], detail: string,
    frame: { frame_seq: number; captured_native_ns: string } | null = null, sequence: number | null = null,
    error: unknown = null, dispatch: ControllerChannelFault["decision_dispatch"] = "not_dispatched"): ControllerChannelFault {
    const native = error instanceof NativeRequestFault ? error : null;
    const evidence = native === null && sequence !== null ? this.transport.applicationEvidence?.(sequence) ?? null : null;
    const fence = this.nativeFence(native?.nativeTiming ?? evidence?.timing ?? null);
    if (native) {
      cause = native.status;
      dispatch = native.dispatch;
      if (native.status === "native_rejected" && fence?.reason === "native_input_lease_expired") cause = "native_lease_expired";
      if (native.status === "native_rejected" && fence?.reason === "queued_frame_expired_before_application") cause = "native_frame_expired";
    }
    return { schema_version: 1, stage, cause, decision_dispatch: dispatch, owner: structuredClone(this.expectedOwner),
      controller_generation: this.controllerGeneration, sequence, frame_seq: frame?.frame_seq ?? null,
      captured_native_ns: frame?.captured_native_ns ?? null, request_id: native?.requestId ?? evidence?.request_id ?? null,
      request_method: native?.method ?? (evidence ? "controller_submit" : null), initiating_request_id: native?.initiatingRequestId ?? null,
      initiating_method: native?.initiatingMethod ?? null, host_detected_ms: performance.now(),
      original_deadline_host_ms: this.deadlineHostMs, native_first_fence: fence, detail: detail.slice(0, 2000) };
  }
  private nativeFence(timing: NativeControlTiming | null): ControllerChannelFault["native_first_fence"] {
    const lease = timing?.controller_lease;
    if (timing?.clock_id !== this.expectedOwner.scope.native_boot_id || !lease ||
      lease.owner.operation_id !== this.expectedOwner.operation_id || lease.owner.generation !== this.expectedOwner.generation ||
      !sameEffectScope(lease.owner.scope, this.expectedOwner.scope) || lease.controller_generation !== this.controllerGeneration ||
      lease.first_fence_reason === null || lease.first_fence_native_ns === null) return null;
    return { reason: lease.first_fence_reason, native_ns: lease.first_fence_native_ns,
      checked_native_ns: lease.checked_native_ns, effective_deadline_native_ns: lease.effective_deadline_native_ns };
  }
  private failed(reason: string, fault: ControllerChannelFault): void {
    this.firstFault ??= fault;
    const retainedReason = this.inputs.snapshot().reason;
    this.failureReason ??= retainedReason !== null && retainedReason !== "admission_revoked" ? retainedReason : reason;
    this.inputs.revoke();
    void this.revoke().catch(() => {});
  }
  private current(): void {
    // A self-retired channel keeps the actual first failure, even after the
    // transport detaches this owner and can report only "owner has retired".
    if (this.failureReason !== null) throw new ControllerChannelFaultError(this.firstFault, this.failureReason);
    try { this.transport.assertCurrent(); } catch (error) {
      const detail = error instanceof Error ? error.message : "Controller scope changed";
      this.firstFault ??= this.fault("scope", "scope_changed", detail, null, null, error, "not_applicable");
      throw new ControllerChannelFaultError(this.firstFault, detail);
    }
    if (this.retirement || this.inputs.snapshot().fenced || performance.now() >= this.deadlineHostMs) {
      const detail = "Controller ordinary admission is fenced or expired.";
      if (performance.now() >= this.deadlineHostMs)
        this.firstFault ??= this.fault("task_deadline", "task_deadline", detail, null, null, null, "not_applicable");
      throw new ControllerChannelFaultError(this.firstFault ??
        this.fault("retirement", "admission_revoked", detail, null, null, null, "not_applicable"), detail);
    }
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.inflight.add(operation);
    void operation.then(() => this.inflight.delete(operation), () => this.inflight.delete(operation));
    return operation;
  }
  async sample(audioCursor: Json): Promise<Json> {
    this.current();
    const audio = minecraftControllerFrameRequestSchema.parse({ audio_cursor: audioCursor });
    const work = (async () => {
      let frame: MinecraftControllerFrame;
      try { frame = await this.transport.sample({ ...this.identity(), ...audio }); } catch (error) {
        if (error instanceof ControllerScreenReadSupersededError) {
          this.current();
          throw error;
        }
        const detail = error instanceof Error ? error.message : "Controller sample failed";
        // A rejected read did not previously fence actuator admission. Preserve
        // that policy while carrying its trusted evidence to the session.
        const fault = this.firstFault ?? this.fault("sample", "transport_unknown", detail, null, null, error, "unknown");
        if (this.firstFault === null) this.admissionFault = fault;
        throw new ControllerChannelFaultError(fault, detail);
      }
      this.current();
      if (this.admissionFault?.stage === "sample") this.admissionFault = null;
      if (this.captures.size === 16) this.captures.delete(this.captures.keys().next().value!);
      this.captures.set(frame.frame_seq, { tick: frame.native_tick, nanos: frame.captured_native_ns });
      return frame;
    })();
    return await this.track(work);
  }
  private capture(frame: Json): MinecraftControllerFrame {
    const parsed = minecraftControllerFrameSchema.parse(frame), captured = this.captures.get(parsed.frame_seq);
    if (!captured || captured.tick !== parsed.native_tick || captured.nanos !== parsed.captured_native_ns ||
      parsed.life_id !== this.expectedOwner.scope.life_id || parsed.space.space_epoch !== this.expectedOwner.scope.space_epoch)
      throw new Error("Controller decision must name its actual host-retained native capture.");
    return parsed;
  }
  submit(frame: Json, input: ControllerInput): InputSubmission {
    let submission: InputSubmission;
    let parsed: MinecraftControllerFrame | null = null;
    let stage: ControllerChannelFault["stage"] = "capture_identity";
    try {
      this.current();
      parsed = this.capture(frame);
      stage = "clock_bound";
      const now = performance.now(), nativeUpper = nativeNowUpper(this.transport.clock(), now);
      stage = "submit_admission";
      const admitted = this.inputs.submit({ context: { ...this.identity(), source_hash: this.expectedOwner.scope.source_hash,
        frame_seq: parsed.frame_seq, observed_native_tick: parsed.native_tick, captured_native_ns: parsed.captured_native_ns }, input },
      nativeUpper);
      submission = admitted;
      if (submission.status === "rejected") {
        this.admissionFault = this.fault(stage, admitted.reason ?? "invalid_input", submission.reason ?? "Controller admission rejected", parsed);
        submission = { ...submission, reason: `${submission.reason}; ${this.decisionDiagnostic("controller_submit_admission", parsed, now, nativeUpper)} input_kind=${input.kind}` };
      }
    } catch (error) {
      this.firstFault ??= error instanceof ControllerChannelFaultError ? error.fault :
        this.fault(stage, stage === "capture_identity" ? "unretained_capture" : "unusable_native_clock",
          error instanceof Error ? error.message : "Controller submission rejected", parsed);
      this.inputs.revoke();
      submission = { sequence: this.inputs.snapshot().submitted_sequence, status: "rejected",
        reason: error instanceof Error ? error.message : "Controller submission rejected" };
    }
    if (submission.status === "rejected") {
      if (this.inputs.snapshot().fenced) this.failed(submission.reason ?? "Controller submission rejected",
        this.firstFault ?? this.admissionFault ?? this.fault("submit_admission", "invalid_input", submission.reason ?? "Rejected"));
      return submission;
    }
    this.admissionFault = null;
    // Drain on a microtask so successive still-unsent compatible held snapshots may coalesce.
    queueMicrotask(() => this.drain());
    return submission;
  }
  private drain(): void {
    for (;;) {
      const remainingTaskMs = this.deadlineHostMs - performance.now();
      if (remainingTaskMs <= 0) {
        this.firstFault ??= this.fault("task_deadline", "task_deadline", "Original controller deadline expired", null, null, null, "not_applicable");
        this.inputs.revoke();
        void this.revoke().catch(() => {});
        return;
      }
      const next = this.inputs.take();
      if (next === null) break;
      const applicationMs = next.frame.input.kind === "screen" ? 5000 + 4000 * next.frame.input.operations.length : 2000;
      const dispatched = performance.now();
      let stage: ControllerChannelFault["stage"] = "submit_response";
      let cause: ControllerChannelFault["cause"] = "transport_unknown";
      const work = this.transport.request("controller_submit", next, Math.max(1, Math.min(applicationMs, remainingTaskMs))).then(raw => {
        stage = "ack_schema"; cause = "invalid_ack";
        const parsed = inputAppliedAckSchema.safeParse(raw);
        if (!parsed.success) {
          this.firstFault ??= this.fault(stage, cause, "Controller application ACK failed schema validation",
            next.frame.context, next.sequence, null, "dispatched");
          throw new ControllerChannelFaultError(this.firstFault, "Controller application ACK failed schema validation");
        }
        const ack = parsed.data;
        stage = "ack_relation";
        const admission = this.inputs.acceptAck(ack);
        if (admission !== "accepted") {
          cause = admission;
          this.firstFault ??= this.fault(stage, cause, `Controller application ACK rejected: ${admission}`,
            next.frame.context, next.sequence, null, "dispatched");
          throw new ControllerChannelFaultError(this.firstFault, `Controller application ACK rejected: ${admission}`);
        }
        // Retain the native cause before callbacks or queued failures can replace it with a retirement symptom.
        if (ack.input_application !== "confirmed") {
          this.failureReason ??= ack.reason ?? `input_application_${ack.input_application}`;
          this.firstFault ??= this.fault("application", `application_${ack.input_application}`, this.failureReason,
            next.frame.context, next.sequence, null, "dispatched");
        }
        stage = "applied_callback"; cause = "applied_callback_failed";
        try { this.applied(ack); } catch (error) {
          this.firstFault ??= this.fault(stage, cause, error instanceof Error ? error.message : "Applied callback failed",
            next.frame.context, next.sequence, null, "dispatched");
          throw error;
        }
        if (this.inputs.snapshot().fenced) void this.revoke().catch(() => {});
      }).catch(error => {
        const context = next.frame.context;
        const reason = `${error instanceof Error ? error.message : String(error)}; controller_submit` +
          ` operation_id=${this.expectedOwner.operation_id} owner_generation=${this.expectedOwner.generation}` +
          ` controller_generation=${this.controllerGeneration} native_boot_id=${this.expectedOwner.scope.native_boot_id}` +
          ` sequence=${next.sequence} input_kind=${next.frame.input.kind} frame_seq=${context.frame_seq}` +
          ` native_tick=${context.observed_native_tick} captured_native_ns=${context.captured_native_ns}` +
          ` host_dispatch_ms=${dispatched} response_elapsed_ms=${Math.max(0, performance.now() - dispatched)}`;
        this.failed(reason, this.fault(error instanceof NativeRequestFault && error.dispatch === "not_dispatched" ? "submit_dispatch" : stage,
          cause, reason, context, next.sequence, error, stage === "submit_response" ? "unknown" : "dispatched"));
      });
      this.track(work);
    }
  }
  async renew(frame: Json | null): Promise<void> {
    this.current();
    let captured: MinecraftControllerFrame | null = null;
    try { captured = frame === null ? null : this.capture(frame); } catch (error) {
      const detail = error instanceof Error ? error.message : "Unretained controller capture";
      this.admissionFault = this.fault("capture_identity", "unretained_capture", detail);
      throw new ControllerChannelFaultError(this.admissionFault, detail);
    }
    const now = performance.now(), deadline = Math.min(this.deadlineHostMs, now + 250);
    let nativeUpper: string | null = null;
    if (captured !== null) {
      try { nativeUpper = nativeNowUpper(this.transport.clock(), now); } catch (error) {
        const detail = error instanceof Error ? error.message : "Unusable native clock";
        this.admissionFault = this.fault("clock_bound", "unusable_native_clock", detail, captured);
        throw new ControllerChannelFaultError(this.admissionFault, detail);
      }
      const age = BigInt(nativeUpper) - BigInt(captured.captured_native_ns);
      if (age < 0n || age > 150000000n) {
        const detail = `A stale decision cannot renew the native input lease; ${this.decisionDiagnostic("controller_heartbeat_admission", captured, now, nativeUpper)}`;
        this.admissionFault = this.fault("heartbeat_admission", "stale_native_frame", detail, captured);
        throw new ControllerChannelFaultError(this.admissionFault, detail);
      }
    }
    if (this.latestHeartbeat !== null) {
      // Only a newer dispatch can extend local admission, never a delayed ACK.
      // The oldest response may still be pending after a lawful newer renewal.
      if (now >= this.latestHeartbeat.deadlineHostMs) {
        const reason = `Controller heartbeat admission is past its latest dispatched lease deadline; ` +
          this.decisionDiagnostic("controller_heartbeat_admission", captured, now, nativeUpper);
        this.failed(reason, this.fault("heartbeat_admission", "host_lease_expired", reason, captured));
        throw new ControllerChannelFaultError(this.firstFault, reason);
      }
      if (captured === null && this.heartbeats.has(this.latestHeartbeat.work)) {
        await this.latestHeartbeat.work;
        return;
      }
    }
    if (this.heartbeats.size >= 8) {
      const reason = `Controller heartbeat outstanding response bound reached; ` +
        this.decisionDiagnostic("controller_heartbeat_admission", captured, now, nativeUpper);
      this.failed(reason, this.fault("heartbeat_admission", "heartbeat_capacity", reason, captured));
      throw new ControllerChannelFaultError(this.firstFault, reason);
    }
    let nativeDeadline: string;
    try {
      const freshDeadline = BigInt(controllerNativeDeadline(this.transport.clock(), deadline, now));
      // Native's task grant is the exact accepted open deadline, not a host
      // deadline re-mapped through a later clock correspondence.
      nativeDeadline = String(freshDeadline < this.deadlineNativeNs ? freshDeadline : this.deadlineNativeNs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unusable native clock";
      this.admissionFault = this.fault("clock_bound", "unusable_native_clock", detail, captured);
      throw new ControllerChannelFaultError(this.admissionFault, detail);
    }
    this.admissionFault = null;
    const work = this.transport.request("controller_heartbeat", { ...this.identity(),
      deadline_native_ns: nativeDeadline }, 1000).then(() => {
      this.transport.assertCurrent();
    }).catch(error => {
      const reason = `${error instanceof Error ? error.message : String(error)}; ${this.decisionDiagnostic("controller_heartbeat", captured, now, nativeUpper)}` +
        ` response_elapsed_ms=${Math.max(0, performance.now() - now)}`;
      this.failed(reason, this.fault(error instanceof NativeRequestFault && error.dispatch === "not_dispatched" ? "heartbeat_dispatch" : "heartbeat_response",
        "transport_unknown", reason, captured, null, error, "unknown"));
      throw new ControllerChannelFaultError(this.firstFault, reason);
    });
    this.track(work);
    this.heartbeats.add(work);
    this.latestHeartbeat = { work, deadlineHostMs: deadline };
    const settled = () => { this.heartbeats.delete(work); };
    void work.then(settled, settled);
    // Decision admission is local, not a native heartbeat/application ACK.
    // request() already ordered this heartbeat ahead of the subsequent submit;
    // native receive validates its lease before it can admit that input. Keep
    // the response tracked for failure fencing and the exact retirement join.
    if (captured === null) await work;
  }
  acceptEffect(owner: ExpectedEffectOwner, value: ControllerEffectUpdate): void {
    if (owner.operation_id !== this.expectedOwner.operation_id || owner.generation !== this.expectedOwner.generation ||
      !sameEffectScope(owner.scope, this.expectedOwner.scope) || value.controller_generation !== this.controllerGeneration) return;
    const update = controllerEffectUpdateSchema.parse(value);
    if (update.sequence <= this.lastEffectSequence || update.sequence > this.inputs.snapshot().submitted_sequence) return;
    this.lastEffectSequence = update.sequence;
    this.effect(update);
  }
  contained(): void { this.inputs.revoke(); }
  revoke(): Promise<RevocationAck> {
    if (this.retirement) return this.retirement;
    this.inputs.revoke();
    const done = Promise.withResolvers<RevocationAck>();
    this.retirement = done.promise;
    void (async () => {
      try {
        const result = retirementResponseSchema.parse(await this.transport.request("controller_revoke", this.identity(), 5000));
        if (result.generation <= this.expectedOwner.generation || !this.inputs.acceptRevocation(result.ack))
          throw new Error("Controller retirement ACK is not actual current-owner retirement.");
        await Promise.allSettled([...this.inflight]);
        const fault = this.firstFault ?? this.admissionFault;
        if (fault && fault.native_first_fence === null) {
          fault.native_first_fence = this.nativeFence(this.transport.retirementTiming?.() ?? null);
        }
        this.transport.retired(result.ack, result.generation);
        done.resolve(result.ack);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Controller retirement remains unknown.";
        this.firstFault ??= this.fault("retirement", "retirement_unknown", detail, null, null, error, "unknown");
        try { await this.transport.failed(); } catch (cleanupError) {
          done.reject(new AggregateError([error, cleanupError], detail));
          return;
        }
        done.reject(error instanceof Error ? error : new Error("Controller retirement remains unknown."));
      }
    })();
    return done.promise;
  }
}
