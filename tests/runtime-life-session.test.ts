import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AuthState, BridgeNotice, GameAction, GameActionResult, GameBridge, GameState, GoalId, Observation, PlayerLife, Json } from "../src/shared/contracts.ts";
import { DEFAULT_SKILL_LIMITS, type SkillRef } from "../src/shared/programs.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store } from "../src/server/store.ts";
import { validateSkill } from "../src/server/program-validation.ts";
import type { ImprovementOpportunity, ProgramVersionEvidence } from "../src/shared/execution-evidence.ts";
import type { LookaheadConfig, PlanProjection } from "../src/shared/planning.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const card = { purpose: "Exercise trusted lifecycle boundaries", applicability: "Deterministic neutral fixture", method: "Observe and await bounded host capabilities", reason: "Measure ownership transitions", limitations: "No gameplay effectiveness claim" };
const ok: GameActionResult = { status: "succeeded", summary: "Confirmed neutral fixture effect", evidence: { effect_confirmed: true } };

async function fixture(goal: GoalId = "collect_wood", initialAction: GameAction = { kind: "look", yaw: 0, pitch: 0 }, childCalls = 0, startLookahead?: LookaheadConfig, repairPrecondition = false) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-life-session-"));
  const store = new Store(directory), world = crypto.randomUUID(), session = crypto.randomUUID();
  let life: PlayerLife = { life_id: 1, status: "alive", can_respawn: false, death: null };
  let sequence = 0, inventory = [{ name: "oak_log", display_name: "Oak Log", slot: 0, count: 3 }];
  const observe = (advance = true): Observation => ({ schema_version: 2, world_id: world, epoch: 1, session_id: session, life: structuredClone(life), observation_seq: advance ? ++sequence : sequence, captured_at: new Date().toISOString(), profile_id: "player-observable-structured", preset_id: "minecraft-observable-initial-r2", player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: life.status === "alive" ? 20 : 0, food: 20, on_ground: true, in_water: false, inventory: structuredClone(inventory) }, blocks: [], entities: [], sounds: [], coverage: { partial: true, max_age_ms: 1000 } });
  const listeners = new Set<(notice: BridgeNotice) => void>();
  let disconnects = 0, neutralizations = 0, respawns = 0, looks = 0, agents = 0, observationReads = 0;
  let neutralizationUnavailable = false, observationUnavailable = false;
  const nativeBarrier = Promise.withResolvers<void>(), workerBarrier = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<GameActionResult>(), actionEntered = Promise.withResolvers<void>();
  const rootEntered = Promise.withResolvers<void>(), recovered = Promise.withResolvers<void>();
  const firstEffectSettled = Promise.withResolvers<number>();
  const continuationEntered = Promise.withResolvers<void>(), continuationEffect = Promise.withResolvers<GameActionResult>();
  const completed = Promise.withResolvers<void>(), paused = Promise.withResolvers<void>(), reviewed = Promise.withResolvers<{ denied: unknown; revision: unknown }>();
  const childrenSettled = Promise.withResolvers<void>(), rootRelease = Promise.withResolvers<void>();
  const rootSucceeded = Promise.withResolvers<void>(), lookaheadSettled = Promise.withResolvers<void>();
  const respawnEntered = Promise.withResolvers<void>(), nativeRespawnProof = Promise.withResolvers<void>();
  const uncertaintyReplanned = Promise.withResolvers<void>();
  const uncertaintyFenced = Promise.withResolvers<void>();
  const protocolFailure = Promise.withResolvers<never>();
  const lookaheadEntered = Promise.withResolvers<void>(), lookaheadReply = Promise.withResolvers<void>();
  const preconditionRejected = Promise.withResolvers<{ details: unknown; plan: PlanProjection | null }>();
  let holdLookaheadReply = false;
  let deferRespawnProof = false;
  let delayBarrier = false, firstLook = true;
  const snapshot = (): GameState => ({ status: "connected", username: "Fixture", version: "1.21.4", world_id: world, epoch: 1, session_id: session, life: structuredClone(life), motor_profile: "balanced", video: { status: "streaming", width: 1, height: 1, fps: 30, frames: sequence + 1, last_frame_at: new Date().toISOString(), error: null }, last_observation_at: null, player: observe(false).player, error: null });
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => { disconnects++; }, snapshot,
    observe: async () => {
      observationReads++;
      if (observationUnavailable) throw new Error("Fresh fixture observation unavailable");
      return observe();
    }, recipes: async () => [], setMotorProfile: async () => {},
    neutralize: async () => {
      neutralizations++;
      if (neutralizationUnavailable) throw new Error("Fixture native input barrier remains unconfirmed");
      if (delayBarrier) await nativeBarrier.promise;
    },
    cancel: async () => {
      if (delayBarrier) await nativeBarrier.promise;
      continuationEffect.resolve({ status: "cancelled", summary: "Fixture continuation emitter neutralized", evidence: null });
    },
    execute: async (action) => {
      if (action.kind === "respawn") {
        respawns++;
        expect(life.status).toBe("dead");
        respawnEntered.resolve();
        if (deferRespawnProof) await nativeRespawnProof.promise;
        life = { life_id: 2, status: "alive", can_respawn: false, death: null };
        inventory = [];
        // The authoritative new-life notification deliberately precedes the RPC result.
        for (const listener of listeners) listener({ type: "state", data: null });
        for (const listener of listeners) listener({ type: "game_event", data: { type: "life", world_id: world, epoch: 1, session_id: session, life, neutralized: true, summary: "Confirmed new incarnation" } });
        return ok;
      }
      looks++;
      if (firstLook) { firstLook = false; actionEntered.resolve(); return await interrupted.promise; }
      if (startLookahead && looks === 2) {
        continuationEntered.resolve();
        return await continuationEffect.promise;
      }
      return ok;
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  let tools: AgentTool[] = [], gate: Parameters<Agent["setBeforeModelCall"]>[0];
  let original: SkillRef | null = null, recovery: SkillRef | null = null, child: SkillRef | null = null;
  let originalExecutionId: string | null = null, recoveryExecutionId: string | null = null;
  let normalStarted = false, recoveryStarted = false;
  let oldEffect: (() => Promise<Json>) | null = null;
  const executeTool = async (name: string, input: unknown) => await tools.find((tool) => tool.name === name)!.execute(crypto.randomUUID(), input);
  const authState: AuthState = { status: "ready", authenticated: true, provider: "openai-codex", account_label: null, models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null };
  const auth = {
    snapshot: () => authState,
    createAgent: async (options: { tools: AgentTool[] }) => {
      agents++; tools = options.tools;
      return { setBeforeModelCall: (hook: typeof gate) => { gate = hook; }, setTools: (next: AgentTool[]) => { tools = next; }, subscribe: () => () => {}, replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
        prompt: async (text: string) => {
          const context = JSON.parse(text) as { phase: string; reason?: string[]; speculative_plan?: { plan_id: string } | null };
          await gate?.({ systemPrompt: [], messages: [], tools: [] });
          if (context.reason?.includes("uncertainty")) uncertaintyReplanned.resolve();
          if (context.speculative_plan) {
            lookaheadEntered.resolve();
            if (holdLookaheadReply) await lookaheadReply.promise;
            if (repairPrecondition) {
              const rejected = await executeTool("planning_stage", {
                plan_id: context.speculative_plan.plan_id,
                skill: { ...child },
                args: "planned", limits: DEFAULT_SKILL_LIMITS,
                precondition_source: "return context.observation.",
              });
              preconditionRejected.resolve({ details: rejected.details, plan: runtime.planningView(created.run_id) });
              if (!rejected.isError) {
                protocolFailure.reject(new Error("Invalid precondition was unexpectedly accepted"));
                return;
              }
              // The diagnostic actor explicitly requests another bounded model
              // continuation; the host must not retry or extend the flight.
              const continuation = await gate?.({ systemPrompt: [], messages: [], tools: [] });
              if (continuation?.stop) {
                protocolFailure.reject(new Error(`Explicit correction was fenced: ${continuation.reason}`));
                return;
              }
            }
            const staged = await executeTool("planning_stage", {
              plan_id: context.speculative_plan.plan_id,
              skill: { ...child },
              args: "planned", limits: DEFAULT_SKILL_LIMITS,
              precondition_source: 'return context.predecessor.status === "succeeded";',
            });
            if (staged.isError)
              protocolFailure.reject(new Error(`Lookahead staging rejected: ${JSON.stringify(staged.details)}`));
          } else if (context.phase === "bootstrapping") {
            const register = async (name: string, source: string, dependencies: SkillRef[] = []) => {
              const result = await executeTool("skill_register", { epoch: 1, spec: { name, source, card, dependencies } });
              return { skill_id: result.details.skill_id, version: result.details.version } as SkillRef;
            };
            child = await register("Fresh neutral child", 'const observation = await game.observe(); const result = await game.action({kind:"look",yaw:0,pitch:0}); return {status:"completed",summary:"Fresh life inspected",result};');
            original = await register("Neutral interrupted root", startLookahead
              ? 'const first = await game.action({kind:"look",yaw:0,pitch:0}); if (first.status !== "succeeded") return {status:"blocked",summary:"First neutral effect did not settle",result:first}; await game.observe(); const second = await game.action({kind:"look",yaw:0.1,pitch:0}); return {status:"completed",summary:"Bounded neutral continuation settled",result:second};'
              : 'const result = await game.action({kind:"look",yaw:0,pitch:0}); return {status:"completed",summary:"Neutral effect settled",result};', childCalls ? [child] : []);
            recovery = await register("Explicit recovery root", 'const result = await game.respawn(); if (result.status !== "succeeded") return {status:"blocked",summary:"Recovery not confirmed",result}; return {status:"completed",summary:"Recovery confirmed",result};', [child]);
          } else if (context.phase === "reviewing") {
            const denied = await executeTool("skill_start", { ...original, epoch: 1, session_id: session, life_id: life.life_id, start_key: "forbidden-post-goal", args: null, limits: DEFAULT_SKILL_LIMITS });
            const revision = await executeTool("skill_revise", {
              epoch: 1, parent: original,
              spec: { source: 'const observation = await game.observe(); return {status:"completed",summary:"Candidate awaits future measurement",result:null};', card, dependencies: [] },
            });
            reviewed.resolve({ denied: denied.details, revision: revision.details });
          } else if (!normalStarted) {
            normalStarted = true;
            const started = await executeTool("skill_start", { ...original, epoch: 1, session_id: session, life_id: 1, start_key: "original", args: "original", limits: DEFAULT_SKILL_LIMITS, ...(startLookahead ? { lookahead: startLookahead } : {}) });
            originalExecutionId = started.details.execution_id;
          } else if (life.status === "dead" && !recoveryStarted) {
            recoveryStarted = true;
            const started = await executeTool("skill_start", { ...recovery, epoch: 1, session_id: session, life_id: 1, start_key: "recovery", args: "recovery", limits: DEFAULT_SKILL_LIMITS });
            recoveryExecutionId = started.details.execution_id;
          }
        },
      } as unknown as Agent;
    }, releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = {
    snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    runSkill: async (_source, args, handle, _limits, signal) => {
      if (args === "original") {
        oldEffect = () => handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } });
        const aborted = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        rootEntered.resolve();
        await handle({ kind: "action", action: initialAction }).catch(() => {});
        if (startLookahead) {
          await handle({ kind: "observe" });
          const result = await handle({ kind: "action", action: { kind: "look", yaw: 0.1, pitch: 0 } });
          return { status: "completed", summary: "Bounded neutral continuation settled", result };
        }
        if (childCalls) {
          for (let index = 0; index < childCalls; index++)
            await handle({ kind: "call", skill: child!, args: "churn-child" });
          childrenSettled.resolve();
          await Promise.race([rootRelease.promise, aborted.promise]);
          if (signal.aborted) throw new Error("Fixture root authority revoked");
          return { status: "completed", summary: "Sequential children settled", result: null };
        }
        await aborted.promise;
        await workerBarrier.promise;
        throw new Error("Old-life isolated worker closed");
      }
      if (args === "churn-child")
        return { status: "completed", summary: "Neutral child settled", result: null };
      if (args === "recovery") {
        const result = await handle({ kind: "respawn" });
        expect(result).toEqual(ok as unknown as Json);
        await handle({ kind: "observe" });
        await handle({ kind: "call", skill: child!, args: "child" });
      } else {
        await handle({ kind: "observe" });
        await handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } });
      }
      return { status: "completed", summary: "Fixture settled", result: null };
    },
    evaluatePrecondition: async (_source, context) =>
      (context as { predecessor: { status: string } }).predecessor.status === "succeeded",
  } satisfies Pick<SandboxService, "snapshot" | "runSkill" | "evaluatePrecondition"> as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {});
  cleanups.push(async () => { neutralizationUnavailable = false; observationUnavailable = false; lookaheadReply.resolve(); continuationEffect.resolve({ status: "cancelled", summary: "Test cleanup continuation neutralized", evidence: null }); nativeBarrier.resolve(); workerBarrier.resolve(); rootRelease.resolve(); nativeRespawnProof.resolve(); interrupted.resolve({ status: "unknown", summary: "Test cleanup", evidence: null }); await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await runtime.initialize();
  const created = await runtime.createRun({ task: "Measure safe life recovery", goal, model_id: "fixture-model" });
  store.subscribe((event) => {
    const details = event.details as { execution_id?: string; status?: string } | null;
    if (event.type === "skill.closed" && details?.execution_id === recoveryExecutionId && details.status === "succeeded") recovered.resolve();
    if (event.type === "action.succeeded" && details?.execution_id === originalExecutionId) firstEffectSettled.resolve(event.event_seq);
    if (event.type === "run.state" && runtime.snapshot()?.status === "completed") completed.resolve();
    if (event.type === "run.state" && runtime.snapshot()?.status === "paused") {
      paused.resolve();
      if (childCalls) protocolFailure.reject(new Error(`Runtime paused during sequential-child proof: ${store.getRun(created.run_id)?.error}`));
    }
    if (event.type === "skill.closed" && details?.execution_id === originalExecutionId) {
      if (details.status === "succeeded") rootSucceeded.resolve();
      else if (childCalls) {
        const failure = new Error(`Sequential-child root closed unexpectedly: ${JSON.stringify(event)}`);
        protocolFailure.reject(failure);
      }
    }
    if (event.type === "planning.settled") lookaheadSettled.resolve();
    if (["planning.rejected", "planning.empty", "scheduler.lookahead_skipped"].includes(event.type))
      protocolFailure.reject(new Error(`Lookahead did not stage: ${JSON.stringify(event)}`));
    if (event.type === "runtime.uncertainty") uncertaintyFenced.resolve();
  });
  await runtime.control(created.run_id, "start");
  await Promise.race([rootEntered.promise, protocolFailure.promise]);
  await Promise.race([actionEntered.promise, protocolFailure.promise]);
  return { runtime, store, created, game, nativeBarrier, workerBarrier, recovered, completed, paused, reviewed,
    candidate: child!,
    childrenSettled, rootSucceeded, lookaheadSettled,
    firstEffectSettled, continuationEntered,
    preconditionRejected,
    uncertaintyReplanned, uncertaintyFenced, protocolFailure,
    lookaheadEntered,
    holdLookahead: () => { holdLookaheadReply = true; },
    releaseLookahead: () => lookaheadReply.resolve(),
    holdNeutralization: () => { delayBarrier = true; },
    failNeutralization: () => { neutralizationUnavailable = true; },
    failFreshObservation: () => { observationUnavailable = true; },
    respawnEntered,
    deferRespawn: () => { deferRespawnProof = true; },
    proveRespawn: () => nativeRespawnProof.resolve(),
    publishRespawnReady: () => {
      life = { ...life, can_respawn: true };
      for (const listener of listeners) listener({
        type: "game_event",
        data: { type: "life", world_id: world, epoch: 1, session_id: session, life, neutralized: true, summary: "Vanilla respawn readiness changed" },
      });
    },
    finishRoot: () => rootRelease.resolve(),
    counters: () => ({ disconnects, neutralizations, respawns, looks, agents, observationReads }),
    staleAction: () => oldEffect!(),
    retryOriginal: () => executeTool("skill_start", { ...original, epoch: 1, session_id: session, life_id: 1, start_key: "original", args: "original", limits: DEFAULT_SKILL_LIMITS, ...(startLookahead ? { lookahead: startLookahead } : {}) }),
    compareVersions: (before: ProgramVersionEvidence, after: ProgramVersionEvidence) => executeTool("version_compare", { before, after }),
    modelTool: executeTool,
    advertisedTools: () => tools.map((tool) => tool.name),
    requestLookahead: () => executeTool("planning_lookahead", {
      root_execution_id: store.skillExecution(created.run_id, { start_key: "original" })!.execution_id,
      after_ms: 0, reason: "Prepare one explicit independent follow-up",
      budget: { calls: 1, tools: 4, duration_ms: 30000 },
    }),
    activatePlan: (planId: string) => executeTool("planning_activate", { plan_id: planId }),
    die: (canRespawn = true) => {
      delayBarrier = true;
      life = { life_id: 1, status: "dead", can_respawn: canRespawn, death: { death_id: "fixture-death", at: new Date().toISOString(), message: "Fixture death" } };
      const event: BridgeNotice = { type: "game_event", data: { type: "death", world_id: world, epoch: 1, session_id: session, life, neutralized: true, summary: "Player died" } };
      for (const listener of listeners) { listener({ type: "state", data: null }); listener(event); listener(event); }
      interrupted.resolve({ status: "unknown", summary: "Death interrupted prior effects", evidence: { effect_confirmed: false } });
    },
    finishNeutral: () => { interrupted.resolve(ok); workerBarrier.resolve(); },
    completeGoal: () => { inventory[0]!.count = 4; interrupted.resolve(ok); workerBarrier.resolve(); },
    confirmLogRemoval: () => {
      interrupted.resolve({ status: "succeeded", summary: "Server confirmed removal", evidence: { effect_confirmed: true, source: "server_block_update", target_name: "oak_log" } });
      workerBarrier.resolve();
    },
    settleUnknown: (workerClosed = true) => {
      interrupted.resolve({ status: "unknown", summary: "Past effect remains unconfirmed", evidence: null });
      if (workerClosed) workerBarrier.resolve();
    },
  };
}

test("death drains old life without disconnect, wakes one recovery generation, and only explicit root adopts the new life", async () => {
  const f = await fixture();
  f.die();
  expect(f.runtime.snapshot()?.status).toBe("running");
  expect(f.runtime.snapshot()?.error).toBeNull();
  expect(f.counters().respawns).toBe(0);
  f.nativeBarrier.resolve();
  await Promise.resolve();
  expect(f.counters().respawns).toBe(0);
  f.workerBarrier.resolve();
  await f.recovered.promise;
  await f.runtime.control(f.created.run_id, "pause");
  const view = f.runtime.snapshot()!;
  expect(view.run_id).toBe(f.created.run_id);
  expect(view.session_id).toBe(f.created.session_id);
  expect(view.epoch).toBe(1);
  expect(view.life_id).toBe(2);
  expect(view.error).toBeNull();
  expect(f.game.snapshot().status).toBe("connected");
  expect(f.game.snapshot().video.status).toBe("streaming");
  expect(f.counters()).toMatchObject({ disconnects: 0, respawns: 1, looks: 2, agents: 2 });
  await expect(f.staleAction()).rejects.toThrow();
  const historicalRetry = await f.retryOriginal();
  expect(historicalRetry.details).toMatchObject({ start_key: "original", status: "unknown", life_id: 1 });
  expect(f.counters().looks).toBe(2);
  const executions = f.store.skillExecutions(view.run_id);
  const original = executions.find((entry) => entry.start_key === "original")!;
  const recovery = executions.find((entry) => entry.start_key === "recovery")!;
  const child = executions.find((entry) => entry.parent_execution_id === recovery.execution_id)!;
  expect(original.status).toBe("unknown");
  expect(recovery.life_id).toBe(1);
  expect(child.life_id).toBe(2);
  expect(f.store.getRun(view.run_id)?.baseline.oak_log).toBe(3);
  const events = f.store.eventsAfter(view.run_id, 0, 500);
  expect(events.filter((entry) => entry.type === "learning.death_episode")).toHaveLength(1);
  expect(events.find((entry) => entry.type === "skill.life_adopted")?.details).toMatchObject({ execution_id: recovery.execution_id, previous_life_id: 1, life_id: 2 });
  await f.runtime.control(view.run_id, "stop");
  expect(f.counters().disconnects).toBe(0);
  const continued = await f.runtime.createRun({ task: "A distinct task baseline", goal: "custom", model_id: "fixture-model" });
  expect(continued.skills.length).toBeGreaterThan(0);
  expect(continued.executions).toEqual([]);
  await f.runtime.control(continued.run_id, "stop");
  const fresh = await f.runtime.createRun({ task: "Explicit fresh program selection", goal: "custom", model_id: "fixture-model", working_programs: "fresh" });
  expect(fresh.skills).toEqual([]);
  expect(fresh.executions).toEqual([]);
});

test("an explicitly chosen respawn reaches native readiness despite cached can_respawn false and adopts only authoritative new-life proof", async () => {
  const f = await fixture();
  f.deferRespawn();
  f.die(false);
  f.nativeBarrier.resolve();
  f.workerBarrier.resolve();
  await f.respawnEntered.promise;
  expect(f.game.snapshot().life).toMatchObject({ life_id: 1, status: "dead", can_respawn: false });
  expect(f.runtime.snapshot()?.status).toBe("running");
  expect(f.runtime.snapshot()?.life_id).toBe(1);
  expect(f.runtime.snapshot()?.action).toMatchObject({ kind: "respawn", status: "running", result: null });
  expect(f.counters()).toMatchObject({ respawns: 1, looks: 1, disconnects: 0 });
  await expect(f.staleAction()).rejects.toThrow();
  const recovery = f.store.skillExecution(f.created.run_id, { start_key: "recovery" })!;
  const deadOptIn = await f.modelTool("skill_start", {
    skill_id: recovery.skill_id, version: recovery.version, start_key: "dead-lookahead",
    epoch: recovery.epoch, session_id: recovery.session_id, life_id: recovery.life_id,
    args: null, limits: recovery.limits,
    lookahead: { after_ms: 0, reason: "Unavailable while dead", budget: { calls: 1, tools: 1, duration_ms: 1000 } },
  });
  expect(deadOptIn.isError).toBe(true);
  expect(f.store.skillExecution(f.created.run_id, { start_key: "dead-lookahead" })).toBeNull();
  f.publishRespawnReady();
  expect(f.game.snapshot().life).toMatchObject({ life_id: 1, status: "dead", can_respawn: true });
  expect(f.runtime.snapshot()?.life_id).toBe(1);
  expect(f.counters()).toMatchObject({ respawns: 1, looks: 1, agents: 2, disconnects: 0 });
  f.proveRespawn();
  await f.recovered.promise;
  expect(f.runtime.snapshot()?.life_id).toBe(2);
  expect(f.counters()).toMatchObject({ respawns: 1, looks: 2, disconnects: 0 });
  expect(f.store.eventsAfter(f.created.run_id, 0, 500)
    .filter((event) => event.type === "learning.death_episode")).toHaveLength(1);
  await f.runtime.control(f.created.run_id, "stop");
});

test("ordinary Pause and Stop await native and isolated emitters without ending the game session", async () => {
  const f = await fixture();
  const pausing = f.runtime.control(f.created.run_id, "pause");
  f.finishNeutral();
  await pausing;
  expect(f.runtime.snapshot()?.status).toBe("paused");
  expect(f.game.snapshot().status).toBe("connected");
  expect(f.counters().neutralizations).toBeGreaterThan(0);
  await f.runtime.control(f.created.run_id, "stop");
  expect(f.runtime.snapshot()?.status).toBe("stopped");
  expect(f.counters().disconnects).toBe(0);
  expect(f.store.eventsAfter(f.created.run_id, 0, 500)
    .some((event) => event.type === "planning.requested")).toBe(false);
});

test("production skill_start opt-in arms one independent request before handoff while the admitted root continues", async () => {
  const lookahead: LookaheadConfig = {
    after_ms: 0, reason: "Prepare one independent follow-up while the current effect continues",
    budget: { calls: 1, tools: 4, duration_ms: 30000 },
  };
  const f = await fixture("custom", { kind: "look", yaw: 0, pitch: 0 }, 0, lookahead);
  f.holdLookahead();
  const root = f.store.skillExecution(f.created.run_id, { start_key: "original" })!;
  const retry = await f.retryOriginal();
  expect(retry.details.execution_id).toBe(root.execution_id);
  const request = {
    skill_id: root.skill_id, version: root.version, epoch: root.epoch,
    session_id: root.session_id, life_id: root.life_id,
    start_key: "second-opt-in", args: "unadmitted", limits: root.limits, lookahead,
  };
  const competing = await f.modelTool("skill_start", request);
  expect(competing.isError).toBe(true);
  expect(f.store.skillExecution(f.created.run_id, { start_key: request.start_key })).toBeNull();
  const invalid = await f.modelTool("skill_start", {
    ...request, start_key: "invalid-opt-in", lookahead: { ...lookahead, budget: { ...lookahead.budget, calls: 5 } },
  });
  expect(invalid.isError).toBe(true);
  expect(f.store.skillExecution(f.created.run_id, { start_key: "invalid-opt-in" })).toBeNull();
  await Promise.race([f.lookaheadEntered.promise, f.protocolFailure.promise]);
  const plan = f.runtime.planningView(f.created.run_id)!;
  expect(root.status).toBe("running");
  expect(plan.basis.root.execution_id).toBe(root.execution_id);
  expect(plan.planning_active).toBe(true);
  const advertised = f.advertisedTools();
  expect(advertised).toContain("planning_stage");
  for (const forbidden of ["skill_start", "skill_register", "skill_revise", "planning_activate", "policy_activate"])
    expect(advertised).not.toContain(forbidden);
  const hashEcho = await f.modelTool("planning_stage", {
    plan_id: plan.plan_id,
    skill: { ...f.candidate, hash: "0".repeat(64) },
    args: null, limits: DEFAULT_SKILL_LIMITS,
    precondition_source: 'return context.predecessor.status === "succeeded";',
  });
  expect(hashEcho.isError).toBe(true);
  expect(hashEcho.details).toMatchObject({ error: { code: "invalid_request" } });
  expect(f.runtime.planningView(f.created.run_id)).toMatchObject({ plan_id: plan.plan_id, state: "planning", planning_active: true });
  const calls = f.store.eventsAfter(f.created.run_id, 0, 500);
  const overlappingRequest = calls.find((event) => event.type === "model.call" &&
    (event.details as { speculative_plan_id?: string } | null)?.speculative_plan_id === plan.plan_id)!;
  expect(overlappingRequest).toBeDefined();
  const requestId = (overlappingRequest.details as { request_id: string }).request_id;
  expect(calls.some((event) => event.type === "model.request_settled" &&
    (event.details as { request_id?: string } | null)?.request_id === requestId)).toBe(false);
  f.finishNeutral();
  const effectSeq = await f.firstEffectSettled.promise;
  expect(effectSeq).toBeGreaterThan(overlappingRequest.event_seq);
  await f.continuationEntered.promise;
  expect(f.store.skillExecution(f.created.run_id, { execution_id: root.execution_id })?.status).toBe("running");
  expect(f.store.skillExecution(f.created.run_id, { execution_id: root.execution_id })?.calls).toBe(3);
  f.releaseLookahead();
  await Promise.race([f.lookaheadSettled.promise, f.protocolFailure.promise]);
  expect(f.runtime.planningView(f.created.run_id)).toMatchObject({
    state: "staged",
    candidate: { ...f.candidate, hash: f.store.skill(f.created.run_id, f.candidate).hash },
  });
  expect(f.store.eventsAfter(f.created.run_id, 0, 500)
    .filter((event) => event.type === "planning.requested")).toHaveLength(1);
  expect(f.store.skillExecutions(f.created.run_id)).toHaveLength(1);
  expect(f.advertisedTools()).toContain("skill_start");
  await f.runtime.control(f.created.run_id, "stop");
  expect(f.runtime.planningView(f.created.run_id)?.state).toBe("invalidated");
  expect(f.counters().looks).toBe(2);
});

test("a production staging syntax rejection permits explicit correction within the same remaining flight budget", async () => {
  const lookahead: LookaheadConfig = {
    after_ms: 0, reason: "Choose one candidate and explicitly correct a rejected precondition",
    budget: { calls: 4, tools: 16, duration_ms: 30000 },
  };
  const f = await fixture("custom", { kind: "look", yaw: 0, pitch: 0 }, 0, lookahead, true);
  const rejected = await Promise.race([f.preconditionRejected.promise, f.protocolFailure.promise]);
  expect(rejected.plan).toMatchObject({ state: "planning", planning_active: true, calls: 1, budget: lookahead.budget });
  expect(rejected.details).toMatchObject({
    error: {
      code: "invalid_program", retryable: false,
      stage_correction: {
        plan_id: rejected.plan!.plan_id, correction_allowed: true, remaining_calls: 3,
        deadline_at: rejected.plan!.deadline_at,
      },
    },
  });
  await Promise.race([f.lookaheadSettled.promise, f.protocolFailure.promise]);
  const staged = f.runtime.planningView(f.created.run_id)!;
  expect(staged).toMatchObject({
    plan_id: rejected.plan!.plan_id, state: "staged", calls: 2,
    deadline_at: rejected.plan!.deadline_at, budget: lookahead.budget,
  });
  expect(f.store.skillExecutions(f.created.run_id)).toHaveLength(1);
  expect(f.store.skillExecution(f.created.run_id, { start_key: "original" })?.status).toBe("running");
  const events = f.store.eventsAfter(f.created.run_id, 0, 500);
  expect(events.filter((event) => event.type === "planning.stage_rejected")).toHaveLength(1);
  expect(events.filter((event) => event.type === "planning.requested")).toHaveLength(1);
  expect(events.some((event) => event.type === "planning.rejected")).toBe(false);
  f.finishNeutral();
  await f.runtime.control(f.created.run_id, "stop");
});

test("verified completion permits an effect-free linked candidate review and leaves the session streaming", async () => {
  const f = await fixture();
  f.completeGoal();
  const review = await f.reviewed.promise;
  await f.completed.promise;
  expect(review.denied).toMatchObject({ error: { code: "precondition_failed" } });
  expect(review.revision).toMatchObject({ version: 2, parent_version: 1, state: "validated" });
  expect(f.runtime.snapshot()?.status).toBe("completed");
  expect(f.runtime.snapshot()?.error).toBeNull();
  expect(f.runtime.snapshot()?.executions.some((entry) => entry.version === 2)).toBe(false);
  expect(f.counters()).toMatchObject({ disconnects: 0, respawns: 0, looks: 1 });
  expect(f.game.snapshot().status).toBe("connected");
  expect(f.game.snapshot().video.status).toBe("streaming");
});

test("break_log verifies a block-removal receipt without pretending that inventory increased", async () => {
  const f = await fixture("break_log", { kind: "dig", target_id: "authorized-fixture-log" });
  f.confirmLogRemoval();
  await f.completed.promise;
  const evidence = f.store.eventsAfter(f.created.run_id, 0, 500).find((event) => event.type === "goal.verified");
  expect(evidence?.details).toMatchObject({ kind: "block_removal", goal: "break_log", item: "oak_log" });
  expect(evidence?.details).not.toHaveProperty("current_count");
  expect(f.game.snapshot().player?.inventory[0]?.count).toBe(3);
  expect(f.runtime.snapshot()?.status).toBe("completed");
  expect(f.counters().disconnects).toBe(0);
});

test("a healthy unknown effect drains, observes afresh and wakes one new strategy generation without replay or human resume", async () => {
  const f = await fixture();
  const observationReads = f.counters().observationReads;
  f.holdNeutralization();
  f.settleUnknown(false);
  await f.uncertaintyFenced.promise;
  expect(f.counters().agents).toBe(1);
  f.nativeBarrier.resolve();
  await Promise.resolve();
  expect(f.counters().agents).toBe(1);
  f.workerBarrier.resolve();
  await f.uncertaintyReplanned.promise;
  expect(f.runtime.snapshot()?.status).toBe("running");
  expect(f.runtime.snapshot()?.error).toBeNull();
  expect(f.runtime.snapshot()?.action?.status).toBe("unknown");
  expect(f.runtime.snapshot()?.executions[0]?.status).toBe("unknown");
  expect(f.runtime.snapshot()?.executions).toHaveLength(1);
  expect(f.counters().observationReads).toBeGreaterThan(observationReads);
  expect(f.counters()).toMatchObject({ looks: 1, respawns: 0, agents: 2 });
  expect(f.counters().neutralizations).toBeGreaterThan(0);
  expect(f.counters().disconnects).toBe(0);
  expect(f.game.snapshot().status).toBe("connected");
  expect(f.game.snapshot().video.status).toBe("streaming");
  const events = f.store.eventsAfter(f.created.run_id, 0, 500);
  expect(events.filter((event) => event.type === "runtime.uncertainty_reconciled")).toHaveLength(1);
  await expect(f.staleAction()).rejects.toThrow();
  await f.runtime.control(f.created.run_id, "stop");
});

for (const unavailable of ["neutralization", "observation"] as const) {
  test(`unknown reconciliation stays paused without destroying a healthy session when ${unavailable} is unconfirmed`, async () => {
    const f = await fixture();
    if (unavailable === "neutralization") f.failNeutralization();
    else f.failFreshObservation();
    f.settleUnknown();
    await f.paused.promise;
    expect(f.runtime.snapshot()?.status).toBe("paused");
    expect(f.runtime.snapshot()?.error).not.toBeNull();
    expect(f.runtime.snapshot()?.action?.status).toBe("unknown");
    expect(f.runtime.snapshot()?.executions[0]?.status).toBe("unknown");
    expect(f.counters()).toMatchObject({ looks: 1, respawns: 0, agents: 1, disconnects: 0 });
    expect(f.game.snapshot().status).toBe("connected");
    expect(f.game.snapshot().video.status).toBe("streaming");
    const events = f.store.eventsAfter(f.created.run_id, 0, 500);
    expect(events.some((event) => event.type === "runtime.uncertainty_reconciled")).toBe(false);
    expect(events.filter((event) => event.type === "runtime.uncertainty_blocked")).toHaveLength(1);
    await expect(f.staleAction()).rejects.toThrow();
  });
}

test("operator Stop wins an in-flight uncertainty reconciliation without reopening or replaying work", async () => {
  const f = await fixture();
  f.holdNeutralization();
  f.settleUnknown(false);
  await f.uncertaintyFenced.promise;
  const stopping = f.runtime.control(f.created.run_id, "stop");
  f.nativeBarrier.resolve();
  f.workerBarrier.resolve();
  await stopping;
  expect(f.runtime.snapshot()?.status).toBe("stopped");
  expect(f.runtime.snapshot()?.action?.status).toBe("unknown");
  expect(f.counters()).toMatchObject({ looks: 1, respawns: 0, agents: 1, disconnects: 0 });
  expect(f.store.eventsAfter(f.created.run_id, 0, 500)
    .some((event) => event.type === "runtime.uncertainty_reconciled")).toBe(false);
});

test("death supersedes uncertainty reconciliation and creates only the existing explicit recovery turn", async () => {
  const f = await fixture();
  f.holdNeutralization();
  f.settleUnknown(false);
  await f.uncertaintyFenced.promise;
  f.die(false);
  f.nativeBarrier.resolve();
  f.workerBarrier.resolve();
  await f.recovered.promise;
  expect(f.runtime.snapshot()?.status).toBe("running");
  expect(f.runtime.snapshot()?.life_id).toBe(2);
  expect(f.counters()).toMatchObject({ looks: 2, respawns: 1, agents: 2, disconnects: 0 });
  const events = f.store.eventsAfter(f.created.run_id, 0, 500);
  expect(events.filter((event) => event.type === "learning.death_episode")).toHaveLength(1);
  expect(events.some((event) => event.type === "runtime.uncertainty_reconciled")).toBe(false);
  await f.runtime.control(f.created.run_id, "stop");
});

test("strategic version comparison cannot read another model's source even when both requested versions share that model", async () => {
  const f = await fixture();
  const foreignRun = { ...f.store.getRun(f.created.run_id)!, run_id: crypto.randomUUID(), model_id: "other-model" };
  f.store.saveRun(foreignRun);
  const before = f.store.registerSkill(foreignRun.run_id, await validateSkill({
    name: "Foreign private program",
    source: 'return {status:"completed",summary:"MODEL_B_PRIVATE_BEFORE",result:null};',
    card, dependencies: [],
  }));
  const after = f.store.registerSkill(foreignRun.run_id, await validateSkill({
    name: "Foreign private program",
    source: 'return {status:"completed",summary:"MODEL_B_PRIVATE_AFTER",result:null};',
    card, dependencies: [],
  }));
  const readSkill = f.store.skill.bind(f.store);
  let foreignSourceReads = 0;
  f.store.skill = (runId, ref) => {
    if (runId === foreignRun.run_id) foreignSourceReads++;
    return readSkill(runId, ref);
  };
  const result = await f.compareVersions(
    { run_id: foreignRun.run_id, skill_id: before.skill_id, version: before.version, hash: before.hash },
    { run_id: foreignRun.run_id, skill_id: after.skill_id, version: after.version, hash: after.hash },
  );
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ error: { code: "forbidden" } });
  expect(JSON.stringify(result)).not.toContain("MODEL_B_PRIVATE");
  expect(foreignSourceReads).toBe(0);
  f.finishNeutral();
  await f.runtime.control(f.created.run_id, "stop");
});

test("revision inherits the exact immutable parent name, rejects renames and identifies a stale latest parent", async () => {
  const f = await fixture();
  const execution = f.store.skillExecution(f.created.run_id, { start_key: "original" })!;
  const parent = f.store.skill(f.created.run_id, execution);
  const spec = {
    source: 'return {status:"blocked",summary:"Candidate awaits an independently chosen trial",result:null};',
    card, dependencies: [],
  };
  const revised = await f.modelTool("skill_revise", {
    epoch: 1, parent: { skill_id: parent.skill_id, version: parent.version }, spec,
  });
  expect(revised.isError).not.toBe(true);
  expect(revised.details).toMatchObject({
    skill_id: parent.skill_id, name: parent.name, version: 2, parent_version: 1,
  });
  expect(f.store.skill(f.created.run_id, parent)).toMatchObject({ source: parent.source, hash: parent.hash });
  expect(f.store.skillExecutions(f.created.run_id)).toHaveLength(1);
  const stale = await f.modelTool("skill_revise", {
    epoch: 1, parent: { skill_id: parent.skill_id, version: 1 }, spec,
  });
  expect(stale.isError).toBe(true);
  expect(stale.details).toMatchObject({
    error: {
      code: "conflict",
      issues: [{ code: "stale_parent", path: "parent", latest_parent: { skill_id: parent.skill_id, version: 2 } }],
    },
  });
  const renamed = await f.modelTool("skill_revise", {
    epoch: 1, parent: { skill_id: parent.skill_id, version: 2 }, spec: { ...spec, name: "Unrequested rename" },
  });
  expect(renamed.isError).toBe(true);
  expect(renamed.details).toMatchObject({ error: { code: "invalid_request" } });
  const unnamedRegistration = await f.modelTool("skill_register", { epoch: 1, spec });
  expect(unnamedRegistration.isError).toBe(true);
  expect(unnamedRegistration.details).toMatchObject({ error: { code: "invalid_request" } });
  expect(f.store.skills(f.created.run_id).filter((skill) => skill.skill_id === parent.skill_id)).toHaveLength(2);
  f.finishNeutral();
  await f.runtime.control(f.created.run_id, "stop");
});

test("overlapping revision validation cannot silently rebase a stale parent", async () => {
  const f = await fixture();
  const execution = f.store.skillExecution(f.created.run_id, { start_key: "original" })!;
  const parent = { skill_id: execution.skill_id, version: execution.version };
  const results = await Promise.all(["First distinct candidate", "Second distinct candidate"].map((summary) =>
    f.modelTool("skill_revise", {
      epoch: 1, parent,
      spec: { source: `return {status:"blocked",summary:${JSON.stringify(summary)},result:null};`, card, dependencies: [] },
    }),
  ));
  expect(results.filter((result) => !result.isError)).toHaveLength(1);
  expect(results.find((result) => result.isError)?.details).toMatchObject({
    error: {
      code: "conflict",
      issues: [{ code: "stale_parent", latest_parent: { skill_id: parent.skill_id, version: 2 } }],
    },
  });
  expect(f.store.skills(f.created.run_id).filter((skill) => skill.skill_id === parent.skill_id)).toHaveLength(2);
  f.finishNeutral();
  await f.runtime.control(f.created.run_id, "stop");
});

test("resolution rejects a revision on insufficient_evidence and accepts an explicitly chosen unproven revise experiment", async () => {
  const f = await fixture();
  f.settleUnknown();
  await f.uncertaintyReplanned.promise;
  const root = f.store.skillExecution(f.created.run_id, { start_key: "original" })!;
  const feedback = await f.modelTool("improvement_feedback", {});
  const opportunity = (feedback.details.opportunities as ImprovementOpportunity[])
    .find((value) => value.execution_id === root.execution_id)!;
  expect(opportunity).toBeDefined();
  const candidate = await f.modelTool("skill_revise", {
    epoch: root.epoch, parent: { skill_id: root.skill_id, version: root.version },
    spec: {
      source: 'await game.observe(); return {status:"blocked",summary:"Candidate awaiting an independently chosen trial",result:null};',
      card, dependencies: [],
    },
  });
  expect(candidate.isError).not.toBe(true);
  const revision: ProgramVersionEvidence = {
    run_id: f.created.run_id, skill_id: candidate.details.skill_id,
    version: candidate.details.version, hash: candidate.details.hash,
  };
  const input = {
    opportunity_id: opportunity.opportunity_id, decision: "insufficient_evidence",
    reason: "The chosen candidate has no efficacy measurement", revision, event_seqs: opportunity.event_seqs,
  };
  const rejected = await f.modelTool("improvement_resolve", input);
  expect(rejected.isError).toBe(true);
  expect(rejected.details).toMatchObject({ error: { code: "invalid_request", retryable: false } });
  expect(f.store.evidenceObjects<ImprovementOpportunity>(f.created.run_id, "opportunity")
    .find((value) => value.opportunity_id === opportunity.opportunity_id)?.resolution).toBeNull();
  const chosen = { ...input, decision: "revise" };
  const accepted = await f.modelTool("improvement_resolve", chosen);
  expect(accepted.isError).not.toBe(true);
  expect(accepted.details).toMatchObject({
    opportunity_id: opportunity.opportunity_id,
    resolution: { decision: "revise", revision, measured: false },
  });
  const matchingRetry = await f.modelTool("improvement_resolve", chosen);
  expect(matchingRetry.isError).not.toBe(true);
  expect(f.store.eventsAfter(f.created.run_id, 0, 500)
    .filter((event) => event.type === "learning.resolved")).toHaveLength(1);
  expect(f.store.skillExecutions(f.created.run_id)).toHaveLength(1);
  await f.runtime.control(f.created.run_id, "stop");
});

test("planning retains its real active and closed predecessor after more than one hundred sequential child executions", async () => {
  // The real fsync-backed 101-child path exceeded the generic 5s suite budget.
  // This allowance bounds the integration proof, not gameplay latency.
  let f: Awaited<ReturnType<typeof fixture>> | null = null;
  let phase = "fixture startup";
  const began = performance.now(), phases: { phase: string; duration_ms: number }[] = [];
  const stalled = Promise.withResolvers<never>();
  const watchdog = setTimeout(() => {
    const root = f?.store.latestRootExecution(f.created.run_id);
    stalled.reject(new Error(`Sequential-child proof stalled: ${JSON.stringify({
      phase, elapsed_ms: performance.now() - began, phases,
      root: root ? { status: root.status, calls: root.calls, ended_at: root.ended_at } : null,
      counters: f?.counters(), plan: f?.runtime.planningView(f.created.run_id),
      recent_events: f?.store.events(f.created.run_id, 0, 8).map((event) => ({ type: event.type, summary: event.summary })),
    })}`));
  }, 12000);
  const step = async <T>(name: string, operation: Promise<T>): Promise<T> => {
    phase = name;
    const start = performance.now();
    try {
      return await Promise.race([operation, stalled.promise, ...(f ? [f.protocolFailure.promise] : [])]);
    } finally {
      phases.push({ phase: name, duration_ms: performance.now() - start });
    }
  };
  try {
    f = await step("fixture startup", fixture("custom", { kind: "look", yaw: 0, pitch: 0 }, 101));
    f.finishNeutral();
    await step("101 durable child closures", f.childrenSettled.promise);
    const root = f.store.skillExecution(f.created.run_id, { start_key: "original" })!;
    expect(root.status).toBe("running");
    expect(root.calls).toBe(102);
    expect(root.calls).toBeLessThan(root.limits.max_calls);
    const presentation = f.store.skillExecutions(f.created.run_id);
    expect(presentation).toHaveLength(100);
    expect(presentation.every((execution) => execution.parent_execution_id === root.execution_id)).toBe(true);
    const requested = await step("lookahead admission", f.requestLookahead());
    expect(requested.isError).not.toBe(true);
    await step("lookahead staged and settled", f.lookaheadSettled.promise);
    const staged = f.runtime.planningView(f.created.run_id)!;
    expect(staged.state).toBe("staged");
    expect(staged.basis.root.execution_id).toBe(root.execution_id);
    expect(staged.reason).toBeNull();
    expect(f.store.skillExecution(f.created.run_id, { execution_id: root.execution_id })?.status).toBe("running");
    f.finishRoot();
    await step("predecessor root closure", f.rootSucceeded.promise);
    const activated = await step("fresh explicit plan activation", f.activatePlan(staged.plan_id));
    expect(activated.isError).not.toBe(true);
    expect(activated.details).toMatchObject({
      state: "activated", reason: null, basis: { root: { execution_id: root.execution_id } },
    });
    const plan = f.runtime.planningView(f.created.run_id)!;
    expect(plan.activation_execution_id).not.toBeNull();
    const admitted = f.store.skillExecution(f.created.run_id, { execution_id: plan.activation_execution_id! })!;
    expect(admitted.parent_execution_id).toBeNull();
    expect(admitted.start_key).toBe(`plan_${staged.plan_id}`);
    expect(admitted.skill_id).toBe(staged.candidate!.skill_id);
  } finally {
    clearTimeout(watchdog);
    if (f) {
      f.finishRoot();
      f.nativeBarrier.resolve();
      f.workerBarrier.resolve();
      await f.runtime.control(f.created.run_id, "stop");
    }
  }
}, 15000);
