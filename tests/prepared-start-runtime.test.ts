import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { DiagnosticModelHooks } from "../src/evaluation/diagnostic-model-hooks.ts";
import type { AuthState, GameBridge, GameState, Json } from "../src/shared/contracts.ts";
import type { ResidentWorker } from "../src/shared/resident.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { controlSessionConfigSchema } from "../src/shared/control-session.ts";
import { Store } from "../src/server/store.ts";
import { Runtime } from "../src/server/runtime.ts";
import type { AuthManager } from "../src/server/auth.ts";
import type { SandboxService } from "../src/server/sandbox.ts";
import type { PreparedSourceCandidate } from "../src/server/prepared-source-contract.ts";
import { PreparedSourcebook } from "../src/server/prepared-sourcebook.ts";
import { adapterCompatibility } from "../src/server/adapter-contract.ts";
import { emptyRunUsage, recordCall } from "../src/server/usage.ts";
import { controllerFrameFixture } from "./helpers/controller-frame.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./helpers/adapter-contract.ts";

const card = { purpose: "First-root lifecycle fixture", applicability: "Synthetic boundaries only",
  method: "Prepared worker before cloud readiness", reason: "Keep control independent", limitations: "No model or native gameplay claim" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
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
    models: [{ id: "fixture-model", name: "Fixture", provider: "openai-codex", context_window: null, input_modalities: ["image"] }], login: null, error: null };
  const auth = { snapshot: () => authState, createAgent: async () => { cloudOpening.resolve(); return await cloud.promise; },
    releaseAgent: async () => {} } as unknown as AuthManager;
  const sandbox = { snapshot: () => ({ status: "ready", image: "fixture", error: null }),
    createResidentWorker: async () => { ordinaryCompiles++; throw new Error("Prepared root must not compile again after join"); },
    createResidentAnalysisWorker: async () => { throw new Error("No fixture analysis"); },
    runSkill: async () => { throw new Error("No legacy root"); } } as unknown as SandboxService;
  const runtime = new Runtime(store, auth, game, sandbox, () => {}, { adapter });
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
    goal: adapter.goals.find(goal => goal.goal_id === "custom")!, model_id: "fixture-model" }, contract_hash: compatibility.compatibility_hash,
    artifact_sha256: "a".repeat(64), sources: book.sources(root), root, bundle, initial_state: null, intent: null,
    limits: { ...DEFAULT_RESIDENT_LIMITS }, session: controlSessionConfigSchema.parse({ schema_version: 1 }), usage,
    deadline_host_ms: performance.now() + 300000, assertCurrent() {}, setPhase() {},
    takeWorker(runId) { takes++; sourceHashAtTake = store.skillExecution(runId, { start_key: `prepared_${id}` })?.source_hash ?? null; return worker; },
    transferClosed() { throw new Error("No launch coordinator owns this software-only fixture"); } };
  return { runtime, store, candidate, cloud, submitted: submitted.promise, workerClosed: workerClosed.promise, cloudOpening: cloudOpening.promise,
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
