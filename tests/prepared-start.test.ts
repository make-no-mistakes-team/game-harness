import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AppSnapshot, AuthState, RunView } from "../src/shared/contracts.ts";
import type { PreparedStartRequest, PreparedStartView } from "../src/shared/prepared-start.ts";
import type { ResidentWorker } from "../src/shared/resident.ts";
import { PreparedStart, type PreparedStartOptions } from "../src/server/prepared-start.ts";
import type { PreparationContract } from "../src/server/prepared-source-contract.ts";
import type { ApprovedSourceReference } from "../src/server/source-authoring.ts";
import { Store } from "../src/server/store.ts";
import { OfficialSessionUnavailableError } from "../src/server/native-launch-fault.ts";
import { minecraftRunFixture, minecraftTestAdapter } from "./helpers/adapter-contract.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const rootSource = "export function activate(frame,state,intent) { return {refused:true,reason:'software fixture only'}; } export function step(frame,state,intent) { return {choice:{kind:'observe'},next_state:state,status:'running',events:[]}; }";
const authState = (): AuthState => ({ authenticated: true, status: "ready", provider: "openai-codex",
  account_label: null, login: null, error: null,
  models: [{ id: "selected-model", name: "Selected fixture model", provider: "openai-codex",
    context_window: null, input_modalities: ["image"] }] });

/** Synthetic Agent protocol only; no provider, native observation or gameplay claim. */
class ScriptedSourceAgent {
  state = { model: { id: "selected-model", api: "openai-codex-responses", provider: "openai-codex" } };
  listeners = new Set<(event: AgentEvent) => void>();
  gate: ((context: unknown, signal?: AbortSignal) => unknown) | null = null;
  beforeToolCall: ((context: unknown, signal?: AbortSignal) => unknown) | null = null;
  streamFn: StreamFn = (() => ({ async *[Symbol.asyncIterator]() {} })) as unknown as StreamFn;
  constructor(readonly tools: AgentTool[], readonly reference?: ApprovedSourceReference) {}
  setBeforeModelCall(gate: ScriptedSourceAgent["gate"]) { this.gate = gate; }
  subscribe(listener: (event: AgentEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  abort() {}
  async waitForIdle() {}
  async prompt() {
    if (this.gate?.({})) return;
    const stream = await this.streamFn(this.state.model as never, { messages: [], tools: this.tools } as never, {});
    for await (const _event of stream) { /* Join the actual wrapped stream owner. */ }
    const content = [
      { type: "toolCall" as const, id: "source-write", name: this.reference ? "program_copy" : "program_write",
        arguments: this.reference ? { name: "executive", entry: "step", reference_hash: this.reference.hash }
          : { name: "executive", entry: "step", source: rootSource } },
      { type: "toolCall" as const, id: "source-finish", name: "prepare_finish", arguments: {
        name: "executive", version: 1, args: null, initial_state: null, limits: {}, session: { schema_version: 1 } } },
    ];
    const assistant = { role: "assistant", content, stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      api: this.state.model.api, provider: this.state.model.provider, model: this.state.model.id } as AssistantMessage;
    for (const listener of this.listeners) listener({ type: "message_end", message: assistant });
    for (const call of content) {
      const tool = this.tools.find(tool => tool.name === call.name)!;
      if (!this.beforeToolCall?.({ tool, toolCall: call, args: call.arguments, assistantMessage: assistant }))
        await tool.execute(call.id, call.arguments);
    }
    if (!this.gate?.({})) throw new Error("Fixture requires the sealed-source host gate");
  }
}

function fixture(sourceReferences?: readonly ApprovedSourceReference[]) {
  const directory = mkdtempSync(join(tmpdir(), "prepared-start-"));
  const adapter = minecraftTestAdapter();
  let contract: PreparationContract = { adapter, artifact_sha256: "a".repeat(64) };
  const state: Pick<AppSnapshot, "game" | "server" | "sandbox" | "run"> = {
    game: { status: "disconnected", username: "Fixture", version: "1.21.4", world_id: null, epoch: 0,
      session_id: null, life: null, binding: null, space: null, screen: null, presentation: null,
      video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
      last_observation_at: null, error: null },
    server: { status: "stopped", version: "1.21.4", host: "127.0.0.1", port: 25565,
      world_id: null, eula_accepted: true, error: null },
    sandbox: { status: "ready", image: "synthetic-fixture", error: null }, run: null,
  };
  const counts = { authReads: 0, agents: 0, releases: 0, compiles: 0, workerCloses: 0, activations: 0,
    launches: 0, launchCloses: 0, admissions: 0 };
  const compileEntered = Promise.withResolvers<void>(), compileResult = Promise.withResolvers<ResidentWorker>();
  const launchEntered = Promise.withResolvers<void>(), launchReady = Promise.withResolvers<void>();
  const launchCloseEntered = Promise.withResolvers<void>(), launchCloseResult = Promise.withResolvers<void>();
  const launchClosed = Promise.withResolvers<void>(), terminal = Promise.withResolvers<PreparedStartView>();
  const worker: ResidentWorker = {
    async activate() { counts.activations++; throw new Error("No activation is authorized by this coordinator fixture"); },
    async step() { throw new Error("No frame is authorized by this coordinator fixture"); },
    async close() { counts.workerCloses++; },
  };
  let owner: PreparedStart;
  let afterCompile: (() => void) | null = null;
  const options: PreparedStartOptions = { directory, sourceReferences,
    auth: { snapshot() { counts.authReads++; return authState(); },
      async createAgent(input) { counts.agents++; return new ScriptedSourceAgent(input.tools, sourceReferences?.[0]) as unknown as Agent; },
      async releaseAgent() { counts.releases++; } },
    sandbox: { async createResidentWorker() { counts.compiles++; compileEntered.resolve(); return compileResult.promise; },
      async createResidentAnalysisWorker() { throw new Error("No analysis configured"); } },
    state: () => state, getContract: async () => contract,
    runtime: { snapshot: () => state.run,
      async startPreparedRun() { counts.admissions++; throw new Error("No run admission expected"); },
      async control() { throw new Error("No run control expected"); } },
    launch() {
      counts.launches++; launchEntered.resolve();
      return { ready: launchReady.promise, async close() {
        counts.launchCloses++; launchCloseEntered.resolve(); await launchCloseResult.promise; launchClosed.resolve();
      } };
    },
    record() {}, changed() {
      const view = owner.snapshot();
      if (view?.phase === "ready") afterCompile?.();
      if (view && ["failed", "cancelled"].includes(view.phase)) terminal.resolve(view);
    },
  };
  owner = new PreparedStart(options);
  cleanups.push(async () => {
    compileResult.resolve(worker); launchCloseResult.resolve(); launchReady.resolve();
    try { await owner.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const request: PreparedStartRequest = { request_id: crypto.randomUUID(), task: "Synthetic coordinator ownership boundary",
    goal: structuredClone(adapter.goals[0]!), model_id: "selected-model" };
  return { owner, options, directory, adapter, request, state, counts, worker, compileEntered, compileResult,
    launchEntered, launchReady, launchCloseEntered, launchCloseResult, launchClosed, terminal,
    whenReady(callback: () => void) { afterCompile = callback; },
    setContract(value: PreparationContract) { contract = value; } };
}

for (const change of ["artifact", "contract"] as const) {
  test(`changed ${change} after compilation refuses before reserving a world launch`, async () => {
    const f = fixture(); await f.owner.initialize();
    const accepted = await f.owner.start(f.request); await f.compileEntered.promise;
    const replacement = { adapter: change === "contract" ? minecraftTestAdapter("fast") : f.adapter,
      artifact_sha256: (change === "artifact" ? "b" : "a").repeat(64) };
    f.whenReady(() => f.setContract(replacement));
    f.compileResult.resolve(f.worker);
    const failed = await f.terminal.promise;
    await f.owner.close();
    expect(failed).toMatchObject({ preparation_id: accepted.preparation_id, phase: "failed", closure: "closed", run_id: null });
    expect(f.counts).toMatchObject({ agents: 1, releases: 1, compiles: 1, workerCloses: 1, activations: 0,
      launches: 0, launchCloses: 0, admissions: 0 });
    expect(f.state.game.status).toBe("disconnected");
  });
}

test("prepared start forwards only explicit validated source task material to selected-model copying", async () => {
  const reference: ApprovedSourceReference = { source: rootSource, entry: "step",
    hash: createHash("sha256").update(rootSource, "utf8").digest("hex"),
    card: { purpose: "Synthetic coordinator protocol", applicability: "Software fixtures only",
      method: "Explicit selected-model copy", reason: "Operator approval", limitations: "No gameplay evidence" },
    provenance: "operator-approved coordinator fixture" };
  const f = fixture([reference]);
  await f.owner.initialize(); const accepted = await f.owner.start(f.request);
  await f.compileEntered.promise;
  expect(f.owner.snapshot()).toMatchObject({ source_versions: 1, phase: "compiling" });
  expect(f.counts.agents).toBe(1); expect(f.counts.activations).toBe(0); expect(f.counts.launches).toBe(0);
  const cancellation = f.owner.cancel(accepted.preparation_id);
  f.compileResult.resolve(f.worker);
  expect((await cancellation).closure).toBe("closed");
  const counts = { ...f.counts };
  expect(() => new PreparedStart({ ...f.options,
    sourceReferences: [{ ...reference, hash: "0".repeat(64) }] })).toThrow();
  expect(f.counts).toEqual(counts);
});

test("cancel during joining closes the reserved launch once and waits for its original readiness owner", async () => {
  const f = fixture(); f.compileResult.resolve(f.worker); await f.owner.initialize();
  const accepted = await f.owner.start(f.request); await f.launchEntered.promise;
  expect(f.owner.snapshot()?.phase).toBe("joining");
  let settled = false;
  const cancelling = f.owner.cancel(accepted.preparation_id).then(view => { settled = true; return view; });
  await f.launchCloseEntered.promise;
  expect(settled).toBe(false);
  expect(f.counts).toMatchObject({ launches: 1, launchCloses: 1, admissions: 0, workerCloses: 0 });
  f.launchCloseResult.resolve(); await f.launchClosed.promise;
  expect(settled).toBe(false);
  expect(f.owner.snapshot()).toMatchObject({ phase: "cancelling", closure: "draining" });
  f.launchReady.resolve();
  expect(await cancelling).toMatchObject({ preparation_id: accepted.preparation_id, phase: "cancelled", closure: "closed", run_id: null });
  await f.owner.close();
  expect(f.counts).toMatchObject({ launches: 1, launchCloses: 1, admissions: 0, workerCloses: 1, activations: 0 });
});

for (const kind of ["official", "forged", "host", "provider"] as const) {
  test(`launch-ready rejection joins launch closure and retains safe failure projection (${kind})`, async () => {
    const f = fixture(); f.compileResult.resolve(f.worker); await f.owner.initialize();
    const accepted = await f.owner.start(f.request); await f.launchEntered.promise;
    const readyAt = f.owner.snapshot()?.ready_at;
    expect(typeof readyAt).toBe("string");
    const known = new OfficialSessionUnavailableError();
    const error = kind === "official" ? known : kind === "forged"
      ? Object.assign(Object.create(OfficialSessionUnavailableError.prototype), {
        stage: "native_launch", code: "official_session_unavailable",
        message: `${known.message} PRIVATE_FORGED_SECRET`, name: "PRIVATE_FORGED_NAME",
      }) : Object.assign(new Error(`${known.message} PRIVATE_${kind.toUpperCase()}_SECRET /private/host/path`),
        { name: "PRIVATE_UNTRUSTED_NAME", stage: "native_launch", code: "official_session_unavailable" });
    // Even a branded instance's mutable Error fields are never publication authority.
    if (kind === "official") {
      known.message = "PRIVATE_MUTATED_SECRET"; known.name = "PRIVATE_MUTATED_NAME";
    }
    f.launchReady.reject(error); await f.launchCloseEntered.promise;
    expect(f.owner.snapshot()).toMatchObject({ phase: "joining", run_id: null, ready_at: readyAt });
    expect(f.counts).toMatchObject({ launchCloses: 1, admissions: 0, activations: 0, workerCloses: 0 });
    f.launchCloseResult.resolve();
    const failed = await f.terminal.promise; await f.owner.close();
    expect(failed).toMatchObject({ phase: "failed", closure: "closed", run_id: null, ready_at: readyAt });
    expect(f.counts).toMatchObject({ launches: 1, launchCloses: 1, admissions: 0, activations: 0, workerCloses: 1 });
    const journal = readFileSync(join(f.directory, "prepared-source", `${accepted.preparation_id}.jsonl`), "utf8");
    const rows = journal.trim().split("\n").map(line => JSON.parse(line));
    const failure = rows.find(row => row.type === "attempt.failure");
    expect(failure).toBeDefined();
    if (kind === "official") {
      expect(failure.details).toMatchObject({ stage: "native_launch", code: "official_session_unavailable",
        error: "The official Launcher Minecraft session is unavailable. Sign in and launch Minecraft 1.21.4 with the official Launcher." });
      expect(failed.error).toBe(failure.details.error);
    } else {
      expect(failure.details.code).toBe("service_failure");
      expect(failure.details.stage).toBeUndefined();
    }
    expect(rows.some(row => row.type === "worker.transferred")).toBe(false);
    expect(JSON.stringify({ failed, journal })).not.toContain("PRIVATE");
    expect(JSON.stringify({ failed, journal })).not.toContain("/private/host/path");
  });
}

test("post-transfer failure joins Stop on the admitted stored run without closing the healthy world", async () => {
  const f = fixture(), store = new Store(f.directory);
  const transferred = Promise.withResolvers<void>(), failAdmission = Promise.withResolvers<void>();
  const stopEntered = Promise.withResolvers<void>(), finishStop = Promise.withResolvers<void>();
  const controls: { run_id: string; command: string }[] = [];
  const transferredWorker = { current: null as ResidentWorker | null };
  let admittedId: string | null = null;
  const failure = new Error("Synthetic post-transfer admission failure");
  const snapshot = (): RunView | null => {
    const run = admittedId ? store.getRun(admittedId) : null;
    if (!run) return null;
    const { baseline: _baseline, control: _control, ...view } = run;
    return { ...view, action: null, policies: [], skills: [], executions: [],
      operator: { state: run.status, pause_cause: null, cleanup_error: null, completion: null, progress: null } };
  };
  // Runtime contract double backed by a real Store row; full root admission is covered separately.
  f.options.runtime = { snapshot,
    async startPreparedRun(candidate) {
      f.counts.admissions++;
      const run = minecraftRunFixture(f.adapter, { task: candidate.request.task, goal: candidate.request.goal,
        model_id: candidate.request.model_id });
      store.saveRun(run); admittedId = run.run_id;
      transferredWorker.current = candidate.takeWorker(run.run_id);
      transferred.resolve(); await failAdmission.promise; throw failure;
    },
    async control(runId, command) {
      controls.push({ run_id: runId, command }); stopEntered.resolve(); await finishStop.promise;
      if (runId !== admittedId || command !== "stop" || !transferredWorker.current) throw new Error("Wrong runtime owner or command");
      await transferredWorker.current.close();
      const run = store.getRun(runId)!;
      store.saveRun({ ...run, status: "stopped", ended_at: new Date().toISOString() });
    },
  };
  f.options.launch = () => {
    f.counts.launches++;
    f.state.game.status = "connected"; f.state.server.status = "running";
    return { ready: Promise.resolve(), async close() {
      f.counts.launchCloses++; f.state.game.status = "disconnected"; f.state.server.status = "stopped";
    } };
  };
  // Unblock original owners even if an assertion interrupts this synthetic failure path.
  cleanups.unshift(async () => { failAdmission.resolve(); finishStop.resolve(); await f.owner.close(); store.close(); });
  f.compileResult.resolve(f.worker); await f.owner.initialize();
  const accepted = await f.owner.start(f.request); await transferred.promise;
  expect(transferredWorker.current).toBe(f.worker);
  expect(f.owner.snapshot()).toMatchObject({ preparation_id: accepted.preparation_id, closure: "transferred", run_id: admittedId });
  await expect(f.owner.cancel(accepted.preparation_id)).rejects.toThrow();
  failAdmission.resolve(); await stopEntered.promise;
  expect(controls).toEqual([{ run_id: admittedId!, command: "stop" }]);
  expect(f.counts.workerCloses).toBe(0);
  expect(store.getRun(admittedId!)?.status).toBe("running");
  finishStop.resolve(); const failed = await f.terminal.promise; await f.owner.close();
  expect(failed).toMatchObject({ preparation_id: accepted.preparation_id, phase: "failed", closure: "closed", run_id: admittedId });
  expect(store.getRun(admittedId!)?.status).toBe("stopped");
  expect(f.state.game.status).toBe("connected"); expect(f.state.server.status).toBe("running");
  expect(f.counts).toMatchObject({ releases: 1, compiles: 1, admissions: 1, workerCloses: 1, launchCloses: 0 });
});

test("an already connected session refuses before consulting auth or allocating inference", async () => {
  const f = fixture(); f.state.game.status = "connected"; await f.owner.initialize();
  await expect(f.owner.start(f.request)).rejects.toMatchObject({ code: "precondition_failed" });
  await f.owner.close();
  expect(f.owner.snapshot()).toBeNull();
  expect(f.counts).toMatchObject({ authReads: 0, agents: 0, releases: 0, compiles: 0, launches: 0, admissions: 0 });
  expect(f.state.game.status).toBe("connected");
});
