import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod";
import type { Json, Observation, ProgramEvidenceView } from "../shared/contracts.ts";
import { toolCatalogAllows, type ToolModule, type ToolRole } from "../shared/tool-policy.ts";
import type { Store, StoredRun } from "./store.ts";
import type { ReactiveRuntime } from "./reactive.ts";
import type { SkillManager } from "./skills.ts";
import type { ExperienceLibrary } from "./experience.ts";
import type { SpeculativePlanning } from "./speculative-planning.ts";
import type { ImprovementLearning } from "./improvement-learning.ts";
import type { StageCorrection } from "../shared/planning.ts";
import { ProgramValidationError } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { ProgramOperations } from "./program-operations.ts";
import { programHelp } from "./program-help.ts";
import { helpSchema, memorySchema, prepareNextSchema, programInspectSchema, programReviewSchema, programRunSchema, programWriteSchema, reflexSchema, taskFinishSchema } from "./program-interface.ts";

export interface RuntimeToolHost {
  run(): StoredRun;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  observe(): Promise<Observation>;
  recipes(item: string): Promise<Json>;
  attentionAfter(ms: number, reason: string): void;
  admitted(): void;
  evidence(): ProgramEvidenceView[];
  planning(): SpeculativePlanning;
  learning(): ImprovementLearning;
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
    const role = (): ToolRole => run.status === "reviewing" ? "review" : this.host.planning().projection()?.planning_active ? "speculative" : "ordinary";
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
    const tool = <T>(name: string, description: string, schema: z.ZodType<T>,
      handler: (input: T, callId: string, signal: AbortSignal | undefined, commit: () => void) => unknown | Promise<unknown>): AgentTool => ({
      name, label: name, description, intent: "omit", concurrency: "exclusive", strict: false,
      parameters: z.toJSONSchema(schema, { unrepresentable: "any" }),
      execute: async (callId, raw, signal) => {
        try {
          if (this.host.run() !== run)
            throw new RuntimeFault("stale_context", "This tool call belongs to a different run");
          if (!toolCatalogAllows(role(), name, this.modules))
            throw new RuntimeFault("forbidden", "This tool is not authorized for the current role and disclosed modules");
          const input = schema.parse(raw);
          const identity = { tool: name, input } as unknown as Json;
          const operation = input && typeof input === "object" && "operation" in input ? input.operation : null;
          const mutation = name === "task_finish" || name === "program_write" || name === "program_review" || name === "prepare_next" ||
            name === "program_run" && operation !== "inspect" || name === "reflex" && operation !== "inspect" ||
            name === "memory" && operation !== "catalog";
          const completed = mutation ? this.store.completedToolCall(run.run_id, callId, identity) : null;
          if (completed !== null) return result(completed);
          const replay = name === "program_run" && operation === "start" &&
            this.skills.get(run.run_id, { start_key: operations.startKey(callId) }) !== null;
          if (signal?.aborted && !replay) throw new RuntimeFault("stale_context", "The strategic request was cancelled");
          if (!replay) this.host.assertCurrent(generation);
          const commit = replay ? () => {} : this.host.toolAuthority();
          commit();
          const assessment = role() === "review" && (name === "program_review" ||
            name === "program_write" && input !== null && typeof input === "object" && "reason" in input);
          if (assessment && this.reviewDecisions.size >= 4)
            throw new RuntimeFault("deadline_exceeded", "The bounded post-goal review decision allowance is exhausted");
          const value = await handler(input, callId, signal, commit);
          if (mutation) this.store.completeToolCall(run.run_id, callId, identity, JSON.parse(JSON.stringify(value)) as Json);
          if (assessment) this.reviewDecisions.add(callId);
          // A successful finish deliberately consumes its own run authority.
          if (name !== "task_finish") {
            commit();
            if (!replay) this.host.assertCurrent(generation);
          }
          this.store.event(run.run_id, "model.tool_result", `Strategic tool ${name} returned service evidence`, {
            tool_call_id: callId, tool: name, result: JSON.parse(JSON.stringify(value)) as Json,
          });
          return result(value);
        } catch (error) {
          const failure: Record<string, Json> = error instanceof ProgramValidationError
            ? { code: "invalid_program", message: name === "prepare_next" ? "Guard must be a compact async BODY using only observation,args bindings and returning a strict boolean; no wrapper/import/export/comments." : "Program failed compact executable validation; supply an async BODY with game,args and no wrapper/import/export/comments.", retryable: false, issues: JSON.parse(JSON.stringify(error.issues)) as Json }
            : error instanceof RuntimeFault
              ? { code: error.code, message: error.message, retryable: false }
              : { code: error instanceof z.ZodError ? "invalid_request" : "backend_unavailable", message: error instanceof z.ZodError ? "Tool arguments do not match the advertised schema" : "The requested operation could not complete safely", retryable: false };
          if (error && typeof error === "object" && "issues" in error && !(error instanceof ProgramValidationError))
            failure.issues = JSON.parse(JSON.stringify(error.issues)) as Json;
          if (error && typeof error === "object" && "stage_correction" in error) {
            const correction = error.stage_correction as StageCorrection;
            const { plan_id: _plan, ...publicCorrection } = correction;
            failure.stage_correction = JSON.parse(JSON.stringify(publicCorrection)) as Json;
          }
          this.store.event(run.run_id, "model.tool_rejected", "Strategic tool returned a fixed safe rejection", { tool_call_id: callId, tool: name, error: failure });
          return { ...result({ error: failure }), isError: true };
        }
      },
    });
    return [
      tool("observe", "Obtain a fresh authorized player observation; no authority identities are caller supplied.", z.object({}).strict(), async () => operations.workspace.observationView(await this.host.observe())),
      tool("program_write", "Create or revise a compact named JavaScript taskflow. Existing names require based_on. Optional reason links the actual revision to matching feedback, not proven efficacy.", programWriteSchema, (input, callId, _signal, commit) => operations.write(input, callId, commit)),
      tool("program_run", "Start a named exact or latest validated program once; inspect/stop current work, activate prepared next work, or select one finite attention wake. The host owns retry identity and authority.", programRunSchema, (input, callId, _signal, commit) => operations.runProgram(input, callId, commit)),
      tool("program_inspect", "Read named catalog/source/execution/trace/feedback/comparison/planning views without effects. Preserve page cursors and explicit omissions.", programInspectSchema, (input) => operations.inspect(input)),
      tool("program_review", "Record keep or insufficient_evidence for the latest matching outcome of a named version. A performed code experiment is linked directly through program_write.reason.", programReviewSchema, (input, callId) => operations.review(input, callId)),
      tool("help", "Load generated game/program/planning reference, or disclose optional reflex/memory modules on demand.", helpSchema, (input) => {
        if ((input.topic === "reflex" || input.topic === "memory") && role() === "ordinary") this.modules.add(input.topic);
        return programHelp(input.topic);
      }),
      tool("task_finish", "Report the whole custom task complete from actual authorized evidence and stop the run immediately. This is unverified model reporting, not built-in goal verification.", taskFinishSchema, (input, callId) => {
        if (run.goal !== "custom") throw new RuntimeFault("forbidden", "Only custom tasks permit model-reported completion; built-in goals require trusted verification");
        this.host.finishTask(input.summary, callId);
        return { status: "stopping", verification: "unverified" };
      }),
      tool("prepare_next", "Stage one existing named program for the current restricted planning flight. Optional guard_source binds only observation,args; omission adds no gameplay condition or effect authority.", prepareNextSchema, (input, callId) => operations.prepare(input, callId)),
      tool("reflex", "Manage optional named JavaScript/Jev reactions: write, inspect, effect-free validate, bounded activate, retire.", reflexSchema, (input, callId, signal) => operations.reflex(input, callId, generation, signal)),
      tool("memory", "Inspect, freshly load, or explicitly qualify compatible named exact experience snapshots using real bounded evidence.", memorySchema, (input, callId, _signal, commit) => operations.memory(input, callId, commit)),
    ].filter((entry) => toolCatalogAllows(role(), entry.name, this.modules));
  }
}
