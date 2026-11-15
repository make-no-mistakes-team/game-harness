import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod";
import { toolCatalogAllows, type ToolModule, type ToolRole } from "../shared/tool-policy.ts";
import { helpSchema, memorySchema, prepareNextSchema, programEditSchema, programInspectSchema, programReviewSchema, programRunSchema, programSubmitSchema, programWriteSchema, reflexSchema, taskFinishSchema } from "./program-interface.ts";

const schemas = {
  observe: z.object({}).strict(),
  program_write: programWriteSchema,
  program_edit: programEditSchema,
  program_submit: programSubmitSchema,
  program_run: programRunSchema,
  program_inspect: programInspectSchema,
  program_review: programReviewSchema,
  help: helpSchema,
  task_finish: taskFinishSchema,
  prepare_next: prepareNextSchema,
  reflex: reflexSchema,
  memory: memorySchema,
};
const inactiveWriteSchema = programWriteSchema.omit({ reason: true });
const inactiveEditSchema = programEditSchema.omit({ reason: true });

export type RuntimeToolName = keyof typeof schemas;
export type RuntimeToolInputs = { [Name in RuntimeToolName]: z.output<(typeof schemas)[Name]> };
export interface RuntimeToolCatalogueEntry<Name extends RuntimeToolName = RuntimeToolName> {
  name: Name;
  description: string;
  schema: z.ZodType<RuntimeToolInputs[Name]>;
}
export type RuntimeToolDescriptor = Pick<AgentTool,
  "name" | "label" | "description" | "parameters" | "intent" | "concurrency" | "strict" | "lenientArgValidation">;

/** Pure role/module selection, shared by the physical host and cognition process. */
export function runtimeToolCatalogue(role: ToolRole, modules: ReadonlySet<ToolModule>): RuntimeToolCatalogueEntry[] {
  const inactiveWrite = role === "authoring" || role === "speculative";
  const catalogue: RuntimeToolCatalogueEntry[] = [
    {
      name: "observe",
      description: "Obtain a fresh authorized player observation and current typed actor image when enabled; no authority identities are caller supplied.",
      schema: schemas.observe,
    },
    {
      name: "program_write",
      description: inactiveWrite
        ? "Validate and save inactive source without starting or replacing foreground work. Explicit entry is required, including revisions: run BODY or step/analyze/library module. Existing names require based_on. card.reason is inert descriptive metadata."
        : "Create or revise named JavaScript source. Explicit entry is required, including revisions: run BODY or step/analyze/library module. Existing names require based_on. Optional reason links actual revision feedback, not proven efficacy.",
      schema: inactiveWrite ? inactiveWriteSchema : schemas.program_write,
    },
    {
      name: "program_edit",
      description: "Apply only your sequential exact unique-match replacements to the latest existing based_on source. Retains entry/card and exact dependency pins when dependencies is omitted. Supply a complete dependencies list to explicitly replace pins using already authored versions. Validates source and graph atomically, saves without execution or controller replacement. Optional reason links the exact parent's actual outcome feedback.",
      schema: inactiveWrite ? inactiveEditSchema : schemas.program_edit,
    },
    {
      name: "program_submit",
      description: "Write and start exact model-authored JavaScript. step is ongoing raw frame/input control; run can be a finite procedure OR an ongoing semantic feedback loop within declared finite root limits. Both can remain useful while cognition runs. Required args is JSON (null if unused); card optional; revisions need based_on latest stored. Optional exact-predecessor handoff fences future capabilities after validation, lets only the current admitted bounded semantic capability settle, then retires before replacement; residents retire immediately. Stop/tool abort revoke immediately. Returns source separately from started/refused/unknown; never retry unknown.",
      schema: schemas.program_submit,
    },
    {
      name: "program_run",
      description: "Start exact named run/step; optional handoff:{name,version,execution_ordinal} replaces only after confirmed retirement. After validation, future predecessor capabilities are fenced immediately; only its current admitted bounded semantic capability may settle. Residents retire immediately; Stop/tool abort revoke immediately. Inspect/stop, update resident intent, run pure analyze, activate a prepared successor, or select finite attention. No automatic replacement or analysis-to-control injection. Host owns retry identity and authority.",
      schema: schemas.program_run,
    },
    {
      name: "program_inspect",
      description: "Read named catalog/source/execution/trace/feedback/comparison/planning views without effects. Preserve page cursors and explicit omissions.",
      schema: schemas.program_inspect,
    },
    {
      name: "program_review",
      description: "Record keep or insufficient_evidence for the latest matching outcome of a named version. A performed code experiment is linked directly through program_write.reason.",
      schema: schemas.program_review,
    },
    {
      name: "help",
      description: "Load actions for compact async methods, action shapes/bounds and crafting. Add kind to topic actions for one complete exact action family. Controller covers local frame/input control; game has full registered schemas; programs covers lifecycle; planning covers prepared successors; reflex covers local reactions. Memory discloses its optional module.",
      schema: schemas.help,
    },
    {
      name: "task_finish",
      description: "Report the custom-task decision. all_requested_work_complete:false records unfinished work and preserves running control; then end this planning response normally. true is TERMINAL: explicitly affirm the WHOLE task is complete, then stop/drain the run and every controller. Unverified means model-reported, not unfinished. Never choose true for partial progress, inability to claim completion or the end of a planning turn.",
      schema: schemas.task_finish,
    },
    {
      name: "prepare_next",
      description: "Stage one existing named program for the current restricted planning flight. Optional guard_source binds only observation,args; omission adds no gameplay condition or effect authority.",
      schema: schemas.prepare_next,
    },
    {
      name: "reflex",
      description: "Submit your authored reaction in one call: operation:'submit' persists the exact source, validates in isolation and explicitly arms a finite trial/watch. Separate write/inspect/validate/activate/retire remain available; keep requires real trial evidence. No policy or response is supplied automatically. Read help reflex for context/state and budgets. Jev requires separately configured provider access.",
      schema: schemas.reflex,
    },
    {
      name: "memory",
      description: "Inspect, freshly load, or explicitly qualify compatible named exact experience snapshots using real bounded evidence.",
      schema: schemas.memory,
    },
  ];
  return catalogue.filter(entry => toolCatalogAllows(role, entry.name, modules));
}

/** Preserve the SDK's existing schema conversion and host-owned validation conventions. */
export function runtimeToolDescriptor(entry: RuntimeToolCatalogueEntry): RuntimeToolDescriptor {
  let parameters: AgentTool["parameters"] | undefined;
  return {
    name: entry.name, label: entry.name, description: entry.description,
    intent: "omit", concurrency: "exclusive", strict: false,
    lenientArgValidation: true,
    // Physical host dispatch uses execute only. Actual SDK schema/context work
    // is paid by the consumer that reads parameters (ordinary cognition).
    get parameters() {
      return parameters ??= z.toJSONSchema(entry.schema, { unrepresentable: "any", io: "input" });
    },
  };
}

export function runtimeToolDescriptors(role: ToolRole, modules: ReadonlySet<ToolModule>): RuntimeToolDescriptor[] {
  return runtimeToolCatalogue(role, modules).map(runtimeToolDescriptor);
}
