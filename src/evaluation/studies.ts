import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { openGovernanceDatabase } from "./policy.ts";
import { readUsageMetrics, type EvaluationOutcome } from "./results.ts";
import { minecraftProfileConfigurationSchema } from "../shared/minecraft.ts";
import { validateAdapterDescriptor } from "../server/adapter-contract.ts";
import { minecraftSchemaCatalog } from "../server/native-contract.ts";
import { validateReferenceStudyDeclaration } from "./policy-reference-study.ts";

const text = z.string().trim().min(1);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const providerAllowance = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fileIdentity = z.object({ path: text, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const modelIdentity = z.object({ provider: text, id: text, api: text, access: text }).strict();
const slotSchema = z.object({ study_id: text, arm: text, initial_state_id: text, repetition: count }).strict();
const requestPath = z.enum(["strategic", "jev", "offline_postprocessing"]);
const manifestSchema = z.object({
  schema_version: z.literal(1), study_id: text, purpose: text, admission_mode: z.enum(["admission_only", "live"]),
  platform_evidence_revision: text,
  permission: z.object({ record: fileIdentity, scope: z.enum(["admission_only", "live"]), granted_by: text }).strict(),
  identities: z.object({ source: z.array(fileIdentity).min(1), build: fileIdentity, dependencies: fileIdentity,
    adapter: text.nullable(), game: z.object({ id: text, version: text }).strict().nullable(),
    observation_schema: count, profile: fileIdentity, helpers: z.array(fileIdentity), controller: fileIdentity.nullable(),
    preprocessing: z.array(fileIdentity), model: modelIdentity.nullable(), library: z.object({ mode: text, snapshot: text.nullable() }).strict() }).strict(),
  task: z.object({ text, identity: fileIdentity, verifier: fileIdentity, progress_predicates: z.array(text), safety_predicates: z.array(text).min(1),
    success: text, failure: text, unknown: text, horizon_ms: count }).strict(),
  execution: z.object({ start_mode: text, adaptation: text, controller_mode: text, sidecars: z.array(text), request_paths: z.array(requestPath),
    isolation: z.object({ store: text, working_programs: text, experience: text, publication: text }).strict() }).strict(),
  initial_states: z.array(z.object({ id: text, mode: text, seed: text.nullable(),
    settings: z.object({ difficulty: text, gamemode: text, cheats: z.boolean(), level_type: text, structures: z.boolean(), hardcore: z.boolean(),
      supplied_inventory: z.boolean(), console_commands: z.boolean(), fresh_world_per_slot: z.boolean() }).strict().nullable(), save: fileIdentity.nullable() }).strict()).min(1),
  arms: z.array(z.object({ id: text, description: text, model: modelIdentity.nullable(), helpers: z.array(fileIdentity), profile: fileIdentity }).strict()).min(1),
  schedule: z.array(z.object({ slot: slotSchema, order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), group: text, optional_block: text.nullable() }).strict()).min(1),
  repetitions: count, ordering: z.literal("declared"),
  optional_blocks: z.array(z.object({ id: text, slots: z.array(slotSchema).min(1), activation_rule: z.literal("operator_after_primary_before_optional") }).strict()),
  allowances: z.object({
    per_attempt: z.object({ host_requests: providerAllowance, wall_ms: count, concurrent_requests: providerAllowance, workers: count }).strict(),
    cohort: z.object({ host_requests: providerAllowance, attempt_wall_ms: count, elapsed_ms: count, concurrent_requests: providerAllowance, workers: count }).strict(),
  }).strict(),
  references: z.object({ public: z.array(fileIdentity), evaluator_data: text, actor_feedback: z.array(text) }).strict(),
  interventions: z.object({ operator_setup: text, resets: text, takeover: text, perturbations: z.array(text) }).strict(),
  analysis: z.object({ rule: text, feedback_release: text }).strict(), stop_rules: z.array(text).min(1),
  retention: z.object({ private_evidence: text, reports: text, events: text, media: text, projection_version: text, gaps: text, inaccessible_initialization: text }).strict(),
}).strict();

export type StudyManifest = z.infer<typeof manifestSchema>;
export type StudySlot = z.infer<typeof slotSchema>;
export type StudyRequestPath = z.infer<typeof requestPath>;
export interface StudyRef { studyId: string; manifestSha256: string }
export interface StudyAcceptanceSelection { studyId: string; manifestPath: string; slot: StudySlot }
export interface AttemptReservation extends StudyRef { reservationId: string; slot: StudySlot }
export interface StudyRequestReservation { requestId: string; reservationId: string; path: StudyRequestPath }
export interface StudySettlement {
  outcome: EvaluationOutcome; usage: unknown | null; evidence: readonly string[];
  stop_reason: null | "safety" | "authority" | "evaluation_leakage" | "invalid_platform" | "allowance_exhausted";
}
export interface StudyDrainConfirmation { requests_drained: boolean; runtime_closed: boolean; native_closed: boolean; evidence: readonly string[] }
export interface StudyBlockDecision { block_id: string; reason: string }
export interface StudyAttemptRecord extends AttemptReservation {
  state: "reserved" | "settled" | "interrupted"; reservedAt: number; ownerPid: number;
  settlement: StudySettlement | null; interruption: string | null;
  cleanup: { confirmed: boolean; evidence: readonly string[] };
  requests: readonly (StudyRequestReservation & { state: "reserved" | "settled" | "unknown" })[];
}
export interface StudyState {
  registeredAt: number;
  manifest: StudyManifest; closure: null | { reason: string; at: number };
  slots: readonly { slot: StudySlot; status: "scheduled" | "inactive" | "not_activated" | "reserved" | "settled" | "interrupted" | "closed_unstarted" }[];
  attempts: readonly StudyAttemptRecord[];
}

/** All reserved cohort outcomes, not the diagnostic first-success inclusion boundary. */
export function summarizeStudyUsage(state: StudyState) {
  const metrics = state.attempts.map(attempt => readUsageMetrics(attempt.settlement?.usage));
  const keys = ["uncached_input", "cache_read", "cache_write", "output"] as const;
  const totals: Record<typeof keys[number], number | null> = { uncached_input: null, cache_read: null, cache_write: null, output: null };
  const subtotal: typeof totals = { uncached_input: null, cache_read: null, cache_write: null, output: null };
  for (const key of keys) {
    if (metrics.every(usage => usage !== null && usage[key] !== null)) {
      const total = metrics.reduce((sum, usage) => sum + usage![key]!, 0);
      if (Number.isSafeInteger(total)) totals[key] = total;
    }
    for (const usage of metrics) {
      const value = usage?.reported_subtotal[key];
      if (value !== null && value !== undefined) subtotal[key] = (subtotal[key] ?? 0) + value;
    }
    if (!metrics.length) subtotal[key] = 0;
    if (subtotal[key] !== null && !Number.isSafeInteger(subtotal[key])) subtotal[key] = null;
  }
  const admissions = metrics.every(usage => usage !== null) ? metrics.reduce((sum, usage) => sum + usage!.admissions, 0) : null;
  return { scope: "all_reserved_study_outcomes" as const, scheduled_slots: state.slots.length,
    attempts_included: state.attempts.length, unresolved_or_interrupted_attempts: state.attempts.filter(attempt => attempt.state !== "settled").length,
    unsuccessful_or_unknown_attempts: state.attempts.filter(attempt => attempt.settlement?.outcome.goal_verified !== true).length,
    admissions: admissions !== null && Number.isSafeInteger(admissions) ? admissions : null,
    durable_host_request_admissions: state.attempts.reduce((sum, attempt) => sum + attempt.requests.length, 0),
    ...totals, reported_subtotal: subtotal, consumption_scope: "observed_logical_admissions" as const, wire_attempts: null, subscription_cost: null,
    limitations: ["Includes every reserved outcome, including after successes and all unsuccessful/unknown outcomes; inactive optional slots remain distinct.",
      "Durable host admission, complete consumption, observed SDK subtotals and actual wire attempts are different quantities; unknown usage is never zero-filled."] };
}

/** The implemented profile identity is checked against the actual pre-inference observation. */
export function readStudyObservationProfile(manifest: StudyManifest, projectRoot: string) {
  const file = checkedFile(realpathSync(projectRoot), manifest.identities.profile);
  const bytes = readFileSync(file, "utf8");
  requireCondition(createHash("sha256").update(bytes).digest("hex") === manifest.identities.profile.sha256, "Study profile identity changed during reading");
  const descriptor = validateAdapterDescriptor(JSON.parse(bytes), minecraftSchemaCatalog());
  minecraftProfileConfigurationSchema.parse(descriptor.observation.profile.configuration);
  requireCondition(descriptor.game.id === "minecraft" && descriptor.game.version === "1.21.4" && descriptor.adapter.id === "fabric-owned-client" &&
    descriptor.actuator === "native" && descriptor.observation.profile.id === "minecraft_assisted_rgb_360_r8_v1",
    "Unsupported materialized native adapter/profile condition");
  return descriptor;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function slotKey(slot: StudySlot): string { return canonical(slotSchema.parse(slot)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function checkedFile(project: string, identity: z.infer<typeof fileIdentity>): string {
  const path = resolve(project, identity.path), real = realpathSync(path), entry = lstatSync(path);
  requireCondition(!/(?:^|[/\\])(?:auth|credentials?)(?:[/\\]|$)|(?:auth|gameharness)\.sqlite$|(?:^|[/\\])\.env(?:\.|$)/i.test(identity.path),
    "Study identity references must not inspect credential/auth storage or secret environment files");
  requireCondition(path === real && entry.isFile() && !entry.isSymbolicLink(), "Study identity must reference a regular file without symlinks");
  const inside = relative(project, path);
  requireCondition(!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`), "Study reference identity must remain inside its declared project");
  requireCondition(createHash("sha256").update(readFileSync(path)).digest("hex") === identity.sha256, `Study identity hash mismatch: ${identity.path}`);
  return path;
}
function sourceInventory(project: string): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    const entry = lstatSync(path);
    requireCondition(!entry.isSymbolicLink(), "Study source identity cannot traverse symlinks");
    if (entry.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (entry.isFile()) files.push(path);
  };
  for (const path of ["src", "scripts", "sandbox", "native/minecraft/src"]) visit(join(project, path));
  for (const path of ["package.json", "tsconfig.json", "bunfig.toml", "native/minecraft/build.gradle", "native/minecraft/build.gradle.kts",
    "native/minecraft/settings.gradle", "native/minecraft/settings.gradle.kts", "native/minecraft/gradle.properties"]) visit(join(project, path));
  return files;
}

/** Pure/local capability and identity validation; never opens auth, providers or game resources. */
export function validateStudyManifest(input: unknown, options: { projectRoot: string }): StudyManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Study manifest must be strict and complete, with finite positive integer allowances: ${parsed.error.message}`);
  const manifest = parsed.data, project = realpathSync(options.projectRoot), identities = manifest.identities;
  requireCondition(manifest.permission.scope === manifest.admission_mode, "Study permission scope must match admission mode");
  const allFiles = [...identities.source, identities.build, identities.dependencies, identities.profile, ...identities.helpers,
    ...identities.preprocessing, ...(identities.controller ? [identities.controller] : []), manifest.permission.record, manifest.task.identity,
    manifest.task.verifier, ...manifest.references.public, ...manifest.arms.flatMap(arm => [arm.profile, ...arm.helpers]),
    ...manifest.initial_states.flatMap(state => state.save ? [state.save] : [])];
  for (const identity of allFiles) checkedFile(project, identity);
  const sources = new Set(identities.source.map(identity => resolve(project, identity.path)));
  requireCondition(sources.size === identities.source.length, "Study source identities must be unique");
  for (const path of sourceInventory(project)) requireCondition(sources.has(path), `Study source inventory changed or is incomplete: ${relative(project, path)}`);
  requireCondition(readFileSync(resolve(project, manifest.task.identity.path), "utf8").trim() === manifest.task.text, "Study task text identity mismatch");
  const execution = manifest.execution, isolation = execution.isolation;
  const reference = execution.controller_mode === "released_policy_reference";
  requireCondition(identities.library.mode === "cold" && identities.library.snapshot === null, "Inherited library execution is unsupported");
  if (reference) validateReferenceStudyDeclaration(manifest, project);
  else {
    requireCondition(execution.controller_mode === "whole_agent" && execution.adaptation === "whole_agent_run_private" && identities.controller === null,
      "Frozen/policy controller execution is unsupported; only declared whole-agent run-private adaptation or the exact released reference variant is supported");
    requireCondition(execution.sidecars.length === 0 && execution.request_paths.every(path => path === "strategic"), "Jev/sidecar/postprocessing request execution is unsupported");
    const per = manifest.allowances.per_attempt, cohort = manifest.allowances.cohort;
    requireCondition(per.host_requests > 0 && cohort.host_requests > 0 && per.concurrent_requests > 0 && cohort.concurrent_requests > 0,
      "Whole-agent/admission-only provider request allowances must remain positive");
  }
  requireCondition(new Set(execution.request_paths).size === execution.request_paths.length, "Request paths must be unique");
  requireCondition(isolation.store === "slot_private" && isolation.working_programs === "fresh" && isolation.experience === "slot_private"
    && isolation.publication === "after_cohort_closure", "Study requires cold slot-private isolation, fresh programs and withheld publication");
  requireCondition(manifest.references.evaluator_data === "withheld" && manifest.analysis.feedback_release === "after_cohort_closure",
    "Held-out evaluator data and cohort feedback must remain withheld");
  if (manifest.admission_mode === "admission_only") {
    requireCondition(execution.start_mode === "none" && execution.request_paths.length === 0 && identities.model === null && identities.adapter === null && identities.game === null,
      "Admission-only declarations cannot enable inference or native resources");
    requireCondition(manifest.initial_states.every(state => state.mode === "none" && state.seed === null && state.settings === null && state.save === null), "Admission-only initial states cannot enable native resources");
  } else if (!reference) {
    requireCondition(execution.start_mode === "fresh_seeded_world", "Restored/prepared/development-task execution is unsupported; only fresh seeded worlds are supported");
    requireCondition(identities.adapter === "fabric-owned-client" && identities.game?.id === "minecraft" && identities.game.version === "1.21.4", "Unsupported adapter/game identity");
    requireCondition(identities.model && identities.model.provider === "openai-codex" && identities.model.api === "openai-codex-responses"
      && identities.model.access === "oauth_subscription" && !/^(latest|default)$|[-/]latest$/.test(identities.model.id), "Live study requires exact model/provider/API/access identity; no fallback");
    requireCondition(execution.request_paths.length === 1, "Live study must declare the strategic request path");
    requireCondition(identities.observation_schema === 3, "Historical observation profiles are inspect-only; live studies require schema 3");
    const descriptor = readStudyObservationProfile(manifest, project);
    requireCondition(descriptor.adapter.id === identities.adapter && descriptor.game.id === identities.game.id &&
      descriptor.game.version === identities.game.version, "Declared study and negotiated descriptor identities differ");
    for (const state of manifest.initial_states) {
      requireCondition(state.mode === "fresh_seeded_world" && state.save === null && state.seed && /^-?\d+$/.test(state.seed), "Restored/prepared saves are unsupported; declare an exact fresh-world seed");
      const settings = state.settings;
      requireCondition(settings && settings.gamemode === "survival" && settings.difficulty === "normal" && !settings.cheats && settings.level_type === "minecraft:normal"
        && settings.structures && !settings.hardcore && !settings.supplied_inventory && !settings.console_commands && settings.fresh_world_per_slot,
        "Unsupported fresh-world settings; initial T00 supports ordinary fresh Normal Survival only");
    }
  }
  const armIds = new Set(manifest.arms.map(arm => arm.id)), stateIds = new Set(manifest.initial_states.map(state => state.id));
  requireCondition(armIds.size === manifest.arms.length && stateIds.size === manifest.initial_states.length, "Study arm/state identities must be unique");
  for (const arm of manifest.arms) {
    if (manifest.admission_mode === "live" && !reference) requireCondition(arm.model && arm.model.provider === "openai-codex" && arm.model.api === "openai-codex-responses"
      && arm.model.access === "oauth_subscription" && !/^(latest|default)$|[-/]latest$/.test(arm.model.id), "Each live arm requires an exact supported model/access identity; no fallback");
    else requireCondition(arm.model === null, "Admission-only/reference arms cannot enable provider inference");
    requireCondition(canonical(arm.helpers) === canonical(identities.helpers) && canonical(arm.profile) === canonical(identities.profile),
      "Unsupported helper/profile override; current arms share the exact implemented helper/profile configuration");
  }
  const slots = new Set<string>();
  for (const [order, entry] of manifest.schedule.entries()) {
    requireCondition(entry.order === order, "Study schedule must have contiguous declared order");
    requireCondition(entry.slot.study_id === manifest.study_id && armIds.has(entry.slot.arm) && stateIds.has(entry.slot.initial_state_id)
      && entry.slot.repetition <= manifest.repetitions, "Study slot references undeclared arm/state/repetition");
    const key = slotKey(entry.slot); requireCondition(!slots.has(key), "Study slots must be unique; duplicate slot"); slots.add(key);
  }
  const primary = manifest.schedule.filter(entry => entry.optional_block === null);
  requireCondition(primary.length > 0, "Study requires a primary declared block");
  const blocks = new Set<string>();
  for (const block of manifest.optional_blocks) {
    requireCondition(!blocks.has(block.id), "Duplicate optional block"); blocks.add(block.id);
    const expected = manifest.schedule.filter(entry => entry.optional_block === block.id);
    requireCondition(expected.length === primary.length && canonical(expected.map(entry => entry.slot)) === canonical(block.slots), "Optional replication must contain a preregistered whole block, not a partial subset");
    requireCondition(expected[0]!.order > primary.at(-1)!.order, "Optional replication must follow the primary block");
    const shape = (entries: typeof primary) => entries.map(entry => `${entry.slot.arm}\0${entry.slot.initial_state_id}\0${entry.group}`).sort();
    requireCondition(canonical(shape(expected)) === canonical(shape(primary)), "Optional replication must repeat the whole declared arm/state/group block");
  }
  requireCondition(manifest.schedule.every(entry => entry.optional_block === null || blocks.has(entry.optional_block)), "Schedule references an undeclared optional block");
  const per = manifest.allowances.per_attempt, cohort = manifest.allowances.cohort;
  for (const [allocation, total] of [[per.host_requests * manifest.schedule.length, cohort.host_requests], [per.wall_ms * manifest.schedule.length, cohort.attempt_wall_ms]])
    requireCondition(Number.isSafeInteger(allocation) && allocation! <= total!, "Declared cohort total cannot cover scheduled allowance allocation");
  requireCondition(per.concurrent_requests <= cohort.concurrent_requests && per.concurrent_requests <= per.host_requests && per.workers === 1
    && per.workers <= cohort.workers, "Per-attempt concurrency/worker allocation exceeds supported cohort limits");
  requireCondition(manifest.task.horizon_ms <= per.wall_ms, "Task horizon exceeds per-attempt wall allowance");
  for (const required of ["safety", "authority", "evaluation_leakage", "invalid_platform", "allowance_exhausted", "operator_interrupt"])
    requireCondition(manifest.stop_rules.includes(required), `Study stop rules must include ${required}`);
  return immutable(manifest);
}

/** Load an already registered declaration without reserving, rewriting or inferring identity. */
export function readRegisteredStudy(ledger: StudyLedger, selection: StudyAcceptanceSelection, projectRoot: string): { ref: StudyRef; manifest: StudyManifest } {
  const parsed = z.object({ studyId: text, manifestPath: text, slot: slotSchema }).strict().parse(selection);
  const path = resolve(projectRoot, parsed.manifestPath), entry = lstatSync(path);
  requireCondition(entry.isFile() && !entry.isSymbolicLink() && realpathSync(path) === path, "Study manifest must be a regular file without symlinks");
  const ref = ledger.getStudyRef(parsed.studyId);
  ledger.validateRegisteredStudy(ref);
  const manifest = validateStudyManifest(JSON.parse(readFileSync(path, "utf8")), { projectRoot });
  requireCondition(manifest.study_id === parsed.studyId && ref.manifestSha256 === createHash("sha256").update(canonical(manifest)).digest("hex"),
    "Registered study manifest identity mismatch; declarations are immutable");
  requireCondition(manifest.schedule.some(entry => slotKey(entry.slot) === slotKey(parsed.slot)), "Study slot is undeclared");
  return { ref, manifest };
}

type StudyRow = { study_id: string; fingerprint: string; manifest: string; registered_at: number; closure: string | null };
type SlotRow = { slot_key: string; study_id: string; slot: string; ordinal: number; optional_block: string | null; disposition: "scheduled" | "inactive" | "not_activated" };
type AttemptRow = { reservation_id: string; study_id: string; slot_key: string; reserved_at: number; owner_pid: number; state: StudyAttemptRecord["state"];
  settlement: string | null; interruption: string | null; cleanup: string | null; metadata: string; requests_allowance: number; wall_allowance: number; workers_allowance: number };
type RequestRow = { request_id: string; reservation_id: string; path: StudyRequestPath; state: "reserved" | "settled" | "unknown"; evidence: string | null; transport_closed: number };
const refSchema = z.object({ studyId: text, manifestSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const reservationSchema = refSchema.extend({ reservationId: text, slot: slotSchema }).strict();
const outcomeSchema = z.object({ platform_status: z.enum(["pass", "fail", "unknown"]), agent_status: z.enum(["goal_verified", "goal_not_verified", "not_run", "unknown"]),
  provider_status: z.enum(["ok", "error", "not_called", "unknown"]), goal_verified: z.boolean().nullable(), classification_reason: z.array(text) }).strict();
const settlementSchema = z.object({ outcome: outcomeSchema, usage: z.unknown(), evidence: z.array(text),
  stop_reason: z.enum(["safety", "authority", "evaluation_leakage", "invalid_platform", "allowance_exhausted"]).nullable() }).strict();

/** Same private SQLite authority as diagnostics; declarations, outcomes and cleanup remain separate. */
export class StudyLedger {
  readonly #db: ReturnType<typeof openGovernanceDatabase>;
  readonly #project: string;
  readonly #now: () => number;
  constructor(governanceRoot: string, options: { projectRoot?: string; now?: () => number } = {}) {
    this.#project = realpathSync(options.projectRoot ?? process.cwd()); this.#now = options.now ?? Date.now;
    this.#db = openGovernanceDatabase(governanceRoot);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS studies (study_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, manifest TEXT NOT NULL, registered_at INTEGER NOT NULL, closure TEXT);
      CREATE TABLE IF NOT EXISTS study_slots (slot_key TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(study_id), slot TEXT NOT NULL,
        ordinal INTEGER NOT NULL, optional_block TEXT, disposition TEXT NOT NULL, UNIQUE(study_id,ordinal));
      CREATE TABLE IF NOT EXISTS study_blocks (study_id TEXT NOT NULL REFERENCES studies(study_id), block_id TEXT NOT NULL, decision TEXT, PRIMARY KEY(study_id,block_id));
      CREATE TABLE IF NOT EXISTS study_attempts (reservation_id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES studies(study_id),
        slot_key TEXT NOT NULL UNIQUE REFERENCES study_slots(slot_key), reserved_at INTEGER NOT NULL, owner_pid INTEGER NOT NULL, state TEXT NOT NULL,
        settlement TEXT, interruption TEXT, cleanup TEXT, metadata TEXT NOT NULL, requests_allowance INTEGER NOT NULL, wall_allowance INTEGER NOT NULL, workers_allowance INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS study_requests (request_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES study_attempts(reservation_id), path TEXT NOT NULL,
        state TEXT NOT NULL, evidence TEXT, transport_closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS study_request_drains (request_id TEXT PRIMARY KEY REFERENCES study_requests(request_id), confirmed_at INTEGER NOT NULL, evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS study_attempts_cohort ON study_attempts(study_id);
      CREATE INDEX IF NOT EXISTS study_requests_owner ON study_requests(reservation_id);
    `);
  }
  close(): void { this.#db.close(); }
  #study(ref: StudyRef): StudyRow {
    refSchema.parse(ref);
    const row = this.#db.query<StudyRow, [string]>("SELECT * FROM studies WHERE study_id=?").get(ref.studyId);
    requireCondition(row && row.fingerprint === ref.manifestSha256, "Missing study or immutable manifest identity mismatch"); return row;
  }
  #attempt(reservation: AttemptReservation): AttemptRow {
    reservationSchema.parse(reservation); this.#study({ studyId: reservation.studyId, manifestSha256: reservation.manifestSha256 });
    const row = this.#db.query<AttemptRow, [string]>("SELECT * FROM study_attempts WHERE reservation_id=?").get(reservation.reservationId);
    requireCondition(row && row.study_id === reservation.studyId && row.slot_key === slotKey(reservation.slot), "Reservation/slot identity mismatch"); return row;
  }
  #close(studyId: string, reason: string): void {
    this.#db.query("UPDATE studies SET closure=? WHERE study_id=? AND closure IS NULL").run(JSON.stringify({ reason, at: this.#now() }), studyId);
  }
  #complete(studyId: string): void {
    const remaining = this.#db.query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM study_slots s LEFT JOIN study_attempts a ON a.slot_key=s.slot_key
      WHERE s.study_id=? AND s.disposition!='not_activated' AND (a.reservation_id IS NULL OR a.state='reserved' OR a.cleanup IS NULL)`).get(studyId)!.count;
    if (remaining === 0) this.#close(studyId, "cohort_complete");
  }
  #unclosed(row: StudyRow): void { requireCondition(row.closure === null, `Study admissions closed: ${row.closure}`); }
  registerStudy(input: StudyManifest): StudyRef {
    const manifest = validateStudyManifest(input, { projectRoot: this.#project }), serialized = canonical(manifest);
    const ref = { studyId: manifest.study_id, manifestSha256: createHash("sha256").update(serialized).digest("hex") };
    return this.#db.transaction(() => {
      const existing = this.#db.query<StudyRow, [string]>("SELECT * FROM studies WHERE study_id=?").get(ref.studyId);
      if (existing) { requireCondition(existing.fingerprint === ref.manifestSha256, "Registered study manifest is immutable; declaration mismatch"); return ref; }
      this.#db.query("INSERT INTO studies VALUES (?,?,?,?,NULL)").run(ref.studyId, ref.manifestSha256, serialized, this.#now());
      for (const entry of manifest.schedule) this.#db.query("INSERT INTO study_slots VALUES (?,?,?,?,?,?)").run(slotKey(entry.slot), ref.studyId, canonical(entry.slot), entry.order, entry.optional_block, entry.optional_block ? "inactive" : "scheduled");
      for (const block of manifest.optional_blocks) this.#db.query("INSERT INTO study_blocks VALUES (?,?,NULL)").run(ref.studyId, block.id);
      return ref;
    }).immediate();
  }
  getStudyRef(studyId: string): StudyRef {
    const row = this.#db.query<StudyRow, [string]>("SELECT * FROM studies WHERE study_id=?").get(text.parse(studyId));
    requireCondition(row, "Study is not registered"); return { studyId: row.study_id, manifestSha256: row.fingerprint };
  }
  validateRegisteredStudy(ref: StudyRef): StudyManifest {
    const row = this.#study(ref);
    try { return validateStudyManifest(JSON.parse(row.manifest), { projectRoot: this.#project }); }
    catch (error) {
      this.#db.transaction(() => this.#close(ref.studyId, "source_or_reference_identity_mismatch")).immediate();
      throw error;
    }
  }
  closeStudyAdmissions(ref: StudyRef, reason: string): void {
    text.parse(reason);
    this.#db.transaction(() => { this.#study(ref); this.#close(ref.studyId, reason); }).immediate();
  }
  reserveStudyAttempt(ref: StudyRef, slot: StudySlot, metadata?: { reportDirectory: string }): AttemptReservation {
    const manifest = this.validateRegisteredStudy(ref);
    if (metadata) z.object({ reportDirectory: text }).strict().parse(metadata);
    // Return an error after COMMIT, so an elapsed deadline closure survives refusal.
    const result = this.#db.transaction((): AttemptReservation | string => {
      const current = this.#study(ref); this.#unclosed(current);
      if (this.#now() >= current.registered_at + manifest.allowances.cohort.elapsed_ms) { this.#close(ref.studyId, "elapsed_deadline"); return "Study elapsed deadline closed admissions"; }
      const key = slotKey(slot), declared = this.#db.query<SlotRow, [string, string]>("SELECT * FROM study_slots WHERE slot_key=? AND study_id=?").get(key, ref.studyId);
      requireCondition(declared, "Slot is not in the declared schedule");
      requireCondition(!this.#db.query("SELECT 1 FROM study_attempts WHERE slot_key=?").get(key), "Study slot already reserved/consumed; duplicate reservation refused");
      requireCondition(declared.disposition === "scheduled", "Optional block is inactive or has an immutable declined disposition");
      const preceding = this.#db.query<{ count: number }, [string, number]>(`SELECT COUNT(*) AS count FROM study_slots s LEFT JOIN study_attempts a ON a.slot_key=s.slot_key
        WHERE s.study_id=? AND s.ordinal<? AND s.disposition!='not_activated' AND a.reservation_id IS NULL`).get(ref.studyId, declared.ordinal)!.count;
      requireCondition(preceding === 0, "Declared slot order requires preceding slots to be assigned first");
      const active = this.#db.query<{ workers: number }, [string]>("SELECT COALESCE(SUM(workers_allowance),0) AS workers FROM study_attempts WHERE study_id=? AND cleanup IS NULL").get(ref.studyId)!.workers;
      requireCondition(active + manifest.allowances.per_attempt.workers <= manifest.allowances.cohort.workers, "Cohort worker ownership/concurrency remains allocated until confirmed drain");
      const allocated = this.#db.query<{ requests: number; wall: number }, [string]>("SELECT COALESCE(SUM(requests_allowance),0) AS requests,COALESCE(SUM(wall_allowance),0) AS wall FROM study_attempts WHERE study_id=?").get(ref.studyId)!;
      const per = manifest.allowances.per_attempt;
      if (allocated.requests + per.host_requests > manifest.allowances.cohort.host_requests || allocated.wall + per.wall_ms > manifest.allowances.cohort.attempt_wall_ms) {
        this.#close(ref.studyId, "allowance_exhausted"); return "Cohort allowance exhausted";
      }
      const reservation = { ...ref, reservationId: randomUUID(), slot: JSON.parse(canonical(slot)) as StudySlot };
      this.#db.query("INSERT INTO study_attempts VALUES (?,?,?,?,?,'reserved',NULL,NULL,NULL,?,?,?,?)")
        .run(reservation.reservationId, ref.studyId, key, this.#now(), process.pid, JSON.stringify(metadata ?? {}), per.host_requests, per.wall_ms, per.workers);
      return reservation;
    }).immediate();
    if (typeof result === "string") throw new Error(result); return immutable(result);
  }
  settleStudyAttempt(reservation: AttemptReservation, input: StudySettlement): void {
    const parsed = settlementSchema.parse(input);
    requireCondition(input.usage !== undefined && (parsed.outcome.agent_status === "goal_verified") === (parsed.outcome.goal_verified === true), "Settlement requires separate valid outcomes and explicit actual usage or null");
    this.#db.transaction(() => {
      const attempt = this.#attempt(reservation); requireCondition(attempt.state === "reserved", "Study outcome history is immutable; only a reserved attempt may settle");
      const manifest: StudyManifest = JSON.parse(this.#study({ studyId: reservation.studyId, manifestSha256: reservation.manifestSha256 }).manifest);
      if (manifest.admission_mode === "admission_only") requireCondition(parsed.outcome.agent_status === "not_run" && parsed.outcome.provider_status === "not_called"
        && parsed.outcome.goal_verified === null && (parsed.usage === null || readUsageMetrics(parsed.usage)?.admissions === 0),
        "Admission-only settlement cannot fabricate provider/gameplay outcomes or usage");
      if (manifest.execution.controller_mode === "released_policy_reference")
        requireCondition(parsed.outcome.provider_status === "not_called" && (parsed.usage === null || readUsageMetrics(parsed.usage)?.admissions === 0),
          "Released reference settlement cannot fabricate provider execution or consumption");
      requireCondition(parsed.outcome.platform_status === "pass" || parsed.stop_reason !== null, "Invalid/unknown platform settlement requires an explicit admission stop reason");
      this.#db.query("UPDATE study_attempts SET state='settled',settlement=? WHERE reservation_id=?").run(JSON.stringify(parsed), reservation.reservationId);
      if (parsed.stop_reason) this.#close(reservation.studyId, parsed.stop_reason);
    }).immediate();
  }
  interruptStudyAttempt(reservation: AttemptReservation, reason: string): void {
    text.parse(reason);
    this.#db.transaction(() => {
      const attempt = this.#attempt(reservation); requireCondition(attempt.state === "reserved", "Study outcome history is immutable; only a reserved attempt may be interrupted");
      this.#db.query("UPDATE study_attempts SET state='interrupted',interruption=? WHERE reservation_id=?").run(reason, reservation.reservationId);
      this.#close(reservation.studyId, reason);
    }).immediate();
  }
  reserveStudyRequest(reservation: AttemptReservation, input: { requestId: string; path: StudyRequestPath }): StudyRequestReservation {
    z.object({ requestId: text, path: requestPath }).strict().parse(input);
    this.validateRegisteredStudy({ studyId: reservation.studyId, manifestSha256: reservation.manifestSha256 });
    return this.#db.transaction(() => {
      const attempt = this.#attempt(reservation), study = this.#study({ studyId: reservation.studyId, manifestSha256: reservation.manifestSha256 }); this.#unclosed(study);
      requireCondition(attempt.state === "reserved" && attempt.cleanup === null, "Only a live reserved attempt can admit a request");
      const manifest: StudyManifest = JSON.parse(study.manifest);
      requireCondition(manifest.admission_mode === "live" && manifest.execution.request_paths.includes(input.path), "Request path is undeclared or unsupported");
      requireCondition(this.#now() < attempt.reserved_at + attempt.wall_allowance && this.#now() < study.registered_at + manifest.allowances.cohort.elapsed_ms, "Study request wall/elapsed deadline expired");
      requireCondition(!this.#db.query("SELECT 1 FROM study_requests WHERE request_id=?").get(input.requestId), "Duplicate request identity is already consumed");
      const admissions = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM study_requests WHERE reservation_id=?").get(attempt.reservation_id)!.count;
      requireCondition(admissions < attempt.requests_allowance, "Per-attempt request allowance exhausted");
      const pending = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM study_requests WHERE reservation_id=? AND transport_closed=0").get(attempt.reservation_id)!.count;
      const cohortPending = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM study_requests r JOIN study_attempts a ON a.reservation_id=r.reservation_id WHERE a.study_id=? AND r.transport_closed=0").get(attempt.study_id)!.count;
      requireCondition(pending < manifest.allowances.per_attempt.concurrent_requests && cohortPending < manifest.allowances.cohort.concurrent_requests, "Cohort/request concurrency ownership is unresolved or at its limit");
      this.#db.query("INSERT INTO study_requests VALUES (?,?,?,'reserved',NULL,0)").run(input.requestId, attempt.reservation_id, input.path);
      return { ...input, reservationId: reservation.reservationId };
    }).immediate();
  }
  settleStudyRequest(request: StudyRequestReservation, input: { status: "settled" | "unknown"; evidence: readonly string[] }): void {
    z.object({ requestId: text, reservationId: text, path: requestPath }).strict().parse(request);
    z.object({ status: z.enum(["settled", "unknown"]), evidence: z.array(text) }).strict().parse(input);
    this.#db.transaction(() => {
      const row = this.#db.query<RequestRow, [string]>("SELECT * FROM study_requests WHERE request_id=?").get(request.requestId);
      requireCondition(row && row.reservation_id === request.reservationId && row.path === request.path && row.state === "reserved", "Request identity/terminal history is immutable");
      this.#db.query("UPDATE study_requests SET state=?,evidence=?,transport_closed=? WHERE request_id=?").run(input.status, JSON.stringify(input.evidence), input.status === "settled" ? 1 : 0, request.requestId);
    }).immediate();
  }
  /** Actual Agent/transport drain can confirm closure without inventing consumption or rewriting the unknown outcome. */
  confirmStudyRequestDrain(request: StudyRequestReservation, evidence: readonly string[]): void {
    z.array(text).min(1).parse(evidence);
    this.#db.transaction(() => {
      const row = this.#db.query<RequestRow, [string]>("SELECT * FROM study_requests WHERE request_id=?").get(request.requestId);
      requireCondition(row && row.reservation_id === request.reservationId && row.path === request.path, "Request drain identity mismatch");
      requireCondition(!this.#db.query("SELECT 1 FROM study_request_drains WHERE request_id=?").get(request.requestId), "Request drain history is immutable");
      this.#db.query("INSERT INTO study_request_drains VALUES (?,?,?)").run(request.requestId, this.#now(), JSON.stringify(evidence));
      this.#db.query("UPDATE study_requests SET transport_closed=1 WHERE request_id=?").run(request.requestId);
    }).immediate();
  }
  confirmStudyResourceDrain(reservation: AttemptReservation, input: StudyDrainConfirmation): void {
    z.object({ requests_drained: z.literal(true), runtime_closed: z.literal(true), native_closed: z.literal(true), evidence: z.array(text).min(1) }).strict().parse(input);
    this.#db.transaction(() => {
      const attempt = this.#attempt(reservation);
      requireCondition(attempt.state !== "reserved", "Cannot release a live reserved attempt's resource ownership");
      const pending = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM study_requests WHERE reservation_id=? AND transport_closed=0").get(reservation.reservationId)!.count;
      requireCondition(pending === 0, "Unresolved request ownership prevents confirmed resource drain");
      requireCondition(attempt.cleanup === null, "Cleanup confirmation history is immutable");
      this.#db.query("UPDATE study_attempts SET cleanup=? WHERE reservation_id=?").run(JSON.stringify({ confirmed: true, evidence: input.evidence, at: this.#now() }), reservation.reservationId);
      this.#complete(reservation.studyId);
    }).immediate();
  }
  #block(ref: StudyRef, decision: StudyBlockDecision, activate: boolean): void {
    z.object({ block_id: text, reason: text }).strict().parse(decision);
    this.#db.transaction(() => {
      const study = this.#study(ref);
      const block = this.#db.query<{ decision: string | null }, [string, string]>("SELECT decision FROM study_blocks WHERE study_id=? AND block_id=?").get(ref.studyId, decision.block_id);
      requireCondition(block, "Optional block is not declared"); requireCondition(block.decision === null, "Optional block disposition is immutable; already activated/declined");
      this.#unclosed(study);
      const pendingPrimary = this.#db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM study_slots s LEFT JOIN study_attempts a ON a.slot_key=s.slot_key WHERE s.study_id=? AND s.optional_block IS NULL AND (a.state IS NULL OR a.state='reserved' OR a.cleanup IS NULL)").get(ref.studyId)!.count;
      requireCondition(pendingPrimary === 0, "Optional whole-block disposition requires completed/drained primary slots");
      this.#db.query("UPDATE study_blocks SET decision=? WHERE study_id=? AND block_id=?").run(JSON.stringify({ ...decision, activated: activate, at: this.#now() }), ref.studyId, decision.block_id);
      this.#db.query("UPDATE study_slots SET disposition=? WHERE study_id=? AND optional_block=?").run(activate ? "scheduled" : "not_activated", ref.studyId, decision.block_id);
      this.#complete(ref.studyId);
    }).immediate();
  }
  activateStudyBlock(ref: StudyRef, decision: StudyBlockDecision): void { this.#block(ref, decision, true); }
  declineStudyBlock(ref: StudyRef, decision: StudyBlockDecision): void { this.#block(ref, decision, false); }
  readStudy(ref: StudyRef): StudyState {
    return this.#db.transaction(() => {
      const row = this.#study(ref), closure: StudyState["closure"] = row.closure ? JSON.parse(row.closure) : null;
      const slots = this.#db.query<SlotRow, [string]>("SELECT * FROM study_slots WHERE study_id=? ORDER BY ordinal").all(ref.studyId);
      const attempts = this.#db.query<AttemptRow, [string]>("SELECT * FROM study_attempts WHERE study_id=? ORDER BY rowid").all(ref.studyId).map((attempt): StudyAttemptRecord => ({
        ...ref, reservationId: attempt.reservation_id, slot: JSON.parse(attempt.slot_key), state: attempt.state, reservedAt: attempt.reserved_at, ownerPid: attempt.owner_pid,
        settlement: attempt.settlement ? JSON.parse(attempt.settlement) : null, interruption: attempt.interruption,
        cleanup: attempt.cleanup ? JSON.parse(attempt.cleanup) : { confirmed: false, evidence: [] },
        requests: this.#db.query<RequestRow, [string]>("SELECT * FROM study_requests WHERE reservation_id=? ORDER BY rowid").all(attempt.reservation_id).map(request => ({ requestId: request.request_id, reservationId: request.reservation_id, path: request.path, state: request.state })),
      }));
      return { registeredAt: row.registered_at, manifest: JSON.parse(row.manifest), closure, attempts, slots: slots.map((entry): StudyState["slots"][number] => {
        const attempt = attempts.find(attempt => slotKey(attempt.slot) === entry.slot_key);
        return { slot: JSON.parse(entry.slot), status: attempt?.state ?? (entry.disposition === "scheduled" && closure ? "closed_unstarted" : entry.disposition) };
      }) };
    }).deferred();
  }
}
