import { expect, test } from "bun:test";
import { ExecutiveObservationMonitor, ExecutiveRawMonitor, ExecutiveStationaryViewMonitor } from "../src/server/executive-incidents.ts";
import type { ResidentSnapshot } from "../src/shared/resident.ts";
import type { ControllerInput, InputAppliedAck } from "../src/shared/controller.ts";
import type { ExecutiveChoice } from "../src/shared/control-session.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { minecraftControllerFrameSchema } from "../src/shared/minecraft.ts";

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

function rawSample(now: number, moving = false) {
  const frame = minecraftControllerFrameSchema.parse(controllerFrameFixture());
  frame.frame_seq = now / 50 + 1; frame.captured_native_ns = String(BigInt(now) * 1_000_000n);
  frame.screen = null; frame.player.on_ground = true; frame.player.in_water = false;
  frame.player.in_lava = false; frame.player.gliding = false; frame.player.vehicle_type = null;
  const held = { forward: moving, back: false, left: false, right: false, jump: false,
    sprint: false, sneak: false, attack: false, use: false };
  const input: ControllerInput = { kind: "world", held, edges: [], view: { kind: "unchanged" }, selected_hotbar: null };
  const ack: InputAppliedAck = { controller_generation: 1, sequence: frame.frame_seq, ordered_edge_prefix: 0,
    applied_native_tick: frame.frame_seq, applied_native_ns: frame.captured_native_ns, held: { ...held },
    applied_pose: { yaw_radians: 0, pitch_radians: 0 }, input_application: "confirmed", reason: null };
  return { frame, input, ack };
}

test("confirmed neutral and stationary motion each produce one factual advisory after five native seconds", () => {
  for (const moving of [false, true]) {
    const monitor = new ExecutiveRawMonitor(), incidents = [];
    for (let now = 0; now <= 8000; now += 50) {
      const { frame, input, ack } = rawSample(now, moving);
      const incident = monitor.update("same-owner", frame, input, ack, now);
      if (incident) incidents.push(incident);
    }
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ reason: moving ? "executive_raw_motion_stationary" : "executive_raw_neutral",
      elapsed_native_ms: 5000, samples: 101 });
  }
});

test("unknown, stale, changed, purposeful controls and missing coverage cannot accumulate raw advice", () => {
  for (const interrupt of ["unknown", "stale", "gap", "scope", "attack", "rotation", "selection", "screen", "held_mismatch"] as const) {
    const monitor = new ExecutiveRawMonitor();
    for (let now = 0; now <= 4000; now += 50) {
      const { frame, input, ack } = rawSample(now);
      expect(monitor.update("owner", frame, input, ack, now)).toBeNull();
    }
    const { frame, input, ack } = rawSample(4050);
    let key = "owner", host = 4050;
    if (interrupt === "unknown") ack.input_application = "unknown";
    if (interrupt === "stale") ack.applied_native_ns = String(BigInt(frame.captured_native_ns) + 150_000_001n);
    if (interrupt === "gap") host += 251;
    if (interrupt === "scope") key = "replacement";
    if (input.kind === "world") {
      if (interrupt === "attack") input.held.attack = ack.held.attack = true;
      if (interrupt === "rotation") input.view = { kind: "delta", yaw_radians: 0.1, pitch_radians: 0 };
      if (interrupt === "selection") input.selected_hotbar = (frame.player.selected_hotbar + 1) % 9;
      if (interrupt === "held_mismatch") ack.held.forward = true;
    }
    if (interrupt === "screen") frame.screen = {
      identity: { screen_id: "visible-inventory", incarnation: 1, layout_revision: 1 },
      content_revision: 1, screen_kind: "inventory", viewport: { width: 320, height: 240, scale_factor: 2 },
      slots: [], cursor: { item: null, count: 0 }, elements: [], progress: [],
    };
    expect(monitor.update(key, frame, input, ack, host)).toBeNull();
    for (let now = 4100; now <= 5050; now += 50) {
      const next = rawSample(now);
      expect(monitor.update(key, next.frame, next.input, next.ack, host + now - 4050)).toBeNull();
    }
  }
});

test("moving beyond the bounded own-body region resets a blocked-motion window even on a round trip", () => {
  const monitor = new ExecutiveRawMonitor();
  for (let now = 0; now <= 7000; now += 50) {
    const { frame, input, ack } = rawSample(now, true);
    frame.player.position.x += Math.sin(now / 1000) * 2;
    expect(monitor.update("owner", frame, input, ack, now)).toBeNull();
  }
  const sample = rawSample(8000, true);
  expect(monitor.update("owner", sample.frame, sample.input, sample.ack, 8000)).toBeNull();
  // Duplicate old ACKs provide no extra observed coverage.
  expect(monitor.update("owner", sample.frame, sample.input, sample.ack, 15000)).toBeNull();
});

function stationaryChoice(now: number): ExecutiveChoice {
  if (now % 150 === 0) return { kind: "observe" };
  const { input } = rawSample(now);
  if (input.kind === "world") input.view = now % 150 === 50
    ? { kind: "rate", yaw_radians_per_second: 1, pitch_radians_per_second: 0 }
    : { kind: "delta", yaw_radians: 0, pitch_radians: -0.01 };
  return { kind: "raw", input };
}

test("stationary view/observe evidence counts software choices without asserting native application", () => {
  const monitor = new ExecutiveStationaryViewMonitor(), incidents = [];
  const origin = 9_007_199_254_740_993n;
  for (let now = 0; now <= 8000; now += 50) {
    const { frame } = rawSample(now);
    frame.captured_native_ns = String(origin + BigInt(now) * 1_000_000n);
    const incident = monitor.update("root:behavior:intent", frame, stationaryChoice(now), now);
    if (incident) incidents.push(incident);
  }
  expect(incidents).toHaveLength(1);
  expect(incidents[0]).toMatchObject({
    reason: "executive_stationary_view_observe", application_inferred: false, usefulness_inferred: false,
    elapsed_native_ms: 5000, samples: 101, raw_view_decisions: 67, observe_decisions: 34, raw_neutral_decisions: 0,
    first_captured_native_ns: String(origin), captured_native_ns: String(origin + 5_000_000_000n),
  });
  expect(incidents[0]).not.toHaveProperty("applied_native_ns");
  expect(incidents[0]).not.toHaveProperty("controller_generation");
});

test("observe-only or neutral-only evidence never becomes a view/observe incident", () => {
  for (const kind of ["observe", "neutral"] as const) {
    const monitor = new ExecutiveStationaryViewMonitor();
    for (let now = 0; now <= 6000; now += 50) {
      const { frame, input } = rawSample(now);
      expect(monitor.update("owner", frame, kind === "observe" ? { kind: "observe" } : { kind: "raw", input }, now)).toBeNull();
    }
  }
});

test("stationary sample coverage admits exactly 250ms adjacency and a 0.3-block anchor including neutral view choices", () => {
  const monitor = new ExecutiveStationaryViewMonitor(), incidents = [];
  for (let now = 0; now <= 5000; now += 250) {
    const { frame, input } = rawSample(now);
    frame.player.position.x = now === 0 ? 0 : 0.3;
    const choice: ExecutiveChoice = now === 2500 ? { kind: "raw", input } : stationaryChoice(now);
    const incident = monitor.update("owner", frame, choice, now);
    if (incident) incidents.push(incident);
  }
  expect(incidents).toHaveLength(1);
  expect(incidents[0]).toMatchObject({
    reason: "executive_stationary_view_observe", elapsed_native_ms: 5000, samples: 21,
    raw_neutral_decisions: 1, own_position: { x: 0.3 }, anchor_position: { x: 0 },
  });
});

test("stationary view/observe windows reset on authority, movement, controls and coverage boundaries", () => {
  for (const interrupt of ["key", "life", "dimension", "space", "position", "selection", "attack", "use",
    "jump", "move", "edge", "hotbar", "screen", "air", "water", "lava", "vehicle", "gliding",
    "task", "host_gap", "native_gap"] as const) {
    const monitor = new ExecutiveStationaryViewMonitor();
    for (let now = 0; now < 4000; now += 50) {
      const { frame } = rawSample(now);
      expect(monitor.update("owner", frame, stationaryChoice(now), now)).toBeNull();
    }
    for (let now = 4000; now <= 8000; now += 50) {
      const { frame, input } = rawSample(now);
      let choice = stationaryChoice(now), key = "owner", host = now;
      if (interrupt === "key") key = "replacement";
      if (interrupt === "life") frame.life_id++;
      if (interrupt === "dimension") frame.space.dimension_id = "minecraft:the_nether";
      if (interrupt === "space") frame.space.space_epoch++;
      if (interrupt === "host_gap") host += 251;
      if (interrupt === "native_gap") frame.captured_native_ns = String(BigInt(frame.captured_native_ns) + 251_000_000n);
      if (now === 4000) {
        if (interrupt === "position") frame.player.position.x += 0.31;
        if (interrupt === "selection") frame.player.selected_hotbar = (frame.player.selected_hotbar + 1) % 9;
        if (input.kind === "world") {
          if (interrupt === "attack" || interrupt === "use" || interrupt === "jump") input.held[interrupt] = true;
          if (interrupt === "move") input.held.forward = true;
          if (interrupt === "edge") input.edges = [{ kind: "button", button: "inventory", phase: "press", count: 1 }];
          if (interrupt === "hotbar") input.selected_hotbar = (frame.player.selected_hotbar + 1) % 9;
          choice = { kind: "raw", input };
        }
        if (interrupt === "task") choice = { kind: "continue", handle: 1 };
        if (interrupt === "air") frame.player.on_ground = false;
        if (interrupt === "water") frame.player.in_water = true;
        if (interrupt === "lava") frame.player.in_lava = true;
        if (interrupt === "vehicle") frame.player.vehicle_type = "boat";
        if (interrupt === "gliding") frame.player.gliding = true;
        if (interrupt === "screen") frame.screen = {
          identity: { screen_id: "inventory", incarnation: 1, layout_revision: 1 },
          content_revision: 1, screen_kind: "inventory", viewport: { width: 320, height: 240, scale_factor: 2 },
          slots: [], cursor: { item: null, count: 0 }, elements: [], progress: [],
        };
      }
      expect(monitor.update(key, frame, choice, host)).toBeNull();
    }
  }
});

test("duplicate captures cannot add stationary choice coverage or bridge a missing interval", () => {
  const monitor = new ExecutiveStationaryViewMonitor(), { frame } = rawSample(0);
  expect(monitor.update("owner", frame, stationaryChoice(50), 0)).toBeNull();
  for (let now = 50; now <= 6000; now += 50)
    expect(monitor.update("owner", frame, stationaryChoice(now), now)).toBeNull();
  const next = rawSample(6050);
  expect(monitor.update("owner", next.frame, stationaryChoice(6050), 6050)).toBeNull();
});

test("pending native scope cannot publish or consume a notification and invalid pending samples still reset coverage", () => {
  for (const invalidPending of [false, true]) {
    const monitor = new ExecutiveStationaryViewMonitor();
    for (let now = 0; now < 5000; now += 50) {
      const { frame } = rawSample(now);
      expect(monitor.update("owner", frame, stationaryChoice(now), now)).toBeNull();
    }
    const pending = rawSample(5000);
    if (invalidPending && pending.input.kind === "world") pending.input.held.attack = true;
    const choice: ExecutiveChoice = invalidPending ? { kind: "raw", input: pending.input } : stationaryChoice(5000);
    expect(monitor.update("owner", pending.frame, choice, 5000, false)).toBeNull();
    const next = rawSample(5050);
    const incident = monitor.update("owner", next.frame, stationaryChoice(5050), 5050);
    if (invalidPending) expect(incident).toBeNull();
    else expect(incident).toMatchObject({ reason: "executive_stationary_view_observe", elapsed_native_ms: 5050 });
  }
});
