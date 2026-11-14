import type { Agent } from "@oh-my-pi/pi-agent-core/agent";
import type { AgentTool, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core/types";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import type { Json, PolicyView, UsagePurpose } from "../shared/contracts.ts";
import type { ToolRole } from "../shared/tool-policy.ts";
import type { PlanProjection, PlanRejectReason } from "../shared/planning.ts";
import type { StoreReadQueries, StoreReadLocation } from "./store-read.ts";
import type { StoredRun } from "./store.ts";
import type { ProgramWorkspaceReadStore } from "./program-workspace.ts";

/** Only readonly source queries and ordered metadata belong to cognition. */
export type StrategicStore = ProgramWorkspaceReadStore & Pick<StoreReadQueries,
  "eventsAfter" | "getAction" | "latestEvent" | "latestRootExecution" | "skill" | "skillExecution" | "skillExecutions"> & {
  readLocation(): StoreReadLocation;
  event(runId: string | null, type: string, summary: string, details?: Json): void;
  /** Genuine embedded Store ownership only; readonly cognition never implements it. */
  saveRun?(run: StoredRun): void;
};
export interface StrategicAgentFactory {
  createAgent(options: { modelId: string; systemPrompt: string[]; tools: AgentTool[] }): Promise<Agent>;
  releaseAgent(agent: Agent): Promise<void>;
}
export interface StrategicSpeculation {
  projection(): PlanProjection | null;
  remainingMs(): number;
  pendingActivation(): Promise<PlanProjection | null>;
  begin(): PlanProjection | null | Promise<PlanProjection | null>;
  requestCall(): boolean | Promise<boolean>;
  finish(id: string): void;
  invalidate(reason: PlanRejectReason): void;
  assertToolAuthority(tool?: string): void;
  authority(): () => void;
}
export interface CognitionRequestIdentity {
  turn_id: string;
  request_id: string;
  generation: number;
  role: ToolRole;
  deadline_os_ns: string;
  phase: StoredRun["status"];
  root_execution_id: string | null;
  source_hash: string | null;
  authoring_deadline_at: number | null;
  pending_decision: boolean;
  plan_id: string | null;
}
export interface CognitionResponseIdentity {
  request_id: string;
  successful: boolean;
  calls: { id: string; name: string; arguments: unknown }[];
}
export interface CognitionEvidenceEvent {
  run_id: string;
  kind: "sdk_context_before_request_assembly_not_wire_payload" |
    "final_sdk_visible_context_not_wire_payload" | "visible_agent_event" | "coverage";
  body: Json;
}
/** Exactly the existing strategic prompt's policy scalars, never policy source. */
export type StrategicPolicy = Pick<PolicyView, "version" | "backend" | "name" | "state" | "priority" | "effects" | "last_error">;
/** Optional only for embedded owners. Default playing installs every hook. */
export interface StrategicOwnership {
  synchronize?(): Promise<void>;
  beginTurn?(id: string, deadlineOsNs: bigint): Promise<void>;
  endTurn?(id: string): Promise<void>;
  dispatch?(identity: CognitionRequestIdentity, request: { model: Model; context: Context }): Promise<void>;
  evidence?(kind: "sdk_context_before_request_assembly_not_wire_payload" | "visible_agent_event", body: unknown): void;
  response?(response: CognitionResponseIdentity): void;
  beforeTool?(context: BeforeToolCallContext): Promise<void>;
  flush?(): Promise<void>;
  call?(run: StoredRun, purpose: UsagePurpose, requestId: string): void;
  classify?(run: StoredRun, previous: UsagePurpose, purpose: UsagePurpose, requestId: string): void;
  usage?(run: StoredRun, purpose: UsagePurpose, usage: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null }, requestId: string): void;
  timing?: { clockId: string; now(): number };
}
