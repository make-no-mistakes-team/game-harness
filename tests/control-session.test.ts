import { expect, test, vi } from "bun:test";
import { ControlSession, type ControlSessionOptions } from "../src/server/control-session.ts";
import { controlSessionConfigSchema, executiveSnapshotSchema, type ExecutiveChoice, type ExecutiveSnapshot } from "../src/shared/control-session.ts";
import { DEFAULT_RESIDENT_LIMITS, ResidentCleanupError, type ExecutiveStepResult, type ResidentClock, type ResidentSnapshot } from "../src/shared/resident.ts";
import { singletonExecutableModuleBundle } from "../src/shared/program-modules.ts";
import type { GameActionResult, Json } from "../src/shared/contracts.ts";
import type { ControllerChannelFault, ControllerInputChannel, InputAppliedAck, RevocationAck } from "../src/shared/controller.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { minecraftControllerFrameSchema, type MinecraftControllerFrame } from "../src/shared/minecraft.ts";
import { controllerNativeDeadline, ControllerChannelFaultError, ControllerScreenReadSupersededError, NativeControllerChannel, NativeRequestFault } from "../src/server/controller-channel.ts";

async function settle() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
class Clock implements ResidentClock {
  id = "session-test-clock"; time = 0; ordinal = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) { const id = ++this.ordinal; this.timers.set(id, { at: this.time + delay, callback }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(Number(handle)); }
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback(); await settle();
    }
    this.time = end; await settle();
  }
  async jump(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers].filter(([, timer]) => timer.at <= this.time)) {
      if (!this.timers.delete(id)) continue;
      timer.callback(); await settle();
    }
  }
}
const neutral = { forward: false, back: false, left: false, right: false, jump: false, sprint: false,
  sneak: false, attack: false, use: false };
const rawChoice: ExecutiveChoice = { kind: "raw", input: { kind: "world", held: { ...neutral, forward: true },
  edges: [{ kind: "button", button: "forward", phase: "press", count: 1 }], view: { kind: "unchanged" }, selected_hotbar: null } };
const request = { kind: "action" as const, action: { kind: "navigate", destination: "authorized-target" }, duration_ms: 1000 };
const success: GameActionResult = { status: "succeeded", summary: "Finite resource work completed", evidence: { collected: 1 } };
function harness(retained = 32, ownBody?: (body: MinecraftControllerFrame["player"]) => void,
  ownFrame?: (frame: MinecraftControllerFrame) => void, nativeGenerationOffset = 0) {
  const clock = new Clock(), completed: { handle: number; frame_seq: number; deadline: number; result: {
    promise: Promise<GameActionResult>; resolve(value: GameActionResult): void; reject(reason?: unknown): void;
  } }[] = [];
  const records: { type: string; details: Json }[] = [], sent: { sequence: number; frame: Json; input: unknown }[] = [];
  const snapshots: ResidentSnapshot[] = [];
  const acknowledgements = new Map<number, (ack: InputAppliedAck) => void>();
  let choice: ExecutiveChoice = { kind: "observe" }, frameSeq = 0, nativeTick = 0, generation = 0, workerClosed = 0, retired = 0;
  let active = true, stepCount = 0, activationCount = 0;
  let retirement = Promise.resolve(), supervision = 0;
  let renewal = async () => {};
  const sample = async () => {
    const frame = minecraftControllerFrameSchema.parse(controllerFrameFixture()); frame.frame_seq = ++frameSeq; frame.native_tick = frameSeq;
    frame.dynamic_entities.native_tick = frameSeq; frame.captured_native_ns = String(Math.round(clock.now() * 1e6));
    frame.dynamic_entities.captured_native_ns = frame.captured_native_ns;
    frame.inventory.captured_native_ns = frame.captured_native_ns;
    ownBody?.(frame.player);
    ownFrame?.(frame);
    nativeTick = frame.native_tick;
    return frame as unknown as Json;
  };
  const result = (state: Json) => ({ choice: structuredClone(choice), next_state: Number(state) + 1,
    status: "running" as const, events: [] });
  const options: ControlSessionOptions = {
    execution_id: "executive", source_hash: "a".repeat(64), controller_generation: 1,
    limits: { ...DEFAULT_RESIDENT_LIMITS, max_frames: 2000, max_steps: 2000 }, deadline_host_ms: 10000,
    initial_state: 0, intent: null, config: controlSessionConfigSchema.parse({ schema_version: 1, retained_tasks: retained }), clock,
    worker: { async activate(_frame, state) { activationCount++; return result(state); },
      async step(_frame, state) { stepCount++; return result(state); }, async close() { workerClosed++; } },
    sample,
    async open(_deadline, applied, _effect) {
      const currentGeneration = ++generation + nativeGenerationOffset; let sequence = 0, revoked = false;
      const captures = new Set<number>();
      acknowledgements.set(currentGeneration, applied);
      const owner = { operation_id: `producer-${generation}`, generation, scope: { session_id: "game-session", world_id: "world", epoch: 1,
        native_boot_id: "boot", run_id: "run", run_generation: 1, life_id: 3, space_epoch: 4,
        execution_id: "executive", source_hash: "a".repeat(64) } };
      return { owner, controllerGeneration: currentGeneration,
        async sample() {
          if (revoked) throw new Error("Retired channel cannot sample");
          const frame = await sample(); captures.add(minecraftControllerFrameSchema.parse(frame).frame_seq); return frame;
        },
        submit(frame, input) { if (revoked) throw new Error("Retired writer emitted"); sent.push({ sequence: ++sequence, frame, input }); return { sequence, status: "submitted", reason: null }; },
        async renew(frame) {
          if (revoked) throw new Error("Retired writer renewed");
          if (!captures.has(minecraftControllerFrameSchema.parse(frame).frame_seq)) throw new Error("Capture does not belong to this channel");
          await renewal();
        },
        snapshot() { return { fenced: revoked, retired: revoked, submitted_sequence: sequence, applied_sequence: 0, ordered_edge_prefix: 0,
          pending_frames: 0, pending_edges: 0, last_input: null, reason: null, fault: null }; },
        async revoke() { revoked = true; await retirement; retired++; return { owner, controller_generation: currentGeneration, admission_revoked: true,
          last_applied_sequence: 0, ordered_edge_prefix: 0, retirement_applied_native_tick: nativeTick,
          retirement_applied_native_ns: String(Math.round(clock.now() * 1e6)), input_application: "confirmed", unresolved_operation_refs: [] } satisfies RevocationAck; },
      } satisfies ControllerInputChannel;
    },
    async task(_request, handle, deadline, signal, frame) {
      expect(deadline).toBeLessThanOrEqual(10000);
      const outcome = Promise.withResolvers<GameActionResult>(); completed.push({ handle, frame_seq: frame.frame_seq, deadline, result: outcome });
      signal.addEventListener("abort", () => outcome.resolve({ status: "cancelled", summary: "Interrupted exactly", evidence: null }), { once: true });
      return await outcome.promise;
    },
    async supervise() { supervision++; }, async retireTask() { await retirement; },
    record(type, details) { records.push({ type, details }); }, current: () => active,
    event() {}, effect() {}, changed(snapshot) { snapshots.push(snapshot); },
    async analysis() { throw new Error("Not used by this execution"); },
  };
  const session = new ControlSession(options);
  return { clock, session, options, completed, sent, snapshots, records,
    choose(value: ExecutiveChoice) { choice = value; }, setRetirement(value: Promise<void>) { retirement = value; },
    onRenew(operation: () => Promise<void>) { renewal = operation; },
    acknowledge(currentGeneration: number, sequence: number) {
      acknowledgements.get(currentGeneration)!({ controller_generation: currentGeneration, sequence, ordered_edge_prefix: sequence,
        applied_native_tick: nativeTick, applied_native_ns: String(Math.round(clock.now() * 1e6)),
        held: { ...neutral, forward: true }, applied_pose: { yaw_radians: 0, pitch_radians: 0 },
        input_application: "confirmed", reason: null });
    },
    setActive(value: boolean) { active = value; },
    get stepCount() { return stepCount; }, get activationCount() { return activationCount; },
    get workerClosed() { return workerClosed; }, get retired() { return retired; }, get supervision() { return supervision; } };
}

const terminalEvent = { kind: "diagnostic", urgency: "ordinary", summary: "Local objective evidence collected",
  details: { logs: 8, postEncounterDig: true } } as const;

test("raw null waits cross a GUI close without queuing stale screen snapshots and retain exact submission attribution", async () => {
  let screenOpen = true;
  const screen = { identity: { screen_id: "inventory", incarnation: 3, layout_revision: 1 },
    content_revision: 1, screen_kind: "inventory", viewport: { width: 640, height: 480, scale_factor: 1 },
    slots: [], cursor: { item: null, count: 0 }, elements: [], progress: [] };
  const h = harness(32, undefined, frame => {
    frame.native_tick += 1000; frame.dynamic_entities.native_tick += 1000;
    frame.screen = screenOpen ? screen : null;
  }, 40);
  const seen: { frame_seq: number; native_tick: number; submission: ExecutiveSnapshot["last_submission"] }[] = [];
  const step = h.options.worker.step;
  h.options.worker.step = async (...args) => {
    const frame = args[0], executive = executiveSnapshotSchema.parse(frame.executive);
    seen.push({ frame_seq: frame.frame_seq, native_tick: frame.native_tick, submission: executive.last_submission });
    return await step(...args);
  };
  const wait: ExecutiveChoice = { kind: "raw", input: null };
  h.choose(wait); await h.session.start(); await h.clock.advance(50);
  expect(h.sent).toHaveLength(0);
  expect(h.session.snapshot().session?.last_submission).toBeNull();
  h.choose({ kind: "raw", input: { kind: "screen", screen: screen.identity, operations: [{ kind: "close" }] } });
  await h.clock.advance(50);
  const submission = { frame_seq: 3, controller_generation: 41, sequence: 1,
    intent_version: 0, behavior_generation: 1, status: "submitted" as const };
  expect(h.session.snapshot().session?.last_submission).toEqual(submission);
  // The screen changes before any application ACK is delivered. Waiting must
  // neither enqueue an old GUI snapshot nor fabricate command application.
  screenOpen = false; h.choose(wait); await h.clock.advance(200);
  expect(h.sent).toHaveLength(1);
  expect(seen.find(frame => frame.frame_seq === 4)).toEqual({
    frame_seq: 4, native_tick: 1004, submission,
  });
  expect(h.session.snapshot()).toMatchObject({ status: "running", controller_generation: 41, last_input: null,
    counters: { submissions: 1, applied_sequence: 0 }, session: { last_submission: submission } });
  h.choose({ kind: "observe" }); await h.clock.advance(50);
  expect(h.session.snapshot().session?.last_submission).toBeNull();
  h.choose(wait); await h.clock.advance(100);
  expect(h.sent).toHaveLength(1);
  h.choose(rawChoice); await h.clock.advance(50);
  expect(h.session.snapshot().session?.last_submission).toMatchObject({
    controller_generation: 42, sequence: 1, intent_version: 0, behavior_generation: 1,
  });
  expect(h.session.snapshot().session?.last_submission?.frame_seq).toBeGreaterThan(3);
  await h.session.stop("End no-submission GUI wait");
});

test("raw null waits preserve held-input bookkeeping until an explicit release", async () => {
  const h = harness(); h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
  h.acknowledge(1, 1);
  const submission = h.session.snapshot().session?.last_submission;
  h.choose({ kind: "raw", input: null }); await h.clock.advance(500);
  expect(h.sent).toHaveLength(1);
  expect(h.session.snapshot()).toMatchObject({ last_input: { sequence: 1, held: { forward: true } },
    counters: { submissions: 1, applied_sequence: 1 }, session: { producer: "raw", last_submission: submission } });
  h.choose({ kind: "raw", input: { kind: "world", held: { ...neutral },
    view: { kind: "unchanged" }, selected_hotbar: null } });
  await h.clock.advance(50);
  expect(h.sent[1]!.input).toMatchObject({ kind: "world", held: neutral,
    edges: [{ kind: "button", button: "forward", phase: "release", count: 1 }] });
  await h.session.stop("End retained held-input state");
});

test("fresh raw null waits cannot extend the original root deadline or mint input acknowledgments", async () => {
  const h = harness(); h.choose({ kind: "raw", input: null });
  await h.session.start(); await h.clock.advance(10000);
  expect(h.sent).toHaveLength(0);
  expect(h.session.snapshot()).toMatchObject({ last_input: null,
    counters: { submissions: 0, applied_sequence: 0, expanded_edges: 0 },
    session: { producer: "none", last_submission: null, deadline_host_ms: 10000, restarts: 0 },
    cleanup: { native: "retired", worker: "closed" } });
  expect(h.workerClosed).toBe(1); expect(h.retired).toBe(1);
  await h.session.stop("End original deadline proof");
});

test.each([false, true])("only a trusted superseded-screen read can be discarded without a decision (trusted=%s)", async trusted => {
  const h = harness(), sample = h.options.sample;
  h.options.sample = async () => {
    const error = new ControllerScreenReadSupersededError();
    throw trusted ? error : new Error(error.message);
  };
  h.choose(rawChoice);
  await h.session.start(); await h.clock.advance(0);
  expect(h.activationCount).toBe(0);
  expect(h.sent).toHaveLength(0);
  expect(h.session.snapshot()).toMatchObject({ status: trusted ? "running" : "failed",
    counters: { stale_frames: trusted ? 1 : 0 }, state: 0 });
  h.options.sample = sample;
  await h.clock.advance(100);
  expect(h.activationCount).toBe(trusted ? 1 : 0);
  expect(h.sent).toHaveLength(trusted ? 1 : 0);
  await h.session.stop("End screen-read classification");
});

test.each([false, true])("superseded raw samples never renew the producer lease (continuous=%s)", async continuous => {
  const h = harness(), open = h.options.open, renew = vi.fn(async () => {});
  let reads = 0;
  h.onRenew(renew);
  h.options.open = async (...args) => {
    const channel = await open(...args), sample = channel.sample.bind(channel);
    channel.sample = async cursor => {
      if (continuous || reads++ === 0) throw new ControllerScreenReadSupersededError();
      return await sample(cursor);
    };
    return channel;
  };
  h.choose(rawChoice);
  await h.session.start(); await h.clock.advance(50);
  expect(h.sent).toHaveLength(0);
  expect(renew).not.toHaveBeenCalled();
  expect(h.retired).toBe(0);
  expect(h.stepCount).toBe(0);
  await h.clock.advance(200);
  if (continuous) {
    expect(h.sent).toHaveLength(0);
    expect(renew).not.toHaveBeenCalled();
    expect(h.retired).toBe(1);
    expect(h.session.snapshot()).toMatchObject({ status: "failed",
      session: { deadline_host_ms: 10000, restarts: 0, producer: "none" } });
  } else {
    expect(h.sent[0]?.sequence).toBe(1);
    expect(h.retired).toBe(0);
    expect(h.session.snapshot().status).toBe("running");
  }
  await h.session.stop("End superseded sample lease boundary");
});

for (const noSubmission of [false, true])
test.each([false, true])(`lease expiry during computation never renews or submits the old owner (wait=${noSubmission}, reset_safe=%s)`, async resetSafe => {
  const h = harness(), renew = vi.fn(async () => {});
  h.onRenew(renew);
  h.options.config.recovery = resetSafe ? "reset_safe" : "none";
  h.options.config.max_restarts = resetSafe ? 1 : 0;
  h.options.restartWorker = async () => h.options.worker;
  h.options.worker.step = async () => {
    h.clock.time += 60;
    return { choice: noSubmission ? { kind: "raw", input: null } : rawChoice,
      next_state: { uncommitted: true }, status: "running", events: [] };
  };
  h.choose(rawChoice);
  await h.session.start();
  await h.clock.advance(0);
  // The owner opened at zero; its original 250ms lease is still live when
  // this delayed tick starts, but expires before its 60ms computation ends.
  await h.clock.jump(200);
  expect(h.sent).toHaveLength(0);
  expect(renew).not.toHaveBeenCalled();
  expect(h.retired).toBe(1);
  const snapshot = h.session.snapshot();
  expect(snapshot.state).toEqual(resetSafe ? 0 : 1);
  expect(snapshot.session).toMatchObject({
    restarts: resetSafe ? 1 : 0,
    behavior_generation: resetSafe ? 2 : 1,
    deadline_host_ms: 10000,
    producer: "none",
  });
  expect(snapshot.status).toBe(resetSafe ? "running" : "failed");
  expect(h.records.filter(record => record.type === "session.reset_safe_restart")).toHaveLength(resetSafe ? 1 : 0);
  await h.session.stop("End expiry boundary");
});

test.each(["completed", "blocked", "yielded"] as const)(
  "a current %s software return publishes count eight and its event without admitting its terminal choice", async status => {
    const choice: ExecutiveChoice = status === "completed" ? rawChoice
      : status === "blocked" ? { kind: "ensure_task", key: 1, request } : { kind: "observe" };
    const h = harness(), returned = Promise.withResolvers<ExecutiveStepResult>(), finals: ResidentSnapshot[] = [];
    const eventStatuses: ResidentSnapshot["status"][] = [];
    let lateIntentAccepted = false;
    const priorEvent = { ...terminalEvent, summary: "Earlier evidence", details: { logs: 7 } };
    h.options.limits.max_events = 2;
    h.options.worker.activate = async () => ({ status: "running", choice: { kind: "observe" },
      next_state: { logs: 7, done: null }, events: [priorEvent] });
    h.options.worker.step = async () => returned.promise;
    h.options.open = vi.fn(h.options.open); h.options.task = vi.fn(h.options.task);
    h.options.event = vi.fn(event => {
      if (event.summary !== terminalEvent.summary) return;
      eventStatuses.push(h.session.snapshot().status);
      try { h.session.updateIntent({ late: true }, 0); lateIntentAccepted = true; } catch {}
    });
    h.options.effect = vi.fn();
    const changed = h.options.changed;
    h.options.changed = (snapshot, terminal) => { changed(snapshot, terminal); if (terminal) finals.push(snapshot); };
    await h.session.start(); await h.clock.advance(0);
    expect(h.session.snapshot().state).toEqual({ logs: 7, done: null });
    await h.clock.advance(50); await h.clock.advance(3);
    returned.resolve({ status, choice, next_state: { logs: 8, done: terminalEvent.summary }, events: [terminalEvent] });
    await settle(); await h.session.stop("join terminal publication"); await h.clock.advance(1000);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ status, reason: `session_${status}`,
      state: { logs: 8, done: terminalEvent.summary }, processed_frame_seq: 2, processed_native_tick: 2,
      processed_native_ns: "50000000", cleanup: { worker: "closed", native: "retired" },
      counters: { frames: 2, steps: 2, events: 2, submissions: 0, expanded_edges: 0, applied_sequence: 0 },
      timings: { step_ms: { count: 2, max: 3 }, input_age_ms: { count: 0 } },
      last_input: null, session: { task_high_water: 0, producer: "none", tasks: [] } });
    expect(finals[0]!.events).toEqual([
      { sequence: 1, host_monotonic_ms: 0, event: priorEvent },
      { sequence: 2, host_monotonic_ms: 53, event: terminalEvent },
    ]);
    expect(h.options.event).toHaveBeenCalledTimes(2);
    expect(h.options.event).toHaveBeenLastCalledWith(terminalEvent);
    expect(h.options.open).not.toHaveBeenCalled(); expect(h.options.task).not.toHaveBeenCalled();
    expect(h.options.effect).not.toHaveBeenCalled(); expect(h.sent).toHaveLength(0);
    expect(h.workerClosed).toBe(1);
    expect(eventStatuses).toEqual([status]); expect(lateIntentAccepted).toBe(false);
  });

test("terminal raw input cannot renew an existing producer before its confirmed drain", async () => {
  const choice = rawChoice;
  const h = harness(), barrier = Promise.withResolvers<void>(), finals: ResidentSnapshot[] = [];
  h.options.open = vi.fn(h.options.open); h.options.task = vi.fn(h.options.task); h.options.event = vi.fn();
  const renew = vi.fn(async () => {}); h.onRenew(renew);
  const changed = h.options.changed;
  h.options.changed = (snapshot, terminal) => { changed(snapshot, terminal); if (terminal) finals.push(snapshot); };
  h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
  expect(h.sent).toHaveLength(1); expect(renew).toHaveBeenCalledTimes(1);
  h.setRetirement(barrier.promise);
  h.options.worker.step = async () => ({ status: "completed", choice,
    next_state: { logs: 8, done: terminalEvent.summary }, events: [terminalEvent] });
  await h.clock.advance(50);
  expect(h.session.snapshot()).toMatchObject({ state: { logs: 8, done: terminalEvent.summary },
    status: "completed", cleanup: { worker: "closed", native: "open" } });
  expect(finals).toHaveLength(0); expect(h.retired).toBe(0);
  expect(h.options.open).toHaveBeenCalledTimes(1); expect(renew).toHaveBeenCalledTimes(1);
  expect(h.options.task).not.toHaveBeenCalled(); expect(h.sent).toHaveLength(1);
  const stopping = h.session.stop("join terminal drain"); barrier.resolve(); await stopping;
  expect(finals).toHaveLength(1);
  expect(finals[0]).toMatchObject({ status: "completed", counters: { submissions: 1, applied_sequence: 0, events: 1 },
    cleanup: { worker: "closed", native: "retired" }, session: { producer: "none", task_high_water: 0, tasks: [] } });
  expect(h.options.event).toHaveBeenCalledTimes(1); expect(h.retired).toBe(1); expect(h.workerClosed).toBe(1);
});

test("a terminal activation publishes software evidence but unconfirmed cleanup remains unknown", async () => {
  const h = harness();
  h.options.worker.activate = async () => ({ status: "completed", choice: rawChoice,
    next_state: { logs: 8, done: terminalEvent.summary }, events: [terminalEvent] });
  h.options.worker.close = async () => { throw new ResidentCleanupError(); };
  h.options.event = vi.fn(); h.options.open = vi.fn(h.options.open);
  await h.session.start(); await h.clock.advance(0);
  await expect(h.session.stop("join unknown cleanup")).rejects.toBeInstanceOf(ResidentCleanupError);
  expect(h.snapshots.at(-1)).toMatchObject({ status: "unknown", state: { logs: 8, done: terminalEvent.summary },
    processed_frame_seq: 1, counters: { events: 1, submissions: 0 }, cleanup: { worker: "unknown", native: "retired" } });
  expect(h.options.event).toHaveBeenCalledTimes(1); expect(h.options.open).not.toHaveBeenCalled();
});

test("a terminal event cannot exceed the cumulative source-event budget or publish partial state", async () => {
  const h = harness();
  h.options.limits.max_events = 1;
  h.options.worker.activate = async () => ({ status: "running", choice: { kind: "observe" },
    next_state: { logs: 7, done: null }, events: [terminalEvent] });
  h.options.worker.step = async () => ({ status: "completed", choice: rawChoice,
    next_state: { logs: 8, done: terminalEvent.summary }, events: [terminalEvent] });
  h.options.event = vi.fn(); h.options.open = vi.fn(h.options.open);
  await h.session.start(); await h.clock.advance(50); await h.session.stop("join event budget failure");
  expect(h.session.snapshot()).toMatchObject({ status: "failed", reason: "session_event_budget",
    state: { logs: 7, done: null }, processed_frame_seq: 1, processed_native_tick: 1, processed_native_ns: "0",
    counters: { events: 1, submissions: 0 }, timings: { step_ms: { count: 1 } },
    cleanup: { worker: "closed", native: "retired" } });
  expect(h.session.snapshot().events).toHaveLength(1);
  expect(h.options.event).toHaveBeenCalledTimes(1); expect(h.options.open).not.toHaveBeenCalled();
});

test("terminal publication retains the bounded event tail without resetting cumulative event accounting", async () => {
  const h = harness();
  h.options.limits.max_events = 129; h.options.event = vi.fn();
  const running = async () => ({ status: "running" as const, choice: { kind: "observe" as const }, next_state: 7,
    events: Array.from({ length: 16 }, () => ({ ...terminalEvent, summary: "Earlier software event" })) });
  h.options.worker.activate = running; h.options.worker.step = running;
  await h.session.start(); await h.clock.advance(350);
  expect(h.session.snapshot().counters.events).toBe(128);
  h.options.worker.step = async () => ({ status: "completed", choice: { kind: "observe" },
    next_state: 8, events: [terminalEvent] });
  await h.clock.advance(50); await h.session.stop("join bounded terminal publication");
  const snapshot = h.session.snapshot();
  expect(snapshot.counters.events).toBe(129); expect(snapshot.events).toHaveLength(128);
  expect(snapshot.events[0]!.sequence).toBe(2);
  expect(snapshot.events.at(-1)).toEqual({ sequence: 129, host_monotonic_ms: 400, event: terminalEvent });
  expect(h.options.event).toHaveBeenCalledTimes(129);
});

test.each(["intent", "scope", "Stop", "deadline", "stale"] as const)(
  "a terminal return superseded by %s cannot publish software state, frame bookkeeping or events", async cause => {
    const h = harness(), returned = Promise.withResolvers<ExecutiveStepResult>();
    h.options.worker.activate = async () => ({ status: "running", choice: { kind: "observe" },
      next_state: { logs: 7, done: null }, events: [] });
    h.options.worker.step = async () => returned.promise;
    h.options.event = vi.fn(); h.options.open = vi.fn(h.options.open); h.options.task = vi.fn(h.options.task);
    await h.session.start(); await h.clock.advance(50);
    let stopping: Promise<void> | undefined;
    if (cause === "intent") h.session.updateIntent({ revised: true }, 0);
    else if (cause === "scope") h.setActive(false);
    else if (cause === "Stop") stopping = h.session.stop("operator Stop");
    else await h.clock.advance(cause === "deadline" ? 9950 : 126);
    returned.resolve({ status: "completed", choice: { kind: "ensure_task", key: 1, request },
      next_state: { logs: 8, done: terminalEvent.summary }, events: [terminalEvent] });
    await settle(); await (stopping ?? h.session.stop("join rejected terminal return"));
    expect(h.session.snapshot()).toMatchObject({ state: { logs: 7, done: null },
      processed_frame_seq: 1, processed_native_tick: 1, processed_native_ns: "0",
      counters: { events: 0, submissions: 0, stale_results: cause === "stale" ? 0 : 1 },
      timings: { step_ms: { count: 1 } }, cleanup: { worker: "closed", native: "retired" },
      session: { task_high_water: 0, tasks: [] } });
    expect(h.session.snapshot().status).toBe(cause === "Stop" || cause === "deadline" ? "stopped" : "failed");
    expect(h.session.snapshot().events).toEqual([]);
    expect(h.options.event).not.toHaveBeenCalled(); expect(h.options.open).not.toHaveBeenCalled();
    expect(h.options.task).not.toHaveBeenCalled(); expect(h.sent).toHaveLength(0);
  });

test("finite child completion and a racing continue leave the executive alive without restarting the task", async () => {
  const h = harness(); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0);
  expect(h.completed.map(task => task.handle)).toEqual([1]);
  h.completed[0]!.result.resolve(success); await settle();
  h.choose({ kind: "continue", handle: 1 }); await h.clock.advance(100);
  expect(h.completed).toHaveLength(1);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { producer: "none", tasks: [{ status: "succeeded" }] } });
  expect(h.stepCount).toBeGreaterThan(0); expect(h.activationCount).toBe(1);
  await h.session.stop("test complete");
});

test("exact interruption preserves executive and requires fresh computation after physical retirement", async () => {
  const h = harness(); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0);
  const barrier = Promise.withResolvers<void>(); h.setRetirement(barrier.promise);
  h.choose(rawChoice); await h.clock.advance(50);
  const before = h.stepCount;
  await h.clock.advance(150);
  expect(h.stepCount).toBe(before); expect(h.sent).toHaveLength(0);
  barrier.resolve(); await settle(); await h.clock.advance(100);
  expect(h.sent.length).toBeGreaterThan(0);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { tasks: [{ status: "interrupted" }], producer: "raw" } });
  expect(minecraftControllerFrameSchema.parse(h.sent[0]!.frame).native_tick).toBeGreaterThan(4);
  await h.session.stop("test complete");
});

test("identical keys return settled outcomes, conflicting content never executes and evicted keys cannot replay", async () => {
  const h = harness(1); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0); h.completed[0]!.result.resolve(success); await settle();
  h.choose({ kind: "ensure_task", key: 1, request: { ...request, duration_ms: 900 } }); await h.clock.advance(50);
  expect(h.session.snapshot().session?.last_command_error).toContain("conflict"); expect(h.completed).toHaveLength(1);
  h.choose({ kind: "ensure_task", key: 2, request }); await h.clock.advance(50);
  h.completed[1]!.result.resolve(success); await settle();
  h.choose({ kind: "ensure_task", key: 1, request }); await h.clock.advance(50);
  expect(h.completed.map(task => task.handle)).toEqual([1, 2]);
  expect(h.session.snapshot().session?.last_command_error).toContain("no replay");
  await h.session.stop("test complete");
});

test("unknown child effect survives as unknown, never replays and does not delete the executive", async () => {
  const h = harness(); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0);
  h.completed[0]!.result.resolve({ status: "unknown", summary: "Cursor consequence unresolved; physical release confirmed", evidence: null });
  await settle(); await h.clock.advance(100);
  expect(h.completed).toHaveLength(1);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { tasks: [{ status: "unknown" }] } });
  await h.session.stop("test complete");
});

test("Stop fences new effects and joins the selected child physical retirement before terminal publication", async () => {
  const h = harness(); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0);
  const barrier = Promise.withResolvers<void>(); h.setRetirement(barrier.promise);
  let stopped = false; const stopping = h.session.stop("operator Stop").then(() => { stopped = true; });
  await settle(); await h.clock.advance(200);
  expect(stopped).toBe(false); expect(h.completed).toHaveLength(1);
  barrier.resolve(); await stopping;
  expect(h.session.snapshot().cleanup).toEqual({ worker: "closed", native: "retired" });
  expect(h.workerClosed).toBe(1);
});

test("a deliberate observation does not keep a semantic producer alive without a fresh continue", async () => {
  const h = harness(); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0);
  h.choose({ kind: "observe" }); await h.clock.advance(150); expect(h.supervision).toBe(0);
  h.choose({ kind: "continue", handle: 1 }); await h.clock.advance(50); expect(h.supervision).toBe(1);
  await h.session.stop("test complete");
});

test("confirmed stationary raw movement reports one advisory without replacing the authored producer", async () => {
  const h = harness(32, body => { body.on_ground = true; body.in_water = false; });
  h.choose({ kind: "raw", input: { kind: "world", held: { ...neutral, forward: true },
    view: { kind: "unchanged" }, selected_hotbar: null } });
  await h.session.start(); await h.clock.advance(0);
  for (let now = 50; now <= 5500; now += 50) {
    await h.clock.advance(50);
    const last = h.sent.at(-1);
    if (last) h.acknowledge(1, last.sequence);
  }
  expect(h.records.filter(record => record.type === "session.continuity_incident")).toHaveLength(1);
  expect(h.records.find(record => record.type === "session.continuity_incident")?.details).toMatchObject({
    reason: "executive_raw_motion_stationary", elapsed_native_ms: 5000, usefulness_inferred: false,
  });
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { producer: "raw", task_high_water: 0 } });
  expect(h.retired).toBe(0);
  await h.session.stop("test complete");
});

const viewOnlyChoice: ExecutiveChoice = { kind: "raw", input: { kind: "world", held: { ...neutral },
  view: { kind: "rate", yaw_radians_per_second: 1, pitch_radians_per_second: 0 }, selected_hotbar: null } };

test("accepted raw-view and observe alternation reports once across real producer-generation turnover without claiming application", async () => {
  const h = harness(32, body => { body.on_ground = true; body.in_water = false; });
  h.choose(viewOnlyChoice); await h.session.start(); await h.clock.advance(0);
  for (let now = 50; now <= 8000; now += 50) {
    h.choose(now % 800 === 0 ? { kind: "observe" } : viewOnlyChoice);
    await h.clock.advance(50);
  }
  const incidents = h.records.filter(record => record.type === "session.continuity_incident");
  expect(incidents).toHaveLength(1);
  expect(incidents[0]?.details).toMatchObject({
    reason: "executive_stationary_view_observe", application_inferred: false, usefulness_inferred: false,
    elapsed_native_ms: 5000, intent_version: 0, behavior_generation: 1,
  });
  const facts = incidents[0]!.details as { [key: string]: Json };
  expect(Number(facts.raw_view_decisions)).toBeGreaterThan(0);
  expect(Number(facts.observe_decisions)).toBeGreaterThan(0);
  expect(Number(facts.raw_view_decisions) + Number(facts.raw_neutral_decisions) + Number(facts.observe_decisions))
    .toBe(Number(facts.samples));
  expect(facts).not.toHaveProperty("applied_native_ns");
  expect(facts).not.toHaveProperty("controller_generation");
  expect(h.retired).toBeGreaterThan(5);
  expect(h.session.snapshot().controller_generation).toBeGreaterThan(5);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { task_high_water: 0 } });
  expect(h.sent.length).toBeGreaterThan(0);
  await h.session.stop("test complete");
});

test("accepted stationary windows reset on movement, attack, tasks, intent, native scope and missing coverage", async () => {
  for (const interrupt of ["position", "attack", "task", "intent", "native_scope", "gap"] as const) {
    let offset = 0, changedScope = false;
    const h = harness(32, body => { body.on_ground = true; body.in_water = false; body.position.x += offset; });
    const open = h.options.open;
    h.options.open = async (...args) => {
      const channel = await open(...args);
      if (changedScope) channel.owner.scope.native_boot_id = "replacement-boot";
      return channel;
    };
    h.choose(viewOnlyChoice); await h.session.start(); await h.clock.advance(0);
    for (let now = 50; now <= 4000; now += 50) {
      h.choose(now % 800 === 0 ? { kind: "observe" } : viewOnlyChoice);
      await h.clock.advance(50);
    }
    expect(h.records.filter(record => record.type === "session.continuity_incident")).toHaveLength(0);
    if (interrupt === "position") offset = 0.31;
    if (interrupt === "intent") h.session.updateIntent({ changed: true }, 0);
    if (interrupt === "native_scope") changedScope = true;
    const attack: ExecutiveChoice = { kind: "raw", input: { kind: "world", held: { ...neutral, attack: true },
      view: { kind: "unchanged" }, selected_hotbar: null } };
    h.choose(interrupt === "attack" ? attack : interrupt === "task" ? { kind: "ensure_task", key: 1, request } : viewOnlyChoice);
    if (interrupt === "gap") await h.clock.jump(300);
    else await h.clock.advance(50);
    offset = 0;
    h.choose(viewOnlyChoice);
    await h.clock.advance(4500);
    expect(h.records.filter(record => record.type === "session.continuity_incident")).toHaveLength(0);
    await h.clock.advance(750);
    expect(h.records.filter(record => record.type === "session.continuity_incident")).toHaveLength(1);
    expect(h.session.snapshot().status).toBe("running");
    await h.session.stop("test complete");
  }
});

test("accepted observe-only choices do not duplicate the software-only observation incident domain", async () => {
  const h = harness(32, body => { body.on_ground = true; body.in_water = false; });
  await h.session.start(); await h.clock.advance(6000);
  expect(h.records.filter(record => record.type === "session.continuity_incident")).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
  await h.session.stop("test complete");
});

const analysisBundle = singletonExecutableModuleBundle("export function analyze(input) { return input; }", "analyze");
const analysisSource = { skill_id: "pure-analysis", version: 1, hash: analysisBundle.source_hash, bundle: analysisBundle };

test("executive analysis keeps stepping, rejects concurrent jobs and retains stale-result provenance and cumulative budget", async () => {
  const h = harness(), output = Promise.withResolvers<Json>();
  h.options.limits.max_analysis_ms = 10;
  h.options.analysis = async (_source, _input, budget, _signal, report) => {
    expect(budget).toBe(10); const value = await output.promise; report(10); return value;
  };
  await h.session.start(); await h.clock.advance(0);
  const job = h.session.analyze(analysisSource, { query: 1 }, 0); await settle();
  await expect(h.session.analyze(analysisSource, null, 0)).rejects.toThrow("already running");
  const before = h.stepCount; await h.clock.advance(100);
  expect(h.stepCount).toBeGreaterThan(before); expect(h.session.snapshot().pending.analysis).toBe(true);
  h.session.updateIntent({ revised: true }, 0); output.resolve({ answer: 7 });
  expect(await job).toMatchObject({ status: "stale", output: { answer: 7 }, input_version: 0,
    controller_execution_id: "executive", source: { skill_id: "pure-analysis", hash: analysisBundle.source_hash } });
  await expect(h.session.analyze(analysisSource, null, 1)).rejects.toThrow("time budget exhausted");
  await h.session.stop("test complete");
});

test("executive Stop aborts analysis and waits for its real service settlement", async () => {
  const h = harness(), output = Promise.withResolvers<Json>(), entered = Promise.withResolvers<AbortSignal>();
  h.options.analysis = async (_source, _input, _budget, signal, report) => {
    entered.resolve(signal); const value = await output.promise; report(1); return value;
  };
  await h.session.start(); await h.clock.advance(0);
  const job = h.session.analyze(analysisSource, null, 0), signal = await entered.promise;
  let stopped = false; const stopping = h.session.stop("operator Stop").then(() => { stopped = true; });
  await settle(); expect(signal.aborted).toBe(true); expect(stopped).toBe(false);
  output.resolve({ late: true }); expect((await job).status).toBe("cancelled"); await stopping;
  expect(h.session.snapshot().cleanup).toEqual({ worker: "closed", native: "retired" });
});

test("unconfirmed executive analysis cleanup contains the owner and cannot claim a known drain", async () => {
  const h = harness(); h.options.analysis = async () => { throw new ResidentCleanupError(); };
  await h.session.start(); await h.clock.advance(0);
  expect((await h.session.analyze(analysisSource, null, 0)).status).toBe("failed"); await settle();
  await expect(h.session.stop("test complete")).rejects.toBeInstanceOf(ResidentCleanupError);
  expect(h.session.snapshot()).toMatchObject({ status: "unknown", cleanup: { worker: "unknown", native: "retired" } });
});

test("an invalid activation fails the invocation without turning its joined computation into unknown cleanup", async () => {
  const h = harness();
  h.options.worker.activate = async () => { throw new Error("Invalid generated activation result"); };
  await h.session.start(); await h.clock.advance(0); await settle();
  await h.session.stop("join failed invocation");
  expect(h.session.snapshot()).toMatchObject({ status: "failed",
    cleanup: { worker: "closed", native: "retired" }, counters: { submissions: 0 } });
  expect(h.workerClosed).toBe(1);
});

test("an asynchronous native fence during a valid step persists the first cause while the host lease is live", async () => {
  const h = harness(), host = vi.spyOn(performance, "now").mockImplementation(() => h.clock.now());
  const originalOpen = h.options.open, step = h.options.worker.step;
  const response = Promise.withResolvers<unknown>();
  let submissions = 0;
  h.options.open = async (deadline, applied, effect, ...rest) => {
    const base = await originalOpen(deadline, applied, effect, ...rest), owner = base.owner;
    const clock = { clock_id: "boot", host_sent_ms: 0, host_received_ms: 0, native_received_ns: "0",
      native_replied_ns: "0", native_processing_ms: 0, residual_round_trip_ms: 0,
      offset_lower_ms: 0, offset_upper_ms: 0, uncertainty_ms: 0 };
    return new NativeControllerChannel(owner, base.controllerGeneration, deadline, controllerNativeDeadline(clock, deadline), {
      async request(method) {
        if (method === "controller_submit") { submissions++; return await response.promise; }
        if (method === "controller_revoke") return { generation: owner.generation + 1, ack: {
          owner, controller_generation: base.controllerGeneration, admission_revoked: true, last_applied_sequence: 0,
          ordered_edge_prefix: 0, retirement_applied_native_tick: 5, retirement_applied_native_ns: "100000000",
          input_application: "confirmed", unresolved_operation_refs: [],
        } };
        return {};
      },
      sample: async () => minecraftControllerFrameSchema.parse(await h.options.sample(null)),
      clock: () => clock,
      assertCurrent() {}, retired() {}, async failed() { throw new Error("Retirement must be confirmed"); },
    }, applied, effect);
  };
  h.options.worker.step = async (...args) => {
    if (submissions === 1) {
      response.reject(new NativeRequestFault("native_rejected", "controller_submit", 41, "dispatched", "Rejected input"));
      await settle();
    }
    return await step(...args);
  };
  try {
    h.choose(rawChoice); await h.session.start(); await h.clock.advance(100);
    await h.session.stop("join failed invocation");
    const faults = h.records.filter(record => record.type === "session.controller_fault");
    expect(faults).toHaveLength(1);
    expect(faults[0]!.details).toMatchObject({
      cause_available: true, host_detected_ms: 100, host_lease_deadline_ms: 300, original_deadline_host_ms: 10000,
      fault: { stage: "submit_response", cause: "native_rejected", decision_dispatch: "dispatched",
        request_id: 41, sequence: 1, frame_seq: 2, captured_native_ns: "50000000", native_first_fence: null },
      channel: { submitted_sequence: 1, applied_sequence: 0 },
    });
    expect(submissions).toBe(1);
    expect(h.session.snapshot()).toMatchObject({ status: "failed", session: { restarts: 0 },
      cleanup: { native: "retired", worker: "closed" } });
    expect(h.records.filter(record => record.type === "session.controller_cleanup").at(-1)!.details)
      .toMatchObject({ cleanup: { native: "retired", worker: "closed" } });
  } finally { response.resolve({}); host.mockRestore(); }
});

test("a source error impersonating the host fault name cannot create trusted channel evidence", async () => {
  const h = harness();
  h.options.worker.activate = async () => {
    const error = new Error("native_input_lease_expired");
    error.name = "ControllerChannelFaultError";
    throw error;
  };
  await h.session.start(); await h.clock.advance(0); await h.session.stop("join source failure");
  expect(h.records.filter(record => record.type === "session.controller_fault")).toHaveLength(0);
  expect(h.session.snapshot()).toMatchObject({ status: "failed", session: { restarts: 0 } });
});

test.each(["reset_safe", "none", "dispatched", "wrong_owner"] as const)(
  "known-unsent stale renewal starts only an explicitly reset-safe exact-owner invocation: %s", async mode => {
    const h = harness(), open = h.options.open, restart = Promise.withResolvers<ControlSessionOptions["worker"]>();
    let rejected = false, restarts = 0;
    const fresh: { state: Json; producer: string | undefined }[] = [];
    h.options.config = { ...h.options.config, recovery: mode === "none" ? "none" : "reset_safe",
      max_restarts: mode === "none" ? 0 : 1 };
    h.options.restartWorker = async () => { restarts++; return await restart.promise; };
    h.options.worker.step = async (_frame, _state, _intent) => ({ choice: rawChoice, next_state: 777,
      status: "running", events: [{ kind: "diagnostic", urgency: "ordinary", summary: "uncommitted stale decision", details: null }] });
    h.options.open = async (...args) => {
      const channel = await open(...args), renew = channel.renew.bind(channel);
      channel.renew = async frame => {
        if (rejected) return await renew(frame);
        rejected = true;
        const capture = minecraftControllerFrameSchema.parse(frame);
        const fault: ControllerChannelFault = {
          schema_version: 1, stage: "heartbeat_admission", cause: "stale_native_frame",
          decision_dispatch: mode === "dispatched" ? "dispatched" : "not_dispatched",
          owner: mode === "wrong_owner" ? { ...channel.owner, operation_id: "unrelated-owner" } : channel.owner,
          controller_generation: channel.controllerGeneration, sequence: null, frame_seq: capture.frame_seq,
          captured_native_ns: capture.captured_native_ns, request_id: null, request_method: null,
          initiating_request_id: null, initiating_method: null, host_detected_ms: h.clock.now(),
          original_deadline_host_ms: h.options.deadline_host_ms, native_first_fence: null,
          detail: "Trusted local stale-capture admission refused before heartbeat/input dispatch",
        };
        throw new ControllerChannelFaultError(fault, fault.detail);
      };
      return channel;
    };
    h.options.event = vi.fn();
    try {
      h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
      expect(h.sent).toHaveLength(0);
      expect(h.options.event).not.toHaveBeenCalled();
      if (mode === "reset_safe") {
        expect(restarts).toBe(1);
        expect(h.workerClosed).toBe(1);
        expect(h.session.snapshot()).toMatchObject({ status: "running", state: 1 });
        await h.clock.advance(100);
        expect(h.sent).toHaveLength(0);
        expect(fresh).toEqual([]);
        restart.resolve({
          async activate(frame, state) {
            fresh.push({ state, producer: executiveSnapshotSchema.parse(minecraftControllerFrameSchema.parse(frame).executive).producer });
            return { choice: rawChoice, next_state: 1, status: "running", events: [] };
          },
          async step() { return { choice: rawChoice, next_state: 2, status: "running", events: [] }; },
          async close() {},
        });
        await settle(); await h.clock.advance(100);
        expect(fresh).toEqual([{ state: 0, producer: "none" }]);
        expect(h.sent).toHaveLength(1);
        expect(h.session.snapshot()).toMatchObject({ status: "running", state: 2,
          session: { restarts: 1, behavior_generation: 2, deadline_host_ms: 10000 } });
        expect(h.records.find(row => row.type === "session.reset_safe_restart")?.details)
          .toMatchObject({ reason: "known_unsent_stale_native_frame", replayed_effects: false, original_deadline_host_ms: 10000 });
      } else {
        expect(restarts).toBe(0);
        expect(h.session.snapshot()).toMatchObject({ status: "failed", session: { restarts: 0 },
          cleanup: { worker: "closed", native: "retired" } });
      }
    } finally {
      restart.resolve(h.options.worker);
      await h.session.stop("test complete");
    }
  });

test.each(["sample", "renew", "submit"] as const)("an untyped trusted %s failure records explicit missing cause before cleanup", async stage => {
  const h = harness(), open = h.options.open;
  h.options.open = async (...args) => {
    const channel = await open(...args);
    if (stage === "sample") channel.sample = async () => { throw new Error("native_input_lease_expired"); };
    if (stage === "renew") channel.renew = async () => { throw new Error("native_input_lease_expired"); };
    if (stage === "submit") channel.submit = () => { throw new Error("native_input_lease_expired"); };
    return channel;
  };
  h.choose(rawChoice); await h.session.start(); await h.clock.advance(50); await h.session.stop("join failed native edge");
  const faults = h.records.filter(record => record.type === "session.controller_fault");
  expect(faults).toHaveLength(1);
  expect(faults[0]!.details).toMatchObject({ fault: null, cause_available: false,
    original_deadline_host_ms: 10000, cleanup: { native: "open", worker: "open" } });
  expect(h.sent).toHaveLength(0);
  expect(h.session.snapshot()).toMatchObject({ status: "failed", session: { restarts: 0 },
    cleanup: { native: "retired", worker: "closed" } });
});

test("raw retirement keeps read-only sensing alive without reading through the fenced channel", async () => {
  const h = harness(); h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
  const barrier = Promise.withResolvers<void>(); h.setRetirement(barrier.promise);
  h.choose({ kind: "observe" }); await h.clock.advance(50);
  const calls = h.stepCount; await h.clock.advance(200);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { producer: "retiring" } });
  expect(h.stepCount).toBe(calls); expect(h.sent).toHaveLength(1);
  barrier.resolve(); await settle(); await h.session.stop("complete");
});

test("an intent update during renewal cannot submit the previous intent's computed input", async () => {
  const h = harness(); h.choose(rawChoice); await h.session.start(); await h.clock.advance(0);
  h.onRenew(async () => { h.session.updateIntent({ destination: "new" }, 0); });
  await h.clock.advance(50); await h.session.stop("join superseded generation");
  expect(h.sent).toHaveLength(0);
  expect(h.session.snapshot()).toMatchObject({ status: "failed", intent_version: 1,
    counters: { stale_results: 1 }, cleanup: { native: "retired", worker: "closed" } });
});

test("known expired raw leases recover before sampling the old channel under the original deadline", async () => {
  const h = harness();
  h.options.config = controlSessionConfigSchema.parse({ schema_version: 1, recovery: "reset_safe", max_restarts: 1 });
  const old = h.options.worker;
  h.options.restartWorker = async () => ({ step: (...args) => old.step(...args), activate: (...args) => old.activate!(...args), close: () => old.close() });
  h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
  const previous = h.sent[0]!;
  await h.clock.jump(350); await h.clock.advance(100);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { restarts: 1,
    behavior_generation: 2, deadline_host_ms: 10000 } });
  expect(h.sent.length).toBeGreaterThan(1);
  expect(minecraftControllerFrameSchema.parse(h.sent.at(-1)!.frame).captured_native_ns)
    .not.toBe(minecraftControllerFrameSchema.parse(previous.frame).captured_native_ns);
  expect(h.retired).toBe(1);
  await h.session.stop("complete");
});

test("recovery after a child settles during a stale decision admits fresh work instead of exposing a permanent retirement", async () => {
  const h = harness(), returned = Promise.withResolvers<ExecutiveStepResult>(), closed = Promise.withResolvers<void>();
  const unknown: GameActionResult = { status: "unknown", summary: "Native supervision expired after emission",
    evidence: { world_effect_emitted: true, neutralized: true } };
  const late: ExecutiveStepResult = { choice: { kind: "continue", handle: 1 },
    next_state: { uncommitted: true }, status: "running", events: [terminalEvent] };
  const freshInputs: { session: ExecutiveSnapshot; state: Json }[] = [];
  h.options.config.recovery = "reset_safe"; h.options.config.max_restarts = 1;
  const oldClose = h.options.worker.close;
  h.options.worker.close = async () => { await closed.promise; await oldClose(); };
  h.options.worker.step = async () => await returned.promise;
  h.options.event = vi.fn();
  h.options.restartWorker = async () => ({
    async activate(frame, state) {
      const session = executiveSnapshotSchema.parse(minecraftControllerFrameSchema.parse(frame).executive);
      freshInputs.push({ session, state });
      // A consumer must wait while retirement is reported, as the real executive did.
      return { choice: session.producer === "retiring" ? { kind: "observe" } : { kind: "ensure_task", key: 2, request },
        next_state: 1, status: "running", events: [] };
    },
    async step() { return { choice: { kind: "continue", handle: 2 }, next_state: 2, status: "running", events: [] }; },
    async close() {},
  });
  try {
    h.choose({ kind: "ensure_task", key: 1, request });
    await h.session.start(); await h.clock.advance(50);
    // Native expiry settles and retires the child before the delayed VM result arrives.
    h.completed[0]!.result.resolve(unknown); await settle();
    expect(h.session.snapshot().session).toMatchObject({ producer: "none", task_high_water: 1,
      tasks: [{ handle: 1, status: "unknown" }] });
    await h.clock.jump(350);
    returned.resolve(late); await settle();
    expect(h.session.snapshot()).toMatchObject({ status: "running", state: 1,
      session: { producer: "retiring", task_high_water: 1, restarts: 0, deadline_host_ms: 10000 } });
    expect(h.completed.map(task => task.handle)).toEqual([1]);
    expect(h.options.event).not.toHaveBeenCalled();
    closed.resolve(); await settle(); await h.clock.advance(100);
    expect(freshInputs[0]).toMatchObject({ state: 0,
      session: { producer: "none", behavior_generation: 2, task_high_water: 1, restarts: 1, deadline_host_ms: 10000 } });
    expect(h.completed.map(task => task.handle)).toEqual([1, 2]);
    expect(h.workerClosed).toBe(1);
    expect(h.session.snapshot()).toMatchObject({ status: "running",
      session: { producer: "task", task_high_water: 2, restarts: 1, deadline_host_ms: 10000 } });
    expect(h.session.snapshot().session?.tasks.find(task => task.handle === 1)?.result).toEqual(unknown);
    expect(h.session.snapshot().counters.steps).toBeGreaterThan(2);
  } finally {
    returned.resolve(late); closed.resolve();
    await h.session.stop("End stale semantic settlement recovery proof");
  }
});

test("an earlier application acknowledgment cannot delete a later outstanding input capture", async () => {
  const h = harness(); h.choose(rawChoice); await h.session.start(); await h.clock.advance(100);
  expect(h.sent.map(input => input.sequence)).toEqual([1, 2]);
  h.acknowledge(1, 1); h.acknowledge(1, 2);
  expect(h.session.snapshot()).toMatchObject({ counters: { applied_sequence: 2, ordered_edge_prefix: 2 },
    last_input: { controller_generation: 1, sequence: 2, input_application: "confirmed" } });
  await h.session.stop("complete");
});

test("large retained receipts remain in history without exceeding subsequent worker frame bounds", async () => {
  const h = harness(), step = h.options.worker.step;
  const frameSizes: number[] = [];
  h.options.worker.step = async (frame, ...args) => {
    const bytes = Buffer.byteLength(JSON.stringify(frame)); frameSizes.push(bytes);
    if (bytes > 262144 - 32768) throw new Error("Worker input capacity exhausted by retained task detail");
    return await step(frame, ...args);
  };
  h.choose({ kind: "ensure_task", key: 1, request }); await h.session.start(); await h.clock.advance(0);
  for (let handle = 1; handle <= 6; handle++) {
    h.completed[handle - 1]!.result.resolve({ ...success, evidence: { receipt: "x".repeat(60000) } }); await settle();
    h.choose({ kind: "ensure_task", key: handle + 1, request }); await h.clock.advance(50);
  }
  expect(h.session.snapshot()).toMatchObject({ status: "running",
    session: { task_high_water: 7, tasks_omitted: 0 } });
  expect(h.session.snapshot().session!.tasks.filter(task => task.status === "succeeded")
    .every(task => task.detail_omitted && task.result?.evidence === null)).toBe(true);
  expect(h.records.filter(record => record.type === "session.child_settled")
    .every(record => JSON.stringify(record.details).includes("x".repeat(60000)))).toBe(true);
  expect(Math.max(...frameSizes)).toBeLessThan(262144 - 32768);
  await h.session.stop("complete");
});

test("a channel opened during a read-only sample cannot adopt that unretained capture", async () => {
  const h = harness(), opening = Promise.withResolvers<void>();
  const open = h.options.open, sample = h.options.sample;
  h.options.open = async (...args) => { await opening.promise; return await open(...args); };
  h.choose(rawChoice); await h.session.start(); await h.clock.advance(0);
  let released = false;
  h.options.sample = async cursor => {
    const frame = await sample(cursor);
    if (!released) { released = true; opening.resolve(); await settle(); }
    return frame;
  };
  await h.clock.advance(50);
  expect(h.sent).toHaveLength(0);
  expect(h.session.snapshot().status).toBe("running");
  await h.clock.advance(50);
  expect(h.sent.map(input => minecraftControllerFrameSchema.parse(input.frame).frame_seq)).toEqual([3]);
  await h.session.stop("complete");
});

test("one ensure_task reserves its request across raw retirement and a fresh continue starts it once", async () => {
  const h = harness(); h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
  const lastRawFrame = minecraftControllerFrameSchema.parse(h.sent[0]!.frame).frame_seq;
  const barrier = Promise.withResolvers<void>(); h.setRetirement(barrier.promise);
  h.choose({ kind: "ensure_task", key: 1, request }); await h.clock.advance(50);
  expect(h.session.snapshot()).toMatchObject({ session: { task_high_water: 1,
    tasks: [{ handle: 1, status: "starting", deadline_host_ms: 1100 }] } });
  expect(h.completed).toHaveLength(0);
  await h.clock.advance(200);
  barrier.resolve(); await settle();
  h.choose({ kind: "continue", handle: 1 }); await h.clock.advance(100);
  expect(h.completed.map(task => task.handle)).toEqual([1]);
  expect(h.completed[0]!.frame_seq).toBeGreaterThan(lastRawFrame);
  expect(h.completed[0]!.deadline).toBe(1100);
  expect(h.session.snapshot()).toMatchObject({ status: "running",
    session: { producer: "task", tasks: [{ handle: 1, status: "running" }] } });
  await h.session.stop("complete");
});

test("a reserved task cannot extend its deadline while raw retirement is pending", async () => {
  const h = harness(); h.choose(rawChoice); await h.session.start(); await h.clock.advance(50);
  const barrier = Promise.withResolvers<void>(); h.setRetirement(barrier.promise);
  h.choose({ kind: "ensure_task", key: 1, request: { ...request, duration_ms: 100 } }); await h.clock.advance(50);
  await h.clock.advance(250); barrier.resolve(); await settle();
  h.choose({ kind: "continue", handle: 1 }); await h.clock.advance(50);
  expect(h.completed).toHaveLength(0);
  expect(h.session.snapshot()).toMatchObject({ status: "running", session: { task_high_water: 1,
    tasks: [{ handle: 1, status: "failed", deadline_host_ms: 200, result: { evidence: { world_effect_emitted: false } } }] } });
  await h.session.stop("complete");
});

test("completion racing replacement preserves the old successful result and the newly reserved handle", async () => {
  const h = harness(); h.choose({ kind: "ensure_task", key: 1, request });
  await h.session.start(); await h.clock.advance(0);
  const barrier = Promise.withResolvers<void>(); h.setRetirement(barrier.promise);
  h.completed[0]!.result.resolve(success); await settle();
  h.choose({ kind: "ensure_task", key: 2, request }); await h.clock.advance(50);
  barrier.resolve(); await settle(); h.choose({ kind: "continue", handle: 2 }); await h.clock.advance(50);
  expect(h.session.snapshot()).toMatchObject({ session: { task_high_water: 2,
    tasks: [{ handle: 1, status: "succeeded" }, { handle: 2, status: "running" }] } });
  expect(h.completed.map(task => task.handle)).toEqual([1, 2]);
  await h.session.stop("complete");
});
