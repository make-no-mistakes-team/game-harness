import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod";
import { IMPROVEMENT_RESOLUTION_HELP } from "../shared/execution-evidence.ts";
import type {
  ActivityEvent,
  ActionView,
  Json,
  Observation,
  ProgramEvidenceView,
} from "../shared/contracts.ts";
import {
  getGameAPIReference,
  policyDecisionSchema,
  policySpecSchema,
  skillRefSchema,
  skillLimitsSchema,
  skillStartRequestSchema,
  lookaheadRequestSchema,
} from "../shared/validation.ts";
import { DEFAULT_SKILL_LIMITS } from "../shared/programs.ts";
import type { Store, StoredRun } from "./store.ts";
import {
  ReactiveRuntime,
  activateSchema,
  policyRefSchema,
} from "./reactive.ts";
import {
  SkillManager,
  skillLookupSchema,
} from "./skills.ts";
import { ExperienceLibrary, promotionDeclarationSchema } from "./experience.ts";
import { ProgramValidationError } from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { SpeculativePlanning } from "./speculative-planning.ts";
import type { ImprovementLearning } from "./improvement-learning.ts";
import { compareProgramVersionsPage } from "./program-comparison.ts";
import { jsonSchema } from "../shared/validation.ts";
export interface RuntimeToolHost {
  run(): StoredRun;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  observe(): Promise<Observation>;
  action(): ActionView | null;
  recipes(item: string): Promise<Json>;
  attentionAfter(ms: number, reason: string): void;
  admitted(): void;
  evidence(): ProgramEvidenceView[];
  planning(): SpeculativePlanning;
  learning(): ImprovementLearning;
  toolAuthority(): () => void;
}
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const epoch = z.number().int().nonnegative();
const empty = z.object({}).strict();
const REVIEW_TOOLS = new Set([
  "capabilities_read", "observation_read",
  "skill_read", "skill_register", "skill_revise", "skill_history",
  "feedback_read", "trace_read", "improvement_feedback",
  "improvement_resolve", "version_compare", "planning_read",
]);
const versionEvidenceSchema = skillRefSchema.extend({
  run_id: z.uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const skillSpecSchema = z
  .object({
    name: z.string().min(1).max(80),
    source: z
      .string()
      .min(1)
      .max(16384)
      .describe(
        "Only the JavaScript statements forming an async function BODY. The host already provides game and args as parameters. Do not include an enclosing function declaration, async function wrapper, arrow-function wrapper, import or export. Use await on game capabilities. EVERY return path, including blocked/failed early exits, must return all three fields: {status:'completed'|'blocked'|'failed',summary:string,result:JSON}. Use result:null when there is no payload. Static source validation does not prove all return paths. Resolve targets from current authorized game.observe() data inside the program and implement bounded taskflow, result checks and recovery rather than one primitive per strategic request.",
      ),
    card: z
      .object({
        purpose: z.string().min(1).max(1000),
        applicability: z.string().min(1).max(1000),
        method: z.string().min(1).max(2000),
        reason: z.string().min(1).max(1000),
        limitations: z.string().min(1).max(1000),
      })
      .strict(),
    dependencies: z.array(skillRefSchema).max(32),
  })
  .strict();
const skillRevisionSpecSchema = skillSpecSchema.omit({ name: true });
/** Schema/authority/evidence seam shared by all strategic tool invocations. */
export class RuntimeTools {
  constructor(
    private store: Store,
    private skills: SkillManager,
    private reactions: ReactiveRuntime,
    private experience: ExperienceLibrary | null,
    private host: RuntimeToolHost,
  ) {}
  build(generation: number): AgentTool[] {
    const run = this.host.run();
    let reviewDecisions = 0;
    const tool = <T>(
      name: string,
      description: string,
      schema: z.ZodType<T>,
      handler: (
        input: T,
        callId: string,
        signal: AbortSignal | undefined,
        commit: () => void,
      ) => unknown | Promise<unknown>,
    ): AgentTool => ({
      name,
      label: name,
      description,
      intent: "omit",
      concurrency: "exclusive",
      parameters: z.toJSONSchema(schema, { unrepresentable: "any" }),
      execute: async (callId, raw, signal) => {
        try {
          if (signal?.aborted)
            throw new RuntimeFault(
              "stale_context",
              "The strategic request was cancelled",
            );
          if (!["skill_start", "skill_get", "skill_cancel"].includes(name))
            this.host.assertCurrent(generation);
          const commit = ["skill_start", "skill_get", "skill_cancel"].includes(name)
            ? () => {} : this.host.toolAuthority();
          commit();
          if (run.status === "reviewing" && !REVIEW_TOOLS.has(name))
            throw new RuntimeFault("precondition_failed", "Post-goal review cannot execute or select gameplay effects");
          if (run.status === "reviewing" && name === "improvement_resolve" && reviewDecisions++ >= 4)
            throw new RuntimeFault("deadline_exceeded", "The bounded post-goal review decision allowance is exhausted");
          const value = await handler(schema.parse(raw), callId, signal, commit);
          commit();
          if (!["skill_start", "skill_get", "skill_cancel", "planning_activate"].includes(name))
            this.host.assertCurrent(generation);
          if (name !== "feedback_read")
            this.store.event(
              run.run_id,
              "model.tool_result",
              `Strategic tool ${name} returned service evidence`,
              {
                tool_call_id: callId,
                tool: name,
                result: JSON.parse(JSON.stringify(value)) as Json,
              },
            );
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            details: value,
          };
        } catch (error) {
          let failure: Record<string, Json>;
          if (error instanceof ProgramValidationError) {
            failure = {
              code: "invalid_program",
              message:
                name === "planning_stage" &&
                error.issues.some((issue) => issue.code === "invalid_syntax")
                  ? "Precondition syntax is invalid. Supply only an async function BODY using the supplied context and state bindings, returning a boolean. Do not include an enclosing function, arrow wrapper, import or export."
                  : name === "skill_register" &&
                error.issues.some((issue) => issue.code === "invalid_syntax")
                  ? "Skill syntax is invalid. Supply async function body statements only: game and args are already provided; do not add an enclosing function or arrow wrapper."
                  : "Program failed compact executable validation",
              retryable: false,
              issues: JSON.parse(JSON.stringify(error.issues)) as Json,
            };
            if (name === "planning_stage" && "stage_correction" in error)
              failure.stage_correction = JSON.parse(JSON.stringify(error.stage_correction)) as Json;
          } else if (error instanceof RuntimeFault) {
            failure = {
              code: error.code,
              message: error.message,
              retryable: false,
            };
            if ("issues" in error && Array.isArray(error.issues))
              failure.issues = JSON.parse(JSON.stringify(error.issues)) as Json;
          } else
            failure = {
              code:
                error instanceof z.ZodError
                  ? "invalid_request"
                  : "backend_unavailable",
              message:
                error instanceof z.ZodError
                  ? "Tool arguments do not match the advertised schema"
                  : "The requested service operation could not complete safely",
              retryable: false,
            };
          this.store.event(
            run.run_id,
            "model.tool_rejected",
            "Strategic tool returned a fixed safe rejection",
            { tool_call_id: callId, tool: name, error: failure },
          );
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: failure }) },
            ],
            details: { error: failure },
            isError: true,
          };
        }
      },
    });
    return [
      tool(
        "capabilities_read",
        "Read the public game API methods and canonical observation/action/result JSON Schemas, including inventory fields, plus current epoch/phase and authorized observation permissions. Source validation does not prove JavaScript types or DTO field access.",
        empty,
        () => ({
          run_id: run.run_id,
          epoch: run.epoch,
          session_id: run.session_id,
          life_id: run.life_id,
          phase: run.status,
          observation_profile: {
            id: "player-observable-structured",
            preset: "minecraft-observable-initial-r2",
            radius_blocks: 32,
            freshness_ms: 1000,
            remembered_is_current: false,
            hidden_state: false,
          },
          game_api: getGameAPIReference(),
          policy_spec_schema: z.toJSONSchema(policySpecSchema, {
            unrepresentable: "any",
          }),
          policy_decision_schema: z.toJSONSchema(policyDecisionSchema),
          skill_spec_schema: z.toJSONSchema(skillSpecSchema),
          skill_revision_spec_schema: z.toJSONSchema(skillRevisionSpecSchema),
          skill_limits_schema: z.toJSONSchema(skillLimitsSchema),
          limits: {
            queue: 16,
            active_policies: 4,
            policy_interval_min_ms: 200,
            policy_evaluation_ms: 500,
            trial_ms: 120000,
            trial_actions: 20,
            trial_evaluations: 100,
            turn_calls: 12,
            turn_tools: 48,
            bootstrap_calls: 3,
            bootstrap_ms: 60000,
          },
          skills: {
            register: "skill_register",
            revise: "skill_revise",
            start: "skill_start",
            get: "skill_get",
            cancel: "skill_cancel",
            default_limits: DEFAULT_SKILL_LIMITS,
          },
          custom_completion: "operator_only",
          effects: {
            admission: run.status === "running" ? "open" : "closed",
            owners: ["skill", "policy"],
            strategic_direct: false,
          },
        }),
      ),
      tool(
        "skill_register",
        "Validate and register immutable compact JavaScript async function BODY statements only; game and args are already provided. No enclosing function/arrow/export. Author a bounded taskflow with observations, result checks and recovery, plus StrategyCard and exact dependencies. Does not execute.",
        z.object({ epoch, spec: skillSpecSchema }).strict(),
        async (input, _callId, _signal, commit) => {
          this.host.assertCurrent(generation, input.epoch);
          return await this.skills.register(run.run_id, input.spec, () => {
            this.host.assertCurrent(generation, input.epoch);
            commit();
          });
        },
      ),
      tool(
        "skill_revise",
        "Author a linked immutable candidate from the exact latest parent. spec contains source, card and dependencies only; the host inherits the parent's name. No rename. Source is your original code, never automatically repaired or claimed better.",
        z.object({ epoch, parent: skillRefSchema, spec: skillRevisionSpecSchema }).strict(),
        async (input, _callId, _signal, commit) => {
          this.host.assertCurrent(generation, input.epoch);
          const parent = this.store.skill(run.run_id, input.parent);
          const assertLatestParent = () => {
            const latest = this.store.skills(run.run_id).filter((skill) => skill.skill_id === parent.skill_id)
              .sort((a, b) => b.version - a.version)[0];
            if (latest?.version !== parent.version)
              throw Object.assign(new RuntimeFault("conflict", "Revision parent is stale. Read error.issues[0].latest_parent and author against that exact version."), {
                issues: [{
                  code: "stale_parent",
                  path: "parent",
                  latest_parent: latest ? { skill_id: latest.skill_id, version: latest.version } : null,
                }],
              });
          };
          assertLatestParent();
          return await this.skills.register(run.run_id, { ...input.spec, name: parent.name }, () => {
            this.host.assertCurrent(generation, input.epoch);
            commit();
            assertLatestParent();
          });
        },
      ),
      tool(
        "planning_lookahead",
        "Opt in once per live root to one independent planning turn; no effects. After after_ms, duration_ms is one shared deadline for planning/tools, predecessor wait, fresh validation and activation. Staging never renews it.",
        lookaheadRequestSchema,
        (input) => this.host.planning().optIn(input),
      ),
      tool(
        "planning_stage",
        "Stage one model-selected existing skill_id/version; the host pins its actual source and dependency hashes. Do not supply a hash. precondition_source is an async function BODY with supplied context/state returning boolean, no wrapper/export or policy/skill result object. Explicit corrections share the original planning/tool/predecessor/validation/activation deadline; no automatic retry or extension.",
        z.object({
          plan_id: z.uuid(),
          skill: skillRefSchema.describe(
            "The exact existing model-selected immutable skill_id/version in this run. Supply only these two fields, never a hash. The host resolves and pins actual source/dependency identities and rechecks them at activation.",
          ),
          args: jsonSchema,
          limits: skillLimitsSchema,
          precondition_source: z.string().min(1).max(16384).describe(
            "Original async function BODY statements only; context and state are supplied. No enclosing function/arrow, import or export. Return boolean, not a policy decision or SkillResult. context is {observation:Observation,task:string,goal:string,predecessor:{execution_id:string,skill_id:string,version:number,hash:string,status:SkillExecutionView.status},candidate:{skill_id:string,version:number,hash:string},args:Json}. state is an empty one-shot local object. task is plain text, not an object; session_id/epoch/life are observation fields. There is no dependencies field: the host pins and validates the closure. predecessor.status uses accepted|running|cancel_requested|succeeded|blocked|failed|cancelled|unknown; activation invokes this predicate only after succeeded. completed belongs SkillResult, not predecessor; execution success is not goal verification. Host guards already enforce run/task/session/life/source identity: do not copy long task text or opaque IDs to repeat them. False rejects activation unchanged. Isolation has no game API/network/files/providers. Original source is preserved; explicit syntax/compactness correction shares the same remaining request/tool/deadline budgets.",
          ),
        }).strict(),
        async (input) => await this.host.planning().stage(input),
      ),
      tool(
        "planning_activate",
        "Explicitly activate only after successful exact predecessor closure, fresh life/session checks and isolated precondition success. Planning/tools, predecessor wait, validation and activation must all fit the original duration_ms deadline after after_ms; no staged extension.",
        z.object({ plan_id: z.uuid() }).strict(),
        async (input) => await this.host.planning().activate(input.plan_id),
      ),
      tool("planning_read", "Read bounded staging/admission evidence without effects.", empty, () => this.host.planning().projection()),
      tool(
        "trace_read",
        "Read bounded attributed actual API/observation/branch trace; model intent and branch diagnostics are not success proof.",
        z.object({ after: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(64) }).strict(),
        (input) => this.store.tracePage(run.run_id, input.after, input.limit),
      ),
      tool("improvement_feedback", "Read bounded deduplicated failure/death/outcome opportunities and objective measurements.",
        z.object({
          after: z.object({ opportunity_seq: z.int().nonnegative(), execution_seq: z.int().nonnegative() }).strict()
            .default({ opportunity_seq: 0, execution_seq: 0 }),
          limit: z.int().min(1).max(100).default(32),
        }).strict(),
        (input) => this.host.learning().feedback(run.run_id, input.after, input.limit)),
      tool(
        "improvement_resolve",
        IMPROVEMENT_RESOLUTION_HELP,
        z.object({
          opportunity_id: z.string().min(1).max(160),
          decision: z.enum(["revise", "keep", "insufficient_evidence"]).describe(IMPROVEMENT_RESOLUTION_HELP),
          reason: z.string().min(1).max(2000).describe(
            "Describe the actual experimental choice and evidence limits. A revise decision may explicitly state that efficacy is unproven.",
          ),
          revision: versionEvidenceSchema.nullable().describe(IMPROVEMENT_RESOLUTION_HELP),
          event_seqs: z.array(z.int().positive()).max(64),
        }).strict(),
        (input) => this.host.learning().resolve(run.run_id, input.opportunity_id, input),
      ),
      tool(
        "version_compare",
        "Compare exact original versions and actual objective samples; descriptive only, not causal improvement evidence.",
        z.object({ before: versionEvidenceSchema, after: versionEvidenceSchema,
          after_sample: z.int().nonnegative().default(0), limit: z.int().min(1).max(100).default(25) }).strict(),
        (input) => compareProgramVersionsPage(this.store, input.before, input.after,
          { kind: "model", run_id: run.run_id, model_id: run.model_id }, input.after_sample, input.limit),
      ),
      tool(
        "skill_start",
        "Durably start an exact skill with stable start_key. Optional lookahead selects one independent planning wake at admission before handoff; omit for none. Its duration_ms is one deadline after after_ms for planning/tools, predecessor wait, fresh validation and activation; staging never renews it. Matching retry returns original identity without replay or another plan.",
        skillStartRequestSchema,
        (input) => {
          const existing = this.skills.get(run.run_id, {
            start_key: input.start_key,
          });
          if (!existing) this.host.assertCurrent(generation, input.epoch);
          const view = this.skills.start(run.run_id, input);
          if (!existing) this.host.admitted();
          return view;
        },
      ),
      tool(
        "skill_get",
        "Read durable skill outcome and consumed root budgets without restarting code.",
        skillLookupSchema,
        (input) => {
          const view = this.skills.get(run.run_id, input);
          if (!view)
            throw new RuntimeFault("not_found", "Skill execution not found");
          return view;
        },
      ),
      tool(
        "skill_cancel",
        "Fence descendants immediately; terminal closure waits isolated workers and leaf effect shutdown.",
        skillLookupSchema,
        (input) => this.skills.cancel(run.run_id, input),
      ),
      tool(
        "skill_read",
        "Read exact immutable source, StrategyCard, validation and dependencies only on demand.",
        skillRefSchema,
        (input) => this.store.skill(run.run_id, input),
      ),
      tool(
        "skill_history",
        "Read measured duration, actions/calls, strategic requests during execution and verified-vs-self-reported evidence; compactness separate.",
        empty,
        () => this.host.evidence(),
      ),
      tool(
        "attention_after",
        "Choose one finite future attention wake, replacing any previous condition. Never periodic.",
        z
          .object({
            after_ms: z.number().int().min(1000).max(600000),
            reason: z.string().min(1).max(300),
          })
          .strict(),
        (input) => {
          this.host.attentionAfter(input.after_ms, input.reason);
          return input;
        },
      ),
      tool(
        "observation_read",
        "Read detailed current filtered player observation. Remembered objects are not current-effect authorization.",
        empty,
        async () => await this.host.observe(),
      ),
      tool(
        "action_get",
        "Read durable action evidence by ID, including historical strategist-origin records. This cannot submit, cancel or resume effects; use skill outcomes rather than polling individual actions.",
        z.object({ action_id: id }).strict(),
        (input) => {
          const action = this.store.getAction(run.run_id, input.action_id);
          if (!action) throw new RuntimeFault("not_found", "Action not found");
          return action.view;
        },
      ),
      tool(
        "recipes_read",
        "Read actual mechanical recipes. craft.executions means recipe executions.",
        z.object({ item: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) }).strict(),
        async (input, _callId, _signal, commit) => {
          // Same trusted capability as program recipes; no adapter/network bypass.
          return await this.host.recipes(input.item);
        },
      ),
      tool(
        "policy_register",
        "Register immutable optional JavaScript reaction or real Jev instruction with finite choices.",
        z.object({ epoch, spec: policySpecSchema }).strict(),
        async (input) =>
          await this.reactions.register(input.spec, input.epoch, generation),
      ),
      tool(
        "policy_validate",
        "Validate the exact immutable reaction on current filtered context without effects. Not effectiveness proof.",
        policyRefSchema,
        async (input, _callId, signal) =>
          await this.reactions.validate(input, generation, signal),
      ),
      tool(
        "policy_activate",
        "Select a bounded trial, or explicitly keep a tried exact version with confirmed effect evidence.",
        activateSchema,
        async (input, _callId, signal) =>
          await this.reactions.activate(input, generation, signal),
      ),
      tool(
        "policy_retire",
        "Revoke exact reaction evaluations and safely close its workers, proposals and effects.",
        policyRefSchema,
        async (input) => await this.reactions.retire(input, generation),
      ),
      tool(
        "experience_read",
        "List declared compatible model/profile/world-scoped exact snapshots; source code is not a proof of effectiveness.",
        empty,
        () => this.experience?.list(run.model_id, run.world_id) ?? [],
      ),
      tool(
        "experience_promote",
        "Explicitly promote exact dependency snapshot using declared portability and verified bounded inventory/goal predicate evidence; generic movement and self-ratings do not qualify.",
        z
          .object({
            execution_id: id,
            name: z.string().min(1).max(80),
            declaration: promotionDeclarationSchema,
          })
          .strict(),
        (input) => {
          if (!this.experience)
            throw new RuntimeFault(
              "backend_unavailable",
              "Experience library is not configured",
            );
          const execution = this.skills.get(run.run_id, {
            execution_id: input.execution_id,
          });
          if (!execution)
            throw new RuntimeFault("not_found", "Skill execution not found");
          const view = this.experience.promote(
            this.store,
            run.run_id,
            execution,
            input.name,
            input.declaration,
          );
          this.store.event(
            run.run_id,
            "experience.promoted",
            "Explicit predicate-evidence-linked snapshot promoted",
            view as unknown as Json,
          );
          return view;
        },
      ),
      tool(
        "experience_load",
        "Select and freshly validate exact compatible dependencies; never restore old args, observations, coordinates or worker state.",
        z
          .object({ experience_id: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
        async (input, _callId, _signal, commit) => {
          if (!this.experience)
            throw new RuntimeFault(
              "backend_unavailable",
              "Experience library is not configured",
            );
          return await this.experience.hydrate(
            input.experience_id,
            run.model_id,
            run.world_id,
            run.run_id,
            this.skills,
            () => {
              this.host.assertCurrent(generation);
              commit();
            },
          );
        },
      ),
      tool(
        "feedback_read",
        "Read bounded forward durable evidence with after_event_seq cursor. Large evidence remains identified rather than stranding pagination.",
        z
          .object({
            after_event_seq: z.number().int().nonnegative().default(0),
            limit: z.number().int().min(1).max(100).default(64),
          })
          .strict(),
        (input) => {
          const candidates = this.store.eventsAfter(
              run.run_id,
              input.after_event_seq,
              input.limit,
            ),
            events: ActivityEvent[] = [];
          let bytes = 0;
          for (const event of candidates) {
            const size = Buffer.byteLength(JSON.stringify(event));
            if (events.length && bytes + size > 64 * 1024) break;
            events.push(
              size > 64 * 1024
                ? {
                    ...event,
                    details: {
                      omitted: true,
                      reason:
                        "Single evidence event exceeds feedback byte budget; protected activity retains full evidence",
                      original_bytes: size,
                    },
                  }
                : event,
            );
            bytes += Math.min(size, 64 * 1024);
          }
          const cursor =
            events[events.length - 1]?.event_seq ?? input.after_event_seq;
          this.store.event(
            run.run_id,
            "model.feedback_read",
            "Strategist read bounded forward evidence",
            {
              after_event_seq: input.after_event_seq,
              through_event_seq: cursor,
              records: events.length,
            },
          );
          return {
            events,
            next_event_seq: cursor,
            page_full:
              events.length < candidates.length ||
              candidates.length === input.limit,
            run: {
              run_id: run.run_id,
              epoch: run.epoch,
              status: run.status,
              action: this.host.action(),
            },
          };
        },
      ),
    ];
  }
}
