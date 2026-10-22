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
  Observation,
} from "../src/shared/contracts.ts";
import type { SkillRef } from "../src/shared/programs.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { Runtime } from "../src/server/runtime.ts";
import { Store } from "../src/server/store.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
const resources: { runtime: Runtime; store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.runtime.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

test("a pending program stays compact and unpolled, and native first-cause survives cleanup until successful explicit resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-scheduler-")),
    store = new Store(directory);
  const worldId = crypto.randomUUID();
  const observation: Observation = {
    schema_version: 2,
    session_id: "fixture-session",
    life: { life_id: 1, status: "alive", can_respawn: false, death: null },
    world_id: worldId,
    epoch: 1,
    observation_seq: 1,
    captured_at: new Date().toISOString(),
    profile_id: "player-observable-structured",
    preset_id: "minecraft-observable-initial-r2",
    player: {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      on_ground: true,
      in_water: false,
      inventory: [],
    },
    blocks: [
      {
        id: "observed-block",
        name: "stone",
        position: { x: 0, y: 63, z: 0 },
        observed_at: new Date().toISOString(),
        current: true,
      },
    ],
    entities: [],
    sounds: [],
    coverage: { partial: true, max_age_ms: 1000 },
  };
  let state: GameState = {
    status: "connected",
    username: "Fixture",
    version: "1.21.4",
    world_id: worldId,
    epoch: 1,
    session_id: observation.session_id,
    life: observation.life,
    motor_profile: "balanced",
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
    player: observation.player,
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
    setMotorProfile: async () => {},
    recipes: async () => [],
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
  let skill: SkillRef | null = null,
    prompts = 0,
    failNextAgent = false;
  const running = Promise.withResolvers<void>(),
    settled = Promise.withResolvers<void>();
  const contexts: Record<string, unknown>[] = [];
  const fakeAgent = {
    setBeforeModelCall: (hook: typeof gate) => {
      gate = hook;
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
      if (context.phase === "bootstrapping") {
        expect(tools.some((tool) => tool.name === "action_submit")).toBe(false);
        expect(tools.some((tool) => tool.name === "action_cancel")).toBe(false);
        const capabilities = await tools
          .find((tool) => tool.name === "capabilities_read")!
          .execute("capabilities", {});
        expect(capabilities.details.effects).toEqual({
          admission: "closed",
          owners: ["skill", "policy"],
          strategic_direct: false,
        });
        const result = await tools
          .find((tool) => tool.name === "skill_register")!
          .execute("register", {
            epoch: 1,
            spec: {
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
            },
          });
        skill = {
          skill_id: result.details.skill_id,
          version: result.details.version,
        };
      } else {
        await tools
          .find((tool) => tool.name === "skill_start")!
          .execute("start", {
            ...skill,
            start_key: "stable-program",
            epoch: 1,
            session_id: observation.session_id,
            life_id: observation.life.life_id,
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
            errorMessage:
              "A program is meaningful pending work; strategy waits for its outcome",
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
  const runtime = new Runtime(store, auth, game, sandbox, () => {});
  resources.push({ runtime, store, directory });
  await runtime.initialize();
  const created = await runtime.createRun({
    task: "Observe without gameplay effects",
    goal: "custom",
    model_id: "fixture-model",
  });
  store.subscribe((event) => {
    if (
      event.run_id === created.run_id &&
      event.type === "scheduler.turn_finished" &&
      prompts === 2
    )
      settled.resolve();
  });
  await runtime.control(created.run_id, "start");
  await running.promise;
  await settled.promise;
  await Promise.resolve();
  expect(runtime.snapshot()?.status).toBe("running");
  expect(runtime.snapshot()?.model_status).toBe("idle");
  expect(prompts).toBe(2);
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
  const historical = store.admitAction(
    created.run_id,
    "historical-strategist-evidence",
    { kind: "look", yaw: 0.5, pitch: 0 },
    "strategist",
  ).action.view;
  historical.status = "succeeded";
  historical.ended_at = new Date().toISOString();
  historical.result = {
    status: "succeeded",
    summary: "Retained historical fixture evidence",
    evidence: null,
  };
  store.saveAction(created.run_id, historical);
  const diagnostic = await tools
    .find((tool) => tool.name === "action_get")!
    .execute("historical-read", {
      action_id: historical.action_id,
    });
  expect(diagnostic.details.origin).toBe("strategist");
  expect(diagnostic.details.execution_id).toBeNull();
  expect(gameExecutions).toBe(2);
  expect(contexts[0]?.observation).toBeUndefined();
  expect(contexts[0]?.player).toBeDefined();
  expect(JSON.stringify(contexts)).not.toContain("observed-block");
  for (let index = 0; index < 10; index++)
    for (const listener of gameListeners)
      listener({ type: "observation", data: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(prompts).toBe(2);
  expect(
    store
      .eventsAfter(created.run_id, 0, 500)
      .filter((event) => event.type === "scheduler.backoff"),
  ).toEqual([]);
  expect(runtime.snapshot()?.usage.calls).toBe(2);
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
  state = { ...state, status: "connected", epoch: 2, error: null };
  observation.epoch = 2;
  failNextAgent = true;
  await runtime.control(created.run_id, "resume");
  expect(runtime.snapshot()?.status).toBe("paused");
  expect(runtime.snapshot()?.error).toBe(firstCause);
  await runtime.control(created.run_id, "resume");
  expect(runtime.snapshot()?.status).toBe("running");
  expect(runtime.snapshot()?.error).toBeNull();
  await runtime.control(created.run_id, "stop");
});
