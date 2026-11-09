import { z } from "zod";
import type { Json, Sha256 } from "./contracts.ts";

export const identitySchema = z.string().min(1).max(160);
export const safeCounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export type SpaceRef = { dimension_id: string; space_epoch: number };
export type ScreenRef = { screen_id: string; incarnation: number; revision: number };
export type VisibleScreenRef = { screen_id: string; incarnation: number; layout_revision: number };
export type VisibleSlotValue = { item: string | null; count: number };
export type VisibleBounds = { x: number; y: number; width: number; height: number };
export type VisibleScreenSnapshot = {
  identity: VisibleScreenRef; content_revision: number; screen_kind: string;
  viewport: { width: number; height: number; scale_factor: number };
  slots: { slot_id: number; value: VisibleSlotValue; bounds: VisibleBounds; enabled: boolean }[];
  cursor: VisibleSlotValue;
  elements: { element_id: string; kind: string; text: string; enabled: boolean; bounds: VisibleBounds }[];
  progress: { id: string; value: number; maximum: number }[];
};
export type VisibleScreenOperation =
  | { kind: "slot"; slot_id: number; button: "left" | "right"; mode: "ordinary" | "shift" | "hotbar";
      hotbar_slot: number | null; expected_cursor: VisibleSlotValue; expected_slots: { slot_id: number; value: VisibleSlotValue }[] }
  | { kind: "element"; element_id: string; button: "left" | "right" }
  | { kind: "scroll"; element_id: string; horizontal: number; vertical: number }
  | { kind: "text"; element_id: string; text: string }
  | { kind: "key"; key: "escape" | "enter" | "backspace" | "delete" | "left" | "right" | "home" | "end" | "shift" | "control" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"; phase: "press" | "release" }
  | { kind: "close" };
export type EffectScreenPrecondition = { kind: "absent" } | { kind: "transaction"; screen: ScreenRef }
  | { kind: "layout"; screen: VisibleScreenRef };
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
  expected_screen: EffectScreenPrecondition;
  supervision?: ProducerSupervision;
}
/** Only a fresh executive decision can renew this exact finite child. */
export interface ProducerSupervision {
  session_id: string;
  behavior_generation: number;
  frame_seq: number;
}
export const producerSupervisionSchema = z.object({
  session_id: identitySchema, behavior_generation: safeCounterSchema.min(1), frame_seq: safeCounterSchema.min(1),
}).strict() satisfies z.ZodType<ProducerSupervision>;
export interface EffectOwnerRef {
  operation_id: string;
  scope: EffectScope;
}
export interface ExpectedEffectOwner extends EffectOwnerRef {
  generation: number;
}

export const spaceRefSchema = z.object({ dimension_id: identitySchema, space_epoch: safeCounterSchema }).strict();
export const screenRefSchema = z.object({ screen_id: identitySchema, incarnation: safeCounterSchema, revision: safeCounterSchema }).strict();
export const visibleScreenRefSchema = z.object({ screen_id: identitySchema, incarnation: safeCounterSchema, layout_revision: safeCounterSchema }).strict();
export const effectScreenPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("transaction"), screen: screenRefSchema }).strict(),
  z.object({ kind: z.literal("layout"), screen: visibleScreenRefSchema }).strict(),
]);
export const visibleSlotValueSchema = z.object({
  item: z.string().regex(/^[a-z][a-z0-9_./-]{0,99}$/).nullable(), count: z.number().int().min(0).max(4096),
}).strict().refine(value => value.item === null ? value.count === 0 : value.count > 0,
  { message: "Empty slots require null/zero; occupied slots require an item and positive count" });
const visibleBoundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().positive(), height: z.number().finite().positive() }).strict();
export const visibleScreenSnapshotSchema = z.object({
  identity: visibleScreenRefSchema, content_revision: safeCounterSchema, screen_kind: identitySchema,
  viewport: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive(),
    scale_factor: z.number().finite().positive() }).strict(),
  slots: z.array(z.object({ slot_id: safeCounterSchema, value: visibleSlotValueSchema,
    bounds: visibleBoundsSchema, enabled: z.boolean() }).strict()).max(128),
  cursor: visibleSlotValueSchema,
  elements: z.array(z.object({ element_id: identitySchema, kind: identitySchema, text: z.string().max(256),
    enabled: z.boolean(), bounds: visibleBoundsSchema }).strict()).max(64),
  progress: z.array(z.object({ id: identitySchema, value: z.number().finite().nonnegative(),
    maximum: z.number().finite().positive() }).strict().refine(entry => entry.value <= entry.maximum)).max(32),
}).strict().superRefine((value, context) => {
  for (const [name, ids] of [
    ["slots", value.slots.map(entry => entry.slot_id)],
    ["elements", value.elements.map(entry => entry.element_id)],
    ["progress", value.progress.map(entry => entry.id)],
  ] as const) if (new Set<string | number>(ids).size !== ids.length)
    context.addIssue({ code: "custom", path: [name], message: "Visible ids must be unique" });
  if (new TextEncoder().encode(value.elements.map(entry => entry.text).join("")).length > 8192)
    context.addIssue({ code: "custom", path: ["elements"], message: "Visible text exceeds 8192 UTF8 bytes" });
}) satisfies z.ZodType<VisibleScreenSnapshot>;
export const visibleScreenOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slot"), slot_id: safeCounterSchema, button: z.enum(["left", "right"]),
    mode: z.enum(["ordinary", "shift", "hotbar"]), hotbar_slot: z.number().int().min(0).max(8).nullable(),
    expected_cursor: visibleSlotValueSchema,
    expected_slots: z.array(z.object({ slot_id: safeCounterSchema, value: visibleSlotValueSchema }).strict()).min(1).max(16),
  }).strict().superRefine((operation, context) => {
    if ((operation.mode === "hotbar") !== (operation.hotbar_slot !== null))
      context.addIssue({ code: "custom", message: "Only hotbar mode requires a hotbar slot" });
    const ids = operation.expected_slots.map(slot => slot.slot_id);
    if (!ids.includes(operation.slot_id) || new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Unique local preconditions must include the clicked source" });
  }),
  z.object({ kind: z.literal("element"), element_id: identitySchema, button: z.enum(["left", "right"]) }).strict(),
  z.object({ kind: z.literal("scroll"), element_id: identitySchema,
    horizontal: z.number().finite().min(-16).max(16), vertical: z.number().finite().min(-16).max(16) }).strict()
    .describe("Ordinary wheel input at one current enabled rendered scroll_region from game.screen(), after visible pointer motion. Components are wheel notches; hidden page/index selection and global scrolling are unsupported. Native rechecks the actual region/layout and rejects unhandled scrolling."),
  z.object({ kind: z.literal("text"), element_id: identitySchema, text: z.string().max(256) }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(["escape", "enter", "backspace", "delete", "left", "right",
    "home", "end", "shift", "control", "1", "2", "3", "4", "5", "6", "7", "8", "9"]),
    phase: z.enum(["press", "release"]) }).strict(),
  z.object({ kind: z.literal("close") }).strict(),
]) satisfies z.ZodType<VisibleScreenOperation>;
export const screenInputActionSchema = z.object({ kind: z.literal("screen_input"), screen: visibleScreenRefSchema,
  operations: z.array(visibleScreenOperationSchema).max(16) }).strict()
  .describe("Ordinary visible vanilla GUI operations under identity/layout and local cursor/source predicates. No whole content revision comparison. Empty operations preserve the open screen without input or task success. Slot ids and visible element ids come from game.screen(); no supplied recipes, destinations or hidden offers. Text requires a visibly focused field. Unsupported controls reject. Partial work/cursor custody is not rolled back; lost ACK is unknown and never automatically replayed.");
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
    scope: effectScopeSchema, invocation: effectInvocationSchema, action, expected_screen: effectScreenPreconditionSchema,
    supervision: producerSupervisionSchema.optional(),
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
/** Host admission only: native must recheck layout and operation-local predicates at application. */
export function screenPreconditionMatches(expected: EffectScreenPrecondition, actual: ScreenRef | null): boolean {
  if (expected.kind === "absent") return actual === null;
  if (expected.kind === "transaction") return sameScreen(expected.screen, actual);
  return actual !== null && expected.screen.screen_id === actual.screen_id && expected.screen.incarnation === actual.incarnation;
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

/** Ordinary world input. Inventory is edge-only; screens and arbitrary keys are not admitted. */
export type WorldHeld = {
  forward: boolean; back: boolean; left: boolean; right: boolean; jump: boolean;
  sprint: boolean; sneak: boolean; attack: boolean; use: boolean;
};
export type ViewInput =
  | { kind: "unchanged" }
  | { kind: "delta"; yaw_radians: number; pitch_radians: number }
  | { kind: "rate"; yaw_radians_per_second: number; pitch_radians_per_second: number };
export type WorldInputEdge =
  | { kind: "button"; button: keyof WorldHeld | "inventory"; phase: "press" | "release"; count: number }
  | Extract<InputEdge, { kind: "hotbar" | "hand_swap" | "drop" }>;
export interface WorldInputStep {
  ticks: number; held: WorldHeld; edges: WorldInputEdge[]; view: ViewInput; selected_hotbar: number | null;
}
export const worldHeldSchema = z.object({
  forward: z.boolean(), back: z.boolean(), left: z.boolean(), right: z.boolean(), jump: z.boolean(),
  sprint: z.boolean(), sneak: z.boolean(), attack: z.boolean(), use: z.boolean(),
}).strict() satisfies z.ZodType<WorldHeld>;
export const viewInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchanged") }).strict()
    .describe("Requests no rotation. When applied, replaces any prior stream view rate; it does not restore an earlier pose or hold an absolute target."),
  z.object({ kind: z.literal("delta"), yaw_radians: delta.min(-2 * Math.PI).max(2 * Math.PI),
    pitch_radians: delta.min(-2 * Math.PI).max(2 * Math.PI) }).strict()
    .describe("Relative radians applied once at ordinary step entry or once when a stream snapshot begins, not spread over its duration. The full target error therefore turns immediately, not along a trajectory. Positive yaw turns right (0 faces +Z, +pi/2 faces -X); positive pitch is up. Actual pose feedback wraps yaw to [-pi,pi) and reports pitch clamped to [-pi/2,pi/2]; vanilla player/vehicle constraints determine the applied pose. Replaces any prior stream view rate."),
  z.object({ kind: z.literal("rate"), yaw_radians_per_second: delta.min(-20 * Math.PI).max(20 * Math.PI),
    pitch_radians_per_second: delta.min(-20 * Math.PI).max(20 * Math.PI) }).strict()
    .describe("Radians per second; each actual client simulation tick applies rate * 0.05, never render or wall time. Positive yaw turns right (0 faces +Z, +pi/2 faces -X); positive pitch is up. Ordinary world_input applies for the step's ticks. A stream retains the rate between commands, even after its input ACK, until replaced, cleared by a screen transition or control retires/expires; no automatic target stop. Submit unchanged or zero rate to stop rotation. Neutral held alone does not stop a retained rate. Actual pose feedback wraps yaw to [-pi,pi) and reports pitch clamped to [-pi/2,pi/2] under vanilla constraints; no sub-tick interpolation is promised."),
]) satisfies z.ZodType<ViewInput>;
export const worldInputEdgeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("button"),
    button: z.enum(["forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use", "inventory"]),
    phase, count: z.number().int().min(1).max(256) }).strict().refine(edge => edge.phase !== "release" || edge.count === 1,
    { message: "Release count must be exactly one" }),
  z.object({ kind: z.literal("hotbar"), slot: z.number().int().min(0).max(8) }).strict(),
  z.object({ kind: z.literal("hand_swap") }).strict(),
  z.object({ kind: z.literal("drop"), all: z.boolean() }).strict(),
]) satisfies z.ZodType<WorldInputEdge>;
export const worldInputStepSchema = z.object({
  ticks: z.number().int().min(1).max(100), held: worldHeldSchema
    .describe("Explicit final state after ordered button transitions from the prior step; action starts neutral. Holding attack/use does not synthesize counted presses."),
  edges: z.array(worldInputEdgeSchema).max(256)
    .describe("Press count increments ordinary counted presses, even when held; release count is exactly one. Inventory is edge-only. At most one hotbar edge per step; repeated drop edges must share one all modifier. Vanilla consumption precedence is not wire transaction order."),
  view: viewInputSchema,
  selected_hotbar: z.number().int().min(0).max(8).nullable(),
}).strict() satisfies z.ZodType<WorldInputStep>;
export const worldInputActionSchema = z.object({
  kind: z.literal("world_input"), steps: z.array(worldInputStepSchema).min(1).max(64),
}).strict().superRefine((action, context) => {
  const held: WorldHeld = { forward: false, back: false, left: false, right: false, jump: false,
    sprint: false, sneak: false, attack: false, use: false };
  let ticks = 0, expandedEdges = 0;
  for (const [index, step] of action.steps.entries()) {
    ticks += step.ticks;
    let hotbar: number | null = null, dropAll: boolean | null = null;
    for (const edge of step.edges) {
      expandedEdges += edge.kind === "button" ? edge.count : 1;
      if (edge.kind === "button" && edge.button !== "inventory") held[edge.button] = edge.phase === "press";
      if (edge.kind === "hotbar") {
        if (hotbar !== null) context.addIssue({ code: "custom", path: ["steps", index, "edges"],
          message: "A step permits at most one hotbar edge" });
        hotbar = edge.slot;
      }
      if (edge.kind === "drop") {
        if (dropAll !== null && dropAll !== edge.all) context.addIssue({ code: "custom", path: ["steps", index, "edges"],
          message: "A step cannot mix single-item and all-item drop modifiers" });
        dropAll = edge.all;
      }
    }
    for (const key of Object.keys(held) as (keyof WorldHeld)[]) {
      if (held[key] !== step.held[key]) context.addIssue({ code: "custom", path: ["steps", index, "held", key],
        message: "Held state must equal the prior state after ordered button transitions" });
    }
    if (hotbar !== null && step.selected_hotbar !== null && hotbar !== step.selected_hotbar)
      context.addIssue({ code: "custom", path: ["steps", index, "selected_hotbar"],
        message: "Hotbar edge must finish at the declared selection" });
  }
  if (ticks > 100) context.addIssue({ code: "custom", path: ["steps"], message: "World input exceeds 100 native ticks" });
  if (expandedEdges > 256) context.addIssue({ code: "custom", path: ["steps"], message: "World input exceeds 256 expanded edges" });
}).describe("Ordinary current-view native inputs, not target assistance or effect confirmation. At most 100 total native ticks and 256 expanded edges per action; each button edge contributes its count, other edges one. Declared nonnull hotbar selection must match the step's hotbar edge. Requires explicit absent screen authority and no open screen. Opening a screen ends the clip without closing it. Final trusted cleanup clears held states and pending presses; a lost acknowledgement is unknown, never automatic replay.");
