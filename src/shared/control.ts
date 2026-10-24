import { z } from "zod";
import type { Json, Sha256 } from "./contracts.ts";

export const identitySchema = z.string().min(1).max(160);
export const safeCounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export type SpaceRef = { dimension_id: string; space_epoch: number };
export type ScreenRef = { screen_id: string; incarnation: number; revision: number };
export type TargetRef = { target_id: string; incarnation: number; space: SpaceRef; life_id: number };
export interface EffectScope {
  session_id: string;
  world_id: string;
  epoch: number;
  native_boot_id: string;
  run_id: string;
  run_generation: number;
  life_id: number;
  space_epoch: number;
  execution_id: string;
  source_hash: Sha256;
}
export type EffectContext = Omit<EffectScope, "execution_id" | "source_hash">;
export type EffectInvocation =
  | { kind: "skill"; execution_id: string; source_hash: Sha256 }
  | { kind: "policy"; execution_id: string; source_hash: Sha256; policy_id: string; version: number }
  | { kind: "diagnostic"; execution_id: string; source_hash: Sha256 };
export interface EffectEnvelope<Action extends Json = Json> {
  operation_id: string;
  compatibility_hash: Sha256;
  scope: EffectScope;
  invocation: EffectInvocation;
  action: Action;
  expected_screen: ScreenRef | null;
}
export interface EffectOwnerRef {
  operation_id: string;
  scope: EffectScope;
}
export interface ExpectedEffectOwner extends EffectOwnerRef {
  generation: number;
}

export const spaceRefSchema = z.object({ dimension_id: identitySchema, space_epoch: safeCounterSchema }).strict();
export const screenRefSchema = z.object({ screen_id: identitySchema, incarnation: safeCounterSchema, revision: safeCounterSchema }).strict();
export const targetRefSchema = z.object({ target_id: identitySchema, incarnation: safeCounterSchema,
  space: spaceRefSchema, life_id: safeCounterSchema }).strict();
export const effectScopeSchema = z.object({
  session_id: identitySchema, world_id: identitySchema, epoch: safeCounterSchema,
  native_boot_id: identitySchema, run_id: identitySchema, run_generation: safeCounterSchema,
  life_id: safeCounterSchema, space_epoch: safeCounterSchema, execution_id: identitySchema, source_hash: sha256Schema,
}).strict();
const invocationIdentity = { execution_id: identitySchema, source_hash: sha256Schema };
export const effectInvocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), ...invocationIdentity }).strict(),
  z.object({ kind: z.literal("policy"), ...invocationIdentity, policy_id: identitySchema,
    version: safeCounterSchema.min(1) }).strict(),
  z.object({ kind: z.literal("diagnostic"), ...invocationIdentity }).strict(),
]);
export const expectedEffectOwnerSchema = z.object({ operation_id: identitySchema, scope: effectScopeSchema,
  generation: safeCounterSchema }).strict();

export function effectEnvelopeSchema<Action extends z.ZodType>(action: Action) {
  return z.object({ operation_id: identitySchema, compatibility_hash: sha256Schema,
    scope: effectScopeSchema, invocation: effectInvocationSchema, action, expected_screen: screenRefSchema.nullable(),
  }).strict().refine(value => value.scope.execution_id === value.invocation.execution_id &&
    value.scope.source_hash === value.invocation.source_hash, { message: "Effect invocation must match its host scope" });
}

/** Explicit field comparison: host generation is never native cancellation generation. */
export function sameEffectScope(a: EffectScope, b: EffectScope): boolean {
  return a.session_id === b.session_id && a.world_id === b.world_id && a.epoch === b.epoch &&
    a.native_boot_id === b.native_boot_id && a.run_id === b.run_id && a.run_generation === b.run_generation &&
    a.life_id === b.life_id && a.space_epoch === b.space_epoch && a.execution_id === b.execution_id && a.source_hash === b.source_hash;
}
export function sameSpace(a: SpaceRef, b: SpaceRef): boolean {
  return a.dimension_id === b.dimension_id && a.space_epoch === b.space_epoch;
}
export function sameScreen(a: ScreenRef | null, b: ScreenRef | null): boolean {
  return a === b || a !== null && b !== null && a.screen_id === b.screen_id &&
    a.incarnation === b.incarnation && a.revision === b.revision;
}
export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return a.target_id === b.target_id && a.incarnation === b.incarnation && a.life_id === b.life_id && sameSpace(a.space, b.space);
}

// Definitions/validation only: these do not register an executable clip/UI capability.
export type HeldState = Record<string, boolean>;
export type InputEdge =
  | { kind: "button"; button: string; phase: "press" | "release"; count: number }
  | { kind: "camera_delta"; x: number; y: number }
  | { kind: "hotbar"; slot: number }
  | { kind: "hand_swap" }
  | { kind: "drop"; all: boolean }
  | { kind: "gui_pointer"; x: number; y: number }
  | { kind: "gui_button"; button: string; phase: "press" | "release" }
  | { kind: "gui_scroll"; x: number; y: number }
  | { kind: "gui_key"; key: string; phase: "press" | "release" }
  | { kind: "gui_text"; text: string };
export interface InputClip {
  kind: "input_clip";
  steps: { ticks: number; held: HeldState; edges: InputEdge[] }[];
  expected_screen?: ScreenRef;
}
export interface InputReceipt {
  operation_id: string;
  accepted: boolean;
  applied_prefix: number;
  stop_reason: "completed" | "cancelled" | "expired" | "stale" | "failed" | "unknown";
  input_application: "confirmed" | "partial" | "unknown";
  effect_status: "confirmed" | "not_observed" | "unknown";
  evidence_refs: string[];
}
const phase = z.enum(["press", "release"]);
const delta = z.number().finite();
export const inputEdgeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("button"), button: identitySchema, phase, count: z.number().int().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("camera_delta"), x: delta, y: delta }).strict(),
  z.object({ kind: z.literal("hotbar"), slot: safeCounterSchema }).strict(),
  z.object({ kind: z.literal("hand_swap") }).strict(),
  z.object({ kind: z.literal("drop"), all: z.boolean() }).strict(),
  z.object({ kind: z.literal("gui_pointer"), x: delta, y: delta }).strict(),
  z.object({ kind: z.literal("gui_button"), button: identitySchema, phase }).strict(),
  z.object({ kind: z.literal("gui_scroll"), x: delta, y: delta }).strict(),
  z.object({ kind: z.literal("gui_key"), key: identitySchema, phase }).strict(),
  z.object({ kind: z.literal("gui_text"), text: z.string().max(256) }).strict(),
]);
export const inputClipSchema = z.object({ kind: z.literal("input_clip"),
  steps: z.array(z.object({ ticks: z.number().int().min(1).max(100), held: z.record(identitySchema, z.boolean()),
    edges: z.array(inputEdgeSchema).max(256) }).strict()).min(1).max(64), expected_screen: screenRefSchema.optional(),
}).strict().superRefine((clip, context) => {
  let ticks = 0, edges = 0;
  for (const step of clip.steps) {
    ticks += step.ticks;
    for (const edge of step.edges) edges += edge.kind === "button" ? edge.count : 1;
  }
  if (ticks > 100) context.addIssue({ code: "custom", message: "Clip exceeds 100 native ticks" });
  if (edges > 256) context.addIssue({ code: "custom", message: "Clip exceeds 256 expanded edges" });
});
export const inputReceiptSchema = z.object({ operation_id: identitySchema, accepted: z.boolean(), applied_prefix: safeCounterSchema,
  stop_reason: z.enum(["completed", "cancelled", "expired", "stale", "failed", "unknown"]),
  input_application: z.enum(["confirmed", "partial", "unknown"]), effect_status: z.enum(["confirmed", "not_observed", "unknown"]),
  evidence_refs: z.array(identitySchema).max(256),
}).strict();
