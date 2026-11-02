import { z } from "zod";
import type { GameActionResult, Json, PlayerLife } from "./contracts.ts";
import { identitySchema, safeCounterSchema } from "./control.ts";

export const sessionIdSchema = identitySchema;
export const lifeIdSchema = safeCounterSchema;
export const playerLifeSchema: z.ZodType<PlayerLife> = z.object({
  life_id: lifeIdSchema,
  status: z.enum(["loading", "alive", "dead", "respawning"]),
  can_respawn: z.boolean(),
  death: z.object({ death_id: identitySchema, at: z.string().min(1).max(40), message: z.string().max(1000).nullable() }).strict().nullable(),
}).strict().refine(life => !life.can_respawn || life.status === "dead", { message: "Only a dead life can be ready for explicit respawn" })
  .refine(life => life.status !== "alive" || life.death === null, { message: "An alive life cannot retain death data" })
  .describe("Native-authoritative own-player incarnation. Loading is not alive; death retains its life ID. Only actual new-life readiness increments it; respawn is explicit.");

export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));

export const gameActionResultSchema = z.object({ status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
  summary: z.string().max(2000), evidence: jsonSchema, requires_reconnect: z.boolean().optional(),
}).strict() satisfies z.ZodType<GameActionResult>;
