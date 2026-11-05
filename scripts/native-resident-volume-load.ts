import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type {
  ActionView,
  GameAction,
  Json,
  RuntimeAdapter,
} from "../src/shared/contracts.ts";
import type { ObservationV3 } from "../src/shared/observations.ts";
import { minecraftObservationV3Schema } from "../src/shared/minecraft.ts";
import { DEFAULT_RESIDENT_LIMITS } from "../src/shared/resident.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import type { SkillSpec, SkillView } from "../src/shared/programs.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import type { ImprovementFeedbackCursor } from "../src/shared/execution-evidence.ts";
import type { Store, StoredRun } from "../src/server/store.ts";
import { observationEvidence } from "../src/server/adapter-evidence.ts";
import { emptyRunUsage } from "../src/server/usage.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import type {
  HistoryQuery,
  HistoryQueryOptions,
  HistoryResult,
} from "../src/server/history-protocol.ts";
import type { P13Volume } from "../src/evaluation/resident-volume.ts";

export interface ResidentVolumeLoadOptions {
  store: Store;
  run: StoredRun;
  adapter: RuntimeAdapter;
  observation: ObservationV3;
  validated: SkillSpec & { validation: SkillView["validation"] };
  actions: P13Volume;
  deadlineHostMs: number;
  signal: AbortSignal;
  note(kind: string, details: Record<string, Json>): void;
  assertCurrent(): void;
}
export interface ResidentVolumeMeasurementOptions {
  measurementStart: number;
  measurementEnd: number;
  deadlineHostMs: number;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface ResidentVolumeLoad {
  runMeasurement(options: ResidentVolumeMeasurementOptions): Promise<void>;
  close(): Promise<void>;
  snapshot(): Record<string, Json>;
}
interface WriterSpanTotals {
  span_kind: "call_to_return_host_blocking" | "call_to_settlement";
  calls: number;
  failures: number;
  total_ms: number;
  max_ms: number;
  max_started_host_ms: number | null;
  max_ended_host_ms: number | null;
}
interface WriterMethodTiming {
  scope: "synthetic_run" | "shared_store_bootstrap";
  calls: number;
  failures: number;
  synchronous: WriterSpanTotals;
  asynchronous: WriterSpanTotals;
}
const LATE_OFFSETS = [20_000, 40_000, 60_000, 80_000, 100_000] as const;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const asJson = (value: unknown): Json => jsonSchema.parse(value);
function bucket(limit: number) {
  const values: Json[] = [];
  let omitted = 0;
  return {
    add(value: unknown) {
      if (values.length < limit) values.push(asJson(value));
      else omitted++;
    },
    snapshot: () => ({ samples: values.slice(), omitted }),
  };
}
/** Fixed-size proc read, with its actual file descriptor owned through close. Missing RSS is unknown. */
async function readerRss(
  pid: number | null,
): Promise<{ bytes: number | null; reason: string | null }> {
  if (pid === null) return { bytes: null, reason: "reader_not_started" };
  try {
    const file = await open(`/proc/${pid}/status`, "r");
    try {
      const bytes = Buffer.alloc(8192);
      const result = await file.read(bytes, 0, bytes.length, 0);
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(
        bytes.toString("utf8", 0, result.bytesRead),
      );
      return match
        ? { bytes: Number(match[1]) * 1024, reason: null }
        : { bytes: null, reason: "rss_unavailable_or_truncated" };
    } finally {
      await file.close();
    }
  } catch (error) {
    return { bytes: null, reason: message(error) };
  }
}

/** One finite synthetic corpus, not a playing controller or an automatic projection owner. */
export async function prepareResidentVolumeLoad(
  options: ResidentVolumeLoadOptions,
): Promise<ResidentVolumeLoad> {
  const { store, adapter } = options;
  const preparationStart = performance.now();
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      options.signal.reason ?? new Error("P13 volume preparation cancelled"),
    );
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const reader = new HistoryReader(store.readLocation());
  const learning = new ImprovementLearning(store, reader);
  const reads = bucket(64),
    memory = bucket(128),
    writerSamples = bucket(64),
    queueSamples = bucket(64);
  const errors = bucket(16),
    stages = bucket(16);
  const writerTotals: Record<string, WriterMethodTiming> = {};
  let queueMax = 0,
    activeMax = 0,
    querySubmitted = 0,
    querySettled = 0,
    queryFailures = 0;
  let readerStartedNoted = false;
  let measurement: Promise<void> | null = null,
    closing: Promise<void> | null = null;
  let closed = false,
    learningClosed = false,
    tasksJoined = false,
    closedAt: number | null = null;
  let prepared = false,
    seeded = 0,
    rawCount = 0,
    preparationEnd: number | null = null;
  let initialGenerationAvailable: boolean | null = null;
  let firstAction: ActionView | null = null;
  let executionId: string | null = null,
    sourceHash: string | null = null,
    rawThrough = 0;
  let measurementWindowStart: number | null = null,
    measurementWindowDeadline: number | null = null,
    measurementStarted: number | null = null,
    measurementSettled: number | null = null;
  let finalStatus: Json = null;
  let semanticCheck: Json = { disposition: "not_run" };
  const runId = randomUUID();
  const invocations = [0, ...LATE_OFFSETS].map((offset) => ({
    offset_ms: offset,
    disposition: "not_submitted",
    submitted_host_ms: null as number | null,
    settled_host_ms: null as number | null,
    source_target: null as number | null,
    error: null as string | null,
  }));
  const readSlots = Array.from({ length: 60 }, (_, index) => ({
    offset_ms: index * 2000,
    disposition: "not_run",
  }));
  const memorySlots = Array.from({ length: 120 }, (_, index) => ({
    offset_ms: index * 1000,
    disposition: "not_run",
  }));
  const restores: (() => void)[] = [];
  function fail(error: unknown) {
    errors.add({ at_host_ms: performance.now(), error: message(error) });
    controller.abort(error);
  }
  function current(deadline: number, assertCurrent: () => void) {
    assertCurrent();
    if (controller.signal.aborted)
      throw controller.signal.reason ?? new Error("P13 volume cancelled");
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("P13 volume original deadline expired");
  }
  function queue() {
    const snapshot = reader.snapshot();
    queueMax = Math.max(queueMax, snapshot.queued);
    activeMax = Math.max(activeMax, Number(snapshot.active));
    queueSamples.add({ at_host_ms: performance.now(), ...snapshot });
    const child = snapshot.child;
    if (
      !readerStartedNoted &&
      child &&
      child.pid !== null &&
      child.closedHostMs === null
    ) {
      readerStartedNoted = true;
      try {
        options.note("p13_volume_reader_started", {
          reader_owner: asJson(snapshot),
        });
      } catch (error) {
        fail(error);
      }
    }
  }
  const originalQuery = reader.query;
  Object.defineProperty(reader, "query", {
    configurable: true,
    writable: true,
    value: function <Q extends HistoryQuery>(
      query: Q,
      queryOptions: HistoryQueryOptions,
    ): Promise<HistoryResult<Q>> {
      querySubmitted++;
      const pending = originalQuery.call(
        reader,
        query,
        queryOptions,
      ) as Promise<HistoryResult<Q>>;
      queue();
      return pending.then(
        (value) => {
          querySettled++;
          queue();
          return value;
        },
        (error) => {
          querySettled++;
          queryFailures++;
          queue();
          throw error;
        },
      );
    },
  });
  restores.push(() => {
    Reflect.deleteProperty(reader, "query");
  });
  for (const method of [
    "saveRun",
    "registerSkill",
    "admitSkill",
    "updateSkillExecution",
    "admitAction",
    "saveAction",
    "event",
    "advanceHistorySourceBootstrap",
    "beginHistoryProjection",
    "commitHistoryProjectionBatch",
  ] as const) {
    const original = store[method];
    const descriptor = Object.getOwnPropertyDescriptor(store, method);
    const totals: WriterMethodTiming = (writerTotals[method] = {
      scope:
        method === "advanceHistorySourceBootstrap"
          ? "shared_store_bootstrap"
          : "synthetic_run",
      calls: 0,
      failures: 0,
      synchronous: {
        span_kind: "call_to_return_host_blocking",
        calls: 0,
        failures: 0,
        total_ms: 0,
        max_ms: 0,
        max_started_host_ms: null,
        max_ended_host_ms: null,
      },
      asynchronous: {
        span_kind: "call_to_settlement",
        calls: 0,
        failures: 0,
        total_ms: 0,
        max_ms: 0,
        max_started_host_ms: null,
        max_ended_host_ms: null,
      },
    });
    Object.defineProperty(store, method, {
      configurable: true,
      writable: true,
      value: function (this: Store, ...args: unknown[]) {
        const first = args[0];
        if (
          method !== "advanceHistorySourceBootstrap" &&
          !(
            first === runId ||
            (first !== null &&
              typeof first === "object" &&
              "run_id" in first &&
              first.run_id === runId)
          )
        )
          return Reflect.apply(original, this, args);
        const start = performance.now();
        totals.calls++;
        const recordSpan = (
          span: WriterSpanTotals,
          end: number,
          failed: boolean,
        ) => {
          const elapsed = end - start;
          span.calls++;
          span.failures += Number(failed);
          span.total_ms += elapsed;
          if (span.max_started_host_ms === null || elapsed > span.max_ms) {
            span.max_ms = elapsed;
            span.max_started_host_ms = start;
            span.max_ended_host_ms = end;
          }
          writerSamples.add({
            method,
            scope: totals.scope,
            span_kind: span.span_kind,
            started_host_ms: start,
            ended_host_ms: end,
            duration_ms: elapsed,
            failed,
          });
        };
        let result: unknown;
        try {
          result = Reflect.apply(original, this, args);
        } catch (error) {
          totals.failures++;
          recordSpan(totals.synchronous, performance.now(), true);
          throw error;
        }
        const returnedAt = performance.now();
        recordSpan(totals.synchronous, returnedAt, false);
        if (result instanceof Promise) {
          void result.then(
            () => {
              recordSpan(totals.asynchronous, performance.now(), false);
            },
            () => {
              totals.failures++;
              recordSpan(totals.asynchronous, performance.now(), true);
            },
          );
        }
        return result;
      },
    });
    restores.push(() => {
      if (descriptor) Object.defineProperty(store, method, descriptor);
      else Reflect.deleteProperty(store, method);
    });
  }
  async function waitUntil(
    target: number,
    deadline: number,
    assertCurrent: () => void,
  ) {
    while (performance.now() < target) {
      current(deadline, assertCurrent);
      const turn = Promise.withResolvers<void>();
      const cancel = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancel);
        turn.reject(
          controller.signal.reason ?? new Error("P13 volume cancelled"),
        );
      };
      const timer = setTimeout(
        () => {
          controller.signal.removeEventListener("abort", cancel);
          turn.resolve();
        },
        Math.max(
          1,
          Math.min(
            2_147_483_647,
            target - performance.now(),
            deadline - performance.now(),
          ),
        ),
      );
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
      await turn.promise;
    }
    current(deadline, assertCurrent);
  }
  function snapshot(): Record<string, Json> {
    const owner = reader.snapshot();
    const lifecycle = owner.child;
    return asJson({
      schema_version: 1,
      assay: "p13_volume",
      provenance: "synthetic_nonplaying_retained_corpus_no_native_effects",
      run_id: runId,
      original_run_id: options.run.run_id,
      actions: options.actions,
      prepared,
      seeded_actions: seeded,
      raw_action_count: rawCount,
      raw_source_through: rawThrough,
      execution_id: executionId,
      source_hash: sourceHash,
      first_action_id: firstAction?.action_id ?? null,
      preparation: {
        started_host_ms: preparationStart,
        ended_host_ms: preparationEnd,
        duration_ms:
          preparationEnd === null ? null : preparationEnd - preparationStart,
        stages: stages.snapshot(),
        initial_generation_available: initialGenerationAvailable,
      },
      measurement: {
        window_start_host_ms: measurementWindowStart,
        window_deadline_host_ms: measurementWindowDeadline,
        started_host_ms: measurementStarted,
        settled_host_ms: measurementSettled,
        invocations,
        submitted: invocations.filter(
          (value) => value.submitted_host_ms !== null,
        ).length,
        settled: invocations.filter((value) => value.settled_host_ms !== null)
          .length,
        final_status: finalStatus,
        semantic_check: semanticCheck,
      },
      reads: {
        interval_ms: 2000,
        page_limit: 8,
        feedback_limit: 16,
        slots: readSlots,
        ...reads.snapshot(),
      },
      memory: { interval_ms: 1000, slots: memorySlots, ...memory.snapshot() },
      queue: {
        submitted: querySubmitted,
        settled: querySettled,
        failures: queryFailures,
        max_queued: queueMax,
        max_active: activeMax,
        ...queueSamples.snapshot(),
      },
      writer: { methods: writerTotals, ...writerSamples.snapshot() },
      errors: errors.snapshot(),
      closed,
      learning_closed: learningClosed,
      reader_closed:
        owner.closed &&
        (!lifecycle ||
          (lifecycle.exitObservedHostMs !== null &&
            lifecycle.stdoutDrainObservedHostMs !== null &&
            lifecycle.closedHostMs !== null)),
      tasks_joined: tasksJoined,
      reader_owner: owner,
      closed_host_ms: closedAt,
    }) as Record<string, Json>;
  }
  async function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      controller.abort(new Error("P13 volume admission closed"));
      const results = await Promise.allSettled([
        learning.close(),
        ...(measurement ? [measurement] : []),
      ]);
      learningClosed = results[0]!.status === "fulfilled";
      tasksJoined = true;
      for (const restore of restores.reverse()) restore();
      options.signal.removeEventListener("abort", abort);
      const owner = reader.snapshot(),
        child = owner.child;
      closed =
        learningClosed &&
        owner.closed &&
        (!child ||
          (child.exitObservedHostMs !== null &&
            child.stdoutDrainObservedHostMs !== null &&
            child.closedHostMs !== null));
      closedAt = performance.now();
      if (!closed)
        throw new Error("P13 volume reader ownership did not close and drain");
      options.note("p13_volume_snapshot", snapshot());
    })();
    return closing;
  }
  async function measure(
    input: ResidentVolumeMeasurementOptions,
  ): Promise<void> {
    const deadline = Math.min(
      input.measurementEnd,
      input.deadlineHostMs,
      options.deadlineHostMs,
    );
    const assertCurrent = () => {
      options.assertCurrent();
      input.assertCurrent();
    };
    const cancel = () =>
      controller.abort(
        input.signal.reason ?? new Error("P13 volume measurement cancelled"),
      );
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) cancel();
    measurementWindowStart = input.measurementStart;
    measurementWindowDeadline = input.measurementEnd;
    const tasks: Promise<void>[] = [];
    const preparationTasks: Promise<void>[] = [];
    const own = (work: Promise<void>) => {
      const task = work.catch((error) => {
        fail(error);
        throw error;
      });
      task.catch(() => {});
      tasks.push(task);
      return task;
    };
    const queryOptions = {
      deadlineHostMs: deadline,
      signal: controller.signal,
    };
    let feedbackAfter: ImprovementFeedbackCursor = {
      schema_version: 2,
      opportunity_change_seq: 0,
      metric_change_seq: 0,
      scope_hash: null,
    };
    let evidenceAfter = { record_index: 0, chunk_index: 0 },
      evidenceGeneration: number | null = null;
    const invoke = (index: number) => {
      current(deadline, assertCurrent);
      const entry = invocations[index]!;
      entry.submitted_host_ms = performance.now();
      if (index === 0) measurementStarted = entry.submitted_host_ms;
      entry.source_target = store.historySourceHighwater(runId);
      entry.disposition = "submitted";
      preparationTasks.push(
        own(
          learning.prepareFeedback(runId, queryOptions).then(
            () => {
              entry.settled_host_ms = performance.now();
              entry.disposition = "completed";
            },
            (error) => {
              entry.settled_host_ms = performance.now();
              entry.disposition = "failed";
              entry.error = message(error);
              throw error;
            },
          ),
        ),
      );
    };
    try {
      if (
        !Number.isFinite(input.measurementStart) ||
        !Number.isFinite(input.measurementEnd) ||
        input.measurementEnd <= input.measurementStart ||
        input.measurementEnd !== input.measurementStart + 120_000
      )
        throw new Error(
          "P13 requires the unchanged full 120-second measurement window",
        );
      await waitUntil(input.measurementStart, deadline, assertCurrent);
      invoke(0);
      own(
        (async () => {
          for (let index = 0; index < LATE_OFFSETS.length; index++) {
            const target = input.measurementStart + LATE_OFFSETS[index]!;
            await waitUntil(target, deadline, assertCurrent);
            if (performance.now() - target >= 2000) {
              invocations[index + 1]!.disposition = "missed";
              throw new Error("P13 fixed late update missed its absolute slot");
            }
            const action = structuredClone(firstAction!);
            action.summary = `Synthetic retained receipt revision ${index + 1}; no native effects`;
            const unconfirmed = index % 2 === 0;
            action.status = unconfirmed ? "unknown" : "succeeded";
            action.result = {
              ...action.result!,
              status: action.status,
              summary: action.summary,
              evidence: {
                ...(action.result!.evidence as Record<string, Json>),
                p13_late_revision: index + 1,
                effect_confirmed: !unconfirmed,
                inventory_receipt_confirmed: !unconfirmed,
              },
            };
            store.saveAction(runId, action);
            invoke(index + 1);
          }
        })(),
      );
      own(
        (async () => {
          for (let offset = 0; offset < 120_000; offset += 2000) {
            const slot = readSlots[offset / 2000]!;
            await waitUntil(
              input.measurementStart + offset,
              deadline,
              assertCurrent,
            );
            if (performance.now() - (input.measurementStart + offset) >= 2000) {
              slot.disposition = "missed";
              continue;
            }
            slot.disposition = "submitted";
            const status = await reader.query(
              { kind: "projection_status", run_id: runId },
              queryOptions,
            );
            if (!status.published) {
              reads.add({
                offset_ms: offset,
                at_host_ms: performance.now(),
                disposition: "pending_first_publication",
                status,
              });
              slot.disposition = "pending";
              continue;
            }
            if (evidenceGeneration !== status.published.generation) {
              evidenceGeneration = status.published.generation;
              evidenceAfter = { record_index: 0, chunk_index: 0 };
            }
            const feedback = await reader.query(
              {
                kind: "operator_feedback",
                run_id: runId,
                after: feedbackAfter,
                limit: 16,
              },
              queryOptions,
            );
            feedbackAfter = feedback.next_after;
            const evidence = await reader.query(
              {
                kind: "export_page",
                run_id: runId,
                collection: "program_evidence",
                execution_id: executionId!,
                generation: evidenceGeneration,
                after: evidenceAfter,
                limit: 8,
              },
              queryOptions,
            );
            evidenceAfter = evidence.next_after;
            reads.add({
              offset_ms: offset,
              at_host_ms: performance.now(),
              disposition: "published_page",
              status,
              feedback,
              evidence,
            });
            slot.disposition = "completed";
          }
        })(),
      );
      own(
        (async () => {
          let previousCpu = process.cpuUsage(),
            previousHost = performance.now();
          for (let offset = 0; offset < 120_000; offset += 1000) {
            const slot = memorySlots[offset / 1000]!;
            await waitUntil(
              input.measurementStart + offset,
              deadline,
              assertCurrent,
            );
            if (performance.now() - (input.measurementStart + offset) >= 1000) {
              slot.disposition = "missed";
              continue;
            }
            const at = performance.now(),
              cpu = process.cpuUsage(),
              owner = reader.snapshot();
            const rss = await readerRss(owner.child?.pid ?? null);
            current(deadline, assertCurrent);
            memory.add({
              offset_ms: offset,
              at_host_ms: at,
              elapsed_ms: at - previousHost,
              host_rss_bytes: process.memoryUsage.rss(),
              cpu_user_us: cpu.user - previousCpu.user,
              cpu_system_us: cpu.system - previousCpu.system,
              reader_pid: owner.child?.pid ?? null,
              reader_rss_bytes: rss.bytes,
              reader_rss_unknown: rss.reason,
            });
            previousCpu = cpu;
            previousHost = at;
            slot.disposition = "completed";
            queue();
          }
        })(),
      );
      // New fixed invocations are appended while the scheduler runs. Join that scheduler before the complete task set.
      await tasks[1];
      await Promise.all(preparationTasks);
      current(deadline, assertCurrent);
      const status = await reader.query(
        { kind: "projection_status", run_id: runId },
        queryOptions,
      );
      finalStatus = asJson(status);
      if (
        invocations.some((value) => value.disposition !== "completed") ||
        !status.published ||
        status.published.source_through < invocations[5]!.source_target!
      )
        throw new Error(
          "P13 required initial publication and all five fixed changes did not complete in measurement",
        );
      const semanticStart = performance.now();
      semanticCheck = {
        disposition: "submitted",
        started_host_ms: semanticStart,
        generation: status.published.generation,
      };
      let metricProof: Record<string, Json>,
        evidenceProof: Record<string, Json>;
      {
        const archive = await retainedRecord(
          "objective_metrics",
          status.published.generation,
        );
        const metric = archive.record;
        assertMetric(metric);
        metricProof = {
          ...archive.proof,
          confirmed_block_removals: metric.confirmed_block_removals!,
          inventory_receipts: metric.inventory_receipts!,
          inventory_delta: metric.inventory_delta!,
        };
      }
      {
        const archive = await retainedRecord(
          "program_evidence",
          status.published.generation,
        );
        const evidence = archive.record;
        if (
          evidence.execution_id !== executionId ||
          evidence.actions !== options.actions ||
          evidence.confirmed_effects !== options.actions - 1 ||
          evidence.evidence_status !== "confirmed_effects" ||
          !Array.isArray(evidence.goal_associations) ||
          evidence.goal_associations.length !== 0 ||
          !Array.isArray(evidence.verified_event_seqs) ||
          evidence.verified_event_seqs.length !== 0
        )
          throw new Error(
            "P13 final published evidence did not retract the first action's goal association",
          );
        assertMetric(evidence.metrics);
        evidenceProof = {
          ...archive.proof,
          actions: evidence.actions,
          confirmed_effects: evidence.confirmed_effects,
          evidence_status: evidence.evidence_status,
          goal_associations: evidence.goal_associations,
          verified_event_seqs: evidence.verified_event_seqs,
        };
      }
      current(deadline, assertCurrent);
      semanticCheck = asJson({
        disposition: "completed",
        started_host_ms: semanticStart,
        completed_host_ms: performance.now(),
        generation: status.published.generation,
        source_through: status.published.source_through,
        metric: metricProof,
        evidence: evidenceProof,
      });
      await Promise.all(tasks);
      current(deadline, assertCurrent);
      options.note("p13_volume_snapshot", snapshot());
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      controller.abort(
        new Error("P13 volume measurement task admission ended"),
      );
      await Promise.allSettled(tasks);
      measurementSettled = performance.now();
      input.signal.removeEventListener("abort", cancel);
      for (const entry of invocations)
        if (entry.disposition === "not_submitted")
          entry.disposition = "not_run";
      options.note("p13_volume_snapshot", snapshot());
    }
    function assertMetric(value: Json | undefined) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.execution_id !== executionId ||
        value.confirmed_block_removals !== options.actions - 1 ||
        value.inventory_receipts !== options.actions - 1 ||
        !value.inventory_delta ||
        typeof value.inventory_delta !== "object" ||
        Array.isArray(value.inventory_delta) ||
        value.inventory_delta.oak_log !== options.actions - 1
      )
        throw new Error(
          "P13 final actual published metric did not retract the first receipt",
        );
    }
    /** Decode one pinned lossless archive record, never a prefix or a parallel reducer. */
    async function retainedRecord(
      collection: "objective_metrics" | "program_evidence",
      generation: number,
    ) {
      const maximumBytes = 16 * 1024 * 1024;
      const parts: string[] = [];
      let after = { record_index: 0, chunk_index: 0 },
        pages = 0,
        expectedChunks: number | null = null;
      let expectedHash: string | null = null,
        expectedBytes: number | null = null,
        textUnits = 0;
      let raw: Json | undefined;
      do {
        current(deadline, assertCurrent);
        const page = await reader.query(
          {
            kind: "export_page",
            run_id: runId,
            collection,
            execution_id: executionId!,
            generation,
            after,
            limit: 8,
          },
          queryOptions,
        );
        pages++;
        if (
          pages > 4096 ||
          page.total !== 1 ||
          page.omissions.length ||
          page.projection?.generation !== generation
        )
          throw new Error(
            "P13 final lossless archive is omitted, unpinned or exceeds its bounded record allowance",
          );
        for (const item of page.records) {
          if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            item.kind === "json_record_chunk"
          ) {
            if (
              raw !== undefined ||
              item.schema_version !== 1 ||
              item.collection !== collection ||
              item.encoding !== "json_text" ||
              item.record_index !== 0 ||
              item.record_count !== 1 ||
              item.chunk_index !== parts.length ||
              !Number.isSafeInteger(item.chunk_count) ||
              Number(item.chunk_count) < 1 ||
              Number(item.chunk_count) > 4096 ||
              !Number.isSafeInteger(item.original_bytes) ||
              Number(item.original_bytes) < 1 ||
              Number(item.original_bytes) > maximumBytes ||
              typeof item.text !== "string" ||
              typeof item.sha256 !== "string" ||
              !/^[a-f0-9]{64}$/.test(item.sha256)
            )
              throw new Error(
                "P13 final archive chunk has invalid identity or bounds",
              );
            expectedChunks ??= Number(item.chunk_count);
            expectedHash ??= item.sha256;
            expectedBytes ??= Number(item.original_bytes);
            if (
              item.chunk_count !== expectedChunks ||
              item.sha256 !== expectedHash ||
              item.original_bytes !== expectedBytes
            )
              throw new Error("P13 final archive chunk identity changed");
            textUnits += item.text.length;
            if (textUnits > maximumBytes)
              throw new Error(
                "P13 final archive exceeds bounded text retention",
              );
            parts.push(item.text);
          } else {
            if (raw !== undefined || parts.length)
              throw new Error(
                "P13 final archive contains multiple logical records",
              );
            raw = item;
          }
        }
        if (
          page.has_more &&
          (page.next_after.record_index < after.record_index ||
            (page.next_after.record_index === after.record_index &&
              page.next_after.chunk_index <= after.chunk_index))
        )
          throw new Error("P13 final archive cursor did not progress");
        after = page.next_after;
        if (!page.has_more) break;
      } while (true);
      if (after.record_index !== 1 || after.chunk_index !== 0)
        throw new Error("P13 final archive is incomplete");
      const text = raw === undefined ? parts.join("") : JSON.stringify(raw);
      const bytes = Buffer.byteLength(text),
        sha256 = createHash("sha256").update(text).digest("hex");
      if (
        bytes > maximumBytes ||
        (raw === undefined &&
          (parts.length !== expectedChunks ||
            bytes !== expectedBytes ||
            sha256 !== expectedHash))
      )
        throw new Error(
          "P13 final archive record hash or complete byte count differs",
        );
      if (raw === undefined) raw = JSON.parse(text) as Json;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("P13 final archive record is not an evidence object");
      return {
        record: raw,
        proof: {
          collection,
          pages,
          original_bytes: bytes,
          sha256,
          lossless_record_verified: true,
        },
      };
    }
  }
  try {
    options.note("p13_volume_snapshot", snapshot());
    current(options.deadlineHostMs, options.assertCurrent);
    if (![30, 300, 3000, 10000, 60000].includes(options.actions))
      throw new Error("P13 volume is not authorized");
    const setup = minecraftObservationV3Schema.parse(options.observation);
    const actual = options.run;
    if (
      !actual.session_id ||
      !actual.native_boot_id ||
      actual.life_id === null ||
      actual.space_epoch === null ||
      !actual.compatibility_hash ||
      setup.world_id !== actual.world_id ||
      setup.session_id !== actual.session_id ||
      setup.epoch !== actual.epoch ||
      setup.native_boot_id !== actual.native_boot_id ||
      setup.life.life_id !== actual.life_id ||
      setup.space.space_epoch !== actual.space_epoch ||
      setup.compatibility_hash !== actual.compatibility_hash
    )
      throw new Error(
        "P13 corpus requires the actual current observation and compatible scope",
      );
    const goal = adapter.goals.find((value) => value.goal_id === "break_log");
    if (!goal || !adapter.effectEvidence)
      throw new Error("P13 requires the registered Minecraft removal verifier");
    const run: StoredRun = {
      ...actual,
      run_id: runId,
      task: "P13 explicitly synthetic nonplaying retained volume corpus; no native effects or learned competence",
      goal,
      status: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
      turns: 0,
      model_status: "idle",
      error: null,
      usage: emptyRunUsage(),
      baseline: adapter.captureBaseline(goal, setup),
    };
    delete run.control;
    store.saveRun(run);
    store.event(
      runId,
      "run.adapter",
      "Actual registered adapter for synthetic retained corpus",
      asJson({
        descriptor: adapter.descriptor,
        compatibility_hash: actual.compatibility_hash,
      }),
    );
    store.event(
      runId,
      "p13.synthetic_corpus",
      "Synthetic nonplaying corpus; not source gameplay facts",
      {
        original_run_id: actual.run_id,
        actions: options.actions,
        native_effects: false,
        source_validation: "actual_caller_selected_immutable_source",
      },
    );
    stages.add({
      stage: "synthetic_run_registered",
      at_host_ms: performance.now(),
    });
    const selected = await store.registerSkill(
      runId,
      options.validated,
      undefined,
      () => current(options.deadlineHostMs, options.assertCurrent),
    );
    if (selected.entry !== "step" && selected.entry !== "run")
      throw new Error("P13 selected source has no admitted playing entry");
    sourceHash = selected.hash;
    const identity = {
      skill_id: selected.skill_id,
      version: selected.version,
      start_key: randomUUID(),
      epoch: run.epoch,
      session_id: run.session_id!,
      native_boot_id: run.native_boot_id!,
      run_generation: 1,
      life_id: run.life_id!,
      space_epoch: run.space_epoch!,
      compatibility_hash: run.compatibility_hash!,
      args: null,
    };
    const owner = store.admitSkill(
      runId,
      selected.entry === "step"
        ? {
            ...identity,
            entry: "step",
            initial_state: null,
            limits: { ...DEFAULT_RESIDENT_LIMITS },
          }
        : { ...identity, entry: "run", limits: { ...DEFAULT_SKILL_LIMITS } },
    ).view;
    executionId = owner.execution_id;
    owner.status = "running";
    owner.started_at = new Date().toISOString();
    store.updateSkillExecution(
      owner,
      "skill.running",
      "Synthetic retained owner ledger; no program dispatch",
    );
    const scope = {
      run_id: runId,
      world_id: run.world_id,
      epoch: run.epoch,
      session_id: run.session_id!,
      native_boot_id: run.native_boot_id!,
      run_generation: owner.run_generation!,
      life_id: run.life_id!,
      space_epoch: run.space_epoch!,
      execution_id: owner.execution_id,
      source_hash: owner.source_hash!,
    };
    const authority = {
      scope,
      invocation: {
        kind: "skill" as const,
        execution_id: owner.execution_id,
        source_hash: owner.source_hash!,
      },
      compatibility_hash: run.compatibility_hash!,
    };
    const request: GameAction = {
      kind: "dig",
      target: {
        target_id: "p13-synthetic-retained-log",
        incarnation: 1,
        space: setup.space,
        life_id: setup.life.life_id,
      },
    };
    stages.add({ stage: "raw_seed_started", at_host_ms: performance.now() });
    for (let index = 0; index < options.actions; index++) {
      current(options.deadlineHostMs, options.assertCurrent);
      const admitted = store.admitAction(
        runId,
        randomUUID(),
        request,
        "skill",
        owner.execution_id,
        authority,
      );
      if (!admitted.created)
        throw new Error("P13 requires distinct admitted actions");
      const action = admitted.action.view;
      const at = new Date().toISOString();
      action.status = "succeeded";
      action.started_at = at;
      action.ended_at = at;
      action.summary =
        "Synthetic retained removal/inventory receipt; no native effect";
      action.result = {
        status: "succeeded",
        summary: action.summary,
        evidence: {
          p13_synthetic: true,
          effect_confirmed: true,
          source: "server_block_update",
          target_name: "oak_log",
          inventory_before: { oak_log: 0 },
          inventory_after: { oak_log: 1 },
          inventory_receipt_confirmed: true,
        },
      };
      store.saveAction(runId, action);
      const facts = adapter.effectEvidence(
        scope,
        action.action_id,
        request,
        action.result,
        at,
      );
      if (!facts.length)
        throw new Error(
          "P13 synthetic nonempty receipt did not produce actual adapter facts",
        );
      for (const fact of facts)
        store.event(
          runId,
          "adapter.evidence",
          "Typed synthetic retained removal fact; no native effects",
          asJson(fact),
        );
      if (index === 0) {
        firstAction = structuredClone(action);
        const possession = structuredClone(setup);
        possession.observation_seq++;
        possession.captured_at = at;
        possession.data.player.inventory = [
          { name: "oak_log", display_name: "Oak Log", count: 1, slot: 0 },
        ];
        const observed = observationEvidence(adapter, scope, possession);
        store.event(
          runId,
          "adapter.evidence",
          "Synthetic retained inventory; not a native observation",
          asJson(observed),
        );
        const verdict = adapter.verifyCompletion(
          {
            goal,
            run_id: runId,
            world_id: run.world_id,
            session_id: run.session_id!,
            epoch: run.epoch,
            native_boot_id: run.native_boot_id!,
            baseline: run.baseline,
          },
          [...facts, observed],
        );
        if (verdict.status !== "verified")
          throw new Error(
            `P13 actual retained-fact verifier failed: ${verdict.reason}`,
          );
        store.event(
          runId,
          "goal.verified",
          "Actual verifier over explicitly synthetic corpus only",
          asJson(verdict),
        );
      }
      seeded++;
      if (seeded % 16 === 0) {
        const turn = Promise.withResolvers<void>();
        setTimeout(turn.resolve, 0);
        await turn.promise;
      }
    }
    owner.status = "succeeded";
    owner.ended_at = new Date().toISOString();
    owner.actions = seeded;
    owner.result = {
      status: "completed",
      summary:
        "Synthetic retained corpus only; no program dispatch or native effects",
      result: { p13_synthetic: true, actions: seeded, no_native_effects: true },
    };
    store.updateSkillExecution(
      owner,
      "skill.succeeded",
      "Synthetic corpus owner ledger complete; no program executed",
    );
    rawThrough = store.historySourceHighwater(runId);
    let after = 0;
    do {
      current(options.deadlineHostMs, options.assertCurrent);
      const page = store.historySourcePage(
        runId,
        "action",
        rawThrough,
        after,
        undefined,
        16,
      );
      for (const record of page.records) {
        const view = JSON.parse(String(record.columns.view)) as ActionView;
        const evidence = view.result?.evidence;
        if (
          view.execution_id !== executionId ||
          view.status !== "succeeded" ||
          !view.ended_at ||
          !view.result?.summary.trim() ||
          evidence === null ||
          typeof evidence !== "object" ||
          Array.isArray(evidence) ||
          Object.keys(evidence).length === 0 ||
          view.scope?.source_hash !== sourceHash ||
          view.scope.run_id !== runId
        )
          throw new Error(
            "P13 raw action population is not attributable terminal receipt data",
          );
        rawCount++;
      }
      if (!page.has_more) break;
      after = page.next_after;
      const turn = Promise.withResolvers<void>();
      setTimeout(turn.resolve, 0);
      await turn.promise;
    } while (true);
    initialGenerationAvailable =
      store.historyProjectionCheckpoint(runId) !== null ||
      store.historyProjectionGeneration(runId) !== null;
    if (
      rawCount !== options.actions ||
      !firstAction ||
      initialGenerationAvailable
    )
      throw new Error(
        "P13 raw preparation changed population or prepared projection before measurement",
      );
    prepared = true;
    preparationEnd = performance.now();
    stages.add({
      stage: "raw_complete_projection_unavailable",
      at_host_ms: preparationEnd,
      actions: rawCount,
      source_through: rawThrough,
    });
    options.note("p13_volume_snapshot", snapshot());
    return {
      snapshot,
      close,
      runMeasurement(input) {
        if (measurement || closing || !prepared)
          return Promise.reject(
            new Error(
              "P13 volume measurement admission is closed or already used",
            ),
          );
        measurement = measure(input);
        return measurement;
      },
    };
  } catch (error) {
    preparationEnd = performance.now();
    fail(error);
    stages.add({
      stage: "preparation_failed",
      at_host_ms: preparationEnd,
      error: message(error),
    });
    try {
      await close();
    } catch (closureError) {
      errors.add({
        stage: "preparation_failure_close",
        error: message(closureError),
      });
    }
    try {
      options.note("p13_volume_snapshot", snapshot());
    } catch (noteError) {
      errors.add({
        stage: "preparation_failure_note",
        error: message(noteError),
      });
    }
    throw error;
  }
}
