import type { AgentTool, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod";
import type { Json, ObservationV3, RuntimeAdapter } from "../shared/contracts.ts";
import { toolCatalogAllows, type ToolModule, type ToolRole } from "../shared/tool-policy.ts";
import type { Store, StoredRun } from "./store.ts";
import type { ReactiveRuntime } from "./reactive.ts";
import type { SkillManager } from "./skills.ts";
import type { ExperienceLibrary } from "./experience.ts";
import type { SpeculativePlanning } from "./speculative-planning.ts";
import type { ImprovementLearning } from "./improvement-learning.ts";
import type { HistoryQueryClient } from "./history-protocol.ts";
import type { StageCorrection } from "../shared/planning.ts";
import { ProgramValidationError } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { ModelObservation } from "./actor-frames.ts";
import { ProgramOperations } from "./program-operations.ts";
import { programHelp } from "./program-help.ts";
import { helpSchema, memorySchema, prepareNextSchema, programInspectSchema, programReviewSchema, programRunSchema, programSubmitSchema, programWriteSchema, reflexSchema, taskFinishSchema } from "./program-interface.ts";

const faultIssuesSchema = z.array(z.object({
  code: z.string().max(80),
  message: z.string().max(1000).optional(),
  path: z.string().max(160).optional(),
  location: z.object({ line: z.number().int().positive(), column: z.number().int().positive() }).nullable().optional(),
  limit: z.object({ maximum: z.number().finite(), actual: z.number().finite() }).nullable().optional(),
  latest_parent: z.object({ name: z.string().max(80), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).nullable().optional(),
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
  constructor(private store: Store, private skills: SkillManager, private reactions: ReactiveRuntime,
    private experience: ExperienceLibrary | null, private host: RuntimeToolHost) {}

  build(generation: number): AgentTool[] {
    const run = this.host.run();
    if (this.moduleRun !== run.run_id) { this.moduleRun = run.run_id; this.modules.clear(); this.reviewDecisions.clear(); }
    const operations = new ProgramOperations(this.store, this.skills, this.reactions, this.experience, this.host, run);
    const role = (): ToolRole => run.status === "reviewing" ? "review" :
      this.host.toolRole?.() ?? (this.host.planning().projection()?.planning_active ? "speculative" : "ordinary");
    const inactiveWrite = () => role() === "authoring" || role() === "speculative";
    const writeSchema = inactiveWrite() ? programWriteSchema.omit({ reason: true }) : programWriteSchema;
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
    const tool = <T>(name: string, description: string, schema: z.ZodType<T>,
      handler: (input: T, callId: string, signal: AbortSignal | undefined, commit: () => void) => unknown | Promise<unknown>): AgentTool => {
      const registered: AgentTool = {
      name, label: name, description, intent: "omit", concurrency: "exclusive", strict: false,
      // Only schema mismatches reach the host; malformed JSON remains SDK-owned.
      lenientArgValidation: true,
      parameters: z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }),
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
          if ((admittedRole === "authoring" || admittedRole === "speculative") && name === "program_write" &&
            input !== null && typeof input === "object" && "reason" in input)
            throw new RuntimeFault("forbidden", "Pending-program authoring saves inactive source only; outcome assessments require an ordinary or review turn");
          const identity = { tool: name, input } as unknown as Json;
          const operation = input && typeof input === "object" && "operation" in input ? input.operation : null;
          const mutation = name === "task_finish" || name === "program_write" || name === "program_submit" || name === "program_review" || name === "prepare_next" ||
            name === "program_run" && operation !== "inspect" || name === "reflex" && operation !== "inspect" ||
            name === "memory" && operation !== "catalog";
          const completed = mutation ? this.store.completedToolCall(run.run_id, callId, identity) : null;
          if (completed !== null) return result(completed);
          const submitted = name === "program_submit" ? operations.submissionReceipt(callId, identity) : null;
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
          const originalScope = name === "program_submit" ? submissionScope() : null;
          const commit = () => {
            if (!replay) {
              if (this.host.run() !== run || signal?.aborted || name === "program_submit" && submissionScope() !== originalScope)
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
            name === "program_write" && input !== null && typeof input === "object" && "reason" in input);
          if (assessment && this.reviewDecisions.size >= 4)
            throw new RuntimeFault("deadline_exceeded", "The bounded post-goal review decision allowance is exhausted");
          const handled = await handler(input, callId, signal, commit);
          const typed = name === "observe" && handled && typeof handled === "object" && "images" in handled
            ? handled as { value: unknown; images: ModelObservation["images"] } : null;
          const value = typed ? typed.value : handled;
          // Finish consumes authority; submit also reports persisted source
          // when authority was revoked between persistence and admission.
          // Authoring starts at the next SDK request, after these results.
          if (name !== "task_finish" && name !== "program_submit") {
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
            ? { code: "invalid_program", message: name === "prepare_next" ? "Guard must be an async BODY using only observation,args bindings and returning a strict boolean; no wrapper/import/export." : "Program failed selected-entry validation. run uses async BODY(game,args); step/analyze uses one synchronous named module export with the advertised parameters. No imports/packages/ambient host APIs. Original and canonical source <=16 KiB. See help programs.", retryable: false, issues: JSON.parse(JSON.stringify(error.issues)) as Json }
            : error instanceof RuntimeFault
              ? { code: error.code, message: error.message, retryable: false }
              : { code: invalidArguments ? "invalid_request" : "backend_unavailable", message: invalidArguments ? "Tool arguments do not match the advertised schema; no operation was admitted" : "The requested operation could not complete safely", retryable: false };
          if (argumentError && invalidArguments)
            failure.issues = argumentError.issues.slice(0, 16).map(issue => ({
              code: issue.code, path: issue.path.map(String).join(".").slice(0, 160),
              message: issue.code === "unrecognized_keys" ? "Unknown fields are not accepted" : issue.message.slice(0, 300),
            }));
          if (error instanceof RuntimeFault && "issues" in error && Array.isArray(error.issues)) {
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
    return [
      tool("observe", "Obtain a fresh authorized player observation and current typed actor image when enabled; no authority identities are caller supplied.", z.object({}).strict(), async () => {
        const selected = this.host.modelObservation ? await this.host.modelObservation() :
          { observation: await this.host.observe(), images: [], image_metadata: { mode: "disabled" } };
        const projection = this.host.adapter().projectObservation(selected.observation);
        return { value: { ...operations.workspace.observationView(selected.observation, projection), image_metadata: selected.image_metadata }, images: selected.images };
      }),
      tool("program_write", inactiveWrite()
        ? "Validate and save an immutable inactive named JavaScript taskflow without starting or replacing foreground work. Existing names require based_on. card.reason is inert descriptive metadata."
        : "Create or revise a compact named JavaScript taskflow. Existing names require based_on. Optional reason links the actual revision to matching feedback, not proven efficacy.",
        writeSchema, (input, callId, signal, commit) => operations.write(input, callId, commit, signal)),
      tool("program_submit", "Explicitly write one immutable program and start that exact version through ordinary admission. Returns persisted source separately from started/refused/unknown execution; never automatically retry an unknown start. Existing names require based_on.", programSubmitSchema, (input, callId, signal, commit) => operations.submit(input, callId, commit, signal)),
      tool("program_run", "Start a matching named run/step entry once; inspect/stop current work, explicitly version-update resident intent, run a separately bounded pure analyze job, activate prepared run work, or select one finite attention wake. No automatic source replacement or analysis-to-control injection. Host owns retry identity and authority.", programRunSchema, (input, callId, _signal, commit) => operations.runProgram(input, callId, commit)),
      tool("program_inspect", "Read named catalog/source/execution/trace/feedback/comparison/planning views without effects. Preserve page cursors and explicit omissions.", programInspectSchema, (input, _callId, signal, commit) => operations.inspect(input, signal, commit)),
      tool("program_review", "Record keep or insufficient_evidence for the latest matching outcome of a named version. A performed code experiment is linked directly through program_write.reason.", programReviewSchema, (input, callId, signal, commit) => operations.review(input, callId, commit, signal)),
      tool("help", "Load generated game/program/planning reference, or disclose optional reflex/memory modules on demand.", helpSchema, (input) => {
        if ((input.topic === "reflex" || input.topic === "memory") && role() === "authoring")
          throw new RuntimeFault("forbidden", "Optional playing modules are unavailable during pending-program authoring");
        if ((input.topic === "reflex" || input.topic === "memory") && role() === "ordinary") this.modules.add(input.topic);
        return programHelp(input.topic, this.host.adapter());
      }),
      tool("task_finish", "Report the whole custom task complete from actual authorized evidence and stop the run immediately. This is unverified model reporting, not built-in goal verification.", taskFinishSchema, (input, callId) => {
        if (typeof run.goal === "string" || run.goal.goal_id !== "custom" || run.goal.verifier !== null) throw new RuntimeFault("forbidden", "Only custom tasks permit model-reported completion; built-in goals require trusted verification");
        this.host.finishTask(input.summary, callId);
        return { status: "stopping", verification: "unverified" };
      }),
      tool("prepare_next", "Stage one existing named program for the current restricted planning flight. Optional guard_source binds only observation,args; omission adds no gameplay condition or effect authority.", prepareNextSchema, (input, callId) => operations.prepare(input, callId)),
      tool("reflex", "Manage optional named JavaScript/Jev reactions: write, inspect, effect-free validate, bounded activate, retire.", reflexSchema, (input, callId, signal) => operations.reflex(input, callId, generation, signal)),
      tool("memory", "Inspect, freshly load, or explicitly qualify compatible named exact experience snapshots using real bounded evidence.", memorySchema, (input, callId, _signal, commit) => operations.memory(input, callId, commit)),
    ].filter((entry) => toolCatalogAllows(role(), entry.name, this.modules));
  }
}
