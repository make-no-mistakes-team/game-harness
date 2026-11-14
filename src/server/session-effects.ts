import { randomUUID } from "node:crypto";
import type { GameAction, GameActionResult, GameBridge, Json } from "../shared/contracts.ts";
import type { ProducerSupervision } from "../shared/control.ts";
import type { ExecutiveTaskRequest } from "../shared/control-session.ts";
import type { MinecraftControllerFrame } from "../shared/minecraft.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import type { ActionArbiter } from "./action-arbiter.ts";
import type { ExecutionTrace } from "./execution-trace.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { SkillManager } from "./skills.ts";
import type { Store, StoredRun } from "./store.ts";

const ACTION_TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

/** Local physical session-effect mediation; Runtime retains lifecycle authority. */
export class SessionEffects {
  private readonly sessionChildren = new Map<string, {
    handle: number; executionId: string; deadlineHostMs: number; supervision: ProducerSupervision;
  }>();

  constructor(
    private readonly store: Store,
    private readonly game: GameBridge,
    private readonly skills: SkillManager,
    private readonly actions: ActionArbiter,
    private readonly trace: ExecutionTrace,
    private readonly run: () => Pick<StoredRun, "session_id"> | null,
  ) {}

  async sessionTask(
    execution: SkillExecutionView,
    request: ExecutiveTaskRequest,
    handle: number,
    deadline: number,
    signal: AbortSignal,
    frame: MinecraftControllerFrame,
    behaviorGeneration: number,
  ): Promise<GameActionResult> {
    if (!this.game.superviseProducer) throw new RuntimeFault("precondition_failed", "Native semantic supervision is required");
    const selection = { handle, executionId: execution.execution_id, deadlineHostMs: deadline,
      supervision: { session_id: execution.execution_id, behavior_generation: behaviorGeneration, frame_seq: frame.frame_seq } };
    if (this.sessionChildren.has(execution.execution_id)) throw new RuntimeFault("busy", "Previous session child has not retired");
    this.sessionChildren.set(execution.execution_id, selection);
    try {
      if (request.kind === "program")
        return await this.skills.runSessionChild(execution, request.program, request.args,
          Math.max(1, Math.floor(deadline - performance.now())), handle, signal);
      this.skills.consumeSessionAction(execution);
      return await this.action(execution, request.action, signal, `session_${handle}`);
    } finally {
      if (this.sessionChildren.get(execution.execution_id) === selection) this.sessionChildren.delete(execution.execution_id);
    }
  }

  async superviseSessionTask(
    execution: SkillExecutionView,
    handle: number,
    frame: MinecraftControllerFrame,
    behaviorGeneration: number,
  ): Promise<void> {
    const selection = this.sessionChildren.get(execution.execution_id);
    if (!selection || selection.handle !== handle) return; // Normal completion/continue race.
    if (performance.now() >= selection.deadlineHostMs) {
      await this.actions.cancelOwned(new Set([selection.executionId]), "Session child original deadline reached"); return;
    }
    selection.supervision = { session_id: execution.execution_id, behavior_generation: behaviorGeneration, frame_seq: frame.frame_seq };
    const active = this.actions.active;
    if (active && active.entry.stored.view.scope &&
      (active.entry.stored.view.execution_id === execution.execution_id ||
        this.store.skillExecution(execution.run_id, { execution_id: active.entry.stored.view.execution_id! })?.root_execution_id === execution.execution_id)) {
      selection.executionId = active.entry.stored.view.execution_id!;
      await this.game.superviseProducer!(selection.executionId, selection.supervision);
    }
  }

  async retireSessionTask(execution: SkillExecutionView, handle: number, reason: string): Promise<void> {
    const selection = this.sessionChildren.get(execution.execution_id);
    await this.skills.retireSessionChild(execution, handle, reason);
    await this.actions.cancelOwned(new Set([execution.execution_id, ...(selection ? [selection.executionId] : [])]), reason);
  }

  async action(
    execution: SkillExecutionView,
    action: GameAction,
    signal: AbortSignal,
    callId: string,
  ): Promise<GameActionResult> {
    if (signal.aborted)
      throw new RuntimeFault("stale_context", "Skill action authority revoked");
    const id = "skill_" + randomUUID(),
      completion = Promise.withResolvers<GameActionResult>();
    let unsubscribe = () => {};
    let settling = false;
    const check = () => {
      const view = this.store.getAction(execution.run_id, id)?.view;
      if (view && ACTION_TERMINAL.has(view.status) && !settling) {
        settling = true;
        unsubscribe();
        const root = this.store.skillExecution(execution.run_id, { execution_id: execution.root_execution_id });
        if ((view.result?.status === "unknown" && !(root?.entry === "step" && root.session)) || view.result?.requires_reconnect)
          this.skills.fence("Leaf outcome is unknown; interrupted execution lineage retained", execution.execution_id);
        if (view.result) completion.resolve(view.result);
        else
          completion.reject(
            new RuntimeFault("unknown_effect", "Skill action has no confirmed result"),
          );
      }
    };
    unsubscribe = this.store.subscribe((event) => {
      if (event.run_id === execution.run_id && event.type.startsWith("action."))
        check();
    });
    try {
      const sessionChild = this.sessionChildren.get(execution.root_execution_id);
      if (sessionChild) sessionChild.executionId = execution.execution_id;
      this.actions.admit(
        id,
        action,
        0,
        sessionChild ? Math.max(1, sessionChild.deadlineHostMs - performance.now()) : undefined,
        null,
        execution.execution_id,
        sessionChild?.supervision,
      );
      this.trace.record(execution, "capability_request", { kind: "admitted_action", action: action as unknown as Json }, {
        call_id: callId, action_id: id, capability: action.kind === "respawn" ? "respawn" : "action",
        session_id: this.run()!.session_id, life_id: this.store.getAction(execution.run_id, id)!.view.life_id,
      });
      check();
      const result = await completion.promise;
      const active = this.actions.active;
      if (active?.entry.stored.view.action_id === id)
        await this.actions.awaitRetirement(active);
      this.trace.record(execution, "capability_result", result as unknown as Json, {
        call_id: callId, action_id: id, capability: action.kind === "respawn" ? "respawn" : "action",
        session_id: this.run()!.session_id, life_id: this.store.getAction(execution.run_id, id)!.view.life_id,
      });
      return result;
    } finally {
      unsubscribe();
    }
  }
}
