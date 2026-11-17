import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Context } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type { AuthState, GameBridge, GameState, Json } from "../src/shared/contracts.ts";
import type { ResidentWorker } from "../src/shared/resident.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { controlSessionConfigSchema } from "../src/shared/control-session.ts";
import { Store } from "../src/server/store.ts";
import { Runtime, type RuntimeOptions } from "../src/server/runtime.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { CognitionClient } from "../src/server/cognition-client.ts";
import type { StrategicRequestAdmission } from "../src/server/strategic.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { PreparedSourceCandidate } from "../src/server/prepared-source-contract.ts";
import { PreparedSourcebook } from "../src/server/prepared-sourcebook.ts";
import { adapterCompatibility } from "../src/server/adapter-contract.ts";
import { emptyRunUsage, recordCall } from "../src/server/usage.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { AcceptanceLoopbackInference, codexLifecycleFrames } from "./helpers/acceptance-loopback-inference.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const card = { purpose: "First-root lifecycle fixture", applicability: "Synthetic boundaries only",
  method: "Prepared worker before cloud readiness", reason: "Keep control independent", limitations: "No model or native gameplay claim" };
const cleanups: (() => Promise<void>)[] = [];
async function joinOwners(owners: (() => Promise<unknown>)[]): Promise<void> {
  // Each owner must receive closure even if another rejects or needs that
  // owner's cancellation to finish. Report errors only after every real join.
  const results = await Promise.allSettled(owners.map(async close => await close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Fixture owner closure failed");
}
afterEach(async () => { await joinOwners(cleanups.splice(0)); });
async function fixture(mainDecisionWindow?: { maxRequests: number }, ordinary?: {
  inference: Pick<AuthManager, "createInferenceSession">;
  modelId: string;
  requestAdmission: StrategicRequestAdmission;
  paused?(): void;
}, options: Pick<RuntimeOptions, "playingAuthorityCeilings" | "assertProgramStart"> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "prepared-runtime-")), store = new Store(directory);
  const adapter = minecraftTestAdapter(), observation = minecraftObservationFixture(adapter);
  const compatibility = adapterCompatibility(adapter.descriptor, adapter.schemas);
  const state: GameState = { status: "connected", username: "Fixture", version: "1.21.4", world_id: observation.world_id,
    epoch: observation.epoch, session_id: observation.session_id, life: observation.life, space: observation.space,
    binding: minecraftTestBinding(adapter), screen: null, presentation: adapter.projectObservation(observation),
    video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
    last_observation_at: observation.captured_at, error: null };
  const cloud = Promise.withResolvers<Agent>(), cloudOpening = Promise.withResolvers<void>();
  void cloud.promise.catch(() => {});
  const submitted = Promise.withResolvers<void>(), workerClosed = Promise.withResolvers<void>();
  const inputWaiters = new Set<() => void>();
  let frameSequence = 0, inputCount = 0, closeCount = 0, activations = 0, takes = 0, ordinaryCompiles = 0;
  let sourceHashAtTake: string | null = null;
  const sample = async () => {
    const frame = controllerFrameFixture(observation.life.life_id, observation.space.space_epoch);
    frame.frame_seq = ++frameSequence; frame.native_tick = 1000 + frameSequence;
    frame.captured_native_ns = String(Math.round(performance.now() * 1e6));
    frame.dynamic_entities.native_tick = frame.native_tick; frame.dynamic_entities.captured_native_ns = frame.captured_native_ns;
    frame.inventory.captured_native_ns = frame.captured_native_ns;
    return frame;
  };
  const held = { forward: true, back: false, left: false, right: false, jump: false,
    sprint: false, sneak: false, attack: false, use: false };
  const choice = { kind: "raw" as const, input: { kind: "world" as const, held, view: { kind: "unchanged" as const }, selected_hotbar: null } };
  const decision = (value: Json) => ({ choice, next_state: value, status: "running" as const, events: [] });
  const worker: ResidentWorker = { async activate(_frame, value, _intent) { activations++; return decision(value); },
    async step(_frame, value, _intent) { return decision(value); }, async close() { closeCount++; workerClosed.resolve(); } };
  const game: GameBridge = { snapshot: () => state, adapter: () => adapter, observe: async () => observation,
    connect: async () => { throw new Error("Runtime admission must not reconnect the world"); },
    disconnect: async () => { throw new Error("Ordinary Stop must preserve the healthy world"); }, subscribe: () => () => {},
    execute: async () => { throw new Error("No semantic fixture action"); }, cancel: async () => {}, neutralize: async () => {}, emergencyStop: async () => {},
    queryCapability: async () => await sample() as unknown as Json,
    openController: async (reservation, generation, _deadline, applied) => {
      const owner = { operation_id: reservation.operation_id, generation: 1, scope: reservation.scope };
      let sequence = 0, retired = false;
      return { owner, controllerGeneration: generation, sample: async () => await sample() as unknown as Json,
        renew: async () => {}, submit(_frame, input) {
          if (retired || input.kind !== "world") throw new Error("Invalid fixture producer");
          const current = ++sequence; inputCount++; submitted.resolve();
          for (const resolve of inputWaiters) resolve();
          inputWaiters.clear();
          queueMicrotask(() => applied({ controller_generation: generation, sequence: current, ordered_edge_prefix: 0,
            applied_native_tick: 1000 + frameSequence, applied_native_ns: String(Math.round(performance.now() * 1e6)),
            held: { ...input.held }, applied_pose: { yaw_radians: 0, pitch_radians: 0 }, input_application: "confirmed", reason: null }));
          return { sequence: current, status: "submitted", reason: null };
        }, snapshot: () => ({ fenced: retired, retired, submitted_sequence: sequence, applied_sequence: sequence,
          ordered_edge_prefix: 0, pending_frames: 0, pending_edges: 0, last_input: null, reason: null, fault: null }),
        revoke: async () => { retired = true; return { owner, controller_generation: generation, admission_revoked: true,
          last_applied_sequence: sequence, ordered_edge_prefix: 0, retirement_applied_native_tick: 1000 + frameSequence,
          retirement_applied_native_ns: String(Math.round(performance.now() * 1e6)), input_application: "confirmed", unresolved_operation_refs: [] }; },
      };
    } };
  const authState: AuthState = { authenticated: true, status: "ready", provider: "openai-codex", account_label: null,
    models: [{ id: ordinary?.modelId ?? "fixture-model", name: "Fixture", provider: "openai-codex", context_window: null, input_modalities: ["image"] }], login: null, error: null };
  const auth = { snapshot: () => authState, createAgent: async () => { cloudOpening.resolve(); return await cloud.promise; },
    createInferenceSession: ordinary?.inference.createInferenceSession.bind(ordinary.inference),
    releaseAgent: async () => {} } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    createResidentWorker: async () => { ordinaryCompiles++; throw new Error("Prepared root must not compile again after join"); },
    createResidentAnalysisWorker: async () => { throw new Error("No fixture analysis"); },
    runSkill: async () => { throw new Error("No legacy root"); } } as unknown as SandboxService;
  let runtime!: Runtime;
  runtime = new Runtime(store, auth, game, sandbox, () => {
    if (ordinary?.paused && runtime?.snapshot()?.status === "paused") ordinary.paused();
  }, { adapter, mainDecisionWindow, ...options,
    ...(ordinary ? { requestAdmission: ordinary.requestAdmission } : { strategicAgentFactory: auth }) });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; cloud.reject(new Error("Original pending cloud allocation ended by fixture"));
    try { await runtime.close(); if (takes === 0) await worker.close(); }
    finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  };
  cleanups.push(close);
  await runtime.initialize();
  const book = new PreparedSourcebook(compatibility.compatibility_hash, adapter, () => {}, () => {});
  await book.write({ name: "decision", entry: "library", card,
    source: `export function decide(state) { return ${JSON.stringify(decision(null))}; }` }, "library-write", "fixture-source-response");
  await book.write({ name: "prepared root", entry: "step", card,
    source: 'import {decide} from "./decision.js"; export function step(frame,state,intent){return decide(state);} export function activate(frame,state,intent){return step(frame,state,intent);}',
    dependencies: [{ name: "decision", version: 1, import_path: "./decision.js" }] }, "root-write", "fixture-source-response");
  const root = book.select({ name: "prepared root", version: 1 }), bundle = book.bundle(root, true);
  const usage = emptyRunUsage(); recordCall(usage, "authoring"); recordCall(usage, "authoring");
  const id = crypto.randomUUID();
  const candidate: PreparedSourceCandidate = { preparation_id: id, request: { request_id: crypto.randomUUID(), task: "Prepared first-root software proof",
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: ordinary?.modelId ?? "fixture-model" }, contract_hash: compatibility.compatibility_hash,
    artifact_sha256: "a".repeat(64), sources: book.sources(root), root, bundle, initial_state: null, intent: null,
    limits: { ...DEFAULT_RESIDENT_LIMITS }, session: controlSessionConfigSchema.parse({ schema_version: 1 }), usage,
    deadline_host_ms: performance.now() + 300000, assertCurrent() {}, setPhase() {},
    takeWorker(runId) { takes++; sourceHashAtTake = store.skillExecution(runId, { start_key: `prepared_${id}` })?.source_hash ?? null; return worker; },
    transferClosed() { throw new Error("No launch coordinator owns this software-only fixture"); } };
  return { runtime, store, candidate, cloud, submitted: submitted.promise, workerClosed: workerClosed.promise, cloudOpening: cloudOpening.promise,
    nextInput: () => new Promise<void>(resolve => { inputWaiters.add(resolve); }),
    counts: () => ({ inputCount, closeCount, activations, takes, ordinaryCompiles, sourceHashAtTake }),
    close };
}

test("first compiled executive controls before cloud readiness and Stop retires it while the original cloud allocation drains", async () => {
  const f = await fixture();
  const starting = f.runtime.startPreparedRun(f.candidate);
  try {
    await Promise.race([f.cloudOpening, starting.then(() => { throw new Error("Prepared startup settled without cloud acquisition"); })]);
    await f.submitted;
    expect(f.counts()).toMatchObject({ activations: 1, takes: 1, ordinaryCompiles: 0, sourceHashAtTake: f.candidate.bundle.source_hash });
    const run = f.runtime.snapshot()!;
    expect(run.usage.calls).toBe(2);
    const stopping = f.runtime.control(run.run_id, "stop");
    await f.workerClosed;
    expect(f.counts().closeCount).toBe(1);
    await f.close(); await starting; await stopping;
  } catch (error) { await f.close(); throw error; }
}, 10000);

test("prepared local control does not suppress Main's initial ordinary task decision until root retirement", async () => {
  const f = await fixture(), prompted = Promise.withResolvers<Record<string, unknown>>();
  const hooks = new DiagnosticModelHooks();
  let listener: ((event: AgentEvent) => void) | null = null, tools: AgentTool[] = [];
  const agent = {
    addBeforeModelCallHook: hooks.add, setBeforeModelCall() {}, replaceMessages() {},
    setTools(value: AgentTool[]) { tools = value; },
    subscribe(value: (event: AgentEvent) => void) { listener = value; return () => { listener = null; }; },
    abort() {}, async waitForIdle() {},
    async prompt(text: string) {
      await hooks.run(undefined, { systemPrompt: [], messages: [], tools });
      prompted.resolve(JSON.parse(text));
      listener?.({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } as unknown as AgentEvent);
    },
  } as unknown as Agent;
  const starting = f.runtime.startPreparedRun(f.candidate);
  try {
    await f.cloudOpening; await f.submitted;
    f.cloud.resolve(agent);
    await starting;
    const timeout = setTimeout(() => prompted.reject(new Error("Initial Main decision waited for live root retirement")), 2000);
    let context: Record<string, unknown>;
    try { context = await prompted.promise; } finally { clearTimeout(timeout); }
    expect(context).toMatchObject({ reason: ["preflight_ready"], pending_decision: true, role: "planning" });
    const run = f.runtime.snapshot()!;
    expect(f.store.latestRootExecution(run.run_id)).toMatchObject({ status: "running", ended_at: null });
    expect(f.counts()).toMatchObject({ activations: 1, takes: 1, ordinaryCompiles: 0 });
  } finally { await f.close(); await starting; }
}, 10000);

const playingCeilings = () => ({
  limits: { ...DEFAULT_RESIDENT_LIMITS, max_analysis_jobs: 0, max_analysis_ms: 0 },
  session: controlSessionConfigSchema.parse({ schema_version: 1, retained_tasks: 128 }),
});
function authorityContext(context: Context) {
  for (const text of context.systemPrompt ?? []) {
    try {
      const value = JSON.parse(text);
      if (value.strategic_context) return value.strategic_context;
    } catch { /* The root prompt is prose. */ }
  }
  throw new Error("Ordinary SDK consumer did not receive bounded strategic context");
}

test("ordinary cognition receives immutable playing bounds and exact first, penultimate and final Main budgets before a refused handoff can retire its predecessor", async () => {
  const model = getBundledModels("openai-codex")[0];
  if (!model) throw new Error("Offline descriptor required by the infrastructure fixture");
  const configured = playingCeilings(), effective = structuredClone(configured);
  const contexts: Context[] = [], bodies: Record<string, unknown>[] = [], reservations: string[] = [];
  const admitted: unknown[] = [], drained = Promise.withResolvers<readonly string[]>();
  let originalDeadline = "", originalId = "";
  let f!: Awaited<ReturnType<typeof fixture>>;
  const inference = new AcceptanceLoopbackInference(model, ({ ordinal, body }) => {
    bodies.push(body);
    if (ordinal > 3) throw new Error("No dispatch may follow the configured Main window");
    const run = f.runtime.snapshot()!, root = f.store.latestRootExecution(run.run_id)!;
    expect(root).toMatchObject({ entry: "step", status: "running", ended_at: null });
    if (ordinal === 1) { originalId = root.execution_id; originalDeadline = root.deadline_at; }
    expect(root.execution_id).toBe(originalId); expect(root.deadline_at).toBe(originalDeadline);
    expect(f.counts().closeCount).toBe(0);
    const output = ordinal === 1 ? { call: { id: "over-ceiling-handoff", name: "program_run", arguments: {
      operation: "start", name: "prepared root", version: 1, entry: "step", args: { actor: "UNCHANGED_INTENT" },
      initial_state: { actor: "UNCHANGED_STATE" },
      limits: effective.limits, session: { ...effective.session, max_calls: effective.session.max_calls + 1 },
      handoff: { name: "prepared root", version: 1, execution_ordinal: 1 },
    } } } : ordinal === 2 ? { call: { id: "inspect-playing-help", name: "help", arguments: { topic: "controller" } } }
      : { text: "Finite administrative request settled." };
    return { iterator: (async function* () { yield codexLifecycleFrames(ordinal, output); })() };
  });
  cleanups.push(() => inference.close());
  f = await fixture({ maxRequests: 3 }, { modelId: inference.model.id, inference,
    requestAdmission: {
      reserve: id => { reservations.push(id); },
      beforeDispatch: async ({ context }) => { contexts.push(structuredClone(context)); },
      transportEnded: () => {}, drained: ids => drained.resolve([...ids]),
    },
  }, { playingAuthorityCeilings: configured, assertProgramStart: request => { admitted.push(structuredClone(request)); } });
  const candidate = { ...f.candidate, limits: { ...effective.limits }, session: { ...effective.session } };
  // Caller mutation cannot change the accepted effective configuration.
  configured.session.max_calls = 1; configured.limits.max_steps = 1;
  const settled = Promise.withResolvers<void>();
  const off = f.store.subscribe(event => {
    if (event.type === "scheduler.turn_deferred") settled.resolve();
    if (event.type === "scheduler.turn_failed" || event.type === "cognition.contained")
      settled.reject(new Error("Ordinary finite disclosure must not fail cognition ownership"));
  });
  const starting = f.runtime.startPreparedRun(candidate);
  try {
    await starting; await settled.promise; expect(await drained.promise).toEqual(reservations);
    expect(contexts).toHaveLength(3); expect(bodies).toHaveLength(3);
    const projections = contexts.map(authorityContext);
    for (let index = 0; index < projections.length; index++) {
      const projection = projections[index]!;
      expect(Buffer.byteLength(JSON.stringify({ strategic_context: projection }))).toBeLessThanOrEqual(32768);
      expect(projection.authority).toEqual({ playing_authority: effective, main_decision_window: {
        max_requests: 3, admitted_requests: index + 1, remaining_requests: 2 - index,
        count_semantics: "after_current_request_admission",
      } });
      expect(JSON.stringify(bodies[index])).toContain(JSON.stringify(JSON.stringify(projection.authority)).slice(1, -1));
    }
    // Preparation contributed two inclusive usage calls, but never Main admissions.
    expect(f.runtime.snapshot()!.usage.calls).toBe(5);
    const refusal = contexts[1]!.messages.filter(message => message.role === "toolResult")
      .find(message => message.toolName === "program_run");
    expect(refusal).toBeDefined();
    const refusedText = refusal!.content.filter(part => part.type === "text").map(part => part.text).join("");
    const error = JSON.parse(refusedText).error;
    expect(error.code).toBe("budget_exceeded");
    const diagnostic = JSON.parse(error.message.slice("Declared playing authority refused: ".length));
    expect(diagnostic).toMatchObject({ violated_field: "session.max_calls", ceilings: effective,
      operation_admitted: false, authority_renewed: false,
      live_program_replacement: "actual_exact_handoff_required" });
    expect(error.message).not.toContain("UNCHANGED_");
    const help = contexts[2]!.messages.filter(message => message.role === "toolResult")
      .find(message => message.toolName === "help");
    expect(help).toBeDefined();
    expect(JSON.parse(help!.content.filter(part => part.type === "text").map(part => part.text).join("")))
      .toMatchObject({ playing_authority: effective, playing_entry: "step", playing_session_required: true });
    expect(admitted).toHaveLength(1); // Additional policy callback only saw the legal initial admission.
    const run = f.runtime.snapshot()!;
    expect(f.store.allSkillExecutions(run.run_id)).toHaveLength(1);
    expect(f.store.latestRootExecution(run.run_id)).toMatchObject({ execution_id: originalId,
      deadline_at: originalDeadline, status: "running", ended_at: null, args: null, initial_state: null,
      limits: effective.limits, session: effective.session });
    expect(f.counts()).toMatchObject({ takes: 1, activations: 1, ordinaryCompiles: 0, closeCount: 0 });
    const cognition = Reflect.get(f.runtime, "strategic") as CognitionClient;
    cognition.wake("resident_attention"); cognition.wake("preflight_ready");
    expect(cognition.snapshot()).toMatchObject({ pid: null, fenced: true,
      turn_id: null, request_id: null, context_id: null });
    expect(bodies).toHaveLength(3); expect(reservations).toHaveLength(3);
    const before = f.counts().inputCount; await f.nextInput();
    expect(f.counts().inputCount).toBeGreaterThan(before);
    expect(bodies).toHaveLength(3);
    await f.runtime.control(run.run_id, "stop");
    expect(f.counts().closeCount).toBe(1); expect(bodies).toHaveLength(3);
  } finally { off(); await joinOwners([() => f.close(), () => starting, () => inference.close()]); }
}, 10_000);

test("configured playing authority refuses the initial prepared root before acceptance or worker transfer", async () => {
  let additional = 0;
  const effective = playingCeilings();
  const f = await fixture(undefined, undefined, {
    playingAuthorityCeilings: effective, assertProgramStart: () => { additional++; },
  });
  const candidate = { ...f.candidate,
    limits: { ...effective.limits, max_steps: effective.limits.max_steps + 1 }, session: effective.session };
  await expect(f.runtime.startPreparedRun(candidate)).rejects.toMatchObject({ code: "budget_exceeded" });
  const run = f.runtime.snapshot()!;
  expect(f.store.allSkillExecutions(run.run_id)).toHaveLength(0);
  expect(f.counts()).toMatchObject({ takes: 0, activations: 0, ordinaryCompiles: 0, inputCount: 0 });
  expect(additional).toBe(0);
});

test("the existing additional program-start callback still refuses an otherwise legal configured initial root", async () => {
  const effective = playingCeilings(), policyRefusal = new RuntimeFault("precondition_failed", "Additional immutable policy gate refused");
  let checked = 0;
  const f = await fixture(undefined, undefined, { playingAuthorityCeilings: effective,
    assertProgramStart: () => { checked++; throw policyRefusal; } });
  const candidate = { ...f.candidate, limits: effective.limits, session: effective.session };
  await expect(f.runtime.startPreparedRun(candidate)).rejects.toBe(policyRefusal);
  expect(checked).toBe(1); expect(f.counts().takes).toBe(0);
  expect(f.store.allSkillExecutions(f.runtime.snapshot()!.run_id)).toHaveLength(0);
});

test("ordinary Cognition process, auth and transport fully drain before the same finite session accepts further local submissions until Stop", async () => {
  const model = getBundledModels("openai-codex")[0];
  if (!model) throw new Error("Offline descriptor required by the infrastructure fixture");
  const releaseResponse = Promise.withResolvers<void>(), ownershipDrained = Promise.withResolvers<readonly string[]>();
  const reservations: string[] = [], dispatches: string[] = [], fetches: string[] = [];
  const transportEnds: { id: string; natural: boolean }[] = [];
  let providerRequests = 0, providerDrained = false, authClosed = false, sessions = 0;
  const inference = new AcceptanceLoopbackInference(model, async ({ ordinal }) => {
    providerRequests++;
    if (ordinal !== 1) throw new Error("No provider request may follow the closed Main window");
    await releaseResponse.promise;
    return { iterator: (async function* () {
      try { yield codexLifecycleFrames(ordinal, { text: "Finite administrative decision complete." }); }
      finally { providerDrained = true; }
    })() };
  });
  cleanups.push(async () => { releaseResponse.resolve(); await inference.close(); });
  const f = await fixture({ maxRequests: 1 }, {
    modelId: inference.model.id,
    inference: { createInferenceSession: options => {
      sessions++;
      const session = inference.createInferenceSession(options);
      return { ...session, close: async () => { await session.close(); authClosed = true; } };
    } },
    requestAdmission: {
      reserve: id => { reservations.push(id); },
      beforeDispatch: async ({ identity }) => { dispatches.push(identity.request_id); },
      beforeSdkFetch: async ({ identity }) => { fetches.push(identity.request_id); },
      transportEnded: (id, natural) => { transportEnds.push({ id, natural }); },
      drained: ids => { ownershipDrained.resolve([...ids]); },
    },
  });
  const deferred = Promise.withResolvers<void>();
  const off = f.store.subscribe(event => {
    if (event.type === "scheduler.turn_deferred") deferred.resolve();
    if (event.type === "scheduler.turn_failed") deferred.reject(new Error("Main request closure retired the eligible executive"));
  });
  const starting = f.runtime.startPreparedRun(f.candidate);
  try {
    await f.submitted;
    const before = f.runtime.snapshot()!, original = f.store.latestRootExecution(before.run_id)!;
    if (original.entry !== "step") throw new Error("Prepared-runtime proof requires the actual finite executive");
    const authority = { execution_id: original.execution_id, source_hash: original.source_hash,
      deadline_at: original.deadline_at, session: original.session, limits: original.limits,
      run_generation: original.run_generation, session_id: original.session_id, native_boot_id: original.native_boot_id };
    releaseResponse.resolve(); await starting; await deferred.promise;
    const drainedRequests = await ownershipDrained.promise;
    expect(authClosed).toBe(true); expect(providerDrained).toBe(true);
    expect(drainedRequests).toEqual(reservations);
    expect(reservations).toHaveLength(1); expect(dispatches).toEqual(reservations);
    expect(fetches).toEqual(reservations);
    expect(transportEnds).toEqual([{ id: reservations[0]!, natural: true }]);
    const cognition = Reflect.get(f.runtime, "strategic") as CognitionClient;
    expect(cognition).toBeInstanceOf(CognitionClient);
    expect(cognition.snapshot()).toMatchObject({ pid: null, turn_id: null, request_id: null, context_id: null });
    const inputsAfterDrain = f.counts().inputCount;
    await f.nextInput();
    expect(f.counts().inputCount).toBeGreaterThan(inputsAfterDrain);
    expect(f.runtime.snapshot()).toMatchObject({ status: "running", model_status: "idle",
      world_id: before.world_id, session_id: before.session_id, epoch: before.epoch, life_id: before.life_id });
    expect(f.store.latestRootExecution(before.run_id)).toMatchObject({ ...authority, status: "running", ended_at: null });
    expect(f.counts()).toMatchObject({ activations: 1, takes: 1, ordinaryCompiles: 0, closeCount: 0 });
    expect(providerRequests).toBe(1); expect(sessions).toBe(1);
    const events = f.store.eventsAfter(before.run_id, 0, 500);
    const started = events.find(event => event.type === "cognition.started")?.details as { worker_pid: number } | undefined;
    expect(started?.worker_pid).toBeDefined(); expect(started?.worker_pid).not.toBe(process.pid);
    expect(events.some(event => event.type === "cognition.contained" || event.type === "scheduler.turn_failed")).toBe(false);
    expect(events.filter(event => event.type === "scheduler.decision_window_closed").map(event => event.details))
      .toEqual([{ outcome: "decision_window_closed", reason: "request_limit", admitted_requests: 1, max_requests: 1,
        automatic_retry: false, physical_authority_renewed: false }]);
    expect(events.find(event => event.type === "scheduler.turn_deferred")?.details)
      .toMatchObject({ reason: "request_limit", root_execution_id: original.execution_id,
        original_root_deadline_at: original.deadline_at, automatic_retry: false });
    await f.runtime.control(before.run_id, "stop");
    expect(f.runtime.snapshot()?.status).toBe("stopped");
    expect(f.counts().closeCount).toBe(1); expect(providerRequests).toBe(1);
  } finally {
    releaseResponse.resolve(); off();
    await joinOwners([() => f.close(), () => starting, () => inference.close()]);
  }
}, 10_000);

test("a final-slot real provider failure physically pauses Runtime instead of preserving its executive as normal budget expiry", async () => {
  const model = getBundledModels("openai-codex")[0];
  if (!model) throw new Error("Offline descriptor required by the infrastructure fixture");
  const releaseResponse = Promise.withResolvers<void>(), paused = Promise.withResolvers<void>();
  const reservations: string[] = [], drained: string[][] = [];
  let requests = 0, providerDrained = false, authClosed = false;
  const inference = new AcceptanceLoopbackInference(model, async ({ ordinal }) => {
    requests++;
    if (ordinal !== 1) throw new Error("A provider failure must not admit another Main request");
    await releaseResponse.promise;
    return { iterator: (async function* () {
      try {
        yield `data: ${JSON.stringify({ type: "response.failed", response: { id: "failed-final-admission",
          status: "failed", error: { code: "server_error", message: "Controlled administrative provider failure" } } })}\n\n`;
      } finally { providerDrained = true; }
    })() };
  });
  cleanups.push(async () => { releaseResponse.resolve(); await inference.close(); });
  const f = await fixture({ maxRequests: 1 }, {
    modelId: inference.model.id,
    inference: { createInferenceSession: options => {
      const session = inference.createInferenceSession(options);
      return { ...session, close: async () => { await session.close(); authClosed = true; } };
    } },
    requestAdmission: {
      reserve: id => { reservations.push(id); },
      transportEnded: () => {},
      drained: ids => { drained.push([...ids]); },
    },
    paused: () => paused.resolve(),
  });
  const starting = f.runtime.startPreparedRun(f.candidate);
  try {
    await f.submitted;
    const run = f.runtime.snapshot()!, original = f.store.latestRootExecution(run.run_id)!;
    expect(original).toMatchObject({ status: "running", ended_at: null });
    releaseResponse.resolve(); await starting; await paused.promise;
    expect(f.runtime.snapshot()).toMatchObject({ status: "paused", operator: { pause_cause: "provider_failure" } });
    expect(f.counts().closeCount).toBe(1);
    const retired = f.store.latestRootExecution(run.run_id)!;
    expect(retired.status).not.toBe("running"); expect(retired.ended_at).not.toBeNull();
    expect(retired.deadline_at).toBe(original.deadline_at);
    expect(providerDrained).toBe(true); expect(authClosed).toBe(true);
    expect(reservations).toHaveLength(1); expect(drained.flat()).toEqual(reservations);
    const cognition = Reflect.get(f.runtime, "strategic") as CognitionClient;
    expect(cognition.snapshot()).toMatchObject({ pid: null, fenced: true, closing: false });
    cognition.wake("resident_attention"); cognition.wake("goal_review");
    await cognition.close();
    const events = f.store.eventsAfter(run.run_id, 0, 500);
    expect(events.some(event => event.type === "scheduler.turn_deferred")).toBe(false);
    expect(requests).toBe(1);
    const inputsAtPause = f.counts().inputCount;
    await f.runtime.control(run.run_id, "stop");
    expect(f.runtime.snapshot()?.status).toBe("stopped");
    expect(f.counts().inputCount).toBe(inputsAtPause); expect(requests).toBe(1);
  } finally {
    releaseResponse.resolve();
    await joinOwners([() => f.close(), () => starting, () => inference.close()]);
  }
}, 10_000);
