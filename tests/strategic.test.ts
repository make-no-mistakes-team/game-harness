import { afterEach, expect, test, vi } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AssistantMessage, RawSseEvent } from "@oh-my-pi/pi-ai";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { ModelProgramEvidence } from "../src/evaluation/model-evidence.ts";
import { DEFAULT_EVALUATION_CAPS } from "../src/evaluation/config.ts";
import { catalogEstimate, classifyEvaluation, costToResult } from "../src/evaluation/results.ts";
import type { ObservationV3, RunPauseCause } from "../src/shared/contracts.ts";
import type { AuthManager } from "../src/server/auth.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import type { HistoryQueryOptions } from "../src/server/history-protocol.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import {
  StrategicPlanner,
  type StrategicHost,
} from "../src/server/strategic.ts";
import { minecraftObservationFixture, minecraftRunFixture, minecraftTestAdapter } from "./helpers/adapter-contract.ts";
import { finishHistoryExecution, historyExecution, historySpec } from "./helpers/history-fixture.ts";

type Gate = Parameters<Agent["setBeforeModelCall"]>[0];
type Assistant = Extract<AgentEvent, { type: "message_end" }>["message"];
interface FakeAgent {
  gate: Gate;
  emit(message: Partial<Assistant>): void;
}
const resources: {
  planner: StrategicPlanner;
  store: Store;
  directory: string;
  history: HistoryReader;
  learning: ImprovementLearning;
  observer?: ModelProgramEvidence;
}[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.planner.close();
    await resource.learning.close();
    await resource.observer?.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

function setup(onPrompt: (text: string, agent: FakeAgent) => Promise<void>, streamFn?: StreamFn) {
  const directory = mkdtempSync(join(tmpdir(), "gameharness-strategic-"));
  const store = new Store(directory), adapter = minecraftTestAdapter();
  const history = new HistoryReader(store.readLocation());
  const learning = new ImprovementLearning(store, history);
  const sessionId = crypto.randomUUID();
  const lifeId = 1;
  const run = minecraftRunFixture(adapter, {
    session_id: sessionId,
    life_id: lifeId,
    task: "Observe authorized state",
    model_id: "fixture-model",
    world_id: crypto.randomUUID(),
    epoch: 1,
    status: "running",
    started_at: null,
    ended_at: null,
    turns: 0,
    model_status: "idle",
    error: null,
  });
  store.saveRun(run);
  const observation = minecraftObservationFixture(adapter, { session_id: sessionId, world_id: run.world_id });
  observation.data.blocks.push({ target: { target_id: "detail-only-block", incarnation: 1, life_id: lifeId, space: observation.space },
    name: "stone", position: { x: .5, y: 63.5, z: .5 }, observed_at: new Date().toISOString(), current: true });
  const state = {
    pending: false,
    busy: true,
    generation: 1,
    prompts: 0,
    creates: 0,
    releases: 0,
    pauses: [] as string[],
    pauseCauses: [] as RunPauseCause[],
    replacements: [] as unknown[],
    contexts: [] as Record<string, unknown>[],
    images: [] as unknown[],
  };
  let planner: StrategicPlanner;
  const host: StrategicHost = {
    run: () => run,
    generation: () => state.generation,
    assertCurrent: (generation, epoch) => {
      if (
        generation !== state.generation ||
        (epoch !== undefined && epoch !== run.epoch) ||
        !["running", "reviewing"].includes(run.status)
      )
        throw new RuntimeFault("stale_context", "Fixture authority revoked");
      return run;
    },
    tools: () => [],
    rootPrompt: () => "Fixture instruction",
    observe: async () => observation,
    projectObservation: current => adapter.projectObservation(current),
    policies: () => [],
    action: () => null,
    programPending: () => state.pending,
    busy: () => state.busy,
    persist: (summary) => store.saveRun(run, summary),
    pause: (message, cause) => {
      state.pauses.push(message);
      state.pauseCauses.push(cause);
      run.status = "paused";
      state.generation++;
      planner.fence();
    },
    terminal: (status, message) => {
      run.status = status;
      run.error = message;
      planner.fence();
    },
    reviewContext: async (options) => {
      await learning.prepareFeedback(run.run_id, options);
      return await history.query({ kind: "review_context", run_id: run.run_id,
        after: { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 0, scope_hash: null }, limit: 12 }, options);
    },
    reviewComplete: () => {
      run.status = "completed";
      planner.fence();
    },
  };
  const auth = {
    createAgent: async (options: Parameters<AuthManager["createAgent"]>[0]) => {
      state.creates++;
      if (streamFn) return new Agent({ initialState: { model: accountingModel(), systemPrompt: options.systemPrompt,
        tools: options.tools }, streamFn, getApiKey: () => "ACCOUNTING_FIXTURE_NO_NETWORK" });
      let listener: ((event: AgentEvent) => void) | null = null;
      const fake: FakeAgent = {
        gate: undefined,
        emit: (message) =>
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "stop",
              usage: { input: 2, cacheRead: 3, cacheWrite: 4, output: 5 },
              ...message,
            },
          } as AgentEvent),
      };
      return {
        setBeforeModelCall: (gate: Gate) => {
          fake.gate = gate;
        },
        setTools: () => {},
        subscribe: (callback: (event: AgentEvent) => void) => {
          listener = callback;
          return () => {
            listener = null;
          };
        },
        replaceMessages: (messages: unknown) => {
          state.replacements.push(messages);
        },
        abort: () => {},
        waitForIdle: async () => {},
        prompt: async (text: string, images?: unknown) => {
          state.prompts++;
          state.contexts.push(JSON.parse(text));
          state.images.push(images);
          await onPrompt(text, fake);
        },
      } as unknown as Agent;
    },
    releaseAgent: async () => {
      state.releases++;
    },
  } as unknown as AuthManager;
  planner = new StrategicPlanner(store, auth, host);
  resources.push({ planner, store, directory, history, learning });
  const event = (type: string) => {
    const ready = Promise.withResolvers<void>();
    const unsubscribe = store.subscribe((value) => {
      if (value.run_id === run.run_id && value.type === type) {
        unsubscribe();
        ready.resolve();
      }
    });
    return ready.promise;
  };
  return { planner, store, run, state, event, host, observation, history };
}

test("review prompts carry named metric replacements and a scoped V2 continuation from real published history", async () => {
  const f = setup(async (_text, agent) => { await callGate(agent); agent.emit({}); });
  const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run, "Named review evidence"));
  const root = historyExecution(f.store, f.run, skill);
  const child = historyExecution(f.store, f.run, skill, root);
  finishHistoryExecution(f.store, child);
  finishHistoryExecution(f.store, root);
  f.run.status = "reviewing";
  f.store.saveRun(f.run);
  await f.planner.start(1);
  const finished = f.event("scheduler.review_finished");
  f.planner.wake("goal_review");
  await finished;
  const context = f.state.contexts[0]?.improvement_review as {
    metrics: { kind: string; program: { name: string; version: number };
      execution_ordinal: number; revision: number; generation: number;
      metric: { name: string; version: number; execution_ordinal: number; root_execution_ordinal: number; outcome: string } }[];
    next_after: { schema_version: 2; opportunity_change_seq: number; metric_change_seq: number; scope_hash: string };
    projection: { generation: number };
  };
  const published = f.store.historyProjectionGeneration(f.run.run_id)!;
  expect(context.metrics).toHaveLength(2);
  for (const execution_ordinal of [1, 2]) {
    expect(context.metrics.find(value => value.execution_ordinal === execution_ordinal)).toMatchObject({
      kind: "replace", program: { name: skill.name, version: skill.version },
      execution_ordinal, revision: published.revision, generation: published.generation,
      metric: { name: skill.name, version: skill.version, execution_ordinal,
        root_execution_ordinal: 1, outcome: "succeeded" },
    });
  }
  expect(context.next_after.schema_version).toBe(2);
  expect(context.next_after.opportunity_change_seq).toBeGreaterThan(0);
  expect(context.next_after.metric_change_seq).toBeGreaterThan(0);
  expect(context.next_after.scope_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(context.projection.generation).toBe(published.generation);
  for (const id of [root.execution_id, child.execution_id, skill.skill_id]) expect(JSON.stringify(context)).not.toContain(id);
  const continuation = await f.history.query({ kind: "review_context", run_id: f.run.run_id,
    after: context.next_after, limit: 12 }, { deadlineHostMs: performance.now() + 10_000 });
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation))
    throw new Error("Expected a named review continuation page");
  expect(continuation).toMatchObject({ metrics: [], opportunities: [], has_more: false });
  expect(continuation.next_after).toEqual(context.next_after);
});

async function callGate(agent: FakeAgent) {
  return await agent.gate?.({ systemPrompt: [], messages: [], tools: [] });
}

function gated(agent: FakeAgent, reason?: string) {
  agent.emit({
    stopReason: "aborted",
    errorMessage: reason,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  } as Partial<Assistant>);
}

for (const delivery of ["resolve", "reject"] as const)
for (const revoke of ["fence", "generation", "phase"] as const)
  test(`a ${revoke} change while real review history awaits ${delivery} delivery cannot prompt`, async () => {
    const f = setup(async () => { throw new Error("Revoked review must not prompt"); });
    f.run.status = "reviewing";
    const entered = Promise.withResolvers<void>(), deliver = Promise.withResolvers<void>();
    let options: HistoryQueryOptions | undefined;
    const read = f.host.reviewContext!;
    f.host.reviewContext = async (request) => {
      options = request;
      const context = await read(request);
      entered.resolve();
      await deliver.promise;
      if (delivery === "reject") throw new Error("Readonly delivery rejected after authority changed");
      return context;
    };
    await f.planner.start(f.state.generation);
    f.planner.wake("goal_review");
    await entered.promise;
    expect(options?.signal?.aborted).toBe(false);
    if (revoke === "fence") {
      f.planner.fence();
      expect(options?.signal?.aborted).toBe(true);
    } else if (revoke === "generation") f.state.generation++;
    else f.run.status = "running";
    const turn = Reflect.get(f.planner, "turn") as Promise<void>;
    deliver.resolve();
    await turn;
    expect(f.state.prompts).toBe(0);
    expect(f.run.usage.calls).toBe(0);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event =>
      event.type === "runtime.model_observation_failed" || event.type === "runtime.history_query_failed")).toBe(false);
  });

test("review fencing aborts the actual pending readonly query and close joins its drain", async () => {
  const f = setup(async () => { throw new Error("Cancelled review must not prompt"); });
  f.run.status = "reviewing";
  const entered = Promise.withResolvers<void>();
  const read = f.host.reviewContext!;
  let options: HistoryQueryOptions | undefined, querySettled = false;
  f.host.reviewContext = async (request) => {
    options = request;
    const pending = read(request);
    entered.resolve();
    try { return await pending; }
    finally { querySettled = true; }
  };
  await f.planner.start(1);
  f.planner.wake("goal_review");
  await entered.promise;
  let closed = false;
  const closing = f.planner.close().then(() => { closed = true; });
  expect(options?.signal?.aborted).toBe(true);
  expect(closed).toBe(false);
  expect(querySettled).toBe(false);
  await closing;
  expect(closed).toBe(true);
  expect(querySettled).toBe(true);
  expect(f.state.prompts).toBe(0);
  expect(f.state.releases).toBe(1);
});

test("an expired original review horizon cancels history without a model request", async () => {
  const f = setup(async () => { throw new Error("Expired review must not prompt"); });
  f.run.status = "reviewing";
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const read = f.host.reviewContext!;
  let deadline = 0, signal: AbortSignal | undefined;
  f.host.reviewContext = async (options) => {
    const context = await read(options);
    deadline = options.deadlineHostMs;
    signal = options.signal;
    entered.resolve();
    await release.promise;
    return context;
  };
  await f.planner.start(1);
  f.planner.wake("goal_review");
  await entered.promise;
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
  release.resolve();
  await f.event("scheduler.review_finished");
  expect(deadline).toBeGreaterThan(0);
  expect(signal?.aborted).toBe(true);
  expect(f.state.prompts).toBe(0);
  expect(f.run.usage.calls).toBe(0);
  vi.restoreAllMocks();
});

test("real readonly review faults are history failures, not observations or provider calls", async () => {
  const f = setup(async () => { throw new Error("Failed history must not prompt"); });
  f.run.status = "reviewing";
  await f.history.close();
  const failed = f.event("runtime.history_query_failed");
  await f.planner.start(1);
  f.planner.wake("goal_review");
  await failed;
  await f.planner.close();
  expect(f.state.prompts).toBe(0);
  expect(f.state.pauseCauses).toEqual(["preparation_failed"]);
  expect(f.run.usage.calls).toBe(0);
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(events.some(event => event.type === "runtime.model_observation_failed")).toBe(false);
  expect(events.some(event => event.type === "scheduler.review_finished")).toBe(false);
});

for (const clock of ["wall", "monotonic"] as const)
test(`review history rejection at the original ${clock} horizon completes the goal before its timer callback runs`, async () => {
  const f = setup(async () => { throw new Error("Expired review must not prompt"); });
  f.run.status = "reviewing";
  const entered = Promise.withResolvers<HistoryQueryOptions>(), reject = Promise.withResolvers<never>();
  let requests = 0;
  f.host.reviewContext = async options => {
    requests++;
    entered.resolve(options);
    return await reject.promise;
  };
  await f.planner.start(1);
  f.planner.wake("goal_review");
  const options = await entered.promise;
  const turn = Reflect.get(f.planner, "turn") as Promise<void>;
  expect(options.signal?.aborted).toBe(false);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event => event.type === "model.deadline")).toBe(false);
  if (clock === "wall") {
    const deadline = Reflect.get(f.planner, "turnDeadline") as number;
    vi.spyOn(Date, "now").mockReturnValue(deadline);
  } else {
    vi.spyOn(performance, "now").mockReturnValue(options.deadlineHostMs);
  }
  reject.reject(new Error("Readonly context rejected at its original finite horizon"));
  await turn;
  expect(requests).toBe(1);
  expect(options.signal?.aborted).toBe(true);
  expect(f.run).toHaveProperty("status", "completed");
  expect(f.state.prompts).toBe(0);
  expect(f.run.usage.calls).toBe(0);
  expect(f.state.pauseCauses).toEqual([]);
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  expect(events.some(event => event.type === "model.deadline")).toBe(false);
  expect(events.some(event => event.type === "runtime.history_query_failed" || event.type === "runtime.model_observation_failed")).toBe(false);
  expect(events.find(event => event.type === "scheduler.review_finished")?.details)
    .toMatchObject({ deadline_reached: true, provider_failed: false, calls: 0 });
});

function accountingModel() {
  const descriptor = getBundledModels("openai-codex").find(value => value.api === "openai-codex-responses");
  if (!descriptor) throw new Error("Installed catalog lacks an offline Codex descriptor");
  return getBundledModel<"openai-codex-responses">("openai-codex", descriptor.id);
}
type RawObserver = NonNullable<Parameters<Agent["setRawSseEventInterceptor"]>[0]>;
function rawEvent(value: Record<string, unknown>): RawSseEvent {
  const data = JSON.stringify(value);
  return { event: typeof value.type === "string" ? value.type : null, data, raw: [`data: ${data}`] };
}
function terminal(usage?: Record<string, unknown>, id: string | null = "accounting-response") {
  return rawEvent({ type: "response.completed", response: { ...(id === null ? {} : { id }), status: "completed",
    ...(usage === undefined ? {} : { usage }) } });
}
const completeWireUsage = { input_tokens: 10, output_tokens: 4, total_tokens: 14,
  input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 } };
function sdkSettlement(stopReason: "stop" | "aborted" = "stop", zero = false): AssistantMessage {
  const model = accountingModel();
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
    stopReason, timestamp: 0, usage: { input: zero ? 0 : 7, cacheRead: zero ? 0 : 3, cacheWrite: 0,
      output: zero ? 0 : 4, totalTokens: zero ? 0 : 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function settledStream(message: AssistantMessage) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  if (message.stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
  else stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}
function accountingFixture(onStream: (observe: RawObserver | undefined, index: number) => AssistantMessage) {
  let index = 0;
  const fixture = setup(async () => { throw new Error("Real Agent stream must own this fixture"); },
    (model, _context, options) => settledStream(onStream(options?.onSseEvent
      ? event => options.onSseEvent!(event, model) : undefined, index++)));
  const directory = resources.at(-1)!.directory;
  const observer = new ModelProgramEvidence(fixture.store, directory, { ...DEFAULT_EVALUATION_CAPS,
    hostRequestAdmissions: 30 }, "accounting-fixture", () => {});
  resources.at(-1)!.observer = observer;
  return { ...fixture, observer };
}
async function accountingTurn(fixture: ReturnType<typeof accountingFixture>, failed = false) {
  if (fixture.run.status === "paused") {
    fixture.run.status = "running";
    await fixture.planner.start(fixture.state.generation);
  }
  const done = fixture.event(failed ? "scheduler.turn_failed" : "scheduler.turn_finished");
  fixture.planner.wake("policy_replan");
  await done;
  return fixture.observer.summary(fixture.run.run_id);
}

test("strategic request records actual payload effort and first provider event without payload or reasoning contents", async () => {
  let invocation = 0;
  const f = setup(async () => { throw new Error("Real Agent owns this offline fixture"); },
    async (model, _context, options) => {
      invocation++;
      await options?.onPayload?.({ model: model.id, reasoning: { effort: "low" },
        instructions: "PRIVATE_FIXTURE_PROMPT", input: [{ text: "PRIVATE_FIXTURE_INPUT" }] }, model);
      options?.onSseEvent?.(rawEvent({ type: "response.create" }), model);
      if (invocation === 2) options?.onSseEvent?.(terminal({
        ...completeWireUsage, output_tokens_details: { reasoning_tokens: 999 },
      }, "configuration-fixture-1"), model);
      const id = `configuration-fixture-${invocation}`;
      options?.onSseEvent?.(rawEvent({ type: "response.created", response: { id } }), model);
      options?.onSseEvent?.(terminal({ ...completeWireUsage, output_tokens_details: { reasoning_tokens: 2 } }, id), model);
      return settledStream(sdkSettlement());
    });
  await f.planner.start(1);
  const done = f.event("scheduler.turn_finished");
  f.planner.wake("policy_replan");
  await done;
  const events = f.store.eventsAfter(f.run.run_id, 0, 500);
  const configuration = events.find(event => event.type === "model.request_configuration");
  expect(configuration?.details).toMatchObject({ reasoning_effort: "low", source: "sdk_transformed_payload" });
  const first = events.filter(event => event.type === "model.first_response_event");
  expect(first).toHaveLength(1);
  expect(first[0]?.details).toMatchObject({ event_type: "response.created" });
  expect(events.find(event => event.type === "model.response_usage_details")?.details)
    .toMatchObject({ reasoning_tokens: 2, cached_input_tokens: 3 });
  const metadata = JSON.stringify(events.filter(event => ["model.request_configuration",
    "model.first_response_event", "model.response_usage_details"].includes(event.type)));
  expect(metadata).not.toContain("PRIVATE_FIXTURE");
  const next = f.event("scheduler.turn_finished");
  f.planner.wake("policy_replan");
  await next;
  const all = f.store.eventsAfter(f.run.run_id, 0, 500);
  const usageDetails = all.filter(event => event.type === "model.response_usage_details").map(event => event.details);
  expect(usageDetails).toHaveLength(2);
  for (const detail of usageDetails)
    expect(detail).toMatchObject({ reasoning_tokens: 2, cached_input_tokens: 3 });
});

test("installed Agent snapshots raw observer before admission; replacing it in the gate cannot bind that invocation", async () => {
  const seen: string[] = [];
  const agent = new Agent({ initialState: { model: accountingModel() }, getApiKey: () => "OFFLINE_ONLY",
    streamFn: (model, _context, options) => {
      options?.onSseEvent?.(terminal(completeWireUsage), model);
      return settledStream(sdkSettlement());
    } });
  agent.setRawSseEventInterceptor(() => { seen.push("before-prompt"); });
  agent.setBeforeModelCall(() => { agent.setRawSseEventInterceptor(() => { seen.push("inside-gate"); }); });
  try {
    await agent.prompt("Synthetic seam characterization; no external transport.");
    expect(seen).toEqual(["before-prompt"]);
    await agent.prompt("Second synthetic invocation.");
    expect(seen).toEqual(["before-prompt", "inside-gate"]);
  } finally { agent.abort(); await agent.waitForIdle(); }
});

test("real strategic accounting keeps SDK subtotal but cannot price three aborted synthetic-zero admissions", async () => {
  const f = accountingFixture((observe, index) => {
    if (index === 0) observe?.(terminal(completeWireUsage));
    return sdkSettlement(index === 0 ? "stop" : "aborted", index > 0);
  });
  await f.planner.start(1);
  const successfulUsage = (await accountingTurn(f)).usage;
  for (let index = 0; index < 3; index++) await accountingTurn(f, true);
  const summary = await f.observer.summary(f.run.run_id);
  expect(summary.usage).toMatchObject({ schema_version: 2, admissions: 4, reported_messages: 4,
    event_coverage: "complete", consumption_coverage: "unknown",
    consumption_scope: "observed_logical_admissions",
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 4 },
    wire_attempts: null, subscription_cost: null });
  expect(summary.usage).not.toHaveProperty("coverage");
  expect(f.run.usage).toMatchObject({ calls: 4, uncached_input: 7, cache_read: 3, output: 4, known_cost: null,
    accounting_basis: "sdk_reported_subtotal" });
  expect(catalogEstimate(summary.usage, { uncached_input: 1, cache_read: 1, cache_write: 1, output: 1 }).estimate).toBeNull();
  const failed = classifyEvaluation({ inferenceAdmitted: true, goalVerified: false, platformChecksComplete: true,
    providerError: false, providerSettled: false });
  const success = classifyEvaluation({ inferenceAdmitted: true, goalVerified: true, platformChecksComplete: true,
    providerError: false, providerSettled: true });
  const result = costToResult([{ outcome: failed, usage: summary.usage }, { outcome: success, usage: successfulUsage }]);
  expect(result).toMatchObject({ attempts_included: 2, unsuccessful_attempts_included: 1, admissions: 5,
    uncached_input: null, output: null, reported_subtotal: { uncached_input: 14, cache_read: 6, cache_write: 0, output: 8 },
    subscription_cost: null, wire_attempts: null });
});

for (const scenario of [
  { name: "created response ID then abort", raw: rawEvent({ type: "response.created", response: { id: "created-only" } }), aborted: true },
  { name: "normal terminal response ID without usage", raw: terminal(undefined), aborted: false },
  { name: "normal stop without any terminal event", raw: null, aborted: false },
]) {
  test(`${scenario.name} does not certify synthetic SDK zero consumption`, async () => {
    const f = accountingFixture(observe => {
      if (scenario.raw) observe?.(scenario.raw);
      return { ...sdkSettlement(scenario.aborted ? "aborted" : "stop", true), responseId: "correlation-only" };
    });
    await f.planner.start(1);
    const summary = await accountingTurn(f, scenario.aborted);
    expect(summary.usage).toMatchObject({ event_coverage: "complete", consumption_coverage: "unknown",
      uncached_input: null, cache_read: null, cache_write: null, output: null,
      reported_subtotal: { uncached_input: 0, cache_read: 0, cache_write: 0, output: 0 } });
  });
}

for (const aborted of [false, true]) {
  test(`explicit bound terminal zero without response ID survives local aborted=${aborted}`, async () => {
    const f = accountingFixture(observe => {
      observe?.(terminal({ input_tokens: 0, output_tokens: 0, total_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, null));
      return sdkSettlement(aborted ? "aborted" : "stop", true);
    });
    await f.planner.start(1);
    const summary = await accountingTurn(f, aborted);
    expect(summary).toMatchObject({ provider_settled: !aborted, usage: { event_coverage: "complete", consumption_coverage: "known",
      uncached_input: 0, cache_read: 0, cache_write: 0, output: 0, subscription_cost: null, wire_attempts: null } });
  });
}

test("terminal counters survive a later local abort independently from provider outcome", async () => {
  const f = accountingFixture(observe => { observe?.(terminal(completeWireUsage)); return sdkSettlement("aborted"); });
  await f.planner.start(1);
  expect(await accountingTurn(f, true)).toMatchObject({ provider_settled: false, usage: {
    consumption_coverage: "known", uncached_input: 7, cache_read: 3, cache_write: 0, output: 4 } });
});

test("a late predecessor callback and duplicate terminal cannot certify the next host request", async () => {
  let predecessor: RawObserver | undefined;
  const f = accountingFixture((observe, index) => {
    if (index === 0) {
      predecessor = observe;
      observe?.(terminal(completeWireUsage, "first"));
      observe?.(terminal(completeWireUsage, "first"));
      return sdkSettlement();
    }
    predecessor?.(terminal(completeWireUsage, "late-first"));
    return sdkSettlement("stop", true);
  });
  await f.planner.start(1);
  const first = await accountingTurn(f);
  expect(first.usage).toMatchObject({ admissions: 1, uncached_input: 7, output: 4 });
  const second = await accountingTurn(f);
  expect(second.usage).toMatchObject({ admissions: 2, event_coverage: "complete", consumption_coverage: "unknown",
    uncached_input: null, output: null, reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 4 } });
});

test("observed abandoned response prevents final terminal usage from certifying the whole admission", async () => {
  const f = accountingFixture(observe => {
    observe?.(rawEvent({ type: "response.created", response: { id: "abandoned-response" } }));
    observe?.(terminal(completeWireUsage, "replacement-response"));
    return sdkSettlement();
  });
  await f.planner.start(1);
  expect((await accountingTurn(f)).usage).toMatchObject({ consumption_coverage: "unknown",
    uncached_input: null, output: null, reported_subtotal: { uncached_input: 7, output: 4 } });
});

for (const sample of [
  { name: "absent cache breakdown", wire: { input_tokens: 10, output_tokens: 4 },
    want: { uncached_input: null, cache_read: null, cache_write: null, output: 4 } },
  { name: "negative output", wire: { ...completeWireUsage, output_tokens: -1 },
    want: { uncached_input: 7, cache_read: 3, cache_write: 0, output: null } },
  { name: "nonfinite output", wire: { ...completeWireUsage, output_tokens: Number.POSITIVE_INFINITY },
    want: { uncached_input: 7, cache_read: 3, cache_write: 0, output: null } },
  { name: "fractional output", wire: { ...completeWireUsage, output_tokens: 1.5 },
    want: { uncached_input: 7, cache_read: 3, cache_write: 0, output: null } },
  { name: "cache greater than aggregate input", wire: { ...completeWireUsage,
    input_tokens_details: { cached_tokens: 11, cache_write_tokens: 0 } },
    want: { uncached_input: null, cache_read: null, cache_write: 0, output: 4 } },
]) {
  test(`terminal ${sample.name} leaves category missingness explicit rather than adopting SDK defaults`, async () => {
    const f = accountingFixture(observe => { observe?.(terminal(sample.wire)); return sdkSettlement(); });
    await f.planner.start(1);
    expect((await accountingTurn(f)).usage).toMatchObject({ ...sample.want, consumption_coverage: "partial",
      event_coverage: "complete", reported_subtotal: { uncached_input: 7, cache_read: 3, cache_write: 0, output: 4 } });
  });
}

test("raw accounting extraction excludes reasoning, payloads, credentials and headers from durable evidence", async () => {
  const f = accountingFixture(observe => {
    observe?.(rawEvent({ type: "response.completed", headers: { authorization: "SECRET_ACCOUNTING_HEADER" },
      request: { prompt: "SECRET_ACCOUNTING_PROMPT" }, credentials: "SECRET_ACCOUNTING_CREDENTIAL",
      response: { id: "safe-accounting-correlation", usage: completeWireUsage,
        output: [{ type: "reasoning", text: "SECRET_ACCOUNTING_REASONING" }] } }));
    return sdkSettlement();
  });
  await f.planner.start(1);
  const summary = await accountingTurn(f);
  expect(summary.usage).toMatchObject({ consumption_coverage: "known", uncached_input: 7, output: 4 });
  const serialized = JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 500));
  for (const marker of ["SECRET_ACCOUNTING_HEADER", "SECRET_ACCOUNTING_PROMPT", "SECRET_ACCOUNTING_CREDENTIAL",
    "SECRET_ACCOUNTING_REASONING", "ACCOUNTING_FIXTURE_NO_NETWORK"]) expect(serialized).not.toContain(marker);
  const usage = f.store.eventsAfter(f.run.run_id, 0, 500).find(value => value.type === "model.usage");
  const admission = f.store.eventsAfter(f.run.run_id, 0, 500).find(value => value.type === "model.call");
  expect(usage?.details).toHaveProperty("usage_evidence.schema_version", 1);
  expect(usage?.details).toHaveProperty("usage_evidence.request_id", Reflect.get(Object(admission?.details), "request_id"));
  const finalized = await f.observer.finalize(f.run.run_id, { status: "failed", reason: "offline_privacy_fixture" });
  const journal = readFileSync(join(resources.at(-1)!.directory, finalized.journal), "utf8");
  for (const marker of ["SECRET_ACCOUNTING_HEADER", "SECRET_ACCOUNTING_PROMPT", "SECRET_ACCOUNTING_CREDENTIAL",
    "SECRET_ACCOUNTING_REASONING", "ACCOUNTING_FIXTURE_NO_NETWORK"]) expect(journal).not.toContain(marker);
});

test("initial strategic prompt receives actual typed images without binary Store evidence", async () => {
  const f = setup(async (_text, agent) => { await callGate(agent); agent.emit({}); });
  const images = [{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==" }];
  const metadata = { sequence: 7, capturedAt: Date.now(), width: 1, height: 1, encoded_bytes: 70,
    sha256: "a".repeat(64), alignment: "unsynchronized" };
  Object.assign(f.host, { modelObservation: async () => ({ observation: f.observation, images, image_metadata: metadata }) });
  await f.planner.start(1);
  const done = f.event("scheduler.turn_finished");
  f.planner.wake("policy_replan");
  await done;
  expect(f.state.prompts).toBe(1);
  expect(f.state.images[0]).toEqual(images);
  expect(JSON.stringify(f.state.contexts[0])).not.toContain(images[0]!.data);
  expect(JSON.stringify(f.store.eventsAfter(f.run.run_id, 0, 500))).not.toContain(images[0]!.data);
});

test("revoking scope during image selection cannot prompt and is not a provider failure", async () => {
  const f = setup(async () => { throw new Error("A stale image must not reach inference"); });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  Object.assign(f.host, { modelObservation: async () => {
    entered.resolve(); await release.promise;
    throw new RuntimeFault("stale_context", "Image selection life changed");
  } });
  await f.planner.start(1);
  f.planner.wake("policy_replan");
  await entered.promise;
  expect(f.state.prompts).toBe(0);
  f.state.generation++;
  release.resolve();
  await f.planner.close();
  expect(f.state.prompts).toBe(0);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event => event.type === "model.call")).toBe(false);
});

test("image encoding failure before prompt is not misclassified as provider failure", async () => {
  const f = setup(async () => { throw new Error("Encoding failure must not enter prompt"); });
  Object.assign(f.host, { modelObservation: async () => { throw new RuntimeFault("backend_unavailable", "Native image encoding failed"); } });
  await f.planner.start(1);
  const rejected = f.event("runtime.model_observation_failed");
  f.planner.wake("policy_replan");
  await rejected;
  await f.planner.close();
  expect(f.state.prompts).toBe(0);
  expect(f.run.usage.calls).toBe(0);
  expect(f.run.model_status).not.toBe("error");
  expect(f.run.status).toBe("paused");
  expect(f.state.pauses).toHaveLength(1);
  expect(f.state.pauseCauses).toEqual(["observation_unavailable"]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 500).some(event => event.type === "model.call" || event.type === "scheduler.turn_failed")).toBe(false);
});

test("next-turn feedback retains safe validation locations and generated failure identity", async () => {
  const f = setup(async (_text, agent) => { await callGate(agent); agent.emit({}); });
  f.store.event(f.run.run_id, "model.tool_rejected", "Authoring admission rejected", { tool: "program_write", error: {
    code: "invalid_program", message: "Invalid syntax", issues: [{ code: "invalid_syntax", location: { line: 4, column: 9 }, limit: null }],
  } });
  f.store.event(f.run.run_id, "skill.closed", "Generated procedure failed", { status: "failed", diagnostic: {
    type: "TypeError", message: "Expected an observation object", source_hash: "c".repeat(64), location: { mapping: "unmapped" },
  } });
  await f.planner.start(1);
  const done = f.event("scheduler.turn_finished");
  f.planner.wake("policy_replan");
  await done;
  const feedback = f.state.contexts[0]?.feedback;
  expect(JSON.stringify(feedback)).toContain('"line":4');
  expect(JSON.stringify(feedback)).toContain('"column":9');
  expect(JSON.stringify(feedback)).toContain("Expected an observation object");
  expect(JSON.stringify(feedback)).toContain("c".repeat(64));
  expect(JSON.stringify(feedback)).toContain("unmapped");
});

test("resident attention overflow names its omitted range and does not replay delivered triggers", async () => {
  const f = setup(async (_text, agent) => {
    await callGate(agent);
    agent.emit({ responseId: "attention-response" } as Partial<Assistant>);
    const stopped = await callGate(agent);
    gated(agent, stopped?.reason);
  });
  f.state.pending = true;
  await f.planner.start(1);
  const first = f.event("scheduler.turn_finished");
  const sequences: number[] = [];
  for (let index = 0; index < 34; index++) {
    sequences.push(f.store.event(f.run.run_id, "controller.event", `Authored attention ${index}`, {
      event: { kind: "attention", urgency: "ordinary", summary: `Authored attention ${index}`, details: { index } },
    }).event_seq);
    f.planner.wake("resident_attention");
  }
  await first;
  const selected = f.state.contexts[0]!;
  expect(selected.omitted_resident_attention).toEqual({
    count: 2, after_event_seq: sequences[0]! - 1, through_event_seq: sequences[1],
  });
  const feedback = selected.feedback as { event_seq: number }[];
  expect(feedback.some(event => event.event_seq === sequences[0] || event.event_seq === sequences[1])).toBe(false);
  expect(feedback.map(event => event.event_seq)).toContain(sequences[33]!);
  const second = f.event("scheduler.turn_finished");
  const latest = f.store.event(f.run.run_id, "controller.event", "Fresh authored attention", {
    event: { kind: "attention", urgency: "urgent", summary: "Fresh authored attention", details: { changed: true } },
  });
  f.planner.wake("resident_attention"); await second;
  expect(f.state.contexts[1]?.omitted_resident_attention).toBeNull();
  expect((f.state.contexts[1]?.feedback as { event_seq: number }[]).map(event => event.event_seq)).toEqual([latest.event_seq]);
  expect(f.state.prompts).toBe(2);
});

for (const spec of [
  { initial: 32, arrivals: 1, success: true, omitted: 0 },
  { initial: 34, arrivals: 1, success: true, omitted: 0 },
  { initial: 34, arrivals: 40, success: true, omitted: 8 },
  { initial: 32, arrivals: 1, success: false, omitted: 1 },
]) test(`resident in-flight overflow retains only unconsumed omissions: ${JSON.stringify(spec)}`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  const f = setup(async (_text, agent) => {
    await callGate(agent);
    if (++calls === 1) {
      entered.resolve(); await release.promise;
      if (!spec.success) {
        agent.emit({ stopReason: "error", errorMessage: "Controlled external request failure" } as Partial<Assistant>);
        return;
      }
    }
    agent.emit({ responseId: `attention-flight-${calls}` } as Partial<Assistant>);
    const stopped = await callGate(agent); gated(agent, stopped?.reason);
  });
  f.state.pending = true;
  await f.planner.start(1);
  const append = (label: string) => {
    const event = f.store.event(f.run.run_id, "controller.event", label, {
      event: { kind: "attention", urgency: "ordinary", summary: label, details: null },
    });
    f.planner.wake("resident_attention"); return event.event_seq;
  };
  const initial: number[] = [], arrivals: number[] = [];
  const first = f.event(spec.success ? "scheduler.turn_finished" : "scheduler.turn_failed");
  for (let index = 0; index < spec.initial; index++) initial.push(append(`Initial ${index}`));
  await entered.promise;
  const second = new Promise<void>(resolve => {
    let completed = 0;
    const off = f.store.subscribe(event => {
      if (event.run_id === f.run.run_id && event.type === "scheduler.turn_finished" &&
          ++completed === (spec.success ? 2 : 1)) { off(); resolve(); }
    });
  });
  try {
    for (let index = 0; index < spec.arrivals; index++) arrivals.push(append(`Arriving ${index}`));
  } finally { release.resolve(); }
  await first;
  if (!spec.success) {
    f.run.status = "running";
    await f.planner.start(f.state.generation);
    f.planner.wake("resident_attention");
  }
  await second;
  const selected = f.state.contexts[1]!;
  if (!spec.omitted) expect(selected.omitted_resident_attention).toBeNull();
  else expect(selected.omitted_resident_attention).toEqual(spec.success
    ? { count: 8, after_event_seq: initial[33], through_event_seq: arrivals[7] }
    : { count: 1, after_event_seq: initial[0]! - 1, through_event_seq: initial[0] });
  const references = [
    ...(selected.feedback as { event_seq: number }[]).map(event => event.event_seq),
    ...(selected.omitted_event_refs as number[]),
  ];
  expect(references).toContain(arrivals.at(-1)!);
  if (spec.success) expect(references.some(sequence => initial.includes(sequence))).toBe(false);
  else expect(references).toContain(initial[1]!);
  expect(f.state.prompts).toBe(2);
});

test("pending work admits one explicit meaningful request, never observation or after-tool polling", async () => {
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({
      responseId: "actual-provider-response",
    } as Partial<Assistant>);
    const stopped = await callGate(agent);
    expect(stopped?.stop).toBe(true);
    expect(stopped?.reason).toBe(
      "A program is meaningful pending work; strategy waits for its outcome",
    );
    gated(agent, stopped?.reason);
  });
  fixture.state.pending = true;
  await fixture.planner.start(1);
  expect(fixture.state.prompts).toBe(0);
  const done = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("policy_replan");
  fixture.planner.wake("policy_replan");
  await done;
  vi.useFakeTimers();
  for (const reason of [
    "observation",
    "tick",
    "no_runnable_work",
    "work_decision_needed",
    "coalesced_pending_work",
  ])
    fixture.planner.wake(reason);
  vi.advanceTimersByTime(160);
  vi.useRealTimers();
  expect(fixture.state.prompts).toBe(1);
  expect(fixture.state.pauses).toEqual([]);
  expect(fixture.run.usage.calls).toBe(1);
  expect(fixture.run.usage.by_purpose.replanning).toMatchObject({
    calls: 1,
    uncached_input: 2,
    cache_read: 3,
    cache_write: 4,
    output: 5,
  });
  expect(fixture.run.usage.known_cost).toBeNull();
  expect(fixture.state.contexts[0]?.adapter_state).toMatchObject({ blocks: [{ target: { target_id: "detail-only-block" } }] });
  expect(fixture.state.contexts[0]).not.toHaveProperty("player");
  expect(
    fixture.store
      .eventsAfter(fixture.run.run_id, 0, 500)
      .find((event) => event.type === "model.request_settled")?.details,
  ).toMatchObject({
    provider_response_id: "actual-provider-response",
    purpose: "replanning",
  });
});

test("a skill admission immediately revokes the rest of the current request allowance", async () => {
  let admit = () => {};
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({});
    admit();
    const stopped = await callGate(agent);
    expect(stopped?.stop).toBe(true);
    gated(agent, stopped?.reason);
  });
  admit = () => {
    fixture.state.pending = true;
    fixture.planner.admitted();
  };
  await fixture.planner.start(1);
  const done = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("recovery_completed");
  await done;
  expect(fixture.state.pauses).toEqual([]);
  expect(fixture.run.usage.calls).toBe(1);
  expect(fixture.run.model_status).toBe("idle");
  expect(
    fixture.store
      .eventsAfter(fixture.run.run_id, 0, 500)
      .filter((event) => event.type === "scheduler.backoff"),
  ).toEqual([]);
});

test("failed requests retain the feedback cursor, account actual usage, and retry with compact evidence", async () => {
  let fail = true;
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({ stopReason: fail ? "error" : "stop" } as Partial<Assistant>);
    fail = false;
  });
  const evidence = fixture.store.event(
    fixture.run.run_id,
    "action.failed",
    "Action safely failed",
    {
      action_id: "failed-action",
      source: "private-program-source",
      observation: { blocks: ["never-echo-detail"] },
    },
  );
  await fixture.planner.start(1);
  let done = fixture.event("scheduler.turn_failed");
  fixture.planner.wake("recovery_completed");
  await done;
  expect(fixture.state.pauses).toHaveLength(1);
  expect(fixture.state.pauseCauses).toEqual(["provider_failure"]);
  fixture.run.status = "running";
  await fixture.planner.start(fixture.state.generation);
  done = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("recovery_completed");
  await done;
  const feedback = fixture.state.contexts.map(
    (context) => context.feedback as { event_seq: number }[],
  );
  expect(
    feedback[0]?.some((event) => event.event_seq === evidence.event_seq),
  ).toBe(true);
  expect(
    feedback[1]?.some((event) => event.event_seq === evidence.event_seq),
  ).toBe(true);
  expect(JSON.stringify(fixture.state.contexts)).not.toContain(
    "private-program-source",
  );
  expect(JSON.stringify(fixture.state.contexts)).not.toContain(
    "never-echo-detail",
  );
  expect(fixture.run.usage).toMatchObject({
    calls: 2,
    uncached_input: 4,
    cache_read: 6,
    cache_write: 8,
    output: 10,
  });
  expect(fixture.state.replacements).toEqual([[], []]);
  expect(fixture.state.releases).toBe(1);
});

test("replacement waits for the old request to settle and its auth scope to release", async () => {
  const requestStarted = Promise.withResolvers<void>();
  const requestFinished = Promise.withResolvers<void>();
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    requestStarted.resolve();
    await requestFinished.promise;
    agent.emit({ stopReason: "aborted" } as Partial<Assistant>);
  });
  await fixture.planner.start(1);
  fixture.planner.wake("recovery_completed");
  await requestStarted.promise;
  const replacement = fixture.planner.start(1);
  expect(fixture.state.creates).toBe(1);
  expect(fixture.state.releases).toBe(0);
  requestFinished.resolve();
  await replacement;
  expect(fixture.state.releases).toBe(1);
  expect(fixture.state.creates).toBe(2);
  expect(fixture.state.prompts).toBe(1);
  expect(fixture.state.pauses).toEqual([]);
});

test("host-ready first planning request can admit work without a separate model bootstrap", async () => {
  const fixture = setup(async (_text, agent) => {
    expect(await callGate(agent)).toBeUndefined();
    agent.emit({});
    fixture.state.pending = true;
    fixture.planner.admitted();
    const stopped = await callGate(agent);
    expect(stopped?.stop).toBe(true);
    gated(agent, stopped?.reason);
  });
  await fixture.planner.start(1);
  const finished = fixture.event("scheduler.turn_finished");
  fixture.planner.wake("preflight_ready");
  await finished;
  expect(fixture.run).toMatchObject({ status: "running" });
  expect(fixture.run.usage.calls).toBe(1);
  expect(fixture.state.prompts).toBe(1);
  expect(fixture.state.pending).toBe(true);
  expect(fixture.run.usage.by_purpose.planning.calls).toBe(1);
  expect(fixture.state.pauses).toEqual([]);
});
