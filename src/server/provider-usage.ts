import type { Api, Model, RawSseEvent } from "@oh-my-pi/pi-ai";
import type { ReportedUsage, RequestUsageEvidence } from "../shared/contracts.ts";

export const unknownUsage = (): ReportedUsage => ({ uncached_input: null, cache_read: null, cache_write: null, output: null });
export const usageCounter = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const keys = ["uncached_input", "cache_read", "cache_write", "output"] as const;
const identity = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : null;

export function sdkReportedUsage(value: unknown): ReportedUsage | null {
  if (value === null || typeof value !== "object") return null;
  const usage = object(value);
  return { uncached_input: usageCounter(usage.input), cache_read: usageCounter(usage.cacheRead),
    cache_write: usageCounter(usage.cacheWrite), output: usageCounter(usage.output) };
}

/** Audited Responses accounting: pi-ai openai-shared.populateResponsesUsageFromResponse.
 * Unlike the SDK, absence/invalidity is not defaulted to zero or clamped.
 * Optional orchestration annotations are absent when not used by the adapter;
 * explicit cache-write counters are still required to justify uncached input.
 */
function responsesUsage(value: unknown): ReportedUsage {
  const usage = object(value), details = object(usage.input_tokens_details), outputDetails = object(usage.output_tokens_details);
  const primaryInput = usageCounter(usage.input_tokens), primaryOutput = usageCounter(usage.output_tokens);
  const primaryRead = usageCounter(Object.hasOwn(details, "cached_tokens") ? details.cached_tokens : usage.prompt_cache_hit_tokens);
  let input = primaryInput, output = primaryOutput, read = primaryRead, write = usageCounter(details.cache_write_tokens);
  const orchestrationInput = Object.hasOwn(details, "orchestration_input_tokens") ? usageCounter(details.orchestration_input_tokens) : 0;
  const orchestrationRead = Object.hasOwn(details, "orchestration_input_cached_tokens") ? usageCounter(details.orchestration_input_cached_tokens) : 0;
  const orchestrationOutput = Object.hasOwn(outputDetails, "orchestration_output_tokens") ? usageCounter(outputDetails.orchestration_output_tokens) : 0;
  const total = usageCounter(usage.total_tokens);
  if (Object.hasOwn(usage, "total_tokens") && total === null) return unknownUsage();
  let separatelyAnnotated: boolean | null = false;
  if (primaryInput !== null && primaryOutput !== null && orchestrationInput !== null && orchestrationOutput !== null) {
    const primary = primaryInput + primaryOutput, separate = primary + orchestrationInput + orchestrationOutput;
    // The installed adapter uses total_tokens to distinguish included from separately
    // annotated orchestration. A contradictory total cannot establish category totals.
    if (total !== null && total !== primary && total !== separate) return unknownUsage();
    separatelyAnnotated = orchestrationInput + orchestrationOutput > 0
      ? total === null ? null : total === separate && separate !== primary : false;
  } else if (orchestrationInput !== 0 || orchestrationOutput !== 0) {
    separatelyAnnotated = null;
  }
  if (separatelyAnnotated === true) {
    input = input !== null && orchestrationInput !== null ? input + orchestrationInput : null;
    output = output !== null && orchestrationOutput !== null ? output + orchestrationOutput : null;
    read = read !== null && orchestrationRead !== null ? read + orchestrationRead : null;
  } else if (separatelyAnnotated === null) {
    // A partial primary total cannot disambiguate included versus separate
    // orchestration. Only categories independent of that decision remain usable.
    if (orchestrationInput !== 0 || orchestrationRead !== 0) input = null;
    if (orchestrationRead !== 0) read = null;
    if (orchestrationOutput !== 0) output = null;
  }
  if (orchestrationInput === null || orchestrationRead === null) { input = null; read = null; }
  if (orchestrationOutput === null) output = null;
  if (orchestrationInput !== null && orchestrationRead !== null && orchestrationRead > orchestrationInput) {
    input = null; read = null;
  }
  // Validate each subdivision against its own aggregate before combining them.
  // An impossible write cannot survive merely because uncached input became null.
  if (primaryInput !== null) {
    if (write !== null && write > primaryInput) { input = null; read = null; write = null; }
    else if (primaryRead !== null && primaryRead > primaryInput) { input = null; read = null; }
    else if (primaryRead !== null && write !== null && primaryRead + write > primaryInput) {
      input = null; read = null; write = null;
    }
  }
  return { uncached_input: input !== null && read !== null && write !== null ? usageCounter(input - read - write) : null,
    cache_read: usageCounter(read), cache_write: write, output: usageCounter(output) };
}

/** One instance per admitted stream invocation. Closing prevents late callbacks
 * from mutating even their original settlement, let alone a newer request.
 */
export class ProviderUsageCollector {
  private readonly seen = new Set<string>();
  private readonly accounted = new Set<string>();
  private terminal: RequestUsageEvidence["provider_terminal"] = null;
  private closed = false;
  private overflow = false;
  private idlessTerminalSignature: string | null = null;
  private idlessUnaccounted = false;
  constructor(private readonly requestId: string, private readonly responseOwners = new Map<string, string>()) {}

  observe(event: RawSseEvent, model: Model<Api>): void {
    if (this.closed) return;
    if (event.data.length > 65536) { this.overflow = true; return; }
    const source = model.api === "openai-codex-responses" && model.provider === "openai-codex"
      ? "openai_codex_responses_terminal" : model.api === "openai-responses" && model.provider === "openai"
        ? "openai_responses_terminal" : null;
    if (source === null) return;
    let payload: Record<string, unknown>;
    try { payload = object(JSON.parse(event.data)); } catch { return; }
    const type = payload.type;
    if (typeof type !== "string" || !["response.created", "response.completed", "response.done", "response.incomplete", "response.failed"].includes(type)) return;
    const response = object(payload.response), id = identity(response.id);
    if (id !== null) {
      const owner = this.responseOwners.get(id);
      if (owner !== undefined && owner !== this.requestId) return;
      if (owner === undefined) {
        if (this.responseOwners.size >= 512) { this.overflow = true; return; }
        this.responseOwners.set(id, this.requestId);
      }
      if (this.seen.size >= 32 && !this.seen.has(id)) { this.overflow = true; return; }
      this.seen.add(id);
    }
    if (type === "response.created") return;
    if (!Object.hasOwn(response, "usage") || response.usage === null) {
      if (id === null) this.idlessUnaccounted = true;
      return;
    }
    const counters = responsesUsage(response.usage);
    if (id === null) {
      // Only allowlisted terminal metadata participates in duplicate detection.
      // Different id-less terminal facts cannot safely be correlated as one response.
      const signature = JSON.stringify({ source, type, counters });
      if (this.idlessTerminalSignature !== null && this.idlessTerminalSignature !== signature) {
        this.idlessUnaccounted = true;
        return;
      }
      this.idlessTerminalSignature = signature;
    }
    const key = id ?? "<idless-terminal>";
    if (this.accounted.has(key)) return;
    if (this.accounted.size >= 32) { this.overflow = true; return; }
    this.accounted.add(key);
    if (this.terminal === null) this.terminal = { source, response_id: id, terminal_type: type, counters };
    else {
      for (const category of keys) {
        const prior = this.terminal.counters[category], next = counters[category];
        this.terminal.counters[category] = prior !== null && next !== null ? usageCounter(prior + next) : null;
      }
      this.terminal.response_id = id;
      this.terminal.terminal_type = type;
    }
  }

  finish(sdkUsage: unknown): RequestUsageEvidence {
    this.closed = true;
    const unaccounted = [...this.seen].filter(id => !this.accounted.has(id));
    if (this.idlessUnaccounted) unaccounted.push("<uncorrelated-idless-terminal>");
    if (this.overflow) unaccounted.push("<observation-bound-exceeded>");
    return { schema_version: 1, request_id: this.requestId, sdk_reported: sdkReportedUsage(sdkUsage),
      provider_terminal: this.terminal, unaccounted_response_ids: unaccounted };
  }
}
