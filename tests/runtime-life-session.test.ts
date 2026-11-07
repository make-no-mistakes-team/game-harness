import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type { AuthState, BridgeNotice, GameAction, GameActionResult, GameBridge, GameState, Json, PlayerLife } from "../src/shared/contracts.ts";
import type { MinecraftObservation } from "../src/shared/minecraft.ts";
import { minecraftActionSchema } from "../src/shared/minecraft.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import type { ImprovementOpportunity } from "../src/shared/execution-evidence.ts";
import type { LookaheadConfig } from "../src/shared/planning.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { Store } from "../src/server/store.ts";
import { validateSkill } from "../src/server/program-validation.ts";
import { qualifyMinecraftExperience } from "../src/server/minecraft-qualification.ts";
import { promotionEvidence } from "../web/src/evidence.ts";
import { projectRunOperator } from "../src/server/operator-state.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const ROOT = "Neutral flow", FOLLOW = "Fresh follow-up", RECOVERY = "Explicit recovery", CHILD = "Neutral child";
const card = { purpose: "Exercise trusted lifecycle transitions", applicability: "Deterministic neutral fixture", method: "Await authorized bounded capabilities", reason: "Measure actual ownership transitions", limitations: "No gameplay effectiveness claim" };
const ok: GameActionResult = { status: "succeeded", summary: "Confirmed neutral fixture effect", evidence: { effect_confirmed: true } };
const cancelled: GameActionResult = { status: "cancelled", summary: "Fixture emitter neutralized", evidence: null };
type Options = { goal?: string; initialAction?: GameAction; childCalls?: number; next?: LookaheadConfig; repairGuard?: boolean; guardSource?: string; guardResult?: boolean; holdWorkerExit?: boolean; recoveryInventory?: boolean; providerFailure?: boolean; blockedRoot?: boolean; customCompletion?: "after-root" | "with-pending-root" };
type PromptContext = { phase: string; role: string; reason: string[]; adapter_state: unknown; speculative_plan: { plan_id: string } | null };
function eventDetails(value: Json): { [key: string]: Json } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function fixture(options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-life-session-"));
  const store = new Store(directory), world = crypto.randomUUID(), session = crypto.randomUUID(), adapter = minecraftTestAdapter();
  let spaceEpoch = 1;
  let life: PlayerLife = { life_id: 1, status: "alive", can_respawn: false, death: null };
  let inventory = [{ name: "oak_log", display_name: "Oak Log", slot: 0, count: 3 }], sequence = 0;
  let disconnects = 0, barriers = 0, respawns = 0, effects = 0, agents = 0, observationReads = 0, guardCalls = 0;
  let failBarrier = false, failObservation = false, failDisconnect = false, failPreparation = false, holdBarrier = false, holdRespawn = false, holdSpec = false;
  const firstEffect = Promise.withResolvers<GameActionResult>(), tailEffect = Promise.withResolvers<GameActionResult>();
  const nativeBarrier = Promise.withResolvers<void>(), workerExit = Promise.withResolvers<void>(), respawnProof = Promise.withResolvers<void>();
  const barrierEntered = Promise.withResolvers<void>(), finishReturned = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const rootEntered = Promise.withResolvers<void>(), effectEntered = Promise.withResolvers<void>(), tailEntered = Promise.withResolvers<void>();
  const admissionSettled = Promise.withResolvers<void>();
  const childrenClosed = Promise.withResolvers<void>(), rootSourceFinished = Promise.withResolvers<void>(), rootDrained = Promise.withResolvers<void>();
  const recoveryClosed = Promise.withResolvers<void>(), successorClosed = Promise.withResolvers<void>(), respawnEntered = Promise.withResolvers<void>();
  const specEntered = Promise.withResolvers<void>(), specReply = Promise.withResolvers<void>(), staged = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>(), reviewed = Promise.withResolvers<unknown>();
  const uncertaintyFenced = Promise.withResolvers<void>(), replanned = Promise.withResolvers<void>(), failure = Promise.withResolvers<never>();
  const rejectedGuard = Promise.withResolvers<{ result: unknown; deadline_at: string }>();
  const firstEffectReceipt = Promise.withResolvers<number>();
  const continuationSettled = Promise.withResolvers<void>();
  const contexts: PromptContext[] = [];
  const notices = new Set<(notice: BridgeNotice) => void>();
  const observation = (advance = true): MinecraftObservation => minecraftObservationFixture(adapter, {
    world_id: world, epoch: 1, session_id: session, life: structuredClone(life), space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch },
    observation_seq: advance ? ++sequence : sequence, captured_at: new Date().toISOString(),
    data: { player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: life.status === "alive" ? 20 : 0, food: 20, on_ground: true, in_water: false, inventory: structuredClone(inventory) },
    blocks: [], entities: [], sounds: [] },
  });
  const lifeNotice = (type: "life" | "death", summary: string): BridgeNotice => ({ type: "game_event", data: { type,
    world_id: world, epoch: 1, session_id: session, native_boot_id: "fixture-native-boot", life,
    space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch }, screen: null, neutralized: true, summary } });
  const barrier = async () => {
    barriers++; if (failBarrier) throw new Error("Native barrier unconfirmed");
    if (holdBarrier) { barrierEntered.resolve(); await nativeBarrier.promise; }
  };
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => { disconnects++; if (failDisconnect) throw new Error("Offline fixture disconnect unconfirmed"); },
    snapshot: (): GameState => ({ status: "connected", username: "Fixture", version: "1.21.4", world_id: world, epoch: 1, session_id: session, life: structuredClone(life),
      binding: minecraftTestBinding(adapter), space: { dimension_id: "minecraft:overworld", space_epoch: spaceEpoch }, screen: null,
      presentation: adapter.projectObservation(observation(false)), last_observation_at: null, error: null,
      video: { status: "streaming", width: 1, height: 1, fps: 30, frames: sequence + 1, last_frame_at: new Date().toISOString(), error: null } }),
    observe: async () => { observationReads++; if (failObservation) throw new Error("Fresh fixture observation unavailable"); return observation(); },
    neutralize: barrier,
    emergencyStop: barrier,
    cancel: async () => { if (holdBarrier) await nativeBarrier.promise; tailEffect.resolve(cancelled); },
    adapter: () => adapter,
    execute: async envelope => {
      const action = minecraftActionSchema.parse(envelope.action);
      if (action.kind === "respawn") {
        respawns++; respawnEntered.resolve();
        expect(life.status).toBe("dead");
        if (holdRespawn) await respawnProof.promise;
        life = { life_id: 2, status: "alive", can_respawn: false, death: null }; inventory = []; spaceEpoch++;
        // Authoritative life notification deliberately precedes the RPC result.
        for (const listener of notices) {
          listener({ type: "state", data: null });
          listener(lifeNotice("life", "Confirmed replacement player"));
        }
        return ok;
      }
      effects++;
      if (effects === 1) { effectEntered.resolve(); return await firstEffect.promise; }
      if ((options.next || options.childCalls || options.customCompletion === "with-pending-root") && effects === 2) { tailEntered.resolve(); return await tailEffect.promise; }
      if (options.recoveryInventory && life.life_id === 2) {
        inventory = [{ name: "stone", display_name: "Stone", count: 2, slot: 0 }];
        return { status: "succeeded", summary: "Synthetic confirmed post-recovery own inventory receipt",
          evidence: { effect_confirmed: true, inventory_receipt_confirmed: true, inventory_before: {}, inventory_after: { stone: 2 } } };
      }
      return ok;
    },
    subscribe: (listener) => { notices.add(listener); return () => { notices.delete(listener); }; },
  };
  let activeTools: AgentTool[] = [], gate: Parameters<Agent["setBeforeModelCall"]>[0];
  const knownTools = new Map<string, AgentTool>();
  let activeAgent: Agent | null = null, rootStarted = false, rootCompleted = false, completionRequested = false, recoveryStarted = false;
  let oldEffect: (() => Promise<Json>) | null = null;
  const rootArgs = { mode: "root", child_calls: options.childCalls ?? 0 };
  const rootRequest = { operation: "start", name: ROOT, args: rootArgs, limits: { ...DEFAULT_SKILL_LIMITS }, ...(options.next ? { next: options.next } : {}) };
  const selectTools = (tools: AgentTool[]) => { activeTools = tools; for (const tool of tools) knownTools.set(tool.name, tool); };
  const invoke = async (name: string, input: unknown, callId: string = crypto.randomUUID()) => {
    const tool = knownTools.get(name);
    if (!tool) throw new Error(`Fixture requested undisclosed tool ${name}`);
    return await tool.execute(callId, input);
  };
  const perform = async (name: string, input: unknown, callId?: string) => {
    const tool = activeTools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Fixture actor requested unavailable tool ${name}`);
    const blocked = await activeAgent?.beforeToolCall?.({ tool, toolCall: { arguments: input }, args: input } as Parameters<NonNullable<Agent["beforeToolCall"]>>[0]);
    if (blocked?.block) throw new Error(`Fixture actor was blocked: ${blocked.reason}`);
    return await invoke(name, input, callId);
  };
  const required = async (name: string, input: unknown, callId?: string) => {
    const result = await perform(name, input, callId);
    if (result.isError) throw new Error(`Fixture ${name} rejected: ${JSON.stringify(result.details)}`);
    return result;
  };
  const write = async (name: string, source: string, dependencies: { name: string; version?: number }[] = []) =>
    await required("program_write", { name, source, card, dependencies });
  const authState: AuthState = { status: "ready", authenticated: true, provider: "openai-codex", account_label: null, models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null };
  const auth = {
    snapshot: () => authState,
    createAgent: async (configuration: { tools: AgentTool[] }) => {
      if (failPreparation) throw new Error("Offline fixture agent preparation failed");
      agents++; selectTools(configuration.tools);
      let pending: Promise<void> | null = null;
      let controller: AbortController | null = null;
      const hooks = new DiagnosticModelHooks();
      const agent = {
        beforeToolCall: undefined as Agent["beforeToolCall"],
        addBeforeModelCallHook: hooks.add,
        setBeforeModelCall: (value: typeof gate) => { gate = value; }, setTools: selectTools,
        subscribe: () => () => {}, replaceMessages: () => {},
        abort: () => controller?.abort(),
        waitForIdle: async () => { if (pending) await pending.then(() => {}, () => {}); },
        prompt: async (text: string) => {
          const signal = new AbortController(); controller = signal;
          const work = (async () => {
            const context = JSON.parse(text) as PromptContext; contexts.push(context);
            await hooks.run(signal.signal, { systemPrompt: [], messages: [], tools: activeTools });
            const admission = await gate?.({ systemPrompt: [], messages: [], tools: activeTools }, signal.signal);
            if (admission?.stop || signal.signal.aborted) return;
            if (options.providerFailure && agents === 1 && rootCompleted)
              throw new Error("Offline fixture provider response failed");
            if (context.reason.includes("uncertainty")) replanned.resolve();
            if (context.speculative_plan) {
              specEntered.resolve();
              if (holdSpec) {
                const revoked = Promise.withResolvers<void>();
                signal.signal.addEventListener("abort", () => revoked.resolve(), { once: true });
                await Promise.race([specReply.promise, revoked.promise]);
              }
              if (signal.signal.aborted) return;
              if (options.repairGuard) {
                const rejected = await perform("prepare_next", { name: FOLLOW, args: { mode: "follow-up" }, guard_source: "return observation.data.player." });
                const plan = runtime.planningView(created.run_id)!;
                rejectedGuard.resolve({ result: rejected.details, deadline_at: plan.deadline_at });
                expect(rejected.isError).toBe(true);
                await hooks.run(signal.signal, { systemPrompt: [], messages: [], tools: activeTools });
                const correction = await gate?.({ systemPrompt: [], messages: [], tools: activeTools }, signal.signal);
                if (correction?.stop) throw new Error(`Explicit guard correction blocked: ${correction.reason}`);
              }
              await required("prepare_next", { name: FOLLOW, args: { mode: "follow-up" }, limits: DEFAULT_SKILL_LIMITS,
                ...(options.guardSource === undefined ? {} : { guard_source: options.guardSource }) });
            } else if (context.phase === "reviewing") {
              const result = await required("program_write", { name: ROOT, based_on: 1,
                source: 'await game.observe(); return {status:"blocked",summary:"Candidate awaits a future task",result:null};', card, dependencies: [] });
              reviewed.resolve(result.details);
            } else if (!rootStarted) {
              await write(FOLLOW, 'await game.observe(); const result = await game.action({kind:"look",yaw:0.2,pitch:0}); return {status:"completed",summary:"Fresh neutral effect settled",result};');
              await write(RECOVERY, 'const result = await game.respawn(); if (result.status !== "succeeded") return {status:"blocked",summary:"Recovery not confirmed",result}; const child = await game.call({name:"Fresh follow-up",version:1},{mode:"follow-up"}); return {status:"completed",summary:"Recovery child settled",result:child};', [{ name: FOLLOW, version: 1 }]);
              if (options.childCalls) await write(CHILD, 'return {status:"completed",summary:"Neutral child settled",result:null};');
              const tail = options.next || options.childCalls;
              const source = `const first = await game.action(${JSON.stringify(options.initialAction ?? { kind: "look", yaw: 0, pitch: 0 })}); if (first.status !== "succeeded") return {status:"blocked",summary:"First effect did not settle",result:first}; ` +
                (options.childCalls ? 'for (let index = 0; index < args.child_calls; index++) await game.call({name:"Neutral child",version:1},{mode:"child"}); ' : "") +
                (tail ? 'await game.observe(); const result = await game.action({kind:"look",yaw:0.1,pitch:0}); ' : 'const result = first; ') +
                `return {status:"${options.blockedRoot ? "blocked" : "completed"}",summary:"Bounded neutral flow settled",result};`;
              await write(ROOT, source, options.childCalls ? [{ name: CHILD, version: 1 }] : []);
              rootStarted = true;
              await required("program_run", rootRequest, "start-original");
              admissionSettled.resolve();
            } else if (options.customCompletion && rootCompleted && !completionRequested) {
              completionRequested = true;
              if (options.customCompletion === "with-pending-root") {
                await required("program_run", { operation: "start", name: FOLLOW, args: { mode: "follow-up" }, limits: DEFAULT_SKILL_LIMITS });
                await tailEntered.promise;
              }
              await required("task_finish", { summary: "Collected one dirt block; fresh inventory contains dirt" });
              finishReturned.resolve();
            } else if (life.status === "dead" && !recoveryStarted) {
              recoveryStarted = true;
              await required("program_run", { operation: "start", name: RECOVERY, args: { mode: "recovery" }, limits: DEFAULT_SKILL_LIMITS });
            }
          })();
          pending = work;
          try { await work; } catch (error) { if (!options.providerFailure) failure.reject(error); throw error; }
          finally { if (pending === work) pending = null; if (controller === signal) controller = null; }
        },
      };
      activeAgent = agent as unknown as Agent;
      return activeAgent;
    }, releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = {
    snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    runSkill: async (_source, args, handle, _limits, signal) => {
      const mode = args && typeof args === "object" && !Array.isArray(args) ? args.mode : null;
      if (mode === "root") {
        oldEffect = () => handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } });
        const revoked = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => revoked.resolve(), { once: true });
        rootEntered.resolve();
        try {
          await handle({ kind: "action", action: options.initialAction ?? { kind: "look", yaw: 0, pitch: 0 } });
          for (let index = 0; index < (options.childCalls ?? 0); index++)
            await handle({ kind: "call", skill: { name: CHILD, version: 1 }, args: { mode: "child" } });
          childrenClosed.resolve();
          if (options.next || options.childCalls) {
            await handle({ kind: "observe" });
            await handle({ kind: "action", action: { kind: "look", yaw: 0.1, pitch: 0 } });
          }
          rootSourceFinished.resolve();
          if (options.holdWorkerExit) await Promise.race([workerExit.promise, revoked.promise]);
          return { status: options.blockedRoot ? "blocked" : "completed", summary: "Bounded neutral flow settled", result: null };
        } catch (error) {
          if (signal.aborted) await workerExit.promise;
          throw error;
        }
      }
      if (mode === "child") return { status: "completed", summary: "Neutral child settled", result: null };
      if (mode === "recovery") {
        await handle({ kind: "respawn" });
        await handle({ kind: "call", skill: { name: FOLLOW, version: 1 }, args: { mode: "follow-up" } });
      } else {
        if (options.customCompletion === "with-pending-root" && mode === "follow-up")
          oldEffect = () => handle({ kind: "action", action: { kind: "look", yaw: 1, pitch: 0 } });
        await handle({ kind: "observe" });
        await handle({ kind: "action", action: { kind: "look", yaw: 0.2, pitch: 0 } });
        if (options.recoveryInventory) await handle({ kind: "observe" });
      }
      return { status: "completed", summary: "Fresh neutral effect settled", result: null };
    },
    evaluateGameGuard: async (_source, fresh, args) => {
      guardCalls++;
      expect(fresh.session_id).toBe(session);
      expect(args).toEqual({ mode: "follow-up" });
      return options.guardResult ?? true;
    },
  } satisfies Pick<SandboxService, "snapshot" | "runSkill" | "evaluateGameGuard"> as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
  cleanups.push(async () => {
    failBarrier = false; failObservation = false; failDisconnect = false;
    specReply.resolve(); firstEffect.resolve(cancelled); tailEffect.resolve(cancelled);
    nativeBarrier.resolve(); workerExit.resolve(); respawnProof.resolve();
    await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  await runtime.initialize();
  const created = await runtime.createRun({ task: "Measure bounded lifecycle transitions", goal: adapter.goals.find(goal => goal.goal_id === (options.goal ?? "custom"))!, model_id: "fixture-model" });
  const findExecution = (name: string) => {
    const program = store.namedSkill(created.run_id, name);
    return program ? store.allSkillExecutions(created.run_id).filter((entry) => entry.skill_id === program.skill_id && entry.parent_execution_id === null).at(-1) ?? null : null;
  };
  store.subscribe((event) => {
    if (event.run_id !== created.run_id) return;
    const details = eventDetails(event.details);
    if (event.type === "action.succeeded" && effects === 1) firstEffectReceipt.resolve(event.event_seq);
    if (event.type === "skill.closed") {
      const execution = typeof details?.execution_id === "string" ? store.skillExecution(created.run_id, { execution_id: details.execution_id }) : null;
      if (execution?.parent_execution_id === null && execution.status === "succeeded") {
        const name = store.skill(created.run_id, execution).name;
        if (name === ROOT && (options.customCompletion || options.providerFailure)) {
          rootCompleted = true;
          inventory = [{ name: "dirt", display_name: "Dirt", slot: 0, count: 1 }];
        }
        if (name === RECOVERY) recoveryClosed.resolve();
        if (name === FOLLOW) successorClosed.resolve();
      }
    }
    if (event.type === "planning.predecessor_settled") rootDrained.resolve();
    if (event.type === "planning.settled") staged.resolve();
    if (event.type === "planning.rejected" || event.type === "planning.activated") continuationSettled.resolve();
    if (event.type === "runtime.uncertainty") uncertaintyFenced.resolve();
    if (event.type === "run.state") {
      const status = store.getRun(created.run_id)?.status;
      if (status === "paused") paused.resolve();
      if (status === "completed") completed.resolve();
      if (status === "stopped") stopped.resolve();
    }
  });
  await runtime.control(created.run_id, "start");
  await Promise.race([rootEntered.promise, failure.promise]);
  await Promise.race([effectEntered.promise, failure.promise]);
  await Promise.race([admissionSettled.promise, failure.promise]);
  return {
    runtime, store, created, game, adapter, contexts, failure, rootEntered, tailEntered, childrenClosed, rootSourceFinished, rootDrained,
    recoveryClosed, successorClosed, respawnEntered, specEntered, staged, paused, completed, reviewed, rejectedGuard,
    firstEffectReceipt, uncertaintyFenced, replanned, nativeBarrier, workerExit,
    continuationSettled, barrierEntered, finishReturned, stopped,
    invoke, findExecution,
    originalRequest: rootRequest,
    counters: () => ({ disconnects, barriers, respawns, effects, agents, observationReads, guardCalls, prompts: contexts.length }),
    advertised: () => activeTools.map((tool) => tool.name),
    retryRoot: () => invoke("program_run", rootRequest, "start-original"),
    staleEffect: () => oldEffect!(),
    finishFirst: (result: GameActionResult = ok) => firstEffect.resolve(result),
    finishTail: () => tailEffect.resolve(ok),
    releaseSpec: () => specReply.resolve(), holdSpec: () => { holdSpec = true; },
    holdBarrier: () => { holdBarrier = true; }, failBarrier: () => { failBarrier = true; }, failObservation: () => { failObservation = true; },
    failCleanup: () => { failBarrier = true; failDisconnect = true; },
    restoreCleanup: () => { failBarrier = false; failDisconnect = false; },
    failPreparation: () => { failPreparation = true; },
    holdRespawn: () => { holdRespawn = true; }, proveRespawn: () => respawnProof.resolve(),
    die: (canRespawn = true) => {
      holdBarrier = true;
      life = { life_id: 1, status: "dead", can_respawn: canRespawn, death: { death_id: "fixture-death", at: new Date().toISOString(), message: "Fixture death" } };
      for (const listener of notices) for (let duplicate = 0; duplicate < 2; duplicate++)
        listener(lifeNotice("death", "Fixture death"));
      firstEffect.resolve({ status: "unknown", summary: "Death interrupted the old effect", evidence: null });
    },
    publishRespawnReady: () => {
      life = { ...life, can_respawn: true };
      for (const listener of notices) listener(lifeNotice("life", "Vanilla readiness changed"));
    },
    collectGoal: () => { inventory[0]!.count = 4; firstEffect.resolve(ok); workerExit.resolve(); },
    removeLog: () => { firstEffect.resolve({ status: "succeeded", summary: "Server-confirmed removal", evidence: { source: "server_block_update", target_name: "oak_log", effect_confirmed: true } }); workerExit.resolve(); },
    unknown: (closedWorker = true) => { firstEffect.resolve({ status: "unknown", summary: "Past effect remains uncertain", evidence: null }); if (closedWorker) workerExit.resolve(); },
  };
}

async function reached<T>(f: { failure: { promise: Promise<never> } }, promise: Promise<T>): Promise<T> {
  return await Promise.race([promise, f.failure.promise]);
}

test("host preflight opens a fresh ordinary turn without a model bootstrap ceremony", async () => {
  const f = await fixture();
  expect(f.contexts).toHaveLength(1);
  expect(f.contexts[0]).toMatchObject({ phase: "running" });
  expect(f.contexts[0]!.adapter_state).toBeDefined();
  expect(f.contexts[0]).not.toHaveProperty("player");
  expect(f.counters().observationReads).toBeGreaterThan(0);
  expect(f.findExecution(ROOT)).toMatchObject({ status: "running", epoch: 1, session_id: f.created.session_id });
  expect(f.runtime.snapshot()?.operator.state).toBe("acting");
  const pausing = f.runtime.control(f.created.run_id, "pause");
  f.finishFirst(); f.workerExit.resolve(); await pausing;
  expect(f.runtime.snapshot()?.status).toBe("paused");
  expect(f.counters().disconnects).toBe(0);
});

test("death drains old emitters then one explicit named recovery root adopts the real new life", async () => {
  const f = await fixture(); f.die();
  expect(f.runtime.snapshot()?.status).toBe("running");
  expect(f.runtime.snapshot()?.error).toBeNull();
  expect(f.runtime.snapshot()?.operator.state).toBe("recovering");
  f.nativeBarrier.resolve(); await Promise.resolve();
  expect(f.counters().respawns).toBe(0);
  f.workerExit.resolve(); await reached(f, f.recoveryClosed.promise);
  const original = f.findExecution(ROOT)!, recovery = f.findExecution(RECOVERY)!;
  const child = f.store.allSkillExecutions(f.created.run_id).find((entry) => entry.parent_execution_id === recovery.execution_id)!;
  expect(original.status).toBe("unknown");
  expect(recovery.life_id).toBe(1); expect(child.life_id).toBe(2);
  expect(f.runtime.snapshot()).toMatchObject({ run_id: f.created.run_id, session_id: f.created.session_id, epoch: 1, life_id: 2, error: null });
  expect(eventDetails(f.store.getRun(f.created.run_id)!.baseline)?.inventory).toMatchObject({ oak_log: 3 });
  await expect(f.staleEffect()).rejects.toThrow();
  const executions = f.store.allSkillExecutions(f.created.run_id).length;
  const retry = await f.retryRoot(); expect(retry.isError).not.toBe(true);
  expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(executions);
  expect(f.counters()).toMatchObject({ disconnects: 0, respawns: 1, effects: 2, agents: 2 });
  const events = f.store.eventsAfter(f.created.run_id, 0, 500);
  expect(events.filter((event) => event.type === "learning.death_episode")).toHaveLength(1);
  expect(events.find((event) => event.type === "skill.life_adopted")?.details).toMatchObject({ previous_life_id: 1, life_id: 2 });
  await f.runtime.control(f.created.run_id, "stop");
  const continued = await f.runtime.createRun({ task: "A new baseline", goal: f.adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: "fixture-model" });
  expect(continued.skills.length).toBeGreaterThan(0); expect(continued.executions).toEqual([]);
  await f.runtime.control(continued.run_id, "start");
  expect(eventDetails(f.store.getRun(continued.run_id)!.baseline)?.inventory).toEqual({});
  await f.runtime.control(continued.run_id, "stop");
  const fresh = await f.runtime.createRun({ task: "Fresh definitions", goal: f.adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: "fixture-model", working_programs: "fresh" });
  expect(fresh.skills).toEqual([]); expect(fresh.executions).toEqual([]);
});

test("promotion selection follows actual recovery-root adoption without rewriting its immutable admission lineage", async () => {
  const f = await fixture({ recoveryInventory: true });
  f.die(); f.nativeBarrier.resolve(); f.workerExit.resolve();
  await reached(f, f.recoveryClosed.promise);
  const recovery = f.findExecution(RECOVERY)!;
  const run = f.store.getRun(f.created.run_id)!;
  const events = f.store.eventsAfter(run.run_id, 0, 500);
  const adopted = events.find(event => event.type === "skill.life_adopted")!;
  expect(recovery.life_id).toBe(1); expect(recovery.space_epoch).toBe(1);
  expect(run.life_id).toBe(2); expect(run.space_epoch).toBe(2);
  expect(eventDetails(adopted.details)).toMatchObject({ execution_id: recovery.execution_id,
    root_execution_id: recovery.execution_id, previous_life_id: 1, life_id: 2 });
  const observed = events.filter(event => event.type === "adapter.evidence" &&
    eventDetails(event.details)?.schema !== undefined).reverse().find(event => {
      const observation = eventDetails(eventDetails(event.details)?.data ?? null);
      const player = eventDetails(eventDetails(observation?.data ?? null)?.player ?? null);
      return Array.isArray(player?.inventory) && player.inventory.some(item =>
        eventDetails(item)?.name === "stone" && eventDetails(item)?.count === 2);
    })!;
  expect(observed).toBeDefined();
  const actionIds = qualifyMinecraftExperience(f.store, run, recovery, { portability: "world_local", retained_world_data: false,
    predicate: { kind: "inventory_gain", item: "stone", min_gain: 2, event_seq: observed.event_seq } });
  expect(actionIds).toHaveLength(1);
  expect(f.store.getAction(run.run_id, actionIds[0]!)?.view.scope).toMatchObject({ life_id: 2, space_epoch: 2 });
  expect(promotionEvidence(observed, run, recovery, events))
    .toEqual({ kind: "inventory_gain", counts: { stone: 2 } });
  for (const invalid of ["absent adoption", "wrong root", "wrong previous life", "wrong observation", "missing respawn", "unconfirmed respawn"] as const) {
    const context = structuredClone(events);
    const adoption = context.find(event => event.event_seq === adopted.event_seq)!;
    const details = eventDetails(adoption.details)!;
    if (invalid === "absent adoption") context.splice(context.indexOf(adoption), 1);
    if (invalid === "wrong root") details.execution_id = details.root_execution_id = "another-root";
    if (invalid === "wrong previous life") details.previous_life_id = 99;
    if (invalid === "wrong observation") details.observation_seq = 999999;
    if (invalid === "missing respawn") {
      const index = context.findIndex(event => event.type === "action.succeeded" &&
        eventDetails(event.details)?.action_id === details.respawn_action_id);
      expect(index).toBeGreaterThanOrEqual(0); context.splice(index, 1);
    }
    if (invalid === "unconfirmed respawn") {
      const receipt = context.find(event => event.type === "action.succeeded" &&
        eventDetails(event.details)?.action_id === details.respawn_action_id)!;
      eventDetails(receipt.details)!.result = { status: "unknown", summary: "Unconfirmed recovery", evidence: null };
    }
    expect({ invalid, selected: promotionEvidence(observed, run, recovery, context) })
      .toEqual({ invalid, selected: null });
  }
  await f.runtime.control(run.run_id, "stop");
});

test("cached respawn readiness does not block a chosen recovery or retrigger the same death", async () => {
  const f = await fixture(); f.holdRespawn(); f.die(false); f.nativeBarrier.resolve(); f.workerExit.resolve();
  await reached(f, f.respawnEntered.promise);
  expect(f.game.snapshot().life).toMatchObject({ status: "dead", life_id: 1, can_respawn: false });
  expect(f.runtime.snapshot()?.life_id).toBe(1);
  f.publishRespawnReady();
  expect(f.game.snapshot().life?.can_respawn).toBe(true);
  expect(f.counters()).toMatchObject({ agents: 2, respawns: 1 });
  f.proveRespawn(); await reached(f, f.recoveryClosed.promise);
  expect(f.runtime.snapshot()?.life_id).toBe(2);
  expect(f.store.eventsAfter(f.created.run_id, 0, 500).filter((event) => event.type === "learning.death_episode")).toHaveLength(1);
  await f.runtime.control(f.created.run_id, "stop");
});

test("ordinary pause and stop await native and isolated emitters but preserve the session and stream", async () => {
  const f = await fixture();
  const pausing = f.runtime.control(f.created.run_id, "pause"); f.finishFirst();
  await Promise.resolve(); expect(f.runtime.snapshot()?.status).toBe("pausing");
  f.workerExit.resolve(); await pausing;
  await f.runtime.control(f.created.run_id, "stop");
  expect(f.runtime.snapshot()?.status).toBe("stopped");
  expect(f.game.snapshot().status).toBe("connected"); expect(f.game.snapshot().video.status).toBe("streaming");
  expect(f.counters().barriers).toBeGreaterThan(0); expect(f.counters().disconnects).toBe(0);
  expect(f.store.eventsAfter(f.created.run_id, 0, 500).some((event) => event.type === "planning.requested")).toBe(false);
});

test("provider-paused Stop drains without treating the retained provider cause as cleanup failure", async () => {
  const f = await fixture({ providerFailure: true });
  f.finishFirst(); f.workerExit.resolve(); await reached(f, f.paused.promise);
  const paused = f.runtime.snapshot()!;
  expect(paused.operator).toMatchObject({ state: "provider_unavailable", pause_cause: "provider_failure", cleanup_error: null });
  expect(paused.error).not.toBeNull();
  f.holdBarrier();
  const stopping = f.runtime.control(f.created.run_id, "stop");
  await reached(f, f.barrierEntered.promise);
  expect(f.runtime.snapshot()).toMatchObject({ status: "stopping", error: paused.error,
    operator: { state: "stopping", cleanup_error: null } });
  f.nativeBarrier.resolve(); await stopping;
  expect(f.runtime.snapshot()).toMatchObject({ status: "stopped", error: paused.error,
    operator: { state: "stopped", cleanup_error: null } });
  expect(f.runtime.getRun(f.created.run_id)?.operator.pause_cause).toBe("provider_failure");
  expect(f.store.getRun(f.created.run_id)?.control).toEqual({ pause_cause: "provider_failure", cleanup_error: null });
  expect(f.counters()).toMatchObject({ effects: 1, agents: 1, disconnects: 0 });
});

test("Stop exposes retry only after an actual failed cleanup and clears it while retrying", async () => {
  const f = await fixture({ providerFailure: true });
  f.finishFirst(); f.workerExit.resolve(); await reached(f, f.paused.promise);
  const cause = f.runtime.snapshot()!.error;
  f.failCleanup();
  await expect(f.runtime.control(f.created.run_id, "stop")).rejects.toThrow("Shutdown could not be confirmed");
  expect(f.runtime.snapshot()).toMatchObject({ status: "stopping", error: cause });
  expect(f.runtime.snapshot()?.operator.cleanup_error).not.toBeNull();
  expect(f.store.getRun(f.created.run_id)?.control?.cleanup_error).not.toBeNull();
  f.restoreCleanup();
  const retrying = f.runtime.control(f.created.run_id, "stop");
  // Retry uses the fail-closed disconnect barrier rather than reopening effects.
  await retrying;
  expect(f.runtime.snapshot()).toMatchObject({ status: "stopped", error: cause,
    operator: { cleanup_error: null } });
  expect(f.counters()).toMatchObject({ effects: 1, agents: 1 });
});

test("explicit Resume keeps a provider-paused task and observes afresh without replaying its prior effect", async () => {
  const f = await fixture({ providerFailure: true });
  f.finishFirst(); f.workerExit.resolve(); await reached(f, f.paused.promise);
  const reads = f.counters().observationReads;
  await f.runtime.control(f.created.run_id, "resume");
  expect(f.runtime.snapshot()).toMatchObject({ task: f.created.task, status: "running", error: null,
    operator: { pause_cause: null, cleanup_error: null } });
  expect(f.counters().observationReads).toBeGreaterThan(reads);
  expect(f.counters()).toMatchObject({ effects: 1, agents: 2 });
  await f.runtime.control(f.created.run_id, "stop");
});

test("failed explicit Resume preserves the provider cause and original task without replaying an effect", async () => {
  const f = await fixture({ providerFailure: true });
  f.finishFirst(); f.workerExit.resolve(); await reached(f, f.paused.promise);
  const cause = f.runtime.snapshot()!.error;
  f.failPreparation();
  await f.runtime.control(f.created.run_id, "resume");
  expect(f.runtime.snapshot()).toMatchObject({ task: f.created.task, status: "paused", error: cause,
    operator: { pause_cause: "provider_failure", cleanup_error: null } });
  expect(f.counters()).toMatchObject({ effects: 1, agents: 1 });
  await f.runtime.control(f.created.run_id, "stop");
});

test("current-run progress survives unrelated events beyond the global event window", async () => {
  const f = await fixture();
  const progress = f.store.event(f.created.run_id, "skill.progress", "Returning with the second load", {
    execution_id: f.findExecution(ROOT)!.execution_id,
  });
  for (let index = 0; index < 510; index++)
    f.store.event(index % 2 ? null : f.created.run_id, "observation", "Unrelated observation");
  f.store.event(null, "skill.progress", "Another run must not replace current progress");
  expect(f.runtime.snapshot()?.operator.progress).toMatchObject({ event_seq: progress.event_seq,
    summary: "Returning with the second load", source: "model_program", verification: "unverified" });
  f.finishFirst(); f.workerExit.resolve();
  await f.runtime.control(f.created.run_id, "stop");
  expect(f.runtime.getRun(f.created.run_id)?.operator.progress?.event_seq).toBe(progress.event_seq);
});

test("blocked root remains an operator blockage without being relabeled as an active effect", async () => {
  const f = await fixture({ blockedRoot: true });
  const closed = Promise.withResolvers<void>();
  const unsubscribe = f.store.subscribe(event => {
    if (event.run_id === f.created.run_id && event.type === "skill.closed") closed.resolve();
  });
  f.finishFirst(); f.workerExit.resolve();
  try { await reached(f, closed.promise); } finally { unsubscribe(); }
  const root = f.findExecution(ROOT)!;
  expect(root.status).toBe("blocked");
  const run = f.store.getRun(f.created.run_id)!;
  run.model_status = "idle";
  expect(projectRunOperator(f.store, run, null, f.store.skillExecutions(run.run_id)).state).toBe("blocked");
  await f.runtime.control(f.created.run_id, "stop");
});

const next = (activation: "manual" | "on_predecessor_success" = "manual"): LookaheadConfig => ({ after_ms: 0, reason: "One independent follow-up", budget: { calls: 4, tools: 16, duration_ms: 30000 }, activation });

test("named root opt-in overlaps actual local continuation without exposing ordinary effects to the restricted planner", async () => {
  const f = await fixture({ next: next() }); f.holdSpec();
  const retry = await f.retryRoot(); expect(retry.isError).not.toBe(true);
  await reached(f, f.specEntered.promise);
  expect(f.advertised()).toContain("prepare_next");
  expect(f.advertised()).not.toContain("program_run");
  const written = await f.invoke("program_write", { name: "inactive prepared reference",
    source: 'return {status:"completed",summary:"Inactive reference",result:null};' });
  expect(written.isError).not.toBe(true);
  expect(f.store.namedSkill(f.created.run_id, "inactive prepared reference")?.entry).toBe("run");
  expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(1);
  const forbidden = await f.invoke("program_run", { operation: "start", name: FOLLOW, args: { mode: "follow-up" } });
  expect(forbidden).toMatchObject({ isError: true, details: { error: { code: "forbidden" } } });
  const plan = f.runtime.planningView(f.created.run_id)!;
  const events = f.store.eventsAfter(f.created.run_id, 0, 500);
  const request = events.find((event) => event.type === "model.call" && eventDetails(event.details)?.speculative_plan_id === plan.plan_id)!;
  expect(request).toBeDefined();
  f.finishFirst(); const receipt = await reached(f, f.firstEffectReceipt.promise); await reached(f, f.tailEntered.promise);
  expect(receipt).toBeGreaterThan(request.event_seq);
  expect(f.findExecution(ROOT)?.status).toBe("running");
  f.releaseSpec(); await reached(f, f.staged.promise);
  expect(f.runtime.planningView(f.created.run_id)?.state).toBe("staged");
  expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(1);
  f.workerExit.resolve(); await f.runtime.control(f.created.run_id, "stop");
  expect(f.runtime.planningView(f.created.run_id)?.state).toBe("invalidated");
});

test("explicit game-guard repair stays inside the same planning flight and does not create another root", async () => {
  const f = await fixture({ next: next(), repairGuard: true, guardSource: "return observation.data.player.health > 0;" });
  const rejected = await reached(f, f.rejectedGuard.promise);
  expect(rejected.result).toMatchObject({ error: { code: "invalid_program", retryable: false, stage_correction: { correction_allowed: true, remaining_calls: 3 } } });
  await reached(f, f.staged.promise);
  expect(f.runtime.planningView(f.created.run_id)).toMatchObject({ state: "staged", calls: 2, deadline_at: rejected.deadline_at });
  expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(1);
  f.finishFirst(); f.workerExit.resolve(); await f.runtime.control(f.created.run_id, "stop");
});

for (const order of ["stage-first", "closure-first"] as const) {
  test(`preauthorized ${order} continuation starts one fresh named successor without another model request`, async () => {
    const f = await fixture({ next: next("on_predecessor_success"), holdWorkerExit: true });
    if (order === "closure-first") f.holdSpec();
    await reached(f, f.specEntered.promise);
    if (order === "stage-first") await reached(f, f.staged.promise);
    f.finishFirst(); await reached(f, f.tailEntered.promise); f.finishTail();
    await reached(f, f.rootSourceFinished.promise);
    expect(f.findExecution(FOLLOW)).toBeNull();
    f.workerExit.resolve(); await reached(f, f.rootDrained.promise);
    if (order === "closure-first") {
      expect(f.runtime.planningView(f.created.run_id)).toMatchObject({ state: "planning", planning_active: true });
      f.releaseSpec();
    }
    await reached(f, f.successorClosed.promise);
    expect(f.runtime.planningView(f.created.run_id)).toMatchObject({ state: "activated", guard_status: "omitted" });
    expect(f.counters()).toMatchObject({ effects: 3, guardCalls: 0, prompts: 2 });
    expect(f.store.allSkillExecutions(f.created.run_id).filter((entry) => entry.parent_execution_id === null)).toHaveLength(2);
    await f.runtime.control(f.created.run_id, "stop");
  });
}

test("a false optional game guard blocks automatic effects without changing the user predicate", async () => {
  const f = await fixture({ next: next("on_predecessor_success"), guardSource: "return observation.data.player.health > args.minimum;", guardResult: false });
  await reached(f, f.staged.promise); f.finishFirst(); await reached(f, f.tailEntered.promise); f.finishTail(); f.workerExit.resolve();
  await reached(f, f.rootDrained.promise);
  await reached(f, f.continuationSettled.promise);
  expect(f.runtime.planningView(f.created.run_id)).toMatchObject({ state: "rejected", guard_status: "failed" });
  expect(f.findExecution(FOLLOW)).toBeNull(); expect(f.counters().effects).toBe(2); expect(f.counters().guardCalls).toBe(1);
  await f.runtime.control(f.created.run_id, "stop");
});

test("verified completion allows only a linked candidate artifact review and preserves streaming", async () => {
  const f = await fixture({ goal: "collect_wood" }); f.collectGoal();
  const review = await reached(f, f.reviewed.promise); await reached(f, f.completed.promise);
  expect(review).toMatchObject({ name: ROOT, version: 2 });
  expect(f.runtime.snapshot()).toMatchObject({ status: "completed", error: null });
  expect(f.store.allSkillExecutions(f.created.run_id).some((entry) => entry.version === 2)).toBe(false);
  expect(f.counters()).toMatchObject({ effects: 1, respawns: 0, disconnects: 0 });
  expect(f.game.snapshot().video.status).toBe("streaming");
});

for (const customCompletion of ["after-root", "with-pending-root"] as const) {
  test(`custom task_finish fences admission before draining ${customCompletion} without verification or post-goal inference`, async () => {
    const f = await fixture({ customCompletion });
    f.holdBarrier();
    f.finishFirst();
    // The ordinary tool must return while neutralization is still held. Awaiting
    // strategic.close() inside that tool would deadlock on its own active prompt.
    await reached(f, f.finishReturned.promise);
    await reached(f, f.barrierEntered.promise);
    expect(f.findExecution(ROOT)?.status).toBe("succeeded");
    expect(f.runtime.snapshot()).toMatchObject({ status: "stopping", error: null });
    expect(f.store.getRun(f.created.run_id)?.status).toBe("stopping");
    expect(f.contexts).toHaveLength(2);
    expect(f.contexts[1]).toMatchObject({
      phase: "running", role: "planning", speculative_plan: null,
      adapter_metadata: { inventory_counts: { dirt: 1 } },
    });
    const reported = f.store.eventsAfter(f.created.run_id, 0, 500).filter((event) => event.type === "task.completion_reported");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.details).toMatchObject({
      summary: "Collected one dirt block; fresh inventory contains dirt", verification: "unverified",
    });
    const effects = customCompletion === "with-pending-root" ? 2 : 1;
    expect(f.counters().effects).toBe(effects);
    const executions = f.store.allSkillExecutions(f.created.run_id).length;
    await expect(f.staleEffect()).rejects.toThrow();
    const forbiddenStart = await f.invoke("program_run", { operation: "start", name: FOLLOW, args: { mode: "after-finish" }, limits: DEFAULT_SKILL_LIMITS });
    expect(forbiddenStart.isError).toBe(true);
    expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(executions);
    expect(f.runtime.snapshot()?.status).toBe("stopping");
    expect(f.counters().effects).toBe(effects);

    f.nativeBarrier.resolve();
    await reached(f, f.stopped.promise);
    expect(f.runtime.snapshot()).toMatchObject({
      status: "stopped", error: null, session_id: f.created.session_id, epoch: 1, life_id: 1,
      operator: { completion: "model_reported_unverified" },
    });
    expect(f.store.getRun(f.created.run_id)).toMatchObject({ status: "stopped", error: null });
    expect(f.store.getRun(f.created.run_id)?.ended_at).not.toBeNull();
    if (customCompletion === "with-pending-root") expect(f.findExecution(FOLLOW)?.status).toBe("cancelled");
    const events = f.store.eventsAfter(f.created.run_id, 0, 500);
    const reports = events.filter((event) => event.type === "task.completion_reported");
    expect(reports).toEqual(reported);
    expect(events.some((event) => event.type === "goal.verified")).toBe(false);
    expect(events.filter((event) => event.type === "model.call")).toHaveLength(2);
    expect(events.some((event) => event.event_seq > reports[0]!.event_seq && event.type === "model.call")).toBe(false);
    expect(f.contexts).toHaveLength(2);
    expect(f.contexts.some((context) => context.phase === "reviewing" || context.role === "review")).toBe(false);
    expect(f.counters()).toMatchObject({ effects, agents: 1, respawns: 0, disconnects: 0 });
    expect(f.game.snapshot()).toMatchObject({
      status: "connected", session_id: f.created.session_id, life: { status: "alive", life_id: 1 },
      video: { status: "streaming", error: null },
    });
  });
}

test("task_finish cannot replace the trusted verifier for a built-in goal", async () => {
  const f = await fixture({ goal: "collect_wood" });
  const result = await f.invoke("task_finish", { summary: "Collected one dirt block; fresh inventory contains dirt" });
  expect(result.isError).toBe(true);
  expect(f.runtime.snapshot()).toMatchObject({ status: "running", error: null });
  expect(f.store.getRun(f.created.run_id)?.status).toBe("running");
  expect(f.findExecution(ROOT)?.status).toBe("running");
  const events = f.store.eventsAfter(f.created.run_id, 0, 500);
  expect(events.some((event) => event.type === "task.completion_reported" || event.type === "goal.verified")).toBe(false);
  expect(f.counters()).toMatchObject({ effects: 1, disconnects: 0 });
  f.finishFirst(); f.workerExit.resolve();
  await f.runtime.control(f.created.run_id, "stop");
});

test("break_log uses a block-removal receipt without fabricating inventory gain", async () => {
  const f = await fixture({ goal: "break_log", initialAction: { kind: "dig", target: { target_id: "authorized-fixture-log", incarnation: 1,
    space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, life_id: 1 } } }); f.removeLog();
  await reached(f, f.completed.promise);
  const verified = f.store.eventsAfter(f.created.run_id, 0, 500).find((event) => event.type === "goal.verified")!;
  expect(f.runtime.snapshot()?.operator.completion).toBe("verified");
  expect(verified.details).toMatchObject({ status: "verified", verifier_id: "minecraft_block_removal_v2", verifier_version: 2 });
  expect(verified.details).not.toHaveProperty("current_count");
  expect(eventDetails(f.game.snapshot().presentation?.metadata ?? null)?.inventory_counts).toMatchObject({ oak_log: 3 });
});

test("healthy uncertainty drains and observes afresh before one new strategy generation, never replaying the effect", async () => {
  const f = await fixture(); const reads = f.counters().observationReads;
  f.holdBarrier(); f.unknown(false); await reached(f, f.uncertaintyFenced.promise);
  f.nativeBarrier.resolve(); await Promise.resolve(); expect(f.counters().agents).toBe(1);
  f.workerExit.resolve(); await reached(f, f.replanned.promise);
  expect(f.runtime.snapshot()).toMatchObject({ status: "running", error: null });
  expect(f.findExecution(ROOT)?.status).toBe("unknown"); expect(f.runtime.snapshot()?.action?.status).toBe("unknown");
  expect(f.counters()).toMatchObject({ effects: 1, agents: 2, disconnects: 0 });
  expect(f.counters().observationReads).toBeGreaterThan(reads);
  expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(1);
  await expect(f.staleEffect()).rejects.toThrow();
  await f.runtime.control(f.created.run_id, "stop");
});

for (const unavailable of ["barrier", "observation"] as const) {
  test(`unknown reconciliation remains paused with the healthy session intact when ${unavailable} is unavailable`, async () => {
    const f = await fixture(); if (unavailable === "barrier") f.failBarrier(); else f.failObservation();
    f.unknown(); await reached(f, f.paused.promise);
    expect(f.runtime.snapshot()?.status).toBe("paused"); expect(f.runtime.snapshot()?.error).not.toBeNull();
    expect(f.findExecution(ROOT)?.status).toBe("unknown");
    expect(f.counters()).toMatchObject({ effects: 1, agents: 1, disconnects: 0 });
    expect(f.game.snapshot().video.status).toBe("streaming");
  });
}

test("Stop wins in-flight uncertainty reconciliation without reopening authority", async () => {
  const f = await fixture(); f.holdBarrier(); f.unknown(false); await reached(f, f.uncertaintyFenced.promise);
  const stopping = f.runtime.control(f.created.run_id, "stop"); f.nativeBarrier.resolve(); f.workerExit.resolve(); await stopping;
  expect(f.runtime.snapshot()?.status).toBe("stopped"); expect(f.counters()).toMatchObject({ effects: 1, agents: 1, disconnects: 0 });
});

test("death supersedes uncertainty and wakes only the explicit recovery generation", async () => {
  const f = await fixture(); f.holdBarrier(); f.unknown(false); await reached(f, f.uncertaintyFenced.promise);
  f.die(false); f.nativeBarrier.resolve(); f.workerExit.resolve(); await reached(f, f.recoveryClosed.promise);
  expect(f.runtime.snapshot()).toMatchObject({ status: "running", life_id: 2 });
  expect(f.counters()).toMatchObject({ agents: 2, respawns: 1, effects: 2, disconnects: 0 });
  await f.runtime.control(f.created.run_id, "stop");
});

test("named source and comparisons cannot read another model's workspace", async () => {
  const f = await fixture();
  const foreign = { ...f.store.getRun(f.created.run_id)!, run_id: crypto.randomUUID(), model_id: "other-model" }; f.store.saveRun(foreign);
  await Promise.all([1, 2].map(async (version) => f.store.registerSkill(foreign.run_id, await validateSkill({ entry: "run", name: "Foreign private program", source: `return {status:"completed",summary:"PRIVATE_MODEL_B_${version}",result:null};`, card, dependencies: [] }, f.adapter))));
  const skill = f.store.skill.bind(f.store); let foreignReads = 0;
  f.store.skill = (runId, ref) => { if (runId === foreign.run_id) foreignReads++; return skill(runId, ref); };
  const compared = await f.invoke("program_inspect", { view: "comparison", before: { name: "Foreign private program", version: 1 }, after: { name: "Foreign private program", version: 2 } });
  expect(compared).toMatchObject({ isError: true, details: { error: { code: "not_found" } } });
  expect(JSON.stringify(compared)).not.toContain("PRIVATE_MODEL_B"); expect(foreignReads).toBe(0);
  f.finishFirst(); f.workerExit.resolve(); await f.runtime.control(f.created.run_id, "stop");
});

test("named revision pins the original running version and trusted call retries cannot select today's latest", async () => {
  const f = await fixture(); const original = f.store.namedSkill(f.created.run_id, ROOT, 1)!;
  const written = await f.invoke("program_write", { name: ROOT, based_on: 1, source: 'await game.observe(); return {status:"blocked",summary:"Unmeasured candidate",result:null};', card, dependencies: [] });
  expect(written.details).toMatchObject({ name: ROOT, version: 2 });
  const retry = await f.retryRoot(); expect(retry.isError).not.toBe(true);
  expect(f.findExecution(ROOT)).toMatchObject({ version: 1, status: "running" });
  expect(f.store.allSkillExecutions(f.created.run_id)).toHaveLength(1);
  expect(f.store.skill(f.created.run_id, original)).toMatchObject({ source: original.source, hash: original.hash });
  const stale = await f.invoke("program_write", { name: ROOT, based_on: 1, source: 'return {status:"blocked",summary:"Stale candidate",result:null};', card, dependencies: [] });
  expect(stale).toMatchObject({ isError: true, details: { error: { code: "conflict", issues: [{ latest_parent: { name: ROOT, version: 2 } }] } } });
  f.finishFirst(); f.workerExit.resolve(); await f.runtime.control(f.created.run_id, "stop");
});

test("a revision reason links the exact candidate experiment without a bookkeeping-only model call", async () => {
  const f = await fixture();
  const original = f.store.namedSkill(f.created.run_id, ROOT, 1)!;
  const published = Promise.withResolvers<void>(), commit = f.store.commitHistoryProjectionBatch.bind(f.store);
  let through = Number.POSITIVE_INFINITY;
  const publication = vi.spyOn(f.store, "commitHistoryProjectionBatch").mockImplementation((runId, batch) => {
    commit(runId, batch);
    if (runId === f.created.run_id && batch.after.phase === "idle" && batch.after.source_through >= through)
      published.resolve();
  });
  try {
    f.unknown(); await reached(f, f.replanned.promise);
    // Replanning admits strategy, not history publication. Join the real
    // background writer's fixed committed frontier; feedback remains readonly.
    through = f.store.historySourceHighwater(f.created.run_id);
    if ((f.store.historyProjectionGeneration(f.created.run_id)?.source_through ?? -1) >= through)
      published.resolve();
    await reached(f, published.promise);
  } finally {
    publication.mockRestore();
  }
  const execution = f.findExecution(ROOT)!;
  const closed = f.store.eventsAfter(f.created.run_id, 0, 500).find(event =>
    event.type === "skill.closed" && eventDetails(event.details)?.execution_id === execution.execution_id)!;
  const parent = { run_id: f.created.run_id, skill_id: original.skill_id, version: original.version, hash: original.hash };
  const before = f.store.evidenceObjects<ImprovementOpportunity>(f.created.run_id, "opportunity");
  expect(execution.status).toBe("unknown");
  expect(before).toEqual([expect.objectContaining({
    kind: "failure", version: parent, execution_id: execution.execution_id, event_seqs: [closed.event_seq], resolution: null,
  })]);
  const opportunity = before[0]!;
  expect(f.store.latestOpportunityForVersion(parent)?.opportunity_id).toBe(opportunity.opportunity_id);
  const feedback = await f.invoke("program_inspect", { view: "feedback", program: { name: ROOT, version: 1 } });
  expect(feedback.isError).not.toBe(true);
  expect(f.store.evidenceObjects<ImprovementOpportunity>(f.created.run_id, "opportunity")).toEqual(before);
  const input = { name: ROOT, based_on: 1, reason: "Choose this candidate experiment without claiming proven efficacy", source: 'await game.observe(); return {status:"blocked",summary:"Candidate awaiting independent measurement",result:null};', card, dependencies: [] };
  const written = await f.invoke("program_write", input, "write-candidate-experiment");
  expect(written.isError).not.toBe(true);
  expect(written.details).toMatchObject({ name: ROOT, version: 2, experiment: { decision: "revise", measured: false, qualification: "candidate_not_proven_improvement" } });
  const candidate = f.store.namedSkill(f.created.run_id, ROOT, 2)!;
  const resolved = f.store.evidenceObjects<ImprovementOpportunity>(f.created.run_id, "opportunity");
  expect(resolved).toEqual([{ ...opportunity, resolution: {
    decision: "revise", reason: input.reason, measured: false, event_seqs: opportunity.event_seqs, at: expect.any(String),
    revision: { run_id: f.created.run_id, skill_id: candidate.skill_id, version: candidate.version, hash: candidate.hash },
  } }]);
  expect(candidate).toMatchObject({ skill_id: original.skill_id, parent_version: original.version });
  const links = f.store.eventsAfter(f.created.run_id, 0, 500).filter(event =>
    event.type === "learning.resolved" || event.type === "learning.candidate_written");
  expect(links).toHaveLength(1);
  expect(links[0]!.details).toMatchObject({ opportunity_id: opportunity.opportunity_id, decision: "revise" });
  const replay = await f.invoke("program_write", input, "write-candidate-experiment");
  expect(replay.isError).not.toBe(true);
  expect(replay.details).toEqual(written.details);
  expect(f.store.evidenceObjects<ImprovementOpportunity>(f.created.run_id, "opportunity")).toEqual(resolved);
  expect(f.store.eventsAfter(f.created.run_id, 0, 500).filter(event =>
    event.type === "learning.resolved" || event.type === "learning.candidate_written")).toEqual(links);
  expect(f.store.namedSkill(f.created.run_id, ROOT)?.version).toBe(2);
  expect(f.store.namedSkill(f.created.run_id, ROOT, 1)).toEqual(original);
  expect(f.store.allSkillExecutions(f.created.run_id)).toEqual([execution]);
  expect(f.runtime.snapshot()?.action?.status).toBe("unknown");
  expect(f.counters()).toMatchObject({ effects: 1, agents: 2, prompts: 2, disconnects: 0 });
  expect(f.store.eventsAfter(f.created.run_id, 0, 500).filter(event => event.type === "model.call")).toHaveLength(2);
  await expect(f.staleEffect()).rejects.toThrow();
  await f.runtime.control(f.created.run_id, "stop");
  expect(f.runtime.snapshot()?.status).toBe("stopped");
  expect(f.store.allSkillExecutions(f.created.run_id)).toEqual([execution]);
  expect(f.counters()).toMatchObject({ effects: 1, agents: 2, prompts: 2, disconnects: 0 });
});

test("planning retains the actual predecessor after more than one hundred sequential named child calls", async () => {
  // This real fsync-backed proof exceeded the suite's generic 5s allowance.
  const began = performance.now();
  const f = await fixture({ childCalls: 101, next: next(), holdWorkerExit: true });
  let phase = "startup";
  const phases: { phase: string; duration_ms: number }[] = [{ phase, duration_ms: performance.now() - began }];
  const stalled = Promise.withResolvers<never>();
  const watchdog = setTimeout(() => {
    const root = f.findExecution(ROOT);
    stalled.reject(new Error(`Named-child proof stalled: ${JSON.stringify({ phase, elapsed_ms: performance.now() - began, phases, root: root ? { status: root.status, calls: root.calls } : null, counters: f.counters(), plan: f.runtime.planningView(f.created.run_id) })}`));
  }, Math.max(1, 12000 - (performance.now() - began)));
  const step = async <T>(name: string, operation: Promise<T>): Promise<T> => {
    phase = name; const start = performance.now();
    try { return await Promise.race([operation, stalled.promise, f.failure.promise]); }
    finally { phases.push({ phase: name, duration_ms: performance.now() - start }); }
  };
  try {
    f.finishFirst(); await step("101 durable named children", f.tailEntered.promise);
    const root = f.findExecution(ROOT)!;
    if (root.entry !== "run") throw new Error("Expected the selected run root");
    expect(root.status).toBe("running"); expect(root.calls).toBeLessThan(root.limits.max_calls);
    const children = f.store.allSkillExecutions(f.created.run_id).filter((entry) => entry.parent_execution_id === root.execution_id);
    expect(children).toHaveLength(101); expect(children.every((entry) => entry.status === "succeeded")).toBe(true);
    expect(f.store.skillExecutions(f.created.run_id)).toHaveLength(100);
    expect(f.store.skillExecutions(f.created.run_id).some((entry) => entry.execution_id === root.execution_id)).toBe(false);
    await step("stage exact candidate", f.staged.promise);
    expect(f.runtime.planningView(f.created.run_id)?.basis.root.execution_id).toBe(root.execution_id);
    f.finishTail(); await step("source finished before worker drain", f.rootSourceFinished.promise);
    expect(f.runtime.snapshot()?.operator.state).toBe("executing");
    f.workerExit.resolve(); await step("actual predecessor drain", f.rootDrained.promise);
    const activated = await step("explicit named activation", f.invoke("program_run", { operation: "activate_next" }));
    expect(activated.isError).not.toBe(true); expect(f.runtime.planningView(f.created.run_id)?.state).toBe("activated");
    expect(f.findExecution(FOLLOW)).not.toBeNull();
  } finally {
    clearTimeout(watchdog);
    f.finishFirst(cancelled); f.finishTail(); f.workerExit.resolve(); f.releaseSpec(); await f.runtime.control(f.created.run_id, "stop");
  }
}, 15000);
