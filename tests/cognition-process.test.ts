import { afterEach, expect, test, vi } from "bun:test";
import { z } from "zod";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { Json } from "../src/shared/contracts.ts";
import { RuntimeFault } from "../src/server/runtime-fault.ts";
import { StrategicPlanner } from "../src/server/strategic.ts";
import { InlineCognitionContext } from "../src/server/cognition-context.ts";
import * as monotonicClock from "../src/server/os-monotonic.ts";
import { deferred, eventLoopTurn, passiveHostFixture, processFixture, retainFiniteExecutive, type ProcessFixture } from "./helpers/cognition-process.fixture.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(scenario = "passive") {
  const f = processFixture(scenario); cleanup.push(() => f.close()); return f;
}
function assertOwnedClosed(f: ProcessFixture) {
  expect(f.processes).toHaveLength(1);
  expect(f.receipts).toHaveLength(1);
  const child = f.processes[0]!;
  expect(child.pid).toBeDefined(); expect(child.pid).not.toBe(process.pid);
  // ChildProcess 'close', unlike 'exit' or kill(), is the process AND stdio receipt.
  expect(child.stdout?.readableEnded).toBe(true);
  expect(child.stdin?.destroyed).toBe(true);
  expect(f.owner.allocations).toBe(1);
}

// These are generic selected-session/process/wire ownership tests. They contain
// no gameplay source, real inference, action execution, sandbox or native driver.
for (const change of ["none", "root", "life"] as const) {
  test(`observation rejection records ${change} authority change without leaking native errors or retrying capture`, async () => {
    const f = fixture("observation"), entered = deferred(), release = deferred();
    await retainFiniteExecutive(f);
    const root = vi.spyOn(f.store, "latestRootExecution").mockImplementation(() => f.state.root);
    cleanup.push(() => root.mockRestore());
    let captures = 0;
    f.host.modelObservation = async () => {
      captures++; entered.resolve(); await release.promise;
      throw new RuntimeFault("stale_context", "SECRET_NATIVE_OBSERVATION_FAILURE");
    };
    cleanup.push(() => release.resolve());
    await f.client.start(1);
    f.client.wake("observation"); await entered.promise;
    const originalTurn = f.client.snapshot().turn_id;
    if (change === "root") f.state.root = { ...f.state.root!, execution_id: "replacement-metadata-root" };
    if (change === "life") f.run.life_id = (f.run.life_id ?? 0) + 1;
    release.resolve();
    expect(await f.marker("observation_rejected")).toEqual({ message: "Cognition transport unavailable" });
    const events = f.store.eventsAfter(f.run.run_id, 0, 100);
    expect(events.find(event => event.type === "cognition.model_observation_rejected")?.details).toEqual({
      reason: "stale_context", turn_id: originalTurn, request_id: null,
      run_replaced: false, generation_changed: false, phase_changed: false,
      run_scope_changed: change === "life", root_changed: change === "root",
      native_guard: "not_reported", provider_request_made: false, capture_retried: false,
    });
    expect(JSON.stringify(events)).not.toContain("SECRET_NATIVE_OBSERVATION_FAILURE");
    expect(events.some(event => event.type === "model.call" ||
      event.type === "fixture.cognition" && event.summary === "observation_returned")).toBe(false);
    expect(captures).toBe(1);
    expect(f.owner.resolutions).toBe(0);
    expect(f.pauses).toEqual([]);
    await f.client.close(); assertOwnedClosed(f);
  }, 10_000);
}

test("ordinary start owns a distinct real process and graceful close joins both ordinary pipes", async () => {
  const f = fixture(); await f.client.start(1);
  expect(f.processes[0]!.pid).not.toBe(process.pid);
  f.client.wake("round_trip"); await f.marker("round_trip");
  expect(f.pauses).toEqual([]);
  await f.client.close();
  assertOwnedClosed(f);
  expect(f.receipts[0]).toEqual({ code: 0, signal: null });
  expect(f.owner.session.signal.aborted).toBe(true);
  await f.owner.drained.promise;
  expect(f.owner.resolutions).toBe(0);
  expect(f.run.turns).toBe(0);
  f.client.reset();
}, 10_000);

test("actual child death pauses the default client without model retry, process restart or embedded fallback", async () => {
  const f = fixture(); await f.client.start(1);
  f.client.wake("die");
  await f.closures[0];
  expect(f.receipts[0]).toEqual({ code: 23, signal: null });
  expect(f.pauses).toHaveLength(1);
  expect(f.pauses[0]!.cause).toBe("provider_failure");
  f.client.wake("must_not_restart"); f.client.admitted();
  await eventLoopTurn();
  expect(f.processes).toHaveLength(1); expect(f.owner.allocations).toBe(1);
  expect(f.owner.resolutions).toBe(0); expect(f.run.turns).toBe(0);
  await f.client.close(); assertOwnedClosed(f);
  expect(f.pauses).toHaveLength(1);
}, 10_000);

test("host turn watchdog contains a pipe-stalled child after cancellation-only drain and does not retry or fallback", async () => {
  const f = fixture("deadline"); await f.client.start(1);
  await f.marker("stall_entering");
  await f.closures[0];
  expect(f.receipts[0]!.signal).toBe("SIGKILL");
  expect(f.pauses).toHaveLength(1); expect(f.pauses[0]!.cause).toBe("deadline");
  f.client.wake("must_not_restart"); await eventLoopTurn();
  expect(f.owner.resolutions).toBe(0); expect(f.run.turns).toBe(0);
  await f.client.close(); assertOwnedClosed(f);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "scheduler.turn_deferred")).toBe(false);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).find(event => event.type === "cognition.contained")?.details)
    .toMatchObject({ reason: "turn_deadline", available: false, automatic_restart: false, closure_confirmed: false });
}, 10_000);

test("an eligible retained executive does not conceal a force-killed cognition owner as idle", async () => {
  const f = fixture("deadline"), root = await retainFiniteExecutive(f);
  const originalDeadline = root.deadline_at;
  await f.client.start(1); await f.marker("stall_entering"); await f.closures[0];
  await f.client.close(); await f.owner.drained.promise;
  expect(f.pauses.map(pause => pause.cause)).toEqual(["deadline"]);
  expect(f.run.model_status).toBe("error");
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "scheduler.turn_deferred")).toBe(false);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.deadline_at).toBe(originalDeadline);
  f.client.wake("resident_attention"); await eventLoopTurn();
  expect(f.processes).toHaveLength(1); expect(f.owner.allocations).toBe(1);
  expect(() => f.client.speculativeToolAuthority()).toThrow();
  assertOwnedClosed(f);
}, 10_000);

test("cooperative deadline settlement defers once, rejects expired tools and permits a later ordinary finite decision", async () => {
  const f = fixture("cooperative"), root = await retainFiniteExecutive(f);
  const originalDeadline = root.deadline_at;
  let commits = 0;
  f.tools.push({ name: "help", label: "help", description: "Generic bounded host decision",
    parameters: z.toJSONSchema(z.object({ value: z.number() }).strict()),
    execute: async () => { f.client.speculativeToolAuthority()(); commits++; return { content: [], details: {} }; },
  });
  await f.client.start(1);
  f.client.wake("preflight_ready"); await f.marker("cooperative_waiting");
  await f.marker("expired_tool_rejected"); await f.marker("cancellation_settled");
  expect(commits).toBe(0); expect(f.receipts).toEqual([]); expect(f.pauses).toEqual([]);
  expect(f.owner.session.signal.aborted).toBe(false);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).filter(event => event.type === "scheduler.turn_deferred")).toHaveLength(1);
  expect(f.run.model_status).toBe("idle"); expect(f.run.turns).toBe(1);
  f.client.wake("resident_attention"); await f.marker("tool_returned");
  expect(commits).toBe(1); expect(f.run.turns).toBe(2);
  expect(f.pauses).toEqual([]); expect(f.processes).toHaveLength(1); expect(f.owner.allocations).toBe(1);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.deadline_at).toBe(originalDeadline);
  await f.client.close(); assertOwnedClosed(f);
}, 10_000);

test("the real SDK planner cooperatively settles one expired decision and plans again only on a new ordinary signal", async () => {
  const f = passiveHostFixture(), root = await retainFiniteExecutive(f);
  const originalRootDeadline = root.deadline_at;
  const settled = deferred(), finished = deferred();
  const unsubscribe = f.store.subscribe(event => {
    if (event.type === "scheduler.turn_deferred") settled.resolve();
    if (event.type === "scheduler.turn_finished") finished.resolve();
  });
  let streams = 0, allocations = 0, canceled = 0, turnId = "";
  const finiteTurns: bigint[] = [];
  let planner: StrategicPlanner;
  const agent = new Agent({ initialState: { model: f.owner.model }, getApiKey: () => "OFFLINE_INFRASTRUCTURE_ONLY",
    streamFn: (model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      const complete = (stopReason: "stop" | "aborted") => {
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [], stopReason, timestamp: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0,
            output: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (stopReason === "aborted") stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: "stop", message });
        stream.end();
      };
      if (++streams === 1) {
        options?.signal?.addEventListener("abort", () => { canceled++; complete("aborted"); }, { once: true });
        planner.cancelTurn(turnId);
        expect(options?.signal?.aborted).toBe(false);
        // Explicitly advance this fixture's wall/monotonic turn boundary, not
        // real process or native budgets. The ordinary SDK cancellation and
        // subsequent StrategicPlanner classification/serialization stay real.
        const deadline = Reflect.get(planner, "turnDeadline") as number;
        vi.spyOn(Date, "now").mockReturnValue(deadline);
        vi.spyOn(monotonicClock, "osMonotonicNs").mockReturnValue(finiteTurns[0]!);
        queueMicrotask(() => planner.cancelTurn(turnId));
      } else complete("stop");
      return stream;
    },
  });
  planner = new StrategicPlanner(f.store, {
    createAgent: async options => {
      allocations++; agent.setSystemPrompt(options.systemPrompt); agent.setTools(options.tools); return agent;
    },
    releaseAgent: async owned => { owned.abort(); await owned.waitForIdle(); },
  }, f.host, { context: new InlineCognitionContext(f.store.readLocation()), ownership: {
    beginTurn: async (id, deadline) => { turnId = id; finiteTurns.push(deadline); },
  } });
  cleanup.push(async () => { vi.restoreAllMocks(); await planner.close(); unsubscribe(); f.close(); });
  await planner.start(1);
  planner.wake("preflight_ready"); await settled.promise;
  expect(canceled).toBe(1); expect(streams).toBe(1); expect(allocations).toBe(1);
  expect(f.pauses).toEqual([]); expect(f.run.model_status).toBe("idle");
  expect(f.store.eventsAfter(f.run.run_id, 0, 200).filter(event => event.type === "scheduler.turn_deferred")).toHaveLength(1);
  expect(Reflect.get(planner, "contextCursor")).toBe(0);
  await eventLoopTurn(); expect(streams).toBe(1);
  planner.cancelTurn("obsolete-turn");
  planner.wake("resident_attention"); await finished.promise;
  expect(streams).toBe(2); expect(allocations).toBe(1); expect(canceled).toBe(1);
  expect(finiteTurns).toHaveLength(2); expect(finiteTurns[1]! > finiteTurns[0]!).toBe(true);
  expect(f.pauses).toEqual([]);
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.deadline_at).toBe(originalRootDeadline);
}, 10_000);

test("backpressured delivery failure joins actual child/pipes and account drain without erasing unknown consumption", async () => {
  const f = fixture("backpressure"); f.holdObservation();
  const observe = f.host.observe;
  f.host.observe = async () => ({ ...await observe(), padding: "x".repeat(2 * 1024 * 1024) });
  const requests: string[][] = [];
  f.host.requestAdmission = { reserve: () => {}, transportEnded: () => {}, drained: ids => requests.push([...ids]) };
  await f.client.start(1); await f.marker("backpressure_paused"); await f.observeEntered.promise;
  const backpressured = deferred();
  const input = f.processes[0]!.stdin!, originalWrite = input.write;
  input.write = new Proxy(originalWrite, { apply(target, owner, args) {
    const accepted = Reflect.apply(target, owner, args);
    // Bun's real pipe can return false while writableLength remains zero.
    // Observe its actual backpressure contract without replacing the I/O.
    if (accepted === false) backpressured.resolve();
    return accepted;
  } });
  cleanup.push(() => { input.write = originalWrite; });
  f.observeRelease.resolve();
  // The child has explicitly stopped reading stdin, so a pipe-sized response
  // cannot drain until the actual OS process/pipes close.
  await backpressured.promise;
  f.processes[0]!.kill("SIGKILL");
  await f.closures[0]; await f.client.close(); await f.owner.drained.promise;
  assertOwnedClosed(f);
  expect(requests).toEqual([["unknown-delivery"]]);
  expect(f.pauses.map(pause => pause.cause)).toEqual(["provider_failure"]);
  expect(f.run.turns).toBe(1);
  const unsettled = f.store.eventsAfter(f.run.run_id, 0, 100).find(event => event.type === "model.request_unsettled");
  expect(unsettled?.details).toMatchObject({ request_id: "unknown-delivery", cognition_process_closed: true,
    usage_reported: false, provider_attempt_count: null });
  f.client.reset();
}, 10_000);

test("context watchdog allows only post-deadline cancellation settlement, not a process restart", async () => {
  const f = fixture("context_cooperative");
  await f.client.start(1); f.client.wake("context");
  await f.marker("context_entered"); await f.marker("context_settled");
  expect(f.pauses).toEqual([]); expect(f.receipts).toEqual([]);
  f.client.wake("after_context"); await f.marker("after_context");
  expect(f.owner.allocations).toBe(1); expect(f.processes).toHaveLength(1);
  await f.client.close(); assertOwnedClosed(f);
}, 10_000);

test("a context CPU stall is contained only after its finite cancellation settlement window", async () => {
  const f = fixture("context_stall");
  await f.client.start(1); f.client.wake("context");
  await f.marker("context_entered"); await f.closures[0]; await f.client.close();
  expect(f.pauses.map(pause => pause.cause)).toEqual(["preparation_failed"]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).find(event => event.type === "cognition.contained")?.details)
    .toMatchObject({ reason: "context_deadline", available: false, automatic_retry: false });
  expect(f.processes).toHaveLength(1); assertOwnedClosed(f);
}, 10_000);

test("an authoring response cannot clear the watchdog before SDK and serialized-turn settlement", async () => {
  const f = fixture("authoring_stall"), root = await retainFiniteExecutive(f);
  const originalDeadline = root.deadline_at;
  await f.client.start(1); f.client.wake("authoring");
  await f.marker("authoring_response_then_stall"); await f.closures[0]; await f.client.close();
  expect(f.pauses.map(pause => pause.cause)).toEqual(["deadline"]);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).find(event => event.type === "cognition.contained")?.details)
    .toMatchObject({ reason: "authoring_deadline", available: false, automatic_retry: false });
  expect(f.store.skillExecution(f.run.run_id, { execution_id: root.execution_id })?.deadline_at).toBe(originalDeadline);
  expect(f.processes).toHaveLength(1); assertOwnedClosed(f);
}, 10_000);

test("fence synchronously revokes a captured physical-host commit while the child cannot read its pipes", async () => {
  const f = fixture("tool");
  const entered = deferred(), release = deferred(), completed = deferred();
  cleanup.push(() => release.resolve());
  let commit: (() => void) | null = null;
  let commits = 0;
  f.tools.push({ name: "help", label: "help", description: "Passive host commit barrier",
    parameters: z.toJSONSchema(z.object({ value: z.number() }).strict()),
    execute: async (_id, raw) => {
      if (raw === null || typeof raw !== "object") throw new Error("Expected an unchanged object argument");
      expect(Object.hasOwn(raw, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(raw, "__proto__")!.value).toEqual({ fixture_owned: true });
      commit = f.client.speculativeToolAuthority(); entered.resolve();
      try { await release.promise; commit(); commits++; return { content: [], details: {} }; }
      finally { completed.resolve(); }
    },
  });
  await f.client.start(1); await entered.promise;
  f.client.wake("stall"); await f.marker("stall_entering");
  f.client.fence();
  expect(f.owner.session.signal.aborted).toBe(true);
  expect(commit).not.toBeNull(); expect(() => commit!()).toThrow();
  let closed = false;
  const closing = f.client.close().then(() => { closed = true; });
  await f.closures[0];
  expect(f.receipts[0]!.signal).toBe("SIGKILL");
  await eventLoopTurn();
  // A killed child is not a receipt for a still-running host tool handler.
  expect(closed).toBe(false); expect(commits).toBe(0);
  release.resolve(); await completed.promise; await closing;
  expect(commits).toBe(0); expect(f.pauses).toEqual([]); assertOwnedClosed(f);
}, 10_000);

for (const change of ["scope", "generation", "phase"] as const) {
  test(`the real tool RPC rechecks changed host ${change} after an asynchronous barrier`, async () => {
    const f = fixture("tool"), entered = deferred(), release = deferred();
    cleanup.push(() => release.resolve());
    let commits = 0;
    f.tools.push({ name: "help", label: "help", description: "Passive delayed commit",
      parameters: z.toJSONSchema(z.object({ value: z.number() }).strict()),
      execute: async () => {
        const commit = f.client.speculativeToolAuthority(); entered.resolve();
        await release.promise; commit(); commits++; return { content: [], details: {} };
      },
    });
    await f.client.start(1); await entered.promise;
    if (change === "scope") f.run.life_id = (f.run.life_id ?? 0) + 1;
    else if (change === "generation") f.state.generation++;
    else f.run.status = "paused";
    release.resolve(); await f.marker("tool_rejected");
    expect(commits).toBe(0);
    await f.client.close(); assertOwnedClosed(f);
  }, 10_000);
}

test("real JSON RPC preserves own __proto__ and invalid null/types for strict raw host validation", async () => {
  const f = fixture("raw");
  const received: unknown[] = [];
  let accepted = 0;
  const schema = z.object({ value: z.number() }).strict();
  f.tools.push({ name: "help", label: "help", description: "Strict passive raw-input validator",
    parameters: z.toJSONSchema(schema), lenientArgValidation: true,
    execute: async (_id, raw) => {
      received.push(raw);
      if (raw !== null && typeof raw === "object" && Object.keys(raw).some(key => key !== "value"))
        throw new RuntimeFault("invalid_request", "Passive host rejected original own properties");
      const result = schema.safeParse(raw);
      if (!result.success) throw new RuntimeFault("invalid_request", "Passive host rejected original arguments");
      accepted++; return { content: [], details: {} };
    },
  });
  await f.client.start(1); await f.marker("raw_done");
  expect(received).toEqual([null, "7", 7, false, [], { value: "7" }, JSON.parse('{"__proto__":{"fixture_owned":true},"value":7}')]);
  expect(Object.hasOwn(received[6] as object, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(received[6], "__proto__")!.value).toEqual({ fixture_owned: true });
  expect(Object.hasOwn({}, "fixture_owned")).toBe(false);
  expect(accepted).toBe(0); expect(f.run.turns).toBe(7);
  await f.client.close(); assertOwnedClosed(f);
}, 10_000);

test("canceled startup rejects a late real-child start response and drains its selected-session owner", async () => {
  const f = fixture("late_start"); f.holdObservation();
  const opening = f.client.start(1);
  // Observe rejection immediately, even if the child fails before the barrier.
  const result = opening.then(() => ({ rejected: false }), () => ({ rejected: true }));
  await f.observeEntered.promise;
  expect(f.owner.consumer).not.toBeNull();
  f.owner.cancel();
  expect(f.owner.session.signal.aborted).toBe(true);
  expect(() => f.client.attentionAfter(1000, "late startup must not revive")).toThrow();
  f.observeRelease.resolve();
  expect(await result).toEqual({ rejected: true }); await f.owner.drained.promise;
  assertOwnedClosed(f);
  expect(f.pauses).toEqual([]); expect(f.owner.resolutions).toBe(0);
  f.client.reset();
}, 10_000);

test("startup cancellation joins actual process close AND a late host pipe handler before claiming drain", async () => {
  const f = fixture("late_start"); f.holdObservation();
  const opening = f.client.start(1);
  const result = opening.then(() => ({ rejected: false }), () => ({ rejected: true }));
  await f.observeEntered.promise;
  let closed = false;
  const closing = f.client.close().then(() => { closed = true; });
  await f.closures[0];
  await eventLoopTurn();
  expect(closed).toBe(false);
  expect(() => f.client.reset()).toThrow();
  f.observeRelease.resolve();
  expect(await result).toEqual({ rejected: true }); await closing; await f.owner.drained.promise;
  assertOwnedClosed(f); expect(f.pauses).toEqual([]);
  f.client.reset();
}, 10_000);

test("child close and canceled key wait do not falsely drain an uncanceled selected-session refresh commit", async () => {
  const f = fixture("refresh");
  const reserved: string[] = [], requestDrains: string[][] = [];
  f.host.requestAdmission = {
    reserve: id => { reserved.push(id); },
    transportEnded: () => {},
    drained: ids => { requestDrains.push([...ids]); },
  };
  await f.client.start(1);
  await f.owner.refreshEntered.promise;
  expect(reserved).toEqual(["refresh-1"]);
  expect(f.owner.resolutions).toBe(1); expect(f.owner.leases.size).toBe(1);
  let closed = false, drained = false;
  void f.owner.drained.promise.then(() => { drained = true; });
  const closing = f.client.close().then(() => { closed = true; });
  await f.closures[0];
  await eventLoopTurn();
  expect(f.owner.session.signal.aborted).toBe(true);
  expect(closed).toBe(false); expect(drained).toBe(false);
  expect(requestDrains).toEqual([]);
  expect(f.owner.refreshCommitted).toBe(false);
  expect(() => f.client.reset()).toThrow();
  f.owner.refreshRelease.resolve();
  await closing; await f.owner.drained.promise;
  expect(f.owner.refreshCommitted).toBe(true); expect(f.owner.leases.size).toBe(0);
  expect(requestDrains).toEqual([["refresh-1"]]);
  expect(f.owner.resolutions).toBe(1); expect(f.pauses).toEqual([]); assertOwnedClosed(f);
  const events: Json[] = f.store.eventsAfter(f.run.run_id, 0, 100).map(event => event.details);
  expect(JSON.stringify(events)).not.toContain("offline-not-a-provider-credential");
  f.client.reset();
}, 10_000);
