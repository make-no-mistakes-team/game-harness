import { z } from "zod";
import { effectInvocationSchema, effectScopeSchema, identitySchema, safeCounterSchema } from "../shared/control.ts";
import { cognitionJsonSchema, isCognitionJson } from "./cognition-json.ts";
import { CONTEXT_WORKER_LIMITS, contextOperationSchema } from "./strategic-context-protocol.ts";
import type { ContextCheckpoint } from "./strategic-context.ts";

const counter = safeCounterSchema;
const text = z.string().max(CONTEXT_WORKER_LIMITS.checkpointBytes);
const note = cognitionJsonSchema;
const historicalScope = z.object({ world_id: identitySchema.nullable(), session_id: identitySchema.nullable(),
  life_id: counter.nullable(), native_boot_id: identitySchema.nullable(), space_epoch: counter.nullable() }).strict();
const execution = z.object({ name: z.string().max(256), version: counter.min(1), execution_ordinal: counter.min(1),
  source_hash: z.string().max(512) }).strict();
const authoredState = z.object({ author: z.literal("model"), gameplay_success_proof: z.literal(false),
  current_subgoal: z.string().max(400).nullable().optional(), worksite: note.optional(), resource_requirements: note.optional(),
  recovery_reason: z.string().max(400).nullable().optional(),
  returned_position_notes: z.array(z.object({ event_seq: counter, field: text,
    position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict() }).strict()).max(4).optional(),
  latest_progress: z.object({ event_seq: counter, summary: z.string().max(400) }).strict().optional(),
  latest_root_result: z.object({ event_seq: counter, status: text, summary: z.string().max(400), result: note }).strict().optional(),
}).strict();
const admission = z.object({ operation_id: identitySchema, scope: effectScopeSchema, invocation: effectInvocationSchema,
  controller_generation: counter.min(1), deadline_host_monotonic_ms: z.number().finite() }).strict();
const omission = z.object({ kind: text, reference: text, reason: text, original_bytes: counter.optional() }).strict();

// This schema admits only the existing reducer's passive checkpoint, never an
// Agent, provider response, observation snapshot, permit or native owner.
const checkpointSchema: z.ZodType<ContextCheckpoint> = z.object({
  runId: identitySchema.nullable(), knowledgeScope: text, dynamicScope: text, compatibility: text, sourceCompatibility: text,
  cursor: counter, sourceFloor: counter, experienceFloor: counter, noteScope: text, noteFloor: counter,
  authoredState, noteOmissions: z.array(text).max(32),
  historicalNotes: z.array(z.tuple([z.enum(["current_subgoal", "worksite"]), z.object({
    field: z.enum(["current_subgoal", "worksite"]), event_seq: counter, value: note, original_scope: historicalScope,
    historical: z.literal(true), current_authority: z.literal(false), value_omitted: z.literal(true).optional(),
  }).strict()])).max(2),
  lastExecutions: z.array(z.tuple([text, text])).max(32),
  adoptedScopes: z.array(z.tuple([text, z.object({ event_seq: counter, life_id: counter,
    native_boot_id: identitySchema, space_epoch: counter }).strict()])).max(32),
  authored: z.array(text).max(32), selected: z.array(z.object({ name: z.string().max(256), version: counter.min(1).optional() }).strict()).max(2),
  failure: counter.nullable(), unresolved: z.array(z.tuple([text, z.object({ event: counter, containment: counter.nullable(),
    original_scope: historicalScope, controller: z.object({ operation_id: identitySchema.nullable(),
      generation: counter, scope: effectScopeSchema }).strict().optional(),
  }).strict()])).max(8),
  controllerAdmissions: z.array(z.tuple([text, admission])).max(32), omittedUnknown: counter,
  help: z.array(z.object({ topic: z.string().max(256), section: text, content: note }).strict()).max(4096),
  helpSchemas: z.array(counter).max(4096), actionHelpSection: text.nullable(), helpOmissions: z.array(omission).max(24),
  authoredControllerEvents: z.array(z.object({ event_seq: counter, at: text, type: z.literal("controller.event"),
    author: z.literal("model"), gameplay_success_proof: z.literal(false), historical: z.literal(true), current_authority: z.literal(false),
    execution, producer: execution.extend({ authored_module_hash: text }).optional(),
    original_scope: historicalScope.extend({ epoch: counter }), kind: z.enum(["diagnostic", "attention"]),
    urgency: z.enum(["ordinary", "urgent"]), summary: z.string().max(240), details: note,
    summary_omitted: z.literal(true).optional(), details_omitted: z.literal(true).optional(),
  }).strict()).max(4), omittedControllerEvents: counter,
  controllerBoundaryCursor: counter, controllerBoundaryEvent: counter, controllerKnowledgeScope: text, controllerEventFloor: counter,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.helpSchemas.some(index => index >= checkpoint.help.length) || new Set(checkpoint.helpSchemas).size !== checkpoint.helpSchemas.length)
    context.addIssue({ code: "custom", message: "Invalid retained help references" });
});

const stateSchema = z.object({ v: z.literal(1), checkpoint: z.string().max(CONTEXT_WORKER_LIMITS.checkpointBytes).nullable(),
  operations: z.array(contextOperationSchema).max(CONTEXT_WORKER_LIMITS.operations) }).strict();
export type PassiveContextState = z.infer<typeof stateSchema>;
export const emptyPassiveContextState = (): PassiveContextState => ({ v: 1, checkpoint: null, operations: [] });
const fail = () => new Error("Passive cognition context custody is invalid");

export function parseContextCheckpoint(encoded: string): ContextCheckpoint {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > CONTEXT_WORKER_LIMITS.checkpointBytes) throw fail();
  const value: unknown = JSON.parse(encoded);
  if (!isCognitionJson(value)) throw fail();
  return checkpointSchema.parse(value);
}

/** Detached, byte/count bounded data, not a restored reducer or an authority. */
export function parsePassiveContextState(value: unknown): PassiveContextState {
  if (!isCognitionJson(value)) throw fail();
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > CONTEXT_WORKER_LIMITS.checkpointBytes + CONTEXT_WORKER_LIMITS.requestBytes / 2 + 4096) throw fail();
  const state = stateSchema.parse(JSON.parse(encoded));
  if (state.operations.reduce((sum, operation) => sum + Buffer.byteLength(JSON.stringify(operation)), 0) > CONTEXT_WORKER_LIMITS.requestBytes / 2) throw fail();
  if (state.checkpoint !== null) parseContextCheckpoint(state.checkpoint);
  return state;
}

export const contextCustodyTransferSchema = z.object({ sequence: counter.min(1),
  kind: z.enum(["journal", "assembled", "closed"]), context_id: z.string().min(1).max(512).nullable(),
  state: z.unknown() }).strict();
export type ContextCustodyTransfer = Omit<z.infer<typeof contextCustodyTransferSchema>, "state"> & { state: PassiveContextState };

/** Host-owned passive memory survives an actual cognition process replacement.
 * Lease identity is private host identity, not a child-supplied run/generation.
 * The caller still owns process watchdogs and checks current assembly scope.
 */
export class CognitionContextCustody {
  #state = emptyPassiveContextState();
  #runId: string | null = null;
  #owner: object | null = null;
  #sequence = 0;
  #closed = false;
  #uncertain = false;
  #candidate: { id: string; state: PassiveContextState } | null = null;

  reset(): void {
    if (this.#owner) throw fail();
    this.#state = emptyPassiveContextState(); this.#runId = null; this.#uncertain = false;
  }

  acquire(owner: object, runId: string): PassiveContextState {
    if (this.#owner || !identitySchema.safeParse(runId).success) throw fail();
    if (this.#runId !== runId) { this.#state = emptyPassiveContextState(); this.#uncertain = false; }
    this.#runId = runId; this.#owner = owner; this.#sequence = 0; this.#closed = false;
    return parsePassiveContextState(this.#state);
  }

  accept(owner: object, body: unknown, assemblyId: string | null, allowCommit: boolean): void {
    if (this.#owner !== owner || this.#closed) throw fail();
    const input = contextCustodyTransferSchema.parse(body);
    if (input.sequence !== this.#sequence + 1) throw fail();
    const state = parsePassiveContextState(input.state);
    if (input.kind === "assembled") {
      if (this.#candidate || !allowCommit || !assemblyId || input.context_id !== assemblyId || state.checkpoint === null ||
          parseContextCheckpoint(state.checkpoint).runId !== this.#runId) throw fail();
      // Transfer is not acknowledgement. Cancellation/deadline can still win
      // while the child waits for this receipt; successful context_end alone
      // promotes this candidate to the last host-committed checkpoint.
      this.#candidate = { id: assemblyId, state };
    } else {
      // A journal/close can retain operations but never acknowledge an assembly
      // or introduce a newly computed scope after cancellation/fencing.
      if (this.#candidate || input.context_id !== null || state.checkpoint !== this.#state.checkpoint ||
          state.operations.length < this.#state.operations.length || this.#state.operations.some((operation, index) =>
            JSON.stringify(operation) !== JSON.stringify(state.operations[index]))) throw fail();
      this.#state = state;
    }
    this.#sequence = input.sequence;
    if (input.kind === "closed") this.#closed = true;
  }

  settle(owner: object, assemblyId: string, successful: boolean, allowCommit: boolean): void {
    if (this.#owner !== owner || this.#closed || this.#candidate && this.#candidate.id !== assemblyId) throw fail();
    if (successful) {
      if (!allowCommit || !this.#candidate) throw fail();
      this.#state = this.#candidate.state;
    }
    this.#candidate = null;
  }

  release(owner: object): void {
    if (this.#owner !== owner) return;
    // A killed/EOF owner may have had knowledge not yet journaled. Preserve the
    // last actual host commit and report the gap, rather than claiming transfer.
    if (!this.#closed) this.#uncertain = true;
    this.#owner = null; this.#candidate = null;
  }

  status(): { uncommitted_custody: "unknown" | "none" } {
    return { uncommitted_custody: this.#uncertain ? "unknown" : "none" };
  }
}
