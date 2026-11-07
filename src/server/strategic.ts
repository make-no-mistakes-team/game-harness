import { randomUUID } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type {
  ActionView,
  ActivityEvent,
  Json,
  ObservationV3,
  PolicyView,
  RuntimeAdapter,
  RunPauseCause,
  UsagePurpose,
} from "../shared/contracts.ts";
import type { AdapterActorProjection } from "../shared/observations.ts";
import type { AuthManager } from "./auth.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { Store, StoredRun } from "./store.ts";
import { recordCall, recordUsage } from "./usage.ts";
import { ProviderUsageCollector } from "./provider-usage.ts";
import type { SpeculativePlanning } from "./speculative-planning.ts";
import { isToolAllowed, type ToolRole } from "../shared/tool-policy.ts";
import { ProgramWorkspace } from "./program-workspace.ts";
import type { HistoryQueryOptions } from "./history-protocol.ts";
import type { ModelObservation } from "./actor-frames.ts";
import { StrategicContext } from "./strategic-context.ts";
import { jsonSchema } from "../shared/validation.ts";
import { preserveRuntimeToolArguments } from "./runtime-tools.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";
import { controllerEventSchema } from "../shared/resident.ts";

const COALESCE_MS = 100;
type ResidentAttentionOmission = { count: number; after_event_seq: number; through_event_seq: number };
const EMPTY_COOLDOWN_MS = 5_000;
const MAX_EMPTY_TURNS = 3;
const TURN_MS = 120_000;
const TURN_CALLS = 12;
const TOOL_CALLS = 48;
const AUTHORING_CALLS = 3;
const AUTHORING_TOOLS = 12;
const AUTHORING_MS = 60_000;
const AUTHORING_CANCELLATION_REASONS = new Set(["root_settled", "scope_lost", "root_replaced", "deadline", "calls", "tools", "fenced"]);
const FEEDBACK_BYTES = 8 * 1024;
const PROGRAM_PENDING =
  "A program is meaningful pending work; strategy waits for its outcome";
const PROVIDER_FAILURE =
  "The strategic model request could not complete. Check authorization and provider availability, then resume the paused run.";
// The installed SDK can promote completed arguments from a transient failed
// stream to toolUse. That recovery marker is still a failed provider response,
// not permission to dispatch its tools or retain its requested knowledge.
const RECOVERED_PROVIDER_FAILURE = "stream_interrupted_after_content";
const MEANINGFUL_WAKES: Record<string, true> = {
  policy_replan: true,
  policy_interrupt: true,
  policy_error: true,
  trial_decision_due: true,
  selected_attention: true,
  resident_attention: true,
  skill_outcome: true,
  planning_continuation: true,
  speculative_lookahead: true,
  death: true,
  uncertainty: true,
  goal_review: true,
};
function pendingDecisionWake(reason: string): boolean {
  return reason !== "planning_continuation" && reason !== "speculative_lookahead" &&
    Object.hasOwn(MEANINGFUL_WAKES, reason);
}
const FEEDBACK_TYPES: Record<string, true> = {
  "skill.closed": true,
  "skill.progress": true,
  "controller.event": true,
  "policy.trial_decision_due": true,
  "policy.effect": true,
  "policy.stale_result": true,
  "goal.verified": true,
  "action.failed": true,
  "action.unknown": true,
  "action.cancelled": true,
  "model.tool_rejected": true,
  "player.death": true,
  "planning.rejected": true,
  "planning.stage_rejected": true,
  "improvement.opportunity": true,
  "runtime.uncertainty": true,
  "runtime.uncertainty_reconciled": true,
  "runtime.uncertainty_blocked": true,
};

/** Optional host governance at the actual request/transport ownership boundary. */
export interface StrategicRequestAdmission {
  reserve(requestId: string, model: { id: string; provider: string; api: string }): void;
  transportEnded(requestId: string, closed: boolean): void;
  drained(requestIds: readonly string[]): void;
}

export interface StrategicHost {
  run(): StoredRun | null;
  generation(): number;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  tools(generation: number): AgentTool[];
  rootPrompt(): string;
  adapter?(): RuntimeAdapter;
  observe(): Promise<ObservationV3>;
  modelObservation?(): Promise<ModelObservation>;
  projectObservation(observation: ObservationV3, previous: ObservationV3 | null): AdapterActorProjection;
  policies(): PolicyView[];
  action(): ActionView | null;
  programPending(): boolean;
  busy(): boolean;
  persist(summary?: string): void;
  pause(message: string, cause: RunPauseCause): void;
  terminal(status: "completed" | "failed", message: string): void;
  speculation?(): SpeculativePlanning;
  reviewContext?(options: HistoryQueryOptions): Promise<Json>;
  reviewComplete?(): void;
  requestAdmission?: StrategicRequestAdmission;
}

interface RequestAttempt {
  id: string;
  startedMono: number;
  usage: ProviderUsageCollector;
  purpose: UsagePurpose;
  index: number;
  planId: string | null;
  review: boolean;
  role: "speculative" | "review" | "recovery" | "planning" | "authoring";
  authoring: AuthoringWindow | null;
  terminalReceived: boolean;
  hostCancellation?: {
    kind: "ordinary_authoring";
    request_id: string;
    root_execution_id: string;
    reason: string;
  } | {
    kind: "strategic_host";
    request_id: string;
    reason: "fenced" | "speculative_preempted" | "turn_deadline";
  };
}

type AbortIntent = {
  kind: "ordinary_authoring";
  window: AuthoringWindow;
  reason: string;
} | {
  kind: "strategic_host";
  reason: "fenced" | "speculative_preempted" | "turn_deadline";
};

interface AuthoringWindow {
  run: StoredRun;
  generation: number;
  root: string;
  scope: string;
  source: string;
  deadline: number;
  calls: number;
  tools: number;
  closed: string | null;
}

function record(value: Json): { [key: string]: Json } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function feedbackEntry(event: ActivityEvent, workspace: ProgramWorkspace): Json {
  // Durable evidence may include full observations, program arguments or action
  // results. Ordinary strategy receives references and selected scalar facts;
  // Named evidence inspection remains the authorized route to original records.
  const details = record(event.details);
  const selected: { [key: string]: Json } = {};
  if (event.type === "controller.event") {
    const authored = controllerEventSchema.safeParse(details?.event);
    if (authored.success) {
      // Preserve authored attention as data, never as the scheduler routing key.
      // Large details remain inspectable in Store without displacing the
      // summary or defeating the existing whole-turn feedback allowance.
      const omitted = Buffer.byteLength(JSON.stringify(authored.data.details)) > 4096;
      selected.event = { ...authored.data, details: omitted ? null : authored.data.details,
        ...(omitted ? { details_omitted: true } : {}) };
    }
  }
  for (const key of [
    "version",
    "status",
    "kind",
    "reason",
    "actions",
    "calls",
    "evaluations",
    "effects",
    "tool",
    "goal",
    "observation_seq",
    "neutralized",
    "workers_closed",
    "no_replay",
    "summary",
  ]) {
    const value = details?.[key];
    if (typeof value === "string") selected[key] = value.slice(0, 300);
    else if (typeof value === "number" || typeof value === "boolean")
      selected[key] = value;
  }
  const executionId = typeof details?.execution_id === "string" ? details.execution_id :
    typeof details?.root_execution_id === "string" ? details.root_execution_id : null;
  const reference = executionId ? workspace.executionReference(executionId) : null;
  if (reference) {
    selected.name = reference.name;
    selected.version = reference.version;
    selected.execution_ordinal = reference.execution_ordinal;
  } else if (typeof details?.skill_id === "string" && typeof details.version === "number") {
    const program = workspace.programReference({ skill_id: details.skill_id, version: details.version });
    if (program.name !== null) selected.name = program.name;
  }
  const error = details && record(details.error ?? null);
  if (error) {
    selected.error = {
      code:
        typeof error.code === "string" ? error.code.slice(0, 80) : "unknown",
      message:
        typeof error.message === "string"
          ? error.message.slice(0, 300)
          : "Tool rejected",
    };
    if (Array.isArray(error.issues)) (selected.error as { [key: string]: Json }).issues = error.issues.slice(0, 8);
  }
  const diagnostic = details?.diagnostic ?? (details ? record(details.details ?? null)?.diagnostic : null);
  if (diagnostic) selected.diagnostic = diagnostic;
  return {
    event_seq: event.event_seq,
    type: event.type,
    summary: event.summary.slice(0, 500),
    details: selected,
  };
}

/** Owns the authenticated strategist, not gameplay or run lifecycle authority. */
export class StrategicPlanner {
  private agent: Agent | null = null;
  private unsubscribeAgent: (() => void) | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private turn: Promise<void> | null = null;
  private fenced = true;
  private fenceRevision = 0;
  private turnCalls = 0;
  private turnDelivered = 0;
  private turnToolCalls = 0;
  private turnDeadline = 0;
  private historyController: AbortController | null = null;
  private providerFailed = false;
  private providerAborted = false;
  private gateReason: string | null = null;
  private authoring: AuthoringWindow | null = null;
  private authoringTimer: NodeJS.Timeout | undefined;
  private turnAuthoring: AuthoringWindow | null = null;
  private authoringEnded = false;
  private authoringPhase = false;
  private pendingDecision = false;
  private emptyTurns = 0;
  private workRevision = 0;
  private contextCursor = 0;
  private residentAttention = new Map<number, ActivityEvent>();
  private residentAttentionConsumed = 0;
  private residentAttentionOmitted: ResidentAttentionOmission | null = null;
  private previousObservation: ObservationV3 | null = null;
  private purpose: UsagePurpose = "planning";
  private role: RequestAttempt["role"] = "planning";
  private request: RequestAttempt | null = null;
  private readonly responseOwners = new Map<string, string>();
  private readonly admittedRequests = new Set<string>();
  private readonly streamDrains = new Map<string, { drained: Promise<void>; close(): Promise<unknown> }>();
  private wakeReasons = new Set<string>();
  private wakeTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private attentionTimer: NodeJS.Timeout | undefined;
  private attentionReason: string | null = null;
  private speculativeTurn = false;
  private readonly retainedContext: StrategicContext;
  private contextObservation: Pick<ObservationV3, "profile_id" | "profile_configuration_hash"> | null = null;
  private readonly eligibleTools = new Map<string, { name: string; arguments: unknown; authority?: () => void }>();

  constructor(
    private readonly store: Store,
    private readonly auth: AuthManager,
    private readonly host: StrategicHost,
  ) {
    this.retainedContext = new StrategicContext(store);
  }

  reset(): void {
    if (this.agent || this.opening || this.turn || this.closing)
      throw new RuntimeFault(
        "conflict",
        "Drain the previous strategic agent before resetting a run",
      );
    this.fence();
    this.turnCalls = 0;
    this.turnDelivered = 0;
    this.turnToolCalls = 0;
    this.turnDeadline = 0;
    this.providerFailed = false;
    this.providerAborted = false;
    this.gateReason = null;
    this.authoring = null;
    this.turnAuthoring = null;
    this.authoringEnded = false;
    this.authoringPhase = false;
    this.pendingDecision = false;
    this.emptyTurns = 0;
    this.workRevision = 0;
    this.contextCursor = 0;
    this.residentAttention.clear();
    this.residentAttentionConsumed = 0;
    this.residentAttentionOmitted = null;
    this.previousObservation = null;
    this.purpose = "planning";
    this.role = "planning";
    this.request = null;
    this.responseOwners.clear();
    this.retainedContext.reset();
    this.contextObservation = null;
    this.eligibleTools.clear();
  }

  async start(generation: number): Promise<void> {
    // Retaining an old provider request while replacing its Agent would give
    // two request owners. Release its entire authenticated scope first.
    const closure = this.close();
    const revision = this.fenceRevision;
    await closure;
    if (revision !== this.fenceRevision)
      throw new RuntimeFault(
        "stale_context",
        "Strategic startup was superseded",
      );
    const run = this.host.assertCurrent(generation);
    this.fenced = false;
    const opening = (async () => {
      const agent = await this.auth.createAgent({
        modelId: run.model_id,
        systemPrompt: [this.host.rootPrompt()],
        tools: this.host.tools(generation).filter((tool) => isToolAllowed(this.toolRole(), tool.name)),
      });
      this.agent = agent;
      if (!this.current(run, generation))
        throw new RuntimeFault(
          "stale_context",
          "Strategic startup authority was revoked",
        );
      this.host.assertCurrent(generation);
      const stream = agent.streamFn;
      // Agent snapshots its raw interceptor before the admission gate runs.
      // Bind at the supported stream invocation boundary instead: this closure
      // captures one admitted request, never a mutable latest-request pointer.
      agent.streamFn = async (model, context, options) => {
        const request = this.request;
        if (!request) throw new RuntimeFault("stale_context", "No admitted strategic request owns this stream");
        if (request.authoring) this.assertAuthoring(request.authoring);
        const adapter = this.host.adapter?.();
        this.retainedContext.synchronize(run, model, context, this.contextObservation, adapter);
        // This is the final supported SDK stream boundary, including tool-loop
        // continuations. Supplement the actual request, not the disposable
        // Agent's history or a host-only reference cache.
        const requestContext = {
          ...context,
          systemPrompt: [...(context.systemPrompt ?? []), this.retainedContext.assemble(run, adapter, this.authoringProjection())],
        };
        let firstResponse = false;
        const events = await stream(model, requestContext, { ...options,
          onPayload: async (payload, payloadModel, signal) => {
            const replacement = await options?.onPayload?.(payload, payloadModel, signal);
            const sent = record((replacement ?? payload) as Json);
            const reasoning = record(sent?.reasoning ?? null);
            if (this.request?.id === request.id) this.store.event(run.run_id, "model.request_configuration",
              "Supported SDK payload hook observed the final request configuration, not provider-effective reasoning",
              { request_id: request.id, source: "sdk_transformed_payload",
                clock_id: HOST_MONOTONIC_CLOCK_ID, prepared_monotonic_ms: performance.now(),
                model: typeof sent?.model === "string" ? sent.model.slice(0, 120) : null,
                reasoning_effort: typeof reasoning?.effort === "string" &&
                  /^(none|minimal|low|medium|high|xhigh|max)$/.test(reasoning.effort) ? reasoning.effort : null,
                reasoning_field_present: sent !== null && Object.hasOwn(sent, "reasoning") });
            return replacement;
          },
          onSseEvent: (event, eventModel) => {
            request.usage.observe(event, eventModel ?? model);
            if (this.request?.id === request.id) {
              let payload: { [key: string]: Json } | null = null;
              if (event.data.length <= 65536) {
                try { payload = record(JSON.parse(event.data)); } catch { /* Provider text is not diagnostic content. */ }
              }
              const response = record(payload?.response ?? null);
              const responseId = typeof response?.id === "string" ? response.id : null;
              const owner = responseId === null ? undefined : this.responseOwners.get(responseId);
              const outbound = payload?.type === "response.create" || event.raw.some(line => line.startsWith(": ws →"));
              const received = !outbound && (owner === undefined || owner === request.id);
              if (received && !firstResponse) {
                firstResponse = true;
                const receivedMono = performance.now();
                this.store.event(run.run_id, "model.first_response_event", "First received provider SSE event; internal latency components remain unknown",
                  { request_id: request.id, event_type: typeof payload?.type === "string" &&
                    /^[a-zA-Z0-9._-]{1,100}$/.test(payload.type) ? payload.type : null,
                    clock_id: HOST_MONOTONIC_CLOCK_ID, received_monotonic_ms: receivedMono,
                    request_elapsed_ms: receivedMono - request.startedMono,
                    observation_point: "complete_received_sse_event", raw_first_byte_monotonic_ms: null });
              }
              if (received && owner === request.id &&
                ["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(payload?.type))) {
                const usage = record(response?.usage ?? null);
                if (usage) {
                  const output = record(usage.output_tokens_details ?? null), input = record(usage.input_tokens_details ?? null);
                  const counter = (value: Json | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
                  this.store.event(run.run_id, "model.response_usage_details", "Optional raw provider counters; absent counters remain unknown",
                    { request_id: request.id, reasoning_tokens: counter(output?.reasoning_tokens),
                      cached_input_tokens: counter(input?.cached_tokens) });
                }
              }
            }
            options?.onSseEvent?.(event, eventModel);
          } });
        const admission = this.host.requestAdmission;
        if (admission) {
          const iterator = events[Symbol.asyncIterator]();
          const drained = Promise.withResolvers<void>();
          void drained.promise.catch(() => {});
          const finished = { done: true as const, value: undefined };
          let exhausted = false, reported = false, closed = false, closing = false;
          let pending: Awaited<ReturnType<typeof iterator.next>> | undefined;
          let closeWork: Promise<typeof finished> | undefined;
          const finish = (natural: boolean) => {
            if (reported) return;
            admission.transportEnded(request.id, natural);
            reported = true;
            drained.resolve();
          };
          const closeIterator = () => {
            if (closeWork) return closeWork;
            closing = true;
            closeWork = (async () => {
              try {
                if (!exhausted) {
                  if (!iterator.return) throw new RuntimeFault("backend_unavailable", "Strategic stream has no confirmable iterator closure");
                  const termination = await iterator.return();
                  if (!termination.done) throw new RuntimeFault("backend_unavailable", "Strategic iterator return did not confirm closure");
                }
                closed = true;
                finish(false);
                return finished;
              } catch (error) { drained.reject(error); throw error; }
            })();
            return closeWork;
          };
          const ownedIterator = {
            async next() {
              if (closed || closing) return finished;
              try {
                const next = pending ?? await iterator.next();
                pending = undefined;
                if (next.done) {
                  exhausted = true;
                  closed = true;
                  if (!closing) finish(true);
                  return next;
                }
                if (!closing && (next.value.type === "done" || next.value.type === "error")) {
                  // The SDK returns on a terminal event without requesting
                  // next.done. Observe actual iterator exhaustion first.
                  const tail = await iterator.next();
                  if (tail.done) {
                    exhausted = true;
                    closed = true;
                    if (!closing) finish(true);
                  } else {
                    pending = tail;
                  }
                }
                return next;
              } catch (error) {
                await closeIterator();
                throw error;
              }
            },
            return: closeIterator,
          };
          // Ownership exists before next(): returning an unstarted lazy
          // generator would otherwise skip its body and every finally block.
          events[Symbol.asyncIterator] = () => ownedIterator;
          this.streamDrains.set(request.id, { drained: drained.promise, close: closeIterator });
        }
        return events;
      };
      const selectPhase = () => {
        this.authoringPhase = run.status !== "reviewing" && !this.speculativeTurn &&
          this.host.programPending() && !this.pendingDecision;
        agent.setTools(this.host.tools(generation).filter(tool => isToolAllowed(this.toolRole(), tool.name)));
      };
      // setTools inside the admission gate is too late for this SDK: its
      // provider context has already been normalized. Refresh the live catalog
      // at the supported synchronization hook, after the previous tool group.
      const unsubscribePhase = agent.addBeforeModelCallHook((signal) => {
        if (!signal?.aborted && this.current(run, generation)) selectPhase();
      });
      agent.setBeforeModelCall((_context, signal) => {
        const stop = (reason: string) => {
          this.gateReason = reason;
          return { stop: true as const, reason };
        };
        if (signal?.aborted || !this.current(run, generation))
          return stop("Run authority revoked");
        try {
          this.host.assertCurrent(generation);
        } catch {
          return stop("Run authority revoked");
        }
        if (this.providerFailed || this.providerAborted)
          return stop("The previous provider response failed; no continuation is authorized");
        const review = run.status === "reviewing";
        // Admission may arm a window inside program_submit/run. Only the next
        // SDK request boundary changes phase, after that tool group returned.
        selectPhase();
        const toolRole = this.toolRole();
        if (this.speculativeTurn && !this.host.speculation?.().requestCall())
          return stop("Finite lookahead request authority reached");
        const authoring = toolRole === "authoring" ? this.reconcileAuthoring() : null;
        if (this.authoringEnded) return stop("The root-bound authoring window ended");
        if (toolRole === "authoring" && (!authoring || authoring.closed))
          return stop(PROGRAM_PENDING);
        if (authoring && (authoring.calls >= AUTHORING_CALLS || authoring.tools >= AUTHORING_TOOLS)) {
          this.endAuthoring(authoring, authoring.calls >= AUTHORING_CALLS ? "calls" : "tools", false);
          return stop("Finite root-bound authoring allowance reached");
        }
        if (
          this.turnCalls >= (review ? 3 : TURN_CALLS) ||
          this.turnToolCalls >= (review ? 12 : TOOL_CALLS) ||
          Date.now() >= this.turnDeadline
        )
          return stop("Finite strategic call allowance reached");
        this.gateReason = null;
        const requestId = randomUUID();
        try { this.host.requestAdmission?.reserve(requestId, agent.state.model); }
        catch { return stop("The finite registered study request allowance or ownership gate refused admission"); }
        if (this.host.requestAdmission) this.admittedRequests.add(requestId);
        if (authoring) {
          authoring.calls++;
          this.turnAuthoring = authoring;
        }
        this.pendingDecision = false;
        this.turnCalls++;
        run.turns++;
        this.request = {
          id: requestId,
          startedMono: performance.now(),
          usage: new ProviderUsageCollector(requestId, this.responseOwners),
          purpose: authoring ? "authoring" : this.purpose,
          index: this.turnCalls,
          planId: this.speculativeTurn ? this.host.speculation?.().projection()?.plan_id ?? null : null,
          review,
          role: authoring ? "authoring" : this.role,
          authoring,
          terminalReceived: false,
        };
        recordCall(run.usage, this.request.purpose);
        this.store.event(
          run.run_id,
          "model.call",
          "Strategic model inference started",
          {
            turn: run.turns,
            generation,
            request_id: this.request.id,
            clock_id: HOST_MONOTONIC_CLOCK_ID,
            started_monotonic_ms: this.request.startedMono,
            request_id_source: "host",
            request_index: this.request.index,
            provider_request_id: null,
            purpose: this.request.purpose,
            purpose_source: "host_turn_role_v1",
            purpose_final: false,
            role: this.request.role,
            speculative_plan_id: this.request.planId,
            read_only_review: review,
          },
        );
        this.host.persist();
      });
      agent.beforeToolCall = (context, signal) => {
        preserveRuntimeToolArguments(context);
        const window = this.request?.authoring;
        const obsoleteAuthoring = Boolean(window && (this.reconcileAuthoring() !== window || window.closed));
        if (!obsoleteAuthoring && context.assistantMessage?.stopDetails?.type === RECOVERED_PROVIDER_FAILURE)
          this.providerFailed = true;
        if (signal?.aborted || !this.current(run, generation) || obsoleteAuthoring || this.authoringEnded || this.providerFailed || this.providerAborted ||
          context.assistantMessage && !["stop", "toolUse"].includes(context.assistantMessage.stopReason))
          return {
            block: true,
            reason: "This strategic turn has no remaining tool authority",
          };
        if (
          ++this.turnToolCalls > (run.status === "reviewing" ? 12 : TOOL_CALLS) ||
          Date.now() >= this.turnDeadline
        )
          return {
            block: true,
            reason: "This strategic turn has no remaining tool authority",
          };
        try {
          this.host.assertCurrent(generation);
          if (this.speculativeTurn)
            this.host.speculation?.().assertToolAuthority(context.tool.name);
          const role = this.toolRole();
          if (!isToolAllowed(role, context.tool.name))
            throw new RuntimeFault("invalid_request", "Tool is not authorized for the current role");
          if (this.authoringEnded)
            throw new RuntimeFault("stale_context", "The root-bound authoring window ended");
          if (role === "authoring") {
            const window = this.reconcileAuthoring();
            if (!window || window.closed)
              throw new RuntimeFault("stale_context", "No live root-bound authoring authority");
            if (window.tools >= AUTHORING_TOOLS) {
              this.endAuthoring(window, "tools", false);
              throw new RuntimeFault("stale_context", "Finite root-bound authoring tool allowance reached");
            }
            window.tools++;
            this.turnAuthoring = window;
          }
        } catch {
          return {
            block: true,
            reason: "This strategic turn has no remaining tool authority",
          };
        }
      };
      const unsubscribeEvents = agent.subscribe((event) =>
        this.agentEvent(event, run, generation),
      );
      this.unsubscribeAgent = () => { unsubscribeEvents(); unsubscribePhase(); };
    })();
    this.opening = opening;
    try {
      await opening;
    } catch (error) {
      if (this.opening === opening) this.opening = null;
      await this.close();
      throw error instanceof RuntimeFault
        ? error
        : new RuntimeFault(
            "backend_unavailable",
            "The authenticated strategic agent could not be prepared",
          );
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  /** Capture before async tool preparation; call again immediately before commit. */
  speculativeToolAuthority(): () => void {
    const revision = this.fenceRevision;
    const deadline = this.turnDeadline;
    const run = this.host.run();
    const generation = this.host.generation();
    const speculation = this.speculativeTurn ? this.host.speculation?.() : undefined;
    const permit = speculation?.authority();
    const authoring = this.authoringPhase && !speculation && run?.status !== "reviewing" && this.host.programPending()
      ? this.reconcileAuthoring() : null;
    const requiresAuthoring = this.authoringPhase && !speculation && run?.status !== "reviewing";
    return () => {
      if (requiresAuthoring && (!authoring || this.reconcileAuthoring() !== authoring || authoring.closed))
        throw new RuntimeFault("stale_context", "Root-bound authoring authority was revoked");
      if (!run || revision !== this.fenceRevision || Date.now() >= deadline || !this.current(run, generation))
        throw new RuntimeFault("stale_context", "Strategic tool authority was revoked");
      permit?.();
    };
  }

  /** Shared catalog/dispatch phase; an exhausted pending root stays restricted. */
  toolRole(): ToolRole {
    if (this.host.run()?.status === "reviewing") return "review";
    if (this.speculativeTurn) return "speculative";
    this.reconcileAuthoring();
    return this.authoringPhase && this.host.programPending() ? "authoring" : "ordinary";
  }

  private authoringScope(run: StoredRun): string {
    return JSON.stringify([run.run_id, run.world_id, run.session_id, run.epoch, run.life_id,
      run.native_boot_id, run.space_epoch, run.compatibility_hash]);
  }

  /** Query only at existing admission, request, tool, result and wake seams. */
  private reconcileAuthoring(): AuthoringWindow | null {
    const run = this.host.run(), generation = this.host.generation();
    const root = run ? this.store.latestRootExecution(run.run_id) : null;
    const previous = this.authoring;
    const scope = run ? this.authoringScope(run) : "";
    const valid = run && this.current(run, generation) && run.status === "running" && this.host.programPending() &&
      root && root.entry !== null && root.parent_execution_id === null && root.root_execution_id === root.execution_id &&
      ["accepted", "running"].includes(root.status) && root.run_generation === generation &&
      root.world_id === run.world_id && root.session_id === run.session_id && root.epoch === run.epoch &&
      root.life_id === run.life_id && root.native_boot_id === run.native_boot_id && root.space_epoch === run.space_epoch &&
      root.compatibility_hash === run.compatibility_hash && root.source_hash !== null;
    if (previous && !previous.closed) {
      const reason = !valid ? (root && !["accepted", "running"].includes(root.status) ? "root_settled" : "scope_lost")
        : previous.run !== run || previous.generation !== generation || previous.scope !== scope ? "scope_lost"
          : previous.root !== root.execution_id || previous.source !== root.source_hash ? "root_replaced"
            : Date.now() >= previous.deadline ? "deadline" : null;
      if (reason) this.endAuthoring(previous, reason);
    }
    if (!valid) return null;
    // Retain the latch for the same actual root even after a scope change,
    // repeated leaf admissions, intent changes, or inactive source revisions.
    if (previous?.run === run && previous.root === root.execution_id) return previous;
    const window: AuthoringWindow = { run, generation, root: root.execution_id, scope, source: root.source_hash!,
      deadline: Math.min(Date.now() + AUTHORING_MS,
        Date.parse(root.deadline_at) - root.limits.duration_ms + AUTHORING_MS, Date.parse(root.deadline_at),
        this.turn && this.turnDeadline ? this.turnDeadline : Infinity),
      calls: 0, tools: 0, closed: null };
    this.authoring = window;
    this.store.event(run.run_id, "scheduler.authoring_entered", "Finite inactive authoring window bound to the current foreground root", {
      root_execution_id: window.root, source_hash: window.source, generation,
      max_calls: AUTHORING_CALLS, max_tools: AUTHORING_TOOLS, deadline_at: new Date(window.deadline).toISOString(),
      calls: 0, tools: 0, reason: "foreground_root",
    });
    this.authoringTimer = setTimeout(() => this.endAuthoring(window, "deadline"), Math.max(1, window.deadline - Date.now()));
    if (Date.now() >= window.deadline) this.endAuthoring(window, "deadline");
    return window;
  }

  private endAuthoring(window: AuthoringWindow, reason: string, abort = true): void {
    if (window.closed) return;
    window.closed = reason;
    if (this.authoring === window) {
      clearTimeout(this.authoringTimer);
      this.authoringTimer = undefined;
    }
    this.store.event(window.run.run_id, "scheduler.authoring_exited", "Root-bound authoring ended without changing foreground execution authority", {
      root_execution_id: window.root, source_hash: window.source, generation: window.generation,
      reason, calls: window.calls, tools: window.tools, remaining_ms: Math.max(0, window.deadline - Date.now()),
    });
    if (this.turnAuthoring === window || this.request?.authoring === window) {
      this.authoringEnded = true;
      if (abort) this.abortRequest({ kind: "ordinary_authoring", window, reason });
    }
  }

  private abortRequest(intent: AbortIntent, agent = this.agent): void {
    const request = this.request;
    const window = intent.kind === "ordinary_authoring" ? intent.window : request?.authoring;
    const rootReason = intent.kind === "ordinary_authoring" ? intent.reason
      : intent.reason === "turn_deadline" ? "deadline" : intent.reason === "fenced" ? "fenced" : null;
    if (intent.kind === "strategic_host" && window && rootReason)
      this.endAuthoring(window, rootReason, false);
    // Own the exact admitted request before abort(), which may synchronously
    // deliver its terminal callback. Neither repeats nor terminal reconciliation
    // can replace the first actual cancellation cause.
    if (agent && request && !request.terminalReceived && !request.hostCancellation) {
      if (window && request.authoring === window && request.role === "authoring" &&
          rootReason && AUTHORING_CANCELLATION_REASONS.has(rootReason))
        request.hostCancellation = { kind: "ordinary_authoring", request_id: request.id,
          root_execution_id: window.root, reason: rootReason };
      else if (intent.kind === "strategic_host" && !request.authoring)
        request.hostCancellation = { kind: "strategic_host", request_id: request.id, reason: intent.reason };
    }
    agent?.abort();
  }

  private assertAuthoring(window: AuthoringWindow): void {
    if (this.reconcileAuthoring() !== window || window.closed)
      throw new RuntimeFault("stale_context", "Root-bound authoring authority was revoked");
  }

  private finishAuthoringBudget(): void {
    const window = this.turnAuthoring;
    if (window && !window.closed && (window.calls >= AUTHORING_CALLS || window.tools >= AUTHORING_TOOLS))
      this.endAuthoring(window, window.calls >= AUTHORING_CALLS ? "calls" : "tools", false);
  }

  private authoringProjection() {
    if (this.toolRole() !== "authoring") return undefined;
    const window = this.reconcileAuthoring();
    const root = window ? this.store.skillExecution(window.run.run_id, { execution_id: window.root }) : null;
    const source = root && window ? this.store.skill(window.run.run_id, root) : null;
    return {
      phase: "authoring" as const,
      root: source ? { name: source.name, version: source.version, hash: window!.source } : null,
      remaining_calls: window && !window.closed ? Math.max(0, AUTHORING_CALLS - window.calls) : 0,
      remaining_tools: window && !window.closed ? Math.max(0, AUTHORING_TOOLS - window.tools) : 0,
      remaining_ms: window && !window.closed ? Math.max(0, window.deadline - Date.now()) : 0,
      instruction: "Foreground work continues unchanged. Within this one finite root-bound window, observe, help, program_inspect and program_write may prepare immutable inactive source. Write saves/validates only; no submit, run, activation, prepare_next, task_finish, reflex, memory or review. No polling or keepalive. Exhaustion waits for the root outcome; later wakes and leaf admissions do not renew this window.",
    };
  }

  admitted(): void {
    this.workRevision++;
    this.emptyTurns = 0;
    this.reconcileAuthoring();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.host.programPending()) {
      // Leaf admission is progress within the same foreground root, not a new
      // authoring allowance or permission to discard queued outcome/attention.
      if (this.wakeReasons.size) this.schedule();
      else {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
      }
    }
  }

  attentionAfter(ms: number, reason: string): void {
    if (
      !Number.isInteger(ms) ||
      ms < 1_000 ||
      ms > 600_000 ||
      !reason.trim() ||
      reason.length > 300
    )
      throw new RuntimeFault(
        "invalid_request",
        "Attention requires a finite 1000–600000ms delay and a reason of at most 300 characters",
      );
    const run = this.host.run();
    const generation = this.host.generation();
    if (!run || !this.current(run, generation))
      throw new RuntimeFault(
        "stale_context",
        "Strategic attention authority is closed",
      );
    clearTimeout(this.attentionTimer);
    this.attentionTimer = setTimeout(() => {
      this.attentionTimer = undefined;
      if (!this.current(run, generation)) return;
      this.attentionReason = reason;
      this.wake("selected_attention");
    }, ms);
  }

  wake(reason: string): void {
    const run = this.host.run();
    if (!run || !this.current(run, this.host.generation())) return;
    this.reconcileAuthoring();
    if (this.host.programPending() && !Object.hasOwn(MEANINGFUL_WAKES, reason))
      return;
    if (reason === "resident_attention") {
      // SkillManager persists the authored event synchronously before waking us.
      // Keep the trigger independently of the ordinary oldest-first Store page.
      const event = this.store.latestEvent(run.run_id, "controller.event");
      const authored = controllerEventSchema.safeParse(record(event?.details ?? null)?.event);
      if (event && event.event_seq > this.residentAttentionConsumed &&
          authored.success && authored.data.kind === "attention") {
        this.residentAttention.set(event.event_seq, event);
        if (this.residentAttention.size > 32) {
          const first = this.residentAttention.keys().next().value!;
          this.residentAttention.delete(first);
          const omitted = this.residentAttentionOmitted;
          this.residentAttentionOmitted = {
            count: (omitted?.count ?? 0) + 1,
            after_event_seq: omitted?.after_event_seq ?? first - 1,
            through_event_seq: first,
          };
        }
      }
    }
    if (this.speculativeTurn && reason !== "speculative_lookahead" && reason !== "planning_continuation" &&
        Object.hasOwn(MEANINGFUL_WAKES, reason)) {
      // Ordinary outcome/replan demand is never held behind optional lookahead.
      // Drain the cancelled request through the same serialized agent owner.
      this.host.speculation?.().invalidate("cancelled");
      this.abortRequest({ kind: "strategic_host", reason: "speculative_preempted" });
    }
    if (this.wakeReasons.size < 32) this.wakeReasons.add(reason.slice(0, 160));
    if (Object.hasOwn(MEANINGFUL_WAKES, reason)) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.schedule();
  }

  fence(): void {
    this.fenced = true;
    this.fenceRevision++;
    this.historyController?.abort();
    clearTimeout(this.wakeTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.attentionTimer);
    this.wakeTimer = undefined;
    this.idleTimer = undefined;
    this.attentionTimer = undefined;
    this.attentionReason = null;
    this.wakeReasons.clear();
    if (this.authoring) this.endAuthoring(this.authoring, "fenced");
    clearTimeout(this.authoringTimer);
    this.authoringTimer = undefined;
    this.host.speculation?.().invalidate("cancelled");
    this.abortRequest({ kind: "strategic_host", reason: "fenced" });
  }

  close(): Promise<void> {
    this.fence();
    if (this.closing) return this.closing;
    const opening = this.opening;
    const closure = (async () => {
      // A cancelled createAgent may still return an allocated auth scope. It
      // publishes that scope before rejecting, so drain creation before release.
      if (opening) await opening.catch(() => {});
      const agent = this.agent;
      const settlements = await Promise.allSettled([
        agent?.waitForIdle(),
        this.turn,
      ]);
      let released = !agent;
      if (agent) {
        try {
          await this.auth.releaseAgent(agent);
          released = true;
        } catch {
          // Keep ownership for a later Stop retry; never install a replacement.
        }
      }
      const streamWork: Promise<unknown>[] = [];
      for (const stream of this.streamDrains.values()) streamWork.push(stream.close(), stream.drained);
      const streamSettlements = await Promise.allSettled(streamWork);
      if (released) {
        this.unsubscribeAgent?.();
        this.unsubscribeAgent = null;
        this.agent = null;
      }
      if (
        !released ||
        settlements.some((result) => result.status === "rejected") ||
        streamSettlements.some((result) => result.status === "rejected")
      )
        throw new RuntimeFault(
          "backend_unavailable",
          "Strategic request shutdown could not be confirmed; admission remains fenced",
        );
      if (this.admittedRequests.size) {
        this.host.requestAdmission?.drained([...this.admittedRequests]);
        this.admittedRequests.clear();
      }
      this.streamDrains.clear();
    })();
    this.closing = closure;
    void closure
      .finally(() => {
        if (this.closing === closure) this.closing = null;
      })
      .catch(() => {});
    return closure;
  }

  private current(run: StoredRun, generation: number): boolean {
    return (
      !this.fenced &&
      this.host.run() === run &&
      generation === this.host.generation() &&
      (run.status === "running" || run.status === "reviewing")
    );
  }

  private schedule(): void {
    if (
      this.turn ||
      this.wakeTimer ||
      this.idleTimer ||
      !this.agent ||
      !this.wakeReasons.size ||
      this.fenced
    )
      return;
    const window = this.reconcileAuthoring();
    if (this.host.programPending() && (!window || window.closed) &&
        !this.wakeReasons.has("speculative_lookahead") && ![...this.wakeReasons].some(pendingDecisionWake))
      return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      const run = this.host.run();
      const generation = this.host.generation();
      if (this.turn || !this.agent || !run || !this.current(run, generation))
        return;
      if (
        this.host.programPending() &&
        ![...this.wakeReasons].some((reason) =>
          Object.hasOwn(MEANINGFUL_WAKES, reason),
        )
      ) {
        this.wakeReasons.clear();
        return;
      }
      const turn = this.strategicTurn(run, generation, this.agent);
      this.turn = turn;
      void turn
        .catch(() => {
          if (this.current(run, generation)) this.host.pause(PROVIDER_FAILURE, "safety");
        })
        .finally(() => {
          if (this.turn === turn) this.turn = null;
          this.schedule();
        })
        .catch(() => {});
    }, COALESCE_MS);
  }

  private async strategicTurn(
    run: StoredRun,
    generation: number,
    agent: Agent,
  ): Promise<void> {
    const review = run.status === "reviewing";
    const phase = run.status, fenceRevision = this.fenceRevision;
    const window = this.reconcileAuthoring();
    const reasons = this.host.programPending() && (!window || window.closed) && this.wakeReasons.has("speculative_lookahead") &&
      ![...this.wakeReasons].some(pendingDecisionWake)
      ? ["speculative_lookahead"] : [...this.wakeReasons];
    for (const reason of reasons) this.wakeReasons.delete(reason);
    const lookaheadOnly = reasons.length > 0 && reasons.every((reason) => reason === "speculative_lookahead");
    if (!review && !lookaheadOnly) {
      const continuation = await this.host.speculation?.().pendingActivation();
      if (!this.current(run, generation) || run.status !== phase || this.fenceRevision !== fenceRevision) return;
      if (continuation?.state === "activated" && reasons.every((reason) => reason === "planning_continuation"))
        return;
    }
    // Replans/outcomes always win; overlap is one intentional independent path,
    // never an extra ordinary pending-work inference allowance.
    const speculative = !review &&
      reasons.includes("speculative_lookahead") &&
      reasons.every((reason) => reason === "speculative_lookahead")
      ? this.host.speculation?.().begin() ?? null
      : null;
    if (reasons.includes("speculative_lookahead") && !speculative) {
      this.host.speculation?.().invalidate("cancelled");
      if (reasons.every((reason) => reason === "speculative_lookahead")) {
        this.store.event(run.run_id, "scheduler.lookahead_skipped", "Optional lookahead demand had no eligible flight; ordinary replan allowances are unchanged", {
          phase: run.status,
          reason: review ? "review" : "draft_not_available",
        });
        return;
      }
    }
    this.speculativeTurn = speculative !== null;
    this.pendingDecision = !review && !speculative && this.host.programPending() && reasons.some(pendingDecisionWake);
    this.turnAuthoring = !this.pendingDecision && !review && !speculative && window && !window.closed ? window : null;
    this.authoringEnded = false;
    this.authoringPhase = false;
    const attention = reasons.includes("selected_attention")
      ? this.attentionReason
      : null;
    this.role = review ? "review" : speculative ? "speculative"
      : reasons.some((reason) => ["policy_replan", "policy_interrupt", "policy_error", "death", "uncertainty"].includes(reason))
        ? "recovery" : "planning";
    this.purpose = review
      ? "improvement"
      : speculative ? "planning"
        : this.role === "recovery" ? "replanning" : "planning";
    const turnId = randomUUID();
    const revision = this.workRevision;
    this.turnCalls = 0;
    this.turnDelivered = 0;
    this.turnToolCalls = 0;
    this.providerFailed = false;
    this.providerAborted = false;
    this.gateReason = null;
    this.request = null;
    this.turnDeadline = speculative
        ? Date.now() + (this.host.speculation?.().remainingMs() ?? 0)
        : Date.now() + (review ? 30_000 : TURN_MS);
    const historyController = new AbortController();
    this.historyController = historyController;
    const historyOptions: HistoryQueryOptions = {
      signal: historyController.signal,
      deadlineHostMs: performance.now() + Math.max(0, this.turnDeadline - Date.now()),
    };
    run.model_status = "thinking";
    this.host.persist();
    this.store.event(
      run.run_id,
      "scheduler.turn_started",
      "Serialized strategic turn started automatically",
      {
        turn_id: turnId,
        generation,
        reasons,
        speculative_plan_id: speculative?.plan_id ?? null,
        read_only_review: review,
      },
    );
    let deadlineReached = false;
    const timer = setTimeout(
      () => {
        deadlineReached = true;
        historyController.abort();
        this.store.event(
          run.run_id,
          "model.deadline",
          "Host strategic time allowance reached; provider cancellation requested",
          {
            turn_id: turnId,
          },
        );
        this.abortRequest({ kind: "strategic_host", reason: "turn_deadline" }, agent);
      },
      Math.max(1, this.turnDeadline - Date.now()),
    );
    let through = this.contextCursor;
    let selectedAttention: ActivityEvent[] = [];
    let attentionOmission: ResidentAttentionOmission | null = null;
    let projectedObservation: ObservationV3 | null = null;
    let prompting = false;
    let preparingHistory = false;
    try {
      const selected = this.host.modelObservation ? await this.host.modelObservation() :
        { observation: await this.host.observe(), images: [], image_metadata: { mode: "disabled" } };
      const observation = selected.observation;
      if (!this.current(run, generation) || run.status !== phase || this.fenceRevision !== fenceRevision) return;
      this.host.assertCurrent(generation, observation.epoch);
      if (observation.world_id !== run.world_id)
        throw new RuntimeFault(
          "stale_context",
          "Strategic observation belongs to another world",
        );
      if (Date.now() >= this.turnDeadline) deadlineReached = true;
      const candidates = this.store.eventsAfter(
        run.run_id,
        this.contextCursor,
        500,
      );
      if (this.role === "planning" && reasons.includes("skill_outcome") &&
          candidates.some((event) => event.type === "action.failed" || event.type === "action.unknown" ||
            (event.type === "skill.closed" &&
              ["failed", "blocked", "unknown"].includes(String(record(event.details)?.status))))) {
        this.role = "recovery";
        this.purpose = "replanning";
      }
      through =
        candidates[candidates.length - 1]?.event_seq ?? this.contextCursor;
      selectedAttention = [...this.residentAttention.values()];
      attentionOmission = this.residentAttentionOmitted;
      const selectedSequences = new Set(candidates.map(event => event.event_seq));
      for (const event of selectedAttention)
        if (!selectedSequences.has(event.event_seq)) candidates.push(event);
      const feedback: Json[] = [];
      const workspace = new ProgramWorkspace(this.store, run.run_id);
      const omitted: number[] = [];
      let bytes = 0;
      for (const event of candidates) {
        if (!Object.hasOwn(FEEDBACK_TYPES, event.type)) continue;
        if (event.type === "controller.event") {
          const authored = controllerEventSchema.safeParse(record(event.details)?.event);
          if (!authored.success || authored.data.kind !== "attention" ||
              event.event_seq <= this.residentAttentionConsumed ||
              (attentionOmission && event.event_seq > attentionOmission.after_event_seq &&
                event.event_seq <= attentionOmission.through_event_seq)) continue;
        }
        const entry = feedbackEntry(event, workspace);
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > FEEDBACK_BYTES) omitted.push(event.event_seq);
        else {
          feedback.push(entry);
          bytes += size;
        }
      }
      const previous = this.previousObservation;
      const projection = this.host.projectObservation(observation,
        previous && previous.world_id === observation.world_id && previous.session_id === observation.session_id &&
          previous.life.life_id === observation.life.life_id && previous.epoch === observation.epoch &&
          previous.space.space_epoch === observation.space.space_epoch ? previous : null);
      this.contextObservation = { profile_id: observation.profile_id, profile_configuration_hash: observation.profile_configuration_hash };
      projectedObservation = observation;
      this.store.event(
        run.run_id,
        "scheduler.context_selected",
        "Bounded filtered evidence selected; omitted records remain available through program_inspect",
        {
          turn_id: turnId,
          observation_seq: observation.observation_seq,
          through_event_seq: through,
          included_event_count: feedback.length,
          omitted_event_refs: omitted,
          omitted_resident_attention: attentionOmission,
        },
      );
      const action = this.host.action();
      let reviewContext: Json = null;
      if (review && this.host.reviewContext && !deadlineReached) {
        preparingHistory = true;
        reviewContext = await this.host.reviewContext(historyOptions);
        if (!this.current(run, generation) || run.status !== phase ||
          this.fenceRevision !== fenceRevision || historyController.signal.aborted && !deadlineReached) return;
        this.host.assertCurrent(generation, observation.epoch);
        if (Date.now() >= this.turnDeadline || performance.now() >= historyOptions.deadlineHostMs)
          deadlineReached = true;
        preparingHistory = false;
      }
      if (!deadlineReached) {
        const selectedTools = this.host.tools(generation)
          .filter((tool) => isToolAllowed(this.toolRole(), tool.name));
        agent.setTools(selectedTools);
        if (speculative) {
          this.store.event(run.run_id, "scheduler.speculative_tools_selected", "Configured the actual speculative agent catalog to read-only evidence and staging; dispatch authority is checked independently", {
            plan_id: speculative.plan_id,
            tools: selectedTools.map((tool) => tool.name),
          });
        }
        prompting = true;
        await agent.prompt(
          JSON.stringify({
            reason: reasons,
            attention,
            phase: run.status,
            role: this.role,
            task: run.task,
            image_metadata: selected.image_metadata,
            life: { status: observation.life.status, can_respawn: observation.life.can_respawn,
              death: observation.life.death ? { at: observation.life.death.at, message: observation.life.death.message } : null },
            speculative_plan: workspace.planningView(speculative),
            pending_decision: this.pendingDecision,
            pending_authoring: this.authoringProjection(),
            improvement_review: reviewContext,
            adapter_state: projection.state,
            adapter_metadata: projection.metadata,
            observation_summary: projection.summary,
            observation_seq: observation.observation_seq,
            current_action: action
              ? {
                  kind: action.kind,
                  status: action.status,
                  origin: action.origin,
                  summary: action.summary.slice(0, 500),
                }
              : null,
            policies: this.host
              .policies()
              .filter(
                (policy) =>
                  policy.state === "trial" || policy.state === "active",
              )
              .map((policy) => ({
                version: policy.version,
                backend: policy.backend,
                name: policy.name.slice(0, 160),
                state: policy.state,
                priority: policy.priority,
                effects: policy.effects,
                last_error: policy.last_error?.slice(0, 300) ?? null,
              })),
            programs: workspace.catalog(0, 12),
            executions: this.store.skillExecutions(run.run_id).slice(0, 8).map((execution) => ({
              ...workspace.executionSummary(execution),
              summary: (execution.result?.summary ?? execution.error)?.slice(0, 500) ?? null,
            })),
            feedback,
            omitted_event_refs: omitted,
            omitted_resident_attention: attentionOmission,
            through_event_seq: through,
            instruction: review
              ? "The goal is verified. Perform one bounded effect-free review: inspect evidence, record keep/insufficient_evidence, or program_write a linked revision with reason. A candidate is not proven improvement. No gameplay trials or effects. Completion follows automatically."
              : speculative
                ? "This is the one authorized independent planning flight. Observe, inspect, help and prepare_next only. Select an existing named candidate; optionally author guard_source BODY(observation,args) returning strict boolean. Omission adds no game constraint. No source writes, starts, activation, effects or polling. Corrections share the original finite deadline. Main's captured permission and all host invariants govern activation."
              : this.host.programPending()
                ? this.pendingDecision
                  ? "Respond to this explicit attention/outcome/recovery signal using ordinary decision authority, including any necessary current-root intent update or stop. This does not renew the root's inactive authoring allowance. Later natural SDK continuation while the root remains pending is restricted to the remaining pure authoring window; no polling or duplicate foreground work."
                  : "The foreground program continues unchanged. Use only observe, help, program_inspect and pure program_write to prepare immutable inactive source within the remaining root-bound authoring allowance. No starts, activation, effects, polling or keepalive; repeated wakes do not renew the window."
                : "Advance the task using current evidence. Choose useful bounded work, react to trial evidence, or explain a genuine obstacle. No human continuation is needed.",
          }), selected.images,
        );
      }
      if (Date.now() >= this.turnDeadline) deadlineReached = true;
    } catch (error) {
      if (!this.current(run, generation) || run.status !== phase || this.fenceRevision !== fenceRevision) return;
      if (Date.now() >= this.turnDeadline || performance.now() >= historyOptions.deadlineHostMs)
        deadlineReached = true;
      if (this.current(run, generation) && !deadlineReached) {
        if (prompting && !this.authoringEnded) this.providerFailed = true;
        else if (prompting) { /* Host authoring cancellation is not a provider outage. */ }
        else if (preparingHistory) {
          this.store.event(run.run_id, "runtime.history_query_failed",
            "Readonly review history could not be prepared; no provider request was made", {
              provider_request_made: false,
              error: error instanceof Error ? error.message.slice(0, 500) : "History query failed",
            });
          run.model_status = "idle";
          this.host.pause("Readonly review history preparation failed; inspect retained evidence before resuming", "preparation_failed");
          return;
        }
        else {
          this.store.event(run.run_id, "runtime.model_observation_failed", "Authorized model observation could not be prepared; no provider request was made", { provider_request_made: false });
          run.model_status = "idle";
          this.host.pause("Authorized model image/observation preparation failed; inspect platform evidence before resuming", "observation_unavailable");
        }
      }
    } finally {
      clearTimeout(timer);
      historyController.abort();
      if (this.historyController === historyController) this.historyController = null;
      this.finishUnsettledRequest(run);
      this.finishAuthoringBudget();
      // Confirm authoring transport release before the queued root outcome can
      // obtain this single owner. This never touches the playing root.
      if (this.authoringEnded) {
        const drains = [...this.streamDrains.values()];
        await Promise.all(drains.flatMap(stream => [stream.close(), stream.drained]));
      }
      if (speculative) this.host.speculation?.().finish(speculative.plan_id);
      this.speculativeTurn = false;
      this.authoringPhase = false;
      this.pendingDecision = false;
      if (speculative) agent.setTools(this.host.tools(generation)
        .filter((tool) => isToolAllowed(this.toolRole(), tool.name)));
      this.eligibleTools.clear();
      // Keep no transcript or old effect authority. Compatible bounded docs
      // and fresh Store projections are owned outside this temporary Agent.
      agent.replaceMessages([]);
    }
    if (!this.current(run, generation)) return;
    if (review) {
      run.model_status = "idle";
      this.store.event(run.run_id, "scheduler.review_finished", "Bounded effect-free post-goal review settled; candidates are not measured improvements", {
        calls: this.turnCalls, tools: this.turnToolCalls,
        deadline_reached: deadlineReached, provider_failed: this.providerFailed,
      });
      this.host.persist();
      this.host.reviewComplete?.();
      return;
    }
    if (speculative) {
      if (this.providerFailed || deadlineReached || this.providerAborted)
        this.host.speculation?.().invalidate(deadlineReached ? "deadline" : "cancelled");
      run.model_status = "idle";
      this.store.event(run.run_id, "scheduler.lookahead_finished", "Bounded independent lookahead settled without consuming normal replan feedback", {
        plan_id: speculative.plan_id, calls: this.turnCalls, tools: this.turnToolCalls,
        deadline_reached: deadlineReached, provider_failed: this.providerFailed,
      });
      this.host.persist();
      return;
    }
    if (
      this.providerFailed || this.providerAborted ||
      !this.authoringEnded && deadlineReached
    ) {
      const pauseCause: RunPauseCause = deadlineReached ? "deadline" : this.providerAborted ? "provider_aborted" : "provider_failure";
      run.model_status = "error";
      this.store.event(
        run.run_id,
        "scheduler.turn_failed",
        "Strategic turn failed or was aborted; selected feedback remains unconsumed and no empty-planning success is recorded",
        {
          turn_id: turnId,
          deadline_reached: deadlineReached,
          provider_failed: this.providerFailed,
          provider_aborted: this.providerAborted,
          pause_cause: pauseCause,
          consumed_event_seq: this.contextCursor,
        },
      );
      this.host.pause(PROVIDER_FAILURE, pauseCause);
      return;
    }
    // A host gate can reject the initial request after observation/admission.
    // Nothing was delivered in that case, so do not consume selected evidence.
    if (this.turnCalls && this.turnDelivered) {
      if (attention !== null && this.attentionReason === attention) this.attentionReason = null;
      this.contextCursor = through;
      const attentionThrough = Math.max(this.residentAttentionConsumed,
        selectedAttention.at(-1)?.event_seq ?? 0, attentionOmission?.through_event_seq ?? 0);
      this.residentAttentionConsumed = attentionThrough;
      for (const sequence of this.residentAttention.keys())
        if (sequence <= attentionThrough) this.residentAttention.delete(sequence);
      if (this.residentAttentionOmitted) {
        const liveOmission = this.residentAttentionOmitted;
        // Overflow can evict records already selected by this in-flight request.
        // A successful request consumed those records too, not just the range
        // that was already omitted when its context was selected.
        const selectedEvictions = selectedAttention.reduce((count, event) => count +
          Number(event.event_seq > liveOmission.after_event_seq && event.event_seq <= liveOmission.through_event_seq), 0);
        const remaining = liveOmission.count - (attentionOmission?.count ?? 0) - selectedEvictions;
        this.residentAttentionOmitted = remaining > 0
          ? { ...liveOmission, count: remaining, after_event_seq: attentionThrough }
          : null;
      }
      this.previousObservation = projectedObservation;
    }
    run.model_status = "idle";
    this.store.event(
      run.run_id,
      "scheduler.turn_finished",
      "Strategic turn settled with complete tool-result groups",
      {
        turn_id: turnId,
        calls: this.turnCalls,
        tools: this.turnToolCalls,
        admitted_work: this.workRevision !== revision,
        authoring_exit: this.authoringEnded ? this.turnAuthoring?.closed ?? "ended" : null,
        consumed_event_seq: this.contextCursor,
      },
    );
    this.host.persist();
    if (this.workRevision !== revision) this.emptyTurns = 0;
    if (this.host.busy() || this.host.programPending()) return;
    // Evidence arriving during inference is already queued for the next turn;
    // do not put a new cooldown in front of that unconsumed demand.
    if (this.wakeReasons.size) return;
    if (this.workRevision === revision) this.emptyTurns++;
    if (this.emptyTurns >= MAX_EMPTY_TURNS) {
      this.store.event(
        run.run_id,
        "scheduler.planning_stalled",
        "Finite consecutive empty-turn allowance exhausted",
        {
          empty_turns: this.emptyTurns,
        },
      );
      this.host.terminal(
        "failed",
        "Planning stalled after three consecutive turns without runnable new work",
      );
      return;
    }
    run.model_status = "waiting";
    this.host.persist();
    this.store.event(
      run.run_id,
      "scheduler.backoff",
      "One bounded idle continuation armed; observations do not poll the model",
      {
        empty_turns: this.emptyTurns,
        cooldown_ms: EMPTY_COOLDOWN_MS,
      },
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.wake("no_runnable_work");
    }, EMPTY_COOLDOWN_MS);
  }

  private finishUnsettledRequest(run: StoredRun): void {
    const request = this.request;
    if (!request) return;
    const endedMono = performance.now();
    this.store.event(
      run.run_id,
      "model.request_unsettled",
      "An admitted provider request ended without a final usage message; usage and provider attempt count remain unknown",
      {
        request_id: request.id,
        clock_id: HOST_MONOTONIC_CLOCK_ID,
        started_monotonic_ms: request.startedMono,
        ended_monotonic_ms: endedMono,
        duration_ms: endedMono - request.startedMono,
        request_index: request.index,
        purpose: request.purpose,
        purpose_source: "host_turn_role_v1",
        purpose_final: false,
        role: request.role,
        speculative_plan_id: request.planId,
        read_only_review: request.review,
        usage_reported: false,
        usage_evidence: request.usage.finish(null) as unknown as Json,
      },
    );
    this.request = null;
  }

  private agentEvent(
    event: AgentEvent,
    run: StoredRun,
    generation: number,
  ): void {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const recoveredFailure = message.stopDetails?.type === RECOVERED_PROVIDER_FAILURE;
      const hostYield =
        message.stopReason === "aborted" &&
        this.gateReason !== null &&
        message.errorMessage === this.gateReason;
      const request = this.request;
      if (request) request.terminalReceived = true;
      // Reconciliation below can itself abort a now-obsolete window. That
      // cannot establish the cause of a terminal response already received.
      const requestedCancellation = request?.hostCancellation;
      const plan = request?.planId ? this.host.speculation?.().projection() : null;
      const window = request?.authoring;
      const obsolete = !this.current(run, generation) ||
        Boolean(window && (this.reconcileAuthoring() !== window || window.closed)) ||
        Boolean(request?.planId && (plan?.plan_id !== request.planId || !plan.planning_active));
      const hostCancellation = message.stopReason === "aborted" &&
        (requestedCancellation?.kind === "strategic_host" || request?.role === "authoring" && obsolete)
        ? requestedCancellation : undefined;
      this.eligibleTools.clear();
      if (!obsolete && !hostYield && !recoveredFailure && ["stop", "toolUse"].includes(message.stopReason)) {
        this.turnDelivered++;
        for (const content of message.content) {
          if (content.type === "toolCall") this.eligibleTools.set(content.id, { name: content.name, arguments: content.arguments,
            ...(window ? { authority: () => this.assertAuthoring(window) } : {}) });
        }
      }
      if (!hostYield && request) {
        // Host workflow roles outrank visible requested tool categories. This is
        // accounting classification, never a claim about hidden intent or cause.
        const toolCalls = message.content.filter((content) => content.type === "toolCall");
        const toolNames = [...new Set(toolCalls.map((content) => content.name))];
        const improvement = toolCalls.some((call) => call.name === "program_review" ||
          (call.name === "program_write" || call.name === "program_submit") && call.arguments && typeof call.arguments === "object" && "based_on" in call.arguments ||
          call.name === "program_inspect" && call.arguments && typeof call.arguments === "object" &&
            (call.arguments.view === "feedback" || call.arguments.view === "comparison"));
        const provisionalPurpose = request.purpose;
        const purpose: UsagePurpose = request.role === "review" ? "improvement"
          : request.role === "speculative" ? "planning"
            : request.role === "recovery" ? "replanning"
              : request.role === "authoring" ? "authoring"
              : improvement
                ? "improvement"
                : toolNames.some((name) => name === "program_write" || name === "program_submit" || name === "reflex")
                  ? "authoring"
                  : "planning";
        if (purpose !== provisionalPurpose) {
          const previous = run.usage.by_purpose[provisionalPurpose];
          const classified = run.usage.by_purpose[purpose];
          if (previous.calls !== null) previous.calls--;
          if (classified.calls === 0 && classified.legacy_input === null) {
            classified.uncached_input = null;
            classified.cache_read = null;
            classified.cache_write = null;
            classified.output = null;
          }
          if (classified.calls !== null) classified.calls++;
          request.purpose = purpose;
        }
        this.store.event(run.run_id, "model.purpose_classified", "Host classified the admitted request from workflow role and visible requested tools; no semantic intent or causality is inferred", {
          request_id: request.id,
          purpose,
          provisional_purpose: provisionalPurpose,
          purpose_source: "host_role_and_tools_v1",
          purpose_final: true,
          role: request.role,
          requested_tools: toolNames.slice(0, TOOL_CALLS),
          omitted_tool_names: Math.max(0, toolNames.length - TOOL_CALLS),
        });
        const evidence = request.usage.finish(message.usage);
        if (message.usage) {
          recordUsage(run.usage, request.purpose, message.usage);
        }
        this.store.event(
            run.run_id,
            "model.usage",
            "SDK-reported subtotal and separately observed terminal accounting evidence; subscription cost is unknown",
            {
              input_tokens: evidence.sdk_reported?.uncached_input ?? null,
              uncached_input_tokens: evidence.sdk_reported?.uncached_input ?? null,
              output_tokens: evidence.sdk_reported?.output ?? null,
              cache_read_tokens: evidence.sdk_reported?.cache_read ?? null,
              cache_write_tokens: evidence.sdk_reported?.cache_write ?? null,
              usage_evidence: evidence as unknown as Json,
              request_id: request.id,
              provider_response_id: message.responseId ?? null,
              purpose: request.purpose,
              purpose_source: "host_role_and_tools_v1",
              purpose_final: true,
              speculative_plan_id: request.planId,
              read_only_review: request.review,
            },
          );
        this.store.event(
          run.run_id,
          "model.request_settled",
          "Admitted strategic provider request settled",
          {
            request_id: request.id,
            clock_id: HOST_MONOTONIC_CLOCK_ID,
            started_monotonic_ms: request.startedMono,
            ended_monotonic_ms: performance.now(),
            request_index: request.index,
            provider_response_id: message.responseId ?? null,
            provider_retry_attempt: message.retryRecovery?.attempt ?? null,
            stop_reason: message.stopReason,
            provider_failure: !hostCancellation && (recoveredFailure || message.stopReason === "error"),
            recovered_failure: recoveredFailure ? {
              type: RECOVERED_PROVIDER_FAILURE,
              explanation: message.stopDetails?.explanation?.slice(0, 500) ?? null,
            } : null,
            usage_reported: Boolean(message.usage),
            purpose: request.purpose,
            purpose_source: "host_role_and_tools_v1",
            purpose_final: true,
            role: request.role,
            speculative_plan_id: request.planId,
            read_only_review: request.review,
            obsolete,
            ...(hostCancellation ? { host_cancellation: hostCancellation } : {}),
          },
        );
        this.request = null;
      }
      if (this.current(run, generation) && !hostYield) {
        if (!hostCancellation && (message.stopReason === "error" || recoveredFailure)) this.providerFailed = true;
        if (message.stopReason === "aborted" && !hostCancellation) this.providerAborted = true;
      }
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        for (const content of message.content) {
          if (content.type === "text" && content.text.trim())
            this.store.event(
              run.run_id,
              "model.explanation",
              "Strategic assistant explanation",
              {
                text: content.text,
                turn: run.turns,
                obsolete,
              },
            );
        }
      }
      if (this.host.run() === run) this.host.persist();
      else this.store.saveRun(run);
    } else if (event.type === "tool_execution_start") {
      this.store.event(
        run.run_id,
        "model.tool_started",
        `Strategist called ${event.toolName}`,
        {
          tool_call_id: event.toolCallId,
          tool: event.toolName,
        },
      );
    } else if (event.type === "tool_execution_end") {
      const eligible = this.eligibleTools.get(event.toolCallId);
      this.eligibleTools.delete(event.toolCallId);
      let authority = true;
      try { eligible?.authority?.(); } catch { authority = false; }
      if (eligible?.name === event.toolName && !event.isError && authority && this.current(run, generation)) {
        const parsed = jsonSchema.safeParse(event.result?.details);
        if (parsed.success) {
          const value = record(parsed.data);
          const input = eligible.arguments && typeof eligible.arguments === "object" && !Array.isArray(eligible.arguments)
            ? eligible.arguments as Record<string, unknown> : null;
          if (event.toolName === "help") {
            const topic = typeof input?.topic === "string" ? input.topic : "overview";
            this.retainedContext.rememberHelp(topic, parsed.data);
          } else if (["program_write", "program_run", "program_inspect", "program_submit"].includes(event.toolName)) {
            const selected = event.toolName === "program_submit" ? record(value?.source ?? null) : value;
            if (typeof selected?.name === "string" && typeof selected.version === "number")
              this.retainedContext.selectProgram(selected.name, selected.version);
          }
        }
      }
      this.store.event(
        run.run_id,
        "model.tool_finished",
        event.isError
          ? "Strategic tool invocation was rejected"
          : `Strategic tool ${event.toolName} returned`,
        {
          tool_call_id: event.toolCallId,
          tool: event.toolName,
          rejected: Boolean(event.isError),
        },
      );
      if (this.host.run() === run) this.host.persist();
    }
  }
}
