import { z } from "zod";
import { authoredControllerInputSchema } from "./controller.ts";
import { identitySchema, safeCounterSchema } from "./control.ts";
import { gameActionResultSchema, jsonSchema } from "./primitives.ts";

/** An execution contract, not a supplied policy. All gameplay choices come from source. */
export const controlSessionConfigSchema = z.object({
  schema_version: z.literal(1),
  max_tasks: safeCounterSchema.min(1).max(65536).default(4096),
  max_actions: safeCounterSchema.min(1).max(65536).default(4096),
  max_calls: safeCounterSchema.min(1).max(262144).default(16384),
  max_depth: safeCounterSchema.min(1).max(8).default(8),
  retained_tasks: safeCounterSchema.min(1).max(128).default(32),
  max_restarts: safeCounterSchema.max(16).default(0),
  recovery: z.enum(["none", "reset_safe"]).default("none"),
}).strict().superRefine((value, context) => {
  if (value.recovery === "none" && value.max_restarts !== 0)
    context.addIssue({ code: "custom", path: ["max_restarts"], message: "Restarts require an explicit model-authored reset-safe activation contract" });
});
export type ControlSessionConfig = z.infer<typeof controlSessionConfigSchema>;

export const executiveTaskRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), action: z.object({ kind: z.string().min(1).max(80) }).catchall(jsonSchema),
    duration_ms: safeCounterSchema.min(1).max(600000) }).strict(),
  z.object({ kind: z.literal("program"), program: z.object({ name: z.string().min(1).max(80), version: safeCounterSchema.min(1) }).strict(),
    args: jsonSchema, duration_ms: safeCounterSchema.min(1).max(600000) }).strict(),
]);
export type ExecutiveTaskRequest = z.infer<typeof executiveTaskRequestSchema>;

/** Keys are monotonically increasing ordinals in this source generation, never reusable IDs. */
export const executiveChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw"), input: authoredControllerInputSchema.nullable()
    .describe("Null keeps/opens the raw producer without submitting input. Fresh valid frames still renew only its short lease; prior held/view controls remain until explicitly changed or retired.") }).strict(),
  z.object({ kind: z.literal("ensure_task"), key: safeCounterSchema.min(1), request: executiveTaskRequestSchema }).strict(),
  z.object({ kind: z.literal("continue"), handle: safeCounterSchema.min(1) }).strict(),
  z.object({ kind: z.literal("cancel"), handle: safeCounterSchema.min(1) }).strict(),
  z.object({ kind: z.literal("observe") }).strict(),
]);
export type ExecutiveChoice = z.infer<typeof executiveChoiceSchema>;

export const executiveTaskSnapshotSchema = z.object({
  handle: safeCounterSchema.min(1),
  status: z.enum(["starting", "running", "retiring", "succeeded", "failed", "interrupted", "unknown", "expired_detail"]),
  request: executiveTaskRequestSchema.nullable(),
  result: gameActionResultSchema.nullable(),
  deadline_host_ms: z.number().finite().nonnegative(),
  history_ref: identitySchema,
  detail_omitted: z.boolean().optional(),
}).strict();
export type ExecutiveTaskSnapshot = z.infer<typeof executiveTaskSnapshotSchema>;

export const executiveSnapshotSchema = z.object({
  schema_version: z.literal(1), session_id: identitySchema, behavior_generation: safeCounterSchema.min(1),
  producer: z.enum(["none", "raw", "task", "retiring"]),
  task_high_water: safeCounterSchema, tasks: z.array(executiveTaskSnapshotSchema).max(128),
  tasks_omitted: safeCounterSchema.optional(),
  last_submission: z.object({
    frame_seq: safeCounterSchema.min(1), controller_generation: safeCounterSchema.min(1),
    sequence: safeCounterSchema.min(1), intent_version: safeCounterSchema,
    behavior_generation: safeCounterSchema.min(1), status: z.enum(["submitted", "coalesced"]),
  }).strict().nullable().optional().describe("Latest accepted raw submission from this producer, attributed to its source frame. Software admission only, not an application ACK or world-effect receipt. Null waits do not replace it; retirement clears it. Omission in older historical snapshots means attribution unavailable, never an inferred sequence."),
  last_command_error: z.string().max(1000).nullable(),
  restarts: safeCounterSchema, deadline_host_ms: z.number().finite().nonnegative(),
}).strict();
export type ExecutiveSnapshot = z.infer<typeof executiveSnapshotSchema>;
