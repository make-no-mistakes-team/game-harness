import { expect, test } from "bun:test";
import { ResidentController } from "../src/server/resident-controller.ts";
import type { Json, Sha256 } from "../src/shared/contracts.ts";
import type { ControllerEffectUpdate, ControllerInput, ControllerInputChannel, InputAppliedAck, RevocationAck } from "../src/shared/controller.ts";
import { DEFAULT_RESIDENT_LIMITS, ResidentCleanupError, type ControllerStepResult, type ResidentClock, type ResidentControllerOptions, type ResidentLifecycle, type ResidentLimits, type ResidentSnapshot, type ResidentTraceEvent } from "../src/shared/resident.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";

const hash = "a".repeat(64) as Sha256;
const neutral = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false };
const world = (overrides: Partial<Extract<ControllerInput, { kind: "world" }>> = {}): ControllerInput =>
  ({ kind: "world", held: { ...neutral }, edges: [], view: { kind: "unchanged" }, selected_hotbar: null, ...overrides });
const decision = (input = world(), next_state: Json = null): ControllerStepResult => ({ input, next_state, status: "running", events: [] });
const deferred = <T>() => Promise.withResolvers<T>();
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
class Clock implements ResidentClock {
  id = "test-monotonic"; time = 0; next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) { const id = ++this.next; this.timers.set(id, { at: this.time + delay, callback }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  async advance(ms: number) { const end = this.time + ms;
    for (;;) { const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; this.time = Math.max(this.time, due[1].at); this.timers.delete(due[0]); due[1].callback(); await settle(); }
    this.time = end; await settle();
  }
  async late(ms: number) { this.time += ms;
    const due = [...this.timers].filter(([, timer]) => timer.at <= this.time);
    for (const [id, timer] of due) { if (!this.timers.delete(id)) continue; timer.callback(); await settle(); }
  }
  async early(at: number) {
    const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) throw new Error("No timer to notify early");
    this.time = at; this.timers.delete(next[0]); next[1].callback(); await settle();
  }
}
function harness(limits: Partial<ResidentLimits> = {}, trace?: ResidentControllerOptions["trace"]) {
  const clock = new Clock(); let active = true, seq = 0, reads = 0, refuses = false, workerClosed = 0;
  let frameSeq: number | null = null, step: ResidentControllerOptions["worker"]["step"] = async (_frame, state) => decision(world(), Number(state) + 1);
  let close: () => Promise<void> = async () => {}; let revoke: () => Promise<void> = async () => {};
  let opening: Promise<void> = Promise.resolve();
  let analysis: ResidentControllerOptions["analysis"] = async (_source, _input, _budget, _signal, report) => { report(1); return { answer: 1 }; };
  let lease = false, leaseTimer: unknown = null;
  let transform = (frame: ReturnType<typeof controllerFrameFixture>) => frame;
  const renewals: Json[] = [], sent: { sequence: number; frame: Json; input: ControllerInput }[] = [];
  const changes: { terminal: boolean; snapshot: ResidentSnapshot }[] = [], effects: { input: ControllerInput; event: ControllerEffectUpdate }[] = [];
  let applied!: (ack: InputAppliedAck) => void, effect!: (event: ControllerEffectUpdate) => void, lifecycle!: ResidentLifecycle;
  const owner = { operation_id: "resident-owner", generation: 1, scope: { session_id: "session", world_id: "world", epoch: 1,
    native_boot_id: "boot", run_id: "run", run_generation: 1, life_id: 3, space_epoch: 4, execution_id: "resident", source_hash: hash } };
  let fenced = false, retired = false, last: InputAppliedAck | null = null;
  const armLease = () => {
    if (!lease) return;
    if (leaseTimer !== null) clock.clearTimeout(leaseTimer);
    leaseTimer = clock.setTimeout(() => { fenced = true; lifecycle.fence("native_lease_expired"); }, 250);
  };
  const channel: ControllerInputChannel = {
    owner, controllerGeneration: 1,
    async sample() { reads++; if (refuses) throw new Error("screen transition"); const frame = controllerFrameFixture();
      frame.frame_seq = frameSeq ?? reads; frame.native_tick = reads; frame.captured_native_ns = String(BigInt(Math.round(clock.now() * 1e6)));
      frame.inventory.captured_native_ns = frame.captured_native_ns; return transform(frame) as unknown as Json; },
    submit(frame, input) { if (fenced) return { sequence: seq, status: "rejected", reason: "fenced" };
      sent.push({ sequence: ++seq, frame, input: structuredClone(input) }); return { sequence: seq, status: "submitted", reason: null }; },
    async renew(frame) { if (fenced || frame === null) throw new Error("invalid renewal"); renewals.push(frame); armLease(); },
    async revoke() { fenced = true; if (leaseTimer !== null) clock.clearTimeout(leaseTimer); await revoke(); retired = true; return { owner, controller_generation: 1, admission_revoked: true,
      last_applied_sequence: last?.sequence ?? 0, ordered_edge_prefix: last?.ordered_edge_prefix ?? 0,
      retirement_applied_native_tick: 9, retirement_applied_native_ns: "9000000000", input_application: "confirmed", unresolved_operation_refs: [] } satisfies RevocationAck; },
    snapshot() { return { fenced, retired, submitted_sequence: seq, applied_sequence: last?.sequence ?? 0,
      ordered_edge_prefix: last?.ordered_edge_prefix ?? 0, pending_frames: retired ? 0 : sent.filter(s => s.sequence > (last?.sequence ?? 0)).length,
      pending_edges: 0, last_input: last, reason: null }; },
  };
  const options: ResidentControllerOptions = { execution_id: "resident", source_hash: hash, controller_generation: 1,
    limits: { ...DEFAULT_RESIDENT_LIMITS, ...limits }, deadline_host_ms: 10000, initial_state: 0, intent: {}, clock, trace,
    worker: { step: (...args) => step(...args), close: async () => { workerClosed++; await close(); } },
    async open(deadline, onApplied, onEffect, hooks) { if (deadline !== 10000) throw new Error("root deadline moved");
      await opening;
      applied = onApplied; effect = onEffect; lifecycle = hooks; armLease(); return channel; }, current: () => active,
    event() {}, effect: (input, event) => effects.push({ input, event }), changed: (snapshot, terminal) => changes.push({ snapshot, terminal }),
    analysis: (...args) => analysis(...args) };
  const controller = new ResidentController(options);
  return { controller, clock, channel, options, sent, renewals, changes, effects,
    get reads() { return reads; }, get workerClosed() { return workerClosed; }, get lifecycle() { return lifecycle; },
    setActive(value: boolean) { active = value; }, refuse(value: boolean) { refuses = value; },
    fixedFrame(value: number | null) { frameSeq = value; }, step(fn: typeof step) { step = fn; }, close(fn: typeof close) { close = fn; },
    revoke(fn: typeof revoke) { revoke = fn; }, analysis(fn: typeof analysis) { analysis = fn; },
    lease() { lease = true; }, transform(fn: typeof transform) { transform = fn; },
    opening(promise: Promise<void>) { opening = promise; },
    ack(sequence: number, ns: string, application: InputAppliedAck["input_application"] = "confirmed") {
      last = { controller_generation: 1, sequence, ordered_edge_prefix: 0, applied_native_tick: 8, applied_native_ns: ns,
        held: neutral, applied_pose: { yaw_radians: 0, pitch_radians: 0 }, input_application: application, reason: null }; applied(last); },
    effect(event: ControllerEffectUpdate) { effect(event); },
  };
}
const analysisSource = { skill_id: "pure-analysis", version: 1, hash, source: "export function analyze(input) { return input; }" };
async function begin(h: { controller: ResidentController; clock: Clock }) { await h.controller.start(); await h.clock.advance(0); }

test("unconfirmed analysis cleanup fences the resident and cannot release the local drain barrier as known", async () => {
  const h = harness(); h.analysis(async () => { throw new ResidentCleanupError(); }); await begin(h);
  const job = await h.controller.analyze(analysisSource, {}, 0); await settle(); await h.controller.stop("test");
  expect(job.status).toBe("failed");
  expect(h.controller.snapshot().status).toBe("unknown");
  expect(h.controller.snapshot().cleanup.worker).toBe("unknown");
  expect(h.controller.snapshot().cleanup.native).toBe("retired");
  await expect(h.lifecycle.drain()).rejects.toThrow(/cleanup/);
});

test("known native retirement stays distinct from an unconfirmed computation drain", async () => {
  const h = harness(); await begin(h);
  h.close(async () => { throw new Error("worker drain unknown"); });
  const retire = h.channel.revoke;
  h.channel.revoke = async () => { throw new ResidentCleanupError(await retire()); };
  await h.controller.stop("owned Stop");
  expect(h.controller.snapshot().status).toBe("unknown");
  expect(h.controller.snapshot().cleanup).toEqual({ worker: "unknown", native: "retired" });
});

for (const [frequency_hz, period] of [[1, 1000], [5, 200], [20, 50]] as const) {
  test(`resident ${frequency_hz}Hz uses absolute slots and never queues catch-up steps`, async () => {
    const h = harness({ frequency_hz }); await begin(h); expect(h.controller.snapshot().counters.steps).toBe(1);
    await h.clock.late(period * 3 + 1); expect(h.controller.snapshot().counters.steps).toBe(2);
    expect(h.controller.snapshot().counters.missed_slots).toBe(2);
    await h.clock.advance(period - 1); expect(h.controller.snapshot().counters.steps).toBe(3); await h.controller.stop("test");
  });
}

test("fractional early timer notification does not run the next absolute slot early", async () => {
  const h = harness({ frequency_hz: 20 }), starts: number[] = [];
  h.clock.time = 10.25;
  h.step(async () => { starts.push(h.clock.now()); return decision(); });
  await begin(h);
  await h.clock.early(60);
  expect(starts).toEqual([10.25]);
  await h.clock.advance(.25);
  expect(starts).toEqual([10.25, 60.25]);
  await h.clock.advance(50);
  expect(starts).toEqual([10.25, 60.25, 110.25]);
  expect(h.controller.snapshot().counters.missed_slots).toBe(0);
  await h.controller.stop("test");
});

test("crossing the deadline while handling an early wake cannot skip the already scheduled slot", async () => {
  const starts: number[] = [], trace: ResidentTraceEvent[] = [];
  let crossed = false, h: ReturnType<typeof harness>;
  h = harness({ frequency_hz: 5 }, event => {
    trace.push(event);
    if (event.stage === "wake" && event.scheduled_slot === 1 && !crossed) {
      crossed = true;
      h.clock.time = 200.02;
    }
  });
  h.step(async () => { starts.push(h.clock.now()); return decision(); });
  await begin(h);
  await h.clock.early(199.99);
  await h.clock.advance(0);
  expect(starts).toEqual([0, 200.02]);
  expect(h.controller.snapshot().counters.missed_slots).toBe(0);
  expect(trace.filter(event => event.stage === "schedule" && event.slot === 1))
    .toMatchObject([{ intended_host_ms: 200 }, { intended_host_ms: 200 }]);
  await h.clock.advance(199.98);
  expect(starts).toEqual([0, 200.02, 400]);
  await h.controller.stop("test");
});

test("worker completion exactly on the next boundary preserves that available slot", async () => {
  const h = harness({ frequency_hz: 20 }), first = deferred<ControllerStepResult>(), starts: number[] = [];
  h.step(async () => { starts.push(h.clock.now()); return starts.length === 1 ? first.promise : decision(); });
  await begin(h); await h.clock.advance(50);
  expect(starts).toEqual([0]);
  first.resolve(decision()); await settle(); await h.clock.advance(0);
  expect(starts).toEqual([0, 50]);
  expect(h.controller.snapshot().counters.missed_slots).toBe(0);
  await h.controller.stop("test");
});

test("delayed worker delivery skips elapsed slots without overlap, catch-up or phase drift", async () => {
  const h = harness({ frequency_hz: 20 }), first = deferred<ControllerStepResult>(), starts: number[] = [];
  h.step(async () => { starts.push(h.clock.now()); return starts.length === 1 ? first.promise : decision(); });
  await begin(h); await h.clock.late(174.5);
  expect(starts).toEqual([0]);
  first.resolve(decision()); await settle();
  expect(h.controller.snapshot().counters.missed_slots).toBe(3);
  await h.clock.advance(25.25); expect(starts).toEqual([0]);
  await h.clock.advance(.25); expect(starts).toEqual([0, 200]);
  await h.clock.advance(50); expect(starts).toEqual([0, 200, 250]);
  await h.controller.stop("test");
});

test("trusted trace correlates absolute wake and actual host stages without actor data", async () => {
  const trace: ResidentTraceEvent[] = [], h = harness({ frequency_hz: 20 }, event => trace.push(event));
  const worker = deferred<ControllerStepResult>(), renewal = deferred<void>();
  h.step(() => worker.promise);
  const renew = h.channel.renew; h.channel.renew = async frame => { await renewal.promise; await renew(frame); };
  await begin(h); await h.clock.advance(7);
  worker.resolve(decision(world({ selected_hotbar: 1 }), { private_state: "not-in-trace" })); await settle();
  await h.clock.advance(3); renewal.resolve(); await settle();
  const first = trace.filter(event => event.stage !== "schedule" || event.slot === 0);
  expect(first.map(event => [event.stage, event.host_monotonic_ms])).toEqual([
    ["anchor", 0], ["schedule", 0], ["wake", 0], ["sample_request", 0], ["sample_receipt", 0],
    ["worker_start", 0], ["worker_return", 7], ["result_validation", 7], ["renewal_start", 7],
    ["renewal_end", 10], ["submission_dispatch", 10],
  ]);
  expect(trace.find(event => event.stage === "schedule")).toMatchObject({ slot: 0, intended_host_ms: 0, missed_slots: 0 });
  expect(trace.find(event => event.stage === "wake")).toMatchObject({ slot: 0, scheduled_slot: 0, intended_host_ms: 0, missed_slots: 0 });
  expect(trace.find(event => event.stage === "submission_dispatch")).toMatchObject({ slot: 0, frame_seq: 1, sequence: 1, outcome: "submitted" });
  expect(trace.find(event => event.stage === "result_validation")).toMatchObject({ frame_seq: 1, outcome: "accepted" });
  for (const [index, event] of trace.entries()) {
    expect(event).toMatchObject({ trace_sequence: index + 1, observer_errors: 0, execution_id: "resident",
      source_hash: hash, controller_generation: 1, host_clock_id: "test-monotonic",
      native_boot_id: "boot", operation_id: "resident-owner", owner_generation: 1 });
    expect(Object.keys(event).some(key => ["state", "input", "source", "frame", "intent", "wire"].includes(key))).toBe(false);
  }
  expect(h.sent.length).toBe(1);
  await h.controller.stop("test");
});

for (const outcome of ["coalesced", "rejected", "throw"] as const) {
  test(`trusted submission trace retains actual ${outcome} dispatch outcome, not an application claim`, async () => {
    const trace: ResidentTraceEvent[] = [], h = harness({}, event => trace.push(event));
    h.step(async () => decision(world({ selected_hotbar: 1 })));
    h.channel.submit = () => {
      if (outcome === "throw") throw new Error("transport unknown");
      return { sequence: 7, status: outcome, reason: outcome === "rejected" ? "native fenced" : null };
    };
    await begin(h);
    expect(trace.find(event => event.stage === "submission_dispatch")).toMatchObject({
      frame_seq: 1, sequence: outcome === "throw" ? null : 7, outcome: outcome === "throw" ? "error" : outcome,
    });
    expect(h.controller.snapshot().counters.applied_sequence).toBe(0);
    expect(h.controller.snapshot().counters.submissions).toBe(outcome === "coalesced" ? 1 : 0);
    await h.controller.stop("test");
  });
}

test("observer exceptions retain an explicit diagnostic gap without changing native authority", async () => {
  const trace: ResidentTraceEvent[] = []; let calls = 0;
  const h = harness({}, event => { if (++calls === 7) throw new Error("collector failed"); trace.push(event); });
  h.step(async () => decision(world({ selected_hotbar: 1 })));
  await begin(h);
  expect(h.controller.snapshot().status).toBe("running");
  expect(h.sent.length).toBe(1); expect(h.renewals.length).toBe(1);
  expect(trace.find(event => event.trace_sequence === 7)).toBeUndefined();
  expect(trace.find(event => event.trace_sequence === 8)?.observer_errors).toBe(1);
  await h.controller.stop("test");
});

test("stale worker delivery is traced as discarded and never renews or submits", async () => {
  const trace: ResidentTraceEvent[] = [], h = harness({}, event => trace.push(event)), worker = deferred<ControllerStepResult>();
  h.step(() => worker.promise); await begin(h); h.controller.updateIntent({ changed: true }, 0);
  worker.resolve(decision(world({ selected_hotbar: 1 }), 9)); await settle();
  expect(trace.find(event => event.stage === "result_validation")).toMatchObject({ frame_seq: 1, outcome: "discarded" });
  expect(trace.some(event => event.stage === "renewal_start" || event.stage === "submission_dispatch")).toBe(false);
  expect(h.controller.snapshot().state).toBe(0); expect(h.sent.length).toBe(0);
  await h.controller.stop("test");
});

test("late wake trace retains the scheduled deadline and skipped slots instead of relabelling lateness", async () => {
  const trace: ResidentTraceEvent[] = [], h = harness({ frequency_hz: 20 }, event => trace.push(event));
  await begin(h); await h.clock.late(151);
  expect(trace.filter(event => event.stage === "wake")).toMatchObject([
    { slot: 0, scheduled_slot: 0, intended_host_ms: 0, host_monotonic_ms: 0, missed_slots: 0 },
    { slot: 3, scheduled_slot: 1, intended_host_ms: 50, host_monotonic_ms: 151, missed_slots: 2 },
  ]);
  expect(trace.filter(event => event.stage === "schedule").at(-1)).toMatchObject({ slot: 4, intended_host_ms: 200 });
  expect(h.controller.snapshot().counters.steps).toBe(2);
  await h.controller.stop("test");
});

for (const failure of ["sample", "worker", "validation", "renewal"] as const) {
  test(`trusted trace retains an actual ${failure} failure without inventing later stages`, async () => {
    const trace: ResidentTraceEvent[] = [], h = harness({}, event => trace.push(event));
    if (failure === "sample") h.refuse(true);
    if (failure === "worker") h.step(async () => { throw new Error("worker failure"); });
    if (failure === "validation") h.step(async () => ({ ...decision(), next_state: undefined }) as unknown as ControllerStepResult);
    if (failure === "renewal") h.channel.renew = async () => { throw new Error("transport unknown"); };
    await begin(h);
    const stage = { sample: "sample_receipt", worker: "worker_return", validation: "result_validation", renewal: "renewal_end" }[failure];
    expect(trace.find(event => event.stage === stage)).toMatchObject({ outcome: "error" });
    expect(trace.some(event => event.stage === "submission_dispatch")).toBe(false);
    expect(h.controller.snapshot().counters.submissions).toBe(0);
    expect(h.controller.snapshot().counters.applied_sequence).toBe(0);
    await h.controller.stop("test");
  });
}

test("resident skips elapsed slots with one worker call in flight", async () => {
  const h = harness({ step_ms: 500 }), pending = deferred<ControllerStepResult>(); h.step(() => pending.promise); await begin(h);
  await h.clock.advance(160); expect(h.controller.snapshot().counters.steps).toBe(1);
  pending.resolve(decision(world(), 8)); await settle(); expect(h.controller.snapshot().state).toBe(8);
  expect(h.controller.snapshot().counters.missed_slots).toBe(3); await h.controller.stop("test");
});

test("intent update discards in-flight state, events and renewal without resetting budgets", async () => {
  const h = harness(), pending = deferred<ControllerStepResult>(); h.step(() => pending.promise); await begin(h);
  expect(h.controller.updateIntent({ goal: "new" }, 0)).toBe(1);
  pending.resolve({ ...decision(world(), 99), events: [{ kind: "attention", urgency: "urgent", summary: "old", details: null }] }); await settle();
  const snapshot = h.controller.snapshot(); expect(snapshot.state).toBe(0); expect(snapshot.counters.steps).toBe(1);
  expect(snapshot.counters.stale_results).toBe(1); expect(snapshot.counters.events).toBe(0); expect(h.renewals.length).toBe(0);
  expect(() => h.controller.updateIntent({}, 0)).toThrow(); await h.controller.stop("test");
});

test("source replacement fences a late result before native renewal", async () => {
  const h = harness(), pending = deferred<ControllerStepResult>(); h.step(() => pending.promise); await begin(h); h.setActive(false);
  pending.resolve(decision(world(), 42)); await settle(); expect(h.controller.snapshot().state).toBe(0);
  expect(h.controller.snapshot().counters.stale_results).toBe(1); expect(h.renewals.length).toBe(0); expect(h.controller.snapshot().cleanup.worker).toBe("closed");
});

test("duplicate native frame cannot rerun a step or renew stale control", async () => {
  const h = harness(); h.fixedFrame(1); await begin(h); await h.clock.advance(100);
  expect(h.controller.snapshot().counters.steps).toBe(1); expect(h.controller.snapshot().counters.stale_frames).toBe(2);
  expect(h.renewals.length).toBe(1); await h.controller.stop("test");
});

test("successful duplicate reads consume the separate frame allowance without spending another step", async () => {
  const h = harness({ max_frames: 2 }); h.fixedFrame(1); await begin(h); await h.clock.advance(100);
  expect(h.controller.snapshot().status).toBe("stopped");
  expect(h.controller.snapshot().counters.steps).toBe(1);
  expect(h.reads).toBe(2);
  expect(h.controller.snapshot().counters.stale_frames).toBe(1);
  await h.controller.stop("test");
});

test("read refusal retries only a fresh sample without cached frame replay", async () => {
  const h = harness(); await begin(h); h.refuse(true); await h.clock.advance(100);
  expect(h.controller.snapshot().counters.read_failures).toBe(2); expect(h.controller.snapshot().counters.steps).toBe(1);
  expect(h.renewals.length).toBe(1); h.refuse(false); await h.clock.advance(50);
  expect(h.controller.snapshot().processed_frame_seq).toBe(4); expect(h.controller.snapshot().state).toBe(2); await h.controller.stop("test");
});

test("neutral world waits count observations but not submissions or applied input", async () => {
  const h = harness(); await begin(h); await h.clock.advance(100); const snapshot = h.controller.snapshot();
  expect(snapshot.counters.steps).toBe(3); expect(snapshot.counters.no_input_decisions).toBe(3);
  expect(snapshot.counters.submissions).toBe(0); expect(snapshot.counters.applied_sequence).toBe(0); expect(snapshot.last_input).toBeNull(); await h.controller.stop("test");
});

test("empty GUI waits do not queue packets behind an unfinished gesture", async () => {
  const h = harness(); let calls = 0; const screen = { screen_id: "inventory", incarnation: 1, layout_revision: 1 };
  h.step(async () => decision({ kind: "screen", screen, operations: calls++ === 0 ? [{ kind: "close" }] : [] }));
  await begin(h); await h.clock.advance(150); const snapshot = h.controller.snapshot();
  expect(snapshot.counters.submissions).toBe(1); expect(snapshot.counters.no_input_decisions).toBe(3); expect(snapshot.pending.frames).toBe(1); await h.controller.stop("test");
});

test("view-rate stop is submitted even when the next held state is neutral", async () => {
  const h = harness(); let calls = 0; h.step(async () => decision(calls++ === 0 ? world({ view: { kind: "rate", yaw_radians_per_second: 1, pitch_radians_per_second: 0 } }) : world()));
  await begin(h); await h.clock.advance(100); expect(h.controller.snapshot().counters.submissions).toBe(2);
  expect(h.sent[1]?.input).toEqual(world()); expect(h.controller.snapshot().counters.no_input_decisions).toBe(1); await h.controller.stop("test");
});

test("processed state never fabricates application and ACK age uses native capture clock", async () => {
  const h = harness(); h.step(async () => decision(world({ view: { kind: "delta", yaw_radians: .1, pitch_radians: 0 } }), 12));
  await begin(h); expect(h.controller.snapshot().state).toBe(12); expect(h.controller.snapshot().counters.applied_sequence).toBe(0);
  h.ack(1, "9000000"); const snapshot = h.controller.snapshot(); expect(snapshot.counters.applied_sequence).toBe(1);
  expect(snapshot.timings.input_age_ms.p50).toBe(9); expect(snapshot.last_input?.sequence).toBe(1); await h.controller.stop("test");
});

test("unknown ACK is retained without claiming confirmed application", async () => {
  const h = harness(); h.step(async () => decision(world({ selected_hotbar: 1 }))); await begin(h); h.ack(1, "1000000", "unknown");
  expect(h.controller.snapshot().last_input?.input_application).toBe("unknown"); expect(h.controller.snapshot().timings.input_age_ms.count).toBe(0); await h.controller.stop("test");
});

test("root deadline remains admission-time bound even when native open is slow", async () => {
  const h = harness(), readiness = deferred<void>(); h.opening(readiness.promise);
  h.clock.time = 9990; const starting = h.controller.start(); await h.clock.advance(10);
  expect(h.controller.snapshot().status).toBe("stopping"); expect(h.controller.snapshot().cleanup.worker).toBe("closed");
  readiness.resolve(); await starting; await settle();
  expect(h.controller.snapshot().cleanup.worker).toBe("closed"); expect(h.controller.snapshot().status).toBe("stopped");
  expect(h.controller.snapshot().counters.steps).toBe(0); expect(h.controller.snapshot().cleanup.native).toBe("retired");
});

test("stop remains pending until actual worker and native retirement barriers", async () => {
  const h = harness(), worker = deferred<void>(), native = deferred<void>(); h.close(() => worker.promise); h.revoke(() => native.promise);
  await begin(h); let stopped = false; const stopping = h.controller.stop("operator").then(() => { stopped = true; }); await settle();
  expect(h.controller.snapshot().status).toBe("stopping"); await h.clock.advance(100); expect(h.controller.snapshot().counters.steps).toBe(1);
  worker.resolve(); await settle(); expect(stopped).toBe(false); native.resolve(); await stopping;
  expect(h.controller.snapshot().cleanup).toEqual({ worker: "closed", native: "retired" }); expect(h.workerClosed).toBe(1);
  await h.controller.stop("again"); expect(h.workerClosed).toBe(1);
});

for (const ordering of ["result-fence-stop", "fence-result-stop", "stop-result-fence"] as const) {
  test(`lifecycle boundary ${ordering} preserves admitted effects and rejects late publication`, async () => {
    const h = harness(), result = deferred<ControllerStepResult>(), worker = deferred<void>(), native = deferred<void>();
    h.step(() => result.promise); h.close(() => worker.promise); h.revoke(() => native.promise);
    await begin(h);
    const output = { ...decision(world({ edges: [{ kind: "hand_swap" }] }), { accepted: true }),
      events: [{ kind: "attention" as const, urgency: "urgent" as const, summary: "step result", details: null }] };
    let stopped = false, stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= h.controller.stop("operator").then(() => { stopped = true; }); };
    for (const boundary of ordering.split("-")) {
      if (boundary === "result") result.resolve(output);
      if (boundary === "fence") h.lifecycle.fence("space_changed");
      if (boundary === "stop") stop();
      await settle();
    }
    const admitted = ordering === "result-fence-stop" ? 1 : 0;
    expect(h.controller.snapshot().state).toEqual(admitted ? { accepted: true } : 0);
    expect(h.controller.snapshot().counters).toMatchObject({ submissions: admitted, expanded_edges: admitted, events: admitted });
    expect(h.sent.map(entry => entry.input)).toEqual(admitted ? [output.input] : []);
    expect(h.renewals.length).toBe(admitted);
    expect(stopped).toBe(false);
    // Neither barrier alone is sufficient, including native-before-worker.
    native.resolve(); await settle(); expect(stopped).toBe(false);
    worker.resolve(); await stopping;
    expect(h.controller.snapshot().cleanup).toEqual({ worker: "closed", native: "retired" });
    await h.clock.advance(100);
    expect(h.sent.length).toBe(admitted);
    expect(h.controller.snapshot().counters.steps).toBe(1);
  });
}

test("arbiter fence drains worker without recursively requiring native retirement", async () => {
  const h = harness(), worker = deferred<void>(); h.close(() => worker.promise); await begin(h);
  h.lifecycle.fence("life"); let drained = false; const draining = h.lifecycle.drain().then(() => { drained = true; }); await settle();
  expect(h.controller.snapshot().cleanup.worker).toBe("closing"); expect(drained).toBe(false);
  worker.resolve(); await draining; expect(drained).toBe(true); await h.controller.stop("life");
});

test("worker exception stops rather than retrying a failed authored step", async () => {
  const h = harness(); h.step(async () => { throw new Error("authored failure"); }); await begin(h); await h.clock.advance(100);
  expect(h.controller.snapshot().status).toBe("failed"); expect(h.controller.snapshot().counters.steps).toBe(1); expect(h.renewals.length).toBe(0);
});

for (const status of ["blocked", "yielded", "completed"] as const) test(`authored ${status} closes only its resident execution`, async () => {
  const h = harness(); h.step(async () => ({ ...decision(world(), 3), status })); await begin(h);
  expect(h.controller.snapshot().status).toBe(status); expect(h.controller.snapshot().state).toBe(3);
  expect(h.controller.snapshot().cleanup).toEqual({ worker: "closed", native: "retired" }); expect(h.renewals.length).toBe(0);
});

test("cumulative step budget is not replenished by intent updates", async () => {
  const h = harness({ max_steps: 2 }); await begin(h); h.controller.updateIntent({}, 0); await h.clock.advance(100);
  expect(h.controller.snapshot().counters.steps).toBe(2); expect(h.controller.snapshot().cleanup.worker).toBe("closed");
});

test("event and edge budgets reject whole over-budget decisions before effects", async () => {
  const h = harness({ max_edges: 0 }); h.step(async () => decision(world({ edges: [{ kind: "hand_swap" }] }), 55)); await begin(h);
  expect(h.controller.snapshot().state).toBe(0); expect(h.controller.snapshot().counters.submissions).toBe(0); expect(h.controller.snapshot().status).toBe("failed");
  const e = harness({ max_events: 0 }); e.step(async () => ({ ...decision(world(), 55), events: [{ kind: "diagnostic", urgency: "ordinary", summary: "event", details: null }] }));
  await begin(e); expect(e.controller.snapshot().state).toBe(0); expect(e.controller.snapshot().counters.events).toBe(0);
});

test("analysis runs alongside stepping and stale intent results retain provenance", async () => {
  const h = harness(), job = deferred<Json>(); h.analysis(async (_s, _i, _b, _signal, report) => { const output = await job.promise; report(100); return output; }); await begin(h);
  const result = h.controller.analyze(analysisSource, { query: 1 }, 0); await settle(); await h.clock.advance(100);
  expect(h.controller.snapshot().counters.steps).toBe(3); expect(h.controller.snapshot().pending.analysis).toBe(true);
  h.controller.updateIntent({}, 0); job.resolve({ answer: 7 }); const done = await result;
  expect(done.status).toBe("stale"); expect(done.output).toEqual({ answer: 7 }); expect(done.input_version).toBe(0);
  expect(done.controller_execution_id).toBe("resident"); expect(done.source).toEqual({ skill_id: "pure-analysis", version: 1, hash }); await h.controller.stop("test");
});

test("analysis enforces one live job and cumulative elapsed allowance", async () => {
  const h = harness({ analysis_job_ms: 80, max_analysis_ms: 100 }), first = deferred<Json>(); h.analysis(async (_s, _i, budget, _signal, report) => {
    if (budget !== 80) throw new Error("wrong first allowance"); const output = await first.promise; report(60); return output; }); await begin(h);
  const running = h.controller.analyze(analysisSource, null, 0); await settle();
  await expect(h.controller.analyze(analysisSource, null, 0)).rejects.toThrow(); await h.clock.advance(60); first.resolve(null); await running;
  h.analysis(async (_s, _i, budget, _signal, report) => { expect(budget).toBe(40); await h.clock.advance(40); report(40); return null; }); await h.controller.analyze(analysisSource, null, 0);
  expect(h.controller.snapshot().counters.analysis_ms).toBe(100); await expect(h.controller.analyze(analysisSource, null, 0)).rejects.toThrow(); await h.controller.stop("test");
});

test("stop aborts analysis but does not forge its drain completion", async () => {
  const h = harness(), job = deferred<Json>(); let signal: AbortSignal | null = null;
  h.analysis(async (_s, _i, _b, abort, report) => { signal = abort; const output = await job.promise; report(1); return output; }); await begin(h);
  const result = h.controller.analyze(analysisSource, null, 0); await settle(); let stopped = false;
  const stopping = h.controller.stop("operator").then(() => { stopped = true; }); await settle();
  expect((signal as AbortSignal | null)?.aborted).toBe(true); expect(stopped).toBe(false); job.resolve({ late: true });
  expect((await result).status).toBe("cancelled"); await stopping; expect(stopped).toBe(true);
});

test("snapshots detach authored state and aggregate notifications", async () => {
  const h = harness({ max_steps: 1000 });
  h.step(async () => decision(world(), { nested: [1] })); await begin(h);
  const first = h.controller.snapshot();
  if (first.state !== null && typeof first.state === "object" && !Array.isArray(first.state) && Array.isArray(first.state.nested)) first.state.nested.push(9);
  expect(h.controller.snapshot().state).toEqual({ nested: [1] }); await h.clock.advance(1000);
  expect(h.changes.length).toBeLessThan(15); await h.controller.stop("test");
});

test("1Hz genuinely expires the short native lease instead of receiving host heartbeats", async () => {
  const h = harness({ frequency_hz: 1 }); h.lease(); await begin(h); await h.clock.advance(1100);
  expect(h.controller.snapshot().counters.steps).toBe(1); expect(h.renewals.length).toBe(1);
  expect(h.controller.snapshot().reason).toBe("native_lease_expired"); expect(h.controller.snapshot().status).toBe("stopped");
});

test("persistent read unavailability reaches native expiry without stale renewal", async () => {
  const h = harness(); h.lease(); await begin(h); h.refuse(true); await h.clock.advance(300);
  expect(h.controller.snapshot().counters.read_failures).toBe(4); expect(h.renewals.length).toBe(1);
  expect(h.controller.snapshot().cleanup.native).toBe("retired");
});

test("guarded step result can cross a host scheduling delay without spending another compute allowance", async () => {
  const h = harness(), pending = deferred<ControllerStepResult>(); h.step(() => pending.promise);
  await begin(h); await h.clock.advance(60);
  expect(h.controller.snapshot().status).toBe("running"); expect(h.renewals).toEqual([]);
  pending.resolve(decision(world({ selected_hotbar: 2 }), { guarded: true })); await settle();
  expect(h.controller.snapshot().state).toEqual({ guarded: true });
  expect(h.sent.map(entry => entry.input)).toEqual([world({ selected_hotbar: 2 })]);
  await h.controller.stop("test");
});

test("step response deadline fences immediately but waits for actual compute closure", async () => {
  const h = harness(), pending = deferred<ControllerStepResult>(); h.step(() => pending.promise);
  const closed = deferred<void>(); h.close(() => closed.promise); await begin(h); await h.clock.advance(500);
  expect(h.controller.snapshot().status).toBe("stopping"); expect(h.controller.snapshot().cleanup.worker).toBe("closing");
  pending.resolve(decision(world(), 999)); closed.resolve(); await settle();
  expect(h.controller.snapshot().status).toBe("failed"); expect(h.controller.snapshot().state).toBe(0); expect(h.renewals.length).toBe(0);
});

test("wrong-life frame fences the execution without admitting a step", async () => {
  const h = harness(); h.transform(frame => {
    frame.life_id = 99; frame.view.crosshair.target.life_id = 99; frame.visible_world.blocks[0]!.target.life_id = 99;
    return frame;
  });
  await begin(h); expect(h.controller.snapshot().counters.steps).toBe(0);
  expect(h.controller.snapshot().status).toBe("stopped"); expect(h.controller.snapshot().cleanup.native).toBe("retired");
});

test("unknown retirement effects keep the original input after stop has fenced callbacks", async () => {
  const h = harness(); const input: ControllerInput = { kind: "screen", screen: { screen_id: "inventory", incarnation: 1, layout_revision: 1 }, operations: [{ kind: "close" }] };
  h.step(async () => decision(input)); await begin(h); const native = deferred<void>(); h.revoke(() => native.promise);
  const stopping = h.controller.stop("operator"); await settle();
  h.effect({ controller_generation: 1, sequence: 1, recorded_native_ns: "1000000", result: { status: "unknown", summary: "lost receipt", evidence: null } });
  expect(h.effects).toHaveLength(1); expect(h.effects[0]?.input).toEqual(input); expect(h.effects[0]?.event.result.status).toBe("unknown");
  native.resolve(); await stopping; expect(h.controller.snapshot().cleanup.native).toBe("retired");
});

test("failed native retirement stays unknown even though the worker is contained", async () => {
  const h = harness(); await begin(h); h.revoke(async () => { throw new Error("missing retirement barrier"); }); await h.controller.stop("operator");
  expect(h.controller.snapshot().cleanup).toEqual({ worker: "closed", native: "unknown" }); expect(h.controller.snapshot().status).toBe("unknown");
});

test("analysis compilation wall time does not consume guarded evaluation allowance", async () => {
  const h = harness({ max_analysis_ms: 100 }); await begin(h);
  h.analysis(async (_source, _input, _budget, _signal, report) => { await h.clock.advance(1000); report(7); return { pure: true }; });
  const result = await h.controller.analyze(analysisSource, null, 0);
  expect(result.status).toBe("completed"); expect(result.elapsed_ms).toBe(7); expect(h.controller.snapshot().counters.analysis_ms).toBe(7);
  expect(h.controller.snapshot().counters.steps).toBe(21); await h.controller.stop("test");
});

test("post-evaluation interval observes service settlement separately from guarded computation", async () => {
  const h = harness(); await begin(h);
  h.analysis(async (_source, _input, _budget, _signal, report) => {
    await h.clock.advance(100); report(7); await h.clock.advance(60); throw new Error("evaluation failed");
  });
  const result = await h.controller.analyze(analysisSource, null, 0);
  expect(result.status).toBe("failed"); expect(result.elapsed_ms).toBe(7);
  expect(result.post_evaluation_ms).toBe(60);
  expect(h.controller.snapshot().counters.analysis_ms).toBe(7);
  await h.controller.stop("test");
});

test("compile rejection has no post-evaluation interval and does not invent compute time", async () => {
  const h = harness(); await begin(h);
  h.analysis(async () => { await h.clock.advance(100); throw new Error("compile failed"); });
  const result = await h.controller.analyze(analysisSource, null, 0);
  expect(result.status).toBe("failed"); expect(result.post_evaluation_ms).toBeNull();
  expect(h.controller.snapshot().counters.analysis_ms).toBe(0);
  expect(h.controller.snapshot().status).toBe("running");
  await h.controller.stop("test");
});

for (const report of [
  (callback: (ms: number) => void) => { callback(7); callback(0); },
  (callback: (ms: number) => void) => { callback(Number.MAX_SAFE_INTEGER + 1); },
]) test("duplicate or unsafe evaluation report fences accounting without resetting its charge", async () => {
  const h = harness(); await begin(h);
  h.analysis(async (_source, _input, _budget, _signal, callback) => { report(callback); throw new Error("evaluation failed"); });
  const result = await h.controller.analyze(analysisSource, null, 0); await settle();
  expect(result.status).toBe("failed"); expect(h.controller.snapshot().status).toBe("failed");
  expect(h.controller.snapshot().counters.analysis_ms).toBeLessThanOrEqual(7);
});

test("retained timing samples and events disclose omissions without unbounded history", async () => {
  const h = harness({ max_steps: 1000, max_events: 1000 });
  h.clock.time = -30000;
  h.step(async () => ({ ...decision(world(), { safe: true }), events: [{ kind: "diagnostic", urgency: "ordinary", summary: "sample", details: { values: [1] } }] }));
  await begin(h); await h.clock.advance(26000); const snapshot = h.controller.snapshot();
  expect(snapshot.counters.steps).toBe(521); expect(snapshot.timings.step_ms.count).toBe(521); expect(snapshot.timings.step_ms.omitted_samples).toBe(9);
  expect(snapshot.counters.events).toBe(521); expect(snapshot.events).toHaveLength(128); expect(snapshot.events[0]?.sequence).toBe(394);
  const event = snapshot.events[0]!.event; event.summary = "mutated";
  expect(h.controller.snapshot().events[0]?.event.summary).toBe("sample"); await h.controller.stop("test");
});

test("edge rate allowance recovers only after its actual rolling second", async () => {
  const h = harness({ max_edges_per_second: 1 }); h.step(async () => decision(world({ edges: [{ kind: "hand_swap" }] })));
  await begin(h); await h.clock.advance(50); expect(h.controller.snapshot().status).toBe("failed");
  expect(h.controller.snapshot().counters.expanded_edges).toBe(1); expect(h.controller.snapshot().counters.submissions).toBe(1);
});

test("explicit selection and persistent held declarations are never skipped as neutral waits", async () => {
  const h = harness(); let count = 0; h.step(async () => decision(world({ held: { ...neutral, forward: true },
    edges: count++ === 0 ? [{ kind: "button", button: "forward", phase: "press", count: 1 }] : [], selected_hotbar: 2 })));
  await begin(h); await h.clock.advance(50); expect(h.controller.snapshot().counters.submissions).toBe(2);
  expect(h.controller.snapshot().counters.no_input_decisions).toBe(0); await h.controller.stop("test");
});

test("old-intent worker rejection cannot fault the replacement intent", async () => {
  const h = harness(), pending = deferred<ControllerStepResult>(); h.step(() => pending.promise); await begin(h);
  h.controller.updateIntent({ new: true }, 0); pending.reject(new Error("old step failed")); await settle();
  expect(h.controller.snapshot().status).toBe("running"); expect(h.controller.snapshot().counters.stale_results).toBe(1);
  h.step(async () => decision(world(), 6)); await h.clock.advance(50); expect(h.controller.snapshot().state).toBe(6); await h.controller.stop("test");
});

test("held state cannot change without the authored ordered transition", async () => {
  const h = harness(); h.step(async () => decision(world({ held: { ...neutral, attack: true } }), 6)); await begin(h);
  expect(h.controller.snapshot().status).toBe("failed"); expect(h.controller.snapshot().state).toBe(0); expect(h.renewals).toHaveLength(0);
});

test("frame budget remains cumulative even when intent versions change", async () => {
  const h = harness({ max_frames: 1 }); await begin(h); h.controller.updateIntent({ new: true }, 0); await h.clock.advance(50);
  expect(h.controller.snapshot().counters.steps).toBe(1); expect(h.controller.snapshot().status).toBe("stopped");
});

test("analysis transport bounds do not inherit the smaller control state bound", async () => {
  const h = harness(); await begin(h);
  h.analysis(async (_source, input, _budget, _signal, report) => { report(1); return input; });
  const result = await h.controller.analyze(analysisSource, { text: "x".repeat(20000) }, 0);
  expect(result.status).toBe("completed"); expect(result.output).toEqual({ text: "x".repeat(20000) }); await h.controller.stop("test");
});

test("analysis job limit is cumulative across explicit intent changes", async () => {
  const h = harness({ max_analysis_jobs: 1 }); await begin(h); await h.controller.analyze(analysisSource, null, 0);
  h.controller.updateIntent({}, 0); await expect(h.controller.analyze(analysisSource, null, 1)).rejects.toThrow();
  expect(h.controller.snapshot().counters.analysis_jobs).toBe(1); await h.controller.stop("test");
});

test("invalid trusted evaluation accounting fails closed without poisoning finite counters", async () => {
  const h = harness(); await begin(h);
  h.analysis(async (_source, _input, _budget, _signal, report) => { report(Number.NaN); return null; });
  const result = await h.controller.analyze(analysisSource, null, 0); await settle();
  expect(result.status).toBe("failed"); expect(h.controller.snapshot().counters.analysis_ms).toBe(0);
  expect(h.controller.snapshot().status).toBe("failed");
});

test("increasing frame IDs cannot smuggle regressed native observation time", async () => {
  const h = harness(); let reads = 0; h.transform(frame => {
    if (++reads > 1) frame.native_tick = 0;
    return frame;
  });
  await begin(h); await h.clock.advance(50); expect(h.controller.snapshot().counters.steps).toBe(1);
  expect(h.controller.snapshot().counters.stale_frames).toBe(1); expect(h.renewals).toHaveLength(1); await h.controller.stop("test");
});
