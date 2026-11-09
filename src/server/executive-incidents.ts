import type { ResidentSnapshot } from "../shared/resident.ts";

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
