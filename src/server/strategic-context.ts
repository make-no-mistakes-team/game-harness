import { createHash } from "node:crypto";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import type { ActivityEvent, Json, ObservationV3, RuntimeAdapter } from "../shared/contracts.ts";
import type { SkillView } from "../shared/programs.ts";
import { PROGRAM_RESULT_GUIDANCE, SKILL_API_VERSION } from "../shared/programs.ts";
import { ProgramWorkspace, type ProgramSelector } from "./program-workspace.ts";
import type { Store, StoredRun } from "./store.ts";
import { z } from "zod";
import { effectInvocationSchema, effectScopeSchema, identitySchema, safeCounterSchema, sameEffectScope, type EffectScope } from "../shared/control.ts";
import { revocationAckSchema } from "../shared/controller.ts";
import { confirmedMinecraftGuiTransactions } from "../shared/minecraft.ts";
import { residentReceiptSchema, type ResidentReceipt } from "./resident-evidence.ts";

// Supplement only: the root prompt, current authorized observation, active SDK
// tool/result pairs and the existing 8 KiB turn feedback have their own bounds.
// 32 KiB serialized UTF-8 is small relative to the selected model's context.
// Whole source has an 18 KiB allowance; requested help may retain 24 KiB.
// These share the 32 KiB input cap, not additive reservations. Contracts,
// objective/failure/unknown references take priority over both.
const INPUT_BYTES = 32 * 1024;
const SOURCE_BYTES = 18 * 1024;
const HELP_BYTES = 24 * 1024;
const HELP_SECTION_BYTES = 6 * 1024;
const MAX_UNRESOLVED = 8;
const NOTE_BYTES = 2 * 1024;
interface Omission { kind: string; reference: string; reason: string; original_bytes?: number }
interface HelpSection { topic: string; section: string; content: Json }
interface HistoricalScope {
  world_id: string | null; session_id: string | null; life_id: number | null;
  native_boot_id: string | null; space_epoch: number | null;
}
interface UnknownReference {
  event: number; containment: number | null; original_scope: HistoricalScope;
  controller?: { operation_id: string | null; generation: number; scope: EffectScope };
}
const controllerAdmissionSchema = z.object({
  operation_id: identitySchema, scope: effectScopeSchema, invocation: effectInvocationSchema,
  controller_generation: safeCounterSchema.min(1), deadline_host_monotonic_ms: z.number().finite(),
}).strict();
const controllerRetirementSchema = z.object({ operation_id: identitySchema, ack: revocationAckSchema }).strict();
const controllerContainmentSchema = z.object({ operation_id: identitySchema, input_application: z.literal("unknown") }).strict();
interface HistoricalNote {
  field: "current_subgoal" | "worksite"; event_seq: number; value: Json; original_scope: HistoricalScope;
  historical: true; current_authority: false; value_omitted?: true;
}
interface AuthoredState {
  author: "model";
  gameplay_success_proof: false;
  current_subgoal?: string | null;
  worksite?: Json;
  resource_requirements?: Json;
  recovery_reason?: string | null;
  returned_position_notes?: { event_seq: number; field: string; position: { x: number; y: number; z: number } }[];
  latest_progress?: { event_seq: number; summary: string };
  latest_root_result?: { event_seq: number; status: string; summary: string; result: Json };
}
type ObservationIdentity = Pick<ObservationV3, "profile_id" | "profile_configuration_hash">;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
// Notes are model-authored JSON, not restored observations or executable
// authority. Keep local positions, but discard handles, snapshots and traces.
function boundedNote(value: unknown, limit = NOTE_BYTES): { value: Json; omitted: boolean } {
  let omitted = false;
  const visit = (input: unknown, depth: number): Json => {
    if (input === null || typeof input === "boolean" || typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input === "string") {
      if (input.length > 400) omitted = true;
      return input.slice(0, 400);
    }
    if (depth === 4) { omitted = true; return null; }
    if (Array.isArray(input)) {
      const result: Json[] = [];
      for (const child of input) {
        if (result.length === 16) { omitted = true; break; }
        const item = visit(child, depth + 1);
        if (bytes([...result, item]) > limit) { omitted = true; break; }
        result.push(item);
      }
      return result;
    }
    const fields = object(input), result: Record<string, Json> = {};
    if (!fields) { omitted = true; return null; }
    for (const [key, child] of Object.entries(fields)) {
      if (key.length > 80 || /(?:^|_)(?:id|ids)$/.test(key) ||
        ["target", "targets", "incarnation", "scope", "args", "history", "blocks", "entities", "observation",
          "player", "inventory", "inventory_before", "inventory_after", "space_epoch", "run_generation", "observation_seq"].includes(key)) {
        omitted = true; continue;
      }
      if (Object.keys(result).length === 32) { omitted = true; break; }
      const item = visit(child, depth + 1);
      if (bytes({ ...result, [key]: item }) > limit) { omitted = true; continue; }
      result[key] = item;
    }
    return result;
  };
  return { value: visit(value, 0), omitted };
}
function actionEvidence(value: unknown): { value: Json; omitted: boolean } | null {
  const evidence = object(value);
  if (!evidence) return null;
  const selected: Record<string, unknown> = {};
  // Mechanical receipts only. In particular, no old target, player snapshot
  // or inventory can become the next turn's target/resource authority.
  for (const key of [
    "navigation_stop_reason", "navigation_start_distance", "navigation_start_limit", "navigation_current_distance", "navigation_current_limit",
    "net_displacement", "horizontal_displacement", "height_change", "movement_start_on_ground", "movement_end",
    "placement_preflight_reason", "equipment_effect_emitted", "placement_effect_emitted", "placement_local_result",
    "world_effect_emitted", "effect_confirmed", "neutralized", "neutralized_effect", "camera_changed", "life_fenced",
    "travel_distance", "start_pose", "end_pose", "arrival_mode", "interaction_reachable", "position_range",
  ]) if (key in evidence) selected[key] = evidence[key];
  return Object.keys(selected).length ? boundedNote(selected, 1536) : null;
}
function submittedOutcome(event: ActivityEvent) {
  const details = object(event.details);
  if (event.type !== "model.tool_result" || details?.tool !== "program_submit") return null;
  const result = object(details.result), source = object(result?.source), start = object(result?.start);
  const status = start?.status;
  if (source?.status !== "persisted" || typeof source.name !== "string" ||
    typeof source.version !== "number" || !Number.isSafeInteger(source.version) || source.version < 1 ||
    status !== "unknown" && status !== "refused") return null;
  const error = object(start?.error);
  return { tool: "program_submit", source: { status: "persisted", name: source.name.slice(0, 80), version: source.version },
    start: { status, error: error ? { code: String(error.code ?? "unknown").slice(0, 80),
      message: String(error.message ?? "").slice(0, 300), retryable: false } : null } };
}
function consequential(event: ActivityEvent): boolean {
  if (["action.failed", "action.unknown", "action.cancelled", "skill.unknown", "model.tool_rejected", "runtime.uncertainty", "runtime.uncertainty_blocked"].includes(event.type)) return true;
  if (submittedOutcome(event)) return true;
  return event.type === "skill.closed" && ["failed", "blocked", "unknown", "cancelled"].includes(String(object(event.details)?.status));
}

/** Run-owned references and bounded static documentation, never an Agent transcript. */
export class StrategicContext {
  private runId: string | null = null;
  private knowledgeScope = "";
  private dynamicScope = "";
  private compatibility = "";
  private sourceCompatibility = "";
  private cursor = 0;
  private sourceFloor = 0;
  private experienceFloor = 0;
  private noteScope = "";
  private noteFloor = 0;
  private authoredState: AuthoredState = { author: "model", gameplay_success_proof: false };
  private noteOmissions = new Set<string>();
  private historicalNotes = new Map<HistoricalNote["field"], HistoricalNote>();
  private lastExecutions = new Map<string, string>();
  private adoptedScopes = new Map<string, {
    event_seq: number; life_id: number; native_boot_id: string; space_epoch: number;
  }>();
  private authored = new Set<string>();
  private selected: ProgramSelector[] = [];
  private failure: number | null = null;
  private unresolved = new Map<string, UnknownReference>();
  private controllerAdmissions = new Map<string, z.infer<typeof controllerAdmissionSchema>>();
  private omittedUnknown = 0;
  private help: HelpSection[] = [];
  private readonly helpSchemas = new WeakSet<HelpSection>();
  private actionHelpSection: string | null = null;
  private helpOmissions: Omission[] = [];

  constructor(private readonly store: Store) {}

  reset(): void {
    this.runId = null; this.knowledgeScope = ""; this.dynamicScope = ""; this.compatibility = ""; this.sourceCompatibility = "";
    this.cursor = 0; this.sourceFloor = 0; this.experienceFloor = 0; this.noteScope = ""; this.noteFloor = 0; this.authored.clear(); this.selected = [];
    this.authoredState = { author: "model", gameplay_success_proof: false }; this.noteOmissions.clear();
    this.historicalNotes.clear(); this.lastExecutions.clear();
    this.adoptedScopes.clear();
    this.failure = null; this.unresolved.clear(); this.controllerAdmissions.clear(); this.omittedUnknown = 0;
    this.help = []; this.actionHelpSection = null; this.helpOmissions = [];
  }

  private scope(run: StoredRun): void {
    if (this.runId !== run.run_id) { this.reset(); this.runId = run.run_id; }
    const knowledge = JSON.stringify([run.run_id, run.task, run.world_id]);
    if (knowledge !== this.knowledgeScope) {
      // A task/world replacement in the same run must not select prior source.
      if (this.knowledgeScope) this.experienceFloor = this.sourceFloor = this.store.lastEventSeq();
      this.knowledgeScope = knowledge; this.selected = []; this.authored.clear();
      this.unresolved.clear(); this.controllerAdmissions.clear(); this.omittedUnknown = 0; this.historicalNotes.clear(); this.lastExecutions.clear();
    }
    const dynamic = JSON.stringify([knowledge, run.session_id, run.life_id, run.native_boot_id, run.space_epoch]);
    if (dynamic !== this.dynamicScope) {
      this.dynamicScope = dynamic; this.failure = null;
    }
    const notes = JSON.stringify([dynamic, run.native_boot_id, run.space_epoch]);
    if (notes !== this.noteScope) {
      this.noteScope = notes; this.noteFloor = this.cursor;
      this.authoredState = { author: "model", gameplay_success_proof: false }; this.noteOmissions.clear();
      this.adoptedScopes.clear();
    }
  }

  synchronize(run: StoredRun, model: Pick<Model, "api" | "provider">, context: Context,
    observation: ObservationIdentity | null, adapter?: RuntimeAdapter): void {
    this.scope(run);
    // Provider transport, root prose and tool-role changes do not change the
    // validated JavaScript executable contract. Keep useful source under those
    // changes; adapter/API/profile changes still invalidate automatic selection.
    const sourceKey = JSON.stringify([SKILL_API_VERSION, run.compatibility_hash, adapter?.descriptor.executable ?? null, observation]);
    if (this.sourceCompatibility && sourceKey !== this.sourceCompatibility) {
      this.sourceFloor = this.store.lastEventSeq();
      this.authored.clear(); this.selected = []; this.lastExecutions.clear();
    }
    this.sourceCompatibility = sourceKey;
    this.actionHelpSection = adapter?.action_capability
      ? `schemas.capabilities.${adapter.action_capability.id}@${adapter.action_capability.version}` : null;
    const key = createHash("sha256").update(JSON.stringify({ api: model.api, provider: model.provider, executable: SKILL_API_VERSION,
      compatibility_hash: run.compatibility_hash, adapter: adapter?.descriptor ?? null,
      profile: observation, root: context.systemPrompt,
      tools: context.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) ?? [] })).digest("hex");
    if (key !== this.compatibility) {
      this.compatibility = key; this.help = []; this.helpOmissions = [];
    }
  }

  /** Only call for a successful tool from a complete eligible model response. */
  rememberHelp(topic: string, value: Json): void {
    this.help = this.help.filter(section => section.topic !== topic);
    this.helpOmissions = this.helpOmissions.filter(entry => !entry.reference.startsWith(`${topic}.`));
    const sections: HelpSection[] = [];
    const visit = (section: string, content: Json, depth: number, schema = false, atomic = false) => {
      const size = bytes(content);
      const fields = object(content);
      schema ||= typeof fields?.$schema === "string" || topic === "game" && section.endsWith(".result_schema");
      // A small native method can still bundle a large result DTO. Keep its
      // invocation contract separate so that DTO cannot outrank action bounds.
      const splitNativeMethod = topic === "game" && section.startsWith("methods.") && fields && "result_schema" in fields;
      if (size <= HELP_SECTION_BYTES && !splitNativeMethod) {
        const entry = { topic, section, content };
        sections.push(entry);
        if (schema) this.helpSchemas.add(entry);
      }
      else {
        if (!atomic && Array.isArray(content) && depth < 8) {
          const actionAlternatives = topic === "game" && this.actionHelpSection !== null &&
            (section === `${this.actionHelpSection}.anyOf` || section === `${this.actionHelpSection}.oneOf`);
          content.forEach((child, index) => visit(`${section}[${index}]`, child, depth + 1, schema, actionAlternatives));
        }
        else if (!atomic && fields && depth < 8) for (const [name, child] of Object.entries(fields)) visit(`${section}.${name}`, child as Json, depth + 1, schema);
        else this.helpOmissions.push({ kind: "help", reference: `${topic}.${section}`, reason: "section_byte_budget", original_bytes: size });
      }
    };
    const fields = object(value);
    if (fields) for (const [name, content] of Object.entries(fields)) visit(name, content as Json, 0);
    else visit("reference", value, 0);
    // Keep executable mechanics and native invocation contracts first.
    // Action bounds precede other reference prose, adapter metadata and DTOs;
    // whole-source and unknown-effect custody compete for the same request cap.
    // Action alternatives stay whole; oversized ones are explicitly omitted.
    // Stable order keeps the latest requested topic first within each class.
    const priority = (section: HelpSection) => {
      if (section.topic === "game" && this.actionHelpSection !== null &&
        (section.section === this.actionHelpSection || section.section.startsWith(`${this.actionHelpSection}.`))) return 1;
      if (section.topic === "programs" &&
        (section.section === "resident.response" || section.section.startsWith("resident.response."))) return 2;
      if (this.helpSchemas.has(section)) return 4;
      if (section.topic === "game" && (section.section === "adapter" || section.section.startsWith("adapter."))) return 3;
      if (section.topic === "game" && (section.section === "validation" || section.section === "lifecycle" ||
        section.section === "progress")) return 2;
      if (section.topic === "programs" && section.section !== "body" && section.section !== "world_view" &&
        section.section !== "target_transitions" && section.section !== "resident" && !section.section.startsWith("resident.")) return 2;
      return 0;
    };
    this.help = [...sections, ...this.help].sort((a, b) => priority(a) - priority(b));
    let used = 0;
    this.help = this.help.filter(section => {
      const size = bytes(section);
      if (used + size <= HELP_BYTES) { used += size; return true; }
      this.helpOmissions.push({ kind: "help", reference: `${section.topic}.${section.section}`, reason: "retained_help_byte_budget", original_bytes: size });
      return false;
    });
    this.helpOmissions = this.helpOmissions.slice(-24);
  }

  selectProgram(name: string, version: number): void {
    this.selected = [{ name, version }, ...this.selected.filter(value => value.name !== name || value.version !== version)].slice(0, 2);
  }

  private event(run: StoredRun, seq: number): ActivityEvent | null {
    const event = this.store.eventsAfter(run.run_id, seq - 1, 1)[0];
    return event?.event_seq === seq ? event : null;
  }

  private eventRoot(run: StoredRun, event: ActivityEvent): string | null {
    const details = object(event.details);
    const action = typeof details?.action_id === "string" ? this.store.getAction(run.run_id, details.action_id) : null;
    const id = typeof details?.execution_id === "string" ? details.execution_id : action?.view.execution_id;
    const execution = id ? this.store.skillExecution(run.run_id, { execution_id: id }) : null;
    return execution?.root_execution_id ?? id ?? null;
  }

  private eventScope(run: StoredRun, event: ActivityEvent): HistoricalScope {
    const details = object(event.details);
    const action = typeof details?.action_id === "string" ? this.store.getAction(run.run_id, details.action_id)?.view : null;
    const execution = typeof details?.execution_id === "string"
      ? this.store.skillExecution(run.run_id, { execution_id: details.execution_id }) : null;
    const adopted = execution ? this.adoptedScopes.get(execution.execution_id) : null;
    const scope = adopted && event.event_seq > adopted.event_seq ? adopted : execution;
    return {
      world_id: execution?.world_id ?? action?.scope?.world_id ?? (typeof details?.world_id === "string" ? details.world_id : null),
      session_id: execution?.session_id ?? action?.session_id ?? (typeof details?.session_id === "string" ? details.session_id : null),
      life_id: scope?.life_id ?? action?.life_id ?? (typeof details?.life_id === "number" ? details.life_id : null),
      native_boot_id: scope?.native_boot_id ?? action?.scope?.native_boot_id ?? (typeof details?.native_boot_id === "string" ? details.native_boot_id : null),
      space_epoch: scope?.space_epoch ?? action?.scope?.space_epoch ?? (typeof details?.space_epoch === "number" ? details.space_epoch : null),
    };
  }

  private belongs(run: StoredRun, provenance: HistoricalScope): boolean {
    for (const key of ["world_id", "session_id", "life_id", "native_boot_id", "space_epoch"] as const)
      if (provenance[key] !== null && provenance[key] !== run[key]) return false;
    return true;
  }

  private rememberHistorical(value: unknown, event: ActivityEvent, scope: HistoricalScope): void {
    const fields = object(value);
    if (!fields) return;
    for (const field of ["current_subgoal", "worksite"] as const) {
      if (!(field in fields)) continue;
      const input = fields[field];
      if (field === "current_subgoal" && input !== null && typeof input !== "string") continue;
      const note = boundedNote(input);
      if (note.value === null) this.historicalNotes.delete(field);
      else this.historicalNotes.set(field, { field, event_seq: event.event_seq, value: note.value,
        original_scope: scope, historical: true, current_authority: false, ...(note.omitted ? { value_omitted: true } : {}) });
    }
  }

  private rememberState(value: unknown): void {
    const fields = object(value);
    if (!fields) return;
    for (const key of ["current_subgoal", "worksite", "resource_requirements", "recovery_reason"] as const) {
      if (!(key in fields)) continue;
      const input = fields[key];
      if (key === "current_subgoal" || key === "recovery_reason") {
        if (input !== null && typeof input !== "string") continue;
        this.authoredState[key] = typeof input === "string" ? input.slice(0, 400) : null;
        if (typeof input === "string" && input.length > 400) this.noteOmissions.add(key);
        else this.noteOmissions.delete(key);
      } else {
        const note = boundedNote(input);
        this.authoredState[key] = note.value;
        if (note.omitted) this.noteOmissions.add(key);
        else this.noteOmissions.delete(key);
      }
    }
  }

  private residentOwner(run: StoredRun, scope: EffectScope, compatibility?: string): boolean {
    const owner = this.store.skillExecution(run.run_id, { execution_id: scope.execution_id });
    if (owner?.entry !== "step" || scope.run_id !== run.run_id || owner.source_hash !== scope.source_hash ||
        owner.compatibility_hash !== (compatibility ?? owner.compatibility_hash)) return false;
    if (owner.world_id !== scope.world_id || owner.session_id !== scope.session_id || owner.epoch !== scope.epoch ||
        owner.native_boot_id !== scope.native_boot_id || owner.run_generation !== scope.run_generation ||
        owner.life_id !== scope.life_id || owner.space_epoch !== scope.space_epoch) return false;
    return this.store.skill(run.run_id, owner).hash === scope.source_hash;
  }

  private residentReceipt(run: StoredRun, event: ActivityEvent): ResidentReceipt | null {
    const parsed = residentReceiptSchema.safeParse(event.details);
    if (!parsed.success) return null;
    const receipt = parsed.data;
    if (!this.residentOwner(run, receipt.scope, receipt.compatibility_hash) ||
        receipt.input_id !== `controller:${receipt.scope.execution_id}:${receipt.update.controller_generation}:${receipt.update.sequence}`) return null;
    return receipt;
  }

  private rememberUnknown(key: string, reference: UnknownReference): void {
    if (this.unresolved.has(key)) return;
    if (this.unresolved.size === MAX_UNRESOLVED) {
      this.unresolved.delete(this.unresolved.keys().next().value!); this.omittedUnknown++;
    }
    this.unresolved.set(key, reference);
  }

  private controllerEvent(run: StoredRun, event: ActivityEvent): void {
    if (event.type === "controller.admitted") {
      const parsed = controllerAdmissionSchema.safeParse(event.details);
      if (!parsed.success) return;
      const admission = parsed.data;
      if (admission.invocation.kind !== "skill" || admission.invocation.execution_id !== admission.scope.execution_id ||
          admission.invocation.source_hash !== admission.scope.source_hash || !this.residentOwner(run, admission.scope)) return;
      const key = `${admission.scope.execution_id}:${admission.controller_generation}`;
      this.controllerAdmissions.set(key, admission);
      if (this.controllerAdmissions.size > 32) this.controllerAdmissions.delete(this.controllerAdmissions.keys().next().value!);
    } else if (event.type === "controller.receipted") {
      const receipt = this.residentReceipt(run, event);
      if (!receipt || receipt.scope.world_id !== run.world_id) return;
      const evidence = object(receipt.update.result.evidence);
      if (receipt.update.result.status !== "unknown" && evidence?.transaction_status !== "unknown" &&
          evidence?.effect_status !== "unknown" && evidence?.input_application !== "unknown") return;
      const admission = this.controllerAdmissions.get(`${receipt.scope.execution_id}:${receipt.update.controller_generation}`);
      this.rememberUnknown(`controller:${receipt.input_id}`, {
        event: event.event_seq, containment: null, original_scope: receipt.scope,
        controller: { operation_id: admission && sameEffectScope(admission.scope, receipt.scope) ? admission.operation_id : null,
          generation: receipt.update.controller_generation, scope: receipt.scope },
      });
    } else {
      const retirement = event.type === "controller.retired" ? controllerRetirementSchema.safeParse(event.details) : null;
      const containment = event.type === "controller.contained" ? controllerContainmentSchema.safeParse(event.details) : null;
      for (const reference of this.unresolved.values()) {
        const controller = reference.controller;
        if (!controller?.operation_id) continue;
        if (retirement?.success) {
          const { operation_id, ack } = retirement.data;
          if (operation_id === controller.operation_id && ack.owner.operation_id === operation_id &&
              ack.controller_generation === controller.generation && sameEffectScope(ack.owner.scope, controller.scope))
            reference.containment = event.event_seq;
        } else if (containment?.success && containment.data.operation_id === controller.operation_id)
          reference.containment = event.event_seq;
      }
    }
  }

  private refresh(run: StoredRun): void {
    let page: ActivityEvent[];
    do {
      page = this.store.eventsAfter(run.run_id, this.cursor, 500);
      for (const event of page) {
        this.cursor = event.event_seq;
        const details = object(event.details);
        if (event.type === "skill.authored" && event.event_seq > this.sourceFloor && typeof details?.skill_id === "string" && typeof details.version === "number") {
          this.authored.add(`${details.skill_id}:${details.version}`);
          // Only the bounded catalog/recent references can be selected below.
          if (this.authored.size > 32) this.authored.delete(this.authored.values().next().value!);
        }
        // Runtime emits this only after the exact chosen root's successful
        // respawn and fresh observation. Its admission identity stays immutable;
        // only later notes use the confirmed adopted scope.
        if (event.type === "skill.life_adopted" && event.event_seq > this.experienceFloor &&
            typeof details?.execution_id === "string" && typeof details.session_id === "string" &&
            typeof details.life_id === "number" && typeof details.native_boot_id === "string" &&
            typeof details.space_epoch === "number") {
          const execution = this.store.skillExecution(run.run_id, { execution_id: details.execution_id });
          if (execution && !execution.parent_execution_id && execution.world_id === run.world_id &&
              execution.session_id === details.session_id) {
            this.adoptedScopes.set(execution.execution_id, { event_seq: event.event_seq, life_id: details.life_id,
              native_boot_id: details.native_boot_id, space_epoch: details.space_epoch });
            if (this.adoptedScopes.size > 32) this.adoptedScopes.delete(this.adoptedScopes.keys().next().value!);
          }
        }
        if (event.event_seq <= this.experienceFloor) continue;
        if (["controller.admitted", "controller.receipted", "controller.retired", "controller.contained"].includes(event.type)) {
          this.controllerEvent(run, event);
          continue;
        }
        const originalScope = this.eventScope(run, event);
        if (originalScope.world_id !== null && originalScope.world_id !== run.world_id) continue;
        if (event.type === "skill.accepted" && event.event_seq > this.sourceFloor &&
            typeof details?.skill_id === "string" && typeof details.version === "number" && typeof details.execution_id === "string") {
          const key = `${details.skill_id}:${details.version}`;
          this.lastExecutions.delete(key); this.lastExecutions.set(key, details.execution_id);
          if (this.lastExecutions.size > 32) this.lastExecutions.delete(this.lastExecutions.keys().next().value!);
        }
        if ((event.type === "skill.progress" || event.type === "skill.closed") && typeof details?.execution_id === "string") {
          const execution = this.store.skillExecution(run.run_id, { execution_id: details.execution_id });
          if (execution && (event.type === "skill.progress" || !execution.parent_execution_id))
            this.rememberHistorical(event.type === "skill.progress" ? details.details : execution.result?.result, event, originalScope);
        }
        // No-replay is historical knowledge, independent of current authority.
        // Containment records emitter closure, not proof of no old world effect.
        const submission = submittedOutcome(event);
        const key = submission && typeof details?.tool_call_id === "string" ? `submission:${details.tool_call_id}`
          : typeof details?.action_id === "string" ? `action:${details.action_id}`
          : typeof details?.execution_id === "string" ? `execution:${details.execution_id}` : null;
        if (key && (event.type === "runtime.uncertainty_reconciled" || event.type === "runtime.uncertainty_blocked")) {
          const unresolved = this.unresolved.get(key);
          if (unresolved) unresolved.containment = event.event_seq;
        } else if (key && (submission?.start.status === "unknown" || event.type === "runtime.uncertainty" ||
            event.type === "action.unknown" || event.type === "skill.unknown" ||
            event.type === "skill.closed" && details?.status === "unknown")) {
          this.rememberUnknown(key, { event: event.event_seq, containment: null, original_scope: originalScope });
        }
        if (!this.belongs(run, originalScope)) continue;
        if ((event.type === "skill.progress" || event.type === "skill.closed") && typeof details?.execution_id === "string") {
          const execution = this.store.skillExecution(run.run_id, { execution_id: details.execution_id });
          const adopted = this.adoptedScopes.get(details.execution_id);
          const scope = adopted && event.event_seq > adopted.event_seq ? adopted : execution;
          const currentNotes = execution && event.event_seq > this.noteFloor &&
            scope?.native_boot_id === run.native_boot_id && scope?.space_epoch === run.space_epoch;
          if (currentNotes && event.type === "skill.progress") {
            this.authoredState.latest_progress = { event_seq: event.event_seq, summary: event.summary.slice(0, 400) };
            this.rememberState(details?.details);
          }
          if (currentNotes && event.type === "skill.closed" && !execution.parent_execution_id && execution.result) {
            const note = boundedNote(execution.result.result);
            this.authoredState.latest_root_result = { event_seq: event.event_seq, status: execution.result.status,
              summary: execution.result.summary.slice(0, 400), result: note.value };
            this.rememberState(execution.result.result);
            // Preserve only coordinates actually returned by the model's
            // procedure, under their original field labels. Do not infer a
            // worksite, route, target or task strategy from those coordinates.
            for (const [field, item] of Object.entries(object(note.value) ?? {})) {
              const member = object(item), position = object(member?.position) ?? member;
              if (!position || !["x", "y", "z"].every(axis => typeof position[axis] === "number" && Number.isFinite(position[axis]))) continue;
              const returned = { event_seq: event.event_seq, field,
                position: { x: position.x as number, y: position.y as number, z: position.z as number } };
              const previous = this.authoredState.returned_position_notes ?? [];
              if (previous.length === 4 && !previous.some(value => value.field === field)) this.noteOmissions.add("returned_position_notes");
              this.authoredState.returned_position_notes = [returned, ...previous.filter(value => value.field !== field)].slice(0, 4);
            }
            if (note.omitted) this.noteOmissions.add("latest_root_result");
            else this.noteOmissions.delete("latest_root_result");
          }
        }
        // A generic root closure cannot replace the actual refusal/uncertain
        // action that caused it. A later root can have a new obstruction.
        if (consequential(event)) {
          const previous = this.failure ? this.event(run, this.failure) : null;
          const root = event.type === "skill.closed" ? this.eventRoot(run, event) : null;
          if (!previous || previous.type === "skill.closed" || !root || root !== this.eventRoot(run, previous))
            this.failure = event.event_seq;
        }
      }
    } while (page.length === 500);
  }

  private eventView(run: StoredRun, seq: number) {
    const event = this.event(run, seq);
    if (!event) return null;
    const details = object(event.details), error = object(details?.error);
    if (event.type === "controller.receipted") {
      const receipt = this.residentReceipt(run, event);
      if (!receipt) return null;
      const input = receipt.input;
      const confirmed = input.kind === "screen" ? confirmedMinecraftGuiTransactions({
        kind: "screen_input", screen: input.screen, operations: input.operations,
      }, receipt.update.result.evidence).map(fact => fact.operation_index) : [];
      // Retain identity and operation dispositions, not stale GUI handles or
      // replayable arguments. The original exact input remains in Store.
      return { event_seq: seq, type: event.type, summary: event.summary.slice(0, 400),
        input_id: receipt.input_id, controller_generation: receipt.update.controller_generation,
        sequence: receipt.update.sequence, recorded_native_ns: receipt.update.recorded_native_ns,
        result_summary: receipt.update.result.summary.slice(0, 400), status: "unknown",
        input: input.kind === "screen" ? { kind: "screen", operation_kinds: input.operations.map(operation => operation.kind),
          confirmed_operation_indexes: confirmed,
          unconfirmed_operation_indexes: input.operations.map((_, index) => index).filter(index => !confirmed.includes(index)) }
          : { kind: "world", edge_count: input.edges.length, view_kind: input.view.kind } };
    }
    if (event.type === "controller.retired" || event.type === "controller.contained")
      return { event_seq: seq, type: event.type, summary: event.summary.slice(0, 400), emitter_closed: true,
        world_effects_resolved: false, input_application: event.type === "controller.retired" ? "confirmed" : "unknown" };
    const submission = submittedOutcome(event);
    if (submission) return { event_seq: seq, type: event.type, summary: event.summary.slice(0, 400), ...submission,
      status: submission.start.status, ...(submission.start.status === "unknown" ? { no_replay: true } : {}) };
    const action = typeof details?.action_id === "string" ? this.store.getAction(run.run_id, details.action_id)?.view
      : event.type === "skill.closed" && typeof details?.execution_id === "string"
        ? this.store.selectedAction(run.run_id, "latest", details.execution_id) : null;
    const result = object(details?.result) ?? object(action?.result);
    const evidence = actionEvidence(result?.evidence);
    const status = details?.status ?? result?.status ?? (event.type === "skill.unknown" ? "unknown" : undefined);
    return { event_seq: seq, type: event.type, summary: event.summary.slice(0, 400),
      ...(typeof status === "string" ? { status: status.slice(0, 80) } : {}),
      ...(action ? { action_kind: action.kind, action_status: action.status } : {}),
      ...(evidence ? { evidence: evidence.value, ...(evidence.omitted ? { evidence_omitted: true } : {}) } : {}),
      ...(result?.requires_reconnect === true ? { requires_reconnect: true } : {}),
      ...(error ? { error: { code: String(error.code ?? "unknown").slice(0, 80), message: String(error.message ?? "").slice(0, 300) } } : {}) };
  }

  private programExecution(run: StoredRun, program: SkillView, workspace: ProgramWorkspace) {
    const id = this.lastExecutions.get(`${program.skill_id}:${program.version}`);
    const execution = id ? this.store.skillExecution(run.run_id, { execution_id: id }) : null;
    if (!execution || execution.world_id !== run.world_id || execution.compatibility_hash !== run.compatibility_hash) return null;
    const reference = workspace.executionReference(execution.execution_id);
    if (!reference) return null;
    const args = boundedNote(execution.args, 1024);
    const result = execution.result ? boundedNote(execution.result.result, 1024) : null;
    return { ...reference, historical: true, current_authority: false, gameplay_success_proof: false,
      original_scope: { world_id: execution.world_id, session_id: execution.session_id, life_id: execution.life_id,
        native_boot_id: execution.native_boot_id, space_epoch: execution.space_epoch },
      status: execution.status, actions: execution.actions, calls: execution.calls,
      argument_sample: args.value, ...(args.omitted ? { argument_sample_omitted: true } : {}),
      outcome: execution.result ? { status: execution.result.status, summary: execution.result.summary.slice(0, 400),
        result: result!.value, ...(result!.omitted ? { result_omitted: true } : {}) } : null,
      ...(execution.error ? { error: execution.error.slice(0, 300) } : {}) };
  }

  assemble(run: StoredRun, adapter?: RuntimeAdapter): string {
    this.scope(run); this.refresh(run);
    const workspace = new ProgramWorkspace(this.store, run.run_id);
    const omissions: Omission[] = [...this.helpOmissions];
    const latest = this.store.latestRootExecution(run.run_id);
    const candidates: SkillView[] = [];
    const add = (program: SkillView | null) => {
      if (!program || candidates.some(value => value.skill_id === program.skill_id && value.version === program.version)) return;
      if (program.validation.runtime_version !== SKILL_API_VERSION || program.validation.api_version !== SKILL_API_VERSION ||
        program.validation.validator_version !== SKILL_API_VERSION || program.validation.compatibility_hash !== run.compatibility_hash ||
        this.sourceFloor && !this.authored.has(`${program.skill_id}:${program.version}`) &&
          !this.selected.some(selector => selector.name === program.name && selector.version === program.version)) return;
      candidates.push(program);
    };
    if (latest) add(this.store.skill(run.run_id, latest));
    for (const selector of this.selected) add(this.store.namedSkill(run.run_id, selector.name, selector.version));
    for (const entry of workspace.catalog(0, 3).records) add(this.store.namedSkill(run.run_id, entry.name, entry.version));
    const contracts = {
      api_version: SKILL_API_VERSION,
      body: "Selected run entry: async JavaScript BODY(game,args), one awaited capability at a time, returning {status:'completed'|'blocked'|'failed',summary:string,result:JSON}. Selected step/analyze: ordinary module with one synchronous named export step(frame,state,intent) or analyze(input); pure helpers/constants allowed. No imports/packages/ambient host access. Source original/canonical <=16 KiB UTF-8. Resident state/intent <=16 KiB and complete output <=64 KiB/depth32. Inspect help programs for exact contracts.",
      result: PROGRAM_RESULT_GUIDANCE,
      programs: "Immutable named versions. Existing name requires based_on latest. Write saves only; ordinary-only program_submit explicitly writes and starts that exact version through ordinary admission; program_run starts existing. Dependencies are pinned. Validation is not gameplay proof; completed program is not task success.",
      freshness: "Retained source/docs and model-authored state are historical reference only, never authority or gameplay proof. Worksite/local positions require fresh reacquisition. Current authorized observation, especially inventory, and later observe results outrank notes. Life/session/boot/space changes discard current dynamic notes; explicit world-local objective/worksite notes and no-replay uncertainty remain historical with original scope. Task/world/fresh-run changes discard experience. Program argument samples/outcomes are sanitized historical examples, never restored inputs or recommendations to rerun blocked/unknown procedures. Resolve fresh targets and construct current args; no target handles, roots, effects or execution state are restored.",
      recovery: "Settled failed no-effect rejection with valid current authority may fresh-observe and boundedly reselect within the same procedure. Unknown/cancelled/reconnected effects must stop and reconcile, never blind retry. Emitter closure and fresh observation do not prove an old unknown effect did not happen.",
      requested_help: "Retained help is partial; re-request help({topic:'game'}) or its topic before relying on missing contracts. Omission references name missing sections; omitted_records counts excluded notices/details. Receipt detail_omitted marks request-budget loss; evidence_omitted also preserves original partial evidence. Inspect authorized event references for full retained detail.",
      game: { binding: "game", methods: ["observe()", "call({name,version?},args)", "progress(summary,details)",
        ...(adapter?.action_capability ? ["action(action)", "actionAndObserve(action) -> {action,observation}"] : []), ...(adapter?.supports_respawn ? ["respawn()"] : [])],
        local_feedback: "actionAndObserve performs one ordinary action then fresh observation after success or settled failed no-world-effect/neutralized evidence. It preserves the raw action status, never retries, and charges both existing budgets. Use your own observed postcondition to decide completion or bounded fresh reselection. Unknown/cancelled/reconnect remain fenced; ineligible outcomes have observation:null. Observation failure propagates, never stale fallback.",
        adapter_bindings: adapter?.bindings.map(binding => ({ name: binding.name, version: binding.version, parameters: binding.parameters })) ?? [] },
    };
    const unresolved = [...this.unresolved.values()].map(reference => ({ ...this.eventView(run, reference.event), status: "unknown", no_replay: true,
      historical: true, current_authority: false, original_scope: reference.original_scope,
      containment: reference.containment ? this.eventView(run, reference.containment) : null }));
    const historicalNotes = [...this.historicalNotes.values()].filter(note =>
      Object.entries(note.original_scope).some(([key, value]) => value !== run[key as keyof HistoricalScope]));
    if (this.omittedUnknown) omissions.push({ kind: "unresolved", reference: `${this.omittedUnknown} older unknown operations`, reason: "reference_count_budget_not_resolution_no_replay" });
    for (const reference of this.noteOmissions) omissions.push({ kind: "authored_state", reference, reason: "bounded_note_fields_or_bytes_not_full_state" });
    for (const note of historicalNotes) if (note.value_omitted)
      omissions.push({ kind: "historical_authored_state", reference: note.field, reason: "bounded_note_fields_or_bytes_not_full_state" });
    const latestProgram = latest && latest.session_id === run.session_id && latest.life_id === run.life_id && latest.world_id === run.world_id &&
      latest.native_boot_id === run.native_boot_id && latest.space_epoch === run.space_epoch
      ? candidates.find(program => program.skill_id === latest.skill_id && program.version === latest.version) : null;
    const purpose = latestProgram?.card.purpose;
    const value = { budget_bytes: INPUT_BYTES, contracts, requested_help: [] as HelpSection[], objective: run.task,
      current_subgoal: this.authoredState.current_subgoal !== undefined ? this.authoredState.current_subgoal
        : purpose && purpose !== "Unspecified by author" ? purpose.slice(0, 400) : null,
      authored_state: { ...this.authoredState },
      historical_authored_state: { author: "model", gameplay_success_proof: false, current_authority: false, notes: historicalNotes },
      latest_failure: this.failure ? this.eventView(run, this.failure) : null, unresolved,
      programs: [] as { name: string; version: number; hash: string; source?: string; source_omission?: string;
        last_execution?: NonNullable<ReturnType<StrategicContext["programExecution"]>> }[],
      omissions, omitted_records: 0, omitted_unknown_operations: this.omittedUnknown };
    // Bound notices before allocation, not after they have displaced useful
    // references. Notices that cannot be retained still contribute to the count.
    while (omissions.length > 16) { omissions.shift(); value.omitted_records++; }
    const omit = (entry: Omission) => {
      if (omissions.length === 16) { omissions.shift(); value.omitted_records++; }
      omissions.push(entry);
    };
    const encoded = () => JSON.stringify({ strategic_context: value });
    // First allocate against the safety fences, not optional old receipt bodies.
    // Keep operation dispositions (including confirmed GUI prefixes), original
    // scope and containment identity even when none of the prose/evidence fits.
    const receiptDetails: { record: Record<string, unknown>; detail: Record<string, unknown>;
      originalEvidenceOmitted: unknown }[] = [];
    for (const reference of unresolved) {
      for (const record of [object(reference), object(reference.containment)]) {
        if (!record) continue;
        const detail: Record<string, unknown> = {};
        for (const key of ["summary", "result_summary", "recorded_native_ns", "evidence"]) {
          if (key in record) { detail[key] = record[key]; delete record[key]; }
        }
        if (!Object.keys(detail).length) continue;
        const originalEvidenceOmitted = record.evidence_omitted;
        record.detail_omitted = true;
        if ("evidence" in detail) record.evidence_omitted = true;
        receiptDetails.push({ record, detail, originalEvidenceOmitted });
        value.omitted_records++;
      }
    }
    let used = 0;
    for (const program of candidates) {
      const metadata = this.programExecution(run, program, workspace);
      const entry = { name: program.name, version: program.version, hash: program.hash, source: program.source,
        ...(metadata ? { last_execution: metadata } : {}) };
      const size = bytes(entry);
      if (used + size <= SOURCE_BYTES && Buffer.byteLength(encoded()) + size + 512 <= INPUT_BYTES) {
        value.programs.push(entry); used += size;
      } else {
        const reference = { name: program.name, version: program.version, hash: program.hash,
          source_omission: "Use program_inspect view source for this exact version", ...(metadata ? { last_execution: metadata } : {}) };
        if (metadata && (used + bytes(reference) > SOURCE_BYTES || Buffer.byteLength(encoded()) + bytes(reference) + 512 > INPUT_BYTES)) {
          delete reference.last_execution;
          omit({ kind: "program_execution", reference: `${program.name}@${program.version}`,
            reason: "reuse_metadata_byte_budget_use_program_inspect" });
        }
        value.programs.push(reference); used += bytes(reference);
        omit({ kind: "source", reference: `${program.name}@${program.version}`, reason: "whole_source_byte_budget", original_bytes: size });
      }
    }
    for (const section of this.help) {
      if (Buffer.byteLength(encoded()) + bytes(section) + 512 <= INPUT_BYTES) value.requested_help.push(section);
      else omit({ kind: "help", reference: `${section.topic}.${section.section}`, reason: "request_byte_budget", original_bytes: bytes(section) });
    }
    // The only potentially adapter-sized mandatory field is the binding list.
    if (Buffer.byteLength(encoded()) > INPUT_BYTES) {
      contracts.game.adapter_bindings = [];
      omit({ kind: "bindings", reference: "game", reason: "request_byte_budget_use_help_game" });
    }
    // Metadata itself is bounded; never let many omission notices defeat the
    // input cap. Count what no longer fits rather than implying full recall.
    while (Buffer.byteLength(encoded()) > INPUT_BYTES && omissions.length > 1) {
      omissions.pop(); value.omitted_records++;
    }
    while (Buffer.byteLength(encoded()) > INPUT_BYTES && value.requested_help.length) {
      value.requested_help.pop(); value.omitted_records++;
    }
    while (Buffer.byteLength(encoded()) > INPUT_BYTES && value.programs.some(program => program.source !== undefined)) {
      let index = value.programs.length - 1;
      while (value.programs[index]!.source === undefined) index--;
      const program = value.programs[index]!;
      delete program.source; program.source_omission = "request_byte_budget_use_exact_source_inspection"; value.omitted_records++;
    }
    for (const program of [...value.programs].reverse()) {
      if (Buffer.byteLength(encoded()) <= INPUT_BYTES) break;
      if (program.last_execution) { delete program.last_execution; value.omitted_records++; }
    }
    // Store normally receives the bounded operator-task schema. This also
    // bounds inspect-only historical records without truncating source code.
    if (Buffer.byteLength(encoded()) > INPUT_BYTES) {
      value.objective = run.task.slice(0, 2000); value.current_subgoal = value.current_subgoal?.slice(0, 500) ?? null;
      value.omitted_records++;
    }
    for (const key of ["latest_root_result", "latest_progress", "returned_position_notes", "recovery_reason", "resource_requirements", "worksite"] as const) {
      if (Buffer.byteLength(encoded()) <= INPUT_BYTES) break;
      if (key in value.authored_state) {
        delete value.authored_state[key]; value.omitted_records++;
      }
    }
    while (Buffer.byteLength(encoded()) > INPUT_BYTES && historicalNotes.length) {
      historicalNotes.pop(); value.omitted_records++;
    }
    while (Buffer.byteLength(encoded()) > INPUT_BYTES && unresolved.length > 1) {
      unresolved.pop(); value.omitted_records++; value.omitted_unknown_operations++;
    }
    if (Buffer.byteLength(encoded()) > INPUT_BYTES) {
      value.objective = value.objective.slice(0, 500); value.omitted_records++;
    }
    // Second pass restores only already-sanitized detail and cannot evict any
    // selected source/help. Preserve pre-existing partial-evidence semantics.
    for (const { record, detail, originalEvidenceOmitted } of receiptDetails) {
      if (!unresolved.some(reference => reference === record || reference.containment === record)) {
        value.omitted_records--;
        continue;
      }
      Object.assign(record, detail);
      delete record.detail_omitted;
      if (originalEvidenceOmitted === undefined) delete record.evidence_omitted;
      else record.evidence_omitted = originalEvidenceOmitted;
      value.omitted_records--;
      if (Buffer.byteLength(encoded()) <= INPUT_BYTES) continue;
      for (const key of Object.keys(detail)) delete record[key];
      record.detail_omitted = true;
      if ("evidence" in detail) record.evidence_omitted = true;
      value.omitted_records++;
    }
    return encoded();
  }
}
