import { expectedEffectOwnerSchema, safeCounterSchema, sameEffectScope,
  type ExpectedEffectOwner, type WorldHeld } from "../shared/control.ts";
import { controllerInputFrameSchema, inputAppliedAckSchema, nativeNanosecondsSchema, revocationAckSchema,
  type ControllerInputFrame, type InputAppliedAck, type InputSubmission, type RevocationAck } from "../shared/controller.ts";

type PendingFrame = {
  sequence: number;
  frame: ControllerInputFrame;
  ordered_edge_start: number;
  ordered_edge_end: number;
  sent: boolean;
};
type AppliedFrame = { sequence: number; ordered_edge_end: number; held: WorldHeld };
const heldKeys: (keyof WorldHeld)[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use"];
const neutralHeld: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
export type ControllerLedgerReason = "admission_revoked" | "invalid_input" | "stale_owner" |
  "nonincreasing_frame_sequence" | "unusable_native_clock" | "stale_native_frame" | "invalid_held_transition" |
  "screen_requires_neutral_world_input" | "input_capacity_exceeded" | "invalid_input_ack" |
  "ack_for_unsent_input" | "ack_overclaims_ordered_prefix" | "ack_held_mismatch" |
  "application_partial" | "application_unknown";
export type ControllerAckAdmission = "accepted" | "stale_or_duplicate" | "invalid_input_ack" |
  "ack_for_unsent_input" | "ack_overclaims_ordered_prefix" | "ack_held_mismatch";
type LedgerSubmission = InputSubmission & { reason: ControllerLedgerReason | null };

function sameHeld(a: WorldHeld, b: WorldHeld): boolean {
  return heldKeys.every(key => a[key] === b[key]);
}

/** Admission/application accounting only. The existing effect owner retains all I/O and retirement authority. */
export class ControllerInputs {
  private readonly owner: ExpectedEffectOwner;
  private readonly controllerGeneration: number;
  private submittedHeld: WorldHeld = neutralHeld;
  private frames: PendingFrame[] = [];
  private fenced = false;
  private retired = false;
  private reason: ControllerLedgerReason | null = null;
  private submittedSequence = 0;
  private acceptedFrameSequence = 0;
  private submittedEdges = 0;
  private orderedEdgePrefix = 0;
  private applied: AppliedFrame | null = null;
  private lastInput: InputAppliedAck | null = null;

  constructor(owner: ExpectedEffectOwner, controllerGeneration: number) {
    this.owner = expectedEffectOwnerSchema.parse(owner);
    this.controllerGeneration = safeCounterSchema.min(1).parse(controllerGeneration);
  }

  submit(frame: ControllerInputFrame, nativeNowNs: string): LedgerSubmission {
    if (this.fenced) return this.rejected(this.reason ?? "admission_revoked");
    const parsed = controllerInputFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.fence("invalid_input");
      return this.rejected("invalid_input");
    }
    const value = parsed.data, context = value.context;
    if (!this.matchesOwner(context.owner) || context.controller_generation !== this.controllerGeneration ||
      context.source_hash !== this.owner.scope.source_hash) return this.rejected("stale_owner");
    if (context.frame_seq <= this.acceptedFrameSequence) return this.rejected("nonincreasing_frame_sequence");
    const now = nativeNanosecondsSchema.safeParse(nativeNowNs);
    if (!now.success) return this.rejected("unusable_native_clock");
    const age = BigInt(now.data) - BigInt(context.captured_native_ns);
    if (age < 0n || age > 150000000n) return this.rejected("stale_native_frame");

    let expanded = 0;
    if (value.input.kind === "world") {
      const transitioned = { ...this.submittedHeld };
      for (const edge of value.input.edges) {
        expanded += edge.kind === "button" ? edge.count : 1;
        if (edge.kind === "button" && edge.button !== "inventory") transitioned[edge.button] = edge.phase === "press";
      }
      if (!sameHeld(transitioned, value.input.held)) {
        this.fence("invalid_held_transition");
        return this.rejected("invalid_held_transition");
      }
    } else {
      expanded = value.input.operations.length;
      if (heldKeys.some(key => this.submittedHeld[key])) {
        this.fence("screen_requires_neutral_world_input");
        return this.rejected("screen_requires_neutral_world_input");
      }
    }

    const previous = this.frames.at(-1);
    const coalesces = previous !== undefined && !previous.sent && previous.frame.input.kind === "world" &&
      value.input.kind === "world" && previous.frame.input.edges.length === 0 && value.input.edges.length === 0 &&
      previous.frame.input.view.kind !== "delta" && value.input.view.kind !== "delta" &&
      previous.frame.input.selected_hotbar === null && value.input.selected_hotbar === null &&
      sameHeld(previous.frame.input.held, value.input.held);
    if ((!coalesces && this.frames.length >= 4) || expanded > 256 - (this.submittedEdges - this.orderedEdgePrefix) ||
      this.submittedSequence === Number.MAX_SAFE_INTEGER || expanded > Number.MAX_SAFE_INTEGER - this.submittedEdges) {
      this.fence("input_capacity_exceeded");
      return this.rejected("input_capacity_exceeded");
    }

    const sequence = ++this.submittedSequence;
    const entry: PendingFrame = { sequence, frame: value, ordered_edge_start: this.submittedEdges,
      ordered_edge_end: this.submittedEdges + expanded, sent: false };
    if (coalesces) this.frames[this.frames.length - 1] = entry;
    else this.frames.push(entry);
    this.submittedEdges += expanded;
    this.acceptedFrameSequence = context.frame_seq;
    if (value.input.kind === "world") this.submittedHeld = value.input.held;
    return { sequence, status: coalesces ? "coalesced" : "submitted", reason: null };
  }

  take(): { sequence: number; frame: ControllerInputFrame; ordered_edge_start: number; ordered_edge_end: number } | null {
    if (this.fenced) return null;
    const entry = this.frames.find(frame => !frame.sent);
    if (!entry) return null;
    entry.sent = true;
    return { sequence: entry.sequence, frame: structuredClone(entry.frame),
      ordered_edge_start: entry.ordered_edge_start, ordered_edge_end: entry.ordered_edge_end };
  }

  acceptAck(ack: InputAppliedAck): ControllerAckAdmission {
    if (this.retired) return "stale_or_duplicate";
    const parsed = inputAppliedAckSchema.safeParse(ack);
    if (!parsed.success) {
      this.fence("invalid_input_ack");
      return "invalid_input_ack";
    }
    const value = parsed.data;
    if (value.controller_generation !== this.controllerGeneration) return "stale_or_duplicate";
    const appliedSequence = this.applied?.sequence ?? 0;
    if (value.sequence < appliedSequence) return "stale_or_duplicate";
    // The latest applied identity is retained separately for subsequent consumed-prefix progress.
    const pending = this.frames.find(frame => frame.sequence === value.sequence && frame.sent);
    const target: AppliedFrame | null = value.sequence === appliedSequence ? this.applied : pending ? {
      sequence: pending.sequence, ordered_edge_end: pending.ordered_edge_end,
      held: pending.frame.input.kind === "world" ? pending.frame.input.held : neutralHeld,
    } : null;
    if (!target) {
      this.fence("ack_for_unsent_input");
      return "ack_for_unsent_input";
    }
    if (value.ordered_edge_prefix > target.ordered_edge_end) {
      this.fence("ack_overclaims_ordered_prefix");
      return "ack_overclaims_ordered_prefix";
    }
    if (value.ordered_edge_prefix < this.orderedEdgePrefix ||
      (this.lastInput !== null && (value.applied_native_tick < this.lastInput.applied_native_tick ||
        BigInt(value.applied_native_ns) < BigInt(this.lastInput.applied_native_ns))) ||
      (value.sequence === appliedSequence && value.ordered_edge_prefix === this.orderedEdgePrefix)) return "stale_or_duplicate";
    if (value.input_application === "confirmed" && !sameHeld(value.held, target.held)) {
      this.fence("ack_held_mismatch");
      return "ack_held_mismatch";
    }

    this.applied = target;
    this.orderedEdgePrefix = value.ordered_edge_prefix;
    this.lastInput = value;
    // Frame acknowledgment is not counted-edge consumption. The cumulative counters outlive snapshots.
    this.frames = this.frames.filter(frame => frame.sequence > value.sequence || !frame.sent);
    if (value.input_application !== "confirmed") this.fence(`application_${value.input_application}`);
    return "accepted";
  }

  revoke(): void {
    this.fence("admission_revoked");
  }

  acceptRevocation(ack: RevocationAck): boolean {
    if (this.retired) return false;
    const parsed = revocationAckSchema.safeParse(ack);
    if (!parsed.success) return false;
    const value = parsed.data;
    if (!this.matchesOwner(value.owner) || value.controller_generation !== this.controllerGeneration) return false;
    const appliedSequence = this.applied?.sequence ?? 0;
    const target = value.last_applied_sequence === appliedSequence ? this.applied :
      this.frames.find(frame => frame.sent && frame.sequence === value.last_applied_sequence);
    if (value.last_applied_sequence < appliedSequence ||
      (value.last_applied_sequence !== appliedSequence && !target) ||
      value.ordered_edge_prefix < this.orderedEdgePrefix || value.ordered_edge_prefix > (target?.ordered_edge_end ?? 0) ||
      (this.lastInput !== null && (value.retirement_applied_native_tick < this.lastInput.applied_native_tick ||
        BigInt(value.retirement_applied_native_ns) < BigInt(this.lastInput.applied_native_ns)))) return false;

    this.fence("admission_revoked");
    this.retired = true;
    this.orderedEdgePrefix = value.ordered_edge_prefix;
    // A retirement can report application progress, but cannot invent an ordinary applied pose/held ACK.
    if (value.last_applied_sequence > appliedSequence) {
      const pending = this.frames.find(frame => frame.sequence === value.last_applied_sequence)!;
      this.applied = { sequence: pending.sequence, ordered_edge_end: pending.ordered_edge_end,
        held: pending.frame.input.kind === "world" ? pending.frame.input.held : neutralHeld };
    }
    this.frames = [];
    return true;
  }

  snapshot(): { fenced: boolean; retired: boolean; submitted_sequence: number; applied_sequence: number;
    ordered_edge_prefix: number; pending_frames: number; pending_edges: number; last_input: InputAppliedAck | null; reason: string | null } {
    return { fenced: this.fenced, retired: this.retired, submitted_sequence: this.submittedSequence,
      applied_sequence: this.applied?.sequence ?? 0, ordered_edge_prefix: this.orderedEdgePrefix,
      pending_frames: this.frames.length, pending_edges: this.retired ? 0 : this.submittedEdges - this.orderedEdgePrefix,
      last_input: this.lastInput === null ? null : structuredClone(this.lastInput), reason: this.reason };
  }

  private matchesOwner(owner: ExpectedEffectOwner): boolean {
    return owner.operation_id === this.owner.operation_id && owner.generation === this.owner.generation &&
      sameEffectScope(owner.scope, this.owner.scope);
  }

  private rejected(reason: ControllerLedgerReason): LedgerSubmission {
    return { sequence: this.submittedSequence, status: "rejected", reason };
  }

  private fence(reason: ControllerLedgerReason): void {
    this.fenced = true;
    this.reason ??= reason;
  }
}
