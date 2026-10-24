import { expect, test } from "bun:test";
import { adapterCompatibility, canonicalContractJson, contractHash, negotiateAdapterDescriptor } from "../src/server/adapter-contract.ts";
import { descriptor, schemaCatalog, sha256 } from "./helpers/adapter-contract.ts";

test("canonical identity sorts object keys while retaining array order and exact finite values", () => {
  expect(canonicalContractJson({ z: [3, 1], a: { y: 2, x: "value" } })).toBe('{"a":{"x":"value","y":2},"z":[3,1]}');
  expect(contractHash({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  expect(contractHash({ values: [1, 2] })).not.toBe(contractHash({ values: [2, 1] }));
});

for (const invalid of [undefined, NaN, Infinity, new Date(), [, 1], { value: undefined }]) {
  test(`unsupported identity value ${String(invalid)} cannot hash as a different wire value`, () => {
    expect(() => canonicalContractJson(invalid)).toThrow();
  });
}

test("cycles cannot acquire a configuration identity", () => {
  const value: { self?: unknown } = {}; value.self = value;
  expect(() => canonicalContractJson(value)).toThrow();
});

test("negotiated stable descriptors cannot be mutated under their unchanged claimed hash", () => {
  const current = adapterCompatibility(descriptor(), schemaCatalog());
  const configuration = current.descriptor.observation.profile.configuration;
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error("Fixture configuration is not an object");
  // Reflect.set reports failed writes on frozen JSON; no mutation is accepted.
  expect(Reflect.set(configuration, "motor_profile", "precise")).toBe(false);
  expect(current.compatibility_hash).toBe(contractHash(current.descriptor));
});

test("capability order is normalized but duplicate registered identities are rejected", () => {
  const first = descriptor(), reordered = descriptor(); reordered.capabilities.reverse();
  expect(negotiateAdapterDescriptor(first, reordered, schemaCatalog()).compatibility_hash).toBe(adapterCompatibility(first, schemaCatalog()).compatibility_hash);
  const duplicate = descriptor(); duplicate.capabilities.push({ ...duplicate.capabilities[0]! });
  expect(() => adapterCompatibility(duplicate, schemaCatalog())).toThrow();
});

test("materialized configuration is checked independently of descriptor equality", () => {
  const changed = descriptor(); changed.observation.profile.configuration.sampler.radius_blocks = 32;
  expect(() => negotiateAdapterDescriptor(changed, structuredClone(changed), schemaCatalog())).toThrow();
  changed.observation.profile.configuration_hash = sha256(changed.observation.profile.configuration);
  expect(() => negotiateAdapterDescriptor(descriptor(), changed, schemaCatalog())).toThrow();
});
