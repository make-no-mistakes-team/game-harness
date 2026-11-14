import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareResidentVolumeLoad,
  type ResidentVolumeLoad,
  type ResidentVolumeLoadOptions,
} from "../scripts/native-resident-volume-load.ts";
import type { Json, RuntimeAdapter } from "../src/shared/contracts.ts";
import type { ObservationV3 } from "../src/shared/observations.ts";
import { Store, type StoredRun } from "../src/server/store.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import { validateSkill } from "../src/server/program-validation.ts";
import { RESIDENT_BENCHMARK_SOURCE } from "../src/evaluation/resident-benchmark.ts";
import {
  minecraftObservationFixture,
  minecraftRunFixture,
  minecraftTestAdapter,
} from "./helpers/adapter-contract.ts";

interface VolumeFixture {
  directory: string;
  store: Store;
  original: StoredRun;
  adapter: RuntimeAdapter;
  observation: ObservationV3;
  selected: ResidentVolumeLoadOptions["validated"];
  signal: AbortController;
  snapshots: Record<string, Json>[];
  owner: ResidentVolumeLoad | null;
  originalReader: HistoryReader | null;
}
const fixtures: VolumeFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.owner?.close();
    await fixture.originalReader?.close();
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
async function fixture(): Promise<VolumeFixture> {
  const directory = mkdtempSync(join(tmpdir(), "p13-resident-volume-"));
  const store = new Store(join(directory, "store"));
  const adapter = minecraftTestAdapter();
  const observation = minecraftObservationFixture(adapter);
  const original = minecraftRunFixture(adapter, {
    status: "stopped",
    ended_at: new Date().toISOString(),
  });
  store.saveRun(original);
  store.appendEvents(
    original.run_id,
    Array.from({ length: 4096 }, (_, index) => ({
      type: "benchmark.evaluator_history",
      summary: "Unchanged original E01 raw corpus",
      details: { index },
    })),
  );
  const selected = await validateSkill(
    {
      entry: "step",
      name: "P13 checked immutable mechanical source",
      source: RESIDENT_BENCHMARK_SOURCE,
      card: {
        purpose: "Retained synthetic host load only",
        applicability: "Dedicated P13 nonplaying corpus",
        method: "Measure actual retained history projection",
        reason: "No provider or native effects",
        limitations: "Not gameplay or learned competence",
      },
      dependencies: [],
    },
    { descriptor: adapter.descriptor, schemas: adapter.schemas },
  );
  const value: VolumeFixture = {
    directory,
    store,
    adapter,
    observation,
    original,
    selected,
    signal: new AbortController(),
    snapshots: [],
    owner: null,
    originalReader: null,
  };
  fixtures.push(value);
  return value;
}
function options(f: VolumeFixture): ResidentVolumeLoadOptions {
  return {
    store: f.store,
    run: f.original,
    adapter: f.adapter,
    observation: f.observation,
    validated: f.selected,
    actions: 30,
    deadlineHostMs: performance.now() + 180_000,
    signal: f.signal.signal,
    assertCurrent() {},
    note(kind, snapshot) {
      if (kind === "p13_volume_snapshot") f.snapshots.push(snapshot);
    },
  };
}
function object(value: Json | undefined): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected evidence object");
  return value;
}
function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error("Expected evidence array");
  return value;
}
test("P13 seeds exactly 30 attributable real raw receipts without premeasurement projection or changing E01", async () => {
  const f = await fixture();
  const originals = {
    saveRun: f.store.saveRun,
    saveAction: f.store.saveAction,
    bootstrap: f.store.advanceHistorySourceBootstrap,
  };
  f.owner = await prepareResidentVolumeLoad(options(f));
  const snapshot = f.owner.snapshot();
  expect(snapshot.prepared).toBe(true);
  expect(snapshot.seeded_actions).toBe(30);
  expect(snapshot.raw_action_count).toBe(30);
  expect(snapshot.run_id).not.toBe(f.original.run_id);
  expect(object(snapshot.preparation).initial_generation_available).toBe(false);
  expect(object(snapshot.measurement).submitted).toBe(0);
  expect(object(snapshot.reader_owner).child).toBeNull();
  const runId = String(snapshot.run_id);
  const run = f.store.getRun(runId)!;
  expect(run.status).toBe("running");
  expect(run.task).toContain("synthetic nonplaying");
  expect(f.store.historyProjectionCheckpoint(runId)).toBeNull();
  expect(f.store.historyProjectionGeneration(runId)).toBeNull();
  const actions = f.store.historySourcePage(
    runId,
    "action",
    Number(snapshot.raw_source_through),
    0,
    undefined,
    128,
  ).records;
  expect(actions).toHaveLength(30);
  for (const record of actions) {
    const action = JSON.parse(String(record.columns.view));
    expect(action.status).toBe("succeeded");
    expect(action.execution_id).toBe(snapshot.execution_id);
    expect(action.scope.source_hash).toBe(snapshot.source_hash);
    expect(action.result.evidence.p13_synthetic).toBe(true);
    expect(action.result.evidence.inventory_after.oak_log).toBe(1);
  }
  expect(f.store.skills(runId)[0]!.validation).toEqual(f.selected.validation);
  expect(f.store.skills(runId)[0]!.source).toBe(f.selected.source);
  expect(
    f.store.skillExecution(runId, {
      execution_id: String(snapshot.execution_id),
    })!.actions,
  ).toBe(30);
  const events = f.store.eventsAfter(runId, 0, 1000);
  expect(events.some((event) => event.type === "run.adapter")).toBe(true);
  expect(
    events.filter((event) => event.type === "adapter.evidence"),
  ).toHaveLength(31);
  expect(
    events.find((event) => event.type === "goal.verified")?.details,
  ).toMatchObject({
    status: "verified",
    verifier_id: "minecraft_block_removal_v2",
  });
  f.originalReader = new HistoryReader(f.store.readLocation());
  const original = await f.originalReader.query(
    {
      kind: "benchmark_history",
      run_id: f.original.run_id,
      minimum_records: 4096,
    },
    { deadlineHostMs: performance.now() + 10_000 },
  );
  expect(original.events).toBe(4096);
  expect(original.programs).toHaveLength(0);
  expect(original.program_evidence).toHaveLength(0);
  expect(f.store.historyProjectionCheckpoint(f.original.run_id)).toBeNull();
  const writerBefore = object(object(f.owner.snapshot().writer).methods);
  expect(object(writerBefore.registerSkill)).toMatchObject({
    calls: 1,
    failures: 0,
    synchronous: {
      span_kind: "call_to_return_host_blocking",
      calls: 1,
      failures: 0,
    },
    asynchronous: { span_kind: "call_to_settlement", calls: 1, failures: 0 },
  });
  expect(
    Number(object(object(writerBefore.registerSkill).asynchronous).total_ms),
  ).toBeGreaterThanOrEqual(
    Number(object(object(writerBefore.registerSkill).synchronous).total_ms),
  );
  expect(object(writerBefore.saveAction)).toMatchObject({
    calls: 30,
    synchronous: { span_kind: "call_to_return_host_blocking", calls: 30 },
    asynchronous: { span_kind: "call_to_settlement", calls: 0 },
  });
  expect(object(writerBefore.advanceHistorySourceBootstrap)).toMatchObject({
    scope: "shared_store_bootstrap",
    calls: 0,
  });
  const syntheticEvents = object(writerBefore.event).calls;
  const unrelated = minecraftRunFixture(f.adapter);
  f.store.saveRun(unrelated);
  f.store.event(
    unrelated.run_id,
    "p13.test_other_scope",
    "Unrelated writer scope must not be attributed to P13",
    null,
  );
  expect(
    object(object(object(f.owner.snapshot().writer).methods).event).calls,
  ).toBe(syntheticEvents);
  await f.owner.close();
  expect(f.store.saveRun).toBe(originals.saveRun);
  expect(f.store.saveAction).toBe(originals.saveAction);
  expect(f.store.advanceHistorySourceBootstrap).toBe(originals.bootstrap);
  expect(f.owner.snapshot()).toMatchObject({
    closed: true,
    learning_closed: true,
    reader_closed: true,
    tasks_joined: true,
  });
});

test("P13 writer instrumentation separates blocking return spans from async settlement and counts actual failures once", async () => {
  const f = await fixture();
  f.owner = await prepareResidentVolumeLoad(options(f));
  const snapshot = f.owner.snapshot(),
    runId = String(snapshot.run_id);
  const receipt = f.store.getAction(runId, String(snapshot.first_action_id))!;
  expect(() =>
    f.store.admitAction(
      runId,
      receipt.view.action_id,
      { kind: "look", yaw: 0, pitch: 0 },
      "skill",
      String(snapshot.execution_id),
      {
        scope: receipt.view.scope!,
        invocation: receipt.view.invocation!,
        compatibility_hash: receipt.view.compatibility_hash!,
      },
    ),
  ).toThrow("Action ID already exists with different content");
  const cancelled = new Error(
    "Actual source publication cancelled at beforeCommit",
  );
  const registration = f.store.registerSkill(
    runId,
    f.selected,
    undefined,
    () => {
      throw cancelled;
    },
  );
  expect(
    await registration.then(
      () => null,
      (error) => error,
    ),
  ).toBe(cancelled);
  const methods = object(object(f.owner.snapshot().writer).methods);
  expect(object(methods.admitAction)).toMatchObject({
    calls: 31,
    failures: 1,
    synchronous: {
      span_kind: "call_to_return_host_blocking",
      calls: 31,
      failures: 1,
    },
    asynchronous: { span_kind: "call_to_settlement", calls: 0, failures: 0 },
  });
  expect(object(methods.registerSkill)).toMatchObject({
    calls: 2,
    failures: 1,
    synchronous: {
      span_kind: "call_to_return_host_blocking",
      calls: 2,
      failures: 0,
    },
    asynchronous: { span_kind: "call_to_settlement", calls: 2, failures: 1 },
  });
  expect(
    Number(object(object(methods.registerSkill).asynchronous).total_ms),
  ).toBeGreaterThanOrEqual(
    Number(object(object(methods.registerSkill).synchronous).total_ms),
  );
  expect(f.store.skills(runId)).toHaveLength(1);
  expect(f.store.historyProjectionCheckpoint(runId)).toBeNull();
});

test("P13 measurement prepares initial raw frontier, makes all five actual updates and reads real bounded pages", async () => {
  // Deliberate real-clock integration: the reader is a separate process, and this case
  // exercises the original absolute 120s cadence/deadline rather than renewing fake time.
  const f = await fixture();
  f.owner = await prepareResidentVolumeLoad(options(f));
  const before = f.owner.snapshot();
  const start = performance.now();
  await f.owner.runMeasurement({
    measurementStart: start,
    measurementEnd: start + 120_000,
    deadlineHostMs: start + 120_000,
    signal: f.signal.signal,
    assertCurrent() {},
  });
  const snapshot = f.owner.snapshot();
  const measured = object(snapshot.measurement);
  expect(measured.submitted).toBe(6);
  expect(measured.settled).toBe(6);
  const invocations = array(measured.invocations).map(object);
  expect(invocations.map((value) => value.offset_ms)).toEqual([
    0, 20_000, 40_000, 60_000, 80_000, 100_000,
  ]);
  expect(invocations.every((value) => value.disposition === "completed")).toBe(
    true,
  );
  expect(invocations[0]!.source_target).toBe(before.raw_source_through);
  for (let index = 1; index < invocations.length; index++) {
    expect(Number(invocations[index]!.source_target)).toBeGreaterThan(
      Number(invocations[index - 1]!.source_target),
    );
    expect(Number(invocations[index]!.settled_host_ms)).toBeLessThan(
      start + 120_000,
    );
  }
  const semantic = object(measured.semantic_check);
  expect(semantic.disposition).toBe("completed");
  expect(Number(semantic.started_host_ms)).toBeGreaterThanOrEqual(
    start + 100_000,
  );
  expect(Number(semantic.completed_host_ms)).toBeLessThan(start + 120_000);
  expect(object(semantic.metric)).toMatchObject({
    confirmed_block_removals: 29,
    inventory_receipts: 29,
    inventory_delta: { oak_log: 29 },
    lossless_record_verified: true,
  });
  expect(object(semantic.evidence)).toMatchObject({
    actions: 30,
    confirmed_effects: 29,
    evidence_status: "confirmed_effects",
    goal_associations: [],
    verified_event_seqs: [],
    lossless_record_verified: true,
  });
  const reads = object(snapshot.reads);
  expect(array(reads.slots)).toHaveLength(60);
  const samples = array(reads.samples).map(object);
  expect(
    samples.some((value) => value.disposition === "pending_first_publication"),
  ).toBe(true);
  for (const sample of samples.filter(
    (value) => value.disposition === "pending_first_publication",
  )) {
    expect(sample.evidence).toBeUndefined();
    expect(object(sample.status).published).toBeNull();
  }
  const published = samples.filter(
    (value) => value.disposition === "published_page",
  );
  expect(published.length).toBeGreaterThan(0);
  for (const sample of published) {
    expect(array(object(sample.evidence).records).length).toBeLessThanOrEqual(
      8,
    );
    expect(
      array(object(sample.feedback).opportunities).length,
    ).toBeLessThanOrEqual(16);
    expect(object(object(sample.status).published).generation).toBeGreaterThan(
      0,
    );
  }
  const metricUpdates = published.flatMap((sample) =>
    array(object(sample.feedback).metrics).map(object),
  );
  expect(
    metricUpdates.some(
      (update) =>
        object(update.metric).confirmed_block_removals === 30 &&
        object(update.metric).inventory_receipts === 30,
    ),
  ).toBe(true);
  expect(
    metricUpdates.some(
      (update) =>
        object(update.metric).confirmed_block_removals === 29 &&
        object(update.metric).inventory_receipts === 29,
    ),
  ).toBe(true);
  expect(array(object(snapshot.memory).slots)).toHaveLength(120);
  expect(array(object(snapshot.memory).samples).length).toBeGreaterThan(0);
  expect(Number(object(snapshot.queue).max_queued)).toBeLessThanOrEqual(8);
  expect(Number(object(snapshot.writer).omitted)).toBeGreaterThan(0);
  const bootstrap = object(
    object(object(snapshot.writer).methods).advanceHistorySourceBootstrap,
  );
  expect(bootstrap.scope).toBe("shared_store_bootstrap");
  expect(Number(bootstrap.calls)).toBeGreaterThan(0);
  expect(object(bootstrap.synchronous).calls).toBe(bootstrap.calls);
  expect(object(bootstrap.asynchronous).calls).toBe(0);
  const updated = f.store.getAction(
    String(snapshot.run_id),
    String(snapshot.first_action_id),
  )!.view;
  expect(updated.status).toBe("unknown");
  expect(updated.result!.evidence).toMatchObject({
    p13_late_revision: 5,
    effect_confirmed: false,
    inventory_receipt_confirmed: false,
    inventory_after: { oak_log: 1 },
  });
  expect(
    f.store.skillExecution(String(snapshot.run_id), {
      execution_id: String(snapshot.execution_id),
    })!.actions,
  ).toBe(30);
  expect(
    f.store.historySourcePage(
      String(snapshot.run_id),
      "action",
      f.store.historySourceHighwater(String(snapshot.run_id)),
      0,
      undefined,
      128,
    ).records,
  ).toHaveLength(30);
  await f.owner.close();
  const closed = f.owner.snapshot();
  expect(closed).toMatchObject({
    closed: true,
    learning_closed: true,
    reader_closed: true,
    tasks_joined: true,
  });
  const child = object(object(closed.reader_owner).child);
  expect(child.pid).toBeGreaterThan(0);
  expect(child.exitObservedHostMs).toBeNumber();
  expect(child.stdoutDrainObservedHostMs).toBeNumber();
  expect(child.closedHostMs).toBeNumber();
}, 135_000);

test("P13 semantic diagnostic compares five receipt transitions with the actual oracle and published archive, not M acceptance", async () => {
  const f = await fixture();
  f.owner = await prepareResidentVolumeLoad(options(f));
  const snapshot = f.owner.snapshot(),
    runId = String(snapshot.run_id);
  // This separate fixture-only diagnostic deliberately prepares its own projection.
  // It neither runs nor changes the owner's real 120s assay or its preparation contract.
  const reader = new HistoryReader(f.store.readLocation());
  const learning = new ImprovementLearning(f.store, reader);
  const queryOptions = {
    signal: f.signal.signal,
    deadlineHostMs: performance.now() + 30_000,
  };
  try {
    await learning.prepareFeedback(runId, queryOptions);
    const first = f.store.getAction(
      runId,
      String(snapshot.first_action_id),
    )!.view;
    const initial = programEvidence(f.store, runId)[0]!;
    expect(initial).toMatchObject({
      actions: 30,
      confirmed_effects: 30,
      evidence_status: "verified_goal",
    });
    expect(initial.goal_associations).toHaveLength(1);
    expect(initial.verified_event_seqs).toHaveLength(1);
    for (let index = 0; index < 5; index++) {
      const action = structuredClone(first),
        unknown = index % 2 === 0;
      action.status = unknown ? "unknown" : "succeeded";
      action.result = {
        ...action.result!,
        status: action.status,
        evidence: {
          ...object(action.result!.evidence),
          effect_confirmed: !unknown,
          inventory_receipt_confirmed: !unknown,
        },
      };
      f.store.saveAction(runId, action);
      await learning.prepareFeedback(runId, queryOptions);
    }
    const oracle = programEvidence(f.store, runId)[0]!;
    const status = await reader.query(
      { kind: "projection_status", run_id: runId },
      queryOptions,
    );
    expect(status.published).not.toBeNull();
    const page = await reader.query(
      {
        kind: "export_page",
        run_id: runId,
        collection: "program_evidence",
        execution_id: String(snapshot.execution_id),
        generation: status.published!.generation,
        after: { record_index: 0, chunk_index: 0 },
        limit: 8,
      },
      queryOptions,
    );
    expect(page).toMatchObject({ total: 1, has_more: false, omissions: [] });
    expect(page.records).toHaveLength(1);
    const published = object(page.records[0]);
    expect(published.kind).not.toBe("json_record_chunk");
    expect(published).toEqual(JSON.parse(JSON.stringify(oracle)));
    const metrics = object(published.metrics);
    const proof = {
      actions: published.actions,
      confirmed_effects: published.confirmed_effects,
      evidence_status: published.evidence_status,
      goal_associations: published.goal_associations,
      verified_event_seqs: published.verified_event_seqs,
      metric_counters: {
        confirmed_block_removals: metrics.confirmed_block_removals,
        inventory_receipts: metrics.inventory_receipts,
        inventory_delta: metrics.inventory_delta,
      },
    };
    expect(proof).toMatchObject({
      actions: 30,
      confirmed_effects: 29,
      evidence_status: "confirmed_effects",
      goal_associations: [],
      verified_event_seqs: [],
      metric_counters: {
        confirmed_block_removals: 29,
        inventory_receipts: 29,
        inventory_delta: { oak_log: 29 },
      },
    });
  } finally {
    await learning.close();
  }
});

test("P13 cancellation aborts measurement immediately and joins actual reader exit and stdout drain before Store close", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<Record<string, Json>>();
  const input = options(f),
    note = input.note;
  let startedEvents = 0;
  input.note = (kind, details) => {
    note(kind, details);
    if (kind === "p13_volume_reader_started") {
      startedEvents++;
      started.resolve(details);
    }
  };
  f.owner = await prepareResidentVolumeLoad(input);
  const start = performance.now();
  const measurement = f.owner.runMeasurement({
    measurementStart: start,
    measurementEnd: start + 120_000,
    deadlineHostMs: start + 120_000,
    signal: f.signal.signal,
    assertCurrent() {},
  });
  const settled = measurement.then(
    () => ({ kind: "resolved" as const }),
    (error) => ({ kind: "rejected" as const, error }),
  );
  const admitted = await Promise.race([
    started.promise.then((details) => ({ kind: "started" as const, details })),
    settled,
  ]);
  if (admitted.kind !== "started")
    throw admitted.kind === "rejected"
      ? admitted.error
      : new Error("Measurement settled before actual reader admission");
  const observedChild = object(object(admitted.details.reader_owner).child);
  expect(observedChild.pid).toBeGreaterThan(0);
  expect(observedChild.closedHostMs).toBeNull();
  const activeMeasurement = object(f.owner.snapshot().measurement);
  expect(activeMeasurement.window_start_host_ms).toBe(start);
  expect(activeMeasurement.window_deadline_host_ms).toBe(start + 120_000);
  expect(activeMeasurement.started_host_ms).toBeNumber();
  expect(activeMeasurement.settled_host_ms).toBeNull();
  expect(activeMeasurement.ended_host_ms).toBeUndefined();
  f.signal.abort(new Error("test native-free parent Stop"));
  const cancelled = await settled;
  expect(cancelled.kind).toBe("rejected");
  if (cancelled.kind === "rejected")
    expect(cancelled.error).toBeInstanceOf(Error);
  await f.owner.close();
  const snapshot = f.owner.snapshot();
  expect(snapshot).toMatchObject({
    closed: true,
    learning_closed: true,
    reader_closed: true,
    tasks_joined: true,
  });
  const measured = object(snapshot.measurement);
  expect(measured.settled_host_ms).toBeNumber();
  expect(Number(measured.settled_host_ms)).toBeGreaterThanOrEqual(
    Number(measured.started_host_ms),
  );
  expect(Number(measured.settled_host_ms)).toBeLessThan(
    Number(measured.window_deadline_host_ms),
  );
  const child = object(object(snapshot.reader_owner).child);
  expect(child.exitObservedHostMs).not.toBeNull();
  expect(child.stdoutDrainObservedHostMs).not.toBeNull();
  expect(child.closedHostMs).not.toBeNull();
  expect(Number(object(snapshot.queue).submitted)).toBe(
    Number(object(snapshot.queue).settled),
  );
  expect(startedEvents).toBe(1);
  expect(
    array(object(snapshot.reads).slots).some(
      (value) => object(value).disposition === "not_run",
    ),
  ).toBe(true);
  expect(f.store.getRun(String(snapshot.run_id))).not.toBeNull();
});

test("P13 expired original measurement deadline does not start a preparation or renew time", async () => {
  const f = await fixture();
  f.owner = await prepareResidentVolumeLoad(options(f));
  const start = performance.now();
  await expect(
    f.owner.runMeasurement({
      measurementStart: start,
      measurementEnd: start + 120_000,
      deadlineHostMs: start - 1,
      signal: f.signal.signal,
      assertCurrent() {},
    }),
  ).rejects.toThrow("original deadline expired");
  expect(object(f.owner.snapshot().measurement).submitted).toBe(0);
  expect(
    f.store.historyProjectionCheckpoint(String(f.owner.snapshot().run_id)),
  ).toBeNull();
  await f.owner.close();
  expect(f.owner.snapshot()).toMatchObject({
    closed: true,
    learning_closed: true,
    reader_closed: true,
    tasks_joined: true,
  });
});

test("P13 accepts an absolute full window even when subtracting fractional endpoints rounds below 120 seconds", async () => {
  const f = await fixture();
  f.owner = await prepareResidentVolumeLoad(options(f));
  const start = 123456.789;
  await expect(
    f.owner.runMeasurement({
      measurementStart: start,
      measurementEnd: start + 120_000,
      deadlineHostMs: performance.now() - 1,
      signal: f.signal.signal,
      assertCurrent() {},
    }),
  ).rejects.toThrow("original deadline expired");
  const snapshot = f.owner.snapshot();
  expect(object(snapshot.measurement).submitted).toBe(0);
  expect(object(snapshot.reader_owner).child).toBeNull();
  await f.owner.close();
});

test("P13 raw preparation cancellation after the fixed 16-action turn retains partial evidence and restores wrappers", async () => {
  const f = await fixture();
  const save = f.store.saveAction;
  const input = options(f),
    note = input.note;
  let syntheticRunId: string | null = null;
  input.note = (kind, details) => {
    note(kind, details);
    if (kind === "p13_volume_snapshot") syntheticRunId = String(details.run_id);
  };
  input.assertCurrent = () => {
    if (!syntheticRunId || !f.store.getRun(syntheticRunId)) return;
    const through = f.store.historySourceHighwater(syntheticRunId);
    if (
      f.store.historySourcePage(
        syntheticRunId,
        "action",
        through,
        0,
        undefined,
        16,
      ).records.length === 16
    )
      f.signal.abort(new Error("cancel preparation at admitted raw turn"));
  };
  await expect(prepareResidentVolumeLoad(input)).rejects.toThrow(
    "cancel preparation",
  );
  const last = f.snapshots.at(-1)!;
  expect(last.seeded_actions).toBe(16);
  expect(last.prepared).toBe(false);
  expect(last).toMatchObject({
    closed: true,
    learning_closed: true,
    reader_closed: true,
    tasks_joined: true,
  });
  expect(object(last.reader_owner).child).toBeNull();
  expect(f.store.saveAction).toBe(save);
  expect(f.store.historyProjectionCheckpoint(String(last.run_id))).toBeNull();
});

test("P13 empty receipts or missing helper-produced facts fail rather than silently qualifying an empty corpus", async () => {
  const f = await fixture();
  const effect = spyOn(f.adapter, "effectEvidence").mockReturnValue([]);
  try {
    await expect(prepareResidentVolumeLoad(options(f))).rejects.toThrow(
      "nonempty receipt did not produce actual adapter facts",
    );
    const last = f.snapshots.at(-1)!;
    expect(last.prepared).toBe(false);
    expect(last).toMatchObject({
      closed: true,
      learning_closed: true,
      reader_closed: true,
      tasks_joined: true,
    });
    expect(object(last.measurement).submitted).toBe(0);
  } finally {
    effect.mockRestore();
  }
});
