import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GameState,
  Json,
  PolicyContext,
  PolicySpec,
  PolicyView,
  ActiveExecutableValidation,
  AdapterBinding,
  RuntimeAdapter,
} from "../shared/contracts.ts";
import {
  policyDecisionSchema,
  policySpecSchema,
} from "../shared/validation.ts";
import type {
  ActionArbiter,
  ActionExecution,
  PolicyAuthority,
} from "./action-arbiter.ts";
import type { FastJudgeBroker, FastJudgeSelection } from "./fast-provider.ts";
import {
  ProgramValidationError,
  validateProgramSource,
  programFingerprint,
} from "./program-validation.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { PolicyWorker, SandboxService } from "./sandbox.ts";
import type { Store, StoredRun } from "./store.ts";
import { recordCall, recordUsage } from "./usage.ts";
import type { ScreenRef } from "../shared/control.ts";
import { sameScreen } from "../shared/control.ts";
import { executableContractStamp } from "./adapter-contract.ts";
import { assertExecutableCompatible } from "./effect-contract.ts";
import { RegisteredAdapterContract } from "./registered-adapter.ts";

const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const policyRefSchema = z
  .object({
    epoch: z.number().int().nonnegative(),
    policy_id: idSchema,
    version: z.number().int().positive(),
  })
  .strict();
export const activateSchema = policyRefSchema
  .extend({
    mode: z.enum(["trial", "keep"]).default("trial"),
    max_ms: z.number().int().min(1_000).max(120_000).default(120_000),
    max_actions: z.number().int().min(1).max(20).default(20),
    max_evaluations: z.number().int().min(1).max(100).default(100),
  })
  .strict();
type PolicyRef = z.infer<typeof policyRefSchema>;

export interface ReactiveHost {
  run(): StoredRun | null;
  generation(): number;
  assertCurrent(generation: number, epoch?: number): StoredRun;
  context(): Promise<PolicyContext>;
  gameState(): GameState;
  needsReconnect(): boolean;
  adapter(): RuntimeAdapter | null;
  binding(): AdapterBinding | null;
  wake(reason: string): void;
  changed(): void;
  admitted(): void;
  /** Resolves only after the native input emitter acknowledges neutralization. */
  neutralize(): Promise<void>;
  closePrograms(reason: string): Promise<void>;
}

interface ContextIdentity {
  session_id: string;
  life_id: number;
  life_status: NonNullable<GameState["life"]>["status"];
  epoch: number;
  world_id: string;
  native_boot_id: string;
  space_epoch: number;
  compatibility_hash: string;
  screen: ScreenRef | null;
}

interface PolicySlot extends PolicyAuthority {
  runId: string;
  identity: ContextIdentity;
  runGeneration: number;
  selected: boolean;
  timer: NodeJS.Timeout | undefined;
  expiry: NodeJS.Timeout | undefined;
  controller: AbortController | null;
  evaluation: Promise<void> | null;
  trial_started: number;
  trial_evaluations: number;
  max_ms: number;
  max_evaluations: number;
  tried: boolean;
}
interface Validation {
  controller: AbortController;
  done: Promise<PolicyView>;
}
type JudgeAccounting = Omit<Awaited<ReturnType<FastJudgeBroker["evaluate"]>>, "choice_id">;
const terminal: Partial<Record<string, true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
  unknown: true,
};
const keyOf = (view: { policy_id: string; version: number }): string =>
  `${view.policy_id}:${view.version}`;
const specOf = (view: PolicyView): PolicySpec => ({
  backend: view.backend,
  choices: view.choices,
  name: view.name,
  source: view.source,
  card: view.card,
  priority: view.priority,
  interval_ms: view.interval_ms,
});

/** Owns immutable reaction selection, isolated workers and bounded evidence-producing trials. */
export class ReactiveRuntime {
  private readonly registrations = new WeakMap<RuntimeAdapter, RegisteredAdapterContract>();
  private policies: PolicyView[] = [];
  private slots = new Map<string, PolicySlot>();
  private validations = new Map<string, Validation>();
  private starts = new Set<Promise<PolicyWorker>>();
  private canonicalSources = new Set<string>();
  private revision = 0;
  private runId: string | null = null;
  private fenced = false;
  private activating = false;

  constructor(
    private store: Store,
    private sandbox: SandboxService,
    private actions: ActionArbiter,
    private host: ReactiveHost,
    private judge?: FastJudgeBroker,
  ) {}

  get list(): PolicyView[] {
    return this.policies;
  }
  private contract() {
    const adapter = this.host.adapter(), binding = this.host.binding();
    if (!adapter || !binding?.ready) throw new RuntimeFault("precondition_failed", "Reactive execution requires a negotiated adapter");
    let registration = this.registrations.get(adapter);
    if (!registration) { registration = new RegisteredAdapterContract(adapter.descriptor, adapter.schemas); this.registrations.set(adapter, registration); }
    if (registration.compatibility.compatibility_hash !== binding.compatibility_hash)
      throw new RuntimeFault("precondition_failed", "Reactive and native executable contracts differ");
    return { adapter, binding, registration, descriptor: adapter.descriptor, schemas: adapter.schemas };
  }
  private compatible(view: PolicyView): void {
    const context = this.contract(), validation = assertExecutableCompatible(view.validation, context.binding);
    if (validation.fingerprint !== programFingerprint(view.hash, view.backend === "jev" ? "jev" : "policy", context.binding.compatibility_hash,
      view.backend === "jev" ? view.choices : undefined))
      throw new RuntimeFault("precondition_failed", "Historical or incompatible policy validation is read-only");
  }

  initialize(runId: string): void {
    this.reset();
    this.runId = runId;
    this.policies = this.store.policies(runId);
    for (const view of this.policies) {
      if (view.state !== "trial" && view.state !== "active") continue;
      view.state = "retired";
      this.store.savePolicy(
        runId,
        view,
        "Recovered policy selection retired; isolated workers and effects are never replayed",
      );
    }
  }

  reset(): void {
    this.revision++;
    this.runId = null;
    this.fenced = false;
    this.policies = [];
    this.slots.clear();
    this.validations.clear();
    this.starts.clear();
    this.canonicalSources.clear();
  }

  async register(
    spec: PolicySpec,
    epoch: number,
    generation: number,
  ): Promise<PolicyView> {
    const revision = this.revision;
    const identity = this.contextIdentity();
    this.assertAuthority(generation, epoch, revision);
    const parsed = policySpecSchema.safeParse(spec);
    if (!parsed.success)
      throw new RuntimeFault(
        "invalid_input",
        "Policy metadata or finite choices are invalid",
      );
    const canonical = parsed.data;
    const contract = this.contract();
    let validation: ActiveExecutableValidation;
    if (canonical.backend === "javascript") {
      try {
        const result = await validateProgramSource(canonical.source, "policy", contract);
        canonical.source = result.source;
        validation = assertExecutableCompatible(result.validation, contract.binding);
      } catch (error) {
        if (error instanceof ProgramValidationError) {
          const fault = new RuntimeFault(
            "invalid_program",
            "Policy JavaScript failed static validation",
          );
          Object.assign(fault, { issues: error.issues });
          throw fault;
        }
        throw new RuntimeFault(
          "invalid_program",
          "Policy JavaScript could not be statically validated",
        );
      }
    } else {
      for (const choice of canonical.choices!) if (choice.decision.kind === "replace") {
        if (!contract.adapter.action_capability) throw new RuntimeFault("precondition_failed", "This adapter has no effect capability");
        contract.registration.parseCapability(contract.adapter.action_capability.id, contract.adapter.action_capability.version, choice.decision.action);
      }
      const hash = createHash("sha256").update(canonical.source).digest("hex");
      validation = { ...executableContractStamp(contract.registration.compatibility),
        fingerprint: programFingerprint(hash, "jev", contract.binding.compatibility_hash, canonical.choices),
        formatted_lines: canonical.source.split("\n").length, complexity: 0, nesting: 0 };
    }
    const run = this.assertAuthority(generation, epoch, revision);
    this.assertIdentity(identity);
    if (canonical.backend === "javascript")
      this.canonicalSources.add(canonical.source);
    const registered = this.store.registerPolicy(
      run.run_id,
      canonical,
      run.turns,
      validation,
    );
    const existing = this.policies.find(
      (view) => keyOf(view) === keyOf(registered),
    );
    if (!existing) this.policies.push(registered);
    this.host.changed();
    return existing ?? registered;
  }

  async validate(
    ref: PolicyRef,
    generation: number,
    signal?: AbortSignal,
  ): Promise<PolicyView> {
    const revision = this.revision;
    const identity = this.contextIdentity();
    this.assertAuthority(generation, ref.epoch, revision, signal);
    const view = this.find(ref);
    if (view.state === "quarantined" || view.state === "retired")
      throw new RuntimeFault(
        "conflict",
        "Register a revised version before validating a quarantined or retired policy",
      );
    if (view.state === "trial" || view.state === "active") return view;
    const key = keyOf(view);
    if (this.validations.has(key))
      throw new RuntimeFault(
        "busy",
        "This exact policy version is already being validated",
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const operation: Validation = { controller, done: Promise.resolve(view) };
    // Enter the registry before asynchronous context acquisition or worker startup.
    this.validations.set(key, operation);
    operation.done = (async () => {
      let worker: PolicyWorker | null = null;
      try {
        const context = await this.host.context();
        this.assertAuthority(
          generation,
          ref.epoch,
          revision,
          controller.signal,
        );
        this.assertIdentity(identity, context);
        worker = await this.startWorker(view, revision);
        this.assertAuthority(
          generation,
          ref.epoch,
          revision,
          controller.signal,
        );
        this.assertIdentity(identity, context);
        policyDecisionSchema.parse(
          await worker.evaluate(context, controller.signal),
        );
        await worker.close();
        worker = null;
        this.assertAuthority(
          generation,
          ref.epoch,
          revision,
          controller.signal,
        );
        this.assertIdentity(identity, context);
        if (view.state === "retired")
          throw new RuntimeFault(
            "stale_context",
            "Policy validation authority was retired",
          );
        if (view.state === "draft") view.state = "validated";
        view.last_error = null;
        this.store.savePolicy(
          this.runId!,
          view,
          `Policy ${view.name} v${view.version} passed isolated validation; effectiveness is unmeasured`,
        );
        this.host.changed();
        return view;
      } catch (error) {
        this.assertAuthority(
          generation,
          ref.epoch,
          revision,
          controller.signal,
        );
        this.assertIdentity(identity);
        if (view.state === "retired")
          throw new RuntimeFault(
            "stale_context",
            "Policy validation authority was retired",
          );
        view.state = "quarantined";
        view.last_error =
          error instanceof RuntimeFault &&
          (error.code === "backend_unavailable" ||
            error.code === "invalid_program")
            ? error.message
            : "Isolated policy validation failed or exceeded its limits";
        this.store.savePolicy(this.runId!, view, view.last_error);
        this.host.changed();
        if (error instanceof RuntimeFault) throw error;
        throw new RuntimeFault("precondition_failed", view.last_error);
      } finally {
        try {
          if (worker) await this.closeWorker(worker);
        } finally {
          signal?.removeEventListener("abort", abort);
          if (this.validations.get(key) === operation)
            this.validations.delete(key);
        }
      }
    })();
    return await operation.done;
  }

  async activate(
    input: z.infer<typeof activateSchema>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<PolicyView> {
    if (this.activating)
      throw new RuntimeFault(
        "busy",
        "A policy selection change is already pending",
      );
    this.activating = true;
    try {
      return await this.activateSelection(input, generation, signal);
    } finally {
      this.activating = false;
    }
  }

  private async activateSelection(
    input: z.infer<typeof activateSchema>,
    generation: number,
    signal?: AbortSignal,
  ): Promise<PolicyView> {
    const revision = this.revision;
    const identity = this.contextIdentity();
    this.assertAuthority(generation, input.epoch, revision, signal);
    const view = this.find(input);
    this.compatible(view);
    const key = keyOf(view);
    if (this.validations.has(key))
      throw new RuntimeFault(
        "busy",
        "Wait for isolated validation to settle before selecting this policy",
      );
    let slot = this.slots.get(key);
    if (slot?.selected && !slot.closure) {
      if (!slot.worker)
        throw new RuntimeFault(
          "busy",
          "Selected policy worker is suspended or starting",
        );
      if (this.trialBound(slot)) {
        await this.finishTrial(slot, "trial_bound");
        this.assertAuthority(generation, input.epoch, revision, signal);
        this.assertIdentity(identity);
      } else {
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
          this.runId!,
          view,
          "Strategist explicitly kept the policy using confirmed effect evidence",
        );
        this.host.admitted();
        this.host.changed();
        return view;
      }
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
      (candidate) => candidate.selected,
    );
    const prior = selected.find(
      (candidate) =>
        candidate.view.policy_id === view.policy_id && candidate !== slot,
    );
    if (!prior && selected.length >= 4)
      throw new RuntimeFault("busy", "At most four policies can be selected");
    if (prior)
      await this.closePolicy(
        prior,
        "validated",
        "A newer immutable version replaced this selection",
      );
    this.assertAuthority(generation, input.epoch, revision, signal);
    this.assertIdentity(identity);
    if (slot?.closure) await slot.closure;
    this.assertAuthority(generation, input.epoch, revision, signal);
    this.assertIdentity(identity);
    if (!slot) {
      slot = {
        view,
        runId: this.runId!,
        identity,
        runGeneration: generation,
        generation: 0,
        worker: null,
        closure: null,
        selected: false,
        timer: undefined,
        expiry: undefined,
        controller: null,
        evaluation: null,
        trial_started: 0,
        trial_deadline: 0,
        trial_actions: 0,
        trial_evaluations: 0,
        max_ms: input.max_ms,
        max_actions: input.max_actions,
        max_evaluations: input.max_evaluations,
        tried: false,
      };
      this.slots.set(key, slot);
    }
    slot.generation++;
    slot.identity = identity;
    slot.runGeneration = generation;
    const policyGeneration = slot.generation;
    slot.closure = null;
    slot.selected = true;
    if (input.mode === "trial") {
      slot.trial_started = 0;
      slot.trial_deadline = 0;
      slot.trial_actions = 0;
      slot.trial_evaluations = 0;
      slot.max_ms = input.max_ms;
      slot.max_actions = input.max_actions;
      slot.max_evaluations = input.max_evaluations;
    }
    this.store.event(
      slot.runId,
      "policy.activation_admitted",
      "Exact immutable policy selection admitted before worker dispatch",
      {
        policy_id: view.policy_id,
        version: view.version,
        mode: input.mode,
        max_ms: slot.max_ms,
        max_actions: slot.max_actions,
        max_evaluations: slot.max_evaluations,
        generation: policyGeneration,
      },
    );
    let worker: PolicyWorker | null = null;
    try {
      worker = await this.startWorker(view, revision);
      this.assertAuthority(generation, input.epoch, revision, signal);
      this.assertIdentity(identity);
      if (
        slot.generation !== policyGeneration ||
        slot.closure ||
        !slot.selected
      )
        throw new RuntimeFault(
          "stale_context",
          "Policy selection was revoked while its worker started",
        );
      slot.worker = worker;
      worker = null;
      view.state = input.mode === "keep" ? "active" : "trial";
      view.last_error = null;
      this.store.savePolicy(
        slot.runId,
        view,
        input.mode === "keep"
          ? "Strategist activated a previously tried policy with real effect evidence"
          : "Bounded policy trial activated",
      );
      this.host.admitted();
      this.schedulePolicy(slot);
      this.host.changed();
      return view;
    } catch (error) {
      if (slot.generation === policyGeneration) slot.selected = false;
      if (worker) await this.closeWorker(worker);
      if (error instanceof RuntimeFault) throw error;
      throw new RuntimeFault(
        "backend_unavailable",
        "Isolated policy worker could not start",
      );
    }
  }

  async retire(ref: PolicyRef, generation: number): Promise<PolicyView> {
    const revision = this.revision;
    const identity = this.contextIdentity();
    this.assertAuthority(generation, ref.epoch, revision);
    const view = this.find(ref);
    const validation = this.validations.get(keyOf(view));
    validation?.controller.abort();
    if (validation) await Promise.allSettled([validation.done]);
    const slot = this.slots.get(keyOf(view));
    if (slot)
      await this.closePolicy(slot, "retired", "Strategist retired the policy");
    else {
      view.state = "retired";
      this.store.savePolicy(this.runId!, view, "Strategist retired the policy");
    }
    this.assertAuthority(generation, ref.epoch, revision);
    this.assertIdentity(identity);
    this.host.changed();
    return view;
  }

  async resume(generation: number): Promise<void> {
    const revision = this.revision;
    const identity = this.contextIdentity();
    if (identity.life_status !== "alive")
      throw new RuntimeFault(
        "precondition_failed",
        "Reactive effects require a confirmed living player",
      );
    const run = this.assertAuthority(generation, undefined, revision);
    this.fenced = false;
    for (const slot of this.slots.values()) {
      if (!slot.selected) continue;
      if (slot.closure) await slot.closure;
      this.assertAuthority(generation, run.epoch, revision);
      this.assertIdentity(identity);
      slot.closure = null;
      if (
        !slot.selected ||
        (slot.view.state !== "trial" && slot.view.state !== "active")
      )
        continue;
      if (this.trialBound(slot)) {
        await this.finishTrial(slot, "elapsed_while_paused");
        continue;
      }
      if (slot.worker) {
        this.schedulePolicy(slot);
        continue;
      }
      const policyGeneration = ++slot.generation;
      slot.identity = identity;
      slot.runGeneration = generation;
      const worker = await this.startWorker(slot.view, revision);
      try {
        this.assertAuthority(generation, run.epoch, revision);
        this.assertIdentity(identity);
        if (
          slot.generation !== policyGeneration ||
          slot.closure ||
          !slot.selected
        )
          throw new RuntimeFault(
            "stale_context",
            "Resumed policy authority was revoked",
          );
      } catch (error) {
        await this.closeWorker(worker);
        throw error;
      }
      slot.worker = worker;
      this.schedulePolicy(slot);
    }
  }

  scheduleAll(): void {
    for (const slot of this.slots.values()) this.schedulePolicy(slot);
  }

  fence(): void {
    this.revision++;
    this.fenced = true;
    for (const validation of this.validations.values())
      validation.controller.abort();
    for (const slot of this.slots.values()) {
      slot.generation++;
      clearTimeout(slot.timer);
      clearTimeout(slot.expiry);
      slot.timer = undefined;
      slot.expiry = undefined;
      slot.controller?.abort();
    }
  }

  /**
   * Call immediately on session/life readiness changes. The synchronous fence
   * revokes in-flight results; settlement drains workers without disconnecting
   * the game or renewing consumed trial budgets. Resume only after alive readiness.
   */
  lifeChanged(): Promise<void> {
    return this.closeAll(true);
  }

  async closeAll(retain: boolean): Promise<void> {
    this.fence();
    const closures: Promise<unknown>[] = [];
    for (const slot of this.slots.values()) {
      if (!retain) slot.selected = false;
      closures.push(
        this.closePolicy(
          slot,
          retain ? null : "retired",
          retain
            ? "Policy suspended; exact selection and absolute trial bounds retained"
            : "Policy selection revoked during run shutdown",
          retain,
        ),
      );
    }
    for (const validation of this.validations.values())
      closures.push(
        validation.done.catch((error) => {
          if (
            !(error instanceof RuntimeFault) ||
            error.code !== "stale_context"
          )
            throw error;
        }),
      );
    // A worker that starts after fencing closes itself before its startup promise settles.
    for (const start of this.starts)
      closures.push(
        start.catch((error) => {
          if (
            !(error instanceof RuntimeFault) ||
            error.code !== "stale_context"
          )
            throw error;
        }),
      );
    const results = await Promise.allSettled(closures);
    if (results.some((result) => result.status === "rejected"))
      throw new RuntimeFault(
        "unknown_effect",
        "Policy worker or effect shutdown could not be confirmed",
      );
  }

  recordEffect(
    policy: PolicyAuthority,
    kind: "executed" | "neutralized",
    evidence: Json,
  ): void {
    const slot = this.slots.get(keyOf(policy.view));
    if (slot !== policy || slot.runId !== this.runId) return;
    slot.view.effects++;
    this.store.savePolicy(slot.runId, slot.view);
    this.store.event(
      slot.runId,
      "policy.effect",
      "Policy has confirmed attributable effect evidence, not just a proposal or continue result",
      {
        policy_id: slot.view.policy_id,
        version: slot.view.version,
        kind,
        evidence,
      },
    );
    this.host.changed();
  }

  private find(ref: { policy_id: string; version: number }): PolicyView {
    const view = this.policies.find(
      (candidate) => keyOf(candidate) === keyOf(ref),
    );
    if (!view)
      throw new RuntimeFault(
        "not_found",
        "Policy version not found in this run",
      );
    return view;
  }

  private contextIdentity(): ContextIdentity {
    const state = this.host.gameState();
    if (!state.session_id || !state.life || !state.world_id || !state.binding?.ready || !state.space)
      throw new RuntimeFault(
        "stale_context",
        "A real game session and player life are required",
      );
    return {
      session_id: state.session_id,
      life_id: state.life.life_id,
      life_status: state.life.status,
      epoch: state.epoch,
      world_id: state.world_id,
      native_boot_id: state.binding.native_boot_id, space_epoch: state.space.space_epoch,
      compatibility_hash: state.binding.compatibility_hash, screen: state.screen,
    };
  }

  private identityCurrent(identity: ContextIdentity): boolean {
    const state = this.host.gameState();
    return (
      state.session_id === identity.session_id &&
      state.epoch === identity.epoch &&
      state.world_id === identity.world_id &&
      state.life?.life_id === identity.life_id &&
      state.life.status === identity.life_status &&
      state.binding?.native_boot_id === identity.native_boot_id && state.binding.compatibility_hash === identity.compatibility_hash &&
      state.space?.space_epoch === identity.space_epoch && sameScreen(state.screen, identity.screen)
    );
  }

  private assertIdentity(
    identity: ContextIdentity,
    context?: PolicyContext,
  ): void {
    if (
      !this.identityCurrent(identity) ||
      (context &&
        (context.observation.session_id !== identity.session_id ||
          context.observation.epoch !== identity.epoch ||
          context.observation.world_id !== identity.world_id ||
          context.observation.life.life_id !== identity.life_id ||
          context.observation.life.status !== identity.life_status ||
          context.observation.native_boot_id !== identity.native_boot_id || context.observation.space.space_epoch !== identity.space_epoch ||
          context.observation.compatibility_hash !== identity.compatibility_hash || !sameScreen(context.observation.screen, identity.screen)))
    )
      throw new RuntimeFault(
        "stale_context",
        "Reactive context belongs to an obsolete session or player life",
      );
  }

  private assertAuthority(
    generation: number,
    epoch: number | undefined,
    revision: number,
    signal?: AbortSignal,
  ): StoredRun {
    const run = this.host.assertCurrent(generation, epoch);
    if (
      revision !== this.revision ||
      signal?.aborted ||
      run.run_id !== this.runId
    )
      throw new RuntimeFault(
        "stale_context",
        "Reactive policy authority was revoked",
      );
    return run;
  }

  private startWorker(
    view: PolicyView,
    revision: number,
  ): Promise<PolicyWorker> {
    this.compatible(view);
    const start = (async () => {
      let worker: PolicyWorker;
      try {
        if (
          view.backend === "javascript" &&
          !this.canonicalSources.has(view.source)
        ) {
          let validationError: unknown;
          try {
            const validated = await validateProgramSource(
              view.source,
              "policy",
              this.contract(),
            );
            if (validated.source !== view.source)
              throw new RuntimeFault(
                "invalid_program",
                "Stored policy source is not canonical; register a revised immutable version",
              );
          } catch (error) {
            validationError = error;
          }
          if (revision !== this.revision)
            throw new RuntimeFault(
              "stale_context",
              "Policy static-validation authority was revoked",
            );
          if (validationError) {
            view.state = "quarantined";
            view.last_error =
              "Stored policy source does not satisfy current static validation; register a revised immutable version";
            this.store.savePolicy(this.runId!, view, view.last_error);
            this.host.changed();
            const fault = new RuntimeFault("invalid_program", view.last_error);
            if (validationError instanceof ProgramValidationError)
              Object.assign(fault, { issues: validationError.issues });
            throw fault;
          }
          this.canonicalSources.add(view.source);
        }
        if (revision !== this.revision)
          throw new RuntimeFault(
            "stale_context",
            "Policy worker startup authority was revoked",
          );
        worker =
          view.backend === "javascript"
            ? await this.sandbox.createWorker(specOf(view))
            : this.jevWorker(view);
      } catch (error) {
        if (error instanceof RuntimeFault) throw error;
        throw new RuntimeFault(
          "backend_unavailable",
          "Isolated policy worker could not start",
        );
      }
      if (revision !== this.revision) {
        await this.closeWorker(worker);
        throw new RuntimeFault(
          "stale_context",
          "Policy worker startup authority was revoked",
        );
      }
      return worker;
    })();
    this.starts.add(start);
    void start.then(
      () => this.starts.delete(start),
      () => this.starts.delete(start),
    );
    return start;
  }

  private async closeWorker(worker: PolicyWorker): Promise<void> {
    try {
      await worker.close();
    } catch {
      throw new RuntimeFault(
        "unknown_effect",
        "Isolated policy worker shutdown could not be confirmed",
      );
    }
  }

  private jevWorker(view: PolicyView): PolicyWorker {
    const judge = this.judge;
    const choices = view.choices;
    const run = this.host.run();
    if (!judge || !choices || !run)
      throw new RuntimeFault(
        "backend_unavailable",
        "Real Jev connection and finite choices are required",
      );
    const identity = this.contextIdentity();
    const generation = this.host.generation();
    const epoch = run.epoch;
    const assertCurrent = (context: PolicyContext) => {
      this.host.assertCurrent(generation, epoch);
      if (this.host.run()?.run_id !== run.run_id)
        throw new RuntimeFault("stale_context", "Jev run authority revoked");
      this.assertIdentity(identity, context);
    };
    let selection: FastJudgeSelection;
    try {
      selection = judge.selection();
    } catch {
      throw new RuntimeFault(
        "backend_unavailable",
        "Jev is unavailable; configure an app-owned TypeSafe API key and supported judge",
      );
    }
    const pending = new Map<AbortController, Promise<void>>();
    let closed = false;
    return {
      evaluate: async (context, signal) => {
        if (closed || signal?.aborted)
          throw new RuntimeFault("stale_context", "Jev authority revoked");
        assertCurrent(context);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const { promise: settlement, resolve: settle } =
          Promise.withResolvers<void>();
        pending.set(controller, settlement);
        const requestId = randomUUID();
        let accounted = false;
        const account = (result: JudgeAccounting) => {
          if (accounted) return;
          accounted = true;
          for (let count = 0; count < result.actual_calls; count++)
            recordCall(run.usage, "other");
          if (result.usage) recordUsage(run.usage, "other", result.usage);
          if (result.known_cost !== null) {
            run.usage.known_cost =
              (run.usage.known_cost ?? 0) + result.known_cost;
            run.usage.by_purpose.other.known_cost =
              (run.usage.by_purpose.other.known_cost ?? 0) + result.known_cost;
          }
          this.store.event(
            run.run_id,
            "model.usage",
            "Actual finite Jev request usage; missing provider counters remain unknown",
            {
              request_id: requestId,
              purpose: "other",
              provider_request_id: result.provider_request_id,
              actual_calls: result.actual_calls,
              usage: result.usage as unknown as Json,
              known_cost: result.known_cost,
              usage_evidence: result.usage_evidence as unknown as Json,
            },
          );
          this.store.saveRun(run);
          this.host.changed();
        };
        const deadlineAt = Date.now() + selection.request_timeout_ms;
        const deadline = setTimeout(
          () => controller.abort(),
          selection.request_timeout_ms,
        );
        try {
          this.store.event(
            run.run_id,
            "model.call",
            "Finite Jev provider request started",
            {
              request_id: requestId,
              purpose: "other",
              backend: "jev",
              policy_id: view.policy_id,
              version: view.version,
              model_id: selection.model_id,
              request_timeout_ms: selection.request_timeout_ms,
              session_id: context.observation.session_id,
              life_id: context.observation.life.life_id,
            },
          );
          const result = await judge.evaluate({
            model_id: selection.model_id,
            instruction: view.source,
            choices,
            context,
            request_id: requestId,
            deadline_at: deadlineAt,
            signal: controller.signal,
          });
          account(result);
          if (closed || controller.signal.aborted)
            throw new RuntimeFault("stale_context", "Jev authority revoked");
          assertCurrent(context);
          const choice = choices.find(
            (candidate) => candidate.id === result.choice_id,
          );
          if (!choice)
            throw new RuntimeFault(
              "invalid_result",
              "Jev returned an unknown finite choice",
            );
          return policyDecisionSchema.parse(choice.decision);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "actual_calls" in error &&
            "usage" in error &&
            "known_cost" in error &&
            "provider_request_id" in error
          )
            account(error as JudgeAccounting);
          if (error instanceof RuntimeFault) throw error;
          throw new RuntimeFault(
            "backend_unavailable",
            "Real Jev request failed or returned no authorized finite choice",
          );
        } finally {
          clearTimeout(deadline);
          signal?.removeEventListener("abort", abort);
          pending.delete(controller);
          settle();
        }
      },
      close: async () => {
        closed = true;
        for (const controller of pending.keys()) controller.abort();
        await Promise.all(pending.values());
      },
    };
  }

  private trialBound(slot: PolicySlot): boolean {
    return (
      slot.view.state === "trial" &&
      slot.trial_started > 0 &&
      (Date.now() >= slot.trial_deadline ||
        slot.trial_actions >= slot.max_actions ||
        slot.trial_evaluations >= slot.max_evaluations)
    );
  }

  private schedulePolicy(slot: PolicySlot): void {
    const run = this.host.run();
    if (
      this.fenced ||
      !slot.selected ||
      !slot.worker ||
      slot.closure ||
      run?.status !== "running" ||
      this.host.needsReconnect() ||
      !this.identityCurrent(slot.identity) ||
      slot.runGeneration !== this.host.generation() ||
      this.host.gameState().life?.status !== "alive"
    )
      return;
    if (slot.view.state !== "trial" && slot.view.state !== "active") return;
    if (slot.view.state === "trial" && slot.trial_started === 0) {
      slot.trial_started = Date.now();
      slot.trial_deadline = slot.trial_started + slot.max_ms;
      slot.tried = true;
      this.store.event(
        slot.runId,
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
    if (this.trialBound(slot)) {
      this.deferClose(() => this.finishTrial(slot, "trial_bound"), slot);
      return;
    }
    if (slot.view.state === "trial" && !slot.expiry)
      slot.expiry = setTimeout(
        () =>
          this.deferClose(() => this.finishTrial(slot, "elapsed_time"), slot),
        Math.max(1, slot.trial_deadline - Date.now()),
      );
    if (slot.timer || slot.evaluation) return;
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      if (
        !slot.selected ||
        !slot.worker ||
        slot.closure ||
        this.host.run()?.status !== "running" ||
        this.fenced ||
        !this.identityCurrent(slot.identity) ||
        slot.runGeneration !== this.host.generation() ||
        this.host.gameState().life?.status !== "alive"
      )
        return;
      const evaluation = this.evaluatePolicy(slot);
      slot.evaluation = evaluation;
      void evaluation
        .finally(() => {
          if (slot.evaluation === evaluation) slot.evaluation = null;
          this.schedulePolicy(slot);
        })
        .catch(() => this.backgroundFailure(slot));
    }, slot.view.interval_ms);
  }

  private async evaluatePolicy(slot: PolicySlot): Promise<void> {
    if (this.trialBound(slot)) {
      this.deferClose(() => this.finishTrial(slot, "trial_bound"), slot);
      return;
    }
    const generation = this.host.generation();
    const policyGeneration = slot.generation;
    const lease = this.actions.lease;
    const epoch = this.host.run()!.epoch;
    const identity = this.contextIdentity();
    const evaluationId = randomUUID();
    const worker = slot.worker!;
    const controller = new AbortController();
    slot.controller = controller;
    try {
      const context = await this.host.context();
      this.assertIdentity(identity, context);
      if (
        !this.policyCurrent(
          slot,
          generation,
          policyGeneration,
          epoch,
          lease,
          worker,
          identity,
        )
      )
        return;
      slot.view.evaluations++;
      if (slot.view.state === "trial") slot.trial_evaluations++;
      this.store.savePolicy(slot.runId, slot.view);
      this.store.event(
        slot.runId,
        "policy.evaluation_started",
        "Isolated policy evaluation started on captured authority",
        {
          evaluation_id: evaluationId,
          policy_id: slot.view.policy_id,
          version: slot.view.version,
          epoch,
          session_id: identity.session_id,
          life_id: identity.life_id,
          run_generation: generation,
          lease_generation: lease,
          observation_seq: context.observation.observation_seq,
        },
      );
      const decision = policyDecisionSchema.parse(
        await worker.evaluate(context, controller.signal),
      );
      if (decision.kind === "replace") {
        const registered = this.contract();
        if (!registered.adapter.action_capability) throw new RuntimeFault("precondition_failed", "This adapter has no effect capability");
        registered.registration.parseCapability(registered.adapter.action_capability.id, registered.adapter.action_capability.version, decision.action);
      }
      if (
        !this.policyCurrent(
          slot,
          generation,
          policyGeneration,
          epoch,
          lease,
          worker,
          identity,
        ) ||
        controller.signal.aborted
      ) {
        this.store.event(
          slot.runId,
          "policy.stale_result",
          "Obsolete policy result rejected; unrelated observation changes alone do not revoke authority",
          {
            evaluation_id: evaluationId,
            policy_id: slot.view.policy_id,
            version: slot.view.version,
          },
        );
        return;
      }
      if (slot.view.state === "trial" && Date.now() >= slot.trial_deadline)
        return;
      this.store.event(
        slot.runId,
        "policy.evaluated",
        "Isolated policy returned a validated scheduler decision",
        {
          evaluation_id: evaluationId,
          policy_id: slot.view.policy_id,
          version: slot.view.version,
          decision: decision as unknown as Json,
        },
      );
      if (decision.kind === "replan") this.host.wake("policy_replan");
      else if (decision.kind === "interrupt" || decision.kind === "replace") {
        if (
          decision.kind === "replace" &&
          this.actions.isEquivalent(decision.action)
        ) {
          this.decisionEvent(
            slot,
            evaluationId,
            "redundant",
            "Equivalent replacement ignored without cancelling or extending existing work",
          );
          return;
        }
        await this.actions.withPreemption(async (current) => {
          if (
            !this.policyCurrent(
              slot,
              generation,
              policyGeneration,
              epoch,
              lease,
              worker,
              identity,
            )
          )
            return;
          if (
            current &&
            (slot.view.priority < current.entry.priority ||
              (slot.view.priority === current.entry.priority &&
                current.entry.policy !== slot))
          ) {
            this.decisionEvent(
              slot,
              evaluationId,
              "priority_rejected",
              "Policy cannot preempt the current exclusive lease priority",
            );
            return;
          }
          if (
            current &&
            (current.cancellation ||
              current.entry.stored.view.status === "cancel_requested")
          ) {
            this.decisionEvent(
              slot,
              evaluationId,
              "cancellation_rejected",
              "Policy cannot claim interruption initiated by another request",
            );
            return;
          }
          // Closing a program fences every future capability, then awaits its actual leaf emitter.
          if (current) current.preemptionOwned = true;
          await this.host.closePrograms(
            "Reactive policy interrupted the running program",
          );
          const cancellationNeeded =
            current && !terminal[current.entry.stored.view.status];
          if (current && (cancellationNeeded || current.cancellation)) {
            await this.actions.cancelExecution(
              current,
              "Policy requested effect preemption",
            );
            if (!current.neutralized || this.host.needsReconnect()) return;
          }
          // Cancellation settlement does not prove pump retirement. Await the
          // captured execution leaving its lease before sampling the handoff.
          if (current) await this.actions.awaitRetirement(current);
          const settledLease = this.actions.lease;
          await this.host.neutralize();
          if (
            !this.policyCurrent(
              slot,
              generation,
              policyGeneration,
              epoch,
              settledLease,
              worker,
              identity,
            ) ||
            (this.actions.active && this.actions.active !== current) ||
            controller.signal.aborted
          )
            return;
          if (
            slot.view.state === "trial" &&
            (Date.now() >= slot.trial_deadline ||
              slot.trial_actions >= slot.max_actions)
          )
            return;
          if (decision.kind === "interrupt" && current)
            this.recordNeutralization(slot, current, evaluationId);
          if (decision.kind === "replace")
            this.actions.admit(
              `policy_${evaluationId}`,
              decision.action,
              slot.view.priority,
              undefined,
              slot,
            );
          else this.host.wake("policy_interrupt");
        });
      }
    } catch (error) {
      if (
        generation !== this.host.generation() ||
        policyGeneration !== slot.generation ||
        !this.identityCurrent(identity) ||
        controller.signal.aborted
      )
        return;
      slot.view.last_error =
        error instanceof RuntimeFault && error.code === "backend_unavailable"
          ? error.message
          : "Isolated policy evaluation failed, returned an invalid decision, or exceeded its limits";
      this.deferClose(async () => {
        await this.closePolicy(slot, "quarantined", slot.view.last_error!);
        this.host.wake("policy_error");
      }, slot);
    } finally {
      if (slot.controller === controller) slot.controller = null;
      if (this.trialBound(slot))
        this.deferClose(() => this.finishTrial(slot, "trial_bound"), slot);
      this.host.changed();
    }
  }

  private policyCurrent(
    slot: PolicySlot,
    generation: number,
    policyGeneration: number,
    epoch: number,
    lease: number,
    worker: PolicyWorker,
    identity: ContextIdentity,
  ): boolean {
    const run = this.host.run();
    const state = this.host.gameState();
    return (
      !!run &&
      !this.fenced &&
      this.identityCurrent(identity) &&
      slot.identity.session_id === identity.session_id &&
      slot.identity.life_id === identity.life_id &&
      slot.runGeneration === generation &&
      identity.life_status === "alive" &&
      slot.runId === run.run_id &&
      run.status === "running" &&
      generation === this.host.generation() &&
      epoch === run.epoch &&
      lease === this.actions.lease &&
      slot.generation === policyGeneration &&
      slot.worker === worker &&
      slot.selected &&
      !slot.closure &&
      (slot.view.state === "trial" || slot.view.state === "active") &&
      !this.host.needsReconnect() &&
      state.status === "connected" &&
      state.epoch === epoch &&
      state.world_id === run.world_id
    );
  }

  private recordNeutralization(
    slot: PolicySlot,
    current: ActionExecution,
    evaluationId: string,
  ): void {
    const result = current.entry.stored.view.result;
    const evidence = result?.evidence;
    if (
      current.neutralized &&
      result?.status === "cancelled" &&
      evidence &&
      typeof evidence === "object" &&
      !Array.isArray(evidence) &&
      evidence.neutralized_effect === true
    )
      this.recordEffect(slot, "neutralized", {
        evaluation_id: evaluationId,
        action_id: current.entry.stored.view.action_id,
      });
  }

  private decisionEvent(
    slot: PolicySlot,
    evaluationId: string,
    kind: string,
    summary: string,
  ): void {
    this.store.event(slot.runId, `policy.${kind}`, summary, {
      evaluation_id: evaluationId,
      policy_id: slot.view.policy_id,
      version: slot.view.version,
    });
  }

  private async finishTrial(slot: PolicySlot, reason: string): Promise<void> {
    if (slot.view.state !== "trial" || slot.closure || !slot.selected) return;
    slot.tried = true;
    await this.closePolicy(
      slot,
      "validated",
      "Bounded policy trial closed; an explicit evidence-linked decision is required",
    );
    this.store.event(
      slot.runId,
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
    this.host.wake("trial_decision_due");
  }

  private closePolicy(
    slot: PolicySlot,
    state: PolicyView["state"] | null,
    reason: string,
    retain = false,
  ): Promise<void> {
    if (!retain) slot.selected = false;
    if (slot.closure)
      return slot.closure.then(() => {
        if (state && slot.view.state !== state) {
          slot.view.state = state;
          this.store.savePolicy(slot.runId, slot.view, reason);
        }
      });
    slot.generation++;
    clearTimeout(slot.timer);
    clearTimeout(slot.expiry);
    slot.timer = undefined;
    slot.expiry = undefined;
    slot.controller?.abort();
    const worker = slot.worker;
    slot.worker = null;
    const evaluation = slot.evaluation;
    slot.closure = (async () => {
      const results = await Promise.allSettled([
        worker ? this.closeWorker(worker) : Promise.resolve(),
        this.actions.cancelPolicy(slot, reason),
        evaluation,
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new RuntimeFault(
          "unknown_effect",
          "Policy worker or effect shutdown could not be confirmed",
        );
      if (state) slot.view.state = state;
      this.store.savePolicy(slot.runId, slot.view, reason);
      this.host.changed();
    })();
    return slot.closure;
  }

  private deferClose(operation: () => Promise<void>, slot: PolicySlot): void {
    queueMicrotask(() => {
      void operation().catch(() => this.backgroundFailure(slot));
    });
  }

  private backgroundFailure(slot: PolicySlot): void {
    slot.view.last_error =
      "Policy worker or effect cleanup could not be confirmed; no replacement is authorized";
    this.store.savePolicy(slot.runId, slot.view, slot.view.last_error);
    this.host.changed();
    this.host.wake("policy_error");
  }
}
