import { expect, test } from "bun:test";
import { z } from "zod";
import type { AdapterDescriptor, AdapterSchemaCatalog } from "../src/shared/contracts.ts";
import { observationV3Schema } from "../src/shared/observations.ts";
import { jsonSchema } from "../src/shared/validation.ts";
import { contractHash } from "../src/server/adapter-contract.ts";
import { RegisteredAdapterContract } from "../src/server/registered-adapter.ts";
import { capabilityFailure, programDiagnostic } from "../src/server/program-diagnostics.ts";
import { minecraftTestAdapter } from "./helpers/adapter-contract.ts";

function fixture(capabilitySchema?: AdapterSchemaCatalog["capabilities"][string]) {
  const schemas: AdapterSchemaCatalog = { observation: jsonSchema.parse(z.toJSONSchema(observationV3Schema)),
    payload: jsonSchema.parse(z.toJSONSchema(z.object({ counter: z.number().int(),
      opaque_usage: z.object({ schema_version: z.literal(2) }).strict() }).strict())),
    capabilities: { "contract.action@1": capabilitySchema ?? jsonSchema.parse(z.toJSONSchema(z.object({ kind: z.literal("press"),
      scope: z.string(), epoch: z.number().int() }).strict())) } };
  const configuration = { counter_visible: true };
  const descriptor: AdapterDescriptor = { descriptor_schema: 1, game: { id: "contract-only", version: "1" },
    adapter: { id: "contract-only", version: "1", build_hash: "a".repeat(64) },
    observation: { schema_version: 3, schema_hash: contractHash(schemas.observation),
      payload_schema: { id: "contract-payload", version: 1, hash: contractHash(schemas.payload) },
      profile: { id: "contract-profile", version: 1, configuration, configuration_hash: contractHash(configuration) } },
    capabilities: [{ id: "contract.action", version: 1, schema_hash: contractHash(schemas.capabilities["contract.action@1"]) }],
    actuator: "native", executable: { api_version: 5, validator_version: 5, runtime_version: 5 } };
  const registry = new RegisteredAdapterContract(descriptor, schemas);
  const observation = { schema_version: 3, world_id: "world", session_id: "session", epoch: 2147483665, native_boot_id: "boot",
    life: { life_id: 3, status: "alive", can_respawn: false, death: null }, space: { dimension_id: "contract-space", space_epoch: 4 },
    screen: null, observation_seq: 1, captured_at: "2026-10-25T12:00:00Z", compatibility_hash: registry.compatibility.compatibility_hash,
    profile_id: descriptor.observation.profile.id, profile_configuration_hash: descriptor.observation.profile.configuration_hash,
    freshness: { max_age_ms: 1000, partial: true }, data: { counter: 7, opaque_usage: { schema_version: 2 } } };
  return { registry, descriptor, schemas, observation };
}

test("trusted registered payload schemas admit non-Minecraft data without relabeling nested version namespaces", () => {
  const f = fixture(), current = f.registry.parseObservation(f.observation);
  expect(current.data).toEqual({ counter: 7, opaque_usage: { schema_version: 2 } });
  expect(current).not.toHaveProperty("player");
  expect(current).not.toHaveProperty("inventory");
});

test("actual registered payload constraints reject a native envelope's malformed or extra data", () => {
  const f = fixture();
  expect(() => f.registry.parseObservation({ ...f.observation, data: { counter: 0.5, opaque_usage: { schema_version: 2 } } })).toThrow();
  expect(() => f.registry.parseObservation({ ...f.observation, data: { ...f.observation.data, player: {} } })).toThrow();
});

test("capability parsing preserves legitimate adapter data named scope/epoch without granting host authority", () => {
  const f = fixture();
  const value = f.registry.parseCapability("contract.action", 1, { kind: "press", scope: "local-mechanical-scope", epoch: 17 });
  expect(value).toEqual({ kind: "press", scope: "local-mechanical-scope", epoch: 17 });
  expect(() => f.registry.parseCapability("contract.action", 1, { kind: "press", scope: "local", epoch: 0.5 })).toThrow();
  expect(() => f.registry.parseCapability("contract.action", 1, { kind: "press", scope: "local", epoch: 17,
    source_hash: "a".repeat(64) })).toThrow();
});

test("a missing capability/schema version is rejected, never replaced by an empty successful result", () => {
  const f = fixture();
  expect(() => f.registry.parseCapability("unimplemented.gui", 1, {})).toThrow();
  expect(() => f.registry.parseCapability("contract.action", 2, {})).toThrow();
});

test("agreeing hashes cannot register a tampered schema document", () => {
  const f = fixture();
  f.schemas.capabilities["contract.action@1"] = { type: "null" };
  expect(() => new RegisteredAdapterContract(f.descriptor, f.schemas)).toThrow();
});

test("registered semantic admission preserves finite wire validation and applies to exposed capability schemas", () => {
  const f = fixture();
  const registry = new RegisteredAdapterContract(f.descriptor, f.schemas, {
    "contract.action@1": value => value !== null && typeof value === "object" && !Array.isArray(value) && value.scope === "allowed",
  });
  expect(registry.parseCapability("contract.action", 1, { kind: "press", scope: "allowed", epoch: 1 }))
    .toEqual({ kind: "press", scope: "allowed", epoch: 1 });
  expect(() => registry.parseCapability("contract.action", 1, { kind: "press", scope: "other", epoch: 1 })).toThrow();
  expect(registry.capabilitySchema("contract.action", 1).safeParse({ kind: "press", scope: "other", epoch: 1 }).success).toBe(false);
  expect(() => registry.parseCapability("contract.action", 1, { kind: "press", scope: "allowed", epoch: 1, extra: true })).toThrow();
});

test("registered navigation range rejection identifies its valid bound without echoing input or claiming native neutralization", () => {
  const adapter = minecraftTestAdapter(), registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas);
  const target = { target_id: "INPUT_TARGET_SECRET", incarnation: 1, life_id: 1,
    space: { dimension_id: "minecraft:overworld", space_epoch: 1 } };
  for (const [range, bound] of [[0.4, ">= 0.5"], [4.1, "<= 4"]] as const) {
    let failure: unknown;
    try { registry.parseCapability("minecraft.action", 4, { kind: "navigate", target, range, duration_ms: 1000 }); }
    catch (error) { failure = error; }
    const publicFailure = capabilityFailure(failure);
    expect(publicFailure.code).toBe("invalid_request");
    expect(publicFailure.message).toContain("range");
    expect(publicFailure.message).toContain(bound);
    expect(publicFailure.message).toContain("before effect admission");
    expect(publicFailure.message).toContain("no action admitted");
    expect(publicFailure.message.length).toBeLessThanOrEqual(1000);
    expect(publicFailure.message).not.toContain(String(range));
    expect(publicFailure.message).not.toContain("INPUT_TARGET_SECRET");
    expect(publicFailure.message).not.toContain("neutralized");
    expect(programDiagnostic(failure, "a".repeat(64))).toMatchObject({ code: "invalid_request", message: publicFailure.message });
  }
  expect(registry.parseCapability("minecraft.action", 4, { kind: "navigate", target, range: 0.5, duration_ms: 1000 }))
    .toMatchObject({ range: 0.5 });
});

test("registered invalid argument diagnostics never echo unknown keys, values or arbitrary backend Zod errors", () => {
  const f = fixture();
  let failure: unknown;
  try { f.registry.parseCapability("contract.action", 1, { kind: "INPUT_KIND_SECRET", INPUT_KEY_SECRET: "INPUT_VALUE_SECRET" }); }
  catch (error) { failure = error; }
  const publicFailure = capabilityFailure(failure);
  expect(publicFailure.code).toBe("invalid_request");
  for (const secret of ["INPUT_KIND_SECRET", "INPUT_KEY_SECRET", "INPUT_VALUE_SECRET"])
    expect(JSON.stringify(publicFailure)).not.toContain(secret);
  const arbitrary = new z.ZodError([{ code: "custom", path: ["HOST_PATH_SECRET"], message: "HOST_MESSAGE_SECRET" }]);
  expect(capabilityFailure(arbitrary)).toEqual({ code: "backend_unavailable", message: "Trusted capability could not complete safely" });
  expect(programDiagnostic(arbitrary, "a".repeat(64))).toEqual({
    type: "ExecutionFailure", message: "Generated program or trusted capability failed; host exception details are not exposed",
    source_hash: "a".repeat(64), location: { mapping: "unmapped" },
  });
});

test("registered recipes argument diagnostics name the expected string without echoing a supplied object", () => {
  const adapter = minecraftTestAdapter(), registry = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas);
  let failure: unknown;
  try { registry.parseCapability("minecraft.recipes", 1, { item: { item: "oak_planks", INPUT_KEY_SECRET: "INPUT_VALUE_SECRET" } }); }
  catch (error) { failure = error; }
  const publicFailure = capabilityFailure(failure);
  expect(publicFailure.code).toBe("invalid_request");
  expect(publicFailure.message).toContain("item");
  expect(publicFailure.message).toMatch(/\bstring\b/);
  for (const secret of ["oak_planks", "INPUT_KEY_SECRET", "INPUT_VALUE_SECRET"])
    expect(JSON.stringify(publicFailure)).not.toContain(secret);
  expect(registry.parseCapability("minecraft.recipes", 1, { item: "oak_planks" })).toEqual({ item: "oak_planks" });
});

test("registered type diagnostics use only static JSON types and redact caller-authored paths and schema metadata", () => {
  for (const [type, value] of [
    ["string", {}], ["number", "INPUT_VALUE_SECRET"],
    ["integer", 0.5], ["boolean", {}],
    ["object", []], ["array", {}], ["null", {}],
  ] as const) {
    const { registry } = fixture({ type: "object", additionalProperties: {
      type, title: "SCHEMA_TITLE_SECRET", description: "SCHEMA_DESCRIPTION_SECRET",
    } });
    let failure: unknown;
    try { registry.parseCapability("contract.action", 1, { INPUT_PATH_SECRET: value }); }
    catch (error) { failure = error; }
    const publicFailure = capabilityFailure(failure);
    expect(publicFailure.code).toBe("invalid_request");
    expect(publicFailure.message).toContain("arguments");
    expect(publicFailure.message).toMatch(new RegExp(`\\b${type}\\b`));
    for (const secret of ["INPUT_PATH_SECRET", "INPUT_VALUE_SECRET", "SCHEMA_TITLE_SECRET", "SCHEMA_DESCRIPTION_SECRET"])
      expect(JSON.stringify(publicFailure)).not.toContain(secret);
  }
});

test("ambiguous registered union type diagnostics never present a branch guess as the expected type", () => {
  for (const keyword of ["anyOf", "oneOf"]) {
    const { registry } = fixture({ type: "object", properties: { item: {
      [keyword]: [{ type: "string" }, { type: "number" }],
    } }, required: ["item"], additionalProperties: false });
    let failure: unknown;
    try { registry.parseCapability("contract.action", 1, { item: { INPUT_KEY_SECRET: "INPUT_VALUE_SECRET" } }); }
    catch (error) { failure = error; }
    const publicFailure = capabilityFailure(failure);
    expect(publicFailure.code).toBe("invalid_request");
    expect(publicFailure.message).toContain("registered capability schema");
    expect(publicFailure.message).not.toMatch(/\b(?:string|number)\b/);
    for (const secret of ["INPUT_KEY_SECRET", "INPUT_VALUE_SECRET"])
      expect(JSON.stringify(publicFailure)).not.toContain(secret);
  }
  const { registry } = fixture({ type: "object", properties: { item: { type: ["string", "number"] } }, required: ["item"] });
  let failure: unknown;
  try { registry.parseCapability("contract.action", 1, { item: {} }); }
  catch (error) { failure = error; }
  const publicFailure = capabilityFailure(failure);
  expect(publicFailure.code).toBe("invalid_request");
  expect(publicFailure.message).not.toMatch(/\b(?:string|number)\b/);
});
