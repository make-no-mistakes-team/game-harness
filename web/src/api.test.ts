import { expect, test } from "bun:test";
import type { ProgramEvidenceView } from "../../src/shared/contracts.ts";
import type { ObjectiveMetrics, ObjectiveMetricUpdate } from "../../src/shared/execution-evidence.ts";
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

async function withApiResponse(body: (respond: (value: unknown) => void) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let response: unknown;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  }), { preconnect: originalFetch.preconnect });
  try { await body(value => { response = value; }); }
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
