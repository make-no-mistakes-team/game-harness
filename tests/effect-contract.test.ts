import { expect, test } from "bun:test";
import type { ActiveExecutableValidation, AdapterBinding } from "../src/shared/contracts.ts";
import { adapterDescriptorSchema } from "../src/shared/adapter.ts";
import { assertCurrentEffect, assertExecutableCompatible } from "../src/server/effect-contract.ts";
import { binding, effectScope } from "./helpers/adapter-contract.ts";

function fixture() {
  const raw = binding(), scope = effectScope();
  const current: AdapterBinding = { ...raw, descriptor: adapterDescriptorSchema.parse(raw.descriptor) };
  const invocation = { kind: "skill" as const, execution_id: scope.execution_id, source_hash: scope.source_hash };
  const screen = { screen_id: "visible-view", incarnation: 2, revision: 3 };
  const envelope = { operation_id: "host-operation", compatibility_hash: current.compatibility_hash, scope: { ...scope }, invocation,
    action: { kind: "fixture_action", scope: "legitimate adapter data" }, expected_screen: { kind: "transaction" as const, screen } };
  const expected = { binding: current, scope, invocation, screen };
  const validation: ActiveExecutableValidation = { api_version: 5, validator_version: 5, runtime_version: 5, compatibility_hash: current.compatibility_hash,
    fingerprint: "a".repeat(64), formatted_lines: 3, complexity: 1, nesting: 0 };
  return { envelope, expected, validation };
}

test("current host source/scope passes without interpreting adapter-owned scope-like payload keys", () => {
  const f = fixture();
  expect(assertCurrentEffect(f.envelope, f.expected).action).toEqual({ kind: "fixture_action", scope: "legitimate adapter data" });
  expect(assertExecutableCompatible(f.validation, f.expected.binding)).toEqual(f.validation);
});

test("explicit no-screen precondition rejects a newly opened view and omission is not an active wildcard", () => {
  const f = fixture();
  const absent = { ...f.envelope, expected_screen: { kind: "absent" as const } };
  expect(assertCurrentEffect(absent, { ...f.expected, screen: null })).toEqual(absent);
  expect(() => assertCurrentEffect(absent, f.expected)).toThrow();
  const { expected_screen: _screen, ...omitted } = absent;
  expect(() => assertCurrentEffect(omitted, { ...f.expected, screen: null })).toThrow();
  expect(() => assertCurrentEffect({ ...absent, expected_screen: null }, { ...f.expected, screen: null })).toThrow();
  expect(() => assertCurrentEffect({ ...absent, expected_screen: f.expected.screen }, f.expected)).toThrow();
});

for (const key of ["session_id", "world_id", "native_boot_id", "run_id", "execution_id", "source_hash"] as const) {
  test(`host apply fence rejects a replaced ${key}`, () => {
    const f = fixture();
    f.envelope.scope[key] = key === "source_hash" ? "f".repeat(64) : "replacement-identity";
    expect(() => assertCurrentEffect(f.envelope, f.expected)).toThrow();
  });
}
for (const key of ["epoch", "run_generation", "life_id", "space_epoch"] as const) {
  test(`host apply fence rejects a replaced ${key} without confusing cancellation generation`, () => {
    const f = fixture(); f.envelope.scope[key]++;
    expect(() => assertCurrentEffect(f.envelope, f.expected)).toThrow();
  });
}

test("replaced screen instances and relevant revisions reject before effects", () => {
  for (const key of ["incarnation", "revision"] as const) {
    const f = fixture();
    f.expected.screen = { ...f.expected.screen, [key]: f.expected.screen[key] + 1 };
    expect(() => assertCurrentEffect(f.envelope, f.expected)).toThrow();
  }
});

test("an inactive or profile-replaced binding cannot admit an otherwise matching effect", () => {
  const inactive = fixture(); inactive.expected.binding.ready = false;
  expect(() => assertCurrentEffect(inactive.envelope, inactive.expected)).toThrow();
  const profile = fixture(); profile.expected.binding.compatibility_hash = "e".repeat(64);
  expect(() => assertCurrentEffect(profile.envelope, profile.expected)).toThrow();
});

test("policy invocations carry their real policy identity rather than a fabricated skill owner", () => {
  const f = fixture();
  const policy = { kind: "policy" as const, execution_id: f.expected.scope.execution_id, source_hash: f.expected.scope.source_hash,
    policy_id: "real-policy", version: 4 };
  const envelope = { ...f.envelope, invocation: policy };
  const expected = { ...f.expected, invocation: policy };
  expect(assertCurrentEffect(envelope, expected).invocation).toEqual(policy);
  expect(() => assertCurrentEffect({ ...envelope, invocation: { ...policy, version: 3 } }, expected)).toThrow();
  expect(() => assertCurrentEffect({ ...envelope, invocation: f.expected.invocation }, expected)).toThrow();
});

for (const kind of ["skill", "policy", "guard", "diagnostic"]) {
  test(`${kind} cannot relabel API3 or stale-profile cached validation as current`, () => {
    const f = fixture();
    expect(() => assertExecutableCompatible({ ...f.validation, runtime_version: 3 }, f.expected.binding)).toThrow();
    expect(() => assertExecutableCompatible({ ...f.validation, validator_version: 2 }, f.expected.binding)).toThrow();
    expect(() => assertExecutableCompatible({ ...f.validation, compatibility_hash: "e".repeat(64) }, f.expected.binding)).toThrow();
    expect(() => assertExecutableCompatible({ fingerprint: "historical-source" }, f.expected.binding)).toThrow();
  });
}
