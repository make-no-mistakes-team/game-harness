import { z } from "zod";
import type { RuntimeAdapter } from "../shared/contracts.ts";
import { getGameAPIReference, policyDecisionSchema } from "../shared/validation.ts";
import { DEFAULT_SKILL_LIMITS } from "../shared/programs.ts";
import { PROGRAM_LIMITS } from "./program-validation.ts";
import { helpSchema, memorySchema, nextConfigSchema, prepareNextSchema, programInspectSchema, programReviewSchema, programRunSchema, programWriteSchema, reflexSchema, taskFinishSchema } from "./program-interface.ts";

export function programHelp(topic: z.infer<typeof helpSchema>["topic"], adapter?: RuntimeAdapter) {
  const schema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any" });
  if (topic === "game") {
    if (!adapter) throw new Error("A negotiated adapter is required for the executable game reference");
    return getGameAPIReference(adapter);
  }
  if (topic === "programs") return {
    write: schema(programWriteSchema), run: schema(programRunSchema), inspect: schema(programInspectSchema), review: schema(programReviewSchema),
    body: "Write only an async JavaScript function BODY. Supplied bindings: game,args. No wrapper/import/export or ambient host access. Comments and coherent helper functions are permitted. Both original and canonical source are capped at 16 KiB UTF-8; structural metrics are descriptive. Ordinary program_write card and dependencies may be omitted: host defaults are unspecified/untested, not invented tactics. Await one capability at a time. Every return path must return {status:'completed'|'blocked'|'failed',summary:string,result:JSON}; result:null is allowed.",
    completion: "A program's completed status is execution-only, not task success. For a custom task, call the separate ordinary-only task_finish lifecycle tool as soon as actual authorized evidence shows the whole task done; do not run another no-op/check or review loop. It stops the run with an unverified model report. Built-in goals still require independent trusted verification.",
    composition: "Declare named dependencies when writing. The host pins their exact validated versions. game.call({name,version?},args) selects only those captured dependencies, never a new latest version; version may be omitted only when the declared name is unambiguous.",
    revision: "A new name creates a family. An existing name requires based_on equal to its latest stored version; conflicts never silently rebase source. Optional reason links an actual direct-child code experiment to the latest unresolved matching outcome. A candidate is not proven improvement or promotion.",
    selection: "Start without version selects latest validated once before admission. Exact version remains exact. Transport retry identity is host-bound; repeat delivery of one tool call never starts new work. A new decision is a distinct call.",
    inspection: "Views are read-only. Follow next_after/has_more and explicit omissions. current means unfinished execution; latest includes terminal outcomes. Trace continuation cursors pin the original execution even after newer work starts. Continue comparison pages using the exact named versions returned on page one. Review without version selects the latest matching outcome in that name family; an exact version stays exact. Named selection never rewrites captured execution/dependency references. Game-specific reads use the executable adapter bindings listed by help topic game, not additional program_inspect views.",
    limits: PROGRAM_LIMITS, default_execution_limits: DEFAULT_SKILL_LIMITS,
  };
  if (topic === "planning") return {
    next: schema(nextConfigSchema), prepare_next: schema(prepareNextSchema),
    authority: "Only main root start authorizes one speculative flight and chooses manual or on_predecessor_success activation. The restricted planner can observe, inspect, help and prepare one existing named candidate, not write or run. The original finite deadline includes planning, predecessor drain, fresh observation, optional guard and durable admission; staging never extends it.",
    guard: "Optional guard_source is an async BODY with only observation,args bindings and strict boolean return. No context/state/task/source/predecessor bindings. Omission adds no model gameplay constraint; fresh observation and all host invariants remain mandatory. False/error never authorizes effects. No automatic repair or retry.",
    activation: "Stop/Pause/death/task/session/generation changes invalidate authority. Only successful exact predecessor closure/drain permits a successor. Main can deliberately activate a manually prepared candidate. No replay of uncertain effects.",
  };
  if (topic === "reflex") return {
    tool: "reflex", schema: schema(reflexSchema), decisions: schema(policyDecisionSchema),
    contract: "Optional named model-authored reactions. JavaScript uses async BODY(context,state), isolated and bounded. Jev uses real provider selection among declared choices, never a local fallback. Write, inspect, validate effect-free, then explicitly activate a bounded trial or evidence-qualified keep; retire revokes and drains effects. Source validation is not efficacy proof. Epoch and exact identities are host-owned.",
  };
  if (topic === "memory") return {
    tool: "memory", schema: schema(memorySchema),
    contract: "Catalog latest compatible snapshot per name with durable numeric revisions and paging. Load {name,version?} pins one exact snapshot, latest when omitted, then freshly validates its captured dependencies without restoring observations,args,targets or worker state. qualify requires the existing trusted bounded goal/block/inventory evidence declaration. No self-rating or automatic promotion. Older same-name revisions remain selectable explicitly.",
  };
  return {
    tools: ["observe", "program_write", "program_run", "program_inspect", "program_review", "help"],
    lifecycle: {
      task_finish: schema(taskFinishSchema),
      contract: "Separate from the six gameplay/program verbs. Ordinary role and custom tasks only. As soon as actual authorized evidence shows the whole task complete, call task_finish with a brief evidence summary instead of more no-op/check programs or review. It immediately revokes admission and stops the run; completion is model-reported and unverified, never goal.verified. Program completed statuses are execution-only. Built-in goals cannot bypass their trusted verifier.",
    },
    topics: ["game", "programs", "planning", "reflex", "memory"],
    advanced: "Request help topic reflex or memory to disclose that optional module for ordinary planning. Speculative and post-goal roles cannot acquire extra authority through help.",
    observation: "The observe tool returns permitted adapter projection data/metadata without host authority identities. Program game.observe() and guards use ObservationV3 with adapter-owned data. Historical schema2 artifacts are read-only. Arguments, results and detailed traces retain opaque JSON keys; byte-budget omissions remain explicit.",
    workflow: "Observe authorized state; write/revise compact named taskflow; start once and let it work. Inspect exact source/outcomes/trace/feedback only when useful. Assess keep or insufficient_evidence, or link a performed revision through write.reason. Host preflight owns readiness, not a mandatory model bootstrap ceremony.",
  };
}
