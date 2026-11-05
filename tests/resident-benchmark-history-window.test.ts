import { expect, test, vi } from "bun:test";
import { runResidentBenchmarkHistoryLoad } from "../scripts/native-resident-benchmark-slot.ts";
import { DEFAULT_RESIDENT_BENCHMARK_PROTOCOL } from "../src/evaluation/resident-benchmark.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import type {
  HistoryQuery,
  HistoryQueryOptions,
  HistoryResult,
} from "../src/server/history-protocol.ts";
import {
  finishHistoryExecution,
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";

// Only the monotonic endpoint is controlled. Every admitted query still uses
// the actual readonly process, corpus, response protocol and close barrier.
class ObservedHistoryReader extends HistoryReader {
  readonly dispatches: Array<{
    query: HistoryQuery;
    hostMs: number;
    deadlineHostMs: number;
  }> = [];
  onDispatch?: () => void;
  onDelivery?: () => void;

  override query<Q extends HistoryQuery>(
    query: Q,
    options: HistoryQueryOptions,
  ): Promise<HistoryResult<Q>> {
    this.dispatches.push({
      query,
      hostMs: performance.now(),
      deadlineHostMs: options.deadlineHostMs,
    });
    const pending = super.query(query, options);
    this.onDispatch?.();
    return pending.then((value) => {
      this.onDelivery?.();
      return value;
    });
  }
}

for (const mode of [
  "full original load",
  "expired before first dispatch",
  "overdue next dispatch",
  "late successful response",
  "stopped query at endpoint",
] as const) {
  test(`E01 measurement history endpoint: ${mode}`, async () => {
    const fixture = historyFixture();
    const reader = new ObservedHistoryReader(fixture.store.readLocation());
    const protocol = DEFAULT_RESIDENT_BENCHMARK_PROTOCOL;
    const skill = await fixture.store.registerSkill(fixture.run.run_id, historySpec(fixture.run));
    const execution = historyExecution(fixture.store, fixture.run, skill);
    finishHistoryExecution(fixture.store, execution);
    const existingEvents = fixture.store.eventsAfter(fixture.run.run_id, 0, 500).length;
    fixture.store.appendEvents(
      fixture.run.run_id,
      Array.from({ length: protocol.history_records }, (_, index) => ({
        type: "benchmark.evaluator_history",
        summary: "Nonplaying evaluator-only history load",
        details: { index },
      })),
    );
    const expectedPayload = {
      events: existingEvents + protocol.history_records,
      program_evidence: programEvidence(fixture.store, fixture.run.run_id),
      programs: fixture.store.skills(fixture.run.run_id),
    };
    const start = performance.now();
    const end = start + protocol.measurement_ms;
    const fakeTimers = mode === "stopped query at endpoint";
    if (fakeTimers) vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockReturnValue(start);
    const abort = new AbortController();
    const records: Array<Record<string, unknown>> = [];
    const lifecycle: { owner: ReturnType<HistoryReader["snapshot"]> | null } = {
      owner: null,
    };
    const payloads: HistoryResult<{ kind: "benchmark_history"; run_id: string; minimum_records: number }>[] = [];
    let stoppedPid: number | null = null;
    try {
      if (mode === "expired before first dispatch") clock.mockReturnValue(end);
      if (mode === "late successful response") {
        reader.onDelivery = () => clock.mockReturnValue(end);
      }
      if (fakeTimers) {
        reader.onDispatch = () => {
          stoppedPid = reader.snapshot().child?.pid ?? null;
          if (stoppedPid === null) throw new Error("Actual readonly child was not started");
          process.kill(stoppedPid, "SIGSTOP");
          clock.mockReturnValue(end);
          vi.advanceTimersByTime(protocol.measurement_ms);
        };
      }
      const loading = runResidentBenchmarkHistoryLoad({
        reader,
        runId: fixture.run.run_id,
        measurementStart: start,
        measurementEnd: end,
        measurementMs: protocol.measurement_ms,
        intervalMs: protocol.history_interval_ms,
        minimumRecords: protocol.history_records,
        deadlineHostMs: start + protocol.root_ms,
        signal: abort.signal,
        assertCurrent: () => abort.signal.throwIfAborted(),
        records,
        lifecycle,
        note(kind, value) {
          if (kind === "history_program_evidence") {
            // The real compound payload must not be replaced by a count-only
            // result when the measurement-bound helper is exercised.
            payloads.push(value as (typeof payloads)[number]);
          }
          if (kind === "actual_store_history_load") {
            if (mode === "full original load") {
              clock.mockReturnValue(start + records.length * protocol.history_interval_ms);
            } else if (mode === "overdue next dispatch") {
              clock.mockReturnValue(end);
            }
          }
        },
      });
      const failure: unknown = await loading.then(() => null, (error: unknown) => error);
      if (mode === "full original load") {
        const scheduledCount = protocol.measurement_ms / protocol.history_interval_ms;
        expect(failure).toBeNull();
        expect(reader.dispatches).toHaveLength(scheduledCount);
        expect(records).toHaveLength(scheduledCount);
        expect(payloads).toHaveLength(scheduledCount);
        for (let index = 0; index < scheduledCount; index++) {
          const scheduled = start + index * protocol.history_interval_ms;
          expect(reader.dispatches[index]).toEqual({
            query: {
              kind: "benchmark_history",
              run_id: fixture.run.run_id,
              minimum_records: protocol.history_records,
            },
            hostMs: scheduled,
            deadlineHostMs: end,
          });
          expect(records[index]).toMatchObject({
            index,
            scheduled_host_ms: scheduled,
            started_host_ms: scheduled,
            ended_host_ms: scheduled,
            deadline_host_ms: end,
            events_read: expectedPayload.events,
            error: null,
          });
          expect(payloads[index]).toEqual(expectedPayload);
        }
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(records.at(-1)).toMatchObject({
          deadline_host_ms: end,
          ended_host_ms: end,
          events_read: 0,
          error: expect.any(String),
        });
        expect(reader.dispatches).toHaveLength(mode === "expired before first dispatch" ? 0 : 1);
        expect(payloads).toHaveLength(mode === "overdue next dispatch" ? 1 : 0);
        if (mode === "expired before first dispatch" || mode === "overdue next dispatch") {
          expect(String(failure)).toContain("before dispatch");
          expect(records.at(-1)?.started_host_ms).toBe(end);
        }
        if (mode === "late successful response") {
          expect(String(failure)).toContain("before result delivery");
        }
        if (fakeTimers) {
          expect(String(failure)).toContain("deadline");
          expect(reader.snapshot()).toMatchObject({
            active: false,
            queued: 0,
            child: {
              pid: stoppedPid,
              exitObservedHostMs: end,
              stdoutDrainObservedHostMs: end,
              closedHostMs: end,
            },
          });
          expect(() => process.kill(stoppedPid!, 0)).toThrow();
        }
      }
      await reader.close();
      expect(reader.snapshot()).toMatchObject({ closed: true, active: false, queued: 0 });
      if (mode === "expired before first dispatch") {
        expect(reader.snapshot().child).toBeNull();
      } else {
        expect(reader.snapshot().child?.closedHostMs).toBeNumber();
      }
    } finally {
      abort.abort();
      await reader.close();
      clock.mockRestore();
      if (fakeTimers) vi.useRealTimers();
      fixture.close();
    }
  }, 20_000);
}
