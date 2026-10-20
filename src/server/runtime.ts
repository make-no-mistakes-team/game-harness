import { randomUUID } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@oh-my-pi/pi-agent-core/types";
import { z } from "zod";
import type {
  ActionView,
  ActivityEvent,
  GameAction,
  GameActionResult,
  GameBridge,
  GoalChoice,
  GoalId,
  Json,
  Observation,
  PolicyContext,
  PolicySpec,
  PolicyView,
  RunView,
} from "../shared/contracts.ts";
import {
  gameActionSchema,
  goalSchema,
  policyDecisionSchema,
  policySpecSchema,
} from "../shared/validation.ts";
import type { AuthManager } from "./auth.ts";
import type { PolicyWorker, SandboxService } from "./sandbox.ts";
import type { Store, StoredAction, StoredRun } from "./store.ts";

export const GOALS: GoalChoice[] = [
  {
    id: "collect_wood",
    label: "Collect wood",
    prompt:
      "Acquire at least one additional wood log, wood block, stem, or hyphae item relative to the inventory at run start.",
  },
  {
    id: "craft_crafting_table",
    label: "Craft a crafting table",
    prompt:
      "Successfully craft a crafting table during this run and retain a crafting table in inventory.",
  },
  {
    id: "craft_stone_pickaxe",
    label: "Craft a stone pickaxe",
    prompt:
      "Successfully craft a stone pickaxe during this run and retain a stone pickaxe in inventory.",
  },
  {
    id: "custom",
    label: "Custom task",
    prompt:
      "Pursue the supplied task. Custom-task completion is not automatically verified; the operator stops the run.",
  },
];

const TERMINAL: Partial<Record<RunView["status"], true>> = {
  stopped: true,
  completed: true,
  failed: true,
};
const ACTION_TERMINAL: Partial<Record<ActionView["status"], true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
  unknown: true,
};
const MAX_QUEUE = 16;
const MAX_POLICIES = 4;
const COALESCE_MS = 100;
const EMPTY_COOLDOWN_MS = 5_000;
const MAX_EMPTY_TURNS = 3;
const TURN_MS = 120_000;
const BOOTSTRAP_MS = 60_000;
const TURN_CALLS = 12;
const BOOTSTRAP_CALLS = 3;
const TOOL_CALLS = 48;
const PROVIDER_FAILURE =
  "The strategic model request could not complete. Check authorization and provider availability, then resume the paused run.";
const BRIDGE_FAILURE =
  "The game effect could not be safely reconciled. Reconnect the game before resuming; no uncertain action will be replayed.";
const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const epochSchema = z.number().int().nonnegative();
const policyRefSchema = z
  .object({
    epoch: epochSchema,
    policy_id: idSchema,
    version: z.number().int().positive(),
  })
  .strict();
const actionSubmitSchema = z
  .object({
    epoch: epochSchema,
    action_id: idSchema,
    action: gameActionSchema,
    priority: z.number().int().min(0).max(100).default(0),
    deadline_ms: z.number().int().min(100).max(15_000).optional(),
  })
  .strict();
const activateSchema = policyRefSchema
  .extend({
    mode: z.enum(["trial", "keep"]).default("trial"),
    max_ms: z.number().int().min(1_000).max(120_000).default(120_000),
    max_actions: z.number().int().min(1).max(20).default(20),
    max_evaluations: z.number().int().min(1).max(100).default(100),
  })
  .strict();

class RuntimeFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface QueueEntry {
  stored: StoredAction;
  priority: number;
  deadline: number;
  order: number;
  generation: number;
  epoch: number;
  policy: PolicySlot | null;
  policy_generation: number | null;
}
interface Execution {
  entry: QueueEntry;
  controller: AbortController;
  done: Promise<void>;
  cancellation: Promise<void> | null;
  neutralized: boolean;
}
interface PolicySlot {
  view: PolicyView;
  generation: number;
  worker: PolicyWorker | null;
  timer: NodeJS.Timeout | undefined;
  expiry: NodeJS.Timeout | undefined;
  controller: AbortController | null;
  evaluation: Promise<void> | null;
  closure: Promise<void> | null;
  trial_started: number;
  trial_deadline: number;
  trial_actions: number;
  trial_evaluations: number;
  max_ms: number;
  max_actions: number;
  max_evaluations: number;
  tried: boolean;
}

function policySpec(view: PolicyView): PolicySpec {
  return {
    name: view.name,
    source: view.source,
    card: view.card,
    priority: view.priority,
    interval_ms: view.interval_ms,
  };
}

function equivalent(action: GameAction): string {
  // Shared validation fixes object-key order, including nested controls.
  return JSON.stringify(gameActionSchema.parse(action));
}

function inventoryCounts(observation: Observation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of observation.player.inventory)
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}

/** Durable admission, one avatar lease, isolated proposals, and one strategic agent. */
export class Runtime {
  private run: StoredRun | null = null;
  private policies: PolicyView[] = [];
  private slots = new Map<string, PolicySlot>();
  private observation: Observation | null = null;
  private observationRequest: Promise<Observation> | null = null;
  private actionView: ActionView | null = null;
  private queue: QueueEntry[] = [];
  private active: Execution | null = null;
  private pumping: Promise<void> | null = null;
  private preempting = false;
  private nextOrder = 0;
  private generation = 0;
  private leaseGeneration = 0;
  private agent: Agent | null = null;
  private unsubscribeAgent: (() => void) | null = null;
  private unsubscribeGame: (() => void) | null = null;
  private turn: Promise<void> | null = null;
  private turnCalls = 0;
  private turnToolCalls = 0;
  private bootstrapCalls = 0;
  private bootstrapDeadline = 0;
  private providerFailed = false;
  private providerAborted = false;
  private emptyTurns = 0;
  private workRevision = 0;
  private contextCursor = 0;
  private wakeReasons = new Set<string>();
  private wakeTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private needsReconnect = false;
  private completedCrafts = new Set<string>();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly auth: AuthManager,
    private readonly game: GameBridge,
    private readonly sandbox: SandboxService,
    private readonly onChange: () => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.unsubscribeGame) return;
    this.run = this.store.lastRun();
    if (this.run) {
      this.store.closeUnfinishedActions(this.run.run_id);
      this.policies = this.store.policies(this.run.run_id);
      for (const policy of this.policies) {
        if (policy.state !== "trial" && policy.state !== "active") continue;
        policy.state = "retired";
        this.store.savePolicy(
          this.run.run_id,
          policy,
          "Previous policy process ended; activation is not replayed",
        );
      }
      if (!TERMINAL[this.run.status]) {
        this.run.status = "stopped";
        this.run.model_status = "idle";
        this.run.ended_at = new Date().toISOString();
        this.run.error =
          "The previous application process ended. Interrupted work was fenced and closed; create a new run to continue.";
        this.store.saveRun(
          this.run,
          "Interrupted run closed without automatic replay",
        );
      }
    }
    this.unsubscribeGame = this.game.subscribe((notice) => {
      if (!this.run || TERMINAL[this.run.status] || this.closed) return;
      if (notice.type === "observation") {
        if (this.run.status === "running")
          void this.refreshObservation().catch(() => {
            /* Connection state supplies the safety wake. */
          });
      } else if (
        notice.type === "state" &&
        (this.run.status === "running" || this.run.status === "bootstrapping")
      ) {
        const state = this.game.snapshot();
        if (
          state.status !== "connected" ||
          state.world_id !== this.run.world_id ||
          state.epoch !== this.run.epoch
        ) {
          this.requestSafetyPause(BRIDGE_FAILURE, true);
        }
      }
    });
    this.onChange();
  }

  snapshot(): RunView | null {
    if (!this.run) return null;
    const { baseline: _baseline, ...view } = this.run;
    return structuredClone({
      ...view,
      action: this.actionView,
      policies: this.policies,
    });
  }

  getRun(id: string): RunView | null {
    if (this.run?.run_id === id) return this.snapshot();
    const run = this.store.getRun(id);
    if (!run) return null;
    const { baseline: _baseline, ...view } = run;
    return { ...view, action: null, policies: this.store.policies(id) };
  }

  async createRun(input: {
    task: string;
    goal: GoalId;
    model_id: string;
  }): Promise<RunView> {
    return await this.serialize(async () => {
      if (this.closed)
        throw new RuntimeFault("unavailable", "The runtime is closed");
      if (this.run && !TERMINAL[this.run.status])
        throw new RuntimeFault(
          "conflict",
          "Stop the current run before creating another",
        );
      const parsed = z
        .object({
          task: z.string().trim().min(1).max(4_000),
          goal: goalSchema,
          model_id: z.string().min(1).max(200),
        })
        .strict()
        .parse(input);
      const state = this.game.snapshot();
      if (state.status !== "connected" || !state.world_id)
        throw new RuntimeFault(
          "backend_unavailable",
          "Connect the game before creating a run",
        );
      if (
        !this.auth
          .snapshot()
          .models.some((model) => model.id === parsed.model_id)
      )
        throw new RuntimeFault(
          "invalid_request",
          "Choose a model from the current authenticated model list",
        );
      this.generation++;
      this.leaseGeneration++;
      this.run = {
        run_id: randomUUID(),
        world_id: state.world_id,
        epoch: state.epoch,
        task: parsed.task,
        goal: parsed.goal,
        model_id: parsed.model_id,
        status: "created",
        started_at: null,
        ended_at: null,
        turns: 0,
        model_status: "idle",
        error: null,
        usage: { input_tokens: 0, output_tokens: 0, known_cost: null },
        baseline: {},
      };
      this.policies = [];
      this.slots.clear();
      this.observation = null;
      this.observationRequest = null;
      this.actionView = null;
      this.completedCrafts.clear();
      this.needsReconnect = false;
      this.bootstrapCalls = 0;
      this.emptyTurns = 0;
      this.workRevision = 0;
      this.contextCursor = 0;
      this.store.saveRun(this.run, "Run created; no game effects admitted");
      this.onChange();
      return this.snapshot()!;
    });
  }

  async control(
    id: string,
    command: "start" | "pause" | "resume" | "stop",
  ): Promise<RunView> {
    if (command === "stop") {
      if (!this.run || this.run.run_id !== id)
        throw new RuntimeFault("not_found", "Run not found");
      if (!TERMINAL[this.run.status])
        this.fenceStop(
          "Operator stopped the run; effect admission revoked immediately",
        );
    }
    return await this.serialize(async () => {
      if (!this.run || this.run.run_id !== id)
        throw new RuntimeFault("not_found", "Run not found");
      if (this.closed && command !== "stop")
        throw new RuntimeFault("unavailable", "The runtime is closed");
      if (command === "stop") {
        if (!TERMINAL[this.run.status])
          await this.halt("stopped", "Operator stopped the run");
      } else if (command === "pause") {
        if (
          this.run.status === "running" ||
          this.run.status === "bootstrapping"
        )
          await this.halt("paused", "Operator paused the run");
        else if (this.run.status !== "paused")
          throw new RuntimeFault(
            "conflict",
            "Only a running run can be paused",
          );
      } else if (command === "start") {
        if (this.run.status !== "created")
          throw new RuntimeFault(
            "conflict",
            "Only a created run can be started",
          );
        await this.begin(false);
      } else {
        if (this.run.status !== "paused")
          throw new RuntimeFault(
            "conflict",
            "Only a paused run can be resumed",
          );
        await this.begin(true);
      }
      return this.snapshot()!;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.run && !TERMINAL[this.run.status])
      this.fenceStop(
        "Application closing; effect admission revoked immediately",
      );
    await this.serialize(async () => {
      if (this.run && !TERMINAL[this.run.status])
        await this.halt("stopped", "Application closed; work is not replayed");
      this.clearScheduler();
      this.unsubscribeGame?.();
      this.unsubscribeGame = null;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private persist(summary?: string): void {
    if (!this.run) return;
    this.store.saveRun(this.run, summary);
    this.onChange();
  }

  private assertCurrent(generation: number, epoch?: number): StoredRun {
    const run = this.run;
    if (
      !run ||
      generation !== this.generation ||
      (run.status !== "running" && run.status !== "bootstrapping")
    )
      throw new RuntimeFault(
        "stale_context",
        "This strategic request no longer has run authority",
      );
    if (epoch !== undefined && epoch !== run.epoch)
      throw new RuntimeFault("stale_epoch", "Use the current run epoch");
    const state = this.game.snapshot();
    if (
      state.status !== "connected" ||
      state.epoch !== run.epoch ||
      state.world_id !== run.world_id
    )
      throw new RuntimeFault(
        "stale_epoch",
        "The game connection changed; pause and reconnect before continuing",
      );
    return run;
  }

  private async begin(resuming: boolean): Promise<void> {
    const run = this.run!;
    const state = this.game.snapshot();
    if (state.status !== "connected" || state.world_id !== run.world_id)
      throw new RuntimeFault(
        "backend_unavailable",
        "Connect the same game world before starting or resuming",
      );
    if (this.needsReconnect && state.epoch <= run.epoch)
      throw new RuntimeFault(
        "unknown_effect",
        "Reconnect the game to a fresh epoch before resuming uncertain work",
      );
    if (this.auth.snapshot().status !== "ready")
      throw new RuntimeFault(
        "unauthorized",
        "Complete model authorization before starting",
      );
    if (this.sandbox.snapshot().status !== "ready")
      throw new RuntimeFault(
        "backend_unavailable",
        "Prepare the isolated policy runtime before starting",
      );
    const generation = ++this.generation;
    this.leaseGeneration++;
    run.epoch = state.epoch;
    this.observation = null;
    this.observationRequest = null;
    this.needsReconnect = false;
    this.providerFailed = false;
    this.emptyTurns = 0;
    run.error = null;
    const observation = await this.game.observe();
    if (generation !== this.generation || this.closed) return;
    if (
      observation.epoch !== run.epoch ||
      observation.world_id !== run.world_id
    )
      throw new RuntimeFault(
        "stale_epoch",
        "The initial observation belongs to a different connection",
      );
    const current = this.game.snapshot();
    if (
      current.status !== "connected" ||
      current.epoch !== run.epoch ||
      current.world_id !== run.world_id
    )
      throw new RuntimeFault(
        "stale_epoch",
        "The game connection changed during startup",
      );
    this.observation = observation;
    if (!resuming) {
      run.baseline = inventoryCounts(observation);
      run.started_at = new Date().toISOString();
      this.bootstrapDeadline = Date.now() + BOOTSTRAP_MS;
    }
    const bootstrap = !resuming;
    run.status = bootstrap ? "bootstrapping" : "running";
    run.model_status = "idle";
    this.persist(
      resuming
        ? "Run resumed with fresh connection fences and worker state"
        : "Bootstrap admitted; game effects remain closed",
    );
    try {
      const agent = await this.auth.createAgent({
        modelId: run.model_id,
        systemPrompt: [this.rootPrompt()],
        tools: this.tools(generation),
      });
      if (generation !== this.generation || this.closed) {
        await this.auth.releaseAgent(agent);
        return;
      }
      try {
        this.assertCurrent(generation);
      } catch (error) {
        await this.auth.releaseAgent(agent);
        throw error;
      }
      this.agent = agent;
      agent.setBeforeModelCall(() => {
        if (
          generation !== this.generation ||
          this.closed ||
          !this.run ||
          (this.run.status !== "running" && this.run.status !== "bootstrapping")
        )
          return { stop: true, reason: "Run authority revoked" };
        const bootstrapping = this.run.status === "bootstrapping";
        if (
          this.turnCalls >= TURN_CALLS ||
          (bootstrapping &&
            (this.bootstrapCalls >= BOOTSTRAP_CALLS ||
              Date.now() >= this.bootstrapDeadline))
        )
          return {
            stop: true,
            reason: "Finite strategic call allowance reached",
          };
        this.turnCalls++;
        if (bootstrapping) this.bootstrapCalls++;
        this.run.turns++;
        this.store.event(
          this.run.run_id,
          "model.call",
          "Strategic model inference started",
          { turn: this.run.turns, generation, bootstrap: bootstrapping },
        );
        this.persist();
      });
      agent.beforeToolCall = (_context, signal) => {
        if (
          signal?.aborted ||
          generation !== this.generation ||
          ++this.turnToolCalls > TOOL_CALLS
        )
          return {
            block: true,
            reason: "This strategic turn has no remaining tool authority",
          };
      };
      this.unsubscribeAgent = agent.subscribe((event) =>
        this.agentEvent(event, generation),
      );
      // Pausing retains immutable selection, not worker processes or private state.
      for (const slot of this.slots.values()) {
        this.assertCurrent(generation);
        if (slot.view.state !== "trial" && slot.view.state !== "active")
          continue;
        if (
          slot.view.state === "trial" &&
          slot.trial_started > 0 &&
          Date.now() >= slot.trial_deadline
        ) {
          slot.view.state = "validated";
          slot.tried = true;
          this.store.savePolicy(
            run.run_id,
            slot.view,
            "Policy trial expired while paused",
          );
          this.store.event(
            run.run_id,
            "policy.trial_decision_due",
            "Previously suspended trial expired; its workers and effects remain closed",
            {
              policy_id: slot.view.policy_id,
              version: slot.view.version,
              reason: "elapsed_while_paused",
              actions: slot.trial_actions,
              evaluations: slot.trial_evaluations,
              effects: slot.view.effects,
            },
          );
          this.wakeReasons.add("trial_decision_due");
          continue;
        }
        slot.generation++;
        const policyGeneration = slot.generation;
        slot.closure = null;
        const worker = await this.sandbox.createWorker(policySpec(slot.view));
        if (
          generation !== this.generation ||
          this.closed ||
          policyGeneration !== slot.generation ||
          slot.closure
        ) {
          await worker.close();
          return;
        }
        try {
          this.assertCurrent(generation);
        } catch (error) {
          await worker.close();
          throw error;
        }
        slot.worker = worker;
        if (run.status === "running") this.schedulePolicy(slot);
      }
      this.assertCurrent(generation);
      this.wake(bootstrap ? "bootstrap" : "recovery_completed");
    } catch {
      if (generation !== this.generation || this.closed) return;
      await this.halt(
        "paused",
        "The authenticated strategic agent or isolated worker could not be prepared. Check service readiness before resuming.",
      );
    }
  }

  private rootPrompt(): string {
    const run = this.run!;
    const goal = GOALS.find((choice) => choice.id === run.goal)!;
    return [
      "You are the single strategic agent controlling one ordinary game player through the supplied filtered tools. Complete the operator task using real observations and verified effects. Never invent outcomes or use developer-authored tactics. There are no grants, teleports, raw world reads, host code, network access, or hidden game state.",
      `Task: ${run.task}\nVerifier contract: ${goal.prompt}`,
      "Inference has latency. Bounded game actions execute asynchronously and isolated policies evaluate independently during inference. Use that concurrency deliberately: action_submit returns an accepted ledger ID immediately, not completion. action_get and feedback_read report real outcomes. A later tool call/model inference can overlap an already admitted action. Do not repeatedly resubmit equivalent work or renew its deadline. Keep stable action_id keys for retries; unknown effects must never be replayed under new keys.",
      "Read capabilities_read and observation_read to discover exact schemas, present epoch, observation permissions, units and limits. Only use target IDs in authorized observations; remembered objects are not guaranteed current. recipes_read returns actual mechanical recipes; craft.executions means recipe executions, not desired output count. Never infer hidden objects from omission. Current observation changes alone do not invalidate unrelated work; connection epoch and exclusive-lease changes do.",
      "During bootstrap, at most three inference calls and 60 seconds are allowed. Read, author, validate and activate policy readiness, but game effects are forbidden until the host automatically enters running. Do not wait for another human prompt. Thereafter each strategic turn has at most 12 inference calls, 48 tools and 120 seconds. The host wakes you on outcomes, replans, trial boundaries and bounded idle continuation; do not poll the model or spin on status tools.",
      'Create your own useful reactive policy from observed needs. policy_register accepts immutable source plus a human-readable StrategyCard (purpose, applicability, method, reason, limitations), priority and interval_ms >= 200. source is only an async function BODY with parameters context and state. context has {observation, action, task}; state is a private persistent JSON object initially empty for each new worker. No tools, provider, network, files or game objects are available inside a policy. You may mutate state (16 KiB). Return exactly {kind:"continue",reason?}, {kind:"replan",reason}, {kind:"interrupt",reason}, or {kind:"replace",action,reason}; action follows the advertised GameAction schema. No handwritten policy or tactical example is installed for you.',
      "Validate exact policy_id/version with policy_validate before policy_activate. Validation executes in isolation with current filtered context and causes no game effects. Initial activation mode trial is bounded to 120 seconds, 20 action admissions and 100 evaluations, or smaller supplied limits. At most four policies are selected. Trials close their proposals/workers/effects at the first bound and wake you with evidence. mode keep is an explicit selection decision permitted only after that exact version has real confirmed effect/neutralization evidence; self-ratings, continue, no-op and acceptance are not effectiveness evidence. Expired trials cannot be renewed by another trial activation. A revised immutable version may be trialled. Feedback retains source/version/evaluation/action attribution.",
      "Policy priority is used by the single exclusive-effect scheduler. A replacement may preempt lower-priority work, or its own equal-priority work, only after confirmed cancellation and awaited emitter shutdown. Redundant equivalent proposals do not cancel or prolong the current action. Pause/stop/epoch changes revoke old model, policy and lease generations. Custom tasks have no automatic completion verifier: report progress honestly and leave stopping to the operator. Built-in goals complete only through the trusted verifier, never your prose.",
      "Write brief user-visible explanations of your actual decisions and evidence; never disclose hidden reasoning. Tool failures and service unavailability are evidence, not permission to invent results or fall back to a handwritten strategy.",
    ].join("\n\n");
  }

  private tools(generation: number): AgentTool[] {
    const tool = <T>(
      name: string,
      description: string,
      schema: z.ZodType<T>,
      handler: (
        input: T,
        callId: string,
        signal?: AbortSignal,
      ) => unknown | Promise<unknown>,
    ): AgentTool => ({
      name,
      label: name,
      description,
      intent: "omit",
      concurrency: "exclusive",
      parameters: z.toJSONSchema(schema, { unrepresentable: "any" }),
      execute: async (callId, raw, signal) => {
        try {
          if (signal?.aborted)
            throw new RuntimeFault(
              "stale_context",
              "The strategic request was cancelled",
            );
          this.assertCurrent(generation);
          const input = schema.parse(raw);
          const value = await handler(input, callId, signal);
          if (name !== "feedback_read") {
            this.store.event(
              this.run!.run_id,
              "model.tool_result",
              `Strategic tool ${name} returned service evidence`,
              {
                tool_call_id: callId,
                tool: name,
                result: JSON.parse(JSON.stringify(value)) as Json,
              },
            );
          }
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            details: value,
          };
        } catch (error) {
          const failure =
            error instanceof RuntimeFault
              ? { code: error.code, message: error.message, retryable: false }
              : {
                  code:
                    error instanceof z.ZodError
                      ? "invalid_request"
                      : "backend_unavailable",
                  message:
                    error instanceof z.ZodError
                      ? "Tool arguments do not match the advertised schema"
                      : "The requested service operation could not complete safely",
                  retryable: false,
                };
          this.store.event(
            this.run!.run_id,
            "model.tool_rejected",
            "Strategic tool returned a fixed safe rejection",
            { tool_call_id: callId, tool: name, error: failure },
          );
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: failure }) },
            ],
            details: { error: failure },
            isError: true,
          };
        }
      },
    });
    const empty = z.object({}).strict();
    return [
      tool(
        "capabilities_read",
        "Read actual schemas, finite runtime limits, current phase and observation permissions.",
        empty,
        () => ({
          run_id: this.run!.run_id,
          epoch: this.run!.epoch,
          phase: this.run!.status,
          observation_profile: {
            id: "player-observable-structured",
            preset: "minecraft-observable-initial-r1",
            radius_blocks: 32,
            freshness_ms: 1_000,
            remembered_is_current: false,
            hidden_state: false,
          },
          game_action_schema: z.toJSONSchema(gameActionSchema),
          policy_spec_schema: z.toJSONSchema(policySpecSchema, {
            unrepresentable: "any",
          }),
          policy_decision_schema: z.toJSONSchema(policyDecisionSchema),
          limits: {
            queue: MAX_QUEUE,
            active_policies: MAX_POLICIES,
            policy_interval_min_ms: 200,
            policy_evaluation_ms: 500,
            trial_ms: 120_000,
            trial_actions: 20,
            trial_evaluations: 100,
            turn_calls: TURN_CALLS,
            turn_tools: TOOL_CALLS,
            bootstrap_calls: BOOTSTRAP_CALLS,
            bootstrap_ms: BOOTSTRAP_MS,
          },
          skills: "unsupported",
          custom_completion: "operator_only",
          effects: this.run!.status === "running" ? "open" : "closed",
        }),
      ),
      tool(
        "observation_read",
        "Read a current filtered player observation. Unknown and remembered objects are not present-effect authorization.",
        empty,
        async () => await this.refreshObservation(),
      ),
      tool(
        "action_submit",
        "Durably admit one bounded asynchronous action with a stable caller action_id. Returns immediately; accepted does not mean executed. Equivalent active/queued requests are deduplicated without deadline renewal.",
        actionSubmitSchema,
        (input) => {
          const existing = this.store.getAction(
            this.run!.run_id,
            input.action_id,
          );
          if (existing) {
            if (equivalent(existing.request) !== equivalent(input.action))
              throw new RuntimeFault(
                "conflict",
                "This action_id already identifies different action content",
              );
            return existing.view;
          }
          this.assertCurrent(generation, input.epoch);
          return this.admit(
            input.action_id,
            input.action,
            input.priority,
            input.deadline_ms,
            null,
          );
        },
      ),
      tool(
        "action_get",
        "Read one durable action outcome; this never submits or resumes work.",
        z.object({ action_id: idSchema }).strict(),
        (input) => {
          const action = this.store.getAction(
            this.run!.run_id,
            input.action_id,
          );
          if (!action) throw new RuntimeFault("not_found", "Action not found");
          return action.view;
        },
      ),
      tool(
        "action_cancel",
        "Request cancellation without waiting for its effects to settle. Poll action_get or consume feedback for confirmed outcome; acknowledgement alone is not neutralization.",
        z.object({ epoch: epochSchema, action_id: idSchema }).strict(),
        (input) => {
          this.assertCurrent(generation, input.epoch);
          const action = this.store.getAction(
            this.run!.run_id,
            input.action_id,
          );
          if (!action) throw new RuntimeFault("not_found", "Action not found");
          if (ACTION_TERMINAL[action.view.status]) return action.view;
          const queued = this.queue.find(
            (entry) => entry.stored.view.action_id === input.action_id,
          );
          if (queued) {
            this.queue = this.queue.filter((entry) => entry !== queued);
            this.closeQueued(queued, "Cancelled before dispatch");
          } else if (
            this.active?.entry.stored.view.action_id === input.action_id
          )
            void this.cancelExecution(
              this.active,
              "Strategist requested cancellation",
            );
          return this.store.getAction(this.run!.run_id, input.action_id)!.view;
        },
      ),
      tool(
        "recipes_read",
        "Read actual available mechanical recipes for an item. Craft counts are recipe executions.",
        z.object({ item: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/) }).strict(),
        async (input) => await this.game.recipes(input.item),
      ),
      tool(
        "policy_register",
        "Register LLM-authored immutable source, StrategyCard and interval/priority; no validation or game effect is implied.",
        z.object({ epoch: epochSchema, spec: policySpecSchema }).strict(),
        (input) => {
          this.assertCurrent(generation, input.epoch);
          const view = this.store.registerPolicy(
            this.run!.run_id,
            input.spec,
            this.run!.turns,
          );
          if (
            !this.policies.some(
              (policy) =>
                policy.policy_id === view.policy_id &&
                policy.version === view.version,
            )
          )
            this.policies.push(view);
          this.onChange();
          return view;
        },
      ),
      tool(
        "policy_validate",
        "Compile and evaluate the exact immutable policy in a disposable isolated worker using current filtered context. A valid result is not effectiveness evidence and has no game effects.",
        policyRefSchema,
        async (input, _callId, signal) => {
          this.assertCurrent(generation, input.epoch);
          const view = this.findPolicy(input.policy_id, input.version);
          if (view.state === "quarantined" || view.state === "retired")
            throw new RuntimeFault(
              "conflict",
              "Register a revised version before validating a quarantined or retired policy",
            );
          if (view.state === "trial" || view.state === "active") return view;
          const context = await this.policyContext();
          this.assertCurrent(generation, input.epoch);
          try {
            await this.sandbox.validate(policySpec(view), context);
          } catch {
            this.assertCurrent(generation, input.epoch);
            if (signal?.aborted)
              throw new RuntimeFault(
                "stale_context",
                "The strategic validation request was cancelled",
              );
            view.state = "quarantined";
            view.last_error =
              "Isolated policy validation failed or exceeded its limits";
            this.store.savePolicy(this.run!.run_id, view, view.last_error);
            this.onChange();
            throw new RuntimeFault("precondition_failed", view.last_error);
          }
          this.assertCurrent(generation, input.epoch);
          if (signal?.aborted)
            throw new RuntimeFault(
              "stale_context",
              "The strategic validation request was cancelled",
            );
          if (view.state === "draft") view.state = "validated";
          view.last_error = null;
          this.store.savePolicy(
            this.run!.run_id,
            view,
            `Policy ${view.name} v${view.version} passed isolated validation; effectiveness is unmeasured`,
          );
          this.onChange();
          return view;
        },
      ),
      tool(
        "policy_activate",
        "Select an exact validated version as a bounded trial, or explicitly keep a tried version with confirmed effect evidence. Repeated activation does not extend trial bounds.",
        activateSchema,
        async (input, _callId, signal) =>
          await this.activatePolicy(input, generation, signal),
      ),
      tool(
        "policy_retire",
        "Revoke evaluations/proposals, close the exact version worker and safely cancel its queued/active effects.",
        policyRefSchema,
        async (input) => {
          this.assertCurrent(generation, input.epoch);
          const view = this.findPolicy(input.policy_id, input.version);
          const slot = this.slots.get(`${view.policy_id}:${view.version}`);
          if (slot)
            await this.closePolicy(
              slot,
              "retired",
              "Strategist retired the policy",
            );
          else {
            view.state = "retired";
            this.store.savePolicy(
              this.run!.run_id,
              view,
              "Strategist retired the policy",
            );
          }
          this.assertCurrent(generation, input.epoch);
          this.onChange();
          return view;
        },
      ),
      tool(
        "feedback_read",
        "Read bounded durable actual explanations, admissions, results and attributable policy evaluation/effect evidence. Use after_event_seq as a cursor.",
        z
          .object({
            after_event_seq: z.number().int().nonnegative().default(0),
            limit: z.number().int().min(1).max(100).default(64),
          })
          .strict(),
        (input) => {
          const candidates = this.store.eventsAfter(
            this.run!.run_id,
            input.after_event_seq,
            input.limit,
          );
          const events: ActivityEvent[] = [];
          let bytes = 0;
          for (const event of candidates) {
            const size = Buffer.byteLength(JSON.stringify(event));
            if (events.length && bytes + size > 64 * 1024) break;
            // One record always advances the cursor. Oversized durable evidence
            // remains identified, rather than stranding all following feedback.
            if (size > 64 * 1024) {
              events.push({
                ...event,
                details: {
                  omitted: true,
                  reason:
                    "Single event exceeds the feedback byte budget; full evidence remains in the protected run activity view",
                  original_bytes: size,
                },
              });
            } else events.push(event);
            bytes += Math.min(size, 64 * 1024);
          }
          const last = events[events.length - 1];
          this.store.event(
            this.run!.run_id,
            "model.feedback_read",
            "Strategist read a bounded forward evidence interval",
            {
              after_event_seq: input.after_event_seq,
              through_event_seq: last?.event_seq ?? input.after_event_seq,
              records: events.length,
            },
          );
          return {
            events,
            next_event_seq: last?.event_seq ?? input.after_event_seq,
            page_full:
              events.length < candidates.length ||
              candidates.length === input.limit,
            run: {
              run_id: this.run!.run_id,
              epoch: this.run!.epoch,
              status: this.run!.status,
              action: this.active?.entry.stored.view ?? this.actionView,
            },
          };
        },
      ),
    ];
  }

  private findPolicy(id: string, version: number): PolicyView {
    const view = this.policies.find(
      (policy) => policy.policy_id === id && policy.version === version,
    );
    if (!view)
      throw new RuntimeFault(
        "not_found",
        "Policy version not found in this run",
      );
    return view;
  }

  private async refreshObservation(): Promise<Observation> {
    if (this.observationRequest) return await this.observationRequest;
    const generation = this.generation;
    const run = this.run;
    if (!run) throw new RuntimeFault("not_found", "No run exists");
    const request = (async () => {
      const observation = await this.game.observe();
      if (
        generation !== this.generation ||
        observation.world_id !== run.world_id ||
        observation.epoch !== run.epoch
      )
        throw new RuntimeFault(
          "stale_epoch",
          "The observation belongs to obsolete run authority",
        );
      if (
        !this.observation ||
        observation.observation_seq >= this.observation.observation_seq
      )
        this.observation = observation;
      this.verifyGoal(this.observation!);
      return this.observation!;
    })();
    this.observationRequest = request;
    try {
      return await request;
    } finally {
      if (this.observationRequest === request) this.observationRequest = null;
    }
  }

  private async policyContext(): Promise<PolicyContext> {
    const observation = await this.refreshObservation();
    return {
      observation,
      action: this.active
        ? structuredClone(this.active.entry.stored.view)
        : null,
      task: this.run!.task,
    };
  }

  private admit(
    id: string,
    action: GameAction,
    priority: number,
    requestedDeadline: number | undefined,
    policy: PolicySlot | null,
  ): ActionView {
    const run = this.run!;
    if (run.status !== "running" || this.needsReconnect)
      throw new RuntimeFault(
        "precondition_failed",
        "Game effects are closed until the run is running with a safe connection",
      );
    const canonical = equivalent(action);
    const matching =
      this.active && equivalent(this.active.entry.stored.request) === canonical
        ? this.active.entry
        : this.queue.find(
            (entry) => equivalent(entry.stored.request) === canonical,
          );
    if (matching) {
      const duplicate = this.store.admitAction(
        run.run_id,
        id,
        action,
        policy ? "policy" : "strategist",
      );
      if (duplicate.created) {
        duplicate.action.view.status = "cancelled";
        duplicate.action.view.ended_at = new Date().toISOString();
        duplicate.action.view.summary =
          "Redundant equivalent proposal rejected without dispatch or deadline renewal";
        duplicate.action.view.result = {
          status: "cancelled",
          summary: duplicate.action.view.summary,
          evidence: {
            dispatched: false,
            duplicate_of: matching.stored.view.action_id,
          },
        };
        this.store.saveAction(run.run_id, duplicate.action.view);
      }
      this.store.event(
        run.run_id,
        "action.redundant",
        "Equivalent work already exists; its deadline was not renewed",
        {
          proposed_action_id: id,
          action_id: matching.stored.view.action_id,
          policy_id: policy?.view.policy_id ?? null,
          version: policy?.view.version ?? null,
        },
      );
      this.onChange();
      return structuredClone(duplicate.action.view);
    }
    if (this.queue.length >= MAX_QUEUE)
      throw new RuntimeFault("busy", "The bounded action queue is full");
    if (
      policy &&
      (policy.closure ||
        !policy.worker ||
        (policy.view.state !== "active" && policy.view.state !== "trial"))
    )
      throw new RuntimeFault(
        "stale_context",
        "The policy is no longer selected",
      );
    if (
      policy?.view.state === "trial" &&
      (policy.trial_actions >= policy.max_actions ||
        Date.now() >= policy.trial_deadline)
    )
      throw new RuntimeFault(
        "deadline_exceeded",
        "The policy trial has reached its action or time bound",
      );
    const admitted = this.store.admitAction(
      run.run_id,
      id,
      action,
      policy ? "policy" : "strategist",
    );
    if (!admitted.created) return structuredClone(admitted.action.view);
    const defaultMs =
      action.kind === "navigate"
        ? action.duration_ms + 2_000
        : action.kind === "move"
          ? action.duration_ms + 2_000
          : action.kind === "dig" || action.kind === "craft"
            ? 12_000
            : 5_000;
    const entry: QueueEntry = {
      stored: admitted.action,
      priority,
      deadline: Date.now() + (requestedDeadline ?? defaultMs),
      order: this.nextOrder++,
      generation: this.generation,
      epoch: run.epoch,
      policy,
      policy_generation: policy?.generation ?? null,
    };
    if (policy) {
      if (policy.view.state === "trial") policy.trial_actions++;
      this.store.event(
        run.run_id,
        "policy.action_admitted",
        "Policy proposal received a durable action ID",
        {
          policy_id: policy.view.policy_id,
          version: policy.view.version,
          action_id: id,
          trial_actions: policy.trial_actions,
        },
      );
    }
    this.queue.push(entry);
    this.queue.sort(
      (left, right) =>
        right.priority - left.priority || left.order - right.order,
    );
    this.actionView = admitted.action.view;
    this.workRevision++;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.emptyTurns = 0;
    this.onChange();
    // Dispatch after returning the admission result, never inside the tool's effect path.
    queueMicrotask(() => this.startPump());
    return structuredClone(admitted.action.view);
  }

  private startPump(): void {
    if (
      this.pumping ||
      this.preempting ||
      !this.run ||
      this.run.status !== "running" ||
      this.needsReconnect
    )
      return;
    const pumping = this.pump();
    this.pumping = pumping;
    void pumping
      .catch(() => this.requestSafetyPause(BRIDGE_FAILURE, true))
      .finally(() => {
        if (this.pumping === pumping) this.pumping = null;
        if (
          this.run?.status === "running" &&
          this.queue.length &&
          !this.needsReconnect
        )
          this.startPump();
      });
  }

  private async pump(): Promise<void> {
    while (
      this.run?.status === "running" &&
      !this.needsReconnect &&
      !this.preempting &&
      this.queue.length
    ) {
      const entry = this.queue.shift()!;
      if (!this.entryCurrent(entry) || Date.now() >= entry.deadline) {
        this.closeQueued(
          entry,
          "Queued action authority or deadline expired before dispatch",
        );
        continue;
      }
      const execution: Execution = {
        entry,
        controller: new AbortController(),
        done: Promise.resolve(),
        cancellation: null,
        neutralized: false,
      };
      this.active = execution;
      this.leaseGeneration++;
      entry.stored.view.status = "running";
      entry.stored.view.started_at = new Date().toISOString();
      entry.stored.view.summary = `${entry.stored.request.kind} executing under the exclusive effect lease`;
      this.actionView = entry.stored.view;
      this.store.saveAction(this.run.run_id, entry.stored.view);
      this.onChange();
      execution.done = this.execute(execution);
      await execution.done;
      if (execution.cancellation) await execution.cancellation;
      if (this.active === execution) this.active = null;
      this.leaseGeneration++;
      this.onChange();
      if (!this.queue.length && this.run?.status === "running")
        this.wake("work_decision_needed");
    }
    if (!this.active && !this.queue.length && this.run?.status === "running")
      this.wake("work_decision_needed");
  }

  private entryCurrent(entry: QueueEntry): boolean {
    if (
      !this.run ||
      entry.generation !== this.generation ||
      entry.epoch !== this.run.epoch
    )
      return false;
    if (
      entry.policy &&
      (entry.policy_generation !== entry.policy.generation ||
        entry.policy.closure ||
        (entry.policy.view.state !== "trial" &&
          entry.policy.view.state !== "active"))
    )
      return false;
    const state = this.game.snapshot();
    return (
      state.status === "connected" &&
      state.world_id === this.run.world_id &&
      state.epoch === this.run.epoch
    );
  }

  private async execute(execution: Execution): Promise<void> {
    const runId = this.run!.run_id;
    const { entry } = execution;
    const timer = setTimeout(
      () => {
        void this.cancelExecution(execution, "Action deadline reached");
      },
      Math.max(1, entry.deadline - Date.now()),
    );
    let result: GameActionResult;
    try {
      result = await this.game.execute(
        entry.stored.request,
        execution.controller.signal,
      );
    } catch {
      result = {
        status: "unknown",
        summary: "The game executor did not return a confirmed outcome",
        evidence: null,
        requires_reconnect: true,
      };
    } finally {
      clearTimeout(timer);
    }
    if (result.status === "unknown" || result.requires_reconnect)
      this.requestSafetyPause(BRIDGE_FAILURE, true);
    const view = entry.stored.view;
    view.status = result.status;
    view.summary = result.summary;
    view.result = result;
    view.ended_at = new Date().toISOString();
    this.store.saveAction(runId, view);
    this.actionView = view;
    if (result.status === "succeeded") {
      if (entry.stored.request.kind === "craft")
        this.completedCrafts.add(entry.stored.request.item);
      const evidence = result.evidence;
      if (
        entry.policy &&
        evidence &&
        typeof evidence === "object" &&
        !Array.isArray(evidence) &&
        evidence.effect_confirmed === true
      ) {
        this.recordPolicyEffect(entry.policy, "executed", {
          action_id: view.action_id,
          result: result as unknown as Json,
        });
      }
    }
    this.onChange();
    if (result.status === "succeeded" && this.run?.status === "running") {
      await this.refreshObservation().catch(() => {
        /* A later authoritative observation can establish inventory receipt. */
      });
    }
  }

  private cancelExecution(execution: Execution, reason: string): Promise<void> {
    if (execution.cancellation) return execution.cancellation;
    const runId = this.run!.run_id;
    const view = execution.entry.stored.view;
    if (ACTION_TERMINAL[view.status]) return execution.done;
    this.leaseGeneration++;
    view.status = "cancel_requested";
    view.summary = reason;
    this.store.saveAction(runId, view);
    execution.controller.abort();
    const cancellation = (async () => {
      let confirmed = false;
      try {
        await this.game.cancel(reason);
        confirmed = true;
      } catch {
        this.requestSafetyPause(BRIDGE_FAILURE, true);
      }
      await execution.done;
      execution.neutralized =
        confirmed &&
        view.result?.status !== "unknown" &&
        !view.result?.requires_reconnect;
      if (!execution.neutralized && !this.needsReconnect)
        this.requestSafetyPause(BRIDGE_FAILURE, true);
      this.store.event(
        runId,
        "action.cancellation_settled",
        execution.neutralized
          ? "Effect emitter shutdown confirmed; earlier effects are not reversed"
          : "Effect emitter shutdown remains uncertain; reconnect required",
        { action_id: view.action_id, neutralized: execution.neutralized },
      );
      this.onChange();
    })();
    execution.cancellation = cancellation;
    this.onChange();
    return cancellation;
  }

  private closeQueued(entry: QueueEntry, reason: string): void {
    const view = entry.stored.view;
    view.status = "cancelled";
    view.summary = reason;
    view.ended_at = new Date().toISOString();
    view.result = {
      status: "cancelled",
      summary: reason,
      evidence: { dispatched: false },
    };
    this.store.saveAction(this.run!.run_id, view);
    this.actionView = view;
    this.onChange();
  }

  private async activatePolicy(
    input: z.infer<typeof activateSchema>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<PolicyView> {
    this.assertCurrent(generation, input.epoch);
    const view = this.findPolicy(input.policy_id, input.version);
    const key = `${view.policy_id}:${view.version}`;
    let slot = this.slots.get(key);
    if (
      slot?.worker &&
      !slot.closure &&
      (view.state === "active" || view.state === "trial")
    ) {
      if (input.mode === "trial" || view.state === "active") return view;
      if (view.effects < 1)
        throw new RuntimeFault(
          "precondition_failed",
          "Keeping a policy requires confirmed effect evidence from this exact version",
        );
      view.state = "active";
      slot.tried = true;
      clearTimeout(slot.expiry);
      slot.expiry = undefined;
      this.store.savePolicy(
        this.run!.run_id,
        view,
        "Strategist explicitly kept the policy using confirmed effect evidence",
      );
      this.workRevision++;
      this.onChange();
      return view;
    }
    if (view.state !== "validated")
      throw new RuntimeFault(
        "precondition_failed",
        "Validate the exact policy version before activation",
      );
    if (input.mode === "keep" && (!slot?.tried || view.effects < 1))
      throw new RuntimeFault(
        "precondition_failed",
        "Keeping a policy requires a tried version and real confirmed effect evidence",
      );
    if (input.mode === "trial" && slot?.tried)
      throw new RuntimeFault(
        "conflict",
        "This exact version already consumed its trial; explicitly keep with evidence or register a revision",
      );
    const selected = [...this.slots.values()].filter(
      (candidate) =>
        candidate.worker &&
        !candidate.closure &&
        (candidate.view.state === "trial" || candidate.view.state === "active"),
    );
    const prior = selected.find(
      (candidate) => candidate.view.policy_id === view.policy_id,
    );
    if (!prior && selected.length >= MAX_POLICIES)
      throw new RuntimeFault("busy", "At most four policies can be selected");
    // Revocation and old effect settlement precede replacement-worker ownership.
    if (prior)
      await this.closePolicy(
        prior,
        "validated",
        "A newer immutable version replaced this selection",
      );
    this.assertCurrent(generation, input.epoch);
    if (!slot) {
      slot = {
        view,
        generation: 0,
        worker: null,
        timer: undefined,
        expiry: undefined,
        controller: null,
        evaluation: null,
        closure: null,
        trial_started: 0,
        trial_deadline: 0,
        trial_actions: 0,
        trial_evaluations: 0,
        max_ms: 120_000,
        max_actions: 20,
        max_evaluations: 100,
        tried: false,
      };
      this.slots.set(key, slot);
    }
    slot.generation++;
    slot.closure = null;
    slot.trial_started = 0;
    slot.trial_deadline = 0;
    slot.trial_actions = 0;
    slot.trial_evaluations = 0;
    slot.max_ms = input.max_ms;
    slot.max_actions = input.max_actions;
    slot.max_evaluations = input.max_evaluations;
    // Persist the activation intent and limits before any worker can propose effects.
    this.store.event(
      this.run!.run_id,
      "policy.activation_admitted",
      "Exact immutable policy selection admitted before worker dispatch",
      {
        policy_id: view.policy_id,
        version: view.version,
        mode: input.mode,
        max_ms: input.max_ms,
        max_actions: input.max_actions,
        max_evaluations: input.max_evaluations,
        generation: slot.generation,
      },
    );
    const worker = await this.sandbox.createWorker(policySpec(view));
    try {
      this.assertCurrent(generation, input.epoch);
      if (signal?.aborted)
        throw new RuntimeFault(
          "stale_context",
          "The strategic activation request was cancelled",
        );
    } catch (error) {
      await worker.close();
      throw error;
    }
    slot.worker = worker;
    view.state = input.mode === "keep" ? "active" : "trial";
    view.last_error = null;
    this.store.savePolicy(
      this.run!.run_id,
      view,
      input.mode === "keep"
        ? "Strategist activated a previously tried policy with real effect evidence"
        : "Bounded policy trial activated",
    );
    this.workRevision++;
    if (this.run!.status === "running") this.schedulePolicy(slot);
    this.onChange();
    return view;
  }

  private schedulePolicy(slot: PolicySlot): void {
    if (!slot.worker || slot.closure || this.run?.status !== "running") return;
    if (slot.view.state === "trial" && slot.trial_started === 0) {
      slot.trial_started = Date.now();
      slot.trial_deadline = slot.trial_started + slot.max_ms;
      this.store.event(
        this.run.run_id,
        "policy.trial_started",
        "Gameplay trial clock started with a ready worker and running effect admission",
        {
          policy_id: slot.view.policy_id,
          version: slot.view.version,
          max_ms: slot.max_ms,
          max_actions: slot.max_actions,
          max_evaluations: slot.max_evaluations,
        },
      );
    }
    if (slot.view.state === "trial" && !slot.expiry)
      slot.expiry = setTimeout(
        () => {
          void this.finishTrial(slot, "elapsed_time");
        },
        Math.max(1, slot.trial_deadline - Date.now()),
      );
    if (slot.timer || slot.evaluation) return;
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      if (!slot.worker || slot.closure || this.run?.status !== "running")
        return;
      const evaluation = this.evaluatePolicy(slot);
      slot.evaluation = evaluation;
      void evaluation
        .catch(() => {
          /* Evaluation errors are recorded and quarantined inside evaluatePolicy. */
        })
        .finally(() => {
          if (slot.evaluation === evaluation) slot.evaluation = null;
          this.schedulePolicy(slot);
        });
    }, slot.view.interval_ms);
  }

  private async evaluatePolicy(slot: PolicySlot): Promise<void> {
    if (
      slot.view.state === "trial" &&
      (Date.now() >= slot.trial_deadline ||
        slot.trial_actions >= slot.max_actions ||
        slot.trial_evaluations >= slot.max_evaluations)
    ) {
      // Do not await self-closure: it must await this evaluation's settlement.
      queueMicrotask(() => {
        void this.finishTrial(slot, "trial_bound");
      });
      return;
    }
    const generation = this.generation;
    const policyGeneration = slot.generation;
    const lease = this.leaseGeneration;
    const epoch = this.run!.epoch;
    const evaluationId = randomUUID();
    const worker = slot.worker!;
    const controller = new AbortController();
    slot.controller = controller;
    try {
      const context = await this.policyContext();
      if (
        !this.policyCurrent(
          slot,
          generation,
          policyGeneration,
          epoch,
          lease,
          worker,
        )
      )
        return;
      slot.view.evaluations++;
      if (slot.view.state === "trial") slot.trial_evaluations++;
      this.store.savePolicy(this.run!.run_id, slot.view);
      this.store.event(
        this.run!.run_id,
        "policy.evaluation_started",
        "Isolated policy evaluation started on captured authority",
        {
          evaluation_id: evaluationId,
          policy_id: slot.view.policy_id,
          version: slot.view.version,
          epoch,
          lease_generation: lease,
          observation_seq: context.observation.observation_seq,
        },
      );
      const decision = policyDecisionSchema.parse(
        await worker.evaluate(context, controller.signal),
      );
      if (
        !this.policyCurrent(
          slot,
          generation,
          policyGeneration,
          epoch,
          lease,
          worker,
        )
      ) {
        this.store.event(
          this.run!.run_id,
          "policy.stale_result",
          "Obsolete policy result rejected; newer unrelated observation alone is not a stale condition",
          {
            evaluation_id: evaluationId,
            policy_id: slot.view.policy_id,
            version: slot.view.version,
          },
        );
        return;
      }
      this.store.event(
        this.run!.run_id,
        "policy.evaluated",
        "Isolated policy returned a validated scheduler decision",
        {
          evaluation_id: evaluationId,
          policy_id: slot.view.policy_id,
          version: slot.view.version,
          decision: decision as unknown as Json,
        },
      );
      if (decision.kind === "replan") this.wake("policy_replan");
      else if (decision.kind === "interrupt" || decision.kind === "replace") {
        const current = this.active;
        if (decision.kind === "replace") {
          const canonical = equivalent(decision.action);
          if (
            (current &&
              equivalent(current.entry.stored.request) === canonical) ||
            this.queue.some(
              (entry) => equivalent(entry.stored.request) === canonical,
            )
          ) {
            this.store.event(
              this.run!.run_id,
              "policy.redundant",
              "Equivalent policy replacement ignored without cancelling or extending existing work",
              {
                evaluation_id: evaluationId,
                policy_id: slot.view.policy_id,
                version: slot.view.version,
              },
            );
            return;
          }
        }
        if (
          current &&
          (slot.view.priority < current.entry.priority ||
            (slot.view.priority === current.entry.priority &&
              current.entry.policy !== slot))
        ) {
          this.store.event(
            this.run!.run_id,
            "policy.priority_rejected",
            "Policy decision cannot preempt the current exclusive lease priority",
            {
              evaluation_id: evaluationId,
              policy_id: slot.view.policy_id,
              version: slot.view.version,
            },
          );
          return;
        }
        if (
          current &&
          (current.cancellation ||
            current.entry.stored.view.status === "cancel_requested")
        ) {
          this.store.event(
            this.run!.run_id,
            "policy.cancellation_rejected",
            "Policy cannot claim or replace an interruption already initiated by another request",
            {
              evaluation_id: evaluationId,
              policy_id: slot.view.policy_id,
              version: slot.view.version,
              action_id: current.entry.stored.view.action_id,
            },
          );
          return;
        }
        this.preempting = true;
        try {
          if (current && !ACTION_TERMINAL[current.entry.stored.view.status]) {
            await this.cancelExecution(
              current,
              "Policy requested effect preemption",
            );
            if (!current.neutralized || this.needsReconnect) return;
            // Only our own awaited cancellation may advance the captured lease.
            if (
              !this.policyCurrent(
                slot,
                generation,
                policyGeneration,
                epoch,
                this.leaseGeneration,
                worker,
              ) ||
              (this.active && this.active !== current)
            )
              return;
            const cancellationEvidence =
              current.entry.stored.view.result?.evidence;
            if (
              decision.kind === "interrupt" &&
              current.entry.stored.view.result?.status === "cancelled" &&
              cancellationEvidence &&
              typeof cancellationEvidence === "object" &&
              !Array.isArray(cancellationEvidence) &&
              cancellationEvidence.neutralized_effect === true
            ) {
              this.recordPolicyEffect(slot, "neutralized", {
                evaluation_id: evaluationId,
                action_id: current.entry.stored.view.action_id,
              });
            }
          }
          if (decision.kind === "replace") {
            this.assertCurrent(generation, epoch);
            if (slot.generation !== policyGeneration || slot.closure) return;
            this.admit(
              `policy_${evaluationId}`,
              decision.action,
              slot.view.priority,
              undefined,
              slot,
            );
          } else this.wake("policy_interrupt");
        } finally {
          this.preempting = false;
          this.startPump();
        }
      }
      if (
        slot.view.state === "trial" &&
        (slot.trial_actions >= slot.max_actions ||
          slot.trial_evaluations >= slot.max_evaluations)
      )
        queueMicrotask(() => {
          void this.finishTrial(slot, "trial_bound");
        });
    } catch {
      if (
        generation !== this.generation ||
        policyGeneration !== slot.generation ||
        controller.signal.aborted
      )
        return;
      slot.view.last_error =
        "Isolated policy evaluation failed, returned an invalid decision, or exceeded its limits";
      queueMicrotask(() => {
        void this.closePolicy(slot, "quarantined", slot.view.last_error!).then(
          () => this.wake("policy_error"),
        );
      });
    } finally {
      if (slot.controller === controller) slot.controller = null;
      this.onChange();
    }
  }

  private policyCurrent(
    slot: PolicySlot,
    generation: number,
    policyGeneration: number,
    epoch: number,
    lease: number,
    worker: PolicyWorker,
  ): boolean {
    const state = this.game.snapshot();
    return (
      !!this.run &&
      this.run.status === "running" &&
      generation === this.generation &&
      epoch === this.run.epoch &&
      lease === this.leaseGeneration &&
      slot.generation === policyGeneration &&
      slot.worker === worker &&
      !slot.closure &&
      (slot.view.state === "trial" || slot.view.state === "active") &&
      !this.needsReconnect &&
      state.status === "connected" &&
      state.epoch === epoch &&
      state.world_id === this.run.world_id
    );
  }

  private recordPolicyEffect(
    slot: PolicySlot,
    kind: "executed" | "neutralized",
    evidence: Json,
  ): void {
    slot.view.effects++;
    this.store.savePolicy(this.run!.run_id, slot.view);
    this.store.event(
      this.run!.run_id,
      "policy.effect",
      "Policy has confirmed attributable effect evidence, not just a proposal or continue result",
      {
        policy_id: slot.view.policy_id,
        version: slot.view.version,
        kind,
        evidence,
      },
    );
    this.onChange();
  }

  private async finishTrial(slot: PolicySlot, reason: string): Promise<void> {
    if (slot.view.state !== "trial" || slot.closure) return;
    slot.tried = true;
    await this.closePolicy(
      slot,
      "validated",
      "Bounded policy trial closed; an explicit evidence-linked decision is required",
    );
    this.store.event(
      this.run!.run_id,
      "policy.trial_decision_due",
      "Policy trial reached its first bound and safely closed proposals/workers/effects",
      {
        policy_id: slot.view.policy_id,
        version: slot.view.version,
        reason,
        actions: slot.trial_actions,
        evaluations: slot.trial_evaluations,
        effects: slot.view.effects,
      },
    );
    this.wake("trial_decision_due");
  }

  private closePolicy(
    slot: PolicySlot,
    state: PolicyView["state"] | null,
    reason: string,
  ): Promise<void> {
    if (slot.closure) return slot.closure;
    slot.generation++;
    clearTimeout(slot.timer);
    clearTimeout(slot.expiry);
    slot.timer = undefined;
    slot.expiry = undefined;
    slot.controller?.abort();
    const worker = slot.worker;
    slot.worker = null;
    const evaluation = slot.evaluation;
    const closure = (async () => {
      const removed = this.queue.filter((entry) => entry.policy === slot);
      this.queue = this.queue.filter((entry) => entry.policy !== slot);
      for (const entry of removed) this.closeQueued(entry, reason);
      const active = this.active?.entry.policy === slot ? this.active : null;
      const cancellation = active
        ? this.cancelExecution(active, reason)
        : Promise.resolve();
      await Promise.all([worker?.close(), cancellation, evaluation]);
      if (state) slot.view.state = state;
      this.store.savePolicy(this.run!.run_id, slot.view, reason);
      this.onChange();
    })();
    slot.closure = closure;
    return closure;
  }

  private wake(reason: string): void {
    if (
      !this.run ||
      this.closed ||
      (this.run.status !== "running" && this.run.status !== "bootstrapping")
    )
      return;
    if (this.wakeReasons.size < 32) this.wakeReasons.add(reason);
    if (this.turn || this.wakeTimer || this.idleTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (
        this.turn ||
        !this.agent ||
        !this.run ||
        (this.run.status !== "running" && this.run.status !== "bootstrapping")
      )
        return;
      const turn = this.strategicTurn();
      this.turn = turn;
      void turn
        .catch(() => this.requestSafetyPause(PROVIDER_FAILURE, false))
        .finally(() => {
          if (this.turn === turn) this.turn = null;
          if (this.wakeReasons.size) this.wake("coalesced_pending_work");
        });
    }, COALESCE_MS);
  }

  private async strategicTurn(): Promise<void> {
    const run = this.run!;
    const generation = this.generation;
    const agent = this.agent!;
    const bootstrap = run.status === "bootstrapping";
    const reasons = [...this.wakeReasons];
    this.wakeReasons.clear();
    const turnId = randomUUID();
    const revision = this.workRevision;
    this.turnCalls = 0;
    this.turnToolCalls = 0;
    this.providerFailed = false;
    this.providerAborted = false;
    run.model_status = "thinking";
    this.persist();
    this.store.event(
      run.run_id,
      "scheduler.turn_started",
      "Serialized strategic turn started automatically",
      { turn_id: turnId, generation, reasons, bootstrap },
    );
    this.boundContext(agent);
    const timeRemaining = bootstrap
      ? Math.max(1, Math.min(BOOTSTRAP_MS, this.bootstrapDeadline - Date.now()))
      : TURN_MS;
    let deadlineReached = false;
    const timer = setTimeout(() => {
      deadlineReached = true;
      this.store.event(
        run.run_id,
        "model.deadline",
        "Host strategic time allowance reached; provider cancellation requested",
        { turn_id: turnId, bootstrap },
      );
      agent.abort();
    }, timeRemaining);
    try {
      const observation = await this.refreshObservation();
      if (
        generation !== this.generation ||
        (run.status !== "running" && run.status !== "bootstrapping")
      )
        return;
      if (bootstrap && Date.now() >= this.bootstrapDeadline)
        deadlineReached = true;
      const candidates = this.store.eventsAfter(
        run.run_id,
        this.contextCursor,
        64,
      );
      const feedback: Json[] = [];
      const omitted: number[] = [];
      let bytes = 0;
      for (const event of candidates) {
        const entry = {
          event_seq: event.event_seq,
          type: event.type,
          summary: event.summary,
          details: event.details,
        };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (bytes + size > 48 * 1024) omitted.push(event.event_seq);
        else {
          feedback.push(entry);
          bytes += size;
        }
      }
      this.store.event(
        run.run_id,
        "scheduler.context_selected",
        "Bounded filtered evidence selected; omitted records remain available through feedback_read",
        {
          turn_id: turnId,
          observation_seq: observation.observation_seq,
          through_event_seq: candidates[candidates.length - 1]?.event_seq ?? 0,
          included_event_count: feedback.length,
          omitted_event_refs: omitted,
        },
      );
      if (!deadlineReached)
        await agent.prompt(
          JSON.stringify({
            reason: reasons,
            phase: run.status,
            run_id: run.run_id,
            epoch: run.epoch,
            task: run.task,
            observation,
            current_action: this.active?.entry.stored.view ?? null,
            policies: this.policies
              .filter(
                (policy) =>
                  policy.state === "trial" || policy.state === "active",
              )
              .map(({ source: _source, ...policy }) => policy),
            feedback,
            omitted_event_refs: omitted,
            instruction: bootstrap
              ? "Prepare observation-informed policy readiness within the bootstrap call allowance. Effects open automatically after bootstrap."
              : "Advance the task using current evidence. Choose useful bounded work, react to trial evidence, or explain a genuine obstacle. No human continuation is needed.",
          }),
        );
      if (bootstrap && Date.now() >= this.bootstrapDeadline)
        deadlineReached = true;
      if (
        generation === this.generation &&
        !this.providerFailed &&
        !this.providerAborted &&
        !deadlineReached
      )
        this.contextCursor =
          candidates[candidates.length - 1]?.event_seq ?? this.contextCursor;
    } catch {
      if (generation === this.generation && !this.closed && !deadlineReached)
        this.providerFailed = true;
    } finally {
      clearTimeout(timer);
    }
    if (
      generation !== this.generation ||
      (run.status !== "running" && run.status !== "bootstrapping")
    )
      return;
    const bootstrapExpired =
      bootstrap && deadlineReached && Date.now() >= this.bootstrapDeadline;
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
      this.requestSafetyPause(PROVIDER_FAILURE, false);
      return;
    }
    run.model_status = "idle";
    if (bootstrapExpired)
      this.store.event(
        run.run_id,
        "scheduler.bootstrap_expired",
        "Bootstrap time allowance expired; selected feedback remains unconsumed and gameplay readiness is retained",
        {
          turn_id: turnId,
          calls: this.turnCalls,
          tools: this.turnToolCalls,
          consumed_event_seq: this.contextCursor,
        },
      );
    else
      this.store.event(
        run.run_id,
        "scheduler.turn_finished",
        "Strategic turn settled with complete tool-result groups",
        {
          turn_id: turnId,
          calls: this.turnCalls,
          tools: this.turnToolCalls,
          admitted_work: this.workRevision !== revision,
          consumed_event_seq: this.contextCursor,
        },
      );
    if (bootstrap) {
      run.status = "running";
      this.persist(
        "Bootstrap ended; game effects opened and autonomous planning resumed",
      );
      for (const slot of this.slots.values()) this.schedulePolicy(slot);
      this.wake("bootstrap_completed");
      return;
    }
    this.persist();
    if (this.workRevision !== revision) this.emptyTurns = 0;
    if (this.active || this.queue.length) return;
    if (this.workRevision === revision) this.emptyTurns++;
    if (this.emptyTurns >= MAX_EMPTY_TURNS) {
      this.store.event(
        run.run_id,
        "scheduler.planning_stalled",
        "Finite consecutive empty-turn allowance exhausted",
        { empty_turns: this.emptyTurns },
      );
      this.requestTerminal(
        "failed",
        "Planning stalled after three consecutive turns without runnable new work",
      );
      return;
    }
    run.model_status = "waiting";
    this.persist();
    this.store.event(
      run.run_id,
      "scheduler.backoff",
      "One bounded idle continuation armed; observations do not poll the model",
      { empty_turns: this.emptyTurns, cooldown_ms: EMPTY_COOLDOWN_MS },
    );
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.wake("no_runnable_work");
    }, EMPTY_COOLDOWN_MS);
  }

  private boundContext(agent: Agent): void {
    const messages = agent.state.messages;
    const groups: AgentMessage[][] = [];
    for (const message of messages) {
      if (message.role === "user" || !groups.length) groups.push([]);
      groups[groups.length - 1]!.push(message);
    }
    let size = 0;
    let first = groups.length;
    for (
      let index = groups.length - 1;
      index >= 0 && groups.length - index <= 4;
      index--
    ) {
      const bytes = Buffer.byteLength(JSON.stringify(groups[index]));
      if (size + bytes > 192 * 1024) break;
      size += bytes;
      first = index;
    }
    // Whole strategic prompt groups only: assistant calls and all paired results
    // stay together. Evidence remains in SQLite and feedback_read after eviction.
    if (first > 0) agent.replaceMessages(groups.slice(first).flat());
  }

  private agentEvent(event: AgentEvent, generation: number): void {
    const run = this.run;
    if (!run) return;
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const usage = message.usage;
      if (usage) {
        run.usage.input_tokens +=
          usage.input + usage.cacheRead + usage.cacheWrite;
        run.usage.output_tokens += usage.output;
        // Subscription inference has no trustworthy monetary charge here.
        this.store.event(
          run.run_id,
          "model.usage",
          "Provider-reported token usage recorded; subscription monetary cost is unknown",
          {
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read_tokens: usage.cacheRead,
            cache_write_tokens: usage.cacheWrite,
          },
        );
      }
      if (generation === this.generation) {
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
                obsolete: generation !== this.generation,
              },
            );
        }
      }
      this.persist();
    } else if (event.type === "tool_execution_start") {
      this.store.event(
        run.run_id,
        "model.tool_started",
        `Strategist called ${event.toolName}`,
        { tool_call_id: event.toolCallId, tool: event.toolName },
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
          rejected: !!event.isError,
        },
      );
      this.onChange();
    }
  }

  private verifyGoal(observation: Observation): void {
    const run = this.run;
    if (
      !run ||
      run.status !== "running" ||
      observation.world_id !== run.world_id ||
      observation.epoch !== run.epoch ||
      run.goal === "custom"
    )
      return;
    const current = inventoryCounts(observation);
    let item: string | undefined;
    if (run.goal === "collect_wood")
      item = Object.keys(current).find(
        (name) =>
          /_(log|wood|stem|hyphae)$/.test(name) &&
          current[name]! > (run.baseline[name] ?? 0),
      );
    else {
      const required =
        run.goal === "craft_crafting_table"
          ? "crafting_table"
          : "stone_pickaxe";
      if (this.completedCrafts.has(required) && (current[required] ?? 0) > 0)
        item = required;
    }
    if (!item) return;
    this.store.event(
      run.run_id,
      "goal.verified",
      "Trusted goal verifier confirmed the goal inventory condition and required execution evidence",
      {
        goal: run.goal,
        item,
        baseline_count: run.baseline[item] ?? 0,
        current_count: current[item]!,
        observation_seq: observation.observation_seq,
        craft_succeeded: this.completedCrafts.has(item),
      },
    );
    this.requestTerminal(
      "completed",
      "Goal completed with verified game evidence",
    );
  }

  private clearScheduler(): void {
    clearTimeout(this.wakeTimer);
    clearTimeout(this.idleTimer);
    this.wakeTimer = undefined;
    this.idleTimer = undefined;
    this.wakeReasons.clear();
  }

  private fenceStop(message: string): void {
    this.run!.status = "stopping";
    this.generation++;
    this.leaseGeneration++;
    this.clearScheduler();
    this.agent?.abort();
    for (const slot of this.slots.values()) slot.controller?.abort();
    if (this.active) void this.cancelExecution(this.active, message);
    this.persist(message);
  }

  private requestSafetyPause(message: string, reconnect: boolean): void {
    if (!this.run || TERMINAL[this.run.status]) return;
    if (reconnect) this.needsReconnect = true;
    this.run.error = message;
    if (
      this.run.status === "paused" ||
      this.run.status === "pausing" ||
      this.run.status === "stopping"
    ) {
      this.persist();
      return;
    }
    this.run.status = "pausing";
    this.generation++;
    this.leaseGeneration++;
    this.clearScheduler();
    this.agent?.abort();
    this.persist("Run safety admission closed before reconciliation");
    void this.serialize(async () => {
      if (this.run?.status === "pausing") await this.halt("paused", message);
    });
  }

  private requestTerminal(
    status: "completed" | "failed",
    message: string,
  ): void {
    if (!this.run || TERMINAL[this.run.status] || this.run.status !== "running")
      return;
    this.run.status = "stopping";
    this.generation++;
    this.leaseGeneration++;
    const generation = this.generation;
    this.clearScheduler();
    this.agent?.abort();
    this.persist(
      "Terminal outcome verified; effect admission revoked before shutdown",
    );
    void this.serialize(async () => {
      if (generation === this.generation && this.run?.status === "stopping")
        await this.halt(status, message);
    });
  }

  private async halt(
    status: "paused" | "stopped" | "completed" | "failed",
    message: string,
  ): Promise<void> {
    const run = this.run!;
    const generation = ++this.generation;
    this.leaseGeneration++;
    run.status = status === "paused" ? "pausing" : "stopping";
    this.clearScheduler();
    const agent = this.agent;
    agent?.abort();
    this.persist(
      "Run admission revoked; waiting for model, policy workers and effect shutdown",
    );
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) this.closeQueued(entry, message);
    const closures = [...this.slots.values()].map((slot) =>
      this.closePolicy(
        slot,
        status === "paused" ? null : "retired",
        status === "paused"
          ? "Policy worker suspended; immutable selection retained"
          : "Policy worker closed with the run",
      ),
    );
    const active = this.active;
    const settlements = await Promise.allSettled([
      active ? this.cancelExecution(active, message) : undefined,
      ...closures,
      agent?.waitForIdle(),
      this.turn,
    ]);
    let cleanupConfirmed = settlements.every(
      (result) => result.status === "fulfilled",
    );
    if (this.pumping) {
      try {
        await this.pumping;
      } catch {
        cleanupConfirmed = false;
      }
    }
    let disconnectConfirmed = true;
    if (status !== "paused" || this.needsReconnect) {
      try {
        await this.game.disconnect();
        disconnectConfirmed = this.game.snapshot().status === "disconnected";
      } catch {
        disconnectConfirmed = false;
      }
      if (!disconnectConfirmed) this.needsReconnect = true;
    }
    if (status !== "paused") {
      for (const policy of this.policies) {
        if (policy.state !== "trial" && policy.state !== "active") continue;
        policy.state = "retired";
        this.store.savePolicy(
          run.run_id,
          policy,
          "Run ended; immutable policy evidence retained without an active worker",
        );
      }
    }
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.agent = null;
    if (agent) {
      try {
        await this.auth.releaseAgent(agent);
      } catch {
        cleanupConfirmed = false;
      }
    }
    // A stop received while pause cleanup was awaiting owns the final status.
    if (generation !== this.generation) return;
    if (!disconnectConfirmed || !cleanupConfirmed) {
      run.error = BRIDGE_FAILURE;
      run.model_status = "error";
      this.persist(
        "Shutdown remains unconfirmed; admission stays closed and Stop may be retried",
      );
      throw new RuntimeFault(
        "unknown_effect",
        "Run shutdown could not be confirmed. Retry Stop before reconnecting or starting another run.",
      );
    }
    run.status = status;
    run.model_status = "idle";
    if (status !== "paused") run.ended_at = new Date().toISOString();
    if (status === "failed") run.error = message;
    else if (this.needsReconnect) run.error = BRIDGE_FAILURE;
    this.persist(message);
  }
}
