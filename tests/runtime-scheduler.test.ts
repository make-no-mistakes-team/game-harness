import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type {
  AuthState,
  BridgeNotice,
  GameBridge,
  GameState,
  ObservationV3,
} from "../src/shared/contracts.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { Runtime } from "../src/server/runtime.ts";
import { Store } from "../src/server/store.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
import type { Database } from "bun:sqlite";
import { DEFAULT_RESIDENT_LIMITS, type ControllerStepResult } from "../src/shared/resident.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
const resources: { runtime: Runtime; store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.runtime.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

for (const backlog of [0, 501]) test(`Runtime resident attention reaches the real serialized strategist across ${backlog} unread progress events while diagnostics do not replan`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-resident-attention-")), store = new Store(directory);
  const adapter = minecraftTestAdapter(), observation = minecraftObservationFixture(adapter);
  const state: GameState = { status: "connected", username: "Fixture", version: "1.21.4", world_id: observation.world_id,
    epoch: observation.epoch, session_id: observation.session_id, life: observation.life,
    binding: minecraftTestBinding(adapter), space: observation.space, screen: null, presentation: adapter.projectObservation(observation),
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, error: null };
  let sample = 0;
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {}, snapshot: () => state, observe: async () => observation,
    execute: async () => { throw new Error("Resident attention has no finite action"); },
    cancel: async () => {}, neutralize: async () => {}, emergencyStop: async () => {},
    adapter: () => adapter, subscribe: () => () => {},
    openController: async (reservation, generation) => {
      const owner = { operation_id: reservation.operation_id, generation: 1, scope: reservation.scope };
      let retired = false;
      return { owner, controllerGeneration: generation,
        sample: async () => {
          const frame = controllerFrameFixture(observation.life.life_id, observation.space.space_epoch);
          frame.frame_seq = ++sample; frame.native_tick = sample; frame.captured_native_ns = String(sample * 50000000);
          return jsonSchema.parse(frame);
        },
        submit: () => { throw new Error("Neutral resident must not submit input"); }, renew: async () => {},
        revoke: async () => {
          retired = true;
          return { owner, controller_generation: generation, admission_revoked: true, last_applied_sequence: 0,
            ordered_edge_prefix: 0, retirement_applied_native_tick: sample, retirement_applied_native_ns: String(sample * 50000000),
            input_application: "confirmed", unresolved_operation_refs: [] };
        },
        snapshot: () => ({ fenced: retired, retired, submitted_sequence: 0, applied_sequence: 0, ordered_edge_prefix: 0,
          pending_frames: 0, pending_edges: 0, last_input: null, reason: null }) };
    },
  };
  let attentionReady = false, attentionEmitted = false;
  const contexts: Record<string, any>[] = [];
  const gates: ({ stop?: boolean; reason?: string } | undefined)[][] = [];
  let written: unknown, started: unknown, promptFailure: unknown;
  let tools: AgentTool[] = [], gate: Parameters<Agent["setBeforeModelCall"]>[0], creates = 0, active = 0, maximumActive = 0, steps = 0;
  const fakeAgent = { setBeforeModelCall: (hook: typeof gate) => { gate = hook; },
    setTools: (selected: AgentTool[]) => { tools = selected; }, subscribe: () => () => {},
    replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
    prompt: async (text: string) => {
      active++; maximumActive = Math.max(maximumActive, active);
      try {
        contexts.push(JSON.parse(text));
        const turnGates = [(await gate?.({ systemPrompt: [], messages: [], tools: [] })) ?? undefined];
        gates.push(turnGates);
        if (contexts.length === 1) {
          written = (await tools.find(tool => tool.name === "program_write")!.execute("resident-write", {
            entry: "step", name: "Attention resident", source: "export function step(frame,state,intent) { return {input:{kind:'world',held:{forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false,attack:false,use:false},edges:[],view:{kind:'unchanged'},selected_hotbar:null},next_state:state,status:'running',events:[]}; }",
            dependencies: [], card: { purpose: "Authored attention", applicability: "Fixture", method: "Bounded event",
              reason: "Strategic routing regression", limitations: "No gameplay claim" },
          })).details;
          started = (await tools.find(tool => tool.name === "program_run")!.execute("resident-start", { operation: "start", entry: "step",
            name: "Attention resident", args: null, initial_state: null,
            limits: { ...DEFAULT_RESIDENT_LIMITS, frequency_hz: 20, duration_ms: 10000 } })).details;
        }
        turnGates.push((await gate?.({ systemPrompt: [], messages: [], tools: [] })) ?? undefined);
      } catch (error) {
        promptFailure = error;
        throw error;
      } finally { active--; }
    } };
  const auth = { snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
    models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null }),
    createAgent: async (options: { tools: AgentTool[] }) => { creates++; tools = options.tools; return fakeAgent as unknown as Agent; },
    releaseAgent: async () => {} } as unknown as AuthManager;
  const neutral: ControllerStepResult["input"] = { kind: "world",
    held: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, attack: false, use: false },
    edges: [], view: { kind: "unchanged" }, selected_hotbar: null };
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    createResidentAnalysisWorker: async () => { throw new Error("Attention regression must not request analysis computation"); },
    createResidentWorker: async () => ({
      step: async (): Promise<ControllerStepResult> => {
        const step = steps++;
        const emitAttention = attentionReady && !attentionEmitted;
        if (emitAttention) attentionEmitted = true;
        return { input: neutral, next_state: null, status: "running", events: step === 0
          ? [{ kind: "diagnostic", urgency: "urgent", summary: "Diagnostic is not replan demand", details: { marker: "diagnostic" } }]
          : emitAttention ? [
            { kind: "attention", urgency: "ordinary", summary: "Inventory changed near the workshop", details: { material: "oak_planks", count: 4 } },
            { kind: "attention", urgency: "urgent", summary: "Need a new target", details: { reason: "observed obstruction" } },
          ] : [] };
      }, close: async () => {},
    }) } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
  resources.push({ runtime, store, directory });
  const eventWaits: { promise: Promise<void>; cancel: () => void }[] = [];
  const event = (type: string) => {
    const done = Promise.withResolvers<void>();
    const off = store.subscribe(entry => {
      if (entry.type === type) { off(); done.resolve(); }
      else if (entry.type === "scheduler.turn_failed" || entry.type === "skill.closed") {
        off(); done.reject(new Error(`Waiting for ${type}, but fixture emitted ${entry.type}: ${entry.summary}; prompt failure: ${String(promptFailure)}; tool results: ${JSON.stringify({ written, started })}`));
      }
    });
    void done.promise.catch(() => {});
    eventWaits.push({ promise: done.promise, cancel: () => {
      off(); done.reject(new Error(`Fixture finished before ${type}`));
    } });
    return done.promise;
  };
  try {
  await runtime.initialize();
  const run = await runtime.createRun({ task: "Observe bounded resident attention", goal: adapter.goals.find(goal => goal.goal_id === "custom")!,
    model_id: "fixture-model" });
  const initial = event("scheduler.turn_finished"), diagnostic = event("controller.event");
  await runtime.control(run.run_id, "start"); await initial;
  expect(written).toMatchObject({ entry: "step" });
  expect(started).toMatchObject({ entry: "step" });
  expect(gates[0]?.[0]?.stop).not.toBe(true);
  expect(gates[0]?.[1]?.stop).toBe(true);
  await diagnostic;
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(contexts).toHaveLength(1);
  for (let index = 0; index < backlog; index++)
    store.event(run.run_id, "controller.progress", "Retained non-waking controller progress", { sample: index });
  const replanned = event("scheduler.turn_finished"); attentionReady = true; await replanned;
  expect(contexts).toHaveLength(2); expect(creates).toBe(1); expect(maximumActive).toBe(1);
  expect(gates[1]?.[0]?.stop).not.toBe(true);
  expect(gates[1]?.[1]?.stop).toBe(true);
  expect(runtime.snapshot()?.executions[0]).toMatchObject({ entry: "step", status: "running" });
  expect(contexts[1]!.reason).toContain("resident_attention");
  expect(contexts[1]!.feedback).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "controller.event", summary: "Inventory changed near the workshop", details:
      expect.objectContaining({ event: { kind: "attention", urgency: "ordinary", summary: "Inventory changed near the workshop",
        details: { material: "oak_planks", count: 4 } } }) }),
    expect.objectContaining({ type: "controller.event", summary: "Need a new target", details:
      expect.objectContaining({ event: { kind: "attention", urgency: "urgent", summary: "Need a new target",
        details: { reason: "observed obstruction" } } }) }),
  ]));
  expect(Buffer.byteLength(JSON.stringify(contexts[1]!.feedback))).toBeLessThanOrEqual(8192);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(contexts).toHaveLength(2);
  } finally {
    for (const wait of eventWaits) wait.cancel();
    await Promise.allSettled(eventWaits.map(wait => wait.promise));
  }
});

test("a pending program stays unpolled and native first-cause remains immutable across a replacement-session new run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-scheduler-")),
    store = new Store(directory), adapter = minecraftTestAdapter();
  const worldId = crypto.randomUUID();
  const observation = minecraftObservationFixture(adapter, { world_id: worldId, session_id: "fixture-session" });
  observation.data.blocks.push({ target: { target_id: "observed-block", incarnation: 1, space: observation.space, life_id: 1 },
    name: "stone", position: { x: .5, y: 63.5, z: .5 }, observed_at: new Date().toISOString(), current: true });
  let state: GameState = {
    status: "connected",
    username: "Fixture",
    version: "1.21.4",
    world_id: worldId,
    epoch: 1,
    session_id: observation.session_id,
    life: observation.life,
    binding: minecraftTestBinding(adapter), space: observation.space, screen: null, presentation: adapter.projectObservation(observation),
    video: {
      status: "idle",
      width: 0,
      height: 0,
      fps: null,
      frames: 0,
      last_frame_at: null,
      error: null,
    },
    last_observation_at: observation.captured_at,
    error: null,
  };
  const gameListeners = new Set<(notice: BridgeNotice) => void>();
  let gameExecutions = 0;
  const game: GameBridge = {
    connect: async () => {},
    disconnect: async () => {
      state = {
        ...state,
        status: "disconnected",
        error: "The native control stream ended",
      };
      for (const listener of gameListeners)
        listener({ type: "state", data: null });
    },
    snapshot: () => state,
    observe: async () => observation,
    execute: async () => {
      gameExecutions++;
      return {
        status: "succeeded",
        summary: "Confirmed neutral fixture action",
        evidence: { effect_confirmed: true },
      };
    },
    cancel: async () => {},
    neutralize: async () => {},
    adapter: () => adapter,
    emergencyStop: async () => {},
    subscribe: (listener) => {
      gameListeners.add(listener);
      return () => {
        gameListeners.delete(listener);
      };
    },
  };
  let tools: AgentTool[] = [],
    gate: Parameters<Agent["setBeforeModelCall"]>[0],
    listener: ((event: AgentEvent) => void) | null = null;
  let initialized = false,
    prompts = 0,
    failNextAgent = false;
  const running = Promise.withResolvers<void>(),
    settled = Promise.withResolvers<void>();
  const contexts: Record<string, unknown>[] = [];
  const fakeAgent = {
    setBeforeModelCall: (hook: typeof gate) => {
      gate = hook;
    },
    setTools: (selected: AgentTool[]) => {
      tools = selected;
    },
    subscribe: (callback: (event: AgentEvent) => void) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    replaceMessages: () => {},
    abort: () => {},
    waitForIdle: async () => {},
    prompt: async (text: string) => {
      prompts++;
      const context = JSON.parse(text) as Record<string, unknown>;
      contexts.push(context);
      await gate?.({ systemPrompt: [], messages: [], tools: [] });
      if (!initialized) {
        initialized = true;
        expect(context.phase).toBe("running");
        const observed = await tools.find((tool) => tool.name === "observe")!.execute("observe", {});
        expect(observed.details.data.player).toMatchObject({ health: 20 });
        await tools
          .find((tool) => tool.name === "program_write")!
          .execute("register", {
              name: "Neutral observer",
              source:
                'for (let step = 0; step < 2; step++) { await game.observe(); const result = await game.action({kind:"look",yaw:step * 0.1,pitch:0}); if (result.status !== "succeeded") return {status:"blocked",summary:"Neutral fixture action did not succeed",result}; } return {status:"completed",summary:"Bounded neutral flow settled",result:null};',
              card: {
                purpose: "Observe authorized state",
                applicability: "Connected fixture",
                method: "Request filtered observation",
                reason: "Exercise program lifecycle",
                limitations: "No gameplay effectiveness claim",
              },
              dependencies: [],
          });
        await tools
          .find((tool) => tool.name === "program_run")!
          .execute("start", {
            operation: "start",
            name: "Neutral observer",
            args: null,
            limits: { ...DEFAULT_SKILL_LIMITS },
          });
        const stopped = await gate?.({
          systemPrompt: [],
          messages: [],
          tools: [],
        });
        expect(stopped?.stop).toBe(true);
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: stopped?.reason,
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        } as unknown as AgentEvent);
      }
    },
  };
  const authState: AuthState = {
    status: "ready",
    authenticated: true,
    provider: "openai-codex",
    account_label: null,
    models: [
      {
        id: "fixture-model",
        name: "Fixture",
        provider: "fixture",
        context_window: null,
      },
    ],
    login: null,
    error: null,
  };
  const auth = {
    snapshot: () => authState,
    createAgent: async (options: { tools: AgentTool[] }) => {
      if (failNextAgent) {
        failNextAgent = false;
        throw new Error("Fixture provider preparation failed");
      }
      tools = options.tools;
      return fakeAgent as unknown as Agent;
    },
    releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = {
    snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    runSkill: async (
      _source: unknown,
      _args: unknown,
      handle: (
        request: import("../src/shared/programs.ts").SkillCapabilityRequest,
      ) => Promise<import("../src/shared/contracts.ts").Json>,
      _limits: unknown,
      signal: AbortSignal,
    ) => {
      const abort = Promise.withResolvers<never>();
      signal.addEventListener(
        "abort",
        () => abort.reject(new Error("Confirmed fixture worker cancellation")),
        { once: true },
      );
      for (let step = 0; step < 2; step++) {
        await handle({ kind: "observe" });
        await handle({
          kind: "action",
          action: { kind: "look", yaw: step * 0.1, pitch: 0 },
        });
      }
      running.resolve();
      return await abort.promise;
    },
  } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
  resources.push({ runtime, store, directory });
  await runtime.initialize();
  const created = await runtime.createRun({
    task: "Observe without gameplay effects",
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!,
    model_id: "fixture-model",
  });
  store.subscribe((event) => {
    if (
      event.run_id === created.run_id &&
      event.type === "scheduler.turn_finished" &&
      prompts === 1
    )
      settled.resolve();
  });
  await runtime.control(created.run_id, "start");
  await running.promise;
  await settled.promise;
  await Promise.resolve();
  expect(runtime.snapshot()?.status).toBe("running");
  expect(runtime.snapshot()?.model_status).toBe("idle");
  expect(prompts).toBe(1);
  expect(gameExecutions).toBe(2);
  expect(runtime.snapshot()?.executions[0]?.actions).toBe(2);
  const admittedEffects = store
    .eventsAfter(created.run_id, 0, 500)
    .filter((event) => event.type === "action.accepted")
    .map((event) => event.details);
  expect(admittedEffects).toHaveLength(2);
  for (const details of admittedEffects) {
    expect(details).toMatchObject({
      origin: "skill",
      execution_id: runtime.snapshot()?.executions[0]?.execution_id,
    });
  }
  const historical = { action_id: "historical-strategist-evidence", kind: "look", origin: "strategist", execution_id: null,
    session_id: observation.session_id, life_id: 1, status: "succeeded", summary: "Retained historical fixture evidence",
    started_at: null, ended_at: new Date().toISOString(), result: {
    status: "succeeded",
    summary: "Retained historical fixture evidence",
    evidence: null,
  } };
  // Seed retained bytes, never use the current executable admission API to
  // manufacture an obsolete strategist command.
  const database: Database = Reflect.get(store, "db");
  database.query("INSERT INTO actions(run_id,action_id,fingerprint,request,view) VALUES(?,?,?,?,?)").run(created.run_id,
    historical.action_id, "historical-read-only", JSON.stringify({ kind: "look", yaw: .5, pitch: 0 }), JSON.stringify(historical));
  const diagnostic = await tools
    .find((tool) => tool.name === "program_inspect")!
    .execute("historical-read", {
      view: "action",
    });
  expect(diagnostic.details.origin).toBe("strategist");
  expect(diagnostic.details).not.toHaveProperty("execution_id");
  expect(gameExecutions).toBe(2);
  expect(contexts[0]?.observation).toBeUndefined();
  expect(contexts[0]?.player).toBeUndefined();
  expect(contexts[0]?.adapter_state).toMatchObject({ player: { health: 20 }, blocks: [{ target: { target_id: "observed-block" } }] });
  for (let index = 0; index < 10; index++)
    for (const listener of gameListeners)
      listener({ type: "observation", data: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(prompts).toBe(1);
  expect(
    store
      .eventsAfter(created.run_id, 0, 500)
      .filter((event) => event.type === "scheduler.backoff"),
  ).toEqual([]);
  expect(runtime.snapshot()?.usage.calls).toBe(1);
  const firstCause = "The native control transport failed";
  state = { ...state, status: "error", error: firstCause };
  for (const listener of gameListeners) listener({ type: "state", data: null });
  expect(runtime.snapshot()?.error).toBe(firstCause);
  const emitLateProviderFailure = () =>
    listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider stream aborted after authority was revoked",
        content: [],
      },
    } as unknown as AgentEvent);
  emitLateProviderFailure();
  await runtime.control(created.run_id, "pause");
  expect(runtime.snapshot()?.status).toBe("paused");
  expect(runtime.snapshot()?.error).toBe(firstCause);
  expect(runtime.snapshot()?.executions[0]?.status).toBe("cancelled");
  state = { ...state, status: "connected", epoch: 2, session_id: "fixture-reconnected-session", binding: minecraftTestBinding(adapter, "replacement-native-boot"), error: null };
  observation.epoch = 2;
  observation.session_id = "fixture-reconnected-session";
  observation.native_boot_id = "replacement-native-boot";
  failNextAgent = true;
  await expect(runtime.control(created.run_id, "resume")).rejects.toMatchObject({ code: "precondition_failed" });
  expect(runtime.snapshot()?.status).toBe("paused");
  expect(runtime.snapshot()?.error).toBe(firstCause);
  await runtime.control(created.run_id, "stop");
  // Stop finishes the old transport owner. Only an explicit replacement
  // connection after that drain can supply authority for the new run.
  state = { ...state, status: "connected", epoch: 2, session_id: "fixture-reconnected-session", binding: minecraftTestBinding(adapter, "replacement-native-boot"), error: null };
  const replacement = await runtime.createRun({ task: "Explicit new replacement-session authority", goal: adapter.goals.find(goal => goal.goal_id === "custom")!,
    model_id: "fixture-model", working_programs: "fresh" });
  await runtime.control(replacement.run_id, "start");
  expect(runtime.snapshot()?.status).toBe("paused");
  expect(store.getRun(created.run_id)?.error).toBe(firstCause);
  await runtime.control(replacement.run_id, "resume");
  expect(runtime.snapshot()?.status).toBe("running");
  expect(runtime.snapshot()?.error).toBeNull();
  await runtime.control(replacement.run_id, "stop");
});
