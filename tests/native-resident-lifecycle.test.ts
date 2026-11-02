import { expect, test, vi } from "bun:test";
import * as resident from "../scripts/native-resident.ts";
import type { SkillExecutionView } from "../src/shared/programs.ts";
import { DEFAULT_RESIDENT_LIMITS, type ResidentSnapshot, type ResidentTimingSummary } from "../src/shared/resident.ts";
import { revocationAckSchema } from "../src/shared/controller.ts";
import { sha256Schema, type EffectScope } from "../src/shared/control.ts";

// Replacing the awaited close with Promise.race would let the public smoke
// finish (and close its Store) before these actual cleanup promises settle.
for (const rejects of [false, true]) {
  test(`resident cleanup remains owned after its deadline until ${rejects ? "rejection" : "completion"}`, async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const gate = Promise.withResolvers<void>();
    const cleanupError = new Error("External worker removal failed");
    let drained = false, settled = false;
    const operation = gate.promise.then(() => { drained = true; if (rejects) throw cleanupError; });
    const outcome = resident.joinResidentCleanup(operation, 10, "Resident cleanup exceeded its allowance")
      .then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      clock.mockReturnValue(35); vi.advanceTimersByTime(35);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      expect(drained).toBe(false);
      gate.resolve();
      const error = await outcome;
      expect(drained).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Resident cleanup exceeded its allowance");
      if (rejects) expect((error as Error).cause).toBe(cleanupError);
    } finally { gate.resolve(); clock.mockRestore(); vi.useRealTimers(); }
  });
}

test("timely resident cleanup preserves the actual rejection", async () => {
  const failure = new Error("Worker ownership remains unknown");
  const deadline = performance.now() + 1000;
  const observed = await resident.joinResidentCleanup(Promise.reject(failure), deadline, "Late cleanup")
    .then(() => null, error => error);
  expect(observed).toBe(failure);
});

for (const held of [false, true]) test(`resident cleanup keeps the original deadline when joined later: held=${held}`, async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const gate = Promise.withResolvers<void>();
  const operation = held ? gate.promise : Promise.resolve();
  const deadline = performance.now() + 10;
  clock.mockReturnValue(35);
  let settled = false;
  const outcome = resident.joinResidentCleanup(operation, deadline, "Original Stop cleanup deadline exceeded")
    .then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    if (held) expect(settled).toBe(false);
    gate.resolve();
    expect(await outcome).toBeInstanceOf(Error);
  } finally { gate.resolve(); clock.mockRestore(); }
});

function faultEvidence() {
  const hash = sha256Schema.parse("a".repeat(64));
  const scope: EffectScope = { session_id: "session", world_id: "world", epoch: 1, native_boot_id: "boot",
    run_id: "run", run_generation: 2, life_id: 1, space_epoch: 3, execution_id: "root", source_hash: hash };
  const emptyTiming = (): ResidentTimingSummary => ({ count: 0, p50: null, p95: null, p99: null, max: null, omitted_samples: 0 });
  const snapshot: ResidentSnapshot = {
    execution_id: "root", source_hash: hash, controller_generation: 1, host_clock_id: "fixture",
    status: "running", reason: null, intent_version: 0, state: null,
    processed_frame_seq: 3, processed_native_tick: 3, processed_native_ns: "300",
    counters: { frames: 3, steps: 3, submissions: 3, applied_sequence: 3, ordered_edge_prefix: 1,
      missed_slots: 0, stale_results: 0, stale_frames: 0, read_failures: 0, no_input_decisions: 0,
      expanded_edges: 1, events: 0, analysis_jobs: 0, analysis_ms: 0 },
    pending: { frames: 0, edges: 0, analysis: false },
    last_input: { controller_generation: 1, sequence: 3, ordered_edge_prefix: 1, applied_native_tick: 3, applied_native_ns: "300",
      held: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: true },
      applied_pose: { yaw_radians: 0, pitch_radians: 0 }, input_application: "confirmed", reason: null },
    timings: { step_ms: emptyTiming(), input_age_ms: emptyTiming() }, events: [], cleanup: { worker: "open", native: "open" },
  };
  const original: Extract<SkillExecutionView, { entry: "step" }> = {
    ...scope, entry: "step", skill_id: "skill", version: 1, start_key: "start", parent_execution_id: null,
    root_execution_id: "root", compatibility_hash: hash, args: null, limits: { ...DEFAULT_RESIDENT_LIMITS }, initial_state: null,
    resident: snapshot, status: "running", started_at: "2026-01-01T00:00:00.000Z", ended_at: null,
    deadline_at: "2026-01-01T00:01:00.000Z", actions: 0, calls: 0, result: null, error: null,
  };
  const terminal = structuredClone(original);
  terminal.status = "cancelled"; terminal.ended_at = "2026-01-01T00:00:01.000Z";
  terminal.resident!.status = "stopped"; terminal.resident!.reason = "admission_revoked";
  terminal.resident!.cleanup = { worker: "closed", native: "retired" };
  terminal.resident!.counters.submissions = 6; terminal.resident!.counters.applied_sequence = 4;
  terminal.resident!.last_input!.sequence = 4;
  const grant = { owner: { operation_id: "original-controller", generation: 7, scope: structuredClone(scope) },
    controller_generation: 1, granted_host_ms: 0 };
  const ack = revocationAckSchema.parse({ owner: grant.owner, controller_generation: 1, admission_revoked: true,
    last_applied_sequence: 5, ordered_edge_prefix: 1, retirement_applied_native_tick: 6, retirement_applied_native_ns: "600",
    input_application: "confirmed", unresolved_operation_refs: ["original-controller"] });
  return { original, terminal, grant, ack };
}

test("scope-fault evidence allows legitimate old-scope application advances before retirement", () => {
  const f = faultEvidence();
  expect(resident.assertResidentFaultRetirement(f.original, f.terminal, f.grant, f.ack).application_sequence_advance).toBe(2);
});

for (const mutate of [
  (f: ReturnType<typeof faultEvidence>) => { f.original.status = "failed"; },
  (f: ReturnType<typeof faultEvidence>) => { f.original.resident!.status = "failed"; },
  (f: ReturnType<typeof faultEvidence>) => { f.original.resident!.last_input!.held.use = false; },
  (f: ReturnType<typeof faultEvidence>) => { f.terminal.status = "failed"; },
  (f: ReturnType<typeof faultEvidence>) => { f.terminal.resident!.controller_generation = 2; },
  (f: ReturnType<typeof faultEvidence>) => { f.terminal.resident!.counters.ordered_edge_prefix = 0; },
  (f: ReturnType<typeof faultEvidence>) => { f.terminal.resident!.counters.ordered_edge_prefix = 2; },
  (f: ReturnType<typeof faultEvidence>) => { f.terminal.resident!.counters.applied_sequence = 2; },
  (f: ReturnType<typeof faultEvidence>) => { f.grant.owner.generation = 8; },
  (f: ReturnType<typeof faultEvidence>) => { f.ack.owner.operation_id = "foreign-controller"; },
  (f: ReturnType<typeof faultEvidence>) => { f.ack.controller_generation = 2; },
  (f: ReturnType<typeof faultEvidence>) => { f.ack.ordered_edge_prefix = 2; },
  (f: ReturnType<typeof faultEvidence>) => { f.ack.last_applied_sequence = 2; },
  (f: ReturnType<typeof faultEvidence>) => { f.ack.unresolved_operation_refs = []; },
]) test("scope-fault evidence refuses a competing termination or corrupted owner/application proof", () => {
  const f = faultEvidence(); mutate(f);
  expect(() => resident.assertResidentFaultRetirement(f.original, f.terminal, f.grant, f.ack)).toThrow();
});

for (const [field, replacement] of [
  ["session_id", "foreign-session"], ["world_id", "foreign-world"], ["epoch", 2], ["native_boot_id", "foreign-boot"],
  ["run_id", "foreign-run"], ["run_generation", 3], ["life_id", 2], ["space_epoch", 4],
  ["execution_id", "foreign-root"], ["source_hash", "b".repeat(64)],
] as const) for (const target of ["terminal", "grant", "ack"] as const) {
  test(`scope-fault evidence rejects ${target} ${field} relabeling`, () => {
    const f = faultEvidence();
    Reflect.set(target === "terminal" ? f.terminal : f[target].owner.scope, field, replacement);
    expect(() => resident.assertResidentFaultRetirement(f.original, f.terminal, f.grant, f.ack)).toThrow();
  });
}
