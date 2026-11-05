import { expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "../src/server/store.ts";
import { ReadonlyStore } from "../src/server/store-read.ts";
import type { HistorySourceKind } from "../src/server/history-source.ts";
import { objectiveMetrics } from "../src/server/objective-metrics.ts";
import { programEvidence } from "../src/server/program-evidence.ts";
import {
  diagnosticAuthorityFixture,
  skillAuthorityFixture,
} from "./helpers/adapter-contract.ts";
import {
  historyExecution,
  historyFixture,
  historySpec,
} from "./helpers/history-fixture.ts";

function bootstrap(store: Store, limit = 128) {
  for (let batch = 0; batch < 1000; batch++) {
    const progress = store.advanceHistorySourceBootstrap(limit);
    expect(progress.processed).toBeLessThanOrEqual(limit);
    if (progress.complete) return;
  }
  throw new Error("Source key bootstrap did not finish its finite fixture");
}
function body(
  reader: ReadonlyStore,
  runId: string,
  kind: HistorySourceKind,
  key: string,
  through: number,
  column: string,
) {
  const record = reader.historySourceRecord(runId, kind, key, through);
  expect(record).not.toBeNull();
  const encoded = record!.columns[column];
  if (typeof encoded !== "string")
    throw new Error("Expected retained raw JSON column");
  return JSON.parse(encoded);
}
function records(
  reader: ReadonlyStore,
  runId: string,
  kind: HistorySourceKind,
  through: number,
) {
  let after = 0,
    throughKey: number | undefined;
  const values: ReturnType<ReadonlyStore["historySourcePage"]>["records"] = [];
  for (let pages = 0; pages < 1000; pages++) {
    const page = reader.historySourcePage(
      runId,
      kind,
      through,
      after,
      throughKey,
      2,
    );
    expect(page.records.length).toBeLessThanOrEqual(2);
    if (throughKey !== undefined) expect(page.through_key).toBe(throughKey);
    throughKey = page.through_key;
    values.push(...page.records);
    if (!page.has_more) return values;
    expect(page.next_after).toBeGreaterThan(after);
    after = page.next_after;
  }
  throw new Error("Source page did not drain its finite fixture");
}

test("eventless run replacements retain exact earlier source generations across reopen", () => {
  const fixture = historyFixture(),
    { run, directory } = fixture;
  let store = fixture.store;
  let reader: ReadonlyStore | undefined;
  try {
    bootstrap(store);
    reader = new ReadonlyStore(store.readLocation());
    const original = store.historySourceHighwater(run.run_id),
      event = store.lastEventSeq();
    expect(
      reader.historySourceRecord(run.run_id, "run", run.run_id, 0),
    ).toBeNull();
    const ordinal = reader.historySourceRecord(
      run.run_id,
      "run",
      run.run_id,
      original,
    )!.ordinal;
    store.saveRun({ ...run, turns: 7 });
    const middle = store.historySourceHighwater(run.run_id);
    store.saveRun({ ...run, turns: 11 });
    const latest = store.historySourceHighwater(run.run_id);
    expect(store.lastEventSeq()).toBe(event);
    expect(latest).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(original);
    expect(
      body(reader, run.run_id, "run", run.run_id, original, "payload").turns,
    ).toBe(0);
    expect(
      body(reader, run.run_id, "run", run.run_id, middle, "payload").turns,
    ).toBe(7);
    expect(
      body(reader, run.run_id, "run", run.run_id, latest, "payload").turns,
    ).toBe(11);
    reader.close();
    store.close();
    store = new Store(directory);
    reader = new ReadonlyStore(store.readLocation());
    expect(
      body(reader, run.run_id, "run", run.run_id, original, "payload").turns,
    ).toBe(0);
    expect(
      body(reader, run.run_id, "run", run.run_id, middle, "payload").turns,
    ).toBe(7);
    expect(
      reader.historySourceRecord(run.run_id, "run", run.run_id, latest)!
        .ordinal,
    ).toBe(ordinal);
  } finally {
    reader?.close();
    store.close();
    fixture.close();
  }
});

test("current actions, direct execution recovery and immutable skill identities remain generation-specific", async () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    const before = store.historySourceHighwater(run.run_id);
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const execution = historyExecution(store, run, skill);
    const action = store.admitAction(
      run.run_id,
      "historical-action",
      { kind: "look", yaw: 0, pitch: 0 },
      "diagnostic",
      "fixture-diagnostic",
      diagnosticAuthorityFixture(run),
    ).action.view;
    bootstrap(store);
    reader = new ReadonlyStore(store.readLocation());
    const accepted = store.historySourceHighwater(run.run_id);
    action.status = "succeeded";
    action.ended_at = "2020-01-01T00:00:01.000Z";
    action.result = {
      status: "succeeded",
      summary: "Storage-only receipt",
      evidence: {
        inventory_receipt_confirmed: true,
        inventory_delta: { stone: 1 },
      },
    };
    store.saveAction(run.run_id, action);
    const firstReceipt = store.historySourceHighwater(run.run_id);
    action.result.evidence = {
      inventory_receipt_confirmed: true,
      inventory_delta: { stone: 3 },
    };
    store.saveAction(run.run_id, action);
    store.reconcileSkillExecutions(run.run_id);
    const latest = store.historySourceHighwater(run.run_id);
    expect(
      reader.historySourceRecord(
        run.run_id,
        "execution",
        execution.execution_id,
        before,
      ),
    ).toBeNull();
    expect(
      body(reader, run.run_id, "action", action.action_id, accepted, "view")
        .status,
    ).toBe("accepted");
    expect(
      body(reader, run.run_id, "action", action.action_id, firstReceipt, "view")
        .result.evidence.inventory_delta,
    ).toEqual({ stone: 1 });
    expect(
      body(reader, run.run_id, "action", action.action_id, latest, "view")
        .result.evidence.inventory_delta,
    ).toEqual({ stone: 3 });
    expect(
      body(
        reader,
        run.run_id,
        "execution",
        execution.execution_id,
        accepted,
        "view",
      ).status,
    ).toBe("running");
    expect(
      body(
        reader,
        run.run_id,
        "execution",
        execution.execution_id,
        latest,
        "view",
      ).status,
    ).toBe("unknown");
    const retained = reader.historySourceRecord(
      run.run_id,
      "skill",
      JSON.stringify([skill.skill_id, skill.version]),
      latest,
    )!;
    expect(retained.columns.hash).toBe(skill.hash);
    expect(
      body(
        reader,
        run.run_id,
        "skill",
        JSON.stringify([skill.skill_id, skill.version]),
        latest,
        "metadata",
      ).validation,
    ).toEqual(skill.validation);
  } finally {
    reader?.close();
    fixture.close();
  }
});

test("retained traces and budget-only rejection have distinct source changes without invented events", () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    const input = {
      run_id: run.run_id,
      execution_id: null,
      root_execution_id: null,
      parent_execution_id: null,
      skill_id: null,
      version: null,
      hash: null,
      session_id: run.session_id,
      life_id: run.life_id,
      kind: "branch" as const,
      payload: { reason: "Storage-only source fixture" },
    };
    const trace = store.recordTrace(input)!;
    const db = new Database(store.readLocation().database);
    try {
      db.query("UPDATE trace_budgets SET recorded=8192 WHERE run_id=?").run(
        run.run_id,
      );
    } finally {
      db.close(true);
    }
    bootstrap(store);
    reader = new ReadonlyStore(store.readLocation());
    const before = store.historySourceHighwater(run.run_id),
      events = store.lastEventSeq();
    expect(store.recordTrace(input)).toBeNull();
    const after = store.historySourceHighwater(run.run_id);
    expect(after).toBeGreaterThan(before);
    expect(store.lastEventSeq()).toBe(events);
    expect(
      records(reader, run.run_id, "trace", after).map((record) =>
        Number(record.columns.trace_seq),
      ),
    ).toEqual([trace.trace_seq]);
    expect(
      reader.historySourceRecord(
        run.run_id,
        "trace_budget",
        run.run_id,
        before,
      )!.columns.omitted_records,
    ).toBe(0);
    expect(
      reader.historySourceRecord(run.run_id, "trace_budget", run.run_id, after)!
        .columns.omitted_records,
    ).toBe(1);
  } finally {
    reader?.close();
    fixture.close();
  }
});

test("oversized event bodies survive lazy sealing and pure source reads do not populate history", () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    const details = { body: "large evidence ".repeat(6000) };
    const event = store.event(
      run.run_id,
      "fixture.large",
      "Retained source",
      details,
    );
    bootstrap(store);
    reader = new ReadonlyStore(store.readLocation());
    const before = store.historySourceHighwater(run.run_id);
    expect(
      body(
        reader,
        run.run_id,
        "event",
        String(event.event_seq),
        before,
        "details",
      ),
    ).toEqual(details);
    const db = new Database(store.readLocation().database);
    try {
      db.query("UPDATE events SET details=? WHERE event_seq=?").run(
        JSON.stringify({ body: "corrected" }),
        event.event_seq,
      );
    } finally {
      db.close(true);
    }
    const after = store.historySourceHighwater(run.run_id);
    expect(
      body(
        reader,
        run.run_id,
        "event",
        String(event.event_seq),
        before,
        "details",
      ),
    ).toEqual(details);
    expect(
      body(
        reader,
        run.run_id,
        "event",
        String(event.event_seq),
        after,
        "details",
      ),
    ).toEqual({ body: "corrected" });
    const db2 = new Database(store.readLocation().database);
    try {
      const state = () =>
        [
          "history_source_changes",
          "history_source_versions",
          "history_source_keys",
          "history_source_bootstrap",
        ].map((table) =>
          db2
            .query(`SELECT * FROM ${table}`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort(),
        );
      const saved = state();
      records(reader, run.run_id, "event", before);
      reader.historySourceRecord(
        run.run_id,
        "event",
        String(event.event_seq),
        after,
      );
      expect(state()).toEqual(saved);
    } finally {
      db2.close(true);
    }
  } finally {
    reader?.close();
    fixture.close();
  }
});

test("a source-transaction fault rolls back backing data, sealed versions and the change frontier together", () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    bootstrap(store);
    const before = store.historySourceHighwater(run.run_id);
    const db = new Database(store.readLocation().database);
    try {
      db.exec(`CREATE TRIGGER source_fault AFTER INSERT ON history_source_changes
      WHEN NEW.kind='run' BEGIN SELECT RAISE(ABORT,'source transaction fault'); END`);
    } finally {
      db.close(true);
    }
    expect(() => store.saveRun({ ...run, turns: 99 })).toThrow(
      "source transaction fault",
    );
    expect(store.historySourceHighwater(run.run_id)).toBe(before);
    reader = new ReadonlyStore(store.readLocation());
    expect(
      body(reader, run.run_id, "run", run.run_id, before, "payload").turns,
    ).toBe(0);
    expect(store.getRun(run.run_id)?.turns).toBe(0);
    const repair = new Database(store.readLocation().database);
    try {
      repair.exec("DROP TRIGGER source_fault");
    } finally {
      repair.close(true);
    }
    store.saveRun({ ...run, turns: 2 });
    expect(
      body(reader, run.run_id, "run", run.run_id, before, "payload").turns,
    ).toBe(0);
    expect(
      body(
        reader,
        run.run_id,
        "run",
        run.run_id,
        store.historySourceHighwater(run.run_id),
        "payload",
      ).turns,
    ).toBe(2);
  } finally {
    reader?.close();
    fixture.close();
  }
});

test("bounded schema5 bootstrap preserves an unvisited original source while later sources remain absent at generation0", () => {
  const fixture = historyFixture(),
    { directory, run } = fixture;
  let store = fixture.store;
  let reader: ReadonlyStore | undefined;
  const original = { ...run, run_id: crypto.randomUUID() };
  const later = { ...run, run_id: crypto.randomUUID() };
  try {
    store.saveRun(original);
    store.close();
    const db = new Database(store.readLocation().database);
    try {
      const triggers = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'history_source_%'",
        )
        .all();
      for (const { name } of triggers)
        db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
      for (const table of [
        "history_source_versions",
        "history_source_keys",
        "history_source_bootstrap",
        "history_source_changes",
      ])
        db.exec(`DROP TABLE ${table}`);
      db.exec("PRAGMA user_version=5");
    } finally {
      db.close(true);
    }
    store = new Store(directory);
    reader = new ReadonlyStore(store.readLocation());
    expect(store.historySourceHighwater(original.run_id)).toBe(0);
    expect(
      body(reader, original.run_id, "run", original.run_id, 0, "payload").turns,
    ).toBe(0);
    expect(() =>
      reader!.historySourcePage(original.run_id, "run", 0),
    ).toThrow();
    const first = store.advanceHistorySourceBootstrap(1);
    expect(first.processed).toBeLessThanOrEqual(1);
    store.saveRun({ ...original, turns: 8 });
    store.saveRun(later);
    reader.close();
    store.close();
    store = new Store(directory);
    bootstrap(store, 1);
    reader = new ReadonlyStore(store.readLocation());
    const retained = records(reader, original.run_id, "run", 0);
    expect(
      retained.map(
        (record) => JSON.parse(record.columns.payload as string).turns,
      ),
    ).toEqual([0]);
    expect(
      reader.historySourceRecord(later.run_id, "run", later.run_id, 0),
    ).toBeNull();
    expect(
      body(
        reader,
        original.run_id,
        "run",
        original.run_id,
        store.historySourceHighwater(original.run_id),
        "payload",
      ).turns,
    ).toBe(8);
    expect(
      body(
        reader,
        later.run_id,
        "run",
        later.run_id,
        store.historySourceHighwater(later.run_id),
        "payload",
      ).turns,
    ).toBe(0);
  } finally {
    reader?.close();
    store.close();
    fixture.close();
  }
});

test("source and change continuations pin their frontiers without chasing later appends", () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    const expected = Array.from(
      { length: 7 },
      (_, index) =>
        store.event(run.run_id, "fixture.page", "Original source", { index })
          .event_seq,
    );
    bootstrap(store);
    reader = new ReadonlyStore(store.readLocation());
    const through = store.historySourceHighwater(run.run_id);
    const first = reader.historySourcePage(
      run.run_id,
      "event",
      through,
      0,
      undefined,
      2,
    );
    const late = store.event(
      run.run_id,
      "fixture.page",
      "Outside original frontier",
      { index: 99 },
    );
    const found = first.records.map((record) =>
      Number(record.columns.event_seq),
    );
    let page = first;
    for (let steps = 0; page.has_more; steps++) {
      expect(steps).toBeLessThan(10);
      page = reader.historySourcePage(
        run.run_id,
        "event",
        through,
        page.next_after,
        first.through_key,
        2,
      );
      found.push(
        ...page.records.map((record) => Number(record.columns.event_seq)),
      );
    }
    expect(found).toEqual(expected);
    expect(found).not.toContain(late.event_seq);
    const changes = [];
    let after = 0;
    for (let steps = 0; ; steps++) {
      expect(steps).toBeLessThan(10);
      const batch = reader.historySourceChanges(run.run_id, after, through, 2);
      expect(batch.through).toBe(through);
      changes.push(...batch.records);
      if (!batch.has_more) break;
      expect(batch.next_after).toBeGreaterThan(after);
      after = batch.next_after;
    }
    expect(
      changes
        .filter((change) => change.kind === "event")
        .map((change) => Number(change.source_key)),
    ).toEqual(expected);
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        reader!.historySourceRecord(run.run_id, "run", run.run_id, invalid),
      ).toThrow();
      expect(() => reader!.historySourceChanges(run.run_id, invalid)).toThrow();
    }
  } finally {
    reader?.close();
    fixture.close();
  }
});

test("deleting a retained source seals its prior value rather than erasing an older snapshot", () => {
  const fixture = historyFixture(),
    { store, run } = fixture;
  let reader: ReadonlyStore | undefined;
  try {
    const event = store.event(
      run.run_id,
      "fixture.retained",
      "Retained historical value",
      { value: 17 },
    );
    bootstrap(store);
    reader = new ReadonlyStore(store.readLocation());
    const before = store.historySourceHighwater(run.run_id);
    const db = new Database(store.readLocation().database);
    try {
      db.query("DELETE FROM events WHERE event_seq=?").run(event.event_seq);
    } finally {
      db.close(true);
    }
    const after = store.historySourceHighwater(run.run_id);
    expect(
      body(
        reader,
        run.run_id,
        "event",
        String(event.event_seq),
        before,
        "details",
      ),
    ).toEqual({ value: 17 });
    expect(
      reader.historySourceRecord(
        run.run_id,
        "event",
        String(event.event_seq),
        after,
      ),
    ).toBeNull();
    expect(
      records(reader, run.run_id, "event", before).map((record) =>
        Number(record.columns.event_seq),
      ),
    ).toEqual([event.event_seq]);
    expect(records(reader, run.run_id, "event", after)).toEqual([]);
  } finally {
    reader?.close();
    fixture.close();
  }
});

test("the pinned canonical oracle retains old receipt and evidence totals after late source replacement and reopen", async () => {
  const fixture = historyFixture(),
    { run, directory } = fixture;
  let store = fixture.store;
  let reader: ReadonlyStore | undefined;
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2020-01-01T00:00:05.000Z"));
  try {
    const skill = await store.registerSkill(run.run_id, historySpec(run));
    const owner = historyExecution(store, run, skill);
    const action = store.admitAction(
      run.run_id,
      "owned-receipt",
      { kind: "look", yaw: 0, pitch: 0 },
      "skill",
      owner.execution_id,
      skillAuthorityFixture(run, owner),
    ).action.view;
    action.status = "succeeded";
    action.ended_at = "2020-01-01T00:00:01.000Z";
    action.result = {
      status: "succeeded",
      summary: "Initial retained effect",
      evidence: {
        effect_confirmed: true,
        inventory_receipt_confirmed: true,
        inventory_delta: { stone: 1 },
        travel_distance: 2,
      },
    };
    store.saveAction(run.run_id, action);
    bootstrap(store);
    const through = store.historySourceHighwater(run.run_id);
    const originalMetrics = objectiveMetrics(store, run.run_id),
      originalEvidence = programEvidence(store, run.run_id);
    reader = new ReadonlyStore(store.readLocation());
    const original = reader.historySnapshot(run.run_id, through);
    expect(objectiveMetrics(original, run.run_id)).toEqual(originalMetrics);
    expect(programEvidence(original, run.run_id)).toEqual(originalEvidence);
    action.result.evidence = {
      effect_confirmed: true,
      inventory_receipt_confirmed: true,
      inventory_delta: { stone: 3 },
      travel_distance: 5,
    };
    store.saveAction(run.run_id, action);
    expect(objectiveMetrics(store, run.run_id)[0]!.inventory_delta).toEqual({
      stone: 3,
    });
    expect(
      objectiveMetrics(store, run.run_id)[0]!.receipted_travel_distance,
    ).toBe(5);
    expect(objectiveMetrics(original, run.run_id)).toEqual(originalMetrics);
    expect(programEvidence(original, run.run_id)).toEqual(originalEvidence);
    reader.close();
    store.close();
    store = new Store(directory);
    reader = new ReadonlyStore(store.readLocation());
    const reopened = reader.historySnapshot(run.run_id, through);
    expect(objectiveMetrics(reopened, run.run_id)).toEqual(originalMetrics);
    expect(programEvidence(reopened, run.run_id)).toEqual(originalEvidence);
    const current = reader.historySnapshot(
      run.run_id,
      store.historySourceHighwater(run.run_id),
    );
    expect(objectiveMetrics(current, run.run_id)).toEqual(
      objectiveMetrics(store, run.run_id),
    );
    expect(programEvidence(current, run.run_id)).toEqual(
      programEvidence(store, run.run_id),
    );
    expect(() => current.eventsAfter(null, 0, 10)).toThrow();
    expect(() => current.getRun("other-run")).toThrow();
  } finally {
    clock.mockRestore();
    reader?.close();
    store.close();
    fixture.close();
  }
});
