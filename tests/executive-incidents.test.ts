import { expect, test } from "bun:test";
import { ExecutiveObservationMonitor } from "../src/server/executive-incidents.ts";
import type { ResidentSnapshot } from "../src/shared/resident.ts";

function snapshot(): ResidentSnapshot {
  const timing = () => ({ count: 0, p50: null, p95: null, p99: null, max: null, omitted_samples: 0 });
  return {
    execution_id: "executive", source_hash: "a".repeat(64), controller_generation: 1, host_clock_id: "host",
    status: "running", reason: null, intent_version: 0, state: null,
    processed_frame_seq: 1, processed_native_tick: 1, processed_native_ns: "1",
    counters: { frames: 1, steps: 1, submissions: 0, applied_sequence: 0, ordered_edge_prefix: 0,
      missed_slots: 0, stale_results: 0, stale_frames: 0, read_failures: 0, no_input_decisions: 1,
      expanded_edges: 0, events: 0, analysis_jobs: 0, analysis_ms: 0 },
    pending: { frames: 0, edges: 0, analysis: false }, last_input: null,
    timings: { step_ms: timing(), input_age_ms: timing() }, events: [],
    session: { schema_version: 1, session_id: "executive", behavior_generation: 1, producer: "none",
      task_high_water: 0, tasks: [], last_command_error: null, restarts: 0, deadline_host_ms: 60000 },
    cleanup: { worker: "open", native: "open" },
  };
}

function observe(frame: ResidentSnapshot): void {
  frame.processed_frame_seq!++;
  frame.counters.frames++; frame.counters.steps++; frame.counters.no_input_decisions++;
}

test("five seconds of fresh observe-only decisions produce one advisory per continuous interval", () => {
  const monitor = new ExecutiveObservationMonitor(), frame = snapshot();
  expect(monitor.update("executive", frame, 0)).toBeNull();
  for (let now = 1000; now < 5000; now += 1000) {
    observe(frame); expect(monitor.update("executive", frame, now)).toBeNull();
  }
  observe(frame);
  expect(monitor.update("executive", frame, 5000)).toEqual({
    reason: "executive_observe_only", elapsed_host_ms: 5000, no_input_decisions: 6,
    processed_frame_seq: 6, intent_version: 0,
  });
  for (let now = 6000; now <= 10000; now += 1000) {
    observe(frame); expect(monitor.update("executive", frame, now)).toBeNull();
  }
  frame.session!.producer = "task";
  expect(monitor.update("executive", frame, 11000)).toBeNull();
  frame.session!.producer = "none";
  for (let now = 12000; now < 17000; now += 1000) {
    observe(frame); expect(monitor.update("executive", frame, now)).toBeNull();
  }
  observe(frame);
  expect(monitor.update("executive", frame, 17000)?.elapsed_host_ms).toBe(5000);
});

test("intervening commands, intent changes, missing progress and owner changes cannot accumulate observation advice", () => {
  for (const interrupt of ["raw", "task", "other_choice", "intent", "owner", "clock_gap", "frame_reset", "stop"] as const) {
    const monitor = new ExecutiveObservationMonitor(), frame = snapshot();
    let execution = "executive";
    monitor.update(execution, frame, 0);
    for (let now = 1000; now <= 4000; now += 1000) {
      observe(frame); expect(monitor.update(execution, frame, now)).toBeNull();
    }
    observe(frame);
    let now = 5000;
    if (interrupt === "raw") frame.counters.submissions++;
    if (interrupt === "task") frame.session!.task_high_water++;
    if (interrupt === "other_choice") frame.counters.steps++;
    if (interrupt === "intent") frame.intent_version++;
    if (interrupt === "owner") execution = "replacement";
    if (interrupt === "clock_gap") now = 7000;
    if (interrupt === "frame_reset") frame.processed_frame_seq = 1;
    if (interrupt === "stop") frame.status = "stopped";
    expect(monitor.update(execution, frame, now)).toBeNull();
  }
  const monitor = new ExecutiveObservationMonitor(), frame = snapshot();
  monitor.update("executive", frame, 0);
  // Repeated delivery of an old snapshot is not new observation coverage.
  expect(monitor.update("executive", frame, 6000)).toBeNull();
  observe(frame);
  expect(monitor.update("executive", frame, 6001)).toBeNull();
});
