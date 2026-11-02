import { expect, test } from "bun:test";
import { controllerStepResultSchema, residentActorLimitsSchema, residentLimitsSchema,
  residentStateSchema, residentIntentSchema } from "../src/shared/resident.ts";
import { programRunSchema, programSubmitSchema, programWriteSchema } from "../src/server/program-interface.ts";
import { skillStartRequestSchema } from "../src/shared/validation.ts";

const neutral = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
const result = () => ({ input: { kind: "world", held: { ...neutral }, edges: [],
  view: { kind: "unchanged" }, selected_hotbar: null }, next_state: { observations_processed: 1 },
  status: "running", events: [] });

test("actor-selected entries cannot exchange playing and pure-analysis authority or budgets", () => {
  const source = "export function step(frame,state,intent) { return null; }";
  expect(programWriteSchema.parse({ name: "legacy-body", source: "return null;" }).entry).toBe("run");
  expect(programWriteSchema.parse({ name: "resident", entry: "step", source }).entry).toBe("step");
  const step = { operation: "start", entry: "step", name: "resident", args: { goal: "wait" }, initial_state: null };
  const parsed = programRunSchema.parse(step);
  expect(parsed).toMatchObject({ entry: "step", limits: { frequency_hz: 20, step_ms: 25 } });
  expect(programRunSchema.safeParse({ ...step, limits: { max_actions: 1 } }).success).toBe(false);
  expect(programRunSchema.safeParse({ operation: "start", entry: "analyze", name: "pure", args: null }).success).toBe(false);
  expect(programSubmitSchema.safeParse({ name: "pure", source, entry: "analyze", args: null }).success).toBe(false);
  expect(programRunSchema.safeParse({ operation: "update_intent", target: "current", expected_version: 1, intent: {} }).success).toBe(true);
  expect(programRunSchema.safeParse({ operation: "analyze", name: "pure", target: "current", input: {}, expected_intent_version: 1 }).success).toBe(true);
  // Internal durable admission has no default selected entry: historical/missing
  // metadata must not become a newly authorized playing program.
  const request = { skill_id: "source", version: 1, start_key: "start", epoch: 1,
    session_id: "session", life_id: 1, native_boot_id: "boot", space_epoch: 1, run_generation: 1,
    compatibility_hash: "a".repeat(64), args: null };
  expect(skillStartRequestSchema.safeParse(request).success).toBe(false);
  expect(skillStartRequestSchema.safeParse({ ...request, entry: "analyze", limits: residentActorLimitsSchema.parse({}) }).success).toBe(false);
});

// Catch implicit status/state/input defaults that would turn a malformed authored decision into live control.
test("resident result requires explicit coherent input and JSON state rather than a policy decision", () => {
  expect(controllerStepResultSchema.safeParse(result()).success).toBe(true);
  for (const field of ["input", "next_state", "status", "events"]) {
    const incomplete: Record<string, unknown> = result(); delete incomplete[field];
    expect(controllerStepResultSchema.safeParse(incomplete).success).toBe(false);
  }
  expect(controllerStepResultSchema.safeParse({ ...result(), action: { kind: "look", yaw: 0, pitch: 0 } }).success).toBe(false);
  expect(controllerStepResultSchema.safeParse({ ...result(), input: { ...result().input, target: "hidden-target" } }).success).toBe(false);
});

test("resident states use actual JSON bytes and reject a nonserializable or too-deep state", () => {
  expect(residentStateSchema.safeParse("x".repeat(16382)).success).toBe(true);
  expect(residentStateSchema.safeParse("x".repeat(16383)).success).toBe(false);
  expect(residentIntentSchema.safeParse("é".repeat(8191)).success).toBe(true);
  expect(residentIntentSchema.safeParse("é".repeat(8192)).success).toBe(false);
  let state: unknown = 0;
  for (let depth = 0; depth < 33; depth++) state = [state];
  expect(residentStateSchema.safeParse(state).success).toBe(false);
  for (const invalid of [undefined, NaN, Infinity, 1n, { fn: () => 1 }, { value: undefined }])
    expect(residentStateSchema.safeParse(invalid).success).toBe(false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(residentStateSchema.safeParse(cyclic).success).toBe(false);
});

test("state validation rejects accessors without executing generated behavior on the host", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { calls++; throw new Error("Must stay out of host validation"); } });
  expect(residentStateSchema.safeParse(getter).success).toBe(false);
  expect(calls).toBe(0);
  const toJSON = { toJSON() { calls++; return {}; } };
  expect(residentStateSchema.safeParse(toJSON).success).toBe(false);
  expect(calls).toBe(0);
});

test("resident events and the complete decision stay bounded independently of state", () => {
  const event = { kind: "diagnostic", urgency: "ordinary", summary: "Visible condition changed", details: null };
  expect(controllerStepResultSchema.safeParse({ ...result(), events: Array.from({ length: 16 }, () => event) }).success).toBe(true);
  expect(controllerStepResultSchema.safeParse({ ...result(), events: Array.from({ length: 17 }, () => event) }).success).toBe(false);
  expect(controllerStepResultSchema.safeParse({ ...result(), events: [{ ...event, summary: "" }] }).success).toBe(false);
  expect(controllerStepResultSchema.safeParse({ ...result(), events: [{ ...event, details: "x".repeat(65536) }] }).success).toBe(false);
  expect(controllerStepResultSchema.safeParse({ ...result(), status: "operator_task_succeeded" }).success).toBe(false);
});

test("resident limits normalize at actor ingress but never borrow taskflow actions or calls", () => {
  const limits = residentActorLimitsSchema.parse({ duration_ms: 150000, frequency_hz: 20 });
  expect(residentLimitsSchema.safeParse(limits).success).toBe(true);
  expect(residentLimitsSchema.safeParse({ duration_ms: 150000, frequency_hz: 20 }).success).toBe(false);
  for (const extra of [{ max_actions: 64 }, { max_calls: 256 }, { max_depth: 8 }])
    expect(residentActorLimitsSchema.safeParse({ ...limits, ...extra }).success).toBe(false);
  for (const frequency_hz of [1, 5, 20]) expect(residentActorLimitsSchema.safeParse({ frequency_hz }).success).toBe(true);
  for (const invalid of [{ frequency_hz: 0 }, { frequency_hz: 100 }, { duration_ms: Infinity },
    { duration_ms: 57600001 }, { step_ms: 501 }, { max_frames: 0 }, { max_edges: -1 },
    { max_edges_per_second: 257 }, { max_analysis_jobs: -1 }, { analysis_job_ms: 5001 }])
    expect(residentActorLimitsSchema.safeParse(invalid).success).toBe(false);
});
