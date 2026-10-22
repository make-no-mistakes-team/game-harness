import type {
  ActionView,
  GameAction,
  GameActionResult,
  GameBridge,
  Json,
  Observation,
  PolicyView,
} from "../shared/contracts.ts";
import { gameActionSchema } from "../shared/validation.ts";
import type { PolicyWorker } from "./sandbox.ts";
import type { Store, StoredAction, StoredRun } from "./store.ts";
import { RuntimeFault } from "./runtime-fault.ts";
export interface PolicyAuthority {
  view: PolicyView;
  generation: number;
  worker: PolicyWorker | null;
  closure: Promise<void> | null;
  trial_actions: number;
  max_actions: number;
  trial_deadline: number;
}
export interface ActionEntry {
  stored: StoredAction;
  priority: number;
  deadline: number;
  order: number;
  generation: number;
  epoch: number;
  sessionId: string;
  lifeId: number;
  policy: PolicyAuthority | null;
  policy_generation: number | null;
  runId: string;
}
export interface ActionExecution {
  entry: ActionEntry;
  controller: AbortController;
  done: Promise<void>;
  cancellation: Promise<void> | null;
  /** Confirmed emitter closure, independent of the preceding action outcome. */
  neutralized: boolean;
  /** A validated reactive decision owns cancellation, worker drain and neutralization. */
  preemptionOwned: boolean;
}
interface OwnedActionExecution extends ActionExecution {
  retirement: ReturnType<typeof Promise.withResolvers<void>> | null;
}
export interface ActionArbiterHost {
  run(): StoredRun | null;
  generation(): number;
  needsReconnect(): boolean;
  changed(): void;
  wake(reason: string): void;
  pause(message: string, reconnect: boolean): void;
  uncertain(action: ActionView): void;
  observe(): Promise<Observation>;
  admitted(): void;
  effect(
    policy: PolicyAuthority,
    kind: "executed" | "neutralized",
    evidence: Json,
  ): void;
  succeeded(action: GameAction, result: GameActionResult, view: ActionView): void;
}
const TERMINAL = new Set<ActionView["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
const BRIDGE_FAILURE =
  "The game effect could not be safely reconciled. Reconnect the game before resuming; no uncertain action will be replayed.";
const key = (action: GameAction): string =>
  JSON.stringify(gameActionSchema.parse(action));
/** The sole avatar effect owner: admission is durable before one bounded queue dispatches. */
export class ActionArbiter {
  private entries: ActionEntry[] = [];
  private current: OwnedActionExecution | null = null;
  private pumping: Promise<void> | null = null;
  private preempting = false;
  private nextOrder = 0;
  private leaseGeneration = 0;
  private latest: ActionView | null = null;
  constructor(
    private store: Store,
    private game: GameBridge,
    private host: ActionArbiterHost,
  ) {}
  get active(): ActionExecution | null {
    return this.current;
  }
  get queue(): readonly ActionEntry[] {
    return this.entries;
  }
  get lease(): number {
    return this.leaseGeneration;
  }
  get view(): ActionView | null {
    return this.latest;
  }
  get busy(): boolean {
    return this.current !== null || this.entries.length > 0;
  }
  reset(): void {
    if (this.busy || this.pumping)
      throw new RuntimeFault(
        "conflict",
        "Close admitted actions before resetting the arbiter",
      );
    this.latest = null;
    this.nextOrder = 0;
    this.leaseGeneration++;
  }
  isEquivalent(action: GameAction): boolean {
    const canonical = key(action);
    return (
      !!(
        this.current && key(this.current.entry.stored.request) === canonical
      ) || this.entries.some((entry) => key(entry.stored.request) === canonical)
    );
  }
  admit(
    id: string,
    action: GameAction,
    priority: number,
    requestedDeadline: number | undefined,
    policy: PolicyAuthority | null,
    executionId: string | null = null,
  ): ActionView {
    if ((!policy && !executionId) || (policy && executionId))
      throw new RuntimeFault(
        "invalid_authority",
        "A gameplay action requires exactly one skill execution or reactive policy owner",
      );
    const run = this.host.run();
    if (!run || run.status !== "running" || this.host.needsReconnect())
      throw new RuntimeFault(
        "precondition_failed",
        "Game effects are closed until the run is running with a safe connection",
      );
    const state = this.game.snapshot();
    // can_respawn is sampled readiness, not an admission lease. Explicit
    // respawn waits for actual vanilla readiness inside the native boundary.
    if (
      state.status !== "connected" ||
      !state.session_id ||
      !state.life ||
      state.session_id !== run.session_id ||
      state.life.life_id !== run.life_id ||
      (action.kind === "respawn"
        ? state.life.status !== "dead" || !!policy
        : state.life.status !== "alive")
    )
      throw new RuntimeFault(
        "stale_context",
        "The action is not authorized for the current player life",
      );
    const canonical = key(action);
    const matching =
      this.current && key(this.current.entry.stored.request) === canonical
        ? this.current.entry
        : this.entries.find((entry) => key(entry.stored.request) === canonical);
    const origin = executionId ? "skill" : "policy";
    if (matching) {
      const duplicate = this.store.admitAction(
        run.run_id,
        id,
        action,
        origin,
        executionId,
      );
      if (duplicate.created) {
        const view = duplicate.action.view;
        view.status = "cancelled";
        view.ended_at = new Date().toISOString();
        view.summary =
          "Redundant equivalent proposal rejected without dispatch or deadline renewal";
        view.result = {
          status: "cancelled",
          summary: view.summary,
          evidence: {
            dispatched: false,
            duplicate_of: matching.stored.view.action_id,
          },
        };
        this.store.saveAction(run.run_id, view);
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
      this.host.changed();
      return structuredClone(duplicate.action.view);
    }
    if (this.entries.length >= 16)
      throw new RuntimeFault("busy", "The bounded action queue is full");
    if (
      policy &&
      (policy.closure ||
        !policy.worker ||
        !["active", "trial"].includes(policy.view.state))
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
      origin,
      executionId,
    );
    if (!admitted.created) return structuredClone(admitted.action.view);
    const defaultMs =
      action.kind === "navigate" || action.kind === "move"
        ? action.duration_ms + 2000
        : action.kind === "respawn"
          ? 15000
          : action.kind === "dig" || action.kind === "craft"
          ? 12000
          : 5000;
    const entry: ActionEntry = {
      stored: admitted.action,
      priority,
      deadline: Date.now() + (requestedDeadline ?? defaultMs),
      order: this.nextOrder++,
      generation: this.host.generation(),
      epoch: run.epoch,
      sessionId: state.session_id,
      lifeId: state.life.life_id,
      policy,
      policy_generation: policy?.generation ?? null,
      runId: run.run_id,
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
    this.entries.push(entry);
    this.entries.sort(
      (left, right) =>
        right.priority - left.priority || left.order - right.order,
    );
    this.latest = admitted.action.view;
    this.host.admitted();
    this.host.changed();
    queueMicrotask(() => this.startPump());
    return structuredClone(admitted.action.view);
  }
  async cancelPolicy(policy: PolicyAuthority, reason: string): Promise<void> {
    await this.cancelMatching((entry) => entry.policy === policy, reason);
  }
  async cancelOwned(ids: ReadonlySet<string>, reason: string): Promise<void> {
    await this.cancelMatching(
      (entry) =>
        !!entry.stored.view.execution_id &&
        ids.has(entry.stored.view.execution_id),
      reason,
    );
  }
  private async cancelMatching(
    matches: (entry: ActionEntry) => boolean,
    reason: string,
  ): Promise<void> {
    const removed = this.entries.filter(matches);
    this.entries = this.entries.filter((entry) => !matches(entry));
    for (const entry of removed) this.closeQueued(entry, reason);
    const active = this.current;
    if (active && matches(active.entry)) {
      const alreadySettled = TERMINAL.has(active.entry.stored.view.status);
      await this.cancelExecution(active, reason);
      if (!alreadySettled && !active.neutralized)
        throw new RuntimeFault(
          "unknown_effect",
          "Leaf effect cleanup is not confirmed",
        );
    }
  }
  async withPreemption(
    operation: (current: ActionExecution | null) => Promise<void>,
  ): Promise<boolean> {
    if (this.preempting) return false;
    this.preempting = true;
    try {
      await operation(this.current);
      return true;
    } finally {
      this.preempting = false;
      this.startPump();
    }
  }
  fence(reason: string): void {
    this.leaseGeneration++;
    const queued = this.entries;
    this.entries = [];
    for (const entry of queued) this.closeQueued(entry, reason);
    if (this.current) void this.cancelExecution(this.current, reason);
  }
  async close(reason: string): Promise<void> {
    this.fence(reason);
    if (this.current) await this.cancelExecution(this.current, reason);
    const pumping = this.pumping;
    await pumping;
    if (this.pumping === pumping) this.pumping = null;
  }
  /** Await pump retirement, separately from cancellation which the pump itself awaits. */
  awaitRetirement(execution: ActionExecution): Promise<void> {
    const current = this.current;
    if (current !== execution) return Promise.resolve();
    current.retirement ??= Promise.withResolvers<void>();
    return current.retirement.promise;
  }
  cancelExecution(execution: ActionExecution, reason: string): Promise<void> {
    if (execution.cancellation) return execution.cancellation;
    const view = execution.entry.stored.view;
    if (TERMINAL.has(view.status)) return execution.done;
    this.leaseGeneration++;
    view.status = "cancel_requested";
    view.summary = reason;
    this.store.saveAction(execution.entry.runId, view);
    execution.controller.abort();
    const cancellation = (async () => {
      let confirmed = false;
      try {
        await this.game.cancel(reason);
        confirmed = true;
      } catch {
        this.host.pause(BRIDGE_FAILURE, true);
      }
      await execution.done;
      execution.neutralized = confirmed;
      if (!execution.neutralized && !this.host.needsReconnect())
        this.host.pause(BRIDGE_FAILURE, true);
      this.store.event(
        execution.entry.runId,
        "action.cancellation_settled",
        execution.neutralized
          ? view.result?.status === "unknown"
            ? "Effect emitter shutdown confirmed; prior action effects remain unknown"
            : "Effect emitter shutdown confirmed; earlier effects are not reversed"
          : "Effect emitter shutdown remains uncertain; reconnect required",
        {
          action_id: view.action_id,
          neutralized: execution.neutralized,
          effect_status: view.result?.status ?? view.status,
        },
      );
      this.host.changed();
    })();
    execution.cancellation = cancellation;
    this.host.changed();
    return cancellation;
  }
  private closeQueued(entry: ActionEntry, reason: string): void {
    const view = entry.stored.view;
    view.status = "cancelled";
    view.summary = reason;
    view.ended_at = new Date().toISOString();
    view.result = {
      status: "cancelled",
      summary: reason,
      evidence: { dispatched: false },
    };
    this.store.saveAction(entry.runId, view);
    this.latest = view;
    this.host.changed();
  }
  private startPump(): void {
    if (
      this.pumping ||
      this.preempting ||
      this.host.run()?.status !== "running" ||
      this.host.needsReconnect()
    )
      return;
    const pumping = this.pump();
    this.pumping = pumping;
    void pumping
      .catch(() => this.host.pause(BRIDGE_FAILURE, true))
      .finally(() => {
        if (this.pumping === pumping) this.pumping = null;
        if (
          this.host.run()?.status === "running" &&
          this.entries.length &&
          !this.host.needsReconnect()
        )
          this.startPump();
      });
  }
  private async pump(): Promise<void> {
    while (
      this.host.run()?.status === "running" &&
      !this.host.needsReconnect() &&
      !this.preempting &&
      this.entries.length
    ) {
      const entry = this.entries.shift()!;
      if (!this.entryCurrent(entry) || Date.now() >= entry.deadline) {
        this.closeQueued(
          entry,
          "Queued action authority or deadline expired before dispatch",
        );
        continue;
      }
      const execution: OwnedActionExecution = {
        entry,
        controller: new AbortController(),
        done: Promise.resolve(),
        cancellation: null,
        neutralized: false,
        preemptionOwned: false,
        retirement: null,
      };
      this.current = execution;
      this.leaseGeneration++;
      entry.stored.view.status = "running";
      entry.stored.view.started_at = new Date().toISOString();
      entry.stored.view.summary = `${entry.stored.request.kind} executing under the exclusive effect lease`;
      this.latest = entry.stored.view;
      this.store.saveAction(entry.runId, entry.stored.view);
      this.host.changed();
      execution.done = this.execute(execution);
      try {
        await execution.done;
        if (execution.cancellation) await execution.cancellation;
      } catch (error) {
        execution.retirement?.reject(error);
        throw error;
      }
      if (this.current === execution) this.current = null;
      this.leaseGeneration++;
      execution.retirement?.resolve();
      this.host.changed();
      if (!this.entries.length && this.host.run()?.status === "running")
        this.host.wake("work_decision_needed");
    }
    if (
      !this.current &&
      !this.entries.length &&
      this.host.run()?.status === "running"
    )
      this.host.wake("work_decision_needed");
  }
  private entryCurrent(entry: ActionEntry): boolean {
    const run = this.host.run(),
      state = this.game.snapshot();
    if (
      !run ||
      entry.runId !== run.run_id ||
      entry.generation !== this.host.generation() ||
      entry.epoch !== run.epoch
    )
      return false;
    if (
      entry.policy &&
      (entry.policy_generation !== entry.policy.generation ||
        entry.policy.closure ||
        !["trial", "active"].includes(entry.policy.view.state))
    )
      return false;
    return (
      state.status === "connected" &&
      state.world_id === run.world_id &&
      state.epoch === run.epoch &&
      state.session_id === entry.sessionId &&
      state.life?.life_id === entry.lifeId &&
      (entry.stored.request.kind === "respawn"
        ? state.life.status === "dead"
        : state.life.status === "alive")
    );
  }
  private async execute(execution: ActionExecution): Promise<void> {
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
    const state = this.game.snapshot();
    if (result.requires_reconnect ||
      (result.status === "unknown" && (state.status !== "connected" || state.error !== null || state.session_id !== entry.sessionId)))
      this.host.pause(state.error ?? BRIDGE_FAILURE, true);
    const view = entry.stored.view;
    view.status = result.status;
    view.summary = result.summary;
    view.result = result;
    view.ended_at = new Date().toISOString();
    this.store.saveAction(entry.runId, view);
    this.latest = view;
    if (result.status === "unknown" && !result.requires_reconnect &&
      state.status === "connected" && state.error === null && state.session_id === entry.sessionId &&
      state.life?.status !== "dead" &&
      !(execution.preemptionOwned && execution.cancellation))
      this.host.uncertain(view);
    if (result.status === "succeeded") {
      this.host.succeeded(entry.stored.request, result, view);
      if (
        entry.policy &&
        result.evidence &&
        typeof result.evidence === "object" &&
        !Array.isArray(result.evidence) &&
        result.evidence.effect_confirmed === true
      )
        this.host.effect(entry.policy, "executed", {
          action_id: view.action_id,
          result: result as unknown as Json,
        });
    }
    this.host.changed();
    if (result.status === "succeeded" && this.host.run()?.status === "running")
      await this.host.observe().catch(() => {});
  }
}
