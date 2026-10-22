import { randomUUID } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type {
  ActionView,
  ActivityEvent,
  Json,
  Observation,
  PolicyView,
  UsagePurpose,
} from "../shared/contracts.ts";
import type { AuthManager } from "./auth.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { Store, StoredRun } from "./store.ts";
import { recordCall, recordUsage } from "./usage.ts";
import { isSpeculativeTool, type SpeculativePlanning } from "./speculative-planning.ts";

const COALESCE_MS = 100;
const EMPTY_COOLDOWN_MS = 5_000;
const MAX_EMPTY_TURNS = 3;
const TURN_MS = 120_000;
const BOOTSTRAP_MS = 60_000;
const TURN_CALLS = 12;
const BOOTSTRAP_CALLS = 3;
const TOOL_CALLS = 48;
const FEEDBACK_BYTES = 8 * 1024;
const REVIEW_TOOLS: Record<string, true> = {
  capabilities_read: true,
  observation_read: true,
  skill_read: true,
  skill_register: true,
  skill_revise: true,
  skill_history: true,
  skill_get: true,
  feedback_read: true,
  action_get: true,
  recipes_read: true,
  improvement_feedback: true,
  improvement_resolve: true,
  version_compare: true,
  trace_read: true,
  planning_read: true,
};
const PROGRAM_PENDING =
  "A program is meaningful pending work; strategy waits for its outcome";
const PROVIDER_FAILURE =
  "The strategic model request could not complete. Check authorization and provider availability, then resume the paused run.";
const MEANINGFUL_WAKES: Record<string, true> = {
  policy_replan: true,
  policy_interrupt: true,
  policy_error: true,
  trial_decision_due: true,
  selected_attention: true,
  skill_outcome: true,
  speculative_lookahead: true,
  death: true,
  uncertainty: true,
  goal_review: true,
};
const FEEDBACK_TYPES: Record<string, true> = {
  "skill.closed": true,
  "skill.progress": true,
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

export interface StrategicHost {
  run(): StoredRun | null;
  generation(): number;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  tools(generation: number): AgentTool[];
  rootPrompt(): string;
  observe(): Promise<Observation>;
  policies(): PolicyView[];
  action(): ActionView | null;
  programPending(): boolean;
  busy(): boolean;
  persist(summary?: string): void;
  pause(message: string): void;
  terminal(status: "completed" | "failed", message: string): void;
  finishBootstrap(): void;
  speculation?(): SpeculativePlanning;
  reviewContext?(): Json;
  reviewComplete?(): void;
}

interface RequestAttempt {
  id: string;
  purpose: UsagePurpose;
  index: number;
  planId: string | null;
  review: boolean;
  role: "bootstrap" | "speculative" | "review" | "recovery" | "planning";
}

function inventoryCounts(observation: Observation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of observation.player.inventory)
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}

function record(value: Json): { [key: string]: Json } | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function feedbackEntry(event: ActivityEvent): Json {
  // Durable evidence may include full observations, program arguments or action
  // results. Ordinary strategy receives references and selected scalar facts;
  // feedback_read remains the authorized route to the original record.
  const details = record(event.details);
  const selected: { [key: string]: Json } = {};
  for (const key of [
    "execution_id",
    "root_execution_id",
    "skill_id",
    "policy_id",
    "version",
    "action_id",
    "evaluation_id",
    "status",
    "kind",
    "reason",
    "actions",
    "calls",
    "evaluations",
    "effects",
    "tool",
    "tool_call_id",
    "goal",
    "session_id",
    "life_id",
    "observation_seq",
    "neutralized",
    "workers_closed",
    "no_replay",
    "summary",
    "plan_id",
    "attempt_id",
  ]) {
    const value = details?.[key];
    if (typeof value === "string") selected[key] = value.slice(0, 300);
    else if (typeof value === "number" || typeof value === "boolean")
      selected[key] = value;
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
  }
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
  private turnToolCalls = 0;
  private turnDeadline = 0;
  private bootstrapCalls = 0;
  private bootstrapDeadline = 0;
  private providerFailed = false;
  private providerAborted = false;
  private gateReason: string | null = null;
  private pendingAllowance = 0;
  private emptyTurns = 0;
  private workRevision = 0;
  private contextCursor = 0;
  private previousInventory: Record<string, number> | null = null;
  private purpose: UsagePurpose = "planning";
  private role: RequestAttempt["role"] = "planning";
  private request: RequestAttempt | null = null;
  private wakeReasons = new Set<string>();
  private wakeTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private attentionTimer: NodeJS.Timeout | undefined;
  private attentionReason: string | null = null;
  private speculativeTurn = false;

  constructor(
    private readonly store: Store,
    private readonly auth: AuthManager,
    private readonly host: StrategicHost,
  ) {}

  reset(): void {
    if (this.agent || this.opening || this.turn || this.closing)
      throw new RuntimeFault(
        "conflict",
        "Drain the previous strategic agent before resetting a run",
      );
    this.fence();
    this.turnCalls = 0;
    this.turnToolCalls = 0;
    this.turnDeadline = 0;
    this.bootstrapCalls = 0;
    this.bootstrapDeadline = 0;
    this.providerFailed = false;
    this.providerAborted = false;
    this.gateReason = null;
    this.pendingAllowance = 0;
    this.emptyTurns = 0;
    this.workRevision = 0;
    this.contextCursor = 0;
    this.previousInventory = null;
    this.purpose = "planning";
    this.role = "planning";
    this.request = null;
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
    if (run.status === "bootstrapping" && !this.bootstrapDeadline)
      this.bootstrapDeadline = Date.now() + BOOTSTRAP_MS;
    const opening = (async () => {
      const agent = await this.auth.createAgent({
        modelId: run.model_id,
        systemPrompt: [this.host.rootPrompt()],
        tools: this.host.tools(generation),
      });
      this.agent = agent;
      if (!this.current(run, generation))
        throw new RuntimeFault(
          "stale_context",
          "Strategic startup authority was revoked",
        );
      this.host.assertCurrent(generation);
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
        const bootstrap = run.status === "bootstrapping";
        const review = run.status === "reviewing";
        if (this.speculativeTurn && !this.host.speculation?.().requestCall())
          return stop("Finite lookahead request authority reached");
        if (!bootstrap && !review && !this.speculativeTurn && this.host.programPending() && !this.pendingAllowance)
          return stop(PROGRAM_PENDING);
        if (
          this.turnCalls >= (review ? 3 : TURN_CALLS) ||
          this.turnToolCalls >= (review ? 12 : TOOL_CALLS) ||
          Date.now() >= this.turnDeadline ||
          (bootstrap &&
            (this.bootstrapCalls >= BOOTSTRAP_CALLS ||
              Date.now() >= this.bootstrapDeadline))
        )
          return stop("Finite strategic call allowance reached");
        if (!bootstrap && !this.speculativeTurn && this.host.programPending()) this.pendingAllowance--;
        this.gateReason = null;
        this.turnCalls++;
        if (bootstrap) this.bootstrapCalls++;
        run.turns++;
        this.request = {
          id: randomUUID(),
          purpose: this.purpose,
          index: this.turnCalls,
          planId: this.speculativeTurn ? this.host.speculation?.().projection()?.plan_id ?? null : null,
          review,
          role: this.role,
        };
        recordCall(run.usage, this.request.purpose);
        this.store.event(
          run.run_id,
          "model.call",
          "Strategic model inference started",
          {
            turn: run.turns,
            generation,
            bootstrap,
            request_id: this.request.id,
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
        if (signal?.aborted || !this.current(run, generation))
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
          if (run.status === "reviewing" && !Object.hasOwn(REVIEW_TOOLS, context.tool.name))
            throw new RuntimeFault("invalid_request", "Post-goal review permits evidence and source authoring only");
        } catch {
          return {
            block: true,
            reason: "This strategic turn has no remaining tool authority",
          };
        }
      };
      this.unsubscribeAgent = agent.subscribe((event) =>
        this.agentEvent(event, run, generation),
      );
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
    return () => {
      if (!run || revision !== this.fenceRevision || Date.now() >= deadline || !this.current(run, generation))
        throw new RuntimeFault("stale_context", "Strategic tool authority was revoked");
      permit?.();
    };
  }

  admitted(): void {
    this.workRevision++;
    this.emptyTurns = 0;
    this.pendingAllowance = 0;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.host.programPending()) {
      // Ordinary queued planning demand is superseded by new work. Explicitly
      // selected attention/lookahead must survive the current root's next leaf
      // admission, including the scheduler's coalescing window.
      for (const reason of this.wakeReasons)
        if (reason !== "selected_attention" && reason !== "speculative_lookahead")
          this.wakeReasons.delete(reason);
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
    if (this.host.programPending() && !Object.hasOwn(MEANINGFUL_WAKES, reason))
      return;
    if (this.speculativeTurn && reason !== "speculative_lookahead" &&
        Object.hasOwn(MEANINGFUL_WAKES, reason)) {
      // Ordinary outcome/replan demand is never held behind optional lookahead.
      // Drain the cancelled request through the same serialized agent owner.
      this.host.speculation?.().invalidate("cancelled");
      this.agent?.abort();
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
    clearTimeout(this.wakeTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.attentionTimer);
    this.wakeTimer = undefined;
    this.idleTimer = undefined;
    this.attentionTimer = undefined;
    this.attentionReason = null;
    this.wakeReasons.clear();
    this.pendingAllowance = 0;
    this.host.speculation?.().invalidate("cancelled");
    this.agent?.abort();
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
      if (released) {
        this.unsubscribeAgent?.();
        this.unsubscribeAgent = null;
        this.agent = null;
      }
      if (
        !released ||
        settlements.some((result) => result.status === "rejected")
      )
        throw new RuntimeFault(
          "backend_unavailable",
          "Strategic request shutdown could not be confirmed; admission remains fenced",
        );
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
      (run.status === "running" || run.status === "bootstrapping" || run.status === "reviewing")
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
          if (this.current(run, generation)) this.host.pause(PROVIDER_FAILURE);
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
    const bootstrap = run.status === "bootstrapping";
    const review = run.status === "reviewing";
    const reasons = [...this.wakeReasons];
    this.wakeReasons.clear();
    // Replans/outcomes always win; overlap is one intentional independent path,
    // never an extra ordinary pending-work inference allowance.
    const speculative = !bootstrap && !review &&
      reasons.includes("speculative_lookahead") &&
      reasons.every((reason) => reason === "speculative_lookahead")
      ? this.host.speculation?.().begin() ?? null
      : null;
    if (reasons.includes("speculative_lookahead") && !speculative) {
      this.host.speculation?.().invalidate("cancelled");
      if (reasons.every((reason) => reason === "speculative_lookahead")) {
        this.store.event(run.run_id, "scheduler.lookahead_skipped", "Optional lookahead demand had no eligible flight; ordinary bootstrap and replan allowances are unchanged", {
          phase: run.status,
          reason: bootstrap ? "bootstrap" : review ? "review" : "draft_not_available",
        });
        return;
      }
    }
    this.speculativeTurn = speculative !== null;
    this.pendingAllowance = reasons.some((reason) =>
      Object.hasOwn(MEANINGFUL_WAKES, reason),
    )
      ? 1
      : 0;
    const attention = reasons.includes("selected_attention")
      ? this.attentionReason
      : null;
    if (attention !== null) this.attentionReason = null;
    this.role = review ? "review" : speculative ? "speculative" : bootstrap ? "bootstrap"
      : reasons.some((reason) => ["policy_replan", "policy_interrupt", "policy_error", "death", "uncertainty"].includes(reason))
        ? "recovery" : "planning";
    this.purpose = review
      ? "improvement"
      : speculative ? "planning" : bootstrap ? "authoring"
        : this.role === "recovery" ? "replanning" : "planning";
    const turnId = randomUUID();
    const revision = this.workRevision;
    this.turnCalls = 0;
    this.turnToolCalls = 0;
    this.providerFailed = false;
    this.providerAborted = false;
    this.gateReason = null;
    this.request = null;
    this.turnDeadline = bootstrap
      ? this.bootstrapDeadline
      : speculative
        ? Date.now() + (this.host.speculation?.().remainingMs() ?? 0)
        : Date.now() + (review ? 30_000 : TURN_MS);
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
        bootstrap,
        speculative_plan_id: speculative?.plan_id ?? null,
        read_only_review: review,
      },
    );
    let deadlineReached = false;
    const timer = setTimeout(
      () => {
        deadlineReached = true;
        this.store.event(
          run.run_id,
          "model.deadline",
          "Host strategic time allowance reached; provider cancellation requested",
          {
            turn_id: turnId,
            bootstrap,
          },
        );
        agent.abort();
      },
      Math.max(1, this.turnDeadline - Date.now()),
    );
    let through = this.contextCursor;
    let inventory: Record<string, number> | null = null;
    let originalTools: AgentTool[] | null = null;
    try {
      const observation = await this.host.observe();
      if (!this.current(run, generation)) return;
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
      const feedback: Json[] = [];
      const omitted: number[] = [];
      let bytes = 0;
      for (const event of candidates) {
        if (!Object.hasOwn(FEEDBACK_TYPES, event.type)) continue;
        const entry = feedbackEntry(event);
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > FEEDBACK_BYTES) omitted.push(event.event_seq);
        else {
          feedback.push(entry);
          bytes += size;
        }
      }
      inventory = inventoryCounts(observation);
      const previous = this.previousInventory ?? run.baseline;
      const inventoryChange = Object.fromEntries(
        [...new Set([...Object.keys(previous), ...Object.keys(inventory)])]
          .filter((name) => (inventory![name] ?? 0) !== (previous[name] ?? 0))
          .map((name) => [
            name,
            (inventory![name] ?? 0) - (previous[name] ?? 0),
          ]),
      );
      this.store.event(
        run.run_id,
        "scheduler.context_selected",
        "Bounded filtered evidence selected; omitted records remain available through feedback_read",
        {
          turn_id: turnId,
          observation_seq: observation.observation_seq,
          through_event_seq: through,
          included_event_count: feedback.length,
          omitted_event_refs: omitted,
        },
      );
      const action = this.host.action();
      if (!deadlineReached) {
        if (speculative) {
          originalTools = this.host.tools(generation);
          const selectedTools = originalTools.filter((tool) => isSpeculativeTool(tool.name));
          agent.setTools(selectedTools);
          this.store.event(run.run_id, "scheduler.speculative_tools_selected", "Configured the actual speculative agent catalog to read-only evidence and staging; dispatch authority is checked independently", {
            plan_id: speculative.plan_id,
            tools: selectedTools.map((tool) => tool.name),
          });
        }
        await agent.prompt(
          JSON.stringify({
            reason: reasons,
            attention,
            phase: run.status,
            run_id: run.run_id,
            epoch: run.epoch,
            task: run.task,
            session_id: observation.session_id,
            life: observation.life,
            speculative_plan: speculative,
            improvement_review: review ? this.host.reviewContext?.() ?? null : null,
            player: {
              position: observation.player.position,
              yaw: observation.player.yaw,
              pitch: observation.player.pitch,
              health: observation.player.health,
              food: observation.player.food,
              on_ground: observation.player.on_ground,
              in_water: observation.player.in_water,
              inventory,
              inventory_change: inventoryChange,
              observation_seq: observation.observation_seq,
            },
            current_action: action
              ? {
                  action_id: action.action_id,
                  kind: action.kind,
                  status: action.status,
                  origin: action.origin,
                  execution_id: action.execution_id,
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
                policy_id: policy.policy_id,
                version: policy.version,
                backend: policy.backend,
                name: policy.name.slice(0, 160),
                state: policy.state,
                priority: policy.priority,
                effects: policy.effects,
                last_error: policy.last_error?.slice(0, 300) ?? null,
              })),
            skills: this.store
              .skills(run.run_id)
              .slice(-12)
              .map((skill) => ({
                skill_id: skill.skill_id,
                version: skill.version,
                name: skill.name.slice(0, 160),
                purpose: skill.card.purpose.slice(0, 200),
                dependencies: skill.dependencies,
                state: skill.state,
              })),
            executions: this.store
              .skillExecutions(run.run_id)
              .slice(0, 8)
              .map((execution) => ({
                execution_id: execution.execution_id,
                skill_id: execution.skill_id,
                version: execution.version,
                status: execution.status,
                actions: execution.actions,
                calls: execution.calls,
                summary:
                  (execution.result?.summary ?? execution.error)?.slice(
                    0,
                    500,
                  ) ?? null,
              })),
            feedback,
            omitted_event_refs: omitted,
            through_event_seq: through,
            instruction: review
              ? "The operator goal is already verified. Perform one bounded effect-free evidence review: inspect objective traces/opportunities, choose revise/keep/insufficient evidence, and optionally author an exact linked source revision. A revision is an unmeasured candidate, not proven improvement. Do not start skills, policies, gameplay trials, or any effects. Completion follows this review automatically."
              : speculative
                ? "This is the single explicitly selected independent lookahead while the predecessor program continues. Only read-only evidence tools and planning_stage are available. Select an already registered candidate by exact skill_id and version and stage it using this plan_id. The host pins its immutable source hash and dependencies; do not supply a hash. Author precondition_source as async function BODY statements with the supplied context and state bindings, returning a boolean, without an enclosing function or arrow wrapper. A syntax/compactness rejection permits your explicit correction only within this same remaining request/tool/time budget. No registration, revision, starts, activation, effects, target-ID replay, or request polling. Activation later requires a fresh observation and successful exact predecessor."
                : bootstrap
              ? "Prepare compact model-authored skills and optional reactions within bootstrap allowance. Effects open automatically after bootstrap."
              : this.host.programPending()
                ? "A program is still meaningful authorized work. This is one bounded attention/outcome/replan request, not permission to poll or duplicate it. Use tools for any necessary detailed evidence."
                : "Advance the task using current evidence. Choose useful bounded work, react to trial evidence, or explain a genuine obstacle. No human continuation is needed.",
          }),
        );
      }
      if (Date.now() >= this.turnDeadline) deadlineReached = true;
    } catch {
      if (this.current(run, generation) && !deadlineReached)
        this.providerFailed = true;
    } finally {
      clearTimeout(timer);
      this.finishUnsettledRequest(run);
      if (speculative) this.host.speculation?.().finish(speculative.plan_id);
      if (originalTools) agent.setTools(originalTools);
      this.speculativeTurn = false;
      // prompt has settled, including all paired tool results. Do not retain
      // raw observations/source/tool echoes while a pending program runs.
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
    const bootstrapExpired = bootstrap && Date.now() >= this.bootstrapDeadline;
    if (
      this.providerFailed ||
      (!bootstrapExpired && (deadlineReached || this.providerAborted))
    ) {
      run.model_status = "error";
      this.store.event(
        run.run_id,
        "scheduler.turn_failed",
        "Strategic turn failed or was aborted; selected feedback remains unconsumed and no empty-planning success is recorded",
        {
          turn_id: turnId,
          deadline_reached: deadlineReached,
          provider_aborted: this.providerAborted,
          consumed_event_seq: this.contextCursor,
        },
      );
      this.host.pause(PROVIDER_FAILURE);
      return;
    }
    // A host gate can reject the initial request after observation/admission.
    // Nothing was delivered in that case, so do not consume selected evidence.
    if (this.turnCalls && !bootstrapExpired) {
      this.contextCursor = through;
      this.previousInventory = inventory;
    }
    run.model_status = "idle";
    this.store.event(
      run.run_id,
      bootstrapExpired
        ? "scheduler.bootstrap_expired"
        : "scheduler.turn_finished",
      bootstrapExpired
        ? "Bootstrap time allowance expired; selected feedback remains unconsumed and gameplay readiness is retained"
        : "Strategic turn settled with complete tool-result groups",
      {
        turn_id: turnId,
        calls: this.turnCalls,
        tools: this.turnToolCalls,
        admitted_work: this.workRevision !== revision,
        consumed_event_seq: this.contextCursor,
      },
    );
    if (bootstrap) {
      this.host.finishBootstrap();
      this.wake("bootstrap_completed");
      return;
    }
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
    this.store.event(
      run.run_id,
      "model.request_unsettled",
      "An admitted provider request ended without a final usage message; usage and provider attempt count remain unknown",
      {
        request_id: request.id,
        request_index: request.index,
        purpose: request.purpose,
        purpose_source: "host_turn_role_v1",
        purpose_final: false,
        role: request.role,
        speculative_plan_id: request.planId,
        read_only_review: request.review,
        usage_reported: false,
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
      const hostYield =
        message.stopReason === "aborted" &&
        this.gateReason !== null &&
        message.errorMessage === this.gateReason;
      const request = this.request;
      const plan = request?.planId ? this.host.speculation?.().projection() : null;
      const obsolete = !this.current(run, generation) ||
        Boolean(request?.planId && (plan?.plan_id !== request.planId || !plan.planning_active));
      if (!hostYield && request) {
        // Host workflow roles outrank visible requested tool categories. This is
        // accounting classification, never a claim about hidden intent or cause.
        const toolNames = [...new Set(message.content
          .filter((content) => content.type === "toolCall")
          .map((content) => content.name))];
        const provisionalPurpose = request.purpose;
        const purpose: UsagePurpose = request.role === "review" ? "improvement"
          : request.role === "speculative" ? "planning"
            : request.role === "recovery" ? "replanning"
              : toolNames.some((name) => ["skill_revise", "improvement_feedback", "improvement_resolve", "version_compare"].includes(name))
                ? "improvement"
                : toolNames.some((name) => name === "skill_register" || name === "policy_register")
                  ? "authoring"
                  : request.role === "bootstrap" ? "authoring" : "planning";
        if (purpose !== provisionalPurpose) {
          const previous = run.usage.by_purpose[provisionalPurpose];
          const classified = run.usage.by_purpose[purpose];
          if (previous.calls !== null) previous.calls--;
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
        if (message.usage) {
          recordUsage(run.usage, request.purpose, message.usage);
          this.store.event(
            run.run_id,
            "model.usage",
            "Provider-reported token usage recorded; subscription monetary cost is unknown",
            {
              input_tokens: message.usage.input,
              uncached_input_tokens: message.usage.input,
              output_tokens: message.usage.output,
              cache_read_tokens: message.usage.cacheRead,
              cache_write_tokens: message.usage.cacheWrite,
              request_id: request.id,
              provider_response_id: message.responseId ?? null,
              purpose: request.purpose,
              purpose_source: "host_role_and_tools_v1",
              purpose_final: true,
              speculative_plan_id: request.planId,
              read_only_review: request.review,
            },
          );
        }
        this.store.event(
          run.run_id,
          "model.request_settled",
          "Admitted strategic provider request settled",
          {
            request_id: request.id,
            request_index: request.index,
            provider_response_id: message.responseId ?? null,
            provider_retry_attempt: message.retryRecovery?.attempt ?? null,
            stop_reason: message.stopReason,
            usage_reported: Boolean(message.usage),
            purpose: request.purpose,
            purpose_source: "host_role_and_tools_v1",
            purpose_final: true,
            speculative_plan_id: request.planId,
            read_only_review: request.review,
            obsolete,
          },
        );
        this.request = null;
      }
      if (this.current(run, generation) && !hostYield) {
        if (message.stopReason === "error") this.providerFailed = true;
        if (message.stopReason === "aborted") this.providerAborted = true;
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
