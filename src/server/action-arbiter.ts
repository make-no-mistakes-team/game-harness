import type {
  ActionView,
  GameAction,
  GameActionResult,
  GameBridge,
  Json,
  ObservationV3,
  PolicyView,
  RuntimeAdapter,
} from "../shared/contracts.ts";
import { randomUUID } from "node:crypto";
import type { EffectEnvelope, EffectInvocation, EffectScope, ProducerSupervision } from "../shared/control.ts";
import { sameEffectScope, screenPreconditionMatches } from "../shared/control.ts";
import { assertExecutableCompatible } from "./effect-contract.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";
import { gameActionSchema } from "../shared/validation.ts";
import type { PolicyWorker } from "./sandbox.ts";
import type { Store, StoredAction, StoredRun } from "./store.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { ControllerEffectUpdate, ControllerInputChannel, ControllerReservation, InputAppliedAck, RevocationAck } from "../shared/controller.ts";
import { revocationAckSchema } from "../shared/controller.ts";
import { ResidentCleanupError, type ResidentLifecycle } from "../shared/resident.ts";
interface ControllerLease {
  executionId: string;
  reservation: ControllerReservation;
  opening: Promise<ControllerInputChannel> | null;
  channel: ControllerInputChannel | null;
  retirement: Promise<RevocationAck> | null;
}
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
  envelope: EffectEnvelope;
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
  adapter(): RuntimeAdapter | null;
  invocation(executionId: string): EffectInvocation | null;
  effectScope(executionId: string): EffectScope | null;
  changed(): void;
  wake(reason: string): void;
  pause(message: string, reconnect: boolean): void;
  uncertain(action: ActionView): void;
  observe(): Promise<ObservationV3>;
  admitted(): void;
  effect(
    policy: PolicyAuthority,
    kind: "executed" | "neutralized",
    evidence: Json,
  ): void;
  settled(action: GameAction, result: GameActionResult, view: ActionView): void;
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
  private static readonly bridges = new WeakMap<GameBridge, ActionArbiter>();
  private readonly diagnostics = new Map<string, { invocation: EffectInvocation; scope: EffectScope }>();
  private readonly registrations = new WeakMap<RuntimeAdapter, RegisteredAdapterContract>();
  private entries: ActionEntry[] = [];
  private current: OwnedActionExecution | null = null;
  private controllerLease: ControllerLease | null = null;
  private pumping: Promise<void> | null = null;
  private preempting = false;
  private nextOrder = 0;
  private leaseGeneration = 0;
  private latest: ActionView | null = null;
  constructor(
    private store: Store,
    private game: GameBridge,
    private host: ActionArbiterHost,
  ) {
    if (ActionArbiter.bridges.has(game)) throw new RuntimeFault("conflict", "One bridge has exactly one effect arbiter");
    ActionArbiter.bridges.set(game, this);
  }
  static current(game: GameBridge): ActionArbiter | null { return this.bridges.get(game) ?? null; }
  get runningContext(): boolean { return this.host.run()?.status === "running"; }
  static attach(store: Store, game: GameBridge, host: ActionArbiterHost): ActionArbiter {
    const existing = this.current(game);
    if (!existing) return new ActionArbiter(store, game, host);
    if (existing.busy || existing.pumping || existing.host.run() && !["stopped", "completed", "failed"].includes(existing.host.run()!.status))
      throw new RuntimeFault("conflict", "Previous arbiter context must be closed before ownership transfer");
    existing.store = store; existing.host = host; existing.reset(); return existing;
  }
  async diagnosticContext<T>(store: Store, host: ActionArbiterHost, operation: (arbiter: ActionArbiter) => Promise<T>): Promise<T> {
    if (this.host.run()?.status === "running") return await operation(this);
    if (this.busy || this.pumping) throw new RuntimeFault("busy", "Diagnostic authority waits for the current arbiter drain");
    const previousStore = this.store, previousHost = this.host;
    this.store = store; this.host = host; this.reset();
    try { return await operation(this); }
    finally {
      // Concurrent trusted calls use this same queue/context. Do not let the
      // first completed diagnostic tear down a later already-admitted owner.
      if (this.pumping) await this.pumping;
      await this.close("Trusted diagnostic context drained");
      this.store = previousStore; this.host = previousHost; this.reset();
    }
  }
  async diagnostic(action: GameAction, sourceHash: string, deadlineMs: number, signal?: AbortSignal): Promise<GameActionResult> {
    if (signal?.aborted) throw new RuntimeFault("cancelled", "Diagnostic was cancelled before admission");
    const run = this.host.run(), state = this.game.snapshot();
    if (!run || run.status !== "running" || !state.binding?.ready || !state.space || !state.session_id || !state.life)
      throw new RuntimeFault("precondition_failed", "Trusted diagnostics require a real current run/adapter context");
    const executionId = `diagnostic_${randomUUID()}`, id = `diagnostic_${randomUUID()}`;
    const invocation: EffectInvocation = { kind: "diagnostic", execution_id: executionId, source_hash: sourceHash };
    const scope: EffectScope = { run_id: run.run_id, run_generation: this.host.generation(), world_id: run.world_id,
      session_id: state.session_id, epoch: run.epoch, native_boot_id: state.binding.native_boot_id,
      life_id: state.life.life_id, space_epoch: state.space.space_epoch, execution_id: executionId, source_hash: sourceHash };
    this.diagnostics.set(executionId, { invocation, scope });
    this.store.event(run.run_id, "diagnostic.invocation", "Trusted host diagnostic invocation; not a skill execution", { execution_id: executionId, source_hash: sourceHash, action_id: id });
    const settled = Promise.withResolvers<GameActionResult>();
    const check = () => {
      const view = this.store.getAction(run.run_id, id)?.view;
      if (view && TERMINAL.has(view.status) && view.result) settled.resolve(view.result);
    };
    const unsubscribe = this.store.subscribe(event => { if (event.run_id === run.run_id && event.type.startsWith("action.")) check(); });
    const abort = () => { void this.cancelOwned(new Set([executionId]), "Diagnostic deadline or caller cancellation").catch(settled.reject); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new RuntimeFault("cancelled", "Diagnostic was cancelled before effect admission");
      this.admit(id, action, 0, deadlineMs, null, executionId); check(); return await settled.promise;
    }
    finally {
      signal?.removeEventListener("abort", abort); unsubscribe();
      await this.cancelOwned(new Set([executionId]), "Diagnostic invocation finished"); this.diagnostics.delete(executionId);
    }
  }
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
    return this.controllerLease !== null || this.current !== null || this.entries.length > 0;
  }
  async reserveController(executionId: string, controllerGeneration: number, deadlineHostMs: number,
    applied: (ack: InputAppliedAck) => void, effect: (update: ControllerEffectUpdate) => void,
    lifecycle?: ResidentLifecycle): Promise<ControllerInputChannel> {
    const run = this.host.run(), state = this.game.snapshot(), adapter = this.host.adapter();
    const diagnostic = this.diagnostics.get(executionId);
    const invocation = diagnostic?.invocation ?? this.host.invocation(executionId);
    const scope = diagnostic?.scope ?? this.host.effectScope(executionId);
    if (this.busy || this.pumping || this.preempting)
      throw new RuntimeFault("busy", "Controller admission waits for the sole effect owner to drain");
    if (!this.game.openController || !run || run.status !== "running" || this.host.needsReconnect() ||
      !adapter || !state.binding?.ready || !state.space || state.life?.status !== "alive" ||
      !invocation || !scope || invocation.source_hash !== scope.source_hash || invocation.execution_id !== scope.execution_id ||
      invocation.execution_id !== executionId || scope.run_id !== run.run_id || scope.run_generation !== this.host.generation() ||
      scope.session_id !== state.session_id || scope.world_id !== state.world_id || scope.epoch !== state.epoch ||
      scope.native_boot_id !== state.binding.native_boot_id || scope.life_id !== state.life.life_id ||
      scope.space_epoch !== state.space.space_epoch || run.compatibility_hash !== state.binding.compatibility_hash ||
      !Number.isSafeInteger(controllerGeneration) || controllerGeneration < 1 || !Number.isFinite(deadlineHostMs) ||
      deadlineHostMs <= performance.now() || deadlineHostMs - performance.now() > 16 * 60 * 60 * 1000)
      throw new RuntimeFault("invalid_authority", "Controller requires an active exact source, live native scope and finite task deadline");
    const reservation: ControllerReservation = { operation_id: `controller_${randomUUID()}`, scope: { ...scope },
      invocation: { ...invocation }, compatibility_hash: state.binding.compatibility_hash,
      expected_screen: state.screen ? { kind: "transaction", screen: { ...state.screen } } : { kind: "absent" } };
    const lease: ControllerLease = { executionId, reservation, opening: null, channel: null, retirement: null };
    this.controllerLease = lease;
    this.leaseGeneration++;
    try {
      this.store.event(run.run_id, "controller.admitted", "Exact controller reservation persisted before native effects", {
        operation_id: reservation.operation_id, scope: { ...scope }, invocation: { ...invocation },
        controller_generation: controllerGeneration, deadline_host_monotonic_ms: deadlineHostMs,
      });
      this.host.admitted(); this.host.changed();
      lease.opening = this.game.openController(reservation, controllerGeneration, deadlineHostMs, applied, update => {
        this.store.event(run.run_id, "controller.effect_receipt", "Actual later controller receipt, independent of input application", {
          operation_id: reservation.operation_id, ...update,
        });
        effect(update);
      });
      const native = await lease.opening;
      const assertCurrent = () => {
        const currentRun = this.host.run(), current = diagnostic?.scope ?? this.host.effectScope(executionId);
        if (this.controllerLease !== lease || currentRun?.run_id !== run.run_id || currentRun.status !== "running" ||
          this.host.needsReconnect() || this.host.generation() !== scope.run_generation || !current || !sameEffectScope(current, scope)) {
          void channel.revoke().catch(() => {});
          throw new RuntimeFault("stale_context", "Controller source/run authority changed before submission");
        }
      };
      const channel: ControllerInputChannel = {
        get owner() { return native.owner; }, controllerGeneration: native.controllerGeneration,
        sample: cursor => { assertCurrent(); return native.sample(cursor); },
        submit: (frame, input) => { assertCurrent(); return native.submit(frame, input); },
        renew: frame => { assertCurrent(); return native.renew(frame); },
        snapshot: () => native.snapshot(),
        revoke: () => {
          if (lease.retirement) return lease.retirement;
          const completion = Promise.withResolvers<RevocationAck>();
          lease.retirement = completion.promise;
          // Publish the idempotent barrier before fencing: fence may reenter Stop.
          let fenceFailure: unknown;
          try { lifecycle?.fence("Controller admission revoked"); } catch (error) { fenceFailure = error; }
          const drain = Promise.resolve().then(() => lifecycle?.drain());
          // Attach immediately; a fast worker failure must not become unhandled
          // while the independent native barrier is still in flight.
          const drained = drain.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
          const retirement = (async () => {
            let confirmed = false;
            let acknowledged: RevocationAck | null = null;
            try {
              const ack = revocationAckSchema.parse(await native.revoke()), owner = native.owner;
              if (ack.owner.operation_id !== owner.operation_id || ack.owner.generation !== owner.generation ||
                !sameEffectScope(ack.owner.scope, reservation.scope) || ack.controller_generation !== controllerGeneration)
                throw new RuntimeFault("unknown_effect", "Controller retirement names another writer");
              confirmed = true;
              acknowledged = ack;
              this.store.event(run.run_id, "controller.retired", "Actual native input retirement acknowledged; prior effects are not reversed", {
                operation_id: reservation.operation_id, ack: { ...ack },
              });
              return ack;
            } catch (error) {
              this.host.pause(BRIDGE_FAILURE, true);
              await this.game.emergencyStop("Unconfirmed controller retirement requires emitter containment");
              this.store.event(run.run_id, "controller.contained", "Emitter containment confirmed; input retirement and preceding world effects remain uncertain", {
                operation_id: reservation.operation_id, input_application: "unknown",
              });
              throw error;
            } finally {
              // Concrete bridge Stop drains its actual emitter before resolving, including
              // uncertain native retirement. Never turn containment into a retirement ACK.
              const local = await drained;
              if (!local.ok || fenceFailure) {
                this.host.pause("Resident computation cleanup is unconfirmed; effect admission remains fenced", true);
                throw new ResidentCleanupError(acknowledged);
              }
              if (confirmed || this.game.snapshot().binding === null) {
                if (this.controllerLease === lease) this.controllerLease = null;
                this.host.changed(); this.host.wake("Controller writer drained"); this.startPump();
              }
            }
          })();
          void retirement.then(completion.resolve, completion.reject);
          return completion.promise;
        },
      };
      lease.channel = channel;
      return channel;
    } catch (error) {
      lifecycle?.fence("Controller admission failed");
      this.host.pause(BRIDGE_FAILURE, true);
      const cleanup = await Promise.allSettled([
        this.game.emergencyStop("Unconfirmed controller admission requires emitter containment"),
        Promise.resolve().then(() => lifecycle?.drain()),
      ]);
      const failure = cleanup.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (this.controllerLease === lease && this.game.snapshot().binding === null) this.controllerLease = null;
      throw error;
    }
  }
  private async cancelController(reason: string): Promise<void> {
    const lease = this.controllerLease;
    if (!lease) return;
    if (!lease.channel && lease.opening) await lease.opening;
    if (lease.channel) await lease.channel.revoke();
    else throw new RuntimeFault("unknown_effect", `Controller admission has not drained: ${reason}`);
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
    supervision?: ProducerSupervision,
  ): ActionView {
    if (this.controllerLease)
      throw new RuntimeFault("busy", "Finite actions cannot overlap an admitted or retiring controller writer");
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
    const adapter = this.host.adapter(), binding = state.binding;
    if (!adapter || !binding?.ready || !state.space || !adapter.action_capability)
      throw new RuntimeFault("precondition_failed", "Negotiated adapter effect admission is not ready");
    let registration = this.registrations.get(adapter);
    if (!registration) { registration = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas, adapter.capabilityValidators); this.registrations.set(adapter, registration); }
    if (registration.compatibility.compatibility_hash !== binding.compatibility_hash || run.compatibility_hash !== binding.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Run and adapter executable contracts do not match");
    const parsedAction = registration.parseCapability(adapter.action_capability.id, adapter.action_capability.version, action);
    action = gameActionSchema.parse(parsedAction);
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
    let invocation: EffectInvocation;
    let scope: EffectScope;
    if (policy) {
      assertExecutableCompatible(policy.view.validation, binding);
      invocation = { kind: "policy", execution_id: randomUUID(), source_hash: policy.view.hash,
        policy_id: policy.view.policy_id, version: policy.view.version };
      scope = { session_id: state.session_id!, world_id: run.world_id, epoch: run.epoch, native_boot_id: binding.native_boot_id,
        run_id: run.run_id, run_generation: this.host.generation(), life_id: state.life!.life_id, space_epoch: state.space.space_epoch,
        execution_id: invocation.execution_id, source_hash: invocation.source_hash };
    } else {
      const diagnostic = this.diagnostics.get(executionId!);
      const source = diagnostic?.invocation ?? this.host.invocation(executionId!), current = diagnostic?.scope ?? this.host.effectScope(executionId!);
      if (!source || !current) throw new RuntimeFault("invalid_authority", "The host invocation is not active");
      invocation = source; scope = { ...current };
      if (scope.run_generation !== this.host.generation() || scope.native_boot_id !== binding.native_boot_id || scope.space_epoch !== state.space.space_epoch ||
        scope.session_id !== state.session_id || scope.life_id !== state.life!.life_id)
        throw new RuntimeFault("stale_context", "The host invocation scope is obsolete");
    }
    const envelope: EffectEnvelope = { operation_id: id, scope, invocation, compatibility_hash: binding.compatibility_hash,
      action, expected_screen: adapter.screenPrecondition?.(action, state.screen) ??
        (state.screen ? { kind: "transaction", screen: { ...state.screen } } : { kind: "absent" }),
      ...(supervision ? { supervision } : {}) };
    const canonical = key(action);
    const matching =
      this.current && key(this.current.entry.stored.request) === canonical
        ? this.current.entry
        : this.entries.find((entry) => key(entry.stored.request) === canonical);
    const origin = invocation.kind;
    if (matching) {
      const duplicate = this.store.admitAction(
        run.run_id,
        id,
        action,
        origin,
        invocation.execution_id,
        { scope, invocation, compatibility_hash: binding.compatibility_hash },
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
      invocation.execution_id,
      { scope, invocation, compatibility_hash: binding.compatibility_hash },
    );
    if (!admitted.created) return structuredClone(admitted.action.view);
    const defaultMs = adapter.effectDeadlineMs(action);
    const entry: ActionEntry = {
      stored: admitted.action,
      priority,
      deadline: Date.now() + (requestedDeadline ?? defaultMs),
      order: this.nextOrder++,
      envelope,
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
    if (this.controllerLease && ids.has(this.controllerLease.executionId)) await this.cancelController(reason);
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
    if (this.controllerLease) void this.cancelController(reason).catch(() => {});
  }
  async close(reason: string): Promise<void> {
    this.fence(reason);
    if (this.controllerLease) await this.cancelController(reason);
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
        await this.game.cancel(reason, { operation_id: execution.entry.envelope.operation_id, scope: execution.entry.envelope.scope });
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
      this.controllerLease ||
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
      if (!this.entryCurrent(entry, true) || Date.now() >= entry.deadline) {
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
  private entryCurrent(entry: ActionEntry, checkScreen = false, checkInvocation = true): boolean {
    const run = this.host.run(),
      state = this.game.snapshot();
    if (
      !run ||
      entry.runId !== run.run_id ||
      entry.envelope.scope.run_generation !== this.host.generation() ||
      entry.envelope.scope.epoch !== run.epoch
    )
      return false;
    const binding = state.binding, scope = entry.envelope.scope;
    if (!binding?.ready || binding.compatibility_hash !== entry.envelope.compatibility_hash || binding.native_boot_id !== scope.native_boot_id ||
      !state.space || state.space.space_epoch !== scope.space_epoch || checkScreen && !screenPreconditionMatches(entry.envelope.expected_screen, state.screen)) return false;
    if (!entry.policy && checkInvocation) {
      const diagnostic = this.diagnostics.get(scope.execution_id);
      const current = diagnostic?.scope ?? this.host.effectScope(scope.execution_id), invocation = diagnostic?.invocation ?? this.host.invocation(scope.execution_id);
      if (!current || !invocation || !sameEffectScope(scope, current) || invocation.source_hash !== scope.source_hash ||
        invocation.kind !== entry.envelope.invocation.kind) return false;
    } else if (entry.policy && entry.policy.view.hash !== scope.source_hash) return false;
    if (
      entry.policy &&
      (entry.policy_generation !== entry.policy.generation ||
        entry.policy.closure ||
        !["trial", "active"].includes(entry.policy.view.state) ||
        entry.policy.view.state === "trial" && Date.now() >= entry.policy.trial_deadline)
    )
      return false;
    return (
      state.status === "connected" &&
      state.world_id === run.world_id &&
      state.epoch === run.epoch &&
      state.session_id === scope.session_id &&
      state.life?.life_id === scope.life_id &&
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
        entry.envelope,
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
      (result.status === "unknown" && (state.status !== "connected" || state.error !== null || state.session_id !== entry.envelope.scope.session_id)))
      this.host.pause(state.error ?? BRIDGE_FAILURE, true);
    const view = entry.stored.view;
    // Durable result observers synchronously fence this skill on an unknown
    // leaf. Capture its genuine live source authority before that publication,
    // then recheck physical/run fences without mistaking our own fence for a
    // foreign/revoked invocation when scheduling uncertainty reconciliation.
    const currentAtSettlement = this.entryCurrent(entry);
    view.status = result.status;
    view.summary = result.summary;
    view.result = result;
    view.ended_at = new Date().toISOString();
    this.store.saveAction(entry.runId, view);
    this.latest = view;
    this.host.settled(entry.stored.request, result, view);
    if (result.status === "unknown" && !result.requires_reconnect &&
      currentAtSettlement && this.entryCurrent(entry, false, false) && state.status === "connected" && state.error === null && state.session_id === entry.envelope.scope.session_id &&
      state.life?.status !== "dead" &&
      !(execution.preemptionOwned && execution.cancellation))
      this.host.uncertain(view);
    if (result.status === "succeeded") {
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
