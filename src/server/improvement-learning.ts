import type { Json } from "../shared/contracts.ts";
import type { ImprovementOpportunity, ProgramVersionEvidence } from "../shared/execution-evidence.ts";
import { IMPROVEMENT_RESOLUTION_HELP } from "../shared/execution-evidence.ts";
import type { Store } from "./store.ts";
import { projectionBatchSchema, type HistoryQueryClient, type HistoryQueryOptions } from "./history-protocol.ts";
import type { ProjectionCheckpoint } from "./history-projection.ts";
import { exactVersion } from "./program-feedback.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import type { ProjectionWriterClient } from "./projection-writer-client.ts";

export interface ImprovementResolution {
  /** Candidate-experiment decision, not an efficacy, adoption, or promotion claim. */
  decision: "revise" | "keep" | "insufficient_evidence";
  reason: string;
  /** Required exact reference only for revise; otherwise null. */
  revision: ProgramVersionEvidence | null;
  event_seqs: number[];
}
/** Reports actual failures/outcomes; the model alone supplies the change and rationale. */
export class ImprovementLearning {
  private readonly preparing = new Map<string, { start(): void; cancel(): void }[]>();
  private readonly admissions = new Map<string, {
    epoch: number;
    suspended: boolean;
    active: Set<Promise<void>>;
  }>();
  private closed = false;

  readonly ready: Promise<void>;
  constructor(private readonly store: Store, private readonly reader: HistoryQueryClient,
    private readonly writer?: ProjectionWriterClient) {
    this.ready = writer?.ready ?? Promise.resolve();
  }

  /** Readonly work runs in bounded child pages; only current, exact candidates reach the writer. */
  async prepareFeedback(runId: string, options: HistoryQueryOptions): Promise<void> {
    this.assertPreparationActive(options);
    let admission = this.admissions.get(runId);
    if (!admission) {
      admission = { epoch: 0, suspended: false, active: new Set() };
      this.admissions.set(runId, admission);
    }
    const epoch = admission.epoch;
    const assertActive = () => {
      this.assertPreparationActive(options);
      if (this.closed || admission.suspended || admission.epoch !== epoch)
        throw new RuntimeFault("history_cancelled", "History preparation admission is closed");
    };
    assertActive();
    // Capture before waiting: a queued invocation never chases mutations made
    // after its caller's original request.
    const desiredThrough = this.store.historySourceHighwater(runId);
    const completion = Promise.withResolvers<void>();
    admission.active.add(completion.promise);
    let acquired = false;
    try {
      const waiting = this.acquirePreparation(runId, options);
      if (waiting) await waiting;
      acquired = true;
      assertActive();
      while (!this.store.advanceHistorySourceBootstrap(128).complete) {
        const turn = Promise.withResolvers<void>();
        setTimeout(turn.resolve, 0);
        await turn.promise;
        assertActive();
      }
      assertActive();
      let checkpoint = this.writer
        ? await this.writer.beginHistoryProjection(runId, desiredThrough, options)
        : this.store.beginHistoryProjection(runId, desiredThrough);
      while (true) {
        assertActive();
        const response = await this.reader.query({
          kind: "projection_batch", run_id: runId, checkpoint,
        }, options);
        assertActive();
        const parsed = projectionBatchSchema.safeParse(response);
        if (!parsed.success)
          throw new RuntimeFault("history_protocol", "Invalid bounded history projection batch");
        const batch = parsed.data;
        if (!this.sameCheckpoint(batch.before, checkpoint) ||
          (batch.has_more && batch.after.revision <= checkpoint.revision))
          throw new RuntimeFault("history_protocol", "Invalid history projection checkpoint or progress");
        // Candidate source acceptance and derived checkpoint publication retain
        // their separate durable commits; no canonical lock spans the worker.
        assertActive();
        if (this.writer) await this.writer.commitHistoryProjectionBatch(runId, batch, options);
        else this.store.commitHistoryProjectionBatch(runId, batch);
        checkpoint = batch.after;
        if (!batch.has_more) {
          if (checkpoint.source_through >= desiredThrough) return;
          const next = this.writer
            ? await this.writer.beginHistoryProjection(runId, desiredThrough, options)
            : this.store.beginHistoryProjection(runId, desiredThrough);
          if (this.sameCheckpoint(next, checkpoint))
            throw new RuntimeFault("history_protocol", "History projection did not reach its fixed source frontier");
          checkpoint = next;
        }
      }
    } finally {
      if (acquired) this.releasePreparation(runId);
      admission.active.delete(completion.promise);
      completion.resolve();
    }
  }

  /** Revoke queued old-turn admissions before joining any asynchronous owner. */
  suspendRun(runId: string): Promise<void> {
    let admission = this.admissions.get(runId);
    if (!admission) {
      admission = { epoch: 0, suspended: false, active: new Set() };
      this.admissions.set(runId, admission);
    }
    admission.suspended = true;
    admission.epoch++;
    for (const waiter of [...(this.preparing.get(runId) ?? [])]) waiter.cancel();
    const active = [...admission.active];
    const queryDrain = this.reader.cancelRun(runId);
    return this.joinPreparations([queryDrain, this.writer?.cancelRun(runId) ?? Promise.resolve(), ...active]);
  }

  resumeRun(runId: string): void {
    if (!this.closed) {
      const admission = this.admissions.get(runId);
      if (admission) admission.suspended = false;
    }
  }

  close(): Promise<void> {
    this.closed = true;
    const drains = [...this.admissions.keys()].map(runId => this.suspendRun(runId));
    return this.joinPreparations([this.reader.close(), this.writer?.close() ?? Promise.resolve(), ...drains]);
  }

  private async joinPreparations(tasks: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(tasks);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "History preparation owners did not drain");
  }

  private sameCheckpoint(left: ProjectionCheckpoint, right: ProjectionCheckpoint): boolean {
    return left.schema_version === right.schema_version &&
      left.revision === right.revision &&
      left.generation === right.generation &&
      left.published_revision === right.published_revision &&
      left.source_through === right.source_through &&
      left.target_through === right.target_through &&
      left.phase === right.phase &&
      left.metric_change_seq === right.metric_change_seq &&
      left.published_metric_change_seq === right.published_metric_change_seq &&
      this.sameJobValue(left.job, right.job);
  }

  /** Jobs are byte-bounded by the checkpoint contract; object key order is not data. */
  private sameJobValue(left: Json, right: Json): boolean {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
      return false;
    if (Array.isArray(left)) {
      if (!Array.isArray(right) || left.length !== right.length) return false;
      return left.every((value, index) => this.sameJobValue(value, right[index]!));
    }
    if (Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key =>
      Object.hasOwn(right, key) && this.sameJobValue(left[key]!, right[key]!));
  }

  private acquirePreparation(runId: string, options: HistoryQueryOptions): Promise<void> | void {
    const queue = this.preparing.get(runId);
    if (!queue) {
      this.preparing.set(runId, []);
      return;
    }
    if (queue.length >= 8)
      throw new RuntimeFault("history_queue_full", "Improvement preparation queue is full for this run");

    // Each bounded FIFO waiter owns only its signal and original absolute
    // deadline. Activation starts a new pass, never a shared result or retry.
    const completion = Promise.withResolvers<void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      completion.reject(error);
    };
    const abort = () => fail(new RuntimeFault("history_cancelled", "Improvement preparation was cancelled"));
    const armDeadline = () => {
      timer = setTimeout(() => {
        try {
          this.assertPreparationActive(options);
          armDeadline();
        } catch (error) {
          fail(error);
        }
      }, Math.max(1, Math.min(2_147_483_647, options.deadlineHostMs - performance.now())));
    };
    const waiter = {
      cancel: abort,
      start: () => {
        cleanup();
        completion.resolve();
      },
    };
    queue.push(waiter);
    options.signal?.addEventListener("abort", abort, { once: true });
    armDeadline();
    if (options.signal?.aborted) abort();
    return completion.promise;
  }

  private releasePreparation(runId: string): void {
    const queue = this.preparing.get(runId)!;
    const next = queue.shift();
    if (next) next.start();
    else this.preparing.delete(runId);
  }

  private assertPreparationActive(options: HistoryQueryOptions): void {
    if (options.signal?.aborted) throw new RuntimeFault("history_cancelled", "Improvement preparation was cancelled");
    if (!Number.isFinite(options.deadlineHostMs) || performance.now() >= options.deadlineHostMs)
      throw new RuntimeFault("history_deadline", "Improvement preparation deadline exceeded");
  }

  async resolve(runId: string, id: string, input: ImprovementResolution,
    options: HistoryQueryOptions = { deadlineHostMs: performance.now() + 10_000 }): Promise<ImprovementOpportunity> {
    this.assertPreparationActive(options);
    if (this.closed || this.admissions.get(runId)?.suspended)
      throw new RuntimeFault("history_cancelled", "Improvement resolution admission is closed");
    const persist = (resolution: NonNullable<ImprovementOpportunity["resolution"]>) => this.writer
      ? this.writer.resolveOpportunity(runId, id, resolution, options)
      : this.store.resolveOpportunity(runId, id, resolution);
    if (!["revise", "keep", "insufficient_evidence"].includes(input.decision) || !input.reason.trim() || input.reason.length > 4000 || input.event_seqs.length > 64) throw new Error("Invalid bounded improvement resolution");
    if (input.decision === "revise" && input.revision === null)
      throw new RuntimeFault("invalid_request", `Revise requires an exact revision reference. ${IMPROVEMENT_RESOLUTION_HELP}`);
    if (input.decision !== "revise" && input.revision !== null)
      throw new RuntimeFault("invalid_request", `Keep and insufficient_evidence require revision:null. To link the exact revision of a chosen or performed candidate experiment, choose revise. ${IMPROVEMENT_RESOLUTION_HELP}`);
    const opportunity = this.store.opportunity(runId, id);
    if (!opportunity) throw new Error("Improvement opportunity not found");
    if (opportunity.resolution) {
      const previous = opportunity.resolution;
      const sameRevision = previous.revision === null ? input.revision === null : input.revision !== null &&
        previous.revision.run_id === input.revision.run_id && previous.revision.skill_id === input.revision.skill_id &&
        previous.revision.version === input.revision.version && previous.revision.hash === input.revision.hash;
      if (previous.decision !== input.decision || previous.reason !== input.reason ||
        !sameRevision ||
        JSON.stringify(previous.event_seqs) !== JSON.stringify([...new Set(input.event_seqs)]))
        throw new RuntimeFault("conflict", "This improvement opportunity already has an immutable resolution; identical retries return that resolution.");
      return persist(previous);
    }
    exactVersion(this.store, opportunity.version);
    for (const seq of input.event_seqs) {
      if (!Number.isSafeInteger(seq) || seq < 1 || this.store.eventsAfter(runId, seq - 1, 1)[0]?.event_seq !== seq) throw new Error("Resolution evidence must reference exact events in this run");
    }
    let measured = false;
    if (input.revision !== null) {
      const revision = exactVersion(this.store, input.revision);
      const parent = exactVersion(this.store, opportunity.version);
      const sourceRun = this.store.getRun(opportunity.version.run_id), revisionRun = this.store.getRun(input.revision.run_id);
      if (!sourceRun || !revisionRun || sourceRun.model_id !== revisionRun.model_id || revision.skill_id !== parent.skill_id || revision.parent_version !== parent.version) throw new Error("Revision must name a same-model direct child version");
      measured = this.store.hasMeasuredSkillExecution(input.revision.run_id, revision);
    }
    return persist({ ...input, event_seqs: [...new Set(input.event_seqs)], measured, at: new Date().toISOString() });
  }
}
