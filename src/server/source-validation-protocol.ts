import { z } from "zod";
import type { AdapterBinding } from "../shared/contracts.ts";
import type { SkillRef, SkillSpec, SkillView } from "../shared/programs.ts";
import { activeExecutableValidationSchema, adapterBindingSchema, adapterDescriptorSchema } from "../shared/adapter.ts";
import { jsonSchema } from "../shared/primitives.ts";
import type { ExecutableValidationContext } from "./program-validation.ts";
import { sourceValidationIssuesSchema } from "./program-validation.ts";

export const SOURCE_VALIDATION_LIMITS = Object.freeze({
  job_ms: 5000, concurrent_jobs: 4, graph_nodes: 256, message_bytes: 2 * 1024 * 1024,
  graph_bytes: 8 * 1024 * 1024, value_nodes: 131072, value_depth: 64,
});
export type ValidatedSourceSkill = SkillSpec & { validation: SkillView["validation"] };
export type SourceValidationRequest = {
  spec: unknown;
  snapshot?: SkillView;
  context: ExecutableValidationContext;
  binding: AdapterBinding;
  runCompatibilityHash: string | null;
};
const refSchema = z.object({ skill_id: z.string().min(1).max(160), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const dependencySchema = refSchema.extend({ import_path: z.string().max(512).optional() }).strict();
const cardSchema = z.object({ purpose: z.string().max(1000), applicability: z.string().max(1000), method: z.string().max(2000),
  reason: z.string().max(1000), limitations: z.string().max(1000) }).strict();
const validatedSchema = z.object({
  entry: z.enum(["run", "step", "analyze", "library"]), name: z.string().min(1).max(80), source: z.string().max(16384),
  card: cardSchema, dependencies: z.array(dependencySchema).max(32), validation: activeExecutableValidationSchema,
}).strict();
// Retained artifacts may have historical validation. Compatibility remains the
// existing source check's decision, not a transport upgrade of old metadata.
const artifactSchema = refSchema.extend({
  entry: z.enum(["run", "step", "analyze", "library"]).optional(), name: z.string().max(80), source: z.string().max(16384),
  hash: z.string().max(256), card: cardSchema, dependencies: z.array(dependencySchema).max(32),
  parent_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  state: z.enum(["validated", "quarantined", "retired"]), created_at: z.string().max(128),
  validation: z.object({ fingerprint: z.string().max(256), runtime_version: z.number().int().nonnegative().optional(),
    formatted_lines: z.number().int().nonnegative(), complexity: z.number().int().nonnegative(), nesting: z.number().int().nonnegative(),
    api_version: z.number().int().nonnegative().optional(), validator_version: z.number().int().nonnegative().optional(),
    compatibility_hash: z.string().max(256).optional(),
    runtime_features: z.array(z.enum(["pure_modules_v1", "motion_track_v1"])).max(2).optional(),
  }).strict(),
}).strict() satisfies z.ZodType<SkillView>;

// Invalid source metadata must reach the original validator without JSON turning
// undefined into null or NaN into null (which changes its diagnostic paths/types).
type SourceValue = [0] | [1, null | boolean | string | number] | [2, SourceValue[]] |
  [3, [string, SourceValue][]] | [4, "NaN" | "Infinity" | "-Infinity"];
const sourceValueSchema: z.ZodType<SourceValue> = z.lazy(() => z.union([
  z.tuple([z.literal(0)]), z.tuple([z.literal(1), z.union([z.null(), z.boolean(), z.string(), z.number().finite()])]),
  z.tuple([z.literal(2), z.array(sourceValueSchema)]),
  z.tuple([z.literal(3), z.array(z.tuple([z.string(), sourceValueSchema]))]),
  z.tuple([z.literal(4), z.enum(["NaN", "Infinity", "-Infinity"])]),
]));
export function encodeSourceValidationSpec(value: unknown): SourceValue {
  if (value === undefined) return [0];
  if (value === null || typeof value === "boolean" || typeof value === "string") return [1, value];
  if (typeof value === "number") return Number.isFinite(value) ? [1, value] : [4, Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity"];
  if (Array.isArray(value)) return [2, Array.from(value, encodeSourceValidationSpec)];
  if (typeof value === "object") return [3, Object.entries(value).map(([key, item]) => [key, encodeSourceValidationSpec(item)])];
  throw new Error("Invalid source metadata envelope");
}
function decodeSourceValue(value: SourceValue): unknown {
  switch (value[0]) {
    case 0: return undefined;
    case 1: return value[1];
    case 2: return value[1].map(decodeSourceValue);
    case 3: return Object.fromEntries(value[1].map(([key, item]) => [key, decodeSourceValue(item)]));
    case 4: return value[1] === "NaN" ? NaN : value[1] === "Infinity" ? Infinity : -Infinity;
  }
}
export const sourceValidationWorkerRequestSchema = z.object({
  kind: z.literal("validate"), spec: sourceValueSchema.transform(decodeSourceValue), snapshot: artifactSchema.optional(),
  context: z.object({ descriptor: adapterDescriptorSchema, schemas: z.object({ observation: jsonSchema, payload: jsonSchema,
    capabilities: z.record(z.string(), jsonSchema), evidence: z.record(z.string(), jsonSchema).optional() }).strict() }).strict(),
  binding: adapterBindingSchema, runCompatibilityHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  deadlineMonotonicNs: z.string().regex(/^[0-9]{1,30}$/),
}).strict();
export type SourceValidationWorkerRequest = z.infer<typeof sourceValidationWorkerRequestSchema>;
export const sourceValidationReadSchema = z.object({ kind: z.literal("artifact"),
  id: z.number().int().positive().max(SOURCE_VALIDATION_LIMITS.graph_nodes), artifact: artifactSchema }).strict();
export type SourceValidationRead = z.infer<typeof sourceValidationReadSchema>;
export const sourceValidationMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), id: z.number().int().positive().max(SOURCE_VALIDATION_LIMITS.graph_nodes), ref: refSchema }).strict(),
  z.object({ kind: z.literal("validated"), validated: validatedSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/), graph: z.array(refSchema).max(SOURCE_VALIDATION_LIMITS.graph_nodes) }).strict(),
  z.object({ kind: z.literal("source_error"), issues: sourceValidationIssuesSchema }).strict(),
  z.object({ kind: z.literal("known_error"), code: z.enum(["dependency_depth", "dependency_state", "dependency_api",
    "dependency_hash", "source_incompatible", "run_children", "snapshot_bytes", "snapshot_fingerprint"]) }).strict(),
  z.object({ kind: z.literal("backend_error") }).strict(),
]);
export type SourceValidationMessage = z.infer<typeof sourceValidationMessageSchema>;
export type SourceValidationResult = Extract<SourceValidationMessage, { kind: "validated" }>;
export function sourceRefKey(ref: SkillRef): string { return JSON.stringify([ref.skill_id, ref.version]); }

function assertEnvelope(value: unknown, maximumNodes: number, maximumDepth: number): void {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > maximumNodes || depth > maximumDepth)
      throw new Error("Source validation envelope exceeds limit");
    if (typeof item === "string") bytes += Buffer.byteLength(item, "utf8");
    else if (item !== null && typeof item === "object") {
      if (seen.has(item)) throw new Error("Source validation envelope must be acyclic");
      seen.add(item);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error("Source validation envelope must contain plain metadata");
      for (const key of Object.keys(item)) {
        bytes += Buffer.byteLength(key, "utf8");
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("Source validation envelope must contain plain metadata");
        visit(descriptor.value, depth + 1);
      }
      seen.delete(item);
    } else if (item !== null && !["undefined", "boolean", "number"].includes(typeof item)) {
      throw new Error("Source validation envelope must contain plain metadata");
    }
    if (bytes > SOURCE_VALIDATION_LIMITS.message_bytes) throw new Error("Source validation envelope exceeds limit");
  };
  visit(value, 0);
}
/** Bound traversal before serialization; do not invoke accessors or adapter methods. */
export function assertSourceValidationEnvelope(value: unknown): void {
  assertEnvelope(value, SOURCE_VALIDATION_LIMITS.value_nodes, SOURCE_VALIDATION_LIMITS.value_depth);
}
export function sourceValidationLine(value: unknown): string {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > SOURCE_VALIDATION_LIMITS.message_bytes) throw new Error("Source validation frame exceeds limit");
  return line;
}
/** Fragmented UTF-8 is decoded only after its bounded newline-delimited frame. */
export class SourceValidationFrames {
  #bytes = 0;
  #parts: Buffer[] = [];
  push(chunk: Buffer, accept: (value: unknown) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), through = end < 0 ? chunk.length : end + 1;
      const length = through - offset;
      if (this.#bytes + length > SOURCE_VALIDATION_LIMITS.message_bytes) throw new Error("Source validation frame exceeds limit");
      this.#parts.push(Buffer.from(chunk.subarray(offset, through))); this.#bytes += length; offset = through;
      if (end < 0) break;
      const bytes = Buffer.concat(this.#parts, this.#bytes); this.#parts = []; this.#bytes = 0;
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 1)));
      // Tags add array nodes/depth, not additional admitted source metadata.
      // Reapply the original limits after the worker decodes its request.
      assertEnvelope(value, SOURCE_VALIDATION_LIMITS.value_nodes * 4, SOURCE_VALIDATION_LIMITS.value_depth * 3 + 8);
      accept(value);
    }
  }
  finish(): void { if (this.#bytes) throw new Error("Incomplete source validation frame"); }
}
