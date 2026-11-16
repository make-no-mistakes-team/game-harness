import { z } from "zod";
import type { StoredRun } from "./store.ts";
import type { StrategicStore } from "./cognition-ports.ts";

export interface MainDecisionWindowOptions { maxRequests: number }
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mainDecisionWindowStateSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("open"), admitted_requests: count, max_requests: count.min(1) }).strict(),
  z.object({ outcome: z.literal("decision_window_closed"), reason: z.literal("request_limit"),
    admitted_requests: count, max_requests: count.min(1) }).strict(),
]);
export type MainDecisionWindowState = z.infer<typeof mainDecisionWindowStateSchema>;
export type ClosedMainDecisionWindow = Extract<MainDecisionWindowState, { outcome: "decision_window_closed" }>;

export function validateMainDecisionWindow(options: MainDecisionWindowOptions | undefined): void {
  if (options !== undefined && (!options || !Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0))
    throw new Error("Main decision window requires a positive safe-integer maxRequests");
}

/** Host admission counts, independent of usage purposes, SDK retries and turn lifetimes. */
export class MainDecisionWindow {
  readonly maxRequests: number;
  private runId: string | null = null;
  private readonly requests = new Set<string>();
  constructor(options: MainDecisionWindowOptions) {
    validateMainDecisionWindow(options);
    this.maxRequests = options.maxRequests;
  }
  state(runId: string): MainDecisionWindowState {
    if (this.runId !== runId) { this.runId = runId; this.requests.clear(); }
    const counts = { admitted_requests: this.requests.size, max_requests: this.maxRequests };
    return this.requests.size >= this.maxRequests
      ? { outcome: "decision_window_closed", reason: "request_limit", ...counts }
      : { outcome: "open", ...counts };
  }
  reserve(runId: string, requestId: string, reserve: () => void): void {
    // The planner queries state before reservation. Bypassing that normal no-dispatch
    // result is an ownership violation, not an expected metadata-batch exception.
    if (this.state(runId).outcome !== "open" || this.requests.has(requestId))
      throw new Error("Main request reservation has no open unique decision-window admission");
    reserve();
    this.requests.add(requestId);
  }
}

/** Same original scoped-executive predicate for time expiry and request-window closure. */
export function retainedFiniteExecutive(store: Pick<StrategicStore, "latestRootExecution">,
  run: StoredRun, generation: number, programPending: boolean) {
  const root = store.latestRootExecution(run.run_id);
  return programPending && root?.entry === "step" && root.session &&
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
    Date.parse(root.deadline_at) > Date.now() ? root : null;
}
