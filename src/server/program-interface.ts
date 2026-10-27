import { z } from "zod";
import { DEFAULT_SKILL_LIMITS } from "../shared/programs.ts";
import { jsonSchema, lookaheadConfigSchema, namedProgramRefSchema, policySpecSchema, skillLimitsSchema } from "../shared/validation.ts";
import { promotionDeclarationSchema } from "./experience.ts";

export const programSelectorSchema = namedProgramRefSchema;
const cardSchema = z.object({
  purpose: z.string().trim().min(1).max(1000), applicability: z.string().trim().min(1).max(1000),
  method: z.string().trim().min(1).max(2000), reason: z.string().trim().min(1).max(1000), limitations: z.string().trim().min(1).max(1000),
}).strict();
export const programWriteSchema = z.object({
  name: z.string().trim().min(1).max(80), source: z.string().min(1).max(16384), card: cardSchema.default({
    purpose: "Unspecified by author", applicability: "Unspecified by author", method: "See immutable source",
    reason: "Unspecified by author", limitations: "Untested; no efficacy or applicability claim",
  }),
  dependencies: z.array(programSelectorSchema).max(32).default([]), based_on: z.int().positive().optional(),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();
export const nextConfigSchema = lookaheadConfigSchema.extend({ activation: z.enum(["manual", "on_predecessor_success"]).default("manual") }).strict();
// Actor input may override individual fields. Only this boundary supplies
// defaults; the execution/planning schemas still require complete strict limits.
const actorLimitsSchema = skillLimitsSchema.extend({
  duration_ms: skillLimitsSchema.shape.duration_ms.default(DEFAULT_SKILL_LIMITS.duration_ms),
  max_actions: skillLimitsSchema.shape.max_actions.default(DEFAULT_SKILL_LIMITS.max_actions),
  max_calls: skillLimitsSchema.shape.max_calls.default(DEFAULT_SKILL_LIMITS.max_calls),
  max_depth: skillLimitsSchema.shape.max_depth.default(DEFAULT_SKILL_LIMITS.max_depth),
}).prefault({});
export const programSubmitSchema = programWriteSchema.extend({
  args: jsonSchema, limits: actorLimitsSchema, next: nextConfigSchema.optional(),
}).strict();
export const programRunSchema = z.discriminatedUnion("operation", [
  programSelectorSchema.extend({ operation: z.literal("start"), args: jsonSchema, limits: actorLimitsSchema, next: nextConfigSchema.optional() }).strict(),
  z.object({ operation: z.literal("inspect"), target: z.enum(["current", "latest"]).default("current") }).strict(),
  z.object({ operation: z.literal("stop"), target: z.enum(["current", "latest"]).default("current") }).strict(),
  z.object({ operation: z.literal("activate_next") }).strict(),
  z.object({ operation: z.literal("attention"), after_ms: z.int().min(1000).max(600000), reason: z.string().trim().min(1).max(300) }).strict(),
]);
const page = { after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(25) };
const executionSelection = { program: programSelectorSchema.optional(), target: z.enum(["current", "latest"]).default("latest") };
export const programInspectSchema = z.discriminatedUnion("view", [
  z.object({ view: z.literal("catalog"), ...page }).strict(),
  programSelectorSchema.extend({ view: z.literal("source") }).strict(),
  z.object({ view: z.literal("execution"), ...executionSelection }).strict(),
  z.object({ view: z.literal("history"), program: programSelectorSchema.optional(), ...page }).strict(),
  z.object({ view: z.literal("trace"), ...executionSelection, ...page }).strict(),
  z.object({ view: z.literal("feedback"), program: programSelectorSchema.optional(), after: z.object({ opportunity_seq: z.int().nonnegative(), execution_seq: z.int().nonnegative() }).strict().default({ opportunity_seq: 0, execution_seq: 0 }), limit: page.limit }).strict(),
  z.object({ view: z.literal("events"), ...page }).strict(),
  z.object({ view: z.literal("comparison"), before: programSelectorSchema, after: programSelectorSchema, after_sample: page.after, limit: page.limit }).strict(),
  z.object({ view: z.literal("planning") }).strict(),
  z.object({ view: z.literal("action"), ...executionSelection }).strict(),
]);
export const programReviewSchema = programSelectorSchema.extend({ decision: z.enum(["keep", "insufficient_evidence"]), reason: z.string().trim().min(1).max(2000) }).strict();
export const taskFinishSchema = z.object({ summary: z.string().trim().min(1).max(2000) }).strict();
export const prepareNextSchema = programSelectorSchema.extend({ args: jsonSchema, limits: actorLimitsSchema, guard_source: z.string().min(1).max(16384).optional() }).strict();
export const helpSchema = z.object({ topic: z.enum(["overview", "game", "programs", "planning", "reflex", "memory"]).default("overview") }).strict();
const namedPolicy = { name: z.string().trim().min(1).max(80), version: z.int().positive().optional() };
export const reflexSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("write"), spec: policySpecSchema }).strict(),
  z.object({ operation: z.literal("inspect"), ...namedPolicy }).strict(),
  z.object({ operation: z.literal("validate"), ...namedPolicy }).strict(),
  z.object({ operation: z.literal("activate"), ...namedPolicy, mode: z.enum(["trial", "keep"]).default("trial"), max_ms: z.int().min(1000).max(120000).default(120000), max_actions: z.int().min(1).max(20).default(20), max_evaluations: z.int().min(1).max(100).default(100) }).strict(),
  z.object({ operation: z.literal("retire"), ...namedPolicy }).strict(),
]);
export const memorySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("catalog"), ...page }).strict(),
  programSelectorSchema.extend({ operation: z.literal("load") }).strict(),
  z.object({ operation: z.literal("qualify"), name: z.string().trim().min(1).max(80), program: programSelectorSchema.optional(), target: z.enum(["current", "latest"]).default("latest"), declaration: promotionDeclarationSchema }).strict(),
]);
