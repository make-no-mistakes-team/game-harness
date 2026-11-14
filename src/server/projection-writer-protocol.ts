import { z } from "zod";
import { projectionBatchSchema, improvementOpportunitySchema } from "./history-protocol.ts";

export const PROJECTION_WRITER_VERSION = 1;
export const PROJECTION_MESSAGE_BYTES = 128 * 1024;
export const PROJECTION_QUEUE_LIMIT = 8;
const sequence = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const deadline = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const projectionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drain") }).strict(),
  z.object({ kind: z.literal("begin"), run_id: identity, desired_through: sequence.optional() }).strict(),
  z.object({ kind: z.literal("commit"), run_id: identity, batch: projectionBatchSchema }).strict(),
  z.object({ kind: z.literal("resolve"), run_id: identity, opportunity_id: identity,
    resolution: improvementOpportunitySchema.shape.resolution.unwrap() }).strict(),
]);
export type ProjectionCommand = z.infer<typeof projectionCommandSchema>;
export const projectionMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("publication"), hash }).strict(),
  z.object({ kind: z.literal("accept"), run_id: identity, hash, source_through: sequence }).strict(),
  z.object({ kind: z.literal("audit"), run_id: identity, receipt_id: hash, payload: z.string().max(65536) }).strict(),
  z.object({ kind: z.literal("publish"), event_seq: sequence.positive() }).strict(),
]);
export type ProjectionMetadata = z.infer<typeof projectionMetadataSchema>;
const error = z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(1024) }).strict();
export const projectionReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }).strict(),
  z.object({ ok: z.literal(false), error }).strict(),
]);
export const projectionJobSchema = z.object({ v: z.literal(PROJECTION_WRITER_VERSION), type: z.literal("job"), id: sequence.positive(),
  deadline_os_ns: deadline, command: projectionCommandSchema }).strict();
export const projectionWorkerInputSchema = z.discriminatedUnion("type", [
  projectionJobSchema,
  z.object({ v: z.literal(PROJECTION_WRITER_VERSION), type: z.literal("close") }).strict(),
]);
export const projectionWorkerOutputSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(PROJECTION_WRITER_VERSION), type: z.literal("result"), id: sequence.positive(), reply: projectionReplySchema }).strict(),
  z.object({ v: z.literal(PROJECTION_WRITER_VERSION), type: z.literal("metadata"), job_id: sequence.positive(), serial: sequence.positive(),
    deadline_os_ns: deadline, command: projectionMetadataSchema }).strict(),
]);
export const projectionWorkerDataSchema = z.object({
  location: z.object({ database: z.string().min(1).max(4096), artifacts: z.string().min(1).max(4096), projection: z.string().min(1).max(4096) }).strict(),
  identity: z.object({ source_id: z.string().uuid(), projection_id: z.string().uuid() }).strict(),
}).strict();
export function projectionWireError(error: unknown): { code: string; message: string } {
  // Never copy arbitrary filesystem/SQLite/worker exception text across the seam.
  if (error instanceof Error && "code" in error &&
    (error.code === "conflict" || error.code === "not_found" || error.code === "budget_exceeded" || error.code === "history_cancelled" || error.code === "history_deadline"))
    return { code: error.code, message: error.message.slice(0, 1024) };
  return { code: "history_backend", message: "Derived history persistence could not complete safely; inspect its retained checkpoint or resolution" };
}
