import { createHash } from "node:crypto";
import type { Json } from "../shared/contracts.ts";
import { ResidentCleanupError, residentAnalysisInputSchema, residentAnalysisOutputSchema, residentSourceIdentitySchema,
  type ResidentAnalysisResult, type ResidentAnalysisSource, type ResidentClock, type ResidentControllerOptions,
  type ResidentSnapshot } from "../shared/resident.ts";

/** One effect-free job alongside either controller; closure remains part of its owner drain. */
export class ResidentAnalysisLane {
  private task: Promise<ResidentAnalysisResult> | null = null;
  private abort: AbortController | null = null;
  private cleanupFailure: ResidentCleanupError | null = null;

  constructor(private readonly options: ResidentControllerOptions, private readonly data: ResidentSnapshot,
    private readonly clock: ResidentClock, private readonly current: () => boolean,
    private readonly stopped: () => boolean,
    private readonly fault: (status: "stopped" | "failed" | "unknown", reason: string) => void,
    private readonly changed: () => void) {}

  analyze(source: ResidentAnalysisSource, input: Json, expectedIntentVersion: number): Promise<ResidentAnalysisResult> {
    if (!this.current() || this.data.status !== "running") return Promise.reject(new Error("Resident is not running"));
    if (expectedIntentVersion !== this.data.intent_version) return Promise.reject(new Error("Stale resident analysis intent version"));
    if (this.task) return Promise.reject(new Error("Resident analysis already running"));
    if (this.data.counters.analysis_jobs >= this.options.limits.max_analysis_jobs) return Promise.reject(new Error("Resident analysis job budget exhausted"));
    const remaining = this.options.limits.max_analysis_ms - this.data.counters.analysis_ms;
    if (remaining <= 0) return Promise.reject(new Error("Resident analysis time budget exhausted"));
    const identity = residentSourceIdentitySchema.parse({ skill_id: source.skill_id, version: source.version, hash: source.hash });
    const selectedSource = structuredClone(source);
    const detached = structuredClone(residentAnalysisInputSchema.parse(input));
    const budget = Math.min(remaining, this.options.limits.analysis_job_ms, Math.max(0, this.options.deadline_host_ms - this.clock.now()));
    if (budget <= 0) return Promise.reject(new Error("Resident deadline reached"));
    const abort = new AbortController(); this.abort = abort;
    const job = ++this.data.counters.analysis_jobs;
    const result: ResidentAnalysisResult = { job_id: `${this.options.execution_id}:analysis:${job}`, source: identity,
      controller_execution_id: this.options.execution_id, controller_source_hash: this.options.source_hash,
      controller_generation: this.data.controller_generation, input_hash: createHash("sha256").update(JSON.stringify(detached)).digest("hex"),
      input_version: expectedIntentVersion, status: "failed", output: null, elapsed_ms: 0, post_evaluation_ms: null, reason: null };
    this.data.pending.analysis = true;
    // Publish ownership before calling the service, including synchronous failures.
    const task = Promise.resolve().then(async () => {
      let reported = false, invalidReport = false, evaluationOpen = true;
      let evaluatedAt: number | null = null;
      try {
        if (!this.current() || abort.signal.aborted) {
          result.status = "cancelled"; result.reason = this.data.reason ?? "resident_not_current_or_expired";
          if (!this.stopped()) this.fault("stopped", result.reason);
          return result;
        }
        const output = await this.options.analysis(selectedSource, detached, budget, abort.signal, elapsed => {
          if (!evaluationOpen) { this.fault("failed", "resident_analysis_accounting"); return; }
          if (reported || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER ||
            this.data.counters.analysis_ms + elapsed > Number.MAX_SAFE_INTEGER) { invalidReport = true; return; }
          reported = true; evaluatedAt = this.clock.now(); result.elapsed_ms = elapsed; this.data.counters.analysis_ms += elapsed;
        });
        if (!reported || invalidReport) { invalidReport = true; throw new Error("Invalid resident analysis evaluation report"); }
        result.output = structuredClone(residentAnalysisOutputSchema.parse(output));
        if (this.stopped()) { result.status = "cancelled"; result.reason = this.data.reason ?? "resident_stopped"; }
        else if (result.elapsed_ms > budget) { result.status = "failed"; result.reason = "analysis_budget"; result.output = null; }
        else if (!this.current() || this.data.intent_version !== expectedIntentVersion) { result.status = "stale"; result.reason = "resident_analysis_version_changed"; }
        else result.status = "completed";
      } catch (error) {
        result.status = this.stopped() ? "cancelled" : "failed";
        result.reason = error instanceof Error ? error.message : String(error); result.output = null;
        if (error instanceof ResidentCleanupError) {
          this.cleanupFailure = error; this.fault("unknown", error.message);
        }
      } finally {
        evaluationOpen = false;
        if (evaluatedAt !== null) result.post_evaluation_ms = Math.max(0, this.clock.now() - evaluatedAt);
        if (invalidReport) this.fault("failed", "resident_analysis_accounting");
        this.data.pending.analysis = false; this.abort = null; this.task = null; this.changed();
      }
      return result;
    });
    this.task = task; return task;
  }

  fence(reason: string): void { this.abort?.abort(reason); }
  async drain(): Promise<void> {
    await this.task;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
}
