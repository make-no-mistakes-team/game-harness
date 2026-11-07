import { mock } from "bun:test";
import { mkdir, writeFile, readFile, readdir, stat, access, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomFillSync } from "node:crypto";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { GameBridge, GameState, ObservationV3 } from "../../src/shared/contracts.ts";
import { nativeFrame } from "./native-frame.ts";
import * as native from "../../src/evaluation/native-game.ts";
import { AttemptLedger } from "../../src/evaluation/policy.ts";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { studyExecutionFixture } from "./study-execution-fixture.ts";
import type { IsolatedStudyCheckout } from "./isolated-study-checkout.ts";
import { emptyRunUsage } from "../../src/server/usage.ts";
import { Store, type StoredRun } from "../../src/server/store.ts";
import { StudyLedger, type StudyRef, type StudySlot } from "../../src/evaluation/studies.ts";
import { minecraftObservationFixture, minecraftTestAdapter, minecraftTestBinding } from "./adapter-contract.ts";
import { PrivateJournal } from "../../src/evaluation/private-journal.ts";
import * as historyModule from "../../src/server/history-reader.ts";
import type { HistoryQuery, HistoryQueryOptions, HistoryResult } from "../../src/server/history-protocol.ts";
import * as recording from "../../src/server/recording.ts";

// Only native ownership, Docker provisioning and the authenticated provider
// factory are substituted. Runner, Runtime, Agent/gates/events, Store, verifier,
// recorder/codec/owned encoder child, private journal and ledger remain real.
// All replacements and environment changes live in this isolated subprocess.
// These offline-renderer ownership cases explicitly select lossless capture.
mock.module(resolve(import.meta.dir, "../../src/server/recording.ts"), () => ({
  ...recording,
  EpisodeRecorder: class extends recording.EpisodeRecorder {
    constructor(options: recording.RecordingOptions) { super({ ...options, captureMode: "lossless_png" }); }
  },
}));
const [requestedMode, rootArg, ownershipArg] = process.argv.slice(2);
const studyMode = requestedMode?.startsWith("study-") ?? false;
const developmentMode = requestedMode?.startsWith("development-") ?? false;
const mode = studyMode ? requestedMode!.slice("study-".length) : developmentMode ? requestedMode!.slice("development-".length) : requestedMode;
const customFinish = developmentMode && mode === "custom-finish";
const observerParity = developmentMode && mode === "observer-parity";
const planningStalled = mode === "planning-stalled";
const requestCapNonGoal = mode === "request-cap-non-goal";
const cancelBeforeIterator = mode === "cancel-before-iterator";
if (!rootArg) throw new Error("Missing isolated acceptance root");
const root = rootArg;
if (mode === "native-close-late") {
  // Before mock registration: exercise the actual fixture's public ownership
  // close and finish, with only the external bridge close held past its cap.
  const { createEvaluationCaps } = await import("../../src/evaluation/config.ts");
  process.env.GAMEHARNESS_NATIVE_PROOF = "1";
  const fixture = await native.NativeFixture.create("late-close", {
    projectRoot: root, authDirectory: root,
    paths: { runtimeRoot: join(root, "runtime"), reportsRoot: join(root, "reports"), governanceRoot: join(root, "governance") },
    caps: createEvaluationCaps({ cleanupMs: 20 }),
  });
  let closedAt: number | null = null;
  const ownedBridge = {
    owned: {},
    async close() { await Bun.sleep(80); Reflect.set(this, "owned", null); closedAt = performance.now(); },
  };
  Reflect.set(fixture, "bridge", ownedBridge);
  await fixture.case("owned-close-bound", {}, async () => {});
  const closeResult = await fixture.close(), closeReturnedAt = performance.now();
  await fixture.finish();
  const finishedAt = performance.now();
  await writeFile(join(root, "fixture-result.json"), JSON.stringify({
    closeResult, closeReturnedAt, closedAt, finishedAt,
    report: JSON.parse(await readFile(join(fixture.evidenceDirectory, "report.json"), "utf8")),
  }));
  await Bun.write(Bun.stdout, "ACCEPTANCE_RESULT fixture-result.json\n");
  process.exit(process.exitCode ?? 0);
}
const earlyDeadlineSignal = mode === "early-deadline-sigint";
const createEntered = Promise.withResolvers<void>(), releaseCreate = Promise.withResolvers<void>();
const nativeCloseEntered = Promise.withResolvers<void>(), releaseNativeClose = Promise.withResolvers<void>();
let workDeadline: number | null = null, signalAt: number | null = null, signalHandoffAt: number | null = null;
let monotonicOffset = 0;
let earlyFinalizerSettledAt: number | null = null, earlyFinalizerSettledWhileNativeHeld: boolean | null = null;
if (earlyDeadlineSignal) {
  const now = performance.now.bind(performance);
  performance.now = () => now() + monotonicOffset;
  const register = postmortem.register;
  mock.module("@oh-my-pi/pi-utils/postmortem", () => ({
    ...postmortem,
    register: (...args: Parameters<typeof postmortem.register>) => {
      const [name, callback, options] = args;
      return register(name, name.startsWith("acceptance-startup-") ? async why => {
        await callback(why);
        earlyFinalizerSettledAt = performance.now();
      } : callback, options);
    },
  }));
}
const imageFailure = mode === "image-before-first" || mode === "image-after-settled";
const manifestFailure = mode === "manifest-failure" || mode === "manifest-failure-sigint";
const preparationExpired = mode === "budget-preparation-expired";
const preparationBounded = mode === "budget-preparation-bounded";
const finalVerificationBudget = mode === "budget-final-verification";
const finalPersistenceBudget = mode === "budget-final-persistence";
const budgetMode = preparationExpired || preparationBounded || finalVerificationBudget || finalPersistenceBudget;
const ownedRuntimeRoot = studyMode ? join(root, "runtime/owned-slot") : join(root, "runtime");
const evidenceDirectory = join(ownedRuntimeRoot, "evidence"), governanceRoot = join(root, "governance");
const isolatedCheckout: IsolatedStudyCheckout | undefined = studyMode ? JSON.parse(ownershipArg ?? "null") : undefined;
const executionFixture = studyMode ? studyExecutionFixture(true, "synthetic-study-lifecycle", { isolatedCheckout }) : undefined;
const project = executionFixture?.projectRoot ?? join(root, "project"), authDirectory = join(root, "auth-data");
await mkdir(root, { recursive: true, mode: 0o700 });
await Promise.all([mkdir(evidenceDirectory, { recursive: true }), mkdir(project, { recursive: true }), mkdir(join(authDirectory, "auth"), { recursive: true }), mkdir(join(root, "bin"))]);
await writeFile(join(authDirectory, "auth/gameharness.sqlite"), "synthetic factory never opens credentials");
process.env.GAMEHARNESS_DATA_DIR = join(root, "runtime");
process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;
process.env.ACCEPTANCE_LIFECYCLE_RELEASE = join(root, "release-render");
await writeFile(join(root, "bin/ffmpeg"), `#!${process.execPath}\nimport { writeFileSync, existsSync } from "node:fs";\nwriteFileSync("renderer.pid", String(process.pid));\nfunction complete() { writeFileSync("replay.mp4", "synthetic renderer, never visual proof"); process.exit(0); }\n${budgetMode || customFinish || observerParity || mode === "complete-persistence" || imageFailure || manifestFailure || mode === "request-cap" || mode === "cold-isolation" || planningStalled || requestCapNonGoal ? "complete();" : `setInterval(() => { if (process.ppid !== ${process.pid}) process.exit(1); if (existsSync(process.env.ACCEPTANCE_LIFECYCLE_RELEASE)) complete(); }, 5);`}\n`, { mode: 0o700 });

let providerCalls = 0, starts = 0, nextWorlds = 0, sequence = 0, returned = false, lateWrites = 0;
let authCreates = 0, nativeClosedAt: number | null = null, returnedAt: number | null = null;
let finalDiagnosticsStartedAt: number | null = null, finalDiagnosticsFinishedAt: number | null = null;
let finalPersistenceStartedAt: number | null = null, finalPersistenceFinishedAt: number | null = null;
const readerCloseEntered = Promise.withResolvers<void>(), releaseReaderClose = Promise.withResolvers<void>();
let observerHistory: historyModule.HistoryReader | undefined;
let blockedManifest: string | undefined, manifestPersistenceError: string | undefined;
let storeClosedAt: number | null = null, storeClosedWhileReaderHeld: boolean | null = null;
let returnedWhileReaderHeld: boolean | null = null, readerAliveWhileHeld = false;
let readerBeforeClose: historyModule.HistoryReaderSnapshot | undefined;
let readerAtStoreClose: historyModule.HistoryReaderSnapshot | undefined;
if (manifestFailure) {
  mock.module(resolve(import.meta.dir, "../../src/server/history-reader.ts"), () => ({
    ...historyModule,
    HistoryReader: class extends historyModule.HistoryReader {
      override query<Q extends HistoryQuery>(query: Q, options: HistoryQueryOptions): Promise<HistoryResult<Q>> {
        if (query.kind === "export_page") observerHistory = this;
        return super.query(query, options);
      }
      override async close(): Promise<void> {
        if (this === observerHistory) {
          readerBeforeClose = this.snapshot();
          readerCloseEntered.resolve();
          await releaseReaderClose.promise;
        }
        await super.close();
      }
    },
  }));
  const finalize = PrivateJournal.prototype.finalize;
  PrivateJournal.prototype.finalize = async function (input) {
    // A real filesystem collision rejects PrivateJournal's own manifest
    // write, after its journal has drained. Do not substitute finalization.
    blockedManifest = this.manifest;
    await mkdir(join(evidenceDirectory, this.manifest), { recursive: true });
    try { return await finalize.call(this, input); }
    catch (error) { manifestPersistenceError = String(error); throw error; }
  };
  const closeStore = Store.prototype.close;
  Store.prototype.close = function () {
    storeClosedAt = performance.now();
    readerAtStoreClose = observerHistory?.snapshot();
    return closeStore.call(this);
  };
}
let startupReservationSeen = false, authReservationSeen = false;
let fixtureConditions: unknown = null;
let studySelection: { studyId: string; manifestPath: string; slot: StudySlot } | undefined;
let studyRef: StudyRef | undefined;
async function reservationExists() {
  if (!studyRef) return false;
  const ledger = new StudyLedger(governanceRoot, { projectRoot: project });
  try { return ledger.readStudy(studyRef).attempts.length === 1; } finally { ledger.close(); }
}
let hasWood = false, frameSequence = 0;
const observationReads: Array<{ sequence: number; at: number; hasWood: boolean }> = [];
const paritySnapshots: Array<{ request: number; phase: string; at: number; sequence: number; presentation: GameState["presentation"] }> = [];
const parityProbes: Promise<void>[] = [];
const session = crypto.randomUUID(), world = crypto.randomUUID();
const listeners = new Set<(frame: Uint8Array) => void>();
const motorProfile = mode === "profile-motor-mismatch" ? "fast" : "balanced";
const adapter = minecraftTestAdapter(motorProfile);
const state: GameState = { status: "connected", username: "isolated-player", version: "1.21.4", world_id: world,
  epoch: 1, session_id: session, life: { life_id: 1, status: "alive", can_respawn: false, death: null },
  binding: minecraftTestBinding(adapter), space: { dimension_id: "minecraft:overworld", space_epoch: 1 }, screen: null, presentation: null,
  video: { status: "streaming", width: 2, height: 2, fps: 30, frames: 0, last_frame_at: null, error: null },
  last_observation_at: null, error: null };
function frame() {
  const packet = nativeFrame({ sequence: ++frameSequence, capturedAt: Date.now() });
  for (const listener of listeners) listener(packet);
  return packet;
}
function actorFrame() {
  if (mode !== "image-before-first" && !(mode === "image-after-settled" && providerCalls > 0)) return frame();
  // Valid GHV2/RGBA, but incompressible RGB makes the actual lossless PNG
  // exceed the actor's 2 MiB limit. Recorder deliveries remain valid 2x2
  // frames, isolating actor preparation from independent recorder failure.
  return nativeFrame({ width: 1024, height: 1024, sequence: ++frameSequence, capturedAt: Date.now(),
    pixels: randomFillSync(new Uint8Array(1024 * 1024 * 4)) });
}
const bridge: GameBridge & { subscribeFrames(callback: (frame: Uint8Array) => void): () => void; latestFrame(): Uint8Array } = {
  connect: async () => {}, disconnect: async () => {}, snapshot: () => structuredClone(state),
  async observe(): Promise<ObservationV3> {
    frame();
    const capturedAt = new Date().toISOString();
    const observation = minecraftObservationFixture(adapter, { session_id: session, life: state.life!, world_id: world, epoch: 1,
      observation_seq: ++sequence, captured_at: capturedAt,
      data: { player: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, health: 20, food: 20, on_ground: true, in_water: false,
        inventory: hasWood ? [{ name: "oak_log", display_name: "Oak Log", count: 1, slot: 0 }] : [] },
      blocks: observerParity ? [{ target: { target_id: "parity-visible-stone", incarnation: 1, life_id: 1,
        space: state.space! }, name: "stone", position: { x: 1, y: 63, z: 1 }, current: true, observed_at: capturedAt }] : [],
      entities: [], sounds: [] } });
    state.presentation = adapter.projectObservation(observation); state.last_observation_at = observation.captured_at;
    if (observerParity) observationReads.push({ sequence, at: performance.now(), hasWood });
    return observation;
  },
  execute: async () => { throw new Error("No gameplay effects belong in this lifecycle fixture"); },
  neutralize: async () => {}, cancel: async () => {}, emergencyStop: async () => {}, adapter: () => adapter,
  subscribe: () => () => {}, subscribeFrames(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
  latestFrame: actorFrame,
};
function paritySnapshot(request: number, phase: string) {
  paritySnapshots.push({ request, phase, at: performance.now(), sequence, presentation: bridge.snapshot().presentation });
}
const descriptor = getBundledModels("openai-codex").find(model => model.api === "openai-codex-responses" && model.input.includes("image"));
if (!descriptor) throw new Error("Installed catalog lacks the offline image-capable descriptor");
const model = getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
const siblingId = crypto.randomUUID(), siblingMarker = "SIBLING_PRIVATE_NOTES_MUST_NOT_ENTER_THIS_SLOT";
let siblingHash: string | null = null;
if (mode === "cold-isolation") {
  // Real sibling Store, not a model/game substitute. Production must never
  // select it instead of the fixture's fresh owned Store.
  const sibling = new Store(join(root, "runtime"));
  const run: StoredRun = { run_id: siblingId, world_id: world, epoch: 1, session_id: session, life_id: 1,
    native_boot_id: null, space_epoch: null, compatibility_hash: null,
    task: siblingMarker, goal: "custom", model_id: model.id, status: "stopped", started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(), turns: 0, model_status: "idle", error: null, usage: emptyRunUsage(), baseline: {} };
  sibling.saveRun(run); sibling.event(run.run_id, "private.notes", siblingMarker, null); sibling.close();
  siblingHash = createHash("sha256").update(await readFile(join(root, "runtime/runs.sqlite"))).digest("hex");
}
const actorContexts: string[] = [];
const earlyIterator = cancelBeforeIterator ? { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() } : null;
let originalIteratorReads = 0, originalIteratorReturns = 0, originalIteratorClosed = false;
let returnedBeforeTransportRelease: boolean | null = null, requestSignalAbortedBeforeRead = false;
let requestCapResponseAbortedBeforeDelivery: boolean | null = null;
const stream: StreamFn = (_model, context, options) => {
  providerCalls++;
  const request = providerCalls;
  actorContexts.push(JSON.stringify(context));
  // Inventory gain is a synthetic native observation, not a fake verifier.
  // Parity gain belongs to the native idle probe and survives later requests.
  if (!observerParity) hasWood = !imageFailure && mode !== "cold-isolation" && mode !== "request-cap" &&
    !planningStalled && !requestCapNonGoal && !cancelBeforeIterator;
  const events = new AssistantMessageEventStream();
  const repair = mode === "cold-isolation" && providerCalls <= 2 || requestCapNonGoal && providerCalls === 1;
  const finishing = customFinish && providerCalls === 1;
  const message: AssistantMessage = { role: "assistant", content: finishing ? [{ type: "toolCall", id: crypto.randomUUID(), name: "task_finish",
    arguments: { summary: "Synthetic custom completion claim; not independently verified" } }] : repair ? [{ type: "toolCall", id: crypto.randomUUID(), name: "program_write",
    arguments: { name: "slot-private-repair", source: `return {status:"completed",summary:"Unexecuted local repair revision ${providerCalls}",result:null};`,
      card: { purpose: "Local study isolation fixture", applicability: "This isolated slot only", method: "Retain an unexecuted local source revision",
        reason: "Exercise actual run-private repair", limitations: "Not executed; no gameplay efficacy evidence" }, dependencies: [],
      ...(providerCalls === 2 ? { based_on: 1 } : {}) } }] : [{ type: "text", text: "Synthetic local lifecycle response; no network." }],
    api: model.api, provider: model.provider, model: model.id, stopReason: repair || finishing ? "toolUse" : "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const deliver = () => {
    events.push({ type: "start", partial: message });
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      // The actual SDK discards unfinished streamed calls. Mirror the provider's
      // completed tool sequence so real host dispatch, not fixture Store writes,
      // creates and revises these local programs.
      events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      events.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(content.arguments), partial: message });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: content, partial: message });
    }
    events.push({ type: "done", reason: repair || finishing ? "toolUse" : "stop", message }); events.end();
  };
  if (observerParity) {
    paritySnapshot(request, "request_started");
    parityProbes.push((async () => {
      await Bun.sleep(150);
      paritySnapshot(request, "request_held");
      deliver();
    })());
  } else if (developmentMode && requestCapNonGoal) {
    // The last admitted response must retain authority through delivery and
    // its real program_write. Only the following request may trigger Stop.
    void Bun.sleep(25).then(() => {
      requestCapResponseAbortedBeforeDelivery = options?.signal?.aborted === true;
      deliver();
    });
  } else deliver();
  if (earlyIterator) {
    // This is the actual external stream-acquisition seam. The real Agent's
    // signal is cancelled before its SDK asks the returned iterator for next().
    // Its original transport iterator has explicit, separately joined cleanup.
    events[Symbol.asyncIterator] = () => ({
      next: async () => { originalIteratorReads++; return { done: true as const, value: undefined }; },
      return: async () => {
        originalIteratorReturns++;
        earlyIterator.entered.resolve();
        await earlyIterator.release.promise;
        originalIteratorClosed = true;
        return { done: true as const, value: undefined };
      },
    });
    for (const agent of agents) agent.abort("Synthetic acquisition cancellation before first iterator read");
    requestSignalAbortedBeforeRead = options?.signal?.aborted === true;
    process.kill(process.pid, "SIGINT");
  }
  return events;
};
const agents = new Set<Agent>();
mock.module(resolve(import.meta.dir, "../../src/server/auth.ts"), () => ({ AuthManager: { create: async () => {
  authCreates++;
  authReservationSeen = await reservationExists();
  return ({
  snapshot: () => ({ status: "ready", authenticated: true, provider: "openai-codex", account_label: null, login: null, error: null,
    models: mode === "model-mismatch" ? [] : [{ id: model.id, name: model.name, provider: model.provider, context_window: model.contextWindow,
      input_modalities: ["text", "image"], capability_provenance: "discovered_sdk_descriptor_not_live_vision" }] }),
  createAgent: async (options: { systemPrompt: string[]; tools: Parameters<Agent["setTools"]>[0] }) => {
    const agent = new Agent({ initialState: { model, systemPrompt: options.systemPrompt, tools: options.tools }, streamFn: stream,
      getApiKey: () => "LOCAL_SYNTHETIC_PROVIDER_ONLY" });
    // This case asserts a settled request followed by a verified goal. Publishing
    // gain at acquisition instead races goal Stop against iterator exhaustion,
    // correctly producing unknown consumption even before the run deadline.
    if (mode === "request-cap") agent.subscribe(event => {
      if (event.type === "agent_end") hasWood = true;
    });
    if (observerParity) agent.subscribe(event => {
      if (event.type !== "agent_end" || providerCalls !== 1) return;
      paritySnapshot(1, "request_settled");
      parityProbes.push((async () => {
        await Bun.sleep(150);
        paritySnapshot(1, "idle");
        // The native seam changes inventory only after both quiet windows.
        // Runtime's normal idle wake must obtain and verify it; the fixture
        // never publishes an observation notice or invokes a verifier.
        hasWood = true;
      })());
    });
    agents.add(agent); return agent;
  },
  releaseAgent: async (agent: Agent) => { agent.abort(); await agent.waitForIdle(); agents.delete(agent); },
  close: async () => { for (const agent of agents) { agent.abort(); await agent.waitForIdle(); } agents.clear(); },
}); } } }));
// Intentional loading boundary: preserve real sandbox exports (notably the
// cleanup error contract), but never prepare Docker in this synthetic process.
const sandboxModule = await import("../../src/server/sandbox.ts");
mock.module(resolve(import.meta.dir, "../../src/server/sandbox.ts"), () => ({ ...sandboxModule, SandboxService: class {
  async prepare() {} snapshot() { return { status: "ready", error: null }; } async close() {}
  async execute() { throw new Error("No worker should be started by a text-only synthetic response"); }
} }));
let persistGateUsed = false;
mock.module(resolve(import.meta.dir, "../../src/evaluation/native-game.ts"), () => ({ ...native, NativeFixture: { create: async (
  _label: string, options: Parameters<typeof native.NativeFixture.create>[1],
) => {
  startupReservationSeen = await reservationExists();
  fixtureConditions = options?.conditions ?? null;
  process.env.GAMEHARNESS_DATA_DIR = ownedRuntimeRoot;
  if (earlyDeadlineSignal) {
    workDeadline = options!.preparationDeadlineHostMs!;
    createEntered.resolve();
    await releaseCreate.promise;
  }
  if (preparationExpired) await Bun.sleep(700);
  if (preparationBounded) await Bun.sleep(Math.min(700, Math.max(1,
    (options?.preparationDeadlineHostMs ?? Infinity) - performance.now() + 5)));
  if (finalVerificationBudget) await Bun.sleep(300);
  return ({
  root: ownedRuntimeRoot, evidenceDirectory, bridge, commands: [],
  report: { world_conditions: { synthetic: true }, native_artifact: { sha256: "synthetic-local-native-seam" } },
  start: async () => { starts++; if (mode === "startup-failure") throw new Error("Local synthetic native startup failure"); },
  nextWorld: async () => { nextWorlds++; throw new Error("Interrupted samples must not start another native world"); },
  diagnostics: async () => {
    if (finalVerificationBudget) {
      finalDiagnosticsStartedAt = performance.now();
      await Bun.sleep(1000);
      finalDiagnosticsFinishedAt = performance.now();
    }
    return { controls_neutral: true, motor_active: false, motor_profile: motorProfile };
  },
  close: async () => {
    if (earlyDeadlineSignal) { nativeCloseEntered.resolve(); await releaseNativeClose.promise; }
    if (preparationExpired) await Bun.sleep(150);
    if (preparationBounded) await Bun.sleep(25);
    nativeClosedAt = performance.now();
    return { closed: true };
  },
  writeJson: async (name: string, value: unknown) => { if (returned) lateWrites++; await writeFile(join(evidenceDirectory, name), JSON.stringify(value), { mode: 0o600, flag: "wx" }); },
  writeReport: async (value: { results?: unknown[]; resource_cleanup?: unknown; cleanup_confirmed?: boolean }) => {
    if (returned) lateWrites++;
    await writeFile(join(evidenceDirectory, "report.json"), JSON.stringify(value), { mode: 0o600 });
    if (finalPersistenceBudget && !persistGateUsed && value.cleanup_confirmed) {
      persistGateUsed = true;
      finalPersistenceStartedAt = performance.now();
      await Bun.sleep(190);
      finalPersistenceFinishedAt = performance.now();
    }
    if (mode === "complete-persistence" && !persistGateUsed && value.results?.length === 1 && !value.resource_cleanup) {
      persistGateUsed = true;
      // Pause real report persistence after all case facts have been committed.
      // SIGINT must still make the overall result incomplete, even with a pass case.
      process.kill(process.pid, "SIGINT"); await Bun.sleep(25);
    }
  },
}); } } }));

async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) Object.assign(files, await snapshot(file));
    else { const data = await readFile(file), info = await stat(file, { bigint: true });
      files[file] = `${info.mtimeNs}:${createHash("sha256").update(data).digest("hex")}`; }
  }
  return files;
}
const unhandled: string[] = [];
process.on("unhandledRejection", error => { unhandled.push(String(error)); });
const rendererPidFile = join(evidenceDirectory, "case-collect_wood-recording/renderer.pid");
let rendererStarted = false;
// Intentional loading boundary: runner imports config-consuming production
// modules only after the isolated native/auth/Docker seams have been installed.
const { runAgentAcceptance } = await import("../../scripts/agent-acceptance.ts");
if (studyMode) {
  const manifest = executionFixture!.manifest;
  manifest.identities.model = { provider: model.provider, id: model.id, api: model.api, access: "oauth_subscription" };
  manifest.arms[0]!.model = manifest.identities.model;
  manifest.allowances.per_attempt.wall_ms = imageFailure ? 10000 : planningStalled ? 20000 : 6000;
  manifest.task.horizon_ms = imageFailure ? 8000 : planningStalled ? 15000 : 1000;
  manifest.allowances.cohort.attempt_wall_ms = manifest.allowances.per_attempt.wall_ms * 4;
  manifest.allowances.cohort.elapsed_ms = imageFailure ? 10_000 : planningStalled ? 60_000 : mode === "deadline" ? 3000 : 6000;
  manifest.allowances.per_attempt.host_requests = mode === "request-cap" || requestCapNonGoal ? 1 : 30;
  manifest.allowances.cohort.host_requests = manifest.allowances.per_attempt.host_requests * 4;
  const manifestPath = executionFixture!.manifestPath;
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const ledger = new StudyLedger(governanceRoot, { projectRoot: project });
  try { studyRef = ledger.registerStudy(manifest); } finally { ledger.close(); }
  studySelection = { studyId: manifest.study_id, manifestPath, slot: manifest.schedule[0]!.slot };
}
const commonOptions = { allowNative: true, allowInference: true, authDirectory, projectRoot: project,
  paths: { runtimeRoot: join(root, "runtime"), reportsRoot: join(root, "reports"), governanceRoot },
  scenario: budgetMode || mode === "complete-persistence" || imageFailure || manifestFailure || studyMode ? "collect_wood" as const : "all" as const, modelId: model.id,
  purpose: "justified_acceptance", justification: "Isolated local synthetic cancellation integration; never a provider or gameplay proof",
  caps: { hostRequestAdmissions: mode === "request-cap" || requestCapNonGoal ? 1 : 30,
    totalMs: earlyDeadlineSignal ? 25200 : preparationExpired || preparationBounded ? 600 : finalVerificationBudget ? 1200 : finalPersistenceBudget ? 2500 : imageFailure || observerParity ? 10000 : planningStalled || developmentMode && requestCapNonGoal ? 20000 : mode === "deadline" ? 3000 : 6000,
    runMs: budgetMode ? 500 : imageFailure || observerParity ? 8000 : planningStalled || developmentMode && requestCapNonGoal ? 15000 : 1000, cleanupMs: earlyDeadlineSignal ? 25000 : budgetMode ? 100 : 300, authMs: budgetMode ? 500 : 1000, discoveryMs: budgetMode ? 500 : 1000,
    startMs: budgetMode ? 500 : 1000, observationMs: 500, diagnosticsMs: finalVerificationBudget ? 1100 : 500, pollMs: 5 } } as const;
const submittedAt = performance.now();
const acceptance = runAgentAcceptance(studySelection ? { ...commonOptions, study: studySelection } :
  { ...commonOptions, ...(developmentMode ? { scenario: undefined, development: {
    task: customFinish ? "Collect wood, make a table and keep four planks." : observerParity ? "Collect wood." : "Make a stone pickaxe from the resources around you.",
    criterion: customFinish ? "custom" as const : observerParity ? "collect_wood" as const : "craft_stone_pickaxe" as const, seed: "20261026",
    start_description: "Synthetic local native seam; no real game/provider" } } : {}),
    hypothesisId: "synthetic-lifecycle", platformEvidenceRevision: "synthetic-baseline" });
const trigger = (async () => {
  if (earlyDeadlineSignal) {
    await createEntered.promise;
    await Bun.sleep(Math.max(1, workDeadline! - performance.now() + 30));
    signalAt = performance.now();
    process.kill(process.pid, "SIGINT");
    // Let the real signal handler enter the startup finalizer before creation
    // hands ownership to the main runner. Hold actual cleanup across handoff.
    await Bun.sleep(25);
    // Advance only this isolated process's monotonic clock, not its timers:
    // spending 8.5s of the signal allowance must not renew it at handoff.
    monotonicOffset = 8500;
    signalHandoffAt = performance.now();
    releaseCreate.resolve();
    await nativeCloseEntered.promise;
    await Bun.sleep(25);
    earlyFinalizerSettledWhileNativeHeld = earlyFinalizerSettledAt !== null;
    releaseNativeClose.resolve();
    return;
  }
  if (manifestFailure) {
    await readerCloseEntered.promise;
    if (mode === "manifest-failure-sigint") process.kill(process.pid, "SIGINT");
    await Bun.sleep(25);
    storeClosedWhileReaderHeld = storeClosedAt !== null;
    returnedWhileReaderHeld = returned;
    const pid = readerBeforeClose?.child?.pid;
    if (pid) { try { process.kill(pid, 0); readerAliveWhileHeld = true; } catch {} }
    releaseReaderClose.resolve();
    return;
  }
  if (earlyIterator) {
    await earlyIterator.entered.promise;
    returnedBeforeTransportRelease = returned;
    earlyIterator.release.resolve();
    return;
  }
  if (budgetMode || customFinish || observerParity || imageFailure || mode === "startup-failure" || mode === "model-mismatch" || mode === "request-cap" || mode === "cold-isolation"
    || mode === "profile-motor-mismatch" || planningStalled || requestCapNonGoal) return;
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline && !await exists(rendererPidFile)) await Bun.sleep(5);
  rendererStarted = await exists(rendererPidFile);
  if (!rendererStarted) throw new Error("Acceptance never reached the actual replay child seam");
  if (mode === "sigint" || mode === "sigterm") process.kill(process.pid, mode === "sigint" ? "SIGINT" : "SIGTERM");
})();
let rendererPid: number | null = null;
async function observeResult() {
 try {
  const result = await acceptance;
  returned = true;
  returnedAt = performance.now();
  await trigger;
  await Promise.all(parityProbes);
  rendererStarted = await exists(rendererPidFile);
  if (rendererStarted) rendererPid = Number(await readFile(rendererPidFile, "utf8"));
  const before = await snapshot(root);
  // A buggy abandoned runCase can resume now, after the caller has received its
  // result and resources/ledger were closed. Exercise that continuation rather
  // than merely checking cancellation callbacks or mock call counts.
  await writeFile(join(root, "release-render"), "release only after caller return");
  await Bun.sleep(250);
  const after = await snapshot(root);
  delete after[join(root, "release-render")];
  const postReturnChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(path => before[path] !== after[path]).map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
  let rendererAlive = false; if (rendererPid !== null) { try { process.kill(rendererPid, 0); rendererAlive = true; } catch {} }
  const report = JSON.parse(await readFile(join(evidenceDirectory, "report.json"), "utf8"));
  let developmentCapPrograms = null;
  if (developmentMode && requestCapNonGoal) {
    const owned = new Store(ownedRuntimeRoot);
    try { developmentCapPrograms = owned.skills(report.results[0].run_id).map(program => ({ name: program.name, version: program.version })); }
    finally { owned.close(); }
  }
  let coldIsolation = null;
  if (mode === "cold-isolation") {
    const owned = new Store(ownedRuntimeRoot);
    try { coldIsolation = { sibling_visible: owned.getRun(siblingId) !== null, actor_sibling_visible: actorContexts.some(context => context.includes(siblingMarker)),
      programs: owned.skills(report.results[0].run_id).map(program => ({ name: program.name, version: program.version })),
      sibling_store_unchanged: siblingHash === createHash("sha256").update(await readFile(join(root, "runtime/runs.sqlite"))).digest("hex") }; }
    finally { owned.close(); }
  }
  const ledger = new AttemptLedger(governanceRoot, { projectRoot: project });
  let attempts;
  try { attempts = ledger.listAttempts("synthetic-lifecycle"); } finally { ledger.close(); }
  let study = null;
  let nextAdmission: { admitted: boolean; slot?: StudySlot; error?: string } | null = null;
  if (studyRef) {
    const studies = new StudyLedger(governanceRoot, { projectRoot: project });
    try {
      study = studies.readStudy(studyRef);
      if (planningStalled) {
        try {
          const next = studies.reserveStudyAttempt(studyRef, { ...study.attempts[0]!.slot, repetition: 2 });
          nextAdmission = { admitted: true, slot: next.slot };
        } catch (error) { nextAdmission = { admitted: false, error: String(error) }; }
        study = studies.readStudy(studyRef);
      }
    } finally { studies.close(); }
  }
  const files = await readdir(evidenceDirectory);
  const manifests = await Promise.all(files.filter(file => file.endsWith("-manifest.json") && file !== blockedManifest).map(async file => JSON.parse(await readFile(join(evidenceDirectory, file), "utf8"))));
  const journals = await Promise.all(files.filter(file => file.endsWith("-journal.jsonl")).map(file => readFile(join(evidenceDirectory, file), "utf8")));
  // Full journals grow during the real five-second idle continuation. Keep
  // fixture IPC on disk instead of one large stdout pipe write that can block
  // fixture completion after the runner has already returned and drained.
  await writeFile(join(root, "fixture-result.json"), JSON.stringify({ result, rendererStarted, rendererAlive, starts, nextWorlds, providerCalls,
    authCreates, nativeClosedAt, submittedAt, returnedAt, finalDiagnosticsStartedAt, finalDiagnosticsFinishedAt,
    finalPersistenceStartedAt, finalPersistenceFinishedAt, observationReads, paritySnapshots,
    declaredCleanupMs: commonOptions.caps.cleanupMs, workDeadline, signalAt, signalHandoffAt,
    earlyFinalizerSettledAt, earlyFinalizerSettledWhileNativeHeld,
    attempts, study, startupReservationSeen, authReservationSeen, fixtureConditions, coldIsolation, nextAdmission, report, manifests, journals, lateWrites, unhandled,
    manifestPersistenceError, storeClosedAt, storeClosedWhileReaderHeld, returnedWhileReaderHeld, readerAliveWhileHeld, readerBeforeClose, readerAtStoreClose,
    originalIteratorReads, originalIteratorReturns, originalIteratorClosed, returnedBeforeTransportRelease, requestSignalAbortedBeforeRead,
    requestCapResponseAbortedBeforeDelivery, developmentCapPrograms,
    postReturnChanges, unchangedAfterReturn: postReturnChanges.length === 0 }), { mode: 0o600 });
  await Bun.write(Bun.stdout, "ACCEPTANCE_RESULT fixture-result.json\n");
 } finally {
  if (rendererPid === null && await exists(rendererPidFile)) rendererPid = Number(await readFile(rendererPidFile, "utf8"));
  if (rendererPid !== null) { try { process.kill(rendererPid, "SIGKILL"); } catch {} }
  // Contain an implementation regression without hiding its observed evidence.
  await writeFile(join(root, "release-render"), "fixture cleanup");
 }
}
const observed = observeResult();
// The SDK's real SIGINT handler intentionally exits 130 after supported
// callbacks drain. Join the observer through that API as well, so it can read
// durable results and probe for late writers without removing foreign handlers.
const unregisterObserver = postmortem.register("synthetic-acceptance-result-observer", () => observed, { exitOnly: true });
try { await observed; } finally {
  unregisterObserver();
  if (executionFixture) await rm(executionFixture.caseRoot, { recursive: true, force: true });
}
