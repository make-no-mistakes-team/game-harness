import type { ActivityEvent } from "../shared/contracts.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const authoringCloseReasons: Readonly<Record<string, true>> = {
  root_settled: true, scope_lost: true, root_replaced: true, deadline: true, calls: true, tools: true, fenced: true,
};

/** Classifies host-owned lifecycle evidence without changing raw SDK failure or usage facts. */
export function classifyEvaluationRequest(event: ActivityEvent): { provider_error: boolean; provider_settled: boolean } {
  const data = object(event.details), cancellation = object(data.host_cancellation);
  const settled = event.type === "model.request_settled";
  const hostCancelled = settled && data.stop_reason === "aborted" && data.role === "authoring" && data.obsolete === true &&
    typeof data.request_id === "string" && data.request_id.length > 0 && cancellation.kind === "ordinary_authoring" &&
    cancellation.request_id === data.request_id && typeof cancellation.root_execution_id === "string" &&
    cancellation.root_execution_id.trim().length > 0 && typeof cancellation.reason === "string" && authoringCloseReasons[cancellation.reason] === true;
  return {
    provider_error: event.type === "model.request_unsettled" || settled && !hostCancelled &&
      (data.stop_reason === "error" || object(data.recovered_failure).type === "stream_interrupted_after_content"),
    provider_settled: settled && (hostCancelled || data.stop_reason !== "aborted" && data.stop_reason !== "error"),
  };
}
