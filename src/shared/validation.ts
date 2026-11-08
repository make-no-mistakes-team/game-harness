import { z } from "zod";
import type { AdapterGoal, GameAction, MotorProfile, PlayerLifeEvent, PolicyDecision, PolicySpec, RuntimeAdapter, VerificationResult } from "./contracts.ts";
import type { SkillCapabilityRequest, SkillLimits, SkillResult, SkillStartRequest, WorkingProgramMode } from "./programs.ts";
import { DEFAULT_SKILL_LIMITS, MAX_SKILL_LIMITS, SKILL_API_VERSION } from "./programs.ts";
import type { LookaheadConfig, LookaheadRequest } from "./planning.ts";
import { identitySchema, safeCounterSchema, screenRefSchema, sha256Schema, spaceRefSchema } from "./control.ts";
import { gameActionResultSchema, jsonSchema, lifeIdSchema, playerLifeSchema, sessionIdSchema } from "./primitives.ts";
import { observationV3Schema } from "./observations.ts";
import { controllerEventSchema, residentIntentSchema, residentLimitsSchema, residentStateSchema } from "./resident.ts";
const utf8 = new TextEncoder();
export { jsonSchema, lifeIdSchema, playerLifeSchema, sessionIdSchema } from "./primitives.ts";

export const motorProfileSchema = z.enum(["precise", "balanced", "fast"]) satisfies z.ZodType<MotorProfile>;
export const workingProgramModeSchema = z.enum(["continue", "fresh"]) satisfies z.ZodType<WorkingProgramMode>;
export const playerLifeEventSchema = z.object({ type: z.enum(["death", "life"]), session_id: sessionIdSchema,
  world_id: identitySchema, epoch: safeCounterSchema, native_boot_id: identitySchema, life: playerLifeSchema,
  space: spaceRefSchema.nullable(), screen: screenRefSchema.nullable(), summary: z.string().max(1000), neutralized: z.literal(true),
}).strict() satisfies z.ZodType<PlayerLifeEvent>;
export const observationSchema = observationV3Schema;

/** Generic framing only. The selected registered adapter validates the action's real vocabulary and fields. */
export const gameActionSchema = z.object({ kind: z.string().min(1).max(80) }).catchall(jsonSchema) satisfies z.ZodType<GameAction>;

export const skillRefSchema = z.object({ skill_id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  version: safeCounterSchema.min(1) }).strict();
export const namedProgramRefSchema = z.object({ name: z.string().trim().min(1).max(80),
  version: safeCounterSchema.min(1).optional() }).strict();
export const skillLimitsSchema = z.object({ duration_ms: z.number().int().min(100).max(MAX_SKILL_LIMITS.duration_ms),
  max_actions: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_actions), max_calls: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_calls),
  max_depth: z.number().int().min(1).max(MAX_SKILL_LIMITS.max_depth),
}).strict() satisfies z.ZodType<SkillLimits>;
export const lookaheadConfigSchema = z.object({ after_ms: z.number().int().min(0).max(600000),
  activation: z.enum(["manual", "on_predecessor_success"]).default("manual"), reason: z.string().trim().min(1).max(300),
  budget: z.object({ calls: z.number().int().min(1).max(4), tools: z.number().int().min(1).max(16),
    duration_ms: z.number().int().min(1000).max(30000) }).strict(),
}).strict().describe("One host-bound speculative flight. The original deadline includes planning, predecessor drain, fresh observation, guard and durable admission; staging never extends it.") satisfies z.ZodType<LookaheadConfig>;
export const lookaheadRequestSchema = lookaheadConfigSchema.extend({ root_execution_id: z.uuid() }).strict() satisfies z.ZodType<LookaheadRequest>;
const skillStartBase = skillRefSchema.extend({ start_key: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),
  epoch: safeCounterSchema, session_id: sessionIdSchema, life_id: lifeIdSchema, native_boot_id: identitySchema,
  space_epoch: safeCounterSchema, run_generation: safeCounterSchema, compatibility_hash: sha256Schema,
  args: jsonSchema,
}).strict();
export const skillStartRequestSchema = z.discriminatedUnion("entry", [
  skillStartBase.extend({ entry: z.literal("run"), limits: skillLimitsSchema,
    lookahead: lookaheadConfigSchema.optional() }).strict(),
  skillStartBase.extend({ entry: z.literal("step"), args: residentIntentSchema,
    limits: residentLimitsSchema, initial_state: residentStateSchema, lookahead: lookaheadConfigSchema.optional() }).strict(),
]) satisfies z.ZodType<SkillStartRequest>;
export const skillResultSchema = z.object({ status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string().min(1).max(2000), result: jsonSchema }).strict() satisfies z.ZodType<SkillResult>;
const programAttentionSchema = controllerEventSchema.omit({ kind: true });
export const skillCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe") }).strict(),
  z.object({ kind: z.literal("respawn") }).strict(),
  z.object({ kind: z.literal("action"), action: gameActionSchema }).strict(),
  z.object({ kind: z.literal("adapter"), capability_id: identitySchema, version: safeCounterSchema.min(1), args: jsonSchema }).strict(),
  z.object({ kind: z.literal("call"), skill: namedProgramRefSchema, args: jsonSchema }).strict(),
  z.object({ kind: z.literal("progress"), summary: z.string().min(1).max(1000), details: jsonSchema }).strict(),
  z.object({ kind: z.literal("attention"), attention: programAttentionSchema }).strict(),
]) satisfies z.ZodType<SkillCapabilityRequest>;

export const policyDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue"), reason: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal("replan"), reason: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("interrupt"), reason: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("replace"), action: gameActionSchema, reason: z.string().min(1).max(500) }).strict(),
]) satisfies z.ZodType<PolicyDecision>;
export const policySpecSchema = z.object({ backend: z.enum(["javascript", "jev"]),
  choices: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), decision: policyDecisionSchema }).strict()).min(2).max(16).nullable(),
  name: z.string().min(1).max(80), source: z.string().min(1).max(32768).refine(value => utf8.encode(value).length <= 32768, "Policy source exceeds 32 KiB"),
  card: z.object({ purpose: z.string().min(1).max(1000), applicability: z.string().min(1).max(1000), method: z.string().min(1).max(2000),
    reason: z.string().min(1).max(1000), limitations: z.string().min(1).max(1000) }).strict(),
  priority: z.number().int().min(0).max(100), interval_ms: z.number().int().min(200).max(5000),
}).strict().superRefine((spec, context) => {
  if (spec.backend === "javascript" && spec.choices !== null || spec.backend === "jev" && spec.choices === null)
    context.addIssue({ code: "custom", message: "JavaScript requires null choices; Jev requires finite choices" });
  if (spec.choices && new Set(spec.choices.map(choice => choice.id)).size !== spec.choices.length)
    context.addIssue({ code: "custom", message: "Choice IDs must be unique" });
}) satisfies z.ZodType<PolicySpec>;
export const goalSchema = z.object({ adapter_id: identitySchema, goal_id: identitySchema,
  verifier: z.object({ id: identitySchema, version: safeCounterSchema.min(1) }).strict().nullable(), parameters: jsonSchema,
}).strict() satisfies z.ZodType<AdapterGoal>;
export const verificationResultSchema = z.object({ adapter_id: identitySchema, verifier_id: identitySchema,
  verifier_version: safeCounterSchema.min(1), status: z.enum(["verified", "failed", "incomplete", "unknown"]),
  reason: z.string().min(1).max(1000), evidence_refs: z.array(identitySchema).max(256),
}).strict().refine(value => value.status !== "verified" || value.evidence_refs.length > 0,
  { message: "Verified completion requires actual evidence references" }) satisfies z.ZodType<VerificationResult>;

const references = new WeakMap<RuntimeAdapter, object>();
export function getGameAPIReference(adapter: RuntimeAdapter) {
  const existing = references.get(adapter); if (existing) return existing;
  const methods: Record<string, object> = {
    observe: { parameters: [], result: "ObservationV3" },
    call: { parameters: [{ name: "skill", type: "NamedProgramRef" }, { name: "args", type: "Json" }], result: "SkillResult",
      contract: "game.call({name,version?},args) invokes only an already authored program captured in this parent's declared dependencies. The host pins exact versions at write/submit; omitted version requires an unambiguous captured name. It does not invoke native game bindings." },
    progress: { parameters: [{ name: "summary", type: "string" }, { name: "details", type: "Json" }], result: "null" },
    attention: { invocation: "await game.attention({urgency:'ordinary'|'urgent',summary,details})",
      parameters: [{ name: "request", type: "ProgramAttention" }], result: "void",
      contract: "Requests cognition while foreground work continues; urgent attention may revoke inactive authoring, not the actor. Charges existing shared root max_calls. No effects, playing authority, retries or extra budgets. Exact fields/limits: schemas.ProgramAttention." },
  };
  if (adapter.action_capability) {
    methods.action = { parameters: [{ name: "action", type: "AdapterAction" }], result: "GameActionResult" };
    methods.actionAndObserve = { parameters: [{ name: "action", type: "AdapterAction" }],
      result: "{action:GameActionResult,observation:ObservationV3|null}",
      contract: "One ordinary action and, after success or an explicitly neutralized failed no-world-effect refusal, a fresh ordinary observation. Both calls consume the existing root budget. The original action status/evidence is unchanged; no retry or task-success inference. Check your own postcondition in observation before deciding to stop or freshly reselect within a small bound. Unknown/cancelled/reconnect outcomes remain fenced; other failures return observation:null. Validation exceptions remain catchable invalid_request, not completed actions. Scope revocation between calls throws; no stale state fallback." };
  }
  if (adapter.supports_respawn) methods.respawn = { parameters: [], result: "GameActionResult" };
  for (const binding of adapter.bindings) methods[binding.name] = { capability_id: binding.capability_id, version: binding.version,
    invocation: `await game.${binding.name}(${binding.parameters.join(", ")})`,
    parameters: binding.parameters.map(name => ({ name, type: "Json" })), result: binding.result?.type ?? "Json",
    ...(binding.result ? { result_schema: binding.result.schema } : {}) };
  const value = { binding: "game", runtime_version: SKILL_API_VERSION, asynchronous: true, concurrent_calls: false, methods,
    adapter: adapter.descriptor,
    native_bindings: "Invoke registered native reads directly as shown by each method's invocation, with positional arguments in parameters order. capability_id and version are trusted binding metadata, not a NamedProgramRef or extra arguments. Native bindings need no program dependency declaration; program_write/program_submit dependencies list only already authored programs for game.call.",
    validation: "Host validates actual registered capability schemas and trusted adapter-owned semantic constraints before effect admission. Semantic predicates run in-process and are not serialized schema fields. Authority is host-attached, never copied from program arguments. Source validation is syntax/resource/safety validation, not a gameplay proof.",
    lifecycle: "Sessions survive healthy Pause/Stop and ordinary death. Respawn is explicit and available only when the selected adapter implements it. Unknown effects stay unknown and are never replayed automatically. Post-goal review is effect-free.",
    progress: "Program-authored progress is intent, not objective completion evidence.",
    schemas: { ObservationV3: adapter.schemas.observation, AdapterData: adapter.schemas.payload,
      capabilities: adapter.schemas.capabilities, GameActionResult: z.toJSONSchema(gameActionResultSchema),
      NamedProgramRef: z.toJSONSchema(namedProgramRefSchema), SkillResult: z.toJSONSchema(skillResultSchema),
      ProgramAttention: z.toJSONSchema(programAttentionSchema), Json: z.toJSONSchema(jsonSchema) },
  };
  references.set(adapter, value); return value;
}
