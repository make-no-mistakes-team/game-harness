import { z } from "zod";
import type { Json } from "./contracts.ts";
import type { SpaceRef } from "./control.ts";
import { safeCounterSchema, sha256Schema, spaceRefSchema } from "./control.ts";
import { jsonSchema } from "./primitives.ts";

export interface TaskCommitment {
  revision: number;
  objective: string;
  stage: string;
  note: string;
  evidence_refs: string[];
  unresolved_operation_ids: string[];
}
export interface TaskCheckpoint {
  checkpoint_id: string;
  source_hash: string;
  state_schema: string;
  state: Json;
  commitment_revision: number;
  world_id: string;
  space: SpaceRef;
  life_id: number;
  evidence_refs: string[];
  unresolved_operation_ids: string[];
}
export const TASK_STATE_LIMITS = Object.freeze({ note_bytes: 8192, state_bytes: 49152,
  metadata_bytes: 8192, identity_bytes: 256, references: 16, request_bytes: 65536 });
const encoder = new TextEncoder();
const identity = z.string().min(1).refine(value => encoder.encode(JSON.stringify(value)).length <= TASK_STATE_LIMITS.identity_bytes,
  { message: "Serialized identity exceeds 256 UTF-8 bytes" });
const references = z.array(identity).max(TASK_STATE_LIMITS.references);
export const taskCommitmentSchema = z.object({ revision: safeCounterSchema,
  objective: z.string().max(4000), stage: z.string().max(1000), note: z.string(),
  evidence_refs: references, unresolved_operation_ids: references,
}).strict().refine(value => encoder.encode(value.note).length <= TASK_STATE_LIMITS.note_bytes,
  { message: "Commitment note exceeds 8192 UTF-8 bytes", path: ["note"] }) satisfies z.ZodType<TaskCommitment>;
export const taskCheckpointSchema = z.object({ checkpoint_id: identity, source_hash: sha256Schema,
  state_schema: identity, state: jsonSchema, commitment_revision: safeCounterSchema,
  world_id: identity, space: spaceRefSchema, life_id: safeCounterSchema,
  evidence_refs: references, unresolved_operation_ids: references,
}).strict().superRefine((value, context) => {
  const stateBytes = encoder.encode(JSON.stringify(value.state)).length;
  if (stateBytes > TASK_STATE_LIMITS.state_bytes)
    context.addIssue({ code: "custom", path: ["state"], message: "Checkpoint state exceeds 49152 UTF-8 bytes" });
  const { state: _state, ...metadata } = value;
  if (encoder.encode(JSON.stringify(metadata)).length > TASK_STATE_LIMITS.metadata_bytes)
    context.addIssue({ code: "custom", message: "Checkpoint metadata exceeds 8192 UTF-8 bytes" });
  // The actual outer worker frame must still be measured by its transport owner.
  if (encoder.encode(JSON.stringify(value)).length + 1 > TASK_STATE_LIMITS.request_bytes)
    context.addIssue({ code: "custom", message: "Checkpoint request exceeds ordinary capability frame bound" });
}) satisfies z.ZodType<TaskCheckpoint>;
