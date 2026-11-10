import { z } from "zod";
import type { ActiveExecutableValidation, AdapterBinding, AdapterDescriptor, HistoricalExecutableValidation, ProgramCompatibility } from "./contracts.ts";
import { identitySchema, safeCounterSchema, sha256Schema } from "./control.ts";
import { jsonSchema } from "./primitives.ts";

const schemaIdentity = z.object({ id: identitySchema, version: safeCounterSchema.min(1), hash: sha256Schema }).strict();
export const adapterDescriptorSchema = z.object({ descriptor_schema: z.literal(1),
  game: z.object({ id: identitySchema, version: identitySchema }).strict(),
  adapter: z.object({ id: identitySchema, version: identitySchema, build_hash: sha256Schema }).strict(),
  observation: z.object({ schema_version: z.literal(3), schema_hash: sha256Schema, payload_schema: schemaIdentity,
    profile: z.object({ id: identitySchema, version: safeCounterSchema.min(1), configuration: jsonSchema,
      configuration_hash: sha256Schema }).strict() }).strict(),
  capabilities: z.array(z.object({ id: identitySchema, version: safeCounterSchema.min(1), schema_hash: sha256Schema }).strict()).max(32),
  actuator: z.enum(["native", "desktop"]),
  executable: z.object({ api_version: z.literal(5), validator_version: z.literal(5), runtime_version: z.literal(5) }).strict(),
}).strict() satisfies z.ZodType<AdapterDescriptor>;
export const programCompatibilitySchema = z.object({ descriptor: adapterDescriptorSchema, compatibility_hash: sha256Schema }).strict() satisfies z.ZodType<ProgramCompatibility>;
export const adapterBindingSchema = programCompatibilitySchema.extend({ native_boot_id: identitySchema, ready: z.boolean() }).strict() satisfies z.ZodType<AdapterBinding>;
export const activeExecutableValidationSchema = z.object({ api_version: z.literal(5), validator_version: z.literal(5), runtime_version: z.literal(5),
  compatibility_hash: sha256Schema, fingerprint: sha256Schema, formatted_lines: safeCounterSchema,
  complexity: safeCounterSchema, nesting: safeCounterSchema,
  runtime_features: z.array(z.literal("pure_modules_v1")).max(1).optional(),
}).strict() satisfies z.ZodType<ActiveExecutableValidation>;
export const historicalExecutableValidationSchema = z.object({ runtime_version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  fingerprint: z.string(), api_version: safeCounterSchema.optional(), validator_version: safeCounterSchema.optional(),
  compatibility_hash: z.string().optional(), formatted_lines: safeCounterSchema.optional(), complexity: safeCounterSchema.optional(),
  nesting: safeCounterSchema.optional(),
}).strict() satisfies z.ZodType<HistoricalExecutableValidation>;
