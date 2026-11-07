import { z } from "zod";
import type { Json } from "../shared/contracts.ts";
import { expectedEffectOwnerSchema, safeCounterSchema, sameEffectScope, type ExpectedEffectOwner } from "../shared/control.ts";
import { controllerEffectUpdateSchema, inputAppliedAckSchema, nativeNanosecondsSchema, revocationAckSchema,
  type ControllerEffectUpdate, type ControllerInput, type ControllerInputChannel, type InputAppliedAck,
  type InputSubmission, type RevocationAck } from "../shared/controller.ts";
import { minecraftControllerFrameRequestSchema, minecraftControllerFrameSchema, type MinecraftControllerFrame } from "../shared/minecraft.ts";
import { ControllerInputs } from "./controller-inputs.ts";
import type { NativeClockCorrespondence } from "./performance.ts";

export interface ControllerChannelTransport {
  request(method: string, params: unknown, timeout: number): Promise<unknown>;
  sample(params: unknown): Promise<MinecraftControllerFrame>;
  clock(): NativeClockCorrespondence | null;
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
  private readonly inputs: ControllerInputs;
  private readonly captures = new Map<number, { tick: number; nanos: string }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private retirement: Promise<RevocationAck> | null = null;
  private lastEffectSequence = 0;
  private failureReason: string | null = null;

  constructor(owner: ExpectedEffectOwner, readonly controllerGeneration: number, private readonly deadlineHostMs: number,
    private readonly transport: ControllerChannelTransport, private readonly applied: (ack: InputAppliedAck) => void,
    private readonly effect: (update: ControllerEffectUpdate) => void) {
    this.expectedOwner = expectedEffectOwnerSchema.parse(owner);
    this.inputs = new ControllerInputs(this.expectedOwner, controllerGeneration);
  }
  get owner(): ExpectedEffectOwner { return structuredClone(this.expectedOwner); }
  snapshot() {
    const snapshot = this.inputs.snapshot();
    return this.failureReason === null ? snapshot : { ...snapshot, reason: this.failureReason };
  }
  private identity() { return { owner: this.expectedOwner, controller_generation: this.controllerGeneration }; }
  private decisionDiagnostic(stage: string, frame: MinecraftControllerFrame | null, now: number, nativeUpper: string | null): string {
    return `${stage} operation_id=${this.expectedOwner.operation_id} owner_generation=${this.expectedOwner.generation}` +
      ` controller_generation=${this.controllerGeneration} native_boot_id=${this.expectedOwner.scope.native_boot_id} host_monotonic_ms=${now}` +
      (frame === null ? "" : ` frame_seq=${frame.frame_seq} native_tick=${frame.native_tick} captured_native_ns=${frame.captured_native_ns}`) +
      (nativeUpper === null ? "" : ` native_now_upper_ns=${nativeUpper}` +
        (frame === null ? "" : ` native_age_upper_ns=${BigInt(nativeUpper) - BigInt(frame.captured_native_ns)}`));
  }
  private failed(reason: string): void {
    const retainedReason = this.inputs.snapshot().reason;
    this.failureReason ??= retainedReason !== null && retainedReason !== "admission_revoked" ? retainedReason : reason;
    this.inputs.revoke();
    void this.revoke().catch(() => {});
  }
  private current(): void {
    // A self-retired channel keeps the actual first failure, even after the
    // transport detaches this owner and can report only "owner has retired".
    if (this.failureReason !== null) throw new Error(this.failureReason);
    this.transport.assertCurrent();
    if (this.retirement || this.inputs.snapshot().fenced || performance.now() >= this.deadlineHostMs)
      throw new Error("Controller ordinary admission is fenced or expired.");
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
      const frame = await this.transport.sample({ ...this.identity(), ...audio });
      this.current();
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
    try {
      this.current();
      const parsed = this.capture(frame);
      const now = performance.now(), nativeUpper = nativeNowUpper(this.transport.clock(), now);
      submission = this.inputs.submit({ context: { ...this.identity(), source_hash: this.expectedOwner.scope.source_hash,
        frame_seq: parsed.frame_seq, observed_native_tick: parsed.native_tick, captured_native_ns: parsed.captured_native_ns }, input },
      nativeUpper);
      if (submission.status === "rejected")
        submission = { ...submission, reason: `${submission.reason}; ${this.decisionDiagnostic("controller_submit_admission", parsed, now, nativeUpper)} input_kind=${input.kind}` };
    } catch (error) {
      this.inputs.revoke();
      submission = { sequence: this.inputs.snapshot().submitted_sequence, status: "rejected",
        reason: error instanceof Error ? error.message : "Controller submission rejected" };
    }
    if (submission.status === "rejected") {
      if (this.inputs.snapshot().fenced) this.failed(submission.reason ?? "Controller submission rejected");
      return submission;
    }
    // Drain on a microtask so successive still-unsent compatible held snapshots may coalesce.
    queueMicrotask(() => this.drain());
    return submission;
  }
  private drain(): void {
    for (;;) {
      const remainingTaskMs = this.deadlineHostMs - performance.now();
      if (remainingTaskMs <= 0) {
        this.inputs.revoke();
        void this.revoke().catch(() => {});
        return;
      }
      const next = this.inputs.take();
      if (next === null) break;
      const applicationMs = next.frame.input.kind === "screen" ? 5000 + 4000 * next.frame.input.operations.length : 2000;
      const dispatched = performance.now();
      const work = this.transport.request("controller_submit", next, Math.max(1, Math.min(applicationMs, remainingTaskMs))).then(raw => {
        const ack = inputAppliedAckSchema.parse(raw);
        if (!this.inputs.acceptAck(ack)) throw new Error("Controller application ACK is duplicate, stale or invalid.");
        // Retain the native cause before callbacks or queued failures can replace it with a retirement symptom.
        if (ack.input_application !== "confirmed")
          this.failureReason ??= ack.reason ?? `input_application_${ack.input_application}`;
        this.applied(ack);
        if (this.inputs.snapshot().fenced) void this.revoke().catch(() => {});
      }).catch(error => {
        const context = next.frame.context;
        this.failed(`${error instanceof Error ? error.message : String(error)}; controller_submit` +
          ` operation_id=${this.expectedOwner.operation_id} owner_generation=${this.expectedOwner.generation}` +
          ` controller_generation=${this.controllerGeneration} native_boot_id=${this.expectedOwner.scope.native_boot_id}` +
          ` sequence=${next.sequence} input_kind=${next.frame.input.kind} frame_seq=${context.frame_seq}` +
          ` native_tick=${context.observed_native_tick} captured_native_ns=${context.captured_native_ns}` +
          ` host_dispatch_ms=${dispatched} response_elapsed_ms=${Math.max(0, performance.now() - dispatched)}`);
      });
      this.track(work);
    }
  }
  async renew(frame: Json | null): Promise<void> {
    this.current();
    const captured = frame === null ? null : this.capture(frame);
    const now = performance.now(), deadline = Math.min(this.deadlineHostMs, now + 250);
    let nativeUpper: string | null = null;
    if (captured !== null) {
      nativeUpper = nativeNowUpper(this.transport.clock(), now);
      const age = BigInt(nativeUpper) - BigInt(captured.captured_native_ns);
      if (age < 0n || age > 150000000n)
        throw new Error(`A stale decision cannot renew the native input lease; ${this.decisionDiagnostic("controller_heartbeat_admission", captured, now, nativeUpper)}`);
    }
    const work = this.transport.request("controller_heartbeat", { ...this.identity(),
      deadline_native_ns: controllerNativeDeadline(this.transport.clock(), deadline, now) }, 1000).then(() => {
      this.transport.assertCurrent();
    }).catch(error => {
      const reason = `${error instanceof Error ? error.message : String(error)}; ${this.decisionDiagnostic("controller_heartbeat", captured, now, nativeUpper)}` +
        ` response_elapsed_ms=${Math.max(0, performance.now() - now)}`;
      this.failed(reason);
      throw new Error(reason);
    });
    await this.track(work);
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
        this.transport.retired(result.ack, result.generation);
        done.resolve(result.ack);
      } catch (error) {
        await this.transport.failed();
        done.reject(error instanceof Error ? error : new Error("Controller retirement remains unknown."));
      }
    })();
    return done.promise;
  }
}
