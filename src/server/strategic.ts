import { randomUUID } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import type {
  ActionView,
  ActivityEvent,
  Json,
  ObservationV3,
  RuntimeAdapter,
  RunPauseCause,
  UsagePurpose,
  GoalChoice,
} from "../shared/contracts.ts";
import type { AdapterActorProjection } from "../shared/observations.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { StoredRun } from "./store.ts";
import { recordCall, recordUsage } from "./usage.ts";
import { ProviderUsageCollector } from "./provider-usage.ts";
import type { CognitionEvidenceEvent, CognitionRequestIdentity, StrategicAgentFactory, StrategicOwnership, StrategicPolicy, StrategicSpeculation, StrategicStore } from "./cognition-ports.ts";
import type { ContextOwner } from "./cognition-context.ts";
import { isToolAllowed, type ToolRole, type ToolModule } from "../shared/tool-policy.ts";
import { ProgramWorkspace } from "./program-workspace.ts";
import { compileToolArgumentBudget, type ToolArgumentOverrun } from "./tool-argument-budget.ts";
import { createToolArgumentKeyBudget } from "./tool-argument-key-budget.ts";
import type { HistoryQueryOptions } from "./history-protocol.ts";
import type { ModelObservation } from "./actor-frames.ts";
import { StrategicContextClient } from "./strategic-context-client.ts";
import { strategicContextAdapter, strategicContextScope } from "./strategic-context-protocol.ts";
import { osMonotonicNs } from "./os-monotonic.ts";
import { jsonSchema } from "../shared/validation.ts";
import { preserveRuntimeToolArguments } from "./runtime-tools.ts";
import { HOST_MONOTONIC_CLOCK_ID } from "./performance.ts";
import { controllerEventSchema } from "../shared/resident.ts";
import { AUTHORING_CANCELLATION_REASONS } from "../shared/strategic-cancellation.ts";

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
  preflight_ready: true,
  policy_replan: true,
  policy_interrupt: true,
  policy_error: true,
  trial_decision_due: true,
  selected_attention: true,
  resident_attention: true,
  program_no_effect: true,
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
  "program.repeated_no_effect": true,
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
  /** Private actual SDK context, never credentials/options or public metadata. */
  beforeDispatch?(request: { identity: CognitionRequestIdentity; model: Model; context: Context },
    options: { signal: AbortSignal; deadlineOsNs: bigint }): Promise<void>;
  /**
   * Private finite admission immediately before each SDK options.fetch call,
   * including SDK-owned retries. Never receives transport arguments or secrets.
   * Rejection prevents that fetch; it does not create a retry or a new request.
   */
  beforeSdkFetch?(request: { identity: CognitionRequestIdentity; model: { id: string; provider: string; api: string } },
    options: { signal: AbortSignal; deadlineOsNs: bigint }): Promise<void>;
  evidence?(event: CognitionEvidenceEvent): void;
}

export interface StrategicHost {
  run(): StoredRun | null;
  generation(): number;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  tools(generation: number): AgentTool[];
  disclosedModules?(): ToolModule[];
  cognitionEvidence?: { enabled(): boolean; emit(event: CognitionEvidenceEvent): void };
  rootPrompt(): string;
  promptInput?(): GoalChoice;
  adapter?(): RuntimeAdapter;
  observe(): Promise<ObservationV3>;
  modelObservation?(): Promise<ModelObservation>;
  projectObservation(observation: ObservationV3, previous: ObservationV3 | null): AdapterActorProjection;
  policies(): StrategicPolicy[];
  action(): ActionView | null;
  programPending(): boolean;
  busy(): boolean;
  persist(summary?: string): void;
  pause(message: string, cause: RunPauseCause): void;
  terminal(status: "completed" | "failed", message: string): void;
  speculation?(): StrategicSpeculation;
  reviewContext?(options: HistoryQueryOptions): Promise<Json>;
  reviewComplete?(): void;
  requestAdmission?: StrategicRequestAdmission;
}

interface RequestAttempt {
  id: string;
  startedMono: number;
  deadlineOsNs: bigint;
  usage: ProviderUsageCollector;
  purpose: UsagePurpose;
  index: number;
  planId: string | null;
  review: boolean;
  pendingDecision: boolean;
  role: "speculative" | "review" | "recovery" | "planning" | "authoring";
  authoring: AuthoringWindow | null;
  terminalReceived: boolean;
  argumentBudgets?: Map<string, ReturnType<typeof compileToolArgumentBudget>>;
  argumentRejection?: { kind: "tool_argument_budget"; request_id: string; tool: string; path: (string | number)[]; limit: number; observed: number };
  hostCancellation?: {
    kind: "ordinary_authoring";
    request_id: string;
    root_execution_id: string;
    reason: string;
  } | {
    kind: "strategic_host";
    request_id: string;
    reason: "fenced" | "speculative_preempted" | "turn_deadline" | "tool_argument_budget";
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
  if (event.type === "program.repeated_no_effect") {
    for (const key of ["source", "usefulness_inferred", "application_inferred", "count", "world_effect_emitted", "neutralized",
      "elapsed_host_ms", "elapsed_native_ms", "samples", "no_input_decisions", "processed_frame_seq", "intent_version",
      "maximum_anchor_distance_blocks", "applied_sequence", "behavior_generation",
      "raw_view_decisions", "raw_neutral_decisions", "observe_decisions"]) {
      const value = details?.[key];
      if (typeof value === "string") selected[key] = value.slice(0, 160);
      else if (typeof value === "number" || typeof value === "boolean") selected[key] = value;
    }
    for (const key of ["own_position", "anchor_position"]) {
      const position = record(details?.[key] ?? null);
      if (position && ["x", "y", "z"].every(axis => typeof position[axis] === "number" && Number.isFinite(position[axis])))
        selected[key] = { x: position.x!, y: position.y!, z: position.z! };
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
  private turnDeadlineOsNs = 0n;
  private historyController: AbortController | null = null;
  private providerFailed = false;
  private providerAborted = false;
  private gateReason: string | null = null;
  private authoring: AuthoringWindow | null = null;
  private authoringTimer: NodeJS.Timeout | undefined;
  private turnAuthoring: AuthoringWindow | null = null;
  private authoringEnded = false;
  private authoringPhase = false;
  private turnAbortRequested = false;
  private pendingDecision = false;
  private decisionBasis: { root: string; intentVersion: number | null } | null = null;
  private attentionDecisionSelected = false;
  private emptyTurns = 0;
  private workRevision = 0;
  private contextCursor = 0;
  private residentAttention = new Map<number, ActivityEvent>();
  private residentAttentionConsumed = 0;
  private residentAttentionOmitted: ResidentAttentionOmission | null = null;
  private programNoEffect: ActivityEvent | null = null;
  private programNoEffectConsumed = 0;
  private previousObservation: ObservationV3 | null = null;
  private purpose: UsagePurpose = "planning";
  private role: RequestAttempt["role"] = "planning";
  private request: RequestAttempt | null = null;
  private rejectedResponse: RequestAttempt | null = null;
  private readonly responseOwners = new Map<string, string>();
  private readonly admittedRequests = new Set<string>();
  private readonly streamDrains = new Map<string, { drained: Promise<void>; close(): Promise<unknown> }>();
  private readonly sdkFetchOperations = new Set<Promise<unknown>>();
  private wakeReasons = new Set<string>();
  private wakeTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private attentionTimer: NodeJS.Timeout | undefined;
  private attentionReason: string | null = null;
  private speculativeTurn = false;
  private readonly retainedContext: ContextOwner;
  private readonly ownership: StrategicOwnership;
  private turnId = "";
  private turnCancellation: { id: string; cancel(): void } | null = null;
  private contextObservation: Pick<ObservationV3, "profile_id" | "profile_configuration_hash"> | null = null;
  private readonly eligibleTools = new Map<string, { name: string; arguments: unknown; authority?: () => void }>();

  constructor(
    private readonly store: StrategicStore,
    private readonly auth: StrategicAgentFactory,
    private readonly host: StrategicHost,
    options: { context?: ContextOwner; ownership?: StrategicOwnership } = {},
  ) {
    this.retainedContext = options.context ?? new StrategicContextClient(store.readLocation());
    this.ownership = options.ownership ?? {};
  }

  private timingNow(): number { return this.ownership.timing?.now() ?? performance.now(); }
  private get timingClock(): string { return this.ownership.timing?.clockId ?? HOST_MONOTONIC_CLOCK_ID; }

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
    this.turnDeadlineOsNs = 0n;
    this.providerFailed = false;
    this.providerAborted = false;
    this.gateReason = null;
    this.authoring = null;
    this.turnAuthoring = null;
    this.authoringEnded = false;
    this.authoringPhase = false;
    this.turnAbortRequested = false;
    this.pendingDecision = false;
    this.decisionBasis = null;
    this.attentionDecisionSelected = false;
    this.emptyTurns = 0;
    this.workRevision = 0;
    this.contextCursor = 0;
    this.residentAttention.clear();
    this.residentAttentionConsumed = 0;
    this.residentAttentionOmitted = null;
    this.programNoEffect = null;
    this.programNoEffectConsumed = 0;
    this.previousObservation = null;
    this.purpose = "planning";
    this.role = "planning";
    this.request = null;
    this.rejectedResponse = null;
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
    this.retainedContext.open();
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
        request.argumentBudgets = new Map(context.tools?.map(tool =>
          [tool.name, compileToolArgumentBudget(tool.parameters)]));
        const argumentSchemas = new Map(context.tools?.map(tool => [tool.name, tool.parameters]));
        const argumentKeyBudgets = new Map<number, ReturnType<typeof createToolArgumentKeyBudget>>();
        if (request.authoring) this.assertAuthoring(request.authoring);
        const adapter = strategicContextAdapter(this.host.adapter?.());
        const scope = strategicContextScope(run);
        const phase = run.status, revision = this.fenceRevision, toolRole = this.toolRole();
        const observation = this.contextObservation;
        // This is the final supported SDK stream boundary, including tool-loop
        // continuations. Supplement the actual request, not the disposable
        // Agent's history or a host-only reference cache.
        const pendingAuthoring = this.authoringProjection();
        const retained = await this.retainedContext.assemble({
          scope, model: { api: model.api, provider: model.provider }, observation, adapter, pendingAuthoring,
        }, { deadlineOsNs: request.deadlineOsNs, signal: options?.signal });
        // This await is a new authority seam, not an admission extension. The
        // exact request, role, run incarnation and original deadline still own
        // publication to the provider; a late reducer response grants nothing.
        this.reconcileDecision();
        selectPhase();
        if (request.authoring) this.assertAuthoring(request.authoring);
        if (this.request !== request || this.agent !== agent || !this.current(run, generation) ||
            this.fenceRevision !== revision || run.status !== phase || this.toolRole() !== toolRole ||
            request.role !== (request.authoring ? "authoring" : this.role) ||
            request.pendingDecision !== this.pendingDecision || request.hostCancellation || this.turnAbortRequested ||
            options?.signal?.aborted || osMonotonicNs() >= request.deadlineOsNs ||
            JSON.stringify(strategicContextScope(run)) !== JSON.stringify(scope) ||
            JSON.stringify(this.contextObservation) !== JSON.stringify(observation) ||
            JSON.stringify(strategicContextAdapter(this.host.adapter?.())) !== JSON.stringify(adapter) ||
            request.planId && (this.host.speculation?.().projection()?.plan_id !== request.planId ||
              this.host.speculation?.().projection()?.planning_active !== true))
          throw new RuntimeFault("stale_context", "Strategic retained context authority was revoked");
        this.host.assertCurrent(generation);
        const requestContext = {
          ...context,
          // The SDK keeps the original user message through its tool loop.
          // Refresh that host projection as well as the supplement: otherwise
          // a pure authoring request still claims ordinary decision authority.
          messages: context.messages.map((message, index) => {
            if (index !== 0 || message.role !== "user") return message;
            const refresh = (text: string) => {
              const projection = JSON.parse(text);
              return JSON.stringify({ ...projection, phase: run.status, role: request.role,
                pending_decision: request.pendingDecision, pending_authoring: pendingAuthoring ?? null,
                ...(pendingAuthoring ? { instruction: pendingAuthoring.instruction } : {}) });
            };
            return { ...message, content: typeof message.content === "string" ? refresh(message.content) :
              message.content.map(part => part.type === "text" ? { ...part, text: refresh(part.text) } : part) };
          }),
          systemPrompt: [...(context.systemPrompt ?? []), retained],
        };
        await this.ownership.flush?.();
        const identity: CognitionRequestIdentity = {
          turn_id: this.turnId, request_id: request.id, generation, role: this.toolRole(),
          deadline_os_ns: request.deadlineOsNs.toString(), phase: run.status,
          root_execution_id: request.authoring?.root ?? this.decisionBasis?.root ?? null,
          source_hash: request.authoring?.source ?? null,
          authoring_deadline_at: request.authoring?.deadline ?? null,
          pending_decision: request.pendingDecision, plan_id: request.planId,
        };
        await this.ownership.dispatch?.(identity, { model, context: requestContext });
        if (!this.current(run, generation) || options?.signal?.aborted || osMonotonicNs() >= request.deadlineOsNs)
          throw new RuntimeFault("stale_context", "Strategic dispatch authority was revoked");
        const beforeSdkFetch = this.host.requestAdmission?.beforeSdkFetch;
        const fetchOptions = beforeSdkFetch ? (() => {
          const fetch = options?.fetch ?? globalThis.fetch;
          const originalSignal = options?.signal ?? new AbortController().signal;
          const selected = { id: model.id, provider: model.provider, api: model.api };
          const speculativePermit = identity.role === "speculative" ? this.host.speculation?.().authority() : undefined;
          const assert = () => {
            this.reconcileDecision();
            if (request.authoring) this.assertAuthoring(request.authoring);
            if (this.request !== request || this.agent !== agent || !this.current(run, generation) ||
              this.fenceRevision !== revision || this.turnId !== identity.turn_id || run.status !== identity.phase ||
              this.toolRole() !== identity.role || request.hostCancellation || this.turnAbortRequested ||
              request.pendingDecision !== identity.pending_decision || request.deadlineOsNs.toString() !== identity.deadline_os_ns ||
              model.id !== selected.id || model.provider !== selected.provider || model.api !== selected.api ||
              agent.state.model.id !== selected.id || agent.state.model.provider !== selected.provider || agent.state.model.api !== selected.api ||
              originalSignal.aborted || osMonotonicNs() >= request.deadlineOsNs ||
              JSON.stringify(strategicContextScope(run)) !== JSON.stringify(scope))
              throw new RuntimeFault("stale_context", "Original strategic SDK fetch authority was revoked");
            speculativePermit?.();
            this.host.assertCurrent(generation);
          };
          return { fetch: async (...args: Parameters<typeof fetch>) => {
            const operation = (async () => {
              const assertSignals = () => {
                args[1]?.signal?.throwIfAborted();
                if (args[0] instanceof Request) args[0].signal.throwIfAborted();
              };
              assert(); assertSignals();
              await beforeSdkFetch.call(this.host.requestAdmission,
                { identity: { ...identity }, model: { ...selected } },
                { signal: originalSignal, deadlineOsNs: request.deadlineOsNs });
              assert(); assertSignals();
              // Preserve the SDK's exact input, init, signal, body and response.
              return fetch(...args);
            })();
            this.sdkFetchOperations.add(operation);
            try { return await operation; }
            finally { this.sdkFetchOperations.delete(operation); }
          } };
        })() : {};
        let firstResponse = false;
        const events = await stream(model, requestContext, { ...options, ...fetchOptions,
          onPayload: async (payload, payloadModel, signal) => {
            const replacement = await options?.onPayload?.(payload, payloadModel, signal);
            const sent = record((replacement ?? payload) as Json);
            const reasoning = record(sent?.reasoning ?? null);
            if (this.request?.id === request.id) this.store.event(run.run_id, "model.request_configuration",
              "Supported SDK payload hook observed the final request configuration, not provider-effective reasoning",
              { request_id: request.id, source: "sdk_transformed_payload",
                clock_id: this.timingClock, prepared_monotonic_ms: this.timingNow(),
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
                const receivedMono = this.timingNow();
                this.store.event(run.run_id, "model.first_response_event", "First received provider SSE event; internal latency components remain unknown",
                  { request_id: request.id, event_type: typeof payload?.type === "string" &&
                    /^[a-zA-Z0-9._-]{1,100}$/.test(payload.type) ? payload.type : null,
                    clock_id: this.timingClock, received_monotonic_ms: receivedMono,
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
        {
          const iterator = events[Symbol.asyncIterator]();
          const drained = Promise.withResolvers<void>();
          void drained.promise.catch(() => {});
          const finished = { done: true as const, value: undefined };
          let exhausted = false, reported = false, closed = false, closing = false;
          let pending: Awaited<ReturnType<typeof iterator.next>> | undefined;
          let closeWork: Promise<typeof finished> | undefined;
          const finish = (natural: boolean) => {
            if (reported) return;
            admission?.transportEnded(request.id, natural);
            reported = true;
            drained.resolve();
            this.streamDrains.delete(request.id);
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
          const planner = this;
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
                if (next.value.type === "toolcall_delta") {
                  const event = next.value;
                  const call = event.partial.content[event.contentIndex];
                  // Partial JSON parsers omit an unterminated property name.
                  // Its raw generated prefix still consumes the advertised
                  // strict-root key budget; nested free JSON remains opaque.
                  if (!argumentKeyBudgets.has(event.contentIndex))
                    argumentKeyBudgets.set(event.contentIndex, call?.type === "toolCall"
                      ? createToolArgumentKeyBudget(argumentSchemas.get(call.name)) : null);
                  const overrun = argumentKeyBudgets.get(event.contentIndex)?.append(event.delta);
                  if (overrun && call?.type === "toolCall")
                    planner.rejectToolArgumentBudget(request, call.name, overrun, run, generation, agent);
                }
                if (next.value.type === "toolcall_delta" || next.value.type === "toolcall_end")
                  planner.checkToolArgumentBudget(request, next.value.partial, run, generation, agent);
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
        this.reconcileDecision();
        const settlingAuthoring = this.authoringPhase && this.turnAuthoring &&
          this.reconcileAuthoring() === this.turnAuthoring && !this.turnAuthoring.closed;
        this.authoringPhase = run.status !== "reviewing" && !this.speculativeTurn &&
          (Boolean(settlingAuthoring) || this.host.programPending() && !this.pendingDecision);
        agent.setTools(this.host.tools(generation).filter(tool => isToolAllowed(this.toolRole(), tool.name)));
      };
      // setTools inside the admission gate is too late for this SDK: its
      // provider context has already been normalized. Refresh the live catalog
      // at the supported synchronization hook, after the previous tool group.
      const unsubscribePhase = agent.addBeforeModelCallHook(async (signal) => {
        await this.ownership.flush?.();
        await this.ownership.synchronize?.();
        if (!signal?.aborted && this.current(run, generation)) selectPhase();
      });
      agent.setBeforeModelCall(async (_context, signal) => {
        this.ownership.evidence?.("sdk_context_before_request_assembly_not_wire_payload", _context);
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
        if (this.rejectedResponse)
          return stop("The interrupted response exceeded its advertised tool argument budget");
        const review = run.status === "reviewing";
        // Admission may arm a window inside program_submit/run. Only the next
        // SDK request boundary changes phase, after that tool group returned.
        selectPhase();
        if (this.attentionDecisionSelected)
          return stop("Selected attention settled this decision; the timed wake owns the next turn");
        if (this.decisionBasis && !this.pendingDecision && !this.host.programPending())
          return stop("The primary control decision settled; fresh outcome evidence owns the next turn");
        const toolRole = this.toolRole();
        if (this.speculativeTurn && !await this.host.speculation?.().requestCall())
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
        const pendingDecision = this.pendingDecision;
        // Reads and inactive writes preserve the wake's decision authority.
        // A changed root/intent or retired predecessor consumes it at the next
        // SDK boundary, without renewing the root's inactive authoring budget.
        this.turnCalls++;
        run.turns++;
        const authoringDeadlineOsNs = authoring
          ? osMonotonicNs() + BigInt(Math.max(0, Math.floor(authoring.deadline - Date.now()))) * 1_000_000n
          : this.turnDeadlineOsNs;
        this.request = {
          id: requestId,
          startedMono: this.timingNow(),
          deadlineOsNs: this.turnDeadlineOsNs < authoringDeadlineOsNs ? this.turnDeadlineOsNs : authoringDeadlineOsNs,
          usage: new ProviderUsageCollector(requestId, this.responseOwners),
          purpose: authoring ? "authoring" : this.purpose,
          index: this.turnCalls,
          planId: this.speculativeTurn ? this.host.speculation?.().projection()?.plan_id ?? null : null,
          review,
          pendingDecision,
          role: authoring ? "authoring" : this.role,
          authoring,
          terminalReceived: false,
        };
        recordCall(run.usage, this.request.purpose);
        this.ownership.call?.(run, this.request.purpose, this.request.id);
        this.store.event(
          run.run_id,
          "model.call",
          "Strategic model inference started",
          {
            turn: run.turns,
            generation,
            request_id: this.request.id,
            clock_id: this.timingClock,
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
      agent.beforeToolCall = async (context, signal) => {
        preserveRuntimeToolArguments(context);
        await this.ownership.flush?.();
        await this.ownership.beforeTool?.(context);
        const window = this.request?.authoring;
        const obsoleteAuthoring = Boolean(window && (this.reconcileAuthoring() !== window || window.closed));
        if (!this.rejectedResponse && !obsoleteAuthoring && context.assistantMessage?.stopDetails?.type === RECOVERED_PROVIDER_FAILURE)
          this.providerFailed = true;
        if (this.rejectedResponse || signal?.aborted || !this.current(run, generation) || obsoleteAuthoring || this.authoringEnded || this.providerFailed || this.providerAborted ||
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
    const authoring = this.authoringPhase && !speculation && run?.status !== "reviewing"
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
    return this.authoringPhase ? "authoring" : "ordinary";
  }

  private authoringScope(run: StoredRun): string {
    return JSON.stringify([run.run_id, run.world_id, run.session_id, run.epoch, run.life_id,
      run.native_boot_id, run.space_epoch, run.compatibility_hash]);
  }

  /** Observe primary control changes only after the preceding SDK tool group. */
  private reconcileDecision(): void {
    const basis = this.decisionBasis;
    if (!this.pendingDecision || !basis) return;
    const run = this.host.run();
    const root = run ? this.store.latestRootExecution(run.run_id) : null;
    const intentVersion = root?.entry === "step" ? root.resident?.intent_version ?? 0 : null;
    if (!root || root.execution_id !== basis.root || intentVersion !== basis.intentVersion ||
        !["accepted", "running"].includes(root.status) ||
        root.entry === "step" && root.resident && !["starting", "running"].includes(root.resident.status))
      this.pendingDecision = false;
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
      // The admitted inactive SDK loop owns settlement grace, not its current
      // provider request: message_end releases that request before tools run.
      // Keep the same turn and original budget across those request-free seams;
      // no new turn, effect or activation authority is admitted.
      const settling = this.authoringPhase && this.turnAuthoring === previous && previous.calls > 0 && this.turn !== null &&
        root?.execution_id === previous.root && root.source_hash === previous.source &&
        root.status === "succeeded";
      const reason = previous.run !== run || previous.generation !== generation || previous.scope !== scope ||
          !run || !this.current(run, generation) || run.status !== "running" ? "scope_lost"
        : root && (previous.root !== root.execution_id || previous.source !== root.source_hash) ? "root_replaced"
          : Date.now() >= previous.deadline ? "deadline"
            : !valid && !settling ? (root && !["accepted", "running"].includes(root.status) ? "root_settled" : "scope_lost") : null;
      if (reason) this.endAuthoring(previous, reason);
      else return previous;
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
    // One abort belongs to the serialized SDK loop, including the request-free
    // tool/publication seam. Repeated wakes must not re-abort that same owner or
    // overwrite its exact request's first host cancellation cause.
    if (!agent || this.turnAbortRequested) return;
    this.turnAbortRequested = true;
    // Own the exact admitted request before abort(), which may synchronously
    // deliver its terminal callback. Neither repeats nor terminal reconciliation
    // can replace the first actual cancellation cause.
    if (agent && request && !request.terminalReceived && !request.hostCancellation) {
      if (window && request.authoring === window && request.role === "authoring" &&
          rootReason && AUTHORING_CANCELLATION_REASONS[rootReason] === true)
        request.hostCancellation = { kind: "ordinary_authoring", request_id: request.id,
          root_execution_id: window.root, reason: rootReason };
      else if (intent.kind === "strategic_host" && !request.authoring)
        request.hostCancellation = { kind: "strategic_host", request_id: request.id, reason: intent.reason };
    }
    agent.abort();
  }

  private checkToolArgumentBudget(
    request: RequestAttempt, message: AssistantMessage, run: StoredRun, generation: number, agent = this.agent,
  ): void {
    for (const call of message.content) {
      if (call.type !== "toolCall") continue;
      const overrun: ToolArgumentOverrun | null = request.argumentBudgets?.get(call.name)?.(call.arguments) ?? null;
      if (overrun) {
        this.rejectToolArgumentBudget(request, call.name, overrun, run, generation, agent);
        return;
      }
    }
  }

  private rejectToolArgumentBudget(
    request: RequestAttempt, tool: string, overrun: ToolArgumentOverrun,
    run: StoredRun, generation: number, agent = this.agent,
  ): void {
    if (this.request !== request || request.terminalReceived || request.hostCancellation ||
        this.turnAbortRequested || this.rejectedResponse || !agent || !this.current(run, generation)) return;
    if (request.authoring && (this.reconcileAuthoring() !== request.authoring || request.authoring.closed)) return;
    if (this.authoringEnded || request.planId &&
        this.host.speculation?.().projection()?.planning_active !== true) return;
    // This is an admitted string-prefix resource limit, not a prediction
    // about final JSON validity (a later duplicate key could overwrite it).
    // Latch this exact response before abort can deliver a terminal callback.
    request.argumentRejection = {
      kind: "tool_argument_budget",
      request_id: request.id,
      tool: tool.slice(0, 120),
      path: overrun.path.slice(0, 16).map(part => typeof part === "string" ? part.slice(0, 80) : part),
      limit: overrun.limit,
      observed: overrun.observed,
    };
    request.hostCancellation = { kind: "strategic_host", request_id: request.id, reason: "tool_argument_budget" };
    this.rejectedResponse = request;
    this.eligibleTools.clear();
    this.store.event(run.run_id, "model.response_budget_exceeded",
      "Host rejected the entire response because a generated string prefix exceeded its advertised tool argument resource bound",
      { ...request.argumentRejection });
    this.host.persist();
    agent.abort();
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
      predecessor_status: root?.status ?? null,
      instruction: "Within this one finite root-bound window, observe, help, program_inspect and program_write may prepare immutable inactive source. Foreground work is not changed; if it has succeeded, only this already-running inactive authoring turn may finish before queued outcome work. An unsuccessful predecessor revokes this lane so fresh ordinary strategy can handle its actual result. Write saves/validates only; no submit, run, activation, prepare_next, task_finish, reflex, memory or review. No polling or keepalive. Later wakes and leaf admissions do not renew this window.",
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
    if (this.turn && this.pendingDecision && this.decisionBasis)
      this.attentionDecisionSelected = true;
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
    // Unsuccessful outcomes revoke inactive authoring before fresh strategy.
    this.reconcileAuthoring();
    if (this.host.programPending() && !Object.hasOwn(MEANINGFUL_WAKES, reason))
      return;
    if (reason === "program_no_effect") {
      // One mechanical advisory slot, independent of the oldest-first page.
      // It is ordinary decision demand, never urgent provider cancellation.
      const event = this.store.latestEvent(run.run_id, "program.repeated_no_effect");
      if (event && event.event_seq > this.programNoEffectConsumed) this.programNoEffect = event;
    }
    let urgent = reason === "policy_interrupt";
    if (reason === "resident_attention") {
      // SkillManager persists the authored event synchronously before waking us.
      // Keep the trigger independently of the ordinary oldest-first Store page.
      const event = this.store.latestEvent(run.run_id, "controller.event");
      const authored = controllerEventSchema.safeParse(record(event?.details ?? null)?.event);
      if (event && event.event_seq > this.residentAttentionConsumed &&
          authored.success && authored.data.kind === "attention") {
        urgent = authored.data.urgency === "urgent";
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
    const authoring = this.turnAuthoring ?? this.request?.authoring;
    if (urgent && authoring && (this.authoringPhase || this.request?.authoring === authoring)) {
      // Urgent model-authored demand revokes inactive authoring, including its
      // settlement grace. It never changes the playing root or renews budgets.
      // Keep the wake and resident evidence queued until this owner has drained.
      this.endAuthoring(authoring, reason);
    }
    if (this.speculativeTurn && reason !== "speculative_lookahead" && reason !== "planning_continuation" &&
        reason !== "program_no_effect" &&
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

  /** Host deadline receipt cancels only the exact finite turn, never the owner. */
  cancelTurn(id: string): void {
    if (id !== this.turnId || this.turnCancellation?.id !== id || osMonotonicNs() < this.turnDeadlineOsNs) return;
    this.turnCancellation?.cancel();
  }

  fence(): void {
    this.fenced = true;
    this.fenceRevision++;
    this.pendingDecision = false;
    this.decisionBasis = null;
    this.historyController?.abort();
    void this.retainedContext.close().catch(() => {});
    clearTimeout(this.wakeTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.attentionTimer);
    this.wakeTimer = undefined;
    this.idleTimer = undefined;
    this.attentionTimer = undefined;
    this.attentionReason = null;
    this.programNoEffect = null;
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
    const contextClosure = this.retainedContext.close();
    const closure = (async () => {
      // A cancelled createAgent may still return an allocated auth scope. It
      // publishes that scope before rejecting, so drain creation before release.
      if (opening) await opening.catch(() => {});
      const agent = this.agent;
      const settlements = await Promise.allSettled([
        agent?.waitForIdle(),
        this.turn,
        contextClosure,
        // A rejected admission/transport is not an ownership-drain failure.
        Promise.allSettled([...this.sdkFetchOperations]),
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
      await this.ownership.flush?.();
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
        .finally(async () => {
          await this.ownership.flush?.();
          await this.ownership.endTurn?.(this.turnId);
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
      ? await this.host.speculation?.().begin() ?? null
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
    this.attentionDecisionSelected = false;
    const decisionRoot = this.pendingDecision ? this.store.latestRootExecution(run.run_id) : null;
    this.decisionBasis = decisionRoot ? { root: decisionRoot.execution_id,
      intentVersion: decisionRoot.entry === "step" ? decisionRoot.resident?.intent_version ?? 0 : null } : null;
    // Only request admission below may bind this turn to settlement grace.
    // A previous turn's consumed window budget cannot admit a new SDK loop.
    // The SDK hook mutates this field across awaits in the remainder of the turn.
    this.turnAuthoring = null as AuthoringWindow | null;
    this.authoringEnded = false;
    this.authoringPhase = false;
    this.turnAbortRequested = false;
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
    this.turnId = turnId;
    const revision = this.workRevision;
    this.turnCalls = 0;
    this.turnDelivered = 0;
    this.turnToolCalls = 0;
    this.providerFailed = false;
    this.providerAborted = false;
    this.gateReason = null;
    this.request = null;
    this.rejectedResponse = null;
    this.turnDeadline = speculative
        ? Date.now() + (this.host.speculation?.().remainingMs() ?? 0)
        : Date.now() + (review ? 30_000 : TURN_MS);
    this.turnDeadlineOsNs = osMonotonicNs() + BigInt(Math.max(0, Math.floor(this.turnDeadline - Date.now()))) * 1_000_000n;
    const historyController = new AbortController();
    this.historyController = historyController;
    let deadlineReached = false;
    const cancellation = { id: turnId, cancel: () => {
      if (deadlineReached) return;
      deadlineReached = true;
      historyController.abort();
      this.store.event(run.run_id, "model.deadline",
        "Host strategic time allowance reached; provider cancellation requested", { turn_id: turnId });
      this.abortRequest({ kind: "strategic_host", reason: "turn_deadline" }, agent);
    } };
    this.turnCancellation = cancellation;
    try { await this.ownership.beginTurn?.(turnId, this.turnDeadlineOsNs); }
    catch (error) {
      if (this.turnCancellation === cancellation) this.turnCancellation = null;
      if (this.historyController === historyController) this.historyController = null;
      historyController.abort();
      throw error;
    }
    if (!this.current(run, generation)) {
      if (this.turnCancellation === cancellation) this.turnCancellation = null;
      if (this.historyController === historyController) this.historyController = null;
      historyController.abort();
      return;
    }
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
    const timer = setTimeout(
      cancellation.cancel,
      Math.max(1, this.turnDeadline - Date.now()),
    );
    let through = this.contextCursor;
    let selectedAttention: ActivityEvent[] = [];
    let selectedNoEffect: ActivityEvent | null = null;
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
          candidates.some((event) => {
            const details = record(event.details);
            if (event.type !== "action.failed" && event.type !== "action.unknown" &&
                !(event.type === "skill.closed" && ["failed", "blocked", "unknown"].includes(String(details?.status))))
              return false;
            const action = typeof details?.action_id === "string" ? this.store.getAction(run.run_id, details.action_id) : null;
            const id = typeof details?.execution_id === "string" ? details.execution_id : action?.view.execution_id;
            const owner = id ? this.store.skillExecution(run.run_id, { execution_id: id }) : null;
            const root = owner ? this.store.skillExecution(run.run_id, { execution_id: owner.root_execution_id }) : null;
            // A successful containing execution already handled its earlier
            // child outcome. Keep that evidence/no-replay uncertainty, but do
            // not turn normal whole-task assessment into mandatory repair.
            // Unowned failures and unsuccessful roots still need recovery.
            return root?.status !== "succeeded";
          })) {
        this.role = "recovery";
        this.purpose = "replanning";
      }
      through =
        candidates[candidates.length - 1]?.event_seq ?? this.contextCursor;
      selectedNoEffect = reasons.includes("program_no_effect") ? this.programNoEffect : null;
      if (selectedNoEffect) {
        const existing = candidates.findIndex(event => event.event_seq === selectedNoEffect!.event_seq);
        if (existing !== -1) candidates.splice(existing, 1);
        // Preserve this bounded trigger before historical progress can consume
        // the whole existing feedback byte allowance.
        candidates.unshift(selectedNoEffect);
      }
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
        if (event.type === "program.repeated_no_effect" &&
          (event.event_seq !== selectedNoEffect?.event_seq || event.event_seq <= this.programNoEffectConsumed)) continue;
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
          this.store.event(run.run_id, "scheduler.speculative_tools_selected", "Configured the actual speculative agent catalog to evidence, inactive source preparation and staging; dispatch authority is checked independently", {
            plan_id: speculative.plan_id,
            tools: selectedTools.map((tool) => tool.name),
          });
        }
        prompting = true;
        const prompt = {
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
              ...workspace.executionSummary(execution, run),
              summary: (execution.result?.summary ?? execution.error)?.slice(0, 500) ?? null,
            })),
            feedback,
            omitted_event_refs: omitted,
            omitted_resident_attention: attentionOmission,
            through_event_seq: through,
            instruction: review
              ? "The goal is verified. Perform one bounded effect-free review: inspect evidence, record keep/insufficient_evidence, or program_write/program_edit a linked revision with reason. A candidate is not proven improvement. No gameplay trials or effects. Completion follows automatically."
              : speculative
                ? "This is the one authorized independent planning flight. Observe, inspect, help, pure program_write/program_edit and prepare_next only. Prepare immutable inactive source if needed, then select one exact named candidate; optionally author guard_source BODY(observation,args) returning strict boolean. Omission adds no game constraint. No starts, activation, effects or polling. Source preparation and corrections share the original finite deadline and allowance. Main's captured permission and all host invariants govern activation."
              : this.host.programPending()
                ? this.pendingDecision
                  ? "Resolve this explicit attention/outcome/recovery signal within the ordinary bounded decision turn. Inspect current state or mechanics as needed, then choose the necessary current-root intent update, code change or stop. Decision authority survives intermediate reads and inactive writes, then ends at the next request after a root/intent change or predecessor retirement. It does not renew the root deadline or inactive-authoring allowance. Keep useful local control running; no polling or duplicate foreground work."
                  : "The foreground program continues unchanged. Use only observe, help, program_inspect and pure program_write/program_edit to prepare immutable inactive source within the remaining root-bound authoring allowance. No starts, activation, effects, polling or keepalive; repeated wakes do not renew the window."
                : "Assess the whole task from current permitted state and retained execution facts/events before starting or revising work. Only if the WHOLE custom task is done, call task_finish with all_requested_work_complete:true and an honest evidence/provenance summary. If work or required evidence remains, do not affirm completion: end the planning response normally while useful local control continues. Execution completion alone is not proof. Earlier child failure or unknown effects do not erase later evidence, resolve that uncertainty or permit replay. Otherwise advance the unfinished task with an autonomous local taskflow. Keep short input intervals, fresh target selection and ordinary recovery inside your code. For ongoing world control use a resident step (help controller); keep useful control running through cloud decisions. Return blocked only when the local algorithm genuinely cannot continue, not merely because an input interval finished. Choose survival and combat responses yourself. No human continuation is needed.",
          };
        for (;;) {
          try {
            await agent.prompt(JSON.stringify(prompt), selected.images);
          } catch (error) {
            if (!this.rejectedResponse) throw error;
          }
          const rejected = this.rejectedResponse as RequestAttempt | null;
          if (!rejected) break;
          // Join the interrupted transport before giving the same serialized
          // turn a fresh request owner. No allowance or deadline is renewed.
          await agent.waitForIdle();
          const owned = this.streamDrains.get(rejected.id);
          if (owned) await Promise.all([owned.close(), owned.drained]);
          this.finishUnsettledRequest(run);
          if (!this.current(run, generation) || run.status !== phase || this.fenceRevision !== fenceRevision ||
              this.turnAbortRequested || this.authoringEnded || this.providerFailed || this.providerAborted ||
              Date.now() >= this.turnDeadline || this.turnCalls >= (review ? 3 : TURN_CALLS) ||
              this.turnToolCalls >= (review ? 12 : TOOL_CALLS)) break;
          if (rejected.authoring &&
              (this.reconcileAuthoring() !== rejected.authoring || rejected.authoring.closed)) break;
          if (speculative && this.host.speculation?.().projection()?.planning_active !== true) break;
          // The discarded group has no tool result. Keep its complete failed
          // accounting in Store, but never feed partial arguments back as an
          // assistant/tool exchange or as new effect authority.
          agent.replaceMessages([]);
          this.rejectedResponse = null;
          const correction = {
            type: "model.response_budget_exceeded",
            ...rejected.argumentRejection!,
            instruction: "The entire preceding response was rejected before tool dispatch. Generate a fresh complete correction within the currently advertised string bounds and strict-object property names. This is a generated-prefix resource budget, even if a later duplicate key could overwrite that prefix. Original authority, remaining allowances and deadline are unchanged.",
          };
          Object.assign(prompt, { response_budget_feedback: correction });
        }
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
      if (this.turnCancellation === cancellation) this.turnCancellation = null;
      historyController.abort();
      if (this.historyController === historyController) this.historyController = null;
      this.finishUnsettledRequest(run);
      this.finishAuthoringBudget();
      const authoring = this.turnAuthoring;
      if (authoring && !authoring.closed &&
          !["accepted", "running"].includes(this.store.skillExecution(run.run_id, { execution_id: authoring.root })?.status ?? ""))
        this.endAuthoring(authoring, "root_settled", false);
      // Confirm canceled transport release before any queued signal can obtain
      // this single owner. This never touches the playing root.
      if (this.authoringEnded || deadlineReached) {
        const drains = [...this.streamDrains.values()];
        await Promise.all(drains.flatMap(stream => [stream.close(), stream.drained]));
      }
      if (speculative) this.host.speculation?.().finish(speculative.plan_id);
      this.speculativeTurn = false;
      this.authoringPhase = false;
      this.pendingDecision = false;
      this.decisionBasis = null;
      this.attentionDecisionSelected = false;
      if (speculative) agent.setTools(this.host.tools(generation)
        .filter((tool) => isToolAllowed(this.toolRole(), tool.name)));
      this.eligibleTools.clear();
      // Keep no transcript or old effect authority. Compatible bounded docs
      // and fresh Store projections are owned outside this temporary Agent.
      agent.replaceMessages([]);
      await this.ownership.flush?.();
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
    if (deadlineReached && !this.providerFailed && !this.providerAborted &&
      !this.authoringEnded && this.turnCalls > 0) {
      const root = this.store.latestRootExecution(run.run_id);
      const continuing = this.host.programPending() && root?.entry === "step" && root.session &&
        root.status === "running" && root.ended_at === null &&
        root.parent_execution_id === null && root.root_execution_id === root.execution_id &&
        root.run_generation === generation && root.world_id === run.world_id &&
        root.session_id === run.session_id && root.epoch === run.epoch &&
        root.life_id !== null && root.life_id === run.life_id &&
        root.native_boot_id !== null && root.native_boot_id === run.native_boot_id &&
        root.space_epoch !== null && root.space_epoch === run.space_epoch &&
        root.compatibility_hash === run.compatibility_hash && root.source_hash !== null &&
        root.resident?.status === "running" && typeof root.resident.processed_frame_seq === "number" &&
        root.resident.processed_frame_seq > 0 &&
        root.resident.cleanup.worker === "open" && root.resident.cleanup.native === "open" &&
        Date.parse(root.deadline_at) > Date.now();
      if (continuing) {
        run.model_status = "idle";
        this.store.event(run.run_id, "scheduler.turn_deferred",
          "Finite Main window expired; existing scoped executive authority remains unchanged", {
            turn_id: turnId, root_execution_id: root.execution_id, source_hash: root.source_hash,
            original_root_deadline_at: root.deadline_at, calls: this.turnCalls, tools: this.turnToolCalls,
            deadline_reached: true, provider_failed: false, provider_aborted: false,
            selected_feedback_consumed: false, automatic_retry: false,
          });
        // No retry/wake or control renewal here. Only a new ordinary signal can
        // request another decision; the executive retains its original budgets.
        this.host.persist();
        return;
      }
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
      if (selectedNoEffect) {
        this.programNoEffectConsumed = selectedNoEffect.event_seq;
        if (this.programNoEffect?.event_seq === selectedNoEffect.event_seq) this.programNoEffect = null;
      }
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
    // Stream callbacks may publish this while the SDK prompt is awaited.
    const rejectedResponse = this.rejectedResponse as RequestAttempt | null;
    this.store.event(
      run.run_id,
      "scheduler.turn_finished",
      rejectedResponse ? "Strategic turn ended after a host resource rejection exhausted its remaining admission authority"
        : "Strategic turn settled with complete tool-result groups",
      {
        turn_id: turnId,
        calls: this.turnCalls,
        tools: this.turnToolCalls,
        admitted_work: this.workRevision !== revision,
        authoring_exit: this.authoringEnded ? this.turnAuthoring?.closed ?? "ended" : null,
        ...(rejectedResponse ? { resource_rejection: rejectedResponse.argumentRejection! } : {}),
        consumed_event_seq: this.contextCursor,
      },
    );
    this.host.persist();
    if (rejectedResponse) return;
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
    const endedMono = this.timingNow();
    this.store.event(
      run.run_id,
      "model.request_unsettled",
      "An admitted provider request ended without a final usage message; usage and provider attempt count remain unknown",
      {
        request_id: request.id,
        clock_id: this.timingClock,
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
        ...(request.argumentRejection ? { resource_rejection: request.argumentRejection } : {}),
        ...(request.hostCancellation ? { host_cancellation: request.hostCancellation } : {}),
      },
    );
    this.request = null;
  }

  private agentEvent(
    event: AgentEvent,
    run: StoredRun,
    generation: number,
  ): void {
    if (["message_start", "message_end", "tool_execution_start", "tool_execution_end"].includes(event.type))
      this.ownership.evidence?.("visible_agent_event", event);
    if (event.type === "message_update" && event.message.role === "assistant" &&
        (event.assistantMessageEvent.type === "toolcall_delta" || event.assistantMessageEvent.type === "toolcall_end") && this.request)
      this.checkToolArgumentBudget(this.request, event.message, run, generation);
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
      const resourceRejected = Boolean(request?.argumentRejection);
      const hostCancellation = message.stopReason === "aborted" &&
        (requestedCancellation?.kind === "strategic_host" || request?.role === "authoring" && obsolete)
        ? requestedCancellation : undefined;
      this.eligibleTools.clear();
      if (!resourceRejected && !obsolete && !hostYield && !recoveredFailure && ["stop", "toolUse"].includes(message.stopReason)) {
        this.turnDelivered++;
        for (const content of message.content) {
          if (content.type === "toolCall") this.eligibleTools.set(content.id, { name: content.name, arguments: content.arguments,
            ...(window ? { authority: () => this.assertAuthoring(window) } : {}) });
        }
      }
      if (request) this.ownership.response?.({
        request_id: request.id,
        successful: !resourceRejected && !obsolete && !hostYield && !recoveredFailure &&
          ["stop", "toolUse"].includes(message.stopReason),
        calls: [...this.eligibleTools].map(([id, call]) => ({ id, name: call.name, arguments: call.arguments })),
      });
      if (!hostYield && request) {
        // Host workflow roles outrank visible requested tool categories. This is
        // accounting classification, never a claim about hidden intent or cause.
        const toolCalls = message.content.filter((content) => content.type === "toolCall");
        const toolNames = [...new Set(toolCalls.map((content) => content.name))];
        const improvement = toolCalls.some((call) => call.name === "program_review" ||
          (call.name === "program_write" || call.name === "program_edit" || call.name === "program_submit") && call.arguments && typeof call.arguments === "object" && "based_on" in call.arguments ||
          call.name === "program_inspect" && call.arguments && typeof call.arguments === "object" &&
            (call.arguments.view === "feedback" || call.arguments.view === "comparison"));
        const provisionalPurpose = request.purpose;
        const purpose: UsagePurpose = request.role === "review" ? "improvement"
          : request.role === "speculative" ? "planning"
            : request.role === "recovery" ? "replanning"
              : request.role === "authoring" ? "authoring"
              : improvement
                ? "improvement"
                : toolNames.some((name) => name === "program_write" || name === "program_edit" || name === "program_submit" || name === "reflex")
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
          this.ownership.classify?.(run, provisionalPurpose, purpose, request.id);
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
          this.ownership.usage?.(run, request.purpose, message.usage, request.id);
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
            clock_id: this.timingClock,
            started_monotonic_ms: request.startedMono,
            ended_monotonic_ms: this.timingNow(),
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
            ...(resourceRejected ? { resource_rejection: request.argumentRejection! } : {}),
            ...(hostCancellation ? { host_cancellation: hostCancellation } : {}),
          },
        );
        this.request = null;
      }
      if (this.current(run, generation) && !hostYield) {
        if (!hostCancellation && (message.stopReason === "error" || recoveredFailure)) this.providerFailed = true;
        if (message.stopReason === "aborted" && !hostCancellation) this.providerAborted = true;
      }
      if (!resourceRejected && message.stopReason !== "error" && message.stopReason !== "aborted") {
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
      else this.store.saveRun?.(run);
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
            const reference = topic === "actions" && typeof input?.kind === "string" ? `actions:${input.kind}` : topic;
            this.retainedContext.rememberHelp(reference, parsed.data);
          } else if (["program_write", "program_edit", "program_run", "program_inspect", "program_submit"].includes(event.toolName)) {
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
