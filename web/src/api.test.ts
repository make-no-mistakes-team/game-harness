import { expect, test } from "bun:test";
import type { AppSnapshot, ProgramEvidenceView, RunUsage } from "../../src/shared/contracts.ts";
import type { ObjectiveMetrics, ObjectiveMetricUpdate } from "../../src/shared/execution-evidence.ts";
import { PREPARED_START_LIMITS, type PreparedStartRequest, type PreparedStartView } from "../../src/shared/prepared-start.ts";
import { fetchImprovementFeedback, fetchSkillEvidence, type SkillEvidencePage } from "./api.ts";

test("measurement pages reject unsafe cursors, oversized records and invalid coverage", async () => {
  const measurement: ProgramEvidenceView = {
    execution_id: "execution-25",
    skill_id: "skill",
    version: 1,
    root_execution_id: "execution-25",
    status: "succeeded",
    duration_ms: null,
    actions: 2,
    calls: 3,
    strategic_requests: 1,
    confirmed_effects: 0,
    evidence_status: "unknown",
    verified_event_seqs: [],
    compactness: { fingerprint: "source", formatted_lines: 4, complexity: 1, nesting: 1 },
  };
  const next: SkillEvidencePage = {
    records: [measurement], next_after: 27, has_more: true, total: 100,
    projection: { generation: 1, source_through: 10, source_available: 10, has_pending: false },
    omissions: [{ index: 26, reason: "record_byte_budget", original_bytes: 65_000 }],
  };
  let response: unknown = next;
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  try {
    const requestCount = requests.length;
    for (const [after, limit] of [[-1, 25], [0.5, 25], [Number.MAX_SAFE_INTEGER + 1, 25], [0, 0], [0, 101], [0, 1.5]])
      await expect(fetchSkillEvidence("run/one", after, limit)).rejects.toThrow();
    expect(requests).toHaveLength(requestCount);

    for (const invalid of [
      { evidence: [measurement] },
      { ...next, next_after: Number.MAX_SAFE_INTEGER + 1 },
      { ...next, total: -1 },
      { ...next, omissions: [{ index: -1, reason: "record_byte_budget", original_bytes: 65_000 }] },
      { ...next, omissions: [{ index: 26, reason: "record_byte_budget", original_bytes: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...next, records: [measurement, measurement, measurement] },
      { ...next, records: [measurement, measurement] },
    ]) {
      response = invalid;
      await expect(fetchSkillEvidence("run/one", 25, 2)).rejects.toThrow();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

function metric(): ObjectiveMetrics {
  return {
    execution_id: "retained-execution", root_execution_id: "retained-execution", outcome: "unknown",
    confirmed_block_removals: 0, removed_blocks: {}, inventory_delta: { stone: 3 }, inventory_receipts: 1,
    target_switches: 0, target_position_switches: 0, sampled_travel_distance: 0, sampled_rotation_degrees: 0,
    receipted_travel_distance: 5, receipted_rotation_degrees: 0, motion_receipts: 1, observation_samples: 0,
    spans_ms: {}, span_samples: {}, evidence_event_seqs: [17], trace_complete: true, limitations: [],
  };
}

async function withApiResponse(body: (
  respond: (value: unknown, status?: number) => void,
  requests: { path: string; init: RequestInit | undefined }[],
) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let response: unknown;
  let status = 200;
  const requests: { path: string; init: RequestInit | undefined }[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ path: String(input), init });
    return new Response(JSON.stringify(response), {
      status, headers: { "Content-Type": "application/json" },
    });
  }, { preconnect: originalFetch.preconnect });
  try { await body((value, code = 200) => { response = value; status = code; }, requests); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("feedback cannot cross a bound scope, go backward, or assign one execution's replacement to another", async () => {
  await withApiResponse(async respond => {
    const scope = "a".repeat(64);
    const next = { schema_version: 2 as const, opportunity_change_seq: 1, metric_change_seq: 4, scope_hash: scope };
    const valid = {
      opportunities: [], metrics: [{ kind: "replace", execution_id: "retained-execution", revision: 8, generation: 2,
        program: { name: "Retained source", version: 1 }, execution_ordinal: 3, metric: metric() }],
      next_after: next, has_more: false, omitted: [],
      projection: { generation: 2, source_through: 30, source_available: 31, has_pending: true },
      opportunity_budget: { max_records: 32, reached: false, omission: "Presentation page only" },
      review: { effect_free: true, max_decisions: 4 },
    };
    respond(valid);
    const first = await fetchImprovementFeedback("run");
    for (const invalid of [
      { ...valid, next_after: { ...next, scope_hash: "b".repeat(64) } },
      { ...valid, next_after: { ...next, metric_change_seq: 3 } },
      { ...valid, has_more: true },
      { ...valid, metrics: [{ ...valid.metrics[0], execution_id: "another-execution" }] },
      { ...valid, projection: { ...valid.projection, source_available: 29 } },
      { ...valid, projection: { ...valid.projection, has_pending: false } },
    ]) {
      respond(invalid);
      await expect(fetchImprovementFeedback("run", first.next_after)).rejects.toThrow();
    }
    await expect(Reflect.apply(fetchImprovementFeedback, undefined,
      ["run", { opportunity_seq: 1, execution_seq: 4 }])).rejects.toThrow();
  });
});

test("feedback decodes explicit removals without fabricating an empty metric", async () => {
  await withApiResponse(async respond => {
    const retraction = { kind: "retract", execution_id: "removed-execution",
      program: { name: "Retained source", version: 1 }, execution_ordinal: 3,
      generation: 2, revision: 8, reason: "execution_removed" } satisfies ObjectiveMetricUpdate;
    const page = {
      opportunities: [], metrics: [retraction],
      next_after: { schema_version: 2, opportunity_change_seq: 0, metric_change_seq: 4, scope_hash: "a".repeat(64) },
      has_more: false, omitted: [],
      projection: { generation: 2, source_through: 30, source_available: 30, has_pending: false },
      opportunity_budget: { max_records: 32, reached: false, omission: "Presentation page only" },
      review: { effect_free: true, max_decisions: 4 },
    };
    respond(page);
    expect((await fetchImprovementFeedback("run")).metrics).toEqual([retraction]);
    for (const malformed of [
      { ...retraction, metric: null },
      { ...retraction, metric: metric() },
      { ...retraction, reason: "unknown" },
      { ...retraction, execution_ordinal: 0 },
      { ...retraction, kind: "replace" },
    ]) {
      respond({ ...page, metrics: [malformed] });
      await expect(fetchImprovementFeedback("run")).rejects.toThrow();
    }
  });
});

test("comparison continuation keeps both generation pins and rejects the old numeric offset", async () => {
  await withApiResponse(async respond => {
    // A separate real client module keeps this fixture's session out of other tests.
    const client: typeof import("./api.ts") = await import(new URL("./api.ts?comparison-cursor-fixture", import.meta.url).href);
    respond({ csrf_token: "fixture-local-session" });
    await client.openSession();
    const before = { run_id: "run-a", skill_id: "source", version: 1, hash: "1".repeat(64) };
    const after = { run_id: "run-b", skill_id: "source", version: 2, hash: "2".repeat(64) };
    const next = { schema_version: 2 as const, before_generation: 2, after_generation: 3, offset: 1, scope_hash: "a".repeat(64) };
    const valid = {
      comparison: {
        before, after, source_diff: { common_prefix_lines: 0, common_suffix_lines: 0, removed: [], added: [] },
        card_diff: {}, samples: { before: [metric()], after: [] }, sample_count: { before: 1, after: 1 },
        controlled_conditions: null, conclusion: "descriptive_only_no_causal_improvement_claim",
      },
      next_after: next, has_more: true, omissions: [],
      projection: {
        before: { generation: 2, source_through: 20, source_available: 20, has_pending: false },
        after: { generation: 3, source_through: 30, source_available: 30, has_pending: false },
      },
    };
    respond(valid);
    const first = await client.fetchComparison(before, after);
    for (const continuation of [
      { ...next, before_generation: 4, offset: 2 },
      { ...next, after_generation: 4, offset: 2 },
      { ...next, scope_hash: "b".repeat(64), offset: 2 },
      { ...next, offset: 0 },
      next,
    ]) {
      respond({ ...valid, next_after: continuation });
      await expect(client.fetchComparison(before, after, first.next_after)).rejects.toThrow();
    }
    await expect(Reflect.apply(client.fetchComparison, undefined, [before, after, 0])).rejects.toThrow();
  });
});

function preparedUsageFixture(): RunUsage {
  const token = { uncached_input: 71, cache_read: null, cache_write: 0, output: 24,
    calls: 2, known_cost: null, legacy_input: null };
  return { ...token, accounting_basis: "sdk_reported_subtotal",
    by_purpose: { authoring: { ...token }, planning: { ...token }, replanning: { ...token },
      improvement: { ...token }, other: { ...token } } };
}

function preparedViewFixture(patch: Partial<PreparedStartView> = {}): PreparedStartView {
  return {
    preparation_id: "prepared/fixture", task: "Gather supplies", model_id: "fixture-discovered-model",
    goal: { adapter_id: "minecraft", goal_id: "custom", verifier: null, parameters: { declared: "fixture" } },
    phase: "compiling", started_at: "2026-11-10T10:00:00.000Z", deadline_at: "2026-11-10T10:05:00.000Z",
    ready_at: null, run_id: null, requests_admitted: 2, tools_used: 4, source_versions: 3,
    analysis_jobs: 1, analysis_ms: 31.75, program: { name: "Fixture source", version: 3 },
    usage: preparedUsageFixture(), limits: PREPARED_START_LIMITS, closure: "open", error: null, ...patch,
  };
}

function preparedStateFixture(prepared_start: PreparedStartView | null): AppSnapshot {
  return {
    auth: { status: "signed_out", authenticated: false, provider: "openai-codex",
      account_label: null, models: [], login: null, error: null },
    server: { status: "stopped", version: "1.21.4", host: "127.0.0.1", port: 25565,
      world_id: null, eula_accepted: true, error: null },
    game: { status: "disconnected", username: "fixture", version: "1.21.4", world_id: null, epoch: 0,
      session_id: null, life: null, binding: null, space: null, screen: null, presentation: null,
      video: { status: "idle", width: 0, height: 0, fps: null, frames: 0, last_frame_at: null, error: null },
      last_observation_at: null, error: null },
    sandbox: { status: "ready", image: "fixture-image", error: null },
    prepared_start, run: null, goals: [], events: [],
  };
}

test("prepared HTTP interactions retain exact request identity, source metadata and honest closure states", async () => {
  await withApiResponse(async (respond, requests) => {
    const client: typeof import("./api.ts") = await import(new URL("./api.ts?prepared-http-fixture", import.meta.url).href);
    respond({ csrf_token: "fixture-prepared-session" });
    await client.openSession();
    const view = preparedViewFixture();
    const request: PreparedStartRequest = { request_id: "f762fe8c-e3db-4a09-ae04-1d8318b00ad9",
      task: view.task, goal: view.goal, model_id: view.model_id };
    respond(view, 202);
    expect(await client.prepareAndPlay(request)).toEqual(view);
    expect(await client.prepareAndPlay(request)).toEqual(view);
    const sent = requests.slice(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.init?.body).toBe(sent[1]?.init?.body);
    expect(sent[0]?.path).toBe("/v1/prepared-start");
    expect(sent[0]?.init).toMatchObject({ method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "fixture-prepared-session" },
      body: JSON.stringify(request) });
    const cancelled = preparedViewFixture({ phase: "cancelled", closure: "closed" });
    respond(cancelled);
    expect(await client.cancelPreparation(view.preparation_id)).toEqual(cancelled);
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/prepared-start/prepared%2Ffixture/cancel", init: { method: "POST", body: "{}" },
    });
    for (const phase of ["authoring", "compiling", "ready", "joining", "activating", "started", "cancelling", "cancelled", "failed"] as const) {
      const state = preparedViewFixture({ phase,
        closure: phase === "started" ? "transferred" : phase === "failed" ? "unknown" : phase === "cancelling" ? "draining" : "open",
        run_id: phase === "started" ? "actual-admitted-run" : null,
        ready_at: ["ready", "joining", "activating", "started"].includes(phase) ? "2026-11-10T10:01:00.000Z" : null });
      respond(preparedStateFixture(state));
      expect((await client.fetchState()).prepared_start).toEqual(state);
    }
    const beforeInvalidRequest = requests.length;
    await expect(Reflect.apply(client.prepareAndPlay, undefined, [{ ...request, experience_id: "must-not-drop" }])).rejects.toThrow();
    await expect(Reflect.apply(client.prepareAndPlay, undefined, [{ ...request, request_id: "not-a-uuid" }])).rejects.toThrow();
    expect(requests).toHaveLength(beforeInvalidRequest);
  });
});

test("retained preparations keep their original budgets after new defaults increase", async () => {
  await withApiResponse(async respond => {
    const client: typeof import("./api.ts") = await import(new URL("./api.ts?retained-preparation-budget", import.meta.url).href);
    const historical = {
      ...preparedViewFixture({ phase: "failed", closure: "closed" }),
      limits: { ...PREPARED_START_LIMITS, duration_ms: 300000, max_requests: 12 },
    };
    respond({ ...preparedStateFixture(null), prepared_start: historical });
    const retained = (await client.fetchState()).prepared_start;
    expect(retained).toEqual(historical);
    expect(retained?.deadline_at).toBe("2026-11-10T10:05:00.000Z");
    const current = preparedViewFixture({ deadline_at: "2026-11-10T10:10:00.000Z" });
    respond(preparedStateFixture(current));
    expect((await client.fetchState()).prepared_start).toEqual(current);
    expect(retained?.limits).toEqual(historical.limits);
  });
});

test("prepared snapshot requires explicit null and rejects missing finite limits, source identity and usage metadata", async () => {
  await withApiResponse(async respond => {
    const client: typeof import("./api.ts") = await import(new URL("./api.ts?prepared-validation-fixture", import.meta.url).href);
    const empty = preparedStateFixture(null);
    respond(empty);
    expect((await client.fetchState()).prepared_start).toBeNull();
    const { prepared_start: omitted, ...missing } = empty;
    respond(missing);
    await expect(client.fetchState()).rejects.toThrow("does not match this UI");
    const view = preparedViewFixture();
    for (const malformed of [
      { ...view, limits: { ...view.limits, max_requests: 0 } },
      { ...view, limits: { ...view.limits, max_requests: 1.5 } },
      { ...view, limits: { ...view.limits, max_requests: Number.MAX_SAFE_INTEGER + 1 } },
      { ...view, limits: { ...view.limits, duration_ms: 0 } },
      { ...view, limits: { ...view.limits, max_analysis_ms: undefined } },
      { ...view, program: { name: "Fixture source" } },
      { ...view, program: { name: "Fixture source", version: 0 } },
      { ...view, phase: "playing" },
      { ...view, closure: undefined },
      { ...view, analysis_ms: -1 },
      { ...view, started_at: "unknown" },
      { ...view, usage: { ...view.usage, cache_read: undefined } },
      { ...view, usage: { ...view.usage, by_purpose: undefined } },
      { ...view, goal: { ...view.goal, verifier: { id: "fixture", version: undefined } } },
    ]) {
      respond({ ...empty, prepared_start: malformed });
      await expect(client.fetchState()).rejects.toThrow("does not match this UI");
    }
  });
});

test("preparation response failures are reported without automatic retries or invented success", async () => {
  await withApiResponse(async (respond, requests) => {
    const client: typeof import("./api.ts") = await import(new URL("./api.ts?prepared-errors-fixture", import.meta.url).href);
    respond({ csrf_token: "fixture-prepared-errors" });
    await client.openSession();
    const view = preparedViewFixture();
    const request: PreparedStartRequest = { request_id: "1714daae-2827-4c2c-a8d7-a5f000f484f9",
      task: view.task, goal: view.goal, model_id: view.model_id };
    respond({ ...view, closure: undefined }, 202);
    await expect(client.prepareAndPlay(request)).rejects.toMatchObject({ code: "invalid_preparation" });
    expect(requests).toHaveLength(2);
    respond({ error: { code: "preparation_conflict", message: "Another preparation owns startup." } }, 409);
    await expect(client.prepareAndPlay(request)).rejects.toMatchObject({ status: 409, code: "preparation_conflict" });
    expect(requests).toHaveLength(3);
    respond({ phase: "cancelled" });
    await expect(client.cancelPreparation(view.preparation_id)).rejects.toMatchObject({ code: "invalid_preparation" });
    expect(requests).toHaveLength(4);
  });
});
