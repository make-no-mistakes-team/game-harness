import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GameAction,
  ActionView,
  GameActionResult,
  GameBridge,
  GoalChoice,
  GoalId,
  Json,
  Observation,
  PolicyContext,
  RunView,
} from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import { goalSchema } from "../shared/validation.ts";
import type { AuthManager } from "./auth.ts";
import type { SandboxService } from "./sandbox.ts";
import type { Store, StoredRun } from "./store.ts";
import { SkillManager } from "./skills.ts";
import { emptyRunUsage } from "./usage.ts";
import {
  CURRENT_PROGRAM_COMPATIBILITY,
  ExperienceLibrary,
  promotionDeclarationSchema as promotionSchema,
  type ProgramCompatibility,
  type PromotionDeclaration,
} from "./experience.ts";
import type { FastJudgeBroker } from "./fast-provider.ts";
import { programEvidence } from "./program-evidence.ts";
import { ActionArbiter } from "./action-arbiter.ts";
import { ReactiveRuntime } from "./reactive.ts";
import { StrategicPlanner } from "./strategic.ts";
import { RuntimeTools } from "./runtime-tools.ts";
import { createRuntimePrompt } from "./runtime-prompt.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { SpeculativePlanning } from "./speculative-planning.ts";
import { ImprovementLearning } from "./improvement-learning.ts";
import { ExecutionTrace } from "./execution-trace.ts";

export const GOALS: GoalChoice[] = [
  {
    id: "break_log",
    label: "Break a log",
    prompt: "Remove at least one eligible log, wood, stem or hyphae block during this run with a server-confirmed block-removal receipt. Inventory gain is not required.",
  },
  {
    id: "collect_wood",
    label: "Collect wood",
    prompt:
      "Acquire at least one additional wood log, wood block, stem, or hyphae item relative to the inventory at run start.",
  },
  {
    id: "craft_crafting_table",
    label: "Craft a crafting table",
    prompt:
      "Successfully craft a crafting table during this run and retain a crafting table in inventory.",
  },
  {
    id: "craft_stone_pickaxe",
    label: "Craft a stone pickaxe",
    prompt:
      "Successfully craft a stone pickaxe during this run and retain a stone pickaxe in inventory.",
  },
  {
    id: "custom",
    label: "Custom task",
    prompt:
      "Pursue the supplied task. Custom-task completion is not automatically verified; the operator stops the run.",
  },
];

const TERMINAL: Partial<Record<RunView["status"], true>> = {
  stopped: true,
  completed: true,
  failed: true,
};
const ACTION_TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
const BRIDGE_FAILURE =
  "The game effect could not be safely reconciled. Reconnect the game before resuming; no uncertain action will be replayed.";
function inventoryCounts(observation: Observation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of observation.player.inventory)
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}
export interface RuntimeOptions {
  experienceDirectory?: string;
  judge?: FastJudgeBroker;
  adapter_id?: string;
}

/** Lifecycle and trusted observation/goal authority; execution modules own their scheduling. */
export class Runtime {
  private readonly skills: SkillManager;
  private readonly experience: ExperienceLibrary | null;
  private readonly compatibility: ProgramCompatibility | null;
  private readonly actions: ActionArbiter;
  private readonly reactions: ReactiveRuntime;
  private readonly strategic: StrategicPlanner;
  private readonly catalog: RuntimeTools;
  private readonly planning: SpeculativePlanning;
  private readonly learning: ImprovementLearning;
  private readonly trace: ExecutionTrace;
  private run: StoredRun | null = null;
  private observation: Observation | null = null;
  private observationRequest: Promise<Observation> | null = null;
  private inventoryEvidence = "";
  private generation = 0;
  private unsubscribeGame: (() => void) | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private needsReconnect = false;
  private completedCrafts = new Set<string>();
  private closed = false;
  private deathIds = new Set<string>();
  private lifeRecovery: Promise<void> | null = null;
  private uncertaintyRecovery: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly auth: AuthManager,
    private readonly game: GameBridge,
    private readonly sandbox: SandboxService,
    private readonly onChange: () => void,
    options: RuntimeOptions = {},
  ) {
    this.compatibility =
      options.adapter_id === "fabric-owned-client"
        ? CURRENT_PROGRAM_COMPATIBILITY
        : null;
    this.experience = options.experienceDirectory
      ? new ExperienceLibrary(options.experienceDirectory, this.compatibility)
      : null;
    this.learning = new ImprovementLearning(store);
    this.trace = new ExecutionTrace(store);
    this.planning = new SpeculativePlanning({
      admissionContext: () => {
        const run = this.run, state = game.snapshot();
        if (!run || run.status !== "running" || state.status !== "connected" || state.error !== null ||
          state.world_id !== run.world_id || state.epoch !== run.epoch || state.session_id !== run.session_id ||
          !state.session_id || !state.life || state.life.life_id !== run.life_id ||
          this.lifeRecovery || this.uncertaintyRecovery) return null;
        return {
          run_id: run.run_id, world_id: run.world_id, generation: this.generation,
          session_id: state.session_id, epoch: state.epoch,
          life_id: state.life.life_id, life_status: state.life.status,
          task: run.task, goal: run.goal,
        };
      },
      context: () => {
        const run = this.run, state = game.snapshot();
        if (!run || run.status !== "running" || !state.session_id || !state.life || this.lifeRecovery || this.uncertaintyRecovery) return null;
        const root = store.latestRootExecution(run.run_id);
        if (!root) return null;
        const source = store.skill(run.run_id, root);
        return {
          run_id: run.run_id, world_id: run.world_id, generation: this.generation,
          session_id: state.session_id, epoch: state.epoch,
          life_id: state.life.life_id, life_status: state.life.status,
          task: run.task, goal: run.goal,
          root: { execution_id: root.execution_id, skill_id: root.skill_id, version: root.version, hash: source.hash, status: root.status },
        };
      },
      skill: (ref) => {
        try { return this.run ? store.skill(this.run.run_id, ref) : null; }
        catch { return null; }
      },
      observe: () => this.refreshObservation(),
      evaluateGuard: (source, observation, args, signal) =>
        sandbox.evaluateGameGuard(source, observation, args, signal),
      admit: async (request, permit) => {
        permit.assertCurrent();
        if (permit.signal.aborted) throw new RuntimeFault("stale_context", "Plan admission cancelled");
        const view = this.skills.start(this.run!.run_id, request);
        this.strategic.admitted();
        return view;
      },
      evidence: (type, details) => { store.event(this.run?.run_id ?? null, type, "Bounded speculative planning evidence", details); },
      wake: (reason) => this.strategic.wake(
        reason === "lookahead" ? "speculative_lookahead" : "planning_continuation",
      ),
    });
    this.actions = new ActionArbiter(store, game, {
      run: () => this.run,
      generation: () => this.generation,
      needsReconnect: () => this.needsReconnect,
      changed: onChange,
      wake: (reason) => this.strategic.wake(reason),
      pause: (message, reconnect) =>
        this.requestSafetyPause(message, reconnect),
      uncertain: (action) => this.handleUncertainty(action),
      observe: () => this.refreshObservation(),
      admitted: () => this.strategic.admitted(),
      effect: (policy, kind, evidence) =>
        this.reactions.recordEffect(policy, kind, evidence),
      succeeded: (action, result, view) => {
        if (action.kind === "craft") this.completedCrafts.add(action.item);
        if (
          this.run?.status === "running" &&
          this.run.goal === "break_log" &&
          action.kind === "dig" &&
          result.evidence &&
          typeof result.evidence === "object" &&
          !Array.isArray(result.evidence) &&
          result.evidence.effect_confirmed === true &&
          result.evidence.source === "server_block_update" &&
          typeof result.evidence.target_name === "string" &&
          /_(log|wood|stem|hyphae)$/.test(result.evidence.target_name)
        ) {
          this.store.event(this.run.run_id, "goal.verified", "Trusted verifier confirmed an eligible block removal", {
            kind: "block_removal",
            goal: "break_log",
            item: result.evidence.target_name,
            action_id: view.action_id,
            execution_id: view.execution_id,
            session_id: view.session_id,
            life_id: view.life_id,
            evidence: result.evidence,
          });
          this.requestTerminal("completed", "Goal completed with verified block-removal evidence");
        }
      },
    });
    this.skills = new SkillManager(store, sandbox, {
      prepareLookahead: (config) => this.planning.prepareOptIn(config),
      authorize: (runId, epoch, sessionId, lifeId) => {
        if (this.run?.run_id !== runId || this.run.status !== "running")
          throw new RuntimeFault(
            "stale_context",
            "Skill effect authority is closed",
          );
        this.assertCurrent(this.generation, epoch);
        const state = this.game.snapshot();
        if (this.lifeRecovery || this.uncertaintyRecovery || state.session_id !== sessionId || state.life?.life_id !== lifeId ||
          !["alive", "dead"].includes(state.life.status))
          throw new RuntimeFault("stale_context", "Skill player-life authority is closed");
      },
      observe: () => this.refreshObservation(),
      action: (execution, action, signal, callId) =>
        this.skillAction(execution, action, signal, callId),
      recipes: (item) => game.recipes(item),
      recover: async (execution) => {
        const generation = this.generation;
        const respawn = this.actions.view;
        if (!respawn || respawn.kind !== "respawn" || respawn.execution_id !== execution.execution_id ||
          respawn.result?.status !== "succeeded" || execution.parent_execution_id !== null)
          throw new RuntimeFault("stale_context", "New-life adoption requires the exact chosen root's successful respawn action");
        const observation = await this.refreshObservation();
        this.assertCurrent(generation, execution.epoch);
        if (observation.session_id !== execution.session_id || observation.life.status !== "alive" ||
          observation.life.life_id === execution.life_id)
          throw new RuntimeFault("stale_context", "Respawn did not establish a fresh authoritative player life");
        this.run!.life_id = observation.life.life_id;
        this.store.event(execution.run_id, "skill.life_adopted", "Only the explicitly chosen recovery root adopted a confirmed new life", {
          execution_id: execution.execution_id,
          root_execution_id: execution.root_execution_id,
          session_id: execution.session_id,
          previous_life_id: respawn.life_id,
          life_id: observation.life.life_id,
          respawn_action_id: respawn.action_id,
          observation_seq: observation.observation_seq,
        });
        this.persist("Explicit recovery established a new player life in the same run");
        await this.reactions.resume(generation);
        return observation.life.life_id;
      },
      cancelActions: (ids, reason) => this.actions.cancelOwned(ids, reason),
      changed: (outcome, execution) => {
        this.onChange();
        if (outcome) {
          if (execution) this.learning.feedback(execution.run_id);
          const continuationOwnsOutcome = execution
            ? this.planning.predecessorSettled(execution.execution_id) : false;
          if (!continuationOwnsOutcome) this.strategic.wake("skill_outcome");
        }
      },
      unsafe: () => {
        if (this.uncertaintyRecovery) {
          if (this.run) this.run.error ??= "An isolated program could not confirm cleanup";
          return;
        }
        this.requestSafetyPause(
          "An isolated program could not confirm cleanup; effect admission remains fenced",
          true,
        );
      },
    });
    this.reactions = new ReactiveRuntime(
      store,
      sandbox,
      this.actions,
      {
        run: () => this.run,
        generation: () => this.generation,
        assertCurrent: (generation, epoch) =>
          this.assertCurrent(generation, epoch),
        context: () => this.policyContext(),
        gameState: () => game.snapshot(),
        needsReconnect: () => this.needsReconnect,
        wake: (reason) => this.strategic.wake(reason),
        changed: onChange,
        admitted: () => this.strategic.admitted(),
        closePrograms: async (reason) => {
          this.skills.fence(reason);
          await this.skills.closeAll(reason);
        },
        neutralize: async () => {
          try {
            await game.neutralize();
          } catch (error) {
            this.requestSafetyPause("Native input neutralization could not be confirmed", true);
            throw error;
          }
        },
      },
      options.judge,
    );
    this.strategic = new StrategicPlanner(store, auth, {
      run: () => this.run,
      generation: () => this.generation,
      assertCurrent: (generation, epoch) =>
        this.assertCurrent(generation, epoch),
      tools: (generation) => this.catalog.build(generation),
      rootPrompt: () =>
        createRuntimePrompt(
          this.run!,
          GOALS.find((goal) => goal.id === this.run!.goal)!,
        ),
      observe: () => this.refreshObservation(),
      policies: () => this.reactions.list,
      action: () => this.actions.active?.entry.stored.view ?? this.actions.view,
      programPending: () => this.skills.pending,
      busy: () => this.actions.busy || this.skills.pending,
      persist: (summary) => this.persist(summary),
      pause: (message) => this.requestSafetyPause(message, false),
      terminal: (status, message) => this.requestTerminal(status, message),
      speculation: () => this.planning,
      reviewComplete: () => this.finishReview(),
      reviewContext: () => this.learning.feedback(this.run!.run_id),
    });
    this.catalog = new RuntimeTools(
      store,
      this.skills,
      this.reactions,
      this.experience,
      {
        run: () => this.run!,
        assertCurrent: (generation, epoch) =>
          this.assertCurrent(generation, epoch),
        observe: () => this.refreshObservation(),
        recipes: (item) => game.recipes(item),
        attentionAfter: (ms, reason) =>
          this.strategic.attentionAfter(ms, reason),
        admitted: () => this.strategic.admitted(),
        evidence: () => this.skillEvidence(this.run!.run_id),
        planning: () => this.planning,
        learning: () => this.learning,
        toolAuthority: () => this.strategic.speculativeToolAuthority(),
      },
    );
  }
  async initialize(): Promise<void> {
    if (this.unsubscribeGame) return;
    this.run = this.store.lastRun();
    if (this.run) {
      this.store.closeUnfinishedActions(this.run.run_id);
      this.store.reconcileSkillExecutions(this.run.run_id);
      this.reactions.initialize(this.run.run_id);
      if (!TERMINAL[this.run.status]) {
        this.run.status = "stopped";
        this.run.model_status = "idle";
        this.run.ended_at = new Date().toISOString();
        this.run.error ??=
          "The previous application process ended. Interrupted work was fenced and closed; create a new run to continue.";
        this.store.saveRun(
          this.run,
          "Interrupted run closed without automatic replay",
        );
      }
    }
    this.unsubscribeGame = this.game.subscribe((notice) => {
      if (!this.run || TERMINAL[this.run.status] || this.closed) return;
      if (notice.type === "game_event" && this.game.snapshot().life?.status === "dead") {
        this.handleDeath();
        return;
      }
      if (notice.type === "observation" && this.run.status === "running")
        void this.refreshObservation().catch(() => {});
      else if (
        notice.type === "state" &&
        (this.run.status === "running" || this.run.status === "reviewing")
      ) {
        const state = this.game.snapshot();
        const sameContext =
          state.world_id === this.run.world_id &&
          state.epoch === this.run.epoch &&
          state.session_id === this.run.session_id;
        if (
          state.status !== "connected" ||
          !sameContext ||
          state.error !== null
        )
          this.requestSafetyPause(
            sameContext ? (state.error ?? BRIDGE_FAILURE) : BRIDGE_FAILURE,
            true,
          );
      }
    });
    this.onChange();
  }
  snapshot(): RunView | null {
    if (!this.run) return null;
    const { baseline: _baseline, ...view } = this.run;
    return structuredClone({
      ...view,
      action: this.actions.view,
      policies: this.reactions.list,
      skills: this.store.skills(this.run.run_id),
      executions: this.store.skillExecutions(this.run.run_id),
    });
  }
  getRun(id: string): RunView | null {
    if (this.run?.run_id === id) return this.snapshot();
    const run = this.store.getRun(id);
    if (!run) return null;
    const { baseline: _baseline, ...view } = run;
    return {
      ...view,
      action: null,
      policies: this.store.policies(id),
      skills: this.store.skills(id),
      executions: this.store.skillExecutions(id),
    };
  }

  listExperience(modelId: string) {
    return this.experience?.list(modelId, this.game.snapshot().world_id) ?? [];
  }

  skillEvidence(runId: string) {
    if (!this.store.getRun(runId))
      throw new RuntimeFault("not_found", "Run not found");
    return programEvidence(this.store, runId);
  }
  planningView(runId: string) {
    if (!this.store.getRun(runId)) throw new RuntimeFault("not_found", "Run not found");
    return this.run?.run_id === runId ? this.planning.projection() : null;
  }

  promoteExperience(
    runId: string,
    executionId: string,
    name: string,
    declaration: PromotionDeclaration,
  ) {
    if (!this.experience)
      throw new RuntimeFault(
        "backend_unavailable",
        "Experience library is not configured",
      );
    const execution = this.skills.get(runId, { execution_id: executionId });
    if (!execution)
      throw new RuntimeFault("not_found", "Skill execution not found");
    const view = this.experience.promote(
      this.store,
      runId,
      execution,
      z.string().min(1).max(80).parse(name),
      promotionSchema.parse(declaration),
    );
    this.store.event(
      runId,
      "experience.promoted",
      "Explicit evidence-gated model-scoped snapshot promoted",
      view as unknown as Json,
    );
    return view;
  }

  async control(
    id: string,
    command: "start" | "pause" | "resume" | "stop",
  ): Promise<RunView> {
    if (command === "pause" && this.run?.run_id === id &&
      ["running", "reviewing"].includes(this.run.status)) {
      this.run.status = "pausing";
      this.fenceAuthority("Operator paused the run; effect admission revoked immediately");
      this.persist("Pause admission revoked before waiting for drain");
    }
    if (command === "stop") {
      if (!this.run || this.run.run_id !== id)
        throw new RuntimeFault("not_found", "Run not found");
      if (!TERMINAL[this.run.status])
        this.fenceStop(
          "Operator stopped the run; effect admission revoked immediately",
        );
    }
    return await this.serialize(async () => {
      if (!this.run || this.run.run_id !== id)
        throw new RuntimeFault("not_found", "Run not found");
      if (this.closed && command !== "stop")
        throw new RuntimeFault("unavailable", "The runtime is closed");
      if (command === "stop") {
        if (!TERMINAL[this.run.status])
          await this.halt("stopped", "Operator stopped the run");
      } else if (command === "pause") {
        if (
          this.run.status === "running" ||
          this.run.status === "reviewing" ||
          this.run.status === "pausing"
        )
          await this.halt("paused", "Operator paused the run");
        else if (this.run.status !== "paused")
          throw new RuntimeFault(
            "conflict",
            "Only a running run can be paused",
          );
      } else if (command === "start") {
        if (this.run.status !== "created")
          throw new RuntimeFault(
            "conflict",
            "Only a created run can be started",
          );
        await this.begin(false);
      } else {
        if (this.run.status !== "paused")
          throw new RuntimeFault(
            "conflict",
            "Only a paused run can be resumed",
          );
        await this.begin(true);
      }
      return this.snapshot()!;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private persist(summary?: string): void {
    if (!this.run) return;
    this.store.saveRun(this.run, summary);
    this.onChange();
  }

  private assertCurrent(generation: number, epoch?: number): StoredRun {
    const run = this.run;
    if (
      !run ||
      generation !== this.generation ||
      (run.status !== "running" && run.status !== "reviewing")
    )
      throw new RuntimeFault(
        "stale_context",
        "This strategic request no longer has run authority",
      );
    if (epoch !== undefined && epoch !== run.epoch)
      throw new RuntimeFault("stale_epoch", "Use the current run epoch");
    const state = this.game.snapshot();
    if (
      state.status !== "connected" ||
      state.epoch !== run.epoch ||
      state.world_id !== run.world_id ||
      state.session_id !== run.session_id ||
      this.lifeRecovery !== null ||
      this.uncertaintyRecovery !== null
    )
      throw new RuntimeFault(
        "stale_epoch",
        "The game connection changed; pause and reconnect before continuing",
      );
    return run;
  }

  private async refreshObservation(): Promise<Observation> {
    if (this.observationRequest) return await this.observationRequest;
    const generation = this.generation;
    const run = this.run;
    if (!run) throw new RuntimeFault("not_found", "No run exists");
    const request = (async () => {
      const observation = await this.game.observe();
      if (
        generation !== this.generation ||
        observation.world_id !== run.world_id ||
        observation.epoch !== run.epoch ||
        observation.session_id !== run.session_id
      )
        throw new RuntimeFault(
          "stale_epoch",
          "The observation belongs to obsolete run authority",
        );
      if (
        !this.observation ||
        observation.observation_seq >= this.observation.observation_seq
      )
        this.observation = observation;
      const counts = inventoryCounts(this.observation);
      const inventoryKey = JSON.stringify(counts);
      if (inventoryKey !== this.inventoryEvidence) {
        this.inventoryEvidence = inventoryKey;
        this.store.event(
          run.run_id,
          "observation.inventory",
          "Trusted authorized inventory counts changed",
          {
            world_id: run.world_id,
            epoch: run.epoch,
            observation_seq: this.observation.observation_seq,
            counts,
          },
        );
      }
      const accepted = this.observation;
      if (observation.life.status === "dead") this.handleDeath();
      this.verifyGoal(accepted);
      return accepted;
    })();
    this.observationRequest = request;
    try {
      return await request;
    } finally {
      if (this.observationRequest === request) this.observationRequest = null;
    }
  }

  private verifyGoal(observation: Observation): void {
    const run = this.run;
    if (
      !run ||
      run.status !== "running" ||
      observation.world_id !== run.world_id ||
      observation.epoch !== run.epoch ||
      run.goal === "custom" ||
      run.goal === "break_log" ||
      observation.life.status !== "alive"
    )
      return;
    const current = inventoryCounts(observation);
    let item: string | undefined;
    if (run.goal === "collect_wood")
      item = Object.keys(current).find(
        (name) =>
          /_(log|wood|stem|hyphae)$/.test(name) &&
          current[name]! > (run.baseline[name] ?? 0),
      );
    else {
      const required =
        run.goal === "craft_crafting_table"
          ? "crafting_table"
          : "stone_pickaxe";
      if (this.completedCrafts.has(required) && (current[required] ?? 0) > 0)
        item = required;
    }
    if (!item) return;
    this.store.event(
      run.run_id,
      "goal.verified",
      "Trusted goal verifier confirmed the goal inventory condition and required execution evidence",
      {
        goal: run.goal,
        kind: "inventory_gain",
        item,
        baseline_count: run.baseline[item] ?? 0,
        current_count: current[item]!,
        observation_seq: observation.observation_seq,
        craft_succeeded: this.completedCrafts.has(item),
      },
    );
    this.requestTerminal(
      "completed",
      "Goal completed with verified game evidence",
    );
  }
  async createRun(input: {
    task: string;
    goal: GoalId;
    model_id: string;
    experience_id?: string;
    working_programs?: "continue" | "fresh";
  }): Promise<RunView> {
    return await this.serialize(async () => {
      if (this.closed)
        throw new RuntimeFault("unavailable", "The runtime is closed");
      if (this.run && !TERMINAL[this.run.status])
        throw new RuntimeFault(
          "conflict",
          "Stop the current run before creating another",
        );
      const parsed = z
        .object({
          task: z.string().trim().min(1).max(4000),
          goal: goalSchema,
          model_id: z.string().min(1).max(200),
          experience_id: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          working_programs: z.enum(["continue", "fresh"]).default("continue"),
        })
        .strict()
        .parse(input);
      const state = this.game.snapshot();
      if (state.status !== "connected" || !state.world_id || !state.session_id || !state.life)
        throw new RuntimeFault(
          "backend_unavailable",
          "Connect the game before creating a run",
        );
      if (
        this.compatibility &&
        state.version !== this.compatibility.game_version
      )
        throw new RuntimeFault(
          "precondition_failed",
          "Native game version does not match program compatibility",
        );
      if (
        !this.auth
          .snapshot()
          .models.some((model) => model.id === parsed.model_id)
      )
        throw new RuntimeFault(
          "invalid_request",
          "Choose a model from the current authenticated model list",
        );
      if (
        parsed.experience_id &&
        !this.experience
          ?.list(parsed.model_id, state.world_id)
          .some((view) => view.experience_id === parsed.experience_id)
      )
        throw new RuntimeFault(
          "invalid_request",
          "Choose a compatible available experience snapshot",
        );
      this.generation++;
      this.actions.reset();
      this.strategic.reset();
      this.run = {
        run_id: randomUUID(),
        world_id: state.world_id,
        epoch: state.epoch,
        session_id: state.session_id,
        life_id: state.life.life_id,
        task: parsed.task,
        goal: parsed.goal,
        model_id: parsed.model_id,
        status: "created",
        started_at: null,
        ended_at: null,
        turns: 0,
        model_status: "idle",
        error: null,
        usage: emptyRunUsage(),
        baseline: {},
      };
      this.observation = null;
      this.observationRequest = null;
      this.inventoryEvidence = "";
      this.completedCrafts.clear();
      this.deathIds.clear();
      this.needsReconnect = false;
      this.store.saveRun(this.run, "Run created; no game effects admitted");
      if (this.compatibility)
        this.store.event(
          this.run.run_id,
          "run.adapter",
          "Trusted current native adapter compatibility descriptor recorded",
          this.compatibility as unknown as Json,
        );
      this.reactions.initialize(this.run.run_id);
      if (parsed.experience_id) {
        const generation = this.generation;
        try {
          const root = await this.experience!.hydrate(
            parsed.experience_id,
            parsed.model_id,
            this.run.world_id,
            this.run.run_id,
            this.skills,
            () => {
              if (
                generation !== this.generation ||
                this.run?.status !== "created"
              )
                throw new RuntimeFault(
                  "stale_context",
                  "Startup selection authority revoked",
                );
            },
          );
          this.store.event(
            this.run.run_id,
            "experience.hydrated",
            "Compatible exact snapshot freshly validated; no execution state replayed",
            {
              experience_id: parsed.experience_id,
              skill_id: root.skill_id,
              version: root.version,
            },
          );
        } catch {
          if (generation === this.generation) {
            this.run.status = "failed";
            this.run.ended_at = new Date().toISOString();
            this.run.error =
              "Selected experience failed fresh validation; no execution was started";
            this.persist(this.run.error);
          }
          throw new RuntimeFault(
            "precondition_failed",
            "Selected experience could not be freshly validated",
          );
        }
      } else if (parsed.working_programs !== "fresh") {
        const generation = this.generation;
        await this.store.hydrateWorkingPrograms(parsed.model_id, state.session_id, this.run.run_id, this.skills, () => {
          if (generation !== this.generation || this.run?.status !== "created")
            throw new RuntimeFault("stale_context", "Working-program selection authority revoked");
        });
      }
      this.onChange();
      return this.snapshot()!;
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.run && !TERMINAL[this.run.status])
      this.fenceStop(
        "Application closing; effect admission revoked immediately",
      );
    await this.serialize(async () => {
      if (this.run && !TERMINAL[this.run.status])
        await this.halt("stopped", "Application closed; work is not replayed");
      this.unsubscribeGame?.();
      this.unsubscribeGame = null;
      this.experience?.close();
    });
  }
  private async begin(resuming: boolean): Promise<void> {
    const run = this.run!,
      state = this.game.snapshot();
    if (state.status !== "connected" || state.world_id !== run.world_id)
      throw new RuntimeFault(
        "backend_unavailable",
        "Connect the same game world before starting or resuming",
      );
    if (this.needsReconnect && state.epoch <= run.epoch)
      throw new RuntimeFault(
        "unknown_effect",
        "Reconnect to a fresh epoch before resuming uncertain work",
      );
    if (this.auth.snapshot().status !== "ready")
      throw new RuntimeFault(
        "unauthorized",
        "Complete model authorization before starting",
      );
    if (this.sandbox.snapshot().status !== "ready")
      throw new RuntimeFault(
        "backend_unavailable",
        "Prepare the isolated program runtime before starting",
      );
    const generation = ++this.generation;
    this.actions.fence("Starting a fresh authority generation");
    run.epoch = state.epoch;
    run.session_id = state.session_id;
    run.life_id = state.life?.life_id ?? null;
    this.observation = null;
    this.observationRequest = null;
    this.needsReconnect = false;
    const observation = await this.game.observe();
    if (generation !== this.generation || this.closed) return;
    const current = this.game.snapshot();
    if (
      observation.world_id !== run.world_id ||
      observation.epoch !== run.epoch ||
      observation.session_id !== run.session_id ||
      current.status !== "connected" ||
      current.world_id !== run.world_id ||
      current.epoch !== run.epoch ||
      current.session_id !== run.session_id ||
      current.error !== null ||
      current.life?.life_id !== observation.life.life_id ||
      current.life?.status !== observation.life.status ||
      !["alive", "dead"].includes(observation.life.status)
    )
      throw new RuntimeFault(
        "stale_epoch",
        "Game readiness or player life changed during host preflight",
      );
    this.observation = observation;
    run.life_id = observation.life.life_id;
    if (!resuming) {
      run.baseline = inventoryCounts(observation);
      run.started_at = new Date().toISOString();
    }
    run.status = "running";
    run.model_status = "idle";
    this.persist(
      resuming
        ? "Run resumed with fresh authority and worker state"
        : "Host preflight confirmed readiness and authoritative game state",
    );
    try {
      await this.strategic.start(generation);
      this.assertCurrent(generation);
      if (observation.life.status === "alive") await this.reactions.resume(generation);
      this.assertCurrent(generation);
      if (resuming) {
        run.error = null;
        this.persist(
          "Explicit resume prepared successfully; previous causal fault cleared",
        );
      }
      this.strategic.wake(resuming ? "recovery_completed" : "preflight_ready");
    } catch {
      if (generation !== this.generation || this.closed) return;
      const failure =
        "The authenticated agent or isolated worker could not be prepared. Check readiness before resuming.";
      run.error ??= failure;
      await this.halt("paused", failure);
    }
  }
  private async policyContext(): Promise<PolicyContext> {
    return {
      observation: await this.refreshObservation(),
      action: this.actions.active
        ? structuredClone(this.actions.active.entry.stored.view)
        : null,
      task: this.run!.task,
    };
  }
  private async skillAction(
    execution: SkillExecutionView,
    action: GameAction,
    signal: AbortSignal,
    callId: string,
  ): Promise<GameActionResult> {
    if (signal.aborted)
      throw new RuntimeFault("stale_context", "Skill action authority revoked");
    const id = "skill_" + randomUUID(),
      completion = Promise.withResolvers<GameActionResult>();
    let unsubscribe = () => {};
    let settling = false;
    const check = () => {
      const view = this.store.getAction(execution.run_id, id)?.view;
      if (view && ACTION_TERMINAL.has(view.status) && !settling) {
        settling = true;
        unsubscribe();
        if (view.result?.status === "unknown" || view.result?.requires_reconnect)
          this.skills.fence("Leaf outcome is unknown; interrupted execution lineage retained", execution.execution_id);
        if (view.result) completion.resolve(view.result);
        else
          completion.reject(
            new RuntimeFault("unknown_effect", "Skill action has no confirmed result"),
          );
      }
    };
    unsubscribe = this.store.subscribe((event) => {
      if (event.run_id === execution.run_id && event.type.startsWith("action."))
        check();
    });
    try {
      this.actions.admit(
        id,
        action,
        0,
        undefined,
        null,
        execution.execution_id,
      );
      this.trace.record(execution, "capability_request", { kind: "admitted_action", action: action as unknown as Json }, {
        call_id: callId, action_id: id, capability: action.kind === "respawn" ? "respawn" : "action",
        session_id: this.run!.session_id, life_id: this.store.getAction(execution.run_id, id)!.view.life_id,
      });
      check();
      const result = await completion.promise;
      const active = this.actions.active;
      if (active?.entry.stored.view.action_id === id)
        await this.actions.awaitRetirement(active);
      this.trace.record(execution, "capability_result", result as unknown as Json, {
        call_id: callId, action_id: id, capability: action.kind === "respawn" ? "respawn" : "action",
        session_id: this.run!.session_id, life_id: this.store.getAction(execution.run_id, id)!.view.life_id,
      });
      return result;
    } finally {
      unsubscribe();
    }
  }

  private fenceAuthority(message: string, uncertainExecutionId?: string): void {
    this.generation++;
    this.planning.invalidate(message.includes("life") ? "life_changed" : "cancelled");
    this.strategic.fence();
    this.reactions.fence();
    this.skills.fence(message, uncertainExecutionId);
    this.actions.fence(message);
  }
  private handleDeath(): void {
    const run = this.run;
    const state = this.game.snapshot();
    const death = state.life?.death;
    if (!run || run.status !== "running" ||
      !death || state.life?.status !== "dead" ||
      state.session_id !== run.session_id || state.epoch !== run.epoch) return;
    const deathKey = JSON.stringify([state.session_id, state.life.life_id, death.death_id]);
    if (this.deathIds.has(deathKey)) return;
    this.deathIds.add(deathKey);
    this.uncertaintyRecovery = null;
    const priorObservation = this.observation;
    const action = this.actions.active?.entry.stored.view ?? null;
    const actionExecution = action?.execution_id
      ? this.store.skillExecution(run.run_id, { execution_id: action.execution_id })
      : null;
    const latestRoot = actionExecution
      ? this.store.skillExecution(run.run_id, { execution_id: actionExecution.root_execution_id })
      : this.store.latestRootExecution(run.run_id);
    const root = latestRoot?.ended_at === null ? latestRoot : null;
    // Synchronous revocation precedes all asynchronous drain work. Never await
    // this operation from an observation or action capability being drained.
    this.fenceAuthority("Player life ended; old-life effects permanently revoked");
    const generation = this.generation;
    run.life_id = state.life.life_id;
    this.observation = null;
    this.observationRequest = null;
    this.store.recordDeathEpisode(run.run_id, {
      death_id: death.death_id,
      session_id: state.session_id!,
      life_id: state.life.life_id,
      last_observation: priorObservation,
      current_root_execution_id: root?.execution_id ?? null,
      action_id: action?.action_id ?? null,
      event_seqs: [],
    });
    this.persist("Player death recorded; game session and run retained");
    const recovery = this.serialize(async () => {
      const settlements = await Promise.allSettled([
        this.skills.closeAll("Player life ended"),
        this.reactions.lifeChanged(),
        this.actions.close("Player life ended"),
        this.strategic.close(),
        this.game.neutralize(),
      ]);
      if (generation !== this.generation || this.closed || this.run !== run) return;
      if (settlements.some((result) => result.status === "rejected")) {
        this.lifeRecovery = null;
        this.requestSafetyPause("Player-life emitter neutralization could not be confirmed", true);
        return;
      }
      this.lifeRecovery = null;
      try {
        await this.refreshObservation();
        this.assertCurrent(generation);
        await this.strategic.start(generation);
        this.assertCurrent(generation);
        this.strategic.wake("death");
      } catch {
        if (generation === this.generation)
          this.requestSafetyPause("The strategic recovery agent could not be prepared", false);
      }
    });
    this.lifeRecovery = recovery;
    void recovery.finally(() => {
      if (this.lifeRecovery === recovery) this.lifeRecovery = null;
    }).catch(() => {});
  }
  private handleUncertainty(action: ActionView): void {
    const run = this.run, state = this.game.snapshot();
    if (!run || run.status !== "running" || this.lifeRecovery || this.uncertaintyRecovery) return;
    if (state.status !== "connected" || state.error !== null || state.session_id !== run.session_id ||
      state.epoch !== run.epoch || state.life?.status !== "alive" || state.life.life_id !== action.life_id) {
      this.requestSafetyPause("The uncertain action cannot be reconciled against its original player life", false);
      return;
    }
    const execution = action.execution_id
      ? this.store.skillExecution(run.run_id, { execution_id: action.execution_id }) : null;
    const sessionId = state.session_id, lifeId = state.life.life_id;
    this.fenceAuthority("Uncertain past effect; prior work revoked without replay", action.execution_id ?? undefined);
    const generation = this.generation;
    this.observation = null;
    this.observationRequest = null;
    this.store.event(run.run_id, "runtime.uncertainty", "Unknown outcome retained; fencing emitters before fresh reconciliation", {
      action_id: action.action_id, execution_id: action.execution_id,
      root_execution_id: execution?.root_execution_id ?? null,
      session_id: sessionId, life_id: lifeId, status: "unknown",
      summary: action.summary.slice(0, 1000), no_replay: true,
    });
    this.persist("Unknown outcome retained; awaiting neutralization and fresh reconciliation");
    const recovery = this.serialize(async () => {
      const settlements = await Promise.allSettled([
        this.skills.closeAll("Uncertain action outcome"),
        this.reactions.closeAll(true),
        this.actions.close("Uncertain action outcome"),
        this.strategic.close(),
        this.game.neutralize(),
      ]);
      if (generation !== this.generation || this.closed || this.run !== run || run.status !== "running") return;
      let failure = settlements.some((result) => result.status === "rejected")
        ? "Emitter closure or native neutralization could not be confirmed" : null;
      let observation: Observation | null = null;
      if (!failure) {
        try {
          observation = await this.refreshObservation();
        } catch {
          failure = "A fresh authoritative observation could not be obtained";
        }
      }
      if (generation !== this.generation || this.closed || this.run !== run || run.status !== "running") return;
      const current = this.game.snapshot();
      if (!failure && (!observation || observation.session_id !== sessionId ||
        observation.life.life_id !== lifeId || observation.life.status !== "alive" ||
        current.status !== "connected" || current.error !== null || current.session_id !== sessionId ||
        current.epoch !== run.epoch || current.life?.life_id !== lifeId || current.life.status !== "alive"))
        failure = "Fresh reconciliation did not confirm the same healthy session and player life";
      this.uncertaintyRecovery = null;
      if (failure) {
        // Already fenced and drained: do not manufacture proof or destroy a
        // healthy session merely because reconciliation remains unavailable.
        run.status = "paused";
        run.model_status = "idle";
        run.error ??= failure;
        this.store.event(run.run_id, "runtime.uncertainty_blocked", failure, {
          action_id: action.action_id, session_id: sessionId, life_id: lifeId, no_replay: true,
        });
        this.persist("Uncertainty reconciliation remains fail-closed; run paused");
        return;
      }
      this.store.event(run.run_id, "runtime.uncertainty_reconciled", "Emitters closed and fresh same-life state confirmed; strategy may choose new work", {
        action_id: action.action_id, session_id: sessionId, life_id: lifeId,
        observation_seq: observation!.observation_seq, neutralized: true, workers_closed: true, no_replay: true,
      });
      try {
        await this.strategic.start(generation);
        this.assertCurrent(generation);
        await this.reactions.resume(generation);
        this.assertCurrent(generation);
        this.strategic.wake("uncertainty");
      } catch {
        if (generation === this.generation)
          this.requestSafetyPause("The strategic reconciliation agent could not be prepared", false);
      }
    });
    this.uncertaintyRecovery = recovery;
    void recovery.finally(() => {
      if (this.uncertaintyRecovery === recovery) this.uncertaintyRecovery = null;
    }).catch(() => {});
  }
  private fenceStop(message: string): void {
    this.run!.status = "stopping";
    this.fenceAuthority(message);
    this.persist(message);
  }
  private requestSafetyPause(message: string, reconnect: boolean): void {
    if (!this.run || TERMINAL[this.run.status]) return;
    if (reconnect) this.needsReconnect = true;
    this.run.error ??= message;
    if (["paused", "pausing", "stopping"].includes(this.run.status)) {
      this.persist();
      return;
    }
    this.run.status = "pausing";
    this.fenceAuthority(message);
    this.persist("Run admission closed before reconciliation");
    void this.serialize(async () => {
      if (this.run?.status === "pausing") await this.halt("paused", message);
    });
  }
  private requestTerminal(
    status: "completed" | "failed",
    message: string,
  ): void {
    if (!this.run || this.run.status !== "running") return;
    if (status === "completed") {
      this.run.status = "reviewing";
      this.fenceAuthority("Verified goal reached; only bounded effect-free review remains");
      const generation = this.generation;
      this.persist("Goal verified; gameplay closed for bounded candidate review");
      void this.serialize(async () => {
        const results = await Promise.allSettled([
          this.skills.closeAll(message),
          this.reactions.closeAll(true),
          this.actions.close(message),
          this.strategic.close(),
          this.game.neutralize(),
        ]);
        if (generation !== this.generation || this.run?.status !== "reviewing") return;
        if (results.some((result) => result.status === "rejected")) {
          this.requestSafetyPause("Post-goal emitter neutralization could not be confirmed", true);
          return;
        }
        await this.strategic.start(generation);
        this.strategic.wake("goal_review");
      }).catch(() => {
        if (generation === this.generation && this.run?.status === "reviewing")
          this.finishReview();
      });
      return;
    }
    if (status === "failed") this.run.error ??= message;
    this.run.status = "stopping";
    this.fenceAuthority(message);
    const generation = this.generation;
    this.persist(
      "Terminal outcome verified; admission revoked before shutdown",
    );
    void this.serialize(async () => {
      if (generation === this.generation && this.run?.status === "stopping")
        await this.halt(status, message);
    });
  }
  private finishReview(): void {
    if (this.run?.status !== "reviewing") return;
    this.run.status = "stopping";
    this.fenceAuthority("Bounded post-goal review finished");
    void this.serialize(async () => {
      if (this.run?.status === "stopping")
        await this.halt("completed", "Goal completed; candidate review finished without further gameplay");
    });
  }
  private async halt(
    status: "paused" | "stopped" | "completed" | "failed",
    message: string,
  ): Promise<void> {
    const run = this.run!;
    run.status = status === "paused" ? "pausing" : "stopping";
    this.fenceAuthority(message);
    const generation = this.generation;
    this.persist(
      "Run admission revoked; awaiting planner, program, reaction and leaf-effect shutdown",
    );
    // Run scope owns input neutralization, never healthy session teardown.
    // Transport faults retain disconnect ownership as the fail-closed fallback.
    const barrier = this.needsReconnect
      ? this.game.disconnect()
      : this.game.neutralize();
    const settlements = await Promise.allSettled([
      this.skills.closeAll(message),
      this.reactions.closeAll(status === "paused"),
      this.actions.close(message),
      this.strategic.close(),
      barrier,
    ]);
    const cleanupConfirmed = settlements.slice(0, 4).every(
      (result) => result.status === "fulfilled",
    );
    let disconnectConfirmed = settlements[4]!.status === "fulfilled";
    if (!cleanupConfirmed || !disconnectConfirmed) this.needsReconnect = true;
    if (!disconnectConfirmed || this.needsReconnect) {
      try {
        await this.game.disconnect();
        disconnectConfirmed = true;
      } catch {
        disconnectConfirmed = false;
      }
    }
    if (!disconnectConfirmed) this.needsReconnect = true;
    if (generation !== this.generation) return;
    if (!disconnectConfirmed || !cleanupConfirmed) {
      run.error ??= BRIDGE_FAILURE;
      run.model_status = "error";
      this.persist("Shutdown remains unconfirmed; admission stays closed");
      throw new RuntimeFault(
        "unknown_effect",
        "Shutdown could not be confirmed. Retry Stop before reconnecting or starting another run.",
      );
    }
    run.status = status;
    run.model_status = "idle";
    if (status !== "paused") run.ended_at = new Date().toISOString();
    if (status === "failed") run.error ??= message;
    else if (this.needsReconnect) run.error ??= BRIDGE_FAILURE;
    if (run.session_id) this.store.retainWorkingPrograms(run.run_id, run.session_id);
    this.persist(message);
  }
}
