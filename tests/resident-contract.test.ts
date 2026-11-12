import { expect, test } from "bun:test";
import {
    controllerStepResultSchema, residentActorLimitsSchema, residentLimitsSchema,
    residentStateSchema, residentIntentSchema, residentJsonConstraint
} from "../src/shared/resident.ts";
import { programRunSchema, programSubmitSchema } from "../src/server/program-interface.ts";
import { skillStartRequestSchema } from "../src/shared/validation.ts";
import { controllerInputFrameSchema, controllerInputSchema } from "../src/shared/controller.ts";
import { z } from "zod";
import {
    GeneratedControllerResultValidationError, parseGeneratedResidentResult, programDiagnostic,
    readProgramDiagnostic
} from "../src/server/program-diagnostics.ts";
import { preparationFailure } from "../src/server/prepared-source-error.ts";
import { ResidentWorkerFault, residentSourceAdvisory } from "../src/server/sandbox.ts";

const neutral = { forward: false, back: false, left: false, right: false, jump: false,
  sprint: false, sneak: false, attack: false, use: false };
const result = () => ({ input: { kind: "world", held: { ...neutral }, edges: [],
  view: { kind: "unchanged" }, selected_hotbar: null }, next_state: { observations_processed: 1 },
  status: "running", events: [] });

test("only a branded detached source diagnostic is projected as untrusted preparation advice", () => {
  const diagnostic = { type: "TypeError", message: "assertion: explicit state required",
    source_hash: "a".repeat(64), location: { mapping: "unmapped" } };
  const fault = new ResidentWorkerFault("source_throw", false, diagnostic);
  diagnostic.message = "PRIVATE_MUTATED_HOST_VALUE"; diagnostic.location.mapping = "PRIVATE_MAPPING";
  Reflect.set(fault, "message", "PRIVATE_HOST_ERROR");
  expect(preparationFailure(fault)).toMatchObject({ code: "source_throw",
    source_diagnostic: { advisory: true, trusted_origin: false, origin: "source_throw", diagnostic: {
      type: "TypeError", message: "assertion: explicit state required", source_hash: "a".repeat(64),
      location: { mapping: "unmapped" },
    } } });
  expect(JSON.stringify(preparationFailure(fault))).not.toContain("PRIVATE");
  expect(fault.sourceDiagnostic?.message).toBe("assertion: explicit state required");
  const projected = residentSourceAdvisory(fault)!;
  Reflect.set(projected.diagnostic, "message", "PRIVATE_PROJECTED_MUTATION");
  expect(residentSourceAdvisory(fault)?.diagnostic.message).toBe("assertion: explicit state required");
  for (const spoof of [
    new Error("PRIVATE_HOST_ERROR"),
    { origin: "source_throw", trustedOrigin: false, sourceDiagnostic: diagnostic, message: "PRIVATE_STRUCTURAL" },
    Object.assign(Object.create(ResidentWorkerFault.prototype), { origin: "source_throw", sourceDiagnostic: diagnostic }),
  ]) {
    expect(preparationFailure(spoof).code).toBe("service_failure");
    expect(residentSourceAdvisory(spoof)).toBeUndefined();
    expect(JSON.stringify(preparationFailure(spoof))).not.toContain("PRIVATE");
  }
});

test("source diagnostic construction rejects hooks, invalid fields and promoted trust without inspecting them", () => {
  let hooks = 0;
  const base = { type: "Error", message: "assertion", source_hash: "a".repeat(64), location: { mapping: "unmapped" } };
  const accessor = { ...base };
  Object.defineProperty(accessor, "message", { get() { hooks++; throw new Error("PRIVATE_GETTER"); } });
  const proxy = new Proxy(base, { ownKeys() { hooks++; throw new Error("PRIVATE_PROXY"); } });
  const locationProxy = new Proxy(base.location, { ownKeys() { hooks++; throw new Error("PRIVATE_LOCATION"); } });
  for (const diagnostic of [accessor, proxy, { ...base, location: locationProxy },
    { ...base, stack: "PRIVATE_STACK" }, { ...base, type: "CustomHostError" },
    { ...base, source_hash: "A".repeat(64) }, { ...base, message: "x".repeat(1001) },
    { ...base, location: { mapping: "unmapped", path: "PRIVATE_PATH" } }]) {
    expect(() => new ResidentWorkerFault("source_throw", false, diagnostic)).toThrow();
  }
  expect(hooks).toBe(0);
  expect(() => new ResidentWorkerFault("source_throw", true, base)).toThrow();
  expect(() => new ResidentWorkerFault("watchdog", false, base)).toThrow();
  const bounded = new ResidentWorkerFault("source_throw", false, { ...base, message: "é".repeat(1000) });
  expect(residentSourceAdvisory(bounded)?.diagnostic.message).toHaveLength(1000);
  for (const origin of ["watchdog", "transport", "opaque", "cleanup"] as const) {
    expect(preparationFailure(new ResidentWorkerFault(origin))).toEqual({
      error: `Resident worker failed (${origin}).`, code: origin,
    });
  }
});

test("actor-selected entries cannot exchange playing and pure-analysis authority or budgets", () => {
  const source = "export function step(frame,state,intent) { return null; }";
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

test("only actor world results admit omitted edges without weakening complete held or native input", () => {
  const { edges: _edges, ...input } = result().input;
  input.held.forward = true;
  const parsed = controllerStepResultSchema.parse({ ...result(), input });
  expect<unknown>(parsed.input).toEqual(input);
  expect(Object.hasOwn(parsed.input, "edges")).toBe(false);
  expect(controllerInputSchema.safeParse(input).success).toBe(false);
  expect(controllerInputFrameSchema.shape.input.safeParse(input).success).toBe(false);
  const { use: _use, ...incompleteHeld } = input.held;
  for (const invalid of [
    { ...input, held: incompleteHeld },
    { ...input, edges: null },
    { ...input, edges: undefined },
    { ...input, target: "hidden-target" },
    { kind: "screen", screen: { screen_id: "inventory", incarnation: 1, layout_revision: 1 } },
  ]) expect(controllerStepResultSchema.safeParse({ ...result(), input: invalid }).success).toBe(false);
});

test("actor explicit edges retain native refinements rather than falling back to omission", () => {
  for (const edges of [
    [{ kind: "button", button: "forward", phase: "release", count: 2 }],
    [{ kind: "button", button: "attack", phase: "press", count: 256 }, { kind: "hand_swap" }],
    [{ kind: "hotbar", slot: 1 }, { kind: "hotbar", slot: 1 }],
    [{ kind: "hotbar", slot: 1 }],
    [{ kind: "drop", all: true }, { kind: "drop", all: false }],
  ]) expect(controllerStepResultSchema.safeParse({ ...result(), input: { ...result().input, selected_hotbar: 2, edges } }).success).toBe(false);
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

test("generated return diagnostics distinguish trusted byte, depth and plain-data boundaries without values", () => {
  const secret = "PRIVATE_VALUE /private/path";
  let nested: unknown = secret;
  for (let depth = 0; depth < 33; depth++) nested = [nested];
  let getters = 0;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { getters++; return secret; } });
  const cases: { value: unknown; constraint: "utf8_bytes" | "depth" | "plain_data"; maximum?: number; path: string }[] = [
    { value: { ...result(), next_state: secret + "é".repeat(8192) }, constraint: "utf8_bytes", maximum: 16384, path: "next_state" },
    { value: { ...result(), next_state: nested }, constraint: "depth", maximum: 32, path: "" },
    { value: { ...result(), next_state: accessor }, constraint: "plain_data", path: "" },
    { value: { ...result(), next_state: { value: Infinity, secret } }, constraint: "plain_data", path: "" },
  ];
  for (const entry of cases) {
    for (const activation of [false, true]) {
      let caught: unknown;
      try {
        if (activation) parseGeneratedResidentResult(entry.value, true);
        else parseGeneratedResidentResult(entry.value);
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(GeneratedControllerResultValidationError);
      if (!(caught instanceof GeneratedControllerResultValidationError)) throw new Error("Missing generated return diagnostic");
      const expected = { code: "custom", path: entry.path, constraint: entry.constraint,
        ...(entry.maximum !== undefined ? { maximum: entry.maximum } : {}) };
      expect(caught.issues).toContainEqual(expected);
      expect(caught.issues.every(issue => !Object.hasOwn(issue, "actual"))).toBe(true);
      const diagnostic = programDiagnostic(caught, "a".repeat(64));
      const readback = readProgramDiagnostic(JSON.parse(JSON.stringify(diagnostic)), "a".repeat(64));
      expect(readback.issues).toContainEqual(expected);
      expect(preparationFailure(caught)).toMatchObject({ code: "invalid_program_result", issues: caught.issues });
      expect(JSON.stringify([diagnostic, readback, preparationFailure(caught)])).not.toContain(secret);
    }
  }
  // The refusal alternative cannot bypass the plain-data guard and run a getter.
  const refused = Object.defineProperty({ reason: secret }, "refused", { enumerable: true, get() { getters++; return true; } });
  expect(() => parseGeneratedResidentResult(refused, true)).toThrow(GeneratedControllerResultValidationError);
  expect(getters).toBe(0);
});

test("JSON constraint metadata retains exact UTF8 limits but does not trust lookalike custom params", () => {
  for (const value of ["x".repeat(16382), "é".repeat(8191), "😀".repeat(4095) + "xx"])
    expect(residentStateSchema.safeParse(value).success).toBe(true);
  for (const value of ["x".repeat(16383), "é".repeat(8192), "😀".repeat(4096)]) {
    const parsed = residentStateSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Byte boundary accepted an over-limit value");
    expect(residentJsonConstraint(parsed.error.issues[0])).toEqual({ constraint: "utf8_bytes", maximum: 16384 });
    expect(preparationFailure(parsed.error).issues).toMatchObject([{ code: "custom", constraint: "utf8_bytes", maximum: 16384 }]);
  }
  const fake = z.unknown().superRefine((_value, context) => context.addIssue({
    code: "custom", message: "PRIVATE_VALIDATOR_MESSAGE", params: { constraint: "utf8_bytes", maximum: 1, actual: 999999 },
  })).safeParse(null);
  if (fake.success) throw new Error("Missing synthetic Zod issue");
  expect(residentJsonConstraint(fake.error.issues[0])).toBeUndefined();
  expect(JSON.stringify(preparationFailure(fake.error))).not.toContain("PRIVATE_VALIDATOR_MESSAGE");
  expect(preparationFailure(fake.error).issues).toEqual([{ code: "custom", message: "Invalid preparation tool argument" }]);
  let getters = 0;
  expect(residentJsonConstraint(Object.defineProperty({}, "params", { get() { getters++; return {}; } }))).toBeUndefined();
  expect(getters).toBe(0);
  const readback = readProgramDiagnostic({ type: "GeneratedControllerResultValidationError", message: "Safe host diagnostic",
    source_hash: "a".repeat(64), location: { mapping: "unmapped" },
    issues: [{ code: "custom", path: "next_state", params: fake.error.issues[0], message: "PRIVATE_VALIDATOR_MESSAGE" },
      { code: "custom", path: "", constraint: "utf8_bytes", maximum: 7, actual: 999999 }] }, "a".repeat(64));
  expect(readback.issues).toEqual([{ code: "custom", path: "next_state" }, { code: "custom", path: "" }]);
  expect(JSON.stringify(readback)).not.toContain("PRIVATE_VALIDATOR_MESSAGE");
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
