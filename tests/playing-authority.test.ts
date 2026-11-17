import { expect, test } from "bun:test";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { controlSessionConfigSchema } from "../src/shared/control-session.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { assertDeclaredPlayingAuthority, validatePlayingAuthorityCeilings,
  type PlayingAuthorityCeilings } from "../src/server/playing-authority.ts";

const envelope = () => ({
  limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 900000, max_steps: 18000, max_frames: 18000,
    max_edges: 230400, max_analysis_jobs: 0, max_analysis_ms: 0 },
  session: controlSessionConfigSchema.parse({ schema_version: 1, retained_tasks: 128 }),
});
function refusal(operation: () => unknown) {
  try { operation(); }
  catch (error) {
    expect(error).toBeInstanceOf(RuntimeFault);
    const fault = error as RuntimeFault;
    expect(fault.code).toBe("budget_exceeded");
    expect(Buffer.byteLength(fault.message)).toBeLessThan(4096);
    expect(fault.message.startsWith("Declared playing authority refused: ")).toBe(true);
    return JSON.parse(fault.message.slice("Declared playing authority refused: ".length));
  }
  throw new Error("Expected finite playing-authority refusal");
}

test("public disconnected admission preserves exact lower authority and ignores unrelated selection metadata", () => {
  const ceilings = envelope(), selected = { ...envelope(),
    limits: { ...envelope().limits, duration_ms: 1000, max_steps: 20, max_frames: 20, max_edges: 0 },
    session: { ...envelope().session, max_tasks: 1, max_actions: 1, max_calls: 1, retained_tasks: 1 },
    name: "PRIVATE_SOURCE_NAME", source: "PRIVATE_SOURCE_BODY" };
  const before = structuredClone(selected);
  expect(assertDeclaredPlayingAuthority(selected, ceilings)).toEqual({ limits: selected.limits, session: selected.session });
  expect(selected).toEqual(before); expect(ceilings).toEqual(envelope());
  const effective = validatePlayingAuthorityCeilings(ceilings);
  ceilings.limits.duration_ms = 1000; ceilings.session.max_calls = 1;
  expect(effective).toEqual(envelope());
  expect(Object.isFrozen(effective)).toBe(true);
  expect(Object.isFrozen(effective.limits)).toBe(true);
  expect(Object.isFrozen(effective.session)).toBe(true);
});

for (const [group, field, value] of [
  ["limits", "duration_ms", 900001], ["limits", "step_ms", 26],
  ["limits", "max_steps", 18001], ["limits", "max_frames", 18001],
  ["limits", "max_edges", 230401], ["limits", "max_events", 257],
  ["limits", "max_analysis_jobs", 1], ["limits", "analysis_job_ms", 501],
  ["limits", "max_analysis_ms", 1], ["session", "max_tasks", 4097],
  ["session", "max_actions", 4097], ["session", "max_calls", 16385],
  ["session", "retained_tasks", 129], ["session", "recovery", "checkpoint_safe"],
] as const) test(`public playing admission refuses ${group}.${field} with only complete trusted bounds`, () => {
  const ceilings = envelope(), request = structuredClone(ceilings);
  Object.assign(request[group], { [field]: value });
  const diagnostic = refusal(() => assertDeclaredPlayingAuthority(request, ceilings));
  expect(diagnostic).toMatchObject({ category: "request_authority_refused", ceilings,
    operation_admitted: false, authority_renewed: false,
    live_program_replacement: "actual_exact_handoff_required" });
  // 129 retained tasks is invalid even before ceiling comparison; no request
  // value or schema exception is diagnostic authority.
  expect(diagnostic.violated_field).toBe(field === "retained_tasks" ? null : `${group}.${field}`);
});

test("invalid declared configuration cannot acquire defaults or expose arbitrary thrown/source values", () => {
  const ceilings = envelope();
  for (const invalid of [
    { ...ceilings, session: { schema_version: 1 } },
    { ...ceilings, limits: { ...ceilings.limits, PRIVATE_CONFIG_KEY: "PRIVATE_CONFIG_VALUE" } },
    { ...ceilings, session: { ...ceilings.session, max_calls: undefined } },
    { ...ceilings, session: { ...ceilings.session, recovery: "PRIVATE_PROVIDER_MESSAGE" } },
    new Proxy({}, { ownKeys() { throw new Error("PRIVATE_HOST_ERROR"); } }),
  ]) {
    expect(refusal(() => assertDeclaredPlayingAuthority(ceilings, invalid as PlayingAuthorityCeilings)))
      .toMatchObject({ category: "invalid_declared_ceilings", ceilings: null, violated_field: null });
  }
});

test("request errors retain trusted ceilings without invoking accessors or forwarding private data", () => {
  const ceilings = envelope();
  let reads = 0;
  const hostile = Object.defineProperty({}, "limits", { enumerable: true,
    get() { reads++; throw new Error("PRIVATE_HOST_EXCEPTION"); } });
  for (const request of [
    hostile, { session: ceilings.session },
    { ...ceilings, limits: { ...ceilings.limits, max_steps: "PRIVATE_REQUEST_VALUE" } },
    { ...ceilings, session: { schema_version: 1 } },
    { ...ceilings, session: { ...ceilings.session, schema_version: 2 } },
  ]) {
    const diagnostic = refusal(() => assertDeclaredPlayingAuthority(request, ceilings));
    expect(diagnostic).toMatchObject({ category: "request_authority_refused", ceilings,
      violated_field: null, operation_admitted: false, authority_renewed: false });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_");
  }
  expect(reads).toBe(0);
});
