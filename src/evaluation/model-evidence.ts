import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { ActivityEvent, ObservationV3 } from "../shared/contracts.ts";
import type { Store } from "../server/store.ts";
import type { Runtime } from "../server/runtime.ts";
import type { AuthManager } from "../server/auth.ts";
import { HistoryReader } from "../server/history-reader.ts";
import type { EvaluationPrefixSummary, HistoryExportCursor, HistoryExportPage, HistoryQuery, HistoryQueryOptions } from "../server/history-protocol.ts";
import type { Json } from "../shared/contracts.ts";
import type { EvaluationCaps } from "./contracts.ts";
import type { GoalAction } from "./scenarios.ts";
import { actionMetrics, readUsageMetrics, type ActionMetrics, type MeasuredInterval, type UsageMetrics, type WaitCategory } from "./results.ts";
import { PrivateJournal, type JournalFinalization } from "./private-journal.ts";
import type { JournalLimits } from "../shared/evidence-limits.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "../server/performance.ts";
import type { ProjectionProgress } from "../server/program-feedback.ts";
import { classifyEvaluationRequest } from "./request-outcome.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Append-only derived evidence. Never settles an attempt or changes admission governance. */
export async function writeUsageQualification(input: { directory: string;
  original: { attempt_id: string; report_path: string; sha256: string };
  usage: UsageMetrics; reasons: readonly string[] }): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(input.original.attempt_id) || !/^[a-f0-9]{64}$/.test(input.original.sha256) ||
    !input.reasons.length || input.reasons.length > 32 || input.reasons.some(reason => !reason || reason.length > 500))
    throw new Error("Qualification requires bounded original identity, SHA-256 and reasons");
  const usage = readUsageMetrics(input.usage);
  if (usage === null) throw new Error("Qualification requires valid version-2 usage metrics");
  const original = await readFile(path.resolve(input.directory, input.original.report_path));
  if (createHash("sha256").update(original).digest("hex") !== input.original.sha256)
    throw new Error("Original report hash does not match qualification identity");
  const name = `usage-qualification-${input.original.attempt_id}-${input.original.sha256}.json`;
  await writeFile(path.join(input.directory, name), JSON.stringify({
    schema_version: 1, kind: "derived_usage_qualification", original: input.original, usage,
    reasons: [...input.reasons], limitations: ["Original report labels, outcomes, bytes and settled rows are unchanged.",
      "Observed logical admission accounting is not all-wire consumption or a subscription invoice."],
  }, null, 2), { mode: 0o600, flag: "wx" });
  return name;
}

interface OpenSpan { run_id: string; start_ms: number; category: WaitCategory }
interface ToolObservation { run_id: string; name: string; tool_call_id: string; arguments: unknown; arguments_sha256: string; omission: string | null }
interface DerivedExportScope {
  status: "not_observed" | "unavailable" | "published";
  projection: ProjectionProgress | null;
  source_available: number | null;
  has_pending: boolean | null;
  omission: string | null;
  total: number | null;
  pages: number;
  complete: boolean;
}
const unknownDerivedScope = (): DerivedExportScope => ({ status: "not_observed", projection: null,
  source_available: null, has_pending: null, omission: "projection_status_not_observed", total: null, pages: 0, complete: false });
export interface EvidenceSummary {
  usage: UsageMetrics;
  actions: ActionMetrics;
  tools: Array<{ name: string; count: number }>;
  provider_error: boolean;
  provider_settled: boolean;
  confirmed_harness_faults: string[];
  unclassified_tool_failures: boolean;
  observer_error: string | null;
  omissions: Record<string, number>;
}
const expectedToolFailures = new Set(["invalid_program", "invalid_request", "precondition_failed", "stale_context",
  "deadline_exceeded", "not_found", "conflict", "validation_failed", "budget_exceeded"]);

/** Streaming transport validation holds only one hash and a possible UTF-16 surrogate. */
class ArchiveRecordVerifier {
  private chunk: { record: number; records: number; count: number; next: number; sha256: string;
    originalBytes: number; bytes: number; hash: ReturnType<typeof createHash>; pending: string } | null = null;
  constructor(private readonly collection: string) {}
  accept(records: readonly Json[], total: number): void {
    for (const raw of records) {
      const record = object(raw);
      if (record.kind !== "json_record_chunk") {
        if (this.chunk) throw new Error("history_export_incomplete_record_chunk");
        continue;
      }
      if (record.schema_version !== 1 || record.collection !== this.collection || record.encoding !== "json_text" ||
          !Number.isSafeInteger(record.record_index) || !Number.isSafeInteger(record.record_count) ||
          Number(record.record_index) < 0 || Number(record.record_index) >= Number(record.record_count) || record.record_count !== total ||
          !Number.isSafeInteger(record.chunk_count) || Number(record.chunk_count) <= 0 ||
          !Number.isSafeInteger(record.original_bytes) || Number(record.original_bytes) <= 0 ||
          typeof record.text !== "string" || typeof record.sha256 !== "string")
        throw new Error("history_export_invalid_record_chunk");
      if (!this.chunk) {
        if (record.chunk_index !== 0) throw new Error("history_export_missing_record_chunk");
        this.chunk = { record: Number(record.record_index), records: Number(record.record_count), count: Number(record.chunk_count),
          next: 0, sha256: record.sha256, originalBytes: Number(record.original_bytes), bytes: 0, hash: createHash("sha256"), pending: "" };
      }
      const chunk = this.chunk;
      if (chunk.record !== record.record_index || chunk.records !== record.record_count || chunk.count !== record.chunk_count ||
          chunk.next !== record.chunk_index || chunk.sha256 !== record.sha256 || chunk.originalBytes !== record.original_bytes)
        throw new Error("history_export_record_chunk_identity_changed");
      let text = chunk.pending + record.text;
      const tail = text.charCodeAt(text.length - 1);
      chunk.pending = tail >= 0xd800 && tail <= 0xdbff ? text.slice(-1) : "";
      if (chunk.pending) text = text.slice(0, -1);
      chunk.hash.update(text); chunk.bytes += Buffer.byteLength(text); chunk.next++;
      if (chunk.next === chunk.count) {
        chunk.hash.update(chunk.pending); chunk.bytes += Buffer.byteLength(chunk.pending);
        if (chunk.hash.digest("hex") !== chunk.sha256 || chunk.bytes !== chunk.originalBytes)
          throw new Error("history_export_record_chunk_hash_changed");
        this.chunk = null;
      }
    }
  }
  finish(): void {
    if (this.chunk) throw new Error("history_export_incomplete_record_chunk");
  }
}

/** Transparent observer of the actual AuthManager Agents and durable production Store.
 * No provider replacement, tool interception, prompt mutation or source injection.
 * Full sources/arguments stay private; compact reports use a separate allowlist.
 */
export class ModelProgramEvidence {
  private runtime: Runtime | null = null;
  private readonly clocks = new Map<number, number>();
  private readonly open = new Map<string, OpenSpan>();
  private readonly completed: Array<MeasuredInterval & { run_id: string }> = [];
  private readonly toolCalls: ToolObservation[] = [];
  private toolBytes = 0;
  private readonly toolFailures: Array<{ run_id: string; tool: string; tool_call_id: string; code: string | null }> = [];
  private readonly agentSubscriptions: Array<() => void> = [];
  private restoreAuthFactory: (() => void) | null = null;
  private closed = false;
  private readonly unsubscribe: () => void;
  private observerError: string | null = null;
  private readonly omissions: Record<string, number> = {};
  private readonly admissions = new Map<string, number>();
  private readonly actionCache = new Map<string, Map<string, GoalAction>>();
  private readonly actionSummaries = new Map<string, ActionMetrics>();
  private readonly inventoryMetricKeys = new Map<string, Map<string, number>>();
  private readonly prefixCounts = new Map<string, Map<string, { type: string; count: number; failed_verifications: number }>>();
  private readonly retrospectiveRuns = new Set<string>();
  private readonly initializedRuns = new Map<string, Promise<void>>();
  private readonly toolFailureFlags = new Map<string, { backend: boolean; unclassified: boolean }>();
  private readonly providerFailures = new Set<string>();
  private readonly modelObservationFailures = new Set<string>();
  private readonly historyQueryFailures = new Set<string>();
  private readonly stopRequested = new Set<string>();
  private readonly journals = new Map<string, PrivateJournal>();
  private readonly history: HistoryReader;
  private readonly observedEventSequences = new Map<string, number[]>();
  private readonly finalizations = new Map<string, Promise<JournalFinalization>>();
  private readonly exports = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;
  private readonly unsubscribeTrace: () => void;
  constructor(readonly store: Store, readonly directory: string, readonly caps: EvaluationCaps,
    readonly clockId: string, private readonly stop: (runId: string, reason: string) => void,
    private readonly options: { limits?: Partial<JournalLimits> } = {}) {
    this.history = new HistoryReader(store.readLocation());
    this.unsubscribeTrace = store.subscribeTraceEvidence(input => {
      this.journal(input.run_id).append("authorized_execution_evidence_before_trace_caps", input);
      const span = object(input.payload);
      if (input.kind === "span" && span.clock_id === HOST_MONOTONIC_CLOCK_ID &&
          span.lifecycle_barrier_confirmed === true &&
          (span.category === "worker_start" || span.category === "worker_cleanup")) {
        this.sameHostInterval(input.run_id, span.category, span.started_monotonic_ms, span.ended_monotonic_ms);
      }
    });
    this.unsubscribe = store.subscribe(event => {
      if (!event.run_id) return;
      try { this.observeEvent(event); }
      catch {
        this.observerError = "production_evidence_observer_failed";
        stop(event.run_id, "production_evidence_observer_failed");
      }
    });
  }
  private journal(runId: string) {
    let journal = this.journals.get(runId);
    if (!journal) {
      journal = new PrivateJournal(this.directory, runId, (id, why) => {
        this.observerError = why; this.stop(id, why);
      }, this.options.limits);
      this.journals.set(runId, journal);
    }
    return journal;
  }
  bindRuntime(runtime: Runtime) { this.runtime = runtime; }
  recordObservation(runId: string, observation: ObservationV3) {
    this.journal(runId).append("authorized_evaluation_observation", { observation });
  }
  private omit(key: string) { this.omissions[key] = (this.omissions[key] ?? 0) + 1; }
  private sameHostInterval(runId: string, category: WaitCategory, start: unknown, end: unknown) {
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      this.omit("invalid_timing_interval");
      return;
    }
    this.addInterval({ run_id: runId, category, start_ms: start, end_ms: end, clock_id: this.clockId });
  }
  private addInterval(span: MeasuredInterval & { run_id: string }) {
    if (this.completed.length < this.caps.reportEventPages * this.caps.eventPageRecords) this.completed.push(span);
    else this.omit("timing_interval_budget");
  }
  private observeEvent(event: ActivityEvent) {
    const runId = event.run_id!, data = object(event.details), now = performance.now();
    this.journal(runId).append("store_event", event);
    let retained = this.observedEventSequences.get(runId);
    if (!retained) { retained = []; this.observedEventSequences.set(runId, retained); }
    if (retained.length < this.caps.reportEventPages * this.caps.eventPageRecords) {
      retained.push(event.event_seq);
      let counts = this.prefixCounts.get(runId);
      if (!counts) { counts = new Map(); this.prefixCounts.set(runId, counts); }
      const count = counts.get(event.type) ?? { type: event.type, count: 0, failed_verifications: 0 };
      count.count++;
      if (event.type === "goal.verification" && data.status === "failed") count.failed_verifications++;
      counts.set(event.type, count);
    }
    if (event.type === "runtime.model_observation_failed") this.modelObservationFailures.add(runId);
    if (event.type === "runtime.history_query_failed") this.historyQueryFailures.add(runId);
    if (event.type.startsWith("action.") && typeof data.action_id === "string") {
      const action = this.store.getAction(runId, data.action_id);
      if (action) {
        let actions = this.actionCache.get(runId);
        if (!actions) { actions = new Map(); this.actionCache.set(runId, actions); }
        let metrics = this.actionSummaries.get(runId);
        if (!metrics) { metrics = actionMetrics([]); this.actionSummaries.set(runId, metrics); }
        let inventoryKeys = this.inventoryMetricKeys.get(runId);
        if (!inventoryKeys) { inventoryKeys = new Map(); this.inventoryMetricKeys.set(runId, inventoryKeys); }
        const previous = actions.get(data.action_id);
        for (const [sample, direction] of [[previous, -1], [action, 1]] as const) {
          if (!sample) continue;
          const delta = actionMetrics([sample]);
          metrics.count += direction * delta.count;
          metrics.confirmed_effects += direction * delta.confirmed_effects;
          metrics.inventory_receipts += direction * delta.inventory_receipts;
          metrics.uncertain_outcomes += direction * delta.uncertain_outcomes;
          for (const [status, count] of Object.entries(delta.by_status)) {
            metrics.by_status[status] = (metrics.by_status[status] ?? 0) + direction * count;
            if (!metrics.by_status[status]) delete metrics.by_status[status];
          }
          for (const [item, count] of Object.entries(delta.inventory_delta)) {
            metrics.inventory_delta[item] = (metrics.inventory_delta[item] ?? 0) + direction * count;
            const present = (inventoryKeys.get(item) ?? 0) + direction;
            if (present) inventoryKeys.set(item, present);
            else { inventoryKeys.delete(item); delete metrics.inventory_delta[item]; }
          }
        }
        actions.set(data.action_id, { ...action, run_id: runId });
      }
    }
    if (this.clocks.size < this.caps.reportEventPages * this.caps.eventPageRecords) this.clocks.set(event.event_seq, now);
    else this.omit("event_monotonic_clocks");
    const close = (key: string) => {
      const span = this.open.get(key);
      if (span) { this.addInterval({ ...span, end_ms: now, clock_id: this.clockId }); this.open.delete(key); }
    };
    if (event.type === "program.source_timing" && data.clock_id === HOST_MONOTONIC_CLOCK_ID)
      this.sameHostInterval(runId, "source_validation", data.started_monotonic_ms,
        data.validation_finished_monotonic_ms ?? data.ended_monotonic_ms);
    if (event.type === "model.call") {
      const count = (this.admissions.get(runId) ?? 0) + 1;
      this.admissions.set(runId, count);
      if (typeof data.request_id === "string") this.open.set(`provider:${runId}:${data.request_id}`, { run_id: runId, start_ms: now, category: "provider_request" });
      if (count >= this.caps.hostRequestAdmissions && !this.stopRequested.has(runId)) {
        this.stopRequested.add(runId);
        this.stop(runId, "host_request_admission_bound_reached");
      }
    } else if (["model.request_settled", "model.request_unsettled"].includes(event.type)) {
      if (typeof data.request_id === "string") close(`provider:${runId}:${data.request_id}`);
      if (classifyEvaluationRequest(event).provider_error) {
        this.providerFailures.add(runId);
        this.stop(runId, "provider_failure_or_unsettled_no_repeat");
      }
    } else if (event.type === "model.tool_started" && typeof data.tool_call_id === "string") {
      this.open.set(`tool:${runId}:${data.tool_call_id}`, { run_id: runId, start_ms: now, category: "tool" });
    } else if (event.type === "model.tool_finished" && typeof data.tool_call_id === "string") close(`tool:${runId}:${data.tool_call_id}`);
    else if (event.type === "action.accepted" && typeof data.action_id === "string") {
      this.open.set(`action:${runId}:${data.action_id}`, { run_id: runId, start_ms: now, category: "game_action" });
    } else if (/^action\.(?:succeeded|failed|cancelled|unknown)$/.test(event.type) && typeof data.action_id === "string") close(`action:${runId}:${data.action_id}`);
  }
  /** Wraps only Agent creation to subscribe to the actual returned Agent. */
  observeAuthAgents(auth: AuthManager) {
    if (this.restoreAuthFactory) throw new Error("The actual Agent observer is already installed");
    const original = auth.createAgent;
    auth.createAgent = async options => {
      const agent = await original.call(auth, options);
      const runId = this.runtime?.currentRunId();
      if (runId && !this.closed) this.observeAgent(agent, runId);
      return agent;
    };
    this.restoreAuthFactory = () => { auth.createAgent = original; };
  }
  private observeAgent(agent: Agent, runId: string) {
    this.agentSubscriptions.push(agent.addBeforeModelCall(context => {
      // Keep the early capacity gate, but do not label this as the assembled
      // request: the strategist adds its run-owned supplement at stream time.
      if (!this.journal(runId).append("sdk_context_before_request_assembly_not_wire_payload", context))
        return { stop: true, reason: "private_journal_evidence_unavailable" };
    }));
    const stream = agent.streamFn;
    if (typeof stream === "function") {
      const observed: typeof stream = (model, context, options) => {
        // Installed before StrategicPlanner wraps streamFn. Its outer wrapper
        // passes the final supplemented context here before provider dispatch.
        if (!this.closed && !this.journal(runId).append("final_sdk_visible_context_not_wire_payload", context))
          throw new Error("private_journal_evidence_unavailable");
        return stream(model, context, options);
      };
      agent.streamFn = observed;
      this.agentSubscriptions.push(() => { if (agent.streamFn === observed) agent.streamFn = stream; });
    }
    this.agentSubscriptions.push(agent.subscribe(event => {
      // Only SDK-visible conversation/tool events. No launcher logs, API keys,
      // transport options, auth database contents or hidden evaluator state.
      if (["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type))
        this.journal(runId).append("visible_agent_event", event);
      if (event.type === "tool_execution_end" && event.isError) {
        const details = object(object(event.result).details), error = object(details.error);
        const code = typeof error.code === "string" ? error.code : null;
        this.toolFailures.push({ run_id: runId, tool: event.toolName, tool_call_id: event.toolCallId,
          code });
        const flags = this.toolFailureFlags.get(runId) ?? { backend: false, unclassified: false };
        flags.backend ||= code === "backend_unavailable";
        flags.unclassified ||= code === null || !expectedToolFailures.has(code) && code !== "backend_unavailable";
        this.toolFailureFlags.set(runId, flags);
      }
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      for (const content of event.message.content) {
        if (content.type !== "toolCall") continue;
        try {
          const json = JSON.stringify(content.arguments), size = Buffer.byteLength(json);
          if (this.toolBytes + size > this.caps.reportJsonBytes / 4) { this.omit("assistant_tool_call_arguments"); continue; }
          this.toolCalls.push({ run_id: runId, name: content.name, tool_call_id: content.id, arguments: JSON.parse(json),
            arguments_sha256: createHash("sha256").update(json).digest("hex"), omission: null });
          this.toolBytes += size;
        } catch { this.omit("assistant_tool_call_arguments"); }
      }
    }));
  }
  count(runId: string) { return this.admissions.get(runId) ?? 0; }
  initialize(runId: string, options?: HistoryQueryOptions): Promise<void> {
    const existing = this.initializedRuns.get(runId);
    if (existing) return existing;
    const query = this.queryOptions(options);
    const work = (async () => {
      // Even the initial prefix probe is byte-bounded and parsed in the child.
      const page = await this.exportPage(runId, "events", { record_index: 0, chunk_index: 0 }, 1, query);
      const first = object(page.records[0]).event_seq;
      if (page.omissions.length || object(page.records[0]).kind === "json_record_chunk" ||
          typeof first === "number" && first !== this.observedEventSequences.get(runId)?.[0]) {
        this.retrospectiveRuns.add(runId);
        this.journal(runId).append("observer_durable_prefix_requires_retrospective_read", {
          first_durable_event_seq: first ?? null, first_observed_event_seq: this.observedEventSequences.get(runId)?.[0] ?? null,
          provenance: "Historical usage/count summaries are readonly child calculations; raw pre-observer SDK events and local clocks are not reconstructed.",
          probe_omissions: page.omissions, chunked_probe: object(page.records[0]).kind === "json_record_chunk" });
      }
    })();
    this.initializedRuns.set(runId, work);
    return work;
  }
  private async prefix(runId: string, options?: HistoryQueryOptions): Promise<EvaluationPrefixSummary> {
    const query = this.queryOptions(options);
    await this.initialize(runId, query);
    if (query.signal?.aborted || performance.now() >= query.deadlineHostMs) throw new Error("history_summary_cancelled_or_deadline");
    const value = await this.history.query({ kind: "evaluation_prefix", run_id: runId,
      event_limit: this.caps.reportEventPages * this.caps.eventPageRecords }, query);
    if (query.signal?.aborted || performance.now() >= query.deadlineHostMs) throw new Error("history_summary_cancelled_or_deadline");
    return value;
  }
  async eventCount(runId: string, type: string, status?: "failed", options?: HistoryQueryOptions): Promise<number> {
    const query = this.queryOptions(options);
    await this.initialize(runId, query);
    if (query.signal?.aborted || performance.now() >= query.deadlineHostMs) throw new Error("history_summary_cancelled_or_deadline");
    const entry = this.retrospectiveRuns.has(runId) ? (await this.prefix(runId, query)).event_counts.find(entry => entry.type === type) :
      this.prefixCounts.get(runId)?.get(type);
    return status === "failed" ? entry?.failed_verifications ?? 0 : entry?.count ?? 0;
  }
  actions(runId: string): GoalAction[] {
    // The observer is installed before run creation. Refresh only on real durable action events,
    // not by rescanning the complete event history during every observation poll.
    return [...(this.actionCache.get(runId)?.values() ?? [])];
  }
  hasProviderFailure(runId: string) {
    return this.providerFailures.has(runId);
  }
  async measure<T>(runId: string, category: WaitCategory, operation: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await operation(); }
    finally { this.addInterval({ run_id: runId, start_ms: start, end_ms: performance.now(), category, clock_id: this.clockId }); }
  }
  intervals(runId: string, endMs: number): MeasuredInterval[] {
    // An unclosed span is not attributed beyond observed settlement: that remainder is unknown.
    this.omissions.unclosed_intervals = [...this.open.values()].filter(span => span.start_ms < endMs).length;
    return this.completed.filter(span => span.run_id === runId);
  }
  async summary(runId: string, options?: HistoryQueryOptions): Promise<EvidenceSummary> {
    const prefix = await this.prefix(runId, options);
    this.omissions.events = prefix.events_omitted ? 1 : 0;
    const flags = this.toolFailureFlags.get(runId);
    const faults = flags?.backend ? ["tool_backend_unavailable"] : [];
    if (this.modelObservationFailures.has(runId)) faults.push("model_observation_failed");
    if (this.historyQueryFailures.has(runId)) faults.push("history_query_failed");
    const actions = this.actionSummaries.get(runId) ?? actionMetrics([]);
    return { usage: prefix.usage, tools: prefix.tools, provider_error: prefix.provider_error, provider_settled: prefix.provider_settled,
      actions: { ...actions, by_status: { ...actions.by_status }, inventory_delta: { ...actions.inventory_delta } },
      confirmed_harness_faults: faults, unclassified_tool_failures: flags?.unclassified ?? false,
      observer_error: this.observerError, omissions: { ...this.omissions } };
  }
  private queryOptions(options?: HistoryQueryOptions): HistoryQueryOptions {
    return options ?? { deadlineHostMs: performance.now() + this.caps.diagnosticsMs };
  }
  private async exportPage(runId: string, collection: Extract<HistoryQuery, { kind: "export_page" }>["collection"],
    after: HistoryExportCursor, limit: number, options: HistoryQueryOptions, generation?: number): Promise<HistoryExportPage> {
    const page = await this.history.query({ kind: "export_page", run_id: runId, collection, after, limit,
      ...(generation === undefined ? {} : { generation }) }, options);
    if (options.signal?.aborted || performance.now() >= options.deadlineHostMs)
      throw new Error("history_export_cancelled_or_deadline");
    const progress = page.next_after.record_index - after.record_index || page.next_after.chunk_index - after.chunk_index;
    if (progress < 0 || page.has_more && progress === 0)
      throw new Error("history_export_cursor_did_not_advance");
    return page;
  }
  private async derivedScope(runId: string, options: HistoryQueryOptions): Promise<DerivedExportScope> {
    const status = await this.history.query({ kind: "projection_status", run_id: runId }, options);
    if (options.signal?.aborted || performance.now() >= options.deadlineHostMs)
      throw new Error("history_export_cancelled_or_deadline");
    return { status: status.published ? "published" : "unavailable", projection: status.published,
      source_available: status.source_available, has_pending: status.published?.has_pending ?? true,
      omission: status.published ? null : "projection_pending_first_publication", total: null, pages: 0, complete: false };
  }
  private acceptDerivedPage(scope: DerivedExportScope, page: HistoryExportPage): void {
    if (!page.projection || page.projection.generation !== scope.projection?.generation ||
        page.projection.source_through !== scope.projection.source_through ||
        scope.total !== null && scope.total !== page.total)
      throw new Error("history_export_projection_identity_changed");
    scope.projection = page.projection;
    scope.source_available = page.projection.source_available;
    scope.has_pending = page.projection.has_pending;
    scope.total = page.total;
    scope.pages++;
  }
  private async refreshDerivedAvailability(runId: string, scope: DerivedExportScope, options: HistoryQueryOptions): Promise<void> {
    const status = await this.history.query({ kind: "projection_status", run_id: runId }, options);
    if (options.signal?.aborted || performance.now() >= options.deadlineHostMs)
      throw new Error("history_export_cancelled_or_deadline");
    scope.source_available = status.source_available;
    scope.has_pending = scope.projection === null || scope.projection.source_through < status.source_available ||
      status.published?.has_pending === true;
    if (scope.projection) scope.projection = { ...scope.projection,
      source_available: status.source_available, has_pending: scope.has_pending };
  }
  save(runId: string, queryOptions?: HistoryQueryOptions): Promise<string> {
    if (this.closed) return Promise.reject(new Error("evidence_observer_closed"));
    const work = this.saveCompact(runId, queryOptions);
    this.exports.add(work);
    void work.then(() => this.exports.delete(work), () => this.exports.delete(work));
    return work;
  }
  private async saveCompact(runId: string, queryOptions?: HistoryQueryOptions) {
    const options = this.queryOptions(queryOptions), name = `run-${runId}-evidence.json`;
    const file = await open(path.join(this.directory, name), "wx", 0o600);
    let bytes = 0, firstProperty = true;
    const overflow = new Error("compact_evidence_exceeds_declared_json_bound");
    const emit = async (text: string) => {
      const size = Buffer.byteLength(text);
      if (bytes + size > this.caps.reportJsonBytes) throw overflow;
      await file.writeFile(text); bytes += size;
    };
    const property = async (key: string) => {
      await emit(`${firstProperty ? "" : ","}${JSON.stringify(key)}:`);
      firstProperty = false;
    };
    const scalar = async (key: string, value: unknown) => {
      await property(key); await emit(JSON.stringify(value));
    };
    const array = async (key: string, values: Iterable<unknown>) => {
      await property(key); await emit("[");
      let first = true;
      for (const value of values) { await emit(`${first ? "" : ","}${JSON.stringify(value)}`); first = false; }
      await emit("]");
    };
    const pageMetadata: Record<string, unknown> = {};
    let objectiveScope = unknownDerivedScope();
    let unfinished: { collection: string; next_after: HistoryExportCursor; page_index: number; total: number | null } | null = null;
    try {
      await emit("{");
      await scalar("classification", "private_actual_provider_evidence_not_gameplay_strategy");
      unfinished = { collection: "run", next_after: { record_index: 0, chunk_index: 0 }, page_index: 0, total: null };
      const run = await this.exportPage(runId, "run", unfinished.next_after, 1, options);
      unfinished = { ...unfinished, total: run.total };
      if (object(run.records[0]).kind === "json_record_chunk") throw overflow;
      await scalar("run", run.records[0] ?? null);
      await scalar("original_run_baseline", object(run.records[0]).baseline ?? null);
      pageMetadata.run = { ...run, records: undefined };
      unfinished = null;
      for (const collection of ["sources", "policies", "executions", "objective_metrics", "events", "traces"] as const) {
        if (collection === "objective_metrics") {
          unfinished = { collection, next_after: { record_index: 0, chunk_index: 0 }, page_index: 0, total: null };
          objectiveScope = await this.derivedScope(runId, options);
          if (objectiveScope.status === "unavailable") {
            await scalar(collection, null);
            pageMetadata[collection] = { ...objectiveScope, next_after: { record_index: 0, chunk_index: 0 },
              has_more: null, logical_records: null, omitted_records: null };
            unfinished = null;
            continue;
          }
        }
        const verifier = new ArchiveRecordVerifier(collection);
        await property(collection); await emit("[");
        let after: HistoryExportCursor = { record_index: 0, chunk_index: 0 };
        let logicalRecords = 0, first = true, pages = 0, omissions = 0, total = 0, hasMore = true;
        const recordCap = collection === "events" ? this.caps.reportEventPages * this.caps.eventPageRecords :
          collection === "traces" ? this.caps.reportTracePages * this.caps.tracePageRecords : Infinity;
        // A permitted record counts only after its final chunk, so its continuation
        // keeps the same allowance and deadline rather than stopping at a transport page.
        while (hasMore && logicalRecords < recordCap) {
          unfinished = { collection, next_after: after, page_index: pages, total: pages ? total : null };
          const page = await this.exportPage(runId, collection, after, Math.min(100, recordCap - logicalRecords), options,
            collection === "objective_metrics" ? objectiveScope.projection!.generation : undefined);
          if (collection === "objective_metrics") this.acceptDerivedPage(objectiveScope, page);
          unfinished = { ...unfinished, total: page.total };
          verifier.accept(page.records, page.total);
          for (const record of page.records) {
            await emit(`${first ? "" : ","}${JSON.stringify(record)}`); first = false;
            const chunk = object(record);
            if (chunk.kind !== "json_record_chunk" || Number(chunk.chunk_index) + 1 === chunk.chunk_count) logicalRecords++;
          }
          after = page.next_after; hasMore = page.has_more; total = page.total; pages++; omissions += page.omissions.length;
          unfinished = { collection, next_after: after, page_index: pages, total };
        }
        verifier.finish();
        if (collection === "objective_metrics") objectiveScope.complete = !hasMore;
        if (collection === "traces") this.omissions.trace_pages = hasMore ? 1 : 0;
        pageMetadata[collection] = { ...(collection === "objective_metrics" ? objectiveScope : {}),
          next_after: after, has_more: hasMore, total, pages, logical_records: logicalRecords, omitted_records: omissions,
          omission_details: omissions ? "Cursor-indexed reasons and byte counts are in the separately bounded private journal export pages." : null };
        await emit("]");
        unfinished = null;
      }
      unfinished = { collection: "trace_budget", next_after: { record_index: 0, chunk_index: 0 }, page_index: 0, total: null };
      const traceBudget = await this.exportPage(runId, "trace_budget", unfinished.next_after, 1, options);
      unfinished = { ...unfinished, total: traceBudget.total };
      if (object(traceBudget.records[0]).kind === "json_record_chunk") throw overflow;
      await scalar("trace_budget", traceBudget.records[0] ?? null);
      pageMetadata.trace_budget = { ...traceBudget, records: undefined };
      unfinished = null;
      await array("actions", this.actionCache.get(runId)?.values() ?? []);
      await array("actual_assistant_tool_calls", this.toolCalls.filter(call => call.run_id === runId));
      await array("actual_tool_failures", this.toolFailures.filter(failure => failure.run_id === runId));
      await array("measured_intervals", this.intervals(runId, performance.now()));
      await property("observed_event_monotonic_clocks"); await emit("[");
      let firstClock = true;
      for (const sequence of this.observedEventSequences.get(runId) ?? []) {
        if (!this.clocks.has(sequence)) continue;
        await emit(`${firstClock ? "" : ","}${JSON.stringify({ event_seq: sequence,
          observed_monotonic_ms: this.clocks.get(sequence), clock_id: this.clockId })}`);
        firstClock = false;
      }
      await emit("]");
      await scalar("summary", await this.summary(runId, options));
      await scalar("omissions", this.omissions);
      await this.refreshDerivedAvailability(runId, objectiveScope, options);
      Object.assign(pageMetadata.objective_metrics as object, objectiveScope);
      await scalar("history_export", { schema_version: 1, collections: pageMetadata,
        record_chunk_encoding: "Concatenate json_record_chunk.text by chunk_index, verify UTF-8 sha256, then JSON.parse; record_index/count identify logical collection records.",
        consistency: "Raw collection pages are separate readonly snapshots, not a multi-page transaction. Objective metrics are pinned to the declared completed projection generation; pending source work is not included." });
      await scalar("model_source_policy", "Actual provider tool calls only; evaluator never supplies gameplay or guard bodies");
      await scalar("limitations", ["Host admissions are not wire attempts; subscription monetary cost is unknown.",
        "Only same-process monotonic spans are combined.",
        "Store traces have independent omission caps; the private journal observes authorized capability data before those caps.",
        "Compact omission and complete private journal allowances are separate; private evidence failures stop the attempt.",
        "No causal improvement, promotion or gameplay-efficiency claim is inferred."]);
      await emit("}");
    } catch (error) {
      if (error !== overflow) {
        this.journal(runId).append("readonly_history_compact_export_failed", {
          schema_version: 1, cursor: unfinished, reason: error instanceof Error ? error.message : "history_query_failed" });
        this.journal(runId).markIncomplete("private_history_export_query_failed");
        await file.truncate(0);
        const failed = JSON.stringify({ run_id: runId, omission: "history_query_failed", cursor: unfinished,
          private_journal: this.journal(runId).journal, history_export: { collections: { objective_metrics: objectiveScope } } });
        if (Buffer.byteLength(failed) <= this.caps.reportJsonBytes) await file.write(failed, 0, "utf8");
        throw error;
      }
      await file.truncate(0);
      const fallback = JSON.stringify({ run_id: runId, omission: overflow.message, cursor: unfinished, private_journal: this.journal(runId).journal,
        limitation: "Use the separately bounded private journal and manifest; this compact export is incomplete.",
        history_export: { collections: { objective_metrics: objectiveScope } }, summary: await this.summary(runId, options) });
      if (Buffer.byteLength(fallback) > this.caps.reportJsonBytes)
        throw new Error("compact_evidence_summary_exceeds_declared_json_bound");
      await file.write(fallback, 0, "utf8");
    } finally { await file.close(); }
    return name;
  }
  finalize(runId: string, input: { status: string; reason: string }, queryOptions?: HistoryQueryOptions): Promise<JournalFinalization> {
    const existing = this.finalizations.get(runId);
    if (existing) return existing;
    const journal = this.journal(runId), options = this.queryOptions(queryOptions);
    const work = (async () => {
      let unfinished: { collection: string; next_after: HistoryExportCursor; page_index: number; total: number | null } | null = null;
      let objectiveScope = unknownDerivedScope();
      try {
        await this.initialize(runId, options);
        for (const collection of ["run", "sources", "policies", "executions", "trace_budget", "objective_metrics", "events", "traces"] as const) {
          if (collection === "objective_metrics") {
            unfinished = { collection, next_after: { record_index: 0, chunk_index: 0 }, page_index: 0, total: null };
            objectiveScope = await this.derivedScope(runId, options);
            if (objectiveScope.status === "unavailable") {
              if (!journal.append("readonly_history_export_collection", { schema_version: 1, collection,
                ...objectiveScope, next_after: { record_index: 0, chunk_index: 0 }, has_more: null,
                logical_records: null, omitted_records: null }))
                throw new Error("private_history_export_append_failed");
              await journal.drain();
              unfinished = null;
              continue;
            }
          }
          let after: HistoryExportCursor = { record_index: 0, chunk_index: 0 };
          let pages = 0, hasMore = true, total: number | null = null;
          unfinished = { collection, next_after: after, page_index: 0, total };
          const verifier = new ArchiveRecordVerifier(collection);
          while (hasMore) {
            const page = await this.exportPage(runId, collection, after, 100, options,
              collection === "objective_metrics" ? objectiveScope.projection!.generation : undefined);
            if (collection === "objective_metrics") this.acceptDerivedPage(objectiveScope, page);
            unfinished = { collection, next_after: after, page_index: pages, total: page.total };
            const before = after;
            after = page.next_after; hasMore = page.has_more; total = page.total; pages++;
            verifier.accept(page.records, page.total);
            if (!journal.append("readonly_history_export_page", { schema_version: 1, collection,
              after: before, page_index: pages - 1,
              snapshot: collection === "objective_metrics" ? "pinned_completed_projection_generation" : "one_readonly_query_not_a_multi_page_transaction", payload: page }))
              throw new Error("private_history_export_append_failed");
            await journal.drain();
            if (page.omissions.length) throw new Error("private_history_export_records_omitted");
            unfinished = { collection, next_after: after, page_index: pages, total };
          }
          verifier.finish();
          if (collection === "objective_metrics") objectiveScope.complete = !hasMore;
          if (!journal.append("readonly_history_export_collection", { schema_version: 1, collection,
            ...(collection === "objective_metrics" ? objectiveScope : {}),
            pages, next_after: after, total, has_more: hasMore, complete: true }))
            throw new Error("private_history_export_append_failed");
          await journal.drain();
        }
        await this.refreshDerivedAvailability(runId, objectiveScope, options);
      } catch (error) {
        journal.append("readonly_history_export_incomplete", { schema_version: 1, cursor: unfinished,
          reason: error instanceof Error ? error.message : "history_query_failed" });
        journal.markIncomplete("private_history_export_incomplete");
      }
      const finalization = { ...input, history_export: { schema_version: 1,
        collections: { objective_metrics: objectiveScope },
        consistency: "Objective metrics describe only their declared completed projection generation, not pending source changes. Raw pages retain separate readonly snapshots." } };
      return journal.finalize(finalization);
    })();
    this.finalizations.set(runId, work);
    return work;
  }
  close(queryOptions?: HistoryQueryOptions): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeTrace();
    for (const unsubscribe of this.agentSubscriptions) unsubscribe();
    this.restoreAuthFactory?.();
    this.restoreAuthFactory = null;
    const options = this.queryOptions(queryOptions);
    this.closing = (async () => {
      const failures: unknown[] = [];
      try {
        await Promise.allSettled(this.exports);
        for (const [runId] of this.journals) {
          try {
            await this.finalize(runId, { status: "interrupted", reason: "observer_closed_without_prior_finalization" }, options);
          } catch (error) { failures.push(error); }
        }
      } finally {
        try { await this.history.close(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Evidence observer shutdown failed");
    })();
    return this.closing;
  }
}
