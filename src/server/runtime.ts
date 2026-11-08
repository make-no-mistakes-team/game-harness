import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GameAction,
  ActionView,
  GameActionResult,
  GameBridge,
  GoalChoice,
  AdapterGoal,
  AdapterEvidence,
  RuntimeAdapter,
  VerificationManifest,
  ProgramCompatibility,
  Json,
  ObservationV3,
  PolicyContext,
  RunView,
  RunPauseCause,
} from "../shared/contracts.ts";
import { projectRunOperator } from "./operator-state.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import { goalSchema, verificationResultSchema } from "../shared/validation.ts";
import { taskTextSchema } from "../shared/tasks.ts";
import type { EffectContext, EffectScope } from "../shared/control.ts";
import { sameEffectScope, sameScreen } from "../shared/control.ts";
import { adapterCompatibility, canonicalContractJson } from "./adapter-contract.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import { observationEvidence } from "./adapter-evidence.ts";
import type { AuthManager } from "./auth.ts";
import type { SandboxService } from "./sandbox.ts";
import type { Store, StoredRun } from "./store.ts";
import { SkillManager } from "./skills.ts";
import { emptyRunUsage } from "./usage.ts";
import {
  ExperienceLibrary,
  promotionDeclarationSchema as promotionSchema,
  type PromotionDeclaration,
} from "./experience.ts";
import type { FastJudgeBroker } from "./fast-provider.ts";
import { HistoryReader } from "./history-reader.ts";
import type { HistoryQueryClient, HistoryQueryOptions } from "./history-protocol.ts";
import { ActionArbiter } from "./action-arbiter.ts";
import { ReactiveRuntime } from "./reactive.ts";
import { StrategicPlanner, type StrategicRequestAdmission } from "./strategic.ts";
import { RuntimeTools } from "./runtime-tools.ts";
import { createRuntimePrompt } from "./runtime-prompt.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { SpeculativePlanning } from "./speculative-planning.ts";
import { ImprovementLearning } from "./improvement-learning.ts";
import { HistoryProjectionOwner } from "./history-projection-owner.ts";
import { ExecutionTrace } from "./execution-trace.ts";
import { ActorFrameSelector, type ModelObservation } from "./actor-frames.ts";
import { retainResidentReceipt } from "./resident-evidence.ts";

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
export interface RuntimeOptions {
  actorFrames?: { latestFrame(): Uint8Array | null; subscribeFrames(listener: (frame: Uint8Array) => void): () => void };
  experienceDirectory?: string;
  judge?: FastJudgeBroker;
  adapter?: RuntimeAdapter | (() => RuntimeAdapter | null);
  requestAdmission?: StrategicRequestAdmission;
}

/** Lifecycle and trusted observation/goal authority; execution modules own their scheduling. */
export class Runtime {
  readonly historyQueries: HistoryQueryClient;
  private readonly actorFrames: ActorFrameSelector | null;
  private readonly actorFrameSource: RuntimeOptions["actorFrames"];
  private readonly imageAuthorityWaits = new Set<() => void>();
  private readonly skills: SkillManager;
  private readonly experience: ExperienceLibrary | null;
  private readonly adapterSource: RuntimeOptions["adapter"];
  private readonly registrations = new WeakMap<RuntimeAdapter, RegisteredAdapterContract>();
  private readonly actions: ActionArbiter;
  private readonly reactions: ReactiveRuntime;
  private readonly strategic: StrategicPlanner;
  private readonly catalog: RuntimeTools;
  private readonly planning: SpeculativePlanning;
  private readonly learning: ImprovementLearning;
  private readonly historyOwner: HistoryProjectionOwner;
  private readonly trace: ExecutionTrace;
  private run: StoredRun | null = null;
  private observation: ObservationV3 | null = null;
  private observationRequest: Promise<ObservationV3> | null = null;
  private verificationManifest: VerificationManifest | null = null;
  private verificationSnapshot: AdapterEvidence | null = null;
  private verificationPending: AdapterEvidence[] = [];
  private verificationKey = "";
  private generation = 0;
  private unsubscribeGame: (() => void) | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private needsReconnect = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private historyDrain: Promise<void> = Promise.resolve();
  private deathIds = new Set<string>();
  private lifeRecovery: Promise<void> | null = null;
  private uncertaintyRecovery: Promise<void> | null = null;
  private repeatedNoEffect: {
    root: string; rootSource: string; scope: EffectScope; signature: string;
    count: number; notified: boolean; actionIds: string[];
  } | null = null;

  private context() {
    const adapter = typeof this.adapterSource === "function" ? this.adapterSource() : this.adapterSource ?? this.game.adapter();
    const binding = this.game.snapshot().binding;
    if (!adapter || !binding?.ready) throw new RuntimeFault("precondition_failed", "A negotiated adapter contract is required");
    let registration = this.registrations.get(adapter);
    if (!registration) { registration = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators); this.registrations.set(adapter, registration); }
    if (registration.compatibility.compatibility_hash !== binding.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Runtime adapter and native negotiated descriptor do not match");
    return { adapter, binding, registration };
  }
  private currentCompatibility(): ProgramCompatibility | null {
    return this.game.snapshot().binding?.ready ? this.context().registration.compatibility : null;
  }
  goals(): GoalChoice[] {
    if (!this.game.snapshot().binding?.ready) return [];
    const adapter = this.context().adapter;
    return adapter.goalChoices ? [...adapter.goalChoices] : adapter.goals.map(goal => ({
      id: goal.goal_id, goal, label: goal.goal_id, prompt: goal.goal_id === "custom" ? "Pursue the supplied custom task; completion is model-reported and unverified." : goal.goal_id,
    }));
  }
  private goalChoice(): GoalChoice {
    if (!this.run || typeof this.run.goal === "string") throw new RuntimeFault("precondition_failed", "Historical goals are inspect-only");
    const goal = this.run.goal;
    return this.goals().find(choice => choice.id === goal.goal_id) ??
      { id: goal.goal_id, goal, label: goal.goal_id, prompt: this.run.task };
  }
  private effectContext(): EffectContext {
    const run = this.run, state = this.game.snapshot();
    if (!run || !state.binding?.ready || !state.session_id || !state.life || !state.space)
      throw new RuntimeFault("stale_context", "Current native lifecycle context is unavailable");
    return { run_id: run.run_id, run_generation: this.generation, world_id: run.world_id, epoch: run.epoch,
      session_id: state.session_id, native_boot_id: state.binding.native_boot_id, life_id: state.life.life_id, space_epoch: state.space.space_epoch };
  }
  private recordEffectEvidence(action: GameAction, result: GameActionResult, view: ActionView): void {
    const run = this.run;
    if (!run || run.status !== "running" || !view.scope || view.scope.run_id !== run.run_id || view.compatibility_hash !== run.compatibility_hash) return;
    const adapter = this.context().adapter;
    const events = adapter.effectEvidence?.(view.scope, view.action_id, action, result, view.ended_at ?? new Date().toISOString()) ?? [];
    for (const evidence of events) {
      this.store.event(run.run_id, "adapter.evidence", "Adapter-owned permitted effect evidence", evidence as unknown as Json);
      this.verificationPending.push(evidence);
    }
    this.verifyGoal();
  }

  private noEffectAuthority(view: ActionView): SkillExecutionView | null {
    const run = this.run, scope = view.scope, invocation = view.invocation, state = this.game.snapshot();
    if (!run || run.status !== "running" || this.closed || this.needsReconnect || this.lifeRecovery || this.uncertaintyRecovery ||
      !scope || view.origin !== "skill" || invocation?.kind !== "skill" || view.execution_id !== scope.execution_id ||
      invocation.execution_id !== scope.execution_id || invocation.source_hash !== scope.source_hash ||
      scope.run_id !== run.run_id || scope.run_generation !== this.generation ||
      scope.world_id !== run.world_id || scope.epoch !== run.epoch || scope.session_id !== run.session_id ||
      scope.native_boot_id !== run.native_boot_id || scope.life_id !== run.life_id || scope.space_epoch !== run.space_epoch ||
      view.compatibility_hash !== run.compatibility_hash || state.status !== "connected" || state.error !== null ||
      !state.binding?.ready || state.binding.compatibility_hash !== run.compatibility_hash ||
      state.world_id !== scope.world_id || state.epoch !== scope.epoch || state.session_id !== scope.session_id ||
      state.binding.native_boot_id !== scope.native_boot_id || state.life?.life_id !== scope.life_id ||
      state.life.status !== "alive" || state.space?.space_epoch !== scope.space_epoch) return null;
    // saveAction publishes synchronously before this callback. A subscriber may
    // already have retired/revoked the producer or replaced its latest root.
    const producerScope = this.skills.effectScope(scope.execution_id);
    if (!producerScope || !sameEffectScope(producerScope, scope)) return null;
    const producer = this.store.skillExecution(run.run_id, { execution_id: scope.execution_id });
    const root = this.store.latestRootExecution(run.run_id);
    if (!producer || !root || producer.root_execution_id !== root.execution_id ||
      !["accepted", "running"].includes(producer.status) || producer.ended_at !== null ||
      producer.source_hash !== scope.source_hash || !["accepted", "running"].includes(root.status) ||
      root.ended_at !== null || (root.entry !== "run" && root.entry !== "step")) return null;
    const rootScope = this.skills.effectScope(root.execution_id);
    return rootScope && rootScope.run_generation === this.generation && rootScope.run_id === run.run_id &&
      rootScope.world_id === scope.world_id && rootScope.epoch === scope.epoch &&
      rootScope.source_hash === root.source_hash && rootScope.session_id === scope.session_id &&
      rootScope.life_id === scope.life_id && rootScope.native_boot_id === scope.native_boot_id &&
      rootScope.space_epoch === scope.space_epoch ? root : null;
  }

  private recordRepeatedNoEffect(action: GameAction, result: GameActionResult, view: ActionView): void {
    const evidence = result.evidence;
    if ((result.status !== "succeeded" && result.status !== "failed") || result.requires_reconnect ||
      evidence === null || typeof evidence !== "object" || Array.isArray(evidence) ||
      evidence.world_effect_emitted !== false || evidence.neutralized !== true || evidence.camera_changed !== false) {
      this.repeatedNoEffect = null;
      return;
    }
    const root = this.noEffectAuthority(view);
    if (!root) { this.repeatedNoEffect = null; return; }
    // Only eligible, normalized settled actions pay for canonical comparison.
    const signature = canonicalContractJson(action), scope = view.scope!;
    const rootScope = this.skills.effectScope(root.execution_id)!;
    let slot = this.repeatedNoEffect;
    if (!slot || slot.root !== root.execution_id || slot.rootSource !== root.source_hash ||
      !sameEffectScope(slot.scope, rootScope) || slot.signature !== signature) {
      slot = this.repeatedNoEffect = { root: root.execution_id, rootSource: root.source_hash!, scope: { ...rootScope },
        signature, count: 0, notified: false, actionIds: [] };
    }
    slot.count = Math.min(3, slot.count + 1);
    if (slot.actionIds.length < 3) slot.actionIds.push(view.action_id);
    if (slot.count !== 3 || slot.notified) return;
    slot.notified = true;
    this.store.event(root.run_id, "program.repeated_no_effect",
      "Advisory: three identical actions reported explicit neutral no-world-effect outcomes; stationary observation may be intentional", {
        source: "runtime_mechanical", usefulness_inferred: false,
        reason: "three_identical_explicit_neutral_outcomes", count: slot.count,
        root_execution_id: root.execution_id, root_source_hash: root.source_hash,
        root_skill_id: root.skill_id, root_version: root.version,
        execution_id: scope.execution_id, source_hash: scope.source_hash,
        action_id: view.action_id, action_ids: slot.actionIds,
        status: result.status, world_effect_emitted: false, camera_changed: false, neutralized: true,
        scope: { ...scope },
      });
    // Event publication is another synchronous external-callback boundary.
    // Persisted advice grants no authority if its exact owner was just fenced.
    const current = this.noEffectAuthority(view);
    if (this.repeatedNoEffect === slot && current?.execution_id === root.execution_id &&
      current.source_hash === root.source_hash) this.strategic.wake("program_no_effect");
    else this.repeatedNoEffect = null;
  }

  constructor(
    private readonly store: Store,
    private readonly auth: AuthManager,
    private readonly game: GameBridge,
    private readonly sandbox: SandboxService,
    private readonly onChange: () => void,
    options: RuntimeOptions = {},
  ) {
    this.adapterSource = options.adapter;
    this.actorFrameSource = options.actorFrames;
    this.actorFrames = options.actorFrames ? new ActorFrameSelector({
      latestFrame: () => options.actorFrames!.latestFrame(),
      scope: () => {
        const run = this.run, state = this.game.snapshot();
        if (!run || state.status !== "connected" || state.error || state.world_id !== run.world_id ||
          state.session_id !== run.session_id || state.epoch !== run.epoch || state.life?.life_id !== run.life_id) return null;
        if (!state.binding?.ready || !state.space || state.binding.native_boot_id !== run.native_boot_id ||
          state.binding.compatibility_hash !== run.compatibility_hash) return null;
        return { run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
          epoch: run.epoch, life_id: run.life_id!, generation: this.generation,
          native_boot_id: state.binding.native_boot_id, compatibility_hash: state.binding.compatibility_hash,
          space: state.space, screen: state.screen };
      },
    }) : null;
    this.experience = options.experienceDirectory
      ? new ExperienceLibrary(options.experienceDirectory, () => this.currentCompatibility())
      : null;
    this.historyQueries = new HistoryReader(store.readLocation());
    this.learning = new ImprovementLearning(store, this.historyQueries);
    this.historyOwner = new HistoryProjectionOwner(store, this.learning);
    this.trace = new ExecutionTrace(store);
    this.planning = new SpeculativePlanning({
      contract: () => this.context().adapter,
      admissionContext: () => {
        const run = this.run, state = game.snapshot();
        if (!run || run.status !== "running" || state.status !== "connected" || state.error !== null ||
          state.world_id !== run.world_id || state.epoch !== run.epoch || state.session_id !== run.session_id ||
          !state.session_id || !state.life || state.life.life_id !== run.life_id ||
          this.lifeRecovery || this.uncertaintyRecovery || typeof run.goal === "string" || !state.binding?.ready || !state.space) return null;
        return {
          run_id: run.run_id, world_id: run.world_id, generation: this.generation,
          session_id: state.session_id, epoch: state.epoch,
          life_id: state.life.life_id, life_status: state.life.status,
          native_boot_id: state.binding.native_boot_id, space_epoch: state.space.space_epoch,
          compatibility_hash: state.binding.compatibility_hash, screen: state.screen,
          task: run.task, goal: run.goal,
        };
      },
      context: () => {
        const run = this.run, state = game.snapshot();
        if (!run || run.status !== "running" || !state.session_id || !state.life || this.lifeRecovery || this.uncertaintyRecovery ||
          typeof run.goal === "string" || !state.binding?.ready || !state.space) return null;
        const root = store.latestRootExecution(run.run_id);
        if (!root) return null;
        const source = store.skill(run.run_id, root);
        const current = root.entry === "step" ? this.skills.get(run.run_id, { execution_id: root.execution_id }) : root;
        return {
          run_id: run.run_id, world_id: run.world_id, generation: this.generation,
          session_id: state.session_id, epoch: state.epoch,
          life_id: state.life.life_id, life_status: state.life.status,
          native_boot_id: state.binding.native_boot_id, space_epoch: state.space.space_epoch,
          compatibility_hash: state.binding.compatibility_hash, screen: state.screen,
          task: run.task, goal: run.goal,
          root: { execution_id: root.execution_id, skill_id: root.skill_id, version: root.version, hash: source.hash, status: root.status,
            intent_version: current?.entry === "step" ? current.resident?.intent_version ?? 0 : null },
        };
      },
      skill: (ref) => {
        try { return this.run ? store.skill(this.run.run_id, ref) : null; }
        catch { return null; }
      },
      observe: () => this.refreshObservation(),
      evaluateGuard: (source, observation, args, signal) =>
        sandbox.evaluateGameGuard(source, observation, args, signal, this.context().adapter),
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
    this.actions = ActionArbiter.attach(store, game, {
      run: () => this.run,
      generation: () => this.generation,
      needsReconnect: () => this.needsReconnect,
      adapter: () => this.context().adapter,
      invocation: (id) => this.skills.invocation(id),
      effectScope: (id) => this.skills.effectScope(id),
      changed: onChange,
      wake: (reason) => this.strategic.wake(reason),
      pause: (message, reconnect) =>
        this.requestSafetyPause(message, reconnect),
      uncertain: (action) => this.handleUncertainty(action),
      observe: () => this.refreshObservation(),
      admitted: () => this.strategic.admitted(),
      effect: (policy, kind, evidence) =>
        this.reactions.recordEffect(policy, kind, evidence),
      settled: (action, result, view) => {
        this.recordEffectEvidence(action, result, view);
        this.recordRepeatedNoEffect(action, result, view);
      },
    });
    this.skills = new SkillManager(store, sandbox, {
      openController: (execution, generation, deadline, applied, effect, lifecycle) =>
        this.actions.reserveController(execution.execution_id, generation, deadline, applied, effect, lifecycle),
      programEvent: (_execution, event) => {
        if (event.kind === "attention") this.strategic.wake("resident_attention");
      },
      residentEffect: (execution, input, event, adapter) => {
        // Retirement may arrive after run/life authority was fenced. Retain the
        // original owner's real prefix and unknown suffix without a new grant.
        const facts = retainResidentReceipt(store, adapter, execution, input, event);
        const run = this.run;
        if (run?.run_id === execution.run_id && run.status === "running" &&
          this.generation === execution.run_generation && run.compatibility_hash === execution.compatibility_hash) {
          this.verificationPending.push(...facts);
          this.verifyGoal();
        }
      },
      prepareLookahead: (config) => this.planning.prepareOptIn(config),
      adapter: () => this.context().adapter,
      binding: () => this.game.snapshot().binding,
      authorize: (scope) => {
        if (this.run?.run_id !== scope.run_id || this.run.status !== "running")
          throw new RuntimeFault(
            "stale_context",
            "Skill effect authority is closed",
          );
        this.assertCurrent(scope.run_generation, scope.epoch);
        const state = this.game.snapshot();
        if (this.lifeRecovery || this.uncertaintyRecovery || state.session_id !== scope.session_id || state.life?.life_id !== scope.life_id ||
          state.binding?.native_boot_id !== scope.native_boot_id || state.space?.space_epoch !== scope.space_epoch ||
          !["alive", "dead"].includes(state.life.status))
          throw new RuntimeFault("stale_context", "Skill player-life authority is closed");
      },
      observe: () => this.refreshObservation(),
      action: (execution, action, signal, callId) =>
        this.skillAction(execution, action, signal, callId),
      queryCapability: async (id, version, args) => {
        if (!game.queryCapability) throw new RuntimeFault("precondition_failed", "This adapter has no registered read capability");
        return await game.queryCapability(id, version, args);
      },
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
        this.run!.space_epoch = observation.space.space_epoch;
        this.store.event(execution.run_id, "skill.life_adopted", "Only the explicitly chosen recovery root adopted a confirmed new life", {
          execution_id: execution.execution_id,
          root_execution_id: execution.root_execution_id,
          session_id: execution.session_id,
          previous_life_id: respawn.life_id,
          life_id: observation.life.life_id,
          native_boot_id: observation.native_boot_id,
          space_epoch: observation.space.space_epoch,
          respawn_action_id: respawn.action_id,
          observation_seq: observation.observation_seq,
        });
        this.persist("Explicit recovery established a new player life in the same run");
        await this.reactions.resume(generation);
        const currentScope = this.skills.effectScope(execution.execution_id);
        if (!currentScope) throw new RuntimeFault("stale_context", "Recovery invocation is no longer active");
        return { ...currentScope, life_id: observation.life.life_id, space_epoch: observation.space.space_epoch };
      },
      cancelActions: (ids, reason) => this.actions.cancelOwned(ids, reason),
      changed: (outcome, execution) => {
        this.onChange();
        if (outcome) {
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
        adapter: () => this.context().adapter,
        binding: () => this.game.snapshot().binding,
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
            await game.emergencyStop("Trusted policy selection barrier");
          } catch (error) {
            this.requestSafetyPause("Native input neutralization could not be confirmed", true);
            throw error;
          }
        },
      },
      options.judge,
    );
    this.strategic = new StrategicPlanner(store, auth, {
      requestAdmission: options.requestAdmission,
      run: () => this.run,
      generation: () => this.generation,
      assertCurrent: (generation, epoch) =>
        this.assertCurrent(generation, epoch),
      tools: (generation) => this.catalog.build(generation),
      rootPrompt: () =>
        createRuntimePrompt(
          this.run!,
          this.goalChoice(),
        ),
      observe: () => this.refreshObservation(),
      modelObservation: () => this.modelObservation(),
      projectObservation: (observation, previous) => this.context().adapter.projectObservation(observation, previous),
      adapter: () => this.context().adapter,
      policies: () => this.reactions.list,
      action: () => this.actions.active?.entry.stored.view ?? this.actions.view,
      programPending: () => this.skills.pending,
      busy: () => this.actions.busy || this.skills.pending,
      persist: (summary) => this.persist(summary),
      pause: (message, cause) => this.requestSafetyPause(message, false, cause),
      terminal: (status, message) => this.requestTerminal(status, message),
      speculation: () => this.planning,
      reviewComplete: () => this.finishReview(),
      reviewContext: async (options) => {
        const run = this.run!, generation = this.generation;
        const assertReview = () => {
          if (options.signal?.aborted || performance.now() >= options.deadlineHostMs ||
            this.run !== run || run.status !== "reviewing")
            throw new RuntimeFault("stale_context", "History review authority expired");
          this.assertCurrent(generation);
        };
        assertReview();
        await this.learning.prepareFeedback(run.run_id, options);
        assertReview();
        const context = await this.historyQueries.query({
          kind: "review_context", run_id: run.run_id,
          after: { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null }, limit: 12,
        }, options);
        assertReview();
        return context;
      },
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
        modelObservation: () => this.modelObservation(),
        adapter: () => this.context().adapter,
        generation: () => this.generation,
        attentionAfter: (ms, reason) =>
          this.strategic.attentionAfter(ms, reason),
        admitted: () => this.strategic.admitted(),
        history: () => this.historyQueries,
        planning: () => this.planning,
        learning: () => this.learning,
        toolRole: () => this.strategic.toolRole(),
        toolAuthority: () => this.strategic.speculativeToolAuthority(),
        finishTask: (summary, callId) => this.finishTask(summary, callId),
      },
    );
  }
  async modelObservation(): Promise<ModelObservation> {
    const generation = this.generation;
    const observation = await this.refreshObservation();
    if (!this.actorFrames) return { observation, images: [], image_metadata: { mode: "disabled" } };
    const run = this.assertCurrent(generation, observation.epoch);
    const model = this.auth.snapshot().models.find(model => model.id === run.model_id);
    if (!model?.input_modalities?.includes("image"))
      throw new RuntimeFault("precondition_failed", "Image-enabled actor requires discovered SDK image input capability; this is not a live vision claim");
    const selected = await this.prepareActorFrame(this.actorFrames, generation, observation);
    this.assertCurrent(generation, observation.epoch);
    return { observation, images: selected.images, image_metadata: selected.metadata };
  }
  private async prepareActorFrame(selector: ActorFrameSelector, generation: number, observation: ObservationV3) {
    const source = this.actorFrameSource!;
    const cancelled = Promise.withResolvers<never>();
    let delivered = Promise.withResolvers<void>();
    const assertAuthority = () => {
      const run = this.assertCurrent(generation, observation.epoch);
      const state = this.game.snapshot();
      if (run.life_id !== observation.life.life_id || state.life?.life_id !== observation.life.life_id ||
        state.session_id !== observation.session_id || state.binding?.native_boot_id !== observation.native_boot_id ||
        state.binding.compatibility_hash !== observation.compatibility_hash || state.space?.space_epoch !== observation.space.space_epoch ||
        !sameScreen(state.screen, observation.screen))
        throw new RuntimeFault("stale_context", "Native image preparation life authority changed");
    };
    const recheck = () => { try { assertAuthority(); } catch (error) { cancelled.reject(error); } };
    // One finite local preparation window, not another model request. An old
    // buffer after resume/respawn must wait for a real delivery, never fallback.
    const timer = setTimeout(() => {
      try {
        assertAuthority();
        cancelled.reject(new RuntimeFault("backend_unavailable", "No current-scope native image arrived within the 1500 ms preparation bound"));
      } catch (error) { cancelled.reject(error); }
    }, 1500);
    let unsubscribeFrames = () => {}, unsubscribeState = () => {};
    this.imageAuthorityWaits.add(recheck);
    try {
      unsubscribeFrames = source.subscribeFrames(() => { recheck(); delivered.resolve(); });
      unsubscribeState = this.game.subscribe(recheck);
      for (;;) {
        assertAuthority();
        delivered = Promise.withResolvers<void>();
        const packet = source.latestFrame();
        try {
          const selected = await Promise.race([selector.select(), cancelled.promise]);
          assertAuthority();
          return selected;
        } catch (error) {
          assertAuthority();
          if (!(error instanceof RuntimeFault) || error.code !== "stale_context") throw error;
        }
        if (source.latestFrame() === packet)
          await Promise.race([delivered.promise, cancelled.promise]);
      }
    } finally {
      clearTimeout(timer);
      unsubscribeFrames(); unsubscribeState();
      this.imageAuthorityWaits.delete(recheck);
    }
  }
  async initialize(): Promise<void> {
    if (this.unsubscribeGame) return;
    const retained = this.store.lastRun();
    // Historical rows are exposed only through read APIs, never restored as a
    // live controller or rewritten by current lifecycle/policy initialization.
    this.run = retained && typeof retained.goal !== "string" && retained.native_boot_id && retained.compatibility_hash ? retained : null;
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
        this.handleScopeChange();
        return;
      }
      if (notice.type === "game_event" && this.run.status === "running") this.handleScopeChange();
      if (notice.type === "observation" && this.run.status === "running") {
        // The bridge already supplied this authorized read. Refetching here
        // echoes every external poll and persists a second full observation.
        try { this.acceptObservation(notice.data, this.generation, this.run); } catch {}
      } else if (
        notice.type === "state" &&
        (this.run.status === "running" || this.run.status === "reviewing")
      ) {
        const state = this.game.snapshot();
        const sameContext =
          state.world_id === this.run.world_id &&
          state.epoch === this.run.epoch &&
          state.session_id === this.run.session_id &&
          state.binding?.native_boot_id === this.run.native_boot_id &&
          state.binding?.compatibility_hash === this.run.compatibility_hash;
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
  currentRunId(): string | null {
    return this.run?.run_id ?? null;
  }
  snapshot(): RunView | null {
    if (!this.run) return null;
    const { baseline: _baseline, control: _control, ...view } = this.run;
    const executions = this.store.skillExecutions(this.run.run_id);
    return structuredClone({
      ...view,
      action: this.actions.view,
      policies: this.reactions.list,
      skills: this.store.skills(this.run.run_id),
      executions,
      operator: projectRunOperator(this.store, this.run, this.actions.view, executions, !!(this.lifeRecovery || this.uncertaintyRecovery)),
    });
  }
  getRun(id: string): RunView | null {
    if (this.run?.run_id === id) return this.snapshot();
    const run = this.store.getRun(id);
    if (!run) return null;
    const { baseline: _baseline, control: _control, ...view } = run;
    const executions = this.store.skillExecutions(id);
    return {
      ...view,
      action: null,
      policies: this.store.policies(id),
      skills: this.store.skills(id),
      executions,
      operator: projectRunOperator(this.store, run, null, executions),
    };
  }

  listExperience(modelId: string) {
    return this.experience?.list(modelId, this.game.snapshot().world_id) ?? [];
  }

  async skillEvidence(runId: string, after = 0, limit = 25, options?: HistoryQueryOptions) {
    if (!this.store.getRun(runId))
      throw new RuntimeFault("not_found", "Run not found");
    return await this.historyQueries.query({ kind: "operator_evidence", run_id: runId, after, limit },
      options ?? { deadlineHostMs: performance.now() + 10_000 });
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
      this.controlState().pause_cause = "operator";
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
      state.binding?.native_boot_id !== run.native_boot_id ||
      state.binding?.compatibility_hash !== run.compatibility_hash ||
      this.lifeRecovery !== null ||
      this.uncertaintyRecovery !== null
    )
      throw new RuntimeFault(
        "stale_epoch",
        "The game connection changed; pause and reconnect before continuing",
      );
    return run;
  }

  private async refreshObservation(): Promise<ObservationV3> {
    if (this.observationRequest) return await this.observationRequest;
    const generation = this.generation;
    const run = this.run;
    if (!run) throw new RuntimeFault("not_found", "No run exists");
    const request = (async () => {
      return this.acceptObservation(await this.game.observe(), generation, run);
    })();
    this.observationRequest = request;
    try {
      return await request;
    } finally {
      if (this.observationRequest === request) this.observationRequest = null;
    }
  }

  private acceptObservation(value: unknown, generation: number, run: StoredRun): ObservationV3 {
    const observation = this.context().registration.parseObservation(value);
    if (
      generation !== this.generation || this.run !== run ||
      observation.world_id !== run.world_id || observation.epoch !== run.epoch ||
      observation.session_id !== run.session_id || observation.native_boot_id !== run.native_boot_id ||
      observation.compatibility_hash !== run.compatibility_hash
    )
      throw new RuntimeFault("stale_epoch", "The observation belongs to obsolete run authority");
    if (this.observation && observation.observation_seq <= this.observation.observation_seq) return this.observation;
    this.observation = observation;
    const evidence = observationEvidence(this.context().adapter, this.effectContext(), observation);
    this.verificationSnapshot = evidence;
    this.store.event(run.run_id, "adapter.evidence", "Fresh adapter-owned permitted observation", evidence as unknown as Json);
    if (observation.life.status === "dead") this.handleDeath();
    this.verifyGoal();
    return observation;
  }

  private verifyGoal(): void {
    const run = this.run;
    if (!run || run.status !== "running" || typeof run.goal === "string" || !run.goal.verifier || !this.verificationManifest) {
      this.verificationPending.length = 0; return;
    }
    const events = this.verificationPending.splice(0), state = this.game.snapshot(), observation = this.observation;
    if (observation && this.verificationSnapshot && state.binding?.native_boot_id === observation.native_boot_id &&
      state.life?.life_id === observation.life.life_id && state.life.status === observation.life.status &&
      state.space?.space_epoch === observation.space.space_epoch && sameScreen(state.screen, observation.screen)) events.push(this.verificationSnapshot);
    const result = verificationResultSchema.parse(this.context().adapter.verifyCompletion(this.verificationManifest, events));
    if (result.adapter_id !== run.goal.adapter_id || result.verifier_id !== run.goal.verifier.id || result.verifier_version !== run.goal.verifier.version)
      throw new RuntimeFault("precondition_failed", "Adapter verdict does not match the registered goal verifier");
    const key = JSON.stringify(result);
    if (key !== this.verificationKey) {
      this.verificationKey = key;
      this.store.event(run.run_id, "goal.verification", "Adapter-owned goal verification result", result as unknown as Json);
    }
    if (result.status === "verified") {
      this.store.event(run.run_id, "goal.verified", "Trusted adapter verifier confirmed the declared goal", result as unknown as Json);
      this.requestTerminal("completed", "Goal completed with adapter-verified evidence");
    } else if (result.status === "failed") {
      this.requestTerminal("failed", "Adapter verifier confirmed the declared goal failed");
    }
  }
  async createRun(input: {
    task: string;
    goal: AdapterGoal;
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
          task: taskTextSchema,
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
      if (state.status !== "connected" || !state.world_id || !state.session_id || !state.life || !state.binding?.ready || !state.space)
        throw new RuntimeFault(
          "backend_unavailable",
          "Connect the game before creating a run",
        );
      const context = this.context();
      const declared = context.adapter.goals.find(goal => goal.goal_id === parsed.goal.goal_id);
      const custom = parsed.goal.goal_id === "custom" && parsed.goal.verifier === null && parsed.goal.adapter_id === context.adapter.descriptor.adapter.id;
      if (!custom && (!declared || canonicalContractJson(declared) !== canonicalContractJson(parsed.goal)))
        throw new RuntimeFault("precondition_failed", "Select an actual registered adapter goal/verifier version");
      if (
        !this.auth
          .snapshot()
          .models.some((model) => model.id === parsed.model_id)
      )
        throw new RuntimeFault(
          "invalid_request",
          "Choose a model from the current authenticated model list",
        );
      if (this.actorFrames && !this.auth.snapshot().models.find(model => model.id === parsed.model_id)?.input_modalities?.includes("image"))
        throw new RuntimeFault("precondition_failed", "This actor requires discovered SDK image input capability; choose a currently discovered image-capable model");
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
      for (const recheck of this.imageAuthorityWaits) recheck();
      this.actions.reset();
      this.strategic.reset();
      this.run = {
        run_id: randomUUID(),
        world_id: state.world_id,
        epoch: state.epoch,
        session_id: state.session_id,
        life_id: state.life.life_id,
        native_boot_id: state.binding.native_boot_id,
        space_epoch: state.space.space_epoch,
        compatibility_hash: state.binding.compatibility_hash,
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
      this.verificationManifest = null; this.verificationSnapshot = null;
      this.verificationPending.length = 0; this.verificationKey = "";
      this.deathIds.clear();
      this.needsReconnect = false;
      this.store.saveRun(this.run, "Run created; no game effects admitted");
      this.store.event(
          this.run.run_id,
          "run.adapter",
          "Trusted current native adapter compatibility descriptor recorded",
          context.registration.compatibility as unknown as Json,
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
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.run && !TERMINAL[this.run.status])
      this.fenceStop(
        "Application closing; effect admission revoked immediately",
      );
    const historyClosing = this.historyOwner.close();
    void historyClosing.catch(() => {});
    this.closing = this.serialize(async () => {
      try {
        if (this.run && !TERMINAL[this.run.status])
          await this.halt("stopped", "Application closed; work is not replayed");
      } finally {
        try {
          const history = await Promise.allSettled([historyClosing, this.historyDrain]);
          const failed = history.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Readonly history owners did not drain");
        } finally {
          this.unsubscribeGame?.();
          this.unsubscribeGame = null;
          this.experience?.close();
        }
      }
    });
    return this.closing;
  }
  private async begin(resuming: boolean): Promise<void> {
    const run = this.run!,
      state = this.game.snapshot();
    if (typeof run.goal === "string" || !run.native_boot_id || !run.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Historical runs remain inspect-only; create a new run under the negotiated contract");
    if (!state.binding?.ready || state.binding.native_boot_id !== run.native_boot_id ||
      state.binding.compatibility_hash !== run.compatibility_hash || state.session_id !== run.session_id)
      throw new RuntimeFault("precondition_failed", "A replaced native session/profile requires a new run; retained evidence is unchanged");
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
    const observation = this.context().registration.parseObservation(await this.game.observe());
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
    run.space_epoch = observation.space.space_epoch;
    if (!resuming || !this.verificationManifest) {
      run.baseline = this.context().adapter.captureBaseline(run.goal, observation);
      this.verificationManifest = { goal: run.goal, run_id: run.run_id, world_id: run.world_id, session_id: run.session_id!,
        epoch: run.epoch, native_boot_id: run.native_boot_id, baseline: run.baseline };
      run.started_at = new Date().toISOString();
    }
    run.status = "running";
    this.verificationSnapshot = observationEvidence(this.context().adapter, this.effectContext(), observation);
    this.store.event(run.run_id, "adapter.evidence", "Run-start permitted adapter observation", this.verificationSnapshot as unknown as Json);
    run.model_status = "idle";
    this.persist(
      resuming
        ? "Run resumed with fresh authority and worker state"
        : "Host preflight confirmed readiness and authoritative game state",
    );
    try {
      if (resuming) {
        await this.historyDrain;
        this.assertCurrent(generation);
        // Direct uncertainty pauses do not pass through halt's metadata
        // reopening. Admit only new history work after fresh safe preflight.
        this.historyOwner.resumeRun(run.run_id);
      }
      await this.strategic.start(generation);
      this.assertCurrent(generation);
      if (observation.life.status === "alive") await this.reactions.resume(generation);
      this.assertCurrent(generation);
      if (resuming) {
        run.error = null;
        this.controlState().pause_cause = null;
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
      this.controlState().pause_cause ??= "preparation_failed";
      await this.halt("paused", failure);
    }
  }
  private async policyContext(): Promise<PolicyContext> {
    const run = this.run!;
    const observation = await this.refreshObservation();
    const execution = this.store.latestRootExecution(run.run_id);
    const program = execution && !execution.ended_at && (execution.entry === "run" || execution.entry === "step")
      ? { name: this.store.skill(run.run_id, execution).name, version: execution.version,
        entry: execution.entry, status: execution.status }
      : null;
    return {
      observation,
      action: this.actions.active
        ? structuredClone(this.actions.active.entry.stored.view)
        : null,
      program,
      task: run.task,
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
    this.repeatedNoEffect = null;
    this.generation++;
    for (const recheck of this.imageAuthorityWaits) recheck();
    this.planning.invalidate(message.includes("life") ? "life_changed" : "cancelled");
    this.strategic.fence();
    this.reactions.fence();
    this.skills.fence(message, uncertainExecutionId);
    this.actions.fence(message);
    // Native/effect authority is revoked first. Then synchronously close all
    // old-turn history admissions, including independent FIFO waiters.
    if (this.run) {
      const drains = [this.historyDrain.catch(() => {}), this.historyOwner.suspendRun(this.run.run_id)];
      this.historyDrain = Promise.allSettled(drains).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "History owner drain is unconfirmed");
      });
      void this.historyDrain.catch(() => {});
    }
  }
  private handleScopeChange(): void {
    const run = this.run, state = this.game.snapshot();
    if (!run || run.status !== "running" || this.lifeRecovery || this.uncertaintyRecovery) return;
    if (!state.binding?.ready || state.binding.native_boot_id !== run.native_boot_id || state.binding.compatibility_hash !== run.compatibility_hash) {
      this.requestSafetyPause("The negotiated native boot/profile changed; old authority is closed", true); return;
    }
    if (state.space?.space_epoch === run.space_epoch && state.life?.life_id === run.life_id) return;
    const action = this.actions.active?.entry.stored.view;
    if (action?.kind === "respawn" && action.origin === "skill" && action.execution_id && this.skills.effectScope(action.execution_id)) return;
    this.fenceAuthority("Authoritative life/space scope changed; old work cannot act");
    const generation = this.generation;
    run.space_epoch = state.space?.space_epoch ?? null;
    run.life_id = state.life?.life_id ?? null;
    this.observation = null; this.observationRequest = null; this.verificationSnapshot = null;
    this.store.event(run.run_id, "runtime.scope_changed", "Native scope changed without relabeling the previous life or effects", {
      native_boot_id: state.binding.native_boot_id, life_id: run.life_id, space_epoch: run.space_epoch, no_replay: true,
    });
    this.persist("Old-scope emitters fenced before fresh observation");
    const recovery = this.serialize(async () => {
      const results = await Promise.allSettled([this.skills.closeAll("Native scope changed"), this.reactions.closeAll(true),
        this.actions.close("Native scope changed"), this.strategic.close(), this.game.emergencyStop("Trusted scope recovery barrier"),
        this.historyDrain]);
      if (generation !== this.generation || this.run !== run || this.closed) return;
      this.lifeRecovery = null;
      if (results.some(result => result.status === "rejected")) { this.requestSafetyPause("Native scope recovery drain is unconfirmed", true); return; }
      try {
        const observation = await this.refreshObservation();
        run.life_id = observation.life.life_id; run.space_epoch = observation.space.space_epoch;
        this.persist("Fresh authorized native scope established; old execution was not resumed");
        this.assertCurrent(generation);
        this.historyOwner.resumeRun(run.run_id);
        await this.strategic.start(generation);
        if (observation.life.status === "alive") await this.reactions.resume(generation);
        this.strategic.wake("scope_changed");
      } catch {
        if (generation === this.generation) this.requestSafetyPause("Fresh native scope is unavailable; run remains fenced", false);
      }
    });
    this.lifeRecovery = recovery;
    void recovery.finally(() => { if (this.lifeRecovery === recovery) this.lifeRecovery = null; }).catch(() => {});
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
    run.space_epoch = state.space?.space_epoch ?? null;
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
        this.game.emergencyStop("Trusted death recovery barrier"),
        this.historyDrain,
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
        this.historyOwner.resumeRun(run.run_id);
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
        this.game.emergencyStop("Trusted uncertainty reconciliation barrier"),
        this.historyDrain,
      ]);
      if (generation !== this.generation || this.closed || this.run !== run || run.status !== "running") return;
      // A failed old-authority drain is not repaired by a fresh observation.
      // Preserve the existing fresh-epoch requirement for explicit Resume.
      if (settlements.slice(0, 5).some((result) => result.status === "rejected"))
        this.needsReconnect = true;
      let failure = settlements.some((result) => result.status === "rejected")
        ? "Emitter closure or native neutralization could not be confirmed" : null;
      let observation: ObservationV3 | null = null;
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
        // Already fenced; retain unconfirmed drains above without manufacturing
        // proof or destroying a healthy session for an unavailable observation.
        run.status = "paused";
        this.controlState().pause_cause = "safety";
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
        this.historyOwner.resumeRun(run.run_id);
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
  private finishTask(summary: string, callId: string): void {
    const run = this.run;
    if (!run || typeof run.goal === "string" || run.goal.goal_id !== "custom" || run.goal.verifier !== null || run.status !== "running")
      throw new RuntimeFault("forbidden", "Only a running custom task permits model-reported completion");
    this.store.event(run.run_id, "task.completion_reported", "Model reported custom task completion; not independently verified", {
      source: "model", reported_outcome: "completed", verification: "unverified",
      summary, tool_call_id: callId, goal: run.goal, task: run.task,
    });
    const message = "Custom task completion reported by model; unverified run stopped";
    this.fenceStop(message);
    const generation = this.generation;
    // Never await the strategic prompt that is currently executing this tool.
    void this.serialize(async () => {
      if (this.run === run && generation === this.generation && run.status === "stopping")
        await this.halt("stopped", message);
    });
  }
  private controlState() {
    return this.run!.control ??= { pause_cause: null, cleanup_error: null };
  }
  private requestSafetyPause(message: string, reconnect: boolean, cause: RunPauseCause = "safety"): void {
    if (!this.run || TERMINAL[this.run.status]) return;
    if (reconnect) this.needsReconnect = true;
    this.run.error ??= message;
    this.controlState().pause_cause ??= cause;
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
          this.game.emergencyStop("Trusted post-goal effect-free barrier"),
          this.historyDrain,
        ]);
        if (generation !== this.generation || this.run?.status !== "reviewing") return;
        if (results.some((result) => result.status === "rejected")) {
          this.requestSafetyPause("Post-goal emitter neutralization could not be confirmed", true);
          return;
        }
        this.historyOwner.resumeRun(this.run.run_id);
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
    this.controlState().cleanup_error = null;
    this.fenceAuthority(message);
    const generation = this.generation;
    this.persist(
      "Run admission revoked; awaiting planner, program, reaction and leaf-effect shutdown",
    );
    // Run scope owns input neutralization, never healthy session teardown.
    // Transport faults retain disconnect ownership as the fail-closed fallback.
    const barrier = this.needsReconnect
      ? this.game.disconnect()
      : this.game.emergencyStop(message);
    const settlements = await Promise.allSettled([
      this.skills.closeAll(message),
      this.reactions.closeAll(status === "paused"),
      this.actions.close(message),
      this.strategic.close(),
      barrier,
      this.historyDrain,
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
    const historyConfirmed = settlements.slice(5).every((result) => result.status === "fulfilled");
    if (!historyConfirmed) {
      this.store.event(run.run_id, "runtime.history_shutdown_failed", "Readonly history owner drain could not be confirmed", {
        native_neutralization_confirmed: disconnectConfirmed,
      });
    }
    if (!disconnectConfirmed || !cleanupConfirmed) {
      this.controlState().cleanup_error = "Shutdown could not be confirmed. Retry Stop before reconnecting or starting another run.";
      run.error ??= BRIDGE_FAILURE;
      run.model_status = "error";
      this.persist("Shutdown remains unconfirmed; admission stays closed");
      throw new RuntimeFault(
        "unknown_effect",
        "Shutdown could not be confirmed. Retry Stop before reconnecting or starting another run.",
      );
    }
    if (!historyConfirmed) {
      this.controlState().cleanup_error = "Readonly history shutdown could not be confirmed. Retry Stop before starting another run.";
      this.persist("History owner drain remains unconfirmed; admission stays closed");
      throw new RuntimeFault("backend_unavailable", this.controlState().cleanup_error!);
    }
    run.status = status;
    run.model_status = "idle";
    if (status !== "paused") run.ended_at = new Date().toISOString();
    if (status === "failed") run.error ??= message;
    else if (this.needsReconnect) run.error ??= BRIDGE_FAILURE;
    if (run.session_id) this.store.retainWorkingPrograms(run.run_id, run.session_id);
    this.persist(message);
    // This is new effect-free metadata ownership after the safe-stop barrier,
    // never continuation of a cancelled turn or authority to emit game work.
    if (!this.closed) this.historyOwner.resumeRun(run.run_id);
  }
}
