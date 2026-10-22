import { randomUUID } from "node:crypto";
import type { Json, Observation } from "../shared/contracts.ts";
import type { PauseCategory, TraceContext, TraceKind } from "../shared/execution-evidence.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import type { Store } from "./store.ts";

const processId = randomUUID();
/** Payloads must be authorized public data. Branches and intent never prove success. */
export class ExecutionTrace {
  constructor(private readonly store: Store) {}
  record(execution: SkillExecutionView, kind: TraceKind, payload: Json, context: TraceContext & { session_id?: string | null; life_id?: number | null } = {}) {
    const skill = this.store.skill(execution.run_id, execution);
    return this.store.recordTrace({
      run_id: execution.run_id, execution_id: execution.execution_id,
      root_execution_id: execution.root_execution_id, parent_execution_id: execution.parent_execution_id,
      skill_id: skill.skill_id, version: skill.version, hash: skill.hash,
      session_id: context.session_id === undefined ? execution.session_id ?? null : context.session_id,
      life_id: context.life_id === undefined ? execution.life_id ?? null : context.life_id,
      call_id: context.call_id ?? null, action_id: context.action_id ?? null,
      observation_seq: context.observation_seq ?? null, capability: context.capability ?? null,
      event_seq: context.event_seq ?? null, kind, payload,
    });
  }
  observe(execution: SkillExecutionView, observation: Observation, context: TraceContext = {}) {
    return this.record(execution, "observation", observation as unknown as Json, { ...context, observation_seq: observation.observation_seq, session_id: observation.session_id, life_id: observation.life.life_id });
  }
  span(execution: SkillExecutionView, category: PauseCategory, startedMono: number, endedMono: number, context: TraceContext & { session_id?: string | null; life_id?: number | null } = {}) {
    if (!Number.isFinite(startedMono) || !Number.isFinite(endedMono) || endedMono < startedMono) throw new Error("Span requires ordered same-process monotonic endpoints");
    return this.record(execution, "span", { category, process_id: processId, started_monotonic_ms: startedMono, ended_monotonic_ms: endedMono, duration_ms: endedMono - startedMono, clock: "same_process_monotonic", overlapping_categories_are_not_additive: true }, context);
  }
}
