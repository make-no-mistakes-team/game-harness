import type { ResidentSnapshot } from "../shared/resident.ts";
import type { ControllerInput, InputAppliedAck } from "../shared/controller.ts";
import type { MinecraftControllerFrame } from "../shared/minecraft.ts";

/** Facts about confirmed controls and own-body samples, never a gameplay verdict. */
export class ExecutiveRawMonitor {
  private interval: {
    key: string; reason: "executive_raw_neutral" | "executive_raw_motion_stationary";
    since: bigint; at: bigint; host: number; frame: number; sequence: number;
    anchor: { x: number; y: number; z: number }; samples: number; notified: boolean;
  } | null = null;

  clear(): void { this.interval = null; }

  update(key: string, frame: MinecraftControllerFrame, input: ControllerInput, ack: InputAppliedAck, now: number) {
    const previous = this.interval;
    if (previous?.key === key && (ack.sequence <= previous.sequence || frame.frame_seq <= previous.frame)) return null;
    const sampled = BigInt(frame.captured_native_ns), applied = BigInt(ack.applied_native_ns);
    const age = applied - sampled;
    if (input.kind !== "world" || ack.input_application !== "confirmed" || age < 0n || age > 150_000_000n ||
      frame.screen !== null || Object.keys(input.held).some(button =>
        input.held[button as keyof typeof input.held] !== ack.held[button as keyof typeof ack.held])) {
      this.clear(); return null;
    }
    const held = ack.held, body = frame.player, view = input.view;
    const noRotation = view.kind === "unchanged" || (view.kind === "delta"
      ? view.yaw_radians === 0 && view.pitch_radians === 0
      : view.yaw_radians_per_second === 0 && view.pitch_radians_per_second === 0);
    const neutral = !Object.values(held).some(Boolean) && input.edges.length === 0 && noRotation &&
      (input.selected_hotbar === null || input.selected_hotbar === body.selected_hotbar);
    const motion = (held.forward !== held.back || held.left !== held.right) &&
      !held.attack && !held.use && !held.jump && input.edges.length === 0 &&
      body.on_ground && !body.in_water && !body.in_lava && !body.gliding && body.vehicle_type === null;
    const reason = neutral ? "executive_raw_neutral" : motion ? "executive_raw_motion_stationary" : null;
    if (reason === null) { this.clear(); return null; }
    const position = body.position;
    const consecutive = previous && previous.key === key && previous.reason === reason &&
      sampled > previous.at && sampled - previous.at <= 250_000_000n &&
      now >= previous.host && now - previous.host <= 250 &&
      Math.hypot(position.x - previous.anchor.x, position.y - previous.anchor.y, position.z - previous.anchor.z) <= 0.3;
    const interval = this.interval = {
      key, reason, since: consecutive ? previous.since : sampled, at: sampled, host: now,
      frame: frame.frame_seq, sequence: ack.sequence, anchor: consecutive ? previous.anchor : { ...position },
      samples: consecutive ? previous.samples + 1 : 1, notified: consecutive ? previous.notified : false,
    };
    if (interval.notified || sampled - interval.since < 5_000_000_000n) return null;
    interval.notified = true;
    return { reason, elapsed_native_ms: Number(sampled - interval.since) / 1e6, samples: interval.samples,
      first_captured_native_ns: interval.since.toString(), captured_native_ns: frame.captured_native_ns,
      applied_native_ns: ack.applied_native_ns, processed_frame_seq: frame.frame_seq,
      controller_generation: ack.controller_generation, applied_sequence: ack.sequence,
      own_position: { ...position }, anchor_position: { ...interval.anchor }, maximum_anchor_distance_blocks: 0.3 };
  }
}

/** Software-only advice. Observation may be purposeful; this never selects input. */
export class ExecutiveObservationMonitor {
  private interval: {
    execution: string; intent: number; since: number; at: number; frame: number;
    steps: number; observations: number; submissions: number; tasks: number; notified: boolean;
  } | null = null;

  clear(): void { this.interval = null; }

  update(execution: string, snapshot: ResidentSnapshot, now: number) {
    const session = snapshot.session, frame = snapshot.processed_frame_seq;
    if (snapshot.status !== "running" || !session || session.producer !== "none" || frame === null) {
      this.clear(); return null;
    }
    const counters = snapshot.counters, previous = this.interval;
    if (previous?.execution === execution && previous.frame === frame) return null;
    const consecutive = previous && previous.execution === execution && previous.intent === snapshot.intent_version &&
      now >= previous.at && now - previous.at <= 2500 && frame > previous.frame &&
      counters.steps > previous.steps && counters.no_input_decisions > previous.observations &&
      counters.steps - previous.steps === counters.no_input_decisions - previous.observations &&
      counters.submissions === previous.submissions && session.task_high_water === previous.tasks;
    const interval = this.interval = {
      execution, intent: snapshot.intent_version, since: consecutive ? previous.since : now, at: now, frame,
      steps: counters.steps, observations: counters.no_input_decisions, submissions: counters.submissions,
      tasks: session.task_high_water, notified: consecutive ? previous.notified : false,
    };
    if (interval.notified || now - interval.since < 5000) return null;
    interval.notified = true;
    return { reason: "executive_observe_only", elapsed_host_ms: now - interval.since,
      no_input_decisions: interval.observations, processed_frame_seq: frame, intent_version: interval.intent };
  }
}
