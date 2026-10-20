import { Buffer } from "node:buffer";
import { z } from "zod";
import type { GameAction, PolicyDecision, PolicySpec } from "./contracts.ts";

const target = z.string().min(1).max(160);
const item = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const angle = z
  .number()
  .finite()
  .min(-2 * Math.PI)
  .max(2 * Math.PI);
const pitch = z
  .number()
  .finite()
  .min(-Math.PI / 2)
  .max(Math.PI / 2);
const look = z.object({ yaw: angle, pitch }).strict();
const controls = z
  .object({
    forward: z.boolean().optional(),
    back: z.boolean().optional(),
    left: z.boolean().optional(),
    right: z.boolean().optional(),
    jump: z.boolean().optional(),
    sprint: z.boolean().optional(),
    sneak: z.boolean().optional(),
  })
  .strict();

export const gameActionSchema: z.ZodType<GameAction> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("move"),
        controls,
        duration_ms: z.number().int().min(50).max(2000),
        look: look.optional(),
        interaction: z
          .object({
            kind: z.enum(["attack", "use"]),
            target_id: target.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z.object({ kind: z.literal("look"), yaw: angle, pitch }).strict(),
    z.object({ kind: z.literal("dig"), target_id: target }).strict(),
    z
      .object({
        kind: z.literal("place"),
        target_id: target,
        face: z.enum(["up", "down", "north", "south", "east", "west"]),
        item,
      })
      .strict(),
    z
      .object({
        kind: z.literal("craft"),
        item,
        executions: z.number().int().min(1).max(16),
        table_id: target.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("equip"),
        item,
        destination: z.enum([
          "hand",
          "off-hand",
          "head",
          "torso",
          "legs",
          "feet",
        ]),
      })
      .strict(),
    z.object({ kind: z.literal("interact"), target_id: target }).strict(),
    z.object({ kind: z.literal("attack"), target_id: target }).strict(),
    z
      .object({
        kind: z.literal("navigate"),
        target_id: target,
        range: z.number().finite().min(1).max(4),
        duration_ms: z.number().int().min(100).max(10000),
      })
      .strict(),
  ],
);

export const policyDecisionSchema: z.ZodType<PolicyDecision> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("continue"),
        reason: z.string().max(500).optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("replan"), reason: z.string().min(1).max(500) })
      .strict(),
    z
      .object({
        kind: z.literal("interrupt"),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    z
      .object({
        kind: z.literal("replace"),
        action: gameActionSchema,
        reason: z.string().min(1).max(500),
      })
      .strict(),
  ]);

export const policySpecSchema: z.ZodType<PolicySpec> = z
  .object({
    name: z.string().min(1).max(80),
    source: z
      .string()
      .min(1)
      .max(32768)
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 32768,
        "Policy source exceeds 32 KiB",
      ),
    card: z
      .object({
        purpose: z.string().min(1).max(1000),
        applicability: z.string().min(1).max(1000),
        method: z.string().min(1).max(2000),
        reason: z.string().min(1).max(1000),
        limitations: z.string().min(1).max(1000),
      })
      .strict(),
    priority: z.number().int().min(0).max(100),
    interval_ms: z.number().int().min(200).max(5000),
  })
  .strict();

export const goalSchema = z.enum([
  "collect_wood",
  "craft_crafting_table",
  "craft_stone_pickaxe",
  "custom",
]);
