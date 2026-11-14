import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { ProjectionWriterClient } from "../src/server/projection-writer-client.ts";
import { finishHistoryExecution, historyExecution, historyFixture, historySpec } from "./helpers/history-fixture.ts";

const options = () => ({ deadlineHostMs: performance.now() + 10_000 });

test("closing an uninitialized enclosing owner admits no audit mutation with unknown persistence", async () => {
  const f = historyFixture();
  const writer = new ProjectionWriterClient(f.store);
  const reader = new HistoryReader(f.store.readLocation());
  const learning = new ImprovementLearning(f.store, reader, writer);
  try {
    // Construction failure must be safely closeable without having admitted a
    // background audit before the caller received its Runtime owner.
    await learning.close();
    await expect(learning.ready).rejects.toMatchObject({ code: "history_closed", persistence: "not_started" });
    await expect(writer.beginHistoryProjection(f.run.run_id, undefined, options())).rejects.toMatchObject({ persistence: "not_started" });
    expect(writer.snapshot()).toEqual({ closed: true, worker_closed: true, active: false, queued: 0 });
  } finally { await learning.close(); f.close(); }
});

test("independent writer publishes real history and resolves a review exactly once through canonical receipts", async () => {
  const f = historyFixture();
  const writer = new ProjectionWriterClient(f.store);
  const reader = new HistoryReader(f.store.readLocation());
  const learning = new ImprovementLearning(f.store, reader, writer);
  try {
    await learning.ready;
    const skill = await f.store.registerSkill(f.run.run_id, historySpec(f.run));
    const execution = historyExecution(f.store, f.run, skill);
    finishHistoryExecution(f.store, execution);
    await learning.prepareFeedback(f.run.run_id, options());
    const opportunity = f.store.latestOpportunityForVersion({ run_id: f.run.run_id, skill_id: skill.skill_id, version: skill.version, hash: skill.hash });
    expect(opportunity?.execution_id).toBe(execution.execution_id);
    expect(f.store.historyProjectionGeneration(f.run.run_id)?.source_through).toBeGreaterThan(0);
    const decision = { decision: "keep" as const, reason: "Retain the recorded storage fixture outcome", revision: null, event_seqs: [] };
    const resolved = await learning.resolve(f.run.run_id, opportunity!.opportunity_id, decision);
    expect(resolved.resolution?.decision).toBe("keep");
    expect(await learning.resolve(f.run.run_id, opportunity!.opportunity_id, decision)).toEqual(resolved);
    expect(f.store.eventsAfter(f.run.run_id, 0, 500).filter(event => event.type === "learning.resolved")).toHaveLength(1);
    expect(() => f.store.beginHistoryProjection(f.run.run_id)).toThrow("independently owned");
  } finally { await learning.close(); f.close(); }
  expect(writer.snapshot()).toMatchObject({ worker_closed: true, active: false, queued: 0 });
});

test("canonical progress and cancellation remain live while the derived writer waits on its own SQLite lock", async () => {
  const f = historyFixture();
  const writer = new ProjectionWriterClient(f.store);
  const blocker = new Database(f.store.readLocation().projection!, { readwrite: true });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let locked = false;
  try {
    await writer.ready;
    blocker.exec("BEGIN IMMEDIATE"); locked = true;
    const pending = writer.beginHistoryProjection(f.run.run_id, undefined, { ...options(), signal: controller.signal });
    const verdict = pending.then(value => ({ value }), error => ({ error: error as unknown }));
    const progressed = Promise.withResolvers<number>();
    // Real platform scheduling is the regression: fake time cannot expose a
    // synchronous SQLite wait accidentally moved back onto the canonical owner.
    timer = setTimeout(() => {
      const event = f.store.event(f.run.run_id, "fixture.progress", "Canonical owner remained responsive under a derived write lock");
      controller.abort(); progressed.resolve(event.event_seq);
    }, 20);
    const sequence = await progressed.promise;
    expect(locked).toBe(true);
    expect(f.store.eventsAfter(f.run.run_id, sequence - 1, 1)[0]?.type).toBe("fixture.progress");
    const drained = writer.cancelRun(f.run.run_id);
    blocker.exec("ROLLBACK"); locked = false;
    await drained;
    expect(await verdict).toMatchObject({ error: { code: "history_cancelled", persistence: "unknown" } });
    expect(writer.snapshot()).toMatchObject({ active: false, queued: 0 });
  } finally {
    clearTimeout(timer);
    if (locked) blocker.exec("ROLLBACK");
    blocker.close(true);
    await writer.close(); f.close();
  }
});

test("closing during projection worker startup joins ownership and cannot acknowledge a late mutation", async () => {
  const f = historyFixture();
  const writer = new ProjectionWriterClient(f.store);
  const ready = writer.ready.then(() => ({ ready: true }), error => ({ error: error as unknown }));
  try {
    await writer.close();
    expect(await ready).toMatchObject({ error: { persistence: "unknown" } });
    expect(writer.snapshot()).toEqual({ closed: true, worker_closed: true, active: false, queued: 0 });
    await expect(writer.beginHistoryProjection(f.run.run_id, undefined, options())).rejects.toMatchObject({ persistence: "not_started" });
  } finally { await writer.close(); f.close(); }
});
