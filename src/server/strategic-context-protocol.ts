import { z } from "zod";
import type { Json, ObservationV3 } from "../shared/contracts.ts";
import { adapterDescriptorSchema } from "../shared/adapter.ts";
import { identitySchema, safeCounterSchema } from "../shared/control.ts";
import type { StoredRun } from "./store.ts";
import type { StrategicContextAdapter } from "./strategic-context.ts";

export const CONTEXT_WORKER_LIMITS = Object.freeze({ requestBytes: 2 * 1024 * 1024, responseBytes: 768 * 1024,
  checkpointBytes: 512 * 1024, contextBytes: 32 * 1024, queued: 8, operations: 64, jobMs: 5_000 });
export const CONTEXT_PROTOCOL_VERSION = 1;
const text = z.string().max(8192);
const counter = safeCounterSchema;
const scopeSchema = z.object({ run_id: identitySchema, task: text, world_id: identitySchema,
  session_id: identitySchema.nullable(), life_id: counter.nullable(), native_boot_id: identitySchema.nullable(),
  space_epoch: counter.nullable(), epoch: counter, compatibility_hash: z.string().nullable(),
}).strict();
export type StrategicContextScope = z.infer<typeof scopeSchema>;
export function strategicContextScope(run: StoredRun): StrategicContextScope {
  return { run_id: run.run_id, task: run.task, world_id: run.world_id, session_id: run.session_id,
    life_id: run.life_id, native_boot_id: run.native_boot_id, space_epoch: run.space_epoch,
    epoch: run.epoch, compatibility_hash: run.compatibility_hash };
}
const adapterSchema = z.object({ descriptor: adapterDescriptorSchema,
  action_capability: z.object({ id: identitySchema, version: counter.min(1) }).strict().nullable(),
  supports_respawn: z.boolean(), bindings: z.array(z.object({ name: identitySchema, capability_id: identitySchema,
    version: counter.min(1), parameters: z.array(z.string().max(1024)).max(128),
    result: z.object({ type: z.string().max(1024), schema: z.json() }).strict().optional(),
  }).strict()).max(128),
}).strict();
export function strategicContextAdapter(adapter?: StrategicContextAdapter): StrategicContextAdapter | undefined {
  if (!adapter) return undefined;
  // Never clone a RuntimeAdapter: its predicates and native methods stay in the owner.
  return adapterSchema.parse({ descriptor: adapter.descriptor, action_capability: adapter.action_capability,
    supports_respawn: adapter.supports_respawn, bindings: adapter.bindings });
}
export const contextOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("help"), topic: z.string().max(256), value: z.json() }).strict(),
  z.object({ kind: z.literal("select"), name: z.string().max(256), version: counter.min(1) }).strict(),
]);
export type ContextOperation = z.infer<typeof contextOperationSchema>;
export interface ContextAssemblyInput {
  scope: StrategicContextScope;
  model: { api: string; provider: string };
  observation: Pick<ObservationV3, "profile_id" | "profile_configuration_hash"> | null;
  adapter?: StrategicContextAdapter;
  pendingAuthoring?: Json;
}
export const contextRequestSchema = z.object({ v: z.literal(CONTEXT_PROTOCOL_VERSION), id: counter.min(1),
  deadline_os_ns: z.string().regex(/^\d{1,24}$/), checkpoint: z.string().max(CONTEXT_WORKER_LIMITS.checkpointBytes).nullable(),
  scope: scopeSchema, model: z.object({ api: z.string().min(1).max(128), provider: z.string().min(1).max(128) }).strict(),
  observation: z.object({ profile_id: identitySchema, profile_configuration_hash: identitySchema }).strict().nullable(),
  adapter: adapterSchema.optional(), pendingAuthoring: z.json().optional(),
  operations: z.array(contextOperationSchema).max(CONTEXT_WORKER_LIMITS.operations),
}).strict();
export const contextResponseSchema = z.discriminatedUnion("ok", [
  z.object({ v: z.literal(CONTEXT_PROTOCOL_VERSION), id: counter.min(1), ok: z.literal(true),
    context: z.string().max(CONTEXT_WORKER_LIMITS.contextBytes),
    checkpoint: z.string().max(CONTEXT_WORKER_LIMITS.checkpointBytes), worker_pid: counter.min(1),
  }).strict(),
  z.object({ v: z.literal(CONTEXT_PROTOCOL_VERSION), id: counter.min(1), ok: z.literal(false),
    error: z.literal("context_worker_failed") }).strict(),
]);
export type ContextResponse = z.infer<typeof contextResponseSchema>;
