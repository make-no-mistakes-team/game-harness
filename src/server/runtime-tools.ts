import type { AgentTool, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod";
import type { Json, ObservationV3, RuntimeAdapter } from "../shared/contracts.ts";
import { toolCatalogAllows, type ToolModule, type ToolRole } from "../shared/tool-policy.ts";
import type { Store, StoredRun } from "./store.ts";
import type { ReactiveRuntime } from "./reactive.ts";
import type { SkillManager } from "./skills.ts";
import type { SourcePrograms } from "./source-programs.ts";
import type { ExperienceLibrary } from "./experience.ts";
import type { SpeculativePlanning } from "./speculative-planning.ts";
import type { ImprovementLearning } from "./improvement-learning.ts";
import type { HistoryQueryClient } from "./history-protocol.ts";
import type { StageCorrection } from "../shared/planning.ts";
import { ProgramValidationError, programEntryContractSchema } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { ModelObservation } from "./actor-frames.ts";
import { ProgramOperations } from "./program-operations.ts";
import { programHelp } from "./program-help.ts";
import { runtimeToolCatalogue, runtimeToolDescriptor, type RuntimeToolCatalogueEntry, type RuntimeToolInputs, type RuntimeToolName } from "./runtime-tool-catalog.ts";
import { residentJsonConstraint } from "../shared/resident.ts";
import type { SkillStartRequest } from "../shared/programs.ts";

type RuntimeToolHandler<Name extends RuntimeToolName> = (
  input: RuntimeToolInputs[Name], callId: string, signal: AbortSignal | undefined, commit: () => void,
) => unknown | Promise<unknown>;
type RuntimeToolHandlers = { [Name in RuntimeToolName]: RuntimeToolHandler<Name> };

const faultIssuesSchema = z.array(z.object({
  code: z.string().max(80),
  message: z.string().max(1000).optional(),
  path: z.string().max(160).optional(),
  location: z.object({ line: z.number().int().positive(), column: z.number().int().positive() }).nullable().optional(),
  limit: z.object({ maximum: z.number().finite(), actual: z.number().finite() }).nullable().optional(),
  latest_parent: z.object({ name: z.string().max(80), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).nullable().optional(),
  entry_contract: programEntryContractSchema.optional(),
})).max(32);

const runtimeTools = new WeakSet<AgentTool>();
/** The SDK may heal types/nulls before this supported hook. Preserve the actor's
 * original input for our own strict validation, before identity or persistence. */
export function preserveRuntimeToolArguments(context: BeforeToolCallContext): void {
  if (!runtimeTools.has(context.tool) || context.args === context.toolCall.arguments) return;
  const original = context.toolCall.arguments;
  if (context.args === null || typeof context.args !== "object") return;
  for (const key of Object.keys(context.args)) delete context.args[key];
  if (original !== null && typeof original === "object" && !Array.isArray(original)) {
    // Unknown JSON keys must remain own data properties for strict validation;
    // Object.assign would invoke the legacy __proto__ setter instead.
    for (const key of Object.keys(original))
      Object.defineProperty(context.args, key, { value: original[key], enumerable: true, configurable: true, writable: true });
  }
  else context.args.__invalid_runtime_arguments = true;
}

export interface RuntimeToolHost {
  run(): StoredRun;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  observe(): Promise<ObservationV3>;
  modelObservation?(): Promise<ModelObservation>;
  adapter(): RuntimeAdapter;
  generation(): number;
  attentionAfter(ms: number, reason: string): void;
  admitted(): void;
  /** Optional host-owned ceiling check on normalized requests. Throw to refuse;
   * never mutate, clamp or grant authority. Existing execution receipts bypass it.
   * Planning hosts must also check before preparation and final admission. */
  assertProgramStart?(request: SkillStartRequest): void;
  history(): HistoryQueryClient;
  planning(): SpeculativePlanning;
  learning(): ImprovementLearning;
  toolRole?(): ToolRole;
  toolAuthority(): () => void;
  finishTask(summary: string, callId: string): void;
}

export class RuntimeTools {
  private modules = new Set<ToolModule>();
  private reviewDecisions = new Set<string>();
  private moduleRun: string | null = null;
  constructor(private store: Store, private skills: SkillManager, private sources: SourcePrograms, private reactions: ReactiveRuntime,
    private experience: ExperienceLibrary | null, private host: RuntimeToolHost) {}

  private synchronizeModules(runId: string): void {
    if (this.moduleRun !== runId) {
      this.moduleRun = runId; this.modules.clear(); this.modules.add("reflex"); this.reviewDecisions.clear();
    }
  }

  disclosedModules(): ToolModule[] {
    this.synchronizeModules(this.host.run().run_id);
    return [...this.modules];
  }

  build(generation: number): AgentTool[] {
    const run = this.host.run();
    this.synchronizeModules(run.run_id);
    const operations = new ProgramOperations(this.store, this.skills, this.sources, this.reactions, this.experience, this.host, run);
    const role = (): ToolRole => run.status === "reviewing" ? "review" :
      this.host.toolRole?.() ?? (this.host.planning().projection()?.planning_active ? "speculative" : "ordinary");
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
    const tool = <Name extends RuntimeToolName>(entry: RuntimeToolCatalogueEntry<Name>): AgentTool => {
      const { name, schema } = entry;
      const handler: RuntimeToolHandler<Name> = handlers[name];
      const descriptor = runtimeToolDescriptor(entry);
      const registered: AgentTool = {
      name: descriptor.name, label: descriptor.label, description: descriptor.description,
      intent: descriptor.intent, concurrency: descriptor.concurrency, strict: descriptor.strict,
      lenientArgValidation: descriptor.lenientArgValidation,
      get parameters() { return descriptor.parameters; },
      // Only schema mismatches reach the host; malformed JSON remains SDK-owned.
      execute: async (callId, raw, signal) => {
        let argumentError: z.ZodError | null = null;
        try {
          if (this.host.run() !== run)
            throw new RuntimeFault("stale_context", "This tool call belongs to a different run");
          const admittedRole = role();
          if (!toolCatalogAllows(admittedRole, name, this.modules))
            throw new RuntimeFault("forbidden", "This tool is not authorized for the current role and disclosed modules");
          const parsed = schema.safeParse(raw);
          if (!parsed.success) { argumentError = parsed.error; throw argumentError; }
          const input = parsed.data;
          if ((admittedRole === "authoring" || admittedRole === "speculative") && (name === "program_write" || name === "program_edit") &&
            input !== null && typeof input === "object" && "reason" in input)
            throw new RuntimeFault("forbidden", "Pending-program authoring saves inactive source only; outcome assessments require an ordinary or review turn");
          const identity = { tool: name, input } as unknown as Json;
          const operation = input && typeof input === "object" && "operation" in input ? input.operation : null;
          const mutation = name === "task_finish" || name === "program_write" || name === "program_edit" || name === "program_submit" || name === "program_review" || name === "prepare_next" ||
            name === "program_run" && operation !== "inspect" || name === "reflex" && operation !== "inspect" ||
            name === "memory" && operation !== "catalog";
          const completed = mutation ? this.store.completedToolCall(run.run_id, callId, identity) : null;
          if (completed !== null) return result(completed);
          const submission = name === "program_submit" || name === "reflex" && operation === "submit";
          const submitted = name === "program_submit" ? operations.submissionReceipt(callId, identity)
            : name === "reflex" && operation === "submit" ? operations.reflexSubmissionReceipt(callId, identity) : null;
          if (submitted !== null) {
            // Recover the already immutable two-phase result, not execution
            // authority. A cancelled/stale request cannot perform new work.
            this.store.completeToolCall(run.run_id, callId, identity, submitted);
            return result(submitted);
          }
          const replay = name === "program_run" && operation === "start" &&
            this.skills.get(run.run_id, { start_key: operations.startKey(callId) }) !== null;
          if (signal?.aborted && !replay) throw new RuntimeFault("stale_context", "The strategic request was cancelled");
          if (!replay) this.host.assertCurrent(generation);
          const authority = replay ? () => {} : this.host.toolAuthority();
          const submissionScope = () => JSON.stringify([run.task, run.goal, run.world_id, run.epoch, run.session_id, run.life_id,
            run.native_boot_id, run.space_epoch, run.compatibility_hash]);
          const originalScope = submission ? submissionScope() : null;
          const commit = () => {
            if (!replay) {
              if (this.host.run() !== run || signal?.aborted || submission && submissionScope() !== originalScope)
                throw new RuntimeFault("stale_context", "Tool authority changed before admission");
              this.host.assertCurrent(generation);
              if (mutation && role() !== admittedRole)
                throw new RuntimeFault("stale_context", "Tool role changed before admission");
              if (!toolCatalogAllows(role(), name, this.modules))
                throw new RuntimeFault("forbidden", "Tool is not authorized for the current role");
            }
            authority();
          };
          commit();
          const assessment = role() === "review" && (name === "program_review" ||
            (name === "program_write" || name === "program_edit") && input !== null && typeof input === "object" && "reason" in input);
          if (assessment && this.reviewDecisions.size >= 4)
            throw new RuntimeFault("deadline_exceeded", "The bounded post-goal review decision allowance is exhausted");
          const handled = await handler(input, callId, signal, commit);
          const typed = name === "observe" && handled && typeof handled === "object" && "images" in handled
            ? handled as { value: unknown; images: ModelObservation["images"] } : null;
          const value = typed ? typed.value : handled;
          // Finish consumes authority; submit also reports persisted source
          // when authority was revoked between persistence and admission.
          // Authoring starts at the next SDK request, after these results.
          if (name !== "task_finish" && !submission) {
            commit();
            if (!replay) this.host.assertCurrent(generation);
          }
          if (mutation) this.store.completeToolCall(run.run_id, callId, identity, JSON.parse(JSON.stringify(value)) as Json);
          if (assessment) this.reviewDecisions.add(callId);
          this.store.event(run.run_id, "model.tool_result", `Strategic tool ${name} returned service evidence`, {
            tool_call_id: callId, tool: name, result: JSON.parse(JSON.stringify(value)) as Json,
          });
          const response = result(value);
          return typed ? { ...response, content: [...response.content, ...typed.images] } : response;
        } catch (error) {
          const invalidArguments = argumentError !== null && error === argumentError;
          const failure: Record<string, Json> = error instanceof ProgramValidationError
            ? { code: "invalid_program", message: name === "prepare_next" ? "Guard must be an async BODY using only observation,args bindings and returning a strict boolean; no wrapper/import/export." : "Program failed selected-entry validation. run uses async BODY(game,args); step/analyze uses one synchronous named module export with the advertised parameters. No imports/packages/ambient host APIs. Original and canonical source <=16 KiB. See help programs.", retryable: false }
            : error instanceof RuntimeFault
              ? { code: error.code, message: error.message, retryable: false }
              : { code: invalidArguments ? "invalid_request" : "backend_unavailable", message: invalidArguments ? "Tool arguments do not match the advertised schema; no operation was admitted" : "The requested operation could not complete safely", retryable: false };
          if (argumentError && invalidArguments)
            failure.issues = argumentError.issues.slice(0, 16).map(issue => {
              const keys = issue.code === "unrecognized_keys" ? issue.keys.slice(0, 8) : null;
              return {
                code: issue.code, path: issue.path.map(String).join(".").slice(0, 160),
                ...residentJsonConstraint(issue),
                message: issue.code === "unrecognized_keys" ? "Unknown fields are not accepted" : issue.message.slice(0, 300),
                ...(keys ? {
                  keys: keys.map(key => key.slice(0, 80)),
                  ...(issue.code === "unrecognized_keys" && issue.keys.length > keys.length ? { omitted_keys: issue.keys.length - keys.length } : {}),
                  ...(keys.some(key => key.length > 80) ? { key_names_truncated: true } : {}),
                } : {}),
              };
            });
          if ((error instanceof RuntimeFault || error instanceof ProgramValidationError) && "issues" in error && Array.isArray(error.issues)) {
            const issues = faultIssuesSchema.safeParse(error.issues.slice(0, 32));
            if (issues.success) failure.issues = JSON.parse(JSON.stringify(issues.data)) as Json;
          }
          if ((error instanceof RuntimeFault || error instanceof ProgramValidationError) && "stage_correction" in error) {
            const correction = error.stage_correction as StageCorrection;
            const { plan_id: _plan, ...publicCorrection } = correction;
            failure.stage_correction = JSON.parse(JSON.stringify(publicCorrection)) as Json;
          }
          this.store.event(run.run_id, "model.tool_rejected", "Strategic tool returned a fixed safe rejection", { tool_call_id: callId, tool: name, error: failure });
          return { ...result({ error: failure }), isError: true };
        }
      },
      };
      runtimeTools.add(registered);
      return registered;
    };
    const handlers: RuntimeToolHandlers = {
      observe: async () => {
        const selected = this.host.modelObservation ? await this.host.modelObservation() :
          { observation: await this.host.observe(), images: [], image_metadata: { mode: "disabled" } };
        const projection = this.host.adapter().projectObservation(selected.observation);
        return { value: { ...operations.workspace.observationView(selected.observation, projection), image_metadata: selected.image_metadata }, images: selected.images };
      },
      program_write: (input, callId, signal, commit) => operations.write(input, callId, commit, signal),
      program_edit: (input, callId, signal, commit) => operations.edit(input, callId, commit, signal),
      program_submit: (input, callId, signal, commit) => operations.submit(input, callId, commit, signal),
      program_run: (input, callId, signal, commit) => operations.runProgram(input, callId, commit, signal),
      program_inspect: (input, _callId, signal, commit) => operations.inspect(input, signal, commit),
      program_review: (input, callId, signal, commit) => operations.review(input, callId, commit, signal),
      help: (input) => {
        if (input.topic === "memory" && role() === "authoring")
          throw new RuntimeFault("forbidden", "Optional playing modules are unavailable during pending-program authoring");
        if (input.topic === "memory" && role() === "ordinary") this.modules.add(input.topic);
        return programHelp(input.topic, this.host.adapter(), input.kind);
      },
      task_finish: (input, callId) => {
        if (typeof run.goal === "string" || run.goal.goal_id !== "custom" || run.goal.verifier !== null) throw new RuntimeFault("forbidden", "Only custom tasks permit model-reported completion; built-in goals require trusted verification");
        if (!input.all_requested_work_complete) {
          this.store.event(run.run_id, "task.progress_reported", "Model reported unfinished custom-task work; control continues", {
            source: "model", reported_outcome: "incomplete", summary: input.summary, tool_call_id: callId,
          });
          return { status: "continuing", all_requested_work_complete: false };
        }
        this.host.finishTask(input.summary, callId);
        return { status: "stopping", verification: "unverified" };
      },
      prepare_next: (input, callId) => operations.prepare(input, callId),
      reflex: (input, callId, signal, commit) => operations.reflex(input, callId, generation, commit, signal),
      memory: (input, callId, _signal, commit) => operations.memory(input, callId, commit),
    };
    return runtimeToolCatalogue(role(), this.modules).map(tool);
  }
}
