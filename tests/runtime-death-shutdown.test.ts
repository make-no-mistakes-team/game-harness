import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AuthState, BridgeNotice, GameActionResult, GameBridge, GameState } from "../src/shared/contracts.ts";
import type { SkillCapabilityRequest } from "../src/shared/programs.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import { Runtime } from "../src/server/runtime.ts";
import { Store } from "../src/server/store.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const resources: { runtime: Runtime; store: Store; directory: string; release(): void }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.release();
    await resource.runtime.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

test("a genuine transport fault pauses only after native and isolated emitters close, retaining unknown history and first cause", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-death-drain-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const worldId = crypto.randomUUID();
  const death = "The native control transport ended unexpectedly.";
  const unknown: GameActionResult = {
    status: "unknown",
    summary: "Transport loss interrupted the action; its effects remain unknown",
    evidence: { effect_confirmed: false, neutralized_effect: false, connection_cause: death },
    requires_reconnect: true,
  };
  const action = Promise.withResolvers<GameActionResult>();
  const nativeClosed = Promise.withResolvers<void>();
  const workerClosed = Promise.withResolvers<void>();
  const actionEntered = Promise.withResolvers<void>();
  const plannerSettled = Promise.withResolvers<void>();
  const disconnectRequested = Promise.withResolvers<void>();
  const cancellationSettled = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const observation = minecraftObservationFixture(adapter, { world_id: worldId, session_id: "fixture-session" });
  let state: GameState = {
    status: "connected", username: "Fixture", version: "1.21.4", world_id: worldId, epoch: 1,
    session_id: observation.session_id, life: observation.life, binding: minecraftTestBinding(adapter),
    space: observation.space, screen: null, presentation: adapter.projectObservation(observation),
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, error: null,
  };
  const listeners = new Set<(notice: BridgeNotice) => void>();
  let connections = 0, prompts = 0, agentCreations = 0;
  const game: GameBridge = {
    connect: async () => { connections++; },
    disconnect: async () => {
      disconnectRequested.resolve();
      await nativeClosed.promise;
      // Preserve the first transport diagnostic after the owned emitter exits.
      // An error snapshot does not itself mean an emitter remains open.
    },
    snapshot: () => state,
    observe: async () => observation,
    execute: async () => { actionEntered.resolve(); return await action.promise; },
    cancel: async () => { await nativeClosed.promise; },
    neutralize: async () => { await nativeClosed.promise; },
    emergencyStop: async () => { await nativeClosed.promise; },
    adapter: () => adapter,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  let tools: AgentTool[] = [], gate: Parameters<Agent["setBeforeModelCall"]>[0], initialized = false;
  const agent = {
    setBeforeModelCall: (hook: typeof gate) => { gate = hook; },
    setTools: (next: AgentTool[]) => { tools = next; },
    subscribe: () => () => {}, replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
    prompt: async (text: string) => {
      prompts++;
      const context = JSON.parse(text) as { phase: string };
      await gate?.({ systemPrompt: [], messages: [], tools: [] });
      if (!initialized) {
        initialized = true;
        expect(context.phase).toBe("running");
        await tools.find(tool => tool.name === "program_write")!.execute("register", {
          name: "Neutral drain fixture", source: 'const result = await game.action({kind:"look",yaw:0,pitch:0}); return {status:"completed",summary:"Neutral result inspected",result};', card: { purpose: "Exercise cancellation", applicability: "Connected fixture", method: "Await one bounded neutral effect", reason: "Prove teardown barriers", limitations: "No gameplay claim" }, dependencies: [],
        });
        await tools.find(tool => tool.name === "program_run")!.execute("start", { operation: "start", name: "Neutral drain fixture", args: null, limits: { ...DEFAULT_SKILL_LIMITS } });
        expect((await gate?.({ systemPrompt: [], messages: [], tools: [] }))?.stop).toBe(true);
      }
    },
  };
  const authState: AuthState = { status: "ready", authenticated: true, provider: "openai-codex", account_label: null, models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null };
  const auth = {
    snapshot: () => authState,
    createAgent: async (options: { tools: AgentTool[] }) => { agentCreations++; tools = options.tools; return agent as unknown as Agent; },
    releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = {
    snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    runSkill: async (_source: string, _args: unknown, handle: (request: SkillCapabilityRequest) => Promise<unknown>, _limits: unknown, signal: AbortSignal) => {
      const aborted = Promise.withResolvers<void>();
      const abort = () => aborted.resolve();
      signal.addEventListener("abort", abort, { once: true });
      try {
        void handle({ kind: "action", action: { kind: "look", yaw: 0, pitch: 0 } }).catch(() => {});
        await aborted.promise;
        await workerClosed.promise;
        throw new Error("Fixture isolated emitter closure confirmed");
      } finally { signal.removeEventListener("abort", abort); }
    },
  } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {
    if (runtime.snapshot()?.status === "paused") paused.resolve();
  }, { adapter });
  resources.push({ runtime, store, directory, release: () => { action.resolve(unknown); nativeClosed.resolve(); workerClosed.resolve(); } });
  await runtime.initialize();
  const created = await runtime.createRun({ task: "Observe neutral cancellation", goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: "fixture-model" });
  store.subscribe(event => {
    if (event.run_id !== created.run_id) return;
    if (event.type === "scheduler.turn_finished" && prompts === 1) plannerSettled.resolve();
    if (event.type === "action.cancellation_settled") cancellationSettled.resolve();
  });
  await runtime.control(created.run_id, "start");
  await actionEntered.promise;
  await plannerSettled.promise;
  state = { ...state, status: "error", presentation: null, error: death };
  for (const listener of listeners) listener({ type: "state", data: null });
  action.resolve(unknown);
  await disconnectRequested.promise;
  expect(runtime.snapshot()?.status).toBe("pausing");
  expect(runtime.snapshot()?.error).toBe(death);
  nativeClosed.resolve();
  await cancellationSettled.promise;
  expect(runtime.snapshot()?.status).toBe("pausing");
  expect(runtime.snapshot()?.action?.status).toBe("unknown");
  workerClosed.resolve();
  await paused.promise;
  expect(runtime.snapshot()?.status).toBe("paused");
  expect(runtime.snapshot()?.error).toBe(death);
  expect(runtime.snapshot()?.action?.result).toEqual(unknown);
  expect(runtime.snapshot()?.executions[0]?.status).toBe("unknown");
  expect(game.snapshot().status).toBe("error");
  const cancellation = store.eventsAfter(created.run_id, 0, 500).find(event => event.type === "action.cancellation_settled");
  expect(cancellation?.details).toMatchObject({ neutralized: true, effect_status: "unknown" });
  await runtime.control(created.run_id, "stop");
  expect(runtime.snapshot()?.status).toBe("stopped");
  expect(runtime.snapshot()?.error).toBe(death);
  expect(runtime.snapshot()?.action?.status).toBe("unknown");
  expect(prompts).toBe(1);
  expect(agentCreations).toBe(1);
  expect(connections).toBe(0);
});
