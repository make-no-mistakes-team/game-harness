import { afterEach, expect, test, vi } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type {
  AuthState,
  BridgeNotice,
  GameAction,
  GameActionResult,
  GameBridge,
  GameState,
  Json,
  ObservationV3,
} from "../src/shared/contracts.ts";
import { DEFAULT_SKILL_LIMITS, type SkillCapabilityRequest } from "../src/shared/programs.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { ActionArbiter } from "../src/server/action-arbiter.ts";
import { Store } from "../src/server/store.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";
import type { Database } from "bun:sqlite";
import { DEFAULT_RESIDENT_LIMITS, type ControllerStepResult } from "../src/shared/resident.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import type { HistoryReader } from "../src/server/history-reader.ts";
import type { HistoryProjectionOwner } from "../src/server/history-projection-owner.ts";
import { ProgramWorkspace } from "../src/server/program-workspace.ts";
const resources: { runtime: Runtime; store: Store; directory: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.runtime.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

async function repeatedNoEffectFixture(executive: boolean | "raw" | "view-observe" = false) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-no-effect-")), store = new Store(directory);
  const adapter = minecraftTestAdapter(), observation = minecraftObservationFixture(adapter);
  const state: GameState = { status: "connected", username: "Fixture", version: "1.21.4", world_id: observation.world_id,
    epoch: observation.epoch, session_id: observation.session_id, life: observation.life,
    binding: minecraftTestBinding(adapter), space: observation.space, screen: null, presentation: adapter.projectObservation(observation),
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, error: null };
  const ready = Promise.withResolvers<(request: SkillCapabilityRequest) => Promise<Json>>();
  let result: GameActionResult = { status: "succeeded", summary: "Explicit neutral outcome",
    evidence: { world_effect_emitted: false, neutralized: true, camera_changed: false } };
  let settle: (() => Promise<GameActionResult>) | null = null, nativeCalls = 0, aborts = 0, sample = 0;
  const rawInput = { kind: "world" as const, held: { forward: executive === "raw", back: false, left: false, right: false, jump: false,
    sprint: false, sneak: false, attack: false, use: false },
    view: executive === "view-observe" ? { kind: "rate" as const, yaw_radians_per_second: 2, pitch_radians_per_second: 0 }
      : { kind: "unchanged" as const }, selected_hotbar: null };
  const sampleFrame = async () => {
    const frame = controllerFrameFixture(observation.life.life_id, observation.space.space_epoch);
    frame.frame_seq = ++sample; frame.native_tick = sample; frame.captured_native_ns = String(sample * 50000000);
    frame.dynamic_entities.native_tick = sample; frame.dynamic_entities.captured_native_ns = frame.captured_native_ns;
    frame.inventory.captured_native_ns = frame.captured_native_ns;
    if (executive === "raw" || executive === "view-observe") {
      frame.player.on_ground = true; frame.player.in_water = false; frame.player.in_lava = false;
      frame.player.gliding = false; frame.player.vehicle_type = null;
    }
    return frame;
  };
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {}, snapshot: () => state, observe: async () => observation,
    execute: async () => { nativeCalls++; return settle ? await settle() : result; },
    cancel: async () => {}, neutralize: async () => {}, emergencyStop: async () => {},
    adapter: () => adapter, subscribe: () => () => {},
    openController: async (reservation, generation, _deadline, applied) => {
      if (executive !== "raw" && executive !== "view-observe") throw new Error("Observe-only executive must not acquire raw input");
      const owner = { operation_id: reservation.operation_id, generation: 1, scope: reservation.scope };
      let sequence = 0, revoked = false;
      return {
        owner, controllerGeneration: generation, sample: async () => jsonSchema.parse(await sampleFrame()),
        renew: async () => {},
        submit(_frame, input) {
          if (revoked || input.kind !== "world") throw new Error("Unexpected fixture input");
          const current = ++sequence;
          queueMicrotask(() => applied({ controller_generation: generation, sequence: current, ordered_edge_prefix: 0,
            applied_native_tick: sample, applied_native_ns: String(sample * 50000000), held: { ...input.held },
            applied_pose: { yaw_radians: 0, pitch_radians: 0 }, input_application: "confirmed", reason: null }));
          return { sequence: current, status: "submitted", reason: null };
        },
        snapshot: () => ({ fenced: revoked, retired: revoked, submitted_sequence: sequence, applied_sequence: sequence,
          ordered_edge_prefix: 0, pending_frames: 0, pending_edges: 0, last_input: null, reason: null, fault: null }),
        revoke: async () => { revoked = true; return { owner, controller_generation: generation, admission_revoked: true,
          last_applied_sequence: sequence, ordered_edge_prefix: 0, retirement_applied_native_tick: sample,
          retirement_applied_native_ns: String(sample * 50000000), input_application: "confirmed", unresolved_operation_refs: [] }; },
      };
    },
    queryCapability: async () => jsonSchema.parse(await sampleFrame()),
  };
  const contexts: Record<string, any>[] = [];
  let tools: AgentTool[] = [];
  let listener: ((event: AgentEvent) => void) | null = null;
  let promptWork: (() => Promise<void>) | null = null;
  const hooks = new DiagnosticModelHooks();
  const agent = { addBeforeModelCallHook: hooks.add, setBeforeModelCall: () => {}, setTools: (value: AgentTool[]) => { tools = value; },
    subscribe: (value: (event: AgentEvent) => void) => { listener = value; return () => { listener = null; }; },
    replaceMessages: () => {}, abort: () => { aborts++; }, waitForIdle: async () => {},
    prompt: async (text: string) => {
      contexts.push(JSON.parse(text));
      await hooks.run(undefined, { systemPrompt: [], messages: [], tools });
      if (contexts.length === 1) {
        const written = await tools.find(tool => tool.name === "program_write")!.execute("no-effect-write", {
          entry: executive ? "step" : "run",
          name: "Neutral repeated actions", source: executive
            ? `export function step(frame,state,intent){const n=state?.n||0;return {choice:${executive === "view-observe"
              ? `(n%8===0?{kind:"observe"}:${JSON.stringify({ kind: "raw", input: rawInput })})`
              : JSON.stringify(executive === "raw" ? { kind: "raw", input: rawInput } : { kind: "observe" })},next_state:{n:n+1},status:"running",events:[]};} export function activate(frame,state,intent){return step(frame,state,intent);}`
            : 'for (let i=0;i<64;i++) { await game.action({kind:"look",yaw:0,pitch:0}); } return {status:"completed",summary:"Finite neutral observations",result:null};',
          dependencies: [], card: { purpose: "Inspect repeated neutral outcomes", applicability: "Fixture",
            method: "Finite identical neutral requests", reason: "Mechanical diagnostic regression", limitations: "No gameplay claim" },
        });
        if (written.isError) { ready.reject(new Error(JSON.stringify(written))); return; }
        const started = await tools.find(tool => tool.name === "program_run")!.execute("no-effect-start", {
          operation: "start", name: "Neutral repeated actions", args: null,
          ...(executive ? { entry: "step", session: { schema_version: 1 },
            limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 15000 } } : { limits: { ...DEFAULT_SKILL_LIMITS } }),
        });
        if (started.isError) ready.reject(new Error(JSON.stringify(started)));
      } else await promptWork?.();
      listener?.({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } as unknown as AgentEvent);
    } };
  const auth = { snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
    models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null }),
    createAgent: async (options: { tools: AgentTool[] }) => { tools = options.tools; return agent as unknown as Agent; },
    releaseAgent: async () => {} } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    createResidentAnalysisWorker: async () => { throw new Error("Observe-only fixture does not request analysis"); },
    createResidentWorker: async () => {
      ready.resolve(async () => { throw new Error("Observe-only executive has no async capability"); });
      let decisions = 0;
      const decision = async () => ({ choice: executive === "raw" || executive === "view-observe" && decisions++ % 8 !== 0
        ? { kind: "raw" as const, input: rawInput } : { kind: "observe" as const }, next_state: null,
        status: "running" as const, events: [] });
      return { activate: decision, step: decision, close: async () => {} };
    },
    runSkill: async (_source: unknown, _args: unknown, handle: (request: SkillCapabilityRequest) => Promise<Json>,
      _limits: unknown, signal: AbortSignal) => {
      ready.resolve(handle);
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "completed", summary: "Neutral worker drained", result: null };
    } } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter, strategicAgentFactory: auth });
  resources.push({ runtime, store, directory });
  const finished = () => new Promise<void>(resolve => {
    const off = store.subscribe(event => { if (event.type === "scheduler.turn_finished") { off(); resolve(); } });
  });
  await runtime.initialize();
  const run = await runtime.createRun({ task: "Review explicit neutral outcomes without automatic recovery", model_id: "fixture-model",
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, ...(executive ? { control_mode: "executive" } : {}) });
  const initial = finished();
  await runtime.control(run.run_id, "start");
  const handle = await ready.promise;
  await initial;
  const diagnostics = () => {
    const found: ReturnType<Store["eventsAfter"]> = [];
    let after = 0;
    for (;;) {
      const page = store.eventsAfter(run.run_id, after, 500);
      found.push(...page.filter(event => event.type === "program.repeated_no_effect"));
      if (page.length < 500) return found;
      after = page.at(-1)!.event_seq;
    }
  };
  return { runtime, store, state, run, contexts, finished,
    action: (action: GameAction = { kind: "look", yaw: 0, pitch: 0 }) => handle({ kind: "action", action }),
    attention: () => handle({ kind: "attention", attention: { urgency: "ordinary", summary: "Fixture requests a bounded decision", details: null } }),
    promptWork: (value: (() => Promise<void>) | null) => { promptWork = value; },
    result: (value: GameActionResult) => { result = value; },
    settlement: (value: (() => Promise<GameActionResult>) | null) => { settle = value; },
    counts: () => ({ nativeCalls, aborts }),
    diagnostics,
    finishTask: () => tools.find(tool => tool.name === "task_finish")!.execute("fixture-finish", { all_requested_work_complete: true, summary: "Explicit terminal lifecycle fixture" }),
  };
}

test("observe-only executive requests one ordinary decision without inventing effects or stopping local control", async () => {
  const fixture = await repeatedNoEffectFixture(true);
  await new Promise<void>((resolve, reject) => {
    const off = fixture.store.subscribe(event => {
      if (event.type === "scheduler.turn_finished") { off(); resolve(); }
      else if (event.type === "skill.closed" || event.type === "scheduler.turn_failed") {
        off(); reject(new Error(`${event.type}: ${JSON.stringify(event.details)}`));
      }
    });
  });
  expect(fixture.contexts).toHaveLength(2);
  expect(fixture.contexts[1]).toMatchObject({ reason: ["program_no_effect"], pending_decision: true });
  expect(fixture.contexts[1]!.feedback).toEqual(expect.arrayContaining([expect.objectContaining({
    type: "program.repeated_no_effect", details: expect.objectContaining({
      reason: "executive_no_effect_decisions", source: "runtime_mechanical", usefulness_inferred: false,
      elapsed_host_ms: expect.any(Number), no_input_decisions: expect.any(Number),
    }),
  })]));
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(fixture.diagnostics()[0]!.details).not.toHaveProperty("world_effect_emitted");
  expect(fixture.store.latestRootExecution(fixture.run.run_id)).toMatchObject({ status: "running", ended_at: null });
  expect(fixture.counts()).toEqual({ nativeCalls: 0, aborts: 0 });
}, 15000);

test("confirmed stationary raw motion wakes ordinary repair without stopping the executive or supplying movement", async () => {
  const fixture = await repeatedNoEffectFixture("raw");
  await fixture.finished();
  expect(fixture.contexts).toHaveLength(2);
  expect(fixture.contexts[1]).toMatchObject({ reason: ["program_no_effect"], pending_decision: true });
  expect(fixture.contexts[1]!.feedback).toEqual(expect.arrayContaining([expect.objectContaining({
    type: "program.repeated_no_effect", details: expect.objectContaining({
      reason: "executive_raw_motion_stationary", usefulness_inferred: false, elapsed_native_ms: 5000,
    }),
  })]));
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(fixture.store.latestRootExecution(fixture.run.run_id)).toMatchObject({ status: "running", ended_at: null });
  expect(fixture.counts()).toEqual({ nativeCalls: 0, aborts: 0 });
}, 15000);

test("stationary view and observe turnover reaches ordinary strategy with software-only evidence", async () => {
  const fixture = await repeatedNoEffectFixture("view-observe");
  await fixture.finished();
  const feedback = fixture.contexts[1]?.feedback.find((entry: { type: string }) => entry.type === "program.repeated_no_effect");
  expect(fixture.contexts[1]).toMatchObject({ reason: ["program_no_effect"], pending_decision: true });
  expect(feedback).toMatchObject({ details: { reason: "executive_stationary_view_observe",
    source: "runtime_mechanical", application_inferred: false, usefulness_inferred: false,
    elapsed_native_ms: expect.any(Number), own_position: expect.any(Object), anchor_position: expect.any(Object) } });
  expect(feedback.details.raw_view_decisions).toBeGreaterThan(0);
  expect(feedback.details.observe_decisions).toBeGreaterThan(0);
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(fixture.store.latestRootExecution(fixture.run.run_id)).toMatchObject({ status: "running", ended_at: null });
  expect(fixture.counts()).toEqual({ nativeCalls: 0, aborts: 0 });
}, 20000);

for (const backlog of [0, 501]) test(`three explicit identical neutral outcomes wake ordinary strategy with a live root across ${backlog} earlier events`, async () => {
  const fixture = await repeatedNoEffectFixture();
  const root = fixture.store.latestRootExecution(fixture.run.run_id)!;
  const reference = new ProgramWorkspace(fixture.store, fixture.run.run_id).executionReference(root.execution_id)!;
  await fixture.action();
  await fixture.action({ pitch: 0, yaw: 0, kind: "look" });
  expect(fixture.diagnostics()).toHaveLength(0);
  for (let i = 0; i < backlog; i++)
    fixture.store.event(fixture.run.run_id, "skill.progress", "Non-waking retained progress", { summary: "Neutral fixture" });
  const decision = fixture.finished();
  await fixture.action();
  await decision;
  expect(fixture.contexts).toHaveLength(2);
  expect(fixture.contexts[1]).toMatchObject({ reason: ["program_no_effect"], role: "planning", pending_decision: true });
  expect(fixture.contexts[1]!.feedback).toEqual(expect.arrayContaining([expect.objectContaining({
    type: "program.repeated_no_effect", details: expect.objectContaining({
      source: "runtime_mechanical", usefulness_inferred: false, count: 3, execution_ordinal: reference.execution_ordinal,
    }),
  })]));
  expect(Buffer.byteLength(JSON.stringify(fixture.contexts[1]!.feedback))).toBeLessThanOrEqual(8192);
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(fixture.diagnostics()[0]!.details).toMatchObject({
    source: "runtime_mechanical", usefulness_inferred: false, root_execution_id: root.execution_id,
    root_source_hash: root.source_hash, execution_id: root.execution_id, source_hash: root.source_hash,
    count: 3, action_ids: expect.arrayContaining([expect.any(String)]),
  });
  for (let i = 0; i < 6; i++) await fixture.action();
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fixture.diagnostics()).toHaveLength(1);
  expect(fixture.contexts).toHaveLength(2);
  expect(fixture.store.latestRootExecution(fixture.run.run_id)).toMatchObject({ execution_id: root.execution_id, status: "running", ended_at: null });
  expect(fixture.counts()).toEqual({ nativeCalls: 9, aborts: 0 });
});

test("mechanical advice coalesces behind an admitted ordinary decision without aborting its provider owner", async () => {
  const fixture = await repeatedNoEffectFixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  fixture.promptWork(async () => { entered.resolve(); await release.promise; });
  await fixture.attention();
  await entered.promise;
  try {
    await fixture.action(); await fixture.action(); await fixture.action();
    expect(fixture.diagnostics()).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fixture.contexts).toHaveLength(2);
    expect(fixture.counts()).toEqual({ nativeCalls: 3, aborts: 0 });
    fixture.promptWork(null);
    const decision = new Promise<void>(resolve => {
      const off = fixture.store.subscribe(event => {
        if (event.type === "scheduler.turn_finished" && fixture.contexts.length === 3) { off(); resolve(); }
      });
    });
    release.resolve();
    await decision;
    expect(fixture.contexts[2]).toMatchObject({ reason: ["program_no_effect"], pending_decision: true });
    expect(fixture.store.latestRootExecution(fixture.run.run_id)?.status).toBe("running");
    expect(fixture.counts().aborts).toBe(0);
  } finally { release.resolve(); }
});

test("trusted diagnostic actions never contribute to a model root's repeated-no-effect advice", async () => {
  const fixture = await repeatedNoEffectFixture();
  const arbiter = Reflect.get(fixture.runtime, "actions") as ActionArbiter;
  for (let i = 0; i < 4; i++) {
    await arbiter.diagnostic({ kind: "look", yaw: 0, pitch: 0 }, "a".repeat(64), 1000);
    const active = arbiter.active;
    if (active) await arbiter.awaitRetirement(active);
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fixture.diagnostics()).toHaveLength(0);
  expect(fixture.contexts).toHaveLength(1);
  expect(fixture.counts().nativeCalls).toBe(4);
});

test("advisory publication cannot wake strategy after a synchronous subscriber retires its root", async () => {
  const fixture = await repeatedNoEffectFixture();
  let stopping: Promise<unknown> | null = null;
  const off = fixture.store.subscribe(event => {
    if (event.type !== "program.repeated_no_effect") return;
    stopping = fixture.runtime.control(fixture.run.run_id, "stop");
  });
  try {
    await fixture.action(); await fixture.action(); await fixture.action().catch(() => null);
    await stopping;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fixture.diagnostics()).toHaveLength(1);
    expect(fixture.contexts.every(context => !context.reason.includes("program_no_effect"))).toBe(true);
    expect(fixture.runtime.snapshot()?.status).toBe("stopped");
    expect(fixture.counts().nativeCalls).toBe(3);
  } finally { off(); }
});

test("different actions, actual effects and uncertain evidence reset rather than accumulate neutral diagnostics", async () => {
  const fixture = await repeatedNoEffectFixture();
  const neutral: GameActionResult = { status: "failed", summary: "Explicit neutral rejection",
    evidence: { world_effect_emitted: false, neutralized: true, camera_changed: false } };
  const notify = async () => {
    const decision = fixture.finished();
    await fixture.action(); await fixture.action(); await fixture.action(); await decision;
  };
  fixture.result(neutral);
  await notify();
  expect(fixture.diagnostics()).toHaveLength(1);
  await fixture.action({ kind: "look", yaw: 0.1, pitch: 0 });
  await fixture.action(); await fixture.action();
  expect(fixture.diagnostics()).toHaveLength(1);
  const next = fixture.finished(); await fixture.action(); await next;
  expect(fixture.diagnostics()).toHaveLength(2);
  const resets: Json[] = [
    { world_effect_emitted: true, neutralized: true },
    { world_effect_emitted: false, neutralized: true, camera_changed: true },
    { world_effect_emitted: false, neutralized: true, camera_changed: "unknown" },
    { world_effect_emitted: false, neutralized: true },
    { world_effect_emitted: false, neutralized: false },
    { neutralized: true },
    { world_effect_emitted: false },
    null,
  ];
  for (const evidence of resets) {
    fixture.result({ status: "succeeded", summary: "Reset evidence", evidence });
    await fixture.action();
    fixture.result(neutral);
    await fixture.action(); await fixture.action();
    const before = fixture.diagnostics().length, decision = fixture.finished();
    await fixture.action(); await decision;
    expect(fixture.diagnostics()).toHaveLength(before + 1);
  }
});

for (const loss of ["unknown", "cancelled", "reconnect", "scope", "terminal", "stale", "revoked", "publication"] as const)
test(`${loss} settlement cannot publish late mechanical attention or schedule new effects`, async () => {
  const fixture = await repeatedNoEffectFixture();
  await fixture.action(); await fixture.action();
  const root = fixture.store.latestRootExecution(fixture.run.run_id)!;
  const release = Promise.withResolvers<GameActionResult>(), entered = Promise.withResolvers<void>();
  fixture.settlement(async () => { entered.resolve(); return await release.promise; });
  const pending = fixture.action().catch(() => null);
  await entered.promise;
  let off = () => {}, stopping: Promise<unknown> | null = null;
  if (loss === "scope") fixture.state.space = { ...fixture.state.space!, space_epoch: fixture.state.space!.space_epoch + 1 };
  if (loss === "terminal") stopping = fixture.finishTask();
  if (loss === "stale") fixture.store.admitSkill(fixture.run.run_id, {
    skill_id: root.skill_id, version: root.version, start_key: "newer-retained-root", entry: "run",
    args: null, limits: { ...DEFAULT_SKILL_LIMITS },
    epoch: root.epoch, session_id: root.session_id!, life_id: root.life_id!, native_boot_id: root.native_boot_id!,
    run_generation: root.run_generation!, space_epoch: root.space_epoch!, compatibility_hash: root.compatibility_hash!,
  });
  if (loss === "publication") off = fixture.store.subscribe(event => {
    if (event.type === "action.succeeded") stopping = fixture.runtime.control(fixture.run.run_id, "stop");
  });
  if (loss === "revoked") stopping = fixture.runtime.control(fixture.run.run_id, "stop");
  release.resolve({ status: loss === "unknown" ? "unknown" : loss === "cancelled" ? "cancelled" : "succeeded",
    summary: "Late neutral-looking result", evidence: { world_effect_emitted: false, neutralized: true, camera_changed: false },
    ...(loss === "reconnect" ? { requires_reconnect: true } : {}) });
  await pending;
  await stopping;
  if (loss === "terminal") await fixture.runtime.close();
  off();
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(fixture.diagnostics()).toHaveLength(0);
  expect(fixture.contexts.every(context => !context.reason.includes("program_no_effect"))).toBe(true);
  expect(fixture.counts().nativeCalls).toBe(3);
});

for (const recoveryKind of ["scope", "death"] as const)
test(`${recoveryKind} recovery drains the actual old feedback reader before admitting a fresh root outcome`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-history-recovery-")), store = new Store(directory);
  const adapter = minecraftTestAdapter(), observation = minecraftObservationFixture(adapter);
  const state: GameState = { status: "connected", username: "Fixture", version: "1.21.4", world_id: observation.world_id,
    epoch: observation.epoch, session_id: observation.session_id, life: observation.life,
    binding: minecraftTestBinding(adapter), space: observation.space, screen: null, presentation: adapter.projectObservation(observation),
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, error: null };
  const listeners = new Set<(notice: BridgeNotice) => void>();
  const barrier = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(),
    killRequested = Promise.withResolvers<void>(), freshOutcome = Promise.withResolvers<void>(),
    freshPreparation = Promise.withResolvers<{ done: Promise<void> }>();
  let pid: number | null = null, holdKill = true, creates = 0, prompts = 0;
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {}, snapshot: () => state, observe: async () => observation,
    execute: async () => { throw new Error("History recovery fixture cannot issue game input"); },
    cancel: async () => {}, neutralize: async () => {},
    emergencyStop: async () => { if (pid !== null) barrier.resolve(); },
    adapter: () => adapter, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  let tools: AgentTool[] = [];
  const hooks = new DiagnosticModelHooks();
  const agent = { addBeforeModelCallHook: hooks.add, setBeforeModelCall: () => {}, setTools: (value: AgentTool[]) => { tools = value; },
    subscribe: () => () => {}, replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
    prompt: async () => {
      prompts++;
      if (prompts > 2) return;
      await hooks.run(undefined, { systemPrompt: [], messages: [], tools });
      if (prompts === 1) await tools.find(tool => tool.name === "program_write")!.execute("write-history-root", {
        name: "History recovery root", source: 'return {status:"blocked",summary:"Bounded retained root outcome",result:null};',
        dependencies: [], card: { purpose: "Retain root outcomes", applicability: "Fixture",
          method: "Return a bounded outcome", reason: "History recovery regression", limitations: "No gameplay claim" },
      });
      await tools.find(tool => tool.name === "program_run")!.execute(`history-root-${prompts}`, {
        operation: "start", name: "History recovery root", args: null, limits: { ...DEFAULT_SKILL_LIMITS },
      });
    } };
  const auth = {
    snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
      models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null }),
    createAgent: async (options: { tools: AgentTool[] }) => { creates++; tools = options.tools; return agent as unknown as Agent; },
    releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    runSkill: async () => ({ status: "blocked", summary: "Bounded retained root outcome", result: null }),
  } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter, strategicAgentFactory: auth });
  resources.push({ runtime, store, directory });
  const reader = runtime.historyQueries as HistoryReader, query = reader.query.bind(reader), kill = ChildProcess.prototype.kill;
  const owner = Reflect.get(runtime, "historyOwner") as HistoryProjectionOwner;
  let retiredChild: ReturnType<HistoryReader["snapshot"]>["child"] = null;
  let freshOutcomeThrough = Number.POSITIVE_INFINITY, freshExecutionId: string | null = null;
  const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
    if (this.pid === pid && signal === "SIGKILL" && holdKill) { killRequested.resolve(); return true; }
    return kill.call(this, signal);
  });
  const querySpy = vi.spyOn(reader, "query").mockImplementation((request, options) => {
    const previousChild = reader.snapshot().child;
    if (previousChild?.pid === pid && previousChild.closedHostMs !== null) retiredChild = previousChild;
    const pending = query(request, options);
    if (request.kind === "projection_batch" && pid === null &&
      store.eventsAfter(request.run_id, 0, 500).some(event => event.type === "skill.closed")) {
      pid = reader.snapshot().child!.pid!;
      process.kill(pid, "SIGSTOP");
      entered.resolve();
    }
    if (request.kind === "projection_batch" && outcomes === 2 && request.checkpoint.target_through >= freshOutcomeThrough) {
      const current = Reflect.get(owner, "current") as { runId: string; done: Promise<void> } | null;
      if (current?.runId === request.run_id) freshPreparation.resolve({ done: current.done });
    }
    return pending;
  });
  let outcomes = 0;
  const unsubscribe = store.subscribe(event => {
    if (event.type === "skill.closed" && ++outcomes === 2) {
      freshOutcomeThrough = store.historySourceHighwater(event.run_id!);
      freshExecutionId = (event.details as { execution_id: string }).execution_id;
      freshOutcome.resolve();
    }
  });
  try {
    await runtime.initialize();
    const run = await runtime.createRun({ task: "Retain outcomes across scope recovery", model_id: "fixture-model",
      goal: adapter.goals.find(goal => goal.goal_id === "custom")! });
    await runtime.control(run.run_id, "start");
    await entered.promise;
    if (recoveryKind === "scope") {
      observation.life = { ...observation.life, life_id: observation.life.life_id + 1 };
      state.life = observation.life;
    } else {
      observation.life = { ...observation.life, status: "dead", death: {
        death_id: "history-recovery-death", message: "Fixture death", at: new Date().toISOString(),
      } };
      state.life = observation.life;
    }
    for (const listener of listeners) listener({ type: "game_event", data: null });
    await barrier.promise;
    await killRequested.promise;
    expect(creates).toBe(1);
    expect(prompts).toBe(1);
    expect(reader.snapshot().child?.closedHostMs).toBeNull();
    holdKill = false;
    process.kill(pid!, "SIGKILL");
    await freshOutcome.promise;
    // The durable terminal event precedes worker settlement and its outcome callback.
    // Join the actual fresh query admission, not an assumed number of microtasks.
    await (await freshPreparation.promise).done;
    expect(retiredChild).toMatchObject({ exitObservedHostMs: expect.any(Number),
      stdoutDrainObservedHostMs: expect.any(Number), closedHostMs: expect.any(Number) });
    expect(creates).toBe(2);
    expect(store.opportunityCount(run.run_id)).toBe(2);
    const published = store.historyProjectionGeneration(run.run_id)!;
    expect(published.generation).toBeGreaterThan(0);
    expect(published.source_through).toBeGreaterThanOrEqual(freshOutcomeThrough);
    const feedback = await reader.query({ kind: "operator_feedback", run_id: run.run_id,
      after: { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null }, limit: 100 },
    { deadlineHostMs: performance.now() + 10_000 });
    const latestMetrics = new Map<string, Extract<(typeof feedback.metrics)[number], { kind: "replace" }>>();
    for (const update of feedback.metrics) {
      if (update.kind === "replace") latestMetrics.set(update.execution_id, update);
      else latestMetrics.delete(update.execution_id);
    }
    expect(latestMetrics.size).toBe(2);
    expect(latestMetrics.get(freshExecutionId!)?.metric.outcome).toBe("blocked");
    expect([...latestMetrics.values()].every(({ metric }) => metric.outcome === "blocked")).toBe(true);
    expect(runtime.snapshot()?.status).toBe("running");
    expect(store.eventsAfter(run.run_id, 0, 500).some(event => event.type === "runtime.history_preparation_failed")).toBe(false);
  } finally {
    holdKill = false;
    if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch {} }
    unsubscribe();
    querySpy.mockRestore();
    killSpy.mockRestore();
  }
});

test("Pause and Stop start native neutralization before readonly joins, resume reopens history, and close drains idle queries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-history-lifecycle-")), store = new Store(directory);
  const adapter = minecraftTestAdapter(), observation = minecraftObservationFixture(adapter);
  const state: GameState = { status: "connected", username: "Fixture", version: "1.21.4", world_id: observation.world_id,
    epoch: observation.epoch, session_id: observation.session_id, life: observation.life,
    binding: minecraftTestBinding(adapter), space: observation.space, screen: null, presentation: adapter.projectObservation(observation),
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, error: null };
  let querySettled = true;
  const nativeHistoryStates: boolean[] = [];
  const game: GameBridge = {
    connect: async () => {}, disconnect: async () => {}, snapshot: () => state, observe: async () => observation,
    execute: async () => { throw new Error("Readonly lifecycle test has no effects"); },
    cancel: async () => {}, neutralize: async () => {},
    emergencyStop: async () => { nativeHistoryStates.push(querySettled); },
    adapter: () => adapter, subscribe: () => () => {},
  };
  const hooks = new DiagnosticModelHooks();
  const agent = { addBeforeModelCallHook: hooks.add, setBeforeModelCall: () => {}, setTools: () => {}, subscribe: () => () => {},
    replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
    prompt: async () => { throw new Error("Lifecycle is stopped before strategic demand is delivered"); } };
  const auth = {
    snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null,
      models: [{ id: "fixture-model", name: "Fixture", provider: "fixture", context_window: null }], login: null, error: null }),
    createAgent: async () => agent as unknown as Agent, releaseAgent: async () => {},
  } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }) } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter, strategicAgentFactory: auth });
  resources.push({ runtime, store, directory });
  await runtime.initialize();
  const run = await runtime.createRun({ task: "Keep history effect-free", model_id: "fixture-model",
    goal: adapter.goals.find(goal => goal.goal_id === "custom")! });
  const reader = runtime.historyQueries as HistoryReader;
  const owner = Reflect.get(runtime, "historyOwner") as HistoryProjectionOwner;
  const queryHistory = reader.query.bind(reader);
  const sourcePreparation = Promise.withResolvers<{ done: Promise<void> }>();
  let sourceThrough = Number.POSITIVE_INFINITY;
  const sourceSpy = vi.spyOn(reader, "query").mockImplementation((request, options) => {
    if (request.kind === "projection_batch" && request.run_id === run.run_id &&
      request.checkpoint.target_through >= sourceThrough) {
      const current = Reflect.get(owner, "current") as { runId: string; done: Promise<void> } | null;
      if (current?.runId === run.run_id) sourcePreparation.resolve({ done: current.done });
    }
    return queryHistory(request, options);
  });
  try {
    const eventsBefore = store.eventsAfter(run.run_id, 0, 500);
    const retained = store.getRun(run.run_id)!;
    store.saveRun({ ...retained, task: "Eventless retained metadata change" });
    sourceThrough = store.historySourceHighwater(run.run_id);
    await (await sourcePreparation.promise).done;
    expect(store.historyProjectionGeneration(run.run_id)!.source_through).toBeGreaterThanOrEqual(sourceThrough);
    expect(store.eventsAfter(run.run_id, 0, 500)).toEqual(eventsBefore);
    expect(runtime.snapshot()?.executions).toEqual([]);
  } finally {
    sourceSpy.mockRestore();
  }
  await runtime.control(run.run_id, "start");
  for (const command of ["pause", "stop"] as const) {
    querySettled = false;
    const query = runtime.skillEvidence(run.run_id).then(
      value => { querySettled = true; return { ok: true as const, value }; },
      error => { querySettled = true; return { ok: false as const, error }; },
    );
    const before = nativeHistoryStates.length;
    await runtime.control(run.run_id, command);
    expect(nativeHistoryStates[before]).toBe(false);
    expect(querySettled).toBe(true);
    expect(await query).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(runtime.snapshot()?.status).toBe(command === "pause" ? "paused" : "stopped");
    if (command === "pause") {
      const page = await runtime.skillEvidence(run.run_id, 0, 1);
      expect(page).toMatchObject({ records: [], next_after: 0, has_more: false, total: 0, omissions: [] });
      await runtime.control(run.run_id, "resume");
    }
  }
  // Operator queries can remain active even when gameplay is already stopped.
  querySettled = false;
  const idleQuery = runtime.skillEvidence(run.run_id).then(
    () => { querySettled = true; return "resolved"; },
    () => { querySettled = true; return "cancelled"; },
  );
  const closing = runtime.close();
  expect(runtime.close()).toBe(closing);
  await closing;
  expect(querySettled).toBe(true);
  expect(await idleQuery).toBe("cancelled");
  expect(store.eventsAfter(run.run_id, 0, 500).some(event => event.type === "runtime.history_preparation_failed")).toBe(false);
  await expect(runtime.skillEvidence(run.run_id)).rejects.toMatchObject({ code: "closed" });
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
          pending_frames: 0, pending_edges: 0, last_input: null, reason: null, fault: null }) };
    },
  };
  let attentionReady = false, attentionEmitted = false;
  const contexts: Record<string, any>[] = [];
  let written: unknown, started: unknown, promptFailure: unknown;
  let tools: AgentTool[] = [], gate: Parameters<Agent["setBeforeModelCall"]>[0], creates = 0, active = 0, maximumActive = 0, steps = 0;
  const hooks = new DiagnosticModelHooks();
  const fakeAgent = { addBeforeModelCallHook: hooks.add, setBeforeModelCall: (hook: typeof gate) => { gate = hook; },
    setTools: (selected: AgentTool[]) => { tools = selected; }, subscribe: () => () => {},
    replaceMessages: () => {}, abort: () => {}, waitForIdle: async () => {},
    prompt: async (text: string) => {
      active++; maximumActive = Math.max(maximumActive, active);
      try {
        contexts.push(JSON.parse(text));
        await hooks.run(undefined, { systemPrompt: [], messages: [], tools });
        if ((await gate?.({ systemPrompt: [], messages: [], tools }))?.stop) return;
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
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter, strategicAgentFactory: auth });
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
  await diagnostic;
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(contexts).toHaveLength(1);
  for (let index = 0; index < backlog; index++)
    store.event(run.run_id, "controller.progress", "Retained non-waking controller progress", { sample: index });
  const replanned = event("scheduler.turn_finished"); attentionReady = true; await replanned;
  expect(contexts).toHaveLength(2); expect(creates).toBe(1); expect(maximumActive).toBe(1);
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
  const hooks = new DiagnosticModelHooks();
  const fakeAgent = {
    addBeforeModelCallHook: hooks.add,
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
      await hooks.run(undefined, { systemPrompt: [], messages: [], tools });
      await gate?.({ systemPrompt: [], messages: [], tools });
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
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
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
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter, strategicAgentFactory: auth });
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
