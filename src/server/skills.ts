import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  GameAction,
  GameActionResult,
  Json,
  Observation,
} from "../shared/contracts.ts";
import type {
  SkillCapabilityRequest,
  SkillExecutionView,
  SkillLimits,
  SkillRef,
  SkillResult,
  SkillStartRequest,
  SkillView,
} from "../shared/programs.ts";
import {
  skillCapabilitySchema,
  skillStartRequestSchema,
  skillResultSchema,
} from "../shared/validation.ts";
import { validateSkill } from "./program-validation.ts";
import { SkillCleanupError, type SandboxService } from "./sandbox.ts";
import type { Store } from "./store.ts";
import type { LookaheadConfig } from "../shared/planning.ts";
import { ExecutionTrace } from "./execution-trace.ts";
export const skillLookupSchema = z.union([
  z.object({ execution_id: z.string().min(1).max(160) }).strict(),
  z.object({ start_key: z.string().min(1).max(160) }).strict(),
]);
export interface SkillHost {
  authorize(runId: string, epoch: number, sessionId: string, lifeId: number): void;
  observe(): Promise<Observation>;
  action(
    execution: SkillExecutionView,
    action: GameAction,
    signal: AbortSignal,
    callId: string,
  ): Promise<GameActionResult>;
  recipes(item: string): Promise<Json>;
  cancelActions(
    executionIds: ReadonlySet<string>,
    reason: string,
  ): Promise<void>;
  changed(outcome: boolean, execution?: SkillExecutionView): void;
  unsafe(): void;
  recover(execution: SkillExecutionView, result: GameActionResult): Promise<number>;
  prepareLookahead?(config: LookaheadConfig): (executionId: string) => void;
}
interface Live {
  view: SkillExecutionView;
  root: Live;
  depth: number;
  controller: AbortController;
  done: Promise<void>;
  children: Set<Live>;
  timer: ReturnType<typeof setTimeout> | undefined;
  closing: Promise<void> | null;
  cleanupEffects: Promise<void> | null;
  abortStatus: "cancelled" | "failed" | "unknown";
  cleanupFailure: Error | null;
  pending: boolean;
  lifeId: number;
}
const terminal = new Set<SkillExecutionView["status"]>([
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
  "unknown",
]);
/** Durable identities and host-authorized capabilities; no worker owns the avatar lease. */
export class SkillManager {
  private live = new Map<string, Live>();
  private cleanupFailures = new Set<Error>();
  private trace: ExecutionTrace;
  constructor(
    private store: Store,
    private sandbox: Pick<SandboxService, "runSkill">,
    private host: SkillHost,
  ) { this.trace = new ExecutionTrace(store); }
  get pending(): boolean {
    return this.live.size > 0;
  }
  async register(
    runId: string,
    spec: unknown,
    beforeCommit: () => void = () => {},
  ): Promise<SkillView> {
    const validated = await validateSkill(spec);
    this.validateDependencies(runId, validated.dependencies);
    beforeCommit();
    const view = this.store.registerSkill(runId, validated);
    this.host.changed(false);
    return view;
  }
  async importSnapshot(
    runId: string,
    snapshot: SkillView,
    beforeCommit: () => void = () => {},
  ): Promise<SkillView> {
    const validated = await validateSkill({
      name: snapshot.name,
      source: snapshot.source,
      card: snapshot.card,
      dependencies: snapshot.dependencies,
    });
    if (
      validated.source !== snapshot.source ||
      createHash("sha256").update(snapshot.source).digest("hex") !==
        snapshot.hash
    )
      throw new Error(
        "Exact snapshot bytes do not match current canonical validation",
      );
    if (validated.validation.fingerprint !== snapshot.validation.fingerprint)
      throw new Error(
        "Snapshot validator configuration changed; fresh evidence requires a validated revision",
      );
    this.validateDependencies(runId, snapshot.dependencies);
    beforeCommit();
    const view = this.store.importSkill(runId, snapshot);
    this.store.event(
      runId,
      "skill.revalidated_import",
      "Exact portable snapshot freshly validated without rewriting dependency references",
      {
        skill_id: view.skill_id,
        version: view.version,
        hash: view.hash,
        validation: validated.validation as unknown as Json,
      },
    );
    this.host.changed(false);
    return view;
  }
  private validateDependencies(runId: string, dependencies: SkillRef[]): void {
    const visited = new Map<string, number>();
    const visit = (ref: SkillRef, depth: number): void => {
      if (depth > 8) throw new Error("Dependency depth exceeds eight");
      const key = `${ref.skill_id}:${ref.version}`;
      if ((visited.get(key) ?? 0) >= depth) return;
      visited.set(key, depth);
      const dependency = this.store.skill(runId, ref);
      if (dependency.state !== "validated")
        throw new Error("Dependency is not validated");
      for (const nested of dependency.dependencies) visit(nested, depth + 1);
    };
    for (const dependency of dependencies) visit(dependency, 2);
  }
  start(runId: string, request: SkillStartRequest): SkillExecutionView {
    const parsed = skillStartRequestSchema.parse(request);
    const existing = this.store.skillExecution(runId, {
      start_key: parsed.start_key,
    });
    if (existing) return this.store.admitSkill(runId, parsed).view;
    this.host.authorize(runId, parsed.epoch, parsed.session_id, parsed.life_id);
    const armLookahead = parsed.lookahead
      ? this.host.prepareLookahead?.(parsed.lookahead) : undefined;
    if (parsed.lookahead && !armLookahead)
      throw new Error("This program host does not provide speculative planning");
    const skill = this.store.skill(runId, parsed);
    if (skill.state !== "validated") throw new Error("Skill is not validated");
    const admitted = this.store.admitSkill(runId, parsed);
    if (admitted.created) {
      const live = this.dispatch(admitted.view, skill, null);
      try {
        armLookahead?.(admitted.view.execution_id);
      } catch (error) {
        // Still in the admission stack: revoke before the dispatch microtask can
        // execute any model-authored capability.
        void this.closeTree(live, "Startup lookahead authority could not be armed")
          .catch(() => this.host.unsafe());
        throw error;
      }
    }
    return structuredClone(admitted.view);
  }
  get(
    runId: string,
    lookup: { execution_id: string } | { start_key: string },
  ): SkillExecutionView | null {
    return this.store.skillExecution(runId, lookup);
  }
  cancel(
    runId: string,
    lookup: { execution_id: string } | { start_key: string },
    reason = "Skill cancellation requested",
  ): SkillExecutionView {
    const view = this.get(runId, lookup);
    if (!view) throw new Error("Skill execution not found");
    const live = this.live.get(view.execution_id);
    if (live)
      void this.closeTree(live, reason).catch(() => this.host.changed(true));
    return this.get(runId, lookup)!;
  }
  fence(reason: string, uncertainExecutionId?: string): void {
    let uncertain = uncertainExecutionId ? this.live.get(uncertainExecutionId) : undefined;
    while (uncertain) {
      uncertain.abortStatus = "unknown";
      uncertain = uncertain.view.parent_execution_id
        ? this.live.get(uncertain.view.parent_execution_id) : undefined;
    }
    for (const live of this.live.values())
      if (live.root === live)
        void this.closeTree(live, reason).catch(() => this.host.changed(true));
  }
  async closeAll(reason: string): Promise<void> {
    const roots = [...this.live.values()].filter((live) => live.root === live);
    for (const root of roots) this.revoke(root, reason);
    await Promise.all(roots.map((root) => this.closeTree(root, reason)));
    if (this.cleanupFailures.size)
      throw this.cleanupFailures.values().next().value;
  }
  private save(
    live: Live,
    type: string,
    summary: string,
    details: Json = null,
  ): void {
    this.store.updateSkillExecution(live.view, type, summary, details);
    this.host.changed(false);
  }
  private dispatch(
    view: SkillExecutionView,
    skill: SkillView,
    parent: Live | null,
  ): Live {
    const live: Live = {
      view,
      root: null as unknown as Live,
      depth: parent ? parent.depth + 1 : 1,
      controller: new AbortController(),
      done: Promise.resolve(),
      children: new Set(),
      timer: undefined,
      closing: null,
      cleanupEffects: null,
      abortStatus: "cancelled",
      cleanupFailure: null,
      pending: false,
      lifeId: view.life_id!,
    };
    live.root = parent?.root ?? live;
    parent?.children.add(live);
    this.live.set(view.execution_id, live);
    live.timer = setTimeout(
      () => {
        void this.closeTree(live.root, "Root skill deadline reached").catch(
          () => this.host.changed(true),
        );
      },
      Math.max(1, Date.parse(view.deadline_at) - Date.now()),
    );
    live.done = Promise.resolve().then(async () => {
      let outcome: SkillResult | null = null;
      try {
        this.authorize(live);
        view.status = "running";
        view.started_at = new Date().toISOString();
        this.save(
          live,
          "skill.running",
          "Skill dispatched inside its isolated execution",
        );
        outcome = skillResultSchema.parse(
          await this.sandbox.runSkill(
            skill.source,
            view.args,
            (request: SkillCapabilityRequest) =>
              this.capability(live, skill, request),
            this.remaining(live),
            live.controller.signal,
            {
              onInstrumentation: (metadata) => {
                this.trace.record(view, "branch", {
                  kind: "instrumentation",
                  ...metadata,
                } as unknown as Json);
              },
              onTrace: (trace) => {
                this.trace.record(view, "branch", trace as unknown as Json, { life_id: live.lifeId });
              },
            },
          ),
        );
        await Promise.all([...live.children].map((child) => child.done));
        if (!live.controller.signal.aborted) {
          this.authorize(live);
          view.result = outcome;
          view.status =
            outcome.status === "completed" ? "succeeded" : outcome.status;
        }
      } catch (error) {
        if (error instanceof SkillCleanupError) {
          live.cleanupFailure = error;
          live.abortStatus = "unknown";
          this.cleanupFailures.add(error);
          this.host.unsafe();
        }
        if (!live.controller.signal.aborted) {
          this.revoke(live, "Skill execution or capability failed");
          live.cleanupEffects = this.host.cancelActions(
            new Set([view.execution_id]),
            "Skill execution failed",
          );
          await live.cleanupEffects;
          await Promise.all(
            [...live.children].map((child) =>
              this.closeTree(child, "Parent skill failed"),
            ),
          );
          view.status = live.cleanupFailure ? "unknown" : "failed";
          view.error = "Skill execution or trusted capability failed";
          if (!live.cleanupFailure)
            view.result = {
              status: "failed",
              summary: view.error,
              result: null,
            };
        }
      } finally {
        try {
          await live.cleanupEffects;
          await Promise.all([...live.children].map((child) => child.done));
        } catch {
          live.abortStatus = "unknown";
        }
        if (live.controller.signal.aborted && !terminal.has(view.status))
          view.status = live.abortStatus;
        view.ended_at = new Date().toISOString();
        clearTimeout(live.timer);
        this.save(
          live,
          "skill.closed",
          outcome?.summary ?? view.error ?? "Skill execution closed",
        );
        this.live.delete(view.execution_id);
        parent?.children.delete(live);
        this.host.changed(live.root === live, view);
        if (live.cleanupFailure) throw live.cleanupFailure;
      }
    });
    void live.done.catch(() => this.host.unsafe());
    this.host.changed(false);
    return live;
  }
  private remaining(live: Live): SkillLimits {
    return {
      ...live.root.view.limits,
      duration_ms: Math.max(
        1,
        Date.parse(live.root.view.deadline_at) - Date.now(),
      ),
      max_actions: Math.max(
        1,
        live.root.view.limits.max_actions - live.root.view.actions,
      ),
      max_calls: Math.max(
        1,
        live.root.view.limits.max_calls - live.root.view.calls,
      ),
      max_depth: Math.max(1, live.root.view.limits.max_depth - live.depth + 1),
    };
  }
  private authorize(live: Live): void {
    if (
      live.controller.signal.aborted ||
      live.root.controller.signal.aborted ||
      terminal.has(live.view.status) ||
      Date.now() >= Date.parse(live.root.view.deadline_at)
    )
      throw new Error("Skill authority revoked");
    this.host.authorize(live.view.run_id, live.view.epoch, live.view.session_id!, live.lifeId);
  }
  private consume(live: Live, action: boolean): void {
    const root = live.root;
    if (
      root.view.calls >= root.view.limits.max_calls ||
      (action && root.view.actions >= root.view.limits.max_actions)
    ) {
      this.revoke(root, "Aggregate root skill budget exhausted");
      void this.closeTree(root, "Aggregate root skill budget exhausted").catch(
        () => this.host.changed(true),
      );
      throw new Error("Aggregate root skill budget exhausted");
    }
    root.view.calls++;
    if (action) root.view.actions++;
    this.save(root, "skill.budget", "Root shared capability budget consumed", {
      execution_id: live.view.execution_id,
      action,
    });
    if (live !== root) {
      live.view.calls++;
      if (action) live.view.actions++;
      this.save(live, "skill.capability", "Child capability budget consumed");
    }
  }
  private async capability(
    live: Live,
    skill: SkillView,
    raw: SkillCapabilityRequest,
  ): Promise<Json> {
    this.authorize(live);
    if (live.pending)
      throw new Error("Only one host capability may be outstanding");
    const request = skillCapabilitySchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024)
      throw new Error("Capability request exceeds byte bound");
    this.consume(live, request.kind === "action" || request.kind === "respawn");
    const callId = randomUUID();
    const started = performance.now();
    const context = { call_id: callId, capability: request.kind, life_id: live.lifeId };
    this.trace.record(live.view, "capability_request", request as unknown as Json, context);
    live.pending = true;
    let resultRecorded = false;
    try {
      let result: Json;
      switch (request.kind) {
        case "observe":
          {
            const observation = await this.host.observe();
            result = observation as unknown as Json;
            this.trace.observe(live.view, observation, context);
          }
          break;
        case "recipes":
          result = await this.host.recipes(request.item);
          break;
        case "respawn":
        case "action": {
          const respawning = request.kind === "respawn" || request.action.kind === "respawn";
          if (respawning && live !== live.root)
            throw new Error("Only an explicitly selected recovery root can respawn");
          const action = await this.host.action(
            live.view,
            request.kind === "respawn" ? { kind: "respawn" } : request.action,
            live.controller.signal,
            callId,
          );
          if (respawning && action.status === "succeeded") {
            if (live.controller.signal.aborted)
              throw new Error("Recovery authority revoked");
            live.lifeId = await this.host.recover(live.view, action);
          }
          result = action as unknown as Json;
          this.trace.record(live.view, "capability_result", { ok: true, result }, { ...context, life_id: live.lifeId });
          resultRecorded = true;
          if (
            action.status === "unknown" ||
            action.status === "cancelled" ||
            action.requires_reconnect
          ) {
            live.root.abortStatus =
              action.status === "unknown" || action.requires_reconnect
                ? "unknown"
                : "cancelled";
            this.revoke(
              live.root,
              "Leaf action was interrupted or became uncertain",
            );
            void this.closeTree(
              live.root,
              "Leaf action lost effect authority",
            ).catch(() => this.host.changed(true));
            throw new Error("Leaf action lost effect authority");
          }
          break;
        }
        case "progress":
          this.save(live, "skill.progress", request.summary, request.details);
          this.trace.record(live.view, "intent", {
            author: "model",
            summary: request.summary,
            details: request.details,
            gameplay_success_proof: false,
          }, context);
          result = null;
          break;
        case "call": {
          if (
            !skill.dependencies.some(
              (ref) =>
                ref.skill_id === request.skill.skill_id &&
                ref.version === request.skill.version,
            )
          )
            throw new Error("Undeclared exact dependency");
          if (live.depth >= live.root.view.limits.max_depth)
            throw new Error("Root composition depth exhausted");
          const dependency = this.store.skill(live.view.run_id, request.skill);
          if (dependency.state !== "validated")
            throw new Error("Dependency no longer validated");
          const admitted = this.store.admitSkill(
            live.view.run_id,
            {
              ...request.skill,
              start_key: `child_${randomUUID()}`,
              epoch: live.view.epoch,
              session_id: live.view.session_id!,
              life_id: live.lifeId,
              args: request.args,
              limits: live.root.view.limits,
            },
            {
              parent_execution_id: live.view.execution_id,
              root_execution_id: live.root.view.execution_id,
            },
          );
          const child = this.dispatch(admitted.view, dependency, live);
          await child.done;
          this.authorize(live);
          result = child.view.result as unknown as Json;
          if (
            !result ||
            !["succeeded", "blocked", "failed"].includes(child.view.status)
          )
            throw new Error("Dependency did not settle safely");
          break;
        }
      }
      if (!resultRecorded) {
        this.trace.record(live.view, "capability_result", { ok: true, result }, { ...context, life_id: live.lifeId });
        resultRecorded = true;
      }
      this.authorize(live);
      if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024)
        throw new Error("Capability result exceeds byte bound");
      return result;
    } catch (error) {
      if (!resultRecorded)
        this.trace.record(live.view, "capability_result", { ok: false, result: null }, { ...context, life_id: live.lifeId });
      throw error;
    } finally {
      this.trace.span(live.view, "capability_wait", started, performance.now(), { ...context, life_id: live.lifeId });
      live.pending = false;
    }
  }
  private revoke(live: Live, reason: string): void {
    if (!live.controller.signal.aborted && !terminal.has(live.view.status)) {
      live.view.status = "cancel_requested";
      live.view.error = reason;
      this.save(live, "skill.cancel_requested", reason);
      live.controller.abort();
    }
    for (const child of live.children) this.revoke(child, reason);
  }
  private closeTree(live: Live, reason: string): Promise<void> {
    if (live.closing) return live.closing;
    this.revoke(live, reason);
    const ids = new Set<string>();
    const collect = (node: Live): void => {
      ids.add(node.view.execution_id);
      for (const child of node.children) collect(child);
    };
    collect(live);
    live.cleanupEffects = this.host.cancelActions(ids, reason);
    live.closing = (async () => {
      const settlements = await Promise.allSettled([
        live.cleanupEffects,
        ...[...live.children].map((child) => this.closeTree(child, reason)),
        live.done,
      ]);
      for (const settlement of settlements)
        if (settlement.status === "rejected") throw settlement.reason;
    })();
    return live.closing;
  }
}
