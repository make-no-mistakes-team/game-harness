import { expect, test } from "bun:test";
import {
  ProjectionDraft,
  assertProjectionCheckpoint,
  type HistoryProjectionBatch,
} from "../src/server/history-projection.ts";
import { HISTORY_LIMITS } from "../src/server/history-limits.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { historyFixture } from "./helpers/history-fixture.ts";

for (const wideRunId of [false, true]) {
  test(`an admitted checkpoint cannot become too large for its continuation request (UTF-8=${wideRunId})`, async () => {
    const fixture = historyFixture(),
      { store } = fixture;
    const run = wideRunId
      ? { ...fixture.run, run_id: "界".repeat(200) }
      : fixture.run;
    if (wideRunId) store.saveRun(run);
    const reader = new HistoryReader(store.readLocation());
    try {
      while (!store.advanceHistorySourceBootstrap(128).complete) {}
      const before = store.beginHistoryProjection(run.run_id);
      const after = structuredClone(before);
      after.revision++;
      after.job.frame_padding = "";
      after.job.frame_padding = "x".repeat(
        HISTORY_LIMITS.requestBytes -
          8 -
          Buffer.byteLength(JSON.stringify(after.job)),
      );
      // The standalone job is legal; only the complete request violates its budget.
      assertProjectionCheckpoint(after);
      const request =
        JSON.stringify({
          id: Number.MAX_SAFE_INTEGER,
          query: {
            kind: "projection_batch",
            run_id: run.run_id,
            checkpoint: after,
            work_limit: 128,
          },
        }) + "\n";
      expect(Buffer.byteLength(request)).toBeGreaterThan(
        HISTORY_LIMITS.requestBytes,
      );
      const batch: HistoryProjectionBatch = {
        before,
        after,
        patches: [],
        candidates: [],
        opportunity_bootstrap: [],
        has_more: true,
      };
      expect(() =>
        store.commitHistoryProjectionBatch(run.run_id, batch),
      ).toThrow();
      expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(before);
      await new ImprovementLearning(store, reader).prepareFeedback(run.run_id, {
        deadlineHostMs: performance.now() + 10_000,
      });
      const published = store.historyProjectionGeneration(run.run_id)!;
      expect(published.source_through).toBe(
        store.historySourceHighwater(run.run_id),
      );
      expect(published.has_pending).toBe(false);
    } finally {
      try {
        await reader.close();
      } finally {
        fixture.close();
      }
    }
  });
}

test("the readonly producer rejects an oversized next request before returning durable progress", () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    while (!store.advanceHistorySourceBootstrap(128).complete) {}
    const before = store.beginHistoryProjection(run.run_id);
    reader = new ReadonlyStore(store.readLocation());
    const draft = new ProjectionDraft(reader, run.run_id, before);
    draft.next.job.frame_padding = "";
    draft.next.job.frame_padding = "x".repeat(
      HISTORY_LIMITS.requestBytes -
        8 -
        Buffer.byteLength(JSON.stringify(draft.next.job)),
    );
    assertProjectionCheckpoint(draft.next);
    expect(() => draft.finish(true)).toThrow();
    expect(store.historyProjectionCheckpoint(run.run_id)).toEqual(before);
    expect(store.getRun(run.run_id)?.run_id).toBe(run.run_id);
  } finally {
    reader?.close();
    fixture.close();
  }
});
