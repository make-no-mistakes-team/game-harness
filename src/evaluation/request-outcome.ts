import type { ActivityEvent } from "../shared/contracts.ts";
import { AUTHORING_CANCELLATION_REASONS } from "../shared/strategic-cancellation.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strategicRoles: Readonly<Record<string, true>> = {
  authoring: true, planning: true, recovery: true, review: true, speculative: true,
};

/** Classifies host-owned lifecycle evidence without changing raw SDK failure or usage facts. */
export function classifyEvaluationRequest(event: ActivityEvent): { provider_error: boolean; provider_settled: boolean } {
  const data = object(event.details), cancellation = object(data.host_cancellation);
  const settled = event.type === "model.request_settled";
  const exactAbortedRequest = settled && data.stop_reason === "aborted" &&
    typeof data.request_id === "string" && data.request_id.length > 0 && cancellation.request_id === data.request_id;
  const authoringCancelled = cancellation.kind === "ordinary_authoring" && data.role === "authoring" && data.obsolete === true &&
    typeof cancellation.root_execution_id === "string" && cancellation.root_execution_id.trim().length > 0 &&
    typeof cancellation.reason === "string" && AUTHORING_CANCELLATION_REASONS[cancellation.reason] === true;
  const strategicCancelled = cancellation.kind === "strategic_host" && Object.keys(cancellation).length === 3 &&
    typeof data.request_id === "string" && data.request_id.trim().length > 0 &&
    typeof data.role === "string" && strategicRoles[data.role] === true &&
    (cancellation.reason === "turn_deadline" || data.obsolete === true &&
      (cancellation.reason === "fenced" || cancellation.reason === "speculative_preempted" && data.role === "speculative"));
  const hostCancelled = exactAbortedRequest && (authoringCancelled || strategicCancelled);
  return {
    provider_error: event.type === "model.request_unsettled" || settled && !hostCancelled &&
      (data.stop_reason === "error" || object(data.recovered_failure).type === "stream_interrupted_after_content"),
    provider_settled: settled && (hostCancelled || data.stop_reason !== "aborted" && data.stop_reason !== "error"),
  };
}
