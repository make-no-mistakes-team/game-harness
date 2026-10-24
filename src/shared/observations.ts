import { z } from "zod";
import type { Json, PlayerLife, Sha256 } from "./contracts.ts";
import type { ScreenRef, SpaceRef } from "./control.ts";
import { identitySchema, safeCounterSchema, screenRefSchema, sha256Schema, spaceRefSchema } from "./control.ts";
import { jsonSchema, playerLifeSchema } from "./primitives.ts";

export interface ObservationV3<Data = Json> {
  schema_version: 3;
  world_id: string;
  epoch: number;
  session_id: string;
  native_boot_id: string;
  life: PlayerLife;
  space: SpaceRef;
  screen: ScreenRef | null;
  observation_seq: number;
  captured_at: string;
  compatibility_hash: Sha256;
  profile_id: string;
  profile_configuration_hash: Sha256;
  freshness: { max_age_ms: number; partial: boolean };
  data: Data;
}
export interface AdapterActorProjection {
  state: Json;
  summary: string;
  metadata: Json;
}

export const observationV3Schema = z.object({
  schema_version: z.literal(3), world_id: identitySchema, epoch: safeCounterSchema, session_id: identitySchema,
  native_boot_id: identitySchema, life: playerLifeSchema, space: spaceRefSchema, screen: screenRefSchema.nullable(),
  observation_seq: safeCounterSchema, captured_at: z.iso.datetime({ offset: true }),
  compatibility_hash: sha256Schema, profile_id: identitySchema, profile_configuration_hash: sha256Schema,
  freshness: z.object({ max_age_ms: safeCounterSchema, partial: z.boolean() }).strict(), data: jsonSchema,
}).strict() satisfies z.ZodType<ObservationV3>;

/** Payload validation belongs to the trusted registered adapter, not this envelope. */
export function adapterObservationSchema<Data extends z.ZodType>(data: Data) {
  return observationV3Schema.extend({ data }).strict();
}

export const adapterActorProjectionSchema = z.object({ state: jsonSchema,
  summary: z.string().max(4000), metadata: jsonSchema }).strict() satisfies z.ZodType<AdapterActorProjection>;
