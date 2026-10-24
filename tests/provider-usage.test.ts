import { expect, test } from "bun:test";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, RawSseEvent } from "@oh-my-pi/pi-ai";
import { ProviderUsageCollector } from "../src/server/provider-usage.ts";
import { catalogEstimate, classifyEvaluation, costToResult, usageMetrics } from "../src/evaluation/results.ts";

function descriptor(provider: "openai" | "openai-codex" | "anthropic"): Model<Api> {
  const found = getBundledModels(provider).find(model => provider === "anthropic" ||
    model.api === (provider === "openai" ? "openai-responses" : "openai-codex-responses"));
  if (!found) throw new Error(`Installed catalogue lacks offline ${provider} descriptor`);
  return getBundledModel(provider, found.id);
}
function event(usage: unknown, id: string | null = "fixture-response", type = "response.completed"): RawSseEvent {
  const data = JSON.stringify({ type, response: { ...(id === null ? {} : { id }), usage } });
  return { event: type, data, raw: [`data: ${data}`] };
}
const sdk = { input: 6, cacheRead: 3, cacheWrite: 1, output: 4 };
const wire = { input_tokens: 10, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
  output_tokens: 4, total_tokens: 14 };

for (const provider of ["openai", "openai-codex"] as const) {
  for (const type of ["response.completed", "response.done", "response.incomplete", "response.failed"]) {
    test(`${provider} ${type} normalizes explicit cache writes without SDK default filling`, () => {
      const collector = new ProviderUsageCollector("request");
      collector.observe(event(wire, null, type), descriptor(provider));
      const report = usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
        messages: [collector.finish(sdk)] });
      expect(report).toMatchObject({ consumption_coverage: "known", uncached_input: 6, cache_read: 3, cache_write: 1, output: 4,
        reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 }, wire_attempts: null, subscription_cost: null });
    });
  }
}

test("an unsupported provider cannot gain terminal provenance by emitting an OpenAI-shaped event", () => {
  const collector = new ProviderUsageCollector("request");
  collector.observe(event(wire), descriptor("anthropic"));
  expect(usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
    messages: [collector.finish(sdk)] })).toMatchObject({ event_coverage: "complete", consumption_coverage: "unknown",
    uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 } });
});

test("a prior response ID delivered through a newer invocation cannot certify that newer admission", () => {
  const owners = new Map<string, string>(), model = descriptor("openai-codex");
  const first = new ProviderUsageCollector("first", owners);
  first.observe(event(wire, "old-response"), model);
  first.finish(sdk);
  const next = new ProviderUsageCollector("next", owners);
  next.observe(event(wire, "old-response"), model);
  expect(usageMetrics({ admissions: 1, admitted_request_ids: ["next"], events_omitted: false,
    messages: [next.finish(sdk)] })).toMatchObject({ consumption_coverage: "unknown", output: null, uncached_input: null });
});

test("an explicitly omitted oversized raw observation prevents a complete logical-consumption claim", () => {
  const collector = new ProviderUsageCollector("request"), model = descriptor("openai-codex");
  collector.observe({ event: "response.created", data: "x".repeat(65537), raw: [] }, model);
  collector.observe(event(wire), model);
  expect(usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
    messages: [collector.finish(sdk)] })).toMatchObject({ event_coverage: "complete", consumption_coverage: "unknown",
    output: null, reported_subtotal: { output: 4 } });
});

test("valid JSON numeric overflow remains an invalid output contribution instead of SDK zero", () => {
  const collector = new ProviderUsageCollector("request"), model = descriptor("openai-codex");
  collector.observe({ event: "response.completed", raw: [], data: '{"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":1},"output_tokens":1e309}}}' }, model);
  expect(usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
    messages: [collector.finish(sdk)] })).toMatchObject({ consumption_coverage: "partial", uncached_input: 6,
    cache_read: 3, cache_write: 1, output: null, reported_subtotal: { output: 4 } });
});

for (const sample of [
  { total: 19, expected: { uncached_input: 8, cache_read: 4, cache_write: 1, output: 6 }, coverage: "known" },
  { total: 14, expected: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 }, coverage: "known" },
  { total: 15, expected: { uncached_input: null, cache_read: null, cache_write: null, output: null }, coverage: "unknown" },
]) {
  test(`explicit orchestration annotations reconcile total=${sample.total} without counting already-included tokens twice`, () => {
    const collector = new ProviderUsageCollector("request");
    collector.observe(event({ ...wire, total_tokens: sample.total,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1, orchestration_input_tokens: 3,
        orchestration_input_cached_tokens: 1 }, output_tokens_details: { orchestration_output_tokens: 2 } }), descriptor("openai-codex"));
    expect(usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
      messages: [collector.finish(sdk)] })).toMatchObject({ ...sample.expected, consumption_coverage: sample.coverage,
      reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 } });
  });
}

for (const missingUsage of [undefined, null]) {
  test(`an idless failed terminal with ${missingUsage === null ? "null" : "omitted"} usage remains unaccounted after a successful retry`, () => {
    const collector = new ProviderUsageCollector("request"), model = descriptor("openai-codex");
    collector.observe(event(missingUsage, null, "response.failed"), model);
    collector.observe(event(wire, "accounted-retry"), model);
    const report = usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
      messages: [collector.finish(sdk)] });
    expect(report).toMatchObject({ event_coverage: "complete", consumption_coverage: "unknown",
      uncached_input: null, cache_read: null, cache_write: null, output: null,
      reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 } });
    expect(catalogEstimate(report, { uncached_input: 1, cache_read: 1, cache_write: 1, output: 1 }).estimate).toBeNull();
  });
}

test("different idless terminal counters cannot be assumed to be one duplicated response", () => {
  const collector = new ProviderUsageCollector("request"), model = descriptor("openai-codex");
  collector.observe(event(wire, null), model);
  collector.observe(event({ input_tokens: 15, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
    output_tokens: 6, total_tokens: 21 }, null), model);
  expect(usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
    messages: [collector.finish({ input: 8, cacheRead: 5, cacheWrite: 2, output: 6 })] })).toMatchObject({
    consumption_coverage: "unknown", uncached_input: null, cache_read: null, cache_write: null, output: null,
    reported_subtotal: { uncached_input: 8, cache_read: 5, cache_write: 2, output: 6 },
  });
});

test("an actual duplicate of one explicitly accounted idless terminal does not inflate its counters", () => {
  const collector = new ProviderUsageCollector("request"), model = descriptor("openai-codex");
  const terminal = event(wire, null);
  collector.observe(terminal, model);
  collector.observe(terminal, model);
  expect(usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
    messages: [collector.finish(sdk)] })).toMatchObject({ consumption_coverage: "known",
    uncached_input: 6, cache_read: 3, cache_write: 1, output: 4, reported_messages: 1 });
});

for (const sample of [
  { name: "missing primary output", input: 10, output: undefined },
  { name: "invalid primary output", input: 10, output: -1 },
  { name: "missing primary input", input: undefined, output: 4 },
  { name: "invalid primary input", input: -1, output: 4 },
]) {
  test(`${sample.name} cannot resolve nonzero orchestration inclusion for dependent categories`, () => {
    const collector = new ProviderUsageCollector("request");
    collector.observe(event({ input_tokens: sample.input, output_tokens: sample.output, total_tokens: 19,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1, orchestration_input_tokens: 3,
        orchestration_input_cached_tokens: 1 }, output_tokens_details: { orchestration_output_tokens: 2 } }), descriptor("openai-codex"));
    const report = usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
      messages: [collector.finish(sdk)] });
    expect(report).toMatchObject({ consumption_coverage: "partial", uncached_input: null, cache_read: null,
      cache_write: 1, output: null, reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 } });
    const outcome = classifyEvaluation({ inferenceAdmitted: true, goalVerified: false,
      platformChecksComplete: true, providerError: false, providerSettled: false });
    expect(costToResult([{ outcome, usage: report }])).toMatchObject({ uncached_input: null, cache_read: null,
      cache_write: 1, output: null, reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 } });
  });
}

for (const sample of [
  { name: "cache writes exceeding primary input", details: { cached_tokens: 3, cache_write_tokens: 11 }, total: 14,
    outputDetails: {}, expected: { uncached_input: null, cache_read: null, cache_write: null, output: 4 } },
  { name: "orchestration cached input exceeding orchestration input despite a balanced total",
    details: { cached_tokens: 3, cache_write_tokens: 1, orchestration_input_tokens: 3, orchestration_input_cached_tokens: 4 },
    total: 19, outputDetails: { orchestration_output_tokens: 2 },
    expected: { uncached_input: null, cache_read: null, cache_write: 1, output: 6 } },
]) {
  test(`${sample.name} cannot publish conflicting qualified cache categories`, () => {
    const collector = new ProviderUsageCollector("request");
    collector.observe(event({ input_tokens: 10, output_tokens: 4, total_tokens: sample.total,
      input_tokens_details: sample.details, output_tokens_details: sample.outputDetails }), descriptor("openai-codex"));
    const report = usageMetrics({ admissions: 1, admitted_request_ids: ["request"], events_omitted: false,
      messages: [collector.finish(sdk)] });
    expect(report).toMatchObject({ ...sample.expected, consumption_coverage: "partial",
      reported_subtotal: { uncached_input: 6, cache_read: 3, cache_write: 1, output: 4 } });
    expect(catalogEstimate(report, { uncached_input: 1, cache_read: 1, cache_write: 1, output: 1 }).estimate).toBeNull();
  });
}
