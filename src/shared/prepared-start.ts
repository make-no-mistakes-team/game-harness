import { z } from "zod";
import type { AdapterGoal, RunUsage } from "./contracts.ts";
import { goalSchema } from "./validation.ts";
import { taskTextSchema } from "./tasks.ts";

export const preparedStartRequestSchema = z.object({
  request_id: z.uuid(), task: taskTextSchema, goal: goalSchema,
  model_id: z.string().min(1).max(160),
}).strict();
export type PreparedStartRequest = z.infer<typeof preparedStartRequestSchema>;
export type PreparedStartPhase = "authoring" | "compiling" | "ready" | "joining" | "activating" |
  "started" | "cancelling" | "cancelled" | "failed";
export const PREPARED_START_LIMITS = Object.freeze({ duration_ms: 600000, max_requests: 24, max_tools: 48,
  max_source_versions: 64, max_source_bytes: 524288, max_analysis_jobs: 8,
  analysis_job_ms: 500, max_analysis_ms: 4000 });

/** Source preparation has no native run, player life or observation authority. */
export interface PreparedStartView {
  preparation_id: string;
  task: string;
  goal: AdapterGoal;
  model_id: string;
  phase: PreparedStartPhase;
  started_at: string;
  deadline_at: string;
  ready_at: string | null;
  run_id: string | null;
  requests_admitted: number;
  tools_used: number;
  source_versions: number;
  analysis_jobs: number;
  analysis_ms: number;
  program: { name: string; version: number } | null;
  usage: RunUsage;
  limits: typeof PREPARED_START_LIMITS;
  /** Transfer means the admitted Runtime owns the live worker, not that it was closed. */
  closure: "open" | "draining" | "closed" | "transferred" | "unknown";
  error: string | null;
}

export function preparedStartActive(view: PreparedStartView | null): boolean {
  return view !== null && (["authoring", "compiling", "ready", "joining", "activating", "cancelling"]
    .includes(view.phase) || view.closure === "unknown");
}
