import { z } from "zod";
import type { AdapterDescriptor, AdapterSchemaCatalog, Json, ProgramCompatibility } from "../shared/contracts.ts";
import { observationV3Schema, type ObservationV3 } from "../shared/observations.ts";
import { jsonSchema } from "../shared/primitives.ts";
import { adapterCompatibility } from "./adapter-contract.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { isValidJsonSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";

function compileRegisteredSchema(document: Json): z.ZodType<Json> {
  if (typeof document !== "boolean" && (document === null || typeof document !== "object" || Array.isArray(document)))
    throw new Error("A registered adapter schema must be a JSON schema object or boolean");
  if (!isValidJsonSchema(document)) throw new Error("Registered adapter document is not a supported valid JSON schema");
  // The installed converter may strip unknown object keys. Validate the actual
  // document without transforming input before the finite-JSON decode instead.
  // This retains legitimate adapter fields named scope/epoch and rejects keys
  // only where the registered schema itself closes that object.
  return z.unknown().superRefine((value, context) => {
    const result = validateJsonSchemaValue(document, value);
    for (const issue of result.issues)
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }).pipe(jsonSchema);
}

/** One compilation per stable registration; payloads/actions never compile schemas or hash source per frame. */
export class RegisteredAdapterContract {
  readonly compatibility: ProgramCompatibility;
  private readonly observationSchema: z.ZodType<ObservationV3>;
  private readonly capabilities: Record<string, z.ZodType<Json>> = Object.create(null);
  constructor(descriptor: AdapterDescriptor, schemas: AdapterSchemaCatalog) {
    this.compatibility = adapterCompatibility(descriptor, schemas);
    this.observationSchema = observationV3Schema.extend({ data: compileRegisteredSchema(schemas.payload) });
    for (const capability of this.compatibility.descriptor.capabilities) {
      const key = `${capability.id}@${capability.version}`;
      this.capabilities[key] = compileRegisteredSchema(schemas.capabilities[key]!);
    }
  }
  parseObservation(value: unknown): ObservationV3 {
    const observation = this.observationSchema.parse(value);
    const descriptor = this.compatibility.descriptor;
    if (observation.compatibility_hash !== this.compatibility.compatibility_hash || observation.profile_id !== descriptor.observation.profile.id ||
      observation.profile_configuration_hash !== descriptor.observation.profile.configuration_hash)
      throw new RuntimeFault("stale_context", "Observation does not match its registered adapter/profile contract");
    return observation;
  }
  parseCapability(id: string, version: number, args: unknown): Json {
    const schema = this.capabilities[`${id}@${version}`];
    if (!schema) throw new RuntimeFault("precondition_failed", "The negotiated adapter does not implement the requested capability schema");
    return schema.parse(args);
  }
  capabilitySchema(id: string, version: number): z.ZodType {
    const schema = this.capabilities[`${id}@${version}`];
    if (!schema) throw new RuntimeFault("precondition_failed", "The negotiated adapter does not implement the requested capability schema");
    return schema;
  }
}
