import { createHash } from "node:crypto";
import { z } from "zod";
import type { AdapterBinding, AdapterDescriptor, AdapterSchemaCatalog, ProgramCompatibility } from "../shared/contracts.ts";
import { identitySchema, safeCounterSchema, sha256Schema } from "../shared/control.ts";
import type { ObservationV3 } from "../shared/observations.ts";
import { observationV3Schema } from "../shared/observations.ts";
import { adapterDescriptorSchema } from "../shared/adapter.ts";

export const ADAPTER_NEGOTIATION_LIMITS = Object.freeze({ hello_bytes: 16384, descriptor_bytes: 12288 });

/** Canonical finite JSON shared by build/schema/profile compatibility, never by frame delivery. */
export function canonicalContractJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object") throw new Error("Contract identity requires finite JSON values");
    if (ancestors.has(item)) throw new Error("Contract identity cannot contain cycles");
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new Error("Contract identity requires JSON objects");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${Array.from(item, encode).join(",")}]`;
    else {
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key])}`).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}
export function contractHash(value: unknown): string {
  return createHash("sha256").update(canonicalContractJson(value)).digest("hex");
}

function freezeContract(value: object): void {
  const fields = value as Record<string, unknown>;
  for (const key in fields) {
    if (!Object.hasOwn(fields, key)) continue;
    const child = fields[key];
    if (child !== null && typeof child === "object") freezeContract(child);
  }
  Object.freeze(value);
}

/** Trusted schema registration is a local composition decision, not a native claim. */
export function validateAdapterDescriptor(value: unknown, schemas: AdapterSchemaCatalog): AdapterDescriptor {
  const encoded = canonicalContractJson(value);
  if (Buffer.byteLength(encoded) > ADAPTER_NEGOTIATION_LIMITS.descriptor_bytes) throw new Error("Adapter descriptor exceeds its wire bound");
  const descriptor = adapterDescriptorSchema.parse(value);
  if (descriptor.observation.schema_hash !== contractHash(schemas.observation) ||
    descriptor.observation.payload_schema.hash !== contractHash(schemas.payload))
    throw new Error("Adapter observation schema is not the trusted registered schema");
  if (descriptor.observation.profile.configuration_hash !== contractHash(descriptor.observation.profile.configuration))
    throw new Error("Adapter materialized configuration does not match its claimed hash");
  const selected = new Set<string>();
  for (const capability of descriptor.capabilities) {
    const key = `${capability.id}@${capability.version}`;
    if (selected.has(key)) throw new Error("Duplicate adapter capability schema");
    selected.add(key);
    const registered = schemas.capabilities[key];
    if (!registered || capability.schema_hash !== contractHash(registered))
      throw new Error("Adapter capability schema is not registered by the trusted host");
  }
  descriptor.capabilities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version);
  freezeContract(descriptor);
  return descriptor;
}
export function adapterCompatibility(value: unknown, schemas: AdapterSchemaCatalog): ProgramCompatibility {
  const descriptor = validateAdapterDescriptor(value, schemas);
  return Object.freeze({ descriptor, compatibility_hash: contractHash(descriptor) });
}
export function negotiateAdapterDescriptor(expected: unknown, native: unknown, schemas: AdapterSchemaCatalog): ProgramCompatibility {
  const host = adapterCompatibility(expected, schemas), actual = adapterCompatibility(native, schemas);
  if (host.compatibility_hash !== actual.compatibility_hash)
    throw new Error("Native build/schema/profile/capability/executable contract does not match the selected host contract");
  return actual;
}
export const nativeHelloSchema = z.object({ protocol: z.literal(4), secret: z.string().regex(/^[a-f0-9]{64}$/),
  session_id: identitySchema, world_id: identitySchema, epoch: safeCounterSchema, native_boot_id: identitySchema,
  descriptor: adapterDescriptorSchema,
}).strict();
export function bindNativeDescriptor(hello: z.infer<typeof nativeHelloSchema>, expected: AdapterDescriptor,
  schemas: AdapterSchemaCatalog): AdapterBinding {
  const compatible = negotiateAdapterDescriptor(expected, hello.descriptor, schemas);
  return { ...compatible, ready: true, native_boot_id: hello.native_boot_id };
}
export function assertActiveObservation(value: unknown, binding: AdapterBinding): ObservationV3 {
  if (!binding.ready) throw new Error("Adapter binding is not ready");
  const observation = observationV3Schema.parse(value);
  if (observation.native_boot_id !== binding.native_boot_id || observation.compatibility_hash !== binding.compatibility_hash ||
    observation.profile_id !== binding.descriptor.observation.profile.id ||
    observation.profile_configuration_hash !== binding.descriptor.observation.profile.configuration_hash)
    throw new Error("Observation does not belong to the negotiated native/profile binding");
  return observation;
}
export function executableContractStamp(compatibility: ProgramCompatibility) {
  return { api_version: 5 as const, validator_version: 5 as const, runtime_version: 5 as const,
    compatibility_hash: compatibility.compatibility_hash };
}

export function sameProgramCompatibility(value: unknown, current: ProgramCompatibility): boolean {
  if (!value || typeof value !== "object" || !("descriptor" in value) || !("compatibility_hash" in value)) return false;
  if (value.compatibility_hash !== current.compatibility_hash) return false;
  const parsed = adapterDescriptorSchema.safeParse(value.descriptor);
  if (!parsed.success) return false;
  parsed.data.capabilities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version);
  return contractHash(parsed.data) === current.compatibility_hash;
}
