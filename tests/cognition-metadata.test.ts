import { afterEach, expect, test } from "bun:test";
import type { Json } from "../src/shared/contracts.ts";
import { CognitionMetadataOwner } from "../src/server/cognition-metadata.ts";
import type { CognitionResponseIdentity, StrategicSpeculation } from "../src/server/cognition-ports.ts";
import type { CognitionMetadata } from "../src/server/cognition-protocol.ts";
import { COGNITION_LIMITS } from "../src/server/cognition-wire.ts";
import { recordCall, recordUsage } from "../src/server/usage.ts";
import { historyFixture, type HistoryFixture } from "./helpers/history-fixture.ts";

const fixtures: HistoryFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function fixture(overrides: Partial<ConstructorParameters<typeof CognitionMetadataOwner>[2]> = {}) {
  const f = historyFixture();
  fixtures.push(f);
  const current = { value: true };
  const responses: CognitionResponseIdentity[] = [];
  const summaries: (string | undefined)[] = [];
  const owner = new CognitionMetadataOwner(f.store, f.run, {
    current: () => current.value,
    persist: summary => { summaries.push(summary); f.store.saveRun(f.run, summary); },
    response: response => { responses.push(response); },
    ...overrides,
  });
  return { ...f, owner, current, responses, summaries };
}
const call = (request_id = "request-1"): CognitionMetadata => ({ kind: "call", request_id, purpose: "planning" });
const reported = { input: 17, cacheRead: 23, cacheWrite: 5, output: 11 };
const usage = (request_id = "request-1"): CognitionMetadata => ({ kind: "usage", request_id, purpose: "planning", usage: reported });

test("an applied batch synchronously orders actual response metadata, classification, complete usage and durable events", () => {
  const f = fixture();
  const response = { request_id: "request-1", successful: true,
    calls: [{ id: "tool-1", name: "fixture_tool", arguments: { nested: [null, false, { value: 7 }] } }] };
  const observed: string[] = [];
  const unsubscribe = f.store.subscribe(event => {
    if (event.type === "fixture.usage") {
      expect(f.run.usage).toMatchObject({ uncached_input: 17, cache_read: 23, cache_write: 5, output: 11 });
      observed.push("usage-event");
    }
  });
  const owner = new CognitionMetadataOwner(f.store, f.run, {
    current: () => true,
    persist: summary => f.store.saveRun(f.run, summary),
    response: value => {
      expect(value).toEqual(response);
      expect(f.run.turns).toBe(1);
      expect(f.run.usage.by_purpose.planning.calls).toBe(1);
      expect(f.run.usage.output).toBeNull();
      expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "fixture.started")).toBe(true);
      observed.push("response");
    },
  });
  const operations: CognitionMetadata[] = [call(),
    { kind: "event", run_id: f.run.run_id, type: "fixture.started", summary: "Started", details: { request_id: "request-1" } },
    { kind: "response", response },
    { kind: "classify", request_id: "request-1", previous: "planning", purpose: "improvement" },
    { kind: "usage", request_id: "request-1", purpose: "improvement", usage: reported },
    { kind: "event", run_id: f.run.run_id, type: "fixture.usage", summary: "Reported subtotal", details: { reported: true } },
    { kind: "progress", model_status: "waiting", summary: "Waiting" }];
  expect(owner.apply({ sequence: 1, operations })).toBeUndefined();
  unsubscribe();
  expect(observed).toEqual(["response", "usage-event"]);
  expect(f.run.usage).toMatchObject({ calls: 1, uncached_input: 17, cache_read: 23, cache_write: 5, output: 11,
    accounting_basis: "sdk_reported_subtotal", known_cost: null,
    by_purpose: { planning: { calls: 0, uncached_input: null, cache_read: null, cache_write: null, output: null },
      improvement: { calls: 1, uncached_input: 17, cache_read: 23, cache_write: 5, output: 11 } } });
  expect(f.store.getRun(f.run.run_id)).toEqual(f.run);
  expect(f.run.model_status).toBe("waiting");
  const events = f.store.eventsAfter(f.run.run_id, 0, 100);
  expect(events.filter(event => event.type.startsWith("fixture.")).map(event => event.type)).toEqual(["fixture.started", "fixture.usage"]);
  expect(events.every((event, index) => index === 0 || event.event_seq > events[index - 1]!.event_seq)).toBe(true);
});

test("late usage adds to concurrent host accounting without replacing usage, lifecycle or scope", () => {
  const f = fixture();
  f.owner.apply({ sequence: 1, operations: [call()] });
  const canonicalUsage = f.run.usage;
  const planning = canonicalUsage.by_purpose.planning;
  recordCall(canonicalUsage, "improvement");
  recordUsage(canonicalUsage, "improvement", { input: 101, cacheRead: 29, cacheWrite: 13, output: 31 });
  f.run.turns++;
  f.run.status = "stopped";
  f.run.model_status = "idle";
  f.run.life_id = 92;
  f.run.space_epoch = 41;
  f.run.ended_at = "2026-11-14T12:00:00.000Z";
  f.run.error = "Host lifecycle state";
  f.run.baseline = { host: "retained" };
  f.current.value = false;
  f.store.saveRun(f.run);
  f.owner.apply({ sequence: 2, operations: [
    { kind: "progress", model_status: "thinking", summary: "Stale worker status" },
    usage(),
  ] });
  expect(f.run.usage).toBe(canonicalUsage);
  expect(f.run.usage.by_purpose.planning).toBe(planning);
  expect(f.run).toMatchObject({ turns: 2, status: "stopped", model_status: "idle", life_id: 92,
    space_epoch: 41, ended_at: "2026-11-14T12:00:00.000Z", error: "Host lifecycle state", baseline: { host: "retained" },
    usage: { calls: 2, uncached_input: 118, cache_read: 52, cache_write: 18, output: 42,
      by_purpose: { planning: { calls: 1, uncached_input: 17, output: 11 },
        improvement: { calls: 1, uncached_input: 101, output: 31 } } } });
  expect(f.store.getRun(f.run.run_id)).toEqual(f.run);
  expect(f.summaries).not.toContain("Stale worker status");
});

test("progress is admitted only for the current running or reviewing run", () => {
  const f = fixture();
  let sequence = 1;
  for (const status of ["created", "pausing", "paused", "stopping", "stopped", "completed", "failed"] as const) {
    f.run.status = status;
    f.owner.apply({ sequence: sequence++, operations: [{ kind: "progress", model_status: "thinking", summary: "Not active" }] });
    expect(f.run.model_status).toBe("idle");
  }
  for (const status of ["running", "reviewing"] as const) {
    f.run.status = status;
    f.owner.apply({ sequence: sequence++, operations: [{ kind: "progress", model_status: "waiting", summary: "Active" }] });
    expect(f.run.model_status).toBe("waiting");
    f.run.model_status = "idle";
  }
  f.current.value = false;
  f.owner.apply({ sequence, operations: [{ kind: "progress", model_status: "error", summary: "Not current" }] });
  expect(f.run.model_status).toBe("idle");
  expect(f.summaries).toEqual(["Active", "Active"]);
});

test("unknown and unsettled provider evidence is retained without inferred usage totals", () => {
  const f = fixture();
  const evidence: Json = { request_id: "request-1", usage_reported: false,
    usage_evidence: { consumption_coverage: "unknown", sdk_reported: null, wire_attempts: null } };
  f.owner.apply({ sequence: 1, operations: [
    call(),
    { kind: "event", run_id: f.run.run_id, type: "model.request_unsettled", summary: "Unknown provider consumption", details: evidence },
    { kind: "usage", request_id: "request-1", purpose: "planning",
      usage: { input: null, cacheRead: null, cacheWrite: null, output: null } },
  ] });
  expect(f.run.usage).toMatchObject({ calls: 1, uncached_input: null, cache_read: null, cache_write: null,
    output: null, known_cost: null, accounting_basis: "sdk_reported_subtotal",
    by_purpose: { planning: { calls: 1, uncached_input: null, cache_read: null, cache_write: null, output: null } } });
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).find(event => event.type === "model.request_unsettled")?.details).toEqual(evidence);
});

test("classification preserves populated and legacy buckets without moving reported subtotals", () => {
  const f = fixture();
  f.run.usage.by_purpose.improvement = { calls: null, uncached_input: null, cache_read: null,
    cache_write: null, output: null, legacy_input: 43, known_cost: null };
  recordCall(f.run.usage, "planning");
  recordUsage(f.run.usage, "planning", { input: 100, cacheRead: 30, cacheWrite: 0, output: 20 });
  f.owner.apply({ sequence: 1, operations: [
    call(),
    { kind: "classify", request_id: "request-1", previous: "planning", purpose: "improvement" },
    { kind: "usage", request_id: "request-1", purpose: "improvement", usage: reported },
  ] });
  expect(f.run.usage).toMatchObject({ calls: 2, uncached_input: 117, cache_read: 53, cache_write: 5, output: 31,
    by_purpose: { planning: { calls: 1, uncached_input: 100, cache_read: 30, cache_write: 0, output: 20 },
      improvement: { calls: null, uncached_input: null, cache_read: null, cache_write: null, output: null, legacy_input: 43 } } });
});

test("duplicate, skipped and regressing sequences fail before any writes", () => {
  const f = fixture();
  const event = { kind: "event", run_id: f.run.run_id, type: "fixture.rejected", summary: "Must not be written", details: null };
  for (const sequence of [0, 2, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => f.owner.apply({ sequence, operations: [event] })).toThrow();
  }
  f.owner.apply({ sequence: 1, operations: [call()] });
  for (const sequence of [1, 0, 3]) {
    expect(() => f.owner.apply({ sequence, operations: [event] })).toThrow();
  }
  expect(f.run.turns).toBe(1);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "fixture.rejected")).toBe(false);
  f.owner.apply({ sequence: 2, operations: [usage()] });
  expect(f.run.usage.output).toBe(11);
});

test("unknown, mismatched and duplicate accounting operations reject the entire batch", () => {
  const f = fixture();
  const rejected: CognitionMetadata[][] = [
    [usage("unknown")],
    [{ kind: "classify", request_id: "unknown", previous: "planning", purpose: "authoring" }],
    [call(), call()],
    [call(), { kind: "classify", request_id: "request-1", previous: "authoring", purpose: "improvement" }],
    [call(), { kind: "usage", request_id: "request-1", purpose: "authoring", usage: reported }],
    [call(), usage(), usage()],
    [call(), usage(), { kind: "classify", request_id: "request-1", previous: "planning", purpose: "improvement" }],
    [call(), { kind: "classify", request_id: "request-1", previous: "planning", purpose: "planning" }],
    [call(), { kind: "classify", request_id: "request-1", previous: "planning", purpose: "improvement" },
      { kind: "classify", request_id: "request-1", previous: "improvement", purpose: "authoring" }],
  ];
  for (const operations of rejected) {
    expect(() => f.owner.apply({ sequence: 1, operations: [
      { kind: "event", run_id: f.run.run_id, type: "fixture.rejected", summary: "Invalid batch", details: null }, ...operations,
    ] })).toThrow();
    expect(f.run.turns).toBe(0);
    expect(f.run.usage.calls).toBe(0);
  }
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(event => event.type === "fixture.rejected")).toBe(false);
  f.owner.apply({ sequence: 1, operations: [call(), usage()] });
  expect(() => f.owner.apply({ sequence: 2, operations: [call()] })).toThrow();
  expect(() => f.owner.apply({ sequence: 2, operations: [usage()] })).toThrow();
  expect(f.run.turns).toBe(1);
  expect(f.run.usage.output).toBe(11);
});

test("malformed, oversized and foreign-run batches fail closed", () => {
  const f = fixture();
  const event = { kind: "event", run_id: f.run.run_id, type: "fixture.event", summary: "Bounded event", details: null };
  const invalid: unknown[] = [
    null,
    { sequence: 1, operations: [event], run: f.run },
    { sequence: 1, operations: [{ ...event, run_id: "foreign-run" }] },
    { sequence: 1, operations: [{ kind: "progress", model_status: "thinking", lifecycle: "running" }] },
    { sequence: 1, operations: [{ ...event, summary: "x".repeat(8193) }] },
    { sequence: 1, operations: Array.from({ length: COGNITION_LIMITS.metadata + 1 }, () => event) },
    { sequence: 1, operations: [{ ...event, details: "x".repeat(COGNITION_LIMITS.metadataBytes) }] },
    { sequence: 1, operations: [call(), { ...usage(), usage: { ...reported, input: -1 } }] },
    { sequence: 1, operations: [call(), { ...usage(), usage: { ...reported, output: Number.POSITIVE_INFINITY } }] },
  ];
  for (const batch of invalid) expect(() => f.owner.apply(batch)).toThrow();
  expect(f.run.turns).toBe(0);
  expect(f.store.eventsAfter(f.run.run_id, 0, 100).some(value => value.type === "fixture.event")).toBe(false);
  f.owner.apply({ sequence: 1, operations: [{ ...event, run_id: null }] });
  expect(f.store.eventsAfter(null, 0, 100).find(value => value.type === "fixture.event")?.run_id).toBeNull();
});

test("response identities must name a real call and can authorize actual call metadata only once", () => {
  const f = fixture();
  const response = { request_id: "request-1", successful: true,
    calls: [{ id: "actual-tool", name: "fixture_tool", arguments: { value: null } }] };
  expect(() => f.owner.apply({ sequence: 1, operations: [{ kind: "response", response }] })).toThrow();
  expect(() => f.owner.apply({ sequence: 1, operations: [call(),
    { kind: "response", response: { ...response, calls: [...response.calls, ...response.calls] } }] })).toThrow();
  expect(() => f.owner.apply({ sequence: 1, operations: [call(),
    { kind: "response", response: { ...response, successful: false } }] })).toThrow();
  f.owner.apply({ sequence: 1, operations: [call(), { kind: "response", response }] });
  expect(f.responses).toEqual([response]);
  expect(() => f.owner.apply({ sequence: 2, operations: [{ kind: "response", response }] })).toThrow();
  expect(f.responses).toEqual([response]);
});

test("request reservation and closure delegate synchronously in batch order", () => {
  const observed: string[] = [];
  const model = { id: "offline-model", provider: "offline-provider", api: "offline-api" };
  const f = fixture({ requestAdmission: {
    reserve: (id, value) => { expect(id).toBe("request-1"); expect(value).toEqual(model); observed.push("reserve"); },
    transportEnded: (id, closed) => { expect(id).toBe("request-1"); expect(closed).toBe(false); observed.push("transport-ended"); },
    drained: ids => { expect(ids).toEqual(["request-1"]); observed.push("drained"); },
  }, response: () => { observed.push("response"); } });
  f.owner.apply({ sequence: 1, operations: [
    { kind: "request_reserve", request_id: "request-1", model }, call(),
    { kind: "response", response: { request_id: "request-1", successful: false, calls: [] } },
    { kind: "transport_ended", request_id: "request-1", closed: false },
    { kind: "requests_drained", request_ids: ["request-1"] },
  ] });
  expect(observed).toEqual(["reserve", "response", "transport-ended", "drained"]);
  for (const operation of [
    { kind: "request_reserve", request_id: "request-1", model },
    { kind: "transport_ended", request_id: "unknown", closed: true },
    { kind: "requests_drained", request_ids: ["unknown"] },
    { kind: "requests_drained", request_ids: ["request-1"] },
  ]) expect(() => f.owner.apply({ sequence: 2, operations: [operation] })).toThrow();
});

test("a refused request reservation prevents subsequent call accounting and latches failure against replay", () => {
  const f = fixture({ requestAdmission: {
    reserve: () => { throw new Error("Reservation refused"); },
    transportEnded: () => { throw new Error("Unexpected transport closure"); },
    drained: () => { throw new Error("Unexpected drain"); },
  } });
  const batch = { sequence: 1, operations: [
    { kind: "request_reserve", request_id: "request-1", model: { id: "offline", provider: "offline", api: "offline" } }, call(),
  ] };
  expect(() => f.owner.apply(batch)).toThrow("Reservation refused");
  expect(f.run.turns).toBe(0);
  expect(f.run.usage.calls).toBe(0);
  expect(() => f.owner.apply({ sequence: 1, operations: [call()] })).toThrow();
});

test("the finite session request-identity budget includes reserved but never dispatched requests", () => {
  const f = fixture();
  let sequence = 1;
  for (let offset = 0; offset < 4096; offset += COGNITION_LIMITS.metadata) {
    f.owner.apply({ sequence: sequence++, operations: Array.from({ length: COGNITION_LIMITS.metadata }, (_, index) => ({
      kind: "request_reserve", request_id: `reserved-${offset + index}`,
      model: { id: "offline", provider: "offline", api: "offline" },
    })) });
  }
  expect(() => f.owner.apply({ sequence, operations: [call("overflow")] })).toThrow();
  // Existing identities still settle and retained IDs are never evicted for reuse.
  f.owner.apply({ sequence: sequence++, operations: [call("reserved-0"), usage("reserved-0"),
    { kind: "requests_drained", request_ids: ["reserved-0"] }] });
  expect(f.run.turns).toBe(1);
  expect(() => f.owner.apply({ sequence, operations: [call("overflow")] })).toThrow();
  expect(() => f.owner.apply({ sequence, operations: [call("reserved-0")] })).toThrow();
});

test("speculation finish and invalidation reach their real owner without inferred state changes", () => {
  const observed: string[] = [];
  const speculation: StrategicSpeculation = {
    projection: () => null, remainingMs: () => 0, pendingActivation: async () => null,
    begin: () => null, requestCall: () => false,
    finish: id => { observed.push(`finish:${id}`); },
    invalidate: reason => { observed.push(`invalidate:${reason}`); },
    assertToolAuthority: () => { throw new Error("No test authority"); },
    authority: () => () => { throw new Error("No test authority"); },
  };
  const f = fixture({ speculation });
  f.owner.apply({ sequence: 1, operations: [
    { kind: "speculation_finish", id: "actual-plan" }, { kind: "speculation_invalidate", reason: "deadline" },
  ] });
  expect(observed).toEqual(["finish:actual-plan", "invalidate:deadline"]);
  const absent = fixture();
  expect(() => absent.owner.apply({ sequence: 1, operations: [{ kind: "speculation_finish", id: "unowned-plan" }] })).toThrow();
  expect(() => absent.owner.apply({ sequence: 1, operations: [{ kind: "speculation_invalidate", reason: "cancelled" }] })).toThrow();
});
