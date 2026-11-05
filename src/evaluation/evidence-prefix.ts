import type { ActivityEvent, ReportedUsage, RequestUsageEvidence } from "../shared/contracts.ts";
import type { EvaluationPrefixSummary } from "../server/history-protocol.ts";
import { usageMetrics } from "./results.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const counter = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Exact legacy first-N event qualification, shared by the live observer and readonly child. */
export function reduceEvaluationPrefix(events: readonly ActivityEvent[], admissions: number, eventsOmitted: boolean): EvaluationPrefixSummary {
  const admitted = events.filter(event => event.type === "model.call");
  const readMessage = (event: ActivityEvent): RequestUsageEvidence[] => {
    const data = object(event.details);
    if (typeof data.request_id !== "string") return [];
    const evidence = object(data.usage_evidence), terminal = object(evidence.provider_terminal);
    const readCounters = (value: unknown): ReportedUsage => {
      const fields = object(value);
      return { uncached_input: counter(fields.uncached_input), cache_read: counter(fields.cache_read),
        cache_write: counter(fields.cache_write), output: counter(fields.output) };
    };
    const bound = evidence.schema_version === 1 && evidence.request_id === data.request_id &&
      Array.isArray(evidence.unaccounted_response_ids) && evidence.unaccounted_response_ids.length <= 34 &&
      evidence.unaccounted_response_ids.every(id => typeof id === "string" && id.length <= 200);
    const source = terminal.source;
    const supported = source === "openai_responses_terminal" || source === "openai_codex_responses_terminal" || source === "jev_response_usage";
    const nested = object(data.usage);
    const sdk = bound ? evidence.sdk_reported === null ? null : readCounters(evidence.sdk_reported)
      : Object.hasOwn(data, "usage")
        ? data.usage === null ? null : { uncached_input: counter(nested.input), cache_read: counter(nested.cacheRead),
          cache_write: counter(nested.cacheWrite), output: counter(nested.output) }
        : { uncached_input: counter(data.uncached_input_tokens), cache_read: counter(data.cache_read_tokens),
          cache_write: counter(data.cache_write_tokens), output: counter(data.output_tokens) };
    return [{ schema_version: 1, request_id: data.request_id, sdk_reported: sdk,
      provider_terminal: bound && supported && typeof terminal.terminal_type === "string" &&
        (terminal.response_id === null || typeof terminal.response_id === "string" && terminal.response_id.length <= 200)
        ? { source, response_id: terminal.response_id, terminal_type: terminal.terminal_type, counters: readCounters(terminal.counters) } : null,
      unaccounted_response_ids: bound ? evidence.unaccounted_response_ids as string[] : [] }];
  };
  const messages = events.filter(event => event.type === "model.usage").flatMap(readMessage);
  const unsettled = events.filter(event => event.type === "model.request_unsettled" &&
    object(event.details).usage_evidence !== undefined).flatMap(readMessage);
  const settlements = events.filter(event => event.type === "model.request_settled");
  const settledIds = new Set(settlements.filter(event => !["aborted", "error"].includes(String(object(event.details).stop_reason)))
    .map(event => object(event.details).request_id));
  const tools = new Map<string, number>();
  const counts = new Map<string, { type: string; count: number; failed_verifications: number }>();
  for (const event of events) {
    const count = counts.get(event.type) ?? { type: event.type, count: 0, failed_verifications: 0 };
    count.count++;
    if (event.type === "goal.verification" && object(event.details).status === "failed") count.failed_verifications++;
    counts.set(event.type, count);
    const name = object(event.details).tool;
    if (event.type === "model.tool_started" && typeof name === "string") tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  return { admissions, usage: usageMetrics({ admissions,
    admitted_request_ids: admitted.flatMap(event => { const id = object(event.details).request_id; return typeof id === "string" ? [id] : []; }),
    messages, additional_terminal_evidence: unsettled, events_omitted: eventsOmitted }),
    tools: [...tools].map(([name, count]) => ({ name, count })),
    provider_error: settlements.some(event => object(event.details).stop_reason === "error" ||
      object(object(event.details).recovered_failure).type === "stream_interrupted_after_content"),
    provider_settled: admitted.length > 0 && !eventsOmitted && admitted.every(event => settledIds.has(object(event.details).request_id)),
    event_counts: [...counts.values()], events_omitted: eventsOmitted };
}
