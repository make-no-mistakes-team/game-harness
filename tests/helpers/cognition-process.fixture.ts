import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ApiKeyResolveContext, ResolvedApiKey } from "@oh-my-pi/pi-ai/auth-retry";
import type { Json } from "../../src/shared/contracts.ts";
import type { SkillExecutionView } from "../../src/shared/programs.ts";
import type { InferenceSessionConsumer, SelectedAccountInferenceSession } from "../../src/server/auth-session.ts";
import { CognitionClient } from "../../src/server/cognition-client.ts";
import { CognitionWire } from "../../src/server/cognition-wire.ts";
import type { CognitionMetadata, CognitionStart } from "../../src/server/cognition-protocol.ts";
import { encodeApiKeyResolveContext } from "../../src/server/cognition-inference.ts";
import { osMonotonicNs } from "../../src/server/os-monotonic.ts";
import { RuntimeFault } from "../../src/server/runtime-fault.ts";
import type { StrategicHost } from "../../src/server/strategic.ts";
import { executionScopeFixture, minecraftObservationFixture, minecraftTestAdapter } from "./adapter-contract.ts";
import { historyFixture, historySpec, type HistoryFixture } from "./history-fixture.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../../src/shared/resident.ts";
import { controlSessionConfigSchema } from "../../src/shared/control-session.ts";
import { ReadonlyStore } from "../../src/server/store-read.ts";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}
export const deferred = <T = void>(): Deferred<T> => Promise.withResolvers<T>();
export const eventLoopTurn = () => {
  const completion = deferred();
  setImmediate(completion.resolve);
  return completion.promise;
};
export const workerPath = fileURLToPath(import.meta.url);

export interface PassiveHostFixture extends HistoryFixture {
  host: StrategicHost;
  state: { run: HistoryFixture["run"] | null; generation: number; pending: boolean; root: SkillExecutionView | null; speculative: boolean };
  owner: FakeSelectedSessionOwner;
  tools: AgentTool[];
  pauses: { message: string; cause: string }[];
  observeEntered: Deferred<void>;
  observeRelease: Deferred<void>;
  holdObservation(): void;
}
interface CloseReceipt { code: number | null; signal: NodeJS.Signals | null }
export interface ProcessFixture extends PassiveHostFixture {
  client: CognitionClient;
  processes: ChildProcess[];
  closures: Promise<CloseReceipt>[];
  receipts: CloseReceipt[];
  marker(name: string): Promise<Json>;
  close(): Promise<void>;
}

/** Explicit fake selected-session owner. No AuthManager, provider or ambient key is used. */
export class FakeSelectedSessionOwner {
  readonly model: Model = (() => {
    const model = getBundledModels("openai-codex")[0];
    if (!model) throw new Error("Offline descriptor required by the infrastructure fixture");
    return model;
  })();
  readonly refreshEntered = deferred();
  readonly refreshRelease = deferred();
  readonly drained = deferred();
  readonly controller = new AbortController();
  readonly leases = new Set<Promise<void>>();
  consumer: InferenceSessionConsumer | null = null;
  allocations = 0;
  cancellations = 0;
  resolutions = 0;
  refreshCommitted = false;
  private closing: Promise<void> | null = null;
  readonly session: SelectedAccountInferenceSession = {
    sessionId: "offline-selected-session",
    model: this.model,
    thinkingLevel: undefined,
    singleInferenceDispatch: true,
    streamFn: undefined,
    signal: this.controller.signal,
    getApiKey: requested => {
      if (requested.id !== this.model.id || requested.provider !== this.model.provider || requested.api !== this.model.api || this.controller.signal.aborted)
        throw new Error("Selected grant unavailable");
      return context => this.resolve(context);
    },
    cancel: () => this.cancel(),
    close: () => this.close(),
  };
  createInferenceSession(options: { modelId: string; consumer: InferenceSessionConsumer }): SelectedAccountInferenceSession {
    if (options.modelId !== this.model.id || this.allocations) throw new Error("Unexpected selected-session allocation or retry");
    this.allocations++;
    this.consumer = options.consumer;
    return this.session;
  }
  cancel(): void {
    this.cancellations++;
    if (!this.controller.signal.aborted) this.controller.abort();
    this.consumer?.revoke();
  }
  close(): Promise<void> {
    this.cancel();
    return this.closing ??= (async () => {
      await Promise.all([this.consumer?.drain(), ...this.leases]);
      this.drained.resolve();
    })();
  }
  /** Models an abortable resolver wait around an independently owned refresh commit. */
  private async resolve(context: ApiKeyResolveContext): Promise<ResolvedApiKey> {
    this.resolutions++;
    const lease = this.refreshRelease.promise.then(() => { this.refreshCommitted = true; });
    this.leases.add(lease);
    void lease.finally(() => this.leases.delete(lease));
    this.refreshEntered.resolve();
    const signal = context.signal ? AbortSignal.any([context.signal, this.controller.signal]) : this.controller.signal;
    const aborted = deferred<never>();
    const reject = () => aborted.reject(new Error("Selected resolver wait canceled"));
    if (signal.aborted) reject(); else signal.addEventListener("abort", reject, { once: true });
    try {
      await Promise.race([lease, aborted.promise]);
      signal.throwIfAborted();
      return { apiKey: "offline-not-a-provider-credential", credentialId: 1 };
    } finally { signal.removeEventListener("abort", reject); }
  }
}

/** Passive host only: no action API, native connection, source, Agent or policy. */
export function passiveHostFixture(): PassiveHostFixture {
  const f = historyFixture();
  const adapter = minecraftTestAdapter();
  const goalFixture = adapter.goals.find(goal => goal.goal_id === "custom")!;
  const owner = new FakeSelectedSessionOwner();
  f.run.model_id = owner.model.id;
  f.store.saveRun(f.run);
  const state = { run: f.run as typeof f.run | null, generation: 1, pending: false,
    root: null as SkillExecutionView | null, speculative: true };
  const tools: AgentTool[] = [];
  const pauses: { message: string; cause: string }[] = [];
  const observeEntered = deferred();
  const observeRelease = deferred();
  let holdObservation = false;
  const host: StrategicHost = {
    run: () => state.run,
    generation: () => state.generation,
    assertCurrent: generation => {
      if (generation !== state.generation || !state.run) throw new RuntimeFault("stale_context", "Passive host generation changed");
      return state.run;
    },
    tools: () => tools,
    disclosedModules: () => ["reflex"],
    rootPrompt: () => "Passive infrastructure fixture",
    promptInput: () => ({ id: "fixture", goal: { adapter_id: adapter.descriptor.adapter.id, goal_id: "custom", verifier: null, parameters: {} },
      label: "Infrastructure", prompt: "passive" }),
    adapter: () => adapter,
    observe: async () => {
      observeEntered.resolve();
      if (holdObservation) await observeRelease.promise;
      return minecraftObservationFixture(adapter);
    },
    projectObservation: observation => adapter.projectObservation(observation, null),
    policies: () => [], action: () => null, programPending: () => state.pending, busy: () => false,
    persist: summary => f.store.saveRun(f.run, summary),
    pause: (message, cause) => { pauses.push({ message, cause }); },
    terminal: () => { throw new Error("No terminal operation is expected in this passive fixture"); },
    speculation: () => ({ projection: () => state.speculative ? {
      plan_id: "plan-1", state: "planning", planning_active: true, reason: null, intent: "Infrastructure authority",
      basis: { run_id: f.run.run_id, generation: state.generation, world_id: f.run.world_id,
        session_id: f.run.session_id!, epoch: f.run.epoch, life_id: f.run.life_id!, life_status: "alive",
        native_boot_id: f.run.native_boot_id!, space_epoch: f.run.space_epoch!, compatibility_hash: f.run.compatibility_hash!,
        screen: null, task: f.run.task, goal: goalFixture,
        root: { execution_id: "metadata-root", skill_id: "metadata-only", version: 1, hash: "a".repeat(64), status: "running" } },
      candidate: null, guard_hash: null, guard_status: "omitted", activation: "manual", activation_permit: "not_authorized",
      activation_trigger: null, predecessor_closed: false, deadline_at: new Date(Date.now() + 30_000).toISOString(),
      budget: { calls: 1, tools: 1, duration_ms: 30_000 }, calls: 0, tools: 0, observation_seq: null,
      activation_execution_id: null, overlap_ms: 0,
    } : null, remainingMs: () => 0, pendingActivation: async () => null,
      begin: () => null, requestCall: () => false, finish: () => {}, invalidate: () => {},
      assertToolAuthority: () => { if (!state.speculative) throw new RuntimeFault("stale_context", "Speculative grant revoked"); },
      authority: () => () => { if (!state.speculative) throw new RuntimeFault("stale_context", "Speculative grant revoked"); },
    }),
  };
  return { ...f, host, state, owner, tools, pauses, observeEntered, observeRelease,
    holdObservation: () => { holdObservation = true; } };
}

/** Storage-only owner metadata; never executes source or starts a controller. */
export async function retainFiniteExecutive(f: PassiveHostFixture): Promise<SkillExecutionView> {
  const spec = await f.store.registerSkill(f.run.run_id, { ...historySpec(f.run, "Finite retained owner"), entry: "step" });
  const root = f.store.admitSkill(f.run.run_id, { entry: "step", skill_id: spec.skill_id, version: spec.version,
    start_key: crypto.randomUUID(), ...executionScopeFixture(f.run), args: null, initial_state: null,
    limits: { ...DEFAULT_RESIDENT_LIMITS, duration_ms: 360_000, max_steps: 7200, max_frames: 7200 },
    session: controlSessionConfigSchema.parse({ schema_version: 1 }),
  }).view;
  if (root.entry !== "step") throw new Error("Storage-only owner requires step admission metadata");
  root.status = "running"; root.started_at = new Date().toISOString();
  const timing = { count: 0, p50: null, p95: null, p99: null, max: null, omitted_samples: 0 };
  root.resident = {
    execution_id: root.execution_id, source_hash: spec.hash, controller_generation: 1,
    host_clock_id: "storage-only-clock", status: "running", reason: null, intent_version: 0,
    state: null, processed_frame_seq: 1, processed_native_tick: 1, processed_native_ns: "1",
    counters: { frames: 1, steps: 1, submissions: 0, applied_sequence: 0, ordered_edge_prefix: 0,
      missed_slots: 0, stale_results: 0, stale_frames: 0, read_failures: 0, no_input_decisions: 1,
      expanded_edges: 0, events: 0, analysis_jobs: 0, analysis_ms: 0 },
    pending: { frames: 0, edges: 0, analysis: false }, last_input: null,
    timings: { step_ms: timing, input_age_ms: timing }, events: [],
    cleanup: { worker: "open", native: "open" },
  };
  f.store.updateSkillExecution(root, "skill.running", "Storage-only owner; no execution invoked");
  f.state.pending = true; f.state.root = root;
  return root;
}

export function processFixture(scenario = "passive"): ProcessFixture {
  const f = passiveHostFixture();
  const goal = f.host.promptInput!();
  f.host.promptInput = () => ({ ...goal, prompt: scenario });
  const processes: ChildProcess[] = [];
  const closures: Promise<{ code: number | null; signal: NodeJS.Signals | null }>[] = [];
  const receipts: { code: number | null; signal: NodeJS.Signals | null }[] = [];
  const markers = new Map<string, Deferred<Json>>();
  const values = new Map<string, Json>();
  const unsubscribe = f.store.subscribe(event => {
    if (event.type !== "fixture.cognition") return;
    values.set(event.summary, event.details);
    markers.get(event.summary)?.resolve(event.details);
  });
  const spawnOwned = new Proxy(spawn, {
    apply(target, thisArg, args) {
      const child: ChildProcess = Reflect.apply(target, thisArg, args);
      processes.push(child);
      const closed = deferred<CloseReceipt>();
      child.once("close", (code, signal) => {
        const receipt = { code, signal }; receipts.push(receipt); closed.resolve(receipt);
      });
      closures.push(closed.promise);
      return child;
    },
  });
  const client = new CognitionClient(f.store, f.owner, f.host, { workerPath, spawn: spawnOwned });
  return { ...f, client, processes, closures, receipts,
    marker: (name: string): Promise<Json> => {
      if (values.has(name)) return Promise.resolve(values.get(name)!);
      const result = markers.get(name) ?? deferred<Json>(); markers.set(name, result); return result.promise;
    },
    async close() {
      f.observeRelease.resolve(); f.owner.refreshRelease.resolve();
      await client.close();
      await Promise.all(closures);
      unsubscribe(); f.close();
    },
  };
}

async function runOwnedProtocolFixture(): Promise<void> {
  let input: CognitionStart | null = null;
  let sequence = 0;
  let request = 0;
  let canceledTurn: { id: string; request: string } | null = null;
  const wire = new CognitionWire(process.stdin, process.stdout, async (method, body) => {
    if (method === "start") {
      input = body as CognitionStart;
      if (input.goal.prompt === "late_start") {
        await wire.call("observe", null);
        await marker("late_start_returning");
      }
      if (input.goal.prompt === "tool") setTimeout(() => { void exerciseTool().catch(() => {}); }, 0);
      if (input.goal.prompt === "raw") setTimeout(() => {
        void (async () => {
          for (const args of [null, "7", 7, false, [], { value: "7" }, JSON.parse('{"__proto__":{"fixture_owned":true},"value":7}')])
            await exerciseTool(args);
          await marker("raw_done");
        })().catch(() => {});
      }, 0);
      if (input.goal.prompt === "deadline") setTimeout(() => {
        void (async () => {
          await wire.call("turn", { id: "stalled-turn", deadline_os_ns: (osMonotonicNs() + 200_000_000n).toString() });
          await marker("stall_entering");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        })().catch(() => {});
      }, 0);
      if (input.goal.prompt === "refresh") setTimeout(() => {
        void (async () => {
          const model = input!.grant.model;
          await metadata([
            { kind: "request_reserve", request_id: "refresh-1", model: { id: model.id, provider: model.provider, api: model.api } },
            { kind: "call", request_id: "refresh-1", purpose: "planning" },
          ]);
          await wire.call("key", { id: "refresh-1", model,
            context: encodeApiKeyResolveContext({ lastChance: false, error: undefined }) });
        })().catch(() => {});
      }, 0);
      if (input.goal.prompt === "backpressure") setTimeout(() => {
        void (async () => {
          const model = input!.grant.model;
          await metadata([
            { kind: "request_reserve", request_id: "unknown-delivery", model: { id: model.id, provider: model.provider, api: model.api } },
            { kind: "call", request_id: "unknown-delivery", purpose: "planning" },
          ]);
          await marker("backpressure_entering");
          process.stdin.pause();
          void wire.call("observe", null).catch(() => {});
          await marker("backpressure_paused");
        })().catch(() => {});
      }, 0);
      return { pid: process.pid };
    }
    if (method === "fence" || method === "attention" || method === "admitted") return null;
    if (method === "turn_cancel") {
      const { id } = body as { id: string };
      if (canceledTurn?.id !== id) return null;
      const previous = canceledTurn; canceledTurn = null;
      // Try the real physical host after the original deadline: cancellation
      // drain must not extend even a previously successful response's grant.
      try {
        await wire.call("tool", { request_id: previous.request, call_id: "expired-call", name: "help", arguments: { value: 7 } });
        await marker("expired_tool_accepted");
      } catch { await marker("expired_tool_rejected"); }
      await metadata([
        { kind: "event", run_id: input!.snapshot.run.run_id, type: "scheduler.turn_deferred",
          summary: "Protocol fixture completed cancellation", details: { turn_id: id, selected_feedback_consumed: false, automatic_retry: false } },
        { kind: "progress", model_status: "idle" },
      ]);
      await wire.call("turn_end", { id });
      await marker("cancellation_settled");
      return null;
    }
    if (method === "wake") {
      const { reason } = body as { reason: string };
      if (reason === "observation" && input!.goal.prompt === "observation") {
        const id = "observation-turn";
        await wire.call("turn", { id, deadline_os_ns: (osMonotonicNs() + 10_000_000_000n).toString() });
        try {
          await wire.call("model_observation", null);
          await marker("observation_returned");
        } catch (error) {
          await marker("observation_rejected", { message: error instanceof Error ? error.message : "Unknown error" });
        } finally { await wire.call("turn_end", { id }); }
      } else if (reason === "context" && input!.goal.prompt.startsWith("context_")) {
        const id = "finite-context", deadline = osMonotonicNs() + 200_000_000n;
        await wire.call("context_begin", { id, deadline_os_ns: deadline.toString() });
        await marker("context_entered");
        if (input!.goal.prompt === "context_stall")
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        else setTimeout(() => {
          void wire.call("context_end", { id, successful: false }).then(() => marker("context_settled")).catch(() => {});
        }, Math.max(1, Number(deadline - osMonotonicNs()) / 1e6) + 50);
      } else if (reason === "authoring" && input!.goal.prompt === "authoring_stall") {
        const source = new ReadonlyStore(input!.location);
        const root = source.latestRootExecution(input!.snapshot.run.run_id); source.close();
        if (!root?.source_hash) throw new Error("Expected storage-only authoring owner");
        const id = "finite-authoring", requestId = "authoring-request";
        await wire.call("turn", { id, deadline_os_ns: (osMonotonicNs() + 30_000_000_000n).toString() });
        const model = input!.grant.model, deadline = osMonotonicNs() + 200_000_000n;
        await metadata([
          { kind: "request_reserve", request_id: requestId, model: { id: model.id, provider: model.provider, api: model.api } },
          { kind: "call", request_id: requestId, purpose: "authoring" },
        ]);
        await wire.call("dispatch", { identity: { turn_id: id, request_id: requestId, generation: input!.snapshot.generation,
          role: "authoring", deadline_os_ns: deadline.toString(), phase: input!.snapshot.run.status,
          root_execution_id: root.execution_id, source_hash: root.source_hash, authoring_deadline_at: Date.now() + 200,
          pending_decision: false, plan_id: null } });
        await metadata([{ kind: "response", response: { request_id: requestId, successful: true, calls: [] } }]);
        await marker("authoring_response_then_stall");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      } else if (reason === "stall") {
        await marker("stall_entering");
        // Generic CPU ownership stall: cannot run IPC, timers, close or fence handlers.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      } else if (reason === "die") process.exit(23);
      else if (input!.goal.prompt === "cooperative" && reason === "preflight_ready") {
        const id = "cooperative-turn", requestId = "cooperative-request";
        const deadline = (osMonotonicNs() + 200_000_000n).toString();
        await wire.call("turn", { id, deadline_os_ns: deadline });
        const model = input!.grant.model;
        await metadata([
          { kind: "request_reserve", request_id: requestId, model: { id: model.id, provider: model.provider, api: model.api } },
          { kind: "call", request_id: requestId, purpose: "planning" },
        ]);
        await wire.call("dispatch", { identity: { turn_id: id, request_id: requestId,
          generation: input!.snapshot.generation, role: "ordinary", deadline_os_ns: deadline,
          phase: input!.snapshot.run.status, root_execution_id: null, source_hash: null,
          authoring_deadline_at: null, pending_decision: true, plan_id: null } });
        await metadata([{ kind: "response", response: { request_id: requestId, successful: true,
          calls: [{ id: "expired-call", name: "help", arguments: { value: 7 } }] } }]);
        canceledTurn = { id, request: requestId };
        await marker("cooperative_waiting");
      }
      else if (input!.goal.prompt === "cooperative" && reason === "resident_attention") await exerciseTool({ value: 7 }, true);
      else if (reason === "tool") await exerciseTool();
      else await marker(reason);
      return null;
    }
    if (method === "close") {
      setImmediate(() => { void wire.flush().then(() => { wire.end(); process.stdin.resume(); }); });
      return null;
    }
    throw new Error("Unknown infrastructure fixture method");
  }, () => {});
  async function metadata(operations: CognitionMetadata[]) { await wire.call("metadata", { sequence: ++sequence, operations }); }
  async function marker(name: string, details: Json = null) {
    await metadata([{ kind: "event", run_id: input!.snapshot.run.run_id, type: "fixture.cognition", summary: name, details }]);
  }
  async function exerciseTool(args: Json = JSON.parse('{"__proto__":{"fixture_owned":true},"value":7}'), pendingDecision = false) {
    const id = `request-${++request}`, turn = `turn-${request}`;
    const deadline = (osMonotonicNs() + 30_000_000_000n).toString();
    await wire.call("turn", { id: turn, deadline_os_ns: deadline });
    const model = input!.grant.model;
    await metadata([
      { kind: "request_reserve", request_id: id, model: { id: model.id, provider: model.provider, api: model.api } },
      { kind: "call", request_id: id, purpose: "planning" },
    ]);
    await wire.call("dispatch", { identity: { turn_id: turn, request_id: id, generation: input!.snapshot.generation,
      role: "ordinary", deadline_os_ns: deadline, phase: input!.snapshot.run.status,
      root_execution_id: null, source_hash: null, authoring_deadline_at: null, pending_decision: pendingDecision, plan_id: null } });
    await metadata([{ kind: "response", response: { request_id: id, successful: true, calls: [{ id: "call-1", name: "help", arguments: args }] } }]);
    try {
      await wire.call("tool", { request_id: id, call_id: "call-1", name: "help", arguments: args });
      await marker("tool_returned");
    } catch { await marker("tool_rejected"); }
    await wire.call("turn_end", { id: turn });
  }
  await wire.ended;
  await wire.drain();
}

if (import.meta.main) await runOwnedProtocolFixture();
