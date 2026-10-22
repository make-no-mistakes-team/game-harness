import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { ActivityEvent } from "../shared/contracts.ts";
import type { TraceRecord } from "../shared/execution-evidence.ts";
import type { Store } from "../server/store.ts";
import type { Runtime } from "../server/runtime.ts";
import type { AuthManager } from "../server/auth.ts";
import { objectiveMetrics } from "../server/objective-metrics.ts";
import type { EvaluationCaps } from "./contracts.ts";
import type { GoalAction } from "./scenarios.ts";
import { actionMetrics, usageMetrics, type ActionMetrics, type MeasuredInterval, type ReportedUsage, type UsageMetrics, type WaitCategory } from "./results.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const counter = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
interface OpenSpan { run_id: string; start_ms: number; category: WaitCategory }
interface ToolObservation { run_id: string; name: string; tool_call_id: string; arguments: unknown; arguments_sha256: string; omission: string | null }
export interface EvidenceSummary {
  usage: UsageMetrics;
  actions: ActionMetrics;
  tools: Array<{ name: string }>;
  provider_error: boolean;
  provider_settled: boolean;
  confirmed_harness_faults: string[];
  unclassified_tool_failures: boolean;
  observer_error: string | null;
  omissions: Record<string, number>;
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
  private readonly providerFailures = new Set<string>();
  private readonly stopRequested = new Set<string>();
  constructor(readonly store: Store, readonly directory: string, readonly caps: EvaluationCaps,
    readonly clockId: string, private readonly stop: (runId: string, reason: string) => void) {
    this.unsubscribe = store.subscribe(event => {
      if (!event.run_id) return;
      try { this.observeEvent(event); }
      catch {
        this.observerError = "production_evidence_observer_failed";
        stop(event.run_id, "production_evidence_observer_failed");
      }
    });
  }
  bindRuntime(runtime: Runtime) { this.runtime = runtime; }
  private omit(key: string) { this.omissions[key] = (this.omissions[key] ?? 0) + 1; }
  private observeEvent(event: ActivityEvent) {
    const runId = event.run_id!, data = object(event.details), now = performance.now();
    if (event.type.startsWith("action.") && typeof data.action_id === "string") {
      const action = this.store.getAction(runId, data.action_id);
      if (action) {
        let actions = this.actionCache.get(runId);
        if (!actions) { actions = new Map(); this.actionCache.set(runId, actions); }
        actions.set(data.action_id, { ...action, run_id: runId });
      }
    }
    if (this.clocks.size < this.caps.reportEventPages * this.caps.eventPageRecords) this.clocks.set(event.event_seq, now);
    else this.omit("event_monotonic_clocks");
    const close = (key: string) => {
      const span = this.open.get(key);
      if (span) { this.completed.push({ ...span, end_ms: now, clock_id: this.clockId }); this.open.delete(key); }
    };
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
      if (event.type === "model.request_unsettled" || data.stop_reason === "error") {
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
      const runId = this.runtime?.snapshot()?.run_id;
      if (runId && !this.closed) this.observeAgent(agent, runId);
      return agent;
    };
    this.restoreAuthFactory = () => { auth.createAgent = original; };
  }
  private observeAgent(agent: Agent, runId: string) {
    this.agentSubscriptions.push(agent.subscribe(event => {
      if (event.type === "tool_execution_end" && event.isError) {
        const details = object(object(event.result).details), error = object(details.error);
        this.toolFailures.push({ run_id: runId, tool: event.toolName, tool_call_id: event.toolCallId,
          code: typeof error.code === "string" ? error.code : null });
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
  events(runId: string): ActivityEvent[] {
    const events: ActivityEvent[] = [];
    let cursor = 0;
    for (let page = 0; page < this.caps.reportEventPages; page++) {
      const batch = this.store.eventsAfter(runId, cursor, this.caps.eventPageRecords);
      events.push(...batch);
      if (batch.length < this.caps.eventPageRecords) return events;
      const next = batch.at(-1)!.event_seq;
      if (next <= cursor) throw new Error("Durable event cursor did not advance");
      cursor = next;
    }
    this.omissions.events = this.store.eventsAfter(runId, cursor, 1).length ? 1 : 0;
    return events;
  }
  trace(runId: string): TraceRecord[] {
    const traces: TraceRecord[] = [];
    let cursor = 0;
    for (let page = 0; page < this.caps.reportTracePages; page++) {
      const value = this.store.tracePage(runId, cursor, this.caps.tracePageRecords);
      traces.push(...value.records);
      if (!value.has_more) return traces;
      if (value.next_after <= cursor) throw new Error("Durable trace cursor did not advance");
      cursor = value.next_after;
    }
    this.omissions.trace_pages = 1;
    return traces;
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
    finally { this.completed.push({ run_id: runId, start_ms: start, end_ms: performance.now(), category, clock_id: this.clockId }); }
  }
  intervals(runId: string, endMs: number): MeasuredInterval[] {
    // An unclosed span is not attributed beyond observed settlement: that remainder is unknown.
    this.omissions.unclosed_intervals = [...this.open.values()].filter(span => span.start_ms < endMs).length;
    return this.completed.filter(span => span.run_id === runId);
  }
  summary(runId: string): EvidenceSummary {
    const events = this.events(runId);
    const admitted = events.filter(event => event.type === "model.call");
    const reported = events.filter(event => event.type === "model.usage");
    const messages: ReportedUsage[] = reported.map(event => {
      const data = object(event.details);
      return { uncached_input: counter(data.uncached_input_tokens), cache_read: counter(data.cache_read_tokens),
        cache_write: counter(data.cache_write_tokens), output: counter(data.output_tokens) };
    });
    const usageIds = new Set(reported.map(event => object(event.details).request_id).filter(id => typeof id === "string"));
    const settlements = events.filter(event => event.type === "model.request_settled");
    const settledIds = new Set(settlements.filter(event => !["aborted", "error"].includes(String(object(event.details).stop_reason))).map(event => object(event.details).request_id));
    const allReported = !this.omissions.events && admitted.every(event => {
      const id = object(event.details).request_id;
      return typeof id === "string" && usageIds.has(id);
    });
    const failures = this.toolFailures.filter(failure => failure.run_id === runId);
    const expected: Record<string, true> = { invalid_request: true, precondition_failed: true, stale_context: true,
      deadline_exceeded: true, not_found: true, conflict: true, validation_failed: true, budget_exceeded: true };
    const faults = failures.some(failure => failure.code === "backend_unavailable") ? ["tool_backend_unavailable"] : [];
    const unclassified = failures.some(failure => failure.code === null || !Object.hasOwn(expected, failure.code) && failure.code !== "backend_unavailable");
    return { usage: usageMetrics(this.count(runId), messages, allReported), actions: actionMetrics(this.actions(runId)),
      tools: events.filter(event => event.type === "model.tool_started").flatMap(event => { const name = object(event.details).tool; return typeof name === "string" ? [{ name }] : []; }),
      provider_error: settlements.some(event => object(event.details).stop_reason === "error"),
      provider_settled: admitted.length > 0 && !this.omissions.events && admitted.every(event => settledIds.has(object(event.details).request_id)),
      confirmed_harness_faults: faults, unclassified_tool_failures: unclassified, observer_error: this.observerError, omissions: { ...this.omissions } };
  }
  async save(runId: string) {
    const events = this.events(runId), traces = this.trace(runId), sources = this.store.skills(runId);
    const name = `run-${runId}-evidence.json`;
    const value = { classification: "private_actual_provider_evidence_not_gameplay_strategy", run: this.runtime?.getRun(runId), original_run_baseline: this.store.getRun(runId)?.baseline,
      sources, policies: this.store.policies(runId), executions: this.store.allSkillExecutions(runId), events, traces,
      trace_budget: this.store.tracePage(runId, 0, 1).budget, objective_metrics: objectiveMetrics(this.store, runId), actions: this.actions(runId),
      actual_assistant_tool_calls: this.toolCalls.filter(call => call.run_id === runId),
      actual_tool_failures: this.toolFailures.filter(failure => failure.run_id === runId),
      measured_intervals: this.intervals(runId, performance.now()),
      observed_event_monotonic_clocks: events.filter(event => this.clocks.has(event.event_seq)).map(event => ({ event_seq: event.event_seq, observed_monotonic_ms: this.clocks.get(event.event_seq), clock_id: this.clockId })),
      summary: this.summary(runId), omissions: this.omissions,
      model_source_policy: "Actual provider tool calls only; evaluator never supplies gameplay or guard bodies",
      limitations: ["Host admissions are not wire attempts; subscription monetary cost is unknown.", "Only same-process monotonic spans are combined.",
        "Full traces remain in the private durable Store if report bounds omit pages.", "No causal improvement, promotion or gameplay-efficiency claim is inferred."] };
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text) > this.caps.reportJsonBytes) {
      // Preserve original evidence in Store; never silently truncate or rewrite model source.
      await writeFile(path.join(this.directory, name), JSON.stringify({ run_id: runId, omission: "full_evidence_exceeds_declared_json_bound", durable_store_retains_originals: true, summary: this.summary(runId) }, null, 2), { mode: 0o600, flag: "wx" });
    } else await writeFile(path.join(this.directory, name), text, { mode: 0o600, flag: "wx" });
    return name;
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    for (const unsubscribe of this.agentSubscriptions) unsubscribe();
    this.restoreAuthFactory?.();
    this.restoreAuthFactory = null;
  }
}
