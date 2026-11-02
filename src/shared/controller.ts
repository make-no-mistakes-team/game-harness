import { z } from "zod";
import { effectInvocationSchema, effectScopeSchema, effectScreenPreconditionSchema, expectedEffectOwnerSchema, identitySchema, safeCounterSchema, sha256Schema,
  viewInputSchema, visibleScreenOperationSchema, visibleScreenRefSchema, worldHeldSchema,
  worldInputEdgeSchema } from "./control.ts";
import type { EffectEnvelope, ExpectedEffectOwner } from "./control.ts";
import type { Json } from "./contracts.ts";
import { gameActionResultSchema } from "./primitives.ts";

/** Native monotonic time stays exact across the entire signed Java long range. */
export const nativeNanosecondsSchema = z.string().max(20).regex(/^-?(?:0|[1-9][0-9]{0,18})$/)
  .refine(value => {
    try {
      const ns = BigInt(value);
      return ns >= -9223372036854775808n && ns <= 9223372036854775807n;
    } catch {
      return false;
    }
  }, { message: "Native nanoseconds must fit a signed Java long" });

export const residentFrameContextSchema = z.object({
  owner: expectedEffectOwnerSchema,
  controller_generation: safeCounterSchema.min(1),
  source_hash: sha256Schema,
  frame_seq: safeCounterSchema.min(1),
  observed_native_tick: safeCounterSchema,
  captured_native_ns: nativeNanosecondsSchema,
}).strict().refine(value => value.source_hash === value.owner.scope.source_hash,
  { message: "Resident frame source must match its owner", path: ["source_hash"] });
export type ResidentFrameContext = z.infer<typeof residentFrameContextSchema>;

export const controllerInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world"), held: worldHeldSchema, edges: z.array(worldInputEdgeSchema).max(256),
    view: viewInputSchema, selected_hotbar: z.number().int().min(0).max(8).nullable() }).strict(),
  z.object({ kind: z.literal("screen"), screen: visibleScreenRefSchema,
    operations: z.array(visibleScreenOperationSchema).max(16) }).strict(),
]).superRefine((input, context) => {
  if (input.kind !== "world") return;
  let expanded = 0, hotbar: number | null = null, dropAll: boolean | null = null;
  for (const edge of input.edges) {
    expanded += edge.kind === "button" ? edge.count : 1;
    if (edge.kind === "hotbar") {
      if (hotbar !== null) context.addIssue({ code: "custom", path: ["edges"], message: "At most one hotbar edge is permitted" });
      hotbar = edge.slot;
    }
    if (edge.kind === "drop") {
      if (dropAll !== null && dropAll !== edge.all)
        context.addIssue({ code: "custom", path: ["edges"], message: "Drop modifiers must agree" });
      dropAll = edge.all;
    }
  }
  if (expanded > 256) context.addIssue({ code: "custom", path: ["edges"], message: "Input exceeds 256 expanded edges" });
  if (hotbar !== null && input.selected_hotbar !== null && hotbar !== input.selected_hotbar)
    context.addIssue({ code: "custom", path: ["selected_hotbar"], message: "Hotbar edge must match the declared selection" });
});
export type ControllerInput = z.infer<typeof controllerInputSchema>;

export const controllerInputFrameSchema = z.object({ context: residentFrameContextSchema, input: controllerInputSchema }).strict();
export type ControllerInputFrame = z.infer<typeof controllerInputFrameSchema>;

export const inputSubmissionSchema = z.object({ sequence: safeCounterSchema,
  status: z.enum(["submitted", "coalesced", "rejected"]), reason: z.string().nullable() }).strict();
export type InputSubmission = z.infer<typeof inputSubmissionSchema>;

/** Actual pose, not a requested camera delta; native pitch is projected positive-up. */
export const inputAppliedAckSchema = z.object({
  controller_generation: safeCounterSchema.min(1), sequence: safeCounterSchema.min(1),
  ordered_edge_prefix: safeCounterSchema, applied_native_tick: safeCounterSchema,
  applied_native_ns: nativeNanosecondsSchema, held: worldHeldSchema,
  applied_pose: z.object({ yaw_radians: z.number().finite(),
    pitch_radians: z.number().finite().min(-Math.PI / 2).max(Math.PI / 2) }).strict(),
  input_application: z.enum(["confirmed", "partial", "unknown"]), reason: z.string().nullable(),
}).strict();
export type InputAppliedAck = z.infer<typeof inputAppliedAckSchema>;

export const revocationAckSchema = z.object({
  owner: expectedEffectOwnerSchema, controller_generation: safeCounterSchema.min(1), admission_revoked: z.literal(true),
  last_applied_sequence: safeCounterSchema, ordered_edge_prefix: safeCounterSchema,
  retirement_applied_native_tick: safeCounterSchema, retirement_applied_native_ns: nativeNanosecondsSchema,
  input_application: z.literal("confirmed"), unresolved_operation_refs: z.array(identitySchema).max(256),
}).strict();
export type RevocationAck = z.infer<typeof revocationAckSchema>;

export const controllerEffectUpdateSchema = z.object({
  controller_generation: safeCounterSchema.min(1), sequence: safeCounterSchema.min(1),
  recorded_native_ns: nativeNanosecondsSchema, result: gameActionResultSchema,
}).strict();
export type ControllerEffectUpdate = z.infer<typeof controllerEffectUpdateSchema>;
/** Host-only reservation; no invented ordinary action is used to acquire controller ownership. */
export type ControllerReservation = Omit<EffectEnvelope, "action">;
export const controllerReservationSchema = z.object({
  operation_id: identitySchema, compatibility_hash: sha256Schema, scope: effectScopeSchema,
  invocation: effectInvocationSchema, expected_screen: effectScreenPreconditionSchema,
}).strict().refine(value => value.scope.execution_id === value.invocation.execution_id &&
  value.scope.source_hash === value.invocation.source_hash, { message: "Controller invocation must match its host scope" });
export interface ControllerInputChannel {
  readonly owner: ExpectedEffectOwner;
  readonly controllerGeneration: number;
  sample(audioCursor: Json): Promise<Json>;
  submit(frame: Json, input: ControllerInput): InputSubmission;
  /** null is trusted mechanical renewal; a decision frame must still be genuinely fresh. */
  renew(frame: Json | null): Promise<void>;
  revoke(): Promise<RevocationAck>;
  snapshot(): {
    fenced: boolean; retired: boolean; submitted_sequence: number; applied_sequence: number;
    ordered_edge_prefix: number; pending_frames: number; pending_edges: number;
    last_input: InputAppliedAck | null; reason: string | null;
  };
}
