import { afterEach, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { Store, type StoredRun } from "../src/server/store.ts";
import { HistoryReader } from "../src/server/history-reader.ts";
import { ImprovementLearning } from "../src/server/improvement-learning.ts";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import {
  programEvidence,
  type DetailedProgramEvidence,
} from "../src/server/program-evidence.ts";
import { ExecutionTrace } from "../src/server/execution-trace.ts";
import {
  prepareHistoryProjectionBatch,
  type HistoryProjectionBatch,
} from "../src/server/history-projection.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import { jsonSchema } from "../src/shared/primitives.ts";
import type { ActionView, GameAction, Json } from "../src/shared/contracts.ts";
import type {
  ImprovementFeedbackCursor,
  ObjectiveMetrics,
} from "../src/shared/execution-evidence.ts";
import type { MinecraftObservation } from "../src/shared/minecraft.ts";
import type { SkillExecutionView, SkillView } from "../src/shared/programs.ts";
import { DEFAULT_SKILL_LIMITS } from "../src/shared/programs.ts";
import {
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";
import {
  minecraftObservationFixture,
  minecraftTestAdapter,
  skillAuthorityFixture,
} from "./helpers/adapter-contract.ts";

const NOW = Date.parse("2020-01-01T00:00:02.000Z");
const adapter = minecraftTestAdapter();
const initialCursor = () => ({
  schema_version: 2 as const,
  opportunity_change_seq: 0,
  metric_change_seq: 0,
  scope_hash: null,
});
const options = () => ({ deadlineHostMs: performance.now() + 120_000 });
interface Fixture {
  store: Store;
  reader: HistoryReader;
  run: StoredRun;
  skill: SkillView;
  cleanup(): void;
  reopen(): Promise<void>;
}
const resources: Fixture[] = [];
afterEach(async () => {
  for (const fixture of resources.splice(0)) {
    try {
      await fixture.reader.close();
    } finally {
      try {
        fixture.store.close();
      } finally {
        fixture.cleanup();
      }
    }
  }
  vi.restoreAllMocks();
});
async function createFixture() {
  const original = historyFixture();
  const skill = await original.store.registerSkill(
    original.run.run_id,
    historySpec(original.run),
  );
  const fixture = {
    store: original.store,
    reader: new HistoryReader(original.store.readLocation()),
    run: original.run,
    skill,
    cleanup: original.close,
    async reopen() {
      await fixture.reader.close();
      fixture.store.close();
      fixture.store = new Store(original.directory);
      fixture.reader = new HistoryReader(fixture.store.readLocation());
    },
  };
  resources.push(fixture);
  return fixture;
}
function execution(f: Fixture, parent?: SkillExecutionView) {
  return historyExecution(f.store, f.run, f.skill, parent);
}
function closeUnknown(f: Fixture, owner: SkillExecutionView) {
  owner.status = "unknown";
  owner.result = null;
  owner.ended_at = "2020-01-01T00:00:01.000Z";
  f.store.updateSkillExecution(
    owner,
    "skill.closed",
    "Storage-only unknown closure",
  );
}
function admit(
  f: Fixture,
  owner: SkillExecutionView,
  request: GameAction = { kind: "look", yaw: 0, pitch: 0 },
) {
  return f.store.admitAction(
    f.run.run_id,
    crypto.randomUUID(),
    request,
    "skill",
    owner.execution_id,
    skillAuthorityFixture(f.run, owner),
  ).action.view;
}
function save(
  f: Fixture,
  action: ActionView,
  evidence: Json,
  status: "succeeded" | "unknown" = "succeeded",
) {
  action.status = status;
  action.ended_at = "2020-01-01T00:00:00.010Z";
  action.result = {
    status,
    summary: "Storage-only retained receipt",
    evidence,
  };
  f.store.saveAction(f.run.run_id, action);
  return f.store.eventsAfter(f.run.run_id, f.store.lastEventSeq() - 1, 1)[0]!
    .event_seq;
}
function dig(f: Fixture, owner: SkillExecutionView) {
  return admit(f, owner, {
    kind: "dig",
    target: {
      target_id: "same-retained-target",
      incarnation: 1,
      life_id: f.run.life_id!,
      space: {
        dimension_id: "minecraft:overworld",
        space_epoch: f.run.space_epoch!,
      },
    },
  });
}
const removal = {
  effect_confirmed: true,
  block_removed: true,
  source: "server_block_update",
  target_name: "oak_log",
};
async function prepare(f: Fixture) {
  await new ImprovementLearning(f.store, f.reader).prepareFeedback(
    f.run.run_id,
    options(),
  );
}
async function prepareBounded(f: Fixture, workLimit: 1 | 2) {
  while (!f.store.advanceHistorySourceBootstrap(128).complete) {
    /* Writer-owned source bootstrap. */
  }
  const desired = f.store.historySourceHighwater(f.run.run_id);
  let checkpoint = f.store.beginHistoryProjection(f.run.run_id, desired);
  for (let batches = 0; batches < 100_000; batches++) {
    const batch = await f.reader.query(
      {
        kind: "projection_batch",
        run_id: f.run.run_id,
        checkpoint,
        work_limit: workLimit,
      },
      options(),
    );
    f.store.commitHistoryProjectionBatch(f.run.run_id, batch);
    checkpoint = batch.after;
    if (!batch.has_more) {
      if (checkpoint.source_through >= desired) return batch;
      checkpoint = f.store.beginHistoryProjection(f.run.run_id, desired);
    }
  }
  throw new Error(
    "Finite bounded fixture did not publish its captured source frontier",
  );
}
for (const kind of ["action", "trace"] as const) {
  test(`${kind} retraction persists a forward removal cursor across discarded previews and reopen`, async () => {
    const f = await createFixture(),
      owner = execution(f);
    const action = admit(f, owner);
    save(f, action, {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_before: {},
      inventory_after: Object.fromEntries(
        Array.from({ length: 96 }, (_, index) => [`item_${index}`, 1]),
      ),
    });
    const trace = new ExecutionTrace(f.store);
    let firstTrace = 0;
    for (let index = 0; index < 36; index++) {
      const record = trace.record(owner, "span", {
        clock: "same_process_monotonic",
        category: "native_action",
        duration_ms: index + 1,
      })!;
      firstTrace ||= record.trace_seq;
    }
    closeUnknown(f, owner);
    await prepare(f);
    if (kind === "action") {
      save(f, action, {
        effect_confirmed: true,
        inventory_receipt_confirmed: true,
        inventory_before: {},
        inventory_after: { retained: 7 },
      });
    } else {
      const database = new Database(f.store.readLocation().database);
      try {
        database
          .query(
            "UPDATE execution_trace SET payload=json_set(payload,'$.payload.duration_ms',10) WHERE run_id=? AND trace_seq=?",
          )
          .run(f.run.run_id, firstTrace);
      } finally {
        database.close();
      }
    }
    let checkpoint = f.store.beginHistoryProjection(f.run.run_id);
    let readonly = new ReadonlyStore(f.store.readLocation());
    let noAfter = 0,
      removalPages = 0,
      reopened = false,
      published = false;
    const active = () => {
      const value = checkpoint.job.objective;
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
    };
    const instrument = () => {
      const page = readonly.historyProjectionRows.bind(readonly);
      readonly.historyProjectionRows = (runId, revision, query) => {
        if (
          active()?.type === kind &&
          active()?.phase === "remove" &&
          query.collection ===
            (kind === "action" ? "action_item" : "trace_applied")
        ) {
          removalPages++;
          if (!query.after) noAfter++;
        }
        return page(runId, revision, query);
      };
    };
    instrument();
    try {
      for (let batches = 0; batches < 2000; batches++) {
        const batch = readonly.snapshot(() =>
          prepareHistoryProjectionBatch(readonly, f.run.run_id, checkpoint, 2),
        );
        f.store.commitHistoryProjectionBatch(f.run.run_id, batch);
        checkpoint = batch.after;
        if (
          !reopened &&
          active()?.type === kind &&
          active()?.phase === "remove" &&
          active()?.after
        ) {
          const persisted = structuredClone(checkpoint);
          readonly.snapshot(() =>
            prepareHistoryProjectionBatch(
              readonly,
              f.run.run_id,
              checkpoint,
              2,
            ),
          );
          expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
            persisted,
          );
          readonly.close();
          await f.reopen();
          readonly = new ReadonlyStore(f.store.readLocation());
          instrument();
          expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
            persisted,
          );
          reopened = true;
        }
        if (!batch.has_more) {
          published = true;
          break;
        }
      }
    } finally {
      readonly.close();
    }
    expect(published).toBe(true);
    expect(reopened).toBe(true);
    expect(removalPages).toBeGreaterThan(10);
    expect(noAfter).toBeLessThanOrEqual(1);
    const metric = row(await read(f), owner).metrics;
    if (kind === "action")
      expect(metric.inventory_delta).toEqual({ retained: 7 });
    else {
      expect(metric.spans_ms).toEqual({ native_action: 675 });
      expect(metric.span_samples).toEqual({ native_action: 36 });
    }
  });
}
function equivalentMetric(
  actual: ObjectiveMetrics,
  expected: ObjectiveMetrics,
) {
  // Only descriptive floating fields receive the support-contract tolerance.
  const {
    sampled_travel_distance: ad,
    sampled_rotation_degrees: ar,
    receipted_travel_distance: at,
    receipted_rotation_degrees: ay,
    spans_ms: as,
    ...a
  } = actual;
  const {
    sampled_travel_distance: ed,
    sampled_rotation_degrees: er,
    receipted_travel_distance: et,
    receipted_rotation_degrees: ey,
    spans_ms: es,
    ...e
  } = expected;
  expect(a).toEqual(e);
  const near = (x: number, y: number, absolute: number) =>
    expect(Math.abs(x - y)).toBeLessThanOrEqual(absolute + Math.abs(y) * 1e-12);
  for (const [x, y] of [
    [ad, ed],
    [ar, er],
    [at, et],
    [ay, ey],
  ])
    near(x!, y!, 1e-9);
  expect(Object.keys(as).sort()).toEqual(Object.keys(es).sort());
  for (const key of Object.keys(es))
    near(as[key as keyof typeof as]!, es[key as keyof typeof es]!, 1e-6);
}
async function read(f: Fixture, complete = true) {
  const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
  const source = f.store.historySourceHighwater(f.run.run_id);
  const published = f.store.historyProjectionGeneration(f.run.run_id)!;
  const events = f.store.lastEventSeq();
  const opportunities = f.store.opportunityUpdates(f.run.run_id);
  const rows: DetailedProgramEvidence[] = [];
  let after = 0;
  for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
    const page = await f.reader.query(
      { kind: "operator_evidence", run_id: f.run.run_id, after, limit: 2 },
      options(),
    );
    expect(page.omissions).toEqual([]);
    expect(page.projection.source_through).toBe(published.source_through);
    expect(page.projection.source_available).toBe(source);
    expect(page.projection.has_pending).toBe(!complete);
    if (complete) expect(page.projection.source_through).toBe(source);
    rows.push(...page.records);
    if (!page.has_more) break;
    expect(page.next_after).toBeGreaterThan(after);
    after = page.next_after;
    if (pageIndex === 999) throw new Error("Evidence paging did not drain");
  }
  const snapshot = f.store.historySnapshot(
    f.run.run_id,
    published.source_through,
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  let oracle: DetailedProgramEvidence[];
  try {
    oracle = programEvidence(snapshot, f.run.run_id);
  } finally {
    clock.mockRestore();
  }
  expect(rows.map((row) => row.execution_id)).toEqual(
    oracle.map((row) => row.execution_id),
  );
  for (const row of rows) {
    const expected = oracle.find(
      (value) => value.execution_id === row.execution_id,
    )!;
    equivalentMetric(row.metrics, expected.metrics);
    equivalentMetric(
      row.metrics,
      objectiveMetrics(snapshot, f.run.run_id).find(
        (value) => value.execution_id === row.execution_id,
      )!,
    );
    const { metrics: _am, duration_ms: _ad, ...actualEvidence } = row;
    const { metrics: _em, duration_ms: _ed, ...expectedEvidence } = expected;
    expect(actualEvidence).toEqual(expectedEvidence);
    const owner = snapshot.skillExecution(f.run.run_id, {
      execution_id: row.execution_id,
    })!;
    if (owner.ended_at || !owner.started_at)
      expect(row.duration_ms).toBe(expected.duration_ms);
  }
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  expect(f.store.historySourceHighwater(f.run.run_id)).toBe(source);
  expect(f.store.lastEventSeq()).toBe(events);
  expect(f.store.opportunityUpdates(f.run.run_id)).toEqual(opportunities);
  return new Map(rows.map((row) => [row.execution_id, row]));
}

for (const variant of [
  "replace",
  "retract",
  "zero_key",
  "remove_position",
] as const) {
  for (const reopenBeforeMutation of [false, true]) {
    test(`closed middle receipt ${variant}, mutation ${reopenBeforeMutation ? "after reopen" : "while open"}`, async () => {
      const f = await createFixture(),
        owner = execution(f);
      const actions = [dig(f, owner), dig(f, owner), dig(f, owner)];
      const position = { x: 0, y: 64, z: 0 };
      const middle = {
        effect_confirmed: true,
        target_position: { ...position, x: 9 },
        inventory_receipt_confirmed: true,
        inventory_before: { stone: 0 },
        inventory_after: { stone: 1 },
        travel_distance: 2,
        native_baseline_receipt_wait_ms: 5,
        native_respawn_readiness_wait_ms: 7,
      };
      const provenance = [
        save(f, actions[0]!, {
          effect_confirmed: true,
          target_position: position,
        }),
        save(f, actions[1]!, middle),
        save(f, actions[2]!, {
          effect_confirmed: true,
          target_position: position,
        }),
      ];
      closeUnknown(f, owner);
      await prepare(f);
      const seed = row(await read(f), owner);
      expect(seed.metrics).toMatchObject({
        inventory_delta: { stone: 1 },
        inventory_receipts: 1,
        receipted_travel_distance: 2,
        motion_receipts: 1,
        spans_ms: { readiness: 12 },
        span_samples: { readiness: 2 },
        target_switches: 0,
        target_position_switches: 2,
      });
      expect(seed.confirmed_effects).toBe(3);
      const seedThrough = f.store.historySourceHighwater(f.run.run_id);
      const feedback = await f.reader.query(
        {
          kind: "operator_feedback",
          run_id: f.run.run_id,
          after: initialCursor(),
          limit: 100,
        },
        options(),
      );
      expect(feedback.has_more).toBe(false);
      if (reopenBeforeMutation) await f.reopen();
      let receipt: Json;
      if (variant === "replace")
        receipt = {
          ...middle,
          target_position: position,
          inventory_after: { stone: 3 },
          travel_distance: 5,
          native_baseline_receipt_wait_ms: 11,
          native_respawn_readiness_wait_ms: 13,
        };
      else if (variant === "retract") receipt = { effect_confirmed: false };
      else if (variant === "zero_key")
        receipt = {
          ...middle,
          inventory_before: { stone: 4 },
          inventory_after: { stone: 4 },
          inventory_delta: { stone: 999 },
        };
      else {
        const { target_position: _position, ...withoutPosition } = middle;
        receipt = withoutPosition;
      }
      save(f, actions[1]!, receipt);
      await prepare(f);
      const oldMetric = objectiveMetrics(
        f.store.historySnapshot(f.run.run_id, seedThrough),
        f.run.run_id,
      )[0]!;
      expect(oldMetric).toMatchObject({
        inventory_delta: { stone: 1 },
        receipted_travel_distance: 2,
        target_position_switches: 2,
        evidence_event_seqs: provenance,
      });
      const changed = row(await read(f), owner);
      expect(changed.metrics).toMatchObject({
        evidence_event_seqs: provenance,
        outcome: "unknown",
        target_switches: 0,
        target_position_switches: variant === "zero_key" ? 2 : 0,
        inventory_delta:
          variant === "retract"
            ? {}
            : {
                stone:
                  variant === "replace" ? 3 : variant === "zero_key" ? 0 : 1,
              },
        inventory_receipts: variant === "retract" ? 0 : 1,
        receipted_travel_distance:
          variant === "replace" ? 5 : variant === "retract" ? 0 : 2,
        motion_receipts: variant === "retract" ? 0 : 1,
        spans_ms:
          variant === "retract"
            ? {}
            : { readiness: variant === "replace" ? 24 : 12 },
        span_samples: variant === "retract" ? {} : { readiness: 2 },
      });
      expect(changed.confirmed_effects).toBe(variant === "retract" ? 2 : 3);
      const continuation = await f.reader.query(
        {
          kind: "operator_feedback",
          run_id: f.run.run_id,
          after: feedback.next_after,
          limit: 100,
        },
        options(),
      );
      const replacement = continuation.metrics
        .filter((value) => value.execution_id === owner.execution_id)
        .at(-1)!;
      expect(replacement.kind).toBe("replace");
      if (replacement.kind !== "replace")
        throw new Error("Expected a metric replacement");
      equivalentMetric(replacement.metric, changed.metrics);
      expect(replacement.revision).toBeGreaterThan(
        feedback.metrics.find(
          (value) => value.execution_id === owner.execution_id,
        )!.revision,
      );
      await f.reopen();
      equivalentMetric(row(await read(f), owner).metrics, changed.metrics);
    });
  }
}

for (const workLimit of [1, 2] as const) {
  test(`first-any objective terminal survives a matching later receipt across 500 events, work limit ${workLimit}`, async () => {
    const f = await createFixture(),
      owner = execution(f);
    const a = dig(f, owner),
      b = dig(f, owner);
    const eA = save(f, a, { effect_confirmed: false }, "unknown");
    const eB = save(f, b, removal);
    closeUnknown(f, owner);
    await prepareBounded(f, workLimit);
    expect(row(await read(f), owner).metrics).toMatchObject({
      confirmed_block_removals: 1,
      evidence_event_seqs: [eA, eB],
    });
    // The decisive current-status-compatible terminal is in a later full-scan page.
    for (let index = 0; index < 500; index++)
      f.store.event(
        f.run.run_id,
        "fixture.unrelated",
        "No action contribution",
        { index },
      );
    await f.reopen();
    save(f, a, removal);
    await prepareBounded(f, workLimit);
    let value = row(await read(f), owner);
    expect(value.metrics).toMatchObject({
      confirmed_block_removals: 2,
      removed_blocks: { oak_log: 2 },
      inventory_delta: {},
      inventory_receipts: 0,
      evidence_event_seqs: [eA, eB],
      outcome: "unknown",
    });
    expect(value.confirmed_effects).toBe(2);
    await f.reopen();
    f.store.event(
      f.run.run_id,
      "action.succeeded",
      "Duplicate terminal without replacing action",
      { action_id: a.action_id },
    );
    const committed = await prepareBounded(f, workLimit);
    value = row(await read(f), owner);
    expect(value.metrics.evidence_event_seqs).toEqual([eA, eB]);
    expect(value.confirmed_effects).toBe(2);
    const beforeReplay = f.store.historyProjectionCheckpoint(f.run.run_id);
    // CAS may reject a stale replay or recognize it as already committed; neither may duplicate anything.
    try {
      f.store.commitHistoryProjectionBatch(f.run.run_id, committed);
    } catch (error) {
      expect(error).toMatchObject({ code: "conflict" });
    }
    expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
      beforeReplay,
    );
    expect(row(await read(f), owner).metrics.confirmed_block_removals).toBe(2);
  }, 180_000);
}

function observation(
  f: Fixture,
  sequence: number,
  x: number,
): MinecraftObservation {
  const sample = minecraftObservationFixture(adapter, {
    world_id: f.run.world_id,
    session_id: f.run.session_id!,
    epoch: f.run.epoch,
    native_boot_id: f.run.native_boot_id!,
    life: {
      life_id: f.run.life_id!,
      status: "alive",
      can_respawn: false,
      death: null,
    },
    space: {
      dimension_id: "minecraft:overworld",
      space_epoch: f.run.space_epoch!,
    },
    observation_seq: sequence,
    captured_at: "2020-01-01T00:00:00.020Z",
  });
  sample.data.player.position.x = x;
  return sample;
}
for (const reopenBeforeMutation of [false, true]) {
  test(`trace dedup is per attributed execution and unseen lower sequences retain order${reopenBeforeMutation ? " after reopen" : ""}`, async () => {
    const f = await createFixture(),
      root = execution(f),
      child = execution(f, root);
    closeUnknown(f, root);
    closeUnknown(f, child);
    let trace = new ExecutionTrace(f.store);
    trace.observe(root, observation(f, 1, 0));
    trace.observe(child, observation(f, 2, 3));
    await prepareBounded(f, 1);
    let values = await read(f);
    expect(row(values, root).metrics).toMatchObject({
      observation_samples: 2,
      sampled_travel_distance: 3,
    });
    expect(row(values, child).metrics).toMatchObject({
      observation_samples: 1,
      sampled_travel_distance: 0,
    });
    if (reopenBeforeMutation) await f.reopen();
    trace = new ExecutionTrace(f.store);
    trace.observe(child, observation(f, 1, 999));
    await prepareBounded(f, 1);
    values = await read(f);
    expect(row(values, root).metrics).toMatchObject({
      observation_samples: 2,
      sampled_travel_distance: 3,
    });
    expect(row(values, child).metrics).toMatchObject({
      observation_samples: 2,
      sampled_travel_distance: 996,
    });
    await f.reopen();
    new ExecutionTrace(f.store).observe(root, observation(f, 3, 4));
    await prepareBounded(f, 2);
    values = await read(f);
    expect(row(values, root).metrics).toMatchObject({
      observation_samples: 3,
      sampled_travel_distance: 4,
      evidence_event_seqs: [],
    });
    expect(row(values, child).metrics).toMatchObject({
      observation_samples: 2,
      sampled_travel_distance: 996,
    });
    await f.reopen();
    expect(row(await read(f), root).metrics.sampled_travel_distance).toBe(4);
  });
}

const scopeAxes = [
  "world",
  "session",
  "epoch",
  "boot",
  "life",
  "dimension",
  "space_epoch",
  "schema",
] as const;
for (const axis of scopeAxes) {
  for (const reopenBeforeMutation of [false, true]) {
    test(`trace ${axis} discontinuity never bridges${reopenBeforeMutation ? " after reopen" : " while open"}, including return to the old scope`, async () => {
      const f = await createFixture(),
        owner = execution(f);
      closeUnknown(f, owner);
      let trace = new ExecutionTrace(f.store);
      const first = observation(f, 1, 0),
        second = observation(f, 2, 3);
      if (axis === "schema") {
        for (const sample of [first, second])
          trace.record(owner, "observation", {
            schema_version: 2,
            world_id: sample.world_id,
            session_id: sample.session_id,
            epoch: sample.epoch,
            life: jsonSchema.parse(sample.life),
            observation_seq: sample.observation_seq,
            captured_at: sample.captured_at,
            profile_id: "player-observable-structured",
            preset_id: "minecraft-observable-initial-r2",
            player: jsonSchema.parse(sample.data.player),
            blocks: [],
            entities: [],
            sounds: [],
            coverage: sample.freshness,
          });
      } else {
        trace.observe(owner, first);
        trace.observe(owner, second);
      }
      await prepare(f);
      expect(row(await read(f), owner).metrics.sampled_travel_distance).toBe(3);
      if (reopenBeforeMutation) await f.reopen();
      trace = new ExecutionTrace(f.store);
      const changed = observation(f, 3, 1000);
      if (axis === "world") changed.world_id = "other-world";
      if (axis === "session") changed.session_id = "other-session";
      if (axis === "epoch") changed.epoch++;
      if (axis === "boot") changed.native_boot_id = "other-boot";
      if (axis === "life") changed.life.life_id++;
      if (axis === "dimension")
        changed.space.dimension_id = "minecraft:the_nether";
      if (axis === "space_epoch") changed.space.space_epoch++;
      trace.observe(owner, changed);
      await prepare(f);
      expect(row(await read(f), owner).metrics).toMatchObject({
        observation_samples: 3,
        sampled_travel_distance: 3,
      });
      await f.reopen();
      const continuation = structuredClone(changed);
      continuation.observation_seq = 4;
      continuation.data.player.position.x = 1002;
      new ExecutionTrace(f.store).observe(owner, continuation);
      await prepare(f);
      expect(row(await read(f), owner).metrics).toMatchObject({
        observation_samples: 4,
        sampled_travel_distance: 5,
      });
      await f.reopen();
      if (axis === "schema") {
        const old = observation(f, 5, 100);
        new ExecutionTrace(f.store).record(owner, "observation", {
          schema_version: 2,
          world_id: old.world_id,
          session_id: old.session_id,
          epoch: old.epoch,
          life: jsonSchema.parse(old.life),
          observation_seq: 5,
          captured_at: old.captured_at,
          profile_id: "player-observable-structured",
          preset_id: "minecraft-observable-initial-r2",
          player: jsonSchema.parse(old.data.player),
          blocks: [],
          entities: [],
          sounds: [],
          coverage: old.freshness,
        });
      } else new ExecutionTrace(f.store).observe(owner, observation(f, 5, 100));
      await prepare(f);
      expect(row(await read(f), owner).metrics).toMatchObject({
        observation_samples: 5,
        sampled_travel_distance: 5,
      });
    });
  }
}

test("shortest wrapped yaw plus pitch survives the observation boundary and reopen", async () => {
  const f = await createFixture(),
    owner = execution(f);
  closeUnknown(f, owner);
  const a = observation(f, 1, 0),
    b = observation(f, 2, 0);
  a.data.player.yaw = (3 * Math.PI) / 4;
  b.data.player.yaw = (-3 * Math.PI) / 4;
  b.data.player.pitch = Math.PI / 4;
  new ExecutionTrace(f.store).observe(owner, a);
  await prepareBounded(f, 1);
  await f.reopen();
  new ExecutionTrace(f.store).observe(owner, b);
  await prepareBounded(f, 2);
  const measured = row(await read(f), owner).metrics;
  expect(measured.observation_samples).toBe(2);
  expect(Math.abs(measured.sampled_rotation_degrees - 135)).toBeLessThanOrEqual(
    1e-9,
  );
});
function row(
  rows: Map<string, DetailedProgramEvidence>,
  owner: SkillExecutionView,
) {
  const value = rows.get(owner.execution_id);
  expect(value).toBeDefined();
  return value!;
}

for (const reopenBeforeMutation of [false, true]) {
  test(`early large-term replacement preserves small later action and trace spans${reopenBeforeMutation ? " after reopen" : ""}`, async () => {
    const f = await createFixture(),
      owner = execution(f);
    const actions = [admit(f, owner), admit(f, owner), admit(f, owner)];
    const provenance = actions.map((action, index) =>
      save(f, action, {
        travel_distance: index === 0 ? 2 ** 53 : 1,
        native_action_ms: index === 0 ? 2 ** 53 : 1,
      }),
    );
    new ExecutionTrace(f.store).span(owner, "native_action", 0, 1);
    closeUnknown(f, owner);
    await prepare(f);
    await read(f);
    if (reopenBeforeMutation) await f.reopen();
    save(f, actions[0]!, { travel_distance: 0, native_action_ms: 0 });
    await prepare(f);
    const corrected = row(await read(f), owner).metrics;
    expect(corrected).toMatchObject({
      receipted_travel_distance: 2,
      motion_receipts: 3,
      spans_ms: { native_action: 3 },
      span_samples: { native_action: 4 },
      evidence_event_seqs: provenance,
      outcome: "unknown",
    });
    await f.reopen();
    equivalentMetric(row(await read(f), owner).metrics, corrected);
  });
}

for (const reopenBeforeMutation of [false, true]) {
  test(`unknown GUI prefix and interrupted actions keep receipt semantics${reopenBeforeMutation ? " after reopen" : ""}`, async () => {
    const f = await createFixture(),
      owner = execution(f);
    const request: GameAction = {
      kind: "screen_input",
      screen: { screen_id: "view", incarnation: 1, layout_revision: 1 },
      operations: [
        {
          kind: "slot",
          slot_id: 0,
          button: "left",
          mode: "ordinary",
          hotbar_slot: null,
          expected_cursor: { item: null, count: 0 },
          expected_slots: [
            { slot_id: 0, value: { item: "crafting_table", count: 1 } },
          ],
        },
      ],
    };
    const gui = admit(f, owner, request),
      unknownDig = dig(f, owner),
      accepted = admit(f, owner),
      running = admit(f, owner);
    const guiSeq = save(
      f,
      gui,
      {
        effect_confirmed: false,
        inventory_receipt_confirmed: true,
        inventory_before: {},
        inventory_after: { fabricated: 999 },
        gui_transactions: [
          {
            kind: "gui_transaction",
            mechanism: "visible_gui",
            operation_index: 0,
            receipt_ref: "server:1:12",
            input_application: "confirmed",
            effect_status: "confirmed",
            inventory_before: { oak_planks: 4 },
            inventory_after: {},
            productions: [
              {
                producer: "crafting",
                item: "crafting_table",
                count: 1,
                source: "server_result_slot_take",
                production_confirmed: true,
              },
            ],
          },
        ],
      },
      "unknown",
    );
    const digSeq = save(f, unknownDig, removal, "unknown");
    running.status = "running";
    running.started_at = "2020-01-01T00:00:00.001Z";
    f.store.saveAction(f.run.run_id, running);
    closeUnknown(f, owner);
    await prepare(f);
    const initial = row(await read(f), owner);
    expect(initial.metrics).toMatchObject({
      inventory_delta: { oak_planks: -4 },
      inventory_receipts: 1,
      confirmed_block_removals: 0,
      removed_blocks: {},
      evidence_event_seqs: [guiSeq, digSeq],
      outcome: "unknown",
    });
    expect(initial.confirmed_effects).toBe(0);
    if (reopenBeforeMutation) await f.reopen();
    f.store.closeUnfinishedActions(f.run.run_id);
    await prepare(f);
    const interrupted = row(await read(f), owner);
    expect(
      f.store.getAction(f.run.run_id, accepted.action_id)!.view.status,
    ).toBe("cancelled");
    expect(
      f.store.getAction(f.run.run_id, running.action_id)!.view.status,
    ).toBe("unknown");
    expect(interrupted.metrics).toMatchObject({
      inventory_delta: { oak_planks: -4 },
      inventory_receipts: 1,
      confirmed_block_removals: 0,
      outcome: "unknown",
    });
    expect(interrupted.metrics.evidence_event_seqs.slice(0, 2)).toEqual([
      guiSeq,
      digSeq,
    ]);
    expect(interrupted.metrics.evidence_event_seqs).toHaveLength(4);
    await f.reopen();
    save(
      f,
      gui,
      {
        effect_confirmed: false,
        inventory_receipt_confirmed: true,
        inventory_delta: { fabricated: 999 },
      },
      "unknown",
    );
    await prepare(f);
    const retracted = row(await read(f), owner);
    expect(retracted.metrics.inventory_delta).toEqual({});
    expect(retracted.metrics.inventory_receipts).toBe(0);
    expect(retracted.confirmed_effects).toBe(0);
    expect(retracted.metrics.evidence_event_seqs).toEqual(
      interrupted.metrics.evidence_event_seqs,
    );
    await f.reopen();
    equivalentMetric(row(await read(f), owner).metrics, retracted.metrics);
  });
}

for (const reopenBeforeMutation of [false, true]) {
  test(`real record budget rejection changes all metrics without a new trace or event${reopenBeforeMutation ? " after reopen" : ""}, including later admissions`, async () => {
    const f = await createFixture(),
      root = execution(f),
      unrelated = execution(f);
    closeUnknown(f, root);
    closeUnknown(f, unrelated);
    const trace = new ExecutionTrace(f.store);
    trace.observe(root, observation(f, 1, 0));
    for (let index = 1; index < 8192; index++) {
      expect(
        trace.record(root, "branch", { diagnostic_only: true, events: [] }),
      ).not.toBeNull();
    }
    save(f, admit(f, root), {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_delta: { stone: 1 },
    });
    await prepare(f);
    let rows = await read(f);
    expect(row(rows, root).metrics).toMatchObject({
      trace_complete: true,
      observation_samples: 1,
      inventory_delta: { stone: 1 },
    });
    expect(row(rows, unrelated).metrics.trace_complete).toBe(true);
    expect(f.store.tracePage(f.run.run_id).budget).toMatchObject({
      recorded: 8192,
      omitted_records: 0,
    });
    if (reopenBeforeMutation) await f.reopen();
    const before = f.store.tracePage(f.run.run_id),
      event = f.store.lastEventSeq(),
      source = f.store.historySourceHighwater(f.run.run_id);
    expect(
      new ExecutionTrace(f.store).observe(root, observation(f, 2, 99)),
    ).toBeNull();
    const after = f.store.tracePage(f.run.run_id);
    expect(after.budget.recorded).toBe(before.budget.recorded);
    expect(after.budget.omitted_records).toBe(1);
    expect(after.next_after).toBe(before.next_after);
    expect(f.store.lastEventSeq()).toBe(event);
    expect(f.store.historySourceHighwater(f.run.run_id)).toBeGreaterThan(
      source,
    );
    await prepare(f);
    rows = await read(f);
    expect(row(rows, root).metrics).toMatchObject({
      trace_complete: false,
      observation_samples: 1,
      sampled_travel_distance: 0,
      inventory_delta: { stone: 1 },
    });
    expect(row(rows, root).evidence_status).toBe("confirmed_effects");
    expect(row(rows, unrelated).metrics.trace_complete).toBe(false);
    await f.reopen();
    const newlyAdmitted = f.store.admitSkill(f.run.run_id, {
      entry: "run",
      skill_id: f.skill.skill_id,
      version: f.skill.version,
      start_key: crypto.randomUUID(),
      epoch: root.epoch,
      session_id: root.session_id!,
      native_boot_id: root.native_boot_id!,
      run_generation: root.run_generation!,
      life_id: root.life_id!,
      space_epoch: root.space_epoch!,
      compatibility_hash: root.compatibility_hash!,
      args: null,
      limits: { ...DEFAULT_SKILL_LIMITS },
    }).view;
    await prepare(f);
    const newMetric = row(await read(f), newlyAdmitted).metrics;
    expect(newMetric).toMatchObject({
      outcome: "accepted",
      trace_complete: false,
      observation_samples: 0,
      sampled_travel_distance: 0,
      evidence_event_seqs: [],
    });
    expect(newMetric.limitations.at(-2)).toBe(
      "No persisted authorized observation samples.",
    );
    expect(newMetric.limitations.at(-1)).toContain("incomplete");
    await f.reopen();
    equivalentMetric(row(await read(f), newlyAdmitted).metrics, newMetric);
  }, 180_000);
}

for (const reopenBeforeMutation of [false, true]) {
  test(`payload and ordered diagnostic omissions do not erase effects or reset retained motion${reopenBeforeMutation ? " after reopen" : ""}`, async () => {
    const f = await createFixture(),
      owner = execution(f);
    closeUnknown(f, owner);
    save(f, admit(f, owner), {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_delta: { stone: 1 },
    });
    let trace = new ExecutionTrace(f.store);
    trace.observe(owner, observation(f, 1, 0));
    await prepare(f);
    if (reopenBeforeMutation) await f.reopen();
    trace = new ExecutionTrace(f.store);
    const oversized = trace.record(owner, "observation", {
      text: "x".repeat(30_000),
    })!;
    expect(oversized.payload).toBeNull();
    expect(oversized.omission?.reason).toBe("record_byte_budget");
    trace.record(owner, "branch", {
      diagnostic_only: true,
      events: [],
      omitted: 3,
      tail_incomplete: false,
    });
    trace.record(owner, "branch", {
      diagnostic_only: true,
      events: [],
      omitted: 0,
      tail_incomplete: true,
      loss_reason: "worker_terminated",
    });
    trace.observe(owner, observation(f, 2, 3));
    await prepare(f);
    const result = row(await read(f), owner);
    expect(result.metrics).toMatchObject({
      observation_samples: 2,
      sampled_travel_distance: 3,
      trace_complete: false,
      inventory_delta: { stone: 1 },
    });
    expect(result.evidence_status).toBe("confirmed_effects");
    expect(
      result.metrics.limitations.filter((text) =>
        text.includes("Source-branch"),
      ),
    ).toEqual([
      "Source-branch diagnostic decisions were omitted by the worker budget; gameplay receipt validity is unchanged.",
      "Source-branch diagnostic tail is incomplete (worker_terminated); missing decision count is unknown and gameplay receipt validity is unchanged.",
    ]);
    await f.reopen();
    equivalentMetric(row(await read(f), owner).metrics, result.metrics);
  });
}

test("failed publication rolls back opportunity, derived writes and checkpoint; reopen retries the same source once", async () => {
  const f = await createFixture(),
    owner = execution(f);
  await prepare(f);
  const seeded = row(await read(f), owner);
  expect(seeded.metrics.outcome).toBe("running");
  const feedback = await f.reader.query(
    {
      kind: "operator_feedback",
      run_id: f.run.run_id,
      after: initialCursor(),
      limit: 100,
    },
    options(),
  );
  expect(feedback.has_more).toBe(false);
  await f.reopen();
  closeUnknown(f, owner);
  const database = new Database(f.store.readLocation().projection!);
  let failed: HistoryProjectionBatch | undefined;
  try {
    database.exec(`CREATE TRIGGER incremental_objective_publish_fault AFTER INSERT ON evidence_objects
      WHEN NEW.kind='opportunity' BEGIN SELECT RAISE(ABORT,'projection publication fault'); END`);
    let checkpoint = f.store.beginHistoryProjection(f.run.run_id);
    for (let index = 0; index < 10_000; index++) {
      const batch = await f.reader.query(
        {
          kind: "projection_batch",
          run_id: f.run.run_id,
          checkpoint,
          work_limit: 2,
        },
        options(),
      );
      const before = f.store.historyProjectionCheckpoint(f.run.run_id);
      const published = f.store.historyProjectionGeneration(f.run.run_id);
      const opportunities = f.store.opportunityUpdates(f.run.run_id);
      try {
        f.store.commitHistoryProjectionBatch(f.run.run_id, batch);
      } catch (error) {
        expect(String(error)).toContain("projection publication fault");
        expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
          before,
        );
        expect(f.store.historyProjectionGeneration(f.run.run_id)).toEqual(
          published,
        );
        expect(f.store.opportunityUpdates(f.run.run_id)).toEqual(opportunities);
        expect(f.store.opportunityCount(f.run.run_id)).toBe(0);
        failed = batch;
        break;
      }
      checkpoint = batch.after;
      if (!batch.has_more)
        throw new Error("Failure opportunity was never offered to the writer");
    }
    expect(failed).toBeDefined();
    expect(row(await read(f, false), owner).metrics.outcome).toBe("running");
    const partial = await f.reader.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: feedback.next_after,
        limit: 100,
      },
      options(),
    );
    expect(partial.metrics).toEqual([]);
    expect(partial.opportunities).toEqual([]);
    expect(partial.projection.has_pending).toBe(true);
    database.exec("DROP TRIGGER incremental_objective_publish_fault");
  } finally {
    database.close(true);
  }
  await f.reopen();
  // Reopening must retain precisely the checkpoint against which this failed preview was computed.
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(
    failed!.before,
  );
  f.store.commitHistoryProjectionBatch(f.run.run_id, failed!);
  await prepare(f);
  const published = row(await read(f), owner);
  expect(published.metrics.outcome).toBe("unknown");
  const final = await f.reader.query(
    {
      kind: "operator_feedback",
      run_id: f.run.run_id,
      after: feedback.next_after,
      limit: 100,
    },
    options(),
  );
  expect(
    final.metrics.filter((value) => value.execution_id === owner.execution_id),
  ).toHaveLength(1);
  expect(final.metrics[0]).toMatchObject({
    kind: "replace",
    metric: { outcome: "unknown" },
  });
  expect(final.opportunities).toHaveLength(1);
  expect(final.opportunities[0]!.execution_id).toBe(owner.execution_id);
  expect(final.has_more).toBe(false);
  expect(f.store.opportunityCount(f.run.run_id)).toBe(1);
  const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
  try {
    f.store.commitHistoryProjectionBatch(f.run.run_id, failed!);
  } catch (error) {
    expect(error).toMatchObject({ code: "conflict" });
  }
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  await f.reopen();
  await prepare(f);
  expect(f.store.opportunityCount(f.run.run_id)).toBe(1);
  const drained = await f.reader.query(
    {
      kind: "operator_feedback",
      run_id: f.run.run_id,
      after: final.next_after,
      limit: 100,
    },
    options(),
  );
  expect(drained.metrics).toEqual([]);
  expect(drained.opportunities).toEqual([]);
  expect(drained.has_more).toBe(false);
});

test("feedback byte paging advances only delivered or explicitly referenced oversized metrics; archive resolves the omission", async () => {
  const f = await createFixture(),
    first = execution(f),
    second = execution(f),
    oversized = execution(f);
  const counts = (length: number) =>
    Object.fromEntries(
      Array.from({ length }, (_, index) => [`fixture_item_${index}`, 1]),
    );
  for (const [owner, size] of [
    [first, 2000],
    [second, 800],
    [oversized, 3500],
  ] as const) {
    save(f, admit(f, owner), {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_before: {},
      inventory_after: counts(size),
    });
    closeUnknown(f, owner);
  }
  await prepare(f);
  await f.reopen();
  const through = f.store.historySourceHighwater(f.run.run_id);
  const expected = objectiveMetrics(
    f.store.historySnapshot(f.run.run_id, through),
    f.run.run_id,
  );
  const checkpoint = f.store.historyProjectionCheckpoint(f.run.run_id);
  let cursor: ImprovementFeedbackCursor = initialCursor();
  const delivered: string[] = [],
    omitted: string[] = [];
  let omissionGeneration: number | undefined;
  for (let index = 0; index < 100; index++) {
    const page = await f.reader.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: cursor,
        limit: 100,
      },
      options(),
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: page }) +
          "\n",
      ),
    ).toBeLessThanOrEqual(65536);
    for (const replacement of page.metrics) {
      delivered.push(replacement.execution_id);
      expect(replacement.kind).toBe("replace");
      if (replacement.kind !== "replace")
        throw new Error("Expected a metric replacement");
      equivalentMetric(
        replacement.metric,
        expected.find(
          (value) => value.execution_id === replacement.execution_id,
        )!,
      );
    }
    for (const omission of page.omitted) {
      expect(omission).toMatchObject({
        kind: "metric",
        id: oversized.execution_id,
        reason: "record_byte_budget",
      });
      expect(omission.original_bytes).toBeGreaterThan(48000);
      expect(Buffer.byteLength(JSON.stringify(omission))).toBeLessThan(1024);
      expect(omission.reference).toMatchObject({
        run_id: f.run.run_id,
        execution_id: oversized.execution_id,
      });
      const reference = omission.reference;
      if (
        !reference ||
        typeof reference !== "object" ||
        Array.isArray(reference) ||
        typeof reference.generation !== "number"
      )
        throw new Error(
          "Metric omission must resolve an exact retained generation",
        );
      omissionGeneration = reference.generation;
      omitted.push(omission.id);
    }
    const progress =
      page.next_after.metric_change_seq - cursor.metric_change_seq;
    expect(progress > 0 || !page.has_more).toBe(true);
    if (page.metrics.length === 0 && page.omitted.length === 0)
      expect(progress).toBe(0);
    cursor = page.next_after;
    if (!page.has_more) break;
    if (index === 99) throw new Error("Finite feedback fixture did not drain");
  }
  expect(delivered).toHaveLength(2);
  expect(new Set(delivered)).toEqual(
    new Set([first.execution_id, second.execution_id]),
  );
  expect(omitted).toEqual([oversized.execution_id]);
  expect(omissionGeneration).toBeNumber();
  const evidence = await f.reader.query(
    { kind: "operator_evidence", run_id: f.run.run_id, after: 2, limit: 1 },
    options(),
  );
  expect(evidence.records).toEqual([]);
  expect(evidence.omissions).toHaveLength(1);
  expect(evidence.omissions[0]).toMatchObject({
    index: 2,
    reason: "record_byte_budget",
  });
  expect(evidence.omissions[0]!.original_bytes).toBeGreaterThan(48000);
  expect(evidence.next_after).toBe(3);
  expect(evidence.has_more).toBe(false);
  expect(evidence.total).toBe(3);
  let after = { record_index: 0, chunk_index: 0 };
  const chunks: string[] = [];
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await f.reader.query(
      {
        kind: "export_page",
        run_id: f.run.run_id,
        collection: "objective_metrics",
        execution_id: oversized.execution_id,
        generation: omissionGeneration!,
        after,
        limit: 1,
      },
      options(),
    );
    expect(page.omissions).toEqual([]);
    expect(
      Buffer.byteLength(
        JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value: page }) +
          "\n",
      ),
    ).toBeLessThanOrEqual(65536);
    expect(page.records).toHaveLength(1);
    const chunk = page.records[0];
    if (
      !chunk ||
      typeof chunk !== "object" ||
      Array.isArray(chunk) ||
      typeof chunk.text !== "string"
    )
      throw new Error(
        "Oversized metric must remain losslessly retrievable as bounded archive chunks",
      );
    expect(chunk).toMatchObject({
      kind: "json_record_chunk",
      collection: "objective_metrics",
      record_index: 0,
      chunk_index: chunks.length,
    });
    chunks.push(chunk.text);
    after = page.next_after;
    if (!page.has_more) break;
    if (pageIndex === 99)
      throw new Error("Metric archive chunks did not drain");
  }
  equivalentMetric(
    JSON.parse(chunks.join("")),
    expected.find((value) => value.execution_id === oversized.execution_id)!,
  );
  expect(f.store.historyProjectionCheckpoint(f.run.run_id)).toEqual(checkpoint);
  expect(f.store.historySourceHighwater(f.run.run_id)).toBe(through);
  await f.reopen();
  const drained = await f.reader.query(
    {
      kind: "operator_feedback",
      run_id: f.run.run_id,
      after: cursor,
      limit: 100,
    },
    options(),
  );
  expect(drained.metrics).toEqual([]);
  expect(drained.omitted).toEqual([]);
  expect(drained.has_more).toBe(false);
}, 180_000);

for (const reopenBeforeMutation of [false, true]) {
  test(`direct execution recovery publishes cancelled versus unknown replacements${reopenBeforeMutation ? " after reopen" : ""}`, async () => {
    const f = await createFixture(),
      running = execution(f);
    const accepted = f.store.admitSkill(f.run.run_id, {
      entry: "run",
      skill_id: f.skill.skill_id,
      version: f.skill.version,
      start_key: crypto.randomUUID(),
      epoch: running.epoch,
      session_id: running.session_id!,
      native_boot_id: running.native_boot_id!,
      run_generation: running.run_generation!,
      life_id: running.life_id!,
      space_epoch: running.space_epoch!,
      compatibility_hash: running.compatibility_hash!,
      args: null,
      limits: { ...DEFAULT_SKILL_LIMITS },
    }).view;
    await prepare(f);
    const before = await f.reader.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: initialCursor(),
        limit: 100,
      },
      options(),
    );
    expect(before.has_more).toBe(false);
    expect(row(await read(f), accepted).metrics.outcome).toBe("accepted");
    if (reopenBeforeMutation) await f.reopen();
    f.store.reconcileSkillExecutions(f.run.run_id);
    await prepare(f);
    const recovered = await read(f);
    expect(row(recovered, accepted).metrics).toMatchObject({
      outcome: "cancelled",
      inventory_delta: {},
      confirmed_block_removals: 0,
      evidence_event_seqs: [],
    });
    expect(row(recovered, accepted).duration_ms).toBeNull();
    expect(row(recovered, running).metrics).toMatchObject({
      outcome: "unknown",
      inventory_delta: {},
      confirmed_block_removals: 0,
      evidence_event_seqs: [],
    });
    const after = await f.reader.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: before.next_after,
        limit: 100,
      },
      options(),
    );
    expect(
      after.metrics
        .map((value) => {
          if (value.kind !== "replace")
            throw new Error("Expected recovery to replace the retained metric");
          return [value.execution_id, value.metric.outcome];
        })
        .sort(),
    ).toEqual(
      [
        [accepted.execution_id, "cancelled"],
        [running.execution_id, "unknown"],
      ].sort(),
    );
    await f.reopen();
    equivalentMetric(
      row(await read(f), accepted).metrics,
      row(recovered, accepted).metrics,
    );
    equivalentMetric(
      row(await read(f), running).metrics,
      row(recovered, running).metrics,
    );
  });
}

test("missing immutable request targets and receipt positions do not reset ordered streams", async () => {
  const f = await createFixture(),
    owner = execution(f);
  const first = dig(f, owner),
    missing = admit(f, owner),
    last = dig(f, owner);
  const firstSequence = save(f, first, {
    target_position: { x: 0, y: 64, z: 0 },
  });
  const missingSequence = save(f, missing, { travel_distance: 0 });
  const lastSequence = save(f, last, {
    target_position: { x: 3, y: 64, z: 0 },
  });
  closeUnknown(f, owner);
  await prepare(f);
  const seed = row(await read(f), owner).metrics;
  expect(seed).toMatchObject({
    target_switches: 0,
    target_position_switches: 1,
    evidence_event_seqs: [firstSequence, missingSequence, lastSequence],
  });
  await f.reopen();
  save(f, last, { target_position: { x: 0, y: 64, z: 0 }, travel_distance: 0 });
  await prepare(f);
  const repaired = row(await read(f), owner).metrics;
  expect(repaired).toMatchObject({
    target_switches: 0,
    target_position_switches: 0,
    motion_receipts: 2,
    evidence_event_seqs: [firstSequence, missingSequence, lastSequence],
  });
  await f.reopen();
  equivalentMetric(row(await read(f), owner).metrics, repaired);
});

for (const reopenBeforeMutation of [false, true]) {
  test(`owner/root attribution and a closed receipt replacement remain current${reopenBeforeMutation ? " after reopening before mutation" : ""}`, async () => {
    const f = await createFixture(),
      root = execution(f),
      child = execution(f, root),
      grandchild = execution(f, child);
    const rootAction = dig(f, root),
      childAction = dig(f, child),
      grandAction = dig(f, grandchild);
    const eRoot = save(f, rootAction, removal),
      eChild = save(f, childAction, removal);
    closeUnknown(f, root);
    closeUnknown(f, child);
    closeUnknown(f, grandchild);
    await prepare(f);
    let rows = await read(f);
    expect([
      row(rows, root).metrics.confirmed_block_removals,
      row(rows, child).metrics.confirmed_block_removals,
      row(rows, grandchild).metrics.confirmed_block_removals,
    ]).toEqual([2, 1, 0]);
    if (reopenBeforeMutation) await f.reopen();
    const eGrand = save(f, grandAction, removal);
    await prepare(f);
    rows = await read(f);
    for (const [owner, count, provenance] of [
      [root, 3, [eRoot, eChild, eGrand]],
      [child, 1, [eChild]],
      [grandchild, 1, [eGrand]],
    ] as const) {
      const observed = row(rows, owner);
      expect(observed.metrics.confirmed_block_removals).toBe(count);
      expect(observed.confirmed_effects).toBe(count);
      expect(observed.metrics.evidence_event_seqs).toEqual([...provenance]);
      expect(observed.metrics.inventory_delta).toEqual({});
      expect(observed.metrics.outcome).toBe("unknown");
    }
    const initial = await f.reader.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: initialCursor(),
        limit: 100,
      },
      options(),
    );
    expect(initial.has_more).toBe(false);
    save(f, childAction, {
      ...removal,
      inventory_receipt_confirmed: true,
      inventory_before: { stone: 0 },
      inventory_after: { stone: 3 },
    });
    await prepare(f);
    const update = await f.reader.query(
      {
        kind: "operator_feedback",
        run_id: f.run.run_id,
        after: initial.next_after,
        limit: 100,
      },
      options(),
    );
    expect(
      update.metrics
        .filter((value) => value.kind === "replace")
        .filter((value) => value.execution_id === child.execution_id)
        .at(-1)?.metric.inventory_delta,
    ).toEqual({ stone: 3 });
    expect(
      update.metrics.every(
        (value) => value.revision > 0 && value.generation > 0,
      ),
    ).toBe(true);
    rows = await read(f);
    expect(row(rows, root).metrics.inventory_delta).toEqual({ stone: 3 });
    expect(row(rows, child).metrics.inventory_delta).toEqual({ stone: 3 });
    expect(row(rows, grandchild).metrics.inventory_delta).toEqual({});
    await f.reopen();
    expect(row(await read(f), root).metrics.evidence_event_seqs).toEqual([
      eRoot,
      eChild,
      eGrand,
    ]);
  });
}
